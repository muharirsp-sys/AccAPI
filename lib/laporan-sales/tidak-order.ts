/*
 * Tujuan: Laporan Sales › Tidak Order (padanan EskaLink "Unproductive Report") — kunjungan Form Kontrol tanpa order sebulan, dipecah per
 *   alasan (no_order_reason) dan per salesman. Agregasi MURNI (tanpa DB — juga diimpor tab klien): susunTidakOrder, persen. Kueri Postgres
 *   ada di route (pola Drop Size), supaya bundel klien tidak menarik pg.
 * Caller: app/api/laporan-sales/tidak-order/route.ts (susunTidakOrder), app/(dashboard)/laporan-sales/tab/TidakOrder.tsx (persen, tipe).
 * Dependensi: lib/form-kontrol/constants (adaHasilKunjungan — murni), lib/laporan-sales/kontrak (tipe jawaban).
 * Main Functions: susunTidakOrder, persen. Side Effects: Tidak ada.
 * Keputusan status ao_control_daily (lib/form-kontrol/types AoStatus = ordered | active | not_order | not_visited | priority):
 *   - kunjungan = status BERHASIL (adaHasilKunjungan: ordered, active, not_order) — toko yang sudah punya hasil kunjungan. `active` = order
 *     (Form Kontrol menghitungnya sebagai order, lib/form-kontrol/db.ts); `not_visited` = belum ada hasil (check-in menulis not_visited sampai
 *     salesman menyimpan hasil); `priority` = bintang prioritas, belum didatangi (constants.ts statusBintang). Keduanya TIDAK dihitung kunjungan.
 *   - tidakOrder = status not_order saja; alasan dihitung hanya dari baris ini (jumlah alasan = tidakOrder, selalu).
 *   ponytail: toko yang sudah check-in tapi belum menyimpan hasil (not_visited + checkin_at terisi) tidak masuk kunjungan. Bila owner mau
 *   menghitungnya, tambahkan (checkin_at IS NOT NULL) ke GROUP BY di route lalu hitung sebagai kunjungan tanpa order/hasil.
 * Cakupan: `cakupan` = UserScope.allowedSalesCodes (null = global). Route menyaring di SQL (data di luar cakupan tak dibaca) DAN di sini.
 */
import { adaHasilKunjungan } from "@/lib/form-kontrol/constants";
import type { BarisAlasan, JawabanTidakOrder } from "./kontrak";

/** Kontrak + daftar cabang untuk saringan (kontrak tidak memuatnya; pola sama dengan JawabanDropSizeLengkap). */
export type JawabanTidakOrderLengkap = JawabanTidakOrder & { pilihanCabang: string[] };

/** Satu kelompok hasil GROUP BY (sales_code, status, no_order_reason_code). */
export type BarisMentah = { salesCode: string; status: string; kode: string | null; jumlah: number };
export type AlasanMaster = { kode: string; label: string; kategori: string };
export type ProfilSales = { salesCode: string; nama: string; cabang: string | null };

export const LABEL_TANPA_ALASAN = "Tanpa alasan";

const urut = (a: string, b: string) => a.localeCompare(b, "id");

/** Persen satu desimal; pembagi 0 = null (tampil "–", bukan 0% atau NaN). */
export const persen = (bagian: number, total: number): number | null => (total > 0 ? Math.round((bagian / total) * 1000) / 10 : null);

export function susunTidakOrder(m: { baris: BarisMentah[]; alasan: AlasanMaster[]; profil: ProfilSales[]; cakupan: string[] | null; cabang?: string | null }):
    Omit<JawabanTidakOrderLengkap, "bulan"> {
    const boleh = m.cakupan === null ? null : new Set(m.cakupan);
    const dalam = (kode: string) => boleh === null || boleh.has(kode);
    const profil = new Map(m.profil.map((p) => [p.salesCode, p]));
    const master = new Map(m.alasan.map((a) => [a.kode, a]));
    const cabang = m.cabang?.trim() || null;

    const pilihanCabang = [...new Set(m.profil.filter((p) => dalam(p.salesCode)).map((p) => p.cabang?.trim()).filter((c): c is string => Boolean(c)))].sort(urut);
    const terpilih = m.baris.filter((r) => dalam(r.salesCode) && (!cabang || profil.get(r.salesCode)?.cabang?.trim() === cabang));

    let kunjungan = 0, tidakOrder = 0;
    const perAlasan = new Map<string, number>();
    const perSales = new Map<string, number>();
    for (const r of terpilih) {
        if (adaHasilKunjungan(r.status)) kunjungan += r.jumlah;
        if (r.status !== "not_order") continue;
        tidakOrder += r.jumlah;
        const kode = (r.kode ?? "").trim();
        perAlasan.set(kode, (perAlasan.get(kode) ?? 0) + r.jumlah);
        perSales.set(r.salesCode, (perSales.get(r.salesCode) ?? 0) + r.jumlah);
    }

    const alasan: BarisAlasan[] = [...perAlasan].map(([kode, jumlah]) => {
        const a = master.get(kode);
        return { kode, label: kode === "" ? LABEL_TANPA_ALASAN : a?.label ?? kode, kategori: a?.kategori ?? "", jumlah };
    }).sort((a, b) => b.jumlah - a.jumlah || urut(a.label, b.label) || urut(a.kode, b.kode));

    const perSalesman = [...perSales].map(([salesCode, jumlah]) => ({ salesCode, salesNama: profil.get(salesCode)?.nama || salesCode, jumlah }))
        .sort((a, b) => b.jumlah - a.jumlah || urut(a.salesNama, b.salesNama) || urut(a.salesCode, b.salesCode));

    return { kunjungan, tidakOrder, alasan, perSalesman, pilihanCabang };
}
