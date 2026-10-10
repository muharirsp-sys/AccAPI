/* S6e-1 butir 4a — penyelidikan "tabrakan charField1" (retur faktur Antrean → NOT_FOUND). Uji ini MEMBUKTIKAN perilaku
 * yang ada; tidak ada perbaikan yang diklaim. Ringkasan:
 *  1. Pencarian retur selesai SEBELUM pencarian faktur dimulai (W:667-926 vs W:928+) → `expectedCharField1` yang dulu
 *     dibaca dari peta faktur selalu "" → charField1 kepala faktur (kunci antrean PRINCIPAL:SO) tidak pernah sampai ke skor.
 *  2. Bahkan bila sampai: untuk referensi bertoken (semua referensi wajar), blok pelanggan/charField1 skor tidak jalan.
 *  3. Mekanisme NOT_FOUND yang TERBUKTI dari kode (bukan khusus Antrean): varian tanpa spasi menemukan kandidat, tetapi
 *     skornya 0 karena hanya token mentah di batas kata yang dihitung. Penyebab di produksi: pertanyaan terbuka. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buatEmulator } from "./uji/emulator-accurate.ts";
import { fakturAntrean } from "./uji/fixture.ts";
import { jalankanLib } from "./uji/jalankan.ts";
import { buildReturSearchVariants, parseReturReference, returDocumentMatches, scoreReturCandidate } from "./retur.ts";

const golden = JSON.parse(readFileSync("lib/pelunasan/uji/golden.json", "utf8")) as Record<string, { payload: unknown; manualRows: unknown }>;
const json = (v: unknown) => JSON.stringify(v, null, 2);
const FIELDS_FAKTUR = "number,branch,primeOwing,customer,charField1";

test("urutan: semua pencarian retur selesai sebelum pencarian faktur pertama (expectedCharField1 tak mungkin terisi)", async () => {
    const fx = fakturAntrean("PRINCIPAL-A:SO-0001")();
    const emu = buatEmulator(fx.data);
    await jalankanLib(fx, emu);
    const urut = emu.panggilan.map((p) => (p.path.startsWith("/api/sales-return/") ? "retur"
        : (p.payload as Record<string, unknown>)?.fields === FIELDS_FAKTUR ? "faktur" : "lain"));
    const terakhirRetur = urut.lastIndexOf("retur");
    const pertamaFaktur = urut.indexOf("faktur");
    assert.ok(terakhirRetur >= 0 && pertamaFaktur >= 0, urut.join(","));
    assert.ok(terakhirRetur < pertamaFaktur, `retur terakhir #${terakhirRetur} harus sebelum faktur pertama #${pertamaFaktur}: ${urut.join(",")}`);
});

test("charField1 kepala faktur (kunci antrean PRINCIPAL:SO) tidak mengubah keluaran — golden kode LAMA kembar identik", async () => {
    // Golden direkam dari kode lama W: faktur ber-charField1 antrean vs faktur charField1 kosong.
    assert.equal(json(golden["f10-faktur-antrean-charfield1"].payload), json(golden["f10b-faktur-antrean-tanpa-charfield1"].payload));
    assert.equal(json(golden["f10-faktur-antrean-charfield1"].manualRows), json(golden["f10b-faktur-antrean-tanpa-charfield1"].manualRows));
    // Dan lib: kunci antrean apa pun → keluaran sama.
    const hasil: string[] = [];
    for (const cf of ["PRINCIPAL-A:SO-0001", "", "CABANG A", "uuid-order-0001"]) {
        const fx = fakturAntrean(cf)();
        const emu = buatEmulator(fx.data);
        hasil.push(json((await jalankanLib(fx, emu)).payload));
    }
    assert.equal(new Set(hasil).size, 1);
});

test("skor retur bertoken tidak bergantung expectedCharField1 maupun pelanggan", () => {
    const ref = parseReturReference("SRB 2610.0091");
    assert.deepEqual(ref.codeTokens, ["SRB 2610.0091"], "kode tanpa garis miring tetap jadi token");
    const kandidat = { number: "SRT/2610/XJ0091", keywords: "SRB 2610.0091", customer: { customerNo: "PLG-J-001", charField1: "CABANG A" } };
    const skor = (cust: string, cf: string) => scoreReturCandidate(kandidat, cust, cf, ref);
    const dasar = skor("PLG-J-001", "");
    assert.ok(dasar >= 90, `kandidat diterima (${dasar})`);
    for (const [cust, cf] of [["PLG-J-001", "PRINCIPAL-A:SO-0001"], ["PLG-J-001", "CABANG A"], ["PLG-LAIN-9", "CABANG B"]]) {
        assert.equal(skor(cust, cf), dasar, `${cust}/${cf}`);
    }
});

test("PERILAKU SAAT INI (pertanyaan terbuka): SRB tersimpan tanpa spasi → varian ketemu, skor 0 → NOT_FOUND", () => {
    const excel = "SRB 2610.0003";
    assert.ok(buildReturSearchVariants(excel).includes("SRB2610.0003"), "pencarian memang mencoba varian tanpa spasi");
    const kandidat = { number: "SRT/2610/XX0003", keywords: "SRB2610.0003", customer: { customerNo: "PLG-D-002" } };
    assert.equal(scoreReturCandidate(kandidat, "PLG-D-002", "", parseReturReference(excel)), 0, "skor 0 < ambang 90");
    // Jalur ayat silang menilai teks TERNORMALISASI dan akan menerimanya — dua jalur tidak sepakat.
    assert.equal(returDocumentMatches(kandidat, excel), true);
    // Golden kode lama f05: baris itu menjadi baris manual (retur dilewati, kas tetap diproses).
    assert.match(json(golden["f05-retur-srb-rjs"].manualRows), /SRB 2610\.0003/);
});
