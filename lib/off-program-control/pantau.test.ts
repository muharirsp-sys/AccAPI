/* Pantau Pengajuan Promo (owner 3 Nov 2026): aturan cakupan salesman — teks principal profil + JKS -> kode OPC lewat alias resmi. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buatIndeksAlias, type AliasTerindeks } from "../principal/resolver.ts";
import type { DataResmi } from "../principal/pemakai.ts";
import { ALASAN_TANPA_PRINCIPAL, ALASAN_TANPA_PROFIL, dalamCakupan, hitungCakupan } from "./pantau.ts";

const a = (id: string, aliasNorm: string, principalId: string, code: string, variantKey: string | null, jenis: AliasTerindeks["jenis"] = "nama", aktif = true): AliasTerindeks =>
    ({ id, aliasNorm, jenis, principalId, code, variantKey, principalAktif: aktif, varianAktif: variantKey === null ? null : true });

const data: DataResmi = {
    indeks: buatIndeksAlias([
        a("1", "PRINCIPLE A", "pa", "PA", null),
        a("2", "PRINCIPLE A FOOD", "pa", "PA", "FOOD"),
        a("3", "PA", "pa", "PA", null, "kode_master_barang"),
        a("4", "PRINCIPLE B, PT", "pb", "PB", null),
        a("5", "PRINCIPLE C", "pc", "PC", null, "nama", false),
    ]),
    principal: new Map([["pa", { code: "PA", name: "PRINCIPLE A, PT" }], ["pb", { code: "PB", name: "PRINCIPLE B, PT" }], ["pc", { code: "PC", name: "PRINCIPLE C, PT" }]]),
    varian: new Map([["pa:FOOD", "PRINCIPLE A FOOD"]]),
};

test("admin = semua principal; tanpa profil sales = kosong dengan alasan", () => {
    const admin = hitungCakupan({ admin: true, punyaProfil: false, teks: [] }, data);
    assert.deepEqual(admin, { semua: true, principal: [], takDikenal: [], alasan: null });
    assert.equal(dalamCakupan(admin, "APA SAJA"), true);
    const tanpa = hitungCakupan({ admin: false, punyaProfil: false, teks: ["PRINCIPLE A"] }, data);
    assert.deepEqual(tanpa, { semua: false, principal: [], takDikenal: [], alasan: ALASAN_TANPA_PROFIL });
    assert.equal(dalamCakupan(tanpa, "PA"), false);
});

test("profil + JKS: alias resmi saja, varian = kode induk, nonaktif tetap ikut, tak dikenal dilaporkan tanpa ditebak", () => {
    const c = hitungCakupan({ admin: false, punyaProfil: true,
        teks: [" principle a food ", "PRINCIPLE A", "principle b,  pt", "PRINCIPLE C", "PA", "PT. PRINCIPLE B", "", "  "] }, data);
    assert.deepEqual(c.principal, [
        { code: "PA", nama: "PRINCIPLE A, PT" }, { code: "PB", nama: "PRINCIPLE B, PT" }, { code: "PC", nama: "PRINCIPLE C, PT" },
    ]);
    // "PA" = kode Master Barang (ruang lain), "PT. PRINCIPLE B" = ejaan tanpa alias: keduanya tidak ikut cakupan.
    assert.deepEqual(c.takDikenal, ["PA", "PT. PRINCIPLE B"]);
    assert.equal(c.alasan, null);
    assert.equal(dalamCakupan(c, "PB"), true);
    assert.equal(dalamCakupan(c, "PD"), false);
});

test("profil ada tapi tidak satu pun principal dikenal = kosong dengan alasan", () => {
    const c = hitungCakupan({ admin: false, punyaProfil: true, teks: ["CABANG A"] }, data);
    assert.deepEqual(c, { semua: false, principal: [], takDikenal: ["CABANG A"], alasan: ALASAN_TANPA_PRINCIPAL });
});
