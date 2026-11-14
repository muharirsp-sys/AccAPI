/**
 * Tujuan: Aturan tetap owner (13 Nov 2026): 8 toko NKA/DC tidak boleh "ditutup" di Accurate, di semua divisi
 *   (kode dasar dan varian principal, mis. C-IND051-KN), meskipun tidak ada transaksi atau tercatat atas nama siapa pun.
 *   Ditutup = dinonaktifkan (`suspended`), atau diberi batas yang menahan pesanannya: batas total piutang
 *   (`customerLimitAmount` / `customerLimitAmountValue`) dan batas umur piutang dalam hari (`customerLimitAge` /
 *   `customerLimitAgeValue`). Bukti: Pesanan Penjualan ALFAMART (C-AL0063) ditolak Accurate "melewati batas piutang".
 *   Mematikan batas tetap boleh. Hapus (`customer/delete.do`) sudah ditolak katalog Konsol (isCatalogWrite).
 * Caller: app/api/proxy/route.ts (tulis customer/save.do & bulk-save.do lewat Konsol), sebelum diteruskan.
 * Dependensi: tidak ada; pencarian kode dari id (GET customer/detail.do) disuntikkan pemanggil.
 * Main Functions: PELANGGAN_TERLINDUNGI, isPelangganTerlindungi, periksaPenutupanPelanggan.
 * Side Effects: tidak ada di modul ini.
 */

export const PELANGGAN_TERLINDUNGI = [
    "C-IND051", "C-IN0050", "C-AL0063", "C-AL0064", "C-ALF052", "C-IND080", "C-IND086", "C-IN0088",
] as const;

type Rec = Record<string, unknown>;
const norm = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim().toUpperCase());
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Kode dasar, atau varian divisinya (diikuti apa pun selain angka). Diikuti angka = toko lain (C-IND0801 ≠ C-IND080). */
export function isPelangganTerlindungi(no: unknown): boolean {
    const s = norm(no);
    return s !== "" && PELANGGAN_TERLINDUNGI.some((k) => s === k || (s.startsWith(k) && !/[0-9]/.test(s.charAt(k.length))));
}

/** Semua nilai kolom bernama itu tanpa membedakan huruf besar/kecil ("suspended" dan "Suspended" bisa sama-sama ada). */
const kolom = (rec: Rec, ...nama: string[]) =>
    Object.keys(rec).filter((k) => nama.includes(k.toLowerCase())).flatMap((k) => rec[k]);

// Fail-closed: hanya "mati" yang tegas dianggap mati; nilai tak dikenal ("on", "ya", 1) = menyala.
const TEKS_MATI = new Set(["FALSE", "0", "N", "NO", "TIDAK", "OFF"]);
const menyala = (v: unknown) => v !== false && v !== 0 && norm(v) !== "" && !TEKS_MATI.has(norm(v));
const matiTegas = (v: unknown) => v === false || v === 0 || TEKS_MATI.has(norm(v));

const BATAS = [
    ["customerlimitamount", "customerlimitamountvalue", "batas piutang"],
    ["customerlimitage", "customerlimitagevalue", "batas umur piutang (hari)"],
] as const;

/**
 * Cara satu baris menutup pelanggan. Batas dipasang bila kolom aktifnya menyala, ATAU nilainya dikirim tanpa mematikan
 * kolom aktifnya secara tegas: bila batas sudah menyala di Accurate, nilai baru langsung berlaku (kolom aktif kosong/null,
 * mis. sel Excel kosong, = tidak dinyatakan, bukan mati).
 */
function alasanMenutup(rec: Rec): string[] {
    const alasan = kolom(rec, "suspended").some(menyala) ? ["dinonaktifkan"] : [];
    for (const [aktif, nilai, nama] of BATAS) {
        const flags = kolom(rec, aktif);
        const dimatikan = flags.some(matiTegas) && !flags.some(menyala);
        if (flags.some(menyala) || (kolom(rec, nilai).some((v) => norm(v) !== "") && !dimatikan)) alasan.push(nama);
    }
    return alasan;
}

/**
 * Semua kandidat baris pelanggan dalam payload: objek tunggal, array bulk, { data: [...] }/{ data: {...} }, objek bersarang,
 * teks JSON, dan kunci datar "x[n].field" (dikelompokkan per awalan+indeks). Baris tanpa alasan menutup diabaikan pemanggil.
 * ponytail: kedalaman dibatasi 6 (payload lebih dalam tidak dibaca); Accurate tidak membaca kolom pelanggan sedalam itu.
 */
function barisDari(v: unknown, dalam = 0): Rec[] {
    if (dalam > 6) return [];
    if (typeof v === "string") {
        if (!/^\s*[[{]/.test(v)) return [];
        try { return barisDari(JSON.parse(v), dalam + 1); } catch { return []; }
    }
    if (Array.isArray(v)) return v.flatMap((x) => barisDari(x, dalam + 1));
    if (!isRec(v)) return [];
    const datar = new Map<string, Rec>();
    const sisa: Rec = {};
    for (const [k, x] of Object.entries(v)) {
        const m = k.match(/^(\w+)\[(\d+)\]\.(.+)$/);
        if (!m) { sisa[k] = x; continue; }
        const key = `${m[1].toLowerCase()}[${m[2]}]`;
        datar.set(key, { ...datar.get(key), [m[3]]: x });
    }
    return [sisa, ...datar.values(), ...Object.values(v).flatMap((x) => barisDari(x, dalam + 1))];
}

export type HasilPenutupan = { kode: string[]; alasan: string[]; idTakTerbaca: string[] };

/**
 * Apakah tulis customer ini menutup toko terlindungi? `cariKode(id)` = kode pelanggan untuk id Accurate (null bila tidak
 * ada; melempar bila gagal baca). Dipanggil sekali per id, hanya untuk baris yang menutup dan membawa id (pada update
 * Accurate memakai id; kode di payload bisa kode baru). Gagal/tidak ditemukan = idTakTerbaca (pemanggil menolak, fail-closed).
 * ponytail: 4 pencarian bersamaan; bulk ratusan baris ber-id = ratusan GET detail.do. Plafon: daftar id 8 toko dari list.do.
 */
export async function periksaPenutupanPelanggan(payload: unknown, cariKode: (id: string) => Promise<string | null>): Promise<HasilPenutupan> {
    const kode = new Set<string>();
    const alasan = new Set<string>();
    const idTakTerbaca = new Set<string>();
    const perId = new Map<string, string[]>();
    for (const rec of barisDari(payload)) {
        const why = alasanMenutup(rec);
        if (why.length === 0) continue;
        for (const no of kolom(rec, "customerno", "no")) {
            if (isPelangganTerlindungi(no)) { kode.add(norm(no)); why.forEach((w) => alasan.add(w)); }
        }
        for (const id of kolom(rec, "id").map(norm).filter(Boolean)) perId.set(id, [...(perId.get(id) ?? []), ...why]);
    }
    const ids = [...perId.keys()];
    for (let i = 0; i < ids.length; i += 4) {
        await Promise.all(ids.slice(i, i + 4).map(async (id) => {
            try {
                const no = await cariKode(id);
                if (no === null) idTakTerbaca.add(id);
                else if (isPelangganTerlindungi(no)) { kode.add(norm(no)); (perId.get(id) ?? []).forEach((w) => alasan.add(w)); }
            } catch {
                idTakTerbaca.add(id);
            }
        }));
    }
    return { kode: [...kode], alasan: [...alasan], idTakTerbaca: [...idTakTerbaca] };
}
