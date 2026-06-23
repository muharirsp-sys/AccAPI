/*
 * Tujuan: Sajikan foto bukti kunjungan dari volume data (pengganti static public/ yang tak tersaji di standalone).
 * Caller: <img src="/api/uploads/form-kontrol/<uuid>.jpg"> di wizard kunjungan & dashboard SPV.
 * Dependensi: fs native, UPLOAD_DIR.
 * Side Effects: Baca file dari disk; tak menulis.
 */
import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { UPLOAD_DIR } from "@/lib/form-kontrol/uploads";
import { requireApiSession } from "@/lib/api-security";

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
    // Foto bukti kunjungan = data internal. Wajib sesi (cookie ikut di <img> same-origin).
    // ponytail: scope per-salesCode bisa ditambah kalau nama file mulai encode pemilik.
    const auth = await requireApiSession(req);
    if (auth.response) return auth.response;
    const { file } = await params;
    // anti path-traversal: paksa basename + hanya .jpg
    const safe = path.basename(file);
    if (!/^[\w.-]+\.jpg$/.test(safe)) return new NextResponse("Not found", { status: 404 });

    try {
        const buf = await readFile(path.join(UPLOAD_DIR, safe));
        return new NextResponse(new Uint8Array(buf), {
            headers: {
                "Content-Type": "image/jpeg",
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        });
    } catch {
        return new NextResponse("Not found", { status: 404 });
    }
}
