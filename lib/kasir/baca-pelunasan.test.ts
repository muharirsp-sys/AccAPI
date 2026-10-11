/* K1b pelaksana pembaca pelunasan (lib/kasir/baca-pelunasan.ts) dengan SIMULATOR Accurate (fetch tiruan) + toko tiruan berlease
 * (aturan token = tokoPg; SQL-nya diuji di baca-pg.test.ts). Jam & tidur disuntik (tanpa menunggu nyata). Jaringan nyata DILARANG. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    bacaPelunasanHari, belumDibaca, JEDA_LENGKAP_DETIK, jawabanSegarkan, LEASE_DETIK, type DepsBaca, type HasilBaca, type StatusBaca, type TokoBaca,
} from "./baca-pelunasan.ts";
import { PESAN_SESI_SINKRON, type Ditolak } from "./pembaca.ts";
import type { Pelunasan } from "./rekonsiliasi.ts";

const D = "2026-10-05";
const DA = "05/10/2026";
const DB = "DB-UJI";
const KRED = { creds: { sessionHost: "https://sim.accurate.invalid", sessionId: "SESI-RAHASIA-1", apiKey: "TOKEN-RAHASIA-1", databaseId: DB } };

type Jam = { t: number };
type Row = { status: StatusBaca["status"]; token: string | null; mulai: number; selesai: number | null; lengkap: number | null; sebab: string | null;
    pesan: string | null; jumlahDaftar: number | null; sisaDetail: number | null; ditolak: Ditolak[]; pemicu: string };

/** Toko tiruan: lease 2 mnt + jeda lengkap 60 dtk menurut `jam`, token dicek di setiap tulis (sama dengan tokoPg). */
function tokoTiruan(jam: Jam) {
    const rows = new Map<string, Row>();
    const cache = new Map<number, { tanggal: string; lastUpdate: string | null; p: Pelunasan }>();
    const tulisan: number[] = [];
    const ke = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    const status = (tanggal: string): StatusBaca => {
        const r = rows.get(tanggal);
        return r ? { databaseId: DB, tanggal, status: r.status, aktif: r.status === "berjalan" && jam.t - r.mulai < LEASE_DETIK * 1000,
            sebab: r.sebab as StatusBaca["sebab"], pesan: r.pesan, jumlahDaftar: r.jumlahDaftar, sisaDetail: r.sisaDetail, ditolak: r.ditolak,
            mulaiPada: ke(r.mulai), selesaiPada: ke(r.selesai), lengkapPada: ke(r.lengkap), pemicu: r.pemicu } : belumDibaca(DB, tanggal);
    };
    const sah = (tanggal: string, token: string) => rows.get(tanggal)?.token === token && rows.get(tanggal)?.status === "berjalan";
    const toko: TokoBaca = {
        async klaim({ tanggal, token, pemicu, penuh }) {
            const r = rows.get(tanggal);
            const aktif = r?.status === "berjalan" && jam.t - r.mulai < LEASE_DETIK * 1000;
            const jeda = !penuh && r?.status === "lengkap" && jam.t - (r.selesai ?? 0) < JEDA_LENGKAP_DETIK * 1000;
            if (aktif || jeda) return { diklaim: false, status: status(tanggal) };
            rows.set(tanggal, { jumlahDaftar: null, sisaDetail: null, ditolak: [], lengkap: null, ...r, status: "berjalan", token, mulai: jam.t,
                selesai: null, sebab: null, pesan: null, pemicu });
            return { diklaim: true };
        },
        status: async (_db, tanggal) => status(tanggal),
        cache: async (_db, tanggal) => new Map([...cache].filter(([, v]) => v.tanggal === tanggal).map(([id, v]) => [id, v.lastUpdate])),
        async tandaiBasi(token, _db, tanggal) {
            if (!sah(tanggal, token)) return false;
            for (const v of cache.values()) if (v.tanggal === tanggal) v.lastUpdate = null;
            return true;
        },
        async tulis(token, _db, p, lastUpdate) {
            if (!sah(p.tanggal, token)) return false;
            cache.set(p.id, { tanggal: p.tanggal, lastUpdate, p });
            tulisan.push(p.id);
            return true;
        },
        async hapus(token, _db, tanggal, ids) {
            if (!sah(tanggal, token)) return false;
            for (const id of ids) if (cache.get(id)?.tanggal === tanggal) cache.delete(id);
            return true;
        },
        async selesai(token, _db, tanggal, a, ditolak) {
            if (!sah(tanggal, token)) return null;
            const r = rows.get(tanggal)!;
            Object.assign(r, { status: a.status, sebab: a.sebab, pesan: a.pesan, jumlahDaftar: a.jumlahDaftar, sisaDetail: a.sisaDetail, ditolak,
                token: null, selesai: jam.t, lengkap: a.status === "lengkap" ? jam.t : r.lengkap });
            return status(tanggal);
        },
    };
    return { toko, rows, cache, tulisan };
}

type PelSim = { id: number; lastUpdate: string; transDate?: string; cheque?: number | string; detail?: unknown };
type Panggilan = { jenis: "list" | "detail"; id?: number; page?: number; ke: number };
type Aturan = (p: Panggilan) => Response | Error | undefined;

/** Simulator Accurate: list.do (100/halaman, filter transDate, rowCount/pageCount) + detail.do; `aturan` menyuntik 401/429/timeout. */
function simulator(jam: Jam, data: PelSim[], aturan: Aturan = () => undefined, opsi: { msPerDetail?: number } = {}) {
    const log: Panggilan[] = [];
    let aktif = 0;
    let maksAktif = 0;
    const pasca429: { aktif: number; maks: number; mulai: boolean } = { aktif: 0, maks: 0, mulai: false };
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
    const fetch: DepsBaca["fetch"] = async (url, init) => {
        const u = new URL(url);
        assert.equal(u.origin, "https://sim.accurate.invalid", "hanya simulator");
        assert.equal((init.headers as Record<string, string>).Authorization, "Bearer TOKEN-RAHASIA-1");
        const jenis = u.pathname.endsWith("/sales-receipt/list.do") ? "list" : u.pathname.endsWith("/sales-receipt/detail.do") ? "detail" : null;
        assert.ok(jenis, `panggilan tak terduga ${u.pathname}`);
        const p: Panggilan = { jenis, ke: log.length + 1, ...(jenis === "detail" ? { id: Number(u.searchParams.get("id")) } : { page: Number(u.searchParams.get("sp.page")) }) };
        log.push(p);
        const setelah429 = pasca429.mulai;
        aktif++;
        maksAktif = Math.max(maksAktif, aktif);
        if (setelah429) pasca429.maks = Math.max(pasca429.maks, ++pasca429.aktif);
        try {
            await new Promise((r) => setTimeout(r, 2));
            if (jenis === "detail") jam.t += opsi.msPerDetail ?? 0;
            const paksa = aturan(p);
            if (paksa instanceof Error) throw paksa;
            if (paksa) {
                if (paksa.status === 429) pasca429.mulai = true;
                return paksa;
            }
            if (jenis === "list") {
                assert.equal(u.searchParams.get("fields"), "id,number,transDate,paymentMethod,chequeAmount,lastUpdate");
                assert.equal(u.searchParams.get("sp.sort"), "id|asc");
                const hari = data.filter((x) => (x.transDate ?? DA) === u.searchParams.get("filter.transDate.val"));
                const hal = hari.slice((p.page! - 1) * 100, p.page! * 100);
                return json({ s: true, d: hal.map((x) => ({ id: x.id, number: `SR/${x.id}`, transDate: x.transDate ?? DA, lastUpdate: x.lastUpdate })),
                    sp: { rowCount: hari.length, pageCount: Math.ceil(hari.length / 100) } });
            }
            const x = data.find((y) => y.id === p.id);
            if (!x) return json({ s: false, d: ["Data tidak ditemukan"] });
            return json({ s: true, d: x.detail ?? { id: x.id, number: `SR/${x.id}`, transDate: x.transDate ?? DA, paymentMethod: "CASH_OTHER",
                chequeAmount: x.cheque ?? 1000.5, detailInvoice: [{ invoiceId: x.id * 10, invoice: { id: x.id * 10, number: `INV/${x.id}`, masterSalesmanId: 11 },
                    invoicePayment: x.cheque ?? 1000.5 }] } });
        } finally {
            aktif--;
            if (setelah429) pasca429.aktif--;
        }
    };
    return { fetch, log, detail: () => log.filter((x) => x.jenis === "detail"), list: () => log.filter((x) => x.jenis === "list"),
        maksAktif: () => maksAktif, pasca429 };
}

function siapkan(data: PelSim[], aturan?: Aturan, opsi: { msPerDetail?: number; kredensial?: DepsBaca["kredensial"] } = {}) {
    const jam: Jam = { t: Date.parse("2026-10-05T10:00:00Z") };
    const t = tokoTiruan(jam);
    const s = simulator(jam, data, aturan, opsi);
    const tidur: number[] = [];
    let n = 0;
    const deps: DepsBaca = {
        kredensial: opsi.kredensial ?? (async () => KRED), toko: () => t.toko, fetch: s.fetch,
        tidur: async (ms) => { tidur.push(ms); jam.t += ms; }, sekarang: () => jam.t, token: () => `tok-${++n}`,
    };
    const baca = (o: { penuh?: boolean; batasMs?: number } = {}) => bacaPelunasanHari({ tanggal: D, pemicu: "uji", ...o }, deps);
    return { jam, t, s, tidur, deps, baca, majuMenit: (m: number) => { jam.t += m * 60_000; } };
}

const lu = (id: number, v = 0) => `05/10/2026 09:${String(id % 60).padStart(2, "0")}:${String(v).padStart(2, "0")}`;
const hari = (n: number, mulai = 1) => Array.from({ length: n }, (_, i) => ({ id: mulai + i, lastUpdate: lu(mulai + i) }));
const status = (h: HasilBaca) => {
    assert.ok(h.jenis !== "kredensial", `hasil ${JSON.stringify(h)}`);
    return h.status;
};

test("putaran pertama lengkap; putaran kedua tanpa perubahan = 0 detail (hanya daftar); < 60 dtk = tanpa Accurate sama sekali", async () => {
    const x = siapkan(hari(130));
    const h1 = await x.baca();
    assert.equal(h1.jenis, "selesai");
    assert.deepEqual([status(h1).status, status(h1).jumlahDaftar, status(h1).sisaDetail, status(h1).sebab], ["lengkap", 130, 0, null]);
    assert.ok(status(h1).lengkapPada);
    assert.deepEqual(x.s.list().map((p) => p.page), [1, 2]);
    assert.equal(x.s.detail().length, 130);
    assert.ok(x.s.maksAktif() <= 4, "≤ 4 panggilan serentak");
    assert.deepEqual(x.tidur.filter((ms) => ms === 150).length, 1, "jeda 150 ms antarhalaman daftar");
    const p = x.t.cache.get(7)!;
    assert.deepEqual([p.lastUpdate, p.p.chequeAmount, p.p.faktur[0].invoicePayment, p.p.faktur[0].masterSalesmanId], [lu(7), 100050, 100050, 11]);

    const jeda = await x.baca();
    assert.equal(jeda.jenis, "jeda_lengkap");
    assert.equal(x.s.log.length, 132, "jeda lengkap: tanpa panggilan Accurate");
    x.majuMenit(2);
    const h2 = await x.baca();
    assert.equal(status(h2).status, "lengkap");
    assert.equal(x.s.detail().length, 130, "putaran kedua: 0 detail");
    assert.equal(x.s.list().length, 4, "putaran kedua: hanya daftar");
});

test("inkremental per id: lastUpdate beda -> dibaca ulang; pelunasan hilang -> dihapus dari cache (daftar lengkap)", async () => {
    const data = hari(5);
    const x = siapkan(data);
    await x.baca();
    x.majuMenit(2);
    data[1].lastUpdate = lu(2, 30);
    data[1].cheque = 777;
    data.splice(3, 1); // id 4 dihapus di Accurate
    data.push({ id: 99, lastUpdate: lu(99) });
    const h = await x.baca();
    assert.equal(status(h).status, "lengkap");
    assert.deepEqual(x.s.detail().slice(5).map((p) => p.id).sort((a, b) => a - b), [2, 99]);
    assert.equal(x.t.cache.get(2)!.p.chequeAmount, 77700);
    assert.equal(x.t.cache.has(4), false, "hilang di Accurate = dihapus");
    assert.deepEqual([...x.t.cache.keys()].sort((a, b) => a - b), [1, 2, 3, 5, 99]);
});

test("429 -> ulang 0,5 dtk (Retry-After dihormati) dan konkurensi TURUN ke 2 sampai akhir putaran", async () => {
    const sudah = new Set<number>();
    const sekali429 = (id: number) => !sudah.has(id) && Boolean(sudah.add(id));
    const x = siapkan(hari(40), (p) => (p.jenis === "detail" && p.id === 3 && sekali429(3) ? new Response("{}", { status: 429 })
        : p.jenis === "detail" && p.id === 9 && sekali429(9) ? new Response("{}", { status: 429, headers: { "retry-after": "3" } }) : undefined));
    const h = await x.baca();
    assert.equal(status(h).status, "lengkap");
    assert.ok(x.tidur.includes(500), `jeda 0,5 dtk: ${x.tidur.join(",")}`);
    assert.ok(x.tidur.includes(3000), "Retry-After 3 dtk dihormati");
    assert.ok(x.s.pasca429.maks <= 2, `sesudah 429 panggilan serentak ≤ 2 (teramati ${x.s.pasca429.maks})`);
    assert.ok(x.s.maksAktif() > 2, "sebelum 429 memang > 2 serentak (uji bermakna)");
    assert.equal(x.t.cache.size, 40);
});

test("429 terus-menerus -> 3× ulang lalu gagal batas_laju; 5xx 3× ulang; tidak_pasti 1× ulang", async () => {
    const terus = siapkan(hari(1), (p) => (p.jenis === "detail" ? new Response("{}", { status: 429 }) : undefined));
    const h = await terus.baca();
    assert.deepEqual([status(h).status, status(h).sebab], ["gagal", "batas_laju"]);
    assert.equal(terus.s.detail().length, 4, "1 + 3 ulang");
    assert.deepEqual(terus.tidur.filter((ms) => ms !== 150), [500, 1000, 2000]);

    let n5 = 0;
    const sekali5 = siapkan(hari(2), (p) => (p.jenis === "detail" && n5++ < 2 ? new Response("<html>", { status: 502 }) : undefined));
    assert.equal(status(await sekali5.baca()).status, "lengkap", "5xx sementara pulih dengan ulang");
    const lima = siapkan(hari(1), (p) => (p.jenis === "detail" ? new Response("x", { status: 503 }) : undefined));
    const h5 = await lima.baca();
    assert.deepEqual([status(h5).sebab, lima.s.detail().length], ["accurate_5xx", 4]);
    const putus = siapkan(hari(1), (p) => (p.jenis === "list" ? new TypeError("fetch failed") : undefined));
    assert.deepEqual([status(await putus.baca()).sebab, putus.s.list().length], ["jaringan", 4]);
});

test("timeout -> ulang 1× lalu gagal tidak_pasti — BUKAN lengkap", async () => {
    const x = siapkan(hari(3), (p) => (p.jenis === "detail" && p.id === 2 ? new DOMException("timeout", "TimeoutError") : undefined));
    const h = await x.baca();
    assert.deepEqual([status(h).status, status(h).sebab], ["gagal", "tidak_pasti"]);
    assert.equal(x.s.detail().filter((p) => p.id === 2).length, 2, "tepat satu ulang");
    assert.equal(status(h).lengkapPada, null);
    const bukanJson = siapkan(hari(1), (p) => (p.jenis === "list" ? new Response("<html>login</html>", { status: 200 }) : undefined));
    assert.deepEqual([status(await bukanJson.baca()).sebab, bukanJson.s.list().length], ["tidak_pasti", 2]);
});

test("401 di tengah -> BERHENTI seketika tanpa ulang, status gagal/sesi_sinkron, cache utuh, lengkap_pada tidak mundur", async () => {
    const data = hari(30);
    const x = siapkan(data);
    await x.baca();
    const lengkapAwal = x.t.rows.get(D)!.lengkap;
    const cacheAwal = new Map([...x.t.cache].map(([id, v]) => [id, v.lastUpdate]));
    x.majuMenit(2);
    data.forEach((b, i) => { b.lastUpdate = lu(b.id, 40 + (i % 10)); }); // semua berubah -> semua perlu detail
    let detailKe = 0; // simulator baru di atas toko yang SAMA
    Object.assign(x.deps, { fetch: simulator(x.jam, data, (p) => (p.jenis === "detail" && ++detailKe === 6 ? new Response("{}", { status: 401 }) : undefined)).fetch });
    const h = await x.baca();
    assert.deepEqual([status(h).status, status(h).sebab], ["gagal", "sesi_sinkron"]);
    assert.equal(status(h).lengkapPada, new Date(lengkapAwal!).toISOString(), "lengkap_pada tidak dimundurkan");
    assert.ok(detailKe <= 6 + 3, `berhenti seketika: ${detailKe} detail (≤ panggilan yang sudah terbang)`);
    assert.deepEqual([...x.t.cache.keys()].sort((a, b) => a - b), [...cacheAwal.keys()].sort((a, b) => a - b), "tidak ada yang terhapus");
    assert.deepEqual(jawabanSegarkan(h), { http: 503, body: { ok: false, kode: "SESI_SINKRON", error: PESAN_SESI_SINKRON, status: status(h) } });

    // 401 pada daftar: tidak satu pun detail, cache utuh walau Accurate kini berisi lebih sedikit.
    x.majuMenit(5);
    data.splice(0, 10);
    Object.assign(x.deps, { fetch: simulator(x.jam, data, (p) => (p.jenis === "list" ? new Response("{}", { status: 401 }) : undefined)).fetch });
    const hl = await x.baca();
    assert.deepEqual([status(hl).sebab, status(hl).jumlahDaftar], ["sesi_sinkron", null]);
    assert.equal(x.t.cache.size, 30, "galat daftar tidak menghapus apa pun");
});

test("403 = hak_akses berhenti tanpa ulang; detail s:false = ditolak terlihat; nominal 3 desimal = DITOLAK (K-3: tak pernah lengkap)", async () => {
    const h403 = siapkan(hari(3), (p) => (p.jenis === "detail" ? new Response("{}", { status: 403 }) : undefined));
    const a = await h403.baca();
    assert.deepEqual([status(a).sebab, h403.s.detail().length <= 3], ["hak_akses", true]);
    assert.ok(!h403.tidur.some((ms) => ms !== 150), "tanpa jeda ulang");

    const data: PelSim[] = [...hari(3), { id: 50, lastUpdate: lu(50), cheque: 1000.125 }];
    const x = siapkan(data, (p) => (p.jenis === "detail" && p.id === 2 ? new Response(JSON.stringify({ s: false, d: ["Token TOKEN-RAHASIA-1 tidak berhak"] })) : undefined));
    const h = await x.baca();
    assert.deepEqual([status(h).status, status(h).sebab, status(h).sisaDetail], ["gagal", "ditolak", 2]);
    assert.deepEqual(status(h).ditolak.map((d) => [d.nomor, d.sebab]).sort(), [["SR/2", "ditolak"], ["SR/50", "nominal"]]);
    assert.ok(!JSON.stringify(status(h)).includes("TOKEN-RAHASIA-1"), "pesan tanpa token");
    assert.deepEqual([...x.t.cache.keys()].sort((m, n) => m - n), [1, 3], "yang sah tetap ditulis");
    assert.equal(jawabanSegarkan(h).http, 502);
    x.majuMenit(2);
    const ulang = await x.baca();
    assert.equal(status(ulang).status, "gagal", "pelunasan rusak dibaca ulang dan tetap ditolak sampai diperbaiki di Accurate");
    assert.deepEqual(x.s.detail().slice(4).map((p) => p.id).sort((m, n) => m - n), [2, 50], "hanya yang belum tercache dibaca ulang");
});

test("daftar terpotong / bergeser -> gagal, TIDAK menghapus cache dan tidak membaca detail", async () => {
    const data = hari(4);
    const x = siapkan(data);
    await x.baca();
    x.majuMenit(2);
    data.splice(0, 2); // Accurate kini 2 pelunasan, tapi daftarnya rusak
    Object.assign(x.deps, { fetch: simulator(x.jam, data, (p) => (p.jenis === "list" ? new Response(JSON.stringify({ s: true, d: [], sp: { rowCount: 2 } })) : undefined)).fetch });
    const h = await x.baca();
    assert.deepEqual([status(h).status, status(h).sebab], ["gagal", "terpotong"]);
    assert.equal(x.t.cache.size, 4, "daftar terpotong tidak pernah menghapus");
});

test("batas waktu -> 200 sebagian + sisa_detail ('Membaca n/N'), panggilan berikut melanjutkan sampai lengkap", async () => {
    const x = siapkan(hari(20), undefined, { msPerDetail: 5_000 });
    const h1 = await x.baca({ batasMs: 45_000 });
    const s1 = status(h1);
    assert.equal(s1.status, "sebagian");
    assert.ok(s1.sisaDetail! > 0 && s1.sisaDetail! < 20, `sisa ${s1.sisaDetail}`);
    assert.equal(s1.pesan, `Membaca ${20 - s1.sisaDetail!}/20`);
    assert.equal(jawabanSegarkan(h1).http, 200);
    assert.equal(s1.lengkapPada, null);
    let h = h1;
    for (let i = 0; i < 5 && status(h).status === "sebagian"; i++) h = await x.baca({ batasMs: 45_000 });
    assert.equal(status(h).status, "lengkap");
    assert.equal(new Set(x.s.detail().map((p) => p.id)).size, 20);
    assert.ok(x.s.detail().length < 20 + 8, "lanjutan tidak membaca ulang yang sudah tercache");
});

test("penuh: semua detail dibaca ulang; terputus batas waktu -> lanjutan (bukan penuh) tetap membaca sisa yang basi", async () => {
    const x = siapkan(hari(12));
    await x.baca();
    assert.equal(x.s.detail().length, 12);
    const jeda = await x.baca({ penuh: true });
    assert.equal(status(jeda).status, "lengkap", "penuh mengabaikan jeda 60 dtk");
    assert.equal(x.s.detail().length, 24);
    Object.assign(x.deps, { fetch: simulator(x.jam, hari(12), undefined, { msPerDetail: 10_000 }).fetch });
    x.majuMenit(2);
    const h = await x.baca({ penuh: true, batasMs: 30_000 });
    assert.equal(status(h).status, "sebagian", "penuh yang terputus BUKAN lengkap walau lastUpdate tak berubah");
    let akhir = h;
    for (let i = 0; i < 6 && status(akhir).status === "sebagian"; i++) akhir = await x.baca({ batasMs: 30_000 });
    assert.equal(status(akhir).status, "lengkap");
    assert.ok([...x.t.cache.values()].every((v) => v.lastUpdate !== null));
});

test("transDate berubah sesudah daftar -> tidak ditulis, sebagian (bukan lengkap)", async () => {
    const x = siapkan([...hari(2), { id: 9, lastUpdate: lu(9), detail: { id: 9, number: "SR/9", transDate: "06/10/2026", paymentMethod: "CASH_OTHER",
        chequeAmount: 1, detailInvoice: [] } }]);
    const h = await x.baca();
    assert.deepEqual([status(h).status, status(h).sisaDetail, x.t.cache.has(9)], ["sebagian", 1, false]);
});

test("kredensial absen / database kosong -> 503 SESI_SINKRON tanpa Accurate dan tanpa baris status; lease aktif -> 409; lease basi direbut", async () => {
    const tanpa = siapkan(hari(2), undefined, { kredensial: async () => ({ error: "Tidak ada sesi Accurate milik admin." }) });
    const h = await tanpa.baca();
    assert.equal(h.jenis, "kredensial");
    assert.deepEqual(jawabanSegarkan(h), { http: 503, body: { ok: false, kode: "SESI_SINKRON", error: PESAN_SESI_SINKRON, detail: "Tidak ada sesi Accurate milik admin." } });
    assert.equal(tanpa.s.log.length, 0);
    assert.equal(tanpa.t.rows.size, 0);
    const kosong = siapkan(hari(2), undefined, { kredensial: async () => ({ creds: { ...KRED.creds, databaseId: " " } }) });
    assert.equal((await kosong.baca()).jenis, "kredensial");

    const x = siapkan(hari(2));
    await x.t.toko.klaim({ databaseId: DB, tanggal: D, token: "orang-lain", pemicu: "cron", penuh: false });
    const sibuk = await x.baca();
    assert.equal(sibuk.jenis, "sedang_dibaca");
    assert.equal(jawabanSegarkan(sibuk).http, 409);
    assert.equal((jawabanSegarkan(sibuk).body as { kode: string }).kode, "SEDANG_DIBACA");
    assert.equal(x.s.log.length, 0);
    x.majuMenit(3); // pembaca lain mati tanpa selesai: lease kedaluwarsa
    assert.equal(status(await x.baca()).status, "lengkap");
    assert.equal(await x.t.toko.tulis("orang-lain", DB, x.t.cache.get(1)!.p, "x"), false, "token basi tidak menimpa");
});
