/*
 * Tujuan: Fiori S6d Faktur Penjualan (it06 #16–#21) — dua kolom daftar + Object Page: kepala dari cache tampil segera sementara barang
 *   menunggu Accurate (`?id=` di URL), cari (debounce; `?q=` dari Order Masuk langsung menyaring), Hanya nomor INV, halaman, galat ≠ cache
 *   kosong ≠ pencarian tanpa hasil, jawaban tidak terbaca (500 JSON, 502 HTML, putus), galat detail (pesan Accurate + Coba lagi, kepala
 *   tetap, BL-22), tautan realisasi lama `?invoiceId=&databaseId=` (kepala dari detail; faktur lunas = alur sampai pelunasan), tanpa izin
 *   Antrean Faktur, ponsel 390 px satu kolom tanpa gulir menyamping, tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-order-faktur.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: /api/faktur dan /api/faktur/[id] di-mock dengan page.route (tidak menyentuh DB/Accurate).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const path = (p: string) => (url: URL) => url.pathname === p;
const NAV = { timeout: 60_000 } as const;
const HTML_502 = { status: 502, contentType: "text/html", body: "<html><body><h1>502 Bad Gateway</h1><hr>nginx</body></html>" };

const baris = (id: number, number: string, customerName: string, customerNo: string, transDate: string, totalAmount: number, over: Record<string, unknown> = {}) => ({
    id, number, transDate, customerNo, customerName, totalAmount, outstanding: totalAmount, status: "Belum Lunas", dueDate: "18/10/2026", age: 4,
    lastUpdateAt: "2026-10-06T02:10:00.000Z", createdAt: "2026-10-06T02:00:00.000Z", ...over,
});
const ROWS = [
    baris(304501, "INV/2610/KN01415", "TOKO A", "C-A0001", "06/10/2026", 4218300),
    baris(304498, "INV/2610/KN01412", "TOKO B", "C-A0002", "04/10/2026", 1627704, { outstanding: null, createdAt: null }),
    baris(304470, "INV/2609/KN01301", "TOKO C", "C-A0003", "26/09/2026", 5240000, { outstanding: 0, status: "Lunas" }),
];
const daftar = (rows: unknown[], hasMore = false) => json({ ok: true, page: 1, pageSize: 50, hasMore, rows });
const DETAIL = {
    id: 304498, number: "INV/2610/KN01412", transDate: "04/10/2026", dueDate: "18/10/2026", customerNo: "C-A0002", customerName: "TOKO B",
    branchName: "CABANG A", salesName: "", description: "", status: "Belum Lunas", subTotal: 1524000, totalDiscount: 57600, tax: 161304,
    totalAmount: 1627704, paid: 0, owing: 1627704, paymentTerm: "Net 14", lastPaymentDate: "",
    items: [
        // Faktur dari Antrean Faktur: sales hanya di BARIS (kepala salesName kosong).
        { itemNo: "BRG-A1", itemName: "BARANG A1 100 ML", quantity: 2, unit: "KRT", unitPrice: 576000, discount: 57600, total: 1094400, salesmen: ["SALES A"] },
        { itemNo: "BRG-A2", itemName: "BARANG A2 200 ML", quantity: 2, unit: "LSN", unitPrice: 186000, discount: 0, total: 372000, salesmen: ["SALES A"] },
    ],
};
const LUNAS = {
    ...DETAIL, id: 304470, number: "INV/2609/KN01301", transDate: "26/09/2026", dueDate: "10/10/2026", customerNo: "C-A0003", customerName: "TOKO C",
    salesName: "SALES A", status: "Lunas", totalAmount: 5240000, paid: 5240000, owing: 0, lastPaymentDate: "06/10/2026",
};

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Default + Memuat: kepala dari cache tampil segera, barang dan ringkasan menunggu Accurate; ?id= di URL; info dan varian BL", async ({ page }) => {
    const minta: string[] = [];
    await page.route(path("/api/faktur"), (r) => { minta.push(new URL(r.request().url()).search); return r.fulfill(daftar(ROWS)); });
    let lepas!: () => void;
    const tahan = new Promise<void>((res) => { lepas = res; });
    await page.route(path("/api/faktur/304498"), async (r) => { await tahan; await r.fulfill(json({ ok: true, faktur: DETAIL })); });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/faktur", NAV);
    const main = page.locator("main");
    const list = main.getByRole("list", { name: "Faktur", exact: true });
    const item = list.getByRole("button", { name: /INV\/2610\/KN01412/ });
    await expect(item).toBeVisible(NAV);
    await expect(item).toContainText("TOKO B");
    await expect(item).toContainText("Rp 1.627.704");
    await expect(list.getByRole("button", { name: /INV\/2609\/KN01301/ })).toContainText("Lunas");
    expect(minta[0]).toBe("?page=1"); // bawaan: hanya nomor INV (tanpa all=1)
    await expect(main.getByRole("region", { name: "Detail faktur" })).toContainText("Pilih faktur di daftar");

    await item.click();
    await expect(page).toHaveURL(/[?&]id=304498(&|$)/);
    await expect(item).toHaveAttribute("aria-current", "true");
    const det = main.getByRole("region", { name: "Detail faktur" });
    // Accurate belum menjawab: kepala sudah dari cache, Barang/Ringkasan kerangka, info detail "menunggu".
    await expect(det.getByRole("heading", { level: 1, name: "INV/2610/KN01412" })).toBeVisible();
    await expect(det.locator(".fi-attrs")).toContainText("TOKO B · C-A0002");
    await expect(det.locator(".fi-attrs > div").filter({ hasText: "Sisa tagihan" })).toHaveText("Sisa tagihan—"); // null cache ≠ Rp 0
    await expect(det.getByRole("region", { name: "Barang" })).toContainText("Mengambil detail dari Accurate…");
    await expect(det.getByRole("region", { name: "Barang" }).getByRole("status")).toBeVisible();
    await expect(det.getByRole("region", { name: "Ringkasan" }).getByRole("status")).toContainText("Memuat ringkasan");
    await expect(det.getByRole("region", { name: "Info" })).toContainText("menunggu Accurate…");
    await page.screenshot({ path: "test-results/fiori-faktur-memuat.png", fullPage: true });

    lepas();
    const tabel = det.getByRole("table", { name: "Barang faktur" });
    await expect(tabel).toContainText("BRG-A1");
    await expect(tabel).toContainText("BARANG A1 100 ML");
    await expect(tabel).toContainText("Rp 1.094.400");
    await expect(det.getByRole("region", { name: "Barang" })).toContainText("2 barang · dari Accurate");
    const ringkas = det.getByRole("region", { name: "Ringkasan" });
    await expect(ringkas).toContainText("PajakRp 161.304");
    await expect(ringkas).toContainText("Sisa tagihanRp 1.627.704");
    const info = det.getByRole("region", { name: "Info" });
    await expect(info).toContainText("CabangCABANG A");
    await expect(info).toContainText("SalesSALES A (per baris; tidak tercatat di kepala faktur)");
    await expect(info).toContainText("TerminNet 14");
    await expect(info).toContainText("Dibuat di Accurate—"); // createdAt hanya dari webhook
    await expect(info).toContainText("Perubahan terakhir06/10/2026, 10.10 WITA");
    await expect(det.getByRole("list", { name: "Alur dokumen" })).toContainText("belum ada pembayaran");
    for (const bl of ["BL-35", "BL-36"]) await expect(main.getByText(`usulan ${bl}`)).toBeVisible();
    await expect(main.getByText("usulan BL-22")).toHaveCount(0);
    await expect(main.getByRole("link", { name: "Antrean Faktur", exact: true })).toHaveAttribute("href", "/antrean-faktur");
    await expect(det.getByRole("link", { name: "Buka Antrean Faktur" })).toHaveAttribute("href", "/antrean-faktur");
    await page.screenshot({ path: "test-results/fiori-faktur-default.png", fullPage: true });
});

test("Cari (debounce), Hanya nomor INV, halaman; pencarian tanpa hasil ≠ cache kosong ≠ galat (500 JSON, 502 HTML, putus)", async ({ page }) => {
    const minta: URLSearchParams[] = [];
    let mode: "isi" | "kosong" | "500" | "502" | "putus" = "isi";
    await page.route(path("/api/faktur"), (r) => {
        const sp = new URL(r.request().url()).searchParams;
        minta.push(sp);
        if (mode === "500") return r.fulfill(json({ ok: false, error: "Gagal memuat daftar faktur." }, 500));
        if (mode === "502") return r.fulfill(HTML_502);
        if (mode === "putus") return r.abort("connectionreset");
        if (mode === "kosong") return r.fulfill(daftar([]));
        const q = sp.get("q");
        if (sp.get("page") === "2") return r.fulfill(daftar([baris(304400, "INV/2609/KN01290", "TOKO D", "C-A0004", "25/09/2026", 2450000)]));
        return r.fulfill(daftar(q ? ROWS.filter((x) => x.number.includes(q) || x.customerName.includes(q)) : ROWS, !q));
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/faktur", NAV);
    const main = page.locator("main");
    const list = main.getByRole("list", { name: "Faktur", exact: true });
    await expect(list.getByRole("button")).toHaveCount(3, NAV);

    await expect(main.getByRole("button", { name: "Sebelumnya" })).toBeDisabled();
    await main.getByRole("button", { name: "Berikutnya" }).click();
    await expect(list).toContainText("INV/2609/KN01290");
    expect(minta.at(-1)!.get("page")).toBe("2");
    await expect(main.getByText("Halaman 2")).toBeVisible();
    await expect(main.getByText("51–51")).toBeVisible();
    await expect(main.getByRole("button", { name: "Berikutnya" })).toBeDisabled();

    // Debounce: satu permintaan untuk seluruh ketikan, dan kembali ke halaman 1.
    await main.getByLabel("Cari faktur").pressSequentially("KN0199", { delay: 40 });
    await expect(main.getByText("Tidak ada faktur yang cocok dengan “KN0199”.")).toBeVisible();
    await expect(main.getByText("matikan “Hanya nomor INV”")).toBeVisible();
    expect(minta.filter((m) => m.has("q")).map((m) => `${m.get("q")}@${m.get("page")}`)).toEqual(["KN0199@1"]);
    expect(minta.at(-1)!.has("all")).toBe(false);
    await expect(main.getByText("Belum ada faktur di cache.")).toHaveCount(0);
    await main.getByLabel("Hanya nomor INV").uncheck();
    await expect.poll(() => minta.at(-1)!.get("all")).toBe("1");
    await expect(main.getByText("Coba sebagian nomor (mis. KN01412) atau nama pelanggan.")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-faktur-kosong-cari.png", fullPage: true });

    mode = "kosong";
    await main.getByLabel("Cari faktur").fill("");
    await expect(main.getByText("Belum ada faktur di cache.")).toBeVisible();
    await expect(main.getByText(/Tidak ada faktur yang cocok/)).toHaveCount(0);

    // Galat pemuatan pertama: bukan kosong; 502 HTML dan putus tidak menampilkan HTML mentah.
    for (const [m, teks] of [["500", "Gagal memuat daftar faktur."], ["502", "Server tidak memberi jawaban yang terbaca."], ["putus", "Server tidak tersambung."]] as const) {
        mode = m;
        await page.reload(NAV);
        await expect(main.getByRole("alert").filter({ hasText: teks })).toContainText("Ini bukan daftar kosong.", NAV);
        await expect(main.getByText("Belum ada faktur di cache.")).toHaveCount(0);
        await expect(main).not.toContainText("Bad Gateway");
    }
    await page.screenshot({ path: "test-results/fiori-faktur-galat.png", fullPage: true });
    mode = "isi";
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(list.getByRole("button")).toHaveCount(3);

    // Galat memuat ulang: daftar sebelumnya tetap tampil dengan strip, bukan diganti kosong.
    mode = "500";
    await main.getByLabel("Cari faktur").fill("TOKO");
    await expect(main.getByRole("alert").filter({ hasText: "Gagal memuat ulang daftar faktur." })).toContainText("Yang tampil adalah hasil sebelumnya.");
    await expect(list.getByRole("button")).toHaveCount(3);
});

test("Galat detail: pesan Accurate apa adanya + Coba lagi, kepala dari cache tetap (BL-22); 502 HTML disebut tidak terbaca", async ({ page }) => {
    // Mode, bukan hitungan permintaan: React StrictMode (dev) memanggil efek dua kali, jadi detail bisa diminta dua kali per pembukaan.
    let mode: "accurate" | "html" | "ok" = "accurate";
    await page.route(path("/api/faktur"), (r) => r.fulfill(daftar(ROWS)));
    await page.route(path("/api/faktur/304498"), (r) => mode === "accurate"
        ? r.fulfill(json({ ok: false, error: "Accurate menolak detail faktur: Data tidak ditemukan" }, 502))
        : mode === "html" ? r.fulfill(HTML_502) : r.fulfill(json({ ok: true, faktur: DETAIL })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/faktur?id=304498", NAV);
    const det = page.locator("main").getByRole("region", { name: "Detail faktur" });
    const barang = det.getByRole("region", { name: "Barang" });
    await expect(barang.getByRole("alert")).toContainText("Accurate menolak detail faktur: Data tidak ditemukan", NAV);
    await expect(det.getByRole("heading", { level: 1, name: "INV/2610/KN01412" })).toBeVisible();
    await expect(det.locator(".fi-attrs")).toContainText("TOKO B · C-A0002");
    await expect(det.getByText("usulan BL-22")).toBeVisible();
    await expect(det.getByRole("region", { name: "Ringkasan" })).toContainText("Belum terbaca");
    await expect(det.getByRole("region", { name: "Info" })).toContainText("Cabangtidak terbaca");
    await page.screenshot({ path: "test-results/fiori-faktur-galat-detail.png", fullPage: true });

    mode = "html";
    await barang.getByRole("button", { name: "Coba lagi" }).click();
    await expect(barang.getByRole("alert")).toContainText("Server tidak memberi jawaban yang terbaca.");
    await expect(det).not.toContainText("Bad Gateway");
    mode = "ok";
    await barang.getByRole("button", { name: "Coba lagi" }).click();
    await expect(det.getByRole("table", { name: "Barang faktur" })).toContainText("BRG-A2");
    await expect(det.getByText("usulan BL-22")).toHaveCount(0);
});

test("Tautan realisasi lama ?invoiceId=&databaseId=: detail langsung dengan databaseId, kepala dari detail; faktur lunas = alur sampai pelunasan; 409", async ({ page }) => {
    const detailUrl: string[] = [];
    await page.route(path("/api/faktur"), (r) => r.fulfill(daftar([]))); // kepala TIDAK boleh bergantung pada cache
    await page.route(path("/api/faktur/304470"), (r) => {
        const u = new URL(r.request().url());
        detailUrl.push(u.search);
        return u.searchParams.get("databaseId") === "DB-A"
            ? r.fulfill(json({ ok: true, faktur: LUNAS }))
            : r.fulfill(json({ ok: false, error: "Database sesi Accurate berbeda dari faktur pada laporan realisasi." }, 409));
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/faktur?invoiceId=304470&databaseId=DB-A", NAV);
    const det = page.locator("main").getByRole("region", { name: "Detail faktur" });
    await expect(det.getByRole("heading", { level: 1, name: "INV/2609/KN01301" })).toBeVisible(NAV);
    expect(detailUrl[0]).toBe("?databaseId=DB-A");
    await expect(det.locator(".fi-oph")).toContainText("Lunas");
    await expect(det.locator(".fi-attrs")).toContainText("TOKO C · C-A0003");
    await expect(det.getByText("Dibuka dari laporan realisasi.")).toBeVisible();
    await expect(det.getByRole("list", { name: "Alur dokumen" })).toContainText("Lunas · bayar terakhir 06/10/2026");
    await expect(det.getByRole("region", { name: "Info" })).toContainText("SalesSALES A");
    await expect(det.getByRole("region", { name: "Ringkasan" })).toContainText("Sisa tagihanRp 0");
    await page.screenshot({ path: "test-results/fiori-faktur-sukses-lunas.png", fullPage: true });

    await page.goto("/faktur?invoiceId=304470&databaseId=DB-B", NAV);
    await expect(det.getByRole("alert")).toContainText("Database sesi Accurate berbeda dari faktur pada laporan realisasi.", NAV);
    await expect(det.getByRole("heading", { level: 1, name: "Faktur dari laporan realisasi" })).toBeVisible();
    expect(detailUrl.at(-1)).toBe("?databaseId=DB-B");
});

test("Tautan Order Masuk ?q=<nomor faktur> langsung menyaring tanpa permintaan tanpa saringan; pilih faktur menyimpan q dan id", async ({ page }) => {
    const minta: URLSearchParams[] = [];
    await page.route(path("/api/faktur"), (r) => {
        const sp = new URL(r.request().url()).searchParams;
        minta.push(sp);
        const q = sp.get("q");
        return r.fulfill(daftar(q ? ROWS.filter((x) => x.number.includes(q)) : ROWS));
    });
    await page.route(path("/api/faktur/304498"), (r) => r.fulfill(json({ ok: true, faktur: DETAIL })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(`/faktur?q=${encodeURIComponent("INV/2610/KN01412")}`, NAV);
    const main = page.locator("main");
    const list = main.getByRole("list", { name: "Faktur", exact: true });
    await expect(list.getByRole("button")).toHaveCount(1, NAV);
    expect(minta[0].get("q")).toBe("INV/2610/KN01412");
    await expect(main.getByLabel("Cari faktur")).toHaveValue("INV/2610/KN01412");
    await list.getByRole("button", { name: /INV\/2610\/KN01412/ }).click();
    await expect(page).toHaveURL(/\?q=INV%2F2610%2FKN01412&id=304498$/);
    expect(minta.every((m) => m.get("q") === "INV/2610/KN01412")).toBe(true);
});

test("Tanpa izin Antrean Faktur (order.view): tombol nonaktif dengan alasan berbahasa tugas", async ({ page }) => {
    await page.route(path("/api/faktur"), (r) => r.fulfill(daftar(ROWS)));
    await page.route(path("/api/faktur/304498"), (r) => r.fulfill(json({ ok: true, faktur: DETAIL })));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/faktur?id=304498", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("link", { name: "Antrean Faktur", exact: true })).toBeVisible(NAV);
    // Admin LOCAL_AUTH_BYPASS memegang semua izin. Navigasi lunak ke /faktur hanya mengambil payload RSC (tanpa HTML server, jadi tanpa
    // salah-hidrasi); array permKeys di payload itu dibuang `order.view`-nya — hanya di tes.
    await page.route((u) => u.pathname === "/faktur", async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        const body = (await res.text()).replace(/permKeys(\\?)":\[([^\]]*)\]/g, (_, e: string, isi: string) =>
            `permKeys${e}":[${isi.split(",").filter((k) => k !== `${e}"order.view${e}"`).join(",")}]`);
        return route.fulfill({ status: res.status(), headers, body });
    });
    await page.getByRole("link", { name: "Faktur Penjualan", exact: true }).first().click();
    await expect(page).toHaveURL(/\/faktur$/);
    const tombol = main.getByRole("button", { name: "Antrean Faktur", exact: true });
    await expect(tombol).toBeDisabled(NAV);
    await expect(tombol).toHaveAttribute("title", "Akun Anda tidak berhak membuka Antrean Faktur.");
    await main.getByRole("list", { name: "Faktur", exact: true }).getByRole("button", { name: /INV\/2610\/KN01412/ }).click();
    await expect(main.getByRole("button", { name: "Buka Antrean Faktur" })).toBeDisabled();
    await expect(main.getByRole("link", { name: /Antrean Faktur/ })).toHaveCount(0);
});

test("Ponsel 390 px: satu kolom daftar ↔ detail dengan Kembali, barang sebagai daftar, tanpa gulir menyamping", async ({ page }) => {
    await page.route(path("/api/faktur"), (r) => r.fulfill(daftar(ROWS)));
    await page.route(path("/api/faktur/304498"), (r) => r.fulfill(json({ ok: true, faktur: DETAIL })));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/faktur", NAV);
    const main = page.locator("main");
    const list = main.getByRole("list", { name: "Faktur", exact: true });
    await expect(list.getByRole("button")).toHaveCount(3, NAV);
    await expect(main.getByRole("region", { name: "Detail faktur" })).toBeHidden();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-faktur-ponsel-daftar.png", fullPage: true });

    await list.getByRole("button", { name: /INV\/2610\/KN01412/ }).click();
    const det = main.getByRole("region", { name: "Detail faktur" });
    await expect(det.getByRole("heading", { level: 1, name: "INV/2610/KN01412" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Daftar faktur" })).toBeHidden();
    await expect(det.getByRole("list", { name: "Barang faktur" })).toContainText("2 KRT × Rp 576.000 · diskon Rp 57.600");
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-faktur-ponsel-detail.png", fullPage: true });

    await det.getByRole("button", { name: "Kembali ke daftar" }).click();
    await expect(page).not.toHaveURL(/id=/);
    await expect(list).toBeVisible();
});
