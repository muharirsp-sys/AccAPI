/*
 * Tujuan: Usulan area untuk outlet yang belum ada di Master Area Heinz. Penyebab tunggal
 *         terbesar nota hilang dari lembar HNZ hari ini (19 dari 131 nota, 21 Agu 2026).
 * Caller: app/api/rekapan-nota/area/route.ts, area-suggest.test.ts.
 * Dependensi: lib/sales-history/fuzzy (damerau) — matcher yang sudah terbukti di repo;
 *             tidak menulis matcher baru dan tidak menambah paket (R9.3).
 * Main Functions: parseKelKec, bangunIndeks, usulkanArea, usulkanSemua.
 * Side Effects: Tidak ada. Pure atas array yang diberikan caller.
 */
import { damerau } from "@/lib/sales-history/fuzzy";

export type Outlet = { kode: string; nama: string; alamat: string | null };
export type OutletTerpetakan = Outlet & { area: string };
export type Keyakinan = "TINGGI" | "SEDANG" | "RENDAH";
export type Usulan = { kode: string; area: string; keyakinan: Keyakinan; alasan: string };

/** Keyakinan TINGGI boleh diterima massal: kelurahan 100% satu area, minimal segini pendukung. */
export const MIN_PENDUKUNG_TINGGI = 5;
/** Ambang Jaccard token alamat+nama untuk usulan dari kemiripan (PRD §3.9). */
export const AMBANG_JACCARD = 0.28;

const bersih = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();

/**
 * Alamat outlet sudah memuat wilayah administratifnya: `... _ Kel.BORONG Kec. MANGGALA`.
 * ponytail: satu regex, bukan parser alamat. Kalau suatu hari formatnya berubah jadi
 * "KELURAHAN X", cakupan turun dan itu kelihatan di angka usulan — bukan salah diam-diam.
 */
export function parseKelKec(alamat: string | null | undefined): { kelurahan: string | null; kecamatan: string | null } {
    const a = bersih(String(alamat ?? ""));
    const kel = a.match(/\bKEL\.?\s*([A-Z0-9'\- .]+?)\s*(?=\bKEC\b|,|$)/);
    const kec = a.match(/\bKEC\.?\s*([A-Z0-9'\- .]+?)\s*(?=,|$)/);
    const ambil = (m: RegExpMatchArray | null) => {
        const v = bersih(m?.[1] ?? "").replace(/\.+$/, "");
        return v.length >= 3 ? v : null;
    };
    return { kelurahan: ambil(kel), kecamatan: ambil(kec) };
}

const STOPWORD = new Set([
    "JL", "JLN", "JALAN", "NO", "NOMOR", "KEL", "KEC", "RT", "RW", "BLOK", "KOMP", "KOMPLEKS",
    "TK", "TOKO", "PT", "CV", "DEPAN", "SAMPING", "DEKAT", "DALAM", "RAYA", "POROS", "PASAR",
]);

function token(nama: string, alamat: string | null): string[] {
    const raw = `${nama} ${alamat ?? ""}`.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    return [...new Set(raw.filter((t) => t.length >= 3 && !STOPWORD.has(t)))];
}

type Wilayah = Map<string, Map<string, number>>; // nama wilayah -> (area -> jumlah)

export type Indeks = {
    kelurahan: Wilayah;
    kecamatan: Wilayah;
    /** token -> indeks outlet terpetakan yang memuatnya. Menghindari perbandingan n x m. */
    postings: Map<string, number[]>;
    tokens: string[][];
    terpetakan: OutletTerpetakan[];
};

function catat(w: Wilayah, kunci: string | null, area: string) {
    if (!kunci) return;
    const per = w.get(kunci) ?? new Map<string, number>();
    per.set(area, (per.get(area) ?? 0) + 1);
    w.set(kunci, per);
}

export function bangunIndeks(terpetakan: OutletTerpetakan[]): Indeks {
    const kelurahan: Wilayah = new Map();
    const kecamatan: Wilayah = new Map();
    const postings = new Map<string, number[]>();
    const tokens: string[][] = [];

    terpetakan.forEach((o, i) => {
        const area = bersih(o.area);
        const { kelurahan: kel, kecamatan: kec } = parseKelKec(o.alamat);
        catat(kelurahan, kel, area);
        catat(kecamatan, kec, area);
        const t = token(o.nama, o.alamat);
        tokens.push(t);
        for (const tok of t) {
            const list = postings.get(tok);
            if (list) list.push(i); else postings.set(tok, [i]);
        }
    });

    return { kelurahan, kecamatan, postings, tokens, terpetakan };
}

function mayoritas(per: Map<string, number> | undefined): { area: string; top: number; total: number } | null {
    if (!per || per.size === 0) return null;
    let area = "", top = 0, total = 0;
    for (const [a, n] of per) {
        total += n;
        if (n > top) { top = n; area = a; }
    }
    return { area, top, total };
}

/** Dua token dianggap sama kalau identik, atau beda satu ketukan untuk kata yang cukup panjang. */
function tokenSama(a: string, b: string): boolean {
    return a === b || (a.length >= 5 && b.length >= 5 && damerau(a, b, 1) <= 1);
}

function jaccard(a: string[], setA: Set<string>, b: string[]): number {
    if (!a.length || !b.length) return 0;
    const setB = new Set(b);
    let irisan = 0;
    for (const t of a) {
        if (setB.has(t)) { irisan += 1; continue; }
        if (b.some((u) => tokenSama(t, u))) irisan += 1;
    }
    return irisan / (setA.size + setB.size - irisan);
}

/**
 * Usulan, bukan penetapan (R9.1). Area salah lebih mahal daripada area kosong: kosong
 * ketahuan di exception queue, salah diam-diam mengirim barang ke rute yang keliru.
 */
export function usulkanArea(target: Outlet, indeks: Indeks): Usulan | null {
    const { kelurahan, kecamatan } = parseKelKec(target.alamat);

    const dariKel = mayoritas(indeks.kelurahan.get(kelurahan ?? ""));
    if (dariKel) {
        const penuh = dariKel.top === dariKel.total;
        const keyakinan: Keyakinan = penuh && dariKel.total >= MIN_PENDUKUNG_TINGGI ? "TINGGI"
            : dariKel.top / dariKel.total >= 0.8 ? "SEDANG" : "RENDAH";
        return {
            kode: target.kode, area: dariKel.area, keyakinan,
            alasan: `Kelurahan ${kelurahan}: ${dariKel.top} dari ${dariKel.total} outlet ada di area ${dariKel.area}`,
        };
    }

    const dariKec = mayoritas(indeks.kecamatan.get(kecamatan ?? ""));
    if (dariKec && dariKec.top / dariKec.total >= 0.6) {
        return {
            kode: target.kode, area: dariKec.area,
            keyakinan: dariKec.top === dariKec.total && dariKec.total >= MIN_PENDUKUNG_TINGGI ? "SEDANG" : "RENDAH",
            alasan: `Kecamatan ${kecamatan}: ${dariKec.top} dari ${dariKec.total} outlet ada di area ${dariKec.area}`,
        };
    }

    // Fallback: tetangga yang alamat/namanya paling mirip. Kandidat dibatasi lewat postings
    // (outlet yang berbagi minimal satu token) supaya tidak menyisir seluruh master.
    const t = token(target.nama, target.alamat);
    const setT = new Set(t);
    const kandidat = new Set<number>();
    for (const tok of t) for (const i of indeks.postings.get(tok) ?? []) kandidat.add(i);

    let terbaik = { skor: 0, i: -1 };
    for (const i of kandidat) {
        const skor = jaccard(t, setT, indeks.tokens[i]);
        if (skor > terbaik.skor) terbaik = { skor, i };
    }
    if (terbaik.i >= 0 && terbaik.skor >= AMBANG_JACCARD) {
        const tetangga = indeks.terpetakan[terbaik.i];
        return {
            kode: target.kode, area: bersih(tetangga.area), keyakinan: "RENDAH",
            alasan: `Mirip ${tetangga.nama} (kemiripan ${(terbaik.skor * 100).toFixed(0)}%), area ${bersih(tetangga.area)}`,
        };
    }

    // 40% sisanya memang tidak ada petunjuknya. Tidak ada yang dikarang (R9.4).
    return null;
}

export function usulkanSemua(targets: Outlet[], terpetakan: OutletTerpetakan[]): Usulan[] {
    const indeks = bangunIndeks(terpetakan);
    return targets.map((t) => usulkanArea(t, indeks)).filter((u): u is Usulan => u !== null);
}
