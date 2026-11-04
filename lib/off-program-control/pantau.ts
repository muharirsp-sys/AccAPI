/*
 * Tujuan: Cakupan halaman Pantau Pengajuan Promo (owner 3 Nov 2026): salesman melihat SEMUA pengajuan OPC (off_batch, semua toko) milik
 *   principal yang tercatat di profil salesnya (SEMUA baris sales_profile akunnya) + principal JKS aktif kode-kode salesnya. Teks principal
 *   bebas dipetakan ke kode OPC (principal.code) HANYA lewat alias resmi (periksaPrincipal); teks yang tak dikenal dilaporkan, tidak ditebak.
 *   Admin (user.role admin) = semua principal. Baca saja.
 * Caller: app/api/off-program-control/pantau/route.ts, app/api/off-program-control/pantau/bukti/[paymentId]/route.ts, pantau.test.ts.
 * Dependensi: db (sales_profile), lib/form-kontrol/db (getJksPrinciples), lib/principal/pemakai (muatDataResmi, periksaPrincipal).
 * Main Functions: hitungCakupan (murni), cakupanPantau (DB), dalamCakupan.
 * Side Effects: cakupanPantau = DB read; lainnya murni.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesProfile } from "@/db/schema";
import { getJksPrinciples } from "@/lib/form-kontrol/db";
import { muatDataResmi, periksaPrincipal, type DataResmi } from "@/lib/principal/pemakai";

export type CakupanPantau = {
    /** true = admin: semua principal (`principal` kosong). */
    semua: boolean;
    /** Principal dalam cakupan: kode OPC (off_batch.principle_code) + nama resmi, urut kode. */
    principal: Array<{ code: string; nama: string }>;
    /** Teks principal profil/JKS yang belum dikenal Data Principal (tidak ikut cakupan). */
    takDikenal: string[];
    /** Kalimat layar bila cakupan kosong; null bila ada isinya. */
    alasan: string | null;
};

export const ALASAN_TANPA_PROFIL = "Akun Anda belum terhubung ke profil sales, jadi belum ada principal yang bisa ditampilkan. Minta admin menautkan akun Anda ke kode sales.";
export const ALASAN_TANPA_PRINCIPAL = "Profil sales Anda belum memuat principal yang dikenal sistem. Minta admin memeriksa principal di profil sales atau JKS Anda.";

/**
 * Aturan cakupan (murni). `teks` = principal sales_profile + principal JKS aktif. Principal NONAKTIF tetap ikut: halaman ini baca saja dan
 * pengajuan lama principal itu masih perlu dipantau. Varian (mis. KINO NON FOOD) = kode principal induknya, karena off_batch tidak menyimpan varian.
 */
export function hitungCakupan(input: { admin: boolean; punyaProfil: boolean; teks: readonly string[] }, data: DataResmi): CakupanPantau {
    if (input.admin) return { semua: true, principal: [], takDikenal: [], alasan: null };
    if (!input.punyaProfil) return { semua: false, principal: [], takDikenal: [], alasan: ALASAN_TANPA_PROFIL };
    const kode = new Map<string, string>();
    const takDikenal = new Set<string>();
    for (const mentah of input.teks) {
        const teks = String(mentah ?? "").trim();
        if (!teks) continue;
        const h = periksaPrincipal(teks, data);
        if (h.status === "tak_dikenal") { takDikenal.add(teks); continue; }
        if (!kode.has(h.principal.code)) kode.set(h.principal.code, data.principal.get(h.principal.principalId)?.name ?? h.principal.code);
    }
    const principal = [...kode].map(([code, nama]) => ({ code, nama })).sort((a, b) => a.code.localeCompare(b.code));
    return { semua: false, principal, takDikenal: [...takDikenal].sort(), alasan: principal.length ? null : ALASAN_TANPA_PRINCIPAL };
}

export const dalamCakupan = (c: CakupanPantau, code: string) => c.semua || c.principal.some((p) => p.code === code);

const DATA_KOSONG: DataResmi = { indeks: new Map(), principal: new Map(), varian: new Map() };

/** Cakupan akun yang sedang masuk. Tabel alias hanya dimuat bila ada teks principal untuk dipetakan. */
export async function cakupanPantau(user: { id: string; role?: string | null }): Promise<CakupanPantau> {
    const admin = user.role === "admin";
    const profil = admin ? [] : await db.select({ salesCode: salesProfile.salesCode, principle: salesProfile.principle })
        .from(salesProfile).where(eq(salesProfile.userId, user.id));
    const teks = profil.length ? [...profil.map((p) => p.principle), ...await getJksPrinciples(profil.map((p) => p.salesCode))] : [];
    return hitungCakupan({ admin, punyaProfil: profil.length > 0, teks }, teks.length ? await muatDataResmi() : DATA_KOSONG);
}
