/* S7-2: resolver principal lewat alias — cocok (utuh/varian), tak_dikenal, ambigu; RUANG wajib (nama | kode_master_barang);
 * tak pernah menebak. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buatIndeksAlias, resolvePrincipal, ruangDari, type AliasTerindeks } from "./resolver.ts";

const a = (id: string, aliasNorm: string, code: string, variantKey: string | null, jenis: AliasTerindeks["jenis"] = "nama", aktif: [boolean, boolean | null] = [true, variantKey === null ? null : true]): AliasTerindeks =>
    ({ id, aliasNorm, jenis, principalId: `p-${code}`, code, variantKey, principalAktif: aktif[0], varianAktif: aktif[1] });

const indeks = buatIndeksAlias([
    a("1", "KINO", "KINO", null),
    a("2", "KINO INDONESIA. TBK, PT", "KINO", null),
    a("3", "KINO NON FOOD", "KINO", "NON_FOOD", "label_mapping"),
    a("4", "FORISA MT", "FRS", "MT"),
    a("5", "MI", "MI", null),
    a("6", "MI", "KINO", null, "kode_master_barang"), // "MI" sah di dua ruang
    a("7", "GD", "GDI", null, "kode_master_barang"),
    a("8", "URC", "URC", null, "nama", [false, null]),
    a("9", "HEINZ (HZ)", "HEINZ", "HZ", "nama", [true, false]),
]);

test("cocok: principal utuh (variantKey null) dan varian; teks dinormalkan dulu; jenis apa pun di ruang nama", () => {
    const utuh = resolvePrincipal("  kino indonesia. tbk, pt ", indeks, "nama");
    assert.deepEqual(utuh.status === "cocok" && [utuh.code, utuh.variantKey, utuh.aktif], ["KINO", null, true]);
    const varian = resolvePrincipal("Kino Non Food", indeks, "nama");
    assert.deepEqual(varian.status === "cocok" && [varian.code, varian.variantKey], ["KINO", "NON_FOOD"], "alias label_mapping tetap ditemukan di ruang nama");
});

test("ruang memisahkan kode Master Barang dari nama: 'GD' di teks bebas TIDAK jatuh ke GDI; 'MI' tidak ambigu", () => {
    assert.equal(resolvePrincipal("gd", indeks, "nama").status, "tak_dikenal", "kode MB 2 karakter tidak ikut ruang nama");
    const gd = resolvePrincipal("gd", indeks, "kode_master_barang");
    assert.deepEqual(gd.status === "cocok" && gd.code, "GDI");
    const nama = resolvePrincipal("mi", indeks, "nama");
    assert.deepEqual(nama.status === "cocok" && nama.code, "MI");
    const mb = resolvePrincipal("mi", indeks, "kode_master_barang");
    assert.deepEqual(mb.status === "cocok" && mb.code, "KINO");
    assert.equal(resolvePrincipal("KINO", indeks, "kode_master_barang").status, "tak_dikenal");
});

test("ruang wajib & sah: selain 'nama' / 'kode_master_barang' dilempar (bukan diam-diam semua ruang)", () => {
    assert.throws(() => resolvePrincipal("KINO", indeks, undefined as never), /ruang/);
    assert.throws(() => resolvePrincipal("KINO", indeks, "label_mapping" as never), /ruang/);
    assert.deepEqual([ruangDari("nama"), ruangDari("kode_master_barang"), ruangDari("label_mapping"), ruangDari(null), ruangDari(["nama"])],
        ["nama", "kode_master_barang", null, null, null]);
});

test("tak_dikenal: kosong, ejaan tak terdaftar, dan TIDAK menebak kecocokan longgar", () => {
    assert.deepEqual(resolvePrincipal("", indeks, "nama"), { status: "tak_dikenal", norm: "" });
    assert.equal(resolvePrincipal("PT KINO INDONESIA TBK", indeks, "nama").status, "tak_dikenal");
    assert.equal(resolvePrincipal("KINO NONFOOD", indeks, "nama").status, "tak_dikenal");
});

test("ambigu: indeks berisi dua target untuk ejaan yang sama di satu ruang (DB mencegahnya; resolver tetap tidak menebak)", () => {
    const rusak = buatIndeksAlias([a("1", "ABC", "ABC", null), a("2", "ABC", "HEINZ", null, "nama_surat")]);
    const r = resolvePrincipal("abc", rusak, "nama");
    assert.deepEqual(r.status === "ambigu" && r.kandidat.map((k) => k.code).sort(), ["ABC", "HEINZ"]);
    const dobel = buatIndeksAlias([a("1", "ABC", "ABC", null), a("2", "ABC", "ABC", null, "nama_surat")]);
    assert.equal(resolvePrincipal("abc", dobel, "nama").status, "cocok", "dua alias target sama = satu target");
});

test("aktif=false bila principal nonaktif atau varian nonaktif (keputusan di pemakai)", () => {
    const urc = resolvePrincipal("URC", indeks, "nama");
    assert.deepEqual(urc.status === "cocok" && urc.aktif, false);
    const hz = resolvePrincipal("Heinz (HZ)", indeks, "nama");
    assert.deepEqual(hz.status === "cocok" && [hz.variantKey, hz.aktif], ["HZ", false]);
});
