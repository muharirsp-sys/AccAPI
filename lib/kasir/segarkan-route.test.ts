/* K1b route POST/GET /api/kasir/segarkan + GET /api/cron/kasir-pelunasan tanpa DB: sesi & izin dipalsukan (tanpa bypass lokal), dependensi
 * pelaksana (`bawaan`: kredensial, toko, fetch, jam) diganti tiruan lalu dipulihkan; fetch global & jaringan nyata DILARANG. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET as getSegarkan, POST as postSegarkan } from "../../app/api/kasir/segarkan/route.ts";
import { GET as getCron } from "../../app/api/cron/kasir-pelunasan/route.ts";
import { bawaan, belumDibaca, publikkan, type DepsBaca, type StatusBaca, type TokoBaca } from "./baca-pelunasan.ts";
import { PESAN_SESI_SINKRON, tanggalCron } from "./pembaca.ts";
import { tokoTiruan } from "./uji-toko-tiruan.ts";
import { todayWita } from "../insentif-payment-date.ts";
import { auth } from "../auth.ts";
import { db } from "../db.ts";

const D = "2026-10-05";
const DB = "DB-UJI";
const KRED = { creds: { sessionHost: "https://sim.accurate.invalid", sessionId: "S", apiKey: "T", databaseId: DB } };

/** Rantai db.select tiruan: tiap select() memakai jawaban berikutnya dari antrean (izin dulu, lalu sesi sinkron). */
function selectTiruan(antrean: unknown[][]) {
    return () => {
        const hasil = antrean.shift() ?? [];
        const rantai: Record<string, unknown> = {};
        for (const m of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"]) rantai[m] = () => rantai;
        rantai.then = (ok: (v: unknown) => unknown, gagal: (e: unknown) => unknown) => Promise.resolve(hasil).then(ok, gagal);
        return rantai;
    };
}

async function dengan<T>(o: { sesi?: boolean; izin?: string[]; select?: unknown[][]; deps?: Partial<DepsBaca>; env?: Record<string, string | undefined> },
    fn: () => Promise<T>): Promise<T> {
    const simpan = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [db, "execute", Object.getOwnPropertyDescriptor(db, "execute")],
        [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
    ] as const;
    const depsLama = { ...bawaan };
    const envLama = Object.fromEntries(["LOCAL_AUTH_BYPASS", "CRON_SECRET", "ACCURATE_SYNC_USER_ID", ...Object.keys(o.env ?? {})].map((k) => [k, process.env[k]]));
    delete process.env.LOCAL_AUTH_BYPASS;
    delete process.env.ACCURATE_SYNC_USER_ID;
    for (const [k, v] of Object.entries(o.env ?? {})) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => (o.sesi === false ? null : { user: { id: "u-kasir", role: "staff" }, session: { id: "s1" } }) });
    Object.defineProperty(db, "select", { configurable: true, value: selectTiruan([(o.izin ?? []).map((key) => ({ groupId: "g1", key })), ...(o.select ?? [])]) });
    Object.defineProperty(db, "execute", { configurable: true, value: async () => ({ rows: [], rowCount: 0 }) });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => { throw new Error("TIDAK BOLEH ke jaringan"); } });
    Object.assign(bawaan, { fetch: () => { throw new Error("TIDAK BOLEH ke Accurate (fetch bawaan)"); }, kredensial: async () => ({ error: "uji: kredensial tidak disuntik" }),
        sesi: async () => ({ userId: "", databaseId: "" }), nama: async () => new Map<string, string>(),
        toko: () => { throw new Error("uji: toko tidak disuntik"); } }, o.deps ?? {});
    try {
        return await fn();
    } finally {
        Object.assign(bawaan, depsLama);
        for (const [obj, k, d] of simpan) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        for (const [k, v] of Object.entries(envLama)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
}

const post = (body: unknown) => new NextRequest("http://app.test/api/kasir/segarkan", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const get = (qs: string) => new NextRequest(`http://app.test/api/kasir/segarkan${qs}`);
const cron = (qs: string, rahasia?: string) => new Request(`http://app.test/api/cron/kasir-pelunasan${qs}`, { headers: rahasia ? { authorization: `Bearer ${rahasia}` } : {} });

const st = (o: Partial<StatusBaca>): StatusBaca => ({ ...belumDibaca(DB, D), ...o });
/** Toko tiruan minimal: klaim menurut `klaim`; tulis selalu sah; selesai memantulkan status akhir. */
function toko(klaim: Awaited<ReturnType<TokoBaca["klaim"]>> = { diklaim: true }): TokoBaca & { selesaiDipanggil: number } {
    const t = {
        selesaiDipanggil: 0,
        klaim: async () => klaim,
        status: async () => st({ status: "berjalan", aktif: false }),
        cache: async () => new Map<number, string | null>(),
        tandaiBasi: async () => true, tulis: async () => true, hapus: async () => true, nomor: async () => new Map<number, string>(),
        selesai: async (_t: string, _d: string, tanggal: string, a: Parameters<TokoBaca["selesai"]>[3], ditolak: Parameters<TokoBaca["selesai"]>[4]) => {
            t.selesaiDipanggil++;
            return st({ tanggal, status: a.status, sebab: a.sebab, pesan: a.pesan, jumlahDaftar: a.jumlahDaftar, sisaDetail: a.sisaDetail, ditolak,
                lengkapPada: a.status === "lengkap" ? "2026-10-05T10:00:00.000Z" : null });
        },
    };
    return t;
}
const jawab = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
const daftarKosong = jawab({ s: true, d: [], sp: { rowCount: 0, pageCount: 0 } });

test("segarkan: tanpa sesi 401, tanpa kasir.view 403 — sebelum Accurate/DB", async () => {
    const r401 = await dengan({ sesi: false }, () => postSegarkan(post({ tanggal: D })));
    assert.equal(r401.status, 401);
    const r403 = await dengan({ izin: ["kasir.catat", "pelunasan.view"] }, () => postSegarkan(post({ tanggal: D })));
    assert.equal(r403.status, 403);
    const g403 = await dengan({ izin: ["dashboard.view"] }, () => getSegarkan(get(`?tanggal=${D}`)));
    assert.equal(g403.status, 403);
});

test("segarkan: tanggal salah / belum tiba -> 400 sebelum Accurate", async () => {
    for (const body of [{}, { tanggal: "05/10/2026" }, { tanggal: "2026-02-30" }, { tanggal: "2999-01-01" }]) {
        const r = await dengan({ izin: ["kasir.view"] }, () => postSegarkan(post(body)));
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal((await r.json() as { ok: boolean }).ok, false);
    }
    assert.equal((await dengan({ izin: ["kasir.view"] }, () => getSegarkan(get("?tanggal=x")))).status, 400);
});

test("segarkan: sesi sinkron mati -> 503 BERKODE SESI_SINKRON dengan pesan admin (bukan 0 pelunasan)", async () => {
    const r = await dengan({ izin: ["kasir.view"], deps: { kredensial: async () => ({ error: "Tidak ada access token Accurate." }) } }, () => postSegarkan(post({ tanggal: D })));
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false, kode: "SESI_SINKRON", error: PESAN_SESI_SINKRON, detail: "Tidak ada access token Accurate." });
    // Accurate 401 di tengah putaran (token sinkron kedaluwarsa) -> status gagal tersimpan + 503 berkode.
    const t = toko();
    const r2 = await dengan({ izin: ["kasir.view"], deps: { kredensial: async () => KRED, toko: () => t, fetch: jawab({}, 401) } }, () => postSegarkan(post({ tanggal: D })));
    assert.equal(r2.status, 503);
    const b2 = await r2.json() as { kode: string; status: StatusBaca };
    assert.deepEqual([b2.kode, b2.status.status, b2.status.sebab, t.selesaiDipanggil], ["SESI_SINKRON", "gagal", "sesi_sinkron", 1]);
    // GET status tanpa sesi sinkron sama sekali -> 503 berkode (tanpa Accurate).
    const g = await dengan({ izin: ["kasir.view"], select: [[]] }, () => getSegarkan(get(`?tanggal=${D}`)));
    assert.equal(g.status, 503);
    assert.equal((await g.json() as { kode: string }).kode, "SESI_SINKRON");
});

test("segarkan: lease dipegang -> 409 SEDANG_DIBACA + status; lengkap < 60 dtk -> 200 tanpa Accurate (fetch dilarang)", async () => {
    const sibuk = st({ status: "berjalan", aktif: true, mulaiPada: "2026-10-05T10:00:00.000Z", pemicu: "cron" });
    const r = await dengan({ izin: ["kasir.view"], deps: { kredensial: async () => KRED, toko: () => toko({ diklaim: false, status: sibuk }) } }, () => postSegarkan(post({ tanggal: D })));
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { ok: false, kode: "SEDANG_DIBACA", error: "Pelunasan tanggal ini sedang dibaca — coba lagi sebentar.",
        status: await publikkan(sibuk, { nama: async () => new Map() }) });
    const lengkap = st({ status: "lengkap", jumlahDaftar: 3, sisaDetail: 0, lengkapPada: "2026-10-05T10:00:00.000Z" });
    const j = await dengan({ izin: ["kasir.view"], deps: { kredensial: async () => KRED, toko: () => toko({ diklaim: false, status: lengkap }) } }, () => postSegarkan(post({ tanggal: D })));
    assert.equal(j.status, 200);
    assert.deepEqual(await j.json(), { ok: true, dariCache: true, status: await publikkan(lengkap, { nama: async () => new Map() }) });
});

test("segarkan: putaran sukses -> 200 lengkap; batas waktu -> 200 sebagian + sisa_detail; GET belum_dibaca", async () => {
    const r = await dengan({ izin: ["kasir.view"], deps: { kredensial: async () => KRED, toko: () => toko(), fetch: daftarKosong } }, () => postSegarkan(post({ tanggal: D })));
    assert.equal(r.status, 200);
    const b = await r.json() as { ok: boolean; status: StatusBaca };
    assert.deepEqual([b.ok, b.status.status, b.status.jumlahDaftar, b.status.sisaDetail], [true, "lengkap", 0, 0]);

    let jam = 0;
    const satu = jawab({ s: true, d: [{ id: 1, number: "SR/1", transDate: "05/10/2026", lastUpdate: "05/10/2026 09:00:00" }], sp: { rowCount: 1, pageCount: 1 } });
    const lambat: DepsBaca["fetch"] = async () => { jam += 50_000; return satu(); }; // daftar menghabiskan batas 45 dtk
    const sebagian = await dengan({ izin: ["kasir.view"], deps: { kredensial: async () => KRED, toko: () => toko(), fetch: lambat, sekarang: () => jam } },
        () => postSegarkan(post({ tanggal: D })));
    assert.equal(sebagian.status, 200);
    const s = (await sebagian.json() as { status: StatusBaca }).status;
    assert.deepEqual([s.status, s.jumlahDaftar, s.sisaDetail, s.pesan], ["sebagian", 1, 1, "Membaca 0/1"]);

    const g = await dengan({ izin: ["kasir.view"], select: [[]], env: { ACCURATE_SYNC_USER_ID: "u-sync" } }, async () => {
        Object.defineProperty(db, "select", { configurable: true, value: selectTiruan([[{ groupId: "g1", key: "kasir.view" }], [{ databaseId: DB }]]) });
        return getSegarkan(get(`?tanggal=${D}`));
    });
    assert.equal(g.status, 200);
    assert.deepEqual(await g.json(), { ok: true, status: await publikkan(belumDibaca(DB, D), { nama: async () => new Map() }) });
});

test("cron: tanpa rahasia 401; tanggal salah 400; check=1 tanpa Accurate; semua lengkap 200; sesi mati 503; selain itu 502", async () => {
    const rahasia = "rahasia-cron-uji";
    assert.equal((await dengan({ env: { CRON_SECRET: rahasia } }, () => getCron(cron(`?tanggal=${D}`)))).status, 401);
    assert.equal((await dengan({ env: { CRON_SECRET: rahasia } }, () => getCron(cron(`?tanggal=${D}`, "salah")))).status, 401);
    assert.equal((await dengan({ env: { CRON_SECRET: undefined } }, () => getCron(cron(`?tanggal=${D}`, rahasia)))).status, 401, "CRON_SECRET kosong = tolak");
    assert.equal((await dengan({ env: { CRON_SECRET: rahasia } }, () => getCron(cron("?tanggal=2999-01-01", rahasia)))).status, 400);

    // check=1: izin = select pertama di dengan(); di cron tak ada izin -> antrean pertama dipakai databaseIdSinkron.
    const cek = await dengan({ env: { CRON_SECRET: rahasia } }, async () => {
        Object.defineProperty(db, "select", { configurable: true, value: selectTiruan([[]]) });
        return getCron(cron("?check=1", rahasia));
    });
    assert.equal(cek.status, 200);
    const bc = await cek.json() as { checkOnly: boolean; sesiSinkron: boolean; tanggal: string[] };
    assert.deepEqual([bc.checkOnly, bc.sesiSinkron, bc.tanggal.length >= 2], [true, false, true]);

    const lengkap = await dengan({ env: { CRON_SECRET: rahasia }, deps: { kredensial: async () => KRED, toko: () => toko(), fetch: daftarKosong } },
        () => getCron(cron(`?tanggal=${D}`, rahasia)));
    assert.equal(lengkap.status, 200);
    assert.deepEqual((await lengkap.json() as { hasil: { tanggal: string; status: string }[] }).hasil.map((h) => [h.tanggal, h.status]), [[D, "lengkap"]]);

    const mati = await dengan({ env: { CRON_SECRET: rahasia }, deps: { kredensial: async () => ({ error: "x" }) } }, () => getCron(cron("", rahasia)));
    assert.equal(mati.status, 503);
    assert.equal((await mati.json() as { kode: string }).kode, "SESI_SINKRON");

    const terpotong = jawab({ s: true, d: [], sp: { rowCount: 5 } });
    const gagal = await dengan({ env: { CRON_SECRET: rahasia }, deps: { kredensial: async () => KRED, toko: () => toko(), fetch: terpotong } },
        () => getCron(cron(`?tanggal=${D}`, rahasia)));
    assert.equal(gagal.status, 502);
    assert.deepEqual((await gagal.json() as { hasil: { sebab: string }[] }).hasil.map((h) => h.sebab), ["terpotong"]);
});

test("segarkan: `penuh` / `konfirmasiHapus` hanya pemegang kasir.buka (OM/Admin) — kasir.view saja = 403 sebelum Accurate", async () => {
    for (const body of [{ tanggal: D, penuh: true }, { tanggal: D, konfirmasiHapus: true }]) {
        const r = await dengan({ izin: ["kasir.view", "kasir.catat", "kasir.tutup"] }, () => postSegarkan(post(body)));
        assert.equal(r.status, 403, JSON.stringify(body));
        assert.match(String((await r.json() as { error: string }).error), /kasir\.buka/);
    }
    let opsiTerima: unknown = null;
    const t = toko();
    const klaimAsli = t.klaim;
    t.klaim = async (a) => { opsiTerima = a; return klaimAsli(); };
    const ok = await dengan({ izin: ["kasir.view", "kasir.buka"], deps: { kredensial: async () => KRED, toko: () => t, fetch: daftarKosong } },
        () => postSegarkan(post({ tanggal: D, penuh: true, konfirmasiHapus: true })));
    assert.equal(ok.status, 200);
    assert.equal((opsiTerima as { penuh: boolean }).penuh, true, "penuh diteruskan untuk kasir.buka");
});

test("cron probe B2: penuh=1 serentak dengan cron biasa/tombol yang memegang lease -> penuh MENUNGGU dan tetap jalan untuk SEMUA tanggal", async () => {
    const rahasia = "rahasia-cron-uji";
    const jam = { t: Date.parse("2026-10-05T11:30:00Z") };
    const t = tokoTiruan(jam, DB);
    const daftar = tanggalCron(todayWita(new Date()));
    for (const tanggal of daftar) await t.toko.klaim({ databaseId: DB, tanggal, token: `biasa-${tanggal}`, pemicu: "cron", penuh: false, akun: null });
    let tidurKe = 0;
    const tidur = async (ms: number) => {
        jam.t += ms;
        // Pembaca biasa tanggal pertama selesai sesudah 10 dtk; sisanya mati tanpa selesai (lease kedaluwarsa 2 mnt).
        if (++tidurKe === 2) await t.toko.selesai(`biasa-${daftar[0]}`, DB, daftar[0], { status: "sebagian", sebab: null, pesan: null, jumlahDaftar: null, sisaDetail: null }, []);
    };
    const r = await dengan({ env: { CRON_SECRET: rahasia }, deps: { kredensial: async () => KRED, toko: () => t.toko, fetch: daftarKosong, tidur, sekarang: () => jam.t } },
        () => getCron(cron("?penuh=1", rahasia)));
    const b = await r.json() as { hasil: { tanggal: string; status: string }[] };
    assert.equal(r.status, 200, JSON.stringify(b));
    assert.deepEqual(b.hasil.map((h) => [h.tanggal, h.status]), daftar.map((d) => [d, "lengkap"]));
    assert.deepEqual(t.klaimPenuh, daftar.map((d) => `${d}:cron`), "baca penuh benar-benar jalan untuk SETIAP tanggal");
    assert.ok(tidurKe >= 2, "menunggu lease, bukan langsung menyerah");
});

test("cron: cron biasa bertemu lease tombol = 202 berketerangan (bukan galat); penuh yang menunggu sampai batas = 502 PENUH_TERTUNDA", async () => {
    const rahasia = "rahasia-cron-uji";
    const sibuk = st({ status: "berjalan", aktif: true });
    const biasa = await dengan({ env: { CRON_SECRET: rahasia }, deps: { kredensial: async () => KRED, toko: () => toko({ diklaim: false, status: sibuk }) } },
        () => getCron(cron(`?tanggal=${D}`, rahasia)));
    assert.equal(biasa.status, 202);
    const bb = await biasa.json() as { ok: boolean; hasil: { status: string; keterangan: string; kode?: string }[] };
    assert.deepEqual([bb.ok, bb.hasil[0].status, bb.hasil[0].kode], [true, "sedang_dibaca", undefined]);
    assert.match(bb.hasil[0].keterangan, /bukan galat/);

    const jam = { t: 0 };
    let percobaan = 0;
    const tkSibuk = toko({ diklaim: false, status: sibuk });
    const klaimAsli = tkSibuk.klaim;
    tkSibuk.klaim = async () => { percobaan++; return klaimAsli(); };
    const penuh = await dengan({ env: { CRON_SECRET: rahasia }, deps: { kredensial: async () => KRED, toko: () => tkSibuk,
        tidur: async (ms: number) => { jam.t += ms; }, sekarang: () => jam.t } }, () => getCron(cron(`?tanggal=${D}&penuh=1`, rahasia)));
    assert.equal(penuh.status, 502);
    const bp = await penuh.json() as { hasil: { kode: string }[] };
    assert.equal(bp.hasil[0].kode, "PENUH_TERTUNDA");
    assert.ok(percobaan > 20 && jam.t >= 120_000, `menunggu > lease (percobaan ${percobaan}, ${jam.t} ms)`);
});
