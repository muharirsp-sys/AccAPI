export const NO_ORDER_REASONS = [
    { id: "R01", reasonCode: "R01", label: "Stok masih cukup",               category: "stok",    sortOrder: 1,  isActive: true },
    { id: "R02", reasonCode: "R02", label: "SKU belum lengkap",               category: "produk",  sortOrder: 2,  isActive: true },
    { id: "R03", reasonCode: "R03", label: "Produk belum terpajang",          category: "produk",  sortOrder: 3,  isActive: true },
    { id: "R04", reasonCode: "R04", label: "Produk sulit ditemukan konsumen", category: "produk",  sortOrder: 4,  isActive: true },
    { id: "R05", reasonCode: "R05", label: "PIC belum mengenal produk",       category: "relasi",  sortOrder: 5,  isActive: true },
    { id: "R06", reasonCode: "R06", label: "PIC belum percaya",               category: "relasi",  sortOrder: 6,  isActive: true },
    { id: "R07", reasonCode: "R07", label: "Toko masih punya tagihan OD",     category: "tagihan", sortOrder: 7,  isActive: true },
    { id: "R08", reasonCode: "R08", label: "Salesmanship belum kuat",         category: "proses",  sortOrder: 8,  isActive: true },
    { id: "R09", reasonCode: "R09", label: "Negosiasi belum berhasil",        category: "proses",  sortOrder: 9,  isActive: true },
    { id: "R10", reasonCode: "R10", label: "Kunjungan kurang rutin",          category: "proses",  sortOrder: 10, isActive: true },
    { id: "R11", reasonCode: "R11", label: "Toko kurang diperhatikan",        category: "proses",  sortOrder: 11, isActive: true },
    { id: "R12", reasonCode: "R12", label: "SKU terbatas",                    category: "produk",  sortOrder: 12, isActive: true },
    { id: "R13", reasonCode: "R13", label: "Prioritas toko rendah",           category: "proses",  sortOrder: 13, isActive: true },
    { id: "R14", reasonCode: "R14", label: "Lainnya",                         category: "lainnya", sortOrder: 14, isActive: true },
    // S5-2 (owner 8 Okt): toko tutup → foto bukti (check-out) wajib, tanpa merchandising & tanpa order.
    { id: "R15", reasonCode: "R15", label: "Toko tutup",                      category: "kunjungan", sortOrder: 15, isActive: true },
] as const;

export const TOKO_TUTUP_CODE = "R15";

/**
 * #21: status not_order wajib membawa kode alasan aktif (code sudah dipangkas; kosong = null).
 * Kirim ulang baris yang di DB sudah not_order dengan kode sama (Submit AO lama mengirim semua baris) tetap lolos.
 */
export function validateNoOrderReason(
    status: string, code: string | null, activeCodes: readonly string[],
    existing?: { status: string; noOrderReasonCode: string | null } | null,
): string | null {
    if (status !== "not_order") return null;
    if (existing?.status === "not_order" && (existing.noOrderReasonCode ?? null) === code) return null;
    if (!code) return "Alasan tidak order wajib dipilih.";
    if (!activeCodes.includes(code)) return `Kode alasan tidak order "${code}" tidak aktif atau tidak dikenal.`;
    return null;
}

export const HARI_KUNJUNGAN = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"] as const;
export const MINGGU_PATTERNS = ["ganjil", "genap", "all"] as const;

/**
 * Kunci pembanding hari JKS: huruf besar tanpa spasi/tanda ("SENIN", " Senin ", "JUM'AT" → "SENIN"/"JUMAT"). Rute membandingkan kunci,
 * jadi JKS yang sudah tersimpan HURUF BESAR terbaca tanpa unggah ulang. SAMA dengan ekspresi SQL `kunciHariSql` di db.ts.
 */
export const kunciHari = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z]/g, "");
const HARI_BAKU = new Map<string, string>(HARI_KUNJUNGAN.map((h) => [kunciHari(h), h]));
/**
 * Bentuk baku hari untuk disimpan saat unggah: "" = kosong (boleh, ditandai di Kontrol JKS); null = tidak dikenal (baris ditolak).
 * Kosong diputuskan dari teks mentah ter-trim, bukan dari kunci: "1", "-", "?" berkunci kosong tetapi BUKAN sel kosong → ditolak.
 */
export function hariBaku(v: unknown): string | null {
    if (!String(v ?? "").trim()) return "";
    return HARI_BAKU.get(kunciHari(v)) ?? null;
}

// ponytail: acuan paritas minggu JKS (keputusan owner 12 Okt 2026) — minggu yang memuat Senin 12 Okt 2026 (tanggal WITA) = GENAP, lalu
//   selang-seling terus Senin-ke-Senin; BUKAN nomor minggu ISO (2026 punya 53 minggu ISO: 28 Des 2026 dan 4 Jan 2027 sama-sama ganjil).
//   Plafon: mengganti acuan membalik pola ganjil/genap SEMUA JKS sekaligus — hanya atas keputusan owner.
export const ACUAN_MINGGU_GENAP = "2026-10-12";
const nomorHari = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };
/**
 * Paritas minggu untuk tanggal kalender WITA "YYYY-MM-DD" (tanggal yang dikirim layar, hariIniWita): selisih minggu dari acuan, negatif
 * juga benar. Satu-satunya hitungan paritas — SQL hanya membandingkan pola tersimpan dengan hasil fungsi ini (db.ts polaMinggu).
 */
export function paritasMinggu(ymd: string): "ganjil" | "genap" {
    const minggu = Math.floor((nomorHari(ymd) - nomorHari(ACUAN_MINGGU_GENAP)) / 7);
    return minggu % 2 === 0 ? "genap" : "ganjil";
}

/** FK-MSM butir 5: kunci nama SPV/SM — trim + huruf besar (" spv a " = "SPV A"); kosong tidak cocok apa pun (pemanggil menjaga). */
export const kunciNama = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

/**
 * Hierarki Sales (owner 13 Okt 2026): nama SPV/SM di sales_profile WAJIB nama akun aktif ber-role itu, karena cakupan (resolveScope)
 * mencocokkan nama AKUN sesi dengan nama ini. `akun` = nama akun aktif ber-role itu (scope.ts namaAkunPeran, akhiran dibuang, BOLEH ganda).
 * Kosong/null = melepas (null). Tidak ada akun = 400 SPV_/SM_TIDAK_DIKENAL; lebih dari satu akun bernama sama = 409 NAMA_GANDA (cakupan
 * akan bocor ke dua akun). Yang disimpan = ejaan AKUN, bukan ketikan.
 */
export function pilihNamaAkun(nama: unknown, akun: readonly string[], peran: "SPV" | "SM"):
    { nama: string | null } | { galat: { status: number; kode: string; error: string } } {
    if (nama != null && typeof nama !== "string") return { galat: { status: 400, kode: "INPUT_TIDAK_VALID", error: `Nama ${peran} harus teks.` } };
    const teks = typeof nama === "string" ? nama.trim() : "";
    const k = kunciNama(teks);
    if (!k) return { nama: null };
    const cocok = akun.filter((a) => kunciNama(a) === k);
    if (cocok.length === 1) return { nama: cocok[0] };
    return cocok.length === 0
        ? { galat: { status: 400, kode: `${peran}_TIDAK_DIKENAL`, error: `${peran} "${teks}" tidak cocok dengan akun ${peran} aktif mana pun; pilih dari daftar akun.` } }
        : { galat: { status: 409, kode: "NAMA_GANDA", error: `Ada ${cocok.length} akun ${peran} aktif bernama "${cocok[0]}" — cakupan akan terbagi ke semuanya; ubah nama salah satu akun dulu.` } };
}

// FK-MSM2: kunjungan luar rute.
/**
 * Kode toko JKS yang COCOK (lib/order-cabang cocokKodeRute) dengan pelanggan Accurate `customerNo` — kebalikannya: customerNo itu sendiri dan
 * customerNo tanpa SATU akhiran terakhir ("C-100001-CBA" → ["C-100001-CBA", "C-100001"]). Huruf besar, ter-trim; spasi dalam tidak ditebak.
 * Dipakai server (cari toko di JKS sendiri / salesman lain, kode pendek maupun lengkap) DAN layar Rute (toko pilihan sudah di rute?).
 * Murni (tanpa impor server) supaya aman di klien; lib/form-kontrol/fk-msm2.test.ts membuktikan kesetaraannya dengan cocokKodeRute.
 */
export function kodeJksUntuk(customerNo: string): string[] {
    const c = String(customerNo ?? "").trim().toUpperCase();
    if (!c) return [];
    const i = c.lastIndexOf("-");
    return i > 0 && i < c.length - 1 ? [c, c.slice(0, i)] : [c];
}

export const DAY_TO_HARI: Record<number, string> = {
    1: "Senin",
    2: "Selasa",
    3: "Rabu",
    4: "Kamis",
    5: "Jumat",
    6: "Sabtu",
};

export const MERCHANDISING_ITEMS = [
    { key: "produkJelas", label: "Produk terlihat jelas" },
    { key: "displayRapi", label: "Display rapi" },
    { key: "dibersihkan", label: "Produk dibersihkan" },
    { key: "ditataulang", label: "Ditata ulang" },
    { key: "posisiMudah", label: "Posisi mudah ditemukan konsumen" },
    { key: "semuaSku",    label: "Seluruh SKU terpajang" },
] as const;

/** Prioritas = status "priority" (tidak ada kolom terpisah), jadi bintang hanya untuk toko yang belum punya hasil kunjungan. */
export const adaHasilKunjungan = (status: string) => status === "ordered" || status === "active" || status === "not_order";

/** Toggle bintang: prioritas ↔ tidak dikunjungi. Batal bintang BUKAN "tidak order" (owner 8 Okt 2026). Hasil kunjungan tidak disentuh. */
export function statusBintang<S extends string>(status: S): S | "priority" | "not_visited" {
    if (adaHasilKunjungan(status)) return status;
    return status === "priority" ? "not_visited" : "priority";
}
