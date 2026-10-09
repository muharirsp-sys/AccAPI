/* AM-020 (H08): fallback tampilan konstanta insentif tidak boleh menjadi basis tulis.
 * AM-045 (H08-c): dua admin menyimpan dari versi yang sama tidak saling menimpa. */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { KonstantaBerubahError, setKonstanta } from "./insentif-settings.ts";
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
