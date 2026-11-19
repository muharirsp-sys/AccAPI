/**
 * Tujuan: Aturan tetap owner (13 Nov 2026; C-IN0087 INDOMARET PALOPO ditambah 18 Nov 2026): 9 toko NKA/DC tidak boleh
 *   "ditutup" di Accurate, di semua divisi
 *   (kode dasar dan varian principal, mis. C-IND051-KN), meskipun tidak ada transaksi atau tercatat atas nama siapa pun.
 *   Ditutup = dinonaktifkan (`suspended`), atau diberi batas yang menahan pesanannya: batas total piutang
 *   (`customerLimitAmount` / `customerLimitAmountValue`) dan batas umur piutang dalam hari (`customerLimitAge` /
 *   `customerLimitAgeValue`). Bukti: Pesanan Penjualan ALFAMART (C-AL0063) ditolak Accurate "melewati batas piutang".
 *   Mematikan batas tetap boleh. Hapus (`customer/delete.do`) sudah ditolak katalog Konsol (isCatalogWrite).
 *   Owner 19 Nov 2026 ("tetap lepas"): batas yang dicentang ulang di luar AccAPI dilepas lagi otomatis (lepasTerlindungi).
 * Caller: app/api/proxy/route.ts (tulis customer/save.do & bulk-save.do lewat Konsol), sebelum diteruskan;
 *   lib/sync.ts (lepasTerlindungi: webhook pelanggan + sync customer).
 * Dependensi: tidak ada; pencarian kode dari id (GET customer/detail.do) dan penulis customer/save.do disuntikkan pemanggil.
 * Main Functions: PELANGGAN_TERLINDUNGI, isPelangganTerlindungi, periksaPenutupanPelanggan, lepasTerlindungi.
 * Side Effects: lepasTerlindungi menulis customer/save.do lewat penulis suntikan; selebihnya tidak ada.
 */

export const PELANGGAN_TERLINDUNGI = [
    "C-IND051", "C-IN0050", "C-AL0063", "C-AL0064", "C-ALF052", "C-IND080", "C-IND086", "C-IN0088",
    "C-IN0087", // owner 18 Nov 2026: "masih tertutup" — batas 12 divisi dimatikan hari itu
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
        // `number` = kunci identitas katalog Konsol (customer/save.do, pos/customer/save.do) — review 17 Nov 2026 H1.
        for (const no of kolom(rec, "customerno", "no", "number")) {
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

/**
 * Owner 19 Nov 2026 ("tetap lepas"): sebuah alat di LUAR AccAPI (belum dikenal) mencentang ulang batas piutang/umur setiap 15 menit
 * (:03/:18/:33/:48 WIB) — terbukti 18 & 19 Nov: ke-12 divisi C-IN0087 dicentang lagi +-5 menit sesudah dilepas, urut id, +-1,5 dtk
 * per pelanggan, nilai lama. Penjaga proxy tidak menjangkau alat itu, jadi setiap kali AccAPI melihat toko terlindungi yang batasnya
 * tercentang (webhook = hitungan detik; sync 4x sehari = cadangan), batasnya dilepas lagi: customer/save.do berisi id + 2 kolom aktif
 * SAJA (nominal & hari dibiarkan, sama seperti 14 & 18 Nov). Simpanan ini memicu webhook yang membaca batas sudah lepas -> tidak
 * berulang. Tidak pernah melempar; saklar darurat env LEPAS_TERLINDUNGI=mati. `asal` = untuk log (mis. appKey webhook penyimpan).
 * ponytail: `suspended` tidak dibuka otomatis (alat itu hanya mencentang batas); tambahkan bila terbukti dinonaktifkan juga.
 */
export async function lepasTerlindungi(
    rows: Rec[], tulis: (payload: Rec) => Promise<{ status: number; text: string }>, asal: string,
): Promise<string[]> {
    if (process.env.LEPAS_TERLINDUNGI === "mati") return [];
    const dilepas: string[] = [];
    for (const row of rows) {
        const id = Number(row.id);
        const no = String(row.customerNo ?? "");
        if (!Number.isFinite(id) || id <= 0 || !isPelangganTerlindungi(no)) continue;
        if (row.customerLimitAmount !== true && row.customerLimitAge !== true) continue;
        try {
            const r = await tulis({ id, customerLimitAmount: false, customerLimitAge: false });
            let s: unknown;
            try { s = (JSON.parse(r.text) as Rec)?.s; } catch { /* bukan JSON = gagal */ }
            if (r.status < 200 || r.status >= 300 || s !== true) throw new Error(`save.do HTTP ${r.status}: ${r.text.slice(0, 200)}`);
            dilepas.push(no);
            console.warn(`[pelanggan-terlindungi] ${no}: batas dicentang lagi di luar AccAPI (${asal}) -> dilepas`);
        } catch (e) {
            console.error(`[pelanggan-terlindungi] ${no}: gagal melepas batas (${asal}): ${e instanceof Error ? e.message : e}`);
        }
    }
    return dilepas;
}
