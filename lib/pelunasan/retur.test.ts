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

test("RJN yang sama di dua daftar berbeda: sisanya terpakai sekali, kekurangan dilunasi sesuai Accurate (dicatat, bukan retur manual)", async () => {
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
    const pesan: string[] = [];
    const out = await parsePelunasan(rows, { trxDate: "2026-11-27", isKeySaved: true, peta: PETA0, accurateFetch: fetch as never, lapor: (j, p) => { if (j === "warning") pesan.push(p); } });
    const dipakai = out.payload.flatMap((d) => d.detailInvoice).filter((l: { invoiceNo: string }) => l.invoiceNo === rjn.number)
        .reduce((s: number, l: { paymentAmount: number }) => s + l.paymentAmount, 0);
    assert.equal(dipakai, -100000, `dulu −200.000 (sisa 100.000 terpakai dua kali); kini ${dipakai}`);
    assert.equal(out.manualRows, null, "aturan pemilik 28 Nov: dokumen ada → sesuai Accurate, bukan retur manual");
    assert.ok(pesan.some((p) => /1 baris: retur di berkas lebih besar dari sisa RJN di Accurate.*INV\/2611\/AA00011 \(Rp 100\.000\)/.test(p)), pesan.join(" | "));
});

/* 28 Nov 2026 (P.27-11-2026): jalur SRB. sales-return/list.do TIDAK membawa primeOwing, jadi SRB yang ketemu selalu terbaca "habis" dan
 * jatuh ke retur manual (AB00321 SRB2676.47 = RJN/2611/AB00216 sisa 81.391,89; AB00322 SRB 2676.49 = RJN/2611/AB00218). Dan berkas menulis
 * SRB2676.47 juga untuk INV/2609/AB00896 (SINAR ABADI), padahal itu retur H.MAMING; retur AB00896 = RJN/2611/AB00217 "INV/2609/AB00896_SRB2676.48_…". */
test("SRB: sisa dibaca dari dokumen RJN; retur pelanggan lain ditolak; salah tulis SRB tetap ketemu lewat nomor faktur di keterangan", async () => {
    const { parsePelunasan } = await import("./parser.ts");
    const ret = (number: string, customerNo: string, description: string, total: number) => ({ id: number, number, customer: { customerNo }, branch: { id: 5, name: "ABC" }, description, totalAmount: total }); // tanpa primeOwing (bentuk nyata)
    const dataRetur = [
        ret("RJN/2611/AB00216", "C-MAM075-AB", "INV/2609/AB00321_SRB2676.47_input21/11/2026_#", 81391.8906),
        ret("RJN/2611/AB00217", "C-SIN172-AB", "INV/2609/AB00896_SRB2676.48_input21/11/2026_#", 49399.3992),
    ];
    const sisaRjn: Record<string, number> = { "RJN/2611/AB00216": -81391.8906, "RJN/2611/AB00217": -49399.3992 };
    const faktur: Record<string, [string, number]> = { "INV/2609/AB00321": ["C-MAM075-AB", 91325.205], "INV/2609/AB00896": ["C-SIN172-AB", 54833.3992] };
    const fetch = async (path: string, _m: string, q?: unknown) => {
        const p = (q ?? {}) as Record<string, unknown>;
        if (path.startsWith("/api/sales-return/")) {
            // Bentuk nyata (28 Nov 2026): `keyword` DIABAIKAN — jawabannya retur terbaru pelanggan lain; filter.keywords CONTAIN bekerja.
            if (p.keyword !== undefined) return { s: true, d: [ret("RJN/2611/KN09999", "C-KIN012-KN", "27/11/26_input28/11/2026_*", 71827)] };
            const cari = String(p["filter.keywords.val"] ?? "").replace(/\s+/g, "").toUpperCase();
            return { s: true, d: cari ? dataRetur.filter((r) => r.description.replace(/\s+/g, "").toUpperCase().includes(cari)).map((r) => ({ ...r })) : [] };
        }
        const no = String(p["filter.number.val"] ?? "");
        if (p["filter.number.op"] === "EQUAL" && sisaRjn[no] != null) return { s: true, d: [{ number: no, primeOwing: sisaRjn[no], customer: dataRetur.find((r) => r.number === no)!.customer }] };
        if (p["filter.number.op"] === "EQUAL" && faktur[no]) return { s: true, d: [{ number: no, primeOwing: faktur[no][1], customer: { customerNo: faktur[no][0] }, branch: { id: 5, name: "ABC" } }] };
        return { s: true, d: [] };
    };
    const PETA0 = { mapTunaiAutoNum: "", mapTunaiBank: "", mapTrfAutoNum: "", mapTrfBank: "", mapBgAutoNum: "", mapBgBank: "", mapPot1Account: "", mapPot2Account: "", mapPot3Account: "" };
    const rows = [ // AB00896 sengaja DULUAN: dulu retur H.MAMING (AB00216) habis untuk SINAR ABADI
        { "Code Outlet": "C-SIN172", "No. Nota": "INV/2609/AB00896", "Tunai": 5434, "No.SRB Rt Ktr": "SRB2676.47", "Pot.RT Ktr": 49399 },
        { "Code Outlet": "C-MAM075", "No. Nota": "INV/2609/AB00321", "Tunai": 9933, "No.SRB Rt Ktr": "SRB2676.47", "Pot.RT Ktr": 81392 },
    ];
    const out = await parsePelunasan(rows, { trxDate: "2026-11-27", isKeySaved: true, peta: PETA0, accurateFetch: fetch as never });
    const retur = out.payload.flatMap((d) => d.detailInvoice.filter((l: { invoiceNo: string }) => l.invoiceNo.startsWith("RJN")).map((l: { invoiceNo: string; paymentAmount: number }) => [d.customerNo, l.invoiceNo, l.paymentAmount]));
    // Selisih berkas vs RJN ≤ Rp 100 → RJN dihabiskan (aturan pemilik): −49.399,3992 dan −81.391,8906.
    assert.deepEqual(retur, [["C-SIN172-AB", "RJN/2611/AB00217", -49399.3992], ["C-MAM075-AB", "RJN/2611/AB00216", -81391.8906]],
        "dulu: keduanya retur manual (SRB tanpa sisa); tanpa syarat pelanggan, AB00216 terpakai untuk SINAR ABADI");
    assert.equal(out.manualRows, null);
});

test("retur gagal dibaca (28 Nov 2026): galat Step4 tidak melompati Step4b; galat menyeluruh = retur manual berlabel GAGAL DIBACA, bukan 'belum ditemukan'", async () => {
    const { parsePelunasan } = await import("./parser.ts");
    const rjn = { id: 1, number: "RJN/2611/AB00217", customer: { customerNo: "C-SIN172-AB" }, branch: { id: 5, name: "ABC" }, description: "INV/2609/AB00896_SRB2676.48_input21/11/2026_#" };
    const buat = (salesReturnGagal: (p: Record<string, unknown>) => boolean) => async (path: string, _m: string, q?: unknown) => {
        const p = (q ?? {}) as Record<string, unknown>;
        if (path.startsWith("/api/sales-return/")) {
            if (salesReturnGagal(p)) throw new Error("Accurate tidak merespons dalam 30 detik (timeout). Coba lagi.");
            const cari = String(p["filter.keywords.val"] ?? "").toUpperCase();
            return { s: true, d: cari && rjn.description.includes(cari) ? [{ ...rjn }] : [] };
        }
        const no = String(p["filter.number.val"] ?? "");
        if (no === "RJN/2611/AB00217") return { s: true, d: [{ number: no, primeOwing: -49399.3992, customer: rjn.customer }] };
        if (no === "INV/2609/AB00896") return { s: true, d: [{ number: no, primeOwing: 54833.3992, customer: rjn.customer, branch: rjn.branch }] };
        return { s: true, d: [] };
    };
    const PETA0 = { mapTunaiAutoNum: "", mapTunaiBank: "", mapTrfAutoNum: "", mapTrfBank: "", mapBgAutoNum: "", mapBgBank: "", mapPot1Account: "", mapPot2Account: "", mapPot3Account: "" };
    const rows = [{ "Code Outlet": "C-SIN172", "No. Nota": "INV/2609/AB00896", "Tunai": 5434, "No.SRB Rt Ktr": "SRB2676.47", "Pot.RT Ktr": 49399 }];

    // Step4 (`keyword` ekor faktur) galat: dulu dilempar ke catch luar → NOT_FOUND tanpa mencoba Step4b; kini Step4b tetap menemukan.
    const a = await parsePelunasan(rows, { trxDate: "2026-11-27", isKeySaved: true, peta: PETA0, accurateFetch: buat((p) => p.keyword === "AB00896") as never });
    assert.ok(a.payload.some((d) => d.detailInvoice.some((l: { invoiceNo: string }) => l.invoiceNo === "RJN/2611/AB00217")), "RJN AB00217 ikut terkirim");
    assert.equal(a.manualRows, null);

    // Semua bacaan sales-return galat: retur manual, tetapi berlabel gagal dibaca + peringatan "ulangi pratinjau".
    const pesan: string[] = [];
    const b = await parsePelunasan(rows, { trxDate: "2026-11-27", isKeySaved: true, peta: PETA0, accurateFetch: buat(() => true) as never,
        lapor: (j, p) => { if (j === "warning") pesan.push(p); } });
    assert.equal(b.manualRows?.length, 1);
    assert.match(String(b.manualRows?.[0]["Aksi Manual"]), /^Retur GAGAL DIBACA dari Accurate/);
    assert.ok(pesan.some((p) => /1 di antaranya GAGAL DIBACA dari Accurate.*ulangi pratinjau/.test(p)), pesan.join(" | "));
});
