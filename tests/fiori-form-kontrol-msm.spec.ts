/*
 * Tujuan: FK-MSM (pilot Form Kontrol cabang, 12 Okt 2026) — layar yang berubah: principal dari JKS (my-scope `principles`: satu = langsung
 *   terpilih tanpa pilihan, beberapa = "Pilih principal" tanpa permintaan, tanpa JKS = penjelasan), Kontrol JKS SPV (cakupan server, tanpa
 *   `salesCodes` dari klien; baris unggah dengan hari tak dikenal dilaporkan), dan pemilih "Toko di rute hari ini" Order Sales (kode JKS
 *   tanpa akhiran -> pelanggan cabang lewat /api/customers/rute; toko yang belum terdaftar di cabang Anda tampil beserta alasannya, tidak
 *   ditawarkan). Ponsel 390 px untuk layar salesman. Data generik (PELANGGAN A, CABANG A, PRINCIPLE A).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-form-kontrol-msm.spec.ts --config playwright.fiori-local.config.ts --workers=1 --output=test-results/fkmsm`.
 * Dependensi: /api/form-kontrol/* + /api/customers/* + /api/items/search + /api/orders/preview + FastAPI Web Sales di-mock (page.route).
 * Side Effects: Tangkapan di test-results/fkmsm.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import * as XLSX from "xlsx";
import { PELANGGAN, mockOrderCabang, mockWebsales } from "./helpers/order-cabang-mock";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());

const SALESMAN = { role: "salesman", salesCode: "S-01", salesName: "SALES A", spvName: "SPV A", allowedSalesCodes: ["S-01"], principles: ["PRINCIPLE A"] };
const RUTE = [
    { id: "a1", salesCode: "S-01", custCode: "C-100001", custName: "PELANGGAN A", principle: "PRINCIPLE A", aoStatus: null, monthlyOrderCount: 0, needsAttention: false, checkinAt: null, checkoutAt: null },
    { id: "a2", salesCode: "S-01", custCode: "C-100002", custName: "PELANGGAN B", principle: "PRINCIPLE A", aoStatus: null, monthlyOrderCount: 0, needsAttention: false, checkinAt: null, checkoutAt: null },
];

async function mockFk(page: Page, opsi: { scope: unknown; jksPost?: unknown }) {
    const baca: URL[] = [];
    const tulis: Request[] = [];
    await page.route("**/api/form-kontrol/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace("/api/form-kontrol/", "");
        if (req.method() === "GET") baca.push(url); else tulis.push(req);
        if (p === "my-scope") return route.fulfill(json(opsi.scope));
        if (p === "ao-control") return route.fulfill(json({ rows: RUTE, summary: {}, date: url.searchParams.get("date") }));
        if (p === "jks" && req.method() === "GET") return route.fulfill(json({ rows: [], total: 0, page: 1, limit: 50 }));
        if (p === "jks" && req.method() === "POST") return route.fulfill(json(opsi.jksPost ?? { success: true, imported: 0, skipped: 0, ditolak: [] }));
        return route.fulfill(json({ rows: [], total: 0 }));
    });
    return { baca, tulis };
}
const rutePermintaan = (baca: URL[]) => baca.filter((u) => u.pathname.endsWith("/ao-control"));
/** Principal yang diminta (mode dev React menjalankan efek dua kali: yang diperiksa himpunannya). */
const principalDiminta = (baca: URL[]) => [...new Set(rutePermintaan(baca).map((u) => u.searchParams.get("principle")))];

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}

test.describe.configure({ timeout: 150_000 });
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test.describe("ponsel 390 px (layar sentuh)", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("Salesman: satu principal JKS langsung terpilih (tanpa pilihan), rute dimuat dengan principal itu", async ({ page }) => {
        const m = await mockFk(page, { scope: SALESMAN });
        await page.goto("/form-kontrol?tab=ao", NAV);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        await expect(r.getByRole("list", { name: "Toko di rute" }).getByRole("listitem")).toHaveCount(2, NAV);
        await expect(r.getByLabel("Principal")).toHaveCount(0);
        await expect(r.getByText("S-01", { exact: true })).toBeVisible();
        await expect(r).toContainText("SALES A · PRINCIPLE A");
        expect(principalDiminta(m.baca)).toEqual(["PRINCIPLE A"]);
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm/ponsel-rute-satu-principal.png", fullPage: true });
    });

    test("Salesman tanpa JKS: penjelasan (kode sales disebut), bukan rute kosong diam; tidak ada permintaan rute", async ({ page }) => {
        const m = await mockFk(page, { scope: { ...SALESMAN, principles: [] } });
        await page.goto("/form-kontrol?tab=ao", NAV);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        await expect(r.getByText("Belum ada JKS aktif untuk Anda")).toBeVisible(NAV);
        await expect(r).toContainText("Kode Sales = S-01");
        await expect(r.getByText("Tidak ada rute terjadwal hari ini")).toHaveCount(0);
        expect(rutePermintaan(m.baca)).toEqual([]);
        await page.goto("/form-kontrol?tab=no-order", NAV);
        await expect(page.getByText("Belum ada JKS aktif untuk Anda")).toBeVisible(NAV);
        expect(rutePermintaan(m.baca)).toEqual([]);
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm/ponsel-tanpa-jks.png", fullPage: true });
    });

    test("Order Sales: toko rute (kode JKS tanpa akhiran) -> pelanggan cabang; toko yang belum terdaftar di cabang Anda tidak ditawarkan + alasannya", async ({ page }) => {
        const pelA = { ...PELANGGAN[0], customerNo: "C-100001-CBA" };
        let gagalSekali = true;
        const { log } = await mockOrderCabang(page, {
            peran: "sales",
            rute: (url) => {
                if (gagalSekali) { gagalSekali = false; return "putus"; }
                return { body: { ok: true, cakupan: { semua: false, branchId: 50, branchName: "CABANG A" }, rute: url.searchParams.getAll("kode").map((k) => k === "C-100001"
                    ? { kode: k, pelanggan: pelA, masalah: null, kandidat: [pelA.customerNo], alasan: "" }
                    : { kode: k, pelanggan: null, masalah: "TIDAK_ADA", kandidat: [], alasan: "Belum terdaftar sebagai pelanggan cabang Anda (CABANG A) di Accurate." }) } };
            },
        });
        await mockWebsales(page, { hari: HARI_INI });
        await page.addInitScript((t) => sessionStorage.setItem("fk-rute-hari-ini", JSON.stringify({ tanggal: t, salesCode: "S-01",
            toko: [{ kode: "C-100001", nama: "PELANGGAN A" }, { kode: "C-100002", nama: "PELANGGAN B" }] })), HARI_INI);
        await page.goto("/sales", NAV);
        const main = page.locator("main");

        // Galat pencocokan ≠ kosong: kalimat + Coba lagi; pencarian pelanggan tetap ada.
        const galat = main.getByRole("alert").filter({ hasText: "Toko di rute hari ini belum bisa dicocokkan dengan pelanggan cabang Anda." });
        await expect(galat).toContainText("Pelanggan tetap bisa dicari di bawah.", NAV);
        await galat.getByRole("button", { name: "Coba lagi" }).click();

        const pilih = main.getByLabel("Toko di rute hari ini");
        await expect(pilih).toBeVisible(NAV);
        await expect(pilih.locator("option")).toHaveText(["Pilih toko", "PELANGGAN A · C-100001-CBA"]);
        const belum = main.getByRole("list", { name: "Toko rute yang belum bisa dipilih" });
        await expect(belum.getByRole("listitem")).toHaveText(["PELANGGAN B C-100002: Belum terdaftar sebagai pelanggan cabang Anda (CABANG A) di Accurate."]);
        expect(log.rute.at(-1)!.searchParams.getAll("kode")).toEqual(["C-100001", "C-100002"]);
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm/ponsel-order-toko-rute.png", fullPage: true });

        const cariSebelum = log.pelanggan.length;
        await pilih.selectOption({ label: "PELANGGAN A · C-100001-CBA" });
        const kartu = main.getByRole("group", { name: "Pelanggan terpilih" });
        await expect(kartu).toContainText("C-100001-CBA", NAV);
        await expect(kartu).toContainText("Cabang CABANG A");
        await expect(main.getByLabel("Outlet")).toHaveValue("PELANGGAN A");
        expect(log.pelanggan.length, "pelanggan dari hasil pencocokan, bukan pencarian kode persis").toBe(cariSebelum);
        await noOverflow(page);
    });
});

test("Admin: beberapa principal = Pilih principal; rute baru diminta sesudah principal dipilih", async ({ page }) => {
    const m = await mockFk(page, { scope: { role: "admin", allowedSalesCodes: null, principles: ["PRINCIPLE A", "PRINCIPLE B"] } });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/form-kontrol?tab=ao", NAV);
    const r = page.getByRole("region", { name: "Rute hari ini" });
    await r.getByLabel("Kode salesman").fill("S-01", NAV);
    await expect(r.getByText("JKS dalam cakupan Anda memuat 2 principal; rute tampil per principal.")).toBeVisible();
    expect(rutePermintaan(m.baca)).toEqual([]);
    await expect(r.getByLabel("Principal").locator("option")).toHaveText(["Pilih principal", "PRINCIPLE A", "PRINCIPLE B"]);
    await r.getByLabel("Principal").selectOption("PRINCIPLE B");
    await expect(r.getByRole("list", { name: "Toko di rute" }).getByRole("listitem")).toHaveCount(2, NAV);
    expect(principalDiminta(m.baca)).toEqual(["PRINCIPLE B"]);
});

test("SPV: Kontrol JKS tanpa salesCodes dari klien (cakupan server), principal dari JKS; unggah melaporkan hari tak dikenal per baris", async ({ page }) => {
    const m = await mockFk(page, {
        scope: { role: "spv", salesName: "SPV A", spvName: "SPV A", allowedSalesCodes: ["S-01", "S-02"], principles: ["PRINCIPLE A", "PRINCIPLE B"] },
        jksPost: { success: true, imported: 1, skipped: 0, ditolak: [{ baris: 3, custCode: "C-100003", hari: "Minggu" }] },
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/form-kontrol?tab=jks", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Hanya JKS salesman dalam cakupan Anda.")).toBeVisible(NAV);
    await expect.poll(() => m.baca.filter((u) => u.pathname.endsWith("/jks")).length).toBeGreaterThan(0);
    for (const u of m.baca.filter((x) => x.pathname.endsWith("/jks"))) expect(u.searchParams.has("salesCodes")).toBe(false);
    await expect(main.getByLabel("Principal").locator("option")).toHaveText(["Semua principal", "PRINCIPLE A", "PRINCIPLE B"]);
    await expect(main.getByText("Server belum membatasi JKS")).toHaveCount(0);

    // SPV tidak punya izin manage pada data nyata; admin LOCAL_AUTH_BYPASS memegang semua kunci, jadi tombol Impor terbuka di sini.
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Kode Sales", "Kode Toko", "Principle", "Hari"],
        ["S-01", "C-100001", "PRINCIPLE A", "SENIN"], ["S-01", "C-100003", "PRINCIPLE A", "Minggu"]]), "JKS");
    const buffer = Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
    await main.getByRole("button", { name: "Impor Excel" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Berkas JKS (.xlsx)").setInputFiles({ name: "jks.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer });
    await expect(dialog.getByText("Baris terbaca")).toBeVisible();
    await dialog.getByRole("button", { name: "Terapkan" }).click();
    await expect(main.getByText("1 baris tidak ditulis: hari kunjungan tidak dikenal.")).toBeVisible(NAV);
    await expect(main).toContainText('baris 3 (C-100003: "Minggu")');
    await expect(main).toContainText("1 baris ditulis, 0 baris dilewati, 1 baris ditolak.");
});
