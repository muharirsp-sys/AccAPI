/* Uji murni petunjuk arah toko (owner 14 Nov 2026: jadwal harian — Google Maps, bagikan, cetak) + GPS wajib check-in/check-out. Data generik. */
import assert from "node:assert/strict";
import test from "node:test";
import { alamatRingkas, htmlRute, punyaTitik, teksRealisasi, teksRute, urlPeta, type TokoPeta } from "./peta";
import { periksaGps } from "./gps";

const A: TokoPeta = { custCode: "C-1", custName: "TOKO A", market: "Pasar Sentral A", alamat: "PASAR SENTRAL A BLOK 2", kota: "KOTA A",
    lat: -5.1477001, lng: 119.4327, urutan: 2, kelasA: true, targetToko: 1_500_000, omzetRata: 1_200_000 };
const B: TokoPeta = { custCode: "C-2", custName: "TOKO B & CO", market: "Jl. Mawar", alamat: "JL MAWAR 5", kota: "KOTA A", urutan: 1 };

test("alamat ringkas: pasar/jalan dan kota tidak diulang bila sudah termuat di alamat; spasi dirapikan", () => {
    assert.equal(alamatRingkas(A), "PASAR SENTRAL A BLOK 2, KOTA A");
    assert.equal(alamatRingkas(B), "Jl. Mawar, JL MAWAR 5, KOTA A");
    assert.equal(alamatRingkas({ alamat: "  JL  MELATI   1 ", kota: "KOTA B", market: null }), "JL MELATI 1, KOTA B");
    assert.equal(alamatRingkas({}), "");
});

test("tautan Google Maps: ada titik = petunjuk arah ke titik (6 desimal); tanpa titik = cari nama + alamat (ter-encode)", () => {
    assert.ok(punyaTitik(A));
    assert.equal(urlPeta(A), "https://www.google.com/maps/dir/?api=1&destination=-5.147700,119.432700");
    assert.ok(!punyaTitik(B));
    assert.equal(urlPeta(B), `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("TOKO B & CO, Jl. Mawar, JL MAWAR 5, KOTA A")}`);
    assert.ok(!punyaTitik({ lat: Number.NaN, lng: 119 }), "NaN bukan titik");
});

test("teks rute (bagikan): judul lalu toko sesuai urutan dengan alamat, Kelas A/target/omzet, dan tautan peta", () => {
    const t = teksRute("Rute SALES A · PRINCIPLE A · Senin, 16 Nov 2026 (minggu M3)", [B, A]);
    const bagian = t.split("\n\n");
    assert.equal(bagian[0], "Rute SALES A · PRINCIPLE A · Senin, 16 Nov 2026 (minggu M3)");
    assert.match(bagian[1], /^1\. TOKO B & CO \(C-2\)\n {3}Jl\. Mawar, JL MAWAR 5, KOTA A\n {3}Peta: https:\/\/www\.google\.com\/maps\/search\/.+ \(cari alamat\)$/);
    assert.match(bagian[2], /^2\. TOKO A \(C-1\)\n {3}PASAR SENTRAL A BLOK 2, KOTA A\n {3}Kelas A · target 1,5\sjt\/bln · omzet ±1,2\sjt\/bln\n {3}Peta: https:\/\/www\.google\.com\/maps\/dir\//);
});

test("realisasi bulan berjalan (owner 14 Nov 2026): total + jumlah faktur + % target; nol = belum ada faktur; tak diketahui = kosong", () => {
    assert.match(teksRealisasi({ realisasiBulan: 750_000, fakturBulan: 3, targetToko: 1_500_000 }), /^realisasi 750\srb \(3 faktur, 50% target\)$/);
    assert.match(teksRealisasi({ realisasiBulan: 750_000, fakturBulan: 3, targetToko: null }), /^realisasi 750\srb \(3 faktur\)$/);
    assert.equal(teksRealisasi({ realisasiBulan: 0, fakturBulan: 0, targetToko: 1_000 }), "belum ada faktur bulan ini");
    assert.equal(teksRealisasi({ realisasiBulan: null, fakturBulan: null }), "");
    assert.match(teksRute("Rute", [{ ...A, realisasiBulan: 600_000, fakturBulan: 2 }]), /Kelas A · target 1,5\sjt\/bln · realisasi 600\srb \(2 faktur, 40% target\) · omzet/);
});

test("halaman cetak: isi di-escape (nama toko berisi tag tidak menjadi HTML)", () => {
    const h = htmlRute("Rute <b>", [{ custCode: "C-3", custName: "<script>alert(1)</script>", alamat: "JL \"A\"" }]);
    assert.ok(!h.includes("<script>alert"));
    assert.ok(h.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(h.includes("<title>Rute &lt;b&gt;</title>"));
    assert.ok(h.includes("JL &quot;A&quot;"));
    assert.ok(h.includes(">Cari alamat</a>"));
});

test("GPS wajib check-in/check-out: tanpa titik = GPS_WAJIB, di luar rentang = GPS_TIDAK_SAH, angka JSON sah = titik", () => {
    const kode = (b: Record<string, unknown>) => { const r = periksaGps(b, "check-in"); return "galat" in r ? r.galat.kode : "OK"; };
    assert.equal(kode({}), "GPS_WAJIB");
    assert.equal(kode({ lat: null, lng: null, accuracy: null }), "GPS_WAJIB");
    assert.equal(kode({ lat: "-5.1", lng: "119.4", accuracy: "10" }), "GPS_WAJIB", "teks bukan angka JSON");
    assert.equal(kode({ lat: -5.1, lng: 119.4 }), "GPS_WAJIB", "akurasi wajib");
    assert.equal(kode({ lat: 91, lng: 119.4, accuracy: 10 }), "GPS_TIDAK_SAH");
    assert.equal(kode({ lat: -5.1, lng: 119.4, accuracy: -1 }), "GPS_TIDAK_SAH");
    const r = periksaGps({ lat: -5.1, lng: 119.4, accuracy: 12 }, "check-out");
    assert.deepEqual(r, { titik: { lat: -5.1, lng: 119.4, accuracy: 12 } });
    const g = periksaGps({}, "check-out");
    assert.ok("galat" in g && g.galat.status === 400 && g.galat.error.includes("check-out"));
});
