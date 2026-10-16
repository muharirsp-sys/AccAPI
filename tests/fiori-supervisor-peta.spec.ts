/*
 * Tujuan: SR-3 Supervisor Review — (1) komponen Peta (Leaflet + OSM): jumlah penanda per status + legenda teks, garis urutan check-in saat
 *   satu salesman dipilih, EmptyState tanpa titik, peta tidak dibangun ulang bila induk mengirim array baru; (2) tab Koordinat Toko di
 *   /form-kontrol: ringkasan, unduh templat, pratinjau + unggah -> tabel baris ditolak, tab hanya untuk admin/manager/admin_sales. 390 px.
 *   Data generik (SALES A, CABANG A, PRINCIPLE A).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true), config sementara port 3062:
 *   `npx playwright test tests/fiori-supervisor-peta.spec.ts --config playwright.sr3-local.config.ts --workers=1`.
 * Dependensi: halaman uji app/(dashboard)/supervisor-review/uji-peta; SEMUA endpoint (/api/supervisor-review*, /api/form-kontrol/*) dan ubin
 *   OSM di-mock (page.route) — tanpa jaringan, tanpa DB.
 * Side Effects: Tangkapan di test-results/sr3.
 */
import { expect, test, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 90_000 } as const;
// PNG 1x1 transparan.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

const pen = (custCode: string, salesCode: string, status: string, lat: number, lng: number) =>
    ({ custCode, namaToko: `TOKO ${custCode}`, salesCode, lat, lng, status });
const kun = (salesCode: string, custCode: string, mulai: string | null, lat: number | null, lng: number | null, extra = {}) => ({
    salesCode, custCode, namaToko: `TOKO ${custCode}`, jenis: mulai ? "rute" : "tanpa_checkin", mulai, selesai: null, menitDiToko: null, menitTempuh: null,
    qty: null, item: null, nilai: null, ec: false, belumDifakturkan: false, lat, lng, jarakKeTokoM: null, ...extra,
});
const SALESMAN = (salesCode: string, nama: string) => ({ cabang: "CABANG A", salesCode, nama });

/** S-01: ec 1, tanpa_ec 1, belum 1 · S-02: ec 1, belum 1, faktur_tanpa_checkin 1. */
const DATA = {
    salesman: [SALESMAN("S-01", "SALES A"), SALESMAN("S-02", "SALES B")],
    penanda: [
        pen("C-1", "S-01", "ec", -5.1477, 119.4327), pen("C-2", "S-01", "tanpa_ec", -5.15, 119.41), pen("C-3", "S-01", "belum", -5.16, 119.43),
        pen("C-4", "S-02", "ec", -5.14, 119.45), pen("C-5", "S-02", "belum", -5.13, 119.46), pen("C-6", "S-02", "faktur_tanpa_checkin", -5.12, 119.47),
    ],
    // S-01 sengaja TIDAK urut `mulai` (11.00 dulu); bujur menurut urutan waktu naik: 119.40 -> 119.42 -> 119.44. Satu kunjungan tanpa GPS.
    kunjungan: [
        kun("S-01", "C-3", "2026-10-16T11:00:00+08:00", -5.16, 119.44, { jarakKeTokoM: 450 }),
        kun("S-01", "C-1", "2026-10-16T08:00:00+08:00", -5.1477, 119.4),
        kun("S-01", "C-2", "2026-10-16T09:30:00+08:00", -5.15, 119.42),
        kun("S-01", "C-9", "2026-10-16T12:00:00+08:00", null, null),
        kun("S-02", "C-4", "2026-10-16T08:10:00+08:00", -5.14, 119.45),
        kun("S-02", "C-5", "2026-10-16T09:10:00+08:00", -5.13, 119.46),
        kun("S-02", "C-6", null, null, null),
    ],
};

async function mockPeta(page: Page, data: unknown) {
    const ubin: string[] = [];
    await page.route("https://tile.openstreetmap.org/**", (route) => { ubin.push(route.request().url()); return route.fulfill({ status: 200, contentType: "image/png", body: PNG }); });
    await page.route("**/api/supervisor-review**", (route) => route.fulfill(json(data)));
    return ubin;
}
const jumlah = (page: Page, kelas: string) => page.locator(`path.peta-${kelas}`);
const legenda = (page: Page) => page.getByRole("list", { name: "Legenda peta" });
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}

test.describe.configure({ timeout: 150_000 });
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test.describe("Peta (halaman uji)", () => {
    test("penanda per status + legenda teks + atribusi + ubin; memilih satu salesman menyaring dan menggambar garis urut waktu", async ({ page }) => {
        const ubin = await mockPeta(page, DATA);
        await page.goto("/supervisor-review/uji-peta", NAV);
        const peta = page.getByRole("region", { name: "Peta toko dan titik check-in" });
        await expect(peta).toBeVisible(NAV);

        // Semua salesman: 6 penanda toko (2 ec, 1 tanpa_ec, 2 belum, 1 faktur_tanpa_checkin) + 5 titik check-in ber-GPS, tanpa garis.
        await expect(jumlah(page, "ec")).toHaveCount(2, NAV);
        await expect(jumlah(page, "tanpa_ec")).toHaveCount(1);
        await expect(jumlah(page, "belum")).toHaveCount(2);
        await expect(jumlah(page, "faktur_tanpa_checkin")).toHaveCount(1);
        await expect(jumlah(page, "checkin")).toHaveCount(5);
        await expect(jumlah(page, "garis")).toHaveCount(0);

        // Legenda = teks + angka (bukan warna saja).
        const l = legenda(page);
        await expect(l.getByRole("listitem").filter({ hasText: "Dikunjungi, EC" })).toHaveText(/Dikunjungi, EC\s*2/);
        await expect(l.getByRole("listitem").filter({ hasText: "Dikunjungi, tanpa EC" })).toHaveText(/tanpa EC\s*1/);
        await expect(l.getByRole("listitem").filter({ hasText: "Terjadwal, belum dikunjungi" })).toHaveText(/belum dikunjungi\s*2/);
        await expect(l.getByRole("listitem").filter({ hasText: "Berfaktur, tanpa check-in" })).toHaveText(/tanpa check-in\s*1/);
        await expect(l.getByRole("listitem").filter({ hasText: "Titik check-in" })).toHaveText(/Titik check-in\s*5/);
        await expect(l).not.toContainText("Garis putus-putus");

        // Atribusi OSM + ubin diminta dari tile.openstreetmap.org.
        await expect(peta.locator(".leaflet-control-attribution")).toContainText("© OpenStreetMap contributors");
        await expect.poll(() => ubin.length, NAV).toBeGreaterThan(0);
        expect(ubin.every((u) => /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(u))).toBe(true);
        await page.screenshot({ path: "test-results/sr3/peta-desktop-semua.png", fullPage: true });

        // Pilih SALES A: hanya miliknya (3 toko, 3 titik GPS dari 4 kunjungan), garis muncul.
        await page.getByLabel("Salesman").selectOption("S-01");
        await expect(jumlah(page, "garis")).toHaveCount(1, NAV);
        await expect(jumlah(page, "ec")).toHaveCount(1);
        await expect(jumlah(page, "tanpa_ec")).toHaveCount(1);
        await expect(jumlah(page, "belum")).toHaveCount(1);
        await expect(jumlah(page, "faktur_tanpa_checkin")).toHaveCount(0);
        await expect(jumlah(page, "checkin")).toHaveCount(3);
        await expect(l).toContainText("Garis putus-putus");
        await expect(l.getByRole("listitem").filter({ hasText: "Titik check-in" })).toHaveText(/Titik check-in\s*3/);

        // Garis mengikuti `mulai` (bukan urutan array): bujur titik naik 119.40 -> 119.42 -> 119.44, jadi x di path harus naik.
        const d = await jumlah(page, "garis").getAttribute("d");
        const xs = [...(d ?? "").matchAll(/[ML]\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)].map((m) => Number(m[1]));
        expect(xs).toHaveLength(3);
        expect(xs[0]).toBeLessThan(xs[1]);
        expect(xs[1]).toBeLessThan(xs[2]);

        // Kembali ke semua salesman: garis hilang lagi.
        await page.getByLabel("Salesman").selectOption("");
        await expect(jumlah(page, "garis")).toHaveCount(0, NAV);
        await expect(jumlah(page, "checkin")).toHaveCount(5);
    });

    test("induk yang mengirim array baru (isi sama) tidak membangun ulang peta", async ({ page }) => {
        await mockPeta(page, DATA);
        await page.goto("/supervisor-review/uji-peta", NAV);
        await expect(jumlah(page, "ec")).toHaveCount(2, NAV);
        await page.evaluate(() => { (window as unknown as { __pane: Element | null }).__pane = document.querySelector(".leaflet-map-pane"); });
        await page.getByRole("button", { name: "Render ulang" }).click();
        await page.getByRole("button", { name: "Render ulang" }).click();
        expect(await page.evaluate(() => document.querySelector(".leaflet-map-pane") === (window as unknown as { __pane: Element | null }).__pane)).toBe(true);
        await expect(jumlah(page, "ec")).toHaveCount(2);
    });

    test("tanpa titik (tak ada toko berkoordinat, kunjungan tanpa GPS): EmptyState, tanpa peta", async ({ page }) => {
        await mockPeta(page, { salesman: DATA.salesman, penanda: [], kunjungan: [kun("S-01", "C-9", "2026-10-16T12:00:00+08:00", null, null)] });
        await page.goto("/supervisor-review/uji-peta", NAV);
        await expect(page.getByText("Belum ada toko berkoordinat / check-in ber-GPS")).toBeVisible(NAV);
        await expect(page.locator(".leaflet-container")).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Peta toko dan titik check-in" })).toHaveCount(0);
    });

    test.describe("ponsel 390 px", () => {
        test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        test("peta 300 px, legenda terbaca, tanpa luapan mendatar", async ({ page }) => {
            await mockPeta(page, DATA);
            await page.goto("/supervisor-review/uji-peta", NAV);
            const peta = page.getByRole("region", { name: "Peta toko dan titik check-in" });
            await expect(jumlah(page, "ec")).toHaveCount(2, NAV);
            expect((await peta.boundingBox())?.height).toBe(300);
            await expect(legenda(page).getByRole("listitem").filter({ hasText: "Terjadwal, belum dikunjungi" })).toBeVisible();
            await noOverflow(page);
            await page.screenshot({ path: "test-results/sr3/peta-ponsel.png", fullPage: true });
        });
    });
});

// ── Tab Koordinat Toko ────────────────────────────────────────────────────

const ADMIN = { role: "admin", salesCode: null, salesName: null, allowedSalesCodes: null, principles: ["PRINCIPLE A"] };
const RINGKASAN = {
    tokoJks: 5, berKoordinat: 2,
    contohTanpaKoordinat: [{ custCode: "C-100001", namaToko: "PELANGGAN A" }, { custCode: "C-100002", namaToko: "PELANGGAN B" }, { custCode: "C-100003", namaToko: "PELANGGAN C" }],
};
const TOLAK = { disimpan: 1, ditolak: [{ baris: 3, kode: "C-100003", pesan: "Latitude di luar rentang -90 s.d. 90" }] };

async function mockTab(page: Page, scope: unknown = ADMIN) {
    const unggah: { tipe: string; badan: string }[] = [];
    await page.route("**/api/form-kontrol/**", (route) => {
        const p = new URL(route.request().url()).pathname.replace("/api/form-kontrol/", "");
        return route.fulfill(p === "my-scope" ? json(scope) : json({ rows: [], total: 0 }));
    });
    await page.route("**/api/supervisor-review/koordinat", (route) => {
        const req = route.request();
        if (req.method() === "POST") { unggah.push({ tipe: req.headers()["content-type"] ?? "", badan: req.postDataBuffer()?.toString("latin1") ?? "" }); return route.fulfill(json(TOLAK)); }
        return route.fulfill(json(RINGKASAN));
    });
    return unggah;
}
const berkasXlsx = (baris: unknown[][]) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(baris), "Koordinat");
    return { name: "koordinat-cabang-a.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer) };
};

test.describe("Tab Koordinat Toko", () => {
    test("ringkasan, templat berisi contoh tanpa koordinat, pratinjau, unggah multipart -> tabel ditolak", async ({ page }, info) => {
        const unggah = await mockTab(page);
        await page.goto("/form-kontrol?tab=koordinat", NAV);
        const bagian = page.getByRole("region", { name: "Koordinat Toko" }).first();
        await expect(bagian).toContainText("Toko JKS aktif", NAV);
        await expect(bagian.getByText("Belum berkoordinat", { exact: true }).locator("xpath=following-sibling::*[1]")).toHaveText("3");
        await expect(page.getByRole("navigation", { name: "Modul Form Kontrol" }).getByRole("link", { name: "Koordinat Toko" })).toHaveAttribute("aria-current", "page");

        // Templat: sheet pertama = header + toko contoh; nama toko di sheet Petunjuk.
        const unduh = page.waitForEvent("download");
        await page.getByRole("button", { name: "Unduh templat" }).click();
        const berkasUnduh = await unduh;
        expect(berkasUnduh.suggestedFilename()).toBe("templat-koordinat-toko.xlsx");
        const path = info.outputPath("templat.xlsx");
        await berkasUnduh.saveAs(path);
        const wb = XLSX.readFile(path);
        expect(wb.SheetNames[0]).toBe("Koordinat");
        expect(XLSX.utils.sheet_to_json(wb.Sheets.Koordinat, { header: 1, defval: "" })).toEqual([
            ["Kode Toko", "Latitude", "Longitude"], ["C-100001", "", ""], ["C-100002", "", ""], ["C-100003", "", ""],
        ]);
        expect(JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets.Petunjuk, { header: 1 }))).toContain("PELANGGAN B");

        // Pratinjau: 3 baris, baris ke-3 lintang di luar rentang -> "tampak tidak sah"; Terapkan terkunci sampai berkas dipilih.
        await page.getByRole("button", { name: "Unggah koordinat" }).click();
        const dlg = page.getByRole("dialog");
        await expect(dlg.getByRole("button", { name: "Terapkan" })).toBeDisabled();
        await dlg.locator('input[type="file"]').setInputFiles(berkasXlsx([
            ["Kode Toko", "Latitude", "Longitude"], ["C-100001", -5.1477, 119.4327], ["C-100002", -5.15, 119.41], ["C-100003", 95, 119.4],
        ]));
        await expect(dlg.getByText("Baris terbaca", { exact: true }).locator("xpath=following-sibling::*[1]")).toHaveText("3", NAV);
        await expect(dlg.getByText("1 baris tampak tidak sah.")).toBeVisible();
        await page.screenshot({ path: "test-results/sr3/koordinat-pratinjau.png" });

        // Terapkan -> POST multipart field `file` berisi berkas yang dipilih; hasil: disimpan + tabel ditolak.
        await dlg.getByRole("button", { name: "Terapkan" }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0, NAV);
        expect(unggah).toHaveLength(1);
        expect(unggah[0].tipe).toContain("multipart/form-data");
        expect(unggah[0].badan).toContain('name="file"');
        expect(unggah[0].badan).toContain('filename="koordinat-cabang-a.xlsx"');
        await expect(page.getByRole("status").filter({ hasText: "Unggahan koordinat selesai." })).toContainText("1 koordinat disimpan, 1 baris ditolak");
        const tabel = page.getByRole("table", { name: "Baris ditolak" });
        await expect(tabel.getByRole("row").filter({ hasText: "C-100003" })).toContainText("Latitude di luar rentang -90 s.d. 90");
        await expect(tabel.getByRole("row").filter({ hasText: "C-100003" }).getByRole("cell").first()).toHaveText("3");
    });

    test("berkas tanpa kolom wajib: peringatan di pratinjau", async ({ page }) => {
        await mockTab(page);
        await page.goto("/form-kontrol?tab=koordinat", NAV);
        await page.getByRole("button", { name: "Unggah koordinat" }).click();
        await page.getByRole("dialog").locator('input[type="file"]').setInputFiles(berkasXlsx([["Kode Toko", "Alamat"], ["C-100001", "JL A"]]));
        await expect(page.getByRole("dialog").getByText("Kolom wajib tidak ada: Latitude, Longitude.")).toBeVisible(NAV);
    });

    test("tab hanya untuk admin/manager/admin_sales: SPV tidak melihatnya", async ({ page }) => {
        await mockTab(page, { ...ADMIN, role: "spv", allowedSalesCodes: ["S-01"], salesCode: "S-01" });
        await page.goto("/form-kontrol", NAV);
        const nav = page.getByRole("navigation", { name: "Modul Form Kontrol" });
        await expect(nav.getByRole("link", { name: "Kontrol JKS" })).toBeVisible(NAV);
        await expect(nav.getByRole("link", { name: "Koordinat Toko" })).toHaveCount(0);
    });

    test.describe("ponsel 390 px", () => {
        test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        test("hasil unggah: daftar ditolak terbaca, tanpa luapan mendatar", async ({ page }) => {
            await mockTab(page);
            await page.goto("/form-kontrol?tab=koordinat", NAV);
            await expect(page.getByRole("region", { name: "Koordinat Toko" }).first()).toContainText("Toko JKS aktif", NAV);
            await page.getByRole("button", { name: "Unggah koordinat" }).click();
            const dlg = page.getByRole("dialog");
            await dlg.locator('input[type="file"]').setInputFiles(berkasXlsx([["Kode Toko", "Latitude", "Longitude"], ["C-100003", 95, 119.4]]));
            await expect(dlg.getByText("Baris terbaca")).toBeVisible(NAV);
            await dlg.getByRole("button", { name: "Terapkan" }).click();
            // Tabel desktop disembunyikan di ponsel (DOM ganda); yang terlihat = daftar ponsel.
            await expect(page.getByText("Latitude di luar rentang -90 s.d. 90").filter({ visible: true })).toHaveCount(1, NAV);
            await noOverflow(page);
            await page.screenshot({ path: "test-results/sr3/koordinat-ponsel.png", fullPage: true });
        });
    });
});
