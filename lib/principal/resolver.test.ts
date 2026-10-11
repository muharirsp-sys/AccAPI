/* S7-2: resolver principal lewat alias — cocok (utuh/varian), tak_dikenal, ambigu; saring jenis; tak pernah menebak. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buatIndeksAlias, JENIS_NAMA, resolvePrincipal, type AliasTerindeks } from "./resolver.ts";

const a = (id: string, aliasNorm: string, code: string, variantKey: string | null, jenis: AliasTerindeks["jenis"] = "nama", aktif: [boolean, boolean | null] = [true, variantKey === null ? null : true]): AliasTerindeks =>
    ({ id, aliasNorm, jenis, principalId: `p-${code}`, code, variantKey, principalAktif: aktif[0], varianAktif: aktif[1] });

const indeks = buatIndeksAlias([
    a("1", "KINO", "KINO", null),
    a("2", "KINO INDONESIA. TBK, PT", "KINO", null),
    a("3", "KINO NON FOOD", "KINO", "NON_FOOD", "label_mapping"),
    a("4", "FORISA MT", "FRS", "MT"),
    a("5", "MI", "MI", null),
    a("6", "MI", "KINO", null, "kode_master_barang"), // "MI" sah di dua ruang
    a("7", "K1", "KINO", null, "kode_master_barang"),
    a("8", "URC", "URC", null, "nama", [false, null]),
    a("9", "HEINZ (HZ)", "HEINZ", "HZ", "nama", [true, false]),
    a("10", "KINO", "KINO", null, "nama_surat"), // ejaan sama, target sama -> tetap satu target
]);

test("cocok: principal utuh (variantKey null) dan varian; teks dinormalkan dulu", () => {
    const utuh = resolvePrincipal("  kino indonesia. tbk, pt ", indeks);
    assert.equal(utuh.status, "cocok");
    assert.deepEqual(utuh.status === "cocok" && [utuh.code, utuh.variantKey, utuh.aktif], ["KINO", null, true]);
    const varian = resolvePrincipal("Kino Non Food", indeks);
    assert.deepEqual(varian.status === "cocok" && [varian.code, varian.variantKey], ["KINO", "NON_FOOD"]);
    const dua = resolvePrincipal("KINO", indeks);
    assert.equal(dua.status, "cocok", "dua alias target sama = satu target");
    assert.equal(dua.status === "cocok" && dua.alias.length, 2);
});

test("tak_dikenal: kosong, ejaan tak terdaftar, dan TIDAK menebak kecocokan longgar", () => {
    assert.deepEqual(resolvePrincipal("", indeks), { status: "tak_dikenal", norm: "" });
    assert.equal(resolvePrincipal("PT KINO INDONESIA TBK", indeks).status, "tak_dikenal");
    assert.equal(resolvePrincipal("KINO NONFOOD", indeks).status, "tak_dikenal");
});

test("ambigu: ejaan sama di dua ruang menunjuk principal berbeda; saring jenis memilih ruang", () => {
    const r = resolvePrincipal("mi", indeks);
    assert.equal(r.status, "ambigu");
    assert.deepEqual(r.status === "ambigu" && r.kandidat.map((k) => k.code).sort(), ["KINO", "MI"]);
    const nama = resolvePrincipal("mi", indeks, { jenis: JENIS_NAMA });
    assert.deepEqual(nama.status === "cocok" && nama.code, "MI");
    const mb = resolvePrincipal("mi", indeks, { jenis: "kode_master_barang" });
    assert.deepEqual(mb.status === "cocok" && mb.code, "KINO");
    assert.equal(resolvePrincipal("K1", indeks, { jenis: JENIS_NAMA }).status, "tak_dikenal");
    assert.equal(resolvePrincipal("KINO NON FOOD", indeks, { jenis: "nama" }).status, "tak_dikenal", "jenis = asal ejaan; saring satu jenis bisa melewatkan");
});

test("aktif=false bila principal nonaktif atau varian nonaktif (keputusan di pemakai)", () => {
    const urc = resolvePrincipal("URC", indeks);
    assert.deepEqual(urc.status === "cocok" && urc.aktif, false);
    const hz = resolvePrincipal("Heinz (HZ)", indeks);
    assert.deepEqual(hz.status === "cocok" && [hz.variantKey, hz.aktif], ["HZ", false]);
});
