/* Mengunci cek "sudah diinput di Accurate" (25 Nov 2026): pelunasan ada yang diinput sales, ada yang admin. Dengan kolom Saldo (Form Kerja
 * Inc "6_Saldo" = sisa piutang sebelum baris), sisa Accurate ≈ Saldo → dikirim; ≈ Saldo − bayar → dilewati; lainnya → PERLU_CEK.
 * Angka baris D & E dari berkas nyata 24 Nov 2026 (INV/2607/HZ01281, INV/2604/GD00274). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { alokasikan } from "./alokasi.ts";

const PETA = { mapTunaiAutoNum: "", mapTunaiBank: "", mapTrfAutoNum: "", mapTrfBank: "", mapBgAutoNum: "", mapBgBank: "", mapPot1Account: "", mapPot2Account: "", mapPot3Account: "" };
const faktur = (no: string, sisa: number) => [no, { invoiceNo: no, customerNo: "C-X0001-SZ", branchId: 1, branchName: "B", outstanding: sisa }] as const;

test("sudah di Accurate: hanya baris yang belum diinput yang dikirim; sisanya dilewati atau ditahan dengan angka", () => {
    const rows = [
        { "Code Outlet": "C-X0001", "No. Nota": "INV/A", "Saldo": 1000000, "Tunai": 400000 },          // A belum (sisa = saldo)
        { "Code Outlet": "C-X0001", "No. Nota": "INV/B", "Saldo": 500000, "Tunai": 500000 },           // B sudah lunas
        { "Code Outlet": "C-X0001", "No. Nota": "INV/C", "Saldo": 300000, "Tunai": 100000 },           // C sudah (cicil oleh sales)
        { "Code Outlet": "C-X0001", "No. Nota": "INV/D", "Saldo": 1362317.31, "Tunai": 300000 },       // D lunas penuh di Accurate → cek
        { "Code Outlet": "C-X0001", "No. Nota": "INV/E", "Saldo": 16062.4, "Tunai": 16062.4 },         // E belum, beda Rp1,33 = selisih
        { "Code Outlet": "C-X0001", "No. Nota": "INV/F", "Tunai": 50000 },                             // F tanpa Saldo → seperti dulu
    ];
    const invoiceBranchMap = new Map<string, Record<string, unknown>>([
        faktur("INV/A", 1000000), faktur("INV/B", 0), faktur("INV/C", 200000), faktur("INV/D", 0), faktur("INV/E", 16061.07), faktur("INV/F", 80000),
    ]);
    const { groupedMap, dilewati } = alokasikan(rows, { trxDate: "2026-11-24", peta: PETA, returMap: new Map(), invoiceBranchMap, invoiceLookupDebugMap: new Map() });

    assert.deepEqual(dilewati.map((d) => [d.invoiceNo, d.reason]), [["INV/B", "SUDAH_DI_ACCURATE"], ["INV/C", "SUDAH_DI_ACCURATE"], ["INV/D", "PERLU_CEK"]]);
    assert.match(dilewati[2].detail ?? "", /Sisa piutang Accurate Rp 0; berkas: saldo Rp 1\.362\.317,31, bayar Rp 300\.000/);
    const sr = [...groupedMap.values()][0];
    assert.equal(sr.customerNo, "C-X0001-SZ", "pelanggan dari faktur Accurate (bersufiks divisi)");
    assert.deepEqual(sr.detailInvoice.map((d: { invoiceNo: string }) => d.invoiceNo), ["INV/A", "INV/E", "INV/F"]);
    const e = sr.detailInvoice[1];
    assert.equal(e.paymentAmount, 16061.07, "uang tetap 16.062,4; selisih -1,33 ke akun selisih");
    assert.deepEqual(e.detailDiscount, [{ amount: 16061.07 - 16062.4, accountNo: "600136" }]);
});

test("retur ketemu tetapi sudah habis terpakai: tidak ada pelunasan sampah berisi selisih saja, masuk retur manual (uji kering 24 Nov)", () => {
    // INV/2611/KN00063: Pot. Lain RJN/2611/KN00158 Rp364.600,47, sisa faktur Rp364.600, retur di Accurate sudah terpakai (sisa 0).
    const rows = [{ "Code Outlet": "C-RAN772", "No. Nota": "INV/2611/KN00063", "Pot. Lain": 364600.4687, "Ket. Pot": "RJN/2611/KN00158" }];
    const returMap = new Map<string, Record<string, unknown>>([["DOC|RJN/2611/KN00158", {
        isArray: true, number: "RJN/2611/KN00158", outstanding: 0, customerNo: "C-RAN772-KN",
        returns: [{ number: "RJN/2611/KN00158", primeOwing: 0, customer: { customerNo: "C-RAN772-KN" } }],
    }]]);
    const invoiceBranchMap = new Map<string, Record<string, unknown>>([["INV/2611/KN00063", { customerNo: "C-RAN772-KN", branchId: 1, outstanding: 364600 }]]);
    const out = alokasikan(rows, { trxDate: "2026-11-24", peta: PETA, returMap, invoiceBranchMap, invoiceLookupDebugMap: new Map() });
    assert.deepEqual([...out.groupedMap.values()].flatMap((s) => s.detailInvoice), [], "dulu: INV -0,47 dengan 600136 -0,47");
    assert.equal(out.unresolvedReturWarnings[0]?.unresolvedSrbAmt, 364600.4687);
});
