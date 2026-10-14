/*
 * Tujuan: FK-MSM2 (pilot Form Kontrol cabang, 12 Okt 2026) — kunjungan LUAR RUTE di layar salesman (390 px): cari pelanggan cabang
 *   (/api/customers/search, jeda >= 300 ms, minimal 2 huruf, permintaan lama dibatalkan) → tambah ke kunjungan hari ini → toko bertanda
 *   "Luar rute" di Rute hari ini; toko yang sudah di rute tidak bisa ditambah ganda; salesman TANPA JKS memakai principal cabang Accurate
 *   (tanpa tautan = penjelasan); kunjungan luar rute dibuka seperti toko JKS (status + alasan); konfirmasi di Laporan harian: hari + minggu
 *   → JKS, "jangan masukkan JKS", "nanti" tidak menahan kirim laporan; peringatan JKS salesman lain. Kontrol JKS SPV: penanda "Ditambahkan
 *   salesman" + hasil unggah `digantikan`; Dashboard SPV: penanda luar rute. Data generik (PELANGGAN A, CABANG A, PRINCIPLE A).
 *   FK-MSM3 (13 Okt): tulis kunjungan untuk toko yang tidak lagi di rute = 409 berkode → Kunjungan diganti penjelasan, Kirim status memuat
 *   ulang rute; tanda prioritas belum dikirim bertahan melewati muat ulang rute (R-7); keputusan konfirmasi dikunci selama daftar dimuat ulang (D7).
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
    batalJawab?: { status: number; body?: unknown }[];
    /** Jawaban POST ao-control berikutnya (antrean; kosong = 200). */
    aoJawab?: { status: number; body: unknown }[] };

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
        if (p === "ao-control" && req.method() === "POST" && opsi.aoJawab?.length) { const j = opsi.aoJawab.shift()!; return route.fulfill(json(j.body, j.status)); }
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

    test("FK-MSM3 Kunjungan: status ditolak 409 KUNJUNGAN_DIBATALKAN (dibatalkan di layar lain) → wizard diganti penjelasan + jalan ke Rute hari ini", async ({ page }) => {
        const m = await mockFk(page, { rute: Array.from({ length: 10 }, (_, i) => baris(`C-9${String(i).padStart(2, "0")}`, `TOKO JKS ${String.fromCharCode(65 + i)}`)),
            aoJawab: [{ status: 409, body: { ok: false, kode: "KUNJUNGAN_DIBATALKAN",
            error: "Kunjungan luar rute PELANGGAN B pada Selasa, 13 Okt 2026 sudah dibatalkan, jadi tidak dicatat. Bila toko ini memang dikunjungi, tambahkan lagi lewat Kunjungan luar rute." } }] });
        await page.goto(`/form-kontrol/visit/C-100002-CBA?salesCode=S-01&principle=PRINCIPLE+A&date=${HARI_INI}`, NAV);
        await expect(page.getByRole("heading", { name: "PELANGGAN B" })).toBeVisible(NAV);
        await page.getByRole("radio", { name: "TIDAK ORDER" }).check();
        await page.getByLabel("Alasan tidak order").selectOption("R01");
        await page.getByRole("button", { name: "Simpan & lanjut" }).click();
        const isi = page.locator(".fi-page");
        await expect(isi.getByRole("heading", { name: "Kunjungan luar rute ini sudah dibatalkan" })).toBeVisible(NAV);
        await expect(isi).toContainText("sudah dibatalkan, jadi tidak dicatat");
        // Peninjau B R-2: isian yang tidak tersimpan disebut; check-in yang sudah tercatat dibedakan. R-5: fokus ke penjelasan, bukan BODY.
        await expect(isi).toContainText("Isian di layar ini tidak tersimpan; check-in yang sudah dikirim tetap tercatat.");
        expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
        await expect(isi.getByRole("link", { name: "Rute hari ini" })).toHaveAttribute("href", "/form-kontrol?tab=ao#luar-rute");
        await expect(page.getByRole("heading", { name: "Merchandising wajib" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Simpan & lanjut" })).toHaveCount(0);
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm3/ponsel-kunjungan-bukan-rute.png", fullPage: true });
        const r0 = ruteDiminta(m.baca).length;
        await isi.getByRole("link", { name: "Rute hari ini" }).click();
        await expect(page.getByRole("region", { name: "Rute hari ini" })).toBeVisible(NAV);
        await expect.poll(() => ruteDiminta(m.baca).length, NAV).toBeGreaterThan(r0);
        // Peninjau B S-2: satu ketukan mendarat di bagian Kunjungan luar rute (rute 10 toko), tombol Tambah terfokus.
        const tambah = page.getByRole("region", { name: "Kunjungan luar rute" }).getByRole("button", { name: "Tambah toko luar rute" });
        await expect(tambah).toBeFocused(NAV);
        await expect.poll(() => tambah.evaluate((e) => { const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }), NAV).toBe(true);
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
        // Peninjau A R-4: kunjungan luar rute hari ini terpisah dari Total toko JKS (kemarin & belum check-in tidak dihitung).
        await expect(lap.locator(".fi-kc", { hasText: "Luar rute dikunjungi" }).locator("b")).toHaveText("4");
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

// =========================================================================== peninjau B (13 Okt): tes B1–B5b disalin/disesuaikan dari
// scratchpad revfk2b/specs/zz-revfk2b.spec.ts — mock dengan antrean jawaban per endpoint (`terapkan` = server sudah menerapkan walau jawabannya galat).

type JawabB = { status: number; body?: unknown; delay?: number; terapkan?: boolean };
type OpsiB = {
    scope?: unknown; rute?: Record<string, unknown>[]; luarRute?: Record<string, unknown>[]; jksRows?: unknown[]; spv?: unknown;
    profiles?: unknown[]; spvOptions?: string[]; smOptions?: string[];
    tambah?: JawabB[]; batal?: JawabB[]; konf?: JawabB[]; luarGet?: JawabB[]; ruteGet?: JawabB[]; aoPost?: JawabB[];
    /** FK-MSM3 (tes peninjau B): GET visit, antrean POST check-in/merchandising, rute per principal. */
    visit?: { store: unknown; ao: unknown; merch: unknown }; checkin?: JawabB[]; merch?: JawabB[]; rutePer?: Record<string, Record<string, unknown>[]>;
    /** GET luar-rute menjawab 500 selama > 0. */
    luarGagal?: number;
};
const PELANGGAN_B = ["A", "B", "C", "D"].map((h, i) => ({ id: i + 1, customerNo: `C-10000${i + 1}-CBA`, name: `PELANGGAN ${h}`, branchId: 50, branchName: "CABANG A",
    categoryName: "TT", channel: "TT", priceCategoryName: null, alamat: `JL. CONTOH ${i + 1}` }));
const luarPada = (tgl: string, id: string, custCode: string, custName: string, over: Record<string, unknown> = {}) => ({
    ...luar(id, custCode, custName, over), tanggal: tgl, dibuatPada: `${tgl}T08:00:00+08:00`, checkinAt: `${tgl}T09:00:00+08:00`, checkoutAt: `${tgl}T09:20:00+08:00`, ...over });
const tidur = (ms?: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const K409 = (kode: string, error: string): JawabB => ({ status: 409, body: { ok: false, kode, error } });
const MSG_BATAL = "Kunjungan luar rute PELANGGAN B pada Selasa, 13 Okt 2026 sudah dibatalkan, jadi tidak dicatat. Bila toko ini memang dikunjungi, tambahkan lagi lewat Kunjungan luar rute.";
const MSG_BUKAN = "TOKO JKS A (C-900) tidak ada di rute S-01 (PRINCIPLE A) pada Selasa, 13 Okt 2026, jadi tidak dicatat. Tambahkan dulu lewat Kunjungan luar rute di Rute hari ini.";
const STORE_LUAR = { id: "l-b", salesCode: "S-01", salesName: "SALES A", custCode: "C-100002-CBA", custName: "PELANGGAN B", market: null, alamat: "JL. CONTOH 2", kota: null,
    principle: "PRINCIPLE A", visitFrequency: 0, luarRute: true };
const STORE_JKS = { id: "j9", salesCode: "S-01", salesName: "SALES A", custCode: "C-900", custName: "TOKO JKS A", market: "GT", alamat: "JL. CONTOH 9", kota: "KOTA A",
    principle: "PRINCIPLE A", visitFrequency: 4 };
const AO_CHECKIN = { id: "a1", status: "not_visited", noOrderReasonCode: null, noOrderNote: null, checkinAt: `${HARI_INI}T08:31:00+08:00`,
    checkinPhotoUrl: "/api/uploads/form-kontrol/in.jpg", checkoutAt: null, checkoutPhotoUrl: null };
const kunjunganUrl = (cust: string) => `/form-kontrol/visit/${cust}?salesCode=S-01&principle=PRINCIPLE+A&date=${HARI_INI}`;
const ruteN = (n: number) => Array.from({ length: n }, (_, i) => baris(`C-9${String(i).padStart(2, "0")}`, `TOKO JKS ${String.fromCharCode(65 + i)}`));
async function ambilFoto(page: Page, label: string) {
    await page.locator("main").getByRole("button", { name: label }).click();
    const kamera = page.getByRole("dialog", { name: "Foto Bukti Kunjungan" });
    await kamera.locator('input[type="file"]').setInputFiles({ name: "toko.png", mimeType: "image/png", buffer: PNG });
    await kamera.getByRole("button", { name: /Gunakan/ }).click();
}
const nBaca = (baca: URL[], akhir: string) => baca.filter((u) => u.pathname.endsWith(akhir)).length;

async function mockB(page: Page, o: OpsiB) {
    const baca: URL[] = [], tulis: Request[] = [];
    const jawab = async (route: Parameters<Parameters<Page["route"]>[1]>[0], j: JawabB) => {
        await tidur(j.delay);
        try {
            return j.body === undefined ? await route.fulfill({ status: j.status, contentType: "text/html", body: "<html>Bad Gateway</html>" }) : await route.fulfill(json(j.body, j.status));
        } catch { /* dibatalkan */ }
    };
    await page.route("**/api/uploads/form-kontrol/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await page.route("**/api/upload/form-kontrol", (r) => { tulis.push(r.request()); return r.fulfill(json({ url: "/api/uploads/form-kontrol/baru.jpg" })); });
    await page.route((u) => u.pathname === "/api/customers/search", async (route) => {
        const q = (new URL(route.request().url()).searchParams.get("q") ?? "").toLowerCase();
        try {
            await route.fulfill(json({ ok: true, cakupan: { semua: false, branchId: 50, branchName: "CABANG A" },
                items: PELANGGAN_B.filter((p) => p.name.toLowerCase().includes(q) || p.customerNo.toLowerCase().includes(q)) }));
        } catch { /* dibatalkan peramban */ }
    });
    await page.route("**/api/form-kontrol/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace("/api/form-kontrol/", "");
        if (req.method() === "GET") baca.push(url); else tulis.push(req);
        if (p === "my-scope") return route.fulfill(json(o.scope ?? SALESMAN));
        if (p === "reasons") return route.fulfill(json({ rows: REASONS }));
        if (p === "ao-control" && req.method() === "GET") {
            const j = o.ruteGet?.shift();
            if (j && !j.terapkan) return jawab(route, j);
            await tidur(j?.delay);
            const rows = o.rutePer?.[url.searchParams.get("principle") ?? ""] ?? o.rute ?? [];
            try { return await route.fulfill(json({ rows, summary: {}, date: url.searchParams.get("date") })); } catch { return; }
        }
        if (p === "ao-control" && req.method() === "POST") {
            const j = o.aoPost?.shift();
            if (j) return jawab(route, j);
            return route.fulfill(json({ success: true, id: "x" }));
        }
        if (p === "visit") return route.fulfill(json(o.visit ?? { store: null, ao: null, merch: null }));
        if (p === "checkin" || (p === "merchandising" && req.method() === "POST")) {
            const j = (p === "checkin" ? o.checkin : o.merch)?.shift();
            if (j) return jawab(route, j);
            return route.fulfill(json({ success: true, id: "x" }));
        }
        if (p === "luar-rute" && req.method() === "GET") {
            if (o.luarGagal) { o.luarGagal--; return route.fulfill(json({ ok: false, error: "Internal server error" }, 500)); }
            const j = o.luarGet?.shift();
            if (j && !j.terapkan) return jawab(route, j);
            await tidur(j?.delay);
            return route.fulfill(json({ ok: true, rows: o.luarRute ?? [], date: url.searchParams.get("date") }));
        }
        if (p === "luar-rute" && req.method() === "POST") {
            const b = req.postDataJSON() as { customerNo: string };
            const pel = PELANGGAN_B.find((x) => x.customerNo === b.customerNo)!;
            const j = o.tambah?.shift();
            if (!j || j.terapkan) o.rute = [...(o.rute ?? []).filter((r) => r.custCode !== pel.customerNo), baris(pel.customerNo, pel.name, { id: `l-${pel.customerNo}`, luarRute: true })];
            if (j) return jawab(route, j);
            return route.fulfill(json({ ok: true, baru: true, row: { id: `l-${pel.customerNo}`, custCode: pel.customerNo, custName: pel.name, konfirmasi: "menunggu" } }, 201));
        }
        if (p === "luar-rute/konfirmasi") {
            const b = req.postDataJSON() as { id: string; keputusan: string; hari?: string; mingguPattern?: string };
            const j = o.konf?.shift();
            if (!j || j.terapkan) {
                o.luarRute = (o.luarRute ?? []).map((r) => r.id === b.id ? { ...r, konfirmasi: b.keputusan, hari: b.hari ?? null, mingguPattern: b.mingguPattern ?? null,
                    dikonfirmasiOlehNama: "SALES A", dikonfirmasiPada: new Date().toISOString() } : r);
            }
            if (j) return jawab(route, j);
            return route.fulfill(json({ ok: true, row: o.luarRute!.find((r) => r.id === b.id), jksLain: [] }));
        }
        if (p === "luar-rute/batal") {
            const { id } = req.postDataJSON() as { id: string };
            const j = o.batal?.shift();
            if (!j || j.terapkan) o.rute = (o.rute ?? []).filter((r) => r.id !== id);
            if (j) return jawab(route, j);
            return route.fulfill(json({ ok: true, row: { id } }));
        }
        if (p === "reports" && req.method() === "GET") return route.fulfill(json({ rows: [{ id: null, salesCode: "S-01", date: url.searchParams.get("date"), totalTokoJks: 2,
            totalOrder: 1, totalActive: 0, totalNotOrder: 0, totalNotVisited: 1, tindakLanjut: "", submittedAt: null, spvAck: false, spvAckAt: null }], total: 1 }));
        if (p === "jks" && req.method() === "GET") return route.fulfill(json({ rows: o.jksRows ?? [], total: (o.jksRows ?? []).length, page: 1, limit: 50 }));
        if (p === "spv-dashboard") return route.fulfill(json(o.spv ?? { rows: [], spvName: "SPV A" }));
        if (p === "sales-profiles" && req.method() === "GET") return route.fulfill(json({ rows: o.profiles ?? [], spvOptions: o.spvOptions ?? [], smOptions: o.smOptions ?? [] }));
        if (p === "sales-profiles" && req.method() === "PUT") {
            // Server menyimpan EJAAN AKUN (pilihNamaAkun), bukan ketikan.
            const b = req.postDataJSON() as { salesCode: string; spvName: string | null; smName: string | null };
            const akun = (v: string | null, opsi: string[] = []) => (v ? opsi.find((x) => x.trim().toUpperCase() === v.trim().toUpperCase()) ?? v : null);
            o.profiles = (o.profiles ?? []).map((x) => (x as { salesCode: string }).salesCode === b.salesCode
                ? { ...(x as object), spvName: akun(b.spvName, o.spvOptions), smName: akun(b.smName, o.smOptions) } : x);
            return route.fulfill(json({ success: true }));
        }
        return route.fulfill(json({ success: true, id: "x" }));
    });
    return { baca, tulis };
}

test.describe("peninjau B — ponsel 390 px", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, geolocation: { latitude: -5.1476, longitude: 119.4327 }, permissions: ["geolocation"] });

    test("B1/R-1 tambah luar rute: jawaban tidak pasti (502, tersimpan) → rute dimuat ulang, toko terlihat", async ({ page }) => {
        const o: OpsiB = { rute: [baris("C-900", "TOKO JKS A")] };
        const m = await mockB(page, o);
        await page.goto("/form-kontrol?tab=ao", NAV);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        const daftar = r.getByRole("list", { name: "Toko di rute" });
        await expect(daftar.getByRole("listitem")).toHaveCount(1, NAV);
        const sek = r.getByRole("region", { name: "Kunjungan luar rute" });
        await sek.getByRole("button", { name: "Tambah toko luar rute" }).click();
        await sek.getByLabel("Cari pelanggan").fill("pelanggan c");
        await sek.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("listitem").first().click();
        o.tambah = [{ status: 502, terapkan: true }];
        const sebelum = nBaca(m.baca, "/ao-control");
        await sek.getByRole("button", { name: "Tambah ke kunjungan hari ini" }).click();
        await expect(sek.getByRole("alert")).toContainText("belum dipastikan", NAV);
        await expect(sek.getByRole("alert")).not.toContainText("Bad Gateway");
        await expect.poll(() => nBaca(m.baca, "/ao-control"), NAV).toBeGreaterThan(sebelum);
        await expect(daftar.getByRole("listitem").filter({ hasText: "PELANGGAN C" })).toContainText("Luar rute", NAV);
        await noOverflow(page);
    });

    test("B2 Batalkan: klik ganda = 1 POST, terkunci saat rute dimuat ulang, 409 tampil, tambah ulang; sesudah Kirim status = tanpa Batalkan; di bawah kartu; SPV tanpa Batalkan", async ({ page }) => {
        const o: OpsiB = { rute: [baris("C-900", "TOKO JKS A"), baris("C-100002-CBA", "PELANGGAN B DENGAN NAMA TOKO YANG CUKUP PANJANG", { id: "l-b", luarRute: true }),
            baris("C-100003-CBA", "PELANGGAN C", { id: "l-c", luarRute: true }),
            // R-3: luar rute yang sudah punya baris AO (Kirim status rute: "tidak dikunjungi") — server menolak batal, tombol tidak ditawarkan.
            baris("C-100004-CBA", "PELANGGAN D", { id: "l-d", luarRute: true, aoStatus: "not_visited" })] };
        const m = await mockB(page, o);
        await page.goto("/form-kontrol?tab=ao", NAV);
        const daftar = page.getByRole("region", { name: "Rute hari ini" }).getByRole("list", { name: "Toko di rute" });
        await expect(daftar.getByRole("listitem")).toHaveCount(4, NAV);
        await expect(daftar.getByRole("button", { name: /^Batalkan kunjungan/ })).toHaveCount(2);
        await expect(daftar.getByRole("button", { name: "Batalkan kunjungan PELANGGAN D" })).toHaveCount(0);
        // R-6: tombol di baris bawah kartu — judul toko panjang tidak diperas (tombol di bawah judul, judul selebar kolom isi).
        const kartuB = daftar.getByRole("listitem").filter({ hasText: "PELANGGAN B DENGAN" });
        const bB = daftar.getByRole("button", { name: /^Batalkan kunjungan PELANGGAN B/ });
        const judul = (await kartuB.getByRole("link").boundingBox())!;
        expect((await bB.boundingBox())!.y).toBeGreaterThanOrEqual(judul.y + judul.height - 1);
        expect(judul.width).toBeGreaterThan(250);
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm2/ponsel-batalkan-bawah-kartu.png", fullPage: true });

        // Klik ganda pada konfirmasi + muat ulang lambat: satu POST, Batalkan lain terkunci selama rute dimuat ulang.
        o.batal = [{ status: 200, body: { ok: true, row: { id: "l-b" } }, delay: 1200, terapkan: true }];
        o.ruteGet = [{ status: 200, delay: 3000, terapkan: true }];
        await bB.click();
        const d = page.getByRole("dialog", { name: /^Batalkan kunjungan PELANGGAN B/ });
        await d.getByRole("button", { name: "Batalkan kunjungan" }).dblclick();
        await expect(d).toBeHidden(NAV);
        expect(postKe(m.tulis, "/luar-rute/batal"), "klik ganda = satu POST").toEqual([{ id: "l-b" }]);
        await expect(daftar.getByRole("button", { name: "Batalkan kunjungan PELANGGAN C" })).toBeDisabled();
        await expect(daftar.getByRole("listitem")).toHaveCount(3, NAV);
        await expect(daftar.getByRole("button", { name: "Batalkan kunjungan PELANGGAN C" })).toBeEnabled(NAV);

        // 409 berkode di dialog (kalimat server apa adanya).
        o.batal = [{ status: 409, body: { ok: false, kode: "SUDAH_DIKUNJUNGI", error: "PELANGGAN C sudah punya status hari ini (check-in, status rute — termasuk \"tidak dikunjungi\" dari Kirim status rute — atau merchandising); kunjungannya tidak bisa dibatalkan." } }];
        await daftar.getByRole("button", { name: "Batalkan kunjungan PELANGGAN C" }).click();
        const d2 = page.getByRole("dialog", { name: "Batalkan kunjungan PELANGGAN C?" });
        await d2.getByRole("button", { name: "Batalkan kunjungan" }).click();
        await expect(d2.getByRole("alert")).toContainText("sudah punya status hari ini", NAV);
        await d2.getByRole("button", { name: "Kembali" }).click();

        // Sesudah batal: toko B bisa ditambah ulang.
        const sek = page.getByRole("region", { name: "Kunjungan luar rute" });
        await sek.getByRole("button", { name: "Tambah toko luar rute" }).click();
        await sek.getByLabel("Cari pelanggan").fill("pelanggan b");
        await sek.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("listitem").first().click();
        await sek.getByRole("button", { name: "Tambah ke kunjungan hari ini" }).click();
        await expect(daftar.getByRole("listitem").filter({ hasText: "PELANGGAN B" })).toContainText("Luar rute", NAV);

        // SPV melihat rute salesman: tanpa Batalkan & tanpa Tambah.
        await mockB(page, { scope: { role: "spv", salesName: "SPV A", spvName: "SPV A", allowedSalesCodes: ["S-01"], principles: ["PRINCIPLE A"] }, rute: o.rute });
        await page.goto("/form-kontrol?tab=ao", NAV);
        await page.getByLabel("Salesman tim").selectOption("S-01");
        await expect(daftar.getByRole("listitem")).toHaveCount(4, NAV);
        await expect(page.getByRole("button", { name: /^Batalkan kunjungan/ })).toHaveCount(0);
        await expect(page.getByRole("region", { name: "Kunjungan luar rute" })).toHaveCount(0);
    });

    test("B3 Konfirmasi: nama toko di kendali + alasan terlihat; 409 BELUM_DIKUNJUNGI; 409 SUDAH_DI_JKS dan 502 → muat ulang; klik ganda = 1 POST; muat ulang gagal = strip + kunci", async ({ page }) => {
        const o: OpsiB = { luarRute: [
            luarPada(HARI_INI, "k1", "C-100001-CBA", "PELANGGAN A", { jksLain: [{ salesCode: "S-02", salesName: "SALES B", custCode: "C-100001", hariKunjungan: "Rabu", mingguPattern: "ganjil" }] }),
            luarPada(HARI_INI, "k2", "C-100002-CBA", "PELANGGAN B"),
            luarPada(HARI_INI, "k3", "C-100003-CBA", "PELANGGAN C"),
            luarPada(HARI_INI, "k4", "C-100004-CBA", "PELANGGAN D"),
        ] };
        const m = await mockB(page, o);
        await page.goto("/form-kontrol?tab=laporan", NAV);
        const lap = page.getByRole("region", { name: "Laporan harian" });
        const sek = lap.getByRole("region", { name: "Toko luar rute" });
        const item = (n: string) => sek.getByRole("list", { name: "Toko luar rute" }).getByRole("listitem").filter({ hasText: n });
        await expect(sek).toContainText("4 menunggu keputusan", NAV);
        // R-4: kendali per toko bernama toko; alasan tombol nonaktif terlihat (bukan hanya title).
        const a = item("PELANGGAN A");
        await expect(a.getByRole("combobox", { name: "Hari kunjungan PELANGGAN A" })).toBeVisible();
        await expect(a.getByRole("combobox", { name: "Minggu kunjungan PELANGGAN A" })).toBeVisible();
        await expect(a.getByRole("button", { name: "Masukkan ke JKS: PELANGGAN A" })).toBeDisabled();
        await expect(a.locator("p.fi-why", { hasText: "Pilih hari" })).toBeVisible();
        await expect(a.getByRole("button", { name: "Jangan masukkan JKS: PELANGGAN A" })).toBeEnabled();
        for (const n of ["Masukkan ke JKS", "Jangan masukkan JKS"]) expect((await a.getByRole("button", { name: n }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await noOverflow(page);

        // 409 BELUM_DIKUNJUNGI: kalimat server (tanggal format Indonesia) tampil di barisnya.
        o.konf = [{ status: 409, body: { ok: false, kode: "BELUM_DIKUNJUNGI", error: "PELANGGAN A belum dikunjungi pada Selasa, 13 Okt 2026 (belum ada check-in, hasil kunjungan, atau merchandising); kunjungi dulu sebelum memasukkan ke JKS." } }];
        await a.getByLabel("Hari").selectOption("Senin");
        await a.getByLabel("Minggu").selectOption("all");
        // 409 → daftar dimuat ulang (keputusan dikunci selama memuat). Jeda 1,5 dtk membuat jendela muat ulang PASTI terlihat: uji ini dulu
        // mengubah data server (SUDAH_DI_JKS di bawah) SEBELUM muat ulang ini selesai → muat ulang membawa B "sudah di JKS", tombol B lenyap,
        // klik menunggu 150 dtk (flaky sejak 13 Okt, bergantung kecepatan mesin; bukan tanggal, bukan kode app). Tunggu muat ulang selesai dulu.
        const g409 = nBaca(m.baca, "/luar-rute");
        o.luarGet = [{ status: 200, delay: 1500, terapkan: true }];
        await a.getByRole("button", { name: "Masukkan ke JKS" }).click();
        await expect(a.getByRole("alert")).toContainText("belum dikunjungi pada Selasa, 13 Okt 2026", NAV);
        await expect(item("PELANGGAN B").locator("p.fi-why", { hasText: "Menunggu daftar dimuat ulang" })).toBeVisible();
        await expect.poll(() => nBaca(m.baca, "/luar-rute"), NAV).toBeGreaterThan(g409);
        await expect(item("PELANGGAN B").getByRole("button", { name: "Jangan masukkan JKS" })).toBeEnabled(NAV);
        await expect(a.getByRole("alert"), "galat bertahan melewati muat ulang").toContainText("belum dikunjungi pada Selasa, 13 Okt 2026");

        // 409 SUDAH_DI_JKS: server sudah mengubah baris menjadi sudah_jks → daftar dimuat ulang, baris jadi "Sudah di JKS Anda", hitungan benar.
        const g0 = nBaca(m.baca, "/luar-rute");
        o.konf = [{ status: 409, body: { ok: false, kode: "SUDAH_DI_JKS", error: "PELANGGAN B sudah ada di JKS Anda (C-100002: Senin · setiap minggu); tidak ditambahkan lagi — kunjungan ini ditandai \"sudah di JKS\"." } }];
        o.luarRute = o.luarRute!.map((r) => r.id === "k2" ? { ...r, konfirmasi: "sudah_jks", jksSaya: [{ salesCode: "S-01", salesName: "SALES A", custCode: "C-100002", hariKunjungan: "Senin", mingguPattern: "all" }] } : r);
        await item("PELANGGAN B").getByRole("button", { name: "Jangan masukkan JKS" }).click();
        await expect(item("PELANGGAN B")).toContainText("Sudah di JKS Anda: Senin · setiap minggu", NAV);
        await expect(item("PELANGGAN B").getByRole("button", { name: /JKS/ })).toHaveCount(0);
        expect(nBaca(m.baca, "/luar-rute")).toBeGreaterThan(g0);
        await expect(sek).toContainText("3 menunggu keputusan");

        // 502 tak pasti (sudah tersimpan): muat ulang → keadaan server tampil.
        o.konf = [{ status: 502, terapkan: true }];
        await item("PELANGGAN C").getByRole("button", { name: "Jangan masukkan JKS" }).click();
        await expect(item("PELANGGAN C")).toContainText("Tidak dimasukkan JKS", NAV);
        await expect(sek).toContainText("2 menunggu keputusan");

        // Klik ganda (jawaban lambat) = satu POST; lalu muat ulang gagal → strip "hasil sebelumnya" + Coba lagi, keputusan lain dikunci.
        const nPost = postKe(m.tulis, "/luar-rute/konfirmasi").length;
        o.konf = [{ status: 200, body: { ok: true, row: {}, jksLain: [] }, delay: 1000, terapkan: true }];
        o.luarGet = [{ status: 500, body: { ok: false, error: "Internal server error" } }];
        await item("PELANGGAN D").getByRole("button", { name: "Jangan masukkan JKS" }).dblclick();
        await expect(item("PELANGGAN D")).toContainText("Tidak dimasukkan JKS", NAV);
        expect(postKe(m.tulis, "/luar-rute/konfirmasi").length - nPost, "klik ganda = satu POST").toBe(1);
        const strip = sek.getByRole("alert").filter({ hasText: "Gagal memuat ulang daftar toko luar rute." });
        await expect(strip).toContainText("Yang tampil hasil sebelumnya", NAV);
        await expect(a.getByRole("button", { name: "Jangan masukkan JKS" })).toBeDisabled();
        await expect(a.locator("p.fi-why", { hasText: "Daftar gagal dimuat ulang; tekan Coba lagi dulu" })).toBeVisible();
        await page.screenshot({ path: "test-results/fkmsm2/ponsel-konfirmasi-muat-ulang-gagal.png", fullPage: true });
        await strip.getByRole("button", { name: "Coba lagi" }).click();
        await expect(strip).toHaveCount(0, NAV);
        await expect(a.getByRole("button", { name: "Jangan masukkan JKS" })).toBeEnabled();

        // "Nanti": laporan tetap terkirim.
        await lap.getByLabel("Tindak lanjut untuk SPV").fill("Kunjungi ulang toko luar rute");
        await lap.getByRole("button", { name: "Kirim laporan ke SPV…" }).click();
        await expect(page.getByRole("dialog")).toContainText("1 (boleh nanti)");
        await page.getByRole("dialog").getByRole("button", { name: "Kirim laporan" }).click();
        await expect.poll(() => postKe(m.tulis, "/reports").length).toBe(1);
        await noOverflow(page);
    });

    test("B3b Laporan: daftar luar rute gagal = galat (bukan kosong), kartu \"—\", kirim laporan tidak tertahan", async ({ page }) => {
        const o: OpsiB = { luarGagal: 99 };
        const m = await mockB(page, o);
        await page.goto("/form-kontrol?tab=laporan", NAV);
        const lap = page.getByRole("region", { name: "Laporan harian" });
        await expect(lap.getByRole("alert").filter({ hasText: "Daftar toko luar rute gagal dimuat." })).toBeVisible(NAV);
        await expect(lap.locator(".fi-kc", { hasText: "Luar rute dikunjungi" }).locator("b")).toHaveText("—");
        await lap.getByLabel("Tindak lanjut untuk SPV").fill("Catatan");
        await lap.getByRole("button", { name: "Kirim laporan ke SPV…" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Kirim laporan" }).click();
        await expect.poll(() => postKe(m.tulis, "/reports").length).toBe(1);
        o.luarGagal = 0;
        await lap.getByRole("button", { name: "Coba lagi" }).first().click();
        await expect(lap.getByRole("alert").filter({ hasText: "Daftar toko luar rute gagal dimuat." })).toHaveCount(0, NAV);
    });

    for (const [tgl, harap] of [["2026-10-21", "ganjil"], ["2027-01-04", "genap"], ["2026-12-28", "ganjil"]] as const) {
        test(`B3c penanda "(minggu ini)" ${tgl} = ${harap} (acuan selang-seling, bukan ISO)`, async ({ page }) => {
            await page.clock.setFixedTime(new Date(`${tgl}T10:00:00+08:00`));
            await mockB(page, { luarRute: [luarPada(tgl, "k1", "C-100001-CBA", "PELANGGAN A")] });
            await page.goto("/form-kontrol?tab=laporan", NAV);
            const sel = page.getByRole("region", { name: "Toko luar rute" }).getByLabel("Minggu");
            await expect(sel.locator("option", { hasText: "(minggu ini)" })).toHaveCount(1, NAV);
            await expect(sel.locator(`option[value="${harap}"]`)).toHaveText(/\(minggu ini\)$/);
        });
    }

    test("B4 SPV 390: JKS bertanda tambahan salesman; Dashboard SPV bertanda Luar rute", async ({ page }) => {
        const jksRow = (custCode: string, tambahan: unknown) => ({ id: custCode, salesCode: "S-01", salesName: "SALES A", custCode, custName: `TOKO ${custCode}`,
            market: null, alamat: null, kota: null, hariKunjungan: "Senin", mingguPattern: "all", area: null, rayon: null, principle: "PRINCIPLE A", visitFrequency: 4,
            isActive: true, tambahanSalesman: tambahan });
        await mockB(page, { scope: { role: "spv", salesName: "SPV A", spvName: "SPV A", allowedSalesCodes: ["S-01"], principles: ["PRINCIPLE A"] },
            jksRows: [jksRow("C-100001", null), jksRow("C-100002-CBA", { oleh: "SALES A", pada: jam("17:05"), dariKunjungan: HARI_INI })],
            spv: { spvName: "SPV A", rows: [{ salesCode: "S-01", salesName: "SALES A", totalRoute: 2, ordered: 1, notOrder: 0, notVisited: 1, checkedIn: 1, checkedOut: 1,
                submittedAt: null, tindakLanjut: null, visits: [{ custCode: "C-100002-CBA", custName: "PELANGGAN B", luarRute: true, status: "ordered",
                    checkinAt: jam("09:00"), checkoutAt: jam("09:20"), durationMinutes: 20, gpsFlag: null, durFlag: null, checkinPhotoUrl: null, checkoutPhotoUrl: null,
                    merchDone: 6, merchTotal: 6 }], totalFieldMinutes: 20 }] } });
        await page.goto("/form-kontrol?tab=jks", NAV);
        const main = page.locator("main");
        const tambahan = main.getByRole("listitem").filter({ hasText: "C-100002-CBA" });
        await expect(tambahan).toContainText("Tambahan salesman", NAV);
        await expect(tambahan).toContainText("ditambahkan salesman oleh SALES A");
        await expect(main.getByRole("listitem").filter({ hasText: "TOKO C-100001" }).first()).not.toContainText("Tambahan salesman");
        await noOverflow(page);
        await page.goto("/form-kontrol/spv-dashboard", NAV);
        await page.getByText("Detail kunjungan (1)").click();
        await expect(page.getByRole("listitem").filter({ hasText: "PELANGGAN B" })).toContainText("Luar rute", NAV);
        await noOverflow(page);
    });

    test("B7/R-7 tanda prioritas belum dikirim bertahan melewati muat ulang rute (Tambah luar rute, Batalkan); toko yang hilang disebut + tandanya dibuang; Kirim status membawa tanda", async ({ page }) => {
        const o: OpsiB = { rute: [baris("C-900", "TOKO JKS A"), baris("C-100002-CBA", "PELANGGAN B", { id: "l-b", luarRute: true })] };
        const m = await mockB(page, o);
        await page.goto("/form-kontrol?tab=ao", NAV);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        const daftar = r.getByRole("list", { name: "Toko di rute" });
        await expect(daftar.getByRole("listitem")).toHaveCount(2, NAV);
        await r.getByRole("button", { name: "Prioritas TOKO JKS A" }).click();
        await r.getByRole("button", { name: "Prioritas PELANGGAN B" }).click();
        await expect(r.getByText("2 tanda prioritas belum dikirim")).toBeVisible();

        // Tambah luar rute → rute dimuat ulang: kedua tanda tetap (dulu hilang diam).
        const sek = r.getByRole("region", { name: "Kunjungan luar rute" });
        await sek.getByRole("button", { name: "Tambah toko luar rute" }).click();
        await sek.getByLabel("Cari pelanggan").fill("pelanggan c");
        await sek.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("listitem").first().click();
        const g0 = nBaca(m.baca, "/ao-control");
        await sek.getByRole("button", { name: "Tambah ke kunjungan hari ini" }).click();
        await expect(daftar.getByRole("listitem")).toHaveCount(3, NAV);
        await expect.poll(() => nBaca(m.baca, "/ao-control")).toBeGreaterThan(g0);
        await expect(r.getByText("2 tanda prioritas belum dikirim")).toBeVisible();
        await expect(r.getByRole("button", { name: "Prioritas TOKO JKS A" })).toHaveAttribute("aria-pressed", "true");
        await expect(r.getByRole("button", { name: "Prioritas PELANGGAN B" })).toHaveAttribute("aria-pressed", "true");

        // Batalkan PELANGGAN B (bertanda) → keluar dari rute: tandanya dibuang DAN disebut; tanda TOKO JKS A tetap.
        await daftar.getByRole("button", { name: "Batalkan kunjungan PELANGGAN B" }).click();
        await page.getByRole("dialog", { name: "Batalkan kunjungan PELANGGAN B?" }).getByRole("button", { name: "Batalkan kunjungan" }).click();
        await expect(daftar.getByRole("listitem")).toHaveCount(2, NAV);
        const strip = r.getByRole("status").filter({ hasText: "1 tanda prioritas dibuang." });
        await expect(strip).toContainText("PELANGGAN B tidak lagi ada di rute ini");
        await expect(r.getByText("1 tanda prioritas belum dikirim")).toBeVisible();
        await expect(r.getByRole("button", { name: "Prioritas TOKO JKS A" })).toHaveAttribute("aria-pressed", "true");
        await noOverflow(page);
        await strip.scrollIntoViewIfNeeded();
        await page.screenshot({ path: "test-results/fkmsm3/ponsel-r7-tanda-dibuang.png" });
        // Peninjau B R-5: sasaran sentuh Tutup pesan >= 44 px; sesudah ditutup fokus ke judul "Rute hari ini", bukan BODY.
        expect((await strip.getByRole("button", { name: "Tutup pesan" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await strip.getByRole("button", { name: "Tutup pesan" }).click();
        await expect(strip).toHaveCount(0);
        await expect(r.getByRole("heading", { name: "Rute hari ini" })).toBeFocused();

        // Kirim status membawa tanda yang bertahan (dari bacaan rute terbaru).
        await r.getByRole("button", { name: /^Kirim status rute/ }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Kirim status" }).click();
        await expect(page.getByRole("dialog")).toBeHidden(NAV);
        expect(postKe(m.tulis, "/ao-control").map((b) => [b.custCode, b.status])).toEqual([["C-900", "priority"], ["C-100003-CBA", "not_visited"]]);
        await expect(r.getByText(/tanda prioritas belum dikirim/)).toHaveCount(0);
    });

    test("D7 Konfirmasi: selama daftar dimuat ulang sesudah keputusan, keputusan toko lain DIKUNCI dengan alasan terlihat; sesudah termuat terbuka", async ({ page }) => {
        const o: OpsiB = { luarRute: [luarPada(HARI_INI, "k1", "C-100001-CBA", "PELANGGAN A"), luarPada(HARI_INI, "k2", "C-100002-CBA", "PELANGGAN B")] };
        await mockB(page, o);
        await page.goto("/form-kontrol?tab=laporan", NAV);
        const sek = page.getByRole("region", { name: "Laporan harian" }).getByRole("region", { name: "Toko luar rute" });
        const item = (n: string) => sek.getByRole("list", { name: "Toko luar rute" }).getByRole("listitem").filter({ hasText: n });
        await expect(sek).toContainText("2 menunggu keputusan", NAV);
        const tidakB = item("PELANGGAN B").getByRole("button", { name: "Jangan masukkan JKS: PELANGGAN B" });
        await expect(tidakB).toBeEnabled();
        o.luarGet = [{ status: 200, delay: 3000, terapkan: true }];
        await item("PELANGGAN A").getByRole("button", { name: "Jangan masukkan JKS" }).click();
        await expect(item("PELANGGAN A")).toContainText("Tidak dimasukkan JKS", NAV);
        await expect(tidakB).toBeDisabled();
        await expect(item("PELANGGAN B").getByRole("button", { name: "Masukkan ke JKS: PELANGGAN B" })).toBeDisabled();
        await expect(item("PELANGGAN B").locator("p.fi-why", { hasText: "Menunggu daftar dimuat ulang" })).toBeVisible();
        await expect(tidakB).toBeEnabled(NAV);
        await expect(item("PELANGGAN B").locator("p.fi-why", { hasText: "Menunggu daftar dimuat ulang" })).toHaveCount(0);
    });

    test("FK-MSM3 Kirim status: toko luar rute dibatalkan di layar lain → 409 KUNJUNGAN_DIBATALKAN di dialog (berhenti di toko itu), rute dimuat ulang tanpa toko itu", async ({ page }) => {
        const awal = [baris("C-900", "TOKO JKS A"), baris("C-100002-CBA", "PELANGGAN B", { id: "l-b", luarRute: true }), baris("C-901", "TOKO JKS C")];
        const o: OpsiB = { rute: awal };
        const m = await mockB(page, o);
        await page.goto("/form-kontrol?tab=ao", NAV);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        const daftar = r.getByRole("list", { name: "Toko di rute" });
        await expect(daftar.getByRole("listitem")).toHaveCount(3, NAV);
        // Bacaan ulang sebelum kirim masih memuat PELANGGAN B; layar lain lalu membatalkannya → server menolak statusnya.
        o.ruteGet = [{ status: 200, body: { rows: awal, summary: {}, date: HARI_INI } }];
        o.rute = [awal[0], awal[2]];
        o.aoPost = [{ status: 200, body: { success: true, id: "a1" } }, { status: 409, body: { ok: false, kode: "KUNJUNGAN_DIBATALKAN",
            error: "Kunjungan luar rute PELANGGAN B pada Selasa, 13 Okt 2026 sudah dibatalkan, jadi tidak dicatat. Bila toko ini memang dikunjungi, tambahkan lagi lewat Kunjungan luar rute." } }];
        const g0 = nBaca(m.baca, "/ao-control");
        await r.getByRole("button", { name: /^Kirim status rute/ }).click();
        const d = page.getByRole("dialog");
        await d.getByRole("button", { name: "Kirim status" }).click();
        await expect(d.getByRole("alert")).toContainText("sudah dibatalkan, jadi tidak dicatat", NAV);
        await expect(d.getByRole("alert")).toContainText("Berhenti di PELANGGAN B: 1 dari 3 toko sudah terkirim. Belum dikirim: TOKO JKS C.");
        await expect(d.getByRole("alert")).toContainText("Tekan Kirim status lagi untuk melanjutkan");
        await expect.poll(() => nBaca(m.baca, "/ao-control"), NAV).toBe(g0 + 2);
        await d.getByRole("button", { name: "Batal" }).click();
        await expect(daftar.getByRole("listitem")).toHaveCount(2, NAV);
        await expect(daftar).not.toContainText("PELANGGAN B");
        expect(postKe(m.tulis, "/ao-control").map((b) => b.custCode)).toEqual(["C-900", "C-100002-CBA"]);
        await noOverflow(page);
    });

    test("FK-MSM3 K1 Kunjungan: check-in ditolak 409 KUNJUNGAN_DIBATALKAN → penjelasan (check-in tidak tercatat) + Rute hari ini di bagian luar rute", async ({ page }) => {
        const o: OpsiB = { visit: { store: STORE_LUAR, ao: null, merch: null }, checkin: [K409("KUNJUNGAN_DIBATALKAN", MSG_BATAL)], rute: ruteN(10) };
        const m = await mockB(page, o);
        await page.goto(kunjunganUrl("C-100002-CBA"), NAV);
        await expect(page.getByRole("heading", { name: "PELANGGAN B" })).toBeVisible(NAV);
        await ambilFoto(page, "Ambil foto check-in");
        const isi = page.locator(".fi-page");
        await expect(isi.getByRole("heading", { name: "Kunjungan luar rute ini sudah dibatalkan" })).toBeVisible(NAV);
        await expect(isi).toContainText("sudah dibatalkan, jadi tidak dicatat");
        await expect(isi).toContainText("Check-in ini tidak tercatat.");
        expect(postKe(m.tulis, "/checkin")).toHaveLength(1);
        const penjaga = await page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
        expect(penjaga, "tak ada penjaga beforeunload tertinggal").toBe(false);
        await noOverflow(page);
        await isi.getByRole("link", { name: "Rute hari ini" }).click();
        const tambah = page.getByRole("region", { name: "Kunjungan luar rute" }).getByRole("button", { name: "Tambah toko luar rute" });
        await expect(tambah).toBeFocused(NAV);
        await expect.poll(() => tambah.evaluate((e) => e.getBoundingClientRect().bottom <= innerHeight), NAV).toBe(true);
    });

    test("FK-MSM3 K2/K4 Kunjungan: toko JKS hari lain — judul 'tidak ada di rute hari ini'; merchandising 409 sesudah check-in → isian disebut tidak tersimpan", async ({ page }) => {
        const o: OpsiB = { visit: { store: STORE_JKS, ao: null, merch: null }, checkin: [K409("BUKAN_RUTE_HARI_INI", MSG_BUKAN)], rute: ruteN(3) };
        await mockB(page, o);
        await page.goto(kunjunganUrl("C-900"), NAV);
        await expect(page.getByRole("heading", { name: "Mulai kunjungan" })).toBeVisible(NAV);
        await ambilFoto(page, "Ambil foto check-in");
        const isi = page.locator(".fi-page");
        await expect(isi.getByRole("heading", { name: "Toko ini tidak ada di rute hari ini" })).toBeVisible(NAV);
        await expect(isi).not.toContainText("tidak lagi di rute");
        await expect(isi).toContainText("TOKO JKS A (C-900) tidak ada di rute");

        // K4: merchandising 409 sesudah check-in + status → wizard diganti; check-in tetap tercatat.
        o.visit = { store: STORE_JKS, ao: { ...AO_CHECKIN, status: "ordered" }, merch: null };
        o.merch = [K409("BUKAN_RUTE_HARI_INI", MSG_BUKAN)];
        await page.goto(kunjunganUrl("C-900"), NAV);
        await expect(page.getByRole("heading", { name: "Hasil kunjungan" })).toBeVisible(NAV);
        await page.getByRole("button", { name: "Simpan & lanjut" }).click();
        await expect(page.getByRole("heading", { name: "Merchandising wajib" })).toBeVisible(NAV);
        for (const b of ["Produk terlihat jelas", "Display rapi & terorganisir", "Area display dibersihkan", "Produk ditata ulang", "Posisi mudah ditemukan konsumen"]) await page.getByLabel(b).check();
        await page.getByRole("listitem").filter({ hasText: "Seluruh SKU terpajang" }).getByRole("button", { name: "Foto" }).click();
        const kamera = page.getByRole("dialog", { name: "Foto Bukti Kunjungan" });
        await kamera.locator('input[type="file"]').setInputFiles({ name: "m.png", mimeType: "image/png", buffer: PNG });
        await kamera.getByRole("button", { name: /Gunakan/ }).click();
        await expect(page.getByText("6 dari 6")).toBeVisible(NAV);
        await page.getByRole("button", { name: "Simpan & lanjut" }).click();
        await expect(isi.getByRole("heading", { name: "Toko ini tidak ada di rute hari ini" })).toBeVisible(NAV);
        await expect(isi).toContainText("Isian di layar ini tidak tersimpan; check-in yang sudah dikirim tetap tercatat.");
        await noOverflow(page);
    });

    test("FK-MSM3 N1 Toko Tidak Order: 409 → muat ulang; penolakan bernama toko di strip tab; ketikan toko lain bertahan", async ({ page }) => {
        const B = baris("C-100002-CBA", "PELANGGAN B", { id: "l-b", luarRute: true, aoStatus: "not_order", noOrderReasonCode: "R01", noOrderNote: "" });
        const C = baris("C-901", "TOKO JKS C", { aoStatus: "not_order", noOrderReasonCode: "R01", noOrderNote: "" });
        const o: OpsiB = { rute: [B, C], aoPost: [K409("BUKAN_RUTE_HARI_INI", "PELANGGAN B (C-100002-CBA) tidak ada di rute S-01 (PRINCIPLE A) pada Selasa, 13 Okt 2026, jadi tidak dicatat.")] };
        const m = await mockB(page, o);
        await page.goto("/form-kontrol?tab=no-order", NAV);
        const sek = page.locator("main");
        const daftar = sek.getByRole("list", { name: "Toko tidak order" });
        await expect(daftar.getByRole("listitem")).toHaveCount(2, NAV);
        const li = (n: string) => daftar.getByRole("listitem", { name: n });
        await li("TOKO JKS C").getByLabel("Catatan").fill("catatan C belum disimpan");
        await li("PELANGGAN B").getByLabel("Alasan tidak order").selectOption("R01");
        await li("PELANGGAN B").getByLabel("Catatan").fill("ubah B");
        o.rute = [C]; // B tidak lagi di rute
        await li("PELANGGAN B").getByRole("button", { name: "Simpan alasan" }).click();
        await expect.poll(() => postKe(m.tulis, "/ao-control").length, NAV).toBe(1);
        await expect(daftar.getByRole("listitem")).toHaveCount(1, NAV);
        const strip = sek.getByRole("status").filter({ hasText: "Alasan 1 toko tidak tersimpan." });
        await expect(strip).toContainText("PELANGGAN B: PELANGGAN B (C-100002-CBA) tidak ada di rute");
        await expect(li("TOKO JKS C").getByLabel("Catatan")).toHaveValue("catatan C belum disimpan");
        await expect(li("TOKO JKS C").getByText("Belum disimpan")).toBeVisible();
        await noOverflow(page);
        await page.screenshot({ path: "test-results/fkmsm3/ponsel-tidak-order-409.png", fullPage: true });
        await strip.getByRole("button", { name: "Tutup pesan" }).click();
        await expect(strip).toHaveCount(0);
        await expect(sek.getByRole("heading", { name: "Toko tidak order", exact: true }).first()).toBeFocused();
    });

    test("FK-MSM3 R1/R2 Rute: tanda tak berlaku untuk toko yang sudah punya hasil kunjungan; tanda bertahan sesudah membuka Kunjungan lalu kembali", async ({ page }) => {
        const A = baris("C-900", "TOKO JKS A"), Bb = baris("C-901", "TOKO JKS B");
        const o: OpsiB = { rute: [A, Bb], visit: { store: STORE_JKS, ao: null, merch: null } };
        const m = await mockB(page, o);
        await page.goto("/form-kontrol?tab=ao", NAV);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        await expect(r.getByRole("list", { name: "Toko di rute" }).getByRole("listitem")).toHaveCount(2, NAV);
        await r.getByRole("button", { name: "Prioritas TOKO JKS A" }).click();
        await r.getByRole("button", { name: "Prioritas TOKO JKS B" }).click();
        await expect(r.getByText("2 tanda prioritas belum dikirim")).toBeVisible();
        // R1(b): A sudah berhasil dikunjungi di layar lain → tanda A tak berlaku sesudah muat ulang.
        o.rute = [baris("C-900", "TOKO JKS A", { aoStatus: "ordered", checkinAt: `${HARI_INI}T09:00:00+08:00`, checkoutAt: `${HARI_INI}T09:20:00+08:00` }), Bb];
        const g0 = nBaca(m.baca, "/ao-control");
        await r.getByRole("button", { name: "Muat ulang" }).click();
        await expect.poll(() => nBaca(m.baca, "/ao-control"), NAV).toBeGreaterThan(g0);
        await expect(r.getByText("1 tanda prioritas belum dikirim")).toBeVisible(NAV);
        await expect(r.getByRole("button", { name: "Prioritas TOKO JKS A" })).toHaveAttribute("aria-pressed", "false");
        // R2 (S-3): buka Kunjungan lalu kembali → tanda B masih ada.
        await r.getByRole("link", { name: /TOKO JKS A/ }).click();
        await expect(page.getByRole("heading", { name: "TOKO JKS A" })).toBeVisible(NAV);
        await page.goBack();
        const r2 = page.getByRole("region", { name: "Rute hari ini" });
        await expect(r2.getByRole("list", { name: "Toko di rute" }).getByRole("listitem")).toHaveCount(2, NAV);
        await expect(r2.getByText("1 tanda prioritas belum dikirim")).toBeVisible(NAV);
        await expect(r2.getByRole("button", { name: "Prioritas TOKO JKS B" })).toHaveAttribute("aria-pressed", "true");
    });

    test("FK-MSM3 R3/R4 Rute: draf berkunci tanggal (23.59 → 00.00 WITA tidak bocor) dan principal (A bertahan sesudah menandai B); sessionStorage diblokir tidak merusak", async ({ page }) => {
        await page.addInitScript(() => {
            Object.defineProperty(window, "sessionStorage", { get() { throw new DOMException("diblokir", "SecurityError"); } });
        });
        await page.clock.setFixedTime(new Date("2026-10-13T23:59:30+08:00"));
        const A1 = baris("C-900", "TOKO JKS A"), B1 = { ...baris("C-950", "TOKO B1"), principle: "PRINCIPLE B" };
        const o: OpsiB = { scope: { ...SALESMAN, principles: ["PRINCIPLE A", "PRINCIPLE B"] }, rutePer: { "PRINCIPLE A": [A1, baris("C-901", "TOKO JKS B")], "PRINCIPLE B": [B1] } };
        const m = await mockB(page, o);
        const galat: string[] = [];
        page.on("pageerror", (e) => galat.push(e.message));
        await page.goto("/form-kontrol?tab=ao", NAV);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        await r.getByLabel("Principal").selectOption("PRINCIPLE A");
        await expect(r.getByRole("button", { name: "Prioritas TOKO JKS A" })).toBeVisible(NAV);
        await r.getByRole("button", { name: "Prioritas TOKO JKS A" }).click();
        // R4: tandai di principal B lalu kembali ke A → tanda A tetap.
        await r.getByLabel("Principal").selectOption("PRINCIPLE B");
        await r.getByRole("button", { name: "Prioritas TOKO B1" }).click();
        await r.getByLabel("Principal").selectOption("PRINCIPLE A");
        await expect(r.getByRole("button", { name: "Prioritas TOKO JKS A" })).toHaveAttribute("aria-pressed", "true", NAV);
        await expect(r.getByText("1 tanda prioritas belum dikirim")).toBeVisible();
        // R3: ganti hari → rute hari baru tanpa tanda kemarin; kiriman hanya membawa tanda hari baru.
        await page.clock.setFixedTime(new Date("2026-10-14T00:00:30+08:00"));
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(r.getByRole("status").filter({ hasText: "Tanggal sudah berganti." })).toBeVisible(NAV);
        await r.getByRole("button", { name: /^Muat rute/ }).click();
        await expect(r.getByText("Rabu, 14 Okt 2026 · WITA")).toBeVisible(NAV);
        await expect(r.getByRole("button", { name: "Prioritas TOKO JKS A" })).toHaveAttribute("aria-pressed", "false");
        await expect(r.getByText(/tanda prioritas belum dikirim/)).toHaveCount(0);
        await r.getByRole("button", { name: "Prioritas TOKO JKS B" }).click();
        await r.getByRole("button", { name: /^Kirim status rute/ }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Kirim status" }).click();
        await expect(page.getByRole("dialog")).toBeHidden(NAV);
        expect(postKe(m.tulis, "/ao-control").map((b) => [b.custCode, b.status, b.date])).toEqual([["C-900", "not_visited", "2026-10-14"], ["C-901", "priority", "2026-10-14"]]);
        expect(galat, "tanpa galat peramban walau sessionStorage melempar").toEqual([]);
    });

    test("B5b/R-2 Hierarki: ejaan lama SM ('adnan') + simpan SPV → sesudah tersimpan baris tidak tetap Draf", async ({ page }) => {
        const o: OpsiB = { scope: { role: "admin", allowedSalesCodes: null, principles: ["CABANG A"] },
            profiles: [{ salesCode: "M-03", salesName: "SALES C", principle: "CABANG A", branch: "CABANG A", spvName: null, smName: "adnan" }],
            spvOptions: ["SPV B"], smOptions: ["ADNAN"] };
        const m = await mockB(page, o);
        await page.goto("/form-kontrol?tab=hierarki", NAV);
        const main = page.locator("main");
        const c = main.getByRole("listitem").filter({ hasText: "SALES C" });
        await expect(main.getByLabel("SM SALES C")).toHaveValue("ADNAN", NAV);
        await expect(c.getByText("Draf")).toHaveCount(0);
        await main.getByLabel("SPV SALES C").selectOption("SPV B");
        await c.getByRole("button", { name: "Simpan" }).click();
        const d = page.getByRole("dialog", { name: "Ubah hierarki SALES C?" });
        await d.getByRole("button", { name: "Simpan hierarki" }).click();
        await expect(d).toBeHidden(NAV);
        await expect(main.getByText("Hierarki SALES C tersimpan.")).toBeVisible();
        await expect.poll(() => m.baca.filter((u) => u.pathname.endsWith("/sales-profiles")).length).toBeGreaterThanOrEqual(2);
        await expect(c.getByText("Draf")).toHaveCount(0, NAV);
        await expect(c.getByRole("button", { name: "Simpan" })).toBeDisabled();
        await expect(main.getByText(/perubahan belum disimpan/)).toHaveCount(0);
    });
});
