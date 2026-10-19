/*
 * Tujuan: Self-check aturan pure modul Rekapan Nota (klasifikasi + state machine wave).
 *         Yang diuji hanya perilaku yang kalau rusak bikin barang salah diambil atau
 *         wave ditutup padahal angkanya masih dipertanyakan.
 * Caller: npm run test:rekapan
 * Dependensi: node:test. Tidak menyentuh DB maupun file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    resolveKlasifikasi,
    hitungPareto, klasifikasiSirup, isiPerKarton, GRUP_DEFAULT,
} from "@/lib/rekapan-nota/classify";
import { tolakUbahIsi, transisiWave } from "@/lib/rekapan-nota/wave-state";

test("outlet tak terdaftar jatuh ke Gabung, area dinormalkan", () => {
    assert.deepEqual(resolveKlasifikasi(null), { area: null, grupAll: GRUP_DEFAULT, grupGdi: GRUP_DEFAULT });
    assert.deepEqual(
        resolveKlasifikasi({ area: " pgu ", grupAll: "IDM & IDG", grupGdi: null }),
        { area: "PGU", grupAll: "IDM & IDG", grupGdi: GRUP_DEFAULT },
    );
});

test("pareto memakai ambang parameter, bukan konstanta", () => {
    assert.equal(hitungPareto(50, 50), true);
    assert.equal(hitungPareto(49.9, 50), false);
    assert.equal(hitungPareto(30, 25), true);
    assert.equal(hitungPareto(null, 50), null, "tak terhitung -> exception, bukan tebakan");
});

test("sirup hanya untuk HEINZ ABC, dari prefiks kode atau nama", () => {
    assert.equal(klasifikasiSirup("HEINZ ABC", "A1092001", "ABC SYRUP"), "SIRUP");
    assert.equal(klasifikasiSirup("HEINZ ABC", "A1110001", "ABC SIRUP JERUK"), "SIRUP");
    assert.equal(klasifikasiSirup("HEINZ ABC", "A1110001", "ABC TOMAT PILLOW"), "NON SIRUP");
    assert.equal(klasifikasiSirup("CUSSONS", "A1092001", "APA SAJA"), null);
});

test("konversi dari transaksi menang atas master yang bisa basi", () => {
    assert.equal(isiPerKarton(48, 24), 48);
    assert.equal(isiPerKarton(null, 24), 24);
    assert.equal(isiPerKarton(null, null), null, "null -> baris tetap dicetak, Sat Bsr kosong");
    assert.equal(isiPerKarton(0, 0), null);
});

test("release boleh dengan exception open, confirm tidak", () => {
    const berisi = { jumlahNota: 10, konversiOpen: 3 };
    assert.deepEqual(transisiWave("draft", "release", berisi), {
        ok: true, status: "released", event: "wave.released",
    });
    const gagal = transisiWave("released", "confirm", berisi);
    assert.equal(gagal.ok, false);
    assert.deepEqual(transisiWave("released", "confirm", { jumlahNota: 10, konversiOpen: 0 }), {
        ok: true, status: "confirmed", event: "wave.confirmed",
    });
});

test("wave kosong tidak bisa dirilis, wave selesai tidak bisa mundur", () => {
    assert.equal(transisiWave("draft", "release", { jumlahNota: 0, konversiOpen: 0 }).ok, false);
    assert.equal(transisiWave("confirmed", "release", { jumlahNota: 5, konversiOpen: 0 }).ok, false);
    assert.equal(transisiWave("cancelled", "confirm", { jumlahNota: 5, konversiOpen: 0 }).ok, false);
    assert.equal(transisiWave("released", "cancel", { jumlahNota: 5, konversiOpen: 9 }).ok, true);
});

test("BL-25: isi wave tertutup tidak bisa diubah; exception masih bisa ditutup setelah konfirmasi", () => {
    for (const aksi of ["takeout", "prioritas", "set_grup"] as const) {
        assert.equal(tolakUbahIsi("draft", aksi), null);
        assert.equal(tolakUbahIsi("released", aksi), null);
        assert.match(tolakUbahIsi("confirmed", aksi) ?? "", /sudah dikonfirmasi/);
        assert.match(tolakUbahIsi("cancelled", aksi) ?? "", /sudah dibatalkan/);
    }
    assert.equal(tolakUbahIsi("draft", "tambah"), null);
    assert.match(tolakUbahIsi("released", "tambah") ?? "", /tidak bisa ditambah/);
    assert.equal(tolakUbahIsi("confirmed", "tutup_exception"), null, "selisih file (BL-54) bisa muncul sesudah konfirmasi");
    assert.match(tolakUbahIsi("cancelled", "tutup_exception") ?? "", /tidak bisa ditutup/);
});
