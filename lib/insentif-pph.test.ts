import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PPH_RATE, nettoInsentif, pphInsentif } from "./insentif-pph";

test("potongan 2,5% dan netto konsisten", () => {
    assert.equal(PPH_RATE, 0.025);
    assert.equal(pphInsentif(1_000_000), 25_000);
    assert.equal(nettoInsentif(1_000_000), 975_000);
    // Pembulatan tidak boleh menciptakan/menghilangkan rupiah: netto + pph = bruto.
    for (const bruto of [1, 7, 999, 1_234_567, 3_500_000]) {
        assert.equal(pphInsentif(bruto) + nettoInsentif(bruto), bruto, `bruto ${bruto}`);
    }
});

test("nol dan nilai tidak wajar tidak dipotong", () => {
    for (const bruto of [0, -100, NaN, Infinity]) {
        assert.equal(pphInsentif(bruto), 0);
        assert.equal(nettoInsentif(bruto), 0);
    }
});
