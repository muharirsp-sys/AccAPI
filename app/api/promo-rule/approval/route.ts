/*
 * Tujuan: Menyimpan DUA pernyataan manusia yang harus ada sebelum publikasi Summary boleh
 *         menjadi aturan promo — centang "program ini benar" dan bukti surat bertanda tangan.
 * Caller: layar Aturan Promo, panel "Tarik dari Summary".
 * Dependensi: db (promo_letter_approval), rbac. Main Functions: GET, POST, DELETE.
 * Side Effects: menulis `promo_letter_approval`; tidak menyentuh `promo_rule` sama sekali.
 *
 * KENAPA DUA, DAN KENAPA TERPISAH DARI "TERBITKAN".
 * Menerbitkan di Summary sudah menyatakan "saya sudah memeriksa barisnya". Yang belum dinyatakan
 * siapa pun adalah dua hal yang berbeda jenisnya:
 *
 *   1. "Aturannya terbaca sistem dan hasilnya benar" — baru bisa dinyatakan SESUDAH melihat
 *      simulasinya. Centang sebelum melihat simulasi tidak menambah keamanan apa pun; ia hanya
 *      memindahkan tanggung jawab ke orang yang tidak punya cara memeriksa.
 *
 *   2. "Programnya memang disetujui yang berwenang" — ini sistem TIDAK BISA menilai sama sekali.
 *      Surat bisa terbaca sempurna dan tetap belum disetujui OM. Jadi yang disimpan bukan
 *      penilaian, melainkan BUKTINYA, dan gerbangnya menolak berjalan tanpa itu.
 *
 * Berkasnya disimpan di basis data, bukan di cakram container: container dibuat ulang tiap
 * deploy dan berkas di dalamnya ikut hilang bersama buktinya.
 *
 * MENCENTANG ULANG MENGGANTI JEJAK LAMA, dan itu disengaja: yang berlaku adalah pernyataan
 * terakhir, dan pernyataan lama yang disimpan berdampingan hanya membuat orang bertanya mana
 * yang dipakai. Mencabutnya (DELETE) mengembalikan gerbangnya ke tertutup.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { promoLetterApproval } from "@/db/schema";
import { resolveRequestPermissionsH } from "@/lib/rbac/resolve";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Batas yang longgar untuk satu surat bertanda tangan, tetapi tetap batas. */
const MAX_BYTES = 15 * 1024 * 1024;

const text = (value: unknown) => String(value ?? "").trim();

async function gateOf(perlu: "summary.view" | "summary.edit") {
    const gate = await resolveRequestPermissionsH();
    if (gate.response) return { response: gate.response };
    if (!gate.perms?.has(perlu)) {
        return { response: NextResponse.json({ ok: false, error: "Akses persetujuan surat tidak diizinkan" }, { status: 403 }) };
    }
    return { email: String(gate.session?.user?.email ?? "") };
}

/** Keadaan persetujuan satu publikasi, atau berkas buktinya bila diminta `?file=1`. */
export async function GET(request: NextRequest) {
    const gate = await gateOf("summary.view");
    if (gate.response) return gate.response;
    const draftId = text(request.nextUrl.searchParams.get("draftId"));
    if (!draftId) return NextResponse.json({ ok: false, error: "draftId wajib diisi" }, { status: 400 });

    const [row] = await db.select().from(promoLetterApproval).where(eq(promoLetterApproval.draftId, draftId));
    if (!row) return NextResponse.json({ ok: true, ada: false });

    if (request.nextUrl.searchParams.get("file") === "1") {
        if (!row.fileBytes) return NextResponse.json({ ok: false, error: "Bukti belum diunggah" }, { status: 404 });
        // Selalu diunduh, tidak pernah dirender di tempat: berkas ini datang dari luar dan
        // membukanya di dalam halaman kita berarti mempercayainya lebih dari yang seharusnya.
        return new NextResponse(new Uint8Array(row.fileBytes), {
            headers: {
                "content-type": "application/pdf",
                "content-disposition": `attachment; filename="${row.fileName.replace(/[^\w.\-]/g, "_") || "bukti.pdf"}"`,
            },
        });
    }

    return NextResponse.json({
        ok: true, ada: true,
        draftId: row.draftId, suratProgram: row.suratProgram,
        dicentang: row.confirmed, dicentangOleh: row.confirmedBy, dicentangPada: row.confirmedAt,
        catatan: row.note,
        buktiNama: row.fileName, buktiUkuran: row.fileSize, buktiHash: row.fileHash,
        buktiOleh: row.uploadedBy, buktiPada: row.uploadedAt,
    });
}

/**
 * Mencentang dan/atau mengunggah bukti. Satu pintu untuk keduanya karena orang mengerjakannya
 * dalam satu duduk: ia melihat simulasi, mengunggah surat yang sudah ditandatangani, lalu
 * menyatakan programnya benar. Memisahkannya jadi dua tombol hanya menambah langkah yang bisa
 * setengah selesai tanpa ada yang tahu.
 */
export async function POST(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;

    const form = await request.formData().catch(() => null);
    if (!form) return NextResponse.json({ ok: false, error: "Kirim sebagai form-data" }, { status: 400 });
    const draftId = text(form.get("draftId"));
    if (!draftId) return NextResponse.json({ ok: false, error: "draftId wajib diisi" }, { status: 400 });

    const berkas = form.get("file");
    const punyaBerkas = berkas instanceof File && berkas.size > 0;
    let bytes: Buffer | null = null;
    let hash = "";
    if (punyaBerkas) {
        if (berkas.size > MAX_BYTES) {
            return NextResponse.json({ ok: false, error: `Bukti maksimal ${MAX_BYTES / 1024 / 1024} MB` }, { status: 413 });
        }
        bytes = Buffer.from(await berkas.arrayBuffer());
        // Hanya PDF: bukti yang bisa berupa apa saja akan suatu hari berupa tangkapan layar
        // WhatsApp, dan yang menandatanganinya tidak akan bisa dilacak dari situ.
        if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
            return NextResponse.json({ ok: false, error: "Bukti harus berkas PDF surat bertanda tangan" }, { status: 415 });
        }
        hash = createHash("sha256").update(bytes).digest("hex");
    }

    const dicentang = text(form.get("confirmed")) === "true";
    const sekarang = new Date();
    const [ada] = await db.select().from(promoLetterApproval).where(eq(promoLetterApproval.draftId, draftId));

    // Centang tanpa bukti, dan bukti tanpa centang, dua-duanya boleh tersimpan — orang memang
    // bisa mengunggah dulu lalu mencentang belakangan. Yang menolak adalah GERBANGNYA saat
    // memuat, bukan pintu ini; menolak di sini berarti pekerjaan separuh tidak bisa disimpan.
    const isi = {
        draftId,
        suratProgram: text(form.get("suratProgram")) || ada?.suratProgram || "",
        principal: text(form.get("principal")) || ada?.principal || "",
        confirmed: dicentang,
        confirmedBy: dicentang ? gate.email! : (ada?.confirmed ? ada.confirmedBy : ""),
        confirmedAt: dicentang ? sekarang : (ada?.confirmed ? ada.confirmedAt : null),
        note: text(form.get("note")) || ada?.note || "",
        ...(punyaBerkas ? {
            fileName: berkas.name.slice(0, 200), fileHash: hash, fileSize: berkas.size,
            fileBytes: bytes, uploadedBy: gate.email!, uploadedAt: sekarang,
        } : {}),
    };

    if (ada) {
        await db.update(promoLetterApproval).set(isi).where(eq(promoLetterApproval.draftId, draftId));
    } else {
        await db.insert(promoLetterApproval).values(isi);
    }
    return NextResponse.json({
        ok: true, draftId, dicentang,
        bukti: punyaBerkas ? { nama: berkas.name, ukuran: berkas.size } : null,
    });
}

/** Mencabut persetujuan. Gerbangnya kembali tertutup pada pemuatan berikutnya. */
export async function DELETE(request: NextRequest) {
    const gate = await gateOf("summary.edit");
    if (gate.response) return gate.response;
    const draftId = text(request.nextUrl.searchParams.get("draftId"));
    if (!draftId) return NextResponse.json({ ok: false, error: "draftId wajib diisi" }, { status: 400 });
    const gone = await db.delete(promoLetterApproval)
        .where(eq(promoLetterApproval.draftId, draftId)).returning({ id: promoLetterApproval.draftId });
    return NextResponse.json({ ok: true, dicabut: gone.length });
}
