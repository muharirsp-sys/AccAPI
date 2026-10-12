import { test } from "node:test";
import assert from "node:assert/strict";
import { halamanAwal, halamanTerlihat } from "./insentif-ui";

const izin = (...k: string[]) => new Set(k.map((x) => `insentif_sales.${x}`));
const kunci = (p: Set<string>) => halamanTerlihat(p).map((h) => h.key);

test("halaman insentif mengikuti izin; salesman hanya Insentif saya", () => {
    assert.deepEqual(kunci(izin("view")), ["saya"]);
    assert.deepEqual(kunci(izin("view", "manage_payment", "input_support")), ["pembayaran", "support"]);
    assert.deepEqual(kunci(izin("view", "manage")), ["dashboard", "pembayaran", "data", "support", "pengaturan"]);
    assert.deepEqual(kunci(izin("view", "view_dashboard")), ["dashboard"]);
    assert.deepEqual(kunci(izin("view", "view_all")), ["dashboard"]);
});

test("identitas hierarki: SPV/SM ber-izin view saja tetap mendapat Dashboard, sales mendapat Insentif saya", () => {
    assert.deepEqual(halamanTerlihat(izin("view"), "spv").map((h) => h.key), ["dashboard"]);
    assert.deepEqual(halamanTerlihat(izin("view"), "sales").map((h) => h.key), ["saya"]);
    assert.deepEqual(halamanTerlihat(izin("view", "manage_payment"), "sales").map((h) => h.key), ["saya", "pembayaran"]);
    assert.equal(halamanAwal(izin("view"), "sm", "sm"), "dashboard");
});

test("?view= lama diarahkan ke halaman baru hanya bila boleh", () => {
    assert.equal(halamanAwal(izin("view", "manage"), "finance"), "pembayaran");
    assert.equal(halamanAwal(izin("view", "manage"), "admin"), "data");
    assert.equal(halamanAwal(izin("view", "manage_payment"), "sm"), "pembayaran");
    assert.equal(halamanAwal(izin("view"), null), "saya");
});
