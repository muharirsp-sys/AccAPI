/* S7-2b: pemakai (Mapping Principal, Master Barang) wajib principal dari tabel resmi — logika murni. Route + DB nyata diuji di
 * lib/principal-pemakai-pg.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buatIndeksAlias, type AliasTerindeks } from "./resolver.ts";
import { GalatPrincipal } from "./tulis.ts";
import { kodeMasterBarang, periksaPrincipal, wajibPrincipal, type DataResmi } from "./pemakai.ts";
import { offPrinciples } from "../off-program-control/constants.ts";
import { getPrincipleByName } from "../off-program-control/helpers.ts";

const a = (id: string, aliasNorm: string, principalId: string, code: string, variantKey: string | null, jenis: AliasTerindeks["jenis"] = "nama", aktif = true): AliasTerindeks =>
    ({ id, aliasNorm, jenis, principalId, code, variantKey, principalAktif: aktif, varianAktif: variantKey === null ? null : true });

const data: DataResmi = {
    indeks: buatIndeksAlias([
        a("1", "KINO", "pk", "KINO", null),
        a("2", "KINO INDONESIA TBK, PT", "pk", "KINO", null),
        a("3", "KINO NON FOOD", "pk", "KINO", "NON_FOOD"),
        a("4", "K1", "pk", "KINO", null, "kode_master_barang"),
        a("5", "KN", "pk", "KINO", "NON_FOOD", "kode_master_barang"),
        a("6", "GDI", "pg", "GDI", null),
        a("7", "GODREJ DISTRIBUSI INDONESIA, PT", "pg", "GDI", null),
        a("8", "GD", "pg", "GDI", null, "kode_master_barang"),
        a("9", "PRINCIPLE A", "pa", "PA", null, "nama", false),
        a("10", "URC", "pu", "URC", null),
    ]),
    principal: new Map([["pk", { code: "KINO", name: "KINO INDONESIA TBK, PT" }], ["pg", { code: "GDI", name: "GODREJ DISTRIBUSI INDONESIA, PT" }],
        ["pa", { code: "PA", name: "PRINCIPLE A" }], ["pu", { code: "URC", name: "URC INDONESIA, PT" }]]),
    varian: new Map([["pk:NON_FOOD", "KINO NON FOOD"]]),
};

test("S7-2b: ejaan KINO resmi tanpa titik; batch OPC lama berejaan lama tetap dikenal server", () => {
    assert.equal(offPrinciples.find((p) => p.code === "KINO")?.name, "KINO INDONESIA TBK, PT");
    assert.equal(offPrinciples.some((p) => p.name.includes("INDONESIA. TBK")), false);
    assert.deepEqual(getPrincipleByName("KINO INDONESIA. TBK, PT"), { name: "KINO INDONESIA TBK, PT", code: "KINO" });
    assert.equal(getPrincipleByName("KINO INDONESIA.. TBK, PT"), undefined, "hanya ejaan lama yang tercatat, bukan pencocokan longgar");
});

test("S7-2b: principal dicocokkan lewat alias (varian/utuh), nama tampil = nama varian / nama resmi", () => {
    const nf = periksaPrincipal(" kino non  food ", data);
    assert.deepEqual(nf, { status: "cocok", principal: { principalId: "pk", code: "KINO", variantKey: "NON_FOOD", nama: "KINO NON FOOD" } });
    const utuh = periksaPrincipal("kino", data);
    assert.deepEqual(utuh.status === "cocok" && [utuh.principal.variantKey, utuh.principal.nama], [null, "KINO INDONESIA TBK, PT"]);
    assert.deepEqual(periksaPrincipal("K1", data).status, "tak_dikenal", "kode Master Barang bukan nama (ruang nama)");
    const mati = periksaPrincipal("principle a", data);
    assert.deepEqual(mati.status === "nonaktif" && mati.principal.code, "PA");
});

test("S7-2b: tak dikenal = saran kandidat (token bersama, hanya principal aktif), tak pernah dipakai otomatis", () => {
    const pt = periksaPrincipal("PT. KINO", data);
    assert.equal(pt.status, "tak_dikenal");
    assert.deepEqual(pt.status === "tak_dikenal" && pt.saran, [
        { code: "KINO", variantKey: null, nama: "KINO INDONESIA TBK, PT" },
        { code: "KINO", variantKey: "NON_FOOD", nama: "KINO NON FOOD" },
    ]);
    const nf = periksaPrincipal("KINO NONFOOD", data);
    assert.deepEqual(nf.status === "tak_dikenal" && nf.saran.map((s) => `${s.code}/${s.variantKey}`), ["KINO/null", "KINO/NON_FOOD"]);
    const nol = periksaPrincipal("PRINCIPLE B", data);
    assert.deepEqual(nol.status === "tak_dikenal" && nol.saran, [], "PRINCIPLE A nonaktif tidak disarankan");
});

test("S7-2b: wajibPrincipal melempar 400 PRINCIPAL_TIDAK_DIKENAL { ditolak[{nilai, saran}] } / 409 PRINCIPAL_NONAKTIF", () => {
    assert.equal(wajibPrincipal("KINO NON FOOD", data).nama, "KINO NON FOOD");
    assert.throws(() => wajibPrincipal("Godrej Indo", data), (e: unknown) => {
        assert.ok(e instanceof GalatPrincipal);
        assert.deepEqual([e.status, e.code], [400, "PRINCIPAL_TIDAK_DIKENAL"]);
        assert.deepEqual(e.detail, { ditolak: [{ nilai: "Godrej Indo", saran: [{ code: "GDI", variantKey: null, nama: "GODREJ DISTRIBUSI INDONESIA, PT" }] }] });
        assert.match(e.message, /Godrej Indo/);
        return true;
    });
    assert.throws(() => wajibPrincipal("PRINCIPLE A", data), (e: unknown) => e instanceof GalatPrincipal && e.status === 409 && e.code === "PRINCIPAL_NONAKTIF"
        && JSON.stringify(e.detail) === JSON.stringify({ nilai: "PRINCIPLE A", principal: { code: "PA", variantKey: null } }));
});

test("S7-2b: kode Master Barang 2 karakter = alias kode_master_barang principal itu (utuh berlaku untuk varian), bukan tebakan", () => {
    const kino = wajibPrincipal("KINO", data);
    const nf = wajibPrincipal("KINO NON FOOD", data);
    const gdi = wajibPrincipal("GDI", data);
    assert.equal(kodeMasterBarang(kino, "", data), "K1", "satu-satunya kode utuh KINO (KN milik varian NON_FOOD)");
    assert.equal(kodeMasterBarang(nf, " kn ", data), "KN");
    assert.equal(kodeMasterBarang(nf, "k1", data), "K1", "kode utuh berlaku untuk varian");
    const tolak = (fn: () => unknown, kodeMb: string | null, pilihan: string[]) => assert.throws(fn, (e: unknown) => e instanceof GalatPrincipal
        && e.status === 400 && e.code === "KODE_MB_TIDAK_COCOK" && JSON.stringify([e.detail.kodeMb, e.detail.pilihan]) === JSON.stringify([kodeMb, pilihan]));
    tolak(() => kodeMasterBarang(nf, "", data), null, ["K1", "KN"]);
    tolak(() => kodeMasterBarang(kino, "GD", data), "GD", ["K1"]);
    tolak(() => kodeMasterBarang(kino, "KN", data), "KN", ["K1"]);
    tolak(() => kodeMasterBarang(wajibPrincipal("URC", data), "", data), null, []);
    assert.equal(kodeMasterBarang(gdi, "", data), "GD");
});
