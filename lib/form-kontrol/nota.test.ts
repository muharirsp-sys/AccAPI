/* Uji murni nota belum lunas + tagihan kunjungan + penjaga tanggal salesman (owner 16 Nov 2026). */
import assert from "node:assert/strict";
import test from "node:test";
import { notaDariBaris, periksaTagihan, ringkasNota, tagihanTokoTutup, tanggalIso } from "./nota";
import { galatTanggalSalesman } from "./constants";

test("tanggalIso: dd/MM/yyyy Accurate dan ISO; selain itu null", () => {
    assert.equal(tanggalIso("02/10/2026"), "2026-10-02");
    assert.equal(tanggalIso("2026-10-02T00:00:00"), "2026-10-02");
    assert.equal(tanggalIso(""), null);
    assert.equal(tanggalIso("2 Okt 2026"), null);
});

test("notaDariBaris: keluar/tertagih/sisa, umur, lewat tempo, lunas & rusak dibuang, urut tertua", () => {
    const n = notaDariBaris([
        { id: 1, number: "INV/1", transDate: "01/11/2026", dueDate: "15/11/2026", totalAmount: 1_000_000, primeOwing: 400_000 },
        { id: 2, number: "INV/2", transDate: "02/10/2026", dueDate: "01/11/2026", totalAmount: "2000000", primeOwing: "2000000" },
        { id: 3, number: "INV/3", transDate: "05/11/2026", dueDate: null, totalAmount: 500_000, primeOwing: 0.4 }, // lunas (pembulatan)
        { id: 4, number: "RJN/1", transDate: "05/11/2026", totalAmount: -50_000, primeOwing: -50_000 }, // retur
        { id: 5, number: "INV/5", transDate: "tanggal rusak", totalAmount: 1, primeOwing: 1 },
        { id: 1, number: "INV/1", transDate: "01/11/2026", dueDate: "15/11/2026", totalAmount: 1_000_000, primeOwing: 400_000 }, // kembar
    ], "2026-11-16");
    assert.deepEqual(n.map((x) => x.nomor), ["INV/2", "INV/1"]);
    assert.deepEqual(n[0], { id: 2, nomor: "INV/2", tanggal: "2026-10-02", jatuhTempo: "2026-11-01", nilai: 2_000_000, tertagih: 0, sisa: 2_000_000,
        umur: 45, lewatTempo: 15 });
    assert.equal(n[1].tertagih, 600_000);
    assert.equal(n[1].lewatTempo, 1);
    assert.deepEqual(ringkasNota(n), { jumlah: 2, nilai: 3_000_000, tertagih: 600_000, sisa: 2_400_000, umurMaks: 45, lewatTempo: 2 });
    assert.deepEqual(ringkasNota([]), { jumlah: 0, nilai: 0, tertagih: 0, sisa: 0, umurMaks: 0, lewatTempo: 0 });
});

test("periksaTagihan: undefined = tidak diubah, null = kosong, tertagih butuh nominal > 0, tidak tertagih butuh alasan dikenal", () => {
    assert.deepEqual(periksaTagihan(undefined), { tagihan: undefined });
    assert.deepEqual(periksaTagihan(null), { tagihan: null });
    assert.deepEqual(periksaTagihan({ status: "tertagih", nominal: "150000.456", catatan: "  tunai " }),
        { tagihan: { status: "tertagih", nominal: 150_000.46, catatan: "tunai" } });
    assert.ok("error" in periksaTagihan({ status: "tertagih", nominal: 0 }));
    assert.ok("error" in periksaTagihan({ status: "tertagih", nominal: "abc" }));
    assert.ok("error" in periksaTagihan({ status: "tertagih", nominal: 2e10 }));
    assert.ok("error" in periksaTagihan({ status: "tertagih", nominal: 0.004 }), "dibulatkan = Rp 0,00 (CHECK DB > 0)");
    assert.deepEqual(periksaTagihan({ status: "tidak_tertagih", alasan: "JANJI_BAYAR" }),
        { tagihan: { status: "tidak_tertagih", alasan: "JANJI_BAYAR", catatan: null } });
    assert.ok("error" in periksaTagihan({ status: "tidak_tertagih", alasan: "NGARANG" }));
    assert.ok("error" in periksaTagihan({ status: "tidak_tertagih", alasan: "LAINNYA" }), "Lainnya wajib bercatatan");
    assert.ok("tagihan" in periksaTagihan({ status: "tidak_tertagih", alasan: "LAINNYA", catatan: "pemilik sakit" }));
    assert.ok("error" in periksaTagihan({ status: "entah" }));
    assert.ok("error" in periksaTagihan([1]));
    assert.deepEqual(tagihanTokoTutup("R15"), { status: "tidak_tertagih", alasan: "TOKO_TUTUP", catatan: null });
    assert.equal(tagihanTokoTutup("R01"), null);
});

test("galatTanggalSalesman: akun salesman hanya hari ini; SPV/Admin (tanpa salesCode) bebas", () => {
    assert.equal(galatTanggalSalesman({ salesCode: "S1" }, "2026-11-16", "2026-11-16"), null);
    assert.equal(galatTanggalSalesman({ salesCode: "S1" }, "2026-11-15", "2026-11-16")?.kode, "TANGGAL_BUKAN_HARI_INI");
    assert.equal(galatTanggalSalesman({ salesCode: "S1" }, "2026-11-17", "2026-11-16")?.status, 409);
    assert.equal(galatTanggalSalesman({}, "2026-11-01", "2026-11-16"), null);
});
