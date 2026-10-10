/* Fiori S6b Finance: keputusan murni layar — izin di satu fungsi, status transfer ≠ posting, kunci baris, "tidak ada" ≥ 2 menit,
 * penyaring catatan lama. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { alasanFaktur, alasanTidakAda, catatanPosting, izinFinance, kodeTampil, kunciBaris, saringCatatan, statusPosting, statusTransfer, type AttemptFinance } from "./finance-ui.ts";

const attempt = (over: Partial<AttemptFinance>): AttemptFinance => ({
    attemptId: "a1", state: "unknown", status: "unknown", stale: false, accurateNumber: "", actorName: "Finance A", targetDbId: "DB-1",
    ageSeconds: 30, createdAtWita: "2026-10-10 09:00:00", updatedAtWita: "2026-10-10 09:00:30", message: "", ...over,
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

test("status posting: attempt sending segar = sedang; basi/unknown = tidak pasti; posted server tanpa catatan = catatan tertinggal", () => {
    assert.equal(statusPosting({ accurate_post_status: "" }, attempt({ status: "sending", state: "sending" })).kode, "sedang");
    assert.equal(statusPosting({ accurate_post_status: "" }, attempt({ status: "stale", state: "sending", stale: true })).kode, "tidak_pasti");
    assert.equal(statusPosting({ accurate_post_status: "unknown" }, null).kode, "tidak_pasti");
    assert.equal(statusPosting({ accurate_post_status: "failed" }, attempt({ status: "unknown" })).kode, "tidak_pasti", "attempt tidak pasti mengalahkan gagal");
    assert.deepEqual(statusPosting({ accurate_post_status: "posted", accurate_purchase_payment_number: "PP/1" }, null), { kode: "terposting", nomor: "PP/1", catatanTertinggal: false });
    assert.deepEqual(statusPosting({ accurate_post_status: "" }, attempt({ status: "posted", state: "posted", accurateNumber: "PP/2" })), { kode: "terposting", nomor: "PP/2", catatanTertinggal: true });
    assert.equal(statusPosting({ accurate_post_status: "failed" }, null).kode, "gagal");
    assert.equal(statusPosting({ accurate_post_status: "skipped" }, null).kode, "belum");
});

test("kunci baris: terposting/tidak pasti/sedang/data usang mengunci; gagal jelas boleh dikirim ulang", () => {
    const izin = izinFinance(new Set(["finance.view", "finance.update", "finance.resolve_unknown"]));
    const k = (kode: Parameters<typeof kunciBaris>[0]["posting"]["kode"], over: Partial<Parameters<typeof kunciBaris>[0]> = {}) =>
        kunciBaris({ posting: { kode, nomor: "", catatanTertinggal: false }, izin, ...over });
    assert.match(k("terposting").posting!, /Sudah terposting/);
    assert.match(k("terposting").status!, /BL-05/);
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

test("'Tidak ada di Accurate' hanya setelah percobaan basi ≥ 2 menit; tanpa attempt server boleh", () => {
    assert.equal(alasanTidakAda(null, 0), undefined);
    assert.equal(alasanTidakAda(attempt({ stale: true, ageSeconds: 10 }), 0), undefined);
    assert.match(alasanTidakAda(attempt({ ageSeconds: 30 }), 0)!, /2 menit/);
    assert.equal(alasanTidakAda(attempt({ ageSeconds: 30 }), 95), undefined, "umur bertambah sejak dimuat");
});

test("catatan lama disaring: tanpa 'Coba lagi' dan tanpa alamat server lokal", () => {
    assert.equal(saringCatatan("Accurate tidak merespons dalam 30 detik (timeout). Coba lagi."), "Accurate tidak merespons dalam 30 detik (timeout).");
    assert.equal(saringCatatan("Koneksi ke backend Python gagal. Pastikan localhost:8000 aktif."), "Koneksi ke backend Python gagal. Pastikan server aktif.");
    assert.equal(saringCatatan("gagal http://localhost:8000/payments/x"), "gagal server");
    const n = catatanPosting("tidak_pasti", "Accurate tidak merespons (timeout). Coba lagi.", "failed");
    assert.match(n, /^TIDAK PASTI/);
    assert.doesNotMatch(n, /Coba lagi/);
    assert.match(catatanPosting("gagal", "dicek manual: tidak ada di Accurate", "failed"), /Boleh diposting ulang/);
});

test("faktur kosong/BELUM ADA menahan posting", () => {
    assert.equal(alasanFaktur([{ invoiceNo: "INV-1" }]), undefined);
    assert.match(alasanFaktur([{ invoiceNo: "INV-1" }, { invoiceNo: "belum ada" }, { invoiceNo: " " }])!, /^2 faktur/);
    assert.ok(alasanFaktur([]));
});
