/*
 * Tujuan: Pembaca pelunasan Accurate untuk Kasir ↔ Incaso (K1b, BL-59) — bagian MURNI: kueri + urai list.do fail-closed (pageCount,
 *   halaman kosong, rowCount bergeser, id ganda), urai detail.do -> Pelunasan (lib/kasir/rekonsiliasi), rencana baca inkremental
 *   PER ID (lastUpdate teks list.do), kelas galat + jadwal ulang, status akhir putaran (lengkap/sebagian/gagal), tanggal cron.
 * Caller: lib/kasir/baca-pelunasan.ts (pelaksana server), app/api/cron/kasir-pelunasan; uji lib/kasir/pembaca.test.ts.
 * Dependensi: lib/kasir/rekonsiliasi (hariKerja, tipe Pelunasan) — murni.
 * Main Functions: kueriDaftar, uraiHalamanDaftar, bacaDaftar (ambil halaman DISUNTIK), uraiDetail, rencanaBaca, kelasGalat,
 *   saringPesan, tundaUlang, bacaRetryAfter, statusAkhir, tanggalCron, keTanggalAccurate, tanggalSah.
 * Side Effects: tidak ada (tanpa I/O dan tanpa jam sistem; `bacaDaftar` memanggil fungsi ambil yang disuntik).
 *
 * Bukti bentuk Accurate: scratch/fiori-intake/KASIR-BUKTI-PROBE-2026-10-11.md (list.do filter transDate SAJA bekerja, 824 baris /
 * 9 halaman, lastUpdate ada) + S6e2-BUKTI-DETAIL-DO-2026-10-10.md (detail: transDate dd/MM/yyyy, paymentMethod, chequeAmount,
 * detailInvoice[].invoice.{id,number,masterSalesmanId}, invoiceId, invoicePayment).
 */
import { hariKerja, type Pelunasan, type PelunasanFaktur } from "./rekonsiliasi.ts";

/** Kelas galat pembaca (kolom kasir_pelunasan_baca.sebab; CHECK di DDL = daftar ini). */
export const KELAS_GALAT = ["sesi_sinkron", "hak_akses", "batas_laju", "accurate_5xx", "jaringan", "tidak_pasti", "ditolak", "bentuk",
    "nominal", "terpotong", "hapus_massal"] as const;
export type KelasGalat = (typeof KELAS_GALAT)[number];

export class GalatBaca extends Error {
    constructor(readonly kelas: KelasGalat, pesan: string) {
        super(pesan);
        this.name = "GalatBaca";
    }
}

/** Pesan 503 sesi sinkron mati (brief K1b) — bukan diam, bukan "0 pelunasan". */
export const PESAN_SESI_SINKRON = "Sesi Accurate akun sinkron kedaluwarsa — admin login ulang di /sesi-accurate lalu pilih database";

export const FIELDS_DAFTAR = "id,number,transDate,paymentMethod,chequeAmount,lastUpdate";
export const UKURAN_HALAMAN = 100;
/** Pagar: 50 halaman = 5.000 pelunasan sehari (hari ramai 824). Lebih = terpotong, bukan dibaca sebagian diam-diam. */
export const MAKS_HALAMAN = 50;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export function tanggalSah(t: unknown): t is string {
    if (typeof t !== "string" || !ISO.test(t)) return false;
    const ms = Date.parse(`${t}T00:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === t;
}

/** YYYY-MM-DD -> dd/MM/yyyy (filter list.do). */
export function keTanggalAccurate(tanggal: string): string {
    if (!tanggalSah(tanggal)) throw new Error(`Format tanggal salah: ${tanggal} (YYYY-MM-DD)`);
    const [y, m, d] = tanggal.split("-");
    return `${d}/${m}/${y}`;
}

/** dd/MM/yyyy (transDate Accurate) -> YYYY-MM-DD; selain itu null. */
export function dariTanggalAccurate(v: unknown): string | null {
    const m = typeof v === "string" ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v.trim()) : null;
    const t = m ? `${m[3]}-${m[2]}-${m[1]}` : "";
    return tanggalSah(t) ? t : null;
}

/** (a) Parameter list.do satu tanggal (filter transDate SAJA, urut id naik — baris baru jatuh di halaman akhir). */
export function kueriDaftar(tanggal: string, halaman: number): Record<string, string> {
    return {
        fields: FIELDS_DAFTAR,
        "filter.transDate.op": "EQUAL",
        "filter.transDate.val": keTanggalAccurate(tanggal),
        "sp.pageSize": String(UKURAN_HALAMAN),
        "sp.sort": "id|asc",
        "sp.page": String(halaman),
    };
}

/** Satu baris list.do yang dipakai: id, nomor, lastUpdate (teks Accurate apa adanya, hanya dibandingkan sama/beda). */
export interface BarisDaftar {
    id: number;
    nomor: string;
    lastUpdate: string;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const teks = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
/** Bilangan bulat ≥ 0 dari angka / teks angka; selain itu NaN. */
const bulat = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
    return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
};
const idSah = (v: unknown) => {
    const n = bulat(v);
    return n > 0 ? n : NaN;
};

/**
 * (b) Satu halaman list.do, fail-closed (aturan = lib/pelunasan/pratinjau-ganda.ts riwayatKelompok ketat): `s:true` + `d` larik;
 * `sp.pageCount` angka/teks angka, 0 hanya bila `d` kosong; halaman kosong sebelum halaman terakhir yang diumumkan (jumlah halaman
 * tidak boleh turun) = gagal; `sp.rowCount` wajib (tanpanya daftar lengkap tak bisa dibuktikan); setiap baris: id, number, transDate
 * = tanggal diminta (filter yang diabaikan = galat, bukan membaca seluruh riwayat), lastUpdate terisi.
 */
export function uraiHalamanDaftar(body: unknown, tanggal: string, halaman: number, pageCountSebelumnya: number, rahasia: readonly string[] = []) {
    const b = obj(body);
    if (b?.s === false) throw new GalatBaca("ditolak", `list.do halaman ${halaman} ditolak: ${saringPesan(b.m ?? b.d, rahasia)}`);
    if (!b || b.s !== true || !Array.isArray(b.d)) throw new GalatBaca("bentuk", `list.do halaman ${halaman}: bukan {s:true, d:[…]}`);
    const sp = obj(b.sp) ?? {};
    const pageCount = bulat(sp.pageCount);
    if (!(pageCount >= 1 || (pageCount === 0 && b.d.length === 0))) {
        throw new GalatBaca("terpotong", `list.do halaman ${halaman} tanpa jumlah halaman (sp.pageCount) yang sah — dianggap terpotong`);
    }
    const rowCount = bulat(sp.rowCount);
    if (Number.isNaN(rowCount)) throw new GalatBaca("terpotong", `list.do halaman ${halaman} tanpa sp.rowCount — kelengkapan daftar tak bisa dibuktikan`);
    if (b.d.length === 0 && halaman < Math.max(pageCountSebelumnya, pageCount)) {
        throw new GalatBaca("terpotong", `list.do halaman ${halaman} kosong sebelum halaman terakhir yang diumumkan — dianggap gagal baca`);
    }
    const baris: BarisDaftar[] = b.d.map((x, i) => {
        const r = obj(x);
        const id = idSah(r?.id);
        const nomor = teks(r?.number);
        const lastUpdate = teks(r?.lastUpdate);
        if (!r || Number.isNaN(id) || !nomor) throw new GalatBaca("bentuk", `list.do halaman ${halaman} baris ${i + 1}: id/number tidak sah`);
        if (dariTanggalAccurate(r.transDate) !== tanggal) {
            throw new GalatBaca("bentuk", `list.do ${nomor}: transDate ${JSON.stringify(r.transDate)} ≠ ${tanggal} — filter tanggal diabaikan?`);
        }
        if (!lastUpdate) throw new GalatBaca("bentuk", `list.do ${nomor}: lastUpdate kosong — baca inkremental tak mungkin`);
        return { id, nomor, lastUpdate };
    });
    return { baris, pageCount, rowCount };
}

/**
 * (b) Daftar LENGKAP satu tanggal: halaman 1..pageCount (jumlah halaman terbesar yang diumumkan), id ganda dibuang. `rowCount` berubah
 * antarhalaman atau jumlah id unik ≠ rowCount (baris bergeser karena hapus/tambah di tengah) -> daftar diulang SEKALI dari halaman 1,
 * lalu `terpotong`. `ambil(halaman)` (disuntik) mengembalikan badan JSON atau melempar (galat transport pemanggil diteruskan apa adanya).
 * ponytail (batas yang DISENGAJA): halaman yang bergeser selama pembacaan hanya terdeteksi bila rowCount / jumlah id unik berubah (-> ulang
 * sekali lalu `terpotong`). Hapus + tambah dalam jumlah SAMA di tengah pembacaan (rowCount tetap) bisa melewatkan satu baris dan tetap
 * `lengkap` KELIRU — baris itu bahkan dianggap hilang lalu dihapus dari cache — sampai putaran berikut (cron 15 menit / tombol) atau baca penuh
 * 19.30 membacanya lagi. Jalan naik bila terbukti perlu: kursor id (filter id > terakhir) atau baca daftar dua kali dan bandingkan.
 */
export async function bacaDaftar(tanggal: string, ambil: (halaman: number) => Promise<unknown>, rahasia: readonly string[] = []): Promise<BarisDaftar[]> {
    let alasan = "";
    for (let putaran = 1; putaran <= 2; putaran++) {
        let pageCount = 1;
        let rowCount: number | null = null;
        const unik = new Map<number, BarisDaftar>();
        let bergeser = false;
        for (let h = 1; h <= pageCount; h++) {
            if (h > MAKS_HALAMAN) throw new GalatBaca("terpotong", `daftar pelunasan ${tanggal} > ${MAKS_HALAMAN} halaman — terpotong`);
            const hal = uraiHalamanDaftar(await ambil(h), tanggal, h, pageCount, rahasia);
            if (rowCount === null) rowCount = hal.rowCount;
            else if (hal.rowCount !== rowCount) {
                alasan = `rowCount berubah ${rowCount} -> ${hal.rowCount} di halaman ${h}`;
                bergeser = true;
                break;
            }
            pageCount = Math.max(pageCount, hal.pageCount);
            for (const b of hal.baris) if (!unik.has(b.id)) unik.set(b.id, b);
        }
        if (!bergeser && unik.size === rowCount) return [...unik.values()];
        if (!bergeser) alasan = `${unik.size} id unik ≠ rowCount ${rowCount}`;
    }
    throw new GalatBaca("terpotong", `daftar pelunasan ${tanggal} bergeser selama dibaca dua kali berturut-turut (${alasan})`);
}

export type HasilDetail = { ok: true; pelunasan: Pelunasan } | { ok: false; sebab: "bentuk" | "nominal" | "berubah"; pesan: string };

/** Skala nilai TEPAT: 1e-20 Rp (BigInt). Accurate mengirim nominal hasil hitung diskon hingga 6 desimal (82250.0988, 1695228.659414). */
const SKALA = 20;
const SATU_SEN = BigInt(`1${"0".repeat(SKALA - 2)}`);

/** Nominal Accurate -> nilai TEPAT berskala SKALA; rusak (bukan desimal polos, notasi e, pemisah ribuan) = galat `nominal`, absen = `bentuk`. */
function tepat(v: unknown, apa: string): bigint | HasilDetail {
    if (v === undefined || v === null || v === "") return { ok: false, sebab: "bentuk", pesan: `${apa} absen` };
    if (typeof v !== "number" && typeof v !== "string") return { ok: false, sebab: "bentuk", pesan: `${apa} bukan angka` };
    const t = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim();
    const m = new RegExp(`^(-?)(\\d+)(?:\\.(\\d{1,${SKALA}}))?$`).exec(t);
    if (!m) return { ok: false, sebab: "nominal", pesan: `${apa}: Nominal tidak sah: ${JSON.stringify(v)} (desimal polos, tanpa pemisah ribuan)` };
    const n = BigInt(m[2] + (m[3] ?? "").padEnd(SKALA, "0"));
    return m[1] ? -n : n;
}

/** Nilai tepat -> sen, dibulatkan setengah menjauhi nol; di luar bilangan bulat aman = galat `nominal`. */
function keSenBulat(x: bigint, apa: string): number | HasilDetail {
    const neg = x < BigInt(0);
    const s = Number(((neg ? -x : x) + SATU_SEN / BigInt(2)) / SATU_SEN);
    if (!Number.isSafeInteger(s)) return { ok: false, sebab: "nominal", pesan: `${apa}: Nominal di luar batas` };
    return neg && s ? -s : s;
}

/**
 * (c) detail.do `d` -> Pelunasan. chequeAmount / invoicePayment dibaca TEPAT lalu sen (setengah menjauhi nol; baris KUMULATIF); fakturId = invoice.id ?? invoiceId;
 * nomorFaktur = invoice.number; salesman = invoice.masterSalesmanId (boleh null). invoicePayment absen = `bentuk` TANPA cadangan
 * paymentAmount (bruto = tunai + retur + diskon: lib/pelunasan/alokasi.ts:391-392). Faktur sama dua kali dalam satu pelunasan =
 * dijumlah (PK cache per faktur); salesman berbeda = `bentuk`. transDate ≠ tanggal diminta = `berubah` (tidak lengkap; tidak ditulis).
 */
export function uraiDetail(d: unknown, tanggal: string, harap: { id: number; nomor?: string }): HasilDetail {
    const r = obj(d);
    const nomorHarap = harap.nomor ?? String(harap.id);
    if (!r) return { ok: false, sebab: "bentuk", pesan: `detail ${nomorHarap}: bukan objek` };
    if (idSah(r.id) !== harap.id) return { ok: false, sebab: "bentuk", pesan: `detail ${nomorHarap}: id ${JSON.stringify(r.id)} ≠ ${harap.id}` };
    const nomor = teks(r.number) || teks(harap.nomor);
    if (!nomor) return { ok: false, sebab: "bentuk", pesan: `detail id ${harap.id}: number kosong` };
    const tgl = dariTanggalAccurate(r.transDate);
    if (!tgl) return { ok: false, sebab: "bentuk", pesan: `detail ${nomor}: transDate ${JSON.stringify(r.transDate)} bukan dd/MM/yyyy` };
    if (tgl !== tanggal) return { ok: false, sebab: "berubah", pesan: `detail ${nomor}: transDate ${tgl} ≠ ${tanggal} (berubah sesudah daftar)` };
    const metode = typeof r.paymentMethod === "string" ? r.paymentMethod : "";
    if (!metode.trim()) return { ok: false, sebab: "bentuk", pesan: `detail ${nomor}: paymentMethod kosong / bukan teks` };
    const chequeTepat = tepat(r.chequeAmount, `detail ${nomor} chequeAmount`);
    if (typeof chequeTepat !== "bigint") return chequeTepat;
    const cheque = keSenBulat(chequeTepat, `detail ${nomor} chequeAmount`);
    if (typeof cheque !== "number") return cheque;
    if (!Array.isArray(r.detailInvoice)) return { ok: false, sebab: "bentuk", pesan: `detail ${nomor}: detailInvoice bukan larik` };

    // Baris dibulatkan KUMULATIF (baris i = sen(Σ tepat s.d. i) − sen(Σ tepat s.d. i−1)): Σ baris = sen(Σ tepat), jadi pelunasan yang klop
    // di Accurate tetap klop dalam sen — tanpa ember tak teralokasi semu 1 sen; selisih nyata tetap terlihat. Tiap baris meleset ≤ 1 sen.
    // ponytail: sen sisa jatuh ke baris yang melewati setengah sen, bukan ke orang tertentu — multi-salesman bisa bergeser 1 sen antarorang
    // (ditangkap klop/penjelasan, tidak diam-diam). Jalan naik: bulatkan kumulatif berurutan masterSalesmanId bila keluhan muncul.
    let kumulatif = BigInt(0);
    let senSebelum = 0;
    const faktur = new Map<number, PelunasanFaktur>();
    for (const [i, x] of r.detailInvoice.entries()) {
        const baris = obj(x);
        const inv = obj(baris?.invoice);
        const di = `detail ${nomor} baris faktur ${i + 1}`;
        const fakturId = idSah(inv?.id ?? baris?.invoiceId);
        if (!baris || Number.isNaN(fakturId)) return { ok: false, sebab: "bentuk", pesan: `${di}: invoice.id / invoiceId tidak sah` };
        const ms = inv?.masterSalesmanId;
        const masterSalesmanId = ms === undefined || ms === null ? null : idSah(ms);
        if (Number.isNaN(masterSalesmanId)) return { ok: false, sebab: "bentuk", pesan: `${di}: masterSalesmanId ${JSON.stringify(ms)} tidak sah` };
        const ipTepat = tepat(baris.invoicePayment, `${di} invoicePayment`);
        if (typeof ipTepat !== "bigint") return ipTepat;
        kumulatif += ipTepat;
        const senKini = keSenBulat(kumulatif, `${di} invoicePayment`);
        if (typeof senKini !== "number") return senKini;
        const ip = senKini - senSebelum;
        senSebelum = senKini;
        const lama = faktur.get(fakturId);
        if (lama && lama.masterSalesmanId !== masterSalesmanId) {
            return { ok: false, sebab: "bentuk", pesan: `${di}: faktur ${fakturId} muncul dua kali dengan salesman berbeda` };
        }
        const jumlahFaktur = (lama?.invoicePayment ?? 0) + ip;
        if (!Number.isSafeInteger(ip) || !Number.isSafeInteger(jumlahFaktur)) return { ok: false, sebab: "nominal", pesan: `${di} invoicePayment: Nominal di luar batas` };
        faktur.set(fakturId, { fakturId, nomorFaktur: lama?.nomorFaktur ?? (teks(inv?.number) || null), masterSalesmanId, invoicePayment: jumlahFaktur });
    }
    return { ok: true, pelunasan: { id: harap.id, nomor, tanggal: tgl, metode, chequeAmount: cheque, faktur: [...faktur.values()] } };
}

/**
 * (d) Rencana satu putaran per id: `baca` = id baru / lastUpdate beda TEKS (penuh = semua), `tetap` = sama, `hapus` = di cache tapi
 * tidak ada di daftar — HANYA bila daftar LENGKAP (daftar terpotong tidak pernah menghapus). Tanpa perbandingan jam.
 */
export function rencanaBaca(cache: ReadonlyMap<number, string | null>, daftar: { baris: readonly BarisDaftar[]; lengkap: boolean }, penuh: boolean) {
    const baca: BarisDaftar[] = [];
    const tetap: number[] = [];
    for (const b of daftar.baris) {
        if (!penuh && cache.has(b.id) && cache.get(b.id) === b.lastUpdate) tetap.push(b.id);
        else baca.push(b);
    }
    const ada = new Set(daftar.baris.map((b) => b.id));
    const hapus = daftar.lengkap ? [...cache.keys()].filter((id) => !ada.has(id)).sort((a, b) => a - b) : [];
    return { baca, hapus, tetap };
}

/**
 * Penjaga hapus massal: satu putaran akan menghapus > 5 pelunasan DAN > 10 % cache tanggal itu -> jangan hapus (status gagal
 * `hapus_massal`, konfirmasi OM/Admin). ponytail: ambang heuristik — akun sinkron yang kehilangan SEDIKIT cabang (≤ 10 % / ≤ 5 baris) tetap
 * lolos. Jalan naik: bandingkan daftar cabang yang terlihat akun sinkron (branch/list.do) dengan daftar harapan sebelum menghapus.
 */
export const hapusMassal = (hapus: number, cache: number): boolean => hapus > 5 && hapus > cache * 0.1;

/** Kontrak K2 (orkestrator 12 Okt): Tutup hari hanya bila status `lengkap` DAN lengkap_pada ≤ 15 menit; lebih tua -> segarkan dulu. */
export const SEGAR_TUTUP_MS = 15 * 60_000;
export function segarUntukTutup(s: { status: string; lengkapPada: string | null }, sekarang: Date): boolean {
    const t = s.lengkapPada ? Date.parse(s.lengkapPada) : NaN;
    return s.status === "lengkap" && Number.isFinite(t) && sekarang.getTime() - t <= SEGAR_TUTUP_MS;
}

/** Pesan Accurate untuk ditampilkan: tanpa token (nilai rahasia sesi, `Bearer …`, untaian panjang mirip token), maks. 300 huruf. */
export function saringPesan(v: unknown, rahasia: readonly string[] = []): string {
    let t = Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ")
        : typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
    for (const r of rahasia) if (r && r.length >= 4) t = t.split(r).join("***");
    t = t.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer ***").replace(/[A-Za-z0-9+/_=-]{24,}/g, "***");
    return t.trim().slice(0, 300) || "tanpa pesan";
}

export type Jawaban = { status: number; teks: string } | { galat: unknown } | { kredensialAbsen: true };

/**
 * (e) Kelas satu jawaban Accurate: sesi_sinkron (401 / kredensial absen), hak_akses (403), batas_laju (429), accurate_5xx (≥ 500),
 * jaringan (fetch gagal), tidak_pasti (timeout / abort / bukan JSON), ditolak (`s:false` atau HTTP lain, pesan disaring). `kelas: null`
 * = sah (HTTP 200 + `s:true`). bentuk/nominal/terpotong dihasilkan pengurai, bukan di sini.
 */
export function kelasGalat(j: Jawaban, rahasia: readonly string[] = []): { kelas: KelasGalat; pesan: string } | { kelas: null; body: Record<string, unknown> } {
    if ("kredensialAbsen" in j) return { kelas: "sesi_sinkron", pesan: PESAN_SESI_SINKRON };
    if ("galat" in j) {
        const nama = (j.galat as { name?: unknown } | null)?.name;
        const pesan = saringPesan(j.galat instanceof Error ? j.galat.message : j.galat, rahasia);
        return nama === "TimeoutError" || nama === "AbortError" ? { kelas: "tidak_pasti", pesan: `tanpa jawaban (${pesan})` }
            : { kelas: "jaringan", pesan: `jaringan: ${pesan}` };
    }
    if (j.status === 401) return { kelas: "sesi_sinkron", pesan: PESAN_SESI_SINKRON };
    if (j.status === 403) return { kelas: "hak_akses", pesan: "Accurate HTTP 403 — akun sinkron tidak berhak membaca pelunasan" };
    if (j.status === 429) return { kelas: "batas_laju", pesan: "Accurate HTTP 429 (batas laju)" };
    if (j.status >= 500) return { kelas: "accurate_5xx", pesan: `Accurate HTTP ${j.status}` };
    let body: Record<string, unknown> | null = null;
    try {
        body = obj(JSON.parse(j.teks));
    } catch {
        return { kelas: "tidak_pasti", pesan: `jawaban Accurate bukan JSON (HTTP ${j.status})` };
    }
    if (j.status === 200 && body?.s === true) return { kelas: null, body };
    return { kelas: "ditolak", pesan: `Accurate HTTP ${j.status}${body?.s === false ? " s:false" : ""}: ${saringPesan(body?.m ?? body?.d, rahasia)}` };
}

/** Berapa kali ulang per kelas (brief K1b): 429 dan 5xx/jaringan ≤ 3×, tidak_pasti 1×; 401/403/ditolak tidak diulang. */
export const MAKS_ULANG: Partial<Record<KelasGalat, number>> = { batas_laju: 3, accurate_5xx: 3, jaringan: 3, tidak_pasti: 1 };
const JEDA_ULANG = [500, 1000, 2000];

/** Jeda sebelum ulang ke-`gagalKe` (1 = sesudah gagal pertama); null = jangan ulang. 429 menghormati Retry-After bila lebih lama. */
export function tundaUlang(kelas: KelasGalat, gagalKe: number, retryAfterMs: number | null = null): number | null {
    if (gagalKe < 1 || gagalKe > (MAKS_ULANG[kelas] ?? 0)) return null;
    const dasar = JEDA_ULANG[Math.min(gagalKe, JEDA_ULANG.length) - 1];
    return kelas === "batas_laju" ? Math.max(dasar, retryAfterMs ?? 0) : dasar;
}

/** Header Retry-After (detik atau tanggal HTTP) -> ms dari `sekarangMs`; tidak sah -> null. */
export function bacaRetryAfter(nilai: string | null, sekarangMs: number): number | null {
    const t = (nilai ?? "").trim();
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t) * 1000;
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : Math.max(0, ms - sekarangMs);
}

export interface Ditolak {
    id: number;
    nomor: string;
    sebab: KelasGalat;
    pesan: string;
}

export type StatusAkhir = {
    status: "lengkap" | "sebagian" | "gagal";
    sebab: KelasGalat | null;
    pesan: string | null;
    jumlahDaftar: number | null;
    sisaDetail: number | null;
};

/**
 * Status putaran. `lengkap` ⇔ daftar lengkap ∧ setiap id daftar ada di cache dengan last_update = lastUpdate list.do ∧ tidak ada yang
 * ditolak ∧ tanpa galat. Urutan: galat putaran (sesi/hak/transport/daftar) -> `gagal`; pelunasan ditolak (bentuk/nominal/s:false) ->
 * `gagal` (K-3: hari itu tak pernah lengkap sampai diperbaiki di Accurate); daftar belum terbaca / id belum cocok (batas waktu, berubah
 * di tengah) -> `sebagian`; selain itu `lengkap`. `sisaDetail` = id daftar yang belum cocok di cache.
 */
export function statusAkhir(r: {
    galat: { kelas: KelasGalat; pesan: string } | null;
    daftar: readonly BarisDaftar[] | null;
    cacheAkhir: ReadonlyMap<number, string | null>;
    ditolak: readonly Ditolak[];
}): StatusAkhir {
    const jumlahDaftar = r.daftar ? r.daftar.length : null;
    const sisaDetail = r.daftar ? r.daftar.filter((b) => r.cacheAkhir.get(b.id) !== b.lastUpdate).length : null;
    const dasar = { jumlahDaftar, sisaDetail };
    if (r.galat) return { status: "gagal", sebab: r.galat.kelas, pesan: r.galat.pesan, ...dasar };
    if (r.ditolak.length) {
        const contoh = r.ditolak.slice(0, 3).map((d) => `${d.nomor} (${d.sebab}: ${d.pesan})`).join("; ");
        return { status: "gagal", sebab: r.ditolak[0].sebab, ...dasar,
            pesan: `${r.ditolak.length} pelunasan ditolak pembaca — perbaiki di Accurate: ${contoh}${r.ditolak.length > 3 ? "; …" : ""}` };
    }
    if (r.daftar === null) return { status: "sebagian", sebab: null, pesan: "Batas waktu habis saat membaca daftar pelunasan", ...dasar };
    if (sisaDetail) return { status: "sebagian", sebab: null, pesan: `Membaca ${jumlahDaftar! - sisaDetail}/${jumlahDaftar}`, ...dasar };
    return { status: "lengkap", sebab: null, pesan: null, ...dasar };
}

/** Tanggal yang dibaca cron bawaan: hari ini (WITA) + mundur sampai hari kerja sebelumnya (Senin: Minggu & Sabtu). */
export function tanggalCron(hariIni: string): string[] {
    if (!tanggalSah(hariIni)) throw new Error(`Format tanggal salah: ${hariIni}`);
    const keluar = [hariIni];
    let t = hariIni;
    do {
        t = new Date(Date.parse(`${t}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        keluar.push(t);
    } while (!hariKerja(t));
    return keluar;
}
