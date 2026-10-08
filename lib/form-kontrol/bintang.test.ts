import { test } from "node:test";
import assert from "node:assert/strict";
import { statusBintang } from "./constants";

test("bintang: prioritas ↔ tidak dikunjungi; hasil kunjungan tidak tertimpa", () => {
    assert.equal(statusBintang("not_visited"), "priority");
    assert.equal(statusBintang("priority"), "not_visited");
    for (const hasil of ["ordered", "active", "not_order"]) assert.equal(statusBintang(hasil), hasil);
});
