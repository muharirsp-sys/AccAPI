/* Kunci: berkas ini adalah jawaban atas "kenapa harus saya yang mastikan?". Kalau pembanding
   ini salah, faktur yang salah akan terlihat hijau — lebih buruk daripada tidak ada verifikasi
   sama sekali, karena orang berhenti memeriksa. Yang paling dijaga di sini: faktur yang TIDAK
   bisa diperiksa tidak boleh pernah berstatus cocok. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePercentChain, readAccurateInvoice, verifyInvoice } from "./invoice-verify.ts";
import type { InvoicePayload } from "./accurate-invoice-write.ts";

/** Bentuk nyata faktur uji INV/2609/KN00403 (2026-09-12), diringkas ke field yang diperiksa. */
const payload = (over: Partial<InvoicePayload> = {}): InvoicePayload => ({
    customerNo: "KNF001-KN",
    transDate: "11/09/2026",
    typeAutoNumber: 1702,
    taxable: true,
    inclusiveTax: false,
    description: "Order KINO-NON-FOOD:1671-SOP-260013022",
    charField1: "KINO-NON-FOOD:1671-SOP-260013022",
    charField2: "",
    branchId: 1051,
    detailItem: [{
        itemNo: "K1010001006010", quantity: 12, unitPrice: 11396.3964, itemUnitId: 1000,
        itemDiscPercent: "", itemCashDiscount: 0,
        detailNotes: "order 1671-SOP-260013022 baris 1", charField1: "KINO-NON-FOOD:1671-SOP-260013022",
    }],
    ...over,
});

const accurate = (over: Record<string, unknown> = {}, lineOver: Record<string, unknown> = {}) => ({
    id: 335951, number: "INV/2609/KN00403", transDate: "11/09/2026", branchId: 1051,
    branchName: "KINO NON FOOD", taxable: true, inclusiveTax: false,
    tax1Amount: 15043.24, totalAmount: 151799.76,
    charField1: "KINO-NON-FOOD:1671-SOP-260013022",
    customer: { customerNo: "KNF001-KN" },
    masterSalesmanId: null, masterSalesmanName: null,
    detailItem: [{
        itemNo: "K1010001006010", quantity: 12, unitPrice: 11396.3964,
        itemUnit: { id: 1000, name: "BLR" }, itemUnitId: 1000,
        itemDiscPercent: "", itemCashDiscount: 0, totalPrice: 136756.76,
        detailNotes: "order 1671-SOP-260013022 baris 1", ...lineOver,
    }],
    ...over,
});

test("faktur uji nyata: payload beku dan jawaban Accurate dinyatakan cocok", () => {
    const hasil = verifyInvoice(payload(), accurate());
    assert.equal(hasil.status, "cocok");
    assert.deepEqual(hasil.findings, []);
    assert.equal(hasil.invoiceNumber, "INV/2609/KN00403");
    assert.equal(hasil.linesChecked, 1);
});

test("raw_data tersimpan sebagai TEKS JSON (bentuk nyata di DB) tetap terbaca", () => {
    const hasil = verifyInvoice(payload(), JSON.stringify(accurate()));
    assert.equal(hasil.status, "cocok");
});

test("faktur tanpa rincian baris TIDAK PERNAH berstatus cocok", () => {
    // Inilah yang tersimpan kalau raw_data datang dari list.do, bukan detail.do. Kalau ini
    // dihitung "cocok", verifikasi akan menghijaukan faktur yang tidak pernah dibandingkan.
    const dariListDo = accurate();
    delete (dariListDo as Record<string, unknown>).detailItem;
    const hasil = verifyInvoice(payload(), dariListDo);
    assert.equal(hasil.status, "tak-terperiksa");
    assert.match(hasil.reason, /rincian baris/);
    assert.equal(hasil.linesChecked, 0);
});

test("faktur belum ada di cache: tak-terperiksa, bukan cocok dan bukan selisih", () => {
    assert.equal(verifyInvoice(payload(), null).status, "tak-terperiksa");
    assert.equal(verifyInvoice(payload(), "bukan json").status, "tak-terperiksa");
});

test("charField1 milik order lain ditandai — pasangannya yang salah, bukan angkanya", () => {
    const hasil = verifyInvoice(payload(), accurate({ charField1: "KINO-NON-FOOD:1671-SOP-999" }));
    assert.equal(hasil.status, "selisih");
    assert.ok(hasil.findings.some((f) => f.field === "charField1"));
});

test("satuan berbeda ketahuan meski kode barang dan qty sama", () => {
    const hasil = verifyInvoice(payload(), accurate({}, { itemUnit: { id: 100, name: "KRT" }, itemUnitId: 100 }));
    const temuan = hasil.findings.find((f) => f.field === "satuan");
    assert.ok(temuan);
    assert.equal(temuan.expected, "1000");
    assert.equal(temuan.actual, "100 (KRT)");
});

test("tanggal faktur BOLEH lebih baru dari SO: faktur diproses saat masalahnya selesai", () => {
    // Aturan pengguna 2026-09-12. Faktur uji nyata dikirim 12/09 untuk SO 11/09 dan Accurate
    // menstempel tanggal pembuatannya sendiri; menuntut sama persis membuat alarm yang tidak
    // pernah bisa dipadamkan, dan alarm begitu justru mengajari orang mengabaikannya.
    const hasil = verifyInvoice(payload(), accurate({ transDate: "12/09/2026" }));
    assert.equal(hasil.status, "cocok");
    assert.equal(hasil.invoiceDate, "12/09/2026");
});

test("tanggal faktur LEBIH AWAL dari SO tetap ditandai", () => {
    // Arah sebaliknya tidak pernah wajar: penjualan tercatat sebelum pesanannya ada.
    const hasil = verifyInvoice(payload(), accurate({ transDate: "10/09/2026" }));
    assert.ok(hasil.findings.some((f) => f.field === "tanggal faktur lebih awal dari SO"));
});

test("tanggal faktur kosong atau tidak terbaca tetap ditandai", () => {
    assert.ok(verifyInvoice(payload(), accurate({ transDate: "" })).findings.some((f) => f.field === "tanggal faktur"));
});

test("harga, qty, dan cabang yang meleset masing-masing jadi satu temuan", () => {
    const hasil = verifyInvoice(payload(), accurate({ branchId: 1052 }, { unitPrice: 10180.18, quantity: 10 }));
    const fields = hasil.findings.map((f) => f.field);
    assert.ok(fields.includes("cabang (branchId)"));
    assert.ok(fields.includes("harga satuan"));
    assert.ok(fields.includes("qty"));
});

test("PPN: taxable/inclusiveTax dan nilai pajaknya ikut diperiksa", () => {
    const mati = verifyInvoice(payload(), accurate({ taxable: false }));
    assert.ok(mati.findings.some((f) => f.field === "PPN aktif (taxable)"));
    const termasuk = verifyInvoice(payload(), accurate({ inclusiveTax: true }));
    assert.ok(termasuk.findings.some((f) => f.field === "PPN di atas harga (inclusiveTax)"));
    const nol = verifyInvoice(payload(), accurate({ tax1Amount: 0 }));
    assert.ok(nol.findings.some((f) => f.field === "nilai PPN (tax1Amount)"));
});

test("nomor faktur kosong = seri cabang tidak terbit, dan itu temuan", () => {
    const hasil = verifyInvoice(payload(), accurate({ number: "" }));
    assert.ok(hasil.findings.some((f) => f.field === "nomor faktur"));
});

test("butir 4.32: rantai diskon persen yang ditafsirkan Accurate berbeda ketahuan dari nilai barisnya", () => {
    // Kita kirim "10+5" bertingkat: 100.000 -> 10.000 lalu 4.500 = netto 85.500.
    // Kalau Accurate menjumlahkan 15% lebih dulu, nettonya 85.000 — selisih Rp 500 yang
    // TIDAK akan terlihat dari mana pun kecuali dari nilai baris.
    const kirim = payload({
        detailItem: [{
            itemNo: "K1", quantity: 1, unitPrice: 100000, itemUnitId: 50,
            itemDiscPercent: "10+5", itemCashDiscount: 0,
            detailNotes: "order SO baris 1", charField1: "KINO-NON-FOOD:1671-SOP-260013022",
        }],
    });
    const benar = accurate({}, {
        itemNo: "K1", quantity: 1, unitPrice: 100000, itemUnit: { id: 50, name: "PCS" }, itemUnitId: 50,
        itemDiscPercent: "10+5", itemCashDiscount: 0, totalPrice: 85500, detailNotes: "order SO baris 1",
    });
    assert.equal(verifyInvoice(kirim, benar).status, "cocok");

    const dijumlahkan = accurate({}, {
        itemNo: "K1", quantity: 1, unitPrice: 100000, itemUnit: { id: 50, name: "PCS" }, itemUnitId: 50,
        itemDiscPercent: "10+5", itemCashDiscount: 0, totalPrice: 85000, detailNotes: "order SO baris 1",
    });
    const hasil = verifyInvoice(kirim, dijumlahkan);
    assert.equal(hasil.status, "selisih");
    assert.ok(hasil.findings.some((f) => f.field === "nilai baris"));
});

test("rantai persen yang hilang dari faktur ketahuan sebagai selisih diskon persen", () => {
    const kirim = payload({
        detailItem: [{
            itemNo: "K1", quantity: 1, unitPrice: 100000, itemUnitId: 50,
            itemDiscPercent: "4+0+0+3", itemCashDiscount: 0,
            detailNotes: "order SO baris 1", charField1: "KINO-NON-FOOD:1671-SOP-260013022",
        }],
    });
    const tanpaDiskon = accurate({}, {
        itemNo: "K1", quantity: 1, unitPrice: 100000, itemUnit: { id: 50, name: "PCS" }, itemUnitId: 50,
        itemDiscPercent: "", itemCashDiscount: 0, totalPrice: 100000, detailNotes: "order SO baris 1",
    });
    const hasil = verifyInvoice(kirim, tanpaDiskon);
    assert.ok(hasil.findings.some((f) => f.field === "diskon persen"));
    assert.ok(hasil.findings.some((f) => f.field === "nilai baris"));
});

test("baris kembar (biasa + bonus 100%) dipasangkan lewat detailNotes, bukan urutan", () => {
    const kirim = payload({
        detailItem: [
            { itemNo: "K1", quantity: 10, unitPrice: 1000, itemUnitId: 50, itemDiscPercent: "", itemCashDiscount: 0,
              detailNotes: "order SO baris 1", charField1: "X" },
            { itemNo: "K1", quantity: 2, unitPrice: 1000, itemUnitId: 50, itemDiscPercent: "100", itemCashDiscount: 0,
              detailNotes: "order SO baris 2", charField1: "X" },
        ],
        charField1: "X",
    });
    // Accurate mengembalikan barisnya TERBALIK; memasangkan lewat kode barang akan menukar
    // baris bonus dengan baris biasa dan melaporkan dua selisih palsu.
    const terbalik = accurate({ charField1: "X" }, {});
    terbalik.detailItem = [
        { itemNo: "K1", quantity: 2, unitPrice: 1000, itemUnit: { id: 50, name: "PCS" }, itemUnitId: 50,
          itemDiscPercent: "100", itemCashDiscount: 0, totalPrice: 0, detailNotes: "order SO baris 2" },
        { itemNo: "K1", quantity: 10, unitPrice: 1000, itemUnit: { id: 50, name: "PCS" }, itemUnitId: 50,
          itemDiscPercent: "", itemCashDiscount: 0, totalPrice: 10000, detailNotes: "order SO baris 1" },
    ];
    const hasil = verifyInvoice(kirim, terbalik);
    assert.equal(hasil.status, "cocok");
    assert.equal(hasil.linesChecked, 2);
});

test("baris yang hilang dari faktur Accurate ditandai, bukan dilewati diam-diam", () => {
    const kirim = payload({
        detailItem: [
            ...payload().detailItem,
            { itemNo: "K2", quantity: 1, unitPrice: 5000, itemUnitId: 50, itemDiscPercent: "", itemCashDiscount: 0,
              detailNotes: "order 1671-SOP-260013022 baris 2", charField1: "KINO-NON-FOOD:1671-SOP-260013022" },
        ],
    });
    const hasil = verifyInvoice(kirim, accurate());
    assert.equal(hasil.status, "selisih");
    assert.ok(hasil.findings.some((f) => f.field === "jumlah baris"));
    assert.ok(hasil.findings.some((f) => f.line === 2 && f.field === "baris"));
});

test("butir 4.31: salesman pada faktur Accurate ikut dilaporkan", () => {
    assert.equal(verifyInvoice(payload(), accurate()).salesman, "");
    assert.equal(verifyInvoice(payload(), accurate({ masterSalesmanName: "KN01_BUDI" })).salesman, "KN01_BUDI");
});

test("rantai persen dibakukan tanpa menggeser posisi", () => {
    assert.equal(normalizePercentChain("4,00 + 2.25"), "4+2.25");
    assert.equal(normalizePercentChain(""), "");
    assert.equal(normalizePercentChain("0+0"), "");
    // Nol di TENGAH tetap: posisi 4 berarti klaim principal, posisi 2 berarti distributor.
    assert.equal(normalizePercentChain("4+0+0+3"), "4+0+0+3");
});

test("pembaca raw_data mengambil satuan, nomor baris kita, dan cabang dari jawaban Accurate", () => {
    const invoice = readAccurateInvoice(accurate());
    assert.equal(invoice.hasDetail, true);
    assert.equal(invoice.branchId, 1051);
    assert.equal(invoice.lines[0].unitName, "BLR");
    assert.equal(invoice.lines[0].ourLine, 1);
});
