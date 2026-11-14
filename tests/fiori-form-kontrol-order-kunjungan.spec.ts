/*
 * Tujuan: Dua alur order salesman di Form Kontrol (owner 14 Nov 2026). Rute hari ini: nomor urut JKS tidak tampil, limit kredit + sisa tampil,
 *   saringan = kontrol segmen. Kunjungan: Status ORDER → halaman order dibuka OTOMATIS; stok toko dari riwayat pengambilan WAJIB (10 teratas),
 *   item super WAJIB ditawarkan sebelum order. Salesman sistem principal: tanpa isian order, "Sudah input order" (dialog) = POST order-kunjungan
 *   ref principal, TIDAK ada kiriman Web Sales, kembali ke wizard di Merchandising tanpa blok item super. Salesman AccAPI: isian order terkunci
 *   sampai stok + item super lengkap; Tambah dari stok; Kirim order = simpan stok + item super DULU, lalu POST Web Sales, lalu dicatat ke
 *   kunjungan (ref websales:<id>). Ponsel 390 px: tanpa gulir menyamping.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true): `PLAYWRIGHT_BASE_URL=http://localhost:3001 npx playwright test tests/fiori-form-kontrol-order-kunjungan.spec.ts`.
 * Dependensi: /api/form-kontrol/* di-mock (status kunjungan berjalan di objek `k`), tests/helpers/order-cabang-mock (pelanggan/barang/rute/
 *   riwayat cabang + FastAPI Web Sales). Tidak menyentuh DB.
 * Side Effects: Tangkapan di test-results/order-kunjungan.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import { ID_WEBSALES, barisRiwayat, mockOrderCabang, mockWebsales, riwayatContoh } from "./helpers/order-cabang-mock";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
const jam = (hhmm: string) => `${HARI_INI}T${hhmm}:00+08:00`;
const SCOPE = { role: "salesman", salesCode: "S-01", salesName: "SALES A", spvName: "SPV A", allowedSalesCodes: ["S-01"], principles: ["CABANG A"] };
const STORE = { id: "j1", salesCode: "S-01", salesName: "SALES A", custCode: "C-01", custName: "PELANGGAN A", market: "GT", alamat: "JL. CONTOH 1", kota: "KOTA A",
    principle: "CABANG A", visitFrequency: 4, targetToko: 2_000_000 };
const SARAN = [{ kodeBarang: "A-4", kodeLain: [], namaBarang: "BARANG A4", peringkat: 1, terakhirDibeli: null }];
const URL_KUNJUNGAN = `/form-kontrol/visit/C-01?salesCode=S-01&principle=CABANG+A&date=${HARI_INI}`;

type Kunjungan = { sumber: "accapi" | "principal"; status: string; orderRef: string | null; dicatat: string | null; tersimpan: Record<string, unknown>[] };

async function mockFk(page: Page, k: Kunjungan) {
    const tulis: Request[] = [];
    await page.route("**/api/uploads/form-kontrol/**", (r) => r.fulfill({ status: 200, contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") }));
    await page.route("**/api/form-kontrol/**", async (route) => {
        const req = route.request();
        const p = new URL(req.url()).pathname.replace("/api/form-kontrol/", "");
        if (req.method() !== "GET") tulis.push(req);
        if (p === "my-scope") return route.fulfill(json(SCOPE));
        if (p === "reasons") return route.fulfill(json({ rows: [{ id: "R01", reasonCode: "R01", label: "Stok masih cukup", category: "stok" }] }));
        if (p === "ao-control" && req.method() === "GET") {
            return route.fulfill(json({ rows: [
                { id: "a1", salesCode: "S-01", custCode: "C-01", custName: "PELANGGAN A", principle: "CABANG A", aoStatus: null, urutan: 7, monthlyOrderCount: 1,
                    needsAttention: false, checkinAt: jam("08:10"), checkoutAt: null, targetToko: 2_000_000, realisasiBulan: 500_000, fakturBulan: 1,
                    adaLimit: true, limitKredit: 5_000_000, piutang: 4_100_000, alamat: "JL. CONTOH 1", kota: "KOTA A" },
                { id: "a2", salesCode: "S-01", custCode: "C-02", custName: "PELANGGAN B", principle: "CABANG A", aoStatus: null, urutan: 8, monthlyOrderCount: 0,
                    needsAttention: false, checkinAt: null, checkoutAt: null, adaLimit: true, limitKredit: 1_000_000, piutang: 1_250_000 },
            ], summary: {} }));
        }
        if (p === "ao-control") { k.status = String(req.postDataJSON().status); return route.fulfill(json({ success: true, id: "a1" })); }
        if (p === "visit") {
            return route.fulfill(json({ store: STORE, sumberOrder: k.sumber, titik: null, realisasi: { total: 500_000, faktur: 1 },
                limit: { limit: 5_000_000, piutang: 4_100_000 }, stok: [], merch: null, bukanRute: null,
                ao: { id: "a1", status: k.status, noOrderReasonCode: null, noOrderNote: null, checkinAt: jam("08:10"), checkinPhotoUrl: "/api/uploads/form-kontrol/in.jpg",
                    checkoutAt: null, checkoutPhotoUrl: null, invoiceNumber: null, orderRef: k.orderRef, orderDicatatPada: k.dicatat } }));
        }
        if (p === "item-super/saran") return route.fulfill(json({ wajib: SARAN, lain: [], tersimpan: k.tersimpan, riwayatTerbaca: true, adaDaftar: true }));
        if (p === "order-kunjungan") {
            const b = req.postDataJSON() as { itemSuper: Record<string, unknown>[]; selesai?: { ref: string } | null };
            k.tersimpan = b.itemSuper;
            if (b.selesai) { k.orderRef = b.selesai.ref; k.dicatat = new Date().toISOString(); }
            return route.fulfill(json({ success: true, id: "a1" }));
        }
        return route.fulfill(json({ success: true, id: "x" }));
    });
    return tulis;
}
const postKe = (tulis: Request[], akhir: string) => tulis.filter((r) => new URL(r.url()).pathname.endsWith(akhir)).map((r) => r.postDataJSON());
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
const RIWAYAT = () => riwayatContoh("C-01", [barisRiwayat("A-1", "BARANG A", "PCS", 24), barisRiwayat("A-2", "BARANG A2", "LSN", 2)], { jumlahFaktur: 4 });

test.use({ permissions: ["geolocation"], geolocation: { latitude: -5.147665, longitude: 119.432732 } });
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Rute hari ini: tanpa nomor urut, limit kredit + sisa (lewat limit disebut), saringan segmen; 390 px tanpa gulir menyamping", async ({ page }) => {
    await mockFk(page, { sumber: "principal", status: "not_visited", orderRef: null, dicatat: null, tersimpan: [] });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/form-kontrol?tab=ao", NAV);
    const daftar = page.getByRole("list", { name: "Toko di rute" });
    await expect(daftar.getByRole("listitem")).toHaveCount(2, NAV);
    await expect(page.getByText(/Urutan \d/)).toHaveCount(0);
    const a = daftar.getByRole("listitem").filter({ hasText: "PELANGGAN A" });
    await expect(a).toContainText("Limit kredit");
    await expect(a).toContainText("sisa 900 rb");
    await expect(a).toContainText("25% · 1 faktur");
    await expect(daftar.getByRole("listitem").filter({ hasText: "PELANGGAN B" })).toContainText("lewat 250 rb");
    const saring = page.getByRole("group", { name: "Saring toko" });
    await saring.getByRole("button", { name: /Belum selesai/ }).click();
    await expect(saring.getByRole("button", { name: /Belum selesai/ })).toHaveAttribute("aria-pressed", "true");
    await noOverflow(page);
    await page.screenshot({ path: "test-results/order-kunjungan/rute-390.png", fullPage: true });
});

test("Salesman sistem principal: ORDER membuka halaman order; stok + item super wajib; Sudah input order tanpa kiriman Web Sales; kembali di Merchandising", async ({ page }) => {
    const k: Kunjungan = { sumber: "principal", status: "not_visited", orderRef: null, dicatat: null, tersimpan: [] };
    const tulis = await mockFk(page, k);
    await mockOrderCabang(page, { peran: "sales", riwayat: RIWAYAT });
    const ws = await mockWebsales(page, { hari: HARI_INI });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL_KUNJUNGAN, NAV);
    const main = page.locator("main");
    await expect(main.getByText("Langkah 2 dari 5 · Status")).toBeVisible(NAV);
    await expect(main.getByText("Limit kredit")).toBeVisible();
    await main.getByRole("radiogroup", { name: "Hasil kunjungan" }).getByText("ORDER", { exact: true }).click();
    await expect(main.getByRole("status").filter({ hasText: "Berikutnya halaman order" })).toContainText("Sudah input order");
    await main.getByRole("button", { name: "Simpan & buka order" }).click();

    await expect(page).toHaveURL(/\/form-kontrol\/visit\/C-01\/order\?/, NAV);
    await expect(main.getByText("Langkah 3 dari 5 · Order · input di sistem CABANG A")).toBeVisible(NAV);
    // Tanpa isian order AccAPI.
    await expect(main.getByRole("list", { name: "Barang", exact: true })).toHaveCount(0);
    await expect(main.getByLabel("Cari barang")).toHaveCount(0);
    const sudah = page.getByRole("button", { name: "Sudah input order" });
    await expect(sudah).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Isi stok 2 barang lagi").first()).toBeVisible();
    await main.getByLabel("Stok di toko BARANG A (PCS), wajib").fill("10");
    await main.getByLabel("Stok di toko BARANG A2 (LSN), wajib").fill("0");
    await expect(main.getByText("2 dari 2 diisi")).toBeVisible();
    await expect(page.getByText("Tawarkan 1 item super dulu").first()).toBeVisible();
    const is = main.getByRole("list", { name: "Item super yang wajib ditawarkan" });
    await is.getByRole("radiogroup", { name: "Ditawarkan?" }).getByText("Ya").click();
    await is.getByRole("radiogroup", { name: "Dipesan toko?" }).getByText("Ya").click();
    await main.getByLabel(/Nomor order di sistem CABANG A/).fill("SO-77");
    await noOverflow(page);
    await page.screenshot({ path: "test-results/order-kunjungan/order-principal-390.png", fullPage: true });
    await sudah.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Tidak ada yang dikirim ke Accurate");
    await expect(dialog).toContainText("SO-77");
    await dialog.getByRole("button", { name: "Sudah input order" }).click();

    await expect(page).toHaveURL(/\/form-kontrol\/visit\/C-01\?/, NAV);
    await expect(main.getByText("Langkah 4 dari 5 · Merchandising")).toBeVisible(NAV);
    await expect(main.getByRole("heading", { name: "Item super" })).toHaveCount(0);
    const [simpan] = postKe(tulis, "/order-kunjungan");
    expect(simpan).toMatchObject({ salesCode: "S-01", custCode: "C-01", principle: "CABANG A", date: HARI_INI,
        selesai: { ref: "principal", nomorOrderPrincipal: "SO-77" },
        itemSuper: [{ kodeBarang: "A-4", ditawarkan: true, dipesan: true, alasan: null }] });
    expect(simpan.stok).toEqual([
        { kodeBarang: "A-1", namaBarang: "BARANG A", satuan: "PCS", stok: 10, rataBulan: 24 },
        { kodeBarang: "A-2", namaBarang: "BARANG A2", satuan: "LSN", stok: 0, rataBulan: 2 },
    ]);
    expect(ws.kirim).toHaveLength(0);
});

test("Salesman AccAPI: isian order terkunci sampai stok + item super; Kirim order = simpan dulu, lalu Web Sales, lalu dicatat ke kunjungan", async ({ page }) => {
    const k: Kunjungan = { sumber: "accapi", status: "ordered", orderRef: null, dicatat: null, tersimpan: [] };
    const tulis = await mockFk(page, k);
    await mockOrderCabang(page, { peran: "sales", riwayat: RIWAYAT });
    const ws = await mockWebsales(page, { hari: HARI_INI });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/form-kontrol/visit/C-01/order?salesCode=S-01&principle=CABANG+A&date=${HARI_INI}`, NAV);
    const main = page.locator("main");
    await expect(main.getByText("Langkah 3 dari 5 · Order · input di AccAPI")).toBeVisible(NAV);
    await expect(main.getByRole("group", { name: "Pelanggan terpilih" })).toContainText("PELANGGAN A", NAV);
    await expect(main.getByText("Isian order terkunci.")).toBeVisible();
    await expect(main.getByLabel("Cari barang")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Kirim order/ })).toHaveAttribute("aria-disabled", "true");

    await main.getByLabel("Stok di toko BARANG A (PCS), wajib").fill("10");
    await main.getByLabel("Stok di toko BARANG A2 (LSN), wajib").fill("2");
    await expect(main.getByText("Saran order 14 PCS")).toBeVisible();
    await expect(main.getByText("Stok cukup untuk sebulan")).toBeVisible();
    const is = main.getByRole("list", { name: "Item super yang wajib ditawarkan" });
    await is.getByRole("radiogroup", { name: "Ditawarkan?" }).getByText("Ya").click();
    await is.getByRole("radiogroup", { name: "Dipesan toko?" }).getByText("Tidak").click();
    await is.getByLabel("Alasan tidak dipesan").selectOption({ index: 1 });
    await expect(main.getByText("Isian order terkunci.")).toHaveCount(0);
    await main.getByRole("button", { name: "Tambah 14 PCS BARANG A ke order" }).click();
    await expect(main.getByRole("list", { name: "Barang", exact: true }).getByRole("listitem").first()).toContainText("BARANG A", NAV);
    await expect(main.getByRole("list", { name: "Barang", exact: true }).getByLabel("Jumlah")).toHaveValue("14");
    await noOverflow(page);
    await page.screenshot({ path: "test-results/order-kunjungan/order-accapi-390.png", fullPage: true });

    const kirim = page.getByRole("button", { name: /Kirim order/ });
    await expect(kirim).not.toHaveAttribute("aria-disabled", "true", NAV);
    await kirim.click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).click();
    await expect(page).toHaveURL(/\/form-kontrol\/visit\/C-01\?/, NAV);
    await expect(main.getByText("Langkah 4 dari 5 · Merchandising")).toBeVisible(NAV);

    const simpan = postKe(tulis, "/order-kunjungan");
    expect(simpan).toHaveLength(2);
    expect(simpan[0].selesai).toBeNull();
    expect(simpan[0].stok).toHaveLength(2);
    expect(simpan[1].selesai).toEqual({ ref: `websales:${ID_WEBSALES}` });
    expect(ws.kirim).toHaveLength(1);
    expect(ws.kirim[0]).toMatchObject({ customer_no: "C-01", lines: [{ code: "A-1", unit: "PCS", quantity: "14" }] });
});

test("Wizard: TIDAK ORDER melewati langkah Order dan menjawab item super di Merchandising seperti semula", async ({ page }) => {
    const k: Kunjungan = { sumber: "accapi", status: "not_visited", orderRef: null, dicatat: null, tersimpan: [] };
    await mockFk(page, k);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL_KUNJUNGAN, NAV);
    const main = page.locator("main");
    await main.getByRole("radiogroup", { name: "Hasil kunjungan" }).getByText("TIDAK ORDER", { exact: true }).click();
    await main.getByLabel("Alasan tidak order").selectOption("R01");
    await main.getByRole("button", { name: "Simpan & lanjut" }).click();
    await expect(main.getByText("Langkah 4 dari 5 · Merchandising")).toBeVisible(NAV);
    await expect(page.getByRole("list", { name: "Langkah kunjungan" })).toContainText("Order dilewati");
    await expect(main.getByRole("heading", { name: "Item super" })).toBeVisible();
    await expect(page).toHaveURL(/\/form-kontrol\/visit\/C-01\?/);
});
