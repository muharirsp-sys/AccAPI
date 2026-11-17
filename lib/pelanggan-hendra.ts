/**
 * Tujuan: Owner 17 Nov 2026 — pelanggan yang kolom Catatan (notes) Accurate-nya memuat "Hendra" adalah keputusan manual:
 *   (1) sistem tidak boleh mengubah APA PUN pada pelanggan itu: tulis customer lewat proxy Konsol ditolak;
 *   (2) sistem HANYA boleh mengembalikan Limit Piutang (customerLimitAmount[Value]) dan Limit Hari (customerLimitAge[Value]) ke
 *       acuan, dan hanya bila keduanya berubah karena IMPOR MASSAL (banyak pelanggan tersimpan di menit yang sama — mis. impor
 *       limit 13 Nov 2026 yang menurunkan C-PEL017-FR ke Rp 200.000). Edit satu per satu di Accurate = keputusan baru, menjadi
 *       acuan. Perubahan kolom LAIN tidak pernah dikembalikan.
 * Caller: app/api/proxy/route.ts (penjaga tulis); app/api/cron/pulih-limit-hendra + app/api/cron/sync-accurate (pemulih).
 * Dependensi: tabel customer (salinan Accurate; notes di raw_data dari lib/sync + webhook), limit_hendra_acuan, sync_state,
 *   Accurate customer/detail.do + save.do.
 * Main Functions: isCatatanHendra, periksaTulisPelangganHendra, putuskanLimit, pulihkanLimitHendra, jalankanPulihLimitHendra.
 * Side Effects: pemulih = customer/save.do berisi id + 4 kolom limit SAJA, dan tulis limit_hendra_acuan. Penjaga tidak menulis.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer, limitHendraAcuan, syncState } from "@/db/schema";
import { parseAccurateDateTime } from "@/lib/accurate-invoice";
import { bacaAccurate, forwardAccurate, type AccurateTarget } from "@/lib/accurate-forward";

/** "Hendra", "hendra", "Hendra via Wa", "Hold ... Hendra" — semua catatan yang menyebut Hendra = keputusan manual. */
export const isCatatanHendra = (notes: unknown) => /hendra/i.test(String(notes ?? ""));

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const teks = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const kolom = (rec: Rec, ...nama: string[]) =>
    Object.keys(rec).filter((k) => nama.includes(k.toLowerCase())).flatMap((k) => rec[k]);

/**
 * Baris pelanggan dalam payload tulis Konsol: objek, array bulk, { data: [...] }, dan kunci datar "data[n].x". Objek bersarang
 * lain (detailContact, detailShipAddress) BUKAN pelanggan — id-nya tidak ikut dicari.
 */
function barisTulis(payload: unknown): Rec[] {
    if (Array.isArray(payload)) return payload.flatMap(barisTulis);
    if (!isRec(payload)) return [];
    const datar = new Map<string, Rec>();
    for (const [k, x] of Object.entries(payload)) {
        const m = k.match(/^data\[(\d+)\]\.([^.[]+)$/i);
        if (m) datar.set(m[1], { ...datar.get(m[1]), [m[2]]: x });
    }
    const data = kolom(payload, "data").filter((x) => Array.isArray(x) || isRec(x));
    return [payload, ...datar.values(), ...data.flatMap(barisTulis)];
}

export type PelangganAccurate = { customerNo: string; notes: string };

/**
 * Penjaga (1): pelanggan mana dalam tulis customer ini yang bercatatan Hendra. `cariId(id)` / `cariNo(customerNo)` membaca
 * Accurate (null = tidak ada; melempar = gagal baca). Baris tanpa id dan kode tidak ditemukan = pelanggan BARU, boleh.
 * Gagal baca = idTakTerbaca (pemanggil menolak, fail-closed). 4 pencarian bersamaan, sekali per id/kode.
 */
export async function periksaTulisPelangganHendra(
    payload: unknown,
    cariId: (id: string) => Promise<PelangganAccurate | null>,
    cariNo: (customerNo: string) => Promise<PelangganAccurate | null>,
): Promise<{ kode: string[]; takTerbaca: string[] }> {
    const ids = new Set<string>();
    const nos = new Set<string>();
    for (const rec of barisTulis(payload)) {
        const id = kolom(rec, "id").map(teks).find(Boolean);
        if (id) ids.add(id);
        else kolom(rec, "customerno", "no").map(teks).filter(Boolean).forEach((n) => nos.add(n.toUpperCase()));
    }
    const kerja = [...[...ids].map((v) => ["id", v] as const), ...[...nos].map((v) => ["no", v] as const)];
    const kode = new Set<string>();
    const takTerbaca: string[] = [];
    for (let i = 0; i < kerja.length; i += 4) {
        await Promise.all(kerja.slice(i, i + 4).map(async ([jenis, v]) => {
            try {
                const p = jenis === "id" ? await cariId(v) : await cariNo(v);
                if (p && isCatatanHendra(p.notes)) kode.add(p.customerNo || v);
                else if (!p && jenis === "id") takTerbaca.push(`id ${v}`); // update ke id yang tidak ada = tidak bisa dipastikan
            } catch {
                takTerbaca.push(jenis === "id" ? `id ${v}` : v);
            }
        }));
    }
    return { kode: [...kode], takTerbaca };
}

// ---------------- Pemulih (2) ----------------

export type Limit = { aktif: boolean; nilai: number | null; hariAktif: boolean; hari: number | null };
export type Kandidat = Limit & { id: number; customerNo: string; lastUpdate: string };
export type DetailLimit = Limit & { customerNo: string; notes: string; lastUpdate: string };

/** Ambang impor massal: >= 20 pelanggan tersimpan dalam satu menit (impor 13 Nov: 29–359/menit; edit tangan <= ~5/menit). */
export const AMBANG_MASSAL = 20;
/** Perubahan baru diputuskan setelah 15 menit — impor yang masih berjalan sudah selesai dan tercatat di salinan. */
export const TUNGGU_MS = 15 * 60_000;

export const samaLimit = (a: Limit, b: Limit) => a.aktif === b.aktif && a.hariAktif === b.hariAktif
    && Math.abs((a.nilai ?? 0) - (b.nilai ?? 0)) < 0.5 && (a.hari ?? 0) === (b.hari ?? 0);

export type Putusan = "acuan_awal" | "sama" | "tunggu" | "acuan_baru" | "pulihkan";

/**
 * Satu pelanggan Hendra: tanpa acuan = catat acuan awal; limit sama = tidak ada apa-apa; berubah di menit ramai (menit itu
 * atau sebelah-sebelahnya >= AMBANG_MASSAL) = pulihkan; berubah sendirian = acuan baru. "Sendirian" baru boleh disimpulkan
 * bila sync PENUH pelanggan selesai >= TUNGGU_MS setelah perubahan (hitungan per menit di salinan sudah lengkap); kalau belum,
 * tunggu — salah menyimpulkan impor sebagai edit tangan = nilai impor jadi acuan dan tidak pernah dipulihkan.
 * ponytail: deteksi impor = kepadatan per menit. Edit tangan yang kebetulan jatuh di menit impor lain ikut dipulihkan.
 */
export function putuskanLimit(acuan: Limit | undefined, kini: Kandidat, ramai: (t: Date) => boolean, sekarang: Date, syncPenuh: Date | null): Putusan {
    if (!acuan) return "acuan_awal";
    if (samaLimit(acuan, kini)) return "sama";
    // Hanya lastUpdate format Accurate. Nilai ISO = cadangan lib/sync saat Accurate tidak mengirim lastUpdate (waktu sync, bukan
    // waktu perubahan) — tidak bisa dihitung per menit, jadi tunggu sampai salinan membawa lastUpdate asli.
    if (!/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/.test(kini.lastUpdate)) return "tunggu";
    const t = parseAccurateDateTime(kini.lastUpdate);
    if (!t || sekarang.getTime() - t.getTime() < TUNGGU_MS) return "tunggu";
    if (ramai(t)) return "pulihkan";
    return syncPenuh && syncPenuh.getTime() - t.getTime() >= TUNGGU_MS ? "acuan_baru" : "tunggu";
}

export type DepsPulih = {
    kandidat(): Promise<Kandidat[]>;
    /** menit epoch (Math.floor(ms/60000)) -> jumlah pelanggan dengan lastUpdate di menit itu (salinan). */
    perMenit(): Promise<Map<number, number>>;
    acuan(): Promise<Map<number, Limit>>;
    syncPenuh(): Promise<Date | null>;
    simpanAcuan(k: Kandidat, sumber: "awal" | "edit_manual"): Promise<void>;
    catatPulih(id: number, dari: Limit): Promise<void>;
    bacaDetail(id: number): Promise<DetailLimit | null>;
    tulisLimit(id: number, limit: Limit): Promise<void>;
};

export type HasilPulih = {
    dicek: number; acuanAwal: number; acuanBaru: string[]; dipulihkan: string[]; ditunda: number; dilewati: string[]; gagal: string[]; coba: boolean;
};

export async function pulihkanLimitHendra(d: DepsPulih, opsi: { sekarang: Date; coba?: boolean; maks?: number }): Promise<HasilPulih> {
    const coba = Boolean(opsi.coba);
    const maks = opsi.maks ?? 300; // ponytail: semua pelanggan Hendra ±281 (17 Nov); batas mencegah salah hitung massal menulis tanpa ujung
    const [kandidat, perMenit, acuan, syncPenuh] = await Promise.all([d.kandidat(), d.perMenit(), d.acuan(), d.syncPenuh()]);
    const ramai = (t: Date) => {
        const m = Math.floor(t.getTime() / 60_000);
        return [m - 1, m, m + 1].some((x) => (perMenit.get(x) ?? 0) >= AMBANG_MASSAL);
    };
    const h: HasilPulih = { dicek: kandidat.length, acuanAwal: 0, acuanBaru: [], dipulihkan: [], ditunda: 0, dilewati: [], gagal: [], coba };
    for (const k of kandidat) {
        const a = acuan.get(k.id);
        const p = putuskanLimit(a, k, ramai, opsi.sekarang, syncPenuh);
        if (p === "sama") continue;
        if (p === "tunggu") { h.ditunda++; continue; }
        try {
            if (p === "acuan_awal" || p === "acuan_baru") {
                if (!coba) await d.simpanAcuan(k, p === "acuan_awal" ? "awal" : "edit_manual");
                if (p === "acuan_awal") h.acuanAwal++;
                else h.acuanBaru.push(k.customerNo);
                continue;
            }
            if (!a) continue;
            if (h.dipulihkan.length >= maks) { h.dilewati.push(`${k.customerNo}: batas ${maks} pemulihan per jalan`); continue; }
            // Salinan bisa tertinggal: putuskan dari Accurate langsung, dan hanya bila belum berubah lagi sejak salinan.
            const det = await d.bacaDetail(k.id);
            if (!det || !isCatatanHendra(det.notes)) { h.dilewati.push(`${k.customerNo}: catatan Hendra sudah tidak ada`); continue; }
            if (det.lastUpdate !== k.lastUpdate) { h.ditunda++; continue; }
            if (samaLimit(a, det)) continue;
            if (!coba) {
                await d.tulisLimit(k.id, a);
                await d.catatPulih(k.id, det);
            }
            h.dipulihkan.push(k.customerNo);
        } catch (e) {
            h.gagal.push(`${k.customerNo}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return h;
}

// ---------------- Penghubung ke Postgres + Accurate ----------------

const CATATAN = sql`CASE WHEN pg_input_is_valid(${customer.rawData} #>> '{}', 'jsonb') THEN (${customer.rawData} #>> '{}')::jsonb ->> 'notes' END`;
const angka = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const benar = (v: unknown) => v === true || v === "t" || v === "true";

/** Isi customer/save.do pemulih: id + 4 kolom limit SAJA — kolom lain pelanggan Hendra tidak pernah dikirim. */
export const payloadPulih = (id: number, l: Limit) => ({
    id, customerLimitAmount: l.aktif, customerLimitAmountValue: l.nilai ?? 0, customerLimitAge: l.hariAktif, customerLimitAgeValue: l.hari ?? 0,
});

export const limitDariAccurate = (d: Rec): Limit => ({
    aktif: d.customerLimitAmount === true, nilai: angka(d.customerLimitAmountValue),
    hariAktif: d.customerLimitAge === true, hari: angka(d.customerLimitAgeValue),
});

/**
 * Pencari pelanggan Accurate untuk penjaga: id -> detail.do; kode -> id dari salinan (customer) lalu detail.do, atau list.do
 * (kata kunci) bila belum ada di salinan. Kode yang tidak ada di mana pun = null (pelanggan baru).
 */
export function cariPelangganAccurate(target: AccurateTarget) {
    const baca = bacaAccurate(target);
    const cache = new Map<string, Promise<PelangganAccurate | null>>();
    const cariId = (id: string) => {
        if (!cache.has(`id:${id}`)) cache.set(`id:${id}`, (async () => {
            const r = await baca("/api/customer/detail.do", "GET", { id });
            if (!r?.s) return null;
            const d = isRec(r.d) ? r.d as Rec : {};
            return { customerNo: teks(d.customerNo), notes: teks(d.notes) };
        })());
        return cache.get(`id:${id}`)!;
    };
    const cariNo = async (no: string) => {
        const [salin] = await db.select({ id: customer.id }).from(customer).where(sql`upper(${customer.customerNo}) = ${no.toUpperCase()}`).limit(1);
        if (salin?.id) return cariId(String(salin.id));
        const r = await baca("/api/customer/list.do", "GET", { fields: "id,customerNo,notes", "filter.keywords.op": "CONTAIN", "filter.keywords.val[0]": no, "sp.pageSize": 100 });
        if (!r?.s) throw new Error(`list.do pelanggan ${no} gagal`);
        const d = (Array.isArray(r.d) ? r.d as Rec[] : []).find((x) => teks(x.customerNo).toUpperCase() === no);
        return d ? { customerNo: teks(d.customerNo), notes: teks(d.notes) } : null;
    };
    return { cariId, cariNo };
}

/**
 * Satu jalan pemulih dengan sesi sync. ponytail: tanpa kunci antar-jalan — dua jalan bersamaan (cron + sync) paling buruk
 * mengirim nilai acuan yang SAMA dua kali (idempoten). Pasang pg_advisory_xact_lock bila pemulih kelak menulis selain acuan.
 */
export async function jalankanPulihLimitHendra(target: AccurateTarget, opsi: { coba?: boolean } = {}): Promise<HasilPulih> {
    const baca = bacaAccurate(target);
    return pulihkanLimitHendra({
        kandidat: async () => ((await db.execute(sql`SELECT id, "customerNo" AS no, last_update AS lu, credit_limit_enabled AS a,
                credit_limit_amount AS n, credit_age_limit_enabled AS ha, credit_age_limit_days AS h
            FROM ${customer} WHERE ${CATATAN} ILIKE '%hendra%'`)).rows as Rec[]).map((r) => ({
            id: Number(r.id), customerNo: teks(r.no), lastUpdate: teks(r.lu),
            aktif: benar(r.a), nilai: angka(r.n), hariAktif: benar(r.ha), hari: angka(r.h),
        })),
        perMenit: async () => {
            // lastUpdate Accurate = teks dd/MM/yyyy HH:mm:ss WIB (+07:00, lib/accurate-invoice); nilai fallback ISO dilewati.
            const rows = (await db.execute(sql`SELECT left(last_update, 16) AS menit, count(*)::int AS n FROM ${customer}
                WHERE last_update ~ '^\\d{2}/\\d{2}/\\d{4} \\d{2}:\\d{2}' GROUP BY 1 HAVING count(*) >= 5`)).rows as { menit: string; n: number }[];
            const m = new Map<number, number>();
            for (const r of rows) {
                const t = parseAccurateDateTime(r.menit);
                if (t) m.set(Math.floor(t.getTime() / 60_000), r.n);
            }
            return m;
        },
        acuan: async () => new Map((await db.select().from(limitHendraAcuan)).map((a) => [a.customerId,
            { aktif: a.limitAktif, nilai: a.limitNilai, hariAktif: a.hariAktif, hari: a.hariNilai }])),
        syncPenuh: async () => {
            const [s] = (await db.execute(sql`SELECT last_sync_timestamp AS t FROM ${syncState} WHERE module = 'customer'`)).rows as { t: string | null }[];
            const t = s?.t ? new Date(s.t) : null;
            return t && !Number.isNaN(t.getTime()) ? t : null;
        },
        simpanAcuan: async (k, sumber) => {
            const nilai = { customerNo: k.customerNo, limitAktif: k.aktif, limitNilai: k.nilai, hariAktif: k.hariAktif, hariNilai: k.hari,
                acuanLastUpdate: k.lastUpdate, sumber, diperbaruiPada: new Date() };
            await db.insert(limitHendraAcuan).values({ customerId: k.id, ...nilai })
                .onConflictDoUpdate({ target: limitHendraAcuan.customerId, set: nilai });
        },
        catatPulih: async (id, dari) => {
            await db.execute(sql`UPDATE ${limitHendraAcuan} SET terakhir_dipulihkan_pada = now(),
                terakhir_dipulihkan_dari = ${JSON.stringify(dari)}::jsonb, jumlah_dipulihkan = jumlah_dipulihkan + 1
                WHERE customer_id = ${id}`);
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
