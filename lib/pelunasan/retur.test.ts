/* S6e-1 butir 4a — penyelidikan "tabrakan charField1" (retur faktur Antrean → NOT_FOUND). Uji ini MEMBUKTIKAN perilaku
 * yang ada; tidak ada perbaikan yang diklaim. Ringkasan:
 *  1. Pencarian retur selesai SEBELUM pencarian faktur dimulai (W:667-926 vs W:928+) → `expectedCharField1` yang dulu
 *     dibaca dari peta faktur selalu "" → charField1 kepala faktur (kunci antrean PRINCIPAL:SO) tidak pernah sampai ke skor.
 *  2. Bahkan bila sampai: untuk referensi bertoken (semua referensi wajar), blok pelanggan/charField1 skor tidak jalan.
 *  3. Mekanisme NOT_FOUND yang TERBUKTI dari kode (bukan khusus Antrean): varian tanpa spasi menemukan kandidat, tetapi
 *     skornya 0 karena hanya token mentah di batas kata yang dihitung. Penyebab di produksi: pertanyaan terbuka. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buatEmulator } from "./uji/emulator-accurate.ts";
import { fakturAntrean } from "./uji/fixture.ts";
import { jalankanLib } from "./uji/jalankan.ts";
import { buildReturSearchVariants, cariRetur, parseReturReference, returDocumentMatches, scoreReturCandidate } from "./retur.ts";

const golden = JSON.parse(readFileSync("lib/pelunasan/uji/golden.json", "utf8")) as Record<string, { payload: unknown; manualRows: unknown }>;
const json = (v: unknown) => JSON.stringify(v, null, 2);
const FIELDS_FAKTUR = "number,branch,primeOwing,customer,charField1";

test("urutan: semua pencarian retur selesai sebelum pencarian faktur pertama (expectedCharField1 tak mungkin terisi)", async () => {
    const fx = fakturAntrean("PRINCIPAL-A:SO-0001")();
    const emu = buatEmulator(fx.data);
    await jalankanLib(fx, emu);
    const urut = emu.panggilan.map((p) => (p.path.startsWith("/api/sales-return/") ? "retur"
        : (p.payload as Record<string, unknown>)?.fields === FIELDS_FAKTUR ? "faktur" : "lain"));
    const terakhirRetur = urut.lastIndexOf("retur");
    const pertamaFaktur = urut.indexOf("faktur");
    assert.ok(terakhirRetur >= 0 && pertamaFaktur >= 0, urut.join(","));
    assert.ok(terakhirRetur < pertamaFaktur, `retur terakhir #${terakhirRetur} harus sebelum faktur pertama #${pertamaFaktur}: ${urut.join(",")}`);
});

test("charField1 kepala faktur (kunci antrean PRINCIPAL:SO) tidak mengubah keluaran — golden kode LAMA kembar identik", async () => {
    // Golden direkam dari kode lama W: faktur ber-charField1 antrean vs faktur charField1 kosong.
    assert.equal(json(golden["f10-faktur-antrean-charfield1"].payload), json(golden["f10b-faktur-antrean-tanpa-charfield1"].payload));
    assert.equal(json(golden["f10-faktur-antrean-charfield1"].manualRows), json(golden["f10b-faktur-antrean-tanpa-charfield1"].manualRows));
    // Dan lib: kunci antrean apa pun → keluaran sama.
    const hasil: string[] = [];
    for (const cf of ["PRINCIPAL-A:SO-0001", "", "CABANG A", "uuid-order-0001"]) {
        const fx = fakturAntrean(cf)();
        const emu = buatEmulator(fx.data);
        hasil.push(json((await jalankanLib(fx, emu)).payload));
    }
    assert.equal(new Set(hasil).size, 1);
});

test("skor retur bertoken tidak bergantung expectedCharField1 maupun pelanggan", () => {
    const ref = parseReturReference("SRB 2610.0091");
    assert.deepEqual(ref.codeTokens, ["SRB 2610.0091"], "kode tanpa garis miring tetap jadi token");
    const kandidat = { number: "SRT/2610/XJ0091", keywords: "SRB 2610.0091", customer: { customerNo: "PLG-J-001", charField1: "CABANG A" } };
    const skor = (cust: string, cf: string) => scoreReturCandidate(kandidat, cust, cf, ref);
    const dasar = skor("PLG-J-001", "");
    assert.ok(dasar >= 90, `kandidat diterima (${dasar})`);
    for (const [cust, cf] of [["PLG-J-001", "PRINCIPAL-A:SO-0001"], ["PLG-J-001", "CABANG A"], ["PLG-LAIN-9", "CABANG B"]]) {
        assert.equal(skor(cust, cf), dasar, `${cust}/${cf}`);
    }
});

test("Accurate mengabaikan filter.returnDocumentNumber (jawaban retur acak): varian SRB tanpa spasi tetap dicoba dan ketemu", async () => {
    // Tiruan perilaku nyata 25 Nov 2026: keywords CONTAIN jalan (spasi = 0 hasil), returnDocumentNumber/number/keyword DIABAIKAN.
    const benar = { number: "RJN/2609/CS00170", customer: { customerNo: "C-NU0023-CS" }, primeOwing: 105000,
        description: "INV/2607/CS00145_SRB2667.57_input28/09/2026_#_@ - CN023185" };
    const acak = [{ number: "RJN/2611/AB00253", customer: { customerNo: "C-AL0064-AB" }, description: "DR-K26000003793_input25/11/2026_*", primeOwing: 1 }];
    const fetch = async (_path: string, _m: string, q?: unknown) => {
        const p = (q ?? {}) as Record<string, unknown>;
        if (p["filter.keywords.op"]) return { s: true, d: String(p["filter.keywords.val"]) === "SRB2667.57" ? [benar] : [] };
        return { s: true, d: acak };
    };
    const peta = new Map();
    await cariRetur(new Map([["C-NU0023|SRB 2667.57", { desc: "SRB 2667.57", invNos: new Set(["INV/2607/CS00145"]), sourceCustomerNo: "C-NU0023", isAyatSilang: false }]]), peta, fetch);
    assert.equal(peta.get("C-NU0023|SRB 2667.57")?.number, "RJN/2609/CS00170", "dulu NOT_FOUND: jawaban acak menghentikan varian");
});

test("SRB tersimpan tanpa spasi di Accurate (…_SRB2653.57_…) tetap diterima: skor lolos ambang 90", () => {
    const excel = "SRB 2610.0003";
    assert.ok(buildReturSearchVariants(excel).includes("SRB2610.0003"), "pencarian memang mencoba varian tanpa spasi");
    const kandidat = { number: "SRT/2610/XX0003", keywords: "SRB2610.0003", customer: { customerNo: "PLG-D-002" } };
    assert.ok(scoreReturCandidate(kandidat, "PLG-D-002", "", parseReturReference(excel)) >= 90, "dulu skor 0 → NOT_FOUND (retur manual)");
    assert.equal(returDocumentMatches(kandidat, excel), true, "jalur ayat silang dan jalur SRB kini sepakat");
    // Bentuk nyata Accurate (RJN/2609/GD00062): deskripsi memuat SRB rapat di antara garis bawah.
    const nyata = { number: "RJN/2609/GD00062", description: "INV/2604/GD00731_SRB2653.57_input09/09/2026_#", customer: { customerNo: "C-580001-GD" } };
    assert.ok(scoreReturCandidate(nyata, "C-580001", "", parseReturReference("SRB 2653.57")) >= 90);
});

/* 28 Nov 2026 (uji kering P.27-11-2026): "…HZ00248,RJN/2606/HZ00008" diurai jadi token "RJN/2605/RJN"; nomor itu tak ada, lalu pindaian
 * keyword longgar mencocokkan RJN TERBARU pelanggan lain (RJN/2611/M100748–M100750, sisa Rp 73 rb) di 6 faktur, ±5× sisanya. */
const DAFTAR_HZ = "RJN/2605/HZ00187,HZ00248,RJN/2606/HZ00008,HZ00613,RJN/2607/HZ00266";
test("RJN: potongan 'RJN' sebelum periode berikutnya bukan nomor; 'RJN2607/' salah tulis dibaca 'RJN/2607/'", () => {
    assert.deepEqual(parseReturReference(DAFTAR_HZ).fullDocTokens,
        ["RJN/2605/HZ00187", "RJN/2605/HZ00248", "RJN/2606/HZ00008", "RJN/2606/HZ00613", "RJN/2607/HZ00266"]);
    assert.deepEqual(parseReturReference("RJN/2610/GD00036, RJN/2611/GD00104").fullDocTokens, ["RJN/2610/GD00036", "RJN/2611/GD00104"]);
    assert.deepEqual(parseReturReference("RJN2607/VI00015, KN00142, RJN/2609/AB00055").fullDocTokens,
        ["RJN/2607/VI00015", "RJN/2607/KN00142", "RJN/2609/AB00055"]);
});

test("RJN: nomor lengkap hanya diterima bila PERSIS ada (EQUAL); RJN terbaru pelanggan lain tidak pernah ikut", async () => {
    const ada = new Map([["RJN/2605/HZ00187", -500000], ["RJN/2606/HZ00008", -200000]].map(([n, p]) => [n as string, { id: n, number: n, primeOwing: p, customer: { customerNo: "C-CI0014-HZ" } }]));
    const terbaru = [{ id: 1, number: "RJN/2611/M100750", primeOwing: -33249.1, customer: { customerNo: "C-MI0090-M1" }, description: "" },
        { id: 2, number: "INV/2605/HZ00187", primeOwing: 900000, customer: { customerNo: "C-LAIN-HZ" }, description: "" }];
    const fetch = async (path: string, _m: string, q?: unknown) => {
        const p = (q ?? {}) as Record<string, unknown>;
        if (path.endsWith("detail.do")) return { s: true, d: ada.get(String(p.number)) ?? terbaru.find((x) => x.number === p.number) };
        if (p["filter.number.op"] === "EQUAL") { const d = ada.get(String(p["filter.number.val"])); return { s: true, d: d ? [d] : [] }; }
        return { s: true, d: terbaru, sp: { pageCount: 1 } }; // keyword bergaris miring diabaikan Accurate: jawaban = dokumen terbaru
    };
    const peta = new Map();
    await cariRetur(new Map([[`DOC|${DAFTAR_HZ}`, { desc: DAFTAR_HZ, invNos: new Set(["INV/2606/HZ01958"]), sourceCustomerNo: "C-CI0014", isAyatSilang: true }]]), peta, fetch);
    assert.deepEqual(peta.get(`DOC|${DAFTAR_HZ}`).returns.map((r: { number: string }) => r.number), ["RJN/2605/HZ00187", "RJN/2606/HZ00008"],
        "dulu: ikut RJN/2611/M100750 (pelanggan lain) dan INV/2605/HZ00187 (faktur biasa)");
});

test("RJN yang sama di dua daftar berbeda: sisanya terpakai sekali, kekurangan masuk retur manual", async () => {
    const { parsePelunasan } = await import("./parser.ts");
    const rjn = { id: 7, number: "RJN/2611/AA00001", primeOwing: -100000, customer: { customerNo: "C-A0001-AA" }, branch: { id: 2, name: "B" } };
    const faktur = (n: string) => ({ number: n, primeOwing: 500000, customer: { customerNo: "C-A0001-AA" }, branch: { id: 2, name: "B" } });
    const fetch = async (path: string, _m: string, q?: unknown) => {
        const p = (q ?? {}) as Record<string, unknown>;
        if (path.endsWith("detail.do")) return { s: true, d: { ...rjn } };
        const no = String(p["filter.number.val"] ?? "");
        if (no === rjn.number) return { s: true, d: [{ ...rjn }] };
        if (no.startsWith("INV/")) return { s: true, d: [faktur(no)] };
        return { s: true, d: [] };
    };
    const PETA0 = { mapTunaiAutoNum: "", mapTunaiBank: "", mapTrfAutoNum: "", mapTrfBank: "", mapBgAutoNum: "", mapBgBank: "", mapPot1Account: "", mapPot2Account: "", mapPot3Account: "" };
    const rows = [
        { "Code Outlet": "C-A0001", "No. Nota": "INV/2611/AA00010", "Tunai": 400000, "Pot. RT Gt": 100000, "No.RJS RT Gt": "RJN/2611/AA00001" },
        { "Code Outlet": "C-A0001", "No. Nota": "INV/2611/AA00011", "Tunai": 400000, "Pot. RT Gt": 100000, "No.RJS RT Gt": "RJN/2611/AA00001, AA00099" },
    ];
    const out = await parsePelunasan(rows, { trxDate: "2026-11-27", isKeySaved: true, peta: PETA0, accurateFetch: fetch as never });
    const dipakai = out.payload.flatMap((d) => d.detailInvoice).filter((l: { invoiceNo: string }) => l.invoiceNo === rjn.number)
        .reduce((s: number, l: { paymentAmount: number }) => s + l.paymentAmount, 0);
    assert.equal(dipakai, -100000, `dulu −200.000 (sisa 100.000 terpakai dua kali); kini ${dipakai}`);
    assert.equal(out.manualRows?.length, 1, "baris kedua: retur tak tertutup → retur manual");
});
