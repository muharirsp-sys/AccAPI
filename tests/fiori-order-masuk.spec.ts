/*
 * Tujuan: Fiori S6d Order Masuk (it06) — List Report (kartu = saringan, status sampai faktur dari Antrean Faktur, nomor faktur menaut ke
 *   Faktur Penjualan, galat ≠ kosong, status antrean gagal ≠ belum antre, Tarik + jawaban tidak pasti, koneksi lewat dialog), Order baru
 *   (harga terisi dari master + sumbernya, harga diubah ditandai, simpan lewat dialog, galat server apa adanya, simpan tidak pasti
 *   mengunci), Object Page (harga order vs master, Antrekan WAJIB salesman — C7: payload pratinjau & antre membawa salesman, antre tidak
 *   pasti → belum pasti + muat ulang + kunci, tidak ditemukan ≠ galat, Butuh harga terkunci), ponsel 390 px tanpa gulir menyamping.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-order-masuk.spec.ts --config playwright.fiori-local.config.ts --workers=1 --output=test-results/order-masuk`.
 * Dependensi: FastAPI order (dev: http://localhost:8000) di-mock dengan header CORS; /api/orders/*, /api/customers/lookup, /api/outlet-channel,
 *   /api/items/units di-mock dengan page.route. Tidak menyentuh DB maupun Accurate.
 * Side Effects: Tangkapan di test-results/order-masuk.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const NAV = { timeout: 60_000 } as const;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const HTML_502 = "<html><body><h1>502 Bad Gateway</h1></body></html>";
const CORS = { "access-control-allow-origin": "http://localhost:3011", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
const fa = (r: Route, body: unknown, status = 200, html?: string) => r.request().method() === "OPTIONS"
    ? r.fulfill({ status: 204, headers: CORS })
    : r.fulfill({ status, headers: { ...CORS, "content-type": html ? "text/html" : "application/json" }, body: html ?? JSON.stringify(body) });

const ID_A = "8f1c0000-aaaa-4bbb-8ccc-000000000001";
const ID_B = "8f310000-aaaa-4bbb-8ccc-000000000002";
const ID_C = "8e910000-aaaa-4bbb-8ccc-000000000003";
const ID_D = "8f2a0000-aaaa-4bbb-8ccc-000000000004";
const HASIL_A = {
    gross: "3480000.00", discount: "68400.00", net: "3411600.00",
    lines: [
        { code: "BRG-A1", unit: "KRT", quantity: "5", gross: "2280000.00", net: "2211600.00", percents: ["3"], cash: "0" },
        { code: "BRG-A2", unit: "LSN", quantity: "10", gross: "1100000.00", net: "1100000.00" },
    ],
    applications: [{ program_id: "P-A", minimum: "1000000", discount: "68400" }], bonuses: [],
};
const baris = (id: string, outlet: string, extra: Record<string, unknown> = {}) => ({
    id, owner: "PETUGAS A", outlet, channel: "GT", order_date: "2026-10-06", status: "draft", result: HASIL_A,
    request_id: null, customer_no: `C-${outlet.slice(-1)}001-KN`, created_at: "2026-10-06T01:31:00Z", ...extra,
});
const ORDERS = [
    baris(ID_A, "TOKO A"),
    baris(ID_B, "TOKO B", { status: "needs_price", result: { pending_price: true, lines: [{ code: "BRG-A1", unit: "KRT", quantity: "2", price: "" }] }, request_id: "10390000-ffff-4fff-8fff-000000000001" }),
    baris(ID_C, "TOKO C"),
    baris(ID_D, "TOKO D"),
];
const OUTBOX = [
    { orderId: ID_C, state: "posted", accurateNumber: "INV/2610/KN01412", lastError: null, updatedAt: "2026-10-06T02:12:00Z" },
    { orderId: ID_D, state: "queued", accurateNumber: null, lastError: null, updatedAt: "2026-10-06T02:00:00Z" },
];
const DETAIL_A = {
    ...ORDERS[0], note: "", sources: [{ draft_id: "d1d1d1d1-0000", revision: 3 }], rules: [{ id: "d1d1d1d1:P-A", name: "PRINCIPLE A Okt 2026 · diskon 3%" }],
    lines: [{ code: "BRG-A1", unit: "KRT", quantity: "5", price: "456000" }, { code: "BRG-A2", unit: "LSN", quantity: "10", price: "110000" }],
};
const MASTER: Record<string, number> = { "BRG-A1|KRT": 456000, "BRG-A2|LSN": 120000 };
const SALESMEN = [{ number: "M-SLA", name: "SALES A", branchId: 50 }, { number: "M-SLB", name: "SALES B", branchId: 50 }];
const harga = (code: string, unit: string) => ({ code, unit, price: MASTER[`${code}|${unit}`] ?? null, source: "tier", priceCategoryName: "Grosir", branchName: "CABANG A", effectiveDate: "2026-10-01", knownUnits: null });

type Opsi = {
    list?: (scope: string) => { body?: unknown; status?: number; html?: string };
    status?: { body?: unknown; status?: number };
    /** Ditunggu sebelum status antrean daftar dijawab (keadaan "memuat"). */
    tundaStatus?: () => Promise<void>;
    koneksi?: unknown;
    pull?: { body?: unknown; status?: number; html?: string };
    detail?: Record<string, { body?: unknown; status?: number; html?: string }>;
    simpan?: Array<{ body?: unknown; status?: number; html?: string }>;
    /** Jawaban GET status antrean satu order — fungsi (bukan urutan): efek dev StrictMode memuat dua kali. */
    invoiceGet?: () => { body?: unknown; status?: number };
    invoicePost?: (body: Record<string, unknown>) => { body?: unknown; status?: number; html?: string };
};
type Log = { listCalls: number; statusUrls: string[]; pullCalls: number; koneksi: unknown[]; simpan: Record<string, unknown>[]; invoiceGets: number; invoicePosts: Record<string, unknown>[] };

async function pasang(page: Page, opsi: Opsi = {}): Promise<Log> {
    const log: Log = { listCalls: 0, statusUrls: [], pullCalls: 0, koneksi: [], simpan: [], invoiceGets: 0, invoicePosts: [] };
    const simpan = [...(opsi.simpan ?? [])];
    await page.route((u) => u.host === "localhost:8000", (r) => {
        const req = r.request();
        const u = new URL(req.url());
        const m = req.method();
        if (m === "OPTIONS") return fa(r, {});
        if (u.pathname === "/api/me") return fa(r, { csrf_token: "t" });
        if (u.pathname === "/orders" && m === "GET") {
            log.listCalls += 1;
            const scope = u.searchParams.get("scope") ?? "mine";
            const x = opsi.list?.(scope) ?? { body: { ok: true, scope, orders: ORDERS } };
            return fa(r, x.body, x.status, x.html);
        }
        if (u.pathname === "/orders" && m === "POST") {
            log.simpan.push(req.postDataJSON());
            const x = simpan.shift() ?? { body: { ok: true, order: { ...DETAIL_A } } };
            return fa(r, x.body, x.status, x.html);
        }
        if (u.pathname === "/orders/connection") {
            if (m === "POST") { log.koneksi.push(req.postDataJSON()); return fa(r, { ok: true, connection: { enabled: true, owner: "PETUGAS A" }, pending: 0 }); }
            return fa(r, opsi.koneksi ?? { ok: true, pending: 3, connection: { enabled: false, owner: "", updated_by: "", updated_at: "", last_run_at: "", last_result: null } });
        }
        if (u.pathname === "/orders/pull") {
            log.pullCalls += 1;
            const x = opsi.pull ?? { body: { ok: true, imported: [], already_imported: [], failed: [] } };
            return fa(r, x.body, x.status, x.html);
        }
        const id = u.pathname.replace("/orders/", "");
        const x = opsi.detail?.[id] ?? (id === ID_A ? { body: { ok: true, order: DETAIL_A } } : { body: { detail: "Order tidak ditemukan" }, status: 404 });
        return fa(r, x.body, x.status, x.html);
    });
    await page.route((u) => u.pathname === "/api/orders/invoice-status", async (r) => {
        log.statusUrls.push(r.request().url());
        await opsi.tundaStatus?.();
        const x = opsi.status ?? { body: { ok: true, outbox: OUTBOX } };
        return r.fulfill(json(x.body, x.status));
    });
    await page.route((u) => /^\/api\/orders\/[^/]+\/invoice$/.test(u.pathname), (r) => {
        const req = r.request();
        if (req.method() === "GET") {
            log.invoiceGets += 1;
            const x = opsi.invoiceGet?.() ?? { body: { ok: true, outbox: null } };
            return r.fulfill(json(x.body, x.status));
        }
        const body = req.postDataJSON() as Record<string, unknown>;
        log.invoicePosts.push(body);
        const x = opsi.invoicePost?.(body) ?? { body: pratinjau(body) };
        return x.html ? r.fulfill({ status: x.status ?? 502, contentType: "text/html", body: x.html }) : r.fulfill(json(x.body, x.status));
    });
    await page.route((u) => u.pathname === "/api/orders/salesmen", (r) => r.fulfill(json({ ok: true, salesmen: SALESMEN })));
    await page.route((u) => u.pathname === "/api/orders/preview", (r) => {
        const b = r.request().postDataJSON() as { lines: { code: string; unit: string; quantity: string }[] };
        const prices = b.lines.map((l) => harga(l.code, l.unit));
        const net = b.lines.reduce((t, l) => t + (MASTER[`${l.code}|${l.unit}`] ?? 0) * Number(l.quantity), 0);
        return r.fulfill(json({ ok: true, prices, lines: b.lines, result: { gross: String(net), discount: "0", net: String(net), lines: [], bonuses: [] }, suggestions: [] }));
    });
    await page.route((u) => u.pathname === "/api/customers/lookup", (r) => r.fulfill(json({ ok: true, found: true, name: "TOKO A", area: "CABANG A", priceCategoryName: "Grosir" })));
    await page.route((u) => u.pathname === "/api/outlet-channel", (r) => {
        const no = new URL(r.request().url()).searchParams.get("no") ?? "";
        return r.fulfill(json({ ok: true, channels: { [no]: "GT" } }));
    });
    await page.route((u) => u.pathname === "/api/items/units", (r) => {
        const code = new URL(r.request().url()).searchParams.get("code") ?? "";
        return r.fulfill(json({ ok: true, found: true, name: `BARANG ${code}`, units: code === "BRG-A2" ? ["LSN"] : ["KRT"] }));
    });
    return log;
}

/** Jawaban pratinjau/antre /api/orders/[id]/invoice: payload membawa salesman bila dipilih (bentuk buildInvoicePayload). */
function pratinjau(body: Record<string, unknown>) {
    const sales = typeof body.salesman === "string" && body.salesman ? body.salesman : "";
    const perBaris = sales ? { salesmanListNumber: [sales] } : {};
    const payload = {
        customerNo: "C-A001-KN", transDate: "06/10/2026", typeAutoNumber: 7, taxable: true, inclusiveTax: false, branchId: 50,
        detailItem: [{ itemNo: "BRG-A1", quantity: 5, unitPrice: 456000, itemUnitId: 100, itemDiscPercent: "3", itemCashDiscount: 0, ...perBaris }],
        ...(sales ? { masterSalesmanId: 4652 } : {}),
    };
    if (body.queue === true) return { ok: true, queued: true, payload, salesman: { number: sales, id: 4652, name: "SALES A" } };
    return { ok: true, dry_run: true, payload, branch: { branchId: 50, branchName: "CABANG A", autoNumberId: 7 }, salesman: sales ? { number: sales, id: 4652, name: "SALES A" } : null };
}

const main = (page: Page) => page.locator("main");
const tanpaGulirSamping = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

test("List Report: kartu = saringan, status sampai faktur dari antrean (satu permintaan), nomor faktur menaut ke Faktur Penjualan", async ({ page }) => {
    const log = await pasang(page);
    await page.goto("/orders");
    await expect(page).toHaveURL(/\/orders$/, NAV);
    const m = main(page);
    await expect(m.getByRole("heading", { name: "Order Masuk", level: 1 })).toBeVisible(NAV);
    const kartu = m.getByRole("group", { name: "Saring menurut status" });
    await expect(kartu.getByRole("button", { name: /Semua order\s*4/ })).toBeVisible();
    await expect(kartu.getByRole("button", { name: /Butuh harga\s*1/ })).toBeVisible();
    await expect(kartu.getByRole("button", { name: /Siap diantrekan\s*1/ })).toBeVisible();
    await expect(kartu.getByRole("button", { name: /Di antrean\s*1/ })).toBeVisible();
    await expect(kartu.getByRole("button", { name: /Difakturkan\s*1/ })).toBeVisible();
    // Status antrean untuk semua order yang tampil dibaca dengan SATU permintaan.
    expect(log.statusUrls).toHaveLength(1);
    for (const id of [ID_A, ID_B, ID_C, ID_D]) expect(decodeURIComponent(log.statusUrls[0])).toContain(id);
    const tabel = m.locator("table");
    await expect(tabel.getByRole("link", { name: "INV/2610/KN01412" })).toHaveAttribute("href", "/faktur?q=INV%2F2610%2FKN01412");
    await expect(tabel.locator("tr", { hasText: "TOKO C" })).toContainText("Difakturkan");
    await expect(tabel.locator("tr", { hasText: "TOKO D" })).toContainText("Di antrean");
    await expect(tabel.locator("tr", { hasText: "TOKO B" })).toContainText("Butuh harga");
    await expect(tabel.locator("tr", { hasText: "TOKO B" })).toContainText("Order Sales #10390000");
    await expect(tabel.getByRole("link", { name: "Order 8f1c0000" })).toHaveAttribute("href", `/orders/${ID_A}`);
    await kartu.getByRole("button", { name: /Butuh harga/ }).click();
    await expect(tabel.locator("tbody tr")).toHaveCount(1);
    await expect(tabel).toContainText("TOKO B");
    await page.screenshot({ path: "test-results/order-masuk/list-default.png", fullPage: true });
});

test("List Report: galat ≠ kosong; kosong; status antrean gagal ≠ belum antre", async ({ page }) => {
    let mode: "galat" | "kosong" | "ok" = "galat";
    await pasang(page, {
        list: (scope) => mode === "galat" ? { status: 502, html: HTML_502 } : { body: { ok: true, scope, orders: mode === "kosong" ? [] : ORDERS } },
        status: { body: { ok: false, error: "Gagal membaca antrean" }, status: 500 },
    });
    await page.goto("/orders");
    const m = main(page);
    await expect(m.getByText(/Daftar order gagal dimuat/)).toBeVisible(NAV);
    await expect(m.getByText(/bukan daftar kosong/)).toBeVisible();
    await expect(m.getByText("Belum ada order milik Anda")).toHaveCount(0);
    await expect(m.getByText(/502 Bad Gateway/)).toHaveCount(0);

    mode = "kosong";
    await m.getByRole("button", { name: "Coba lagi" }).click();
    await expect(m.getByText("Belum ada order milik Anda")).toBeVisible();

    mode = "ok";
    await page.reload();
    await expect(m.getByText("Status Antrean Faktur gagal dimuat.")).toBeVisible(NAV);
    await expect(m.locator("table tr", { hasText: "TOKO A" })).toContainText("status antrean belum terbaca");
    await expect(m.locator("table tr", { hasText: "TOKO A" })).not.toContainText("Siap diantrekan");
    const kartuGalat = m.getByRole("group", { name: "Saring menurut status" });
    await expect(kartuGalat.getByRole("button", { name: /Difakturkan\s*–\s*gagal dimuat/ })).toBeVisible();
    // Order tersimpan yang status antreannya tidak terbaca TIDAK dihitung Siap diantrekan.
    await expect(kartuGalat.getByRole("button", { name: /Siap diantrekan\s*–\s*gagal dimuat/ })).toBeVisible();
});

test("List Report: selama status antrean dimuat kartu antrean bertanda “–” (bukan 0) dan order tidak tampil Siap diantrekan", async ({ page }) => {
    let lepas: () => void = () => {};
    const tahan = new Promise<void>((ok) => { lepas = ok; });
    await pasang(page, { tundaStatus: () => tahan });
    await page.goto("/orders");
    const m = main(page);
    const kartu = m.getByRole("group", { name: "Saring menurut status" });
    await expect(kartu.getByRole("button", { name: /Siap diantrekan\s*–\s*memuat…/ })).toBeVisible(NAV);
    await expect(kartu.getByRole("button", { name: /Di antrean\s*–\s*memuat…/ })).toBeVisible();
    await expect(m.locator("table tr", { hasText: "TOKO A" })).toContainText("Memeriksa Antrean Faktur…");
    lepas();
    await expect(kartu.getByRole("button", { name: /Siap diantrekan\s*1$/ })).toBeVisible();
    await expect(m.locator("table tr", { hasText: "TOKO A" })).toContainText("Siap diantrekan");
});

test("Tarik Order Sales: hasil tarikan tampil; jawaban tidak pasti = belum pasti; koneksi lewat dialog", async ({ page }) => {
    let pull: Opsi["pull"] = { body: { ok: true, imported: [{ request_id: "a", order_id: "x" }, { request_id: "b", order_id: "y" }], already_imported: [], failed: [{ request_id: "c0c0c0c0-1", error: "Order serupa sudah ada", duplicate: true }] } };
    const log = await pasang(page, { get pull() { return pull; } });
    await page.goto("/orders");
    const m = main(page);
    await expect(m.getByRole("button", { name: "Tarik sekarang" })).toBeEnabled(NAV);
    const sebelum = log.listCalls;
    await m.getByRole("button", { name: "Tarik sekarang" }).click();
    await expect(m.getByText("2 order baru ditarik dari Order Sales.")).toBeVisible();
    await expect(m.getByText(/1 tertahan: #c0c0c0c0 — Order serupa sudah ada/)).toBeVisible();
    await expect.poll(() => log.listCalls).toBeGreaterThan(sebelum);

    pull = { status: 502, html: HTML_502 };
    await m.getByRole("button", { name: "Tarik sekarang" }).click();
    await expect(m.getByText("Hasil tarik belum pasti.")).toBeVisible();
    await expect(m.getByText(/502 Bad Gateway/)).toHaveCount(0);

    await m.getByRole("button", { name: "Nyalakan tarik otomatis…" }).click();
    const dlg = page.getByRole("dialog", { name: "Nyalakan tarik otomatis Order Sales?" });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("3 permintaan");
    await dlg.getByRole("button", { name: "Nyalakan" }).click();
    await expect(dlg).toBeHidden();
    expect(log.koneksi).toEqual([{ enabled: true }]);
});

test("Order baru: harga terisi dari master + sumbernya, harga diubah ditandai, simpan lewat dialog lalu ke halaman order", async ({ page }) => {
    const log = await pasang(page);
    await page.goto("/orders/baru");
    const m = main(page);
    const simpanBtn = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpanBtn).toBeDisabled(NAV);
    await expect(simpanBtn).toHaveAttribute("title", "Pilih pelanggan dan isi minimal satu barang");
    await m.getByLabel("Kode pelanggan Accurate").fill("C-A001-KN");
    await expect(m.getByLabel("Outlet")).toHaveValue("TOKO A");
    await expect(m.getByLabel("Channel")).toHaveValue("GT");
    const b1 = m.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Kode barang").fill("BRG-A1");
    await b1.getByLabel("Jumlah").fill("5");
    await expect(b1.getByLabel("Harga")).toHaveValue("456000");
    await expect(b1).toContainText("Grosir · CABANG A · berlaku 01/10/2026");
    await m.getByRole("button", { name: "Tambah barang" }).click();
    const b2 = m.getByRole("listitem", { name: "Barang 2" });
    await b2.getByLabel("Kode barang").fill("BRG-A2");
    await b2.getByLabel("Jumlah").fill("10");
    await expect(b2.getByLabel("Harga")).toHaveValue("120000");
    await b2.getByLabel("Harga").fill("110000");
    await expect(b2).toContainText("Beda dari master Rp 120.000");
    await expect(m.getByText("1 harga diubah dari harga master.")).toBeVisible();
    await expect(simpanBtn).toBeEnabled();
    await simpanBtn.click();
    const dlg = page.getByRole("dialog", { name: "Simpan order untuk TOKO A?" });
    await expect(dlg).toContainText("1 barang beda dari master");
    await dlg.getByRole("button", { name: "Simpan order" }).click();
    await expect(page).toHaveURL(new RegExp(`/orders/${ID_A}\\?baru=1$`), NAV);
    expect(log.simpan).toHaveLength(1);
    expect(log.simpan[0]).toMatchObject({
        outlet: "TOKO A", channel: "GT", customer_no: "C-A001-KN",
        lines: [{ code: "BRG-A1", unit: "KRT", quantity: "5", price: "456000" }, { code: "BRG-A2", unit: "LSN", quantity: "10", price: "110000" }],
    });
    await expect(main(page).getByText("Order tersimpan dengan aturan promo yang dibekukan.")).toBeVisible(NAV);
});

test("Order baru: sesudah tersimpan Simpan terkunci sampai halaman order terbuka — tidak tersimpan dua kali", async ({ page }) => {
    const log = await pasang(page);
    let lepas: () => void = () => {};
    const tahan = new Promise<void>((ok) => { lepas = ok; });
    // Tahan navigasi ke halaman order (host Next saja, bukan FastAPI) supaya keadaan "sudah tersimpan, belum pindah" bisa diuji.
    await page.route((u) => u.host === "localhost:3011" && u.pathname === `/orders/${ID_A}`, async (r) => { await tahan; await r.continue(); });
    await page.goto("/orders/baru");
    const m = main(page);
    await m.getByLabel("Kode pelanggan Accurate").fill("C-A001-KN", NAV);
    const b1 = m.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Kode barang").fill("BRG-A1");
    await expect(b1.getByLabel("Harga")).toHaveValue("456000");
    await page.getByRole("button", { name: "Simpan order…" }).click();
    const simpan = page.getByRole("dialog").getByRole("button", { name: "Simpan order", exact: true });
    await simpan.click();
    await expect.poll(() => log.simpan.length).toBe(1);
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", "Order sudah tersimpan; membuka halaman order…");
    await simpan.click({ force: true });
    lepas();
    await expect(page).toHaveURL(new RegExp(`/orders/${ID_A}\\?baru=1$`), NAV);
    expect(log.simpan).toHaveLength(1);
});

test("Order baru: galat server tampil di dialog apa adanya; simpan tidak pasti mengunci Simpan", async ({ page }) => {
    await pasang(page, { simpan: [
        { status: 422, body: { detail: "Channel outlet C-A001-KN menurut master MT, bukan GT" } },
        { status: 502, html: HTML_502 },
    ] });
    await page.goto("/orders/baru");
    const m = main(page);
    await m.getByLabel("Kode pelanggan Accurate").fill("C-A001-KN", NAV);
    const b1 = m.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Kode barang").fill("BRG-A1");
    await expect(b1.getByLabel("Harga")).toHaveValue("456000");
    const simpanBtn = page.getByRole("button", { name: "Simpan order…" });
    await simpanBtn.click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Simpan order" }).click();
    await expect(dlg.getByRole("alert")).toHaveText("Channel outlet C-A001-KN menurut master MT, bukan GT");
    await dlg.getByRole("button", { name: "Simpan order" }).click();
    await expect(dlg).toBeHidden();
    await expect(m.getByText("Hasil simpan belum pasti.")).toBeVisible();
    await expect(simpanBtn).toBeDisabled();
    await expect(simpanBtn).toHaveAttribute("title", /Periksa Order Masuk dulu/);
});

test("Object Page: harga order vs master; Antrekan WAJIB salesman dan payload membawa salesman di setiap baris (C7)", async ({ page }) => {
    let antre = false;
    const log = await pasang(page, {
        invoiceGet: () => ({ body: { ok: true, outbox: antre ? { state: "queued", accurateNumber: null, lastError: null, updatedAt: "2026-10-06T01:52:00Z" } : null } }),
        invoicePost: (b) => { if (b.queue === true) antre = true; return { body: pratinjau(b) }; },
    });
    await page.goto(`/orders/${ID_A}`);
    const m = main(page);
    await expect(m.getByRole("heading", { name: "Order 8f1c0000", level: 1 })).toBeVisible(NAV);
    await expect(m.locator(".fi-oph")).toContainText("Siap diantrekan");
    await expect(m.locator("table tr", { hasText: "BRG-A2" })).toContainText("Beda master");
    await expect(m.locator("table tr", { hasText: "BRG-A1" })).toContainText("Sama dengan master");
    await expect(m.getByText("1 barang beda dari master (belum menahan antre — usulan BL-19)")).toBeVisible();
    await page.getByRole("button", { name: "Antrekan faktur…" }).click();
    const dlg = page.getByRole("dialog", { name: "Antrekan faktur untuk Order 8f1c0000?" });
    const tombolAntre = dlg.getByRole("button", { name: "Antrekan", exact: true });
    await expect(tombolAntre).toBeDisabled();
    await expect(tombolAntre).toHaveAttribute("title", "Pilih salesman dulu");
    await expect(dlg).toContainText("CABANG A · seri faktur cabang ini");
    await expect(dlg).toContainText("06/10/2026 (tanggal order; bisa diganti saat Kirim)");
    await expect(dlg).toContainText("Netto Rp 3.411.600 + PPN 11% = Rp 3.786.876 (estimasi)");
    await expect(dlg).toContainText("1 barang beda dari master");
    await dlg.getByLabel("Salesman").selectOption("M-SLA");
    await expect(dlg).toContainText("M-SLA · SALES A — di setiap baris faktur");
    await expect(tombolAntre).toBeEnabled();
    expect(log.invoicePosts.at(-1)).toEqual({ queue: false, salesman: "M-SLA" });
    await tombolAntre.click();
    await expect(dlg).toBeHidden();
    expect(log.invoicePosts.at(-1)).toEqual({ queue: true, salesman: "M-SLA" });
    await expect(m.getByText("Order 8f1c0000 masuk Antrean Faktur.")).toBeVisible();
    await expect(m.locator(".fi-oph")).toContainText("Di antrean");
    await expect(page.getByRole("button", { name: "Antrekan faktur…" })).toBeDisabled();
    await page.screenshot({ path: "test-results/order-masuk/detail-antre.png", fullPage: true });
});

test("Object Page: ditolak tampil di dialog; antre tidak pasti → belum pasti + muat ulang + kunci", async ({ page }) => {
    let jawab: "tolak" | "ragu" = "tolak";
    let galatBaca = false;
    const log = await pasang(page, {
        invoiceGet: () => galatBaca ? { body: { ok: false, error: "Gagal membaca antrean" }, status: 500 } : { body: { ok: true, outbox: null } },
        invoicePost: (b) => b.queue !== true ? { body: pratinjau(b) }
            : jawab === "tolak" ? { status: 409, body: { ok: false, error: "Satuan LSN tidak ada di master satuan Accurate" } } : { status: 504, html: HTML_502 },
    });
    await page.goto(`/orders/${ID_A}`);
    const m = main(page);
    await page.getByRole("button", { name: "Antrekan faktur…" }).click(NAV);
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Salesman").selectOption("M-SLB");
    const antre = dlg.getByRole("button", { name: "Antrekan", exact: true });
    await expect(antre).toBeEnabled();
    await antre.click();
    await expect(dlg.getByRole("alert")).toHaveText("Satuan LSN tidak ada di master satuan Accurate");
    jawab = "ragu";
    galatBaca = true;
    const getSebelum = log.invoiceGets;
    await antre.click();
    await expect(dlg).toBeHidden();
    await expect(m.getByText("Hasil antre belum pasti.")).toBeVisible();
    await expect(m.getByText(/504|Bad Gateway/)).toHaveCount(0);
    await expect.poll(() => log.invoiceGets).toBeGreaterThan(getSebelum);
    const tombol = page.getByRole("button", { name: "Antrekan faktur…" });
    await expect(tombol).toBeDisabled();
    await expect(tombol).toHaveAttribute("title", "Status Antrean Faktur belum terbaca; muat ulang dulu");
});

test("Object Page: tidak ditemukan ≠ galat; Butuh harga terkunci beralasan", async ({ page }) => {
    await pasang(page, { detail: {
        [ID_C]: { status: 502, html: HTML_502 },
        [ID_B]: { body: { ok: true, order: { ...ORDERS[1], note: "", sources: [], rules: [], lines: [{ code: "BRG-A1", unit: "KRT", quantity: "2", price: "" }] } } },
    } });
    await page.goto(`/orders/${ID_D}`);
    const m = main(page);
    await expect(m.getByText("Order tidak ditemukan")).toBeVisible(NAV);
    await page.goto(`/orders/${ID_C}`);
    await expect(m.getByRole("heading", { name: "Order gagal dimuat" })).toBeVisible(NAV);
    await expect(m.getByText(/bukan berarti ordernya tidak ada/)).toBeVisible();
    await expect(m.getByText("Order tidak ditemukan")).toHaveCount(0);
    await page.goto(`/orders/${ID_B}`);
    await expect(m.locator(".fi-oph")).toContainText("Butuh harga", NAV);
    const tombol = page.getByRole("button", { name: "Antrekan faktur…" });
    await expect(tombol).toBeDisabled();
    await expect(tombol).toHaveAttribute("title", /Butuh harga/);
});

test("Object Page: status antrean belum terbaca → tidak ada langkah tahap yang disorot sebagai posisi order", async ({ page }) => {
    await pasang(page, { invoiceGet: () => ({ body: { ok: false, error: "Gagal membaca antrean" }, status: 500 }) });
    await page.goto(`/orders/${ID_A}`);
    const m = main(page);
    await expect(m.getByText("Status Antrean Faktur belum terbaca.")).toBeVisible(NAV);
    const tahap = m.getByRole("list", { name: "Tahap order" });
    await expect(tahap.locator('[aria-current="step"]')).toHaveCount(0);
    await expect(m.locator(".fi-oph")).toContainText("status antrean belum terbaca");
});

test("Ponsel 390 px: daftar, Order baru, dan halaman order tanpa gulir menyamping", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await pasang(page);
    await page.goto("/orders");
    await expect(main(page).getByRole("heading", { name: "Order Masuk", level: 1 })).toBeVisible(NAV);
    await expect(main(page).getByRole("list", { name: /^Order/ }).first()).toBeVisible();
    await tanpaGulirSamping(page);
    await page.goto("/orders/baru");
    await expect(main(page).getByRole("heading", { name: "Order baru", level: 1 })).toBeVisible(NAV);
    await tanpaGulirSamping(page);
    await page.goto(`/orders/${ID_A}`);
    await expect(main(page).getByRole("heading", { name: "Order 8f1c0000", level: 1 })).toBeVisible(NAV);
    await tanpaGulirSamping(page);
    await page.screenshot({ path: "test-results/order-masuk/detail-390.png", fullPage: true });
});
