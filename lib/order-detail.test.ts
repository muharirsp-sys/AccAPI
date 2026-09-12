/* Kunci: aturan satuan diambil dari Power Query yang dipakai admin selama ini. Menyimpang
   berarti faktur sistem tidak sama dengan faktur yang selama ini terbit. Baris rekap,
   baris QTY nol, dan produk tanpa mapping harus keluar — bukan ditebak. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { discountsOf, fixLine, isoDate, parseOrderDetail, type PackInfo } from "./order-detail.ts";

const PACKS = new Map<string, PackInfo>([
    ["106052", { unit: "BTL", packSize: 36 }],
    ["106068", { unit: "BTL", packSize: 36 }],
]);

const HEAD = [
    ["REPORT ORDER DETAIL"],
    ["Periode", ": 2026-09-11 s/d 2026-09-11"],
    ["Cabang", ": 1201671 - SURYA PERKASA, CV - MAKASSAR"],
    ["SLSMAN_ID", "CUST_ID1", "CUST_ID2", "CUSTOMER", "CUST_TYPE1", "SO_NO", "SO_DATE", "SO_STS",
     "PRD_ID", "PRD_DESC", "QTY", "PRICE", "GROSS", "DISC_1", "DISC_4", "DISC_7", "TOTAL_DISC",
     "TOTAL_PROMO", "NET", "FLAG_BONUS"],
];
const line = (over: Record<string, unknown> = {}) => {
    const base: Record<string, unknown> = {
        SLSMAN_ID: "1671GR4102", CUST_ID1: "16710223162", CUST_ID2: "16710223162", CUSTOMER: "GALERY MAKASSAR C-GAL006",
        CUST_TYPE1: "General Trade", SO_NO: "1671-SOP-1", SO_DATE: "2026-09-11", SO_STS: "SHIPMENT",
        PRD_ID: "106052", PRD_DESC: "ESK CG ROMANTIC PURPLE 100ML BTL", QTY: 24, PRICE: 13513.5135,
        GROSS: 324324.32, DISC_1: 0, DISC_4: 0, DISC_7: 0, TOTAL_DISC: 0, TOTAL_PROMO: 0, NET: 359999.99,
        FLAG_BONUS: "N", ...over,
    };
    return HEAD[3].map((name) => base[name]);
};

test("satuan naik ke KRT hanya bila QTY habis dibagi ISI, dan harganya dikali ISI", () => {
    // 72 / 36 = 2 karton; nilai barisnya tidak berubah.
    assert.deepEqual(fixLine(72, 10000, { unit: "BTL", packSize: 36 }), { qty: 2, unit: "KRT", price: 360000 });
    // 50 / 36 tidak bulat -> tetap satuan terkecil.
    assert.deepEqual(fixLine(50, 10000, { unit: "BTL", packSize: 36 }), { qty: 50, unit: "BTL", price: 10000 });
    // ISI nol tidak pernah membagi.
    assert.deepEqual(fixLine(10, 500, { unit: "PCS", packSize: 0 }), { qty: 10, unit: "PCS", price: 500 });
    for (const [qty, isi] of [[72, 36], [36, 36], [24, 12]] as const) {
        const fixed = fixLine(qty, 1000, { unit: "BTL", packSize: isi });
        assert.equal(fixed.qty * fixed.price, qty * 1000, `nilai baris berubah untuk ${qty}/${isi}`);
    }
});

test("baris bonus jadi potongan 100% di posisi 1", () => {
    assert.deepEqual(discountsOf({ DISC_1: 4, DISC_4: 2.25 }, false), [{ position: 1, percent: 4 }, { position: 4, percent: 2.25 }]);
    assert.deepEqual(discountsOf({ DISC_1: 0 }, true), [{ position: 1, percent: 100 }]);
    // Posisi tanpa pemilik tetap ikut supaya bisa dilaporkan sebagai diskon tak bertuan.
    assert.deepEqual(discountsOf({ DISC_7: 5 }, false), [{ position: 7, percent: 5 }]);
});

test("tanggal terbaca dari teks maupun serial Excel", () => {
    assert.equal(isoDate("2026-09-11"), "2026-09-11");
    assert.equal(isoDate(new Date(Date.UTC(2026, 8, 11))), "2026-09-11");
    assert.equal(isoDate(46276), "2026-09-11");
    assert.equal(isoDate("bukan tanggal"), "");
});

test("kop laporan terbaca dan baris normal ikut", () => {
    const result = parseOrderDetail([...HEAD, line(), line({ PRD_ID: "106068", QTY: 72, PRICE: 22072.07 })], PACKS);
    assert.match(result.branch, /1201671/);
    assert.match(result.period, /2026-09-11/);
    assert.equal(result.issues.length, 0, result.issues.join(" | "));
    assert.equal(result.lines.length, 2);
    // 24 tidak habis dibagi 36 -> tetap BTL; 72 habis dibagi 36 -> 2 KRT.
    assert.deepEqual([result.lines[0].unit, result.lines[0].qty], ["BTL", 24]);
    assert.deepEqual([result.lines[1].unit, result.lines[1].qty], ["KRT", 2]);
    assert.equal(result.lines[1].price, 22072.07 * 36);
    // CUST_ID1, bukan CUST_ID2, dan bukan nama outlet.
    assert.equal(result.lines[0].customerCode, "16710223162");
});

test("baris rekap, QTY nol, dan produk tanpa mapping dikeluarkan dan dilaporkan", () => {
    const result = parseOrderDetail([
        ...HEAD,
        line(),
        line({ QTY: 0 }),
        line({ PRD_ID: "999999" }),
        ["Total for 1201671", "", "", "", "", "", "", "", "", "", 1236, 0, 24488648],
        ["Grand Total", "", "", "", "", "", "", "", "", "", 1236, 0, 24488648],
    ], PACKS);
    assert.equal(result.lines.length, 1, JSON.stringify(result.lines.map((l) => l.productCode)));
    assert.deepEqual(result.unmappedProducts, ["999999"]);
    assert.match(result.issues.join(" "), /QTY 0/);
    assert.match(result.issues.join(" "), /belum ada di mapping/);
});

test("berkas yang bukan Order Detail ditolak, bukan menghasilkan nol baris diam-diam", () => {
    const result = parseOrderDetail([["Kolom A", "Kolom B"], ["1", "2"]], PACKS);
    assert.equal(result.lines.length, 0);
    assert.match(result.issues[0], /bukan berkas Order Detail/);
});

test("kolom DISC_n yang berisi RUPIAH dibedakan dari yang berisi persen", () => {
    // Berkas 12 September 2026 memuat keduanya. SS DIAPERS: persen di DISC_1.
    const persen = discountsOf({ DISC_1: 2, GROSS: 95675.68, TOTAL_DISC: 1913.51 }, false);
    assert.deepEqual(persen, [{ position: 1, percent: 2 }]);

    // RISKA TK: RUPIAH di DISC_5 (potongan faktur MSG yang dibagi rata). Dibaca sebagai
    // persen, 446,8468 berarti 446,85% — dan potongan yang SAH ikut tertahan.
    const rupiah = discountsOf({ DISC_5: 446.8468, GROSS: 29729.73, TOTAL_DISC: 446.85 }, false);
    assert.equal(rupiah.length, 1);
    assert.equal(rupiah[0].position, 5);
    assert.equal(rupiah[0].amount, 446.8468);
    // Persen setara: hitungan di hilir tidak perlu tahu bedanya.
    assert.ok(Math.abs(29729.73 * rupiah[0].percent / 100 - 446.85) <= 1);

    // Baris bonus tetap 100% di posisi 1, tidak ikut ditebak-tebak.
    assert.deepEqual(discountsOf({ DISC_1: 0, GROSS: 1000, TOTAL_DISC: 1000 }, true), [{ position: 1, percent: 100 }]);

    // Dua posisi terisi: tidak dibedakan, jatuh ke persen. Kalau ternyata salah, selisih
    // totalnya yang menahan barisnya — gagal tertutup.
    const campur = discountsOf({ DISC_1: 4, DISC_4: 2.25, GROSS: 345945.95, TOTAL_DISC: 21310.27 }, false);
    assert.deepEqual(campur, [{ position: 1, percent: 4 }, { position: 4, percent: 2.25 }]);
});

