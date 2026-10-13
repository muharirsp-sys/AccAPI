/*
 * Tujuan: FK-MSM2 (pilot Form Kontrol cabang, 12 Okt 2026) — kunjungan LUAR RUTE di layar salesman (390 px): cari pelanggan cabang
 *   (/api/customers/search, jeda >= 300 ms, minimal 2 huruf, permintaan lama dibatalkan) → tambah ke kunjungan hari ini → toko bertanda
 *   "Luar rute" di Rute hari ini; toko yang sudah di rute tidak bisa ditambah ganda; salesman TANPA JKS memakai principal cabang Accurate
 *   (tanpa tautan = penjelasan); kunjungan luar rute dibuka seperti toko JKS (status + alasan); konfirmasi di Laporan harian: hari + minggu
 *   → JKS, "jangan masukkan JKS", "nanti" tidak menahan kirim laporan; peringatan JKS salesman lain. Kontrol JKS SPV: penanda "Ditambahkan
 *   salesman" + hasil unggah `digantikan`; Dashboard SPV: penanda luar rute. Data generik (PELANGGAN A, CABANG A, PRINCIPLE A).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-form-kontrol-luar-rute.spec.ts --config playwright.fiori-local.config.ts --workers=1 --output=test-results/fkmsm2`.
 * Dependensi: /api/form-kontrol/* + /api/customers/search di-mock (page.route). Tidak menyentuh DB.
 * Side Effects: Tangkapan di test-results/fkmsm2.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import * as XLSX from "xlsx";
import { paritasMinggu } from "../lib/form-kontrol/constants";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
const KEMARIN = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date(Date.now() - 86_400_000));

const SALESMAN = { role: "salesman", salesCode: "S-01", salesName: "SALES A", spvName: "SPV A", allowedSalesCodes: ["S-01"], principles: ["PRINCIPLE A"],
    principalCabang: null, alasanCabang: null };
const baris = (custCode: string, custName: string, over: Record<string, unknown> = {}) => ({ id: `r-${custCode}`, salesCode: "S-01", custCode, custName,
    principle: "PRINCIPLE A", aoStatus: null, monthlyOrderCount: 0, needsAttention: false, checkinAt: null, checkoutAt: null, luarRute: false, ...over });
const PELANGGAN = [
    { id: 1, customerNo: "C-100001-CBA", name: "PELANGGAN A", branchId: 50, branchName: "CABANG A", categoryName: "TT", channel: "TT", priceCategoryName: null, alamat: "JL. CONTOH 1" },
    { id: 2, customerNo: "C-100002-CBA", name: "PELANGGAN B", branchId: 50, branchName: "CABANG A", categoryName: "TT", channel: "TT", priceCategoryName: null, alamat: "JL. CONTOH 2" },
];
const REASONS = [{ id: "R01", reasonCode: "R01", label: "Stok masih cukup", category: "stok" }, { id: "R14", reasonCode: "R14", label: "Lainnya", category: "lainnya" }];
const jam = (hhmm: string) => `${HARI_INI}T${hhmm}:00+08:00`;
const luar = (id: string, custCode: string, custName: string, over: Record<string, unknown> = {}) => ({ id, tanggal: HARI_INI, custCode, custName, alamat: null,
    principle: "PRINCIPLE A", konfirmasi: "menunggu", hari: null, mingguPattern: null, jksId: null, dibuatPada: jam("08:00"), dikonfirmasiOlehNama: null,
    dikonfirmasiPada: null, status: "ordered", noOrderReasonCode: null, checkinAt: jam("09:00"), checkoutAt: jam("09:20"), jksSaya: [], jksLain: [], ...over });

type Opsi = { scope?: unknown; rute?: Record<string, unknown>[]; luarRute?: Record<string, unknown>[]; jksRows?: unknown[]; jksPost?: unknown; spv?: unknown;
    /** Jawaban POST luar-rute/batal berikutnya (antrean; kosong = 200 dan baris keluar dari rute). */
    batalJawab?: { status: number; body?: unknown }[] };

async function mockFk(page: Page, opsi: Opsi) {
    const baca: URL[] = [];
    const tulis: Request[] = [];
    const cari: { url: URL; t: number }[] = [];
    const batal: string[] = [];
    page.on("requestfailed", (r) => { if (r.url().includes("/api/customers/search")) batal.push(new URL(r.url()).searchParams.get("q") ?? ""); });
    await page.route((u) => u.pathname === "/api/customers/search", async (route) => {
        const url = new URL(route.request().url());
        cari.push({ url, t: Date.now() });
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        try {
            await route.fulfill(json({ ok: true, cakupan: { semua: false, branchId: 50, branchName: "CABANG A" },
                items: PELANGGAN.filter((p) => p.name.toLowerCase().includes(q) || p.customerNo.toLowerCase().includes(q)) }));
        } catch { /* dibatalkan peramban */ }
    });
    await page.route("**/api/form-kontrol/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace("/api/form-kontrol/", "");
        if (req.method() === "GET") baca.push(url); else tulis.push(req);
        if (p === "my-scope") return route.fulfill(json(opsi.scope ?? SALESMAN));
        if (p === "reasons") return route.fulfill(json({ rows: REASONS }));
        if (p === "ao-control" && req.method() === "GET") return route.fulfill(json({ rows: opsi.rute ?? [], summary: {}, date: url.searchParams.get("date") }));
        if (p === "luar-rute" && req.method() === "GET") return route.fulfill(json({ ok: true, rows: opsi.luarRute ?? [], date: url.searchParams.get("date") }));
        if (p === "luar-rute" && req.method() === "POST") {
            const b = req.postDataJSON() as { customerNo: string };
            const pel = PELANGGAN.find((x) => x.customerNo === b.customerNo)!;
            opsi.rute = [...(opsi.rute ?? []), baris(pel.customerNo, pel.name, { id: `l-${pel.customerNo}`, luarRute: true })];
            return route.fulfill(json({ ok: true, baru: true, row: { id: `l-${pel.customerNo}`, custCode: pel.customerNo, custName: pel.name, konfirmasi: "menunggu" } }, 201));
        }
        if (p === "luar-rute/konfirmasi") {
            const b = req.postDataJSON() as { id: string; keputusan: string; hari?: string; mingguPattern?: string };
            opsi.luarRute = (opsi.luarRute ?? []).map((r) => r.id === b.id ? { ...r, konfirmasi: b.keputusan, hari: b.hari ?? null, mingguPattern: b.mingguPattern ?? null,
                dikonfirmasiOlehNama: "SALES A", dikonfirmasiPada: new Date().toISOString() } : r);
            return route.fulfill(json({ ok: true, row: opsi.luarRute.find((r) => r.id === b.id), jksLain: [] }));
        }
        if (p === "luar-rute/batal") {
            const j = opsi.batalJawab?.shift();
            if (j) return j.body === undefined ? route.fulfill({ status: j.status, contentType: "text/html", body: "<html>Bad Gateway</html>" }) : route.fulfill(json(j.body, j.status));
            const { id } = req.postDataJSON() as { id: string };
            opsi.rute = (opsi.rute ?? []).filter((r) => r.id !== id);
            return route.fulfill(json({ ok: true, row: { id } }));
        }
        if (p === "visit") return route.fulfill(json({
            store: { id: "l-C-100002-CBA", salesCode: "S-01", salesName: "SALES A", custCode: "C-100002-CBA", custName: "PELANGGAN B", market: null, alamat: "JL. CONTOH 2",
                kota: null, principle: "PRINCIPLE A", visitFrequency: 0, luarRute: true },
            ao: { id: "a1", status: "not_visited", noOrderReasonCode: null, noOrderNote: null, checkinAt: jam("09:00"), checkinPhotoUrl: "/api/uploads/form-kontrol/in.jpg", checkoutAt: null, checkoutPhotoUrl: null },
            merch: null,
        }));
        if (p === "reports" && req.method() === "GET") return route.fulfill(json({ rows: [{ id: null, salesCode: "S-01", date: url.searchParams.get("date"), totalTokoJks: 2,
            totalOrder: 1, totalActive: 0, totalNotOrder: 0, totalNotVisited: 1, tindakLanjut: "", submittedAt: null, spvAck: false, spvAckAt: null }], total: 1 }));
        if (p === "jks" && req.method() === "GET") return route.fulfill(json({ rows: opsi.jksRows ?? [], total: (opsi.jksRows ?? []).length, page: 1, limit: 50 }));
        if (p === "jks" && req.method() === "POST") return route.fulfill(json(opsi.jksPost ?? { success: true, imported: 0, skipped: 0, ditolak: [], digantikan: [] }));
        if (p === "spv-dashboard") return route.fulfill(json(opsi.spv ?? { rows: [], spvName: "SPV A" }));
        return route.fulfill(json({ success: true, id: "x" }));
    });
    await page.route("**/api/uploads/form-kontrol/**", (r) => r.fulfill({ status: 200, contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") }));
    return { baca, tulis, cari, batal };
}
const postKe = (tulis: Request[], akhir: string) => tulis.filter((r) => new URL(r.url()).pathname.endsWith(akhir)).map((r) => r.postDataJSON());
const ruteDiminta = (baca: URL[]) => baca.filter((u) => u.pathname.endsWith("/ao-control"));

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

    test("Rute: cari pelanggan cabang (jeda, min 2 huruf, batal lama) → tambah kunjungan luar rute → toko bertanda Luar rute; toko di rute tidak ganda", async ({ page }) => {
        const m = await mockFk(page, { rute: [baris("C-100001", "PELANGGAN A")] });
        await page.goto("/form-kontrol?tab=ao", NAV);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        await expect(r.getByRole("list", { name: "Toko di rute" }).getByRole("listitem")).toHaveCount(1, NAV);
        const sek = r.getByRole("region", { name: "Kunjungan luar rute" });
        await sek.getByRole("button", { name: "Tambah toko luar rute" }).click();
        const kotak = sek.getByLabel("Cari pelanggan");

        await kotak.fill("p");
        await page.waitForTimeout(500);
        expect(m.cari.length, "1 huruf = tanpa permintaan").toBe(0);
        // Ketik cepat: permintaan hanya untuk ketikan terakhir, >= 300 ms sesudah ketukan terakhir.
        await kotak.pressSequentially("elanggan", { delay: 30 });
        const tKetik = Date.now();
        await expect(sek.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("listitem")).toHaveCount(2, NAV);
        expect(m.cari.map((c) => c.url.searchParams.get("q"))).toEqual(["pelanggan"]);
        expect(m.cari[0].t - tKetik).toBeGreaterThanOrEqual(250);
        expect(m.cari[0].url.searchParams.has("branchId"), "cabang dari server (salesman)").toBe(false);

        // Toko yang sudah di rute (kode JKS tanpa akhiran = pelanggan C-100001-CBA) tidak bisa ditambah.
        await sek.getByRole("listitem").filter({ hasText: "PELANGGAN A" }).click();
        const tombol = sek.getByRole("button", { name: "Tambah ke kunjungan hari ini" });
        await expect(tombol).toBeDisabled();
        await expect(sek).toContainText("PELANGGAN A sudah ada di rute hari ini");
        await sek.getByRole("button", { name: "Ganti pelanggan" }).click();
        await sek.getByLabel("Cari pelanggan").fill("C-100002");
        await sek.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("listitem").filter({ hasText: "PELANGGAN B" }).click();
        await expect(tombol).toBeEnabled();
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm2/ponsel-cari-luar-rute.png", fullPage: true });
        await tombol.click();

        await expect(r.getByRole("list", { name: "Toko di rute" }).getByRole("listitem")).toHaveCount(2, NAV);
        expect(postKe(m.tulis, "/luar-rute")).toEqual([{ salesCode: "S-01", principle: "PRINCIPLE A", date: HARI_INI, customerNo: "C-100002-CBA" }]);
        const item = r.getByRole("list", { name: "Toko di rute" }).getByRole("listitem").filter({ hasText: "PELANGGAN B" });
        await expect(item).toContainText("Luar rute");
        await expect(item.getByRole("link")).toHaveAttribute("href", new RegExp(`/form-kontrol/visit/C-100002-CBA\\?salesCode=S-01&principle=PRINCIPLE\\+A&date=${HARI_INI}`));
        await expect(sek.getByText("PELANGGAN B ditambahkan ke kunjungan hari ini.")).toBeVisible();
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm2/ponsel-rute-luar-rute.png", fullPage: true });
    });

    test("Salesman TANPA JKS: principal cabang Accurate — rute diminta + tambah luar rute; tanpa tautan = penjelasan + alasan, tanpa permintaan", async ({ page }) => {
        const m = await mockFk(page, { scope: { ...SALESMAN, principles: [], principalCabang: "CABANG A" } });
        await page.goto("/form-kontrol?tab=ao", NAV);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        await expect(r.getByText("Belum ada JKS aktif untuk Anda")).toBeVisible(NAV);
        await expect(r).toContainText("Anda tetap bisa menambah kunjungan luar rute");
        await expect.poll(() => [...new Set(ruteDiminta(m.baca).map((u) => u.searchParams.get("principle")))]).toEqual(["CABANG A"]);
        const sek = r.getByRole("region", { name: "Kunjungan luar rute" });
        await sek.getByRole("button", { name: "Tambah toko luar rute" }).click();
        await sek.getByLabel("Cari pelanggan").fill("PELANGGAN B");
        await sek.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("listitem").filter({ hasText: "PELANGGAN B" }).click();
        await sek.getByRole("button", { name: "Tambah ke kunjungan hari ini" }).click();
        await expect(r.getByRole("list", { name: "Toko di rute" }).getByRole("listitem")).toHaveCount(1, NAV);
        expect(postKe(m.tulis, "/luar-rute")[0].principle).toBe("CABANG A");
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm2/ponsel-tanpa-jks-luar-rute.png", fullPage: true });

        const m2 = await mockFk(page, { scope: { ...SALESMAN, principles: [], principalCabang: null,
            alasanCabang: "Akun Anda belum terhubung ke karyawan salesman Accurate. Minta admin menautkannya di menu User; sampai itu order tidak bisa dibuat." } });
        await page.goto("/form-kontrol?tab=ao", NAV);
        await expect(r.getByText("Belum ada JKS aktif untuk Anda")).toBeVisible(NAV);
        await expect(r).toContainText("Akun Anda belum terhubung ke karyawan salesman Accurate");
        await expect(r.getByRole("region", { name: "Kunjungan luar rute" })).toHaveCount(0);
        expect(ruteDiminta(m2.baca)).toEqual([]);
    });

    test("Kunjungan luar rute dibuka seperti toko JKS: penanda Luar rute, status tidak order + alasan tersimpan", async ({ page }) => {
        const m = await mockFk(page, {});
        await page.goto(`/form-kontrol/visit/C-100002-CBA?salesCode=S-01&principle=PRINCIPLE+A&date=${HARI_INI}`, NAV);
        await expect(page.getByRole("heading", { name: "PELANGGAN B" })).toBeVisible(NAV);
        await expect(page.getByText("Luar rute", { exact: true })).toBeVisible();
        // Check-in sudah tercatat (mock) → wizard langsung di langkah Status, sama dengan toko JKS.
        await page.getByRole("radio", { name: "TIDAK ORDER" }).check();
        await page.getByLabel("Alasan tidak order").selectOption("R01");
        await page.getByRole("button", { name: "Simpan & lanjut" }).click();
        await expect(page.getByRole("heading", { name: "Merchandising wajib" })).toBeVisible(NAV);
        expect(postKe(m.tulis, "/ao-control")).toEqual([{ salesCode: "S-01", custCode: "C-100002-CBA", principle: "PRINCIPLE A", date: HARI_INI,
            status: "not_order", noOrderReasonCode: "R01", noOrderNote: "" }]);
        await noOverflow(page);
    });

    test("Rute: Batalkan kunjungan luar rute salah tambah (owner 13 Okt) — hanya luar rute belum dikunjungi; galat server di dialog; tidak pasti = kunci + muat ulang", async ({ page }) => {
        const opsi: Opsi = {
            rute: [baris("C-100001", "PELANGGAN A"), baris("C-100002-CBA", "PELANGGAN B", { id: "l-b", luarRute: true }),
                baris("C-100003-CBA", "PELANGGAN C", { id: "l-c", luarRute: true }),
                baris("C-100004-CBA", "PELANGGAN D", { id: "l-d", luarRute: true, checkinAt: jam("09:00") })],
            batalJawab: [{ status: 409, body: { ok: false, kode: "SUDAH_DIKUNJUNGI", error: "PELANGGAN B sudah punya catatan kunjungan hari ini (check-in, status, atau merchandising) — tidak bisa dibatalkan." } }],
        };
        const m = await mockFk(page, opsi);
        await page.goto("/form-kontrol?tab=ao", NAV);
        const daftar = page.getByRole("region", { name: "Rute hari ini" }).getByRole("list", { name: "Toko di rute" });
        await expect(daftar.getByRole("listitem")).toHaveCount(4, NAV);
        // Hanya kunjungan luar rute yang belum dikunjungi: bukan toko JKS, bukan yang sudah check-in.
        await expect(daftar.getByRole("button", { name: /^Batalkan kunjungan/ })).toHaveCount(2);
        const tombolB = daftar.getByRole("button", { name: "Batalkan kunjungan PELANGGAN B" });
        expect((await tombolB.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm2/ponsel-batal-luar-rute.png", fullPage: true });

        await tombolB.click();
        const d = page.getByRole("dialog", { name: "Batalkan kunjungan PELANGGAN B?" });
        await expect(d).toContainText("C-100002-CBA");
        await d.getByRole("button", { name: "Batalkan kunjungan" }).click();
        await expect(d.getByRole("alert")).toContainText("sudah punya catatan kunjungan hari ini", NAV);
        await d.getByRole("button", { name: "Batalkan kunjungan" }).click();
        await expect(d).toBeHidden(NAV);
        await expect(daftar.getByRole("listitem")).toHaveCount(3, NAV);
        await expect(page.getByText("Kunjungan luar rute PELANGGAN B dibatalkan.")).toBeVisible();
        expect(postKe(m.tulis, "/luar-rute/batal")).toEqual([{ id: "l-b" }, { id: "l-b" }]);

        // Jawaban tidak pasti (502 HTML): dialog menyebut "belum pasti", tombol terkunci; sesudah ditutup semua Batalkan terkunci sampai muat ulang.
        opsi.batalJawab!.push({ status: 502 });
        await daftar.getByRole("button", { name: "Batalkan kunjungan PELANGGAN C" }).click();
        const d2 = page.getByRole("dialog", { name: "Batalkan kunjungan PELANGGAN C?" });
        await d2.getByRole("button", { name: "Batalkan kunjungan" }).click();
        await expect(d2.getByRole("alert")).toContainText("hasil pembatalan belum pasti", NAV);
        await expect(d2.getByRole("alert")).not.toContainText("Bad Gateway");
        await expect(d2.getByRole("button", { name: "Batalkan kunjungan" })).toBeDisabled();
        await d2.getByRole("button", { name: "Kembali" }).click();
        const strip = page.getByRole("status").filter({ hasText: "Hasil pembatalan terakhir belum pasti." });
        await expect(strip).toBeVisible();
        await expect(daftar.getByRole("button", { name: "Batalkan kunjungan PELANGGAN C" })).toBeDisabled();
        await strip.getByRole("button", { name: "Muat ulang" }).click();
        await expect(daftar.getByRole("button", { name: "Batalkan kunjungan PELANGGAN C" })).toBeEnabled(NAV);
        expect(postKe(m.tulis, "/luar-rute/batal")).toHaveLength(3);
        await noOverflow(page);
    });

    test("Laporan harian: konfirmasi luar rute — hari + minggu → JKS, jangan masukkan, 'nanti' tidak menahan kirim laporan; peringatan JKS salesman lain", async ({ page }) => {
        const m = await mockFk(page, { luarRute: [
            luar("k1", "C-100002-CBA", "PELANGGAN B", { jksLain: [{ salesCode: "S-02", salesName: "SALES B", custCode: "C-100002", hariKunjungan: "Rabu", mingguPattern: "ganjil" }] }),
            luar("k2", "C-100003-CBA", "PELANGGAN C"),
            luar("k3", "C-100004-CBA", "PELANGGAN D"),
            luar("k4", "C-100005-CBA", "PELANGGAN E", { konfirmasi: "jks", hari: "Senin", mingguPattern: "genap", dikonfirmasiOlehNama: "SALES A", dikonfirmasiPada: jam("10:00") }),
            luar("k5", "C-100006-CBA", "PELANGGAN F", { tanggal: KEMARIN }),
            luar("k6", "C-100007-CBA", "PELANGGAN G", { checkinAt: null, checkoutAt: null, status: null }),
        ] });
        await page.goto("/form-kontrol?tab=laporan", NAV);
        const lap = page.getByRole("region", { name: "Laporan harian" });
        const sek = lap.getByRole("region", { name: "Toko luar rute" });
        const daftar = sek.getByRole("list", { name: "Toko luar rute" });
        await expect(daftar.getByRole("listitem")).toHaveCount(5, NAV);
        await expect(sek).toContainText("4 menunggu keputusan");
        await expect(daftar.getByRole("listitem").filter({ hasText: "PELANGGAN G" })).toHaveCount(0);
        await expect(daftar.getByRole("listitem").filter({ hasText: "PELANGGAN F" })).toContainText("Kunjungan");
        const b = daftar.getByRole("listitem").filter({ hasText: "PELANGGAN B" });
        await expect(b).toContainText("Sudah di JKS salesman lain: S-02 SALES B (Rabu · minggu ganjil)");
        await expect(daftar.getByRole("listitem").filter({ hasText: "PELANGGAN E" })).toContainText("Masuk JKS: Senin · minggu genap");

        const masuk = b.getByRole("button", { name: "Masukkan ke JKS" });
        await expect(masuk).toBeDisabled();
        await b.getByLabel("Hari").selectOption("Selasa");
        // Paritas = rute (acuan owner 12 Okt 2026 = genap, selang-seling; bukan minggu ISO).
        await expect(b.getByLabel("Minggu").locator(`option[value="${paritasMinggu(HARI_INI)}"]`)).toHaveText(/\(minggu ini\)$/);
        await expect(b.getByLabel("Minggu").locator("option", { hasText: "minggu ini" })).toHaveCount(1);
        await b.getByLabel("Minggu").selectOption("genap");
        await expect(masuk).toBeEnabled();
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm2/ponsel-konfirmasi-luar-rute.png", fullPage: true });
        await masuk.click();
        await expect(b).toContainText("Masuk JKS: Selasa · minggu genap", NAV);
        await daftar.getByRole("listitem").filter({ hasText: "PELANGGAN C" }).getByRole("button", { name: "Jangan masukkan JKS" }).click();
        await expect(daftar.getByRole("listitem").filter({ hasText: "PELANGGAN C" })).toContainText("Tidak dimasukkan JKS", NAV);
        expect(postKe(m.tulis, "/luar-rute/konfirmasi")).toEqual([
            { id: "k1", salesCode: "S-01", keputusan: "jks", hari: "Selasa", mingguPattern: "genap" },
            { id: "k2", salesCode: "S-01", keputusan: "tidak" },
        ]);
        await expect(sek).toContainText("2 menunggu keputusan");

        // "Nanti": PELANGGAN D + F dibiarkan menunggu — laporan tetap terkirim.
        await lap.getByLabel("Tindak lanjut untuk SPV").fill("Kunjungi ulang toko luar rute");
        await lap.getByRole("button", { name: "Kirim laporan ke SPV…" }).click();
        const dlg = page.getByRole("dialog");
        await expect(dlg).toContainText("Toko luar rute menunggu keputusan");
        await expect(dlg).toContainText("2 (boleh nanti)");
        await dlg.getByRole("button", { name: "Kirim laporan" }).click();
        await expect.poll(() => postKe(m.tulis, "/reports").length).toBe(1);
        await noOverflow(page);
    });
});

test("SPV: Kontrol JKS menandai baris tambahan salesman; unggah melaporkan baris tambahan yang digantikan; Dashboard SPV menandai luar rute", async ({ page }) => {
    const jksRow = (custCode: string, tambahan: unknown) => ({ id: custCode, salesCode: "S-01", salesName: "SALES A", custCode, custName: `TOKO ${custCode}`,
        market: null, alamat: null, kota: null, hariKunjungan: "Senin", mingguPattern: "all", area: null, rayon: null, principle: "PRINCIPLE A", visitFrequency: 4,
        isActive: true, tambahanSalesman: tambahan });
    await mockFk(page, {
        scope: { role: "spv", salesName: "SPV A", spvName: "SPV A", allowedSalesCodes: ["S-01"], principles: ["PRINCIPLE A"] },
        jksRows: [jksRow("C-100001", null), jksRow("C-100002-CBA", { oleh: "SALES A", pada: jam("17:05"), dariKunjungan: HARI_INI })],
        jksPost: { success: true, imported: 1, skipped: 0, ditolak: [], digantikan: [{ salesCode: "S-01", principle: "PRINCIPLE A", custCode: "C-100002-CBA",
            custName: "PELANGGAN B", kodeBerkas: "C-100002" }] },
        spv: { spvName: "SPV A", rows: [{ salesCode: "S-01", salesName: "SALES A", totalRoute: 1, ordered: 1, notOrder: 0, notVisited: 0, checkedIn: 1, checkedOut: 1,
            submittedAt: null, tindakLanjut: null, visits: [{ custCode: "C-100002-CBA", custName: "PELANGGAN B", luarRute: true, status: "ordered",
                checkinAt: jam("09:00"), checkoutAt: jam("09:20"), durationMinutes: 20, gpsFlag: null, durFlag: null, checkinPhotoUrl: null, checkoutPhotoUrl: null,
                merchDone: 6, merchTotal: 6 }], totalFieldMinutes: 20 }] },
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/form-kontrol?tab=jks", NAV);
    const main = page.locator("main");
    const tabel = main.getByRole("table");
    await expect(tabel.getByRole("row").filter({ hasText: "C-100002-CBA" })).toContainText("Ditambahkan salesman", NAV);
    await expect(tabel.getByRole("row").filter({ hasText: "C-100002-CBA" })).toContainText("oleh SALES A");
    await expect(tabel.getByRole("row").filter({ hasText: "C-100001" }).first()).toContainText("Unggahan");

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Kode Sales", "Kode Toko", "Principle", "Hari"], ["S-01", "C-100002", "PRINCIPLE A", "Senin"]]), "JKS");
    await main.getByRole("button", { name: "Impor Excel" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Berkas JKS (.xlsx)").setInputFiles({ name: "jks.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer) });
    await expect(dialog.getByText("Baris terbaca")).toBeVisible();
    await dialog.getByRole("button", { name: "Terapkan" }).click();
    await expect(main.getByText("1 baris tambahan salesman dinonaktifkan: tokonya ada di berkas dengan kode JKS lain.")).toBeVisible(NAV);
    await expect(main).toContainText("PELANGGAN B (C-100002-CBA → C-100002, S-01)");

    await page.goto("/form-kontrol/spv-dashboard", NAV);
    await page.getByText("Detail kunjungan (1)").click();
    await expect(page.getByRole("listitem").filter({ hasText: "PELANGGAN B" })).toContainText("Luar rute", NAV);
});
