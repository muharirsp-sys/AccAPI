/*
 * Tujuan: Fiori S5 Lapangan (it05) — layar salesman: Rute hari ini (Default: kunjungan berjalan paling atas, "N hari order bulan ini",
 *   tautan kunjungan bertanggal WITA, Kirim status lewat dialog → payload per toko; Kosong; Galat ≠ kosong, tanpa sinyal disebut sinyal),
 *   tanggal WITA sebelum 08.00 dengan jam tiruan (Rute, Laporan harian, Order Sales), Kunjungan (status tersimpan tampil lagi, Kembali di
 *   setiap langkah, checkbox asli 24 px dalam baris 56 px, galat merch tampil di langkahnya dan tidak maju, tanpa sinyal: foto tetap +
 *   Coba lagi), Order Sales (pemilih toko rute, harga per baris, 409 missing/wrong_unit di barisnya, nomor permintaan, galat Order saya ≠
 *   kosong), ponsel 390 px layar sentuh (tanpa gulir menyamping, kontrol ≥ 44 px). Temuan peninjau: P6 Kirim status membaca ulang rute
 *   + hanya salesman pemilik, P1 jawaban tidak pasti menahan Kirim order, P2 ketikan toko lain tidak hilang, P3 Lanjut tanpa tulis ulang,
 *   P4 lewat 00.00 isian tidak hilang, laporan Kemarin. Tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-lapangan-salesman.spec.ts --config playwright.fiori-local.config.ts --workers=1 --output=test-results/salesman`.
 * Dependensi: /api/form-kontrol/*, /api/upload/form-kontrol, /api/customers/lookup, /api/outlet-channel, /api/items/units, /api/orders/preview
 *   di-mock dengan page.route; FastAPI Web Sales (dev: http://localhost:8000) di-mock dengan header CORS. Tidak menyentuh DB.
 * Side Effects: Tangkapan di test-results/salesman.
 */
import { expect, test, type Locator, type Page, type Request, type Route } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
const CORS = { "access-control-allow-origin": "http://localhost:3010", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
const fastapi = (r: Route, body: unknown, status = 200, html?: string) => r.request().method() === "OPTIONS"
    ? r.fulfill({ status: 204, headers: CORS })
    : r.fulfill({ status, headers: { ...CORS, "content-type": html ? "text/html" : "application/json" }, body: html ?? JSON.stringify(body) });
// PNG 1×1 untuk foto unggahan dan berkas "kamera".
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const SCOPE = { role: "salesman", salesCode: "S-01", salesName: "SALES A", spvName: "SPV A", allowedSalesCodes: ["S-01"] };
const jam = (hhmm: string) => `${HARI_INI}T${hhmm}:00+08:00`;
const rute = (custCode: string, custName: string, over: Record<string, unknown>) => ({
    id: `a-${custCode}`, salesCode: "S-01", custCode, custName, principle: "GODREJ", aoStatus: null, noOrderReasonCode: null, noOrderNote: null,
    monthlyOrderCount: 0, needsAttention: false, checkinAt: null, checkoutAt: null, ...over,
});
const RUTE = [
    rute("C-01", "TOKO A", { aoStatus: "ordered", monthlyOrderCount: 3, checkinAt: jam("07:40"), checkoutAt: jam("07:58") }),
    rute("C-02", "TOKO B", { monthlyOrderCount: 4 }),
    rute("C-03", "TOKO C", { aoStatus: "not_order", noOrderReasonCode: "R01", noOrderNote: "stok lama", needsAttention: true }),
    rute("C-04", "TOKO D", { aoStatus: "not_visited", monthlyOrderCount: 1, checkinAt: jam("08:10") }),
];
const REASONS = [
    { id: "R01", reasonCode: "R01", label: "Stok masih cukup", category: "stok" },
    { id: "R03", reasonCode: "R03", label: "Produk belum terpajang", category: "produk" },
    { id: "R14", reasonCode: "R14", label: "Lainnya", category: "lainnya" },
];
const STORE = { id: "j3", salesCode: "S-01", salesName: "SALES A", custCode: "C-03", custName: "TOKO C", market: "GT", alamat: "JL. CONTOH 1", kota: "KOTA A", principle: "GODREJ", visitFrequency: 4 };
const AO_CHECKIN = { id: "a-C-03", status: "not_order", noOrderReasonCode: "R03", noOrderNote: "stok lama", checkinAt: jam("08:31"), checkinPhotoUrl: "/api/uploads/form-kontrol/in.jpg", checkoutAt: null, checkoutPhotoUrl: null };

type Opsi = {
    scope?: unknown; rute?: unknown[]; ruteGagal?: "500" | "putus";
    visit?: { store: unknown; ao: unknown; merch: unknown } | "404";
    merchGagal?: number; uploadPutus?: boolean; tundaPostMs?: number;
    /** Tanggal laporan yang sudah terkirim (server). */
    laporanTerkirim?: string[];
};

/** /api/form-kontrol/* + unggah foto dimock; `opsi` dibaca tiap permintaan (bisa diubah di tengah tes). */
async function mockFk(page: Page, opsi: Opsi) {
    const tulis: Request[] = [];
    const baca: URL[] = [];
    let unggah = 0;
    await page.route("**/api/uploads/form-kontrol/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await page.route("**/api/upload/form-kontrol", (r) => {
        unggah++;
        if (opsi.uploadPutus) return r.abort("internetdisconnected");
        tulis.push(r.request());
        return r.fulfill(json({ url: "/api/uploads/form-kontrol/baru.jpg" }));
    });
    await page.route("**/api/form-kontrol/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace("/api/form-kontrol/", "");
        if (req.method() === "GET") baca.push(url); else tulis.push(req);
        if (p === "my-scope") return route.fulfill(json(opsi.scope ?? SCOPE));
        if (p === "reasons") return route.fulfill(json({ rows: REASONS }));
        if (p === "ao-control" && req.method() === "GET") {
            if (opsi.ruteGagal === "putus") return route.abort("internetdisconnected");
            if (opsi.ruteGagal === "500") return route.fulfill(json({ error: "Internal server error" }, 500));
            return route.fulfill(json({ rows: opsi.rute ?? RUTE, summary: {}, date: url.searchParams.get("date") }));
        }
        if (p === "visit") {
            if (opsi.visit === "404") return route.fulfill(json({ error: "Store not found" }, 404));
            return route.fulfill(json(opsi.visit ?? { store: STORE, ao: AO_CHECKIN, merch: null }));
        }
        if (p === "merchandising" && opsi.merchGagal) { opsi.merchGagal--; return route.fulfill(json({ error: "Internal server error" }, 500)); }
        if (req.method() === "POST" && opsi.tundaPostMs) await new Promise((r) => setTimeout(r, opsi.tundaPostMs));
        if (p === "reports" && req.method() === "GET") {
            const terkirim = (opsi.laporanTerkirim ?? []).includes(url.searchParams.get("date") ?? "");
            return route.fulfill(json({ rows: [{ id: null, salesCode: "S-01", date: url.searchParams.get("date"), totalTokoJks: 18, totalOrder: 11, totalActive: 0, totalNotOrder: 4, totalNotVisited: 3,
                tindakLanjut: terkirim ? "Kunjungi ulang TOKO C" : "", submittedAt: terkirim ? new Date().toISOString() : null, spvAck: false, spvAckAt: null }], total: 1 }));
        }
        if (p === "reports" && req.method() === "POST") opsi.laporanTerkirim = [...(opsi.laporanTerkirim ?? []), String(req.postDataJSON().date)];
        return route.fulfill(json({ success: true, id: "x" }));
    });
    return { tulis, baca, unggah: () => unggah };
}
/**
 * Akun yang punya izin form_kontrol.view TANPA form_kontrol.submit. Preset admin LOCAL_AUTH_BYPASS tidak punya kunci form_kontrol.* sama
 * sekali (D-17) sehingga tombol tidak dikunci dan server yang memutuskan (alasanIzinFk). Untuk menguji penguncian, kunci view disuntik
 * ke payload RSC halaman /form-kontrol (hanya di tes): `permKeys` shell (IzinFkCtx) dan `izinFk` Kunjungan.
 */
async function izinTanpaSubmit(page: Page) {
    await page.route((u) => u.pathname.startsWith("/form-kontrol"), async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        const body = (await res.text())
            .replace(/izinFk\\":\[\]/g, 'izinFk\\":[\\"form_kontrol.view\\"]').replace(/izinFk":\[\]/g, 'izinFk":["form_kontrol.view"]')
            .replace(/permKeys\\":\[/g, 'permKeys\\":[\\"form_kontrol.view\\",').replace(/permKeys":\[/g, 'permKeys":["form_kontrol.view",');
        return route.fulfill({ status: res.status(), headers, body });
    });
}
const postKe = (tulis: Request[], akhir: string) => tulis.filter((r) => new URL(r.url()).pathname.endsWith(akhir)).map((r) => r.postDataJSON());

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
/** Semua kontrol yang terlihat di `root` ≥ 44 px (lebar & tinggi); checkbox/radio dinilai dari baris/labelnya. Tautan teks jejak halaman
 *  (.fi-crumb) dikecualikan: tujuannya sama dengan tombol 44 px di kaki halaman. */
async function target44(root: Locator) {
    const kecil = await root.evaluate((el) => {
        const out: string[] = [];
        el.querySelectorAll("button, a[href], select, textarea, input").forEach((node) => {
            const e = node as HTMLInputElement;
            if (e.closest(".fi-crumb")) return;
            const box = e.getBoundingClientRect();
            if (!box.width || !box.height) return;
            const nama = `${e.tagName} "${(e.getAttribute("aria-label") || e.textContent || e.name || "").trim().slice(0, 40)}"`;
            if (e.type === "checkbox" || e.type === "radio") {
                const host = (e.closest("li") ?? e.closest("label"))?.getBoundingClientRect();
                if (!host || host.height < 44) out.push(`${nama} baris ${host?.height}`);
                return;
            }
            if (Math.min(box.width, box.height) < 43.5) out.push(`${nama} ${Math.round(box.width)}×${Math.round(box.height)}`);
        });
        return out;
    });
    expect(kecil).toEqual([]);
}

test.use({
    permissions: ["geolocation"], geolocation: { latitude: -5.147665, longitude: 119.432732 },
    // Dokumen yang disajikan route.fulfill (izinTanpaSubmit) dianggap bukan jaringan lokal oleh Edge → skrip localhost diblokir dan halaman
    // tidak terhidrasi. Pemeriksaan Local Network Access dimatikan HANYA di peramban tes ini.
    launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights"] },
});
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Rute hari ini: kunjungan berjalan paling atas, hari order, tautan bertanggal WITA; Kirim status lewat dialog = payload per toko", async ({ page }) => {
    const m = await mockFk(page, {});
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/form-kontrol?tab=ao", NAV);
    const r = page.getByRole("region", { name: "Rute hari ini" });
    const daftar = r.getByRole("list", { name: "Toko di rute" });
    await expect(daftar.getByRole("listitem")).toHaveCount(4, NAV);
    // Sedang dikunjungi → tidak order → belum → selesai.
    await expect(daftar.getByRole("listitem")).toHaveText([/TOKO D/, /TOKO C/, /TOKO B/, /TOKO A/]);
    await expect(daftar.getByRole("listitem").first()).toContainText("Sedang dikunjungi · check-in 08.10");
    await expect(daftar.getByRole("listitem").first()).toContainText("Lanjutkan");
    await expect(r.getByText(/4 hari order bulan ini/)).toBeVisible();
    await expect(r.getByText(/≥ 2× tidak order bulan ini/)).toBeVisible();
    await expect(r.getByText("2 dari 4 dikunjungi")).toBeVisible(); // TOKO A + TOKO D sudah check-in
    await expect(daftar.getByRole("link", { name: /TOKO B/ })).toHaveAttribute("href", `/form-kontrol/visit/C-02?salesCode=S-01&principle=GODREJ&date=${HARI_INI}`);
    expect(m.baca.filter((u) => u.pathname.endsWith("/ao-control")).map((u) => u.searchParams.get("date"))).toContain(HARI_INI);

    await daftar.getByRole("button", { name: "Prioritas TOKO B" }).click();
    await expect(r.getByText(/1 tanda prioritas belum dikirim/)).toBeVisible();
    await r.getByRole("button", { name: "Kirim status rute hari ini…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading")).toHaveText("Kirim status 4 toko rute hari ini?");
    await expect(dlg).toContainText("Prioritas1");
    await page.screenshot({ path: "test-results/salesman/rute-dialog.png" });
    await dlg.getByRole("button", { name: "Kirim status", exact: true }).click();
    await expect(dlg).toBeHidden();
    const posts = postKe(m.tulis, "/ao-control");
    expect(posts).toHaveLength(4);
    expect(posts.find((p) => p.custCode === "C-02")).toEqual({ salesCode: "S-01", custCode: "C-02", principle: "GODREJ", date: HARI_INI, status: "priority", noOrderReasonCode: null, noOrderNote: null });
    expect(posts.find((p) => p.custCode === "C-03")).toEqual({ salesCode: "S-01", custCode: "C-03", principle: "GODREJ", date: HARI_INI, status: "not_order", noOrderReasonCode: "R01", noOrderNote: "stok lama" });
    expect(posts.find((p) => p.custCode === "C-04")).toMatchObject({ status: "not_visited" });
    await expect(r.getByRole("status").filter({ hasText: "Status 4 toko terkirim" })).toBeVisible();
    await page.screenshot({ path: "test-results/salesman/rute-default.png", fullPage: true });
});

test("Kirim status (P6): rute dibaca ulang sebelum dikirim — status kunjungan yang tersimpan sesudah layar dimuat tidak tertimpa; bacaan gagal = batal", async ({ page }) => {
    const opsi: Opsi = { rute: RUTE.map((x) => ({ ...x })) };
    const m = await mockFk(page, opsi);
    await page.goto("/form-kontrol?tab=ao", NAV);
    const r = page.getByRole("region", { name: "Rute hari ini" });
    const daftar = r.getByRole("list", { name: "Toko di rute" });
    await expect(daftar.getByRole("listitem")).toHaveCount(4, NAV);
    await daftar.getByRole("button", { name: "Prioritas TOKO B" }).click();
    await daftar.getByRole("button", { name: "Prioritas TOKO D" }).click();
    // Sesudah layar dimuat, salesman menyimpan ORDER untuk TOKO B dan TOKO D dari kunjungan (server berubah, layar ini belum dimuat ulang).
    opsi.rute = RUTE.map((x) => (x.custCode === "C-02" || x.custCode === "C-04" ? { ...x, aoStatus: "ordered", checkinAt: jam("09:00") } : { ...x }));

    // Bacaan ulang gagal → tidak ada yang dikirim, galat di dialog.
    opsi.ruteGagal = "500";
    await r.getByRole("button", { name: "Kirim status rute hari ini…" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Kirim status", exact: true }).click();
    await expect(dlg.getByRole("alert")).toContainText("Rute tidak bisa dibaca ulang sebelum dikirim, jadi tidak ada yang dikirim.");
    expect(postKe(m.tulis, "/ao-control")).toHaveLength(0);

    opsi.ruteGagal = undefined;
    await dlg.getByRole("button", { name: "Kirim status", exact: true }).click();
    await expect(dlg).toBeHidden();
    const posts = postKe(m.tulis, "/ao-control");
    expect(posts).toHaveLength(4);
    expect(posts.find((p) => p.custCode === "C-02")).toMatchObject({ status: "ordered" });
    expect(posts.find((p) => p.custCode === "C-04")).toMatchObject({ status: "ordered" });
    expect(posts.find((p) => p.custCode === "C-03")).toMatchObject({ status: "not_order", noOrderReasonCode: "R01", noOrderNote: "stok lama" });
    await expect(r.getByRole("status").filter({ hasText: "2 tanda prioritas tidak dikirim" })).toBeVisible();
});

test("Kirim status hanya untuk salesman pemilik rute: SPV memilih salesman timnya dan melihat baca-saja", async ({ page }) => {
    const m = await mockFk(page, { scope: { role: "spv", salesName: "SPV A", spvName: "SPV A", allowedSalesCodes: ["S-01", "S-02"] } });
    await page.goto("/form-kontrol?tab=ao", NAV);
    const r = page.getByRole("region", { name: "Rute hari ini" });
    await r.getByLabel("Salesman tim").selectOption("S-01", NAV);
    const daftar = r.getByRole("list", { name: "Toko di rute" });
    await expect(daftar.getByRole("listitem")).toHaveCount(4, NAV);
    const kirim = r.getByRole("button", { name: /Kirim status rute/ });
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Hanya salesman pemilik rute yang mengirim status rute; tampilan ini baca-saja.");
    await expect(daftar.getByRole("button", { name: "Prioritas TOKO B" })).toBeDisabled();
    expect(m.tulis).toHaveLength(0);
});

test("Rute hari ini: galat ≠ kosong; tanpa sinyal disebut sinyal; kosong = tidak ada rute", async ({ page }) => {
    const opsi: Opsi = { ruteGagal: "500" };
    await mockFk(page, opsi);
    await page.goto("/form-kontrol?tab=ao", NAV);
    const r = page.getByRole("region", { name: "Rute hari ini" });
    await expect(r.getByRole("alert")).toContainText("Rute gagal dimuat", NAV);
    await expect(r.getByRole("alert")).toContainText("Ini bukan rute kosong");
    await expect(r.getByText("Tidak ada rute terjadwal")).toHaveCount(0);
    await expect(r.getByRole("button", { name: "Kirim status rute hari ini…" })).toBeDisabled();
    opsi.ruteGagal = "putus";
    await r.getByRole("alert").getByRole("button", { name: "Coba lagi" }).click();
    await expect(r.getByRole("alert")).toContainText("tanpa sinyal");
    await page.screenshot({ path: "test-results/salesman/rute-galat.png", fullPage: true });
    opsi.ruteGagal = undefined;
    opsi.rute = [];
    await r.getByRole("alert").getByRole("button", { name: "Coba lagi" }).click();
    await expect(r.getByText("Tidak ada rute terjadwal hari ini")).toBeVisible();
    await expect(r.getByRole("alert")).toHaveCount(0);
    // Muat ulang yang gagal sesudah hasil kosong tetap galat, bukan "tidak ada rute".
    opsi.ruteGagal = "500";
    await r.getByRole("button", { name: "Muat ulang" }).click();
    await expect(r.getByRole("alert")).toContainText("Rute gagal dimuat");
    await expect(r.getByText("Tidak ada rute terjadwal")).toHaveCount(0);
});

test("Tanggal = WITA: 07.30 WITA (UTC masih kemarin) → rute, kirim status, laporan, dan order memakai tanggal WITA", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-08T23:30:00Z")); // Jumat 9 Okt 2026 07.30 WITA
    const m = await mockFk(page, {});
    await page.goto("/form-kontrol?tab=ao", NAV);
    const r = page.getByRole("region", { name: "Rute hari ini" });
    await expect(r.getByText("Jumat, 9 Okt 2026 · WITA")).toBeVisible(NAV);
    await expect(r.getByRole("list", { name: "Toko di rute" }).getByRole("link", { name: /TOKO B/ })).toHaveAttribute("href", /&date=2026-10-09$/);
    const tanggalGet = m.baca.filter((u) => u.pathname.endsWith("/ao-control")).map((u) => u.searchParams.get("date"));
    expect(tanggalGet.length).toBeGreaterThan(0);
    expect(new Set(tanggalGet)).toEqual(new Set(["2026-10-09"]));
    await r.getByRole("button", { name: "Kirim status rute hari ini…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim status", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(postKe(m.tulis, "/ao-control").map((p) => p.date)).toEqual(["2026-10-09", "2026-10-09", "2026-10-09", "2026-10-09"]);

    await page.goto("/form-kontrol?tab=laporan", NAV);
    const lap = page.getByRole("region", { name: "Laporan harian" });
    await expect(lap.getByText("Jumat, 9 Okt 2026 · WITA")).toBeVisible(NAV);
    expect(new Set(m.baca.filter((u) => u.pathname.endsWith("/reports")).map((u) => u.searchParams.get("date")))).toEqual(new Set(["2026-10-09", "2026-10-08"]));
    // Laporan kemarin (WITA) belum terkirim → strip; salesman bisa mengirimnya lewat pilihan "Kemarin" (tanpa pemilih tanggal bebas).
    await expect(lap.getByRole("status").filter({ hasText: "Laporan kemarin belum terkirim." })).toBeVisible();
    await expect(lap.locator('input[type="date"]')).toHaveCount(0);
    await lap.getByLabel("Tindak lanjut untuk SPV").fill("Kunjungi ulang TOKO C");
    await lap.getByRole("button", { name: "Kirim laporan ke SPV…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim laporan" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(postKe(m.tulis, "/reports")).toEqual([{ salesCode: "S-01", date: "2026-10-09", tindakLanjut: "Kunjungi ulang TOKO C" }]);
    await expect(lap.getByRole("status").filter({ hasText: "Laporan harian terkirim ke SPV" })).toBeVisible();
    await expect(lap.getByRole("button", { name: "Sudah terkirim" })).toBeDisabled();

    await lap.getByRole("button", { name: "Buka laporan kemarin" }).click();
    await expect(lap.getByText("Kamis, 8 Okt 2026 · WITA")).toBeVisible();
    await lap.getByLabel("Tindak lanjut untuk SPV").fill("Laporan terlewat: TOKO B tutup");
    await lap.getByRole("button", { name: "Kirim laporan ke SPV…" }).click();
    await expect(page.getByRole("dialog").getByRole("heading")).toHaveText("Kirim laporan harian kemarin ke SPV?");
    await page.getByRole("dialog").getByRole("button", { name: "Kirim laporan" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(postKe(m.tulis, "/reports").at(-1)).toEqual({ salesCode: "S-01", date: "2026-10-08", tindakLanjut: "Laporan terlewat: TOKO B tutup" });
    await lap.getByRole("button", { name: "Hari ini", exact: true }).click();
    await expect(lap.getByText("Laporan kemarin belum terkirim.")).toHaveCount(0);

    await page.route((u) => u.host === "localhost:8000", (rt) => fastapi(rt, { ok: true, requests: [], csrf_token: "t" }));
    await page.goto("/sales", NAV);
    await expect(page.locator("main").getByLabel("Tanggal order")).toHaveValue("2026-10-09", NAV);
});

test("Kunjungan: status tersimpan tampil lagi, Kembali di setiap langkah, galat merch tidak maju, checkbox 24 px dalam baris 56 px", async ({ page }) => {
    const opsi: Opsi = {};
    const m = await mockFk(page, opsi);
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(`/form-kontrol/visit/C-03?salesCode=S-01&principle=GODREJ&date=${HARI_INI}`, NAV);
    const main = page.locator("main");
    const langkah = main.getByRole("list", { name: "Langkah kunjungan" }).locator('[aria-current="step"]');
    await expect(main.getByRole("heading", { level: 1, name: "TOKO C" })).toBeVisible(NAV);
    await expect(langkah).toContainText("Status");
    // #5: status tersimpan tampil lagi (tetap wajib dikonfirmasi).
    await expect(main.getByRole("radio", { name: /TIDAK ORDER/ })).toBeChecked();
    await expect(main.getByLabel("Alasan tidak order")).toHaveValue("R03");
    await expect(main.getByLabel("Catatan")).toHaveValue("stok lama");
    await main.getByRole("button", { name: "Kembali", exact: true }).click();
    await expect(langkah).toContainText("Check-in");
    await expect(main.getByText("Check-in sudah tercatat.")).toBeVisible();
    await expect(main.getByRole("button", { name: "Rute hari ini" })).toBeVisible();
    await main.getByRole("button", { name: "Lanjut", exact: true }).click();
    await expect(langkah).toContainText("Status");
    await main.getByRole("button", { name: "Simpan & lanjut" }).click();
    await expect(langkah).toContainText("Merchandising");
    expect(postKe(m.tulis, "/ao-control")).toEqual([{ salesCode: "S-01", custCode: "C-03", principle: "GODREJ", date: HARI_INI, status: "not_order", noOrderReasonCode: "R03", noOrderNote: "stok lama" }]);
    // P3: Kembali ke Status yang sudah dikonfirmasi lalu maju tanpa perubahan = Lanjut tanpa menulis ulang.
    await main.getByRole("button", { name: "Kembali", exact: true }).click();
    await expect(langkah).toContainText("Status");
    await expect(main.getByText("Tersimpan: TIDAK ORDER.")).toBeVisible();
    await expect(main.getByRole("button", { name: "Simpan & lanjut" })).toHaveCount(0);
    await main.getByRole("button", { name: "Lanjut", exact: true }).click();
    await expect(langkah).toContainText("Merchandising");
    expect(postKe(m.tulis, "/ao-control")).toHaveLength(1);

    // #6: checkbox asli 24 px, baris ≥ 56 px, berlabel.
    const cek = main.getByRole("checkbox", { name: "Produk terlihat jelas" });
    const kotak = await cek.boundingBox();
    expect(Math.round(kotak!.width)).toBe(24);
    expect(Math.round(kotak!.height)).toBe(24);
    const baris = await main.getByRole("list", { name: "Merchandising" }).getByRole("listitem").first().boundingBox();
    expect(baris!.height).toBeGreaterThanOrEqual(56);
    const simpan = main.getByRole("button", { name: "Simpan & lanjut" });
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", "Lengkapi 6 butir lagi");
    for (const c of await main.getByRole("checkbox").all()) await c.check();
    await page.screenshot({ path: "test-results/salesman/kunjungan-merch.png", fullPage: true });

    // #7: galat simpan merch tampil di langkah ini, langkah tidak maju, tidak ada "Gagal check-out".
    opsi.merchGagal = 1;
    await simpan.click();
    await expect(main.getByRole("alert")).toContainText("Merchandising belum tersimpan.");
    await expect(langkah).toContainText("Merchandising");
    await expect(main.getByText(/check-out/i).filter({ hasText: "Gagal" })).toHaveCount(0);
    await simpan.click();
    await expect(langkah).toContainText("Check-out");
    const merch = postKe(m.tulis, "/merchandising");
    expect(merch.at(-1)).toEqual({ salesCode: "S-01", custCode: "C-03", principle: "GODREJ", date: HARI_INI, produkJelas: true, displayRapi: true, dibersihkan: true, ditataulang: true, posisiMudah: true, semuaSku: true, stepPhotos: null, note: null });
    await expect(main.getByText("TIDAK ORDER · R03 · Produk belum terpajang")).toBeVisible();
    // Kembali dari Check-out → Merchandising tersimpan (Lanjut tanpa kirim ulang).
    await main.getByRole("button", { name: "Kembali", exact: true }).click();
    await expect(langkah).toContainText("Merchandising");
    await expect(main.getByRole("checkbox", { name: "Seluruh SKU terpajang" })).toBeChecked();
    await main.getByRole("button", { name: "Lanjut", exact: true }).click();
    await expect(langkah).toContainText("Check-out");
    expect(postKe(m.tulis, "/merchandising")).toHaveLength(2);
    expect(postKe(m.tulis, "/checkout")).toHaveLength(0);
});

test("Kunjungan: toko di luar JKS = kosong; galat muat ≠ kosong", async ({ page }) => {
    const opsi: Opsi = { visit: "404" };
    await mockFk(page, opsi);
    await page.goto(`/form-kontrol/visit/C-99?salesCode=S-01&principle=GODREJ&date=${HARI_INI}`, NAV);
    const main = page.locator("main");
    await expect(main.getByText("Toko ini tidak ada di JKS Anda")).toBeVisible(NAV);
    await page.route("**/api/form-kontrol/visit**", (r) => r.abort("internetdisconnected"));
    await page.reload();
    await expect(main.getByRole("alert")).toContainText("Data kunjungan gagal dimuat", NAV);
    await expect(main.getByRole("alert")).toContainText("tanpa sinyal");
    await expect(main.getByText("Toko ini tidak ada di JKS Anda")).toHaveCount(0);
});

test("Kunjungan tanpa sinyal: foto check-in tetap di layar, langkah tidak maju, Coba lagi mengirim foto yang sama", async ({ page }) => {
    const opsi: Opsi = { visit: { store: STORE, ao: null, merch: null }, uploadPutus: true };
    const m = await mockFk(page, opsi);
    await page.goto(`/form-kontrol/visit/C-03?salesCode=S-01&principle=GODREJ&date=${HARI_INI}`, NAV);
    const main = page.locator("main");
    const langkah = main.getByRole("list", { name: "Langkah kunjungan" }).locator('[aria-current="step"]');
    await expect(langkah).toContainText("Check-in", NAV);
    await main.getByRole("button", { name: "Ambil foto check-in" }).click();
    const kamera = page.getByRole("dialog", { name: "Foto Bukti Kunjungan" });
    await kamera.locator('input[type="file"]').setInputFiles({ name: "toko.png", mimeType: "image/png", buffer: PNG });
    await kamera.getByRole("button", { name: /Gunakan/ }).click();
    await expect(kamera).toBeHidden();
    const strip = main.getByRole("alert");
    await expect(strip).toContainText("Foto check-in belum terkirim.");
    await expect(strip).toContainText("tanpa sinyal");
    await expect(strip).toContainText("Foto tetap di layar ini");
    await expect(main.getByRole("img", { name: "Foto yang belum terkirim" })).toBeVisible();
    await expect(langkah).toContainText("Check-in");
    expect(postKe(m.tulis, "/checkin")).toHaveLength(0);
    await page.screenshot({ path: "test-results/salesman/kunjungan-tanpa-sinyal.png", fullPage: true });

    opsi.uploadPutus = false;
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(langkah).toContainText("Status");
    expect(m.unggah()).toBe(2);
    expect(postKe(m.tulis, "/checkin")).toEqual([expect.objectContaining({
        salesCode: "S-01", custCode: "C-03", principle: "GODREJ", date: HARI_INI, photoUrl: "/api/uploads/form-kontrol/baru.jpg", lat: -5.147665, lng: 119.432732,
    })]);
    const fd = m.tulis.find((r) => r.url().endsWith("/api/upload/form-kontrol"))!.postData() ?? "";
    expect(fd).toContain('name="salesName"');
    expect(fd).toContain('name="lat"');
});

test("Akun form_kontrol.view tanpa submit: tombol tulis nonaktif dengan alasan, tidak disembunyikan", async ({ page }) => {
    const m = await mockFk(page, {});
    await izinTanpaSubmit(page);
    await page.goto("/form-kontrol?tab=ao", NAV);
    const r = page.getByRole("region", { name: "Rute hari ini" });
    const kirim = r.getByRole("button", { name: "Kirim status rute hari ini…" });
    await expect(kirim).toBeDisabled(NAV);
    await expect(kirim).toHaveAttribute("title", /belum punya izin/);
    await page.goto(`/form-kontrol/visit/C-03?salesCode=S-01&principle=GODREJ&date=${HARI_INI}`, NAV);
    const main = page.locator("main");
    await expect(main.getByRole("status").filter({ hasText: "Hanya lihat." })).toBeVisible(NAV);
    await expect(main.getByRole("button", { name: "Simpan & lanjut" })).toHaveAttribute("title", /belum punya izin/);
    expect(m.tulis).toHaveLength(0);
});

test("Toko tidak order + Laporan harian: galat ≠ kosong/nol; simpan alasan per toko = payload lama dengan tanggal WITA", async ({ page }) => {
    const opsi: Opsi = { ruteGagal: "500" };
    const m = await mockFk(page, opsi);
    await page.goto("/form-kontrol?tab=no-order", NAV);
    const no = page.getByRole("region", { name: "Toko tidak order" });
    await expect(no.getByRole("alert")).toContainText("Toko tidak order gagal dimuat", NAV);
    await expect(no.getByText("Tidak ada toko berstatus tidak order")).toHaveCount(0);
    opsi.ruteGagal = undefined;
    await no.getByRole("alert").getByRole("button", { name: "Coba lagi" }).click();
    const toko = no.getByRole("listitem", { name: "TOKO C" });
    await expect(toko).toContainText("Alasan tersimpan");
    await expect(toko.getByLabel("Alasan tidak order")).toHaveValue("R01");
    await toko.getByLabel("Alasan tidak order").selectOption("R14");
    await toko.getByLabel("Catatan").fill("toko tutup");
    await expect(toko).toContainText("Belum disimpan");
    await toko.getByRole("button", { name: "Simpan alasan" }).click();
    await expect(toko).toContainText("Alasan tersimpan");
    expect(postKe(m.tulis, "/ao-control")).toEqual([{ salesCode: "S-01", custCode: "C-03", principle: "GODREJ", date: HARI_INI, status: "not_order", noOrderReasonCode: "R14", noOrderNote: "toko tutup" }]);
    await expect(no.getByText("usulan Toko tutup", { exact: false })).toBeVisible();
    await page.screenshot({ path: "test-results/salesman/toko-tidak-order.png", fullPage: true });

    await page.route("**/api/form-kontrol/reports**", (r) => r.fulfill(json({ error: "Internal server error" }, 500)));
    await page.goto("/form-kontrol?tab=laporan", NAV);
    const lap = page.getByRole("region", { name: "Laporan harian" });
    await expect(lap.getByRole("alert")).toContainText("Laporan gagal dimuat", NAV);
    await expect(lap.getByRole("alert")).toContainText("Angka tidak ditampilkan agar tidak terbaca sebagai nol.");
    await expect(lap.getByText("Total toko JKS")).toHaveCount(0);
});

test("Toko tidak order (P2): ketikan toko lain selama simpan berjalan tidak hilang", async ({ page }) => {
    const opsi: Opsi = { rute: [...RUTE, rute("C-05", "TOKO E", { aoStatus: "not_order", noOrderReasonCode: "R01", noOrderNote: "" })], tundaPostMs: 1500 };
    const m = await mockFk(page, opsi);
    await page.goto("/form-kontrol?tab=no-order", NAV);
    const no = page.getByRole("region", { name: "Toko tidak order" });
    const c = no.getByRole("listitem", { name: "TOKO C" });
    const e = no.getByRole("listitem", { name: "TOKO E" });
    await expect(c.getByLabel("Alasan tidak order")).toHaveValue("R01", NAV);
    await c.getByLabel("Catatan").fill("catatan C");
    await c.getByRole("button", { name: "Simpan alasan" }).click();
    await e.getByLabel("Catatan").fill("catatan E belum disimpan"); // selama simpan C berjalan
    await expect(c).toContainText("Alasan tersimpan");
    await expect(e.getByLabel("Catatan")).toHaveValue("catatan E belum disimpan");
    await expect(e).toContainText("Belum disimpan");
    expect(postKe(m.tulis, "/ao-control")).toEqual([expect.objectContaining({ custCode: "C-03", noOrderNote: "catatan C" })]);
});

test("Laporan (P4): lewat 00.00 WITA tindak lanjut yang diketik tidak hilang dan tanggal tidak berganti diam-diam", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-08T15:59:30Z")); // 23.59.30 WITA 8 Okt
    const m = await mockFk(page, {});
    await page.goto("/form-kontrol?tab=laporan", NAV);
    const lap = page.getByRole("region", { name: "Laporan harian" });
    const ta = lap.getByLabel("Tindak lanjut untuk SPV");
    await ta.fill("TOKO C stok penuh, kunjungi ulang Kamis", NAV);
    await page.clock.setFixedTime(new Date("2026-10-08T16:00:30Z")); // 00.00.30 WITA 9 Okt
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(lap.getByRole("status").filter({ hasText: "Tanggal sudah berganti." })).toBeVisible();
    await ta.press("End");
    await ta.pressSequentially(".");
    await expect(ta).toHaveValue("TOKO C stok penuh, kunjungi ulang Kamis.");
    await expect(lap.getByText("Kamis, 8 Okt 2026 · WITA")).toBeVisible();
    expect(new Set(m.baca.filter((u) => u.pathname.endsWith("/reports")).map((u) => u.searchParams.get("date")))).toEqual(new Set(["2026-10-08", "2026-10-07"]));
    // Pilihan eksplisit pindah ke hari baru; ketikan 8 Okt tetap tersimpan sebagai "Kemarin".
    await lap.getByRole("button", { name: "Muat Jumat, 9 Okt 2026" }).click();
    await expect(lap.getByText("Jumat, 9 Okt 2026 · WITA")).toBeVisible();
    await lap.getByRole("button", { name: "Kemarin", exact: true }).click();
    await expect(lap.getByLabel("Tindak lanjut untuk SPV")).toHaveValue("TOKO C stok penuh, kunjungi ulang Kamis.");
});

/** Order Sales: master + pratinjau di Next, Web Sales di FastAPI :8000. */
async function mockOrder(page: Page, opsi: { orderGagal?: boolean; terkirim?: boolean; postTidakPasti?: boolean }) {
    const kirim: unknown[] = [];
    const pratinjau: Array<{ lines: Array<{ code: string; unit: string; quantity: string }> }> = [];
    const ID = "3f2a9c1e-77aa-4b3c-9d10-aa00bb11cc22";
    await page.route((u) => u.pathname === "/api/customers/lookup", (r) => r.fulfill(json({ ok: true, no: "C-01", found: true, name: "TOKO A", area: "AREA A", priceCategoryName: "GROSIR" })));
    await page.route((u) => u.pathname === "/api/outlet-channel", (r) => r.fulfill(json({ ok: true, channels: { "C-01": "GT" } })));
    await page.route((u) => u.pathname === "/api/items/units", (r) => {
        const code = new URL(r.request().url()).searchParams.get("code");
        return r.fulfill(json({ ok: true, code, found: true, name: code === "A-1" ? "BARANG A" : "BARANG B", units: code === "A-1" ? ["KRT", "PCS"] : ["LSN"] }));
    });
    await page.route((u) => u.pathname === "/api/orders/preview", (r) => {
        const b = r.request().postDataJSON() as (typeof pratinjau)[number];
        pratinjau.push(b);
        if (b.lines.some((l) => l.code === "A-1" && l.unit === "PCS")) {
            return r.fulfill(json({ ok: false, error: "Satuan PCS tidak ada di master untuk A-1 (tersedia: KRT)", wrong_unit: [{ code: "A-1", unit: "PCS", known_units: ["KRT"] }] }, 409));
        }
        if (b.lines.some((l) => l.code === "B-2")) return r.fulfill(json({ ok: false, error: "Harga belum tersedia dari Accurate untuk: B-2", missing: ["B-2"] }, 409));
        return r.fulfill(json({ ok: true, lines: b.lines, prices: [{ code: "A-1", unit: "KRT", price: 576000, source: "kategori", priceCategoryName: "GROSIR" }],
            result: { gross: "1152000.00", discount: "57600.00", net: "1094400.00", bonuses: [] }, suggestions: [] }));
    });
    await page.route((u) => u.host === "localhost:8000", (r) => {
        const p = new URL(r.request().url()).pathname;
        if (p === "/api/me") return fastapi(r, { csrf_token: "t" });
        if (p === "/websales/orders" && r.request().method() === "POST") {
            kirim.push(r.request().postDataJSON());
            opsi.terkirim = true;
            // Order SUDAH tersimpan, tetapi proxy memutus jawaban (502 HTML) → hasil tidak pasti di layar.
            if (opsi.postTidakPasti) return fastapi(r, null, 502, "<html>Bad Gateway</html>");
            return fastapi(r, { ok: true, request: { id: ID, status: "pending" } });
        }
        if (p === "/websales/orders") {
            if (opsi.orderGagal && !opsi.terkirim) return fastapi(r, { detail: "database is locked" }, 500);
            return fastapi(r, { ok: true, requests: opsi.terkirim ? [{ id: ID, outlet: "TOKO A", channel: "GT", order_date: HARI_INI, customer_no: "C-01", status: "pending", created_at: new Date().toISOString(), pulled_at: null }] : [] });
        }
        return fastapi(r, { ok: true });
    });
    return { kirim, pratinjau };
}

test("Order Sales: toko rute, harga per baris, 409 per baris, nomor permintaan; galat Order saya ≠ kosong", async ({ page }) => {
    const opsi = { orderGagal: true };
    const m = await mockOrder(page, opsi);
    await page.addInitScript((t) => sessionStorage.setItem("fk-rute-hari-ini", JSON.stringify({ tanggal: t, salesCode: "S-01", toko: [{ kode: "C-01", nama: "TOKO A" }] })), HARI_INI);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/sales", NAV);
    const main = page.locator("main");
    const saya = main.getByRole("region", { name: "Order saya" });
    await expect(saya.getByRole("alert")).toContainText("Order saya gagal dimuat", NAV);
    await expect(saya.getByText("Belum ada order terkirim")).toHaveCount(0);

    await main.getByLabel("Toko di rute hari ini").selectOption({ label: "TOKO A · C-01" });
    await expect(main.getByLabel("Kode pelanggan Accurate")).toHaveValue("C-01");
    await expect(main.getByLabel("Outlet")).toHaveValue("TOKO A");
    await expect(main.getByLabel("Channel")).toHaveValue("GT");

    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Kode barang").fill("A-1");
    await b1.locator("select").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    await main.getByRole("button", { name: "Tambah barang" }).click();
    const b2 = main.getByRole("listitem", { name: "Barang 2" });
    await b2.getByLabel("Kode barang").fill("B-2");
    await expect(b2.locator("select")).toHaveValue("LSN");
    await b2.getByLabel("Jumlah").fill("6");
    // #13: harga per baris; baris tanpa harga ditandai di barisnya; netto hanya dari baris berharga, dengan penjelasan.
    await expect(b1).toContainText("Harga ada");
    await expect(b1).toContainText("Rp 576.000 per KRT");
    await expect(b2).toContainText("Harga belum tersedia");
    const total = main.getByLabel("Perkiraan nilai order");
    await expect(total).toContainText("Bruto (yang sudah ada harganya)");
    await expect(total).toContainText("Rp 1.094.400");
    await expect(total).toContainText("1 barang belum berharga tidak ikut dihitung.");
    expect(m.pratinjau.at(-1)!.lines.map((l) => l.code)).toEqual(["A-1"]);
    expect(m.pratinjau.at(-1)).toMatchObject({ channel: "GT", order_date: HARI_INI, customer_no: "C-01" });
    await page.screenshot({ path: "test-results/salesman/order-harga.png", fullPage: true });

    // 409 wrong_unit tampil di barisnya; kirim tertahan dengan alasan.
    await b1.locator("select").selectOption("PCS");
    await expect(b1).toContainText("Satuan PCS tidak ada untuk A-1. Pilih KRT.");
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Perbaiki satuan barang 1");
    await page.screenshot({ path: "test-results/salesman/order-satuan.png", fullPage: true });
    await b1.locator("select").selectOption("KRT");
    await expect(b1).toContainText("Harga ada");
    await expect(kirim).toBeEnabled();

    await kirim.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading")).toHaveText("Kirim order untuk TOKO A?");
    await expect(dlg).toContainText("Rp 1.094.400");
    await dlg.getByRole("button", { name: "Kirim order" }).click();
    await expect(dlg).toBeHidden();
    expect(m.kirim).toEqual([{ outlet: "TOKO A", channel: "GT", order_date: HARI_INI, note: "", customer_no: "C-01",
        lines: [{ code: "A-1", unit: "KRT", quantity: "2" }, { code: "B-2", unit: "LSN", quantity: "6" }] }]);
    // #12: nomor permintaan = 8 karakter awal id respons.
    await expect(main.getByRole("status").filter({ hasText: "No. permintaan #3f2a9c1e" })).toBeVisible();
    await expect(saya.getByRole("list", { name: "Order saya" })).toContainText("#3f2a9c1e");
    await expect(saya).toContainText("Menunggu ditarik petugas");
    await expect(saya.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: "test-results/salesman/order-terkirim.png", fullPage: true });
});

test("Order Sales (P1): jawaban tidak pasti menahan Kirim → tepat 1 POST; Kirim lagi hanya lewat dialog yang menyebut risiko ganda", async ({ page }) => {
    const opsi = { postTidakPasti: true };
    const m = await mockOrder(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/sales", NAV);
    const main = page.locator("main");
    await main.getByLabel("Kode pelanggan Accurate").fill("C-01");
    await expect(main.getByLabel("Channel")).toHaveValue("GT", NAV);
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Kode barang").fill("A-1");
    await b1.locator("select").selectOption("KRT");
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeEnabled();
    await kirim.click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    const strip = main.getByRole("status").filter({ hasText: "Hasil kirim belum pasti." });
    await expect(strip).toBeVisible();
    await expect(main.getByRole("list", { name: "Order saya" })).toContainText("#3f2a9c1e"); // order sudah masuk
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Periksa Order saya dulu — order terakhir mungkin sudah masuk");
    expect(m.kirim).toHaveLength(1);
    // Kirim lagi = pilihan eksplisit dengan peringatan order ganda; Batal tidak mengirim apa pun.
    await strip.getByRole("button", { name: "Kirim lagi…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading")).toHaveText("Kirim lagi order untuk TOKO A?");
    await expect(dlg).toContainText("DUA kali");
    await dlg.getByRole("button", { name: "Batal" }).click();
    expect(m.kirim).toHaveLength(1);
    // Mengubah isian melepas tahanan.
    await b1.getByLabel("Jumlah").fill("3");
    await expect(kirim).toBeEnabled();
});

test("Order Sales (owner 8 Okt): draf di ponsel — muat ulang menawarkan Pulihkan/Buang, kiriman belum pasti tetap menahan Kirim, terkirim = draf hilang", async ({ page }) => {
    const opsi = { postTidakPasti: true };
    const m = await mockOrder(page, opsi);
    // Muat ulang memicu peringatan "perubahan belum disimpan" (beforeunload) — diterima; dialog peramban lain tetap galat.
    page.removeAllListeners("dialog");
    page.on("dialog", (d) => { if (d.type() !== "beforeunload") throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); return d.accept(); });
    const drafPonsel = () => page.evaluate(() => Object.keys(localStorage).find((k) => k.startsWith("accapi.order-sales.draf.v1")) ?? null);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/sales", NAV);
    const main = page.locator("main");
    const tawaran = main.getByRole("status").filter({ hasText: "Ada draf order di ponsel ini." });
    await main.getByLabel("Kode pelanggan Accurate").fill("C-01");
    await expect(main.getByLabel("Channel")).toHaveValue("GT", NAV);
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Kode barang").fill("A-1");
    await b1.locator("select").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    await expect(main.getByText("tersimpan sebagai draf di ponsel ini, belum di server")).toBeVisible();

    // Muat ulang: tidak dipulihkan diam-diam; Pulihkan mengembalikan isian (tanggal tetap hari ini).
    await page.reload(NAV);
    await expect(tawaran).toContainText("C-01 · TOKO A · 1 barang", NAV);
    await expect(main.getByLabel("Kode pelanggan Accurate")).toHaveValue("");
    await tawaran.getByRole("button", { name: "Pulihkan draf" }).click();
    await expect(tawaran).toBeHidden();
    await expect(main.getByLabel("Kode pelanggan Accurate")).toHaveValue("C-01");
    await expect(b1.getByLabel("Kode barang")).toHaveValue("A-1");
    await expect(b1.getByLabel("Jumlah")).toHaveValue("2");
    await expect(main.getByLabel("Channel")).toHaveValue("GT");

    // Kiriman tidak pasti → draf menyimpan tandanya; setelah dipulihkan Kirim tetap tertahan (tidak ada POST kedua).
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await kirim.click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Hasil kirim belum pasti." })).toBeVisible();
    await page.reload(NAV);
    await expect(tawaran).toContainText("Kiriman terakhirnya belum pasti", NAV);
    await tawaran.getByRole("button", { name: "Pulihkan draf" }).click();
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Periksa Order saya dulu — order terakhir mungkin sudah masuk");
    expect(m.kirim).toHaveLength(1);

    // Terkirim → draf dihapus dari ponsel; muat ulang tidak menawarkan apa pun.
    opsi.postTidakPasti = false;
    await b1.getByLabel("Jumlah").fill("3");
    await kirim.click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Order terkirim" })).toBeVisible();
    expect(m.kirim).toHaveLength(2);
    expect(await drafPonsel()).toBeNull();
    await page.reload(NAV);
    await expect(main.getByRole("heading", { name: "Order Sales" })).toBeVisible(NAV);
    await expect(tawaran).toHaveCount(0);

    // Buang lewat dialog.
    await b1.getByLabel("Kode barang").fill("A-1");
    await page.reload(NAV);
    await tawaran.getByRole("button", { name: "Buang…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Buang draf" }).click();
    await expect(tawaran).toBeHidden();
    expect(await drafPonsel()).toBeNull();
});

test("Order Sales (peninjau): kirim terputus tanpa jawaban → draf menahan Kirim; ketukan pertama tidak menghapus draf; draf akun lain tidak ditawarkan", async ({ page }) => {
    await mockOrder(page, {});
    let post = 0;
    await page.route((u) => u.host === "localhost:8000" && u.pathname === "/websales/orders", (r) => {
        if (r.request().method() !== "POST") return r.fallback();
        post++;
        return new Promise<void>(() => {}); // server menyimpan, jawabannya tidak pernah sampai
    });
    page.removeAllListeners("dialog");
    page.on("dialog", (d) => { if (d.type() !== "beforeunload") throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); return d.accept(); });
    await page.addInitScript(() => localStorage.setItem("accapi.order-sales.draf.v1.akun-lain",
        JSON.stringify({ customerNo: "C-09", outlet: "TOKO LAIN", note: "", lines: [{ code: "A-1", unit: "KRT", quantity: "1" }], tidakPasti: "", disimpan: "" })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/sales", NAV);
    const main = page.locator("main");
    const tawaran = main.getByRole("status").filter({ hasText: "Ada draf order di ponsel ini." });
    await expect(main.getByRole("heading", { name: "Order Sales" })).toBeVisible(NAV);
    await expect(tawaran).toHaveCount(0); // draf akun lain di ponsel yang sama tidak ditawarkan

    await main.getByLabel("Kode pelanggan Accurate").fill("C-01");
    await expect(main.getByLabel("Channel")).toHaveValue("GT", NAV);
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Kode barang").fill("A-1");
    await b1.locator("select").selectOption("KRT");
    await main.getByRole("button", { name: "Kirim order…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).click();
    await expect.poll(() => post).toBe(1);
    await page.reload(NAV); // halaman ditinggalkan sebelum jawaban datang
    await expect(tawaran).toContainText("Kiriman terakhirnya belum pasti", NAV);

    // Mengetik kode pelanggan (belum ada barang) menutup tawaran tetapi tidak menghapus draf yang belum diputuskan.
    await main.getByLabel("Kode pelanggan Accurate").fill("C-02");
    await expect(tawaran).toBeHidden();
    await page.reload(NAV);
    await tawaran.getByRole("button", { name: "Pulihkan draf" }).click();
    await expect(main.getByLabel("Kode pelanggan Accurate")).toHaveValue("C-01");
    await expect(main.getByRole("button", { name: "Kirim order…" })).toBeDisabled();
    expect(post).toBe(1);
});

test.describe("ponsel 390 px (layar sentuh)", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("Rute, Kunjungan, Order: tanpa gulir menyamping; semua kontrol ≥ 44 px", async ({ page }) => {
        await mockFk(page, {});
        await mockOrder(page, {});
        await page.goto("/form-kontrol?tab=ao", NAV);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        await expect(r.getByRole("list", { name: "Toko di rute" }).getByRole("listitem")).toHaveCount(4, NAV);
        await noOverflow(page);
        await target44(r);
        await page.screenshot({ path: "test-results/salesman/ponsel-rute.png", fullPage: true });

        await page.goto(`/form-kontrol/visit/C-03?salesCode=S-01&principle=GODREJ&date=${HARI_INI}`, NAV);
        const main = page.locator("main");
        await expect(main.getByRole("radio", { name: /TIDAK ORDER/ })).toBeChecked(NAV);
        await noOverflow(page);
        await target44(main);
        await page.screenshot({ path: "test-results/salesman/ponsel-kunjungan-status.png", fullPage: true });
        await main.getByRole("button", { name: "Simpan & lanjut" }).click();
        await expect(main.getByRole("checkbox", { name: "Produk terlihat jelas" })).toBeVisible();
        await noOverflow(page);
        await target44(main);
        await page.screenshot({ path: "test-results/salesman/ponsel-kunjungan-merch.png", fullPage: true });

        await page.goto("/sales", NAV);
        await expect(main.getByRole("heading", { name: "Order Sales" })).toBeVisible(NAV);
        await main.getByLabel("Kode pelanggan Accurate").fill("C-01");
        await main.getByRole("button", { name: "Tambah barang" }).click();
        await expect(main.getByRole("button", { name: "Hapus barang 2" })).toBeVisible();
        await noOverflow(page);
        await target44(main);
        await page.screenshot({ path: "test-results/salesman/ponsel-order.png", fullPage: true });
    });
});
