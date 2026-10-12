/*
 * Tujuan: Server Kasir ↔ Incaso K2a (BL-59): muat satu hari (GET /api/kasir) dan tulis setoran / penjelasan / Tutup / Buka hari —
 *   SATU transaksi READ COMMITTED per tulis, pernyataan pertama kunci hari pg_advisory_xact_lock(hashtextextended('kasir:'||tanggal, 0)),
 *   lalu baca ulang event -> statusHari/bolehDiubah (jam server) -> hitung ulang dari DB (angka klien = pembanding saja) -> INSERT.
 *   Tutup juga FOR SHARE baris status baca K1b (klaim pembaca menunggu; cache diam selama transaksi). Kunci 20.00 WITA dicatat MALAS
 *   (event `kunci` oleh 'sistem' + snapshot) oleh aksi pertama sesudahnya — tanpa cron.
 * Keputusan: scratch/fiori-intake/OWNER-ANSWERS-K1b-S7-1b-2026-10-12.md (K2: bukti transfer berkas wajib, Form Kasir wajib bila > 0,
 *   Giro wajib nomor BG + jatuh tempo; orkestrator: kunci malas, jelaskan tanpa syarat lengkap, Minggu tak diblokir) + OWNER-ANSWERS-S7-
 *   2026-10-10.md (C8, T1, T2). Kontrak: docs/handover/KASIR-KONTRAK.md §8.
 * Caller: app/api/kasir/route.ts (GET), app/api/kasir/{setoran,jelaskan,tutup,buka,bukti}/route.ts.
 * Dependensi: lib/kasir/rekonsiliasi (murni), lib/kasir/baca-pelunasan (muatPelunasanDalam, databaseIdSinkron, publikkan),
 *   lib/kasir/pembaca (segarUntukTutup, tanggalSah), lib/insentif-payment-date (todayWita), lib/db, db/schema.
 * Main Functions: muatHari, catatKunciOtomatis, catatSetoran, jelaskan, tutupHari, bukaHari, cariBukti, muatPetaOrang, bentukJawabanHari,
 *   uraiSetoran/uraiJelaskan/uraiTutup/uraiBuka/uraiTanggal, jawabanGalat, sidikHari.
 * Side Effects: SELECT tabel kasir_* + accurate_employee + sales_code_merge; INSERT kasir_setoran, kasir_selisih_catatan,
 *   kasir_tak_teralokasi_catatan, kasir_hari_event (append-only; tanpa UPDATE/DELETE). TIDAK pernah memanggil Accurate.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@/lib/db";
import { accurateEmployee, kasirHariEvent, kasirSelisihCatatan, kasirSetoran, kasirTakTeralokasiCatatan, salesCodeMerge } from "@/db/schema";
import { bawaan as bawaanBaca, databaseIdSinkron, muatPelunasanDalam, publikkan, type StatusBaca, type StatusPublik } from "./baca-pelunasan.ts";
import { PESAN_SESI_SINKRON, segarUntukTutup, tanggalSah } from "./pembaca.ts";
import {
    alokasiPelunasan, ALASAN_BUKA_MIN, bolehDiubah, hariKerja, keSen, orangDariKode, orangDariSalesmanId, penghalangTutup, rekonsiliasiHari,
    rencanaSetoranOrang, senKeTeks, snapshotHari, statusHari, TANPA_SALESMAN, type EventHari, type HasilRekonsiliasi, type Pelunasan,
    type PetaOrang, type Sen,
} from "./rekonsiliasi.ts";
import { todayWita } from "../insentif-payment-date.ts";

type Db = NodePgDatabase<Record<string, unknown>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const PENJELASAN_MAKS = 1000;
/** Batas per kolom setoran (Tunai/Transfer/Giro): Rp 100.000.000.000 (tinjauan A K2a). */
export const BATAS_KOLOM_SEN = 100_000_000_000 * 100;
/**
 * Batas aman jumlah SATU hari (Σ setoran revisi terakhir; Σ |cheque| dan Σ |invoicePayment| cache): Rp 10 triliun = 1e15 sen, jauh di bawah
 * Number.MAX_SAFE_INTEGER (≈ 9e15 sen) — semua jumlah, selisih, pembulatan Rp 100 dan snapshot tetap bulat aman (klop/senKeTeks tak melempar).
 */
export const BATAS_HARI_SEN = 10_000_000_000_000 * 100;
export const TINDAK_LANJUT = ["setor_susulan", "koreksi_incaso", "lapor_om"] as const;
export type TindakLanjut = (typeof TINDAK_LANJUT)[number];

/** Titik jeda UJI balapan (bawaan no-op): uji PG menahan transaksi di titik ini untuk membuktikan serialisasi. */
export type TitikJeda = "setoran:sebelum-insert" | "tutup:sesudah-baca" | "jelaskan:sebelum-insert";

export interface DepsHari {
    db: Db;
    /** Jam SERVER (bukan klien) — kunci 20.00 WITA, hari depan, segar ≤ 15 mnt, dan `pada` event. */
    sekarang: () => Date;
    /** database_id sesi Accurate SINKRON ("" = sesi tak ada). */
    databaseId: () => Promise<string>;
    /** user.id -> nama tampilan. */
    nama: (ids: string[]) => Promise<Map<string, string>>;
    jeda: (titik: TitikJeda) => Promise<void>;
}

/** Dependensi produksi. Uji mengganti propertinya lalu memulihkannya. */
export const bawaanHari: DepsHari = {
    db,
    sekarang: () => new Date(),
    databaseId: () => databaseIdSinkron(),
    nama: (ids) => bawaanBaca.nama(ids),
    jeda: async () => undefined,
};

/** Galat berkode untuk klien (KASIR-KONTRAK §8.2). `tambahan` = field / alasan / keadaan. */
export class GalatKasir extends Error {
    constructor(readonly http: number, readonly kode: string, pesan: string, readonly tambahan: Record<string, unknown> = {}) {
        super(pesan);
    }
}

const salah = (field: string, pesan: string) => new GalatKasir(400, "INPUT_SALAH", pesan, { field });

/** Galat apa pun -> jawaban HTTP (tanpa pesan DB mentah). GalatKasir apa adanya; selain itu 500 GALAT_INTERNAL (= sebelum commit). */
export function jawabanGalat(e: unknown, label: string): { http: number; body: Record<string, unknown> } {
    if (e instanceof GalatKasir) return { http: e.http, body: { ok: false, kode: e.kode, error: e.message, ...e.tambahan } };
    console.error(label, e);
    return { http: 500, body: { ok: false, kode: "GALAT_INTERNAL", error: "Gagal memproses permintaan Kasir — tidak ada yang tersimpan. Coba lagi." } };
}

const kodePg = (e: unknown) => (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
const kendalaPg = (e: unknown) => (e as { constraint?: string; cause?: { constraint?: string } })?.constraint
    ?? (e as { cause?: { constraint?: string } })?.cause?.constraint;

// ---------------------------------------------------------------------------------------------------------------------
// Transaksi hari (serialisasi per tanggal)
// ---------------------------------------------------------------------------------------------------------------------

/** Penolakan yang TETAP meng-commit transaksi (mis. baris `kunci` sistem yang baru dicatat), lalu dilempar sesudah commit. */
type Tolak = { tolak: GalatKasir };
const tolak = (g: GalatKasir): Tolak => ({ tolak: g });
const adalahTolak = (x: unknown): x is Tolak => typeof x === "object" && x !== null && "tolak" in x;

/**
 * SATU transaksi READ COMMITTED, pernyataan pertama kunci hari. BUKAN REPEATABLE READ/SERIALIZABLE: di sana snapshot diambil SEBELUM
 * menunggu kunci sehingga tulisan pemegang kunci sebelumnya tak terlihat. Galat di dalam `fn` = ROLLBACK (pasti tak tersimpan); galat
 * sesudah `fn` selesai (COMMIT gagal / koneksi putus) = 502 TIDAK_PASTI.
 */
async function transaksiHari<T>(deps: DepsHari, tanggal: string, fn: (tx: Tx) => Promise<T | Tolak>): Promise<T> {
    let fnSelesai = false;
    let hasil: T | Tolak;
    try {
        hasil = await deps.db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kasir:${tanggal}`}, 0))`);
            const r = await fn(tx);
            fnSelesai = true;
            return r;
        }, { isolationLevel: "read committed" });
    } catch (e) {
        if (fnSelesai) {
            console.error("[KASIR] commit tidak pasti", e);
            throw new GalatKasir(502, "TIDAK_PASTI", "Server tidak memberi jawaban yang pasti — hasilnya belum pasti. Muat ulang dan periksa dulu sebelum mengulang.");
        }
        throw e;
    }
    if (adalahTolak(hasil)) throw hasil.tolak;
    return hasil;
}

// ---------------------------------------------------------------------------------------------------------------------
// Muat (di dalam transaksi pemanggil)
// ---------------------------------------------------------------------------------------------------------------------

export type EventTersimpan = EventHari & { oleh: string; snapshot: unknown; pada: Date };

export interface BarisSetoran {
    id: number;
    salesmanKode: string;
    revisi: number;
    tunai: Sen;
    transfer: Sen;
    giro: Sen;
    giroNomor: string | null;
    giroJatuhTempo: string | null;
    noFormKasir: string | null;
    buktiTransfer: string | null;
    catatan: string | null;
    dicatatOleh: string;
    dicatatPada: Date;
}

export interface Muatan {
    tanggal: string;
    databaseId: string;
    events: EventTersimpan[];
    setoran: BarisSetoran[];
    catatan: { id: number; salesmanKode: string; pelunasan: Sen; setoran: Sen; penjelasan: string; tindakLanjut: string; dicatatOleh: string; dicatatPada: Date }[];
    catatanTak: { id: number; pelunasanId: number; sisa: Sen; penjelasan: string; dicatatOleh: string; dicatatPada: Date }[];
    /** null = sesi sinkron tanpa database (cache tak dibaca). */
    baca: StatusBaca | null;
    pelunasan: Pelunasan[];
    peta: PetaOrang;
    namaKode: Map<string, string>;
    pegawai: { kode: string; orang: string; nama: string }[];
    kodeDikenal: Set<string>;
    hasil: HasilRekonsiliasi;
}

/**
 * Peta orang hari itu: accurate_employee (id -> number = kode salesman, nama) + sales_code_merge decision 'merge' BULAN `tanggal`
 * (from -> to). `pegawai` = pilihan setoran tanpa pelunasan (salesman ∧ ¬suspended); `kodeDikenal` = semua nomor pegawai.
 */
export async function muatPetaOrang(tx: Db | Tx, tanggal: string) {
    const rows = await tx.select({ id: accurateEmployee.id, number: accurateEmployee.number, name: accurateEmployee.name,
        salesman: accurateEmployee.salesman, suspended: accurateEmployee.suspended }).from(accurateEmployee)
        .orderBy(asc(accurateEmployee.number), asc(accurateEmployee.id));
    const [tahun, bulan] = tanggal.split("-").map(Number);
    const gabung = await tx.select({ dari: salesCodeMerge.fromSalesCode, ke: salesCodeMerge.toSalesCode }).from(salesCodeMerge)
        .where(and(eq(salesCodeMerge.periodMonth, bulan), eq(salesCodeMerge.periodYear, tahun), eq(salesCodeMerge.decision, "merge")));
    const peta: PetaOrang = {
        kodeSalesman: new Map(rows.map((r) => [Number(r.id), r.number.trim()])),
        gabunganPerBulan: new Map([[tanggal.slice(0, 7), new Map(gabung.filter((g) => g.dari.trim() && g.ke?.trim())
            .map((g) => [g.dari.trim(), g.ke!.trim()]))]]),
    };
    const namaKode = new Map<string, string>();
    for (const r of rows) if (r.number.trim() && r.name.trim() && !namaKode.has(r.number.trim())) namaKode.set(r.number.trim(), r.name.trim());
    const pegawai = rows.filter((r) => r.salesman && !r.suspended && r.number.trim())
        .map((r) => ({ kode: r.number.trim(), orang: orangDariKode(r.number, tanggal, peta), nama: r.name.trim() }));
    return { peta, namaKode, pegawai, kodeDikenal: new Set(rows.map((r) => r.number.trim()).filter(Boolean)) };
}

/** Nominal tersimpan yang tak bisa jadi sen bulat aman (keSen RangeError) -> galat terbaca 422, bukan 500. */
async function angkaAman<T>(apa: string, fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        throw new GalatKasir(422, "ANGKA_TIDAK_SAH", `Nominal ${apa} tersimpan tidak sah (${e.message}) — hari ini tidak bisa dihitung. Minta IT memeriksa data tersimpan.`);
    }
}

/** Semua bahan satu hari dibaca dari `tx` (kunci hari / FOR SHARE dipegang pemanggil) + rekonsiliasi. */
async function muatDalam(tx: Db | Tx, tanggal: string, databaseId: string): Promise<Muatan> {
    const ev = await tx.select().from(kasirHariEvent).where(eq(kasirHariEvent.tanggal, tanggal)).orderBy(asc(kasirHariEvent.id));
    const st = await tx.select().from(kasirSetoran).where(eq(kasirSetoran.tanggal, tanggal)).orderBy(asc(kasirSetoran.salesmanKode), asc(kasirSetoran.revisi));
    const ct = await tx.select().from(kasirSelisihCatatan).where(eq(kasirSelisihCatatan.tanggal, tanggal)).orderBy(asc(kasirSelisihCatatan.id));
    const tk = databaseId ? await tx.select().from(kasirTakTeralokasiCatatan)
        .where(and(eq(kasirTakTeralokasiCatatan.tanggal, tanggal), eq(kasirTakTeralokasiCatatan.databaseId, databaseId)))
        .orderBy(asc(kasirTakTeralokasiCatatan.id)) : [];
    const cache = databaseId ? await angkaAman("cache pelunasan", () => muatPelunasanDalam(tx, databaseId, tanggal))
        : { status: null, pelunasan: [] as Pelunasan[] };
    const orang = await muatPetaOrang(tx, tanggal);
    const setoran: BarisSetoran[] = await angkaAman("setoran", async () => st.map((s) => ({ id: Number(s.id), salesmanKode: s.salesmanKode,
        revisi: s.revisi, tunai: keSen(s.tunai), transfer: keSen(s.transfer), giro: keSen(s.giro), giroNomor: s.giroNomor,
        giroJatuhTempo: s.giroJatuhTempo, noFormKasir: s.noFormKasir, buktiTransfer: s.buktiTransfer, catatan: s.catatan, dicatatOleh: s.dicatatOleh,
        dicatatPada: s.dicatatPada })));
    const catatan = await angkaAman("penjelasan selisih", async () => ct.map((c) => ({ id: Number(c.id), salesmanKode: c.salesmanKode,
        pelunasan: keSen(c.pelunasan), setoran: keSen(c.setoran), penjelasan: c.penjelasan, tindakLanjut: c.tindakLanjut, dicatatOleh: c.dicatatOleh,
        dicatatPada: c.dicatatPada })));
    const catatanTak = await angkaAman("penjelasan tak teralokasi", async () => tk.map((c) => ({ id: Number(c.id), pelunasanId: Number(c.pelunasanId),
        sisa: keSen(c.sisa), penjelasan: c.penjelasan, dicatatOleh: c.dicatatOleh, dicatatPada: c.dicatatPada })));
    // Pertahanan kedua (tinjauan A): angka yang SUDAH tersimpan di luar batas aman -> galat terbaca 422, bukan 500 dari klop/senKeTeks.
    const terakhir = new Map<string, BarisSetoran>();
    for (const s of setoran) if ((terakhir.get(s.salesmanKode)?.revisi ?? 0) < s.revisi) terakhir.set(s.salesmanKode, s);
    const jumlah = (xs: number[]) => xs.reduce((a, x) => a + Math.abs(x), 0);
    for (const [apa, n] of [["setoran (revisi terakhir)", jumlah([...terakhir.values()].map((s) => s.tunai + s.transfer + s.giro))],
        ["pelunasan (chequeAmount)", jumlah(cache.pelunasan.map((p) => p.chequeAmount))],
        ["baris faktur (invoicePayment)", jumlah(cache.pelunasan.flatMap((p) => p.faktur.map((f) => f.invoicePayment)))]] as const) {
        if (n > BATAS_HARI_SEN) {
            throw new GalatKasir(422, "ANGKA_TIDAK_SAH", `Jumlah ${apa} tanggal ${tanggal} melebihi batas aman Rp 10 triliun — hari ini tidak bisa dihitung. `
                + "Minta IT memeriksa data tersimpan (tabel jejak append-only, perbaikan oleh role pemilik).");
        }
    }
    const hasil = rekonsiliasiHari({ tanggal, pelunasan: cache.pelunasan, peta: orang.peta,
        setoran: setoran.map((s) => ({ salesmanKode: s.salesmanKode, revisi: s.revisi, tunai: s.tunai, transfer: s.transfer, giro: s.giro })),
        catatan: catatan.map((c) => ({ salesmanKode: c.salesmanKode, pelunasan: c.pelunasan, setoran: c.setoran })),
        catatanTakTeralokasi: catatanTak.map((c) => ({ pelunasanId: c.pelunasanId, sisa: c.sisa })) });
    return {
        tanggal, databaseId, setoran, catatan, catatanTak, baca: cache.status, pelunasan: cache.pelunasan, hasil, ...orang,
        events: ev.map((e) => ({ id: Number(e.id), jenis: e.jenis as EventHari["jenis"], alasan: e.alasan, pada: e.pada, oleh: e.oleh, snapshot: e.snapshot })),
    };
}

/** Snapshot event tutup/kunci = snapshotHari + ringkasan baca (status, lengkapPada, jumlahDaftar, akun = user.id akun sinkron). */
function snapshotTersimpan(m: Muatan) {
    return { ...snapshotHari(m.hasil), baca: m.baca ? { status: m.baca.status, lengkapPada: m.baca.lengkapPada, jumlahDaftar: m.baca.jumlahDaftar,
        akun: m.baca.akunSinkron } : null };
}

async function sisipEvent(tx: Tx, m: Muatan, e: { jenis: EventHari["jenis"]; alasan?: string | null; snapshot?: unknown; oleh: string }, pada: Date) {
    const [r] = await tx.insert(kasirHariEvent).values({ tanggal: m.tanggal, jenis: e.jenis, alasan: e.alasan ?? null, snapshot: e.snapshot ?? null,
        oleh: e.oleh, pada }).returning();
    const ev: EventTersimpan = { id: Number(r.id), jenis: e.jenis, alasan: r.alasan, pada: r.pada, oleh: r.oleh, snapshot: r.snapshot };
    m.events.push(ev);
    return ev;
}

/**
 * Kunci 20.00 WITA dicatat malas: hari terkunci OTOMATIS (tanpa event sesudah 20.00, atau jendela buka lewat) -> event `kunci` oleh
 * 'sistem' + snapshot, di transaksi berkunci pemanggil (sekali walau serentak). Tanpa database sinkron = dilewati (snapshot tanpa
 * Incaso menyesatkan); kunci tetap berlaku dari statusHari.
 */
async function pastikanKunci(tx: Tx, m: Muatan, sekarang: Date): Promise<boolean> {
    // belum_dibaca (tinjauan A RENDAH 4): GET tanggal lama (mis. 1900-01-01) dulu menulis kunci permanen bersnapshot Incaso nol — kini dilewati;
    // kunci tetap berlaku dari jam (statusHari), snapshot dicatat aksi pertama sesudah cache tanggal itu pernah dibaca.
    if (statusHari(m.tanggal, m.events, sekarang).sebab !== "otomatis_20" || m.baca === null || m.baca.status === "belum_dibaca") return false;
    await sisipEvent(tx, m, { jenis: "kunci", snapshot: snapshotTersimpan(m), oleh: "sistem" }, sekarang);
    return true;
}

/** Catat kunci otomatis (GET pertama sesudah 20.00). true = baris kunci baru ditulis. */
export async function catatKunciOtomatis(tanggal: string, deps: DepsHari = bawaanHari): Promise<boolean> {
    const databaseId = (await deps.databaseId()).trim();
    if (!databaseId) return false;
    return transaksiHari(deps, tanggal, async (tx) => pastikanKunci(tx, await muatDalam(tx, tanggal, databaseId), deps.sekarang()));
}

// ---------------------------------------------------------------------------------------------------------------------
// Sidik & banding snapshot
// ---------------------------------------------------------------------------------------------------------------------

/** JSON berkunci terurut (jsonb Postgres mengurutkan ulang kunci objek). */
function kanonik(v: unknown): string {
    return JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : x));
}
const inti = (s: unknown) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return { total: o.total ?? null, baris: o.baris ?? null, takTeralokasi: o.takTeralokasi ?? null };
};

/**
 * Sidik angka hari — dikirim klien di POST tutup: total, baris orang + status + dijelaskan, ember, DAN komposisi metode pelunasan + setoran
 * per kode (revisi, tunai, transfer, giro). Tanpa yang terakhir, Tunai 100.000 -> Transfer 100.000 oleh pengguna lain lolos Tutup dengan
 * sidik lama (tinjauan A RENDAH 5).
 */
export function sidikHari(h: HasilRekonsiliasi): string {
    const rinci = h.baris.map((b) => ({ orang: b.orang, perMetode: b.pelunasanPerMetode,
        perKode: b.setoranPerKode.map((x) => [x.kode, x.revisi, x.tunai, x.transfer, x.giro]) }));
    return createHash("sha256").update(kanonik({ ...inti(snapshotHari(h)), rinci })).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------------------------------------------------
// Bentuk jawaban GET (murni)
// ---------------------------------------------------------------------------------------------------------------------

const T = (sen: Sen) => senKeTeks(sen);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const TAK_DIKENAL = "(akun tak dikenal)";

function pesanBelumLengkap(b: StatusBaca): string {
    const n = b.jumlahDaftar !== null && b.sisaDetail !== null ? ` (${b.jumlahDaftar - b.sisaDetail}/${b.jumlahDaftar})` : "";
    const sebab = {
        belum_dibaca: "Pelunasan Incaso tanggal ini belum pernah dibaca — tekan Segarkan.",
        berjalan: b.aktif ? "Pelunasan Incaso sedang dibaca." : "Pembaca pelunasan Incaso terhenti — tekan Segarkan.",
        sebagian: `Pelunasan Incaso baru terbaca sebagian${n}.`,
        gagal: `Pelunasan Incaso gagal dibaca${b.pesan ? `: ${b.pesan}` : "."}`,
        lengkap: "",
    }[b.status];
    return `${sebab} Angka Incaso belum ditampilkan (bukan nol).`;
}

/**
 * Jawaban GET /api/kasir dari muatan (murni; diuji tanpa DB). Angka Incaso HANYA bila status baca `lengkap` — selain itu null + sebab;
 * setoran selalu. Bentuk = KASIR-KONTRAK §8.3.
 */
export function bentukJawabanHari(m: Muatan, o: { sekarang: Date; orang: string | null; namaUser: Map<string, string>; baca: StatusPublik | null }) {
    const L = m.baca?.status === "lengkap";
    const h = m.hasil;
    const nU = (id: string) => (id === "sistem" ? "Sistem" : o.namaUser.get(id) ?? TAK_DIKENAL);
    const lipat = (kode: string) => orangDariKode(kode, m.tanggal, m.peta);
    const namaOrang = (orang: string, kode: readonly string[] = []) => (orang === TANPA_SALESMAN ? "Tanpa salesman"
        : m.namaKode.get(orang) ?? kode.map((k) => m.namaKode.get(k)).find(Boolean) ?? "");
    const buktiUrl = (s: BarisSetoran) => (s.buktiTransfer ? `/api/kasir/bukti?id=${s.id}` : null);
    const revisiPublik = (s: BarisSetoran) => ({ id: s.id, kode: s.salesmanKode, orang: lipat(s.salesmanKode), revisi: s.revisi, tunai: T(s.tunai),
        transfer: T(s.transfer), giro: T(s.giro), total: T(s.tunai + s.transfer + s.giro), noFormKasir: s.noFormKasir, buktiUrl: buktiUrl(s),
        giroNomor: s.giroNomor, giroJatuhTempo: s.giroJatuhTempo, catatan: s.catatan, oleh: nU(s.dicatatOleh), pada: iso(s.dicatatPada) });
    const st = statusHari(m.tanggal, m.events, o.sekarang);
    const akhirTK = [...m.events].reverse().find((e) => e.jenis !== "buka");
    const embers = h.takTeralokasi;

    let rincian: { orang: string; pelunasan: unknown[] } | null | undefined;
    if (o.orang !== null) {
        rincian = null;
        if (L) {
            let target: string | null = null;
            try { target = o.orang.trim() ? lipat(o.orang) : TANPA_SALESMAN; } catch { target = null; }
            const bagian = target === null ? [] : alokasiPelunasan(m.pelunasan, m.peta).bagian.filter((b) => b.orang === target);
            rincian = { orang: target ?? o.orang, pelunasan: bagian.map((b) => {
                const p = m.pelunasan.find((x) => x.id === b.pelunasanId)!;
                return { pelunasanId: p.id, nomor: p.nomor, metode: p.metode, chequeAmount: T(p.chequeAmount), bagian: T(b.sen),
                    faktur: p.faktur.filter((f) => orangDariSalesmanId(f.masterSalesmanId, p.tanggal, m.peta).orang === target)
                        .map((f) => ({ fakturId: f.fakturId, nomorFaktur: f.nomorFaktur ?? null, invoicePayment: T(f.invoicePayment) })) };
            }) };
        }
    }

    const penjelasan = [
        ...m.catatan.map((c) => {
            const orang = lipat(c.salesmanKode);
            const b = h.baris.find((x) => x.orang === orang);
            return { id: c.id, jenis: "selisih" as const, orang, pelunasan: T(c.pelunasan), setoran: T(c.setoran), penjelasan: c.penjelasan,
                tindakLanjut: c.tindakLanjut, oleh: nU(c.dicatatOleh), pada: iso(c.dicatatPada), _t: c.dicatatPada.getTime(),
                berlaku: L ? Boolean(b && b.pelunasan === c.pelunasan && (b.setoran?.total ?? 0) === c.setoran) : null };
        }),
        ...m.catatanTak.map((c) => ({ id: c.id, jenis: "tak_teralokasi" as const, pelunasanId: c.pelunasanId, sisa: T(c.sisa), penjelasan: c.penjelasan,
            oleh: nU(c.dicatatOleh), pada: iso(c.dicatatPada), _t: c.dicatatPada.getTime(),
            berlaku: L ? embers.some((e) => e.pelunasanId === c.pelunasanId && e.sisa === c.sisa) : null })),
    ].sort((a, b) => a._t - b._t || a.id - b.id).map(({ _t, ...x }) => { void _t; return x; });

    const p = L ? penghalangTutup(h) : null;
    return {
        ok: true as const,
        tanggal: m.tanggal,
        sekarang: o.sekarang.toISOString(),
        hari: {
            terkunci: st.terkunci, sebab: st.sebab, kunciBerikutnya: iso(st.kunciBerikutnya), bolehDiubah: bolehDiubah(m.tanggal, m.events, o.sekarang),
            hariKerja: hariKerja(m.tanggal),
            berubahSejakDitutup: L && akhirTK ? kanonik(inti(snapshotHari(h))) !== kanonik(inti(akhirTK.snapshot)) : null,
            event: m.events.map((e) => ({ id: e.id, jenis: e.jenis, alasan: e.alasan ?? null, oleh: nU(e.oleh), pada: iso(e.pada) })),
        },
        baca: o.baca,
        segarUntukTutup: m.baca ? segarUntukTutup(m.baca, o.sekarang) : false,
        incaso: { lengkap: L, sebab: m.baca === null ? "SESI_SINKRON" : L ? null : "BACA_BELUM_LENGKAP",
            pesan: m.baca === null ? PESAN_SESI_SINKRON : L ? null : pesanBelumLengkap(m.baca) },
        total: {
            pelunasan: L ? T(h.total.pelunasan) : null, setoran: T(h.total.setoran), selisih: L ? T(h.total.setoran - h.total.pelunasan) : null,
            takTeralokasi: L ? T(h.total.takTeralokasi) : null, takTeralokasiBelumDijelaskan: L ? embers.filter((e) => !e.dijelaskan).length : null,
            nonKas: L ? T(h.total.nonKas) : null, klop: L ? h.baris.filter((b) => b.status === "klop").length : null, jumlahOrang: h.baris.length,
        },
        orang: h.baris.map((b) => {
            // Revisi terakhir kode UTAMA (= dasar buktiLama); belum ada -> revisi terbaru kode lain milik orang itu (sebelum gabungan).
            const milik = m.setoran.filter((s) => lipat(s.salesmanKode) === b.orang).sort((x, y) => x.id - y.id);
            const terakhir = milik.filter((s) => s.salesmanKode === b.orang).at(-1) ?? milik.at(-1);
            return {
                orang: b.orang, nama: namaOrang(b.orang, b.kode), kode: b.kode,
                pelunasan: L ? T(b.pelunasan) : null,
                pelunasanPerMetode: L ? Object.fromEntries(Object.entries(b.pelunasanPerMetode).map(([k, v]) => [k, T(v)])) : null,
                jumlahFaktur: L ? b.jumlahFaktur : null,
                setoran: b.setoran ? { tunai: T(b.setoran.tunai), transfer: T(b.setoran.transfer), giro: T(b.setoran.giro), total: T(b.setoran.total) } : null,
                dasar: b.setoranPerKode.map((x) => ({ kode: x.kode, revisi: x.revisi })),
                setoranPerKode: b.setoranPerKode.map((x) => ({ kode: x.kode, revisi: x.revisi, tunai: T(x.tunai), transfer: T(x.transfer), giro: T(x.giro),
                    total: T(x.total) })),
                setoranTerakhir: terakhir ? { id: terakhir.id, kode: terakhir.salesmanKode, revisi: terakhir.revisi, noFormKasir: terakhir.noFormKasir,
                    buktiUrl: buktiUrl(terakhir), giroNomor: terakhir.giroNomor, giroJatuhTempo: terakhir.giroJatuhTempo, catatan: terakhir.catatan,
                    oleh: nU(terakhir.dicatatOleh), pada: iso(terakhir.dicatatPada) } : null,
                selisih: L && b.selisih !== null ? T(b.selisih) : null,
                status: L ? b.status : null,
                dijelaskan: L ? b.dijelaskan : null,
                salesmanIdTakDikenal: L ? b.salesmanIdTakDikenal : null,
            };
        }),
        takTeralokasi: L ? embers.map((e) => ({ pelunasanId: e.pelunasanId, nomor: e.nomor, metode: e.metode, chequeAmount: T(e.chequeAmount),
            jumlahInvoicePayment: T(e.jumlahInvoicePayment), sisa: T(e.sisa), arah: e.arah, alasan: e.alasan,
            orang: e.orang.map((x) => ({ orang: x, nama: namaOrang(x) })), dijelaskan: e.dijelaskan })) : null,
        nonKas: L ? h.nonKas.map((x) => ({ pelunasanId: x.id, nomor: x.nomor, metode: x.metode, chequeAmount: T(x.chequeAmount) })) : null,
        penghalangTutup: p ? { bisaDitutup: p.bisaDitutup, alasan: p.alasan } : null,
        sidik: L ? sidikHari(h) : null,
        riwayat: { setoran: m.setoran.map(revisiPublik), penjelasan },
        pegawai: m.pegawai,
        ...(rincian === undefined ? {} : { rincian }),
    };
}
export type JawabanHari = ReturnType<typeof bentukJawabanHari>;

/** GET /api/kasir: catat kunci otomatis bila perlu (gagal tak menggagalkan GET), lalu satu snapshot REPEATABLE READ baca-saja. */
export async function muatHari(tanggal: string, o: { orang: string | null }, deps: DepsHari = bawaanHari): Promise<JawabanHari> {
    const databaseId = (await deps.databaseId()).trim();
    if (databaseId) {
        const ev = await deps.db.select({ id: kasirHariEvent.id, jenis: kasirHariEvent.jenis, pada: kasirHariEvent.pada, alasan: kasirHariEvent.alasan })
            .from(kasirHariEvent).where(eq(kasirHariEvent.tanggal, tanggal)).orderBy(asc(kasirHariEvent.id));
        const events = ev.map((e) => ({ id: Number(e.id), jenis: e.jenis as EventHari["jenis"], pada: e.pada, alasan: e.alasan }));
        if (statusHari(tanggal, events, deps.sekarang()).sebab === "otomatis_20") {
            await catatKunciOtomatis(tanggal, deps).catch((e) => console.error("[KASIR KUNCI OTOMATIS]", e));
        }
    }
    const m = await deps.db.transaction((tx) => muatDalam(tx, tanggal, databaseId), { isolationLevel: "repeatable read", accessMode: "read only" });
    const ids = [...new Set([...m.events.map((e) => e.oleh), ...m.setoran.map((s) => s.dicatatOleh), ...m.catatan.map((c) => c.dicatatOleh),
        ...m.catatanTak.map((c) => c.dicatatOleh)].filter((x) => x && x !== "sistem"))];
    const namaUser = ids.length ? await deps.nama(ids).catch(() => new Map<string, string>()) : new Map<string, string>();
    const baca = m.baca ? await publikkan(m.baca, { nama: deps.nama }) : null;
    return bentukJawabanHari(m, { sekarang: deps.sekarang(), orang: o.orang, namaUser, baca });
}

// ---------------------------------------------------------------------------------------------------------------------
// Urai isian (murni; 400 INPUT_SALAH + field)
// ---------------------------------------------------------------------------------------------------------------------

const objek = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw salah("badan", "Badan permintaan harus objek JSON.");
    return raw as Record<string, unknown>;
};

/** Tanggal sah YYYY-MM-DD, tanggal yang ada, tidak di masa depan WITA (jam server). */
export function uraiTanggal(t: unknown, sekarang: Date): string {
    if (!tanggalSah(t)) throw salah("tanggal", "Tanggal wajib YYYY-MM-DD dan tanggal yang ada.");
    const hariIni = todayWita(sekarang);
    if (t > hariIni) throw salah("tanggal", `Tanggal ${t} belum tiba (hari ini ${hariIni} WITA).`);
    return t;
}

/** Nominal TEKS ≥ 0 (atau bertanda bila `bertanda`), maks. 2 desimal, tanpa pemisah ribuan -> sen; |sen| ≤ `maks`. */
function uraiNominal(v: unknown, field: string, bertanda = false, maks = BATAS_HARI_SEN): Sen {
    const t = typeof v === "string" ? v.trim() : null;
    if (t === null || !(bertanda ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/).test(t)) {
        throw salah(field, `Nominal ${field} tidak sah: teks angka${bertanda ? "" : " tidak negatif"}, maks. 2 desimal, tanpa pemisah ribuan (contoh "1250000").`);
    }
    let sen: Sen;
    try {
        sen = keSen(t);
    } catch {
        throw salah(field, `Nominal ${field} di luar batas.`);
    }
    if (Math.abs(sen) > maks) throw salah(field, `Nominal ${field} melebihi batas ${rupiahSen(maks)}.`);
    return sen;
}
const rupiahSen = (sen: Sen) => `Rp ${(sen / 100).toLocaleString("id-ID")}`;

function teksOpsional(v: unknown, field: string, maks: number): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw salah(field, `${field} harus teks.`);
    const t = v.trim();
    if (t.length > maks) throw salah(field, `${field} maksimal ${maks} huruf.`);
    return t || null;
}

function teksWajib(v: unknown, field: string, min: number, maks: number, apa: string): string {
    const t = typeof v === "string" ? v.trim() : "";
    if (t.length < min) throw salah(field, `${apa} wajib diisi minimal ${min} huruf.`);
    if (t.length > maks) throw salah(field, `${apa} maksimal ${maks} huruf.`);
    return t;
}

export interface IsianSetoran {
    tanggal: string;
    orang: string;
    tunai: Sen;
    transfer: Sen;
    giro: Sen;
    noFormKasir: string | null;
    giroNomor: string | null;
    giroJatuhTempo: string | null;
    buktiLama: boolean;
    catatan: string | null;
    dasar: { kode: string; revisi: number }[];
}

/** Isian POST setoran (KASIR-KONTRAK §8.4). `adaBerkas` = bagian `bukti` multipart berisi. */
export function uraiSetoran(raw: unknown, sekarang: Date, adaBerkas: boolean): IsianSetoran {
    const r = objek(raw);
    const tanggal = uraiTanggal(r.tanggal, sekarang);
    if (typeof r.orang !== "string") throw salah("orang", "Orang (kode salesman) wajib diisi.");
    const orang = r.orang.trim();
    if (orang === TANPA_SALESMAN) throw salah("orang", "Setoran tidak bisa dicatat untuk Tanpa salesman — pilih pegawai.");
    if (orang.length > 100) throw salah("orang", "Kode orang terlalu panjang.");
    const tunai = uraiNominal(r.tunai, "tunai", false, BATAS_KOLOM_SEN);
    const transfer = uraiNominal(r.transfer, "transfer", false, BATAS_KOLOM_SEN);
    const giro = uraiNominal(r.giro, "giro", false, BATAS_KOLOM_SEN);
    const total = tunai + transfer + giro;
    const noFormKasir = teksOpsional(r.noFormKasir, "noFormKasir", 100);
    if (total > 0 && !noFormKasir) throw salah("noFormKasir", "Nomor Form Kasir wajib diisi untuk setoran lebih dari 0.");
    const giroNomor = teksOpsional(r.giroNomor, "giroNomor", 100);
    const jt = r.giroJatuhTempo === undefined || r.giroJatuhTempo === null || r.giroJatuhTempo === "" ? null : r.giroJatuhTempo;
    if (jt !== null && !tanggalSah(jt)) throw salah("giroJatuhTempo", "Tanggal jatuh tempo Giro wajib YYYY-MM-DD dan tanggal yang ada.");
    if (giro > 0 && !giroNomor) throw salah("giroNomor", "Nomor BG wajib diisi untuk setoran Giro.");
    if (giro > 0 && jt === null) throw salah("giroJatuhTempo", "Tanggal jatuh tempo Giro wajib diisi untuk setoran Giro.");
    if (giro === 0 && (giroNomor || jt !== null)) throw salah(giroNomor ? "giroNomor" : "giroJatuhTempo", "Nomor BG / jatuh tempo hanya untuk setoran Giro lebih dari 0.");
    if (r.buktiLama !== undefined && typeof r.buktiLama !== "boolean") throw salah("buktiTransfer", "buktiLama harus true/false.");
    const buktiLama = r.buktiLama === true;
    if (transfer > 0 && !adaBerkas && !buktiLama) throw salah("buktiTransfer", "Bukti transfer (foto/PDF) wajib diunggah untuk setoran Transfer.");
    if (transfer === 0 && (adaBerkas || buktiLama)) throw salah("buktiTransfer", "Bukti transfer hanya untuk setoran Transfer lebih dari 0.");
    if (adaBerkas && buktiLama) throw salah("buktiTransfer", "Pilih salah satu: unggah bukti baru ATAU pakai bukti revisi sebelumnya.");
    const catatan = teksOpsional(r.catatan, "catatan", 500);
    if (!Array.isArray(r.dasar) || r.dasar.length > 50) throw salah("dasar", "dasar wajib larik { kode, revisi } dari GET /api/kasir.");
    const dasar = r.dasar.map((d) => {
        const x = d as { kode?: unknown; revisi?: unknown } | null;
        if (!x || typeof x.kode !== "string" || !x.kode.trim() || !Number.isSafeInteger(x.revisi) || (x.revisi as number) < 1) {
            throw salah("dasar", "dasar wajib larik { kode, revisi } dari GET /api/kasir.");
        }
        return { kode: x.kode.trim(), revisi: x.revisi as number };
    });
    if (new Set(dasar.map((d) => d.kode)).size !== dasar.length) throw salah("dasar", "dasar memuat kode ganda.");
    return { tanggal, orang, tunai, transfer, giro, noFormKasir, giroNomor, giroJatuhTempo: jt as string | null, buktiLama, catatan, dasar };
}

export type IsianJelaskan =
    | { tanggal: string; jenis: "selisih"; orang: string; pelunasan: Sen; setoran: Sen; penjelasan: string; tindakLanjut: TindakLanjut }
    | { tanggal: string; jenis: "tak_teralokasi"; pelunasanId: number; sisa: Sen; penjelasan: string };

export function uraiJelaskan(raw: unknown, sekarang: Date): IsianJelaskan {
    const r = objek(raw);
    const tanggal = uraiTanggal(r.tanggal, sekarang);
    const angka = (r.angka && typeof r.angka === "object" ? r.angka : {}) as Record<string, unknown>;
    if (r.jenis === "selisih") {
        if (typeof r.orang !== "string" || r.orang.length > 100) throw salah("orang", "Orang (kode salesman; \"\" = Tanpa salesman) wajib diisi.");
        const pelunasan = uraiNominal(angka.pelunasan, "angka.pelunasan");
        const setoran = uraiNominal(angka.setoran, "angka.setoran");
        const penjelasan = teksWajib(r.penjelasan, "penjelasan", ALASAN_BUKA_MIN, PENJELASAN_MAKS, "Penjelasan");
        if (!TINDAK_LANJUT.includes(r.tindakLanjut as TindakLanjut)) throw salah("tindakLanjut", "Tindak lanjut wajib dipilih (setor susulan / koreksi Incaso / lapor OM).");
        return { tanggal, jenis: "selisih", orang: r.orang.trim(), pelunasan, setoran, penjelasan, tindakLanjut: r.tindakLanjut as TindakLanjut };
    }
    if (r.jenis === "tak_teralokasi") {
        if (!Number.isSafeInteger(r.pelunasanId) || (r.pelunasanId as number) <= 0) throw salah("pelunasanId", "pelunasanId wajib bilangan bulat positif.");
        const sisa = uraiNominal(angka.sisa, "angka.sisa", true);
        if (sisa === 0) throw salah("angka.sisa", "Sisa tak teralokasi tidak boleh 0.");
        const penjelasan = teksWajib(r.penjelasan, "penjelasan", ALASAN_BUKA_MIN, PENJELASAN_MAKS, "Penjelasan");
        return { tanggal, jenis: "tak_teralokasi", pelunasanId: r.pelunasanId as number, sisa, penjelasan };
    }
    throw salah("jenis", "jenis wajib \"selisih\" atau \"tak_teralokasi\".");
}

export function uraiTutup(raw: unknown, sekarang: Date): { tanggal: string; sidik: string } {
    const r = objek(raw);
    const tanggal = uraiTanggal(r.tanggal, sekarang);
    if (typeof r.sidik !== "string" || !/^[0-9a-f]{16}$/.test(r.sidik)) throw salah("sidik", "sidik wajib dari GET /api/kasir (muat ulang halaman).");
    return { tanggal, sidik: r.sidik };
}

export function uraiBuka(raw: unknown, sekarang: Date): { tanggal: string; alasan: string } {
    const r = objek(raw);
    return { tanggal: uraiTanggal(r.tanggal, sekarang), alasan: teksWajib(r.alasan, "alasan", ALASAN_BUKA_MIN, PENJELASAN_MAKS, "Alasan buka kembali") };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tulis
// ---------------------------------------------------------------------------------------------------------------------

const keadaanHari = (m: Muatan, sekarang: Date) => {
    const st = statusHari(m.tanggal, m.events, sekarang);
    return { hari: { terkunci: st.terkunci, sebab: st.sebab, kunciBerikutnya: iso(st.kunciBerikutnya) } };
};
const terkunci = (m: Muatan, sekarang: Date) => new GalatKasir(409, "HARI_TERKUNCI", (() => {
    const st = statusHari(m.tanggal, m.events, sekarang);
    if (st.sebab === "tutup") return "Hari ini sudah ditutup — setoran dan penjelasan tidak bisa diubah. Minta OM/Admin membuka kembali bila perlu.";
    if (st.sebab === "kunci" || st.sebab === "otomatis_20") return "Hari terkunci otomatis pukul 20.00 WITA. Minta OM/Admin membuka kembali bila perlu.";
    return "Hari ini belum boleh diubah.";
})(), keadaanHari(m, sekarang));

/**
 * Catat/koreksi setoran satu ORANG: kode dilipat ke kanonik, `dasar` = revisi terakhir yang dilihat klien (≠ sekarang -> 409
 * SETORAN_BERUBAH), rencanaSetoranOrang -> SEMUA baris dalam transaksi ini. Tidak bergantung status baca. `buktiBaru` = nama berkas
 * yang SUDAH disimpan route (lib/kasir/bukti) — dihapus route bila galat pasti.
 */
export async function catatSetoran(isian: IsianSetoran & { buktiBaru: string | null }, oleh: string, deps: DepsHari = bawaanHari) {
    const databaseId = (await deps.databaseId().catch(() => "")).trim();
    try {
        return await transaksiHari(deps, isian.tanggal, async (tx) => {
            const sekarang = deps.sekarang();
            const m = await muatDalam(tx, isian.tanggal, databaseId);
            await pastikanKunci(tx, m, sekarang);
            if (!bolehDiubah(isian.tanggal, m.events, sekarang)) return tolak(terkunci(m, sekarang));
            const orang = orangDariKode(isian.orang, isian.tanggal, m.peta);
            if (orang === TANPA_SALESMAN || !(m.kodeDikenal.has(isian.orang) || m.hasil.baris.some((b) => b.orang === orang))) {
                throw salah("orang", `Kode ${isian.orang} tidak dikenal (bukan pegawai Accurate dan belum punya setoran hari ini).`);
            }
            const baris = m.hasil.baris.find((b) => b.orang === orang) ?? { orang, setoranPerKode: [], setoran: null };
            const sekarangDasar = baris.setoranPerKode.map((x) => ({ kode: x.kode, revisi: x.revisi }));
            const sama = sekarangDasar.length === isian.dasar.length
                && sekarangDasar.every((x) => isian.dasar.some((d) => d.kode === x.kode && d.revisi === x.revisi));
            if (!sama) {
                throw new GalatKasir(409, "SETORAN_BERUBAH", "Setoran orang ini sudah berubah sejak halaman dimuat (klik ganda atau pengguna lain). Periksa revisi terbaru.", {
                    keadaan: { orang, dasar: sekarangDasar, setoranPerKode: baris.setoranPerKode.map((x) => ({ kode: x.kode, revisi: x.revisi, tunai: T(x.tunai),
                        transfer: T(x.transfer), giro: T(x.giro), total: T(x.total) })),
                    setoran: baris.setoran ? { tunai: T(baris.setoran.tunai), transfer: T(baris.setoran.transfer), giro: T(baris.setoran.giro),
                        total: T(baris.setoran.total) } : null } });
            }
            let bukti = isian.buktiBaru;
            if (isian.buktiLama) {
                const lama = m.setoran.filter((s) => s.salesmanKode === orang).at(-1);
                if (!lama?.buktiTransfer || lama.transfer !== isian.transfer) {
                    throw salah("buktiTransfer", "Bukti revisi sebelumnya hanya boleh dipakai bila revisi itu punya bukti dan nominal Transfer-nya sama. Unggah bukti baru.");
                }
                bukti = lama.buktiTransfer;
            }
            // Batas total hari SEBELUM INSERT: Σ setoran orang lain + kiriman ini ≤ BATAS_HARI_SEN (tinjauan A; pasangan pertahanan kedua muatDalam).
            const totalLain = m.hasil.total.setoran - (baris.setoran?.total ?? 0);
            if (totalLain + isian.tunai + isian.transfer + isian.giro > BATAS_HARI_SEN) {
                throw new GalatKasir(409, "NOMINAL_DI_LUAR_BATAS", `Total setoran tanggal ini akan melebihi batas aman ${rupiahSen(BATAS_HARI_SEN)}. Periksa nominal.`,
                    { keadaan: { batasHari: T(BATAS_HARI_SEN), totalHariLain: T(totalLain) } });
            }
            const rencana = rencanaSetoranOrang(baris, { tunai: isian.tunai, transfer: isian.transfer, giro: isian.giro });
            await deps.jeda("setoran:sebelum-insert");
            const sisip = await tx.insert(kasirSetoran).values(rencana.map((r) => {
                const utama = r.salesmanKode === orang;
                return { tanggal: isian.tanggal, salesmanKode: r.salesmanKode, revisi: r.revisi, revisiSebelumnya: r.revisiSebelumnya, tunai: T(r.tunai),
                    transfer: T(r.transfer), giro: T(r.giro), dicatatOleh: oleh, dicatatPada: sekarang,
                    ...(utama ? { noFormKasir: isian.noFormKasir, buktiTransfer: isian.transfer > 0 ? bukti : null, giroNomor: isian.giro > 0 ? isian.giroNomor : null,
                        giroJatuhTempo: isian.giro > 0 ? isian.giroJatuhTempo : null, catatan: isian.catatan }
                        : { catatan: `Dinolkan: setoran orang ${orang} dicatat di kode ${orang} (gabungan kode ${isian.tanggal.slice(0, 7)}).` }) };
            })).returning({ id: kasirSetoran.id, kode: kasirSetoran.salesmanKode, revisi: kasirSetoran.revisi, bukti: kasirSetoran.buktiTransfer });
            const utama = sisip.find((x) => x.kode === orang)!;
            return { orang, revisi: sisip.map((x) => ({ kode: x.kode, revisi: x.revisi })), buktiUrl: utama.bukti ? `/api/kasir/bukti?id=${Number(utama.id)}` : null };
        });
    } catch (e) {
        if (!(e instanceof GalatKasir) && kodePg(e) === "23505") {
            throw new GalatKasir(409, "SETORAN_BERUBAH", "Setoran orang ini baru saja dicatat pengguna lain. Muat ulang dan periksa revisi terbaru.", { keadaan: null });
        }
        throw e;
    }
}

/**
 * Jelaskan selisih orang / uang tak teralokasi. TIDAK mensyaratkan status baca `lengkap` (orkestrator 12 Okt): angka dihitung ulang dari
 * cache SEKARANG dan harus sama dengan angka klien; penjelasan berkunci angka (berubah = tak berlaku). Identik dengan penjelasan terakhir
 * yang berlaku -> sudahAda (klik ganda tanpa baris kedua).
 */
export async function jelaskan(isian: IsianJelaskan, oleh: string, deps: DepsHari = bawaanHari): Promise<{ id: number } | { sudahAda: true }> {
    const databaseId = (await deps.databaseId()).trim();
    if (!databaseId) throw new GalatKasir(503, "SESI_SINKRON", PESAN_SESI_SINKRON);
    return transaksiHari(deps, isian.tanggal, async (tx) => {
        const sekarang = deps.sekarang();
        const m = await muatDalam(tx, isian.tanggal, databaseId);
        await pastikanKunci(tx, m, sekarang);
        if (!bolehDiubah(isian.tanggal, m.events, sekarang)) return tolak(terkunci(m, sekarang));
        if (isian.jenis === "selisih") {
            const orang = isian.orang ? orangDariKode(isian.orang, isian.tanggal, m.peta) : TANPA_SALESMAN;
            const b = m.hasil.baris.find((x) => x.orang === orang);
            if (!b || b.status === "klop") {
                throw new GalatKasir(409, "TIDAK_PERLU_DIJELASKAN", "Baris ini sudah klop / tidak ada lagi — tidak perlu dijelaskan.", { keadaan: { status: b?.status ?? null } });
            }
            const setoran = b.setoran?.total ?? 0;
            if (b.pelunasan !== isian.pelunasan || setoran !== isian.setoran) {
                throw new GalatKasir(409, "ANGKA_BERUBAH", "Angka pelunasan/setoran sudah berubah sejak halaman dimuat. Periksa angka terbaru lalu jelaskan lagi.", {
                    keadaan: { angka: { pelunasan: T(b.pelunasan), setoran: T(setoran) }, status: b.status } });
            }
            const akhir = m.catatan.filter((c) => orangDariKode(c.salesmanKode, isian.tanggal, m.peta) === orang && c.pelunasan === b.pelunasan
                && c.setoran === setoran).at(-1);
            if (akhir && akhir.penjelasan.trim() === isian.penjelasan && akhir.tindakLanjut === isian.tindakLanjut) return { sudahAda: true as const };
            await deps.jeda("jelaskan:sebelum-insert");
            const [r] = await tx.insert(kasirSelisihCatatan).values({ tanggal: isian.tanggal, salesmanKode: orang, pelunasan: T(b.pelunasan), setoran: T(setoran),
                penjelasan: isian.penjelasan, tindakLanjut: isian.tindakLanjut, dicatatOleh: oleh, dicatatPada: sekarang }).returning({ id: kasirSelisihCatatan.id });
            return { id: Number(r.id) };
        }
        const embers = m.hasil.takTeralokasi.filter((t) => t.pelunasanId === isian.pelunasanId);
        if (!embers.length) throw new GalatKasir(409, "TIDAK_PERLU_DIJELASKAN", "Uang tak teralokasi pelunasan ini sudah tidak ada — tidak perlu dijelaskan.", { keadaan: null });
        if (!embers.some((t) => t.sisa === isian.sisa)) {
            throw new GalatKasir(409, "ANGKA_BERUBAH", "Sisa tak teralokasi sudah berubah sejak halaman dimuat. Periksa angka terbaru lalu jelaskan lagi.", {
                keadaan: { angka: { sisa: embers.map((t) => T(t.sisa)) } } });
        }
        const akhir = m.catatanTak.filter((c) => c.pelunasanId === isian.pelunasanId && c.sisa === isian.sisa).at(-1);
        if (akhir && akhir.penjelasan.trim() === isian.penjelasan) return { sudahAda: true as const };
        await deps.jeda("jelaskan:sebelum-insert");
        const [r] = await tx.insert(kasirTakTeralokasiCatatan).values({ tanggal: isian.tanggal, databaseId, pelunasanId: isian.pelunasanId, sisa: T(isian.sisa),
            penjelasan: isian.penjelasan, dicatatOleh: oleh, dicatatPada: sekarang }).returning({ id: kasirTakTeralokasiCatatan.id });
        return { id: Number(r.id) };
    });
}

/**
 * Tutup hari (Kasir). Status baca dibaca `FOR SHARE` (klaim pembaca K1b menunggu transaksi ini) dan HARUS `lengkap` ∧ `lengkap_pada`
 * ≤ 15 mnt (segarUntukTutup); penghalangTutup kosong; sidik klien = sidik server. Snapshot = snapshotHari + baca (CHECK
 * kasir_hari_event_tutup_tuntas = jaring kedua). Event terakhir `tutup` -> sudahDitutup (klik ganda).
 */
export async function tutupHari(isian: { tanggal: string; sidik: string }, oleh: string, deps: DepsHari = bawaanHari) {
    const databaseId = (await deps.databaseId()).trim();
    try {
        return await transaksiHari(deps, isian.tanggal, async (tx) => {
            const sekarang = deps.sekarang();
            if (databaseId) {
                await tx.execute(sql`SELECT 1 FROM kasir_pelunasan_baca WHERE database_id = ${databaseId} AND tanggal = ${isian.tanggal}::date FOR SHARE`);
            }
            const m = await muatDalam(tx, isian.tanggal, databaseId);
            await pastikanKunci(tx, m, sekarang);
            const akhir = m.events.at(-1);
            if (akhir?.jenis === "tutup") return { sudahDitutup: true as const, event: { id: akhir.id, pada: iso(akhir.pada) } };
            if (statusHari(isian.tanggal, m.events, sekarang).terkunci) return tolak(terkunci(m, sekarang));
            if (!databaseId || m.baca === null) throw new GalatKasir(503, "SESI_SINKRON", PESAN_SESI_SINKRON);
            if (!segarUntukTutup(m.baca, sekarang)) {
                throw new GalatKasir(409, "BACA_BELUM_SEGAR", m.baca.status === "lengkap"
                    ? "Pelunasan Incaso terakhir dibaca lebih dari 15 menit lalu — segarkan dulu sebelum menutup hari."
                    : m.baca.status === "gagal" && m.baca.ditolak.length
                        ? "Ada pelunasan yang ditolak pembaca — perbaiki di Accurate; hari tidak bisa ditutup sampai terbaca lengkap."
                        : "Pelunasan Incaso belum terbaca lengkap — segarkan dulu sebelum menutup hari.",
                    { keadaan: { baca: await publikkan(m.baca, { nama: deps.nama }), segarUntukTutup: false } });
            }
            await deps.jeda("tutup:sesudah-baca");
            const p = penghalangTutup(m.hasil);
            if (!p.bisaDitutup) throw new GalatKasir(409, "TERHALANG", "Hari belum bisa ditutup — jelaskan dulu yang tersisa.", { alasan: p.alasan });
            const sidik = sidikHari(m.hasil);
            if (sidik !== isian.sidik) {
                throw new GalatKasir(409, "ANGKA_BERUBAH", "Angka hari ini berubah sejak halaman dimuat. Periksa angka terbaru lalu tutup lagi.", { keadaan: { sidik } });
            }
            const ev = await sisipEvent(tx, m, { jenis: "tutup", snapshot: snapshotTersimpan(m), oleh }, sekarang);
            return { event: { id: ev.id, pada: iso(ev.pada) } };
        });
    } catch (e) {
        if (!(e instanceof GalatKasir) && kodePg(e) === "23514" && kendalaPg(e) === "kasir_hari_event_tutup_tuntas") {
            throw new GalatKasir(409, "TERHALANG", "Hari belum bisa ditutup — masih ada yang belum dijelaskan.", { alasan: [] });
        }
        throw e;
    }
}

/** Buka kembali hari terkunci (OM/Admin, kasir.buka) beralasan ≥ 15 -> terbuka sampai 20.00 WITA berikutnya (T1). */
export async function bukaHari(isian: { tanggal: string; alasan: string }, oleh: string, deps: DepsHari = bawaanHari) {
    const databaseId = (await deps.databaseId().catch(() => "")).trim();
    return transaksiHari(deps, isian.tanggal, async (tx) => {
        const sekarang = deps.sekarang();
        const m = await muatDalam(tx, isian.tanggal, databaseId);
        await pastikanKunci(tx, m, sekarang);
        if (!statusHari(isian.tanggal, m.events, sekarang).terkunci) {
            throw new GalatKasir(409, "TIDAK_TERKUNCI", "Hari ini sedang terbuka — tidak perlu dibuka kembali.", keadaanHari(m, sekarang));
        }
        await sisipEvent(tx, m, { jenis: "buka", alasan: isian.alasan, oleh }, sekarang);
        return { kunciBerikutnya: iso(statusHari(isian.tanggal, m.events, sekarang).kunciBerikutnya) };
    });
}

/** Baris bukti untuk unduhan (nama berkas dari DB, bukan dari pengguna). */
export async function cariBukti(id: number, deps: Pick<DepsHari, "db"> = bawaanHari) {
    const [r] = await deps.db.select({ bukti: kasirSetoran.buktiTransfer, tanggal: kasirSetoran.tanggal, kode: kasirSetoran.salesmanKode,
        revisi: kasirSetoran.revisi }).from(kasirSetoran).where(eq(kasirSetoran.id, id)).limit(1);
    return r ?? null;
}
