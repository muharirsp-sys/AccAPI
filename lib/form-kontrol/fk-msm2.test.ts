/* FK-MSM2 (kunjungan luar rute + konfirmasi JKS) TANPA DB: kode JKS untuk pelanggan Accurate (kebalikan cocokKodeRute) dan pemeriksaan isian
 * konfirmasi. Perilaku route ASLI pada Postgres = lib/form-kontrol/fk-msm2-pg.test.ts. Data contoh generik. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { periksaKeputusan } from "./luar-rute.ts";
import { kodeJksUntuk } from "./constants.ts";
import { cocokKodeRute } from "../order-cabang.ts";

test("kodeJksUntuk = kebalikan PERSIS cocokKodeRute (kode JKS pendek/lengkap untuk satu pelanggan Accurate)", () => {
    assert.deepEqual(kodeJksUntuk(" c-100001-cba "), ["C-100001-CBA", "C-100001"]);
    assert.deepEqual(kodeJksUntuk("C- FA0164-CBA"), ["C- FA0164-CBA", "C- FA0164"], "spasi dalam dipertahankan");
    assert.deepEqual(kodeJksUntuk("C-100001-"), ["C-100001-"]);
    assert.deepEqual(kodeJksUntuk("-CBA"), ["-CBA"]);
    assert.deepEqual(kodeJksUntuk(""), []);
    // Untuk setiap pasangan (kode JKS, customerNo): cocokKodeRute(k, c) <=> kodeJksUntuk(c) memuat k (huruf besar, ter-trim).
    const pelanggan = ["C-100001-CBA", "C-100001", "C-2000-01-CBA", "C- FA0164-CBA", "C-100001-", "X", "C-100010-CBA", "c-100001-cba"];
    const jks = ["C-100001", "c-100001 ", "C-100001-CBA", "C-2000", "C-2000-01", "C- FA0164", "C-FA0164", "C-10001", "C", "", "X"];
    for (const c of pelanggan) for (const k of jks) {
        assert.equal(kodeJksUntuk(c).includes(k.trim().toUpperCase()) && k.trim() !== "", cocokKodeRute(k, c), `${JSON.stringify(k)} vs ${c}`);
    }
});

test("periksaKeputusan: 'tidak'; 'jks' wajib hari Senin–Sabtu (bentuk baku) + minggu ganjil/genap/all; lainnya kalimat penolakan", () => {
    assert.deepEqual(periksaKeputusan({ keputusan: "tidak", hari: "x" }), { keputusan: "tidak" });
    assert.deepEqual(periksaKeputusan({ keputusan: "jks", hari: " jum'at ", mingguPattern: " GANJIL " }), { keputusan: "jks", hari: "Jumat", minggu: "ganjil" });
    assert.deepEqual(periksaKeputusan({ keputusan: "jks", hari: "Sabtu", mingguPattern: "all" }), { keputusan: "jks", hari: "Sabtu", minggu: "all" });
    for (const [isi, pesan] of [
        [{ keputusan: "nanti" }, /masukkan ke JKS/],
        [{ keputusan: "jks", hari: "Minggu", mingguPattern: "all" }, /Senin–Sabtu/],
        [{ keputusan: "jks", hari: "", mingguPattern: "all" }, /Senin–Sabtu/],
        [{ keputusan: "jks", hari: "Senin", mingguPattern: "" }, /ganjil, genap, atau setiap minggu/],
        [{ keputusan: "jks", hari: "Senin", mingguPattern: "tiap" }, /ganjil, genap, atau setiap minggu/],
    ] as const) {
        const h = periksaKeputusan(isi as Record<string, unknown>);
        assert.ok("error" in h, JSON.stringify(isi));
        assert.match(h.error, pesan);
    }
});
