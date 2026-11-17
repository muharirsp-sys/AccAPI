/**
 * Tujuan: Owner 17 Nov 2026 — pelanggan yang kolom Catatan (notes) Accurate-nya memuat "Hendra" adalah keputusan manual:
 *   (1) sistem tidak boleh mengubah APA PUN pada pelanggan itu: tulis customer lewat proxy Konsol ditolak;
 *   (2) sistem HANYA boleh mengembalikan Limit Piutang (customerLimitAmount[Value]) dan Limit Hari (customerLimitAge[Value]),
 *       dan hanya bila perubahan limit itu berasal dari IMPOR MASSAL (banyak pelanggan tersimpan di menit yang sama — mis. impor
 *       limit 13 Nov 2026 yang menurunkan C-PEL017-FR dari 445rb ke 200rb). Edit satu per satu = keputusan baru, dibiarkan.
 *       Perubahan kolom LAIN tidak pernah dikembalikan.
 * Cara kerja: setiap simpanan pelanggan yang terlihat (webhook detail.do dan sync list.do, keduanya lewat upsertPage customer di
 *   lib/sync) diamati: menit simpanannya dihitung (limit_menit_simpan), dan bila pelanggan Hendra berubah limitnya dicatat SATU
 *   peristiwa berisi limit sebelum & sesudah (limit_hendra_ubah). Pemulih memutuskan peristiwa per pelanggan (satu kesatuan) bila
 *   semuanya >= 15 menit sejak disimpan DAN sejak teramati: menit ramai (>= 20 simpanan; menit sebelah ikut) = impor -> limit
 *   dikembalikan ke nilai SEBELUM impor; tidak ramai = edit satuan -> dibiarkan. Hitungan per menit hanya bertambah.
 * Caller: app/api/proxy/route.ts (penjaga tulis); lib/sync.ts customer.upsertPage (pengamat); app/api/cron/pulih-limit-hendra +
 *   app/api/cron/sync-accurate (pemulih).
 * Dependensi: tabel customer (salinan), limit_hendra_ubah, limit_menit_simpan (0045), Accurate customer/detail.do, list.do, save.do.
 * Main Functions: isCatatanHendra, periksaTulisPelangganHendra, cariPelangganAccurate, amatiSimpanan, amatiHalamanPelanggan,
 *   pulihkanLimitHendra, jalankanPulihLimitHendra.
 * Side Effects: pengamat menulis limit_menit_simpan + limit_hendra_ubah (gagal = dicatat log, sync tetap jalan); pemulih =
 *   customer/save.do berisi id + 4 kolom limit SAJA, lalu menandai peristiwa. Penjaga tidak menulis.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer, limitHendraUbah, limitMenitSimpan, syncState } from "@/db/schema";
import { parseAccurateDateTime } from "@/lib/accurate-invoice";
import { bacaAccurate, flattenPayload, forwardAccurate, type AccurateTarget } from "@/lib/accurate-forward";
import { isPelangganTerlindungi } from "@/lib/pelanggan-terlindungi";

/** "Hendra", "hendra", "Hendra via Wa", "Hold ... Hendra" — semua catatan yang menyebut Hendra = keputusan manual. */
export const isCatatanHendra = (notes: unknown) => /hendra/i.test(String(notes ?? ""));

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const teks = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
/** lastUpdate Accurate: teks dd/MM/yyyy HH:mm:ss WIB. Nilai ISO = cadangan lib/sync (waktu sync, bukan waktu simpan). */
const FORMAT_ACCURATE = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/;

// ---------------- (1) Penjaga tulis Konsol ----------------

/**
 * Kunci identitas pelanggan dalam payload, dibaca dari bentuk DATAR yang sama dengan yang dikirim ke Accurate (flattenPayload):
 * id / customerNo / no / number di tingkat atas, data[n], atau data (objek) — termasuk "data[0][id]", "ID", dan nilai array.
 * Kunci objek bersarang lain (detailContact[0].id, detailShipAddress) bukan pelanggan.
 */
const KUNCI_IDENTITAS = /^(?:data(?:\[\d+\])?(?:\.|\[))?(id|customerno|no|number)\]?(?:\[\d+\])?$/i;

export function identitasTulis(payload: unknown): { ids: string[]; kode: string[]; rusak: boolean } {
    if (!Array.isArray(payload) && !isRec(payload)) return { ids: [], kode: [], rusak: payload !== null && payload !== undefined };
    const datar = Array.isArray(payload) ? flattenPayload(payload, "data") : flattenPayload(payload);
    const ids = new Set<string>();
    const kode = new Set<string>();
    for (const [k, v] of Object.entries(datar)) {
        const m = k.match(KUNCI_IDENTITAS);
        const nilai = teks(v);
        if (!m || !nilai) continue;
        if (m[1].toLowerCase() === "id") ids.add(nilai);
        else kode.add(nilai.toUpperCase());
    }
    return { ids: [...ids], kode: [...kode], rusak: false };
}

export type PelangganAccurate = { customerNo: string; notes: string };

/**
 * Pelanggan Hendra dalam tulis customer ini. SEMUA id dan SEMUA kode (customerNo/no/number) dicari — kode juga saat id ada,
 * karena save.do bisa menunjuk pelanggan lewat kodenya. `cariId` null = id tidak ada (tak terbaca, update ke id fiktif);
 * `cariNo` null = kode belum ada di Accurate (pelanggan baru, boleh). Melempar = tak terbaca. Payload bukan objek/array = tak
 * terbaca. Pemanggil menolak bila ada yang Hendra ATAU tak terbaca (fail-closed). 4 pencarian bersamaan.
 */
export async function periksaTulisPelangganHendra(
    payload: unknown,
    cariId: (id: string) => Promise<PelangganAccurate | null>,
    cariNo: (customerNo: string) => Promise<PelangganAccurate | null>,
): Promise<{ kode: string[]; takTerbaca: string[] }> {
    const ident = identitasTulis(payload);
    const kode = new Set<string>();
    const takTerbaca: string[] = ident.rusak ? ["payload bukan objek/array"] : [];
    const kerja = [...ident.ids.map((v) => ["id", v] as const), ...ident.kode.map((v) => ["no", v] as const)];
    for (let i = 0; i < kerja.length; i += 4) {
        await Promise.all(kerja.slice(i, i + 4).map(async ([jenis, v]) => {
            try {
                const p = jenis === "id" ? await cariId(v) : await cariNo(v);
                if (p && isCatatanHendra(p.notes)) kode.add(p.customerNo || v);
                else if (!p && jenis === "id") takTerbaca.push(`id ${v}`);
            } catch {
                takTerbaca.push(jenis === "id" ? `id ${v}` : v);
            }
        }));
    }
    return { kode: [...kode], takTerbaca };
}

/**
 * Pencari pelanggan Accurate untuk penjaga: id -> detail.do; kode -> id dari salinan (customer) lalu detail.do, atau list.do
 * (kata kunci, cocok persis) bila belum ada di salinan. Jawaban detail tanpa objek pelanggan = tak terbaca (melempar).
 */
export function cariPelangganAccurate(target: AccurateTarget) {
    const baca = bacaAccurate(target);
    const cache = new Map<string, Promise<PelangganAccurate | null>>();
    const cariId = (id: string) => {
        if (!cache.has(id)) cache.set(id, (async () => {
            const r = await baca("/api/customer/detail.do", "GET", { id });
            if (!r?.s) return null;
            if (!isRec(r.d) || !teks((r.d as Rec).customerNo)) throw new Error(`detail.do ${id}: jawaban tanpa pelanggan`);
            return { customerNo: teks((r.d as Rec).customerNo), notes: teks((r.d as Rec).notes) };
        })());
        return cache.get(id)!;
    };
    const cariNo = async (no: string) => {
        const [salin] = await db.select({ id: customer.id }).from(customer).where(sql`upper(${customer.customerNo}) = ${no.toUpperCase()}`).limit(1);
        if (salin?.id) return cariId(String(salin.id));
        const r = await baca("/api/customer/list.do", "GET", { fields: "id,customerNo,notes", "filter.keywords.op": "CONTAIN", "filter.keywords.val[0]": no, "sp.pageSize": 100 });
        if (!r?.s) throw new Error(`list.do pelanggan ${no} gagal`);
        const d = (Array.isArray(r.d) ? r.d as Rec[] : []).find((x) => teks(x.customerNo).toUpperCase() === no.toUpperCase());
        return d ? { customerNo: teks(d.customerNo), notes: teks(d.notes) } : null;
    };
    return { cariId, cariNo };
}

// ---------------- (2) Pengamat simpanan pelanggan ----------------

export type Limit = { aktif: boolean; nilai: number | null; hariAktif: boolean; hari: number | null };
const angka = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export const limitDariAccurate = (d: Rec): Limit => ({
    aktif: d.customerLimitAmount === true || d.customerLimitAmount === "true", nilai: angka(d.customerLimitAmountValue),
    hariAktif: d.customerLimitAge === true || d.customerLimitAge === "true", hari: angka(d.customerLimitAgeValue),
});

export const samaLimit = (a: Limit, b: Limit) => a.aktif === b.aktif && a.hariAktif === b.hariAktif
    && Math.abs((a.nilai ?? 0) - (b.nilai ?? 0)) < 0.5 && (a.hari ?? 0) === (b.hari ?? 0);

export type SimpananLama = { lastUpdate: string; limit: Limit };
export type PeristiwaBaru = { customerId: number; customerNo: string; lastUpdate: string; lama: Limit; baru: Limit; status: "baru" | "sistem" };
/** Pemulihan yang sudah / sedang ditulis pemulih: limit `baru` peristiwa itu dikembalikan `ke` nilai ini. */
export type Pemulihan = { baru: Limit; ke: Limit };

/**
 * Murni. `rows` = jawaban Accurate (detail.do atau list.do) yang akan di-upsert; `lama` = salinan SEBELUM upsert; `pemulihan` =
 * pemulihan pemulih per pelanggan (`diproses`, atau `dipulihkan` 2 hari terakhir — review 3 C, dengan `dipulihkan_ke`). Simpanan baru = lastUpdate berbeda dari
 * salinan (jawaban ulang yang sama tidak dihitung dua kali). Simpanan pemulih sendiri (limit berbalik persis baru -> ke dari salah
 * satu pemulihan) = peristiwa `sistem`, tidak dihitung ke menit ramai dan tidak diputuskan.
 * ponytail: webhook dan sync yang membaca salinan lama bersamaan bisa menghitung satu simpanan dua kali (menit normal butuh ~10
 * simpanan nyata untuk melewati ambang 20). Hitungan per (pelanggan, lastUpdate) bila itu terbukti terjadi.
 */
export function amatiSimpanan(rows: Rec[], lama: Map<number, SimpananLama>, pemulihan: Map<number, Pemulihan[]>) {
    const menit = new Map<string, number>();
    const ubah: PeristiwaBaru[] = [];
    for (const row of rows) {
        const id = Number(row.id);
        const lu = teks(row.lastUpdate);
        if (!Number.isFinite(id) || !FORMAT_ACCURATE.test(lu)) continue;
        const sebelum = lama.get(id);
        if (sebelum && sebelum.lastUpdate === lu) continue;
        const sesudah = limitDariAccurate(row);
        if (sebelum && isCatatanHendra(row.notes) && !samaLimit(sebelum.limit, sesudah)) {
            const sistem = (pemulihan.get(id) ?? []).some((p) => samaLimit(p.ke, sesudah) && samaLimit(p.baru, sebelum.limit));
            ubah.push({ customerId: id, customerNo: teks(row.customerNo), lastUpdate: lu, lama: sebelum.limit, baru: sesudah, status: sistem ? "sistem" : "baru" });
            if (sistem) continue;
        }
        menit.set(lu.slice(0, 16), (menit.get(lu.slice(0, 16)) ?? 0) + 1);
    }
    return { menit, ubah };
}

const benar = (v: unknown) => v === true || v === "t" || v === "true";

/** Baca salinan SEBELUM upsert satu halaman pelanggan (dipanggil lib/sync). Gagal = null (pengamatan halaman ini dilewati). */
export async function bacaSalinanLama(ids: number[]): Promise<Map<number, SimpananLama> | null> {
    if (!ids.length) return new Map();
    try {
        // sql.param: SATU parameter array ($1::bigint[]). `${ids}` mentah dirender drizzle sebagai daftar ($1, $2) = SQL rusak (review 2 #1).
        const rows = (await db.execute(sql`SELECT id, last_update AS lu, credit_limit_enabled AS a, credit_limit_amount AS n,
                credit_age_limit_enabled AS ha, credit_age_limit_days AS h FROM ${customer} WHERE id = ANY(${sql.param(ids)}::bigint[])`)).rows as Rec[];
        return new Map(rows.map((r) => [Number(r.id), { lastUpdate: teks(r.lu),
            limit: { aktif: benar(r.a), nilai: angka(r.n), hariAktif: benar(r.ha), hari: angka(r.h) } }]));
    } catch (e) {
        console.error(`[pelanggan-hendra] salinan lama tidak terbaca, pengamatan dilewati: ${e instanceof Error ? e.message : e}`);
        return null;
    }
}

/**
 * Catat hasil amatiSimpanan (dipanggil lib/sync sesudah upsert halaman). TIDAK PERNAH melempar: gagal (tabel belum dimigrasi,
 * DB sibuk) hanya dicatat log — sync dan webhook tidak boleh berhenti karena pengamatan.
 */
export async function amatiHalamanPelanggan(rows: Rec[], lama: Map<number, SimpananLama> | null) {
    if (!lama) return;
    try {
        const hendraIds = rows.filter((r) => isCatatanHendra(r.notes)).map((r) => Number(r.id)).filter(Number.isFinite);
        const pulih = new Map<number, Pemulihan[]>();
        if (hendraIds.length) {
            const p = (await db.execute(sql`SELECT customer_id, baru, dipulihkan_ke FROM ${limitHendraUbah}
                WHERE status IN ('diproses', 'dipulihkan') AND dipulihkan_ke IS NOT NULL
                  AND (status = 'diproses' OR diputuskan_pada > now() - interval '2 days')
                  AND customer_id = ANY(${sql.param(hendraIds)}::bigint[])`)).rows as Rec[];
            for (const r of p) {
                const daftar = pulih.get(Number(r.customer_id)) ?? [];
                daftar.push({ baru: r.baru as Limit, ke: r.dipulihkan_ke as Limit });
                pulih.set(Number(r.customer_id), daftar);
            }
        }
        const { menit, ubah } = amatiSimpanan(rows, lama, pulih);
        for (const [m, n] of menit) {
            await db.insert(limitMenitSimpan).values({ menit: m, jumlah: n })
                .onConflictDoUpdate({ target: limitMenitSimpan.menit, set: { jumlah: sql`${limitMenitSimpan.jumlah} + ${n}` } });
        }
        if (ubah.length) {
            await db.insert(limitHendraUbah).values(ubah.map((u) => ({ customerId: u.customerId, customerNo: u.customerNo, lastUpdate: u.lastUpdate,
                lama: u.lama, baru: u.baru, status: u.status, diputuskanPada: u.status === "sistem" ? new Date() : null,
                alasan: u.status === "sistem" ? "simpanan pemulih sendiri" : null }))).onConflictDoNothing();
        }
    } catch (e) {
        console.error(`[pelanggan-hendra] pengamatan simpanan gagal (sync lanjut): ${e instanceof Error ? e.message : e}`);
    }
}

// ---------------- (3) Pemulih ----------------

/** Ambang impor massal: >= 20 simpanan pelanggan dalam satu menit (impor 13 Nov: 29–359/menit; edit tangan <= ~5/menit). */
export const AMBANG_MASSAL = 20;
/** Peristiwa baru diputuskan setelah 15 menit — impor yang masih berjalan sudah selesai dan terhitung. */
export const TUNGGU_MS = 15 * 60_000;
/** Peristiwa `diproses` yang tertinggal (jalan terputus) boleh diklaim ulang sesudah 30 menit. */
export const KLAIM_BASI_MS = 30 * 60_000;

/** "13/11/2026 10:22" +/- n menit, format Accurate. */
function menitGeser(menit: string, n: number) {
    const t = parseAccurateDateTime(menit);
    if (!t) return menit;
    const w = new Date(t.getTime() + n * 60_000 + 7 * 3_600_000); // WIB
    const p = (x: number) => String(x).padStart(2, "0");
    return `${p(w.getUTCDate())}/${p(w.getUTCMonth() + 1)}/${w.getUTCFullYear()} ${p(w.getUTCHours())}:${p(w.getUTCMinutes())}`;
}

export type Peristiwa = {
    id: number; customerId: number; customerNo: string; lastUpdate: string; lama: Limit; baru: Limit;
    /** Saat peristiwa teramati (webhook/sync) — impor yang baru teramati sync belum tentu sudah terhitung penuh. */
    dicatatPada: Date;
};
export type DetailLimit = Limit & { customerNo: string; notes: string; lastUpdate: string };

export type DepsPulih = {
    daftar(): Promise<Peristiwa[]>;
    /** Hitungan simpanan untuk menit-menit ini (limit_menit_simpan). */
    hitungMenit(menit: string[]): Promise<Map<string, number>>;
    /**
     * Klaim SEMUA peristiwa terbuka satu pelanggan (semua-atau-tidak). Gagal = jalan lain memegang sebagian, atau ada peristiwa
     * pelanggan itu yang belum ada di `ids` (teramati sesudah daftar dibaca) — pelanggan diputuskan jalan berikutnya.
     */
    klaim(customerId: number, ids: number[]): Promise<boolean>;
    /** Catat nilai yang AKAN ditulis (status tetap `diproses`) SEBELUM save.do — pengamat mengenali simpanan itu sebagai `sistem`. */
    tandaiTarget(id: number, ke: Limit): Promise<void>;
    selesai(id: number, status: "dipulihkan" | "dibiarkan" | "dilewati" | "baru", alasan: string): Promise<void>;
    bacaDetail(customerId: number): Promise<DetailLimit | null>;
    tulisLimit(customerId: number, limit: Limit): Promise<void>;
};

export type HasilPulih = {
    peristiwa: number; dipulihkan: string[]; dibiarkan: string[]; dilewati: string[]; ditunda: number; gagal: string[]; coba: boolean;
};

/** Pelanggan yang tidak terbaca / berubah lagi tanpa peristiwa teramati diulang paling lama 2 hari, lalu dilewati. */
export const BATAS_ULANG_MS = 2 * 24 * 3_600_000;

/**
 * Pemulih. Ramai = hitungan pengamat (hanya bertambah) di menit itu atau sebelahnya >= AMBANG_MASSAL. Peristiwa SATU pelanggan
 * diputuskan sebagai satu kesatuan dari SATU pembacaan Accurate, dan statusnya baru ditulis SESUDAH hasilnya pasti — tulis gagal,
 * pelanggan tak terbaca, atau perubahan yang belum teramati = seluruh kelompok kembali `baru` dan dihitung ulang utuh jalan
 * berikutnya (review 3 A, review 4 F1/F3). Rantai: impor beruntun A->B lalu B->C kembali ke A; edit satuan memutus rantai.
 * ponytail: tanpa pendapat kedua dari Accurate (filter lastUpdate) — hitungan Accurate ikut memuat simpanan pemulih sendiri dan
 * tergerus simpanan berikutnya (review 2 #4). Plafon: impor yang terjadi saat pengamat mati/belum terpasang tidak dipulihkan, dan
 * edit tangan yang webhook-nya hilang lalu disusul impor sebelum sync berikut dipulihkan ke nilai sebelum edit (review 2 #6).
 */
export async function pulihkanLimitHendra(d: DepsPulih, opsi: { sekarang: Date; coba?: boolean; maks?: number }): Promise<HasilPulih> {
    const coba = Boolean(opsi.coba);
    const maks = opsi.maks ?? 300; // ponytail: pelanggan Hendra ±281 (17 Nov); batas mencegah salah hitung menulis tanpa ujung
    const sekarang = opsi.sekarang.getTime();
    const daftar = await d.daftar();
    const h: HasilPulih = { peristiwa: daftar.length, dipulihkan: [], dibiarkan: [], dilewati: [], ditunda: 0, gagal: [], coba };
    const ramaiCache = new Map<string, boolean>();
    const ramai = async (menit: string) => {
        if (!ramaiCache.has(menit)) {
            const sekitar = [menitGeser(menit, -1), menit, menitGeser(menit, 1)];
            const n = await d.hitungMenit(sekitar);
            ramaiCache.set(menit, sekitar.some((m) => (n.get(m) ?? 0) >= AMBANG_MASSAL));
        }
        return ramaiCache.get(menit)!;
    };
    const waktu = (e: Peristiwa) => (FORMAT_ACCURATE.test(e.lastUpdate) ? parseAccurateDateTime(e.lastUpdate) : null);
    const matang = (e: Peristiwa) => {
        const t = waktu(e);
        return Boolean(t) && sekarang - t!.getTime() >= TUNGGU_MS && sekarang - e.dicatatPada.getTime() >= TUNGGU_MS;
    };
    const label = (e: Peristiwa) => `${e.customerNo} (${e.lastUpdate})`;
    const perPelanggan = new Map<number, Peristiwa[]>();
    for (const e of daftar) perPelanggan.set(e.customerId, [...(perPelanggan.get(e.customerId) ?? []), e]);

    for (const [customerId, kelompok] of perPelanggan) {
        if (!kelompok.every(matang) || h.dipulihkan.length >= maks) { h.ditunda += kelompok.length; continue; }
        if (!coba && !(await d.klaim(customerId, kelompok.map((e) => e.id)))) continue;
        const terakhir = kelompok[kelompok.length - 1];
        const tua = sekarang - (waktu(terakhir)?.getTime() ?? sekarang) >= BATAS_ULANG_MS;
        /** Kembalikan seluruh kelompok ke `baru` (diulang utuh). */
        const ulang = async (alasan: string) => {
            if (!coba) for (const e of kelompok) await d.selesai(e.id, "baru", alasan).catch(() => undefined);
            h.ditunda += kelompok.length;
        };
        /** Tulis status akhir seluruh kelompok sekaligus. */
        const tutup = async (status: Map<number, ["dipulihkan" | "dibiarkan" | "dilewati", string]>) => {
            for (const e of kelompok) {
                const [s, alasan] = status.get(e.id)!;
                if (!coba) await d.selesai(e.id, s, alasan);
                if (s === "dibiarkan") h.dibiarkan.push(label(e));
                else if (s === "dilewati") h.dilewati.push(`${label(e)}: ${alasan}`);
            }
        };
        try {
            // 1) Keputusan per peristiwa tanpa menulis apa pun: impor atau edit satuan, dan target rantai tiap impor.
            const impor = new Map<number, boolean>();
            for (const e of kelompok) impor.set(e.id, await ramai(e.lastUpdate.slice(0, 16)));
            const target = new Map<number, Limit>();
            let rantai: Pemulihan | undefined;
            for (const e of kelompok) {
                if (!impor.get(e.id)) { rantai = undefined; continue; }
                const ke = rantai && samaLimit(rantai.baru, e.lama) ? rantai.ke : e.lama;
                target.set(e.id, ke);
                rantai = { baru: e.baru, ke };
            }
            const status = new Map<number, ["dipulihkan" | "dibiarkan" | "dilewati", string]>();
            for (const e of kelompok) {
                status.set(e.id, impor.get(e.id) ? ["dilewati", "digantikan peristiwa berikutnya"] : ["dibiarkan", "edit satuan = keputusan baru"]);
            }
            if (![...impor.values()].some(Boolean)) { await tutup(status); continue; }

            // 2) Satu pembacaan Accurate untuk seluruh kelompok.
            const det = await d.bacaDetail(customerId);
            if (!det) {
                if (!tua) { await ulang("pelanggan tidak terbaca di Accurate, diulang"); continue; }
                for (const e of kelompok) if (impor.get(e.id)) status.set(e.id, ["dilewati", "pelanggan tidak terbaca di Accurate > 2 hari"]);
                await tutup(status);
                continue;
            }
            if (!isCatatanHendra(det.notes)) {
                for (const e of kelompok) if (impor.get(e.id)) status.set(e.id, ["dilewati", "catatan Hendra sudah tidak ada"]);
                await tutup(status);
                continue;
            }
            const ke = target.get(terakhir.id);
            if (ke && samaLimit(det, ke)) {
                // Sudah bernilai sebelum impor (tulis terdahulu ternyata masuk, atau impor berikutnya mengembalikannya) — tanpa
                // save.do: lastUpdate pelanggan Hendra tidak disentuh sia-sia (review 3 E, review 5 nit 1).
                status.set(terakhir.id, ["dipulihkan", "sudah sesuai nilai sebelum impor, tanpa tulis"]);
                await tutup(status);
                h.dilewati.push(`${label(terakhir)}: sudah sesuai, tanpa tulis`);
                continue;
            }
            if (!samaLimit(det, terakhir.baru)) {
                // Accurate berubah lagi tanpa peristiwa teramati (belum diamati webhook/sync): putuskan utuh nanti (review 4 F3).
                if (!tua) { await ulang("limit berubah lagi, peristiwanya belum teramati; diulang"); continue; }
                for (const e of kelompok) if (impor.get(e.id)) status.set(e.id, ["dilewati", "limit berubah lagi sesudahnya (> 2 hari)"]);
                await tutup(status);
                continue;
            }
            // Keadaan Accurate = hasil peristiwa terakhir. Edit satuan -> dibiarkan; impor -> pulihkan ke target rantainya.
            if (!ke) { await tutup(status); continue; }
            if (isPelangganTerlindungi(terakhir.customerNo) && (ke.aktif || ke.hariAktif)) {
                // Aturan 13 Nov (lib/pelanggan-terlindungi) menang: 8 toko NKA/DC tidak pernah diberi batas, juga oleh pemulih ini.
                status.set(terakhir.id, ["dilewati", "toko terlindungi 13 Nov: batas tidak boleh dipasang kembali"]);
                await tutup(status);
                continue;
            }
            if (coba) {
                h.dipulihkan.push(label(terakhir));
                for (const e of kelompok) if (e !== terakhir) { const [s, a] = status.get(e.id)!; if (s === "dibiarkan") h.dibiarkan.push(label(e)); else h.dilewati.push(`${label(e)}: ${a}`); }
                continue;
            }
            // 3) Urutan aman (review 2 #4, #9): target dicatat (status tetap `diproses`) -> save.do -> status akhir seluruh kelompok.
            status.set(terakhir.id, ["dipulihkan", "impor massal: limit dikembalikan ke nilai sebelum impor"]);
            try {
                await d.tandaiTarget(terakhir.id, ke);
                await d.tulisLimit(customerId, ke);
            } catch (err) {
                // Tulis tak pasti (timeout, 5xx): pastikan dari Accurate.
                const cek = await d.bacaDetail(customerId).catch(() => null);
                if (!cek || !samaLimit(cek, ke)) {
                    h.gagal.push(`${label(terakhir)}: ${err instanceof Error ? err.message : String(err)}`);
                    if (cek && samaLimit(cek, terakhir.baru)) {
                        // Ditolak terus (mis. validasi Accurate) tidak diulang tanpa ujung: batas 2 hari yang sama (review 5 nit 2).
                        if (!tua) await ulang("tulis gagal, diulang utuh jalan berikutnya");
                        else {
                            for (const e of kelompok) if (impor.get(e.id)) status.set(e.id, ["dilewati", "tulis Accurate gagal terus > 2 hari"]);
                            await tutup(status);
                        }
                    }
                    // Accurate tak terbaca: biarkan `diproses` -> diklaim ulang setelah basi dan diputuskan dari Accurate.
                    continue;
                }
                status.set(terakhir.id, ["dipulihkan", "tulis tak pasti, terbukti masuk di Accurate"]);
            }
            await tutup(status);
            h.dipulihkan.push(label(terakhir));
        } catch (err) {
            h.gagal.push(`${label(terakhir)}: ${err instanceof Error ? err.message : String(err)}`);
            await ulang("gagal sebelum menulis, diulang");
        }
    }
    return h;
}

// ---------------- Penghubung pemulih ke Postgres + Accurate ----------------

/** Isi customer/save.do pemulih: id + 4 kolom limit SAJA — kolom lain pelanggan Hendra tidak pernah dikirim. */
export const payloadPulih = (id: number, l: Limit) => ({
    id, customerLimitAmount: l.aktif, customerLimitAmountValue: l.nilai ?? 0, customerLimitAge: l.hariAktif, customerLimitAgeValue: l.hari ?? 0,
});

/** Satu baris log ringkas hasil pemulih (cron & sync-accurate). Kode pelanggan dipulihkan ikut — jejak tulis otomatis ke Accurate. */
export const ringkasPulih = (h: HasilPulih) => `peristiwa=${h.peristiwa} dipulihkan=${h.dipulihkan.length} dibiarkan=${h.dibiarkan.length}`
    + ` dilewati=${h.dilewati.length} ditunda=${h.ditunda} gagal=${h.gagal.length}${h.coba ? " (coba)" : ""}`
    + (h.dipulihkan.length ? ` [${h.dipulihkan.join(", ")}]` : "");

/** Saklar darurat: env PULIH_LIMIT_HENDRA=mati menghentikan pemulih (pengamat & penjaga tetap jalan). */
export const pemulihMati = () => (process.env.PULIH_LIMIT_HENDRA || "").trim().toLowerCase() === "mati";

export async function jalankanPulihLimitHendra(target: AccurateTarget, opsi: { coba?: boolean } = {}): Promise<HasilPulih | { mati: true } | { tertunda: string }> {
    if (pemulihMati()) return { mati: true };
    // Sync pelanggan sedang berjalan = hitungan per menit dari impor yang baru teramati sync belum lengkap (review 3 B). `syncing`
    // yang basi (> 2 jam, sync terputus) tidak menahan. Dari akhir sync-accurate statusnya sudah `idle`.
    const [s] = (await db.execute(sql`SELECT 1 AS ya FROM ${syncState} WHERE module = 'customer' AND status = 'syncing'
            AND updated_at > (now() AT TIME ZONE 'UTC') - interval '2 hours'`)).rows as Rec[]; // updated_at = timestamp tanpa zona, ditulis drizzle dalam UTC (review 4 F2)
    if (s) return { tertunda: "sync pelanggan sedang berjalan; diputuskan jalan berikutnya" };
    const baca = bacaAccurate(target);
    return pulihkanLimitHendra({
        daftar: async () => ((await db.execute(sql`SELECT id, customer_id, customer_no, last_update, lama, baru, dicatat_pada FROM ${limitHendraUbah}
                WHERE status = 'baru' OR (status = 'diproses' AND diputuskan_pada < now() - make_interval(secs => ${KLAIM_BASI_MS / 1000}))
                ORDER BY id`)).rows as Rec[]).map((r) => ({
            id: Number(r.id), customerId: Number(r.customer_id), customerNo: teks(r.customer_no), lastUpdate: teks(r.last_update),
            lama: r.lama as Limit, baru: r.baru as Limit, dicatatPada: new Date(String(r.dicatat_pada)),
        })),
        hitungMenit: async (menit) => new Map(((await db.execute(sql`SELECT menit, jumlah FROM ${limitMenitSimpan}
                WHERE menit = ANY(${sql.param(menit)}::text[])`)).rows as Rec[]).map((r) => [teks(r.menit), Number(r.jumlah)])),
        tandaiTarget: async (id, ke) => {
            await db.execute(sql`UPDATE ${limitHendraUbah} SET dipulihkan_ke = ${JSON.stringify(ke)}::jsonb WHERE id = ${id}`);
        },
        klaim: async (customerId, ids) => {
            // SEMUA peristiwa terbuka pelanggan ini (review 4 F3), bukan hanya yang ada di daftar jalan ini.
            const dapat = ((await db.execute(sql`UPDATE ${limitHendraUbah} SET status = 'diproses', diputuskan_pada = now()
                WHERE customer_id = ${customerId}
                  AND (status = 'baru' OR (status = 'diproses' AND diputuskan_pada < now() - make_interval(secs => ${KLAIM_BASI_MS / 1000})))
                RETURNING id`)).rows as Rec[]).map((r) => Number(r.id));
            const harap = new Set(ids);
            if (dapat.length === ids.length && dapat.every((id) => harap.has(id))) return true;
            // Sebagian dipegang jalan lain, atau ada peristiwa yang teramati sesudah daftar dibaca: lepas yang sempat diklaim,
            // pelanggan ini diputuskan utuh jalan berikutnya (semua-atau-tidak).
            if (dapat.length) await db.execute(sql`UPDATE ${limitHendraUbah} SET status = 'baru' WHERE id = ANY(${sql.param(dapat)}::bigint[])`);
            return false;
        },
        selesai: async (id, status, alasan) => {
            await db.execute(sql`UPDATE ${limitHendraUbah} SET status = ${status}, alasan = ${alasan}, diputuskan_pada = now() WHERE id = ${id}`);
        },
        bacaDetail: async (id) => {
            const r = await baca("/api/customer/detail.do", "GET", { id });
            const d = r?.s && isRec(r.d) ? r.d as Rec : null;
            return d ? { customerNo: teks(d.customerNo), notes: teks(d.notes), lastUpdate: teks(d.lastUpdate), ...limitDariAccurate(d) } : null;
        },
        tulisLimit: async (id, l) => {
            const r = await forwardAccurate(target, "/api/customer/save.do", "POST", payloadPulih(id, l));
            const j = (() => { try { return JSON.parse(r.text); } catch { return null; } })();
            if (r.status < 200 || r.status >= 300 || !j?.s) throw new Error(`save.do HTTP ${r.status}: ${teks(Array.isArray(j?.d) ? j.d[0] : r.text).slice(0, 200)}`);
        },
    }, { sekarang: new Date(), coba: opsi.coba });
}
