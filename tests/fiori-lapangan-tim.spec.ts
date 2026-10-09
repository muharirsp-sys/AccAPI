/*
 * Tujuan: Fiori S5 Lapangan (it05) — layar tim: shell Form Kontrol per peran (salesman/SPV/admin dari my-scope tiruan; galat akses ≠
 *   kosong), Dashboard SPV (Default, Kosong, Galat, admin memilih SPV → query spvName, Tandai sudah dibaca lewat dialog → payload,
 *   Batalkan tanda dibaca lewat dialog → `ack: false` + galat server di dialog),
 *   Kontrol JKS (impor lewat dialog: FormData `file` + pratinjau, imported DAN skipped tampil; templat terunduh), Kontrol SM (isian
 *   tersimpan dimuat, galat tidak ditelan, simpan lewat dialog), Briefing + Hierarki (tulis lewat dialog, payload), ponsel 390 px.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-lapangan-tim.spec.ts --config playwright.fiori-local.config.ts --workers=1 --output=test-results/tim`.
 * Dependensi: /api/form-kontrol/* di-mock dengan page.route (tidak menyentuh DB).
 * Side Effects: Tangkapan di test-results/tim.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());

const SCOPE = {
    salesman: { role: "salesman", salesCode: "S-01", salesName: "SALES A", spvName: "SPV A", allowedSalesCodes: ["S-01"] },
    spv: { role: "spv", salesName: "SPV A", spvName: "SPV A", allowedSalesCodes: ["S-01", "S-02"] },
    sm: { role: "sm", salesName: "SM A", smName: "SM A", allowedSalesCodes: ["S-01", "S-02"] },
    admin: { role: "admin", allowedSalesCodes: null },
};
const kini = new Date().toISOString();
const SALESMAN = [
    {
        salesCode: "S-01", salesName: "SALES A", totalRoute: 18, ordered: 11, notOrder: 4, notVisited: 3, checkedIn: 15, checkedOut: 14,
        submittedAt: kini, tindakLanjut: "TOKO A stok lama, kunjungi ulang Kamis.", spvAck: false, spvAckAt: null, totalFieldMinutes: 130,
        visits: [{ custCode: "C-01", custName: "TOKO A", status: "not_order", checkinAt: kini, checkoutAt: kini, durationMinutes: 3, gpsFlag: "akurasi_rendah", durFlag: "durasi_singkat", checkinPhotoUrl: null, checkoutPhotoUrl: null, merchDone: 6, merchTotal: 6, merchStepPhotos: null }],
    },
    { salesCode: "S-02", salesName: "SALES B", totalRoute: 17, ordered: 7, notOrder: 3, notVisited: 7, checkedIn: 10, checkedOut: 10, submittedAt: null, tindakLanjut: null, spvAck: false, spvAckAt: null, visits: [], totalFieldMinutes: 0 },
];
const JKS = [
    { id: "j1", salesCode: "S-01", salesName: "SALES A", custCode: "C-01", custName: "TOKO A", market: "GT", alamat: "", kota: "KOTA A", hariKunjungan: "Senin", mingguPattern: "all", area: "AREA A", rayon: "R1", principle: "GODREJ", visitFrequency: 4, isActive: true },
    { id: "j2", salesCode: "S-01", salesName: "SALES A", custCode: "C-02", custName: "TOKO B", market: "GT", alamat: "", kota: "KOTA A", hariKunjungan: "", mingguPattern: "ganjil", area: "AREA A", rayon: "R1", principle: "GODREJ", visitFrequency: 2, isActive: true },
];
const PROFILES = [
    { salesCode: "S-01", salesName: "SALES A", principle: "GODREJ", branch: "CABANG A", spvName: "SPV A", smName: "SM A" },
    { salesCode: "S-02", salesName: "SALES B", principle: "GODREJ", branch: "CABANG A", spvName: "SPV B", smName: "SM A" },
    { salesCode: "S-03", salesName: "SALES C", principle: "GODREJ", branch: "CABANG A", spvName: null, smName: null },
];

type Opsi = {
    scope?: unknown; scopeGagal?: boolean;
    dashboard?: unknown[]; dashboardGagal?: boolean; dashboardTanpaSpv?: boolean;
    briefingGagal?: boolean; briefingPostStatus?: number;
    profilesGagal?: boolean;
    smControl?: unknown[]; smControlGagal?: boolean;
    /** Jumlah POST reports/ack berikutnya yang ditolak 403 (cakupan). */
    ackDitolak?: number;
};

/** Semua /api/form-kontrol/* dimock; opsi bisa diubah di tengah tes (objek yang sama dibaca tiap permintaan). */
async function mockApi(page: Page, opsi: Opsi) {
    const tulis: Request[] = [];
    const baca: URL[] = [];
    await page.route("**/api/form-kontrol/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace("/api/form-kontrol/", "");
        if (req.method() === "GET") baca.push(url); else tulis.push(req);
        if (p === "my-scope") return opsi.scopeGagal ? route.fulfill(json({ error: "Internal server error" }, 500)) : route.fulfill(json(opsi.scope ?? SCOPE.admin));
        if (p === "spv-dashboard") {
            if (opsi.dashboardTanpaSpv) return route.fulfill(json({ error: "SPV name not found" }, 400));
            return opsi.dashboardGagal ? route.fulfill(json({ error: "Internal server error" }, 500))
                : route.fulfill(json({ rows: opsi.dashboard ?? SALESMAN, date: url.searchParams.get("date"), spvName: url.searchParams.get("spvName") ?? "SPV A" }));
        }
        if (p === "reports/ack") {
            if (opsi.ackDitolak) { opsi.ackDitolak--; return route.fulfill(json({ error: "Tidak berhak atau laporan belum disubmit" }, 403)); }
            return route.fulfill(json({ success: true }));
        }
        if (p === "sales-profiles" && req.method() === "GET") return opsi.profilesGagal ? route.fulfill(json({ error: "Forbidden" }, 403)) : route.fulfill(json({ rows: PROFILES }));
        if (p === "sales-profiles" && req.method() === "PUT") return route.fulfill(json({ success: true }));
        if (p === "jks" && req.method() === "GET") return route.fulfill(json({ rows: JKS, total: JKS.length, page: 1, limit: 50 }));
        if (p === "jks" && req.method() === "POST") return route.fulfill(json({ success: true, imported: 2, skipped: 1 }));
        if (p === "briefing" && req.method() === "GET") {
            return opsi.briefingGagal ? route.fulfill(json({ error: "Internal server error" }, 500)) : route.fulfill(json({ rows: [{ session: "pagi", createdAt: kini }], total: 1 }));
        }
        if (p === "briefing" && req.method() === "POST") {
            // 502 dari proxy = jawaban tidak pasti (badan HTML).
            return opsi.briefingPostStatus === 502 ? route.fulfill({ status: 502, contentType: "text/html", body: "<html>502 Bad Gateway</html>" }) : route.fulfill(json({ success: true, id: "b1" }));
        }
        if (p === "sm-briefings") return route.fulfill(json({ rows: [{ spvName: "SPV A", briefings: [{ session: "pagi", penyebab: "Stok toko penuh", solusi: "Tawarkan varian baru" }] }, { spvName: "SPV B", briefings: [] }], smName: "SM A" }));
        if (p === "sm-control" && req.method() === "GET") return opsi.smControlGagal ? route.fulfill(json({ error: "Internal server error" }, 500)) : route.fulfill(json({ rows: opsi.smControl ?? [], total: (opsi.smControl ?? []).length }));
        if (p === "sm-control" && req.method() === "POST") return route.fulfill(json({ success: true, id: "s1" }));
        if (p === "frequency") return route.fulfill(json({ rows: [], simulation: null }));
        // Tab salesman (agen L) dan lainnya: kosong yang sah.
        return route.fulfill(json({ rows: [], total: 0 }));
    });
    return { tulis, baca };
}

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}

// Mode dev: kompilasi rute pertama lambat.
test.describe.configure({ timeout: 150_000 });

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Shell: tab mengikuti peran dari my-scope (salesman, SPV, admin); tautan Dashboard SPV hanya untuk tim", async ({ page }) => {
    const opsi: Opsi = { scope: SCOPE.salesman };
    await mockApi(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    const main = page.locator("main");
    const nav = main.getByRole("navigation", { name: "Modul Form Kontrol" });

    await page.goto("/form-kontrol", NAV);
    await expect(main.getByRole("heading", { level: 1, name: "Form Kontrol" })).toBeVisible(NAV);
    await expect(nav.getByRole("link")).toHaveText(["Form AO Harian", "Toko Tidak Order", "Laporan Harian"], NAV);
    await expect(nav.getByRole("link", { name: "Form AO Harian" })).toHaveAttribute("aria-current", "page");
    await expect(main.getByRole("link", { name: "Dashboard SPV" })).toHaveCount(0);
    await expect(main.getByText("Tampilan terkunci ke data Anda (SALES A).")).toBeVisible();

    opsi.scope = SCOPE.spv;
    await page.goto("/form-kontrol?tab=hierarki", NAV); // tab yang tidak boleh untuk SPV → tab pertama
    await expect(nav.getByRole("link")).toHaveText(["Kontrol JKS", "Form AO Harian", "Toko Tidak Order", "Laporan Harian", "Briefing SPV"], NAV);
    await expect(nav.getByRole("link", { name: "Kontrol JKS" })).toHaveAttribute("aria-current", "page");
    await expect(main.getByRole("link", { name: "Dashboard SPV" })).toHaveAttribute("href", "/form-kontrol/spv-dashboard");

    opsi.scope = SCOPE.admin;
    await page.goto("/form-kontrol?tab=hierarki", NAV);
    await expect(nav.getByRole("link")).toHaveText(["Kontrol JKS", "Form AO Harian", "Toko Tidak Order", "Laporan Harian", "Briefing SPV", "Kontrol SM", "Frekuensi Kunjungan", "Hierarki Sales"], NAV);
    await expect(nav.getByRole("link", { name: "Hierarki Sales" })).toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Kontrol SM" }).click();
    await expect(page).toHaveURL(/tab=sm-control/);
    // Admin tidak tertaut ke nama SM: layar menjelaskan, bukan formulir kosong yang bisa disimpan.
    await expect(main.getByText("Kontrol SM diisi oleh akun SM")).toBeVisible(NAV);
    await page.screenshot({ path: "test-results/tim/shell-admin.png", fullPage: true });
});

test("Shell: galat verifikasi akses tampil sebagai galat (bukan kosong); Coba lagi membuka modul", async ({ page }) => {
    const opsi: Opsi = { scopeGagal: true, scope: SCOPE.spv };
    await mockApi(page, opsi);
    await page.goto("/form-kontrol", NAV);
    const main = page.locator("main");
    const galat = main.getByRole("alert").filter({ hasText: "Akses Form Kontrol belum dapat diverifikasi" });
    await expect(galat).toBeVisible(NAV);
    await expect(galat).toContainText("Tidak ada modul yang dibuka");
    await expect(main.getByRole("navigation", { name: "Modul Form Kontrol" })).toHaveCount(0);
    await expect(main.getByText(/Belum ada modul/)).toHaveCount(0);
    opsi.scopeGagal = false;
    await galat.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("navigation", { name: "Modul Form Kontrol" }).getByRole("link")).toHaveCount(5, NAV);
});

test("Dashboard SPV: Default per salesman, Tandai sudah dibaca lewat dialog (payload), Sukses", async ({ page }) => {
    const { tulis, baca } = await mockApi(page, { scope: SCOPE.spv });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/form-kontrol/spv-dashboard", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Dashboard SPV" })).toBeVisible(NAV);
    const andi = main.getByRole("article", { name: "SALES A" });
    await expect(andi).toBeVisible(NAV);
    // Tanggal yang dikirim = hari ini WITA; SPV tidak mengirim spvName (server memakai profilnya).
    const q = baca.find((u) => u.pathname.endsWith("/spv-dashboard"))!;
    expect(q.searchParams.get("date")).toBe(HARI_INI);
    expect(q.searchParams.has("spvName")).toBe(false);
    await expect(main.locator(".fi-kc").filter({ hasText: "Rute tercatat" })).toContainText("35");
    await expect(main.locator(".fi-kc").filter({ hasText: "Laporan masuk" })).toContainText("1/2");
    await expect(main.getByText("1 salesman belum mengirim laporan:")).toBeVisible();
    await expect(andi.getByText("Menunggu dibaca")).toBeVisible();
    await expect(andi.getByText("Akurasi GPS rendah 1")).toBeVisible();
    await expect(main.getByRole("article", { name: "SALES B" }).getByText("Belum kirim laporan")).toBeVisible();
    await expect(main.getByRole("article", { name: "SALES B" }).getByRole("button", { name: "Tandai sudah dibaca" })).toHaveCount(0);
    await expect(main.locator('aside[aria-label="Usulan it05 #15"]')).toBeVisible();

    const tombol = andi.getByRole("button", { name: "Tandai sudah dibaca" });
    expect((await tombol.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await tombol.click();
    const dialog = page.getByRole("dialog", { name: "Tandai laporan SALES A sudah dibaca?" });
    await expect(dialog).toContainText("TOKO A stok lama, kunjungi ulang Kamis.");
    await expect(dialog).toContainText("bisa dibatalkan dari kartu salesman");
    await expect(dialog).not.toContainText("tidak bisa dibatalkan");
    expect(tulis).toHaveLength(0); // belum menulis sebelum dikonfirmasi
    await dialog.getByRole("button", { name: "Tandai sudah dibaca" }).click();
    await expect(dialog).toBeHidden();
    const ack = tulis.find((r) => r.url().includes("/reports/ack"))!;
    expect(ack.method()).toBe("POST");
    expect(ack.postDataJSON()).toEqual({ salesCode: "S-01", date: HARI_INI });
    await expect(main.getByRole("status").filter({ hasText: "Laporan SALES A ditandai sudah dibaca." })).toBeVisible();
    await page.screenshot({ path: "test-results/tim/spv-default.png", fullPage: true });
});

test("Dashboard SPV: Batalkan tanda dibaca (kontrak #132) lewat dialog → ack:false; galat server di dialog; kartu kembali Menunggu dibaca", async ({ page }) => {
    const dibaca = { ...SALESMAN[0], spvAck: true, spvAckAt: kini };
    const opsi: Opsi = { scope: SCOPE.spv, dashboard: [dibaca, SALESMAN[1]], ackDitolak: 1 };
    const { tulis } = await mockApi(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/form-kontrol/spv-dashboard", NAV);
    const main = page.locator("main");
    const kartu = main.getByRole("article", { name: "SALES A" });
    await expect(kartu.getByText(/^Dibaca /)).toBeVisible(NAV);
    await expect(kartu.getByRole("button", { name: "Tandai sudah dibaca" })).toHaveCount(0);
    await expect(main.getByRole("article", { name: "SALES B" }).getByRole("button", { name: /Batalkan tanda dibaca/ })).toHaveCount(0);
    const tombol = kartu.getByRole("button", { name: "Batalkan tanda dibaca…" });
    expect((await tombol.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await tombol.click();
    const dialog = page.getByRole("dialog", { name: "Batalkan tanda dibaca laporan SALES A?" });
    await expect(dialog).toContainText("Laporan kembali berstatus Menunggu dibaca");
    await expect(dialog).toContainText("Ditandai dibaca");
    expect(tulis).toHaveLength(0);
    await dialog.getByRole("button", { name: "Batalkan tanda dibaca" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Tanda dibaca belum dibatalkan.");
    await expect(dialog.getByRole("alert")).toContainText("Anda tidak berhak atas laporan ini"); // 403 server diterjemahkan pesanServer
    await page.screenshot({ path: "test-results/tim/spv-batal-dibaca.png" });
    opsi.dashboard = SALESMAN; // server: spvAck=false sesudah batal
    await dialog.getByRole("button", { name: "Batalkan tanda dibaca" }).click();
    await expect(dialog).toBeHidden();
    const ack = tulis.filter((r) => r.url().includes("/reports/ack")).map((r) => [r.method(), r.postDataJSON()]);
    expect(ack).toEqual([["POST", { salesCode: "S-01", date: HARI_INI, ack: false }], ["POST", { salesCode: "S-01", date: HARI_INI, ack: false }]]);
    await expect(main.getByRole("status").filter({ hasText: "Tanda dibaca laporan SALES A dibatalkan." })).toBeVisible();
    await expect(kartu.getByText("Menunggu dibaca")).toBeVisible(NAV);
    await expect(kartu.getByRole("button", { name: "Tandai sudah dibaca" })).toBeVisible();
});

test("Dashboard SPV: Kosong dan Galat berbeda; galat tidak menampilkan angka nol", async ({ page }) => {
    const opsi: Opsi = { scope: SCOPE.spv, dashboard: [] };
    await mockApi(page, opsi);
    await page.goto("/form-kontrol/spv-dashboard", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Belum ada salesman di tim SPV A")).toBeVisible(NAV);
    await expect(main.getByRole("alert")).toHaveCount(0);

    opsi.dashboardGagal = true;
    await page.reload();
    const galat = main.getByRole("alert").filter({ hasText: "Dashboard gagal dimuat." });
    await expect(galat).toBeVisible(NAV);
    await expect(galat).toContainText("Angka tidak ditampilkan agar tidak terbaca sebagai nol.");
    await expect(main.getByText(/Belum ada salesman/)).toHaveCount(0);
    await expect(main.locator(".fi-kc")).toHaveCount(0);
    await expect(galat).not.toContainText("Internal server error");
    opsi.dashboardGagal = false;
    opsi.dashboard = SALESMAN;
    await galat.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("article", { name: "SALES A" })).toBeVisible();

    // 400 berbahasa Inggris dari server diterjemahkan, tidak diteruskan mentah.
    opsi.dashboardTanpaSpv = true;
    await page.reload();
    const tanpaSpv = main.getByRole("alert").filter({ hasText: "Dashboard gagal dimuat." });
    await expect(tanpaSpv).toContainText("Akun Anda belum tertaut ke nama SPV di Hierarki Sales.", NAV);
    await expect(tanpaSpv).not.toContainText("SPV name not found");
});

test("Dashboard SPV (admin): pilih SPV dari Hierarki → query spvName; daftar gagal → isian teks + VariantNote", async ({ page }) => {
    const opsi: Opsi = { scope: SCOPE.admin };
    const { baca } = await mockApi(page, opsi);
    await page.goto("/form-kontrol/spv-dashboard", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Pilih SPV untuk melihat timnya")).toBeVisible(NAV);
    expect(baca.some((u) => u.pathname.endsWith("/spv-dashboard"))).toBe(false); // admin tanpa SPV tidak memicu 400
    const pilih = main.getByLabel("SPV", { exact: true });
    await expect(pilih.locator("option")).toHaveText(["Pilih SPV…", "SPV A", "SPV B"]);
    await pilih.selectOption("SPV B");
    await expect(page).toHaveURL(/spv=SPV(\+|%20)B/);
    await expect(main.getByRole("article", { name: "SALES A" })).toBeVisible(NAV);
    const q = baca.filter((u) => u.pathname.endsWith("/spv-dashboard")).at(-1)!;
    expect(q.searchParams.get("spvName")).toBe("SPV B");
    expect(q.searchParams.get("date")).toBe(HARI_INI);

    opsi.profilesGagal = true;
    await page.goto("/form-kontrol/spv-dashboard", NAV);
    await expect(main.locator('aside[aria-label="Usulan it05 #16"]')).toBeVisible(NAV);
    await main.getByLabel("Nama SPV").fill("SPV A");
    await main.getByRole("button", { name: "Tampilkan" }).click();
    await expect(page).toHaveURL(/spv=SPV(\+|%20)A/);
    await expect.poll(() => baca.filter((u) => u.pathname.endsWith("/spv-dashboard")).at(-1)?.searchParams.get("spvName")).toBe("SPV A");
});

test("Kontrol JKS: templat terunduh; impor lewat dialog (pratinjau, FormData file), imported dan skipped tampil", async ({ page }) => {
    const { tulis } = await mockApi(page, { scope: SCOPE.admin });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/form-kontrol?tab=jks", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("table").getByText("TOKO A")).toBeVisible(NAV);
    await expect(main.getByText("1 toko di halaman ini belum punya hari kunjungan.")).toBeVisible();

    const [unduh] = await Promise.all([page.waitForEvent("download"), main.getByRole("button", { name: "Unduh templat" }).click()]);
    expect(unduh.suggestedFilename()).toBe("templat-jks.xlsx");
    const wb = XLSX.read(readFileSync(await unduh.path()));
    expect(wb.SheetNames[0]).toBe("JKS");
    expect(XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Petunjuk, { header: 1 }).find((r) => r[0] === "Channel")?.[1]).toMatch(/^Wajib diisi: GT, TT, atau MT/);
    const header = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.JKS, { header: 1 })[0];
    expect(header).toEqual(["Kode Sales", "Nama Sales", "Kode Toko", "Nama Toko", "Market", "Channel", "Alamat", "Kota", "Hari", "Pola", "Area", "Rayon", "Principle", "Frekuensi"]);

    await main.getByRole("button", { name: "Impor Excel" }).click();
    const dialog = page.getByRole("dialog", { name: "Terapkan berkas JKS?" });
    await expect(dialog.getByRole("button", { name: "Terapkan" })).toBeDisabled();
    const isi = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(isi, XLSX.utils.aoa_to_sheet([
        ["Kode Sales", "Kode Toko", "Principle", "Hari", "Channel", "Kolom Aneh"],
        ["S-01", "C-01", "GODREJ", "Senin", "GT", "x"],
        ["S-01", "C-03", "GODREJ", "Selasa", "", "y"],
        ["", "C-04", "GODREJ", "Rabu", "MT", "z"],
    ]), "Sheet1");
    await dialog.locator('input[type="file"]').setInputFiles({ name: "jks-okt.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: XLSX.write(isi, { type: "buffer", bookType: "xlsx" }) as Buffer });
    await expect(dialog.locator(".fi-kv")).toContainText("Baris terbaca3");
    await expect(dialog.locator(".fi-kv")).toContainText("5: Kode Sales, Kode Toko, Principle, Hari, Channel");
    // Sel Channel kosong tersimpan kosong di server (bukan TT): peringatan, bukan blok.
    await expect(dialog.getByRole("status").filter({ hasText: "Kolom Channel kosong di 1 baris." })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Terapkan" })).toBeEnabled();
    await expect(dialog.locator(".fi-kv")).toContainText("Kolom Aneh (diabaikan)");
    expect(tulis).toHaveLength(0);
    await dialog.getByRole("button", { name: "Terapkan" }).click();
    await expect(dialog).toBeHidden();
    const post = tulis.find((r) => r.url().includes("/api/form-kontrol/jks"))!;
    expect(post.method()).toBe("POST");
    expect(post.headers()["content-type"]).toContain("multipart/form-data");
    const badan = post.postDataBuffer()!.toString("latin1");
    expect(badan).toContain('name="file"; filename="jks-okt.xlsx"');
    await expect(main.getByRole("status").filter({ hasText: "Impor JKS diterapkan." })).toContainText("jks-okt.xlsx: 2 baris ditulis, 1 baris dilewati");
    await page.screenshot({ path: "test-results/tim/jks-impor.png", fullPage: true });
});

test("Kontrol SM: isian tersimpan dimuat (#18); simpan lewat dialog; galat tidak ditelan", async ({ page }) => {
    const opsi: Opsi = {
        scope: SCOPE.sm,
        smControl: [{ smName: "SM A", date: HARI_INI, spvChecked: [{ name: "SPV A", note: "Pantau toko baru" }, { name: "SPV B", note: "" }], jksChecked: true, fotoChecked: false, deviations: [{ spv: "SPV B", catatan: "Telat briefing" }], followUp: "Cek ulang JKS Kamis", createdAt: kini }],
    };
    const { tulis, baca } = await mockApi(page, opsi);
    await page.goto("/form-kontrol?tab=sm-control", NAV);
    const main = page.locator("main");
    await expect(main.getByLabel("Catatan coaching SPV A")).toHaveValue("Pantau toko baru", NAV);
    await expect(main.getByLabel("JKS sudah dicek hari ini")).toBeChecked();
    await expect(main.getByLabel("Foto kunjungan sudah dimonitor")).not.toBeChecked();
    await expect(main.getByLabel("Catatan (baris 1)")).toHaveValue("Telat briefing");
    await expect(main.getByLabel("Tindak lanjut SM hari ini")).toHaveValue("Cek ulang JKS Kamis");
    await expect(main.getByText("Penyebab: Stok toko penuh.")).toBeVisible();
    const q = baca.find((u) => u.pathname.endsWith("/sm-control"))!;
    expect(q.searchParams.get("smName")).toBe("SM A");
    expect(q.searchParams.get("date")).toBe(HARI_INI);

    await main.getByLabel("Foto kunjungan sudah dimonitor").check();
    await expect(main.getByText("Draf belum disimpan")).toBeVisible();
    await main.getByRole("button", { name: "Simpan Kontrol SM" }).click();
    const dialog = page.getByRole("dialog", { name: "Simpan Kontrol SM hari ini?" });
    await dialog.getByRole("button", { name: "Simpan" }).click();
    await expect(dialog).toBeHidden();
    const body = tulis.find((r) => r.url().includes("/sm-control"))!.postDataJSON();
    expect(body).toEqual({
        smName: "SM A", date: HARI_INI,
        spvChecked: [{ name: "SPV A", note: "Pantau toko baru" }, { name: "SPV B", note: "" }],
        jksChecked: true, fotoChecked: true, coachingNote: "SPV A: Pantau toko baru",
        deviations: [{ spv: "SPV B", catatan: "Telat briefing" }], followUp: "Cek ulang JKS Kamis",
    });
    await expect(main.getByText("Kontrol SM tersimpan.")).toBeVisible();
    await expect(main.getByText("Draf belum disimpan")).toHaveCount(0);

    opsi.smControlGagal = true;
    await page.reload();
    const galat = main.getByRole("alert").filter({ hasText: "Kontrol SM belum berhasil dimuat." });
    await expect(galat).toBeVisible(NAV);
    await expect(galat).toContainText("Isian Kontrol SM yang tersimpan belum berhasil dimuat.");
    await expect(main.getByRole("button", { name: "Simpan Kontrol SM" })).toHaveCount(0);
});

test("Briefing dan Hierarki: tulis lewat dialog, payload sama dengan hari ini (tanggal WITA)", async ({ page }) => {
    const opsi: Opsi = { scope: SCOPE.spv };
    const { tulis } = await mockApi(page, opsi);
    await page.goto("/form-kontrol?tab=briefing", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Pagi: tersimpan 1×")).toBeVisible(NAV);
    await main.getByLabel("JKS layak dijalankan hari ini").check();
    await main.getByLabel("Toko yang dibahas").fill("TOKO A");
    await main.getByRole("button", { name: "Simpan briefing pagi" }).click();
    const dialog = page.getByRole("dialog", { name: "Simpan briefing pagi?" });
    await expect(dialog).toContainText("menyimpan lagi menambah catatan baru");
    await dialog.getByRole("button", { name: "Simpan briefing" }).click();
    await expect(dialog).toBeHidden();
    expect(tulis.find((r) => r.url().includes("/briefing"))!.postDataJSON()).toEqual({
        spvName: "SPV A", date: HARI_INI, session: "pagi", agenda: ["JKS layak dijalankan hari ini"], tokoDialas: "TOKO A", penyebab: "", solusi: "",
    });

    opsi.scope = SCOPE.admin;
    await page.goto("/form-kontrol?tab=hierarki", NAV);
    await main.getByLabel("SPV SALES C").fill("SPV A");
    await main.getByRole("listitem").filter({ hasText: "SALES C" }).getByRole("button", { name: "Simpan" }).click();
    const d2 = page.getByRole("dialog", { name: "Ubah hierarki SALES C?" });
    await expect(d2).toContainText("— → SPV A");
    await d2.getByRole("button", { name: "Simpan hierarki" }).click();
    await expect(d2).toBeHidden();
    const put = tulis.find((r) => r.method() === "PUT")!;
    expect(put.postDataJSON()).toEqual({ salesCode: "S-03", spvName: "SPV A", smName: null });
});

test("Briefing: Simpan dikunci saat daftar tersimpan galat dan setelah jawaban tidak pasti (cegah catatan ganda); Frekuensi SM tanpa tim", async ({ page }) => {
    const opsi: Opsi = { scope: SCOPE.spv, briefingGagal: true, briefingPostStatus: 502 };
    const { tulis } = await mockApi(page, opsi);
    await page.goto("/form-kontrol?tab=briefing", NAV);
    const main = page.locator("main");
    const simpan = main.getByRole("button", { name: "Simpan briefing pagi" });
    await expect(main.getByRole("alert").filter({ hasText: "Briefing tersimpan belum berhasil dimuat." })).toBeVisible(NAV);
    await expect(simpan).toBeDisabled();
    await expect(main.getByText("Briefing tersimpan belum termuat; simpan dikunci agar tidak tercatat ganda.")).toBeVisible();

    opsi.briefingGagal = false;
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(simpan).toBeEnabled(NAV);
    await simpan.click();
    const dialog = page.getByRole("dialog", { name: "Simpan briefing pagi?" });
    await dialog.getByRole("button", { name: "Simpan briefing" }).click();
    await expect(dialog.getByRole("alert")).toContainText("hasilnya belum pasti");
    await expect(dialog.getByRole("alert")).not.toContainText("Bad Gateway");
    await expect(dialog.getByRole("button", { name: "Simpan briefing" })).toBeDisabled(); // tidak bisa ditekan ulang
    expect(tulis.filter((r) => r.url().includes("/briefing"))).toHaveLength(1);
    await dialog.getByRole("button", { name: "Batal" }).click();
    await expect(simpan).toBeDisabled();
    const strip = main.getByRole("status").filter({ hasText: "Hasil simpan terakhir belum pasti." });
    await strip.getByRole("button", { name: "Muat ulang" }).click();
    await expect(simpan).toBeEnabled(NAV);

    opsi.scope = { role: "sm", salesName: "SM B", smName: "SM B", allowedSalesCodes: [] };
    await page.goto("/form-kontrol?tab=frekuensi", NAV);
    await expect(main.getByText("Belum ada salesman di tim Anda")).toBeVisible(NAV);
    await expect(main.getByText("Pilih salesman dan principal")).toHaveCount(0);
});

test("Ponsel 390 px: shell, Dashboard SPV, dan JKS tanpa gulir menyamping; Tandai sudah dibaca ≥ 44 px", async ({ page }) => {
    const opsi: Opsi = { scope: SCOPE.spv };
    await mockApi(page, opsi);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/form-kontrol?tab=jks", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("list", { name: "JKS aktif" }).getByText("TOKO A")).toBeVisible(NAV);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/tim/ponsel-jks.png", fullPage: true });
    await page.goto("/form-kontrol/spv-dashboard", NAV);
    const tombol = main.getByRole("article", { name: "SALES A" }).getByRole("button", { name: "Tandai sudah dibaca" });
    await expect(tombol).toBeVisible(NAV);
    expect((await tombol.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/tim/ponsel-spv.png", fullPage: true });
    await page.goto("/form-kontrol?tab=briefing", NAV);
    await expect(main.getByRole("button", { name: "Simpan briefing pagi" })).toBeVisible(NAV);
    await noOverflow(page);
});
