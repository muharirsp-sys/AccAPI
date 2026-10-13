/* FK-MSM (pilot Form Kontrol cabang, 12 Okt 2026) TANPA DB: kunci hari JKS + bentuk baku unggah, paritas minggu dari acuan owner
 * (12 Okt 2026 = genap, selang-seling; bukan ISO), pencocokan kode toko JKS (tanpa akhiran cabang) -> pelanggan Accurate cabang. Perilaku route
 * ASLI pada Postgres = lib/form-kontrol/fk-msm-pg.test.ts. Data contoh generik. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hariBaku, kunciHari, paritasMinggu, pilihNamaAkun } from "./constants.ts";
import { hariIniWita } from "../../app/(dashboard)/form-kontrol/shared.tsx";
import { cocokKodeRute, pilihPelangganRute } from "../order-cabang.ts";
import { BATAS_KODE_RUTE, cocokkanTokoRute } from "../../components/order/order-cabang-api.ts";

test("butir 2: kunci hari tak peka huruf/spasi/tanda; bentuk baku unggah; hari tak dikenal = null, kosong = ''", () => {
    for (const v of ["SENIN", " senin ", "Senin"]) assert.equal(kunciHari(v), "SENIN");
    for (const v of ["JUM'AT", "Jum’at", "jumat", "JUM AT"]) assert.equal(kunciHari(v), "JUMAT");
    assert.equal(hariBaku("SABTU"), "Sabtu");
    assert.equal(hariBaku(" jum'at "), "Jumat");
    assert.equal(hariBaku("Minggu"), null, "Minggu tidak punya rute");
    assert.equal(hariBaku("Senen"), null);
    assert.equal(hariBaku(""), "");
    assert.equal(hariBaku("   "), "");
    assert.equal(hariBaku(undefined), "");
    // KC1: isian tanpa huruf hari BUKAN kosong — ditolak per baris, bukan disimpan tanpa hari.
    for (const v of ["1", "-", "?", 1]) assert.equal(hariBaku(v), null, String(v));
});

test("owner 12 Okt: paritas minggu selang-seling terus dari minggu acuan (Senin 12 Okt 2026 = genap), bukan minggu ISO", () => {
    assert.equal(paritasMinggu("2026-10-12"), "genap", "minggu acuan");
    assert.equal(paritasMinggu("2026-10-18"), "genap", "Minggu = minggu yang sama (Senin-ke-Senin)");
    assert.equal(paritasMinggu("2026-10-19"), "ganjil", "minggu depan");
    assert.equal(paritasMinggu("2026-10-26"), "genap");
    // 2026 punya 53 minggu ISO: ISO % 2 memberi 28 Des 2026 (minggu 53) dan 4 Jan 2027 (minggu 1) sama-sama ganjil. Selang-seling = beda.
    assert.equal(paritasMinggu("2026-12-28"), "ganjil"); // 11 minggu sesudah acuan
    assert.equal(paritasMinggu("2027-01-04"), "genap"); // 12 minggu sesudah acuan
    // Sebelum acuan (selisih negatif): Minggu 11 Okt = minggu sebelumnya.
    assert.equal(paritasMinggu("2026-10-11"), "ganjil");
    assert.equal(paritasMinggu("2026-10-05"), "ganjil");
    assert.equal(paritasMinggu("2026-09-28"), "genap");
    assert.equal(paritasMinggu("2026-06-01"), "ganjil", "data contoh seed Juni");
    // Batas hari menurut WITA: Minggu 23.30 WITA masih minggu acuan, Senin 00.30 WITA sudah minggu depan.
    assert.equal(paritasMinggu(hariIniWita(new Date("2026-10-18T15:30:00Z"))), "genap");
    assert.equal(paritasMinggu(hariIniWita(new Date("2026-10-18T16:30:00Z"))), "ganjil");
});

test("butir 6: kode toko JKS cocok persis ATAU kode + '-' + SATU akhiran; tak peka huruf; spasi dalam dipertahankan", () => {
    assert.equal(cocokKodeRute("C-100001", "C-100001-CBA"), true);
    assert.equal(cocokKodeRute("c-100001 ", "C-100001-cba"), true);
    assert.equal(cocokKodeRute("C-100001", "C-100001"), true);
    assert.equal(cocokKodeRute("C- FA0164", "C- FA0164-CBA"), true);
    assert.equal(cocokKodeRute("C-FA0164", "C- FA0164-CBA"), false, "spasi dalam tidak ditebak");
    assert.equal(cocokKodeRute("C-10000", "C-100001-CBA"), false, "awalan angka lain");
    assert.equal(cocokKodeRute("C-2000", "C-2000-01-CBA"), false, "akhiran lebih dari satu bagian");
    assert.equal(cocokKodeRute("C-2000", "C-2000-"), false);
    assert.equal(cocokKodeRute("", "C-1"), false);
});

test("butir 6: tepat satu pelanggan AKTIF = dipilih; dua = GANDA; hanya nonaktif = NONAKTIF; tidak ada = TIDAK_ADA", () => {
    const p = (customerNo: string, suspended = false) => ({ customerNo, suspended });
    assert.equal(pilihPelangganRute("C-1", [p("C-1-CBA"), p("C-2-CBA")]).pelanggan?.customerNo, "C-1-CBA");
    assert.equal(pilihPelangganRute("C-1", [p("C-1-CBA"), p("C-1-OLD", true)]).pelanggan?.customerNo, "C-1-CBA", "yang nonaktif tidak membuat ganda");
    assert.deepEqual(pilihPelangganRute("C-1", [p("C-1-CBA"), p("C-1")]), { pelanggan: null, masalah: "GANDA", kandidat: ["C-1-CBA", "C-1"] });
    assert.deepEqual(pilihPelangganRute("C-1", [p("C-1-CBA", true)]), { pelanggan: null, masalah: "NONAKTIF", kandidat: ["C-1-CBA"] });
    assert.deepEqual(pilihPelangganRute("C-1", [p("C-10-CBA")]), { pelanggan: null, masalah: "TIDAK_ADA", kandidat: [] });
});

test("KC3: rute lebih dari batas per permintaan dipecah (bukan dipotong / gagal semua)", async () => {
    const asli = globalThis.fetch;
    const diminta: string[][] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
        const kode = new URL(String(url), "http://app.test").searchParams.getAll("kode");
        diminta.push(kode);
        const rute = kode.map((k) => ({ kode: k, pelanggan: null, masalah: "TIDAK_ADA", kandidat: [], alasan: `x ${k}` }));
        return new Response(JSON.stringify({ ok: true, cakupan: {}, rute }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
        const kode = Array.from({ length: 450 }, (_, i) => `C-${i}`);
        const h = await cocokkanTokoRute(kode, undefined, "sales");
        assert.ok(h.ok);
        assert.deepEqual(h.ok && h.data.map((r) => r.kode), kode, "semua toko, urutan sama");
        assert.deepEqual(diminta.map((d) => d.length), [BATAS_KODE_RUTE, BATAS_KODE_RUTE, 50]);
    } finally {
        globalThis.fetch = asli;
    }
});

test("Hierarki (owner 13 Okt): nama SPV/SM = TEPAT SATU akun aktif (kunciNama), disimpan ejaan akun; kosong = lepas; tak dikenal 400; ganda 409", () => {
    const akun = ["SPV A", "SPV_SYAMSUL", "spv ganda", "SPV GANDA"];
    assert.deepEqual(pilihNamaAkun(" spv a ", akun, "SPV"), { nama: "SPV A" }, "ejaan akun, bukan ketikan");
    for (const v of [null, undefined, "", "   "]) assert.deepEqual(pilihNamaAkun(v, akun, "SPV"), { nama: null });
    const asing = pilihNamaAkun("SYAMSUL", akun, "SPV");
    assert.deepEqual("galat" in asing && [asing.galat.status, asing.galat.kode], [400, "SPV_TIDAK_DIKENAL"], "kasus produksi: SYAMSUL vs akun SPV_SYAMSUL");
    const sm = pilihNamaAkun("SM X", [], "SM");
    assert.deepEqual("galat" in sm && [sm.galat.status, sm.galat.kode], [400, "SM_TIDAK_DIKENAL"]);
    const ganda = pilihNamaAkun("Spv Ganda", akun, "SPV");
    assert.deepEqual("galat" in ganda && [ganda.galat.status, ganda.galat.kode], [409, "NAMA_GANDA"]);
    const angka = pilihNamaAkun(7, akun, "SPV");
    assert.deepEqual("galat" in angka && [angka.galat.status, angka.galat.kode], [400, "INPUT_TIDAK_VALID"]);
});
