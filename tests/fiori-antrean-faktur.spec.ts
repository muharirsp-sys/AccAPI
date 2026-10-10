/*
 * Tujuan: Fiori S6c Antrean Faktur (it02) — worklist (kartu = saringan, jawaban Accurate terbaca, galat ≠ kosong, kosong, ponsel 390 px),
 *   dialog Kirim BL-39 (pratinjau server; yang dikirim = orderIds HASIL PRATINJAU; hasil per baris termasuk dilewati; sesi tidak cocok =
 *   nonaktif berlasan; 502 HTML = "belum pasti" + muat ulang + kunci), Selesaikan tidak pasti (hasil pencarian DULU, ketemu/tidak ketemu/
 *   gagal, 409 masa tunggu = sisa menit, tanpa izin = nonaktif berlasan), Antre ulang (hasil pencarian server), Buang (alasan wajib),
 *   Riwayat (BL-17), dan Verifikasi balik (selisih terbuka terlihat, Terima sales/Cabut, draf, galat terpisah). Tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-antrean-faktur.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: /api/invoice-outbox/**, /api/invoice-verify di-mock dengan page.route (tidak menyentuh DB/Accurate).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const menitLalu = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());

type Over = Record<string, unknown>;
const row = (orderId: string, state: string, over: Over = {}) => ({
    orderId, soNo: orderId.includes(":") ? orderId.split(":")[1] : null, source: "laporan principal", customerNo: "C-A-001", outlet: "TOKO A",
    salesman: "SALES A", orderDate: "2026-10-09", state, attempts: 0, lastError: "", accurateNumber: "", queuedBy: "admin@contoh",
    createdAt: menitLalu(30), updatedAt: menitLalu(30), ageMinutes: 30, overdue: false, ...over,
});
const ROWS = [
    row("PRINCIPLE-A:SO-A-001", "queued", { ageMinutes: 134, overdue: true }),
    row("PRINCIPLE-A:SO-A-002", "queued", { outlet: "TOKO B", customerNo: "C-A-002", ageMinutes: 25 }),
    row("PRINCIPLE-B:SO-B-001", "sending", { attempts: 1, updatedAt: menitLalu(20) }),
    row("PRINCIPLE-A:SO-A-003", "unknown", { attempts: 1, updatedAt: menitLalu(40), lastError: "HTTP 401 (belum terbukti tidak diproses): {\"s\":false}" }),
    row("PRINCIPLE-B:SO-B-002", "rejected", { attempts: 2, overdue: true, ageMinutes: 151, customerNo: "C-B-009", outlet: "TOKO C", lastError: "[\"Pelanggan C-B-009 tidak ditemukan\"]" }),
];
const BATCH = { id: "b1", fileName: "ORDER_PRINCIPLE_A_PAGI.xlsx", principal: "PRINCIPLE A", uploadedAt: menitLalu(150), uploadedBy: "admin@contoh", reviewCount: 6, lineCount: 214, ageMinutes: 150, overdue: true };
const antrean = (rows: unknown[], over: Over = {}) => ({
    ok: true, escalateAfterMinutes: 120, summary: { queued: 2, sending: 1, unknown: 1, rejected: 1, posted: 591 },
    overdue: 3, overdueQueue: 2, overdueBatches: 1, reviewLinesOverdue: 6, pendingBatches: [BATCH], rows, ...over,
});
const order = (orderId: string, total: number) => ({ orderId, soNo: orderId.split(":")[1], principal: orderId.split(":")[0], customerNo: "C-A-001",
    orderDate: "2026-10-09", transDate: "09/10/2026", lines: 2, dpp: total / 1.11, ppn: total - total / 1.11, total });
const PRATINJAU = (over: Over = {}) => ({
    ok: true, database: { tujuan: "1001", label: "x", sesiPenekan: { id: "1001", alias: "DB CABANG A" }, cocok: true },
    maksPerTekan: 50, jumlah: 2, antreanMenunggu: 2, tanggalFaktur: null, nilaiPerkiraan: "x",
    perPrincipal: [{ principal: "PRINCIPLE-A", jumlah: 2, dpp: 200000, ppn: 22000, total: 222000 }],
    total: { dpp: 200000, ppn: 22000, total: 222000 },
    orders: [order("PRINCIPLE-A:SO-A-001", 111000), order("PRINCIPLE-A:SO-A-002", 111000)], ...over,
});
const temuan = (jenis: "sales" | "isi" | null, field: string, expected: string, actual: string) => ({ line: jenis === "isi" ? 3 : null, field, expected, actual, jenis, dijelaskan: false });
const VERIF = {
    ok: true, checked: 2, summary: { cocok: 1, selisih: 1, dijelaskan: 0, "tak-terperiksa": 0 }, rows: [
        { orderId: "PRINCIPLE-A:SO-A-009", soNo: "SO-A-009", state: "posted", customerNo: "C-A-001", matchedBy: "charField1", foundWhileUnknown: false,
            status: "selisih", reason: "", invoiceNumber: "INV/A/0009", linesChecked: 4, salesman: "SALES B", invoiceDate: "09/10/2026", terbuka: 2,
            findings: [temuan("sales", "sales", "SALES A", "SALES B"), temuan("isi", "qty", "24", "20")], sidik: { sales: "[\"s\"]", isi: "[\"i\"]" }, penjelasan: {} },
        { orderId: "PRINCIPLE-A:SO-A-008", soNo: "SO-A-008", state: "posted", customerNo: "C-A-001", matchedBy: "charField1", foundWhileUnknown: false,
            status: "cocok", reason: "", invoiceNumber: "INV/A/0008", linesChecked: 3, salesman: "SALES A", invoiceDate: "09/10/2026", terbuka: 0,
            findings: [], sidik: { sales: "[]", isi: "[]" }, penjelasan: {} },
    ],
};

type Tulis = { method: string; path: string; query: string; body: Record<string, unknown> | null };
type Jawab = (route: Route, body: Record<string, unknown> | null) => unknown;
type Opsi = {
    list?: Jawab; preview?: Jawab; send?: Jawab; aksi?: Jawab; cari?: Jawab; selesai?: Jawab; riwayat?: Jawab; verif?: Jawab;
};

/** Semua /api/invoice-outbox/** dan /api/invoice-verify dimock; `opsi` dibaca tiap permintaan (bisa diganti di tengah tes). */
async function mock(page: Page, opsi: Opsi) {
    const log: Tulis[] = [];
    await page.route((u) => u.pathname.startsWith("/api/invoice-outbox") || u.pathname === "/api/invoice-verify", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const body = req.postData() ? (req.postDataJSON() as Record<string, unknown>) : null;
        log.push({ method: req.method(), path: url.pathname, query: url.search, body });
        const p = url.pathname;
        const m = req.method();
        const pakai = (f: Jawab | undefined, bawaan: () => unknown) => (f ? f(route, body) : bawaan());
        if (p === "/api/invoice-outbox" && m === "GET") return pakai(opsi.list, () => route.fulfill(json(antrean(ROWS))));
        if (p === "/api/invoice-outbox" && m === "POST") return pakai(opsi.aksi, () => route.fulfill(json({ ok: true })));
        if (p === "/api/invoice-outbox/send/preview") return pakai(opsi.preview, () => route.fulfill(json(PRATINJAU())));
        if (p === "/api/invoice-outbox/send") return pakai(opsi.send, () => route.fulfill(json({ ok: false, error: "tidak diharapkan" }, 500)));
        if (p === "/api/invoice-outbox/resolve" && m === "GET") return pakai(opsi.cari, () => route.fulfill(json({ ok: false, error: "tidak diharapkan" }, 500)));
        if (p === "/api/invoice-outbox/resolve" && m === "POST") return pakai(opsi.selesai, () => route.fulfill(json({ ok: false, error: "tidak diharapkan" }, 500)));
        if (p === "/api/invoice-outbox/riwayat") return pakai(opsi.riwayat, () => route.fulfill(json({ ok: true, events: [] })));
        if (p === "/api/invoice-verify") return pakai(opsi.verif, () => route.fulfill(json(m === "GET" ? VERIF : { ok: true })));
        return route.fulfill(json({ ok: false, error: `rute tak dimock ${p}` }, 500));
    });
    return log;
}
const tulisKe = (log: Tulis[], p: string, method = "POST") => log.filter((t) => t.path === p && t.method === method);
const getKe = (log: Tulis[], p: string) => log.filter((t) => t.path === p && t.method === "GET");

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}

/**
 * Akun tanpa `order.resolve_unknown` (dan opsional tanpa `order.edit`). Admin LOCAL_AUTH_BYPASS memegang semua kunci, jadi array
 * `permKeys` di payload RSC halaman diganti (hanya di tes) — pola tests/fiori-lapangan-salesman.spec.ts.
 */
async function tanpaIzin(page: Page, kunci: string[]) {
    await page.route((u) => u.pathname === "/antrean-faktur", async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        const body = (await res.text()).replace(/permKeys(\\?)":\[([^\]]*)\]/g, (_, e: string, isi: string) =>
            `permKeys${e}":[${isi.split(",").filter((k) => !kunci.some((x) => k.includes(`"${x}`))).join(",")}]`);
        return route.fulfill({ status: res.status(), headers, body });
    });
}

test.use({
    // Dokumen dari route.fulfill (tanpaIzin) dianggap bukan jaringan lokal oleh Edge → skrip localhost diblokir. Hanya di peramban tes ini.
    launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights"] },
});
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Daftar: kartu = saringan, jawaban Accurate terbaca, mengirim > 15 mnt, galat ≠ kosong, kosong + Kirim nonaktif berlasan, ponsel 390", async ({ page }) => {
    const opsi: Opsi = {};
    const log = await mock(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/antrean-faktur", NAV);
    const main = page.locator("main");
    const tabel = main.getByRole("table", { name: "Antrean" });
    await expect(tabel.getByRole("columnheader", { name: "Jawaban Accurate" })).toBeVisible(NAV);
    // Kalimat, bukan JSON mentah / catatan teknis.
    // Kolom Jawaban Accurate (salinan pop-in tersembunyi di kolom pertama tidak dihitung).
    await expect(tabel.getByRole("cell", { name: "Pelanggan C-B-009 tidak ditemukan", exact: true })).toBeVisible();
    await expect(tabel.getByRole("cell", { name: /^Accurate menolak sesi atau izin \(HTTP 401\)/ })).toBeVisible();
    await expect(tabel).not.toContainText("[\"");
    await expect(tabel.getByText(/lebih dari 15 menit — menjadi Tidak pasti otomatis/)).toBeVisible();
    await expect(tabel.getByRole("cell", { name: /2 jam 14 mnt/ })).toBeVisible();
    // Hanya baris Antre yang bisa dipilih.
    await expect(tabel.getByRole("checkbox", { name: "Pilih SO SO-A-003" })).toBeDisabled();
    await expect(tabel.getByRole("checkbox", { name: "Pilih SO SO-A-002" })).toBeEnabled();
    await expect(main.getByRole("status").filter({ hasText: "3 masalah lewat 2 jam" })).toBeVisible();
    await expect(main.getByRole("table", { name: "Batch belum diantrekan" })).toContainText("ORDER_PRINCIPLE_A_PAGI.xlsx");

    const kartu = main.getByRole("group", { name: "Saring menurut status" });
    await kartu.getByRole("button", { name: /Ditolak/ }).click();
    await expect(kartu.getByRole("button", { name: /Ditolak/ })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => getKe(log, "/api/invoice-outbox").at(-1)?.query).toBe("?state=rejected");
    await kartu.getByRole("button", { name: /Lewat 2 jam/ }).click();
    await expect.poll(() => getKe(log, "/api/invoice-outbox").at(-1)?.query).toBe("?overdue=1");

    // Muat ulang gagal: data lama + strip, Kirim terkunci berlasan (bukan aksi atas data usang).
    opsi.list = (r) => r.fulfill(json({ ok: false, error: "Server antrean tidak menjawab" }, 500));
    await main.getByRole("button", { name: "Muat ulang" }).first().click();
    await expect(main.getByText("Gagal memuat ulang.")).toBeVisible();
    await expect(main.getByText("Kirim nonaktif: Muat ulang dulu: antrean belum terbaru.")).toBeVisible();
    await expect(main.getByRole("button", { name: /^Kirim .*faktur…$/ })).toBeDisabled();

    // Pemuatan pertama gagal: ErrorState, BUKAN "tidak ada faktur".
    await page.goto("/antrean-faktur", NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Antrean gagal dimuat: Server antrean tidak menjawab." })).toBeVisible(NAV);
    await expect(main.getByText("Tidak ada faktur yang menggantung")).toHaveCount(0);
    await expect(main.getByRole("button", { name: /Menggantung/ })).toContainText("gagal dimuat");

    // Kosong: kalimat kosong + Kirim nonaktif dengan alasan.
    opsi.list = (r) => r.fulfill(json(antrean([], { summary: {}, overdue: 0, overdueQueue: 0, overdueBatches: 0, pendingBatches: [] })));
    await page.goto("/antrean-faktur", NAV);
    await expect(main.getByText("Tidak ada faktur yang menggantung")).toBeVisible(NAV);
    await expect(main.getByRole("button", { name: /^Kirim faktur…$/ })).toHaveAttribute("title", "Tidak ada faktur antre");

    opsi.list = undefined;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/antrean-faktur", NAV);
    await expect(main.getByRole("list", { name: "Antrean" })).toContainText("SO-B-002", NAV);
    await expect(main.getByRole("button", { name: "Selesaikan…" }).last()).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/antrean-faktur/ponsel.png", fullPage: true });
});

test("Kirim: dialog dari pratinjau server; yang dikirim = orderIds HASIL PRATINJAU (bukan semua antre); hasil per baris termasuk dilewati", async ({ page }) => {
    const opsi: Opsi = {};
    const log = await mock(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/antrean-faktur", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("table", { name: "Antrean" })).toBeVisible(NAV);

    // Pilihan satu baris → pratinjau menerima orderId itu + tanggal faktur.
    await main.getByRole("checkbox", { name: "Pilih SO SO-A-002" }).check();
    await main.getByLabel("Tanggal faktur").fill(HARI_INI);
    await main.getByRole("button", { name: "Kirim 1 terpilih…" }).click();
    await expect.poll(() => getKe(log, "/api/invoice-outbox/send/preview").at(-1)?.query).toBe(`?orderId=PRINCIPLE-A%3ASO-A-002&invoiceDate=${HARI_INI}`);
    let dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Batal" }).click();
    await main.getByRole("checkbox", { name: "Pilih SO SO-A-002" }).uncheck();
    await main.getByRole("button", { name: "Pakai tanggal SO" }).click();

    // Tanpa pilihan: antrean bertambah SESUDAH pratinjau — yang dikirim tetap daftar pratinjau.
    opsi.send = (r) => r.fulfill(json({
        ok: true, sent: 1, verifiedOk: 1, mismatched: 0, unchecked: 0, rejected: 0, unknown: 0, remaining: 2, sentBy: "admin@contoh",
        results: [{ orderId: "PRINCIPLE-A:SO-A-001", state: "posted", accurateId: "501", number: "INV/A/0001" },
            { orderId: "PRINCIPLE-A:SO-A-002", state: "dilewati", error: "sudah diambil proses lain (status sending) — muat ulang" }],
        verified: [{ orderId: "PRINCIPLE-A:SO-A-001", status: "cocok" }],
    }));
    await main.getByRole("button", { name: "Kirim 2 faktur…" }).click();
    dlg = page.getByRole("dialog", { name: "Kirim 2 faktur ke Accurate?" });
    await expect(dlg).toBeVisible();
    await expect(getKe(log, "/api/invoice-outbox/send/preview").at(-1)?.query).toBe("");
    await expect(dlg).toContainText("DB CABANG A (1001)");
    await expect(dlg).toContainText("Sama dengan tujuan");
    await expect(dlg).toContainText("2 (maks. 50 per tekan)");
    await expect(dlg).toContainText("PRINCIPLE-A · 2 · Rp 222.000");
    await expect(dlg).toContainText("Rp 222.000");
    await expect(dlg).toContainText("tanggal SO masing-masing (09/10/2026)");
    await expect(dlg).toContainText("tidak bisa ditarik");
    opsi.list = (r) => r.fulfill(json(antrean([...ROWS, row("PRINCIPLE-A:SO-A-010", "queued")])));
    await dlg.getByRole("button", { name: "Kirim 2 faktur" }).click();
    await expect(dlg).toBeHidden();
    const kirim = tulisKe(log, "/api/invoice-outbox/send");
    expect(kirim).toHaveLength(1);
    expect(kirim[0].body).toEqual({ orderIds: ["PRINCIPLE-A:SO-A-001", "PRINCIPLE-A:SO-A-002"] });

    const hasil = main.getByRole("region", { name: /Hasil kiriman/ });
    await expect(hasil).toContainText("oleh admin@contoh");
    await expect(hasil).toContainText("1 terposting (1 cocok per baris) · 0 ditolak · 0 tidak pasti · 1 dilewati · 2 masih antre.");
    const perFaktur = hasil.getByRole("list", { name: "Hasil per faktur" });
    await expect(perFaktur.getByRole("listitem").filter({ hasText: "SO-A-001" })).toContainText("INV/A/0001 · cocok per baris");
    await expect(perFaktur.getByRole("listitem").filter({ hasText: "SO-A-002" })).toContainText("Dilewatisudah diambil proses lain");
    await page.screenshot({ path: "test-results/antrean-faktur/hasil-kirim.png", fullPage: true });
});

test("Kirim: pilihan hanya dari baris yang tampil — Cari/principal mengosongkan pilihan; tanpa pilihan dialog menyebut saringan tidak membatasi", async ({ page }) => {
    const log = await mock(page, {});
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/antrean-faktur", NAV);
    const main = page.locator("main");
    await main.getByRole("checkbox", { name: "Pilih SO SO-A-002" }).check(NAV);
    await expect(main.getByRole("button", { name: "Kirim 1 terpilih…" })).toBeVisible();
    // SO-A-002 (TOKO B) tersembunyi oleh Cari: tidak boleh tetap terpilih lalu terkirim tanpa terlihat.
    await main.getByLabel("Cari").first().fill("TOKO A");
    await expect(main.getByRole("button", { name: "Kirim 2 faktur…" })).toBeVisible();
    await main.getByLabel("Cari").first().fill("");
    await expect(main.getByRole("checkbox", { name: "Pilih SO SO-A-002" })).not.toBeChecked();
    await main.getByLabel("Cari").first().fill("TOKO");
    await main.getByRole("button", { name: "Kirim 2 faktur…" }).click();
    const dlg = page.getByRole("dialog", { name: "Kirim 2 faktur ke Accurate?" });
    await expect(dlg).toContainText("Saringan di layar tidak membatasi Kirim");
    expect(getKe(log, "/api/invoice-outbox/send/preview").at(-1)?.query).toBe("");
});

test("Kirim: pratinjau diperiksa ulang tepat sebelum mengirim — berubah = dialog diperbarui, tidak ada yang dikirim", async ({ page }) => {
    let berubah = false;
    const tiga = PRATINJAU({ jumlah: 3, antreanMenunggu: 3, total: { dpp: 300000, ppn: 33000, total: 333000 },
        orders: [order("PRINCIPLE-A:SO-A-001", 111000), order("PRINCIPLE-A:SO-A-002", 111000), order("PRINCIPLE-A:SO-A-010", 111000)] });
    const opsi: Opsi = {
        preview: (r) => r.fulfill(json(berubah ? tiga : PRATINJAU())),
        send: (r) => r.fulfill(json({ ok: true, sent: 0, verifiedOk: 0, mismatched: 0, unchecked: 0, rejected: 0, unknown: 0, remaining: 3, sentBy: "admin@contoh", results: [], verified: [] })),
    };
    const log = await mock(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/antrean-faktur", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Kirim 2 faktur…" }).click(NAV);
    const dlg = page.getByRole("dialog", { name: "Kirim 2 faktur ke Accurate?" });
    await expect(dlg).toContainText("Rp 222.000");
    berubah = true; // antrean berubah selagi dialog terbuka (mis. SO baru diantrekan)
    await dlg.getByRole("button", { name: "Kirim 2 faktur" }).click();
    const baru = page.getByRole("dialog", { name: "Kirim 3 faktur ke Accurate?" });
    await expect(baru.getByRole("alert").filter({ hasText: "Pratinjau berubah" })).toBeVisible();
    await expect(baru).toContainText("Rp 333.000");
    expect(tulisKe(log, "/api/invoice-outbox/send")).toHaveLength(0);
    await baru.getByRole("button", { name: "Kirim 3 faktur" }).click();
    await expect(baru).toBeHidden();
    expect(tulisKe(log, "/api/invoice-outbox/send")[0].body).toEqual({ orderIds: ["PRINCIPLE-A:SO-A-001", "PRINCIPLE-A:SO-A-002", "PRINCIPLE-A:SO-A-010"] });
});

test("Kirim: sesi tidak cocok = nonaktif berlasan; 502 HTML = 'belum pasti' + muat ulang + kunci sampai antrean terbaru", async ({ page }) => {
    const opsi: Opsi = { preview: (r) => r.fulfill(json(PRATINJAU({ ok: false, database: { tujuan: "1001", label: "x", sesiPenekan: { id: "2002", alias: "DB LAIN" }, cocok: false } }))) };
    const log = await mock(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/antrean-faktur", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Kirim 2 faktur…" }).click(NAV);
    let dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("bukan database faktur 1001 — ganti database di API Wrapper");
    await expect(dlg).not.toContainText("ACCURATE_INVOICE_DB_ID");
    await expect(dlg.getByRole("button", { name: "Kirim 2 faktur" })).toBeDisabled();
    await expect(dlg.getByRole("button", { name: "Kirim 2 faktur" })).toHaveAttribute("title", "Sesi Accurate Anda tidak cocok dengan database tujuan");
    await dlg.getByRole("button", { name: "Batal" }).click();

    opsi.preview = undefined;
    opsi.send = (r) => r.fulfill({ status: 502, contentType: "text/html", body: "<html><body><h1>502 Bad Gateway</h1></body></html>" });
    let lepas: () => void = () => {};
    const tahan = new Promise<void>((ok) => { lepas = ok; });
    opsi.list = async (r) => { await tahan; return r.fulfill(json(antrean(ROWS))); };
    const sebelum = getKe(log, "/api/invoice-outbox").length;
    await main.getByRole("button", { name: "Kirim 2 faktur…" }).click();
    dlg = page.getByRole("dialog", { name: "Kirim 2 faktur ke Accurate?" });
    await dlg.getByRole("button", { name: "Kirim 2 faktur" }).click();
    await expect(dlg).toBeHidden();
    const strip = main.getByRole("status").filter({ hasText: "Hasil tindakan terakhir belum pasti." });
    await expect(strip).toContainText("Hasilnya belum pasti");
    await expect(strip).not.toContainText("<html");
    await expect.poll(() => getKe(log, "/api/invoice-outbox").length).toBeGreaterThan(sebelum);
    // Kunci: selama antrean terbaru belum terbaca, Kirim dan tindakan tulis nonaktif.
    await expect(main.getByRole("button", { name: /^Kirim .*faktur…$/ })).toBeDisabled();
    await expect(main.getByText(/Kirim nonaktif: Hasil tindakan terakhir belum pasti/)).toBeVisible();
    lepas();
    await expect(main.getByRole("button", { name: "Kirim 2 faktur…" })).toBeEnabled();
    expect(tulisKe(log, "/api/invoice-outbox/send")).toHaveLength(1);
});

const KETEMU = { ok: true, orderId: "PRINCIPLE-A:SO-A-003", sisaMenit: 0, faktur: { tanggal: "09/10/2026", total: 111000 }, dikirim: { dpp: 100000, ppn: 11000, total: 111000 },
    pencarian: { hasil: "ketemu", sumber: "accurate", cocok: "charField1", id: "9001", number: "INV/A/0009", semua: [{ id: "9001", number: "INV/A/0009" }] } };
const TIDAK = { ok: true, orderId: "PRINCIPLE-A:SO-A-003", sisaMenit: 0, faktur: null, dikirim: { dpp: 100000, ppn: 11000, total: 111000 },
    pencarian: { hasil: "tidak_ketemu_dicek", sumber: "accurate", diperiksa: 4, baris_list_do: 4, calon_tanpa_kunci: [{ id: "9100", number: "INV/A/0100", totalAmount: 50000, transDate: "09/10/2026" }] } };
const ALASAN = "Dicek di Accurate › Faktur Penjualan, pelanggan C-A-001";

test("Selesaikan: hasil pencarian tampil DULU; ketemu → terposting; tidak ketemu + 409 masa tunggu → sisa menit; gagal → tanpa keputusan", async ({ page }) => {
    const opsi: Opsi = { cari: (r) => r.fulfill(json(KETEMU)), selesai: (r) => r.fulfill(json({ ok: true, orderId: "PRINCIPLE-A:SO-A-003", state: "posted", accurateId: "9001", number: "INV/A/0009" })) };
    const log = await mock(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/antrean-faktur", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Selesaikan…" }).click(NAV);
    let dlg = page.getByRole("dialog", { name: "Selesaikan faktur tidak pasti" });
    await expect(dlg).toContainText("Ditemukan langsung di Accurate");
    await expect(dlg).toContainText("INV/A/0009");
    await expect(dlg).toContainText("09/10/2026");
    await expect(dlg).toContainText("Total di AccurateRp 111.000");
    expect(getKe(log, "/api/invoice-outbox/resolve").at(-1)?.query).toBe("?orderId=PRINCIPLE-A%3ASO-A-003");
    await expect(dlg.getByRole("radio", { name: /Tetapkan tidak terposting/ })).toBeDisabled();
    await expect(dlg.getByRole("radiogroup")).toContainText("faktur ditemukan — mengirim ulang akan membuat faktur ganda");
    await expect(dlg.getByRole("radio", { name: /Tetapkan terposting sebagai INV\/A\/0009/ })).toBeChecked();
    await dlg.getByLabel("Alasan").fill("sudah ada");
    await expect(dlg.getByRole("button", { name: "Tetapkan terposting" })).toBeDisabled();
    await dlg.getByLabel("Alasan").fill(ALASAN);
    await dlg.getByRole("button", { name: "Tetapkan terposting" }).click();
    await expect(dlg).toBeHidden();
    expect(tulisKe(log, "/api/invoice-outbox/resolve")[0].body).toEqual({ orderId: "PRINCIPLE-A:SO-A-003", keputusan: "terposting", alasan: ALASAN });
    await expect(main.getByRole("status").filter({ hasText: "ditetapkan terposting sebagai INV/A/0009" })).toBeVisible();

    // Tidak ketemu: calon tanpa kunci tampil; tidak terposting dipilih → server 409 masa tunggu → sisa menit tampil, pilihan terkunci.
    opsi.cari = (r) => r.fulfill(json(TIDAK));
    opsi.selesai = (r) => r.fulfill(json({ ok: false, sisaMenit: 12, error: "Kiriman terakhir baru 3 menit lalu — Accurate mungkin masih menyimpannya; tunggu 12 menit lagi sebelum menetapkan tidak terposting." }, 409));
    await main.getByRole("button", { name: "Selesaikan…" }).click();
    dlg = page.getByRole("dialog", { name: "Selesaikan faktur tidak pasti" });
    await expect(dlg).toContainText("Tidak ditemukan di Accurate");
    await expect(dlg).toContainText("1 faktur pelanggan ini tanpa kunci antrean.");
    await expect(dlg).toContainText("INV/A/0100");
    await expect(dlg.getByRole("radio", { name: /Tetapkan terposting/ })).toBeDisabled();
    await dlg.getByLabel("Alasan").fill(ALASAN);
    await expect(dlg.getByRole("button", { name: "Simpan penyelesaian" })).toHaveAttribute("title", "Pilih hasil dulu"); // belum memilih
    await dlg.getByRole("radio", { name: /Tetapkan tidak terposting/ }).check();
    await dlg.getByRole("button", { name: "Tetapkan tidak terposting" }).click();
    await expect(dlg.getByRole("alert").filter({ hasText: "tunggu 12 menit lagi" })).toBeVisible();
    await expect(dlg.getByRole("radio", { name: /Tetapkan tidak terposting/ })).toBeDisabled();
    await expect(dlg.getByRole("radiogroup")).toContainText("Tersedia 12 menit lagi");
    await expect(dlg.getByLabel("Alasan")).toHaveValue(ALASAN); // isian tidak dikosongkan
    expect(tulisKe(log, "/api/invoice-outbox/resolve").at(-1)?.body).toMatchObject({ keputusan: "tidak_terposting" });
    await page.screenshot({ path: "test-results/antrean-faktur/selesaikan-tunggu.png" });
    await dlg.getByRole("button", { name: "Batal" }).click();

    // Pencarian gagal: alasan tampil, tidak ada keputusan yang bisa disimpan.
    opsi.cari = (r) => r.fulfill(json({ ...TIDAK, pencarian: { hasil: "gagal_cek", alasan: "list.do HTTP 401: sesi habis" } }));
    await main.getByRole("button", { name: "Selesaikan…" }).click();
    dlg = page.getByRole("dialog", { name: "Selesaikan faktur tidak pasti" });
    await expect(dlg).toContainText("Pencarian tidak bisa memastikan. list.do HTTP 401: sesi habis");
    await expect(dlg.getByRole("radio", { name: /Tetapkan terposting/ })).toBeDisabled();
    await expect(dlg.getByRole("radio", { name: /Tetapkan tidak terposting/ })).toBeDisabled();
});

test("Tanpa izin: Selesaikan/Kirim/Buang nonaktif dengan alasan berkalimat (bukan nama kunci mentah)", async ({ page }) => {
    await tanpaIzin(page, ["order.resolve_unknown", "order.edit"]);
    await mock(page, {});
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/antrean-faktur", NAV);
    const main = page.locator("main");
    const selesai = main.getByRole("button", { name: "Selesaikan…" });
    await expect(selesai).toBeDisabled(NAV);
    await expect(selesai).toHaveAttribute("title", /izin Selesaikan posting tidak pasti/);
    await expect(selesai).not.toHaveAttribute("title", /order\./);
    await expect(main.getByRole("button", { name: /^Kirim .*faktur…$/ })).toHaveAttribute("title", "Hanya petugas berizin ubah order yang boleh mengirim faktur ke Accurate");
    await expect(main.getByRole("button", { name: "Buang SO SO-B-002" })).toBeDisabled();
    await expect(main.getByText("Anda hanya bisa melihat antrean.")).toBeVisible();
});

test("Antre ulang menampilkan hasil pencarian server; Buang wajib alasan; Riwayat per order (galat ≠ kosong)", async ({ page }) => {
    const opsi: Opsi = {
        aksi: (r, b) => r.fulfill(json(b?.action === "resend"
            ? { ok: true, orderId: b.orderId, action: "resend", state: "posted", accurateId: "9005", number: "INV/B/0005",
                pencarian: { hasil: "ketemu", sumber: "accurate", cocok: "charField1", id: "9005", number: "INV/B/0005", semua: [] } }
            : { ok: true, orderId: b?.orderId, action: "discard", state: null })),
        riwayat: (r) => r.fulfill(json({ ok: true, events: [
            { id: 1, jenis: "antre", stateFrom: null, stateTo: "queued", actor: "admin@contoh", httpStatus: null, errorCode: "", reason: "", createdAt: menitLalu(140), detail: {} },
            { id: 2, jenis: "kirim", stateFrom: "queued", stateTo: "sending", actor: "fakturist@contoh", httpStatus: null, errorCode: "", reason: "", createdAt: menitLalu(60), detail: { attempt: 1, target_db: "1001", trans_date: "09/10/2026" } },
            { id: 3, jenis: "rejected", stateFrom: "sending", stateTo: "rejected", actor: "fakturist@contoh", httpStatus: 200, errorCode: "", reason: "[\"Harga barang belum ada untuk kategori GROSIR\"]", createdAt: menitLalu(59), detail: {} },
            { id: 4, jenis: "buang", stateFrom: "rejected", stateTo: null, actor: "admin@contoh", httpStatus: null, errorCode: "", reason: "Harga kategori di batch salah", createdAt: menitLalu(1), detail: { attempts: 1 } },
        ] })),
    };
    const log = await mock(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/antrean-faktur", NAV);
    const main = page.locator("main");

    await main.getByRole("button", { name: "Antre ulang…" }).click(NAV);
    let dlg = page.getByRole("dialog", { name: "Antre ulang SO SO-B-002?" });
    await expect(dlg).toContainText("server mencari faktur SO ini di Accurate");
    await expect(dlg).toContainText("Pelanggan C-B-009 tidak ditemukan");
    await dlg.getByRole("button", { name: "Cari lalu antre ulang" }).click();
    await expect(dlg).toBeHidden();
    expect(tulisKe(log, "/api/invoice-outbox")[0].body).toEqual({ orderId: "PRINCIPLE-B:SO-B-002", action: "resend" });
    await expect(main.getByRole("status").filter({ hasText: "Faktur INV/B/0005 sudah ada di Accurate." })).toContainText("tidak dikirim ulang");

    await main.getByRole("button", { name: "Buang SO SO-A-001" }).click();
    dlg = page.getByRole("dialog", { name: "Buang 1 baris dari antrean?" });
    const buang = dlg.getByRole("button", { name: "Buang baris" });
    await expect(buang).toBeDisabled();
    await expect(buang).toHaveAttribute("title", "Isi alasan buang dulu");
    await dlg.getByLabel("Alasan buang").fill("Harga kategori di batch salah");
    await buang.click();
    await expect(dlg).toBeHidden();
    expect(tulisKe(log, "/api/invoice-outbox")[1].body).toEqual({ orderId: "PRINCIPLE-A:SO-A-001", action: "discard", reason: "Harga kategori di batch salah" });
    const strip = main.getByRole("status").filter({ hasText: "SO SO-A-001 dibuang dari antrean." });
    await strip.getByRole("button", { name: "Lihat riwayat" }).click();
    dlg = page.getByRole("dialog", { name: "Riwayat SO SO-A-001" });
    const daftar = dlg.getByRole("list", { name: "Riwayat SO SO-A-001" });
    await expect(daftar).toContainText("Dikirim ke Accurate (percobaan ke-1)");
    await expect(daftar).toContainText("database 1001 · tanggal faktur 09/10/2026");
    await expect(daftar).toContainText("Harga barang belum ada untuk kategori GROSIR");
    await expect(daftar).toContainText("Dibuang dari antrean");
    await expect(daftar).toContainText("Alasan: Harga kategori di batch salah");
    expect(getKe(log, "/api/invoice-outbox/riwayat").at(-1)?.query).toBe("?orderId=PRINCIPLE-A%3ASO-A-001");
    await page.screenshot({ path: "test-results/antrean-faktur/riwayat.png" });
    await dlg.getByRole("button", { name: "Tutup" }).last().click();

    opsi.riwayat = (r) => r.fulfill(json({ ok: false, error: "Riwayat tidak terbaca" }, 500));
    await main.getByRole("button", { name: "Riwayat SO SO-A-003" }).click();
    dlg = page.getByRole("dialog", { name: "Riwayat SO SO-A-003" });
    await expect(dlg.getByRole("alert")).toContainText("Riwayat tidak terbaca");
    await expect(dlg).not.toContainText("Belum ada riwayat");
});

test("Verifikasi balik: selisih terbuka terlihat; Terima sales/Cabut tetap; draf penjelasan; galat terpisah dari antrean", async ({ page }) => {
    const opsi: Opsi = {};
    const log = await mock(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/antrean-faktur", NAV);
    const main = page.locator("main");
    const sek = main.getByRole("region", { name: "Verifikasi balik" });
    await expect(sek).toContainText("salinan faktur Accurate", NAV);
    const r9 = sek.getByRole("article", { name: "Verifikasi SO SO-A-009" });
    await expect(r9).toContainText("2 selisih belum dijelaskan");
    await expect(r9).toContainText("baris 3 · qty: dikirim 24, di Accurate 20");
    await expect(sek.getByRole("article", { name: "Verifikasi SO SO-A-008" })).toHaveCount(0); // cocok hanya bila diminta
    await r9.getByRole("button", { name: "Terima sales di Accurate" }).click();
    await expect.poll(() => tulisKe(log, "/api/invoice-verify").length).toBe(1);
    expect(tulisKe(log, "/api/invoice-verify")[0].body).toEqual({ orderId: "PRINCIPLE-A:SO-A-009", jenis: "sales", sidik: "[\"s\"]", note: "" });
    await r9.getByLabel("Penjelasan selisih isi SO SO-A-009").fill("Koreksi qty saat bongkar: 4 karton rusak");
    await expect(r9).toContainText("Belum disimpan");
    await expect(sek).toContainText("Penjelasan belum disimpan");
    await r9.getByRole("button", { name: "Jelaskan selisih isi" }).click();
    await expect.poll(() => tulisKe(log, "/api/invoice-verify").length).toBe(2);
    expect(tulisKe(log, "/api/invoice-verify")[1].body).toMatchObject({ jenis: "isi", note: "Koreksi qty saat bongkar: 4 karton rusak" });
    await sek.getByLabel("Tampilkan semua").check();
    await expect(sek.getByRole("article", { name: "Verifikasi SO SO-A-008" })).toContainText("Cocok (3 baris)");

    // Penjelasan yang sudah ada bisa dicabut (DELETE).
    opsi.verif = (r) => r.request().method() === "GET"
        ? r.fulfill(json({ ...VERIF, rows: [{ ...VERIF.rows[0], terbuka: 1, penjelasan: { sales: { note: "Sales diganti", by: "admin@contoh", at: menitLalu(5) } } }] }))
        : r.fulfill(json({ ok: true }));
    await sek.getByRole("button", { name: "Muat ulang" }).click();
    await sek.getByRole("button", { name: "Cabut" }).click();
    await expect.poll(() => tulisKe(log, "/api/invoice-verify", "DELETE").length).toBe(1);

    // Galat verifikasi terpisah: antrean tetap tampil, verifikasi menampilkan galat (bukan kosong).
    opsi.verif = (r) => r.fulfill(json({ ok: false, error: "Salinan faktur tidak terbaca" }, 500));
    await page.goto("/antrean-faktur", NAV);
    await expect(sek.getByRole("alert")).toContainText("Salinan faktur tidak terbaca", NAV);
    await expect(sek).not.toContainText("Tidak ada selisih");
    await expect(main.getByRole("table", { name: "Antrean" })).toContainText("SO-A-001");
});
