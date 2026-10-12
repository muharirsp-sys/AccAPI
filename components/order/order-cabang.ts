/*
 * Tujuan: Logika murni Order per cabang Accurate (O2): tipe jawaban pencarian pelanggan/barang + pratinjau, kode galat O1 -> kalimat +
 *   tindakan, baris yang terbuang saat ganti pelanggan beda cabang, dan ringkasan promo per baris/per order dari hasil pratinjau.
 * Caller: components/order/{order-cabang-api.ts,useCari.ts,PemilihPelanggan.tsx,PemilihBarang.tsx,PanelPromo.tsx},
 *   app/(dashboard)/sales/OrderSales.tsx, app/(dashboard)/orders/{OrderBaru,AntreFaktur,OrderMasuk}.tsx, app/(dashboard)/orders/order-ui.ts
 *   (tipe), components/order/order-cabang.test.ts.
 * Dependensi: tidak ada (murni; tipe saja). Kontrak server: docs/handover/O1-KONTRAK-ORDER-CABANG.md §2-§3.
 * Main Functions: galatDariJawaban, cukupHuruf, urlCariPelanggan, urlCariBarang, labelSatuan, barisBedaCabang, promoBaris, ringkasPromo.
 * Side Effects: Tidak ada.
 */

/** status 0 = tanpa jawaban (putus); data null = badan bukan JSON. Sama dengan `Jawaban` di form-kontrol/lapangan. */
export type Jawaban = { status: number; data: Record<string, unknown> | null };

// ------------------------------------------------------------------ tipe pencarian (kontrak §3)

export type Cakupan = { semua: boolean; branchId: number | null; branchName: string | null };
export type PelangganPilih = {
    id: number; customerNo: string; name: string; branchId: number; branchName: string;
    /** "GT"/"MT"/… dari kategori Accurate; "" = kategori belum diisi (server menolak order tanpa channel). */
    channel: string; categoryName: string | null; priceCategoryName: string | null; alamat: string | null;
};
export type UnitHarga = { unit: string; price: number | null; source?: string; branchName?: string | null; effectiveDate?: string | null };
export type BarangPilih = {
    id: number; no: string; name: string; branchId: number | null; branchName: string | null; tag: string | null; units: UnitHarga[];
    /** Harga di `units` berlaku untuk pelanggan+tanggal ini; berubah = harga di daftar dianggap basi (yang final tetap dari pratinjau). */
    hargaUntuk: string;
};

// ------------------------------------------------------------------ tipe pratinjau (bentuk respons /api/orders/preview + FastAPI)

export type ResultLine = { code: string; unit: string; quantity: string; gross: string; net: string; percents?: string[]; cash?: string };
export type Bonus = { program_id: string; code: string; unit: string; quantity: string; eligible_codes?: string[]; program_name?: string };
export type Blocked = { program_id: string; program_name?: string; reason?: string };
export type Result = {
    pending_price?: boolean; gross?: string; discount?: string; net?: string;
    lines?: ResultLine[]; applications?: { program_id: string; minimum: string; discount: string; program_name?: string }[]; bonuses?: Bonus[];
    blocked?: Blocked[];
};
export type Suggestion = { program_id: string; program_name?: string; message: string; codes: string[] };
export type PriceInfo = {
    code: string; unit: string; price: number | null; source: string; priceCategoryName: string | null;
    branchName: string | null; effectiveDate: string | null;
};

// ------------------------------------------------------------------ pencarian

/** Kontrak O1 §catatan putaran 1: debounce >= 300 ms, minimal 2 huruf, permintaan lama dibatalkan. */
export const JEDA_CARI_MS = 300;
export const MIN_HURUF = 2;
export const cukupHuruf = (q: string) => q.trim().length >= MIN_HURUF;

const query = (p: Record<string, string | number | null | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined && String(v) !== "") s.set(k, String(v));
    const teks = s.toString();
    return teks ? `?${teks}` : "";
};

export const urlCariPelanggan = (o: { q?: string; branchId?: number | null; limit?: number }) =>
    `/api/customers/search${query({ q: o.q?.trim(), branchId: o.branchId, limit: o.limit })}`;

export const urlCariBarang = (o: { q?: string; customerId?: number | null; tanggal?: string; limit?: number }) =>
    `/api/items/search${query({ q: o.q?.trim(), customerId: o.customerId, tanggal: o.tanggal, limit: o.limit })}`;

export const urlSalesmanCabang = (branchId: number | null | undefined) =>
    `/api/orders/salesmen${query({ branchId })}`;

const angka = (v: unknown) => (typeof v === "number" ? v : v === null || v === undefined || v === "" ? NaN : Number(v));
const teksAtauNull = (v: unknown) => (typeof v === "string" && v ? v : null);

export function bacaPelanggan(raw: unknown): PelangganPilih | null {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = angka(r.id), branchId = angka(r.branchId);
    if (!Number.isFinite(id) || !Number.isFinite(branchId) || typeof r.customerNo !== "string" || !r.customerNo) return null;
    return {
        id, customerNo: r.customerNo, name: String(r.name ?? ""), branchId, branchName: String(r.branchName ?? ""),
        channel: String(r.channel ?? "").trim().toUpperCase(), categoryName: teksAtauNull(r.categoryName),
        priceCategoryName: teksAtauNull(r.priceCategoryName), alamat: teksAtauNull(r.alamat),
    };
}

export function bacaBarang(raw: unknown, hargaUntuk: string): BarangPilih | null {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = angka(r.id);
    if (!Number.isFinite(id) || typeof r.no !== "string" || !r.no) return null;
    const units = (Array.isArray(r.units) ? r.units : []).flatMap((u): UnitHarga[] => {
        const o = (u ?? {}) as Record<string, unknown>;
        if (typeof o.unit !== "string" || !o.unit) return [];
        const price = angka(o.price);
        return [{ unit: o.unit, price: Number.isFinite(price) && price > 0 ? price : null, source: teksAtauNull(o.source) ?? undefined,
            branchName: teksAtauNull(o.branchName), effectiveDate: teksAtauNull(o.effectiveDate) }];
    });
    const branchId = angka(r.branchId);
    return { id, no: r.no, name: String(r.name ?? ""), branchId: Number.isFinite(branchId) ? branchId : null,
        branchName: teksAtauNull(r.branchName), tag: teksAtauNull(r.tag), units, hargaUntuk };
}

/** Kunci "harga di daftar masih berlaku": pelanggan (kategori harga) + tanggal order. */
export const kunciHarga = (pelangganId: number | null | undefined, tanggal: string) => `${pelangganId ?? ""}|${tanggal}`;

/** "KRT · Rp 576.000" bila harga di daftar masih berlaku untuk pelanggan+tanggal ini, selain itu hanya satuannya ("harga belum ada" bila kosong). */
export function labelSatuan(u: UnitHarga, berlaku: boolean, format: (n: number) => string): string {
    if (!berlaku) return u.unit;
    return u.price === null ? `${u.unit} · harga belum ada` : `${u.unit} · ${format(u.price)}`;
}

// ------------------------------------------------------------------ galat -> kalimat + tindakan

export type Peran = "sales" | "petugas";

export type Galat = {
    /** Kode server (SALESMAN_BELUM_TERHUBUNG, …) atau TANPA_SINYAL / BELUM_PASTI / SESI_BERAKHIR / GALAT. */
    kode: string;
    judul: string;
    pesan: string;
    /** Apa yang harus dilakukan pemakai. */
    tindakan: string;
    /** Aturan yang PASTI menolak: simpan/kirim akan ditolak server juga, jadi layar mengunci aksinya. */
    menolak: boolean;
    /** Putus / >= 502 / bukan JSON: hasilnya belum pasti (bukan "tidak ada"). */
    tidakPasti: boolean;
    /** Salesman belum bisa memakai layar sama sekali (akun belum tertaut / karyawan tidak aktif). */
    blokirSales: boolean;
    /** Barang yang dipersoalkan server -> kalimat per barang (untuk barisnya). */
    perBarang: Record<string, string>;
};

type Aturan = { judul: string; pesan?: (d: Record<string, unknown>) => string; tindakan: string | Record<Peran, string>; menolak?: boolean; blokirSales?: boolean };

const dariServer = (d: Record<string, unknown>, cadangan: string) => (typeof d.error === "string" && d.error ? d.error : typeof d.detail === "string" && d.detail ? d.detail : cadangan);

const ATURAN: Record<string, Aturan> = {
    SALESMAN_BELUM_TERHUBUNG: {
        judul: "Akun Anda belum dihubungkan ke karyawan Accurate",
        pesan: () => "Akun ini belum ditautkan ke karyawan salesman di Accurate, jadi cabang Anda belum diketahui dan order belum bisa dibuat.",
        tindakan: "Hubungi Admin untuk menautkan akun Anda ke karyawan salesman Accurate (layar User).", menolak: true, blokirSales: true,
    },
    SALESMAN_TIDAK_AKTIF: {
        judul: "Karyawan Accurate Anda tidak aktif",
        pesan: () => "Karyawan yang ditautkan ke akun ini nonaktif, bukan salesman, atau belum punya cabang di Accurate.",
        tindakan: "Hubungi Admin untuk memeriksa data karyawan Anda di Accurate.", menolak: true, blokirSales: true,
    },
    CABANG_DI_LUAR_CAKUPAN: {
        judul: "Di luar cabang Anda",
        pesan: (d) => dariServer(d, "Salesman hanya bisa order untuk pelanggan di cabangnya sendiri."),
        tindakan: "Pilih pelanggan di cabang Anda.", menolak: true,
    },
    PELANGGAN_WAJIB: { judul: "Pelanggan belum dipilih", pesan: () => "Order butuh pelanggan Accurate.", tindakan: "Cari dan pilih pelanggan dulu.", menolak: true },
    PELANGGAN_TIDAK_ADA: {
        judul: "Pelanggan tidak ada di master", pesan: (d) => dariServer(d, "Pelanggan tidak ada di master Accurate hasil sinkron."),
        tindakan: { sales: "Cari ulang namanya. Bila memang baru, minta Admin menyinkronkan master pelanggan.", petugas: "Cari ulang namanya, atau sinkronkan master pelanggan dari Accurate." }, menolak: true,
    },
    PELANGGAN_SUSPENDED: {
        judul: "Pelanggan nonaktif di Accurate", pesan: (d) => dariServer(d, "Pelanggan nonaktif (suspended) di Accurate; tidak bisa diorder."),
        tindakan: { sales: "Pilih pelanggan lain, atau minta Admin mengaktifkannya kembali di Accurate.", petugas: "Pilih pelanggan lain, atau aktifkan kembali di Accurate lalu sinkronkan." }, menolak: true,
    },
    PELANGGAN_TANPA_CABANG: {
        judul: "Pelanggan belum punya cabang", pesan: (d) => dariServer(d, "Pelanggan belum punya cabang di Accurate."),
        tindakan: { sales: "Minta Admin mengisi cabang pelanggan di Accurate.", petugas: "Isi cabang pelanggan di Accurate, lalu sinkronkan." }, menolak: true,
    },
    BARANG_TIDAK_ADA: {
        judul: "Barang tidak ada di master", pesan: (d) => dariServer(d, "Barang tidak ada di master Accurate."),
        tindakan: "Hapus barang itu dari order, atau cari barang lain.", menolak: true,
    },
    BARANG_SUSPENDED: {
        judul: "Barang nonaktif di Accurate", pesan: (d) => dariServer(d, "Barang nonaktif (suspended) di Accurate."),
        tindakan: "Hapus barang itu dari order, atau cari barang lain.", menolak: true,
    },
    BARANG_BEDA_CABANG: {
        judul: "Barang bukan milik cabang pelanggan", pesan: (d) => dariServer(d, "Pelanggan hanya bisa dipesankan barang dari cabangnya."),
        tindakan: "Hapus barang itu, lalu cari barang yang milik cabang pelanggan.", menolak: true,
    },
    SATUAN_SALAH: {
        judul: "Satuan tidak cocok dengan master", pesan: (d) => dariServer(d, "Satuan tidak ada di master untuk barang ini."),
        tindakan: "Pilih salah satu satuan yang tersedia di barisnya.", menolak: true,
    },
    HARGA_BELUM_ADA: {
        judul: "Harga belum ada di Accurate", pesan: (d) => dariServer(d, "Harga belum tersedia dari Accurate untuk barang ini di cabang pelanggan."),
        tindakan: {
            sales: "Order dengan barang ini belum bisa dikirim. Minta petugas melengkapi harganya di Accurate.",
            petugas: "Isi harga barangnya manual di barisnya, atau lengkapi daftar harga di Accurate lalu sinkronkan.",
        }, menolak: true,
    },
    INPUT_TIDAK_VALID: { judul: "Isian tidak valid", pesan: (d) => dariServer(d, "Isian tidak sesuai aturan server."), tindakan: "Periksa isiannya lalu coba lagi." },
    TIDAK_DIIZINKAN: {
        judul: "Akun Anda tidak berizin", pesan: (d) => dariServer(d, "Akun ini tidak punya izin untuk layar ini."),
        tindakan: "Minta Admin menambahkan izinnya ke grup akses Anda.", menolak: true,
    },
    // ponytail: nama kode penolakan "salesman beda cabang" di Antre Faktur belum ada di kontrak O1; dipetakan dari dugaan nama +
    // kalimat server. Betulkan bila putaran perbaikan O1 memakai kode lain (cukup tambah kuncinya di sini).
    SALESMAN_BEDA_CABANG: {
        judul: "Salesman bukan dari cabang pelanggan", pesan: (d) => dariServer(d, "Salesman faktur harus karyawan cabang yang sama dengan pelanggan order."),
        tindakan: "Pilih salesman dari daftar (hanya salesman cabang pelanggan).", menolak: true,
    },
};

const kodeBarangDari = (d: Record<string, unknown>): { kode: string; baris: string }[] => {
    const hasil: { kode: string; baris: string }[] = [];
    const tambah = (kode: unknown, baris: string) => { if (typeof kode === "string" && kode) hasil.push({ kode, baris }); };
    if (Array.isArray(d.barang)) {
        for (const b of d.barang) {
            if (typeof b === "string") { tambah(b, "Tidak ada atau tidak bisa dipakai di order ini."); continue; }
            const o = (b ?? {}) as Record<string, unknown>;
            const asal = o.branchId === null || o.branchId === undefined
                ? `tanpa cabang${typeof o.tag === "string" && o.tag ? ` (tag "${o.tag}" tidak bisa diorder)` : ""}`
                : `milik cabang ${String(o.branchName ?? o.branchId)}`;
            tambah(o.code, `${typeof o.name === "string" && o.name ? `${o.name} ` : ""}${asal}, bukan cabang pelanggan.`);
        }
    }
    if (Array.isArray(d.missing)) for (const k of d.missing) tambah(k, "Harga belum ada di Accurate untuk cabang pelanggan.");
    if (Array.isArray(d.wrong_unit)) {
        for (const w of d.wrong_unit) {
            const o = (w ?? {}) as Record<string, unknown>;
            const ada = Array.isArray(o.known_units) ? (o.known_units as string[]).join(" atau ") : "";
            tambah(o.code, `Satuan ${String(o.unit ?? "")} tidak ada${ada ? `; pilih ${ada}` : ""}.`);
        }
    }
    return hasil;
};

/**
 * Jawaban server -> kalimat + tindakan. Putus (0), >= 502, atau bukan JSON = "hasilnya belum pasti" (tidak pernah "kosong"/"tidak ada").
 * Kode dibaca dari `kode` (rute order) atau `code` (rute admin); kode yang belum dikenal memakai kalimat server apa adanya.
 */
export function galatDariJawaban(j: Jawaban, peran: Peran = "petugas"): Galat {
    const dasar = { menolak: false, blokirSales: false, perBarang: {} as Record<string, string> };
    if (j.status === 0) {
        return { ...dasar, kode: "TANPA_SINYAL", judul: "Tidak tersambung ke server", tidakPasti: true,
            pesan: "Permintaan tidak sampai ke server, jadi hasilnya belum pasti.", tindakan: "Periksa sinyal, lalu coba lagi." };
    }
    if (j.status >= 502 || j.data === null) {
        return { ...dasar, kode: "BELUM_PASTI", judul: "Hasilnya belum pasti", tidakPasti: true,
            pesan: "Server tidak memberi jawaban yang jelas (sibuk atau mati sebentar).", tindakan: "Muat ulang data, lalu periksa sebelum mengulang." };
    }
    const d = j.data;
    const kode = typeof d.kode === "string" ? d.kode : typeof d.code === "string" ? d.code : "";
    const a = kode ? ATURAN[kode] : undefined;
    if (a) {
        const perBarang = Object.fromEntries(kodeBarangDari(d).map((b) => [b.kode, b.baris]));
        return { kode, judul: a.judul, pesan: a.pesan ? a.pesan(d) : dariServer(d, a.judul), tindakan: typeof a.tindakan === "string" ? a.tindakan : a.tindakan[peran],
            menolak: Boolean(a.menolak), tidakPasti: false, blokirSales: Boolean(a.blokirSales), perBarang };
    }
    if (j.status === 401) {
        return { ...dasar, kode: "SESI_BERAKHIR", judul: "Sesi login berakhir", tidakPasti: false, pesan: "Sesi Anda sudah berakhir.", tindakan: "Masuk ulang, lalu coba lagi." };
    }
    if (j.status === 403) {
        return { ...dasar, kode: kode || "TIDAK_DIIZINKAN", judul: "Akun Anda tidak berizin", tidakPasti: false, menolak: true,
            pesan: dariServer(d, "Akun ini tidak punya izin untuk layar ini."), tindakan: "Minta Admin menambahkan izinnya ke grup akses Anda." };
    }
    return { ...dasar, kode: kode || "GALAT", judul: "Permintaan ditolak server", tidakPasti: false,
        pesan: dariServer(d, "Server menolak permintaan ini."), tindakan: "Periksa isiannya lalu coba lagi; bila terulang, hubungi Admin." };
}

/** Satu kalimat untuk strip/alasan kunci: "Pesan Tindakan". */
export const kalimatGalat = (g: Galat) => `${g.pesan} ${g.tindakan}`;

/** Kode yang punya kalimat sendiri di sini (dipakai pemanggil lain untuk memutuskan memakai kalimat ini atau kalimat server). */
export const kodeDikenal = (kode: string) => kode in ATURAN;

/**
 * Kalimat penolakan simpan/kirim untuk dialog: kode yang dikenal = "Judul. Pesan Tindakan"; kode yang belum dikenal = kalimat server apa adanya
 * (aturan lain: channel beda master 422, dugaan order ganda 409, aturan promo belum terbit 409 — tampil persis seperti sebelum O2).
 */
export const kalimatPenolakan = (g: Galat) => (g.kode in ATURAN ? `${g.judul}. ${kalimatGalat(g)}` : g.tidakPasti || g.kode === "SESI_BERAKHIR" ? `${g.judul}. ${kalimatGalat(g)}` : g.pesan);

/** Kode dibaca dari rute hari ini / draf / pemulihan tetapi tidak ada di hasil pencarian: bukan galat server, jadi bukan "belum pasti". */
export function galatTidakDitemukan(jenis: "pelanggan" | "barang", kode: string, peran: Peran = "petugas"): Galat {
    const dasar = { tidakPasti: false, blokirSales: false, perBarang: {} as Record<string, string> };
    if (jenis === "pelanggan") {
        return { ...dasar, kode: "PELANGGAN_TIDAK_ADA", menolak: true, judul: "Pelanggan tidak ditemukan",
            pesan: `Pelanggan ${kode} tidak ditemukan. Mungkin sudah nonaktif, ${peran === "sales" ? "di luar cabang Anda, " : ""}atau belum ada di master Accurate hasil sinkron.`,
            tindakan: "Cari pelanggan lain dengan nama atau kodenya." };
    }
    return { ...dasar, kode: "BARANG_TIDAK_ADA", menolak: true, judul: "Barang tidak ditemukan",
        pesan: `Barang ${kode} tidak ada di cabang pelanggan ini (atau sudah nonaktif).`, tindakan: "Hapus barisnya, atau cari barang lain." };
}

// ------------------------------------------------------------------ ganti pelanggan beda cabang

/** Baris berbarang yang cabangnya bukan `cabangBaru` — dibuang (dengan konfirmasi) saat pelanggan diganti ke cabang lain. */
export function barisBedaCabang<T extends { code: string; barang: { branchId: number | null } | null }>(lines: T[], cabangBaru: number): { dibuang: T[]; tersisa: T[] } {
    const dibuang: T[] = [], tersisa: T[] = [];
    for (const l of lines) {
        if (l.code.trim() && l.barang?.branchId !== cabangBaru) dibuang.push(l); else tersisa.push(l);
    }
    return { dibuang, tersisa };
}

// ------------------------------------------------------------------ promo (bentuk respons pratinjau yang ada sekarang)

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export type PromoBaris = { gross: number; net: number; diskon: number; persen: string[]; tunai: number; bonus: Bonus[] };

/** Diskon + bonus untuk satu baris order (kode + satuan). null = server tidak menghitung baris ini (belum ada hasil / baris tanpa harga). */
export function promoBaris(result: Result | null | undefined, code: string, unit: string): PromoBaris | null {
    const baris = result?.lines?.find((l) => l.code === code && l.unit === unit);
    if (!baris) return null;
    // Bonus "dari barang yang dibeli" menempel di barang yang memenuhi syarat; bonus berkode barang tertentu tampil di ringkasan order.
    const bonus = (result?.bonuses ?? []).filter((b) => !b.code && (b.eligible_codes ?? []).includes(code));
    return { gross: num(baris.gross), net: num(baris.net), diskon: Math.max(0, num(baris.gross) - num(baris.net)),
        persen: (baris.percents ?? []).map(String), tunai: num(baris.cash), bonus };
}

const namaProgram = (id: string, nama: string | undefined, result: Result, saran: Suggestion[]) =>
    nama || saran.find((s) => s.program_id === id)?.program_name || result.blocked?.find((b) => b.program_id === id)?.program_name || `Program #${id.slice(0, 8)}`;

export type RingkasPromo = {
    gross: number; diskon: number; net: number;
    program: { id: string; nama: string; diskon: number }[];
    /** Bonus berkode barang sendiri (bukan "dari barang yang dibeli"). */
    bonusLain: { nama: string; kode: string; unit: string; jumlah: string }[];
    /** Program yang sebenarnya ada tetapi tidak berlaku untuk outlet ini + sebabnya. */
    tidakBerlaku: { nama: string; alasan: string }[];
};

export function ringkasPromo(result: Result | null | undefined, saran: Suggestion[] = []): RingkasPromo | null {
    if (!result) return null;
    return {
        gross: num(result.gross), diskon: num(result.discount), net: num(result.net),
        program: (result.applications ?? []).map((a) => ({ id: a.program_id, nama: namaProgram(a.program_id, a.program_name, result, saran), diskon: num(a.discount) })),
        bonusLain: (result.bonuses ?? []).filter((b) => b.code).map((b) => ({ nama: namaProgram(b.program_id, b.program_name, result, saran), kode: b.code, unit: b.unit, jumlah: b.quantity })),
        tidakBerlaku: (result.blocked ?? []).map((b) => ({ nama: namaProgram(b.program_id, b.program_name, result, saran), alasan: b.reason ?? "tidak memenuhi syarat outlet" })),
    };
}
