/*
 * Tujuan: Jaga alamatAccurate() — pemasok customer.alamat dari cron sync Accurate.
 * Caller: `npm run test:rekapan`.
 * Dependensi: lib/sync (alamatAccurate). Pure, tanpa DB dan tanpa jaringan.
 *
 * Kenapa fungsi sekecil ini diuji: nilai baliknya menentukan cabang SQL di sisi lain.
 * `""` dan `null` terlihat sama di layar, tapi `nullif(excluded."alamat", '')` hanya
 * menyelamatkan salah satunya — dan alamat kosong yang lolos akan MENGISI kolom yang
 * seharusnya tetap kosong, lalu memblokir impor master mengisinya nanti.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { alamatAccurate } from "@/lib/sync";

test("menggabung bill* yang terisi, dipisah koma", () => {
    assert.equal(
        alamatAccurate({ billStreet: "JL. PERINTIS NO. 12", billCity: "MAKASSAR", billProvince: "SULAWESI SELATAN" }),
        "JL. PERINTIS NO. 12, MAKASSAR, SULAWESI SELATAN",
    );
});

test("bagian kosong dibuang, bukan jadi koma menggantung", () => {
    assert.equal(alamatAccurate({ billStreet: "JL. VETERAN", billCity: "", billProvince: null }), "JL. VETERAN");
});

test("outlet tanpa alamat -> null, bukan string kosong", () => {
    // Ini yang menjaga kolom tetap kosong supaya impor master masih boleh mengisinya.
    assert.equal(alamatAccurate({}), null);
    assert.equal(alamatAccurate({ billStreet: "   ", billCity: "", billProvince: undefined }), null);
});

test("spasi berlebih dirapikan — token alamat dipakai pencocokan Jaccard", () => {
    assert.equal(alamatAccurate({ billStreet: "JL.   SUDIRMAN\tNO 8 " }), "JL. SUDIRMAN NO 8");
});

test("Kel./Kec. yang ikut di billStreet tetap utuh untuk parseKelKec()", () => {
    assert.equal(
        alamatAccurate({ billStreet: "JL. TODDOPULI RAYA _ Kel.BORONG Kec. MANGGALA", billCity: "MAKASSAR" }),
        "JL. TODDOPULI RAYA _ Kel.BORONG Kec. MANGGALA, MAKASSAR",
    );
});
