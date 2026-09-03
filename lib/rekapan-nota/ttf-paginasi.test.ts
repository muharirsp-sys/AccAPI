/*
 * Tujuan: Self-check paginasi TTF. Yang dijaga bukan "hasilnya rapi", tapi tiga jaminan
 *         kontrol dokumen: tidak ada baris hilang, tidak ada halaman meluber (kalau meluber,
 *         browser memecah lagi dan nomor halaman jadi bohong), dan halaman terakhir masih
 *         menyisakan ruang untuk blok paraf.
 * Caller: npm run test:rekapan
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    bagiHalamanTtf, TINGGI_BARIS_MM, RUANG_ISI_MM, RUANG_ISI_HAL1_MM, TINGGI_PARAF_MM,
} from "./ttf-paginasi";

const deret = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const anggaran = (h: number) => (h === 0 ? RUANG_ISI_HAL1_MM : RUANG_ISI_MM);

test("tidak ada nota yang hilang atau berpindah urutan", () => {
    for (const n of [0, 1, 18, 19, 20, 21, 40, 958]) {
        const isi = bagiHalamanTtf(deret(n));
        assert.deepEqual(isi.flat(), deret(n), `n=${n}`);
    }
});

test("tidak ada halaman yang melebihi anggaran tingginya", () => {
    const isi = bagiHalamanTtf(deret(958));
    isi.forEach((hal, h) => {
        assert.ok(hal.length * TINGGI_BARIS_MM <= anggaran(h),
            `halaman ${h + 1} meluber: ${hal.length} baris`);
    });
});

test("halaman terakhir menyisakan ruang untuk blok paraf", () => {
    // 19 baris pas memenuhi halaman 1 tanpa sisa untuk paraf -> harus tumpah ke halaman 2.
    for (const n of [1, 5, 19, 20, 40, 958]) {
        const isi = bagiHalamanTtf(deret(n));
        const akhir = isi[isi.length - 1];
        const sisa = anggaran(isi.length - 1) - akhir.length * TINGGI_BARIS_MM;
        assert.ok(sisa >= TINGGI_PARAF_MM, `n=${n}: sisa ${sisa.toFixed(1)}mm < paraf`);
    }
});

test("wave kosong tetap menghasilkan satu halaman", () => {
    assert.deepEqual(bagiHalamanTtf([]), [[]]);
});
