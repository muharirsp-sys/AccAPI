/* AM-020 (H08): fallback tampilan konstanta insentif tidak boleh menjadi basis tulis.
 * AM-045 (H08-c): dua admin menyimpan dari versi yang sama tidak saling menimpa. */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { KonstantaBerubahError, getKonstantaBerlabel, setKonstanta } from "./insentif-settings.ts";
import { NextRequest } from "next/server";
import { POST as postPayment } from "../app/api/insentif-sales/payments/route.ts";
import { DEFAULT_KONSTANTA } from "./insentif-konstanta.ts";

test("baca konstanta gagal -> setKonstanta menolak dan TIDAK menulis bawaan + patch", async () => {
    // Pool habis / statement timeout saat membaca: dulu getKonstanta menelan error dan
    // mengembalikan BAWAAN, lalu setKonstanta menulis bawaan + satu field ke DB — semua 25
    // angka uang lain kembali ke bawaan tanpa ada yang meminta.
    const select = mock.method(db, "select", () => { throw new Error("pool habis"); });
    const insert = mock.method(db, "insert", () => { throw new Error("TIDAK BOLEH MENULIS"); });
    try {
        await assert.rejects(setKonstanta({ gt: { pool1: 2_000_000 } }, "admin", null), /pool habis/);
        assert.equal(insert.mock.callCount(), 0, "menulis walau baca gagal");
    } finally {
        select.mock.restore();
        insert.mock.restore();
    }
});

const T = new Date("2026-09-30T01:02:03.456Z");
const tersimpan = () => mock.method(db, "select", () => ({
    from: () => ({ where: () => ({ limit: async () => [{ value: JSON.stringify(DEFAULT_KONSTANTA), updatedAt: T }] }) }),
}));
const updateMengembalikan = (rows: unknown[]) => mock.method(db, "update", () => ({
    set: () => ({ where: () => ({ returning: async () => rows }) }),
}));

test("AM-045: versi editor basi -> 409 tanpa menulis", async () => {
    const select = tersimpan();
    const update = updateMengembalikan([{ key: "x" }]);
    try {
        await assert.rejects(setKonstanta({ gt: { pool1: 2_000_000 } }, "admin", "2026-09-29T00:00:00.000Z"), KonstantaBerubahError);
        await assert.rejects(setKonstanta({ gt: { pool1: 2_000_000 } }, "admin", null), KonstantaBerubahError, "baris ada, editor mengira belum pernah disimpan");
        assert.equal(update.mock.callCount(), 0, "menulis walau versi basi");
    } finally {
        select.mock.restore();
        update.mock.restore();
    }
});

test("AM-045: admin lain menyimpan di antara baca dan tulis -> UPDATE bersyarat 0 baris -> 409", async () => {
    const select = tersimpan();
    const update = updateMengembalikan([]);
    try {
        await assert.rejects(setKonstanta({ gt: { pool1: 2_000_000 } }, "admin", T.toISOString()), KonstantaBerubahError);
        assert.equal(update.mock.callCount(), 1);
    } finally {
        select.mock.restore();
        update.mock.restore();
    }
});

test("AM-045: versi cocok -> tersimpan, versi baru dikembalikan (kontrol positif)", async () => {
    const select = tersimpan();
    const update = updateMengembalikan([{ key: "insentif_konstanta" }]);
    try {
        const hasil = await setKonstanta({ gt: { pool1: 2_000_000 } }, "admin", T.toISOString());
        assert.equal(hasil.konstanta.gt.pool1, 2_000_000);
        assert.equal(hasil.konstanta.gt.aoAmbang, DEFAULT_KONSTANTA.gt.aoAmbang, "field lain dari yang tersimpan");
        assert.ok(hasil.versi > T.toISOString(), `versi baru ${hasil.versi}`);
    } finally {
        select.mock.restore();
        update.mock.restore();
    }
});

/*
 * S6-0c perbaikan 5 (peninjau B): dashboard/spv/sm dulu jatuh ke bawaan TANPA memberi tahu, lalu Pembayaran mengirim nominal
 * hasil bawaan sebagai totalIncentive. Kini tampilan DILABELI dan server menolak menandai lunas selama konstanta tak terbaca.
 */
test("getKonstantaBerlabel: baca gagal → bawaan DILABELI gagal_baca (tampilan boleh degraded, tidak diam-diam)", async () => {
    const select = mock.method(db, "select", () => { throw new Error("statement timeout"); });
    try {
        assert.deepEqual(await getKonstantaBerlabel(), { konstanta: DEFAULT_KONSTANTA, konstantaSumber: "gagal_baca" });
    } finally {
        select.mock.restore();
    }
});

test("POST payments lunas saat konstanta tak terbaca → 503 KONSTANTA_GAGAL_BACA, tidak menulis; status lain lewat ke validasi biasa", async () => {
    const env = { NODE_ENV: process.env.NODE_ENV, LOCAL_AUTH_BYPASS: process.env.LOCAL_AUTH_BYPASS };
    Object.assign(process.env, { NODE_ENV: "development", LOCAL_AUTH_BYPASS: "true" });
    const select = mock.method(db, "select", () => { throw new Error("DB tak terbaca"); });
    const insert = mock.method(db, "insert", () => { throw new Error("TIDAK BOLEH MENULIS"); });
    const kirim = (paymentStatus: string) => postPayment(new NextRequest("http://localhost/api/insentif-sales/payments", {
        method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ salesCode: "S-A", salesName: "SALES A", principle: "PRINCIPLE A", branch: "CABANG A", periodMonth: 9, periodYear: 2026, totalIncentive: 1_000_000, paymentStatus }),
    }));
    try {
        const res = await kirim("lunas");
        assert.equal(res.status, 503);
        assert.equal((await res.json()).code, "KONSTANTA_GAGAL_BACA");
        assert.equal(insert.mock.callCount(), 0);
        // Kontrol: status "belum" tidak memeriksa konstanta — sampai ke pencarian target (DB) seperti biasa.
        await assert.rejects(kirim("belum"), /DB tak terbaca/);
    } finally {
        select.mock.restore();
        insert.mock.restore();
        for (const [k, v] of Object.entries(env)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
});
