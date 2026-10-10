/* Fiori S6b Finance: keputusan murni layar — izin di satu fungsi, status transfer ≠ posting, kunci baris, "tidak ada" ≥ 2 menit,
 * penyaring catatan lama. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL_POSTING, alasanFaktur, bedaPengajuan, potongKelompok, alasanTidakAda, catatanPosting, izinFinance, kodeTampil, kunciBaris, saringCatatan, statusPosting, statusTransfer, type AttemptFinance } from "./finance-ui.ts";

const attempt = (over: Partial<AttemptFinance>): AttemptFinance => ({
    attemptId: "a1", state: "unknown", status: "unknown", stale: false, accurateNumber: "", actorName: "Finance A", clientRef: "K1", targetDbId: "DB-1",
    ageSeconds: 30, createdAt: "2026-10-10T01:00:00.000Z", updatedAt: "2026-10-10T01:00:00.000Z", createdAtWita: "2026-10-10 09:00:00", updatedAtWita: "2026-10-10 09:00:00", message: "", ...over,
});

test("izin: satu fungsi; tanpa kunci = alasan terlihat tanpa nama kunci mentah", () => {
    const semua = izinFinance(new Set(["finance.view", "finance.update", "finance.resolve_unknown"]));
    assert.deepEqual(semua, { posting: undefined, tujuan: undefined, status: undefined, selesaikan: undefined, ekspor: undefined });
    const lihat = izinFinance(new Set(["finance.view"]));
    for (const k of ["posting", "tujuan", "status", "selesaikan"] as const) {
        assert.ok(lihat[k], `${k} harus nonaktif tanpa izin ubah/selesaikan`);
        assert.doesNotMatch(lihat[k]!, /finance\.|resolve_unknown|\.update/, `${k} menyebut kunci mentah`);
    }
    assert.equal(lihat.ekspor, undefined);
    // D-14: penyelesai tanpa izin ubah tetap bisa menyelesaikan, tetapi tidak memposting.
    const penyelesai = izinFinance(new Set(["finance.view", "finance.resolve_unknown"]));
    assert.equal(penyelesai.selesaikan, undefined);
    assert.ok(penyelesai.posting);
    assert.ok(izinFinance(new Set()).ekspor);
});

test("status transfer dipisah dari status posting", () => {
    assert.deepEqual(statusTransfer("Sudah Transfer", "2026-10-06"), { label: "Ditransfer 06/10/2026", tone: "pos" });
    assert.equal(statusTransfer("Ajukan Ulang").tone, "warn");
    assert.equal(statusTransfer("").label, "Belum transfer");
});

const MILIK = { key: "K1", dbId: "DB-1" };

test("status posting: attempt sending segar = sedang; basi/unknown = tidak pasti; posted server tanpa catatan = catatan tertinggal", () => {
    assert.equal(statusPosting({ accurate_post_status: "" }, attempt({ status: "sending", state: "sending" }), MILIK).kode, "sedang");
    assert.equal(statusPosting({ accurate_post_status: "" }, attempt({ status: "stale", state: "sending", stale: true }), MILIK).kode, "tidak_pasti");
    assert.equal(statusPosting({ accurate_post_status: "unknown" }, null, MILIK).kode, "tidak_pasti");
    assert.equal(statusPosting({ accurate_post_status: "failed" }, attempt({ status: "unknown" }), MILIK).kode, "tidak_pasti", "attempt tidak pasti mengalahkan gagal");
    assert.deepEqual(statusPosting({ accurate_post_status: "posted", accurate_purchase_payment_number: "PP/1" }, null, MILIK), { kode: "terposting", nomor: "PP/1", catatanTertinggal: false });
    assert.deepEqual(statusPosting({ accurate_post_status: "" }, attempt({ status: "posted", state: "posted", accurateNumber: "PP/2" }), MILIK), { kode: "terposting", nomor: "PP/2", catatanTertinggal: true });
    assert.equal(statusPosting({ accurate_post_status: "failed" }, null, MILIK).kode, "gagal");
    assert.equal(statusPosting({ accurate_post_status: "skipped" }, null, MILIK).kode, "belum");
});

test("A-3: attempt posted hanya milik record (clientRef) & database sesi yang sama; selain itu tidak pasti", () => {
    const posted = attempt({ status: "posted", state: "posted", accurateNumber: "PP/2" });
    assert.equal(statusPosting({}, posted, MILIK).kode, "terposting");
    assert.equal(statusPosting({}, posted, { key: "K2", dbId: "DB-1" }).kode, "tidak_pasti", "record lain dengan himpunan faktur sama");
    assert.equal(statusPosting({}, posted, { key: "K1", dbId: "DB-9" }).kode, "tidak_pasti", "database sesi lain");
    assert.equal(statusPosting({}, posted, { key: "K1", dbId: "" }).kode, "tidak_pasti", "database sesi tidak terbaca");
    assert.equal(statusPosting({}, attempt({ status: "posted", state: "posted", clientRef: "" }), MILIK).kode, "tidak_pasti");
    assert.equal(statusPosting({ accurate_post_status: "posted" }, posted, { key: "K2", dbId: "DB-9" }).kode, "terposting", "catatan Finance record ini tetap berlaku");
});

test("B-3: status posting server tak terbaca = 'tidak terbaca' (bukan 'belum'); catatan Finance posted/unknown tetap berlaku; mengunci", () => {
    const tak = { ...MILIK, terbaca: false };
    assert.equal(statusPosting({ accurate_post_status: "" }, null, tak).kode, "tak_terbaca");
    assert.equal(statusPosting({ accurate_post_status: "failed" }, null, tak).kode, "tak_terbaca");
    assert.equal(statusPosting({ accurate_post_status: "posted", accurate_purchase_payment_number: "PP/1" }, null, tak).kode, "terposting");
    assert.equal(statusPosting({ accurate_post_status: "unknown" }, null, tak).kode, "tidak_pasti");
    assert.equal(LABEL_POSTING.tak_terbaca.label, "Status posting tidak terbaca");
    const izin = izinFinance(new Set(["finance.view", "finance.update", "finance.resolve_unknown"]));
    const k = kunciBaris({ posting: { kode: "tak_terbaca", nomor: "", catatanTertinggal: false }, izin });
    assert.match(k.posting!, /tidak terbaca/);
    assert.match(k.status!, /tidak terbaca/);
    assert.equal(kodeTampil("tak_terbaca", true), "tidak_pasti");
});

test("kunci baris: terposting/tidak pasti/sedang/data usang mengunci; gagal jelas boleh dikirim ulang", () => {
    const izin = izinFinance(new Set(["finance.view", "finance.update", "finance.resolve_unknown"]));
    const k = (kode: Parameters<typeof kunciBaris>[0]["posting"]["kode"], over: Partial<Parameters<typeof kunciBaris>[0]> = {}) =>
        kunciBaris({ posting: { kode, nomor: "", catatanTertinggal: false }, izin, ...over });
    assert.match(k("terposting").posting!, /Sudah terposting/);
    assert.match(k("terposting").status!, /tidak bisa dikembalikan/);
    // Alasan tampil ke pengguna: tanpa kode BL mentah.
    for (const kode of ["belum", "sedang", "terposting", "tidak_pasti", "gagal", "tak_terbaca"] as const) {
        for (const alasan of Object.values(k(kode))) if (alasan) assert.doesNotMatch(alasan, /BL-\d/, `${kode}: ${alasan}`);
    }
    assert.match(k("tidak_pasti").posting!, /tidak pasti/);
    assert.match(k("tidak_pasti").status!, /selesaikan dulu/);
    assert.equal(k("tidak_pasti").selesaikan, undefined);
    assert.match(k("sedang").posting!, /Sedang diposting/);
    assert.match(k("sedang").selesaikan!, /Hanya untuk|Sedang/);
    assert.deepEqual(k("gagal"), { posting: undefined, status: undefined, selesaikan: "Hanya untuk posting tidak pasti.", tujuan: undefined });
    assert.match(k("belum", { kunciLokal: true }).posting!, /tidak pasti/, "hasil tidak pasti di tab ini mengunci sampai diselesaikan");
    assert.equal(k("belum", { sumber: "Data gagal dimuat ulang." }).posting, "Data gagal dimuat ulang.");
    assert.equal(kunciBaris({ posting: { kode: "terposting", nomor: "PP/2", catatanTertinggal: true }, izin }).posting, undefined, "catatan tertinggal boleh dicatat");
    const tanpaIzin = kunciBaris({ posting: { kode: "belum", nomor: "", catatanTertinggal: false }, izin: izinFinance(new Set(["finance.view"])) });
    assert.ok(tanpaIzin.posting && tanpaIzin.status && tanpaIzin.tujuan);
});

test("A-2/B-2: kunci lokal hanya untuk belum/gagal — hasil terposting (catatan tertinggal) tetap bisa dicatat di tab yang sama", () => {
    const izin = izinFinance(new Set(["finance.view", "finance.update", "finance.resolve_unknown"]));
    assert.equal(kodeTampil("belum", true), "tidak_pasti");
    assert.equal(kodeTampil("gagal", true), "tidak_pasti");
    for (const kode of ["terposting", "sedang", "tidak_pasti", "belum"] as const) assert.equal(kodeTampil(kode, false), kode);
    assert.equal(kodeTampil("terposting", true), "terposting");
    assert.equal(kodeTampil("sedang", true), "sedang");
    const tertinggal = kunciBaris({ posting: { kode: "terposting", nomor: "PP/2", catatanTertinggal: true }, izin, kunciLokal: true });
    assert.equal(tertinggal.posting, undefined, "Catat hasil posting tidak boleh buntu karena kunci lokal");
    assert.match(tertinggal.selesaikan!, /Hanya untuk posting tidak pasti/);
    assert.match(kunciBaris({ posting: { kode: "gagal", nomor: "", catatanTertinggal: false }, izin, kunciLokal: true }).posting!, /tidak pasti/);
});

test("Putaran 2 B-1: catatan Finance unknown + attempt posted milik sendiri — Catat hasil posting hanya bagi pemegang izin selesaikan", () => {
    const posted = attempt({ status: "posted", state: "posted", accurateNumber: "PP/2" });
    const tidakPasti = statusPosting({ accurate_post_status: "unknown" }, posted, MILIK);
    assert.equal(tidakPasti.kode, "terposting");
    assert.equal(tidakPasti.catatanTertinggal, true);
    const tanpaSelesai = kunciBaris({ posting: tidakPasti, izin: izinFinance(new Set(["finance.view", "finance.update"])) });
    assert.match(tanpaSelesai.posting!, /^Catatan Finance pengajuan ini masih Tidak pasti/);
    assert.doesNotMatch(tanpaSelesai.posting!, /finance\.|resolve_unknown/, "tanpa kunci mentah");
    assert.doesNotMatch(tanpaSelesai.posting!, /tekan/i, "tidak menyuruh menekan tombol yang ditolak");
    const finance = izinFinance(new Set(["finance.view", "finance.update", "finance.resolve_unknown"]));
    assert.equal(kunciBaris({ posting: tidakPasti, izin: finance }).posting, undefined, "Finance boleh mencatat");
    // Catatan Finance kosong (bukan unknown): pencatatan posted tidak butuh izin selesaikan.
    const kosong = statusPosting({ accurate_post_status: "" }, posted, MILIK);
    assert.equal(kunciBaris({ posting: kosong, izin: izinFinance(new Set(["finance.view", "finance.update"])) }).posting, undefined);
    // Galat server yang memuat nama kunci izin tidak menampilkannya.
    assert.equal(saringCatatan("Penyelesaian status posting TIDAK PASTI hanya untuk kewenangan Finance (finance.resolve_unknown)."),
        "Penyelesaian status posting TIDAK PASTI hanya untuk kewenangan Finance.");
});

test("'Tidak ada di Accurate' hanya setelah percobaan basi ≥ 2 menit; tanpa attempt server boleh", () => {
    assert.equal(alasanTidakAda(null, 0), undefined);
    assert.equal(alasanTidakAda(attempt({ stale: true, ageSeconds: 10 }), 0), undefined);
    assert.match(alasanTidakAda(attempt({ ageSeconds: 30 }), 0)!, /2 menit/);
    assert.equal(alasanTidakAda(attempt({ ageSeconds: 30 }), 95), undefined, "umur bertambah sejak dimuat");
    // Dibuat 10 menit lalu tetapi DIUBAH 30 detik lalu (mis. sending → unknown): server menghitung basi dari updatedAt.
    const baruDiubah = attempt({ ageSeconds: 600, updatedAt: "2026-10-10T01:09:30.000Z" });
    assert.match(alasanTidakAda(baruDiubah, 0)!, /2 menit/);
    assert.equal(alasanTidakAda(baruDiubah, 95), undefined);
    assert.match(alasanTidakAda(attempt({ ageSeconds: 600, updatedAt: "" }), 0)!, /2 menit/, "updatedAt tak terbaca = dianggap baru berubah");
});

test("catatan lama disaring: tanpa 'Coba lagi' dan tanpa alamat server lokal", () => {
    assert.equal(saringCatatan("Accurate tidak merespons dalam 30 detik (timeout). Coba lagi."), "Accurate tidak merespons dalam 30 detik (timeout).");
    assert.equal(saringCatatan("Koneksi ke backend Python gagal. Pastikan localhost:8000 aktif."), "Koneksi ke backend Python gagal. Pastikan server aktif.");
    assert.equal(saringCatatan("gagal http://localhost:8000/payments/x"), "gagal server");
    // Ajakan di tengah kalimat: seluruh kalimat itu dibuang (dulu tersisa potongan "Gagal menyimpan; nanti setelah …").
    assert.equal(saringCatatan("Gagal menyimpan; coba lagi nanti setelah server pulih. Data lain aman."), "Data lain aman.");
    assert.equal(saringCatatan("Status posting tidak bisa dibaca dari database. Coba lagi."), "Status posting tidak bisa dibaca dari database.");
    assert.equal(saringCatatan("Percobaan yang dicoba lagi tetap tercatat."), "Percobaan yang dicoba lagi tetap tercatat.", "'dicoba lagi' bukan ajakan");
    const n = catatanPosting("tidak_pasti", "Accurate tidak merespons (timeout). Coba lagi.", "failed");
    assert.match(n, /^TIDAK PASTI/);
    assert.doesNotMatch(n, /Coba lagi/);
    assert.match(catatanPosting("gagal", "dicek manual: tidak ada di Accurate", "failed"), /Boleh diposting ulang/);
});

test("B-5: baris dibaca ulang sebelum tulis — nilai/faktur/status berubah atau hilang = batal", () => {
    const p = { total_nilai: 1500, status_pembayaran: "Belum Transfer", accurate_post_status: "", detail_invoices: [{ invoiceNo: "A", paymentAmount: 1000 }, { invoiceNo: "B", paymentAmount: 500 }] };
    assert.equal(bedaPengajuan(p, { ...p, detail_invoices: [...p.detail_invoices].reverse() }), undefined, "urutan faktur tidak berpengaruh");
    assert.equal(bedaPengajuan(p, undefined), "pengajuan tidak ada lagi di daftar");
    assert.equal(bedaPengajuan(p, { ...p, total_nilai: 1400 }), "nilai dibayar");
    assert.equal(bedaPengajuan(p, { ...p, detail_invoices: [{ invoiceNo: "A", paymentAmount: 1000 }, { invoiceNo: "C", paymentAmount: 500 }] }), "faktur atau nilainya");
    assert.equal(bedaPengajuan(p, { ...p, detail_invoices: [{ invoiceNo: "A", paymentAmount: 900 }, { invoiceNo: "B", paymentAmount: 600 }] }), "faktur atau nilainya");
    assert.equal(bedaPengajuan(p, { ...p, status_pembayaran: "Ajukan Ulang" }), "status transfer");
    assert.equal(bedaPengajuan(p, { ...p, accurate_post_status: "unknown" }), "status posting");
});

test("A-6: query /attempts dipotong per 100 kelompok DAN per panjang karakter; urutan tetap", () => {
    assert.deepEqual(potongKelompok([]), []);
    const kecil = Array.from({ length: 250 }, (_, i) => `invoices=I${i}`);
    assert.deepEqual(potongKelompok(kecil).map((x) => x.length), [100, 100, 50]);
    const panjang = Array.from({ length: 10 }, () => `invoices=${"X".repeat(2500)}`); // 2509 karakter per kelompok
    const bagian = potongKelompok(panjang);
    assert.deepEqual(bagian.map((x) => x.length), [2, 2, 2, 2, 2]);
    for (const b of bagian) assert.ok(b.map((i) => panjang[i]).join("&").length <= 6000);
    assert.deepEqual(bagian.flat(), panjang.map((_, i) => i), "urutan & kelengkapan");
    assert.deepEqual(potongKelompok([`invoices=${"Y".repeat(7000)}`, "invoices=A"]), [[0], [1]], "kelompok raksasa dikirim sendiri");
});

test("faktur kosong/BELUM ADA menahan posting", () => {
    assert.equal(alasanFaktur([{ invoiceNo: "INV-1" }]), undefined);
    assert.match(alasanFaktur([{ invoiceNo: "INV-1" }, { invoiceNo: "belum ada" }, { invoiceNo: " " }])!, /^2 faktur/);
    assert.ok(alasanFaktur([]));
});
