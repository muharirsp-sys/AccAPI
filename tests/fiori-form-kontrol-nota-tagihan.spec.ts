/*
 * Tujuan: Form Kontrol owner 16 Nov 2026 — (1) Merchandising nonaktif: Check-in → Status → [Order] → Check-out (4 langkah tampil, tanpa POST
 *   merchandising); (2) nota belum lunas toko tampil (keluar/tertagih/sisa, umur per nota, pembayaran Incaso) dan toko bernota WAJIB mencatat
 *   hasil tagih di langkah Status (payload `tagihan`), toko tanpa nota tidak ditanya; (3) selfie check-in: wajah tidak cocok = pesan, kunjungan
 *   tetap lanjut; (4) layar Incaso Tagihan Kunjungan: saringan bawaan tidak tertagih & tidak order. Ponsel 390 px tanpa gulir menyamping.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true): `PLAYWRIGHT_BASE_URL=http://localhost:3001 npx playwright test tests/fiori-form-kontrol-nota-tagihan.spec.ts`.
 * Dependensi: /api/form-kontrol/* + /api/upload/form-kontrol di-mock (tanpa DB, tanpa Accurate, tanpa FastAPI).
 * Side Effects: Tangkapan di test-results/nota-tagihan.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
const jam = (hhmm: string) => `${HARI_INI}T${hhmm}:00+08:00`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SCOPE = { role: "salesman", salesCode: "S-01", salesName: "SALES A", spvName: "SPV A", allowedSalesCodes: ["S-01"], principles: ["CABANG A"] };
const STORE = { id: "j1", salesCode: "S-01", salesName: "SALES A", custCode: "C-01", custName: "PELANGGAN A", market: "GT", alamat: "JL. CONTOH 1", kota: "KOTA A",
    principle: "CABANG A", visitFrequency: 4, targetToko: 2_000_000 };
const URL_KUNJUNGAN = `/form-kontrol/visit/C-01?salesCode=S-01&principle=CABANG+A&date=${HARI_INI}`;
const NOTA = {
    sumber: "accurate", dibacaPada: jam("08:12"), terpotong: false,
    nota: [
        { id: 11, nomor: "INV/2610/KN0001", tanggal: "2026-10-02", jatuhTempo: "2026-11-01", nilai: 2_000_000, tertagih: 500_000, sisa: 1_500_000, umur: 45, lewatTempo: 15 },
        { id: 12, nomor: "INV/2611/KN0009", tanggal: "2026-11-10", jatuhTempo: "2026-12-10", nilai: 800_000, tertagih: 0, sisa: 800_000, umur: 6, lewatTempo: null },
    ],
    ringkas: { jumlah: 2, nilai: 2_800_000, tertagih: 500_000, sisa: 2_300_000, umurMaks: 45, lewatTempo: 1 },
    bayar: [{ fakturId: 11, tanggal: "2026-11-05", nomor: "PL/2611/0042", metode: "CASH_OTHER", nominal: 500_000 }],
};
const TANPA_NOTA = { ...NOTA, nota: [], bayar: [], ringkas: { jumlah: 0, nilai: 0, tertagih: 0, sisa: 0, umurMaks: 0, lewatTempo: 0 } };

type K = { status: string; checkin: boolean; nota: unknown; wajah?: { status: string; skor: number | null } };

async function mockFk(page: Page, k: K) {
    const tulis: Request[] = [];
    await page.route("**/api/uploads/form-kontrol/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await page.route("**/api/upload/form-kontrol", (r) => { tulis.push(r.request()); return r.fulfill(json({ url: "/api/uploads/form-kontrol/selfie.jpg" })); });
    await page.route("**/api/form-kontrol/**", async (route) => {
        const req = route.request();
        const p = new URL(req.url()).pathname.replace("/api/form-kontrol/", "");
        if (req.method() !== "GET") tulis.push(req);
        if (p === "my-scope") return route.fulfill(json(SCOPE));
        if (p === "reasons") return route.fulfill(json({ rows: [{ id: "R01", reasonCode: "R01", label: "Stok masih cukup", category: "stok" },
            { id: "R15", reasonCode: "R15", label: "Toko tutup", category: "kunjungan" }] }));
        if (p === "nota") return route.fulfill(json({ ok: true, nota: k.nota }));
        if (p === "checkin") { k.checkin = true; return route.fulfill(json({ success: true, id: "a1", diajukanKeIt: false, wajah: k.wajah ?? { status: "cocok", skor: 0.8 } })); }
        if (p === "ao-control" && req.method() === "POST") { k.status = String(req.postDataJSON().status); return route.fulfill(json({ success: true, id: "a1" })); }
        if (p === "visit") {
            return route.fulfill(json({ store: STORE, sumberOrder: "accapi", titik: null, realisasi: null, limit: null, stok: [], merch: null, bukanRute: null,
                ao: k.checkin ? { id: "a1", status: k.status, noOrderReasonCode: null, noOrderNote: null, checkinAt: jam("08:10"), checkinPhotoUrl: "/api/uploads/form-kontrol/in.jpg",
                    checkoutAt: null, checkoutPhotoUrl: null, invoiceNumber: null, orderRef: null, orderDicatatPada: null } : null }));
        }
        if (p === "item-super/saran") return route.fulfill(json({ wajib: [], lain: [], tersimpan: [], riwayatTerbaca: true, adaDaftar: false }));
        return route.fulfill(json({ success: true, id: "x" }));
    });
    return tulis;
}
const postKe = (tulis: Request[], akhir: string) => tulis.filter((r) => new URL(r.url()).pathname.endsWith(akhir)).map((r) => r.postDataJSON());
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}

test.use({ permissions: ["geolocation"], geolocation: { latitude: -5.147665, longitude: 119.432732 } });
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Nota belum lunas tampil; tidak order + tidak tertagih wajib dicatat; langsung check-out tanpa Merchandising", async ({ page }) => {
    const k: K = { status: "not_visited", checkin: true, nota: NOTA };
    const tulis = await mockFk(page, k);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL_KUNJUNGAN, NAV);
    const main = page.locator("main");
    await expect(main.getByText("Langkah 2 dari 4 · Status")).toBeVisible(NAV);
    await expect(main.getByRole("list", { name: "Langkah kunjungan" })).not.toContainText("Merchandising");
    // Ringkasan nota: jumlah, sisa, umur tertua, lewat tempo; rincian per nota + pembayaran Incaso.
    const ringkas = main.getByText("2 nota belum lunas · sisa");
    await expect(ringkas).toBeVisible(NAV);
    await ringkas.click();
    const daftar = main.getByRole("list", { name: "Nota belum lunas" });
    await expect(daftar.getByRole("listitem")).toHaveCount(2);
    await expect(daftar.getByRole("listitem").first()).toContainText("INV/2610/KN0001");
    await expect(daftar.getByRole("listitem").first()).toContainText("45 hari · lewat tempo 15 hari");
    await expect(daftar.getByRole("listitem").first()).toContainText("PL/2611/0042");
    await expect(main.getByText(/Keluar Rp\s?2\.800\.000 · tertagih Rp\s?500\.000/)).toBeVisible();

    await main.getByRole("radiogroup", { name: "Hasil kunjungan" }).getByText("TIDAK ORDER", { exact: true }).click();
    await main.getByLabel("Alasan tidak order").selectOption("R01");
    const simpan = main.getByRole("button", { name: "Simpan & lanjut" });
    await expect(simpan).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Pilih hasil tagih nota").first()).toBeVisible();
    await main.getByRole("radiogroup", { name: "Hasil tagih nota" }).getByText("Tidak tertagih", { exact: true }).click();
    await main.getByLabel("Alasan tidak tertagih").selectOption("JANJI_BAYAR");
    await main.getByLabel("Catatan tagih").fill("bayar Kamis");
    await noOverflow(page);
    await page.screenshot({ path: "test-results/nota-tagihan/status-tagihan-390.png", fullPage: true });
    await simpan.click();

    await expect(main.getByText("Langkah 4 dari 4 · Check-out")).toBeVisible(NAV);
    await expect(page.getByRole("list", { name: "Langkah kunjungan" })).toContainText("Order dilewati");
    await expect(main.getByText("Tidak tertagih · Janji bayar di kunjungan berikut")).toBeVisible();
    expect(postKe(tulis, "/ao-control")).toEqual([{ salesCode: "S-01", custCode: "C-01", principle: "CABANG A", date: HARI_INI, status: "not_order",
        noOrderReasonCode: "R01", noOrderNote: "", tagihan: { status: "tidak_tertagih", alasan: "JANJI_BAYAR", catatan: "bayar Kamis" } }]);
    expect(postKe(tulis, "/merchandising")).toHaveLength(0);
});

test("Tertagih wajib bernominal; toko tutup bernota otomatis tidak tertagih; toko tanpa nota tidak ditanya", async ({ page }) => {
    const k: K = { status: "not_visited", checkin: true, nota: NOTA };
    const tulis = await mockFk(page, k);
    await page.goto(URL_KUNJUNGAN, NAV);
    const main = page.locator("main");
    await expect(main.getByText("2 nota belum lunas · sisa")).toBeVisible(NAV);
    await main.getByRole("radiogroup", { name: "Hasil kunjungan" }).getByText("TIDAK ORDER", { exact: true }).click();
    await main.getByLabel("Alasan tidak order").selectOption("R01");
    await main.getByRole("radiogroup", { name: "Hasil tagih nota" }).getByText("Tertagih", { exact: true }).click();
    await expect(page.getByText("Isi nominal tertagih").first()).toBeVisible();
    await main.getByLabel("Nominal tertagih (Rp)").fill("750.000");
    await expect(main.getByLabel("Nominal tertagih (Rp)")).toHaveValue("750000");
    // Toko tutup: pertanyaan tagih diganti catatan otomatis.
    await main.getByLabel("Alasan tidak order").selectOption("R15");
    await expect(main.getByRole("radiogroup", { name: "Hasil tagih nota" })).toHaveCount(0);
    await expect(main.getByText("dicatat tidak tertagih karena toko tutup.")).toBeVisible();
    await main.getByLabel("Alasan tidak order").selectOption("R01");
    await main.getByRole("button", { name: "Simpan & lanjut" }).click();
    await expect(main.getByText("Langkah 4 dari 4 · Check-out")).toBeVisible(NAV);
    expect(postKe(tulis, "/ao-control")[0].tagihan).toEqual({ status: "tertagih", nominal: 750_000, catatan: null });

    // Toko tanpa nota: tidak ada pertanyaan tagih, payload tanpa kunci tagihan.
    const k2: K = { status: "not_visited", checkin: true, nota: TANPA_NOTA };
    const tulis2 = await mockFk(page, k2);
    await page.goto(URL_KUNJUNGAN, NAV);
    await expect(main.getByText("Tidak ada nota belum lunas.")).toBeVisible(NAV);
    await main.getByRole("radiogroup", { name: "Hasil kunjungan" }).getByText("TIDAK ORDER", { exact: true }).click();
    await main.getByLabel("Alasan tidak order").selectOption("R01");
    await expect(main.getByRole("radiogroup", { name: "Hasil tagih nota" })).toHaveCount(0);
    await main.getByRole("button", { name: "Simpan & lanjut" }).click();
    await expect(main.getByText("Langkah 4 dari 4 · Check-out")).toBeVisible(NAV);
    expect("tagihan" in postKe(tulis2, "/ao-control")[0]).toBe(false);
});

test("Selfie check-in: kamera depan, wajah tidak cocok = pesan untuk salesman, kunjungan tetap lanjut ke Status", async ({ page }) => {
    const k: K = { status: "not_visited", checkin: false, nota: TANPA_NOTA, wajah: { status: "beda", skor: 0.21 } };
    const tulis = await mockFk(page, k);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL_KUNJUNGAN, NAV);
    const main = page.locator("main");
    await expect(main.getByText("Langkah 1 dari 4 · Check-in")).toBeVisible(NAV);
    await expect(main.getByText(/Selfie di depan toko/)).toBeVisible();
    await main.getByRole("button", { name: "Ambil selfie check-in" }).click();
    const kamera = page.getByRole("dialog", { name: "Selfie check-in" });
    await kamera.locator('input[type="file"]').setInputFiles({ name: "selfie.png", mimeType: "image/png", buffer: PNG });
    await kamera.getByRole("button", { name: /Gunakan/ }).click();
    await expect(main.getByText("Wajah tidak cocok dengan foto acuan.")).toBeVisible(NAV);
    await expect(main.getByText("Kunjungan tetap tercatat dan ditandai untuk ditinjau SPV.")).toBeVisible();
    await expect(main.getByText("Langkah 2 dari 4 · Status")).toBeVisible();
    expect(postKe(tulis, "/checkin")).toHaveLength(1);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/nota-tagihan/selfie-beda-390.png", fullPage: true });
});

test("Tagihan Kunjungan (Incaso): bawaan tidak tertagih & tidak order; saringan lain; ponsel tanpa gulir menyamping", async ({ page }) => {
    const baris = (custCode: string, custName: string, status: string, tagih: Record<string, unknown>) => ({
        salesCode: "S-01", salesName: "SALES A", custCode, custName, principle: "CABANG A", status, noOrderReasonCode: status === "not_order" ? "R01" : null,
        checkinAt: jam("09:00"), checkoutAt: jam("09:20"), tagihNominal: null, tagihAlasan: null, tagihCatatan: null,
        nota: { jumlah: 2, nilai: 2_800_000, tertagih: 500_000, sisa: 2_300_000, umurMaks: 45, lewatTempo: 1 }, ...tagih });
    const rows = [
        baris("C-01", "PELANGGAN A", "not_order", { tagihStatus: "tidak_tertagih", tagihAlasan: "JANJI_BAYAR", tagihCatatan: "bayar Kamis" }),
        baris("C-02", "PELANGGAN B", "ordered", { tagihStatus: "tidak_tertagih", tagihAlasan: "BELUM_ADA_UANG" }),
        baris("C-03", "PELANGGAN C", "not_order", { tagihStatus: "tertagih", tagihNominal: 750_000 }),
    ];
    const diminta: string[] = [];
    await page.route("**/api/form-kontrol/tagihan**", (r) => { diminta.push(new URL(r.request().url()).searchParams.get("tanggal") ?? ""); return r.fulfill(json({ ok: true, tanggal: HARI_INI, rows })); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/tagihan-kunjungan", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Tagihan Kunjungan" })).toBeVisible(NAV);
    const saring = main.getByRole("group", { name: "Saring kunjungan" });
    await expect(saring.getByRole("button", { name: /Tidak tertagih & tidak order/ })).toHaveAttribute("aria-pressed", "true", NAV);
    // Tabel desktop dan daftar ponsel dirender keduanya (ResponsiveTable); yang dinilai = yang terlihat.
    await expect(main.getByText("PELANGGAN A").filter({ visible: true })).toHaveCount(1);
    await expect(main.getByText("PELANGGAN B")).toHaveCount(0);
    await expect(main.getByText("PELANGGAN C")).toHaveCount(0);
    await expect(main.getByText("3 kunjungan bernota · 1 tertagih")).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/nota-tagihan/incaso-390.png", fullPage: true });
    await saring.getByRole("button", { name: /^Tertagih/ }).click();
    await expect(main.getByText("PELANGGAN C").filter({ visible: true })).toHaveCount(1);
    await expect(main.getByText("PELANGGAN A")).toHaveCount(0);
    expect(diminta[0]).toBe(HARI_INI);
});
