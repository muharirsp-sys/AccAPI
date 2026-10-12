/*
 * Tujuan: Fiori S3 — Laporan Harian (wizard + riwayat + dialog Kirim), Penerima laporan (draf, Nonaktifkan via dialog, galat keyword kembar),
 *   Rekonsiliasi (wizard, galat mapping/riwayat bukan kosong, dialog Aktifkan mapping, saring hasil), History penjualan (kosong, galat di halaman, dialog Impor).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true): `npx playwright test tests/fiori-laporan-rekonsiliasi.spec.ts`.
 * Dependensi: endpoint di-mock dengan page.route (tidak menyentuh DB/FastAPI/SMTP).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const path = (p: string) => (url: URL) => url.pathname === p;
const NAV = { timeout: 60_000 } as const;
const xlsx = (name: string) => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });

const RUNS = [
    { id: "r1", reportDate: "2026-10-05", status: "failed", fileCount: 14, emailCount: 22, note: "email_mode:daily", createdAt: "2026-10-05T23:45:00Z", uploadedBy: "Nurul", penerima: { sent: 21, failed: 1 } },
    { id: "r2", reportDate: "2026-10-01", status: "sending", fileCount: 12, emailCount: 22, note: "email_mode:daily", createdAt: "2026-10-01T23:55:00Z", uploadedBy: "Nurul", penerima: { sent: 9, pending: 13 } },
    { id: "r3", reportDate: "2026-10-03", status: "sent", fileCount: 14, emailCount: 22, note: "email_mode:daily", createdAt: "2026-10-03T23:50:00Z", uploadedBy: "Nurul", penerima: { sent: 22 } },
];
const UPLOAD = {
    ok: true, runId: "r9", reportDate: "2026-10-06", period: { month: 10, year: 2026 }, dashboardFed: { inserted: 1106 },
    incentiveFeed: { progressKeys: 40, targetKeys: 40, matchedKeys: 40, unmatchedKeys: 0, ready: true }, salesRows: 4812, netDpp: 1_920_000_000,
    summary: [{ spv: "SPV ANI", rows: 1200, dpp: 500_000_000, ao: 80, ec: 60, ia: 120 }],
    recipientsPreview: [{ keyword: "SPV ANI", groupType: "spv", fileName: "SPV_ANI_06-10.xlsx", emails: ["spv.ani@contoh.id"] }, { keyword: "SM HENDRIK", groupType: "sm", fileName: "SM_HENDRIK_06-10.xlsx", emails: ["hendrik@contoh.id", "om@contoh.id"] }],
    totalRecipients: 3, generatedFiles: [{ keyword: "SPV ANI", groupType: "spv", fileName: "SPV_ANI_06-10.xlsx", rows: 1200, stockRows: 0 }],
    unmatchedReportKeywords: ["SPV BARU"], manager: { fileName: "2026-10-06_Laporan_Pak_Fahdhar.xlsx", previewFileName: "2026-10-06_Laporan_Pak_Fahdhar.html", rows: 26, missingTargets: false },
};
const RCP = { recipients: [
    { keyword: "SPV ANI", emails: "spv.ani@contoh.id", active: true }, { keyword: "SM HENDRIK", emails: "hendrik@contoh.id, om@contoh.id", active: true }, { keyword: "SPV RUDI", emails: "spv.rudi@contoh.id", active: false },
] };
const MAPPING = { active: { id: "m4", version: 4, originalName: "KINO_mapping_SKU_v4.xlsx", uploadedByName: "Dewi", createdAt: "2026-09-28T02:00:00Z", isActive: true }, versions: [{ id: "m4", version: 4, originalName: "KINO_mapping_SKU_v4.xlsx", uploadedByName: "Dewi", createdAt: "2026-09-28T02:00:00Z", isActive: true }, { id: "m3", version: 3, originalName: "KINO_mapping_SKU_v3.xlsx", uploadedByName: "Ari", createdAt: "2026-08-14T02:00:00Z" }], canManage: true };
const HIST = { items: [{ id: "run-1", mappingVersionId: "m4", status: "success", uploadedByName: "Dewi", inputFiles: [{ role: "accurateFile", name: "Faktur_1-5Okt.xlsx" }, { role: "principalFile", name: "SalesDetail_KINO.xlsx" }], summary: { MATCH: 1204, QTY_MISMATCH: 17, MISSING_PRINCIPAL: 5 }, issues: null, error: null, durationMs: 1450, startedAt: "2026-10-06T02:24:00Z" }], page: 1, pageSize: 20 };
const RESULT = { accurateLines: [], kinoLines: [], summary: { MATCH: 1, VALUE_MISMATCH: 1, MISSING_PRINCIPAL: 1 }, results: [
    { orderNumber: "INV/2610/KN01388", internalProductCode: "SBB200", transactionClass: "NORMAL", accurateQuantity: 24, principalQuantity: 24, quantityDifference: 0, accurateNet: 424512, principalNet: 418032, valueDifference: 6480, amountDifferences: [{ component: "net", accurate: 424512, kino: 418032, difference: 6480 }], status: "VALUE_MISMATCH", warnings: [], accurateSourceRows: [3], principalSourceRows: [7] },
    { orderNumber: "INV/2610/KN01412", internalProductCode: "BNB250", transactionClass: "NORMAL", accurateQuantity: 12, principalQuantity: 0, quantityDifference: 12, accurateNet: 310200, principalNet: 0, valueDifference: 310200, amountDifferences: [], status: "MISSING_PRINCIPAL", warnings: [], accurateSourceRows: [9], principalSourceRows: [] },
    { orderNumber: "INV/2610/KN01387", internalProductCode: "SBB100", transactionClass: "NORMAL", accurateQuantity: 48, principalQuantity: 48, quantityDifference: 0, accurateNet: 518400, principalNet: 518400, valueDifference: 0, amountDifferences: [], status: "MATCH", warnings: [], accurateSourceRows: [4], principalSourceRows: [8] },
] };
const ITEMS = { ok: true, total: 2, totalApproximate: false, searchBackend: "sqlite", items: [
    { id: 1, referensi: "INV/2610/KN01388", tanggal: "2026-10-06", principal: "KINO", kodeCust: "C-MKS0418", customerNama: "TK SINAR JAYA", kodeObjek: "SBB200", namaProduk: "SLEEK BABY BATH 200 ML", qty: 24, satuan: "PCS", hargaSatuan: 17688, hargaTotal: 424512, diskonRp: 21225, keterangan: "" },
    { id: 2, referensi: "INV/2609/KN01301", tanggal: "2026-09-28", principal: "KINO", kodeCust: "C-MKS0418", customerNama: "TK SINAR JAYA", kodeObjek: "SBB100", namaProduk: "SLEEK BABY BATH 100 ML", qty: 48, satuan: "PCS", hargaSatuan: 10800, hargaTotal: 518400, diskonRp: 0, keterangan: "" },
] };

async function noOverflow(page: Page, label = "") {
    const ukuran = await page.evaluate(() => { const m = document.querySelector("main"); const lebar = [...document.querySelectorAll("main *")].filter((el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1 || el.scrollWidth > el.clientWidth + 1; }).slice(0, 8).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}:${Math.round(el.getBoundingClientRect().left)}..${Math.round(el.getBoundingClientRect().right)}/${el.scrollWidth}`); return { doc: document.documentElement.scrollWidth, win: innerWidth, main: m?.scrollWidth, client: m?.clientWidth, lebar }; });
    expect(ukuran.doc <= ukuran.win && (!ukuran.main || ukuran.main <= (ukuran.client ?? 0) + 1), `${label} ${JSON.stringify(ukuran)}`).toBe(true);
}
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test.describe("Laporan harian", () => {
    test("riwayat: gagal → Kirim ulang… dialog; macet berlabel; proses → wizard → dialog Kirim mengirim body yang benar", async ({ page }) => {
        const dikirim: unknown[] = [];
        await page.route(path("/api/laporan-harian/runs"), (r) => r.fulfill(json({ runs: RUNS })));
        await page.route(path("/api/laporan-harian/upload"), (r) => r.fulfill(json(UPLOAD)));
        await page.route((u) => /\/api\/laporan-harian\/[^/]+\/send$/.test(u.pathname), (r) => { dikirim.push({ url: r.request().url(), body: r.request().postDataJSON() }); return r.fulfill(json({ ok: true, status: "sent", emailsSent: 3, emailsFailed: 0, emailsSkipped: 0 })); });
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto("/laporan-harian", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("heading", { level: 1, name: "Laporan harian" })).toBeVisible(NAV);
        const riwayat = main.getByRole("table", { name: "Riwayat kirim" });
        await expect(riwayat.getByRole("row", { name: /05\/10\/2026/ })).toContainText("Gagal");
        await expect(riwayat.getByRole("row", { name: /01\/10\/2026/ })).toContainText("Macet");
        await expect(main.getByText("usulan BL-29")).toBeVisible();
        const footer = main.locator(".fi-ftb");
        await expect(footer.getByRole("button", { name: "Proses dan perbarui dashboard" })).toBeDisabled();
        await page.screenshot({ path: "test-results/fiori-laporan-harian-awal.png", fullPage: true });

        // Kirim ulang run gagal → dialog, bukan langsung.
        await riwayat.getByRole("row", { name: /05\/10\/2026/ }).getByRole("button", { name: "Kirim ulang…" }).click();
        await expect(page.getByRole("dialog")).toContainText("Kirim ulang 1 email yang gagal?");
        await page.getByRole("dialog").getByRole("button", { name: "Kirim ulang 1 email" }).click();
        await expect(page.getByRole("dialog")).toBeHidden();
        expect(dikirim[0]).toMatchObject({ body: { confirm: true, isClosing: false, recipientMode: "all" } });
        expect(String((dikirim[0] as { url: string }).url)).toContain("/api/laporan-harian/r1/send");

        // Proses → langkah 2–3 → footer Kirim → dialog menyebut penerima yang tidak dikirim.
        await main.locator("#laporan-penjualan").setInputFiles(xlsx("Penjualan 06-10.xlsx"));
        await footer.getByRole("button", { name: "Proses dan perbarui dashboard" }).click();
        await expect(main.getByRole("heading", { level: 1 })).toContainText("data Selasa, 6 Okt 2026", NAV);
        await expect(main.getByText("Pencapaian tersambung ke Insentif Sales.")).toBeVisible();
        await expect(main.getByText("Berkas SPV BARU tidak punya penerima.")).toBeVisible();
        await expect(main.getByRole("link", { name: "Laporan manajer", exact: true })).toBeVisible();
        await main.getByRole("group", { name: "Penerima" }).getByRole("button", { name: "Pilih tertentu" }).click();
        await main.getByRole("table", { name: "Penerima email" }).getByLabel("Pilih SM_HENDRIK_06-10.xlsx\u0000om@contoh.id").uncheck();
        await expect(main.getByText("1 penerima yang tidak dipilih akan berstatus dilewati")).toBeVisible();
        await expect(main.getByText("usulan BL-58")).toBeVisible();
        await footer.getByRole("button", { name: "4 · Kirim 2 email…" }).click();
        const dlg = page.getByRole("dialog");
        await expect(dlg).toContainText("Kirim 2 email laporan 06/10/2026?");
        await expect(dlg).toContainText("SPV BARU tidak dikirim");
        await page.screenshot({ path: "test-results/fiori-laporan-harian-kirim.png" });
        await dlg.getByRole("button", { name: "Kirim 2 email" }).click();
        await expect(main.getByRole("status").filter({ hasText: "3 email terkirim." })).toBeVisible();
        expect(dikirim[1]).toMatchObject({ body: { confirm: true, recipientMode: "selected", selectedRecipients: [{ fileName: "SPV_ANI_06-10.xlsx", email: "spv.ani@contoh.id" }, { fileName: "SM_HENDRIK_06-10.xlsx", email: "hendrik@contoh.id" }] } });
        await expect(footer.getByRole("button", { name: /Kirim/ })).toHaveCount(0); // sudah terkirim: tidak ada aksi kirim lagi
        await expect(footer.getByRole("button", { name: "Proses ulang berkas baru" })).toBeVisible(); // run baru tetap bisa
    });

    test("galat pengolahan tampil di halaman; riwayat tetap", async ({ page }) => {
        await page.route(path("/api/laporan-harian/runs"), (r) => r.fulfill(json({ runs: RUNS })));
        await page.route(path("/api/laporan-harian/upload"), (r) => r.fulfill(json({ error: "Tidak bisa menghubungi FastAPI backend", detail: "timeout 300 s" }, 502)));
        await page.goto("/laporan-harian", NAV);
        const main = page.locator("main");
        await main.locator("#laporan-penjualan").setInputFiles(xlsx("Penjualan.xlsx"));
        await main.locator(".fi-ftb").getByRole("button", { name: "Proses dan perbarui dashboard" }).click();
        await expect(main.getByRole("alert")).toContainText("Tidak bisa menghubungi FastAPI backend");
        await expect(main.getByRole("alert")).toContainText("Dashboard dan progres insentif tidak berubah");
        await expect(main.getByRole("table", { name: "Riwayat kirim" }).getByRole("row")).toHaveCount(4);
    });
});

test.describe("Penerima laporan", () => {
    test("draf → Simpan; Nonaktifkan lewat dialog; keyword kembar ditolak server dan tampil di halaman", async ({ page }) => {
        let putBody: unknown = null; let gagal = true;
        await page.route(path("/api/laporan-harian/mapping"), (r) => {
            if (r.request().method() === "PUT") { putBody = r.request().postDataJSON(); return gagal ? r.fulfill(json({ error: "Keyword penerima tidak boleh duplikat" }, 400)) : r.fulfill(json({ ok: true, recipients: 4 })); }
            return r.fulfill(json(RCP));
        });
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto("/laporan-harian/mapping", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("heading", { level: 1, name: "Penerima laporan" })).toBeVisible(NAV);
        const tabel = main.getByRole("table", { name: "Penerima" });
        await expect(tabel.getByRole("row")).toHaveCount(3); // header + 2 aktif
        await expect(main.locator(".fi-ftb").getByRole("button", { name: "Simpan perubahan" })).toBeDisabled();
        await main.getByRole("button", { name: "Tambah penerima" }).click();
        await tabel.getByLabel("Keyword baru").fill("spv ani");
        await tabel.getByLabel("Email baru").fill("kembar@contoh.id");
        await expect(main.locator(".fi-ftb")).toContainText("1 baris diubah");
        await tabel.getByRole("row", { name: /SM HENDRIK/ }).getByRole("button", { name: "Nonaktifkan…" }).click();
        await expect(page.getByRole("dialog")).toContainText("Nonaktifkan penerima SM HENDRIK?");
        await page.getByRole("dialog").getByRole("button", { name: "Nonaktifkan" }).click();
        await expect(tabel.getByRole("row")).toHaveCount(3); // SM HENDRIK pindah ke tab Nonaktif
        await main.getByRole("group", { name: "Status" }).getByRole("button", { name: /Nonaktif/ }).click();
        await expect(main.getByRole("table", { name: "Penerima" }).getByLabel("Keyword SM HENDRIK")).toHaveValue("SM HENDRIK"); // keyword ada di input
        await main.locator(".fi-ftb").getByRole("button", { name: "Simpan perubahan" }).click();
        await expect(main.getByRole("alert")).toContainText("Keyword penerima tidak boleh duplikat");
        expect(putBody).toMatchObject({ recipients: [{ keyword: "SPV ANI" }, { keyword: "SM HENDRIK", active: false }, { keyword: "SPV RUDI" }, { keyword: "SPV ANI", emails: "kembar@contoh.id" }] });
        await page.screenshot({ path: "test-results/fiori-penerima-galat.png", fullPage: true });
        gagal = false;
        await main.getByRole("group", { name: "Status" }).getByRole("button", { name: /Aktif/ }).first().click();
        await main.getByRole("table", { name: "Penerima" }).getByLabel("Keyword baru").fill("SPV BARU");
        await main.locator(".fi-ftb").getByRole("button", { name: "Simpan perubahan" }).click();
        await expect(main.getByRole("status").filter({ hasText: "1 penerima ditambah. 1 dinonaktifkan." })).toBeVisible();
    });

    test("kosong: keadaan kosong dengan ajakan tambah", async ({ page }) => {
        await page.route(path("/api/laporan-harian/mapping"), (r) => r.fulfill(json({ recipients: [] })));
        await page.goto("/laporan-harian/mapping", NAV);
        await expect(page.locator("main").getByRole("status").filter({ hasText: "Belum ada penerima aktif" })).toBeVisible(NAV);
    });
});

test.describe("Rekonsiliasi", () => {
    test("default: mapping + riwayat; jalankan → hasil tersaring masalah; Aktifkan mapping lewat dialog", async ({ page }) => {
        let aktifkanForm: string[] = [];
        await page.route(path("/api/reconciliation/mappings"), (r) => { if (r.request().method() === "POST") { aktifkanForm = (r.request().postData() ?? "").match(/name="(\w+)"/g) ?? []; return r.fulfill(json({ id: "m5", version: 5, originalName: "KINO_mapping_SKU_v5.xlsx", uploadedByName: "Dewi", createdAt: new Date().toISOString(), isActive: true }, 201)); } return r.fulfill(json(MAPPING)); });
        await page.route(path("/api/reconciliation/history"), (r) => r.fulfill(json(HIST)));
        await page.route(path("/api/reconciliation/kino/sales"), (r) => r.fulfill(json(RESULT)));
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto("/reconciliation", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("heading", { level: 1, name: "Rekonsiliasi Faktur KINO" })).toBeVisible(NAV);
        await expect(main.getByLabel("Stempel versi mapping")).toContainText("Versi 4");
        const riwayat = main.getByRole("region", { name: "Riwayat rekonsiliasi" });
        await expect(riwayat).toContainText("Berhasil");
        await expect(riwayat).toContainText("Total 1226");
        await expect(riwayat).toContainText("Masalah 22");
        const footer = main.locator(".fi-ftb");
        await expect(footer.getByRole("button", { name: "Jalankan rekonsiliasi" })).toBeDisabled();
        await expect(footer).toContainText("Pilih 2 berkas lagi");
        await main.getByLabel("Rincian Faktur Penjualan (Accurate)").setInputFiles(xlsx("Faktur_1-5Okt.xlsx"));
        await main.getByLabel("Sales Detail KINO").setInputFiles(xlsx("SalesDetail_KINO.xlsx"));
        await footer.getByRole("button", { name: "Jalankan rekonsiliasi" }).click();
        const hasil = main.getByRole("table", { name: "Hasil rekonsiliasi" });
        await expect(hasil.getByRole("row")).toHaveCount(3); // 2 masalah (saringan bawaan)
        await expect(hasil).toContainText("Data KINO tidak ditemukan");
        await expect(hasil).not.toContainText("KN01387");
        await expect(main.getByLabel("Filter status")).toHaveValue("ISSUES_ONLY");
        await main.getByRole("group", { name: "Saring hasil" }).getByRole("button", { name: /^Semua/ }).click();
        await expect(hasil.getByRole("row")).toHaveCount(4);
        await page.screenshot({ path: "test-results/fiori-rekonsiliasi-hasil.png", fullPage: true });

        await main.getByLabel("Ganti mapping").setInputFiles(xlsx("KINO_mapping_SKU_v5.xlsx"));
        await main.getByRole("button", { name: "Aktifkan v5…" }).click();
        const dlg = page.getByRole("dialog");
        await expect(dlg).toContainText("Berlaku untuk semua pengguna");
        await expect(dlg).toContainText("v4 · KINO_mapping_SKU_v4.xlsx");
        await dlg.getByRole("button", { name: "Aktifkan mapping" }).click();
        await expect(main.getByRole("status").filter({ hasText: "Mapping v5 aktif" })).toBeVisible();
        expect(aktifkanForm.join(" ")).toContain("mappingFile");
    });

    test("galat: mapping dan riwayat 500 → galat eksplisit, bukan kosong; jalankan terkunci; ganti jenis mengganti principal", async ({ page }) => {
        await page.route(path("/api/reconciliation/mappings"), (r) => r.fulfill(json({ error: "boom" }, 500)));
        await page.route(path("/api/reconciliation/history"), (r) => r.fulfill(json({ error: "boom" }, 500)));
        await page.goto("/reconciliation", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("alert").filter({ hasText: "Mapping Faktur KINO gagal dimuat" })).toBeVisible(NAV);
        await expect(main.getByRole("alert").filter({ hasText: "Riwayat belum termuat" })).toBeVisible();
        await expect(main.getByText("Belum pernah dijalankan")).toHaveCount(0);
        await main.getByRole("group", { name: "Jenis Rekonsiliasi" }).getByRole("button", { name: "Pembelian" }).click();
        await expect(main.getByLabel("Prinsipal")).toHaveValue("GODREJ");
        await expect(main.getByText("Belum ada file dipilih")).toHaveCount(2);
    });
});

test.describe("History penjualan", () => {
    test("kosong sebelum produk diketik; cari → tabel; galat di halaman; Impor lewat dialog", async ({ page }) => {
        let gagal = false; let imporHeader = "";
        await page.route(path("/api/sales-history/years"), (r) => r.fulfill(json({ ok: true, years: [{ year: 2026, invoices: 4000 }] })));
        await page.route(path("/api/sales-history/principals"), (r) => r.fulfill(json({ ok: true, principals: [{ principal: "KINO", invoices: 1200 }] })));
        await page.route(path("/api/sales-history/customers"), (r) => r.fulfill(json({ ok: true, customers: [{ kode: "C-MKS0418", nama: "TK SINAR JAYA", invoices: 40 }] })));
        await page.route(path("/api/sales-history/item-search"), (r) => gagal ? r.fulfill(json({ ok: false, error: "Gagal memuat item." }, 500)) : r.fulfill(json(ITEMS)));
        await page.route(path("/api/sales-history/import"), (r) => { imporHeader = r.request().headers()["x-filename"] ?? ""; return r.fulfill(json({ ok: true, sourceFile: "efaktur_sep_2026.csv", imported: 17940 })); });
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto("/sales-history", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("status").filter({ hasText: "Ketik nama produk untuk menampilkan item" })).toBeVisible(NAV);
        await main.getByLabel("Produk").first().fill("sleek");
        const tabel = main.getByRole("table", { name: "History item" });
        await expect(tabel.getByRole("row")).toHaveCount(3);
        await expect(tabel).toContainText("SLEEK BABY BATH 200 ML");
        await expect(tabel).toContainText("5,0%");
        await page.screenshot({ path: "test-results/fiori-history-default.png", fullPage: true });
        gagal = true;
        await main.getByLabel("Produk").first().fill("sleek baby");
        await expect(main.getByRole("alert").filter({ hasText: "Gagal memuat item." })).toBeVisible();
        await expect(main.getByLabel("Produk").first()).toHaveValue("sleek baby"); // saringan tidak berubah
        gagal = false;
        await main.getByRole("button", { name: "Impor CSV e-Faktur…" }).click();
        const dlg = page.getByRole("dialog");
        await expect(dlg.getByRole("button", { name: "Impor" })).toBeDisabled();
        await dlg.getByLabel(/Berkas CSV/).setInputFiles({ name: "efaktur_sep_2026.csv", mimeType: "text/csv", buffer: Buffer.from("FK;1") });
        await expect(dlg).toContainText("Impor efaktur_sep_2026.csv?");
        await expect(dlg).toContainText("usulan BL-60");
        await dlg.getByRole("button", { name: "Impor" }).click();
        await expect(main.getByRole("status").filter({ hasText: "17.940 item diimpor" })).toBeVisible();
        expect(imporHeader).toBe("efaktur_sep_2026.csv");
    });

    test("ponsel: tanpa gulir menyamping di keempat layar", async ({ page }) => {
        await page.route(path("/api/laporan-harian/runs"), (r) => r.fulfill(json({ runs: RUNS })));
        await page.route(path("/api/laporan-harian/mapping"), (r) => r.fulfill(json(RCP)));
        await page.route(path("/api/reconciliation/mappings"), (r) => r.fulfill(json(MAPPING)));
        await page.route(path("/api/reconciliation/history"), (r) => r.fulfill(json(HIST)));
        await page.route((u) => u.pathname.startsWith("/api/sales-history/"), (r) => r.fulfill(json({ ok: true, years: [], principals: [], customers: [] })));
        await page.setViewportSize({ width: 390, height: 844 });
        for (const p of ["/laporan-harian", "/laporan-harian/mapping", "/reconciliation", "/sales-history"]) {
            await page.goto(p, NAV);
            await expect(page.locator("main h1")).toBeVisible(NAV);
            await noOverflow(page, p);
            await page.screenshot({ path: `test-results/fiori-s3${p.replace(/\//g, "-")}-ponsel.png`, fullPage: true });
        }
    });
});
