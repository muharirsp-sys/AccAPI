/*
 * Tujuan: Pelaksana server pembaca pelunasan Accurate Kasir ↔ Incaso (K1b, BL-59): kredensial SINKRON -> lease baris status
 *   kasir_pelunasan_baca -> list.do berurutan (fail-closed) -> detail.do HANYA untuk id baru / lastUpdate beda (≤ 4 pekerja, turun ke 2
 *   sesudah 429) -> cache kasir_pelunasan(+_faktur) per pelunasan SATU transaksi -> hapus yang hilang (daftar lengkap saja) -> status
 *   akhir lengkap/sebagian/gagal. Pembaca cache untuk K2/K3: muatPelunasanHari, statusBaca, databaseIdSinkron.
 * Caller: app/api/kasir/segarkan (POST/GET), app/api/cron/kasir-pelunasan; K2 (GET /api/kasir), K3 (Beranda) membaca cache saja.
 * Dependensi: lib/kasir/pembaca (murni), lib/kasir/rekonsiliasi (keSen/senKeTeks, tipe Pelunasan), lib/accurate-session
 *   (resolveSyncCredentials, pickSyncUserId — berkas itu TIDAK diubah), lib/sync (accurateHeaders), lib/db, db/schema.
 * Main Functions: bacaPelunasanHari, tokoPg, muatPelunasanHari, statusBaca, databaseIdSinkron, jawabanSegarkan.
 * Side Effects: GET Accurate sales-receipt/list.do + detail.do (BACA-SAJA, identitas sinkron); tulis kasir_pelunasan,
 *   kasir_pelunasan_faktur, kasir_pelunasan_baca. TIDAK pernah menulis ke Accurate dan tidak menyimpan raw_data.
 *
 * Aturan (KASIR-KONTRAK §4 + brief K1b): nominal Accurate > 2 desimal dibulatkan ke sen di pembaca (15 Okt; rusak = pelunasan DITOLAK, terlihat di status, tidak dilewati diam-diam);
 * 401/403 = BERHENTI seketika tanpa ulang; galat TIDAK pernah menghapus cache atau memundurkan lengkap_pada; `last_update` yang disimpan
 * = nilai list.do yang dibaca SEBELUM detail (berubah di antaranya -> putaran berikut membaca ulang: boleh lebih, tak pernah terlewat).
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "@/lib/db";
import { accurateOAuthSession, kasirPelunasan, kasirPelunasanFaktur, user } from "@/db/schema";
import { pickSyncUserId, resolveSyncCredentials } from "@/lib/accurate-session";
import { accurateHeaders, type AccurateCredentials } from "@/lib/sync";
import {
    bacaDaftar, bacaRetryAfter, GalatBaca, hapusMassal, kelasGalat, kueriDaftar, PESAN_SESI_SINKRON, rencanaBaca, statusAkhir, tanggalSah, tundaUlang,
    uraiDetail, type BarisDaftar, type Ditolak, type Jawaban, type KelasGalat, type StatusAkhir,
} from "./pembaca.ts";
import { keSen, senKeTeks, type Pelunasan } from "./rekonsiliasi.ts";

/** Lease 2 menit (> batasMs 45 dtk + satu panggilan 20 dtk + jeda ulang) menurut jam DB — lintas instance. */
export const LEASE_DETIK = 120;
/** Hasil `lengkap` < 60 dtk lalu dan bukan `penuh` -> status dikembalikan tanpa Accurate. */
export const JEDA_LENGKAP_DETIK = 60;
const PER_PANGGILAN_MS = 20_000;
const JEDA_HALAMAN_MS = 150; // lib/sync.ts:77

export type StatusBaca = {
    databaseId: string;
    tanggal: string;
    status: "berjalan" | "lengkap" | "sebagian" | "gagal" | "belum_dibaca";
    /** Lease masih berlaku (status berjalan & dimulai < LEASE_DETIK lalu). berjalan + !aktif = pembaca terhenti (lease kedaluwarsa). */
    aktif: boolean;
    sebab: KelasGalat | null;
    pesan: string | null;
    jumlahDaftar: number | null;
    sisaDetail: number | null;
    ditolak: Ditolak[];
    mulaiPada: string | null;
    selesaiPada: string | null;
    lengkapPada: string | null;
    /** "cron" | "manual:<user.id>" — INTERNAL; ke klien lewat publikkan() (tanpa id user). */
    pemicu: string | null;
    /** user.id akun Accurate sinkron yang cache-nya TERAKHIR DITERAPKAN — INTERNAL; ke klien sebagai NAMA lewat publikkan(). Tidak ditimpa saat
     * klaim, dan tetap akun lama selama penjaga ganti-akun menahan hapus (sampai OM/Admin mengonfirmasi). */
    akunSinkron: string | null;
    /** Baca penuh cron yang menyerah menunggu lease (PENUH_TERTUNDA); klaim berikutnya menjalankan baca penuh lalu mengosongkannya. */
    penuhTertundaPada: string | null;
};

/** Status untuk klien: tanpa id user mentah (akun & pemicu sebagai nama). */
export type StatusPublik = Omit<StatusBaca, "akunSinkron" | "pemicu"> & { akun: string | null; pemicu: string | null; pemicuOleh: string | null };

/** Penyimpanan cache + status (PG = tokoPg; uji tanpa DB memakai tiruan dengan aturan lease/token yang sama). */
export interface TokoBaca {
    /** Lease: sukses bila tak ada pembaca aktif dan (penuh ATAU bukan `lengkap` < JEDA_LENGKAP_DETIK lalu). */
    klaim(a: { databaseId: string; tanggal: string; token: string; pemicu: string; penuh: boolean; akun: string | null }):
        Promise<{ diklaim: true; akunLama: string | null; penuhTertunda: boolean } | { diklaim: false; status: StatusBaca }>;
    /** Catat baca penuh yang tertunda (tanpa menyentuh lease/token pemegang). */
    tandaiPenuhTertunda(databaseId: string, tanggal: string): Promise<void>;
    /** Tanggal ≥ `sejak` yang masih bertanda baca penuh tertunda (cron ikut membacanya). */
    tanggalTertunda(databaseId: string, sejak: string): Promise<string[]>;
    status(databaseId: string, tanggal: string): Promise<StatusBaca>;
    /** id -> last_update cache pelunasan bertanggal itu. */
    cache(databaseId: string, tanggal: string): Promise<Map<number, string | null>>;
    /** Baca penuh: last_update tanggal itu = NULL (isi tetap; setiap id dibaca ulang sampai cocok). false = token basi. */
    tandaiBasi(token: string, databaseId: string, tanggal: string): Promise<boolean>;
    /** Upsert kepala + ganti baris faktur, satu transaksi, token dicek. false = token basi (tidak ditulis). */
    tulis(token: string, databaseId: string, p: Pelunasan, lastUpdate: string): Promise<boolean>;
    hapus(token: string, databaseId: string, tanggal: string, ids: number[]): Promise<boolean>;
    /** id -> nomor pelunasan di cache (rincian penjaga hapus massal). */
    nomor(databaseId: string, ids: number[]): Promise<Map<number, string>>;
    /** Simpan status akhir (+ akun sinkron yang cache-nya diterapkan) bila token masih pemilik; null = token basi. lengkap_pada hanya maju. */
    selesai(token: string, databaseId: string, tanggal: string, akhir: StatusAkhir, ditolak: Ditolak[], akun: string | null): Promise<StatusBaca | null>;
}

type Kredensial = Awaited<ReturnType<typeof resolveSyncCredentials>>;
/** Identitas sinkron TANPA Accurate: user.id + databaseId dari baris sesi (lihat sesiSinkron). */
export type SesiSinkron = { userId: string; databaseId: string };

export interface DepsBaca {
    kredensial: () => Promise<Kredensial>;
    sesi: () => Promise<SesiSinkron>;
    /** user.id -> nama (tampilan status). */
    nama: (ids: string[]) => Promise<Map<string, string>>;
    toko: () => TokoBaca;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    tidur: (ms: number) => Promise<void>;
    sekarang: () => number;
    token: () => string;
}

/** Dependensi produksi. Uji route mengganti propertinya (dan memulihkannya) — jaringan nyata dilarang di uji. */
export const bawaan: DepsBaca = {
    kredensial: () => resolveSyncCredentials(),
    sesi: () => sesiSinkron(),
    nama: async (ids) => new Map((await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))).map((r) => [r.id, r.name])),
    toko: () => tokoPg(db),
    fetch: (url, init) => fetch(url, init),
    tidur: (ms) => new Promise((r) => setTimeout(r, ms)),
    sekarang: () => Date.now(),
    token: () => randomUUID(),
};

export interface OpsiBaca {
    tanggal: string;
    /** "cron" | "manual:<userId>" — dicatat di baris status. */
    pemicu: string;
    /** Baca ulang SEMUA detail (salesman faktur yang disunting tak mengubah lastUpdate pelunasan). */
    penuh?: boolean;
    /** Lewati penjaga hapus massal (route: hanya pemegang kasir.buka = OM/Admin). */
    konfirmasiHapus?: boolean;
    batasMs?: number;
    konkurensi?: number;
}

export type HasilBaca =
    | { jenis: "kredensial"; pesan: string; status?: StatusBaca }
    | { jenis: "sedang_dibaca" | "jeda_lengkap" | "lease_hilang" | "selesai"; status: StatusBaca };

type HasilAmbil = { ok: true; body: Record<string, unknown> } | { ok: false; kelas: KelasGalat | "waktu_habis"; pesan: string };
/** izin = panggilan Accurate serentak yang boleh (turun ke 2 sesudah 429); slot dipegang SELAMA fetch saja (bukan saat jeda ulang). */
type Kendali = { izin: number; henti: boolean; aktif: number; antre: (() => void)[] };
async function masuk(k: Kendali) {
    while (k.aktif >= k.izin) await new Promise<void>((r) => k.antre.push(r));
    k.aktif++;
}
function keluar(k: Kendali) {
    k.aktif--;
    k.antre.shift()?.();
}
class WaktuHabis extends Error {}

/** Satu GET Accurate + ulang menurut kelas (429/5xx/jaringan ≤ 3×, tidak_pasti 1×, 401/403/ditolak tidak). Tenggat dicek SEBELUM tiap panggilan. */
async function ambilAccurate(deps: DepsBaca, creds: AccurateCredentials, path: string, query: Record<string, string>, tenggat: number,
    kendali: Kendali, rahasia: string[]): Promise<HasilAmbil> {
    // Koma literal: Accurate tidak membaca %2C (lib/accurate-forward.ts).
    const url = `${creds.sessionHost}/accurate/api${path}?${new URLSearchParams(query).toString().replace(/%2C/g, ",")}`;
    for (let gagal = 0; ;) {
        if (kendali.henti || deps.sekarang() >= tenggat) return { ok: false, kelas: "waktu_habis", pesan: "batas waktu / dihentikan" };
        let j: Jawaban;
        let retryAfter: number | null = null;
        await masuk(kendali);
        try {
            if (kendali.henti || deps.sekarang() >= tenggat) return { ok: false, kelas: "waktu_habis", pesan: "batas waktu / dihentikan" };
            const res = await deps.fetch(url, { method: "GET", headers: accurateHeaders(creds), redirect: "manual", signal: AbortSignal.timeout(PER_PANGGILAN_MS) });
            retryAfter = bacaRetryAfter(res.headers.get("retry-after"), deps.sekarang());
            j = { status: res.status, teks: await res.text() };
        } catch (e) {
            j = { galat: e };
        } finally {
            keluar(kendali);
        }
        const n = kelasGalat(j, rahasia);
        if (n.kelas === null) return { ok: true, body: n.body };
        if (n.kelas === "batas_laju") kendali.izin = Math.min(kendali.izin, 2); // 429: konkurensi 2 sampai akhir putaran
        const tunda = tundaUlang(n.kelas, ++gagal, retryAfter);
        if (tunda === null) return { ok: false, kelas: n.kelas, pesan: n.pesan };
        if (deps.sekarang() + tunda >= tenggat) return { ok: false, kelas: "waktu_habis", pesan: n.pesan };
        await deps.tidur(tunda);
    }
}

/**
 * Satu putaran baca pelunasan bertanggal `tanggal` (YYYY-MM-DD) dari database sesi SINKRON. Hasil `selesai` = status tersimpan
 * (lengkap / sebagian / gagal); `kredensial` = sesi sinkron tak bisa dipakai — bila databaseId sesi masih diketahui, status tanggal itu
 * DITULIS gagal/sesi_sinkron (lease dihormati; lengkap_pada tidak dimundurkan) agar `lengkap` lama tidak tetap tampil;
 * `sedang_dibaca` = lease dipegang pembaca lain; `jeda_lengkap` = lengkap < 60 dtk lalu (tanpa Accurate); `lease_hilang` = lease direbut
 * pembaca lain karena putaran ini melewati LEASE_DETIK (tulisan berikutnya ditolak token).
 */
export async function bacaPelunasanHari(opsi: OpsiBaca, deps: DepsBaca = bawaan): Promise<HasilBaca> {
    const { tanggal, pemicu } = opsi;
    if (!tanggalSah(tanggal)) throw new Error(`Format tanggal salah: ${tanggal} (YYYY-MM-DD)`);
    const penuh = Boolean(opsi.penuh);
    const tenggat = deps.sekarang() + (opsi.batasMs ?? 45_000);
    const sesi = await deps.sesi().catch((): SesiSinkron => ({ userId: "", databaseId: "" }));
    const akun = sesi.userId.trim() || null;
    const k = await deps.kredensial();
    const databaseId = String(k.creds?.databaseId ?? "").trim();
    if (!k.creds || !databaseId) {
        const pesan = k.error ?? "Sesi Accurate akun sinkron tanpa database terpilih.";
        const dbSesi = sesi.databaseId.trim();
        if (!dbSesi) return { jenis: "kredensial", pesan };
        // Sesi mati tetapi database diketahui: `lengkap` lama TIDAK boleh tetap tampil -> gagal/sesi_sinkron (penuh: abaikan jeda lengkap,
        // lease tetap dihormati). lengkap_pada tetap (riwayat), cache tidak disentuh.
        const t = deps.toko();
        const tk = deps.token();
        const kl = await t.klaim({ databaseId: dbSesi, tanggal, token: tk, pemicu, penuh: true, akun });
        if (!kl.diklaim) return { jenis: "kredensial", pesan, status: kl.status };
        const st = await t.selesai(tk, dbSesi, tanggal, { status: "gagal", sebab: "sesi_sinkron", pesan: PESAN_SESI_SINKRON, jumlahDaftar: null, sisaDetail: null },
            [], kl.akunLama);
        return { jenis: "kredensial", pesan, ...(st ? { status: st } : {}) };
    }
    const creds = k.creds;
    const toko = deps.toko();
    const token = deps.token();
    const klaim = await toko.klaim({ databaseId, tanggal, token, pemicu, penuh, akun });
    if (!klaim.diklaim) return { jenis: klaim.status.status === "lengkap" ? "jeda_lengkap" : "sedang_dibaca", status: klaim.status };
    // Baca penuh yang tertunda (cron 19.30 menyerah menunggu lease) dijalankan oleh klaim berikutnya, siapa pun pemicunya.
    const penuhEfektif = penuh || klaim.penuhTertunda;
    // Akun sinkron berganti sejak cache terakhir diterapkan: cabang yang terlihat bisa berbeda -> hapus apa pun ditahan (penjaga murah).
    const akunGanti = Boolean(klaim.akunLama && akun && klaim.akunLama !== akun);
    let akunSimpan = akun ?? klaim.akunLama;

    const rahasia = [creds.apiKey, creds.sessionId];
    const kendali: Kendali = { izin: Math.max(1, Math.min(opsi.konkurensi ?? 4, 4)), henti: false, aktif: 0, antre: [] };
    const ambil = (path: string, query: Record<string, string>) => ambilAccurate(deps, creds, path, query, tenggat, kendali, rahasia);
    const st: { galat: { kelas: KelasGalat; pesan: string } | null; daftar: BarisDaftar[] | null; ditolak: Ditolak[]; leaseHilang: boolean } =
        { galat: null, daftar: null, ditolak: [], leaseHilang: false };
    try {
        // 0. Baca penuh: tandai basi SEGERA sesudah klaim, SEBELUM list.do — putaran yang kehabisan waktu di tengah daftar tetap meninggalkan
        //    last_update NULL, jadi lanjutan (bukan penuh) membaca ulang semuanya (probe P1d: suntingan salesman tanpa lastUpdate).
        if (penuhEfektif && !(await toko.tandaiBasi(token, databaseId, tanggal))) return { jenis: "lease_hilang", status: await toko.status(databaseId, tanggal) };
        // 1. Daftar lengkap, berurutan (jeda 150 ms antarpanggilan).
        let pertama = true;
        try {
            st.daftar = await bacaDaftar(tanggal, async (h) => {
                if (!pertama) await deps.tidur(JEDA_HALAMAN_MS);
                pertama = false;
                const j = await ambil("/sales-receipt/list.do", kueriDaftar(tanggal, h));
                if (j.ok) return j.body;
                throw j.kelas === "waktu_habis" ? new WaktuHabis() : new GalatBaca(j.kelas, `list.do halaman ${h}: ${j.pesan}`);
            }, rahasia);
        } catch (e) {
            if (e instanceof GalatBaca) st.galat = { kelas: e.kelas, pesan: e.message };
            else if (!(e instanceof WaktuHabis)) throw e;
        }

        const daftar = st.daftar;
        if (daftar) {
            // 2. Rencana per id. 3. Hapus yang hilang — daftar di sini selalu LENGKAP (terpotong = galat di atas).
            const cache = await toko.cache(databaseId, tanggal);
            const rencana = rencanaBaca(cache, { baris: daftar, lengkap: true }, penuhEfektif);
            if (!st.leaseHilang && rencana.hapus.length) {
                if (!opsi.konfirmasiHapus && (hapusMassal(rencana.hapus.length, cache.size) || akunGanti)) {
                    // Akun sinkron yang hanya melihat sebagian cabang "menghilangkan" pelunasan cabang lain: jangan hapus diam-diam.
                    const nomor = await toko.nomor(databaseId, rencana.hapus);
                    if (akunGanti) akunSimpan = klaim.akunLama; // penjaga bertahan sampai dikonfirmasi
                    st.galat = { kelas: "hapus_massal", pesan: `${rencana.hapus.length} dari ${cache.size} pelunasan tanggal ini hilang dari daftar Accurate`
                        + `${akunGanti ? " sesudah akun Accurate sinkron berganti" : ""} — tidak dihapus. Periksa cabang yang terlihat akun sinkron; OM/Admin dapat `
                        + "mengonfirmasi hapus." };
                    st.ditolak.push(...rencana.hapus.map((id) => ({ id, nomor: nomor.get(id) ?? `id ${id}`, sebab: "hapus_massal" as const,
                        pesan: "hilang dari daftar Accurate; menunggu konfirmasi hapus" })));
                } else if (!(await toko.hapus(token, databaseId, tanggal, rencana.hapus))) st.leaseHilang = true;
            }

            // 5. Detail: ≤ izin pekerja; tenggat dicek sebelum tiap panggilan; 401/403/transport habis-ulang = henti semua pekerja.
            let i = 0;
            const pekerja = async (ke: number) => {
                while (ke < kendali.izin && !kendali.henti && !st.leaseHilang && i < rencana.baca.length) {
                    if (deps.sekarang() >= tenggat) return;
                    const b = rencana.baca[i++];
                    const j = await ambil("/sales-receipt/detail.do", { id: String(b.id) });
                    if (kendali.henti || st.leaseHilang) return; // berhenti seketika: jawaban terlambat tidak ditulis
                    if (!j.ok) {
                        if (j.kelas === "waktu_habis") return;
                        if (j.kelas === "ditolak") {
                            st.ditolak.push({ id: b.id, nomor: b.nomor, sebab: "ditolak", pesan: j.pesan });
                            continue;
                        }
                        kendali.henti = true;
                        st.galat = { kelas: j.kelas, pesan: `detail ${b.nomor}: ${j.pesan}` };
                        return;
                    }
                    const u = uraiDetail(j.body.d, tanggal, b);
                    if (!u.ok) {
                        if (u.sebab !== "berubah") st.ditolak.push({ id: b.id, nomor: b.nomor, sebab: u.sebab, pesan: u.pesan });
                        continue; // berubah (transDate pindah) = tidak ditulis -> sisa -> sebagian
                    }
                    if (!(await toko.tulis(token, databaseId, u.pelunasan, b.lastUpdate))) st.leaseHilang = true;
                }
            };
            await Promise.all(Array.from({ length: Math.min(kendali.izin, rencana.baca.length) }, (_, ke) => pekerja(ke)));
        }

        if (st.leaseHilang) return { jenis: "lease_hilang", status: await toko.status(databaseId, tanggal) };
        // akun_sinkron = akun yang cache-nya DITERAPKAN dari daftar LENGKAP: putaran yang gagal sebelum langkah hapus (daftar null: 5xx/401/
        // terpotong/waktu habis) tidak boleh "menerima" akun baru — kalau tidak, putaran berikut menghapus diam-diam (probe P6a).
        if (!daftar) akunSimpan = klaim.akunLama;
        const akhir = statusAkhir({ galat: st.galat, daftar, cacheAkhir: daftar ? await toko.cache(databaseId, tanggal) : new Map(), ditolak: st.ditolak });
        const tersimpan = await toko.selesai(token, databaseId, tanggal, akhir, st.ditolak, akunSimpan);
        return tersimpan ? { jenis: "selesai", status: tersimpan } : { jenis: "lease_hilang", status: await toko.status(databaseId, tanggal) };
    } catch (e) {
        // Galat tak terduga (DB / bug): status gagal bila lease masih milik kita (cache tidak disentuh), lalu dilempar (route 500).
        const pesan = `galat internal pembaca: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
        await toko.selesai(token, databaseId, tanggal, { status: "gagal", sebab: "tidak_pasti", pesan, jumlahDaftar: null, sisaDetail: null }, st.ditolak,
            klaim.akunLama).catch(() => null);
        throw e;
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Penyimpanan Postgres
// ---------------------------------------------------------------------------------------------------------------------

type Db = NodePgDatabase<Record<string, unknown>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const LEASE = sql.raw(`interval '${LEASE_DETIK} seconds'`);
const JEDA_LENGKAP = sql.raw(`interval '${JEDA_LENGKAP_DETIK} seconds'`);
/** Waktu keluar sebagai ISO UTC (`…Z`) — driver Drizzle mengembalikan timestamptz mentah sebagai teks PG. */
const isoPg = (kolom: string) => sql.raw(`to_char(${kolom} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${kolom}`);
const KOLOM_STATUS = sql`database_id, tanggal::text AS tanggal, status, sebab, pesan, jumlah_daftar, sisa_detail, ditolak, ${isoPg("mulai_pada")},
    ${isoPg("selesai_pada")}, ${isoPg("lengkap_pada")}, pemicu, akun_sinkron, ${isoPg("penuh_tertunda_pada")},
    (status = 'berjalan' AND mulai_pada > now() - ${LEASE}) AS aktif`;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const angkaAtauNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function keStatus(r: Record<string, unknown>): StatusBaca {
    return {
        databaseId: String(r.database_id), tanggal: String(r.tanggal), status: r.status as StatusBaca["status"], aktif: r.aktif === true,
        sebab: (r.sebab ?? null) as KelasGalat | null, pesan: (r.pesan ?? null) as string | null,
        jumlahDaftar: angkaAtauNull(r.jumlah_daftar), sisaDetail: angkaAtauNull(r.sisa_detail), ditolak: Array.isArray(r.ditolak) ? r.ditolak as Ditolak[] : [],
        mulaiPada: iso(r.mulai_pada), selesaiPada: iso(r.selesai_pada), lengkapPada: iso(r.lengkap_pada), pemicu: (r.pemicu ?? null) as string | null,
        akunSinkron: (r.akun_sinkron ?? null) as string | null, penuhTertundaPada: iso(r.penuh_tertunda_pada),
    };
}

export const belumDibaca = (databaseId: string, tanggal: string): StatusBaca => ({
    databaseId, tanggal, status: "belum_dibaca", aktif: false, sebab: null, pesan: null, jumlahDaftar: null, sisaDetail: null, ditolak: [],
    mulaiPada: null, selesaiPada: null, lengkapPada: null, pemicu: null, akunSinkron: null, penuhTertundaPada: null,
});

async function bacaStatus(d: Db | Tx, databaseId: string, tanggal: string): Promise<StatusBaca> {
    const r = await d.execute(sql`SELECT ${KOLOM_STATUS} FROM kasir_pelunasan_baca WHERE database_id = ${databaseId} AND tanggal = ${tanggal}::date`);
    return r.rows[0] ? keStatus(r.rows[0]) : belumDibaca(databaseId, tanggal);
}

/** Token masih pemilik lease? FOR SHARE: pengklaim baru (UPDATE) menunggu tulisan ini selesai; tulisan sesudah klaim baru ditolak. */
async function leaseSah(tx: Tx, token: string, databaseId: string, tanggal: string) {
    const r = await tx.execute(sql`SELECT 1 FROM kasir_pelunasan_baca WHERE database_id = ${databaseId} AND tanggal = ${tanggal}::date
        AND token = ${token} AND status = 'berjalan' FOR SHARE`);
    return (r.rowCount ?? 0) > 0;
}

const diKepala = (databaseId: string, tanggal: string): SQL =>
    and(eq(kasirPelunasan.databaseId, databaseId), eq(kasirPelunasan.tanggal, tanggal)) as SQL;

export function tokoPg(d: Db): TokoBaca {
    return {
        async klaim({ databaseId, tanggal, token, pemicu, penuh, akun }) {
            const r = await d.execute(sql`
                INSERT INTO kasir_pelunasan_baca AS b (database_id, tanggal, status, token, mulai_pada, pemicu, akun_sinkron)
                VALUES (${databaseId}, ${tanggal}::date, 'berjalan', ${token}, now(), ${pemicu}, ${akun})
                ON CONFLICT (database_id, tanggal) DO UPDATE SET status = 'berjalan', token = EXCLUDED.token, mulai_pada = now(),
                    pemicu = EXCLUDED.pemicu, sebab = NULL, pesan = NULL, selesai_pada = NULL
                WHERE NOT (b.status = 'berjalan' AND b.mulai_pada > now() - ${LEASE})
                  AND (${penuh}::boolean OR b.penuh_tertunda_pada IS NOT NULL OR NOT (b.status = 'lengkap' AND b.selesai_pada > now() - ${JEDA_LENGKAP}))
                RETURNING b.akun_sinkron AS akun_lama, b.penuh_tertunda_pada IS NOT NULL AS penuh_tertunda`);
            // akun_sinkron TIDAK diubah klaim (hanya diisi saat baris baru) -> RETURNING = akun yang cache-nya terakhir diterapkan.
            const baris = r.rows[0];
            return baris ? { diklaim: true, akunLama: (baris.akun_lama ?? null) as string | null, penuhTertunda: baris.penuh_tertunda === true }
                : { diklaim: false, status: await bacaStatus(d, databaseId, tanggal) };
        },
        async tanggalTertunda(databaseId, sejak) {
            const r = await d.execute(sql`SELECT tanggal::text AS tanggal FROM kasir_pelunasan_baca WHERE database_id = ${databaseId}
                AND penuh_tertunda_pada IS NOT NULL AND tanggal >= ${sejak}::date ORDER BY tanggal`);
            return r.rows.map((x) => String(x.tanggal));
        },
        async tandaiPenuhTertunda(databaseId, tanggal) {
            await d.execute(sql`UPDATE kasir_pelunasan_baca SET penuh_tertunda_pada = coalesce(penuh_tertunda_pada, now())
                WHERE database_id = ${databaseId} AND tanggal = ${tanggal}::date`);
        },
        status: (databaseId, tanggal) => bacaStatus(d, databaseId, tanggal),
        async cache(databaseId, tanggal) {
            const rows = await d.select({ id: kasirPelunasan.pelunasanId, lastUpdate: kasirPelunasan.lastUpdate }).from(kasirPelunasan)
                .where(diKepala(databaseId, tanggal));
            return new Map(rows.map((r) => [Number(r.id), r.lastUpdate]));
        },
        tandaiBasi: (token, databaseId, tanggal) => d.transaction(async (tx) => {
            if (!(await leaseSah(tx, token, databaseId, tanggal))) return false;
            await tx.update(kasirPelunasan).set({ lastUpdate: null }).where(diKepala(databaseId, tanggal));
            await tx.execute(sql`UPDATE kasir_pelunasan_baca SET penuh_tertunda_pada = NULL WHERE database_id = ${databaseId} AND tanggal = ${tanggal}::date`);
            return true;
        }),
        tulis: (token, databaseId, p, lastUpdate) => d.transaction(async (tx) => {
            if (!(await leaseSah(tx, token, databaseId, p.tanggal))) return false;
            const kepala = { nomor: p.nomor, tanggal: p.tanggal, metode: p.metode, chequeAmount: senKeTeks(p.chequeAmount), lastUpdate };
            await tx.insert(kasirPelunasan).values({ databaseId, pelunasanId: p.id, ...kepala })
                .onConflictDoUpdate({ target: [kasirPelunasan.databaseId, kasirPelunasan.pelunasanId], set: { ...kepala, dibacaPada: sql`now()` } });
            await tx.delete(kasirPelunasanFaktur).where(and(eq(kasirPelunasanFaktur.databaseId, databaseId), eq(kasirPelunasanFaktur.pelunasanId, p.id)));
            if (p.faktur.length) {
                await tx.insert(kasirPelunasanFaktur).values(p.faktur.map((f) => ({ databaseId, pelunasanId: p.id, fakturId: f.fakturId,
                    nomorFaktur: f.nomorFaktur ?? null, masterSalesmanId: f.masterSalesmanId, invoicePayment: senKeTeks(f.invoicePayment) })));
            }
            return true;
        }),
        hapus: (token, databaseId, tanggal, ids) => d.transaction(async (tx) => {
            if (!(await leaseSah(tx, token, databaseId, tanggal))) return false;
            // tanggal ikut disaring: pelunasan yang pindah tanggal dan sudah ditulis pembaca tanggal lain tidak ikut terhapus.
            await tx.delete(kasirPelunasan).where(and(diKepala(databaseId, tanggal), inArray(kasirPelunasan.pelunasanId, ids)));
            return true;
        }),
        async nomor(databaseId, ids) {
            const rows = await d.select({ id: kasirPelunasan.pelunasanId, nomor: kasirPelunasan.nomor }).from(kasirPelunasan)
                .where(and(eq(kasirPelunasan.databaseId, databaseId), inArray(kasirPelunasan.pelunasanId, ids)));
            return new Map(rows.map((r) => [Number(r.id), r.nomor]));
        },
        async selesai(token, databaseId, tanggal, akhir, ditolak, akun) {
            const r = await d.execute(sql`
                UPDATE kasir_pelunasan_baca SET status = ${akhir.status}, sebab = ${akhir.sebab}, pesan = ${akhir.pesan?.slice(0, 1000) ?? null},
                    jumlah_daftar = ${akhir.jumlahDaftar}, sisa_detail = ${akhir.sisaDetail}, ditolak = ${JSON.stringify(ditolak)}::jsonb,
                    token = NULL, selesai_pada = now(), akun_sinkron = ${akun ?? null},
                    lengkap_pada = CASE WHEN ${akhir.status === "lengkap"}::boolean THEN now() ELSE lengkap_pada END
                WHERE database_id = ${databaseId} AND tanggal = ${tanggal}::date AND token = ${token} AND status = 'berjalan'
                RETURNING ${KOLOM_STATUS}`);
            return r.rows[0] ? keStatus(r.rows[0]) : null;
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pembaca cache (K2 / K3) — TANPA Accurate
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Identitas sesi SINKRON (user.id + databaseId) tanpa panggilan Accurate (status/cache Kasir hanya untuk database itu).
 * ponytail: menyalin pemilihan user resolveSyncCredentials (lib/accurate-session.ts:147-153, berkas itu tidak diubah) supaya GET status
 * tidak memicu open-db.do. Plafon: bila pemilihan di sana berubah, ubah juga di sini (uji route GET memakai pickSyncUserId yang sama).
 */
export async function sesiSinkron(d: Db = db): Promise<SesiSinkron> {
    let userId = (process.env.ACCURATE_SYNC_USER_ID || "").trim();
    if (!userId) {
        userId = pickSyncUserId(await d.select({ userId: accurateOAuthSession.userId, role: user.role }).from(accurateOAuthSession)
            .innerJoin(user, eq(user.id, accurateOAuthSession.userId)).orderBy(desc(accurateOAuthSession.updatedAt)));
    }
    if (!userId) return { userId: "", databaseId: "" };
    const [row] = await d.select({ databaseId: accurateOAuthSession.databaseId }).from(accurateOAuthSession)
        .where(eq(accurateOAuthSession.userId, userId)).limit(1);
    return { userId, databaseId: String(row?.databaseId ?? "").trim() };
}

export const databaseIdSinkron = async (d: Db = db): Promise<string> => (await sesiSinkron(d)).databaseId;

/** Status baca terakhir (belum_dibaca bila tak ada baris) — tanpa Accurate. */
export function statusBaca(databaseId: string, tanggal: string, d: Db = db): Promise<StatusBaca> {
    return bacaStatus(d, databaseId, tanggal);
}

/**
 * Pelunasan bertanggal `tanggal` dari cache `databaseId` (pakai databaseIdSinkron()) + status bacanya, satu snapshot (REPEATABLE READ,
 * baca-saja). K2: total hanya boleh tampil sebagai lengkap & Tutup hanya bila `status.status === "lengkap"`. Nominal = sen (keSen).
 */
export function muatPelunasanHari(databaseId: string, tanggal: string, d: Db = db): Promise<{ status: StatusBaca; pelunasan: Pelunasan[] }> {
    return d.transaction(async (tx) => {
        const status = await bacaStatus(tx, databaseId, tanggal);
        const kepala = await tx.select().from(kasirPelunasan).where(diKepala(databaseId, tanggal)).orderBy(asc(kasirPelunasan.pelunasanId));
        const baris = await tx.select({ pelunasanId: kasirPelunasanFaktur.pelunasanId, fakturId: kasirPelunasanFaktur.fakturId,
            nomorFaktur: kasirPelunasanFaktur.nomorFaktur, masterSalesmanId: kasirPelunasanFaktur.masterSalesmanId,
            invoicePayment: kasirPelunasanFaktur.invoicePayment })
            .from(kasirPelunasanFaktur)
            .innerJoin(kasirPelunasan, and(eq(kasirPelunasan.databaseId, kasirPelunasanFaktur.databaseId), eq(kasirPelunasan.pelunasanId, kasirPelunasanFaktur.pelunasanId)))
            .where(diKepala(databaseId, tanggal))
            .orderBy(asc(kasirPelunasanFaktur.pelunasanId), asc(kasirPelunasanFaktur.fakturId));
        const per = new Map<number, Pelunasan["faktur"][number][]>();
        for (const b of baris) {
            const xs = per.get(Number(b.pelunasanId)) ?? [];
            xs.push({ fakturId: Number(b.fakturId), nomorFaktur: b.nomorFaktur, masterSalesmanId: b.masterSalesmanId === null ? null : Number(b.masterSalesmanId),
                invoicePayment: keSen(b.invoicePayment) });
            per.set(Number(b.pelunasanId), xs);
        }
        return {
            status,
            pelunasan: kepala.map((k) => ({ id: Number(k.pelunasanId), nomor: k.nomor, tanggal: k.tanggal, metode: k.metode,
                chequeAmount: keSen(k.chequeAmount), faktur: per.get(Number(k.pelunasanId)) ?? [] })),
        };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Status untuk klien: akun sinkron & pemicu manual sebagai NAMA (bukan user.id); nama tak terbaca = "(akun tak dikenal)". */
export async function publikkan(s: StatusBaca, deps: Pick<DepsBaca, "nama"> = bawaan): Promise<StatusPublik> {
    const { akunSinkron, pemicu, ...sisa } = s;
    const [jenis, ...oleh] = (pemicu ?? "").split(":");
    const pemicuId = oleh.join(":");
    const ids = [akunSinkron, pemicuId].filter((x): x is string => Boolean(x));
    const nama = ids.length ? await deps.nama(ids).catch(() => new Map<string, string>()) : new Map<string, string>();
    const tampil = (id: string | null) => (id ? nama.get(id) ?? "(akun tak dikenal)" : null);
    return { ...sisa, akun: tampil(akunSinkron), pemicu: jenis || null, pemicuOleh: tampil(pemicuId || null) };
}

/** HasilBaca -> jawaban HTTP POST /api/kasir/segarkan (status dipublikkan; diuji tanpa jaringan). */
export async function jawabanSegarkan(h: HasilBaca, deps: Pick<DepsBaca, "nama"> = bawaan): Promise<{ http: number; body: Record<string, unknown> }> {
    if (h.jenis === "kredensial") {
        return { http: 503, body: { ok: false, kode: "SESI_SINKRON", error: PESAN_SESI_SINKRON, detail: h.pesan,
            ...(h.status ? { status: await publikkan(h.status, deps) } : {}) } };
    }
    const s = await publikkan(h.status, deps);
    if (h.jenis === "sedang_dibaca" || h.jenis === "lease_hilang") {
        return { http: 409, body: { ok: false, kode: "SEDANG_DIBACA", error: "Pelunasan tanggal ini sedang dibaca — coba lagi sebentar.", status: s } };
    }
    if (h.jenis === "jeda_lengkap") return { http: 200, body: { ok: true, dariCache: true, status: s } };
    if (s.status === "gagal" && s.sebab === "sesi_sinkron") return { http: 503, body: { ok: false, kode: "SESI_SINKRON", error: PESAN_SESI_SINKRON, status: s } };
    if (s.status === "gagal" && s.sebab === "hapus_massal") return { http: 409, body: { ok: false, kode: "HAPUS_MASSAL", error: s.pesan, status: s } };
    if (s.status === "gagal") return { http: 502, body: { ok: false, kode: "BACA_GAGAL", error: s.pesan, status: s } };
    return { http: 200, body: { ok: true, status: s } };
}
