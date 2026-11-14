/* Uji murni JKS Web-LL (siklus 4 minggu, F8) + Item Super (gabung varian, saran per toko, isian penawaran) — owner 13 Nov 2026. */
import assert from "node:assert/strict";
import test from "node:test";
import { frekuensiBawaan, hariBaku, hariCocok, mingguSiklus, paritasMinggu, polaBerlaku, terjadwalPada } from "./constants";
import { bacaJksWebLl, polaDariMinggu, tebakPeta, nilaiUntukPeta } from "./jks-webll";
import { MAKS_SARAN_WAJIB, bacaItemSuper, periksaTawaran, pilihSaran, type SaranItemSuper } from "./item-super";

test("minggu siklus = nomor minggu ISO 2026 ((n-1) mod 4)+1, selaras paritas, tidak melompat di tahun 53 minggu", () => {
    assert.equal(mingguSiklus("2026-10-12"), "m2"); // ISO 42
    assert.equal(mingguSiklus("2026-11-13"), "m2"); // ISO 46 (Jumat)
    assert.equal(mingguSiklus("2026-11-16"), "m3"); // ISO 47
    assert.equal(mingguSiklus("2026-11-23"), "m4");
    assert.equal(mingguSiklus("2026-11-30"), "m1");
    assert.equal(mingguSiklus("2026-10-05"), "m1"); // ISO 41, sebelum acuan
    assert.equal(mingguSiklus("2026-12-28"), "m1"); // ISO 53
    assert.equal(mingguSiklus("2027-01-04"), "m2"); // berjalan terus, bukan m1 lagi
    for (let i = 0; i < 120; i++) {
        const d = new Date(Date.UTC(2026, 8, 1) + i * 86_400_000).toISOString().slice(0, 10);
        assert.equal(["m1", "m3"].includes(mingguSiklus(d)), paritasMinggu(d) === "ganjil", d);
    }
    // F3 (owner 14 Nov 2026): pola tiga minggu yang memuat m3 ikut berlaku.
    assert.deepEqual(polaBerlaku("2026-11-16"), ["all", "ganjil", "m3", "m123", "m134", "m234"]);
    assert.deepEqual(polaBerlaku("2026-11-09"), ["all", "genap", "m2", "m123", "m124", "m234"]);
});

test("hari F8: beberapa hari dibakukan, dicocokkan per hari; JKS lama satu hari tetap terbaca", () => {
    assert.equal(hariBaku("kamis, SENIN"), "Senin, Kamis");
    assert.equal(hariBaku("Senin+Kamis"), "Senin, Kamis");
    assert.equal(hariBaku("Senin dan Kamis"), "Senin, Kamis");
    assert.equal(hariBaku("JUM'AT"), "Jumat");
    assert.equal(hariBaku("Senin, Minggu"), null);
    assert.equal(hariBaku(" "), "");
    assert.ok(hariCocok("Senin, Kamis", "Kamis"));
    assert.ok(!hariCocok("Senin, Kamis", "Selasa"));
    assert.ok(hariCocok("JUM'AT", "Jumat"));
    assert.equal(frekuensiBawaan("all", "Senin, Kamis"), 8);
    assert.equal(frekuensiBawaan("m3", "Senin"), 1);
    assert.equal(frekuensiBawaan("genap", "Senin"), 2);
});

test("terjadwalPada: Senin 16 Nov 2026 (m3, ganjil) memuat m3/ganjil/all dan hari F8", () => {
    const pada = terjadwalPada("2026-11-16");
    assert.ok(pada({ hariKunjungan: "Senin", mingguPattern: "m3" }));
    assert.ok(pada({ hariKunjungan: "Senin, Kamis", mingguPattern: "all" }));
    assert.ok(pada({ hariKunjungan: "SENIN", mingguPattern: " Ganjil " }));
    assert.ok(!pada({ hariKunjungan: "Senin", mingguPattern: "m1" }));
    assert.ok(!pada({ hariKunjungan: "Senin", mingguPattern: "genap" }));
    assert.ok(!pada({ hariKunjungan: "Selasa", mingguPattern: "all" }));
    assert.ok(!terjadwalPada("2026-11-15")({ hariKunjungan: "Senin", mingguPattern: "all" })); // Minggu
});

const barisJks = (x: Record<string, unknown>) => ({ SALESMAN: "KN2_IRDAWATI ALIM", PRINCIPAL: "KINO", "KODE OUTLET": "C-1", "NAMA OUTLET": "TOKO A",
    HARI: "Senin", FREKUENSI: "F1", M1: "✓", M2: "", M3: "", M4: "", URUTAN: 3, STATUS: "TETAP", CHANNEL: "GT", "LOKASI DARI": "GPS lapangan",
    LATITUDE: -5.1, LONGITUDE: 119.4, ...x });
const peta = { sales: { "KN2_IRDAWATI ALIM": "EMP-2" }, principal: { KINO: "KINO NON FOOD" } };

test("JKS Web-LL: M1..M4 -> pola, F8 dua baris -> satu baris dua hari, status pindah + koordinat lapangan", () => {
    assert.equal(polaDariMinggu([true, true, true, true]), "all");
    assert.equal(polaDariMinggu([false, true, false, true]), "genap");
    assert.equal(polaDariMinggu([false, false, true, false]), "m3");
    assert.equal(polaDariMinggu([true, true, false, false]), null);
    assert.equal(polaDariMinggu([false, false, false, false]), null);
    const r = bacaJksWebLl([
        barisJks({}),
        barisJks({ "KODE OUTLET": "C-2", HARI: "Senin", FREKUENSI: "F8", M1: "✓", M2: "✓", M3: "✓", M4: "✓", URUTAN: 9, "KELAS A": "YA" }),
        barisJks({ "KODE OUTLET": "C-2", HARI: "Kamis", FREKUENSI: "F8", M1: "✓", M2: "✓", M3: "✓", M4: "✓", URUTAN: 2, "KELAS A": "YA" }),
        barisJks({ "KODE OUTLET": "C-3", STATUS: "PINDAH SALES", "SALES SEKARANG (NOTA TERAKHIR)": "KN4_RAHAYU", "LOKASI DARI": "tengah kelurahan" }),
    ], peta);
    assert.deepEqual(r.galat, []);
    assert.equal(r.baris.length, 3);
    const c2 = r.baris.find((b) => b.custCode === "C-2")!;
    assert.equal(c2.hariKunjungan, "Senin, Kamis");
    assert.equal(c2.mingguPattern, "all");
    assert.equal(c2.visitFrequency, 8);
    assert.equal(c2.urutan, 2);
    assert.equal(c2.kelasA, true);
    const c1 = r.baris.find((b) => b.custCode === "C-1")!;
    assert.equal(c1.mingguPattern, "m1");
    assert.equal(c1.salesCode, "EMP-2");
    assert.equal(c1.principle, "KINO NON FOOD");
    assert.equal(c1.salesSebelum, null);
    assert.equal(r.baris.find((b) => b.custCode === "C-3")!.salesSebelum, "KN4_RAHAYU");
    assert.deepEqual(r.koordinat.map((k) => k.custCode).sort(), ["C-1", "C-2"]); // C-3 = perkiraan, tidak ditulis
});

test("JKS Web-LL: salesman belum dipetakan / hari bentrok = galat (impor dibatalkan pemanggil)", () => {
    const r = bacaJksWebLl([barisJks({ SALESMAN: "X_ASING" }), barisJks({ "KODE OUTLET": "C-9" }), barisJks({ "KODE OUTLET": "C-9" })], peta);
    assert.equal(r.galat.length, 2);
    assert.match(r.galat[0].pesan, /belum dipetakan/);
    assert.match(r.galat[1].pesan, /bentrok/);
});

test("tebak peta: nama kursi dibuang, principal gabungan MIX tidak ditebak", () => {
    const nilai = nilaiUntukPeta([barisJks({}), barisJks({ SALESMAN: "KN_MT2__MELIZA", PRINCIPAL: "ADNA_GUMINDO, FKS" })]);
    const t = tebakPeta(nilai, [{ salesCode: "E1", salesName: "IRDAWATI ALIM" }, { salesCode: "E2", salesName: "KN_MT2_MELIZA" }], ["KINO NON FOOD", "MIX FOOD"]);
    assert.deepEqual(t.sales, { "KN2_IRDAWATI ALIM": "E1", "KN_MT2__MELIZA": "E2" });
    assert.deepEqual(t.principal, { KINO: "KINO NON FOOD" });
});

const item = (x: Record<string, unknown>) => ({ PRINCIPAL: "UNITAMA SARI MAS, PT", CHANNEL: "GT", RANK: 1, "KODE BARANG": "U3020202007510",
    "NAMA BARANG": "DH 75G", "OMZET RATA-RATA / BULAN (ACUAN)": 100, KONTRIBUSI: 0.1, "JUMLAH TOKO BELI": 10, ...x });
const petaItem = { principal: { "UNITAMA SARI MAS, PT": "UNITAMA" }, sales: { DANI: "EMP-9" } };

test("item super: varian 13 digit + KODE DIGABUNG jadi satu saran; principal tak dipetakan dilewati; kode dobel = galat", () => {
    const r = bacaItemSuper([
        item({}),
        item({ RANK: 2, "KODE BARANG": "U3020202007510N", "OMZET RATA-RATA / BULAN (ACUAN)": 300 }),
        item({ RANK: 3, "KODE BARANG": "U9", "KODE DIGABUNG (KODE LAIN DI PENJUALAN)": "U8; U7" }),
        item({ PRINCIPAL: "LAIN, PT", "KODE BARANG": "Z1" }),
    ], [item({ SALES: "DANI", "KELOMPOK TOKO": "MT", "KODE BARANG": "U5" })], petaItem);
    assert.deepEqual(r.galat, []);
    assert.deepEqual(r.lewat.principal, ["LAIN, PT"]);
    const gt = r.saran.filter((s) => s.channel === "GT");
    assert.equal(gt.length, 2);
    assert.equal(gt[0].kodeBarang, "U3020202007510N"); // omzet terbesar = kode utama
    assert.deepEqual(gt[0].kodeLain, ["U3020202007510"]);
    assert.deepEqual(gt[1].kodeLain, ["U7", "U8"]);
    assert.deepEqual(gt.map((s) => s.peringkat), [1, 2]);
    assert.equal(r.varianDigabung, 1);
    assert.equal(r.saran.find((s) => s.salesCode === "EMP-9")?.channel, "MT");
    const dobel = bacaItemSuper([item({}), item({ RANK: 2 })], [], petaItem);
    assert.equal(dobel.galat.length, 1);
});

const s = (kode: string, peringkat: number, x: Partial<SaranItemSuper> = {}): SaranItemSuper => ({ principle: "P", channel: "GT", salesCode: "",
    kodeBarang: kode, kodeLain: [], namaBarang: kode, peringkat, kontribusi: null, omzetRata: null, jumlahToko: null, ...x });

test("saran toko: yang belum dibeli didahulukan (varian dihitung), maks MAKS_SARAN_WAJIB; daftar MT khusus sales menang", () => {
    const semua = [s("A", 1), s("B", 2, { kodeLain: ["B2"] }), s("C", 3), ...Array.from({ length: 15 }, (_, i) => s(`X${i}`, 4 + i)),
        s("M1", 1, { channel: "MT", salesCode: "S1" }), s("M9", 1, { channel: "MT" })];
    const p = pilihSaran(semua, { principle: "P", channel: "GT", salesCode: "S1" }, new Map([["A", "2026-11-01"], ["B2", "2026-10-20"]]));
    assert.equal(p.wajib.length, MAKS_SARAN_WAJIB);
    assert.deepEqual(p.wajib.slice(0, 2).map((x) => x.kodeBarang), ["C", "X0"]);
    assert.equal(p.lain.find((x) => x.kodeBarang === "B")?.terakhirDibeli, "2026-10-20");
    assert.deepEqual(pilihSaran(semua, { principle: "P", channel: "MT", salesCode: "S1" }, new Map()).wajib.map((x) => x.kodeBarang), ["M1"]);
    assert.deepEqual(pilihSaran(semua, { principle: "P", channel: "MT", salesCode: "S2" }, new Map()).wajib.map((x) => x.kodeBarang), ["M9"]);
});

test("isian penawaran: semua saran wajib dijawab; tidak dipesan wajib alasan; Lainnya wajib catatan; kode asing ditolak", () => {
    const saran = { wajib: [{ kodeBarang: "A" }, { kodeBarang: "B" }], lain: [{ kodeBarang: "C" }] };
    assert.ok("error" in periksaTawaran(null, saran));
    assert.ok("error" in periksaTawaran([{ kodeBarang: "A", ditawarkan: true, dipesan: true }], saran));
    assert.ok("error" in periksaTawaran([{ kodeBarang: "A", ditawarkan: true, dipesan: false }, { kodeBarang: "B", ditawarkan: false }], saran));
    assert.ok("error" in periksaTawaran([{ kodeBarang: "Z", ditawarkan: false, alasan: "HARGA" }], saran));
    assert.ok("error" in periksaTawaran([{ kodeBarang: "A", ditawarkan: false, alasan: "LAINNYA", catatan: "x" },
        { kodeBarang: "B", ditawarkan: true, dipesan: true }], saran));
    const ok = periksaTawaran([{ kodeBarang: "A", ditawarkan: false, dipesan: true, alasan: "TIDAK_SEMPAT" },
        { kodeBarang: "B", ditawarkan: true, dipesan: true, alasan: "HARGA" }, { kodeBarang: "C", ditawarkan: true, dipesan: false, alasan: "STOK_ADA" }], saran);
    assert.ok("baris" in ok);
    assert.deepEqual(ok.baris.map((b) => [b.kodeBarang, b.dipesan, b.alasan]), [["A", null, "TIDAK_SEMPAT"], ["B", true, null], ["C", false, "STOK_ADA"]]);
    assert.deepEqual(periksaTawaran(null, { wajib: [], lain: [] }), { baris: [] });
});

test("F3 tiga dari empat minggu: M1+M2+M3 -> m123, terjadwal di m1/m2/m3 saja, frekuensi bawaan 3 per hari", () => {
    assert.equal(polaDariMinggu([true, true, true, false]), "m123");
    assert.equal(polaDariMinggu([false, true, true, true]), "m234");
    assert.equal(polaDariMinggu([true, false, true, true]), "m134");
    const toko = { hariKunjungan: "Senin", mingguPattern: "m123" };
    // Senin 2 Nov 2026 = m1, 9 Nov = m2, 16 Nov = m3, 23 Nov = m4, 30 Nov = m1.
    assert.deepEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"].map((d) => terjadwalPada(d)(toko)), [true, true, true, false, true]);
    assert.deepEqual(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"].map((d) => terjadwalPada(d)({ hariKunjungan: "Kamis, Senin", mingguPattern: " M234 " })),
        [false, true, true, true]);
    assert.equal(frekuensiBawaan("m123", "Senin"), 3);
    const r = bacaJksWebLl([barisJks({ FREKUENSI: "F3", M1: "✓", M2: "✓", M3: "✓", M4: "" })], peta);
    assert.deepEqual(r.galat, []);
    assert.equal(r.baris[0].mingguPattern, "m123");
    assert.equal(r.baris[0].visitFrequency, 3);
});
