import test from "node:test";
import assert from "node:assert/strict";
import { bulanSah, IZIN_HALAMAN, rentangBulan, tabTerlihat } from "./kontrak";

test("tabTerlihat: hanya tab yang izinnya dipegang", () => {
    assert.deepEqual(tabTerlihat(new Set(["sales_history.view"])).map((t) => t.id), ["top30", "drop-size"]);
    assert.deepEqual(tabTerlihat(new Set(["supervisor_review.view"])).map((t) => t.id), ["harian", "coverage", "tidak-order"]);
    assert.deepEqual(tabTerlihat(new Set()), []);
    assert.deepEqual(IZIN_HALAMAN, ["sales_history.view", "supervisor_review.view", "insentif_sales.view_all"]);
});

test("bulanSah + rentangBulan", () => {
    assert.ok(bulanSah("2026-10"));
    for (const v of ["2026-13", "2026-1", "26-10", "", null, 202610]) assert.equal(bulanSah(v), false, String(v));
    assert.deepEqual(rentangBulan("2026-02"), { tahun: 2026, bulan: 2, hari: 28, polaTransDate: "%/02/2026" });
    assert.equal(rentangBulan("2024-02").hari, 29);
    assert.equal(rentangBulan("2026-10").hari, 31);
});
