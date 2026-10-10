/*
 * Tujuan: Fiori S6d Order Principal — wizard Unggah → Validasi → Calon faktur → Diantrekan: daftar batch galat ≠ kosong, pilihan
 *   principal (lain nonaktif), pratinjau → Simpan batch (FormData apply), berkas sama → dialog Ganti membaca antrean batch lama, Validasi
 *   (Ditahan utuh paling atas + Mapping, Harga laporan/Accurate/Selisih, peringatan = strip, Bukan order ganda lewat dialog beralasan,
 *   Cabut langsung, Segarkan harga prices=1, validasi berjalan), calon faktur (tanpa sales, pernah dibuang, tidak ikut, draf) → dialog
 *   antreN (payload queue:true) → Diantrekan (Hapus terkunci, alur dokumen), Hapus dari daftar membaca antrean dulu, jawaban tidak pasti
 *   (502 HTML / putus) → "belum pasti" + muat ulang + kunci, ponsel 390 px tanpa gulir menyamping, tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-order-principal.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: /api/principal-order/** di-mock dengan page.route (tidak menyentuh DB/Accurate).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Request, type Route } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const PRINCIPAL = "KINO NON FOOD";
const FILE = "OrderDetail_CABANG-A_2026-10-05.xlsx";
const HELD = `SO 1671-SOP-260013025 ditahan utuh (2 baris lain ikut ditahan): kode produk BRG-A9 belum ada di mapping. Tambahkan mapping-nya, lalu unggah ulang berkas ini dengan "ganti batch lama".`;
const DUPE = "SO 1671-SOP-260013030 ini mirip 83% dengan 1671-SOP-260012988 pada outlet dan tanggal yang sama (5 barang sama: BRG-A1, BRG-A2). "
    + "Mirip tetapi tidak sama persis justru bentuk ketikan ulang yang paling sering lolos — konfirmasi dulu bahwa ini bukan order ganda.";

const BATCH = {
    id: "b1", principal: PRINCIPAL, fileName: FILE, branch: "CABANG A", period: "2026-10-05", lineCount: 4, skipped: 1,
    issues: [HELD, "Baris 9: QTY 0; baris dilewati."], status: "review", uploadedBy: "admin@contoh.test", uploadedAt: "2026-10-05T08:20:00.000Z",
    validatedAt: "2026-10-05T08:25:00.000Z", okCount: 2, reviewCount: 2,
};
const BATCH_LAMA = { ...BATCH, id: "b0", fileName: "OrderDetail_CABANG-A_2026-10-02.xlsx", period: "2026-10-02", issues: [], uploadedAt: "2026-10-02T07:30:00.000Z", okCount: 64, reviewCount: 0, lineCount: 64, skipped: 0 };
const line = (rowNumber: number, soNo: string, over: Record<string, unknown> = {}) => ({
    rowNumber, soNo, soDate: "2026-10-05", customerCode: "C-TKA01", customerName: "TOKO A", customerType: "General Trade",
    productCode: "BRG-A1", productName: "BARANG A1 100ML", reportQty: "24", reportGross: "240000", qty: "1", unit: "KRT", price: "240000",
    discounts: [{ position: 1, percent: 2 }], bonus: false, itemCode: "BRG-A1", customerNo: "TKA01-KN", expectedPrice: "240000",
    status: "ok", findings: [], ...over,
});
const LINES = [
    line(1, "1671-SOP-260013022"),
    line(2, "1671-SOP-260013022", { productCode: "BRG-A2", productName: "BARANG A2 50ML" }),
    line(3, "1671-SOP-260013024", { price: "250000", expectedPrice: "245000", status: "review", findings: ["Harga 250.000 beda dari harga Accurate 245.000."] }),
    line(4, "1671-SOP-260013030", { customerName: "TOKO B", status: "review", findings: [DUPE] }),
];
const ACKS = [{ principal: PRINCIPAL, soNo: "1671-SOP-260013022", reason: "mirip", note: "Order susulan; SO lama sudah difakturkan sebagai INV/2610/KN01412.", confirmedBy: "admin@contoh.test", confirmedAt: "2026-10-05T09:00:00.000Z" }];
const READY = [
    { key: "KINO-NON-FOOD:1671-SOP-260013022", soNo: "1671-SOP-260013022", customerNo: "TKA01-KN", orderDate: "2026-10-05", lineCount: 2, gross: 480000, net: 470400, branch: "CABANG A", salesman: "SALES A", salesmanId: 101, pernahDibuang: false },
    { key: "KINO-NON-FOOD:1671-SOP-260013026", soNo: "1671-SOP-260013026", customerNo: "TKB01-KN", orderDate: "2026-10-05", lineCount: 1, gross: 300000, net: 300000, branch: "CABANG A", salesman: "", salesmanId: 0, pernahDibuang: true },
];
const SKIPPED = [{ soNo: "1671-SOP-260013024", reason: "ada baris yang perlu ditinjau" }, { soNo: "1671-SOP-260013030", reason: "ada baris yang perlu ditinjau" }];

type Kirim = { method: string; path: string; query: string; body: unknown };
type Mock = {
    daftar?: (r: Route) => Promise<void>;
    detail?: (id: string, r: Route) => Promise<void>;
    antrean?: (id: string, r: Route) => Promise<void>;
    unggah?: (form: string, r: Route) => Promise<void>;
    hapus?: (id: string, r: Route) => Promise<void>;
    validasi?: (r: Route) => Promise<void>;
    calon?: (queue: boolean, r: Route) => Promise<void>;
    ack?: (r: Route) => Promise<void>;
};

/** Semua /api/principal-order/** dimock; permintaan tulis dicatat. */
async function pasang(page: Page, m: Mock = {}) {
    const kirim: Kirim[] = [];
    const catat = (req: Request, body: unknown) => { const u = new URL(req.url()); kirim.push({ method: req.method(), path: u.pathname, query: u.search, body }); };
    await page.route((u) => u.pathname === "/api/principal-order", async (r) => {
        const req = r.request(); const id = new URL(req.url()).searchParams.get("id") ?? "";
        if (req.method() === "GET" && !id) return m.daftar ? m.daftar(r) : r.fulfill(json({ ok: true, batches: [BATCH, BATCH_LAMA] }));
        if (req.method() === "GET") return m.detail ? m.detail(id, r) : r.fulfill(json({ ok: true, batch: BATCH, lines: LINES }));
        if (req.method() === "DELETE") { catat(req, null); return m.hapus ? m.hapus(id, r) : r.fulfill(json({ ok: true, removed: 1 })); }
        const form = (req.postDataBuffer() ?? Buffer.from("")).toString("latin1");
        catat(req, form);
        return m.unggah ? m.unggah(form, r) : r.fulfill(json({ ok: false, error: "tidak dimock" }, 500));
    });
    await page.route((u) => u.pathname === "/api/principal-order/queue", async (r) => {
        const req = r.request(); const id = new URL(req.url()).searchParams.get("id") ?? "";
        if (req.method() === "GET") return m.antrean ? m.antrean(id, r) : r.fulfill(json({ ok: true, id, candidates: 2, queue: [] }));
        const body = req.postDataJSON() as { queue?: boolean };
        catat(req, body);
        return m.calon ? m.calon(body.queue === true, r) : r.fulfill(json(body.queue
            ? { ok: true, id, queued: 2, keys: READY.map((c) => c.key), alreadyPosted: [], skipped: SKIPPED }
            : { ok: true, dry_run: true, id, ready: READY, skipped: SKIPPED }));
    });
    await page.route((u) => u.pathname === "/api/principal-order/validate", async (r) => {
        catat(r.request(), null);
        return m.validasi ? m.validasi(r) : r.fulfill(json({ ok: true, id: "b1", checked: 4, okCount: 2, reviewCount: 2, priceRefresh: null, peringatan: [] }));
    });
    await page.route((u) => u.pathname === "/api/principal-order/dupe-ack", async (r) => {
        const req = r.request();
        if (req.method() === "GET") return r.fulfill(json({ ok: true, acks: ACKS }));
        catat(req, req.method() === "POST" ? req.postDataJSON() : null);
        return m.ack ? m.ack(r) : r.fulfill(json({ ok: true }));
    });
    return kirim;
}
/**
 * Tiruan GET status antrean batch = perilaku server sesudah BL-21: kunci dari SEMUA nomor SO batch (LINES), bukan hanya kandidat yang
 * lolos validasi — SO yang sudah antre lalu kini ditinjau tetap terhitung. `outbox` = nomor SO yang punya baris Antrean Faktur.
 */
const antreanServer = (outbox: () => string[]) => (id: string, r: Route) => r.fulfill(json({
    ok: true, id, candidates: 2,
    queue: [...new Set(LINES.map((l) => l.soNo))].filter((so) => outbox().includes(so)).map((so) => ({ orderId: `KINO-NON-FOOD:${so}`, state: "posted", number: "INV/2610/KN01412", error: "" })),
}));
const field = (form: string, name: string) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(form)?.[1];
const berkas = (name = FILE) => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("PK-isi-contoh") });

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Unggah: galat daftar bukan kosong; principal lain nonaktif; pratinjau → ringkasan → Simpan batch membuka Validasi", async ({ page }) => {
    let daftar: "galat" | "kosong" = "galat";
    const kirim = await pasang(page, {
        daftar: (r) => r.fulfill(daftar === "galat" ? json({ ok: false, error: "Koneksi basis data terputus." }, 500) : json({ ok: true, batches: [] })),
        unggah: (form, r) => r.fulfill(json(field(form, "apply") === "true"
            ? { ok: true, applied: true, id: "b1", lineCount: 4 }
            : { ok: true, applied: false, fileName: FILE, principal: PRINCIPAL, branch: "CABANG A", period: "2026-10-05", lineCount: 4, skipped: 1, issues: [HELD, "Baris 9: QTY 0; baris dilewati."],
                unmappedProducts: ["BRG-A9"], unmappedCustomers: [], unmappedSalesmen: ["(kosong)"], duplicateOf: null })),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/principal-order", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Order Principal" })).toBeVisible(NAV);
    await expect(main.getByRole("list", { name: "Langkah Order Principal" }).locator('[aria-current="step"]')).toContainText("Unggah");
    // Galat ≠ kosong.
    await expect(main.getByRole("alert").filter({ hasText: "Koneksi basis data terputus." })).toBeVisible();
    await expect(main.getByText("Belum ada batch")).toHaveCount(0);
    daftar = "kosong";
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByText("Belum ada batch")).toBeVisible();

    const pilih = main.getByLabel("Principal", { exact: true });
    await expect(pilih).toHaveValue(PRINCIPAL);
    await expect(pilih.locator("option", { hasText: "Principal lain — format belum didukung" })).toBeDisabled();
    const pratinjau = page.locator(".fi-ftb").getByRole("button", { name: "Pratinjau" });
    await expect(pratinjau).toBeDisabled();
    await expect(pratinjau).toHaveAttribute("title", "Pilih berkas Order Detail dulu.");

    await main.getByLabel(/Berkas Order Detail/).setInputFiles(berkas());
    await expect(main.getByText("Berkas belum disimpan")).toBeVisible();
    await pratinjau.click();
    const ringkas = main.getByRole("region", { name: "Pratinjau berkas" });
    await expect(ringkas.getByRole("status").filter({ hasText: "1 SO ditahan utuh" })).toContainText("SO 1671-SOP-260013025");
    await expect(ringkas.getByRole("status").filter({ hasText: "Belum termapping" })).toContainText("Salesman (1): (kosong) — SO-nya tertahan di Validasi");
    await expect(ringkas.getByRole("link", { name: "Mapping Principal" }).first()).toHaveAttribute("href", "/principal-mapping");
    await expect(ringkas).toContainText("Baris 9: QTY 0; baris dilewati.");
    expect(field(kirim[0].body as string, "apply")).toBe("false");
    expect(field(kirim[0].body as string, "principal")).toBe(PRINCIPAL);
    await page.screenshot({ path: "test-results/fiori-order-principal-unggah.png", fullPage: true });

    await page.locator(".fi-ftb").getByRole("button", { name: "Simpan batch" }).click();
    await expect(page).toHaveURL(/\/principal-order\?batch=b1$/, NAV);
    expect(field(kirim[1].body as string, "apply")).toBe("true");
    expect(field(kirim[1].body as string, "replace")).toBe("false");
    await expect(main.getByRole("status").filter({ hasText: "4 baris tersimpan." })).toBeVisible(NAV);
    await expect(main.getByRole("list", { name: "Langkah Order Principal" }).locator('[aria-current="step"]')).toContainText("Validasi");
});

test("Berkas sama: dialog Ganti membaca antrean batch lama — ada SO antre / gagal baca → nonaktif; kosong → replace=true", async ({ page }) => {
    let antrean: "ada" | "galat" | "kosong" = "ada";
    const kirim = await pasang(page, {
        antrean: (id, r) => r.fulfill(antrean === "galat" ? json({ ok: false, error: "Batch tidak ditemukan" }, 404)
            : json({ ok: true, id, candidates: 10, queue: antrean === "ada" ? [{ orderId: "KINO-NON-FOOD:1671-SOP-260013022", state: "queued", number: "", error: "" }] : [] })),
        unggah: (form, r) => r.fulfill(json(field(form, "apply") === "true"
            ? { ok: true, applied: true, id: "b2", lineCount: 64 }
            : { ok: true, applied: false, fileName: BATCH_LAMA.fileName, branch: "CABANG A", period: "2026-10-02", lineCount: 64, skipped: 0, issues: [], unmappedProducts: [], unmappedCustomers: [], unmappedSalesmen: [],
                duplicateOf: { id: "b0", fileName: BATCH_LAMA.fileName, uploadedAt: BATCH_LAMA.uploadedAt } })),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/principal-order", NAV);
    const main = page.locator("main");
    await main.getByLabel(/Berkas Order Detail/).setInputFiles(berkas(BATCH_LAMA.fileName));
    await page.locator(".fi-ftb").getByRole("button", { name: "Pratinjau" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Berkas ini sudah pernah diunggah." })).toContainText("02/10/2026 15.30");
    await expect(page.locator(".fi-ftb").getByRole("button", { name: "Simpan batch" })).toHaveCount(0);
    await expect(main.getByText("usulan BL-44")).toBeVisible();

    await page.locator(".fi-ftb").getByRole("button", { name: "Ganti batch lama…" }).click();
    let dlg = page.getByRole("dialog");
    const ganti = dlg.getByRole("button", { name: "Ganti batch", exact: true });
    await expect(dlg.getByRole("heading", { name: `Ganti batch ${BATCH_LAMA.fileName} dengan berkas ini?` })).toBeVisible();
    await expect(ganti).toBeDisabled();
    await expect(ganti).toHaveAttribute("title", /1 SO batch lama sudah di Antrean Faktur; batch tidak bisa diganti \(BL-21\)/);
    await expect(dlg.getByText("usulan BL-21")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-order-principal-ganti-ditolak.png" });
    await dlg.getByRole("button", { name: "Batal" }).click();

    antrean = "galat";
    await page.locator(".fi-ftb").getByRole("button", { name: "Ganti batch lama…" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("alert").filter({ hasText: "Status antrean belum terbaca." })).toContainText("Batch tidak ditemukan");
    await expect(dlg.getByRole("button", { name: "Ganti batch", exact: true })).toHaveAttribute("title", /belum terbaca/);
    antrean = "kosong";
    await dlg.getByRole("button", { name: "Coba lagi" }).click();
    await expect(dlg.getByRole("button", { name: "Ganti batch", exact: true })).toBeEnabled();
    await dlg.getByRole("button", { name: "Ganti batch", exact: true }).click();
    await expect(page).toHaveURL(/\?batch=b2$/, NAV);
    const simpan = kirim.filter((k) => k.method === "POST" && k.path === "/api/principal-order");
    expect(field(simpan.at(-1)!.body as string, "replace")).toBe("true");
    expect(field(simpan.at(-1)!.body as string, "apply")).toBe("true");
});

test("Validasi: Ditahan utuh paling atas, harga Accurate & selisih, peringatan strip, Bukan order ganda lewat dialog, Cabut langsung, Segarkan harga", async ({ page }) => {
    let lambat = false;
    const kirim = await pasang(page, {
        validasi: async (r) => {
            if (lambat) await new Promise((ok) => setTimeout(ok, 1500));
            const prices = new URL(r.request().url()).searchParams.get("prices") === "1";
            return r.fulfill(json({ ok: true, id: "b1", checked: 4, okCount: 2, reviewCount: 2, priceRefresh: prices ? { ok: true, processed: 3, priceRows: 12 } : null,
                peringatan: ['Aturan BP-A1 menunjuk daftar "LOYALTY" yang tidak punya anggota pada 2026-10-05.'] }));
        },
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/principal-order?batch=b1", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("list", { name: "Langkah Order Principal" }).locator('[aria-current="step"]')).toContainText("Validasi", NAV);
    // Bagian pertama sesudah KPI = Ditahan utuh.
    const bagian = main.locator("section.fi-section");
    await expect(bagian.first()).toHaveAttribute("aria-label", "Ditahan utuh: produk belum termapping");
    await expect(bagian.first().getByRole("link", { name: "Mapping Principal" })).toHaveAttribute("href", "/principal-mapping");
    await expect(bagian.first()).toContainText("BRG-A9");
    const tabel = main.getByRole("table", { name: "Baris perlu ditinjau" });
    for (const h of ["Harga laporan", "Harga Accurate", "Selisih"]) await expect(tabel.getByRole("columnheader", { name: h })).toBeVisible();
    await expect(tabel.locator("tbody tr").first()).toContainText("+5.000");
    await expect(main.getByText("usulan BL-45")).toBeVisible();
    await expect(main.getByText(/tanggal awal periode batch \(05\/10\/2026\)/)).toBeVisible();
    // Konfirmasi tercatat tetap tampil.
    await expect(main.getByRole("list", { name: "Konfirmasi bukan order ganda yang tercatat" })).toContainText("INV/2610/KN01412");
    await page.screenshot({ path: "test-results/fiori-order-principal-validasi.png", fullPage: true });

    // Bukan order ganda: catatan wajib, payload reason = temuan, note = catatan; lalu validasi ulang.
    await main.getByRole("button", { name: "Bukan order ganda…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "SO 1671-SOP-260013030 bukan order ganda?" })).toBeVisible();
    const yakin = dlg.getByRole("button", { name: "Bukan order ganda", exact: true });
    await expect(yakin).toBeDisabled();
    await dlg.getByLabel(/Catatan konfirmasi/).fill("Sudah dicek ke SALES A, order berbeda.");
    await yakin.click();
    await expect(dlg).toBeHidden();
    await expect(main.getByRole("status").filter({ hasText: "SO 1671-SOP-260013030 dinyatakan bukan order ganda." })).toBeVisible();
    const ack = kirim.find((k) => k.path === "/api/principal-order/dupe-ack" && k.method === "POST");
    expect(ack?.body).toEqual({ principal: PRINCIPAL, soNo: "1671-SOP-260013030", reason: DUPE, note: "Sudah dicek ke SALES A, order berbeda." });
    expect(kirim.filter((k) => k.path === "/api/principal-order/validate")).toHaveLength(1);
    await expect(main.getByRole("status").filter({ hasText: "Perlu dikerjakan:" })).toContainText("LOYALTY");

    // Cabut = tombol langsung (arah aman), lalu validasi ulang.
    await main.getByRole("button", { name: "Cabut konfirmasi SO 1671-SOP-260013022" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Konfirmasi SO 1671-SOP-260013022 dicabut." })).toBeVisible();
    expect(kirim.find((k) => k.method === "DELETE" && k.path === "/api/principal-order/dupe-ack")?.query).toBe("?principal=KINO%20NON%20FOOD&soNo=1671-SOP-260013022");

    // Segarkan harga = prices=1; Memuat: validasi berjalan, aksi terkunci.
    lambat = true;
    await page.locator(".fi-ftb").getByRole("button", { name: "Segarkan harga" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Menyegarkan harga Accurate lalu memvalidasi…" })).toBeVisible();
    await expect(page.locator(".fi-ftb").getByRole("button", { name: "Lanjut ke calon faktur" })).toBeDisabled();
    await expect(main.getByRole("status").filter({ hasText: "Harga disegarkan: 3 barang, 12 baris harga." })).toBeVisible();
    expect(kirim.filter((k) => k.path === "/api/principal-order/validate").at(-1)?.query).toBe("?id=b1&prices=1");
});

test("Calon faktur → dialog antreN (payload queue:true) → Diantrekan; Hapus terkunci bila SO antre; draf dijaga", async ({ page }) => {
    let antre: unknown[] = [];
    const kirim = await pasang(page, {
        antrean: (id, r) => r.fulfill(json({ ok: true, id, candidates: 2, queue: antre })),
        calon: (queue, r) => {
            if (queue) antre = [{ orderId: READY[0].key, state: "queued", number: "", error: "" }, { orderId: READY[1].key, state: "posted", number: "INV/2610/KN01412", error: "" }];
            return r.fulfill(json(queue ? { ok: true, id: "b1", queued: 2, keys: READY.map((c) => c.key), alreadyPosted: [], skipped: SKIPPED } : { ok: true, dry_run: true, id: "b1", ready: READY, skipped: SKIPPED }));
        },
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/principal-order?batch=b1", NAV);
    const main = page.locator("main");
    await page.locator(".fi-ftb").getByRole("button", { name: "Lanjut ke calon faktur" }).click(NAV);
    await expect(main.getByRole("list", { name: "Langkah Order Principal" }).locator('[aria-current="step"]')).toContainText("Calon faktur");
    await expect(main.getByText("Calon faktur belum diantrekan")).toBeVisible();
    expect(kirim.find((k) => k.path === "/api/principal-order/queue")?.body).toEqual({ queue: false });
    const tabel = main.getByRole("table", { name: "Calon faktur" });
    await expect(tabel.locator("tbody tr")).toHaveCount(2);
    await expect(tabel.locator("tbody tr").nth(1)).toContainText("tanpa sales");
    await expect(tabel.locator("tbody tr").nth(1)).toContainText("dicari dulu di Accurate saat diantrekan");
    await expect(main.getByRole("status").filter({ hasText: "1 faktur akan terbit TANPA sales" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Tidak ikut" })).toContainText("1671-SOP-260013024 — ada baris yang perlu ditinjau");
    await expect(main.getByText("usulan BL-23")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-order-principal-calon.png", fullPage: true });

    await page.locator(".fi-ftb").getByRole("button", { name: "Antrekan 2 faktur…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: `Antrekan 2 faktur dari batch ${FILE}?` })).toBeVisible();
    await expect(dlg).toContainText("Netto Rp 770.400 + PPN 11% ≈ Rp 855.144");
    await expect(dlg).toContainText("1 faktur (1671-SOP-260013026)");
    await expect(dlg).toContainText("2 SO (lihat daftar Tidak ikut)");
    await expect(dlg).toContainText("1 SO dicari dulu di Accurate");
    await page.screenshot({ path: "test-results/fiori-order-principal-dialog-antre.png" });
    await dlg.getByRole("button", { name: "Antrekan 2 faktur", exact: true }).click();
    await expect(dlg).toBeHidden();
    expect(kirim.filter((k) => k.path === "/api/principal-order/queue").at(-1)?.body).toEqual({ queue: true });

    await expect(main.getByRole("list", { name: "Langkah Order Principal" }).locator('[aria-current="step"]')).toContainText("Diantrekan");
    await expect(main.getByRole("status").filter({ hasText: "2 faktur masuk Antrean Faktur." })).toBeVisible();
    const status = main.getByRole("table", { name: "Status antrean batch ini" });
    await expect(status).toContainText("Antre");
    await expect(status).toContainText("INV/2610/KN01412");
    await expect(main.getByRole("list", { name: "Alur dokumen" })).toContainText("1 terbit");
    const hapus = page.locator(".fi-ftb").getByRole("button", { name: "Hapus batch…" });
    await expect(hapus).toBeDisabled();
    await expect(hapus).toHaveAttribute("title", "2 SO batch ini ada di Antrean Faktur; batch tidak bisa dihapus (BL-21).");
    await expect(page.locator(".fi-ftb").getByRole("link", { name: "Buka Antrean Faktur" })).toHaveAttribute("href", "/antrean-faktur");
    await page.screenshot({ path: "test-results/fiori-order-principal-diantrekan.png", fullPage: true });
});

test("Jawaban tidak pasti: antre 502 HTML → belum pasti di dialog, antrean dimuat ulang, Antrekan terkunci sampai disiapkan ulang", async ({ page }) => {
    let bacaAntrean = 0;
    await pasang(page, {
        antrean: (id, r) => { bacaAntrean += 1; return r.fulfill(json({ ok: true, id, candidates: 2, queue: [] })); },
        calon: (queue, r) => (queue
            ? r.fulfill({ status: 502, contentType: "text/html", body: "<html><body><h1>502 Bad Gateway</h1></body></html>" })
            : r.fulfill(json({ ok: true, dry_run: true, id: "b1", ready: READY, skipped: [] }))),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/principal-order?batch=b1", NAV);
    await page.locator(".fi-ftb").getByRole("button", { name: "Lanjut ke calon faktur" }).click(NAV);
    await page.locator(".fi-ftb").getByRole("button", { name: "Antrekan 2 faktur…" }).click();
    const dlg = page.getByRole("dialog");
    const sebelum = bacaAntrean;
    await dlg.getByRole("button", { name: "Antrekan 2 faktur", exact: true }).click();
    await expect(dlg.getByRole("alert")).toContainText("hasilnya belum pasti");
    await expect(dlg).not.toContainText("Bad Gateway");
    await expect(dlg.getByRole("button", { name: "Antrekan 2 faktur", exact: true })).toBeDisabled();
    await expect.poll(() => bacaAntrean).toBeGreaterThan(sebelum);
    await dlg.getByRole("button", { name: "Batal" }).click();
    const main = page.locator("main");
    await expect(main.getByRole("status").filter({ hasText: "Hasil antre sebelumnya belum pasti." })).toBeVisible();
    const antre = page.locator(".fi-ftb").getByRole("button", { name: "Antrekan 2 faktur…" });
    await expect(antre).toBeDisabled();
    await expect(antre).toHaveAttribute("title", "Hasil antre sebelumnya belum pasti; siapkan ulang calon faktur dulu.");
    await page.locator(".fi-ftb").getByRole("button", { name: "Siapkan ulang" }).click();
    await expect(antre).toBeEnabled();
});

test("Hapus dari Batch terakhir: dialog membaca antrean dulu; ada SO / gagal → nonaktif; putus → belum pasti + kunci; 0 → DELETE", async ({ page }) => {
    let antrean: "ada" | "kosong" = "ada";
    let putus = true;
    const kirim = await pasang(page, {
        // SO 1671-SOP-260013024 kini DITINJAU (bukan kandidat) tetapi fakturnya sudah terposting: tetap mengunci Hapus.
        antrean: antreanServer(() => (antrean === "ada" ? ["1671-SOP-260013024"] : [])),
        hapus: (id, r) => (putus ? r.abort("connectionreset") : r.fulfill(json({ ok: true, removed: 1 }))),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/principal-order", NAV);
    const main = page.locator("main");
    const tabel = main.getByRole("table", { name: "Batch terakhir" });
    await expect(tabel.locator("tbody tr")).toHaveCount(2, NAV);
    await tabel.getByRole("button", { name: `Hapus ${FILE}…` }).click();
    let dlg = page.getByRole("dialog");
    const hapus = dlg.getByRole("button", { name: "Hapus batch", exact: true });
    await expect(hapus).toHaveAttribute("title", /1 SO batch ini sudah di Antrean Faktur; batch tidak bisa dihapus \(BL-21\)/);
    await expect(dlg.getByText("usulan BL-21")).toBeVisible();
    await expect(dlg.getByRole("textbox")).toHaveCount(0); // server DELETE tidak menerima alasan
    await dlg.getByRole("button", { name: "Batal" }).click();

    antrean = "kosong";
    await tabel.getByRole("button", { name: `Hapus ${FILE}…` }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("button", { name: "Hapus batch", exact: true })).toBeEnabled();
    await dlg.getByRole("button", { name: "Hapus batch", exact: true }).click();
    await expect(dlg.getByRole("alert")).toContainText("hasilnya belum pasti");
    putus = false;
    await expect(dlg.getByRole("button", { name: "Hapus batch", exact: true })).toBeEnabled(); // terbaca lagi → boleh diulang
    await dlg.getByRole("button", { name: "Hapus batch", exact: true }).click();
    await expect(dlg).toBeHidden();
    await expect(main.getByRole("status").filter({ hasText: `Batch ${FILE} dihapus.` })).toBeVisible();
    expect(kirim.filter((k) => k.method === "DELETE").map((k) => k.query)).toEqual(["?id=b1", "?id=b1"]);
});

test("BL-21 server: Hapus yang ditolak server (409) tampil di dialog apa adanya; batch tidak tampil terhapus", async ({ page }) => {
    const TOLAK = "1 SO batch ini sudah di Antrean Faktur (1671-SOP-260013024); batch tidak bisa dihapus. Buang dulu di Antrean Faktur bila memang harus diulang.";
    const kirim = await pasang(page, {
        // Layar membaca antrean kosong (mis. bacaan usang), server tetap penjaga utama di dalam transaksi.
        antrean: antreanServer(() => []),
        hapus: (_id, r) => r.fulfill(json({ ok: false, error: TOLAK }, 409)),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/principal-order", NAV);
    const main = page.locator("main");
    const tabel = main.getByRole("table", { name: "Batch terakhir" });
    await tabel.getByRole("button", { name: `Hapus ${FILE}…` }).click(NAV);
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Hapus batch", exact: true }).click();
    await expect(dlg.getByRole("alert")).toHaveText(TOLAK);
    await expect(dlg).toBeVisible();
    await expect(main.getByText(`Batch ${FILE} dihapus.`)).toHaveCount(0);
    expect(kirim.filter((k) => k.method === "DELETE")).toHaveLength(1);
});

test("Batch tidak ditemukan = galat (bukan kosong); ponsel 390 px tanpa gulir menyamping di Unggah dan Validasi", async ({ page }) => {
    await pasang(page, { detail: (id, r) => (id === "hilang" ? r.fulfill(json({ ok: false, error: "Batch tidak ditemukan" }, 404)) : r.fulfill(json({ ok: true, batch: BATCH, lines: LINES }))) });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/principal-order?batch=hilang", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("alert").filter({ hasText: "Batch tidak ditemukan" })).toBeVisible(NAV);
    await expect(main.getByRole("link", { name: "Kembali ke unggah" })).toHaveAttribute("href", "/principal-order");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/principal-order", NAV);
    await expect(main.getByRole("list", { name: "Batch terakhir" })).toBeVisible(NAV);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-order-principal-ponsel-unggah.png", fullPage: true });
    await page.goto("/principal-order?batch=b1", NAV);
    await expect(main.getByRole("list", { name: "Baris perlu ditinjau" })).toBeVisible(NAV);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-order-principal-ponsel-validasi.png", fullPage: true });
});
