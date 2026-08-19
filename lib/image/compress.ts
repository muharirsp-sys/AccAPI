/*
 * Tujuan: Kompresi foto bukti di sisi browser tanpa merusak keterbacaan — resize bertahap, tangga kualitas, EXIF orientation, dan hash integritas.
 * Caller: components/form-kontrol/camera-capture.tsx (jalur kamera dan jalur pilih-file). Wajib dipakai modul Delivery/Incaso saat dibangun.
 * Dependensi: lib/image/compress-plan.ts (keputusan murni), API browser createImageBitmap/OffscreenCanvas/crypto.subtle.
 * Main Functions: compressEvidencePhoto, CompressResult, CompressMeta.
 * Side Effects: Membuat canvas sementara di memori dan menutup ImageBitmap. Tidak menulis DB/file/jaringan.
 *
 * PRINSIP: floor keras, ceiling lunak. Foto di bawah ambang keterbacaan DITOLAK
 * (minta foto ulang), bukan diterima diam-diam. Kalau ceiling byte tidak bisa
 * dicapai tanpa menembus quality floor, file besar yang menang.
 */

"use client";

import {
    EVIDENCE_PROFILES,
    MIN_ACCEPTABLE_LONG_EDGE,
    isBelowReadableFloor,
    planResize,
    qualityLadder,
    type EvidenceProfile,
} from "./compress-plan";

export type { EvidenceProfile };

/** Metadata untuk disimpan ke DB — bukti bahwa pipeline tidak merusak bukti. */
export interface CompressMeta {
    profile: EvidenceProfile;
    srcWidth: number;
    srcHeight: number;
    srcBytes: number;
    srcType: string;
    outWidth: number;
    outHeight: number;
    outBytes: number;
    quality: number;
    resized: boolean;
    /** true = ceiling byte ditembus demi mempertahankan quality floor. */
    hitCeiling: boolean;
    /** true = file asli dipakai apa adanya karena hasil kompres lebih besar. */
    keptOriginal: boolean;
    /** false = browser tidak mendukung imageOrientation; rotasi EXIF mungkin salah. */
    exifOriented: boolean;
    /** SHA-256 hex dari blob final. Deteksi kalau file di disk diubah setelahnya. */
    sha256: string;
}

export type CompressResult =
    | { ok: true; blob: Blob; meta: CompressMeta }
    | { ok: false; reason: string; srcWidth: number; srcHeight: number };

/** Decode blob -> bitmap, dengan rotasi EXIF diterapkan bila didukung. */
async function decode(
    input: Blob,
): Promise<{ bitmap: ImageBitmap; exifOriented: boolean }> {
    try {
        // Chrome/Firefox/Safari modern: menghormati EXIF orientation.
        // Tanpa ini, foto dari jalur pilih-file tersimpan miring/terbalik.
        const bitmap = await createImageBitmap(input, { imageOrientation: "from-image" });
        return { bitmap, exifOriented: true };
    } catch {
        // Browser lama: decode tanpa koreksi orientasi, tapi tandai di meta
        // supaya tidak ada klaim palsu bahwa orientasi sudah benar.
        const bitmap = await createImageBitmap(input);
        return { bitmap, exifOriented: false };
    }
}

interface Canvas2D {
    canvas: OffscreenCanvas | HTMLCanvasElement;
    ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

function makeCanvas(width: number, height: number): Canvas2D {
    if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D tidak tersedia.");
        return { canvas, ctx };
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D tidak tersedia.");
    return { canvas, ctx };
}

async function encode(
    canvas: OffscreenCanvas | HTMLCanvasElement,
    quality: number,
): Promise<Blob> {
    if ("convertToBlob" in canvas) {
        return canvas.convertToBlob({ type: "image/jpeg", quality });
    }
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("Encode JPEG gagal."))),
            "image/jpeg",
            quality,
        );
    });
}

async function sha256Hex(blob: Blob): Promise<string> {
    try {
        const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        return Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    } catch {
        // crypto.subtle butuh secure context (HTTPS/localhost). Jangan gagalkan
        // upload hanya karena hash tidak bisa dihitung — tandai saja.
        return "";
    }
}

/**
 * Kompres foto bukti. Mengembalikan { ok: false } bila resolusi sumber di bawah
 * ambang keterbacaan — pemanggil WAJIB menampilkan pesan dan minta foto ulang,
 * jangan mengirim apa pun.
 */
export async function compressEvidencePhoto(
    input: Blob,
    profile: EvidenceProfile = "dokumen",
): Promise<CompressResult> {
    const spec = EVIDENCE_PROFILES[profile];
    const { bitmap, exifOriented } = await decode(input);
    const srcWidth = bitmap.width;
    const srcHeight = bitmap.height;

    // GERBANG KETERBACAAN — sebelum kerja apa pun.
    if (isBelowReadableFloor(srcWidth, srcHeight)) {
        bitmap.close();
        return {
            ok: false,
            reason:
                `Resolusi foto terlalu rendah (${srcWidth}x${srcHeight}). ` +
                `Minimal sisi panjang ${MIN_ACCEPTABLE_LONG_EDGE} px agar tulisan terbaca. ` +
                `Foto ulang dengan kamera lebih dekat, atau pilih file foto beresolusi lebih tinggi.`,
            srcWidth,
            srcHeight,
        };
    }

    const plan = planResize(srcWidth, srcHeight, profile);

    // Turun bertahap: downscale >2x dalam satu langkah merusak stroke huruf.
    let source: ImageBitmap | OffscreenCanvas | HTMLCanvasElement = bitmap;
    let workCanvas: Canvas2D | null = null;
    for (const step of plan.steps) {
        workCanvas = makeCanvas(step.width, step.height);
        workCanvas.ctx.imageSmoothingEnabled = true;
        workCanvas.ctx.imageSmoothingQuality = "high";
        workCanvas.ctx.drawImage(source as CanvasImageSource, 0, 0, step.width, step.height);
        source = workCanvas.canvas;
    }
    bitmap.close();
    if (!workCanvas) throw new Error("Rencana resize kosong.");

    // Tangga kualitas: berhenti pada yang pertama muat di ceiling.
    const ladder = qualityLadder(profile);
    let best: Blob | null = null;
    let bestQuality = ladder[ladder.length - 1];
    for (const q of ladder) {
        const candidate = await encode(workCanvas.canvas, q);
        best = candidate;
        bestQuality = q;
        if (candidate.size <= spec.targetBytes) break;
    }
    if (!best) throw new Error("Encode gagal menghasilkan blob.");

    const hitCeiling = best.size > spec.targetBytes;

    // Jangan pernah memperbesar file. Bisa terjadi pada foto yang sudah kecil
    // dan sudah terkompres — re-encode justru menambah byte dan menambah
    // generation loss tanpa manfaat.
    let output = best;
    let keptOriginal = false;
    let outWidth = plan.width;
    let outHeight = plan.height;
    if (!plan.resized && best.size >= input.size) {
        output = input;
        keptOriginal = true;
        outWidth = srcWidth;
        outHeight = srcHeight;
    }

    return {
        ok: true,
        blob: output,
        meta: {
            profile,
            srcWidth,
            srcHeight,
            srcBytes: input.size,
            srcType: input.type || "unknown",
            outWidth,
            outHeight,
            outBytes: output.size,
            quality: keptOriginal ? 1 : bestQuality,
            resized: plan.resized && !keptOriginal,
            hitCeiling: keptOriginal ? false : hitCeiling,
            keptOriginal,
            exifOriented,
            sha256: await sha256Hex(output),
        },
    };
}
