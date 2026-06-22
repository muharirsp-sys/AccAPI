import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { UPLOAD_DIR } from "@/lib/form-kontrol/uploads";

const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

function xmlEscape(s: string) {
    return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}

// ponytail: server timestamp (anti-manipulasi client) + overlay 2 baris di kiri-bawah via sharp.
function buildStampSvg(width: number, height: number, line1: string, line2: string) {
    const fs = Math.max(14, Math.round(width / 42));
    const pad = Math.round(fs * 0.6);
    const band = fs * 2 + pad * 3;
    const top = height - band;
    return Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="${top}" width="${width}" height="${band}" fill="black" opacity="0.5"/>
            <text x="${pad}" y="${top + pad + fs}" font-family="sans-serif" font-size="${fs}" fill="white" font-weight="bold">${xmlEscape(line1)}</text>
            <text x="${pad}" y="${top + pad * 2 + fs * 2}" font-family="sans-serif" font-size="${fs}" fill="white">${xmlEscape(line2)}</text>
        </svg>`
    );
}

function nowJakartaLabel() {
    const p = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date()).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

export async function POST(req: Request) {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });

        const salesName = (formData.get("salesName") as string | null)?.trim() || "";
        const custName  = (formData.get("custName") as string | null)?.trim() || "";
        const lat = formData.get("lat") as string | null;
        const lng = formData.get("lng") as string | null;

        if (!file.type.startsWith("image/")) {
            return NextResponse.json({ error: "Only image files allowed" }, { status: 400 });
        }
        if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
            return NextResponse.json({ error: "Ukuran file maksimal 5MB." }, { status: 400 });
        }

        const filename = `${randomUUID()}.jpg`;
        const dir = UPLOAD_DIR;
        await mkdir(dir, { recursive: true });

        const resized = await sharp(Buffer.from(await file.arrayBuffer()))
            .rotate()
            .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 72 })
            .toBuffer();

        // Burn stamp (sales | toko | waktu-server | koordinat) ke kiri-bawah foto.
        const img = sharp(resized);
        const { width, height } = await img.metadata();
        let out = resized;
        if (width && height) {
            const coordTxt = (lat && lng) ? `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}` : "Lokasi tidak terdeteksi";
            const line1 = [salesName, custName].filter(Boolean).join(" | ") || "Kunjungan";
            const line2 = `${nowJakartaLabel()} | ${coordTxt}`;
            out = await img
                .composite([{ input: buildStampSvg(width, height, line1, line2), top: 0, left: 0 }])
                .jpeg({ quality: 72 })
                .toBuffer();
        }
        await writeFile(path.join(dir, filename), out);

        return NextResponse.json({ url: `/api/uploads/form-kontrol/${filename}` });
    } catch {
        return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
}
