/*
 * Tujuan: Supervisor Review SR-2 (/supervisor-review, spec docs/superpowers/specs/2026-10-16-supervisor-review-design.md §2/§4/§5) —
 *   desktop 1366 px: tabel per cabang + baris TOTAL + kolom salesman menempel saat digulir menyamping + status ikon DAN teks + baris
 *   "Tanpa salesman terpetakan" + catatan data tak lengkap; pilih salesman → rincian (belum difakturkan / tanpa check-in / luar rute / jauh
 *   dari toko / subtotal) dan Peta; WhatsApp (href, target, rel; waUrl null = nonaktif + petunjuk); ponsel 390 px: kartu → rincian dengan tab
 *   Kunjungan | Peta; keadaan memuat / galat bisa diulang / galat muat ulang / kosong berpesan; saringan → query; tab Hierarki: kolom No HP
 *   (PUT mengirim noHp HANYA bila diubah, galat NO_HP_TIDAK_SAH tampil di dialog).
 * Caller: Playwright lokal terhadap dev server (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `PLAYWRIGHT_BASE_URL=http://localhost:3061 npx playwright test tests/fiori-supervisor-review.spec.ts --workers=1`.
 * Dependensi: semua /api/** yang dipanggil di-mock page.route (tanpa DB, tanpa Accurate); ubin peta di-mock. Data contoh generik.
 * Side Effects: Tangkapan bukti di test-results/sr2.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import type { Angka, BarisSalesman, JawabanSupervisorReview, Kunjungan, TotalCabang } from "../lib/supervisor-review/kontrak";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 90_000 } as const;
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const WA_A = "https://wa.me/6281234567890?text=Ringkasan%20SALES%20A";
const WA_C = "https://wa.me/6281234567891?text=Ringkasan%20SALES%20C";
const TANPA_HP = "No HP belum diisi — Admin: tab Hierarki";
const TANPA_RINCIAN = "Faktur tanpa salesman terpetakan tidak dipecah per toko — periksa kode salesman faktur di Accurate.";

const angka = (o: Partial<Angka> = {}): Angka => ({
    registeredOutlet: 40, callPlan: 12, callRute: 9, callNonRute: 2, ec: 4, noo: 1, quantity: 120.5, itemPerEc: 2.5,
    nilaiOrder: 3_450_000, omzetPerEc: 862_500, jamDiToko: 3.25, jamPerjalanan: 1.5, ...o,
});
const NOL = { callRute: 0, callNonRute: 0, ec: 0, noo: 0, quantity: 0, itemPerEc: 0, nilaiOrder: 0, omzetPerEc: 0, jamDiToko: 0, jamPerjalanan: 0 };
const S1: BarisSalesman = { cabang: "CABANG A", salesCode: "S-01", nama: "SALES A", status: "di_toko", waUrl: WA_A, ...angka() };
const S2: BarisSalesman = { cabang: "CABANG A", salesCode: "S-02", nama: "SALES B", status: "belum", waUrl: null, ...angka({ ...NOL, callPlan: 10 }) };
const S0: BarisSalesman = { cabang: "CABANG A", salesCode: "", nama: "", status: "belum", waUrl: null, ...angka({ ...NOL, registeredOutlet: 0, callPlan: 0, ec: 1, nilaiOrder: 150_000, omzetPerEc: 150_000 }) };
const S3: BarisSalesman = { cabang: "CABANG B", salesCode: "S-03", nama: "SALES C", status: "sudah", waUrl: WA_C, ...angka({ ec: 6, callPlan: 8, nilaiOrder: 5_100_000, omzetPerEc: 850_000 }) };
const TOTAL_A: TotalCabang = { cabang: "CABANG A", ...angka({ ec: 5, callPlan: 22, nilaiOrder: 3_600_000, omzetPerEc: 720_000 }) };
const TOTAL_B: TotalCabang = { cabang: "CABANG B", ...angka({ ec: 6, callPlan: 8, nilaiOrder: 5_100_000, omzetPerEc: 850_000 }) };

const WITA = (jam: string) => `2026-10-16T${jam}:00+08:00`;
const K = (o: Partial<Kunjungan> = {}): Kunjungan => ({
    salesCode: "S-01", custCode: "C-01", namaToko: "TOKO A", jenis: "rute", mulai: WITA("08:10"), selesai: WITA("09:00"), menitDiToko: 50, menitTempuh: null,
    qty: 24, item: 3, nilai: 1_200_000, ec: true, belumDifakturkan: false, lat: -5.14, lng: 119.41, jarakKeTokoM: 35, ...o,
});
const KUNJUNGAN: Kunjungan[] = [
    K(),
    K({ custCode: "C-02", namaToko: "TOKO B", jenis: "luar_rute", mulai: WITA("09:20"), selesai: WITA("09:50"), menitDiToko: 30, menitTempuh: 20, qty: 12.5, item: 2, nilai: 900_000, jarakKeTokoM: 420 }),
    K({ custCode: "C-03", namaToko: "TOKO C", mulai: WITA("10:05"), selesai: null, menitDiToko: null, menitTempuh: 15, qty: null, item: null, nilai: null, belumDifakturkan: true, jarakKeTokoM: null }),
    K({ custCode: "C-04", namaToko: "TOKO D", jenis: "tanpa_checkin", mulai: null, selesai: null, menitDiToko: null, menitTempuh: null, qty: 6, item: 1, nilai: 150_000, lat: null, lng: null, jarakKeTokoM: null }),
    K({ salesCode: "S-03", custCode: "C-05", namaToko: "TOKO E", lat: null, lng: null, jarakKeTokoM: null }), // check-in tanpa GPS
];

function jawaban(o: Partial<JawabanSupervisorReview> = {}): JawabanSupervisorReview {
    return {
        tanggal: "2026-10-16", diperbaruiPada: WITA("09:40"), cakupan: "global", pilihanCabang: ["CABANG A", "CABANG B"], pilihanPrinciple: ["PRINCIPLE A", "PRINCIPLE B"],
        salesman: [S1, S2, S0, S3], totalCabang: [TOTAL_A, TOTAL_B], kunjungan: KUNJUNGAN,
        penanda: [{ custCode: "C-01", namaToko: "TOKO A", salesCode: "S-01", lat: -5.14, lng: 119.41, status: "ec" }],
        tokoTanpaKoordinat: 7, fakturBelumTerbaca: [{ cabang: "CABANG A", jumlah: 3 }], ...o,
    };
}

type Jawab = ReturnType<typeof json>;
/** Mock GET /api/supervisor-review (+ ubin peta). `jawab(n, url)` = jawaban ke-n; bawaan = jawaban(). Log = query tiap permintaan. */
async function pasang(page: Page, jawab?: (n: number, url: URL) => Jawab | Promise<Jawab>) {
    const log: URL[] = [];
    await page.route("**/tile.openstreetmap.org/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX }));
    await page.route((u) => u.pathname === "/api/supervisor-review", async (r: Route) => {
        const url = new URL(r.request().url());
        log.push(url);
        return r.fulfill(await (jawab ? jawab(log.length, url) : json(jawaban({ tanggal: url.searchParams.get("tanggal") ?? "2026-10-16" }))));
    });
    return log;
}

const noOverflow = (page: Page) => page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); });
const tabelRingkasan = (page: Page) => page.getByRole("table", { name: "Ringkasan per salesman, per cabang" });
const baris = (page: Page, teks: string) => tabelRingkasan(page).getByRole("row").filter({ hasText: teks });

// Mode dev: kompilasi rute pertama lambat.
test.describe.configure({ timeout: 150_000 });

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await page.setViewportSize({ width: 1366, height: 900 });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Desktop: tabel per cabang + TOTAL, status ikon dan teks, tanpa salesman terpetakan, catatan data tak lengkap, kolom salesman menempel", async ({ page }) => {
    await pasang(page);
    await page.goto("/supervisor-review", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Supervisor Review" })).toBeVisible(NAV);
    const tabel = tabelRingkasan(page);
    await expect(tabel).toBeVisible(NAV);
    await expect(tabel.locator("thead th")).toHaveText(["Salesman", "Status", "Registered Outlet", "Call Plan", "Call Rute", "Call Non Rute", "EC", "NOO", "Quantity", "Item/EC",
        "Nilai Order", "Omzet/EC", "Time at Outlet (jam)", "Time Travel (jam)", "WhatsApp"]);
    await expect(main.getByText("data per 09.40 WITA")).toBeVisible();

    // Baris salesman: angka berformat Indonesia (koma desimal, titik ribuan), status = ikon + teks.
    const a = baris(page, "S-01");
    await expect(a).toContainText("SALES A");
    await expect(a.getByRole("cell").nth(1)).toHaveText("🟢 Di toko");
    await expect(a.getByRole("cell")).toHaveText(["SALES AS-01", "🟢 Di toko", "40", "12", "9", "2", "4", "1", "120,5", "2,5", "Rp 3.450.000", "Rp 862.500", "3,25", "1,5", "WhatsApp"]);
    await expect(baris(page, "S-02").getByRole("cell").nth(1)).toHaveText("⚪ Belum check-in");
    await expect(baris(page, "S-03").getByRole("cell").nth(1)).toHaveText("🔵 Sudah berkunjung");

    // Dikelompokkan per cabang; TOTAL dari totalCabang (bukan jumlah di klien).
    await expect(tabel.locator("tbody")).toHaveCount(2);
    await expect(tabel.locator("tbody").nth(0).locator("tr > :first-child")).toHaveText(["CABANG A", "SALES AS-01", "SALES BS-02", "Tanpa salesman terpetakan", "TOTAL CABANG A"]);
    await expect(tabel.locator("tbody").nth(1).locator("tr > :first-child")).toHaveText(["CABANG B", "SALES CS-03", "TOTAL CABANG B"]);
    const total = baris(page, "TOTAL CABANG A");
    await expect(total).toContainText("Rp 3.600.000");
    await expect(total).toContainText("Rp 720.000");
    await expect(baris(page, "TOTAL CABANG B")).toContainText("Rp 5.100.000");

    // Faktur tanpa salesman terpetakan: baris berlabel, tanpa tombol WhatsApp.
    const tanpa = baris(page, "Tanpa salesman terpetakan");
    await expect(tanpa).toContainText("Rp 150.000");
    await expect(tanpa.getByRole("button", { name: /WhatsApp/ })).toHaveCount(0);
    await expect(tanpa.getByRole("link")).toHaveCount(0);

    // Data tak lengkap TERLIHAT (spec §5).
    await expect(main.getByText("3 faktur cabang CABANG A belum terbaca rinciannya")).toBeVisible();
    await expect(main.getByText("7 toko JKS belum punya koordinat")).toBeVisible();
    expect(await noOverflow(page)).toBe(true);

    // Kolom salesman tetap saat digulir menyamping: tabel lebih lebar dari wadah, sel pertama tetap di tepi kiri wadah.
    const geser = await page.evaluate(() => {
        const wadah = document.querySelector(".fi-tablescroll") as HTMLElement;
        const th = wadah.querySelector("thead th") as HTMLElement;
        const td = wadah.querySelector("tbody tr:nth-child(2) > td:first-child") as HTMLElement; // sel nama salesman pertama (baris 1 = judul cabang)
        const lebar = wadah.scrollWidth > wadah.clientWidth + 100;
        wadah.scrollLeft = 400;
        const kiri = wadah.getBoundingClientRect().left;
        return { lebar, scroll: wadah.scrollLeft, pos: getComputedStyle(td).position, selisihTh: Math.abs(th.getBoundingClientRect().left - kiri), selisihTd: Math.abs(td.getBoundingClientRect().left - kiri) };
    });
    expect(geser.lebar).toBe(true);
    expect(geser.scroll).toBeGreaterThan(0);
    expect(geser.pos).toBe("sticky");
    expect(geser.selisihTh).toBeLessThan(2);
    expect(geser.selisihTd).toBeLessThan(2);
    await page.evaluate(() => { (document.querySelector(".fi-tablescroll") as HTMLElement).scrollLeft = 0; });
    await page.screenshot({ path: "test-results/sr2/desktop.png", fullPage: true });
});

test("Desktop: pilih salesman → rincian kunjungan (belum difakturkan, tanpa check-in, luar rute, jauh dari toko, subtotal) dan Peta", async ({ page }) => {
    await pasang(page);
    await page.goto("/supervisor-review", NAV);
    const main = page.locator("main");
    const peta = main.getByRole("region", { name: "Peta kunjungan" });
    const rincian = main.getByRole("region", { name: "Rincian kunjungan" });
    await expect(tabelRingkasan(page)).toBeVisible(NAV);
    await expect(peta).toBeVisible(NAV);
    await expect(peta).toContainText("semua salesman dalam cakupan");
    await expect(rincian.getByText("Pilih salesman")).toBeVisible();

    const nama = baris(page, "S-01").getByRole("button", { name: "SALES A" });
    await expect(nama).toHaveAttribute("aria-pressed", "false");
    await nama.click();
    await expect(nama).toHaveAttribute("aria-pressed", "true");
    await expect(peta).toContainText("SALES A");
    const tabel = rincian.getByRole("table", { name: "Rincian kunjungan" });
    await expect(tabel.locator("thead th")).toHaveText(["Toko", "Mulai", "Selesai", "Menit di toko", "Waktu tempuh (mnt)", "Qty", "Item", "EC"]);
    await expect(tabel.getByRole("row")).toHaveCount(5); // kepala + 4 kunjungan S-01 (TOKO E milik S-03 tidak ikut)

    const a = tabel.getByRole("row").filter({ hasText: "TOKO A" });
    await expect(a.getByRole("cell")).toHaveText(["TOKO AC-0135 m dari toko", "08.10", "09.00", "50", "—", "24", "3", "✓"]);
    await expect(a).not.toContainText("jauh dari toko"); // 35 m ≤ ambang: jarak tampil biasa, bukan penanda jauh
    await expect(a).not.toContainText("belum difakturkan");
    const b = tabel.getByRole("row").filter({ hasText: "TOKO B" });
    await expect(b).toContainText("luar rute");
    await expect(b).toContainText("jauh dari toko (420 m)");
    await expect(b).not.toContainText("m dari toko"); // satu penanda saja, bukan dua
    await expect(b.getByRole("cell").nth(4)).toHaveText("20");
    await expect(b.getByRole("cell").nth(5)).toHaveText("12,5");
    const c = tabel.getByRole("row").filter({ hasText: "TOKO C" });
    await expect(c).toContainText("belum difakturkan");
    await expect(c).toContainText("toko tanpa koordinat"); // ada titik check-in, jarak null
    await expect(c).not.toContainText("tanpa GPS");
    await expect(c.getByRole("cell").nth(2)).toHaveText("—"); // masih di toko: belum check-out
    await expect(c.getByRole("cell").nth(5)).toHaveText("—"); // EC tanpa qty
    await expect(c.getByRole("img", { name: "EC" })).toBeVisible();
    const d = tabel.getByRole("row").filter({ hasText: "TOKO D" });
    await expect(d).toContainText("tanpa check-in");
    await expect(d).not.toContainText("tanpa GPS"); // tanpa check-in memang tanpa titik
    await expect(d).not.toContainText("tanpa koordinat");
    await expect(d.getByRole("cell").nth(1)).toHaveText("—"); // tanpa jam

    // Subtotal di bawah tabel.
    const sub = rincian.getByRole("group", { name: "Subtotal kunjungan" });
    const nilai = (label: string) => sub.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd");
    await expect(nilai("Kunjungan")).toHaveText("4");
    await expect(nilai("Menit di toko")).toHaveText("80");
    await expect(nilai("Waktu tempuh (mnt)")).toHaveText("35");
    await expect(nilai("Qty")).toHaveText("42,5");
    await expect(nilai("Item")).toHaveText("6");
    await expect(nilai("EC")).toHaveText("4");
    await expect(nilai("Nilai")).toHaveText("Rp 2.250.000");

    // Balik ke semua salesman.
    await peta.getByRole("button", { name: "Lihat semua salesman" }).click();
    await expect(nama).toHaveAttribute("aria-pressed", "false");
    await expect(rincian.getByText("Pilih salesman")).toBeVisible();
    // Salesman tanpa kunjungan: kosong yang dijelaskan, bukan tabel kosong.
    await baris(page, "S-02").getByRole("button", { name: "SALES B", exact: true }).click();
    await expect(rincian.getByText("Belum ada kunjungan")).toBeVisible();

    // Check-in tanpa GPS tidak diam: berlabel, tanpa jarak.
    await baris(page, "S-03").getByRole("button", { name: "SALES C", exact: true }).click();
    const e = rincian.getByRole("table", { name: "Rincian kunjungan" }).getByRole("row").filter({ hasText: "TOKO E" });
    await expect(e).toContainText("tanpa GPS");
    await expect(e).not.toContainText("m dari toko");

    // Baris "Tanpa salesman terpetakan": tanpa rincian per toko, penjelasan; peta tetap semua salesman.
    await baris(page, "Tanpa salesman terpetakan").getByRole("button", { name: "Tanpa salesman terpetakan", exact: true }).click();
    await expect(rincian.getByText(TANPA_RINCIAN)).toBeVisible();
    await expect(rincian.getByRole("table")).toHaveCount(0);
    await expect(rincian.getByRole("group", { name: "Subtotal kunjungan" })).toHaveCount(0);
    await expect(peta).toContainText("semua salesman dalam cakupan");
});

test("WhatsApp: href wa.me di tab baru; waUrl null = tombol nonaktif + petunjuk terlihat", async ({ page }) => {
    await pasang(page);
    await page.goto("/supervisor-review", NAV);
    await expect(tabelRingkasan(page)).toBeVisible(NAV);

    const wa = baris(page, "S-01").getByRole("link", { name: "WhatsApp ke SALES A" });
    await expect(wa).toHaveAttribute("href", WA_A);
    await expect(wa).toHaveAttribute("target", "_blank");
    expect(await wa.getAttribute("rel")).toBe("noopener noreferrer");
    await expect(baris(page, "S-03").getByRole("link", { name: "WhatsApp ke SALES C" })).toHaveAttribute("href", WA_C);

    const mati = baris(page, "S-02").getByRole("button", { name: "WhatsApp ke SALES B" });
    await expect(mati).toBeDisabled();
    await expect(mati).toHaveAttribute("title", TANPA_HP);
    await expect(page.locator("main").getByText(TANPA_HP)).toHaveCount(0); // tabel: petunjuk di title; teks terlihat di rincian salesman
    await baris(page, "S-02").getByRole("button", { name: "SALES B", exact: true }).click();
    const rincian = page.locator("main").getByRole("region", { name: "Rincian kunjungan" });
    await expect(rincian.getByText(TANPA_HP)).toBeVisible();
    await expect(rincian.getByRole("button", { name: "WhatsApp ke SALES B" })).toBeDisabled();
});

test("Ponsel 390 px: kartu per salesman → rincian dengan tab Kunjungan | Peta; WhatsApp di kartu", async ({ page }) => {
    await pasang(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/supervisor-review", NAV);
    const main = page.locator("main");
    const kartuA = main.getByRole("list", { name: "Salesman CABANG A" }).getByRole("listitem").filter({ hasText: "SALES A" });
    await expect(kartuA).toBeVisible(NAV);
    await expect(main.getByRole("table")).toHaveCount(0); // ponsel: tidak ada tabel lebar
    await expect(kartuA).toContainText("EC / Call Plan: 4 / 12");
    await expect(kartuA).toContainText("Rp 3.450.000");
    await expect(kartuA).toContainText("Di toko");
    await expect(kartuA.getByRole("link", { name: "WhatsApp ke SALES A" })).toHaveAttribute("href", WA_A);
    const kartuB = main.getByRole("list", { name: "Salesman CABANG A" }).getByRole("listitem").filter({ hasText: "SALES B" });
    await expect(kartuB).toContainText("Belum check-in");
    await expect(kartuB.getByRole("button", { name: "WhatsApp ke SALES B" })).toBeDisabled();
    await expect(kartuB.getByText(TANPA_HP)).toBeVisible(); // di ponsel tak ada hover: petunjuk terlihat
    await expect(main.getByRole("region", { name: "CABANG A" })).toContainText("Total: EC 5 / Call Plan 22 · Rp 3.600.000");
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: "test-results/sr2/ponsel-daftar.png", fullPage: true });

    // Ketuk kartu di bagian bawah daftar: rincian terbuka dari atas (gulir <main> kembali 0) dan judul rincian terfokus.
    const gulir = () => main.evaluate((m) => m.scrollTop);
    await main.evaluate((m) => { m.scrollTop = m.scrollHeight; });
    await expect.poll(gulir).toBeGreaterThan(0);
    await main.getByRole("list", { name: "Salesman CABANG B" }).getByRole("listitem").filter({ hasText: "SALES C" }).getByRole("button").first().click();
    await expect.poll(gulir).toBe(0);
    await expect(main.getByRole("heading", { name: "SALES C" })).toBeFocused();
    await main.getByRole("button", { name: "Kembali ke daftar" }).click();

    // Baris "Tanpa salesman terpetakan": penjelasan, bukan kunjungan.
    await main.getByRole("list", { name: "Salesman CABANG A" }).getByRole("listitem").filter({ hasText: "Tanpa salesman terpetakan" }).getByRole("button").first().click();
    await expect(main.getByText(TANPA_RINCIAN)).toBeVisible();
    await expect(main.getByRole("list", { name: "Kunjungan" })).toHaveCount(0);
    await main.getByRole("button", { name: "Kembali ke daftar" }).click();

    await kartuA.getByRole("button").first().click();
    await expect(main.getByRole("button", { name: "Kembali ke daftar" })).toBeVisible();
    const kunjungan = main.getByRole("tab", { name: "Kunjungan" });
    const petaTab = main.getByRole("tab", { name: "Peta" });
    await expect(kunjungan).toHaveAttribute("aria-selected", "true");
    await expect(petaTab).toHaveAttribute("aria-selected", "false");
    const panel = main.getByRole("tabpanel", { name: "Kunjungan" });
    await expect(panel.getByRole("list", { name: "Kunjungan" }).getByRole("listitem")).toHaveCount(4);
    await expect(panel.getByRole("listitem").filter({ hasText: "TOKO B" })).toContainText("jauh dari toko (420 m)");
    await expect(panel.getByRole("listitem").filter({ hasText: "TOKO C" })).toContainText("belum difakturkan");
    await expect(panel.getByRole("listitem").filter({ hasText: "TOKO D" })).toContainText("tanpa check-in");
    await expect(panel.getByRole("group", { name: "Subtotal kunjungan" })).toContainText("Rp 2.250.000");
    await expect(main.getByRole("link", { name: "WhatsApp ke SALES A" })).toHaveAttribute("href", WA_A);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: "test-results/sr2/ponsel-rincian.png", fullPage: true });

    await petaTab.click();
    await expect(petaTab).toHaveAttribute("aria-selected", "true");
    await expect(main.getByRole("tabpanel", { name: "Peta" })).toBeVisible();
    await expect(main.getByRole("tabpanel", { name: "Kunjungan" })).toHaveCount(0);
    await kunjungan.click();
    await expect(main.getByRole("tabpanel", { name: "Kunjungan" })).toBeVisible();

    await main.getByRole("button", { name: "Kembali ke daftar" }).click();
    await expect(kartuA).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
});

test("Keadaan: memuat, galat bisa diulang, galat muat ulang menyisakan data lama, kosong berpesan, kosong tanpa pesan", async ({ page }) => {
    // Memuat → galat → Coba lagi → data → Muat ulang gagal (data lama tetap + strip) → Muat ulang berhasil.
    // Mode dev (StrictMode) memuat dua kali saat mount → jawaban ditentukan `modus`, bukan nomor permintaan.
    let modus: "galat" | "ok" = "galat";
    let lepas!: () => void;
    const tahan = new Promise<void>((r) => { lepas = r; });
    await pasang(page, async () => {
        await tahan;
        return modus === "galat" ? json({ error: "Internal server error" }, 500) : json(jawaban());
    });
    await page.goto("/supervisor-review", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("status").filter({ hasText: "Memuat Supervisor Review" })).toBeVisible(NAV);
    lepas();
    const galat = main.getByRole("alert").filter({ hasText: "Supervisor Review belum bisa ditampilkan" });
    await expect(galat).toBeVisible(NAV);
    await expect(galat).toContainText("Supervisor Review belum berhasil dimuat.");
    await expect(galat).not.toContainText("Internal server error");
    await expect(tabelRingkasan(page)).toHaveCount(0); // galat ≠ kosong
    modus = "ok";
    await galat.getByRole("button", { name: "Coba lagi" }).click();
    await expect(tabelRingkasan(page)).toBeVisible(NAV);

    modus = "galat";
    await main.getByRole("button", { name: "Muat ulang" }).click();
    const strip = main.getByRole("alert").filter({ hasText: "Gagal memuat ulang." });
    await expect(strip).toBeVisible(NAV);
    await expect(strip).toContainText("Yang tampil adalah hasil sebelumnya.");
    await expect(tabelRingkasan(page)).toBeVisible();
    modus = "ok";
    await strip.getByRole("button", { name: "Coba lagi" }).click();
    await expect(strip).toHaveCount(0, NAV);
    await expect(tabelRingkasan(page)).toBeVisible();
});

test("Keadaan kosong: pesan server tampil apa adanya (HIERARKI_BELUM_TERTAUT); tanpa pesan = kalimat umum", async ({ page }) => {
    const pesan = { kode: "HIERARKI_BELUM_TERTAUT", teks: "Akun belum tertaut ke hierarki — hubungi Admin." };
    let o: Partial<JawabanSupervisorReview> = { salesman: [], totalCabang: [], kunjungan: [], penanda: [], fakturBelumTerbaca: [], tokoTanpaKoordinat: 0, pesan };
    await pasang(page, () => json(jawaban(o)));
    await page.goto("/supervisor-review", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Akun belum tertaut ke hierarki — hubungi Admin.")).toBeVisible(NAV);
    await expect(main.getByText("Belum ada data untuk ditampilkan")).toBeVisible();
    await expect(tabelRingkasan(page)).toHaveCount(0);

    o = { ...o, pesan: undefined };
    await main.getByRole("button", { name: "Muat ulang" }).click();
    await expect(main.getByText("Tidak ada salesman untuk ditampilkan")).toBeVisible(NAV);
    await expect(main.getByText("hubungi Admin")).toHaveCount(0);
});

test("Saringan: tanggal, cabang, principal masuk query; Muat ulang meminta lagi", async ({ page }) => {
    const log = await pasang(page);
    await page.goto("/supervisor-review", NAV);
    const main = page.locator("main");
    await expect(tabelRingkasan(page)).toBeVisible(NAV);
    // Mode dev (StrictMode) memuat dua kali saat mount: hitung relatif terhadap muatan awal.
    let n = log.length;
    const lagi = async () => { n += 1; await expect.poll(() => log.length).toBe(n); return log[n - 1].searchParams; };
    const q0 = log[n - 1].searchParams;
    expect(q0.get("tanggal")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(q0.get("cabang")).toBeNull();
    expect(q0.get("principle")).toBeNull();

    await expect(main.getByLabel("Cabang").locator("option")).toHaveText(["Semua cabang", "CABANG A", "CABANG B"]);
    await expect(main.getByLabel("Principal").locator("option")).toHaveText(["Semua principal", "PRINCIPLE A", "PRINCIPLE B"]);
    await expect(main.getByLabel("Tanggal")).toHaveAttribute("max", q0.get("tanggal")!); // tanggal depan tak bisa dipilih
    await main.getByLabel("Cabang").selectOption("CABANG A");
    const q1 = await lagi();
    expect(q1.get("cabang")).toBe("CABANG A");
    expect(q1.get("tanggal")).toBe(q0.get("tanggal"));
    await main.getByLabel("Principal").selectOption("PRINCIPLE B");
    const q2 = await lagi();
    expect(q2.get("cabang")).toBe("CABANG A");
    expect(q2.get("principle")).toBe("PRINCIPLE B");

    await main.getByLabel("Tanggal").fill("2026-10-10");
    const q3 = await lagi();
    expect(q3.get("tanggal")).toBe("2026-10-10");
    expect(q3.get("principle")).toBe("PRINCIPLE B");

    await main.getByRole("button", { name: "Muat ulang" }).click();
    const q4 = await lagi();
    expect(q4.get("tanggal")).toBe("2026-10-10");
    expect(q4.get("cabang")).toBe("CABANG A");
});

// ── TabHierarki: No HP ────────────────────────────────────────────────────────────────────────────────────────────────

type Profil = { salesCode: string; salesName: string; principle: string; branch: string; spvName: string | null; smName: string | null; noHp?: string | null };
async function pasangHierarki(page: Page, put: { status: number; body: unknown }[] = []) {
    const profil: Profil[] = [
        { salesCode: "S-01", salesName: "SALES A", principle: "PRINCIPLE A", branch: "CABANG A", spvName: "SPV A", smName: "SM A", noHp: "081234567890" },
        { salesCode: "S-02", salesName: "SALES B", principle: "PRINCIPLE A", branch: "CABANG A", spvName: "SPV A", smName: "SM A", noHp: null },
    ];
    const tulis: { method: string; body: Record<string, unknown> }[] = [];
    await page.route("**/api/form-kontrol/**", async (route) => {
        const req = route.request();
        const p = new URL(req.url()).pathname.replace("/api/form-kontrol/", "");
        if (p === "my-scope") return route.fulfill(json({ role: "admin", allowedSalesCodes: null, principles: ["PRINCIPLE A"] }));
        if (p === "sales-profiles" && req.method() === "GET") return route.fulfill(json({ rows: profil, spvOptions: ["SPV A", "SPV B"], smOptions: ["SM A"] }));
        if (p === "sales-profiles" && req.method() === "PUT") {
            const body = req.postDataJSON() as Record<string, unknown>;
            tulis.push({ method: "PUT", body });
            const j = put.shift();
            if (j) return route.fulfill(json(j.body, j.status));
            const r = profil.find((x) => x.salesCode === body.salesCode)!;
            r.spvName = body.spvName as string | null;
            if ("noHp" in body) r.noHp = body.noHp ? "081234567891" : null; // server menormalkan "+62 812 …" ke 08…
            return route.fulfill(json({ success: true }));
        }
        return route.fulfill(json({ rows: [], total: 0 }));
    });
    return tulis;
}

test("Hierarki: kolom No HP; PUT mengirim noHp HANYA bila diubah; galat NO_HP_TIDAK_SAH tampil di dialog (berkalimat server maupun hanya kode)", async ({ page }) => {
    const tulis = await pasangHierarki(page, [
        { status: 400, body: { ok: false, kode: "NO_HP_TIDAK_SAH", error: "No HP harus nomor seluler Indonesia (08…, +62…), 10–13 angka." } },
        { status: 400, body: { ok: false, kode: "NO_HP_TIDAK_SAH" } },
    ]);
    await page.goto("/form-kontrol?tab=hierarki", NAV);
    const main = page.locator("main");
    const a = main.getByRole("listitem").filter({ hasText: "SALES A" });
    const b = main.getByRole("listitem").filter({ hasText: "SALES B" });
    await expect(main.getByLabel("No HP SALES A")).toHaveValue("081234567890", NAV);
    await expect(main.getByLabel("No HP SALES B")).toHaveValue("");
    await expect(a.getByRole("button", { name: "Simpan" })).toBeDisabled(); // belum ada perubahan

    // 1. No HP tidak sah: server menolak 400 berkalimat → tampil di dialog; isian tidak hilang.
    await main.getByLabel("No HP SALES B").fill("0812");
    await expect(b.getByText("Draf")).toBeVisible();
    await b.getByRole("button", { name: "Simpan" }).click();
    const d = page.getByRole("dialog", { name: "Ubah hierarki SALES B?" });
    await expect(d).toContainText("— → 0812");
    await d.getByRole("button", { name: "Simpan hierarki" }).click();
    await expect(d.getByRole("alert")).toContainText("No HP harus nomor seluler Indonesia", NAV);
    expect(tulis[0].body).toEqual({ salesCode: "S-02", spvName: "SPV A", smName: "SM A", noHp: "0812" });

    // 2. 400 hanya berkode (tanpa kalimat) → kalimat bawaan layar.
    await d.getByRole("button", { name: "Simpan hierarki" }).click();
    await expect(d.getByRole("alert")).toContainText("No HP tidak sah: tulis nomor seluler Indonesia berbentuk 08…", NAV);
    await expect(main.getByLabel("No HP SALES B")).toHaveValue("0812");

    // 3. Nomor sah diketik apa adanya (+62 …): terkirim apa adanya, server menormalkan, sesudah muat ulang tidak lagi Draf.
    await d.getByRole("button", { name: "Batal" }).click();
    await main.getByLabel("No HP SALES B").fill("+62 812-3456-7891");
    await b.getByRole("button", { name: "Simpan" }).click();
    await d.getByRole("button", { name: "Simpan hierarki" }).click();
    await expect(d).toBeHidden(NAV);
    expect(tulis[2].body).toEqual({ salesCode: "S-02", spvName: "SPV A", smName: "SM A", noHp: "+62 812-3456-7891" });
    await expect(main.getByText("Hierarki SALES B tersimpan.")).toBeVisible();
    await expect(main.getByLabel("No HP SALES B")).toHaveValue("+62 812-3456-7891"); // isian tidak dibuang
    await expect(b.getByText("Draf")).toHaveCount(0); // 08… kanonik = isian yang sama → bukan perubahan

    // 4. Hapus nomor: kosong → noHp null.
    await main.getByLabel("No HP SALES A").fill("");
    await a.getByRole("button", { name: "Simpan" }).click();
    const da = page.getByRole("dialog", { name: "Ubah hierarki SALES A?" });
    await expect(da).toContainText("081234567890 → —");
    await da.getByRole("button", { name: "Simpan hierarki" }).click();
    await expect(da).toBeHidden(NAV);
    expect(tulis[3].body).toEqual({ salesCode: "S-01", spvName: "SPV A", smName: "SM A", noHp: null });
});

test("Hierarki: hanya SPV diubah → PUT tanpa kunci noHp; ponsel 390 px tanpa gulir menyamping, isian No HP ≥ 44 px", async ({ page }) => {
    const tulis = await pasangHierarki(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/form-kontrol?tab=hierarki", NAV);
    const main = page.locator("main");
    const hp = main.getByLabel("No HP SALES A");
    await expect(hp).toHaveValue("081234567890", NAV);
    expect((await hp.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await noOverflow(page)).toBe(true);

    await main.getByLabel("SPV SALES A").selectOption("SPV B");
    await main.getByRole("listitem").filter({ hasText: "SALES A" }).getByRole("button", { name: "Simpan" }).click();
    const d = page.getByRole("dialog", { name: "Ubah hierarki SALES A?" });
    await d.getByRole("button", { name: "Simpan hierarki" }).click();
    await expect(d).toBeHidden(NAV);
    expect(tulis).toHaveLength(1);
    expect(tulis[0].body).toEqual({ salesCode: "S-01", spvName: "SPV B", smName: "SM A" });
});
