/* Uji murni validasi lokasi (owner 14 Nov 2026): radius check-in/check-out fix 20 m / validasi 100 m, alasan pengajuan IT, berkas status titik,
 * titik tengah check-in. Data generik. */
import assert from "node:assert/strict";
import test from "node:test";
import { RADIUS_M, TOLERANSI_AKURASI_M, alasanAjuanSah, kalimatLuarRadius, periksaRadius, statusTitik } from "./radius";
import { bacaStatusTitik, ringkasTitikCheckin } from "./lokasi";

const TOKO = { lat: -5.1477, lng: 119.4327 };
/** Titik ±n meter ke utara dari TOKO (1° lintang ≈ 111 195 m). */
const utara = (m: number) => ({ lat: TOKO.lat + m / 111_195, lng: TOKO.lng });

test("radius: fix 20 m, validasi 100 m; tanpa titik toko = tanpa batas; status tak dikenal = validasi (longgar)", () => {
    assert.deepEqual(RADIUS_M, { fix: 20, validasi: 100 });
    assert.deepEqual(periksaRadius(utara(15), { ...TOKO, status: "fix" }), { dalam: true, jarakM: 15, radiusM: 20 });
    const luar = periksaRadius(utara(35), { ...TOKO, status: "fix" });
    assert.ok(!luar.dalam && luar.jarakM === 35 && luar.radiusM === 20 && luar.statusTitik === "fix");
    assert.ok(periksaRadius(utara(35), { ...TOKO, status: "validasi" }).dalam, "35 m masih dalam 100 m");
    const jauh = periksaRadius(utara(150), { ...TOKO, status: "validasi" });
    assert.ok(!jauh.dalam && jauh.radiusM === 100);
    assert.deepEqual(periksaRadius(utara(5_000), null), { dalam: true, jarakM: null, radiusM: null });
    assert.equal(statusTitik("fix"), "fix");
    assert.equal(statusTitik("aneh"), "validasi");
    if (!luar.dalam) {
        const k = kalimatLuarRadius(luar, 12.4, "check-in");
        assert.match(k, /check-in Anda ±35 m dari titik toko \(batas 20 m untuk titik fix, ditambah toleransi akurasi GPS ±0 m dari akurasi ±12 m\)/);
        assert.match(k, /ajukan ke IT/);
    }
});

test("toleransi akurasi GPS (owner 14 Nov 2026): jarak − min(akurasi, 15 m) ≤ batas; akurasi tak ada = tanpa toleransi", () => {
    assert.equal(TOLERANSI_AKURASI_M, 15);
    const fix = { ...TOKO, status: "fix" as const };
    assert.ok(periksaRadius({ ...utara(30), accuracy: 12 }, fix).dalam, "30 − 12 = 18 ≤ 20");
    const a = periksaRadius({ ...utara(35), accuracy: 12 }, fix);
    assert.ok(!a.dalam && a.toleransiM === 12, "35 − 12 = 23 > 20");
    assert.ok(periksaRadius({ ...utara(35), accuracy: 500 }, fix).dalam, "akurasi buruk dibatasi 15 m: 35 − 15 = 20");
    assert.ok(!periksaRadius({ ...utara(36), accuracy: 500 }, fix).dalam, "36 − 15 = 21 > 20");
    assert.ok(!periksaRadius({ ...utara(21), accuracy: null }, fix).dalam);
    assert.ok(periksaRadius({ ...utara(110), accuracy: 10 }, { ...TOKO, status: "validasi" }).dalam, "110 − 10 = 100");
});

test("alasan pengajuan IT: dirapikan, 10–300 huruf; selain itu null", () => {
    assert.equal(alasanAjuanSah("  titik  toko salah di peta "), "titik toko salah di peta");
    assert.equal(alasanAjuanSah("pendek"), null);
    assert.equal(alasanAjuanSah(42), null);
    assert.equal(alasanAjuanSah("x".repeat(301)), null);
});

test("berkas status titik: tiga sheet -> validasi; LATITUDE/LONGITUDE BENAR -> fix; kode ganda: fix menang; titik benar tidak sah = galat", () => {
    const h = bacaStatusTitik({
        "1_SANGAT_BERBEDA": [{ KODE0: " c-1 ", "LATITUDE BENAR": "", "LONGITUDE BENAR": "" }, { KODE0: "C-2", "LATITUDE BENAR": "-5,1", "LONGITUDE BENAR": 119.4 }],
        "2_BERBEDA": [{ KODE0: "C-3" }, { KODE0: "C-4", "LATITUDE BENAR": 91, "LONGITUDE BENAR": 119 }, { KODE0: "" }],
        "3_ALAMAT_KELIRU": [{ KODE0: "C-1", "LATITUDE BENAR": -5.2, "LONGITUDE BENAR": 119.5 }],
        "SEMUA_TOKO": [{ KODE0: "C-9" }],
    });
    assert.deepEqual(h.sheetDibaca, ["1_SANGAT_BERBEDA", "2_BERBEDA", "3_ALAMAT_KELIRU"]);
    assert.deepEqual(h.baris, [
        { custCode: "C-1", sheet: "Alamat keliru", status: "fix", lat: -5.2, lng: 119.5 },
        { custCode: "C-2", sheet: "Sangat berbeda", status: "fix", lat: -5.1, lng: 119.4 },
        { custCode: "C-3", sheet: "Berbeda", status: "validasi" },
        { custCode: "C-4", sheet: "Berbeda", status: "validasi" },
    ]);
    assert.equal(h.galat.length, 1);
    assert.deepEqual([h.galat[0].sheet, h.galat[0].baris], ["2_BERBEDA", 3]);
    assert.deepEqual(bacaStatusTitik({ "SEMUA_TOKO": [{ KODE0: "C-9" }] }).sheetDibaca, []);
});

test("titik tengah check-in: median tahan pencilan, sebaran = jarak terjauh, jumlah salesman berbeda", () => {
    const t = (m: number, s: string) => ({ salesCode: s, tanggal: "2026-11-14", ...utara(m), akurasi: 10 });
    const r = ringkasTitikCheckin([t(0, "S1"), t(10, "S2"), t(12, "S1"), t(2_000, "S3")])!;
    assert.equal(Math.round((r.lat - TOKO.lat) * 111_195), 11, "median lintang = rata-rata dua titik tengah (10 m & 12 m)");
    assert.equal(r.jumlah, 4);
    assert.equal(r.salesman, 3);
    assert.ok(r.sebaranM > 1_900 && r.sebaranM < 2_000, "pencilan 2 km terlihat di sebaran, tidak menggeser titik tengah");
    assert.equal(ringkasTitikCheckin([]), null);
});
