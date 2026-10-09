/* AM-020 (H08): fallback tampilan konstanta insentif tidak boleh menjadi basis tulis. */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import { setKonstanta } from "./insentif-settings.ts";

test("baca konstanta gagal -> setKonstanta menolak dan TIDAK menulis bawaan + patch", async () => {
    // Pool habis / statement timeout saat membaca: dulu getKonstanta menelan error dan
    // mengembalikan BAWAAN, lalu setKonstanta menulis bawaan + satu field ke DB — semua 25
    // angka uang lain kembali ke bawaan tanpa ada yang meminta.
    const select = mock.method(db, "select", () => { throw new Error("pool habis"); });
    const insert = mock.method(db, "insert", () => { throw new Error("TIDAK BOLEH MENULIS"); });
    try {
        await assert.rejects(setKonstanta({ gt: { pool1: 2_000_000 } }, "admin"), /pool habis/);
        assert.equal(insert.mock.callCount(), 0, "menulis walau baca gagal");
    } finally {
        select.mock.restore();
        insert.mock.restore();
    }
});
