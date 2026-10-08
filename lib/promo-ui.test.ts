/*
 * Tujuan: Self-check helper layar Promo: rupiah tanpa desimal palsu, koma desimal, status aturan (nonaktif mengalahkan tanggal),
 *         kosakata beban, dan kalimat artinya menyebut penanggung yang benar.
 * Caller: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { artinya, bebanDari, manfaat, persen, rupiah, statusAturan, tgl } from "@/lib/promo-ui";

test("rupiah: desimal hanya bila berdesimal; persen koma", () => {
    assert.equal(rupiah(20000), "Rp 20.000");
    assert.equal(rupiah(6480.5), "Rp 6.480,50");
    assert.equal(rupiah("0"), "Rp 0");
    assert.equal(persen("2.25"), "2,25%");
    assert.equal(manfaat("DISC_RP", "20000"), "Rp 20.000");
    assert.equal(manfaat("BONUS_QTY", "1"), "bonus 1");
    assert.equal(tgl("2026-10-06"), "06/10/2026");
});

test("status aturan: nonaktif mengalahkan masa berlaku; batas tanggal inklusif", () => {
    const hari = "2026-10-06";
    assert.equal(statusAturan({ active: false, periodStart: "2026-10-01", periodEnd: "2026-10-31" }, hari), "nonaktif");
    assert.equal(statusAturan({ active: true, periodStart: "2026-09-01", periodEnd: "2026-09-30" }, hari), "berakhir");
    assert.equal(statusAturan({ active: true, periodStart: "2026-10-07", periodEnd: null }, hari), "belum");
    assert.equal(statusAturan({ active: true, periodStart: "2026-10-06", periodEnd: "2026-10-06" }, hari), "aktif");
    assert.equal(statusAturan({ active: true, periodStart: null, periodEnd: null }, hari), "aktif");
});

test("beban: PRINCIPAL = klaim principal, selain itu beban distributor; kalimat artinya menyebutnya", () => {
    assert.equal(bebanDari("PRINCIPAL"), "principal");
    assert.equal(bebanDari("DISTRIBUTOR"), "distributor");
    assert.match(artinya({ benefitBeban: "PRINCIPAL", benefitType: "DISC_PCT", benefitValue: "1.5", tierNo: 1, outletList: "LOYALTY", outletListMode: "EXCLUDE" }), /BUKAN peserta LOYALTY.*1,5%.*klaim principal/);
    assert.match(artinya({ benefitBeban: "DISTRIBUTOR", benefitType: "DISC_RP", benefitValue: "20000", customerCode: "C-AL0063" }), /^Outlet C-AL0063 dapat potongan Rp 20\.000.*beban distributor/);
});
