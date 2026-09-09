/*
 * Tujuan: Aturan klasifikasi baris/nota rekapan — grup outlet, area, pareto, sirup, eksklusi.
 *         Semuanya pure supaya bisa diuji tanpa DB dan dipakai ulang di parser maupun cetak.
 * Caller: app/api/rekapan-nota/** , lib/rekapan-nota/query.ts, classify.test.ts.
 * Dependensi: Tidak ada.
 * Main Functions: resolveKlasifikasi, isAreaDikecualikan, hitungPareto, klasifikasiSirup.
 * Side Effects: Tidak ada.
 */

export const GRUP_DEFAULT = "Gabung";
export const AREA_DIKECUALIKAN_DEFAULT = ["NON", "LUAR KOTA"];

export type MasterOutlet = {
    area: string | null;
    grupAll: string | null;
    grupGdi: string | null;
};

export type Klasifikasi = {
    area: string | null;
    grupAll: string;
    grupGdi: string;
};

/**
 * `Gabung` di Excel adalah nilai default dari `IFERROR(...,"Gabung")` — artinya "outlet
 * tidak terdaftar di daftar pemisahan mana pun", bukan sebuah grup yang dikelola.
 */
export function resolveKlasifikasi(master: MasterOutlet | null | undefined): Klasifikasi {
    const area = master?.area?.trim().toUpperCase() || null;
    return {
        area: area || null,
        grupAll: master?.grupAll?.trim() || GRUP_DEFAULT,
        grupGdi: master?.grupGdi?.trim() || GRUP_DEFAULT,
    };
}

/**
 * R2.5 (Q3): outlet ber-area NON / LUAR KOTA dikeluarkan dari pool SEJAK AWAL — difilter di
 * jalur masuk, bukan di lembar cetak, supaya tidak ada jalan ia menyelinap ke lembar `Gabung`.
 * Outlet yang areanya belum dipetakan (null) TIDAK dikecualikan: ia tetap masuk pool dan
 * memunculkan exception OUTLET_TANPA_AREA — hilang diam-diam justru masalah yang sedang dibereskan.
 */
export function isAreaDikecualikan(area: string | null | undefined, daftar: string[] = AREA_DIKECUALIKAN_DEFAULT): boolean {
    if (!area) return false;
    const a = area.trim().toUpperCase();
    return daftar.some((d) => d.trim().toUpperCase() === a);
}

export function parseAreaDikecualikan(setting: string | null | undefined): string[] {
    const raw = (setting ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return raw.length ? raw : AREA_DIKECUALIKAN_DEFAULT;
}

/** Pareto = volume, bukan area: total karton per NOTA >= ambang (app_setting, default 50). */
export function hitungPareto(totalKarton: number | null | undefined, ambang: number): boolean | null {
    if (totalKarton === null || totalKarton === undefined || !Number.isFinite(totalKarton)) return null;
    return totalKarton >= ambang;
}

/**
 * R6.5 (Q7): sirup Heinz disimpan di gudang fisik berbeda, jadi harus dipisah. Hanya berlaku
 * untuk produk HEINZ ABC — sesuai formula `SRP/NON` di workbook. Hari ini pemisahan itu cuma
 * diterapkan di 1 dari 29 lembar; di sini ia berlaku untuk setiap lembar yang memuat Heinz.
 */
export function klasifikasiSirup(jenisproduk: string, kodeBarang: string, namaBarang: string): "SIRUP" | "NON SIRUP" | null {
    if ((jenisproduk ?? "").trim().toUpperCase() !== "HEINZ ABC") return null;
    const isSirup = (kodeBarang ?? "").toUpperCase().startsWith("A1092")
        || (namaBarang ?? "").toUpperCase().includes("SIRUP");
    return isSirup ? "SIRUP" : "NON SIRUP";
}

/**
 * Konversi yang dipakai untuk satu baris. Data yang datang bersama transaksinya lebih
 * dipercaya daripada master yang bisa basi (R1.7). null = KONVERSI_TIDAK_ADA: barisnya
 * TETAP tercetak dengan Sat Bsr/Sat Kcl kosong, tidak dihilangkan seperti di Excel (R1.3).
 */
export function isiPerKarton(konvTersirat: number | null, isiMaster: number | null): number | null {
    if (konvTersirat && konvTersirat > 0) return konvTersirat;
    if (isiMaster && isiMaster > 0) return isiMaster;
    return null;
}
