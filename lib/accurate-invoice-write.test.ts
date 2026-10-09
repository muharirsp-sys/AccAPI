/* Kunci: faktur tidak boleh dibuat dari angka yang tidak beku, satuan tidak boleh ditebak,
   dan timeout tidak boleh dianggap gagal (faktur ganda di Accurate tidak bisa dibatalkan). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { barisPersenRupiah, classifySaveResponse, discardable, buildInvoicePayload, nextOutboxState, pakaiTanggalFaktur, readInvoiceIdentity, resendable, sendable, toAccurateDate, type InvoiceOrder, type InvoicePayload } from "./accurate-invoice-write.ts";

const UNITS = new Map([["KRT", 100], ["BAG", 350]]);

const order = (patch: Partial<InvoiceOrder> = {}): InvoiceOrder => ({
    id: "11111111-2222-3333-4444-555555555555",
    customer_no: "C-MUS026-GD",
    outlet: "HJ. MUSTARI, TK",
    channel: "GT",
    order_date: "2026-09-08",
    status: "draft",
    note: "catatan",
    lines: [{ code: "M5012001000740", unit: "KRT", quantity: "2", price: "1144800" }],
    sources: [{ draft_id: "e6c56dac-aaaa", revision: 2 }],
    result: {
        gross: "2289600.00", discount: "228960.00", net: "2060640.00",
        lines: [{ code: "M5012001000740", unit: "KRT", quantity: "2", gross: "2289600.00", net: "2060640.00" }],
    },
    ...patch,
});

test("tanggal tulis Accurate dd/MM/yyyy", () => {
    assert.equal(toAccurateDate("2026-09-08"), "08/09/2026");
    assert.throws(() => toAccurateDate("08-09-2026"));
});

test("payload memakai angka beku dan tidak pernah mengarang nomor faktur", () => {
    const payload = buildInvoicePayload(order(), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 });
    assert.equal(payload.customerNo, "C-MUS026-GD");
    assert.equal(payload.transDate, "08/09/2026");
    // Seri penomoran datang dari cabang pelanggan, bukan nilai tetap: penomoran Faktur
    // Penjualan berjalan per cabang, jadi `1` untuk semua faktur = nomor nyasar ke cabang lain.
    assert.equal(payload.typeAutoNumber, 1702);
    assert.ok(!("number" in payload), "nomor faktur harus datang dari Accurate");
    assert.equal(payload.branchId, 150);
    // PPN wajib aktif untuk semua faktur penjualan, dan harga adalah DPP (pajak ditambahkan
    // di atasnya), bukan harga yang sudah termasuk pajak.
    assert.equal(payload.taxable, true);
    assert.equal(payload.inclusiveTax, false);
    assert.deepEqual(payload.detailItem[0], {
        itemNo: "M5012001000740", quantity: 2, unitPrice: 1144800, itemUnitId: 100,
        // Tanpa rantai persen pada hasil beku, seluruh diskon jatuh sebagai rupiah.
        itemDiscPercent: "", itemCashDiscount: 228960,
        detailNotes: "order 11111111 baris 1", charField1: order().id,
    });

    // Persen + rupiah pada satu baris: Accurate MEMBUANG rupiahnya begitu persen terisi
    // (INV/2609/KN01376). Rupiahnya ikut masuk rantai sebagai persen setara, rupiah dikirim 0.
    const beku = order();
    beku.result.lines = [{ ...beku.result.lines![0], percents: ["5"], cash: "114480" }];
    const campur = buildInvoicePayload(beku, { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 });
    assert.equal(campur.detailItem[0].itemDiscPercent, "5+5.2632");
    assert.equal(campur.detailItem[0].itemCashDiscount, 0);
    assert.deepEqual(barisPersenRupiah(campur), []);

    // Rantai yang tidak menghasilkan netto beku ditahan, bukan dikirim lalu ketahuan belakangan.
    const meleset = order();
    meleset.result.lines = [{ ...meleset.result.lines![0], percents: ["10", "5"], cash: "8960" }];
    // Sebabnya dasar yang salah (10% + 5% + Rp 8.960 ≠ diskon 10%), bukan batas desimal.
    assert.throws(() => buildInvoicePayload(meleset, { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), (error: Error) => {
        assert.match(error.message, /Barang M5012001000740 \(KRT\): netto SO Rp 2060640\.00, netto hasil diskon 10\+5 \+ Rp 8960 Rp 1948648\.00, selisih Rp 111992\.00/);
        assert.match(error.message, /SO ditahan utuh: rantai diskon beku tidak menghasilkan netto SO/);
        assert.doesNotMatch(error.message, /4 desimal/);
        return true;
    });

    // Sebabnya batas 4 desimal: persen + rupiah persis menghasilkan netto, persen setaranya tidak.
    const besar = order({ lines: [{ code: "M5012001000740", unit: "KRT", quantity: "1", price: "50000000" }] });
    besar.result.lines = [{ code: "M5012001000740", unit: "KRT", quantity: "1", gross: "50000000.00", net: "48287654.33", percents: ["2"], cash: "712345.67" }];
    assert.throws(() => buildInvoicePayload(besar, { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }),
        /selisih Rp 16\.33\. SO ditahan utuh: potongan rupiah baris terlalu besar untuk dipersenkan 4 desimal/);

    // Bagian rupiah tidak boleh melebihi total diskon baris.
    const salah = order();
    salah.result.lines = [{ ...salah.result.lines![0], percents: ["10"], cash: "999999" }];
    assert.throws(() => buildInvoicePayload(salah, { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /diskon rupiah/);
    // Jejak balik untuk rekonsiliasi status TIDAK PASTI.
    assert.equal(payload.charField1, order().id);
    assert.equal(payload.charField2, "e6c56dacr2");
});

test("menolak, bukan menebak, saat ada yang tidak pasti", () => {
    assert.throws(() => buildInvoicePayload(order({ customer_no: "" }), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /pelanggan/);
    assert.throws(() => buildInvoicePayload(order({ result: { pending_price: true } }), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /needs_price/);
    assert.throws(() => buildInvoicePayload(order(), { unitIds: new Map(), branchId: 150, typeAutoNumber: 1702 }), /master satuan/);
    // Satuan yang tidak ada di master satuan Accurate: satu item bisa berselisih 72x.
    assert.throws(() => buildInvoicePayload(order({
        lines: [{ code: "X", unit: "LUSIN", quantity: "1", price: "1" }],
        result: { lines: [{ code: "X", unit: "LUSIN", quantity: "1", gross: "1", net: "1" }] },
    }), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /master satuan/);
    // Baris hasil yang tidak punya pasangan baris masukan = angka beku tidak konsisten.
    assert.throws(() => buildInvoicePayload(order({
        result: { lines: [{ code: "LAIN", unit: "KRT", quantity: "1", gross: "1", net: "1" }] },
    }), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /tidak konsisten/);
    assert.throws(() => buildInvoicePayload(order({ result: { lines: [] } }), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 }), /baris hasil/);
});

test("identitas dokumen dibaca dari amplop Accurate", () => {
    assert.deepEqual(readInvoiceIdentity({ s: true, r: { id: 331710, number: "INV/2609/M100412" } }),
        { ok: true, id: "331710", number: "INV/2609/M100412", message: "" });
    const failed = readInvoiceIdentity({ s: false, d: ["Customer tidak ditemukan"] });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /Customer tidak ditemukan/);
});

test("klasifikasi respons save.do: hanya penolakan beramplop yang boleh dikirim ulang (AM-015/016)", () => {
    const ok = JSON.stringify({ s: true, r: { id: 331710, number: "INV/1" } });
    assert.deepEqual(classifySaveResponse(200, ok), { kind: "posted", id: "331710", number: "INV/1" });
    assert.equal(classifySaveResponse(200, JSON.stringify({ s: false, d: ["Customer tidak ditemukan"] })).kind, "rejected");
    assert.equal(classifySaveResponse(400, JSON.stringify({ s: false, d: ["field wajib"] })).kind, "rejected");
    // Semua di bawah ini: Accurate MUNGKIN sudah menyimpan -> tidak pasti, bukan "rejected"
    // (yang di UI berarti aman dikirim ulang = faktur ganda).
    for (const [status, text] of [
        [502, '{"message":"Bad Gateway"}'],  // JSON gateway, bukan amplop Accurate
        [200, "{}"],
        [200, "[]"],
        [200, "null"],                       // dulu TypeError: baris macet `sending`, batch berhenti
        [200, "<html>502</html>"],
        [503, JSON.stringify({ s: false, d: ["overload"] })],  // 5xx: amplop pun tidak dipercaya
        [200, JSON.stringify({ s: true })],  // sukses tanpa id: tidak bisa diverifikasi
        [200, JSON.stringify({ s: true, r: { number: "INV/2" } })],
    ] as const) {
        assert.equal(classifySaveResponse(status, text).kind, "no_answer", `${status} ${text}`);
    }
    // 1835b724 (review #3) menjadikan 401/403/429 "rejected belum diproses"; D-07 + S6-0d E7 MEMBALIKNYA:
    // angka status saja bukan bukti tidak tersimpan (gateway/proxy bisa menjawab begitu sesudah
    // Accurate menyimpan). Termasuk yang berbadan amplop {s:false} — tetap tidak pasti, bukan Ditolak.
    for (const status of [401, 403, 429]) {
        for (const text of ['{"error":"invalid_token"}', "<html>denied</html>", JSON.stringify({ s: false, d: ["Token kedaluwarsa"] }), ""]) {
            const hasil = classifySaveResponse(status, text);
            assert.equal(hasil.kind, "no_answer", `${status} ${text}`);
            assert.match(hasil.kind === "no_answer" ? hasil.message : "", new RegExp(`HTTP ${status}`));
        }
    }
});

test("tanpa jawaban dari Accurate statusnya TIDAK PASTI, bukan gagal, dan tidak boleh dikirim lagi", () => {
    assert.equal(nextOutboxState("queued", { kind: "no_answer", message: "timeout" }), "unknown");
    assert.equal(nextOutboxState("sending", { kind: "no_answer", message: "ECONNRESET" }), "unknown");
    // Status TIDAK PASTI bertahan: pengiriman ulang otomatis bisa membuat faktur ganda di
    // Accurate yang tidak bisa dibatalkan dari sini.
    assert.equal(nextOutboxState("unknown", { kind: "posted", id: "1", number: "X" }), "unknown");
    assert.equal(sendable("unknown"), false);
    assert.equal(sendable("posted"), false);
    assert.equal(sendable("sending"), false);

    // Accurate menjawab dan menolak: aman diperbaiki lalu dicoba lagi — tetapi oleh MANUSIA.
    // Pengirim terjadwal tidak boleh mengambilnya sendiri; kalau boleh, tiap jalannya cron
    // mengulang kegagalan yang sama tanpa ada yang memperbaiki sebabnya.
    assert.equal(nextOutboxState("sending", { kind: "rejected", message: "customer suspended" }), "rejected");
    assert.equal(sendable("rejected"), false);
    assert.equal(sendable("queued"), true);
    assert.equal(resendable("rejected"), true);
    // Yang TIDAK PASTI tidak pernah boleh dilepas ulang, oleh siapa pun.
    assert.equal(resendable("unknown"), false);
    assert.equal(resendable("posted"), false);
    assert.equal(resendable("sending"), false);
    assert.equal(resendable("queued"), false);
    assert.equal(nextOutboxState("sending", { kind: "posted", id: "331710", number: "INV/1" }), "posted");
    assert.equal(nextOutboxState("posted", { kind: "rejected", message: "apa pun" }), "posted");
});

test("yang boleh DIBUANG hanya yang pasti belum ada fakturnya di Accurate", () => {
    // Belum satu request pun terkirim, atau Accurate menjawab dan menolak.
    assert.equal(discardable("queued"), true);
    assert.equal(discardable("rejected"), true);
    // `sending` sedang dalam perjalanan, `posted` pasti ada, `unknown` mungkin ada — menghapus
    // jejak lokalnya menghilangkan satu-satunya petunjuk untuk mencarinya lewat charField1.
    assert.equal(discardable("sending"), false);
    assert.equal(discardable("posted"), false);
    assert.equal(discardable("unknown"), false);
});


test("sales per baris ikut di SETIAP baris, hanya bila salesnya sah", () => {
    // KN01225-KN01227 (2026-09-29): sales hanya di kepala faktur hilang begitu faktur disimpan
    // ulang dari layar Accurate, yang menyimpan sales per baris.
    // Baris BONUS disusun di jalur terpisah; tanpanya faktur terbit dengan sales hanya di
    // sebagian barang (keluhan pengguna 2026-09-30).
    const withBonus = order();
    withBonus.result.bonuses = [{ program_id: "P-1", code: "M5012001000740", unit: "KRT", quantity: "1" }];
    const dengan = buildInvoicePayload(withBonus, { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702,
        masterSalesmanId: 3464, salesmanNumber: "M-YAM" });
    assert.equal(dengan.detailItem.length, 2);
    assert.ok(dengan.detailItem.every((line) => line.salesmanListNumber?.length === 1 && line.salesmanListNumber[0] === "M-YAM"));
    // Tanpa sales yang sah: field tidak dikirim sama sekali (bukan daftar kosong).
    const tanpa = buildInvoicePayload(order(), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 });
    assert.ok(tanpa.detailItem.every((line) => !("salesmanListNumber" in line)));
});

test("tanggal faktur pilihan: hanya transDate yang diganti, tidak boleh sebelum SO", () => {
    const beku = { customerNo: "C-MAJ010-KN", transDate: "28/09/2026", typeAutoNumber: 1702, taxable: true,
        inclusiveTax: false, description: "Order X", detailItem: [], charField1: "KINO-NON-FOOD:SO1", charField2: "" } as InvoicePayload;
    // Kosong = tanggal SO apa adanya (objek yang sama, tidak disalin).
    assert.equal(pakaiTanggalFaktur(beku, "2026-09-28").payload, beku);
    // Order kemarin difakturkan hari ini: hanya transDate yang berubah, kunci charField1 tetap.
    const hariIni = pakaiTanggalFaktur(beku, "2026-09-28", "2026-09-29");
    assert.equal(hariIni.error, undefined);
    assert.deepEqual(hariIni.payload, { ...beku, transDate: "29/09/2026" });
    assert.equal(beku.transDate, "28/09/2026", "payload beku tidak ikut berubah");
    // Hari yang sama boleh; lebih awal dari SO ditolak.
    assert.equal(pakaiTanggalFaktur(beku, "2026-09-28", "2026-09-28").error, undefined);
    assert.match(pakaiTanggalFaktur(beku, "2026-09-28", "2026-09-27").error ?? "", /lebih awal dari tanggal SO 28\/09\/2026/);
});

test("payload beku lama berbentuk persen + rupiah ketahuan sebelum dikirim", () => {
    // Bentuk persis INV/2609/KN01376 (diantrekan 30 Sep 2026): Accurate memakai 2% saja.
    const lama = buildInvoicePayload(order(), { unitIds: UNITS, branchId: 150, typeAutoNumber: 1702 });
    lama.detailItem[0] = { ...lama.detailItem[0], itemDiscPercent: "2+0+0+0+0", itemCashDiscount: 4933.33 };
    assert.deepEqual(barisPersenRupiah(lama), [lama.detailItem[0].detailNotes]);
    // Rupiah saja (tanpa persen) dan "0+0" tanpa rupiah bukan campuran.
    lama.detailItem[0] = { ...lama.detailItem[0], itemDiscPercent: "", itemCashDiscount: 4933.33 };
    assert.deepEqual(barisPersenRupiah(lama), []);
});
