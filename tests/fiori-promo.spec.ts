/*
 * Tujuan: Fiori S4a Promo — Rekap (kartu, tak bertuan → Normalisasi, galat bukan nol), Normalisasi (kelompok, dialog Golongkan/Batalkan),
 *   Aturan (status, detail + artinya, BL-52, Hapus dan Impor lewat dialog, Daftar outlet), Summary (draf, siklus, Terbitkan dengan centang, gerbang faktur).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin): `npx playwright test tests/fiori-promo.spec.ts`.
 * Dependensi: /api/* di-mock dengan page.route; FastAPI Summary (dev: http://localhost:8000) di-mock dengan header CORS.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const path = (p: string) => (url: URL) => url.pathname === p;
const NAV = { timeout: 60_000 } as const;
const CORS = { "access-control-allow-origin": "http://localhost:3010", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, PUT, OPTIONS" };
const fastapi = (r: Route, body: unknown, status = 200) => r.request().method() === "OPTIONS"
    ? r.fulfill({ status: 204, headers: CORS })
    : r.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });

const ATURAN = [
    { id: 405, suratProgram: "BP2610009096", promoGroup: "SLEEK BABY", promoLabel: "Sleek Oktober", benefitType: "DISC_PCT", benefitValue: "3", benefitBeban: "PRINCIPAL", itemCode: "SBB200", itemName: "SLEEK BABY BATH 200 ML", customerCode: "", periodStart: "2026-10-01", periodEnd: "2026-10-31", tierNo: 1, outletList: "", outletListMode: "" },
];
const ROWS = [
    { bucket: "unowned", invoiceNo: "INV/2610/KN01388", invoiceId: "i1", lineKey: "l1", transDate: "2026-10-06", branchName: "KINO", customerNo: "C-1", customerName: "TK SINAR JAYA", itemCode: "SBB200", itemName: "SLEEK BABY BATH 200 ML", positions: "1", percent: 3, amount: 12735, suratProgram: "", promoGroup: "", reason: "Tidak ada aturan principal di posisi 1", calonAturan: { principal: [405], distributor: [] } },
    { bucket: "unowned", invoiceNo: "INV/2610/KN01391", invoiceId: "i2", lineKey: "l2", transDate: "2026-10-06", branchName: "KINO", customerNo: "C-2", customerName: "ALFAMART PETTARANI", itemCode: "SBB200", itemName: "SLEEK BABY BATH 200 ML", positions: "1", percent: 3, amount: 5000, suratProgram: "", promoGroup: "", reason: "Nominal berubah sesudah diputuskan", calonAturan: { principal: [405], distributor: [] }, bekasNormalisasi: "principal" },
    { bucket: "principal", invoiceNo: "INV/2610/KN01387", invoiceId: "i3", lineKey: "l3", transDate: "2026-10-05", branchName: "KINO", customerNo: "C-3", customerName: "UD MAJU", itemCode: "SBB200", itemName: "SLEEK", positions: "1", percent: 3, amount: 9000, suratProgram: "BP2610009096", promoGroup: "SLEEK BABY", reason: "", aturanId: 405 },
];
const RECAP = {
    ok: true, from: "2026-10-01", to: "2026-10-31", principal: "", principals: ["KINO NON FOOD"], invoicesInRange: 612, invoicesWithoutDetail: 3, rules: 128, webInvoiceIds: ["i1"], aturan: ATURAN,
    recap: { invoices: 609, lines: 4812, gross: 1_920_000_000, distributor: 2_500_000, principal: 18_250_000.5, unowned: 17735, rows: ROWS,
        programs: [{ key: "BP2610009096|SLEEK BABY", suratProgram: "BP2610009096", promoLabel: "Sleek Oktober", promoGroup: "SLEEK BABY", amount: 9000, lines: 1, invoices: 1, normalisasi: 9000, normalisasiBaris: 1 }],
        tarifMenganggur: [{ customerCode: "C-AL0063", tierNo: 4, benefitValue: "2.25", benefitBeban: "PRINCIPAL", suratProgram: "TARIF", promoLabel: "Alfamart", outletBertransaksi: true }],
        outletTanpaAturan: [{ customerNo: "C-2", customerName: "ALFAMART PETTARANI", amount: 5000, lines: 1, positions: ["1"], percents: [3] }] },
};
const hari = new Date(); const ymd = (d: Date) => d.toISOString().slice(0, 10);
const RULES = [
    { id: 412, principal: "KINO NON FOOD", suratProgram: "BP2610009097", promoLabel: "", promoGroup: "ESKULIN", itemCode: "ESK100", itemName: "ESKULIN COLOGNE", customerCode: "", periodStart: ymd(new Date(hari.getTime() - 5 * 864e5)), periodEnd: ymd(new Date(hari.getTime() + 20 * 864e5)), active: true, tierNo: 1, triggerQty: "30", triggerUnit: "PCS", benefitType: "BONUS_QTY", benefitValue: "1", benefitUnit: "", benefitBeban: "PRINCIPAL", channel: "", outletList: "LOYALTY", outletListMode: "INCLUDE", note: "", importedBy: "maya@x", source: "surat", sourceRef: "6ea38247" },
    { id: 420, principal: "KINO NON FOOD", suratProgram: "BP2610009096", promoLabel: "", promoGroup: "SLEEK", itemCode: "SBB200", itemName: "SLEEK BABY BATH 200 ML", customerCode: "", periodStart: null, periodEnd: null, active: false, tierNo: 1, triggerQty: "12", triggerUnit: "PCS", benefitType: "DISC_PCT", benefitValue: "1.5", benefitUnit: "%", benefitBeban: "PRINCIPAL", channel: "GT", outletList: "", outletListMode: "", note: "", importedBy: "maya@x", source: "manual", sourceRef: "" },
    { id: 377, principal: "KINO NON FOOD", suratProgram: "TARIF", promoLabel: "", promoGroup: "", itemCode: "", itemName: "", customerCode: "C-AL0063", periodStart: null, periodEnd: null, active: true, tierNo: 4, triggerQty: "0", triggerUnit: "PCS", benefitType: "DISC_PCT", benefitValue: "2.25", benefitUnit: "%", benefitBeban: "PRINCIPAL", channel: "", outletList: "", outletListMode: "", note: "", importedBy: "x", source: "excel", sourceRef: "" },
];

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Rekap: kartu beban, Tak bertuan menuju Normalisasi dengan periode, rincian; galat tidak tampil sebagai nol", async ({ page }) => {
    let gagal = false;
    await page.route(path("/api/promo-recap"), (r) => gagal ? r.fulfill(json({ ok: false, error: "statement timeout" }, 500)) : r.fulfill(json(RECAP)));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/rekap-promo", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("button", { name: /Klaim principal/ })).toContainText("Rp 18.250.000,50", NAV);
    await expect(main.getByRole("button", { name: /Beban distributor/ })).toContainText("Rp 2.500.000");
    const tak = main.getByRole("link", { name: /Tak bertuan/ });
    await expect(tak).toHaveAttribute("href", /\/normalisasi-diskon\?from=\d{4}-\d{2}-\d{2}&to=/);
    await expect(main.getByText("Rp 17.735 potongan belum bisa dipertanggungjawabkan.")).toBeVisible();
    await expect(main.getByRole("region", { name: "Tarif yang tidak terpakai" })).toContainText("2,25% di kolom 4"); // kolom setengah lebar: tabel tampil sebagai daftar
    await main.getByRole("button", { name: "Lihat rincian", exact: true }).click();
    await expect(main.getByRole("region", { name: "Rincian Tak bertuan" })).toContainText("2 baris");
    await page.screenshot({ path: "test-results/fiori-rekap-promo.png", fullPage: true });
    gagal = true;
    await page.reload();
    await expect(main.getByRole("alert")).toContainText("Rekap gagal dimuat", NAV);
    await expect(main.getByText("Rp 0")).toHaveCount(0);
});

test("Normalisasi: tiga kelompok, Golongkan lewat dialog mengirim aturan dasar; Batalkan lewat dialog", async ({ page }) => {
    const kirim: unknown[] = [];
    await page.route(path("/api/promo-recap"), (r) => r.fulfill(json(RECAP)));
    await page.route(path("/api/promo-recap/normalisasi"), (r) => { kirim.push({ m: r.request().method(), b: r.request().postDataJSON() }); return r.fulfill(json({ ok: true, disimpan: 1, dicabut: 1 })); });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/normalisasi-diskon?from=2026-10-01&to=2026-10-31", NAV);
    const main = page.locator("main");
    const segs = main.getByRole("group", { name: "Kelompok potongan" });
    await expect(segs).toContainText("Tak bertuan 1", NAV);
    await expect(segs).toContainText("Perlu diputuskan ulang 1");
    await expect(segs).toContainText("Sudah digolongkan 1");
    const tabel = main.getByRole("table", { name: "Tak bertuan" });
    await expect(tabel).toContainText("web");
    await tabel.getByRole("checkbox", { name: /Pilih i1|Pilih unowned/ }).or(tabel.locator("tbody input[type=checkbox]").first()).first().check();
    await main.getByRole("button", { name: "Golongkan…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("button", { name: "Golongkan" })).toBeDisabled();
    await dlg.getByLabel("Beban").selectOption("principal");
    await dlg.getByLabel(/Aturan promo dasar/).selectOption("BP2610009096");
    await page.screenshot({ path: "test-results/fiori-normalisasi-dialog.png" });
    await dlg.getByRole("button", { name: "Golongkan sebagai Klaim principal" }).click();
    await expect(dlg).toBeHidden();
    expect(kirim[0]).toMatchObject({ m: "POST", b: { bucket: "principal", rows: [{ promoRuleId: 405, lineKey: "l1" }] } });
    await expect(main.getByRole("status").filter({ hasText: "digolongkan sebagai Klaim principal" })).toBeVisible();
    await segs.getByRole("button", { name: /Sudah digolongkan/ }).click();
    await main.getByRole("table", { name: "Sudah digolongkan" }).locator("tbody input[type=checkbox]").first().check();
    await main.getByRole("button", { name: /Batalkan 1 penggolongan/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Batalkan penggolongan" }).click();
    expect(kirim[1]).toMatchObject({ m: "DELETE", b: { keys: [{ lineKey: "l3", positions: "1" }] } });
});

test("Aturan: status tersaring, detail + artinya, BL-52, Hapus dan Impor lewat dialog (principal wajib, pratinjau dulu)", async ({ page }) => {
    const hapus: string[] = []; const impor: string[] = [];
    await page.route(path("/api/promo-rule"), (r) => {
        if (r.request().method() === "DELETE") { hapus.push(r.request().url()); return r.fulfill(json({ ok: true, deleted: 1 })); }
        return r.fulfill(json({ ok: true, rules: RULES, principals: ["KINO NON FOOD"], total: 3, truncated: 0 }));
    });
    await page.route(path("/api/promo-recap"), async (r) => {
        const body = r.request().postDataBuffer()?.toString("latin1") ?? "";
        impor.push(body);
        return r.fulfill(json({ ok: true, rows: 22, programs: 4, tingkatFaktur: 0, tarifOutlet: 0, outlet: 0, issues: [] }));
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/aturan-promo", NAV);
    const main = page.locator("main");
    const daftar = main.getByRole("list", { name: "Daftar aturan" });
    await expect(daftar.getByRole("button")).toHaveCount(2, NAV); // nonaktif #420 tersembunyi di saringan bawaan
    await main.getByLabel("Status").selectOption("semua");
    await expect(daftar.getByRole("button", { name: /#420/ })).toContainText("Nonaktif");
    await daftar.getByRole("button", { name: /#412/ }).click();
    const detail = main.getByRole("region", { name: "Detail aturan" });
    await expect(detail.getByRole("heading", { name: "Aturan #412" })).toBeVisible();
    await expect(detail).toContainText("peserta LOYALTY");
    await expect(detail).toContainText("klaim principal");
    await detail.getByLabel("Minimal belanja").fill("24");
    await expect(detail.getByText("Mengubah aturan asal surat menjadikannya aturan manual.")).toBeVisible();
    await expect(detail.getByText("usulan BL-52")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-aturan-promo.png", fullPage: true });
    await detail.getByRole("button", { name: "Batal" }).click();
    await detail.getByRole("button", { name: "Hapus…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Hapus aturan" }).click();
    expect(hapus[0]).toContain("ids=412");

    await main.getByRole("button", { name: "Impor Excel…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("button", { name: "Pratinjau" })).toBeDisabled();
    await dlg.getByLabel("Principal").fill("godrej");
    await dlg.getByLabel("Berkas Excel").setInputFiles({ name: "aturan.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });
    await dlg.getByRole("button", { name: "Pratinjau" }).click();
    await expect(dlg).toContainText("22 baris · 4 program");
    await dlg.getByRole("button", { name: "Muat aturan" }).click();
    await expect(dlg).toBeHidden();
    expect(impor[0]).toContain("GODREJ"); expect(impor[0]).toMatch(/name="apply"\r\n\r\nfalse/);
    expect(impor[1]).toMatch(/name="apply"\r\n\r\ntrue/);
});

test("Daftar outlet: tali daftar terlihat; keluarkan anggota lewat dialog", async ({ page }) => {
    let dihapus = "";
    await page.route(path("/api/promo-rule"), (r) => r.fulfill(json({ ok: true, rules: RULES, principals: [], total: 3 })));
    await page.route(path("/api/promo-outlet"), (r) => {
        if (r.request().method() === "DELETE") { dihapus = r.request().url(); return r.fulfill(json({ ok: true, deleted: 1 })); }
        return r.fulfill(json({ ok: true, distCode: "1201671", programs: [], lists: [{ name: "LOYALTY", members: 1, tiers: {}, linked: [{ suratProgram: "BP2610009097", mode: "INCLUDE", rules: 3 }] }, { name: "MSG", members: 0, tiers: {}, linked: [] }],
            members: [{ id: 7, listName: "LOYALTY", customerCode: "C-WIN013", customerName: "TK WINDA", tier: "", sourceCode: "22160031402", periodStart: "2026-10-01", periodEnd: "2026-12-31", active: true, note: "", importedBy: "x" }] }));
    });
    await page.goto("/aturan-promo", NAV);
    const main = page.locator("main");
    await main.getByRole("group", { name: "Bagian" }).getByRole("button", { name: "Daftar outlet peserta" }).click(NAV);
    const chips = main.getByRole("list", { name: "Daftar dan tali ke aturan" });
    await expect(chips).toContainText("BP2610009097 (hanya)");
    await expect(chips).toContainText("belum dipakai aturan");
    await main.getByRole("table", { name: "Anggota daftar" }).getByRole("button", { name: "Keluarkan C-WIN013" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Keluarkan" }).click();
    expect(dihapus).toContain("ids=7");
});

test("Summary: buka draf, siklus, Terbitkan butuh centang; gerbang faktur menunggu bukti dan pernyataan", async ({ page }) => {
    const publish: unknown[] = [];
    const draft = { id: "6ea38247aa", revision: 3, status: "draft", title: "Summary KINO NON FOOD Oktober", content: { rows: [{ id: "r1", no: "1", principle: "KINO NON FOOD", surat_program: "BP2610009096", nama_program: "Sleek", kelompok: "SLEEK BABY", variant: "", gramasi: "", kemasan: "", ketentuan: "12", benefit_type: "DISC_PCT", benefit: "3", periode_start: "2026-10-01", periode_end: "2026-10-31" }], extraction: { warnings: ["angka 3% terbaca dari halaman 2 yang buram"] }, period: ["2026-10-01", "2026-10-31"] } };
    const rules = [{ id: "p1", name: "SLEEK BABY", channel: "GT", start: "2026-10-01", end: "2026-10-31", unit: "PCS", codes: ["SBB200"], mix: false, stacking: false, threshold: "qty", tiers: [{ minimum: "12", percentages: ["3"], rupiah: "0" }] }];
    await page.route((u) => u.host === "localhost:8000", (r) => {
        const p = new URL(r.request().url()).pathname;
        if (p === "/api/principles") return fastapi(r, { ok: true, principles: { k1: { name: "KINO NON FOOD", filename: "kino.xlsx" } } });
        if (p === "/api/me") return fastapi(r, { csrf_token: "t" });
        if (p === "/summary/library") return fastapi(r, { ok: true, drafts: [{ id: draft.id, title: draft.title, status: "draft", revision: 3, updated_at: "2026-10-05T08:02:00Z" }] });
        if (p === `/summary/library/${draft.id}`) return fastapi(r, { ok: true, draft, programs: rules, issues: [] });
        if (p === `/summary/library/${draft.id}/publish`) { if (r.request().method() === "POST") publish.push(r.request().postDataJSON()); return fastapi(r, { ok: true, draft: { ...draft, status: "published", revision: 4 }, programs: rules, issues: [] }); }
        return fastapi(r, { ok: true });
    });
    await page.route(path("/api/promo-rule/from-summary"), (r) => new URL(r.request().url()).searchParams.get("simulate")
        ? r.fulfill(json({ ok: true, simulasi: { ok: true, suratProgram: "BP2610009096", ruleCount: 22, groups: [], refused: [], notes: [], warnings: [], trial: { lines: 612, explained: 609, noDiscount: 0, unexplained: [] } }, persetujuan: { dicentang: false, dicentangOleh: "", dicentangPada: null, catatan: "", buktiNama: "", buktiUkuran: 0, buktiOleh: "", buktiPada: null } }))
        : r.fulfill(json({ ok: true, published: [{ draft_id: "lain1", title: "Godrej Okt", published_at: "2026-10-02", surat_program: "GDI/10", principal: "GODREJ", nama_program: "Hit", kelompok: "", period: { start: "2026-10-01", end: "2026-10-31" }, programs: 3, codes: ["A"], sudahDimuat: false }] })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/summary", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Belum ada draf Summary")).toBeVisible(NAV);
    await main.getByLabel("Buka draf tersimpan").selectOption(draft.id);
    await expect(main.getByRole("heading", { level: 1, name: draft.title })).toBeVisible();
    await expect(main.getByRole("list", { name: "Siklus Summary" }).locator('[aria-current="step"]')).toContainText("Terbit");
    await expect(main.getByText("1 catatan pembacaan:")).toBeVisible();
    await expect(main.getByRole("table", { name: "Aturan tersusun" })).toContainText("diskon 3%");
    await expect(main.getByText("usulan BL-51")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-summary.png", fullPage: true });
    await main.locator(".fi-ftb").getByRole("button", { name: "Terbitkan…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("button", { name: "Terbitkan" })).toBeDisabled();
    await dlg.getByLabel("Saya sudah membandingkan draf dengan PDF sumber").check();
    await dlg.getByRole("button", { name: "Terbitkan" }).click();
    await expect(dlg).toBeHidden();
    expect(publish[0]).toMatchObject({ reviewed: true, revision: 3 });
    await expect(main.getByRole("status").filter({ hasText: "terbit" }).first()).toContainText("dipakai mesin order");
    await expect(main.locator(".fi-ftb").getByRole("button", { name: "Cabut publikasi…" })).toBeVisible();

    const gerbang = main.getByRole("region", { name: "Langkah berikutnya: masuk gerbang faktur" });
    await gerbang.getByRole("table", { name: "Publikasi Summary" }).getByRole("button", { name: "Simulasikan" }).click();
    await expect(gerbang).toContainText("Diuji atas faktur nyata");
    const muat = gerbang.getByRole("button", { name: "Muat ke gerbang faktur…" });
    await expect(muat).toBeDisabled();
    await expect(muat).toHaveAttribute("title", "Lengkapi bukti tanda tangan dan pernyataan");
    await expect(gerbang.getByText("usulan BL-53")).toBeVisible();
});

test("Gerbang faktur: bukti + pernyataan lengkap → Muat lewat dialog; pesan hasil dan daftar ditolak tetap tampil, status jadi dimuat", async ({ page }) => {
    let dimuat = false; const muat: unknown[] = [];
    const entri = { draft_id: "lain1", title: "Godrej Okt", published_at: "2026-10-02", surat_program: "GDI/10", principal: "GODREJ", nama_program: "Hit", kelompok: "", period: { start: "2026-10-01", end: "2026-10-31" }, programs: 3, codes: ["A"] };
    await page.route((u) => u.host === "localhost:8000", (r) => fastapi(r, { ok: true, principles: {}, drafts: [] }));
    await page.route(path("/api/promo-rule/from-summary"), (r) => {
        if (r.request().method() === "POST") { muat.push(r.request().postDataJSON()); dimuat = true; return r.fulfill(json({ ok: true, aturan: 3, suratProgram: "GDI/10", outlet: 0, ditolak: ["Program rafaksi tidak bisa dinyatakan utuh"], catatan: [] })); }
        if (new URL(r.request().url()).searchParams.get("simulate")) return r.fulfill(json({ ok: true, simulasi: { ok: true, suratProgram: "GDI/10", ruleCount: 3, groups: [], refused: ["Program rafaksi tidak bisa dinyatakan utuh"], notes: ["Satuan KRT dibaca dari master"], warnings: [], trial: { lines: 10, explained: 10, noDiscount: 0, unexplained: [] } },
            persetujuan: { dicentang: true, dicentangOleh: "Maya", dicentangPada: "2026-10-06T02:00:00Z", catatan: "", buktiNama: "ttd.pdf", buktiUkuran: 20480, buktiOleh: "Maya", buktiPada: "2026-10-06T02:00:00Z" } }));
        return r.fulfill(json({ ok: true, published: [{ ...entri, sudahDimuat: dimuat }] }));
    });
    await page.goto("/summary", NAV);
    const gerbang = page.locator("main").getByRole("region", { name: "Langkah berikutnya: masuk gerbang faktur" });
    await gerbang.getByRole("table", { name: "Publikasi Summary" }).getByRole("button", { name: "Simulasikan" }).click(NAV);
    await expect(gerbang.getByText("Satuan KRT dibaca dari master")).toBeVisible();
    await gerbang.getByRole("button", { name: "Muat ke gerbang faktur…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Muat aturan" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(muat[0]).toEqual({ draftId: "lain1" });
    await expect(gerbang.getByText("3 aturan surat GDI/10 dimuat ke gerbang faktur.")).toBeVisible();
    await expect(gerbang.getByText("Program rafaksi tidak bisa dinyatakan utuh").first()).toBeVisible();
    await expect(gerbang.getByRole("button", { name: "Muat ulang ke gerbang faktur…" })).toBeVisible();
    await gerbang.getByRole("button", { name: "Muat ulang ke gerbang faktur…" }).click();
    await expect(page.getByRole("dialog")).toContainText("Surat ini sudah pernah dimuat.");
});

test("ponsel: empat layar Promo tanpa gulir menyamping", async ({ page }) => {
    await page.route(path("/api/promo-recap"), (r) => r.fulfill(json(RECAP)));
    await page.route(path("/api/promo-rule"), (r) => r.fulfill(json({ ok: true, rules: RULES, principals: [], total: 3 })));
    await page.route(path("/api/promo-rule/from-summary"), (r) => r.fulfill(json({ ok: true, published: [] })));
    await page.route((u) => u.host === "localhost:8000", (r) => fastapi(r, { ok: true, principles: {}, drafts: [] }));
    await page.setViewportSize({ width: 390, height: 844 });
    for (const p of ["/rekap-promo", "/normalisasi-diskon", "/aturan-promo", "/summary"]) {
        await page.goto(p, NAV);
        await expect(page.locator("main h1")).toBeVisible(NAV);
        await noOverflow(page);
        await page.screenshot({ path: `test-results/fiori-s4a${p.replace(/\//g, "-")}-ponsel.png`, fullPage: true });
    }
});
