/*
 * Tujuan: Sajikan foto bukti kunjungan dari volume data (pengganti static public/ yang tak tersaji di standalone) — hanya ke yang berhak.
 * Caller: <img src="/api/uploads/form-kontrol/<uuid>.jpg"> di wizard kunjungan & dashboard SPV.
 * Dependensi: fs native, UPLOAD_DIR, resolveScope (cakupan Form Kontrol), ao_control_daily + merchandising_check (baris pemilik foto).
 * Side Effects: Baca file dari disk + baca DB; tak menulis.
 * Otorisasi (14 Okt 2026): admin/manager/admin_sales = semua foto. Selain itu foto harus dirujuk baris salesCode dalam cakupan
 *   (salesman sendiri, SPV/SM timnya): ao_control_daily check-in/check-out (foto toko tutup R15 = check-out) atau merchandising_check
 *   photo_url/step_photos. Foto butir merchandising tampil di wizard SEBELUM barisnya disimpan (Simpan merchandising) → foto yatim
 *   (belum dirujuk baris mana pun) yang baru diunggah boleh dibuka pengguna bercakupan sales; namanya UUID acak yang hanya diketahui pengunggah.
 */
import { NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import path from "path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { aoControlDaily as ao, merchandisingCheck as mc } from "@/db/schema";
import { UPLOAD_DIR } from "@/lib/form-kontrol/uploads";
import { resolveScope } from "@/lib/form-kontrol/scope";
import { requireApiSession } from "@/lib/api-security";

// ponytail: 2 jam = langkah merchandising yang wajar sebelum disimpan. Foto yang diganti ("Ganti foto") ikut yatim di jendela ini;
// bila perlu ketat, catat pengunggah saat unggah lalu ganti jendela ini dengan "pengunggah = sesi".
const YATIM_MS = 2 * 60 * 60 * 1000;

/** Ada baris yang merujuk url foto ini; codes null = salesCode mana pun. */
async function dirujuk(url: string, codes: string[] | null): Promise<boolean> {
    // ponytail: dengan codes = indeks (sales_code, date); codes null (cek yatim, jalur tolak saja) = seq scan. Indeks kolom foto bila lambat.
    const [a] = await db.select({ id: ao.id }).from(ao).where(and(codes ? inArray(ao.salesCode, codes) : undefined,
        or(eq(ao.checkinPhotoUrl, url), eq(ao.checkoutPhotoUrl, url)))).limit(1);
    if (a) return true;
    const [m] = await db.select({ id: mc.id }).from(mc).where(and(codes ? inArray(mc.salesCode, codes) : undefined,
        or(eq(mc.photoUrl, url), sql`jsonb_path_exists(${mc.stepPhotos}, '$.* ? (@ == $u)', jsonb_build_object('u', ${url}::text))`))).limit(1);
    return Boolean(m);
}

async function boleh(url: string, berkas: string, codes: string[] | null): Promise<boolean> {
    if (codes === null) return true;
    if (codes.length === 0) return false;
    if (await dirujuk(url, codes)) return true;
    const s = await stat(berkas).catch(() => null);
    return s !== null && Date.now() - s.mtimeMs < YATIM_MS && !await dirujuk(url, null);
}

export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
    const auth = await requireApiSession(req);
    if (auth.response) return auth.response;
    const { file } = await params;
    // anti path-traversal: hanya [A-Za-z0-9_-].jpg — tanpa /, \, atau .. (tolak, bukan dipangkas ke basename).
    if (!/^[\w-]+\.jpg$/.test(file)) return new NextResponse("Not found", { status: 404 });
    const berkas = path.join(UPLOAD_DIR, file);

    const { allowedSalesCodes } = await resolveScope(auth.session);
    if (!await boleh(`/api/uploads/form-kontrol/${file}`, berkas, allowedSalesCodes)) return new NextResponse("Forbidden", { status: 403 });

    try {
        const buf = await readFile(berkas);
        return new NextResponse(new Uint8Array(buf), {
            headers: {
                "Content-Type": "image/jpeg",
                // Foto privat: jangan disimpan cache bersama/proxy; cache peramban singkat cukup untuk thumbnail dashboard.
                "Cache-Control": "private, max-age=3600",
            },
        });
    } catch {
        return new NextResponse("Not found", { status: 404 });
    }
}
