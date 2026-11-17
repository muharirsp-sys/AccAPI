/*
 * Tujuan: Validasi wajah selfie check-in (owner 16 Nov 2026) — sisi server: foto check-in (UPLOAD_DIR) -> FastAPI POST /wajah/sidik (cookie sales
 *   diteruskan) -> bandingkan dengan wajah_acuan salesman -> tulis ao_control_daily.wajah_status/wajah_skor. Belum punya acuan = selfie
 *   berwajah pertama menjadi acuan (sumber 'checkin'). Admin mengosongkan acuan lewat hapusAcuanWajah (Hierarki).
 * Caller: app/api/form-kontrol/checkin (sesudah check-in tersimpan), app/api/form-kontrol/wajah-acuan.
 * Dependensi: ./uploads (UPLOAD_DIR), ./wajah (murni), db wajah_acuan + ao_control_daily, FastAPI (FASTAPI_BASE_URL).
 * Main Functions: periksaWajahCheckin, statusAcuanWajah, hapusAcuanWajah.
 * Side Effects: baca berkas foto; HTTP ke FastAPI (≤ 10 dtk); INSERT wajah_acuan; UPDATE ao_control_daily; DELETE wajah_acuan (reset).
 *
 * TIDAK PERNAH melempar ke pemanggil dan tidak pernah menahan check-in (owner: wajah beda = lanjut, tandai SPV): galat apa pun = 'tidak_terbaca'.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { aoControlDaily, wajahAcuan } from "@/db/schema";
import { UPLOAD_DIR } from "./uploads";
import { nilaiWajah, type StatusWajah } from "./wajah";

const BACKEND = process.env.FASTAPI_BASE_URL || process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";
const AWALAN = "/api/uploads/form-kontrol/";

type Kunci = { salesCode: string; custCode: string; principle: string; date: string };

/** Sidik wajah foto (null = tanpa wajah). Melempar bila foto/layanan tidak terbaca. */
async function sidikFoto(photoUrl: string, cookie: string | null): Promise<number[] | null> {
    const berkas = photoUrl.startsWith(AWALAN) ? photoUrl.slice(AWALAN.length) : "";
    // Sama dengan penyaji foto: hanya [A-Za-z0-9_-].jpg di UPLOAD_DIR (tanpa path traversal).
    if (!/^[\w-]+\.jpg$/.test(berkas)) throw new Error("url foto check-in bukan unggahan Form Kontrol");
    const isi = await readFile(path.join(UPLOAD_DIR, berkas));
    const r = await fetch(`${BACKEND}/wajah/sidik`, {
        method: "POST", body: new Uint8Array(isi), cache: "no-store", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "image/jpeg", ...(cookie ? { cookie } : {}) },
    });
    const j = r.ok ? await r.json().catch(() => null) as { ok?: unknown; sidik?: unknown } | null : null;
    if (!j || j.ok !== true) throw new Error(`layanan wajah HTTP ${r.status}`);
    const s = j.sidik;
    if (s === null) return null;
    if (!Array.isArray(s) || s.length !== 128 || !s.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error("sidik wajah tidak sah");
    return s as number[];
}

/** Bandingkan selfie check-in dengan acuan salesman dan catat hasilnya di baris kunjungan. Tidak pernah melempar. */
export async function periksaWajahCheckin(k: Kunci & { photoUrl: string; cookie: string | null }): Promise<{ status: StatusWajah; skor: number | null }> {
    let hasil: { status: StatusWajah; skor: number | null } = { status: "tidak_terbaca", skor: null };
    try {
        const sidik = await sidikFoto(k.photoUrl, k.cookie);
        const [acuan] = await db.select({ sidik: wajahAcuan.sidik }).from(wajahAcuan).where(eq(wajahAcuan.salesCode, k.salesCode)).limit(1);
        hasil = nilaiWajah(sidik, acuan?.sidik ?? null);
        if (hasil.status === "acuan_baru" && sidik) {
            const baru = await db.insert(wajahAcuan).values({ salesCode: k.salesCode, sidik, fotoUrl: k.photoUrl, sumber: "checkin", dibuatOleh: k.salesCode })
                .onConflictDoNothing().returning({ salesCode: wajahAcuan.salesCode });
            if (baru.length === 0) { // acuan baru saja dibuat check-in lain yang serentak: bandingkan dengannya
                const [lain] = await db.select({ sidik: wajahAcuan.sidik }).from(wajahAcuan).where(eq(wajahAcuan.salesCode, k.salesCode)).limit(1);
                hasil = nilaiWajah(sidik, lain?.sidik ?? null);
            }
        }
    } catch {
        hasil = { status: "tidak_terbaca", skor: null };
    }
    try {
        await db.update(aoControlDaily).set({ wajahStatus: hasil.status, wajahSkor: hasil.skor }).where(and(eq(aoControlDaily.salesCode, k.salesCode),
            eq(aoControlDaily.custCode, k.custCode), eq(aoControlDaily.principle, k.principle), eq(aoControlDaily.date, k.date)));
    } catch { /* tanda wajah tambahan; check-in sudah tersimpan */ }
    return hasil;
}

/** Status acuan wajah per salesman untuk Hierarki: kode -> { fotoUrl, dibuatPada } (tanpa sidik — data biometrik tidak dikirim ke layar). */
export async function statusAcuanWajah(salesCodes: string[]) {
    if (salesCodes.length === 0) return new Map<string, { fotoUrl: string; dibuatPada: string }>();
    const rows = await db.select({ salesCode: wajahAcuan.salesCode, fotoUrl: wajahAcuan.fotoUrl, dibuatPada: wajahAcuan.dibuatPada })
        .from(wajahAcuan).where(inArray(wajahAcuan.salesCode, salesCodes));
    return new Map(rows.map((r) => [r.salesCode, { fotoUrl: r.fotoUrl, dibuatPada: r.dibuatPada.toISOString() }]));
}

/** Kosongkan acuan wajah salesman (acuan keliru); check-in berwajah berikutnya menjadi acuan baru. true = ada yang dihapus. */
export async function hapusAcuanWajah(salesCode: string): Promise<boolean> {
    return (await db.delete(wajahAcuan).where(eq(wajahAcuan.salesCode, salesCode)).returning({ s: wajahAcuan.salesCode })).length > 0;
}
