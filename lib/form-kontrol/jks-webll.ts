/*
 * Tujuan: Membaca berkas JKS hasil hitung Web-LL (JKS_<PRINCIPAL>_<tgl>.xlsx, sheet "JKS semua sales"; owner 13 Nov 2026) menjadi baris
 *   upsertJksRows: siklus 4 minggu (kolom M1..M4) -> pola minggu, F8 (dua baris, dua hari) -> satu baris "Senin, Kamis", nama salesman/principal
 *   berkas -> kode sales/principal sistem lewat peta pilihan Admin, plus keterangan toko (urutan, kategori, kelas A, target, status pindah, lokasi).
 * Caller: app/api/form-kontrol/jks/route.ts (POST multipart, server), app/(dashboard)/form-kontrol/tabs/TabJks.tsx (pratinjau + peta, klien).
 * Dependensi: ./constants (hariBaku, kunciNama) — MURNI, tanpa impor server, aman di klien.
 * Main Functions: SHEET_WEBLL, cariSheetWebLl, nilaiUntukPeta, tebakPeta, bacaJksWebLl. Side Effects: tidak ada.
 */
import { hariBaku, kunciNama } from "./constants";

export const SHEET_WEBLL = "JKS semua sales";
/** Lokasi yang dipercaya untuk toko_koordinat (titik lapangan); perkiraan dari alamat/tengah wilayah TIDAK ditulis sebagai koordinat. */
const LOKASI_LAPANGAN = new Set(["GPS LAPANGAN", "TITIK LAPANGAN COCOK ALAMAT", "TITIK LAPANGAN DISEPAKATI SUMBER"]);

export type BarisMentah = Record<string, unknown>;
/** Peta Admin: nilai di berkas -> nilai sistem. sales: SALESMAN -> sales_code; principal: PRINCIPAL -> principle JKS. */
export type PetaJks = { sales: Record<string, string>; principal: Record<string, string> };
export type BarisJksWebLl = {
    salesCode: string; salesName: string; custCode: string; custName: string; market?: string; alamat?: string; kota?: string;
    hariKunjungan: string; mingguPattern: string; area?: string; rayon?: string; principle: string; channel: string; visitFrequency: number;
    urutan: number | null; kategori: string | null; kelasA: boolean; targetToko: number | null; omzetRata: number | null;
    statusJks: string | null; salesSebelum: string | null; lokasiDari: string | null;
};

const teks = (v: unknown) => String(v ?? "").trim();
/** Sel angka: xlsx memberi number; teks "1,5" dibaca 1.5. ponytail: teks ribuan bertitik ("1.234.567") = null, berkas Web-LL selalu number. */
const angka = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = teks(v).replace(",", ".");
    return s && Number.isFinite(Number(s)) ? Number(s) : null;
};
/** Sel M1..M4 ("✓") dan KELAS A ("YA"). */
const centang = (v: unknown) => /^(✓|✔|v|x|y|ya|1|true)$/i.test(teks(v));

/** Nama sheet JKS Web-LL di buku kerja (tanpa beda huruf besar/kecil); undefined = bukan berkas Web-LL. */
export function cariSheetWebLl(namaSheet: readonly string[]): string | undefined {
    return namaSheet.find((n) => n.trim().toLowerCase() === SHEET_WEBLL.toLowerCase());
}

/** Nilai SALESMAN dan PRINCIPAL di berkas (+ jumlah baris) untuk dipetakan Admin sebelum Terapkan. */
export function nilaiUntukPeta(rows: readonly BarisMentah[]) {
    const hitung = (kolom: string) => {
        const m = new Map<string, number>();
        for (const r of rows) { const v = teks(r[kolom]); if (v) m.set(v, (m.get(v) ?? 0) + 1); }
        return [...m].map(([nilai, baris]) => ({ nilai, baris })).sort((a, b) => a.nilai.localeCompare(b.nilai, "id"));
    };
    return { sales: hitung("SALESMAN"), principal: hitung("PRINCIPAL") };
}

/**
 * Tebakan awal peta (Admin tetap memeriksa): salesman = profil yang namanya sama persis (kunciNama), atau sama sesudah awalan kursi dibuang
 * di kedua sisi (bagian sesudah garis bawah terakhir: "KN2_IRDAWATI ALIM" ~ "IRDAWATI ALIM", "KN_MT2__MELIZA" ~ "MELIZA"), hanya bila tepat
 * satu; principal = principal sistem yang sama persis, atau satu-satunya yang memuat / dimuat nama berkas ("KINO" ~ "KINO NON FOOD").
 * Principal gabungan berkas MIX ("ADNA_GUMINDO, FONTERRA", "(potensi di FKS)") tidak ditebak — Admin memakai "isi semua". Tidak yakin = kosong.
 */
export function tebakPeta(nilai: ReturnType<typeof nilaiUntukPeta>, profil: readonly { salesCode: string; salesName: string }[],
    principalSistem: readonly string[]): PetaJks {
    const tanpaKursi = (s: string) => kunciNama(s.split("_").pop());
    const sales: Record<string, string> = {};
    for (const { nilai: n } of nilai.sales) {
        const persis = profil.filter((p) => kunciNama(p.salesName) === kunciNama(n));
        const longgar = persis.length ? persis : profil.filter((p) => tanpaKursi(p.salesName) === tanpaKursi(n));
        if (longgar.length === 1) sales[n] = longgar[0].salesCode;
    }
    const principal: Record<string, string> = {};
    for (const { nilai: n } of nilai.principal) {
        const k = kunciNama(n);
        if (/[,(]/.test(k)) continue;
        const persis = principalSistem.filter((p) => kunciNama(p) === k);
        const dekat = persis.length ? persis : principalSistem.filter((p) => kunciNama(p).includes(k) || k.includes(kunciNama(p)));
        if (dekat.length === 1) principal[n] = dekat[0];
    }
    return { sales, principal };
}

/**
 * M1..M4 tercentang -> pola minggu JKS; tiga minggu (F3, owner 14 Nov 2026) = "m" + nomor minggunya (m123, m124, m134, m234). Kombinasi lain
 * (dua minggu berurutan / tanpa centang) = null (baris ditolak).
 */
export function polaDariMinggu(m: readonly boolean[]): string | null {
    const ke = m.map((v, i) => (v ? i + 1 : 0)).filter(Boolean).join("");
    if (ke.length === 3) return `m${ke}`;
    return ({ "1234": "all", "13": "ganjil", "24": "genap", "1": "m1", "2": "m2", "3": "m3", "4": "m4" } as Record<string, string>)[ke] ?? null;
}

/**
 * Baris sheet "JKS semua sales" (sheet_to_json, header baris 1) -> baris JKS sistem. `baris` di galat = nomor baris Excel (judul = 1).
 * Satu toko dua baris (F8) digabung: hari disatukan, urutan terkecil dipakai. Galat apa pun dilaporkan — pemanggil (mode ganti) membatalkan
 * seluruh unggahan bila ada galat, supaya toko di baris cacat tidak hilang dari rute.
 */
export function bacaJksWebLl(rows: readonly BarisMentah[], peta: PetaJks) {
    const galat: { baris: number; kode: string; pesan: string }[] = [];
    const hasil = new Map<string, BarisJksWebLl & { baris: number; hariMentah: string[] }>();
    const koordinat = new Map<string, { custCode: string; lat: number; lng: number }>();
    rows.forEach((r, i) => {
        const baris = i + 2;
        const kode = teks(r["KODE OUTLET"]);
        const salesBerkas = teks(r["SALESMAN"]), principalBerkas = teks(r["PRINCIPAL"]);
        if (!kode && !salesBerkas && !principalBerkas) return; // baris kosong
        const salesCode = peta.sales[salesBerkas] ?? "", principle = peta.principal[principalBerkas] ?? "";
        const hari = hariBaku(r["HARI"]);
        const pola = polaDariMinggu(["M1", "M2", "M3", "M4"].map((k) => centang(r[k])));
        const frek = Number(teks(r["FREKUENSI"]).replace(/^F/i, ""));
        const pesan = !kode ? "Kode outlet kosong."
            : !salesCode ? `Salesman "${salesBerkas}" belum dipetakan ke kode sales.`
            : !principle ? `Principal "${principalBerkas}" belum dipetakan.`
            : !hari ? `Hari "${teks(r["HARI"])}" tidak dikenal (Senin–Sabtu).`
            : !pola ? "Centang minggu M1–M4 tidak dikenal (harus satu minggu, M1+M3, M2+M4, tiga minggu, atau semua)."
            : ![1, 2, 3, 4, 8].includes(frek) ? `Frekuensi "${teks(r["FREKUENSI"])}" tidak dikenal (F1, F2, F3, F4, F8).` : null;
        if (pesan) { galat.push({ baris, kode, pesan }); return; }
        const kunci = `${salesCode}\u0000${kode.toUpperCase()}\u0000${principle}`;
        const lama = hasil.get(kunci);
        const urutan = angka(r["URUTAN"]);
        if (lama) {
            // F8: baris kedua = hari kedua toko yang sama. Hari sama dua kali / pola berbeda = berkas tidak konsisten.
            if (lama.hariMentah.includes(hari!) || lama.mingguPattern !== pola) {
                galat.push({ baris, kode, pesan: `Toko ${kode} muncul lagi (baris ${lama.baris}) dengan hari atau minggu yang bentrok.` });
                return;
            }
            lama.hariMentah.push(hari!);
            lama.hariKunjungan = hariBaku(lama.hariMentah.join(","))!;
            if (urutan !== null && (lama.urutan === null || urutan < lama.urutan)) lama.urutan = urutan;
            return;
        }
        const status = teks(r["STATUS"]).toUpperCase() || null;
        hasil.set(kunci, {
            baris, hariMentah: [hari!],
            salesCode, salesName: salesBerkas, custCode: kode, custName: teks(r["NAMA OUTLET"]) || kode,
            market: teks(r["JALAN / PASAR"]) || undefined, alamat: teks(r["ALAMAT"]) || undefined, kota: teks(r["KOTA"]) || undefined,
            hariKunjungan: hari!, mingguPattern: pola!, area: teks(r["AREA"]) || undefined, rayon: teks(r["RAYON"]) || undefined, principle,
            channel: teks(r["CHANNEL"]).toUpperCase() || "GT", visitFrequency: frek,
            urutan, kategori: teks(r["KATEGORI OUTLET"]).toUpperCase() || null, kelasA: centang(r["KELAS A"]),
            targetToko: angka(r["TARGET TOKO"]), omzetRata: angka(r["RATA2 OMZET / BULAN (6 BLN)"]),
            statusJks: status, salesSebelum: status && status !== "TETAP" ? teks(r["SALES SEKARANG (NOTA TERAKHIR)"]) || null : null,
            lokasiDari: teks(r["LOKASI DARI"]) || null,
        });
        const lat = angka(r["LATITUDE"]), lng = angka(r["LONGITUDE"]);
        if (LOKASI_LAPANGAN.has(teks(r["LOKASI DARI"]).toUpperCase()) && lat !== null && lng !== null && lat >= -11 && lat <= 6 && lng >= 95 && lng <= 141) {
            koordinat.set(kode.toUpperCase(), { custCode: kode, lat, lng });
        }
    });
    const baris: BarisJksWebLl[] = [...hasil.values()].map((r) => {
        const salin: Partial<typeof r> = { ...r };
        delete salin.baris; delete salin.hariMentah;
        return salin as BarisJksWebLl;
    });
    return { baris, galat, koordinat: [...koordinat.values()] };
}
