/*
 * Tujuan: Fiori S4c Insentif Sales — Dashboard (Taksiran = sales + SPV + SM, capaian per SPV dengan warna laju + legenda, alasan Rp 0 per
 *   baris, rincian MT, galat tabel SPV ≠ kosong, galat dashboard ≠ kosong, kosong "target belum diunggah" vs "tidak cocok saringan",
 *   saringan SM di klien, ponsel 390 px) dan Insentif saya (identitas sales → capaian/syarat/bulan lalu lunas; tanpa identitas →
 *   belum ditautkan; galat ≠ Rp 0). Tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-insentif-dashboard.spec.ts --config playwright.fiori-local.config.ts`.
 * Dependensi: /api/insentif-sales/{dashboard,spv-dashboard,sm-dashboard} di-mock dengan page.route (tidak menyentuh DB).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const path = (p: string) => (url: URL) => url.pathname === p;
const NAV = { timeout: 60_000 } as const;

type Over = Record<string, unknown>;
const baris = (salesCode: string, salesName: string, principle: string, channel: string, spvName: string, smName: string, over: Over = {}) => ({
    salesCode, salesName, principle, branch: "MAKASSAR", channel, tipeSales: "exclusive", statusInsentif: "distributor_principle", support: 0,
    spvName, smName,
    target: { value: 400_000_000, ec: 600, ao: 120, ia: 30, isq: 0.25, splm: 0 },
    real: { value: 416_000_000, ec: 610, ao: 250, ia: 70, isq: 0.28 },
    pct: { value: 104, ec: 101.7, ao: 208.3, isq: 112, total: 130 },
    incentive: { value: 300_000, ec: 0, ao: 700_000, isq: 0, total: 1_000_000 },
    ambangAo: 240, aoFile: false, paymentStatus: "belum", ...over,
});
const ROWS = [
    baris("MKS-07", "Andi Pratama", "KINO", "GT", "ANI", "HENDRIK"),
    baris("MKS-11", "Bayu Saputra", "KINO", "MT", "ANI", "HENDRIK", { ambangAo: 120, incentive: { value: 350_000, ec: 150_000, ao: 131_500, isq: 350_000, total: 981_500 } }),
    baris("MKS-08", "Sinta Dewi", "KINO", "GT", "ANI", "HENDRIK", { paymentStatus: "lunas", incentive: { value: 282_300, ec: 0, ao: 658_700, isq: 0, total: 941_000 } }),
    baris("MKS-21", "Rudi Hartono", "GODREJ", "GT", "MARTEN", "HENDRIK", {
        pct: { value: 88, ec: 90, ao: 125, isq: 100, total: 90 }, real: { value: 352_000_000, ec: 540, ao: 150, ia: 40, isq: 0.27 },
        incentive: { value: 0, ec: 0, ao: 0, isq: 0, total: 0 },
    }),
    baris("MKS-30", "Yusuf Amir", "VINDA", "GT", "YARMAN", "DARMA", { support: 1_000_000, incentive: { value: 0, ec: 0, ao: 0, isq: 0, total: 0 } }),
];
const dashboard = (rows: unknown[], over: Over = {}) => ({
    month: 9, year: 2026, rows, progressFeed: null, cakupan: { dibatasi: false },
    opsiFilter: { principles: ["GODREJ", "KINO", "VINDA"], branches: ["MAKASSAR"], sm: ["DARMA", "HENDRIK"] }, ...over,
});
const det = (principle: string, insentif: number, over: Over = {}) => ({ principle, targetValue: 1_000_000_000, realisasiValue: 1_010_000_000, pctValue: 1, rate: 1_200_000, support: 0, porsiDistributor: 1_200_000, insentif, ...over });
const SPV = [
    { spvName: "ANI", jumlahValid: 2, ratePerPrincipal: 2_000_000, total: 4_000_000, rincian: [det("KINO", 2_000_000), det("URC", 2_000_000)] },
    { spvName: "MARTEN", jumlahValid: 1, ratePerPrincipal: 1_500_000, total: 0, rincian: [det("GODREJ", 0, { support: 1_500_000, porsiDistributor: 0 })] },
    { spvName: "YARMAN", jumlahValid: 1, ratePerPrincipal: 1_500_000, total: 1_200_000, rincian: [det("VINDA", 1_200_000)] },
];
const SM = [
    { smName: "HENDRIK", jumlahBaris: 46, targetValue: 4_730_000_000, realisasiValue: 4_701_000_000, pctValue: 0.994, berhak: true, total: 1_500_000 },
    { smName: "DARMA", jumlahBaris: 12, targetValue: 900_000_000, realisasiValue: 950_000_000, pctValue: 1.055, berhak: false, total: 0 },
];

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
/** Mock tiga endpoint; `dash`/`spv`/`sm` bisa diganti per tes. Mengembalikan URL dashboard yang diminta. */
async function mock(page: Page, opsi: { dash?: (u: URL) => ReturnType<typeof json>; spv?: () => ReturnType<typeof json>; sm?: () => ReturnType<typeof json> } = {}) {
    const diminta: string[] = [];
    const isi = (f: () => ReturnType<typeof json>) => (r: Route) => r.fulfill(f());
    await page.route(path("/api/insentif-sales/dashboard"), (r) => {
        const u = new URL(r.request().url());
        diminta.push(u.search);
        return r.fulfill(opsi.dash ? opsi.dash(u) : json(dashboard(ROWS)));
    });
    await page.route(path("/api/insentif-sales/spv-dashboard"), isi(opsi.spv ?? (() => json({ month: 9, year: 2026, rows: SPV }))));
    await page.route(path("/api/insentif-sales/sm-dashboard"), isi(opsi.sm ?? (() => json({ month: 9, year: 2026, rows: SM }))));
    return diminta;
}

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Dashboard: Taksiran sales+SPV+SM, capaian per SPV berwarna laju, alasan Rp 0 per baris, rincian MT, tanpa 'MT belum ada aturan'", async ({ page }) => {
    await mock(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales?month=9&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible(NAV);
    await expect(main.getByRole("table", { name: "Insentif sales" })).toBeVisible(NAV);
    await page.screenshot({ path: "test-results/fiori-insentif-dashboard-atas.png" });

    const taksiran = main.locator(".fi-kc").filter({ hasText: "Taksiran insentif" });
    await expect(taksiran).toContainText("Rp 9,6 Jt");
    await expect(taksiran).toContainText("Sales Rp 2,9 Jt · SPV Rp 5,2 Jt · SM Rp 1,5 Jt");
    await expect(main.getByText("usulan BL-48")).toBeVisible();

    const capaian = main.getByRole("region", { name: "Capaian per SPV" });
    await expect(capaian.getByText("di atas laju (≥ 100%)")).toBeVisible();
    await expect(capaian.getByText("tertinggal (< 80%)")).toBeVisible();
    const tabelSpv = capaian.getByRole("table", { name: "Capaian per SPV" });
    await expect(tabelSpv.locator("tbody tr")).toHaveCount(3);
    await expect(tabelSpv.locator('tbody tr').filter({ hasText: "MARTEN" }).locator(".fi-badge").first()).toHaveAttribute("title", "mendekati laju");

    const sales = main.getByRole("table", { name: "Insentif sales" });
    await expect(sales.locator("tbody tr").filter({ hasText: "Rudi Hartono" })).toContainText("belum 90,0%");
    await expect(sales.locator("tbody tr").filter({ hasText: "Yusuf Amir" })).toContainText("ditanggung principle");
    await expect(sales.locator("tbody tr").filter({ hasText: "Sinta Dewi" })).toContainText("Lunas");
    await expect(sales.locator("tfoot")).toContainText("Rp 2.922.500");
    await expect(main.getByText("MT belum ada aturan")).toHaveCount(0);
    const bukaBayu = main.getByRole("button", { name: "Rincian Bayu Saputra KINO" });
    await bukaBayu.click();
    await expect(bukaBayu).toHaveAttribute("aria-expanded", "true");
    await expect(sales.getByText("Komponen insentif (MT)")).toBeVisible();
    await expect(sales.getByText("Item Aktif (bobot Rp 350.000)")).toBeVisible();

    const spv = main.getByRole("region", { name: "Insentif SPV" });
    await expect(spv.getByRole("table", { name: "Insentif SPV" }).locator("tbody tr").filter({ hasText: "MARTEN" })).toContainText("ditanggung principle");
    await spv.getByRole("button", { name: "Rincian ANI" }).click();
    await expect(spv.getByRole("table", { name: "Rincian per principal" })).toContainText("URC");
    const sm = main.getByRole("region", { name: "Insentif SM" });
    await expect(sm.locator("tbody tr").filter({ hasText: "DARMA" })).toContainText("tidak ikut skema insentif SM");
    await expect(sm).toContainText("≥ 110,0% Rp 3,5 Jt");
    await page.screenshot({ path: "test-results/fiori-insentif-dashboard.png", fullPage: true });
});

test("Dashboard: galat tabel SPV tampil sebagai galat (bukan kosong) dan Taksiran menyebutnya; galat dashboard bukan kosong", async ({ page }) => {
    let dashGagal = false;
    await mock(page, {
        spv: () => json({ error: "Koneksi database terputus" }, 500),
        dash: () => (dashGagal ? json({ error: "Koneksi database terputus" }, 500) : json(dashboard(ROWS))),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales?month=9&year=2026", NAV);
    const main = page.locator("main");
    const spv = main.getByRole("region", { name: "Insentif SPV" });
    await expect(spv.getByRole("alert")).toContainText("Insentif SPV belum berhasil dimuat (Koneksi database terputus).", NAV);
    await expect(spv.getByText("Belum ada insentif SPV")).toHaveCount(0);
    await expect(main.locator(".fi-kc").filter({ hasText: "Taksiran insentif" })).toContainText("SPV gagal dimuat");
    await expect(main.getByRole("region", { name: "Insentif SM" }).locator("tbody tr")).toHaveCount(2);

    dashGagal = true;
    await page.reload(NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Data insentif belum berhasil dimuat" })).toBeVisible(NAV);
    await expect(main.getByText("Data kosong tidak ditampilkan karena server belum memberikan hasil yang valid.")).toBeVisible();
    await expect(main.getByText(/Belum ada data insentif|Tidak ada data untuk saringan/)).toHaveCount(0);
});

test("Dashboard: periode kosong lalu Muat ulang gagal → alert 'hasil sebelumnya', bukan kosong diam-diam", async ({ page }) => {
    let gagal = false;
    await mock(page, { dash: () => (gagal ? json({ error: "Koneksi database terputus" }, 500) : json(dashboard([]))) });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales?month=9&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Belum ada data insentif September 2026" })).toBeVisible(NAV);
    await expect(main.getByRole("alert")).toHaveCount(0);
    gagal = true;
    await main.getByRole("button", { name: "Muat ulang" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Yang tampil adalah hasil sebelumnya untuk September 2026." })).toBeVisible(NAV);
    await expect(main.getByRole("alert")).toContainText("Data insentif belum berhasil dimuat.");
});

test("Dashboard: ganti ke periode yang gagal → galat, tidak pernah angka periode lama (dashboard maupun SPV/Taksiran)", async ({ page }) => {
    await mock(page, { dash: (u) => (u.searchParams.get("month") === "8" ? json({ error: "Koneksi database terputus" }, 500) : json(dashboard(ROWS))) });
    // SPV Juli gagal, periode lain berhasil (rute ini dipasang terakhir → menang atas mock bawaan).
    await page.route(path("/api/insentif-sales/spv-dashboard"), (r) => new URL(r.request().url()).searchParams.get("month") === "7"
        ? r.fulfill(json({ error: "Koneksi database terputus" }, 500)) : r.fulfill(json({ rows: SPV })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales?month=9&year=2026", NAV);
    const main = page.locator("main");
    const spv = main.getByRole("region", { name: "Insentif SPV" });
    await expect(spv.locator("tbody tr").filter({ hasText: "ANI" })).toHaveCount(1, NAV);

    await page.locator(".fi-fbar").getByRole("textbox", { name: "Periode" }).fill("2026-07");
    await expect(page).toHaveURL(/month=7/, NAV);
    await expect(spv.getByRole("alert")).toContainText("Insentif SPV belum berhasil dimuat", NAV);
    await expect(spv.locator("tbody tr").filter({ hasText: "ANI" })).toHaveCount(0);
    const taksiran = main.locator(".fi-kc").filter({ hasText: "Taksiran" });
    await expect(taksiran).toContainText("SPV gagal dimuat — angka tidak lengkap");
    await expect(taksiran).toHaveAttribute("data-tone", "warn");
    await expect(taksiran).not.toContainText("SPV Rp");

    await page.locator(".fi-fbar").getByRole("textbox", { name: "Periode" }).fill("2026-08");
    await expect(page).toHaveURL(/month=8/, NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Data insentif belum berhasil dimuat." })).toBeVisible(NAV);
    await expect(main.getByText("Yang tampil adalah hasil sebelumnya")).toHaveCount(0);
    await expect(main.getByText("Andi Pratama")).toHaveCount(0);
});

test("Dashboard kosong: target belum diunggah (tautan Data periode) ≠ tidak cocok saringan", async ({ page }) => {
    await mock(page, {
        dash: (u) => u.searchParams.get("principle")
            ? json(dashboard([]))
            : json(dashboard([], { progressFeed: { progressKeys: 12, targetKeys: 0, matchedKeys: 0, unmatchedKeys: 12, zeroTargetKeys: 0, ready: false } })),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales?month=9&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Target periode ini belum diunggah" })).toBeVisible(NAV);
    await expect(main.getByText("12 kombinasi pencapaian sudah diterima.", { exact: false })).toBeVisible();
    await expect(main.getByRole("link", { name: "Buka Data periode" })).toHaveAttribute("href", "/insentif-sales/data-periode?month=9&year=2026");

    await page.goto("/insentif-sales?month=9&year=2026&principle=GODREJ", NAV);
    await expect(main.getByRole("heading", { name: "Tidak ada data untuk saringan ini" })).toBeVisible(NAV);
    await main.getByRole("button", { name: "Hapus saringan", exact: true }).click();
    await expect(page).toHaveURL(/\/insentif-sales\?month=9&year=2026$/, NAV);
});

test("Dashboard saringan SM: disaring di klien, tabel SPV/SM tidak ikut disaring", async ({ page }) => {
    const diminta = await mock(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales?month=9&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("table", { name: "Insentif sales" }).locator("tbody tr")).toHaveCount(5, NAV);
    await page.locator(".fi-fbar").getByLabel("SM").selectOption("DARMA");
    await expect(page).toHaveURL(/sm=DARMA/, NAV);
    const sales = main.getByRole("table", { name: "Insentif sales" });
    await expect(sales.locator("tbody tr")).toHaveCount(1);
    await expect(sales.locator("tbody tr")).toContainText("Yusuf Amir");
    await expect(sales.locator("tfoot")).toContainText("Total 1 dari 5 baris");
    await expect(main.getByRole("table", { name: "Capaian per SPV" }).locator("tbody tr")).toHaveCount(1);
    await expect(main.getByRole("region", { name: "Insentif SPV" }).locator("tbody tr")).toHaveCount(3);
    await expect(main.getByRole("region", { name: "Insentif SM" }).locator("tbody tr")).toHaveCount(2);
    await expect(main.locator(".fi-kc").filter({ hasText: "Taksiran insentif" })).toContainText("SPV dan SM tanpa saringan");
    expect(diminta.every((q) => !q.includes("sm="))).toBe(true);
});

test("Dashboard ponsel 390 px: daftar, rincian bisa dibuka, tanpa gulir menyamping", async ({ page }) => {
    await mock(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/insentif-sales?month=9&year=2026", NAV);
    const main = page.locator("main");
    const daftar = main.getByRole("list", { name: "Insentif sales" });
    await expect(daftar).toBeVisible(NAV);
    await expect(main.getByRole("table", { name: "Insentif sales" })).toBeHidden();
    await noOverflow(page);
    await daftar.getByRole("button", { name: "Rincian Bayu Saputra KINO" }).click();
    await expect(daftar.getByText("Komponen insentif (MT)")).toBeVisible();
    await main.getByRole("list", { name: "Insentif SPV" }).getByRole("button", { name: "Rincian ANI" }).click();
    await expect(main.getByRole("table", { name: "Rincian per principal" })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-insentif-dashboard-ponsel.png", fullPage: true });
});

// ── Insentif saya ───────────────────────────────────────────────────────────
const SALES = { dibatasi: true, jumlahKode: 1, identitas: { role: "sales", name: "MKS-07" } };
const kini = baris("MKS-07", "Andi Pratama", "KINO", "GT", "ANI", "HENDRIK", {
    target: { value: 412_000_000, ec: 600, ao: 120, ia: 30, isq: 0.25, splm: 0 }, real: { value: 86_500_000, ec: 118, ao: 52, ia: 14, isq: 0.27 },
    pct: { value: 21, ec: 19.7, ao: 43.3, isq: 108, total: 40 }, incentive: { value: 0, ec: 0, ao: 0, isq: 0, total: 0 },
});
const lalu = baris("MKS-07", "Andi Pratama", "KINO", "GT", "ANI", "HENDRIK", { paymentStatus: "lunas" });

test("Insentif saya (ponsel): identitas sales → capaian berjalan, syarat dari konstanta, September lunas dengan bruto/PPh/netto", async ({ page }) => {
    await mock(page, { dash: (u) => json(dashboard(u.searchParams.get("month") === "10" ? [kini] : [lalu], { cakupan: SALES })) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/insentif-sales/saya?month=10&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Insentif saya" })).toBeVisible(NAV);
    const capaian = main.getByRole("region", { name: "Capaian Oktober 2026" });
    await expect(capaian).toContainText("Value · bobot 30,0%", NAV);
    await expect(capaian).toContainText("52 dari 240 outlet");
    await expect(main.getByRole("region", { name: "Cara insentif Anda dihitung" })).toContainText("minimal 90,0%");
    const sept = main.getByRole("region", { name: "Insentif September 2026" });
    await expect(sept).toContainText("Rp 1.000.000");
    await expect(sept).toContainText("PPh 2,5%");
    await expect(sept).toContainText("-Rp 25.000");
    await expect(sept).toContainText("Rp 975.000");
    await expect(sept.getByRole("status").filter({ hasText: "Insentif September 2026 sudah dibayar." })).toBeVisible();
    await expect(sept.getByText("Lunas", { exact: true })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-insentif-saya.png", fullPage: true });
});

test("Insentif saya: akun tanpa identitas hierarki → belum ditautkan, tidak ada data siapa pun", async ({ page }) => {
    await mock(page, { dash: () => json(dashboard(ROWS)) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/insentif-sales/saya?month=10&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Akun Anda belum ditautkan ke hierarki insentif" })).toBeVisible(NAV);
    await expect(main.getByRole("link", { name: "Buka Pengaturan" })).toHaveAttribute("href", "/insentif-sales/pengaturan?month=10&year=2026");
    for (const nama of ["Andi Pratama", "Rudi Hartono", "Rp 1.000.000"]) await expect(main.getByText(nama)).toHaveCount(0);
    await noOverflow(page);
});

test("Insentif saya: galat memuat tidak tampil sebagai Rp 0 (periode berjalan maupun bulan lalu)", async ({ page }) => {
    let gagalSemua = true;
    await mock(page, {
        dash: (u) => gagalSemua || u.searchParams.get("month") === "9"
            ? json({ error: "Koneksi database terputus" }, 500)
            : json(dashboard([kini], { cakupan: SALES })),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/insentif-sales/saya?month=10&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("alert").filter({ hasText: "Data insentif belum berhasil dimuat" })).toBeVisible(NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Data insentif belum berhasil dimuat" }).getByText("Angka tidak ditampilkan agar tidak terbaca sebagai Rp 0.")).toBeVisible();
    await expect(main.getByRole("region", { name: "Insentif September 2026" }).getByRole("alert")).toContainText("Insentif September 2026 belum berhasil dimuat");
    await expect(main.locator("dd, .fi-kc")).toHaveCount(0); // tidak ada nilai sama sekali, apalagi Rp 0

    gagalSemua = false;
    await main.getByRole("alert").filter({ hasText: "Data insentif belum berhasil dimuat" }).getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("region", { name: "Capaian Oktober 2026" })).toBeVisible(NAV);
    const sept = main.getByRole("region", { name: "Insentif September 2026" });
    await expect(sept.getByRole("alert")).toContainText("Insentif September 2026 belum berhasil dimuat");
    await expect(sept.locator("dd")).toHaveCount(0);
});

test("Insentif saya: Oktober galat lalu kosong — insentif September tetap tampil", async ({ page }) => {
    let oktober: "galat" | "kosong" = "galat";
    await mock(page, {
        dash: (u) => u.searchParams.get("month") === "9"
            ? json(dashboard([lalu], { cakupan: SALES }))
            : oktober === "galat" ? json({ error: "Koneksi database terputus" }, 500) : json(dashboard([], { cakupan: SALES })),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/insentif-sales/saya?month=10&year=2026", NAV);
    const main = page.locator("main");
    const kini = main.getByRole("alert").filter({ hasText: "Data insentif belum berhasil dimuat" });
    await expect(kini).toBeVisible(NAV);
    const sept = main.getByRole("region", { name: "Insentif September 2026" });
    await expect(sept).toContainText("Rp 1.000.000", NAV);
    await expect(sept.getByText("Lunas", { exact: true })).toBeVisible();

    oktober = "kosong";
    await kini.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("heading", { name: "Belum ada target untuk kode MKS-07 di Oktober 2026" })).toBeVisible(NAV);
    await expect(sept).toContainText("Rp 975.000");
    await noOverflow(page);
});
