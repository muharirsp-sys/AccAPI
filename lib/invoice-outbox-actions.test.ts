/* S6-0d butir 3 (owner E2): Ditolak tetap Ditolak, TETAPI Antre ulang dan mengantrekan SO yang pernah
 * dibuang SELALU didahului pencarian faktur. Tanpa DB/Accurate: db tiruan mencatat tulisan, pencari
 * tiruan menghitung panggilan. (Uji Postgres sungguhan: lib/invoice-outbox-event.test.ts.) */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { aksiAntrean, antrekan, selesaikanTidakPasti, type Pencari } from "./invoice-outbox-actions.ts";
import type { HasilCari } from "./invoice-search.ts";

const DIBUAT = new Date("2026-10-08T02:00:00Z");

/** db tiruan: select berurutan dari `pilih`; semua tulisan (update/insert/delete) dicatat. */
function dbTiruan(pilih: unknown[][]) {
    const tulis: { op: string; nilai?: unknown }[] = [];
    let i = 0;
    const chain = (hasil: unknown) => {
        const c: Record<string, unknown> = {};
        for (const m of ["from", "where", "orderBy", "limit", "onConflictDoNothing"]) c[m] = () => c;
        c.then = (ok: (v: unknown) => unknown, no: (e: unknown) => unknown) => Promise.resolve(hasil).then(ok, no);
        c.returning = () => Promise.resolve([{ orderId: "K", attempts: 1 }]);
        return c;
    };
    const tx = {
        update: () => ({ set: (nilai: unknown) => { tulis.push({ op: "update", nilai }); return chain([]); } }),
        insert: () => ({ values: (nilai: unknown) => { tulis.push({ op: "insert", nilai }); return chain([]); } }),
        delete: () => { tulis.push({ op: "delete" }); return chain([]); },
    };
    const db = {
        // Penyapu (sapuSending) = execute; tiruan: tidak ada yang tersapu.
        execute: async () => ({ rows: [] }),
        select: () => chain(pilih[i++] ?? []),
        selectDistinct: () => chain(pilih[i++] ?? []),
        transaction: async (cb: (t: typeof tx) => unknown) => cb(tx),
    };
    return { db: db as unknown as NodePgDatabase, tulis };
}

const pencari = (hasil: HasilCari) => {
    const calls: Parameters<Pencari>[0][] = [];
    const cari: Pencari = async (q) => { calls.push(q); return hasil; };
    return { cari, calls };
};
const KETEMU: HasilCari = { hasil: "ketemu", id: "331710", number: "INV/2610/KN00001", sumber: "accurate", semua: [{ id: "331710", number: "INV/2610/KN00001" }] };
const TIDAK: HasilCari = { hasil: "tidak_ketemu_dicek", sumber: "accurate", diperiksa: 2, barisListDo: 2 };
const GAGAL: HasilCari = { hasil: "gagal_cek", alasan: "list.do HTTP 401" };
const BARIS_DITOLAK = [{ state: "rejected", customerNo: "C-1-KN", createdAt: DIBUAT }];

test("Antre ulang: faktur KETEMU -> terposting (id + nomor), TIDAK kembali ke antrean", async () => {
    const { db, tulis } = dbTiruan([BARIS_DITOLAK, [{ first: null }]]);
    const { cari, calls } = pencari(KETEMU);
    const hasil = await aksiAntrean(db, { orderId: "KINO:SO-1", action: "resend", actor: "petugas@contoh", reason: "", cari, targetDb: "DB-1" });
    assert.equal(hasil.status, 200);
    assert.equal(hasil.body.state, "posted");
    assert.deepEqual(calls, [{ orderId: "KINO:SO-1", customerNo: "C-1-KN", queuedAt: DIBUAT }]);
    const ubah = tulis.find((w) => w.op === "update")?.nilai as Record<string, unknown>;
    assert.equal(ubah.state, "posted");
    assert.deepEqual([ubah.accurateDbId, ubah.accurateId, ubah.accurateNumber], ["DB-1", "331710", "INV/2610/KN00001"]);
    assert.ok(!tulis.some((w) => (w.nilai as { state?: string } | undefined)?.state === "queued"), "tidak boleh kembali ke antrean");
    const event = tulis.find((w) => w.op === "insert")?.nilai as { jenis: string; detail: { pencarian: { hasil: string } } }[];
    assert.equal(event[0].jenis, "posted");
    assert.equal(event[0].detail.pencarian.hasil, "ketemu");
});

test("Antre ulang: pencarian GAGAL -> ditolak 409, tidak ada yang ditulis", async () => {
    const { db, tulis } = dbTiruan([BARIS_DITOLAK, [{ first: null }]]);
    const hasil = await aksiAntrean(db, { orderId: "KINO:SO-1", action: "resend", actor: "p", reason: "", cari: pencari(GAGAL).cari, targetDb: "DB-1" });
    assert.equal(hasil.status, 409);
    assert.match(String(hasil.body.error), /tidak bisa memastikan \(list\.do HTTP 401\)/);
    assert.equal(tulis.length, 0);
});

test("Antre ulang: tidak ketemu setelah dicek -> queued + event antre_ulang berisi pencarian", async () => {
    const { db, tulis } = dbTiruan([BARIS_DITOLAK, [{ first: "2026-10-07T23:00:00Z" }]]);
    const { cari, calls } = pencari(TIDAK);
    const hasil = await aksiAntrean(db, { orderId: "KINO:SO-1", action: "resend", actor: "p", reason: "piutang sudah dibayar", cari, targetDb: "DB-1" });
    assert.equal(hasil.status, 200);
    assert.equal(hasil.body.state, "queued");
    // Jendela pencarian dari antre PERTAMA (riwayat), bukan created_at baris sekarang.
    assert.equal(calls[0].queuedAt.toISOString(), "2026-10-07T23:00:00.000Z");
    assert.equal((tulis.find((w) => w.op === "update")?.nilai as { state: string }).state, "queued");
    const [ev] = tulis.find((w) => w.op === "insert")?.nilai as { jenis: string; reason: string; detail: { pencarian: { hasil: string } } }[];
    assert.deepEqual([ev.jenis, ev.reason, ev.detail.pencarian.hasil], ["antre_ulang", "piutang sudah dibayar", "tidak_ketemu_dicek"]);
});

test("Antre ulang tanpa pencari / database tujuan -> 503, tidak ada yang ditulis", async () => {
    const { db, tulis } = dbTiruan([BARIS_DITOLAK, BARIS_DITOLAK]);
    assert.equal((await aksiAntrean(db, { orderId: "K", action: "resend", actor: "p", reason: "" })).status, 503);
    assert.equal((await aksiAntrean(db, { orderId: "K", action: "resend", actor: "p", reason: "", cari: pencari(KETEMU).cari, targetDb: "" })).status, 503);
    assert.equal(tulis.length, 0);
});

test("Antrekan: hanya kunci yang PERNAH dibuang yang dicari; ketemu = baris terposting, gagal = ditahan", async () => {
    const entri = (orderId: string) => ({ orderId, customerNo: "C-1-KN", orderDate: "2026-10-08", payload: { charField1: orderId } });
    for (const [hasilCari, harap] of [[KETEMU, "posted"], [GAGAL, "blocked"], [TIDAK, "queued"]] as const) {
        // select 1 = pernahDibuang (selectDistinct), select 2 = waktuAntrePertama.
        const { db, tulis } = dbTiruan([[{ orderId: "KINO:SO-BUANG" }], [{ first: "2026-10-01T01:00:00Z" }]]);
        const { cari, calls } = pencari(hasilCari);
        const hasil = await antrekan(db, { entries: [entri("KINO:SO-BUANG"), entri("KINO:SO-BARU")], actor: "p", targetDb: "DB-1", cari });
        assert.deepEqual(calls.map((c) => c.orderId), ["KINO:SO-BUANG"], "SO baru tidak perlu dicari");
        assert.equal(calls[0].queuedAt.toISOString(), "2026-10-01T01:00:00.000Z");
        const sisipan = tulis.filter((w) => w.op === "insert").flatMap((w) => [w.nilai].flat() as { orderId: string; state?: string; jenis?: string }[]);
        const baris = sisipan.filter((v) => v.state);
        if (harap === "posted") {
            assert.deepEqual(hasil.posted, [{ orderId: "KINO:SO-BUANG", accurateId: "331710", number: "INV/2610/KN00001" }]);
            assert.ok(baris.some((v) => v.orderId === "KINO:SO-BUANG" && v.state === "posted"));
            assert.ok(!baris.some((v) => v.orderId === "KINO:SO-BUANG" && v.state === "queued"));
        } else if (harap === "blocked") {
            assert.equal(hasil.blocked[0].orderId, "KINO:SO-BUANG");
            assert.match(hasil.blocked[0].reason, /pernah dibuang/);
            assert.ok(!baris.some((v) => v.orderId === "KINO:SO-BUANG"));
        } else {
            assert.ok(baris.some((v) => v.orderId === "KINO:SO-BUANG" && v.state === "queued"));
        }
        assert.ok(baris.some((v) => v.orderId === "KINO:SO-BARU" && v.state === "queued"), "SO baru tetap diantrekan");
    }
});

test("Antrekan: SO pernah dibuang tanpa pencari -> ditahan, tidak diantrekan", async () => {
    const { db, tulis } = dbTiruan([[{ orderId: "KINO:SO-BUANG" }]]);
    const hasil = await antrekan(db, { entries: [{ orderId: "KINO:SO-BUANG", customerNo: "C", orderDate: "2026-10-08", payload: {} }], actor: "p", targetDb: "DB-1", cari: null });
    assert.equal(hasil.blocked.length, 1);
    assert.equal(tulis.length, 0);
});

// ---------------------------------------------------------------- AM-047 Selesaikan tidak pasti
const BARIS_TIDAK_PASTI = [{ state: "unknown", customerNo: "C-1-KN", createdAt: DIBUAT }];
const ALASAN = "Dicek di Accurate: faktur KN00001 ada, tanggal 08/10";

test("Selesaikan: alasan < 15 / keputusan asing / tanpa pencari -> ditolak SEBELUM pencarian, tidak ada yang ditulis", async () => {
    const { db, tulis } = dbTiruan([BARIS_TIDAK_PASTI]);
    const { cari, calls } = pencari(KETEMU);
    const base = { orderId: "KINO:SO-1", actor: "p", cari, targetDb: "DB-1" };
    assert.equal((await selesaikanTidakPasti(db, { ...base, keputusan: "terposting", alasan: "sudah ada" })).status, 400);
    assert.equal((await selesaikanTidakPasti(db, { ...base, keputusan: "kirim_ulang", alasan: ALASAN })).status, 400);
    assert.equal((await selesaikanTidakPasti(db, { orderId: "K", actor: "p", keputusan: "terposting", alasan: ALASAN })).status, 503);
    assert.equal(calls.length, 0);
    assert.equal(tulis.length, 0);
});

test("Selesaikan terposting: WAJIB `ketemu` dari pencarian langsung -> posted + id/nomor + event selesaikan", async () => {
    const { db, tulis } = dbTiruan([BARIS_TIDAK_PASTI, [{ first: null }]]);
    const hasil = await selesaikanTidakPasti(db, { orderId: "KINO:SO-1", keputusan: "terposting", alasan: ALASAN, actor: "admin@contoh", cari: pencari(KETEMU).cari, targetDb: "DB-1" });
    assert.equal(hasil.status, 200);
    assert.equal(hasil.body.state, "posted");
    const ubah = tulis.find((w) => w.op === "update")?.nilai as Record<string, unknown>;
    assert.deepEqual([ubah.state, ubah.accurateId, ubah.accurateNumber, ubah.accurateDbId], ["posted", "331710", "INV/2610/KN00001", "DB-1"]);
    const [ev] = tulis.find((w) => w.op === "insert")?.nilai as { jenis: string; stateFrom: string; stateTo: string; reason: string; actor: string }[];
    assert.deepEqual([ev.jenis, ev.stateFrom, ev.stateTo, ev.reason, ev.actor], ["selesaikan", "unknown", "posted", ALASAN, "admin@contoh"]);
});

test("Selesaikan tidak terposting: WAJIB `tidak_ketemu_dicek` -> rejected (amplop [..]) agar bisa diantre ulang lewat jalur E2", async () => {
    const { db, tulis } = dbTiruan([BARIS_TIDAK_PASTI, [{ menit: 42 }], [{ first: null }]]);
    const hasil = await selesaikanTidakPasti(db, { orderId: "KINO:SO-1", keputusan: "tidak_terposting", alasan: ALASAN, actor: "admin@contoh", cari: pencari(TIDAK).cari, targetDb: "DB-1" });
    assert.equal(hasil.status, 200);
    const ubah = tulis.find((w) => w.op === "update")?.nilai as { state: string; lastError: string };
    assert.equal(ubah.state, "rejected");
    assert.match(ubah.lastError, /^\["Ditetapkan tidak terposting oleh admin@contoh: /);
});

test("Selesaikan: hasil pencarian bertentangan / gagal -> 409, tidak ada yang ditulis", async () => {
    for (const [keputusan, hasilCari, pola] of [
        ["terposting", TIDAK, /tidak menemukan faktur/],
        ["tidak_terposting", KETEMU, /DITEMUKAN di Accurate/],
        ["terposting", GAGAL, /tidak bisa memastikan/],
        ["tidak_terposting", GAGAL, /tidak bisa memastikan/],
    ] as const) {
        const { db, tulis } = dbTiruan(keputusan === "tidak_terposting"
            ? [BARIS_TIDAK_PASTI, [{ menit: null }], [{ first: null }]]
            : [BARIS_TIDAK_PASTI, [{ first: null }]]);
        const hasil = await selesaikanTidakPasti(db, { orderId: "KINO:SO-1", keputusan, alasan: ALASAN, actor: "p", cari: pencari(hasilCari).cari, targetDb: "DB-1" });
        assert.equal(hasil.status, 409, `${keputusan} + ${hasilCari.hasil}`);
        assert.match(String(hasil.body.error), pola);
        assert.equal(tulis.length, 0);
    }
});

test("Selesaikan: hanya baris TIDAK PASTI (rejected/posted/queued ditolak)", async () => {
    for (const state of ["rejected", "posted", "queued"]) {
        const { db, tulis } = dbTiruan([[{ state, customerNo: "C", createdAt: DIBUAT }]]);
        const { cari, calls } = pencari(KETEMU);
        const hasil = await selesaikanTidakPasti(db, { orderId: "K", keputusan: "terposting", alasan: ALASAN, actor: "p", cari, targetDb: "DB-1" });
        assert.equal(hasil.status, 409, state);
        assert.equal(calls.length, 0);
        assert.equal(tulis.length, 0);
    }
});

test("A-SEDANG: Tetapkan tidak terposting ditolak < 15 menit sejak kirim terakhir (jam DB) — save.do yang timeout bisa commit belakangan", async () => {
    for (const [menit, sisa] of [[0.5, 15], [14.01, 1]] as const) {
        const { db, tulis } = dbTiruan([BARIS_TIDAK_PASTI, [{ menit }]]);
        const { cari, calls } = pencari(TIDAK);
        const hasil = await selesaikanTidakPasti(db, { orderId: "KINO:SO-1", keputusan: "tidak_terposting", alasan: ALASAN, actor: "p", cari, targetDb: "DB-1" });
        assert.equal(hasil.status, 409, `${menit} menit`);
        assert.match(String(hasil.body.error), new RegExp(`tunggu ${sisa} menit lagi`));
        assert.equal(hasil.body.sisaMenit, sisa);
        assert.equal(calls.length, 0, "tidak perlu mencari selama masa tunggu");
        assert.equal(tulis.length, 0);
    }
    // Terposting tidak menunggu: faktur yang DITEMUKAN menutup kirim ulang, tidak membukanya.
    const { db } = dbTiruan([BARIS_TIDAK_PASTI, [{ first: null }]]);
    assert.equal((await selesaikanTidakPasti(db, { orderId: "KINO:SO-1", keputusan: "terposting", alasan: ALASAN, actor: "p", cari: pencari(KETEMU).cari, targetDb: "DB-1" })).status, 200);
});
