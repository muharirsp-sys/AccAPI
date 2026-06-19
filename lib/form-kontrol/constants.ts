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
] as const;

export const PRINCIPLES = ["GODREJ", "MONTISS", "MUSTIKA RATU", "SOFTEX"] as const;
export const HARI_KUNJUNGAN = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"] as const;
export const MINGGU_PATTERNS = ["ganjil", "genap", "all"] as const;

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
