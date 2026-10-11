/* S6e-2 (owner #6): pemeriksaan riwayat sales-receipt di SERVER, fail-closed — logika pencocokan sama dengan pratinjau
 * (golden p01 tetap identik), tetapi jawaban tak terbaca/terpotong/terlambat = kunci GAGAL (ditahan), bukan lolos. Emulator
 * Accurate tiruan, tanpa jaringan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buatEmulator } from "./uji/emulator-accurate.ts";
import { fixturePratinjau } from "./uji/fixture.ts";
import { periksaRiwayatAccurate, pratinjauRiwayatAccurate, targetRiwayat } from "./pratinjau-ganda.ts";
import type { AccurateFetch } from "./retur.ts";

const target = (r: Record<string, unknown>) => targetRiwayat(r);

test("server: cocok sama dengan pratinjau klien (fixture p01)", async () => {
    const p = fixturePratinjau();
    const klien = await pratinjauRiwayatAccurate(p.rows, buatEmulator(p.data).accurateFetch as AccurateFetch);
    const server = await periksaRiwayatAccurate(p.rows.map(target), buatEmulator(p.data).accurateFetch as AccurateFetch);
    assert.deepEqual([...server.cocok], [...klien]);
    assert.equal(server.cocok.size, 1, "satu baris identik dengan RCP/2610/0001");
    assert.equal(server.gagal.size, 0);
});

test("server: galat baca satu kelompok -> kunci kelompok itu GAGAL (ditahan), kelompok lain tetap dinilai", async () => {
    const p = fixturePratinjau();
    const emu = buatEmulator({ ...p.data, galat: ["PLG-A-002"] });
    const r = await periksaRiwayatAccurate(p.rows.map(target), emu.accurateFetch as AccurateFetch);
    assert.deepEqual([...r.gagal.keys()], [target(p.rows[2]).key]);
    assert.match(r.gagal.get(target(p.rows[2]).key)!, /galat buatan/);
    assert.equal(r.cocok.size, 1, "PLG-A-003 tetap cocok");
    // Pratinjau klien (fail-open lama) TIDAK berubah: galat menghentikan pencarian tanpa melempar.
    await pratinjauRiwayatAccurate(p.rows, emu.accurateFetch as AccurateFetch);
});

test("server: jawaban bukan s:true / detail kosong / daftar terpotong = GAGAL (bukan lolos)", async () => {
    const row = { customerNo: "C1", transDate: "01/10/2026", detailInvoice: [{ invoiceNo: "I1", paymentAmount: 1 }] };
    const coba = async (f: AccurateFetch) => (await periksaRiwayatAccurate([target(row)], f)).gagal.size;
    assert.equal(await coba(async () => ({ s: false, d: ["Sesi habis"] })), 1, "list.do s:false");
    assert.equal(await coba(async (path) => path.endsWith("list.do") ? { s: true, d: [{ id: 1 }], sp: { pageCount: 1 } } : { s: false, d: ["x"] }), 1, "detail s:false");
    assert.equal(await coba(async () => ({ s: true, d: [], sp: { pageCount: 6 } })), 1, "> 5 halaman");
    // Kontrol positif: daftar kosong yang terbaca = tidak mirip, tidak gagal.
    assert.equal(await coba(async () => ({ s: true, d: [], sp: { pageCount: 1 } })), 0);
});

test("server: melewati batas waktu -> kelompok yang belum selesai GAGAL; paling banyak 4 serentak", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ customerNo: `C${i}`, transDate: "01/10/2026", detailInvoice: [{ invoiceNo: `I${i}`, paymentAmount: 1 }] }));
    let kini = 0;
    let maks = 0;
    const lambat: AccurateFetch = async (_p, _m, q) => {
        kini++; maks = Math.max(maks, kini);
        try {
            if ((q as Record<string, unknown>)["filter.customerNo"] === "C7") await new Promise(() => {}); // tidak pernah menjawab
            await new Promise((r) => setTimeout(r, 2));
            return { s: true, d: [], sp: { pageCount: 1 } };
        } finally { kini--; }
    };
    const r = await periksaRiwayatAccurate(rows.map(target), lambat, { batasMs: 200 });
    assert.deepEqual([...r.gagal.keys()], [target(rows[7]).key]);
    assert.match(r.gagal.get(target(rows[7]).key)!, /batas waktu/);
    assert.ok(maks <= 4 && maks >= 2, `serentak ${maks}`);
});

// S6e-2 (bukti baca-saja detail.do 10 Okt): bentuk ASLI = invoice.number + customer.customerNo; item diskon account.no.
const asli = (cust: string, inv: string, amt: number, diskon: unknown[] = []) => ({ s: true, d: {
    number: "PR.1", customer: { customerNo: cust }, transDate: "01/10/2026", detailInvoice: [{ invoice: { number: inv }, invoiceId: 5, paymentAmount: amt, detailDiscount: diskon }] } });
const satuKandidat = (detail: unknown): AccurateFetch => async (path) => path.endsWith("list.do") ? { s: true, d: [{ id: 1, number: "PR.1" }], sp: { pageCount: 1 } } : detail;

test("normalisasi: bentuk asli Accurate (invoice.number, account.no) cocok dengan baris payload; bentuk lama (invoiceNo) tetap", async () => {
    const row = { customerNo: "C1", transDate: "01/10/2026", detailInvoice: [{ invoiceNo: "I1", paymentAmount: 900, detailDiscount: [{ accountNo: "600123", amount: 100 }] }] };
    const cocok = async (f: AccurateFetch) => (await periksaRiwayatAccurate([target(row)], f)).cocok.get(target(row).key);
    assert.deepEqual(await cocok(satuKandidat(asli("C1", "I1", 900, [{ account: { no: "600123" }, amount: 100 }]))), ["PR.1"]);
    assert.deepEqual(await cocok(satuKandidat({ s: true, d: { number: "PR.1", customerNo: "C1", transDate: "01/10/2026",
        detailInvoice: [{ invoiceNo: "I1", paymentAmount: 900, detailDiscount: [{ accountNo: "600123", amount: 100 }] }] } })), ["PR.1"]);
    // Nominal beda = tidak mirip (dan bukan gagal).
    const beda = await periksaRiwayatAccurate([target(row)], satuKandidat(asli("C1", "I1", 800, [{ account: { no: "600123" }, amount: 100 }])));
    assert.equal(beda.cocok.size + beda.gagal.size, 0);
});

test("normalisasi: bentuk tak dikenali (tanpa nomor faktur / detailInvoice bukan daftar) = GAGAL BACA di server, TIDAK TERBACA di pratinjau", async () => {
    const row = { customerNo: "C1", transDate: "01/10/2026", detailInvoice: [{ invoiceNo: "I1", paymentAmount: 900 }] };
    // Item potongan tanpa nomor akun TIDAK lagi di sini: potongan tidak ikut keputusan (tinjauan 11 Okt A1, uji probe di bawah).
    const rusak = [
        { s: true, d: { number: "PR.1", customer: { customerNo: "C1" }, detailInvoice: [{ invoiceId: 5, paymentAmount: 900 }] } },
        { s: true, d: { number: "PR.1", customer: { customerNo: "C1" } } },
    ];
    for (const d of rusak) {
        const server = await periksaRiwayatAccurate([target(row)], satuKandidat(d));
        assert.match(server.gagal.get(target(row).key) ?? "", /tidak dikenali/, JSON.stringify(d));
        const klien = await pratinjauRiwayatAccurate([row], satuKandidat(d));
        assert.ok(klien.tidakTerbaca.has(target(row).key), "pratinjau: tidak terbaca, bukan aman");
    }
});

// ------------------------------------------------------------------ Tinjauan 11 Okt A1/B1: identitas KASAR (orkestrator)
// TAHAN = pelanggan + tanggal + {faktur: nominal bayar}; akun/catatan/jumlah potongan TIDAK ikut. Probe peninjau A (P2/P3/P3b/P3c)
// dan REV-B F: semuanya HARUS ditahan (cocok), bukan lolos karena bentuk potongan berbeda.
const berpotongan = (diskon: Record<string, unknown>) => ({ customerNo: "C1", transDate: "01/10/2026",
    detailInvoice: [{ invoiceNo: "I1", paymentAmount: 900, detailDiscount: [diskon] }] });
const POT = { accountNo: "600123", discountNotes: "Pot TB", amount: 100 };

test("A1 probe P2/P3/P3b/P3c + REV-B F: bentuk/akun/catatan potongan berbeda tetap DITAHAN (cocok), bukan lolos", async () => {
    const kasus: Array<[string, Record<string, unknown>, unknown[]]> = [
        ["P2 jumlah potongan bernama lain", POT, [{ account: { no: "600123" }, discountNotes: "Pot TB", discountAmount: 100 }]],
        ["P3 Pot.DiscTB tanpa accountNo (Accurate mengisi akun bawaan)", { discountNotes: "Pot DiscTB", amount: 100 }, [{ account: { no: "610000" }, discountNotes: "Pot DiscTB", amount: 100 }]],
        ["P3b / REV-B F discountNotes tidak dikembalikan", POT, [{ account: { no: "600123" }, amount: 100 }]],
        ["P3c akun potongan diganti", POT, [{ account: { no: "699999" }, discountNotes: "Pot TB", amount: 100 }]],
        ["item potongan tanpa nomor akun (dulu GAGAL BACA)", POT, [{ amount: 100, discountNotes: "x" }]],
    ];
    for (const [nama, diskon, diskonAccurate] of kasus) {
        const row = berpotongan(diskon);
        const r = await periksaRiwayatAccurate([target(row)], satuKandidat(asli("C1", "I1", 900, diskonAccurate)));
        assert.deepEqual(r.cocok.get(target(row).key), ["PR.1"], nama);
        assert.equal(r.gagal.size, 0, nama);
        const klien = await pratinjauRiwayatAccurate([row], satuKandidat(asli("C1", "I1", 900, diskonAccurate)));
        assert.deepEqual(klien.get(target(row).key), ["PR.1"], `pratinjau: ${nama}`);
    }
});

test("A1: nominal baris dianggap sama bila = paymentAmount ATAU invoicePayment Accurate; faktur/nominal lain = tidak mirip", async () => {
    const row = { customerNo: "C1", transDate: "01/10/2026", detailInvoice: [{ invoiceNo: "I1", paymentAmount: 1000 }] };
    const dgn = (pa: unknown, ip: unknown, inv = "I1") => satuKandidat({ s: true, d: { number: "PR.1", customer: { customerNo: "C1" },
        detailInvoice: [{ invoice: { number: inv }, paymentAmount: pa, invoicePayment: ip, detailDiscount: [] }] } });
    const cocok = async (f: AccurateFetch) => (await periksaRiwayatAccurate([target(row)], f)).cocok.get(target(row).key);
    assert.deepEqual(await cocok(dgn(900, 1000)), ["PR.1"], "= invoicePayment");
    assert.deepEqual(await cocok(dgn(1000, 1100)), ["PR.1"], "= paymentAmount");
    assert.equal(await cocok(dgn(900, 950)), undefined, "nominal lain");
    assert.equal(await cocok(dgn(1000, 1000, "I2")), undefined, "faktur lain");
    // Lebih banyak menahan: baris Rp900 + potongan Rp100 dianggap sama dengan paymentAmount Accurate Rp1.000 (bila Accurate menjumlahnya).
    const pot = berpotongan(POT);
    assert.deepEqual((await periksaRiwayatAccurate([target(pot)], dgn(1000, null))).cocok.get(target(pot).key), ["PR.1"], "bayar + potongan");
});

test("A1: nomor faktur / nominal TAK TERBACA (bukan angka) = GAGAL BACA (ditahan); potongan tidak ikut keputusan", async () => {
    const row = { customerNo: "C1", transDate: "01/10/2026", detailInvoice: [{ invoiceNo: "I1", paymentAmount: 900 }] };
    const baris = (x: Record<string, unknown>) => satuKandidat({ s: true, d: { number: "PR.1", customer: { customerNo: "C1" }, detailInvoice: [x] } });
    for (const x of [{ invoice: { number: "I1" }, paymentAmount: "abc" }, { invoice: { number: "I1" } }, { invoice: { number: "I1" }, paymentAmount: { v: 1 } },
        { invoice: { number: "I1" }, paymentAmount: 900, invoicePayment: "x" }, { invoice: {}, paymentAmount: 900 }]) {
        const r = await periksaRiwayatAccurate([target(row)], baris(x));
        assert.match(r.gagal.get(target(row).key) ?? "", /tidak dikenali/, JSON.stringify(x));
    }
    // Item potongan apa pun bentuknya tidak menahan baris berfaktur lain (bukan GAGAL BACA).
    const lain = await periksaRiwayatAccurate([target(row)], baris({ invoice: { number: "I9" }, paymentAmount: 5, detailDiscount: [{ aneh: true }] }));
    assert.equal(lain.gagal.size + lain.cocok.size, 0);
});
