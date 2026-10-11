/*
 * Tujuan: Fiori S6e-2b wizard Pelunasan — Jenis (Pembayaran pembelian nonaktif beralasan) → Unggah (berkas bukan Pelunasan = kosong beralasan)
 *   → Akun (BG/potongan wajib, penanda ISI_KODE_AKUN_ ditolak, sesi gagal = Tinjau terkunci) → Tinjau (KPI, potensi ganda ditahan, izin
 *   Finance beralasan → kunci override lock, database berubah = Kirim terkunci) → dialog Kirim (database, paket ≤ 100) → Hasil per baris:
 *   sukses + putus di tengah (Tidak pasti, per paket), 409 database_changed (Gagal + sesi dibaca ulang), 409 ACCURATE_HISTORY (Ditahan),
 *   galat kunci menurut GalatKirim.code (403 izin, BLOCKED_KEYS, putus = belum pasti), Selesaikan (pencarian dulu → terposting / tidak_ada
 *   tersimpan; 409 database_unknown / similar_found = pilihan tidak ditawarkan lagi; 502 = belum pasti + cari ulang), tanpa izin = nonaktif
 *   beralasan, daftar Perlu tindakan (?rows=1; galat ≠ kosong; alreadyResolved = muat ulang), Excel atas permintaan, ponsel 390 px, tanpa
 *   dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-pelunasan.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: semua endpoint di-mock page.route per docs/handover/S6e2-KONTRAK-API.md (tidak menyentuh DB/Accurate); berkas xlsx dibuat di tes.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import * as XLSX from "xlsx";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 90_000 } as const;
const SESI = { ok: true, connected: true, databaseConnected: true, sessionHost: "https://contoh.accurate.id", databaseId: "77", databaseAlias: "PT CONTOH" };

type Baris = Record<string, unknown>;
const BARIS: Baris[] = [
    { "Code Outlet": "PELANGGAN-A", "No. Nota": "INV/A/001", Tunai: 100000 },
    { "Code Outlet": "PELANGGAN-B", "No. Nota": "INV/A/002", Trf: 200000, "Ket. Trf": "MAYBANK" },
    { "Code Outlet": "PELANGGAN-C", "No. Nota": "INV/A/003", BG: 300000, "Ket.BG": "BG-001" },
    { "Code Outlet": "PELANGGAN-D", "No. Nota": "INV/A/004", Tunai: 50000, "Pot.1 Kwtnsi": 5000 },
];
/** n baris Tunai berbeda pelanggan (n dokumen sales-receipt) → paket 100. */
const banyak = (n: number): Baris[] => Array.from({ length: n }, (_, i) => ({ "Code Outlet": `PELANGGAN-${i + 1}`, "No. Nota": `INV/B/${String(i + 1).padStart(3, "0")}`, Tunai: 1000 * (i + 1) }));
const berkas = (rows: Baris[], name = "PELUNASAN_09102026.xlsx") => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "PELUNASAN");
    return { name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer };
};

type Body = Record<string, unknown> & { keys?: Array<{ key: string }>; payload?: Baris[]; preview?: boolean };
type Opsi = {
    sesi?: (n: number) => ReturnType<typeof json>;
    blok?: (key: string) => string | undefined;
    lock?: (body: Body) => ReturnType<typeof json> | undefined;
    /** Tulis bulk-save ke-n (mulai 1). "putus" = koneksi diputus. */
    tulis?: (body: Body, n: number) => ReturnType<typeof json> | "putus";
    /** GET pencarian Selesaikan ke-n (mulai 1) untuk `key`. */
    resolve?: (key: string, n: number) => ReturnType<typeof json>;
    /** POST Selesaikan ke-n (mulai 1). "putus" = koneksi diputus. */
    selesai?: (body: Body, n: number) => ReturnType<typeof json> | "putus";
    /** GET /api/idempotency/summary?rows=1 (mengganti bawaan bila mengembalikan jawaban). */
    summary?: (url: URL) => ReturnType<typeof json> | undefined;
    /** Baris ringkasan untuk jawaban bawaan: disaring `database=` + gema `rowsDatabaseId` (kontrak §6). */
    barisRingkasan?: Array<Record<string, unknown>>;
};
type Log = { sesi: number; lock: Body[]; tulis: Body[]; complete: Body[]; resolve: string[]; selesai: Body[]; summary: string[] };

const KOSONG = { ok: true, uncertain: { unknown: 0, sendingStale: 0, total: 0 }, retryable: 0, processingStale: 0, perDatabase: [], rows: [], rowsTruncated: false, staleMinutes: 15 };
/** Baris pencarian Selesaikan (kontrak §4) untuk kunci PAY_<pelanggan>_…; `isi` menimpa bawaan. */
const cari = (key: string, isi: Record<string, unknown> = {}) => json({ ok: true, databaseId: "77", databaseAlias: "PT CONTOH", rows: [{
    key, status: "UNKNOWN", customerNo: key.split("_")[1] ?? "", transDate: "09/10/2026", invoiceNo: "INV/A/001", amount: 100000,
    updatedAt: "2026-10-10T01:00:00.000Z", ageSeconds: 900, eligible: true, found: false, receiptNumbers: [], candidates: [], readError: null, ...isi,
}] });
/** Kandidat §4: pelunasan Accurate yang menyentuh faktur baris (nominal boleh beda). */
const kandidat = (receiptNumber: string, invoiceNo: string, amount: number) => ({ found: true, receiptNumbers: [receiptNumber],
    candidates: [{ receiptNumber, invoiceNos: [invoiceNo], amount, transDate: "09/10/2026", invoices: [{ invoiceNo, paymentAmount: amount, invoicePayment: null }] }] });

async function pasang(page: Page, o: Opsi = {}) {
    const log: Log = { sesi: 0, lock: [], tulis: [], complete: [], resolve: [], selesai: [], summary: [] };
    await page.route((u) => u.pathname === "/api/auth/accurate-session", (r) => r.fulfill(o.sesi ? o.sesi(++log.sesi) : (++log.sesi, json(SESI))));
    await page.route((u) => u.pathname === "/api/idempotency/lock", (r: Route) => {
        const body = r.request().postDataJSON() as Body;
        if (body.preview) {
            const blocked = (body.keys ?? []).map((k) => ({ key: k.key, reason: o.blok?.(k.key) })).filter((e) => e.reason);
            return r.fulfill(json({ ok: true, blockedKeys: blocked.map((b) => b.key), blockedEntries: blocked }));
        }
        log.lock.push(body);
        return r.fulfill(o.lock?.(body) ?? json({ ok: true, lockId: "lock-1", blockedKeys: [], blockedEntries: [] }));
    });
    await page.route((u) => u.pathname === "/api/idempotency/complete", (r) => { log.complete.push(r.request().postDataJSON() as Body); return r.fulfill(json({ ok: true })); });
    await page.route((u) => u.pathname === "/api/idempotency/resolve", (r) => {
        if (r.request().method() === "POST") {
            log.selesai.push(r.request().postDataJSON() as Body);
            const jawab = o.selesai ? o.selesai(log.selesai.at(-1)!, log.selesai.length) : json({ ok: false, error: "tidak di-mock" }, 500);
            return jawab === "putus" ? r.abort("connectionreset") : r.fulfill(jawab);
        }
        log.resolve.push(r.request().url());
        const key = new URL(r.request().url()).searchParams.get("key") ?? "";
        return r.fulfill(o.resolve ? o.resolve(key, log.resolve.filter((u) => u.includes(encodeURIComponent(key))).length) : json({ ok: false }, 500));
    });
    await page.route((u) => u.pathname === "/api/idempotency/summary", (r) => {
        const url = new URL(r.request().url());
        log.summary.push(url.search);
        const db = url.searchParams.get("database");
        const rows = (o.barisRingkasan ?? []).filter((b) => !db || b.databaseId === db);
        return r.fulfill(o.summary?.(url) ?? json({ ...KOSONG, rows, ...(db ? { rowsDatabaseId: db } : {}) }));
    });
    await page.route((u) => u.pathname === "/api/proxy", (r) => {
        const body = r.request().postDataJSON() as Body & { endpointPath: string; method: string; payload: Record<string, unknown> };
        if (body.method === "GET") {
            const p = body.payload ?? {};
            if (body.endpointPath.includes("sales-invoice") && p["filter.number.val"]) {
                return r.fulfill(json({ s: true, d: [{ number: p["filter.number.val"], branch: { id: 1, name: "CABANG A" }, primeOwing: 1e9 }] }));
            }
            return r.fulfill(json({ s: true, d: [], sp: { pageCount: 1 } }));
        }
        log.tulis.push(body);
        const jawab = o.tulis ? o.tulis(body, log.tulis.length) : json({ s: true, d: (body.payload as unknown as Baris[]).map((_, i) => ({ s: true, r: { id: i + 1, number: `PR.2026.10.${String(i + 1).padStart(5, "0")}` } })) });
        return jawab === "putus" ? r.abort("connectionreset") : r.fulfill(jawab);
    });
    return log;
}

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
const footer = (page: Page) => page.locator(".fi-ftb");

/** Jenis → Unggah (berkas) → Akun (BG + Pot.1 bila perlu) → Tinjau. */
async function sampaiTinjau(page: Page, rows: Baris[] = BARIS) {
    await page.goto("/pelunasan", NAV);
    await expect(page.getByText("Database: PT CONTOH (id 77)")).toBeVisible();
    await page.getByRole("button", { name: /Pelunasan penjualan/ }).click();
    await page.getByLabel("Berkas Format Pelunasan").setInputFiles(berkas(rows));
    await expect(page.getByRole("region", { name: "Isi berkas" })).toBeVisible();
    await page.getByRole("button", { name: "Lanjut ke Akun" }).click();
    if (rows.some((r) => r.BG)) await page.getByLabel("Rekening BG").fill("110104");
    if (rows.some((r) => r["Pot.1 Kwtnsi"])) await page.getByLabel("Akun Potongan 1").fill("4102");
    await page.getByRole("button", { name: "Lanjut ke Tinjau" }).click();
    await expect(page.getByRole("region", { name: "Siap kirim" })).toBeVisible({ timeout: 60_000 });
}

test.use({
    // Dokumen dari route.fulfill (tanpaIzin) dianggap bukan jaringan lokal oleh Edge → skrip localhost diblokir. Hanya di peramban tes ini.
    launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights"] },
});
test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Jenis → Unggah → Akun: pembelian nonaktif beralasan, berkas lain kosong beralasan, BG/potongan wajib, penanda akun ditolak", async ({ page }) => {
    await pasang(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/pelunasan", NAV);
    const pembelian = page.getByRole("button", { name: /Pembayaran pembelian/ });
    await expect(pembelian).toBeDisabled();
    await expect(pembelian).toContainText("diposting dari Finance");
    await page.screenshot({ path: "test-results/fiori-pelunasan-1-jenis.png", fullPage: true });
    await page.getByRole("button", { name: /Pelunasan penjualan/ }).click();

    // Berkas bukan Pelunasan = kosong beralasan, Lanjut terkunci.
    await page.getByLabel("Berkas Format Pelunasan").setInputFiles(berkas([{ Nama: "x", Nilai: 1 }], "REKAP_LAIN.xlsx"));
    await expect(page.getByRole("alert").filter({ hasText: "Berkas tidak berisi baris pelunasan." })).toContainText("REKAP_LAIN.xlsx");
    await expect(page.getByRole("button", { name: "Lanjut ke Akun" })).toBeDisabled();
    await expect(footer(page)).toContainText("Berkas tidak berisi baris pelunasan");
    await page.screenshot({ path: "test-results/fiori-pelunasan-2-kosong.png", fullPage: true });

    await page.getByLabel("Berkas Format Pelunasan").setInputFiles(berkas(BARIS));
    const isi = page.getByRole("region", { name: "Isi berkas" });
    await expect(isi).toContainText("Baris dibaca4");
    await expect(isi).toContainText("Berisi BG1");
    await page.getByRole("button", { name: "Lanjut ke Akun" }).click();

    // Draf: rekening BG belum dipilih → Lanjut terkunci dengan alasan TERLIHAT.
    await expect(page.getByText("Wajib: 1 baris berisi BG.")).toBeVisible();
    const lanjut = page.getByRole("button", { name: "Lanjut ke Tinjau" });
    await expect(lanjut).toBeDisabled();
    await expect(footer(page)).toContainText("Lengkapi rekening BG");
    await expect(page.getByLabel("Penomoran")).toHaveValue("Otomatis (AutoNumber Accurate)");
    await page.screenshot({ path: "test-results/fiori-pelunasan-3-akun-draf.png", fullPage: true });
    await page.getByLabel("Rekening BG").fill("110104");
    await page.getByLabel("Akun Potongan 1").fill("ISI_KODE_AKUN_POT1_DI_UI");
    await expect(page.getByText("penanda akun kosong tidak boleh dikirim")).toBeVisible();
    await expect(lanjut).toBeDisabled();
    await page.getByLabel("Akun Potongan 1").fill("4102");
    await expect(lanjut).toBeEnabled();

    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
});

test("Sesi Accurate gagal dibaca: header galat, Tinjau terkunci; database berubah sesudah pratinjau = Kirim terkunci", async ({ page }) => {
    let mode: "galat" | "ok" | "lain" = "galat";
    await pasang(page, { sesi: () => mode === "galat" ? json({ ok: false, error: "Koneksi basis data terputus." }, 500)
        : json(mode === "ok" ? SESI : { ...SESI, databaseId: "88", databaseAlias: "PT LAIN" }) });
    await page.goto("/pelunasan", NAV);
    await expect(page.getByText("Sesi Accurate tidak terbaca").first()).toBeVisible();
    await page.getByRole("button", { name: /Pelunasan penjualan/ }).click();
    await page.getByLabel("Berkas Format Pelunasan").setInputFiles(berkas(BARIS.slice(0, 1)));
    await page.getByRole("button", { name: "Lanjut ke Akun" }).click();
    await expect(page.getByRole("button", { name: "Lanjut ke Tinjau" })).toBeDisabled();
    await expect(footer(page)).toContainText("Sesi Accurate tidak terbaca");
    mode = "ok";
    await page.getByRole("button", { name: "Periksa ulang sesi" }).click();
    await expect(page.getByText("Database: PT CONTOH (id 77)")).toBeVisible();
    await page.getByRole("button", { name: "Lanjut ke Tinjau" }).click();
    await expect(page.getByRole("region", { name: "Siap kirim" })).toBeVisible({ timeout: 60_000 });

    mode = "lain";
    await page.getByRole("button", { name: "Periksa ulang sesi" }).click();
    await expect(page.getByText("Database Accurate berubah sejak pratinjau.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Kirim 1 pelunasan/ })).toBeDisabled();
    await expect(footer(page)).toContainText("Database Accurate berubah sejak pratinjau; ulangi pratinjau.");
    await page.screenshot({ path: "test-results/fiori-pelunasan-4-db-berubah.png", fullPage: true });
});

test("Tinjau → izin Finance → Kirim 2 paket: paket 1 terposting, paket 2 putus = Tidak pasti; Selesaikan menampilkan pencarian dulu", async ({ page }) => {
    const rows = [...banyak(150), BARIS[0], { "Code Outlet": "", "No. Nota": "INV/C/001", Tunai: 1000 }];
    const log = await pasang(page, {
        blok: (key) => (key.includes("PELANGGAN-A_") ? "UNKNOWN_OUTCOME" : undefined),
        tulis: (body, n) => (n === 2 ? "putus" : json({ s: true, d: (body.payload as Baris[]).map((_, i) => ({ s: true, r: { id: i + 1, number: `PR.2026.10.${String(i + 1).padStart(5, "0")}` } })) })),
        resolve: (key) => cari(key, { invoiceNo: "INV/B/101", amount: 101000, ...kandidat("PR.2026.10.00120", "INV/B/101", 101000) }),
        // Server putaran 2: tanpa acceptSimilar → 409 similar_not_identical (identitas server bisa beda dari tampilan nominal).
        selesai: (body) => (body.acceptSimilar ? json({ ok: true, status: "SUCCESS", resolutionId: "res-1", receiptNumbers: [body.accurateNumber] })
            : json({ ok: false, code: "similar_not_identical", error: "Pelunasan PR.2026.10.00120 tidak identik dengan baris ini (potongan berbeda).",
                ...kandidat("PR.2026.10.00120", "INV/B/101", 96000), selected: { receiptNumber: "PR.2026.10.00120", invoiceNos: ["INV/B/101"], amount: 96000 },
                rowAmount: 101000, candidateAmount: 96000, difference: 5000, hint: "takeover" }, 409)),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await sampaiTinjau(page, rows);

    const kpi = page.getByLabel("Ringkasan tinjauan");
    await expect(kpi).toContainText("Dibaca152");
    await expect(kpi).toContainText("Dilewati1");
    await expect(page.getByRole("region", { name: "Dilewati saat dibaca" })).toContainText("Baris 152: Code Outlet kosong");
    await expect(kpi).toContainText("Siap kirim150");
    await expect(kpi).toContainText("Potensi ganda1");
    const ganda = page.getByRole("region", { name: "Potensi ganda" });
    await expect(ganda).toContainText("Kiriman sebelumnya belum pasti");
    await expect(ganda.getByRole("button", { name: "Izinkan yang dicentang…" })).toBeDisabled();
    await page.screenshot({ path: "test-results/fiori-pelunasan-5-tinjau.png", fullPage: true });

    // Izin Finance: dialog alasan ≥ 15, baris ikut dikirim dengan override lock.
    await expect(ganda).toContainText("= kirim ulang terkendali (takeover Finance, tercatat dengan alasan)");
    await ganda.getByRole("checkbox", { name: "Pilih INV/A/001" }).check();
    await ganda.getByRole("button", { name: "Izinkan yang dicentang…" }).click();
    const izinDlg = page.getByRole("dialog", { name: "Kirim ulang terkendali 1 baris?" });
    await expect(izinDlg).toContainText("Kirim ulang terkendali (takeover) untuk 1 baris");
    await izinDlg.getByLabel("Alasan mengizinkan").fill("terlalu pendek");
    await expect(izinDlg.getByRole("button", { name: "Izinkan 1 baris" })).toBeDisabled();
    await expect(izinDlg).toContainText("minimal 15 karakter");
    await izinDlg.getByLabel("Alasan mengizinkan").fill("Pelunasan kedua untuk cicilan; dikonfirmasi dengan outlet");
    await izinDlg.getByRole("button", { name: "Izinkan 1 baris" }).click();
    await expect(ganda).toContainText("Diizinkan Finance");
    await expect(kpi).toContainText("Siap kirim151");

    await page.getByRole("button", { name: "Kirim 151 pelunasan…" }).click();
    const kirim = page.getByRole("dialog", { name: "Kirim 151 pelunasan ke Accurate?" });
    await expect(kirim).toContainText("PT CONTOH (id 77) · sama dengan sesi Anda");
    await expect(kirim).toContainText("151 dalam 2 paket (maks. 100 per paket)");
    await expect(kirim).toContainText("1 baris (1 kirim ulang terkendali) · alasan: Pelunasan kedua untuk cicilan");
    await page.screenshot({ path: "test-results/fiori-pelunasan-6-dialog-kirim.png", fullPage: true });
    // Klik ganda tidak mengirim dua kali.
    await kirim.getByRole("button", { name: "Kirim 151 pelunasan" }).dblclick();

    await expect(page.getByLabel("Ringkasan hasil")).toBeVisible({ timeout: 60_000 });
    expect(log.lock).toHaveLength(1);
    expect(log.lock[0].allowLockedKeys).toEqual([expect.stringContaining("PELANGGAN-A_")]);
    expect(log.lock[0].overrideReason).toBe("Pelunasan kedua untuk cicilan; dikonfirmasi dengan outlet");
    expect(log.tulis).toHaveLength(2);
    expect(log.tulis.map((t) => (t.payload as unknown[]).length)).toEqual([100, 51]);
    for (const t of log.tulis) { expect(t.expectedDatabaseId).toBe("77"); expect(t.idempotencyLockId).toBe("lock-1"); }

    const hasil = page.getByLabel("Ringkasan hasil");
    await expect(hasil).toContainText("Terposting100");
    await expect(hasil).toContainText("Tidak pasti51");
    await expect(page.getByText("51 baris tidak pasti (paket 2).")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-pelunasan-7-hasil.png", fullPage: true });

    // Excel hanya atas permintaan.
    const unduh = page.waitForEvent("download");
    await page.getByRole("button", { name: "Laporan per baris (Excel)" }).click();
    expect((await unduh).suggestedFilename()).toMatch(/^Hasil_Pelunasan_.*_WITA\.xlsx$/);

    // Selesaikan: hasil pencarian tampil DULU; simpan terkunci sampai keputusan + tempat periksa + alasan lengkap; tersimpan → baris Terposting.
    await page.getByRole("button", { name: /^Selesaikan INV\/B\/101/ }).click();
    const sel = page.getByRole("dialog", { name: "Selesaikan pelunasan tidak pasti" });
    const cariHasil = sel.getByRole("status", { name: "Hasil pencarian" });
    await expect(cariHasil).toContainText("Ada 1 pelunasan di Accurate yang menyentuh faktur ini");
    await expect(cariHasil).not.toContainText("sama persis");
    await expect(sel.getByRole("list", { name: "Pelunasan yang menyentuh faktur ini" })).toContainText("PR.2026.10.00120 · 09/10/2026 · faktur INV/B/101 · Rp 101.000 (nominal sama dengan baris)");
    expect(log.resolve[0]).toContain("key=PAY_PELANGGAN-101");
    await expect(sel.getByRole("radio", { name: /Tetapkan tidak ada/ })).toBeDisabled();
    await expect(sel).toContainText("bandingkan nominalnya");
    const simpan = sel.getByRole("button", { name: "Tetapkan terposting" });
    await expect(simpan).toBeDisabled();
    await sel.getByRole("textbox", { name: "Alasan", exact: true }).fill("Dicek di Accurate, pelunasan terbentuk dan nilainya cocok.");
    await expect(sel).toContainText("Pilih hasil pemeriksaan dulu");
    await sel.getByRole("radio", { name: /Tetapkan terposting sebagai PR.2026.10.00120/ }).check();
    await expect(simpan).toBeDisabled();
    await expect(sel).toContainText("Isi tempat Anda memeriksa");
    await sel.getByLabel("Diperiksa di").fill("Accurate › Penerimaan Penjualan, PELANGGAN-101 09/10/2026");
    await page.screenshot({ path: "test-results/fiori-pelunasan-8-selesaikan.png", fullPage: true });
    await simpan.click();
    await expect(sel.getByRole("alert")).toContainText("tidak identik dengan baris ini (potongan berbeda)");
    await expect(sel).toContainText("Pelunasan PR.2026.10.00120 Rp 96.000 ≠ baris ini Rp 101.000 (selisih Rp 5.000) — bisa jadi cicilan lain.");
    await expect(sel).toContainText("kirim ulang terkendali — unggah ulang baris ini lewat Pelunasan baru");
    await expect(sel).toContainText("Izinkan yang dicentang…");
    await expect(sel).not.toContainText("Akun Anda tidak berhak mengizinkannya");
    await expect(simpan).toBeDisabled();
    await expect(sel.locator("footer .fi-why")).toContainText("Centang konfirmasi selisih nominal dulu");
    await sel.getByRole("checkbox", { name: /adalah kiriman baris ini/ }).check();
    await simpan.click();
    await expect(sel).toBeHidden();
    expect(log.selesai).toHaveLength(2);
    expect(log.selesai[0].acceptSimilar).toBeUndefined();
    expect(log.selesai[1]).toEqual({ key: expect.stringContaining("PAY_PELANGGAN-101_"), decision: "terposting", accurateNumber: "PR.2026.10.00120",
        reason: "Dicek di Accurate, pelunasan terbentuk dan nilainya cocok.", checkedSource: "Accurate › Penerimaan Penjualan, PELANGGAN-101 09/10/2026", expectedDatabaseId: "77",
        acceptSimilar: true });
    await expect(page.getByText("Status baris diperbarui.")).toBeVisible();
    await expect(hasil).toContainText("Terposting101");
    await expect(hasil).toContainText("Tidak pasti50");
    await expect(page.getByRole("table", { name: "Hasil per baris" })).toContainText("Diselesaikan: terposting PR.2026.10.00120");

    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-pelunasan-9-hasil-ponsel.png", fullPage: true });
});

test("409 database_changed = Gagal tidak terkirim + sesi dibaca ulang; 409 ACCURATE_HISTORY = Ditahan lalu sisa paket dikirim", async ({ page }) => {
    let kasus: "db" | "dbRagu" | "riwayat" = "db";
    const log = await pasang(page, {
        tulis: (body, n) => {
            if (kasus === "db") return json({ error: "Database Accurate berubah.", code: "database_changed", sent: false, databaseId: "88", databaseAlias: "PT LAIN" }, 409);
            // Tanpa sent:false: server tidak menjamin tidak terkirim → Tidak pasti (kontrak §7), sebabnya tetap dijelaskan.
            if (kasus === "dbRagu") return json({ error: "Database Accurate berubah.", code: "database_changed" }, 409);
            const rows = body.payload as Baris[];
            if (rows.length === 4) return json({ error: "1 baris ditahan", code: "ACCURATE_HISTORY", sent: false, rows: [{ index: 2, key: "PAY_x", reason: "ACCURATE_HISTORY", receiptNumbers: ["PR.2026.10.00012"] }] }, 409);
            return json({ s: true, d: rows.map((_, i) => ({ s: true, r: { id: n * 10 + i, number: `PR.2026.10.0${n}${i}` } })) });
        },
    });
    await sampaiTinjau(page);
    const sesiSebelum = log.sesi;
    await page.getByRole("button", { name: "Kirim 4 pelunasan…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim 4 pelunasan" }).click();
    await expect(page.getByText("Database Accurate berubah saat mengirim.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel("Ringkasan hasil")).toContainText("Gagal4");
    await expect(page.getByLabel("Ringkasan hasil")).toContainText("Terposting0");
    await expect.poll(() => log.sesi).toBeGreaterThan(sesiSebelum + 1); // dibaca ulang sebelum kirim + sesudah 409
    expect(log.complete.some((c) => c.status === "FAILED")).toBe(true);
    await page.screenshot({ path: "test-results/fiori-pelunasan-10-db-changed.png", fullPage: true });

    kasus = "dbRagu";
    await page.getByRole("button", { name: "Pelunasan baru" }).click();
    await page.getByLabel("Berkas Format Pelunasan").setInputFiles(berkas(BARIS));
    await page.getByRole("button", { name: "Lanjut ke Akun" }).click();
    await page.getByLabel("Rekening BG").fill("110104");
    await page.getByLabel("Akun Potongan 1").fill("4102");
    await page.getByRole("button", { name: "Lanjut ke Tinjau" }).click();
    await page.getByRole("button", { name: "Kirim 4 pelunasan…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim 4 pelunasan" }).click();
    await expect(page.getByText("Database Accurate berubah saat mengirim — hasilnya belum pasti.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel("Ringkasan hasil")).toContainText("Tidak pasti4");
    await expect(page.getByLabel("Ringkasan hasil")).toContainText("Gagal0");
    await expect(page.getByText("Database Accurate berubah saat mengirim.")).toHaveCount(0);

    kasus = "riwayat";
    await page.getByRole("button", { name: "Pelunasan baru" }).click();
    await page.getByLabel("Berkas Format Pelunasan").setInputFiles(berkas(BARIS));
    await page.getByRole("button", { name: "Lanjut ke Akun" }).click();
    await page.getByLabel("Rekening BG").fill("110104");
    await page.getByLabel("Akun Potongan 1").fill("4102");
    await page.getByRole("button", { name: "Lanjut ke Tinjau" }).click();
    await page.getByRole("button", { name: "Kirim 4 pelunasan…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim 4 pelunasan" }).click();
    const hasil = page.getByLabel("Ringkasan hasil");
    await expect(hasil).toContainText("Ditahan1", { timeout: 60_000 });
    await expect(hasil).toContainText("Terposting3");
    await expect(page.getByRole("table", { name: "Hasil per baris" })).toContainText("PR.2026.10.00012");
});

test("Galat kunci menurut code: 403 PERMISSION_REQUIRED dengan teks server tanpa nama kunci = kalimat izin; tidak ada yang dikirim", async ({ page }) => {
    // Teks server sengaja tidak menyebut kunci izin: kalimat UI harus dari `code`, bukan dari mencocokkan teks.
    let jawabKunci = json({ error: "Ditolak.", code: "PERMISSION_REQUIRED" }, 403);
    const log = await pasang(page, { lock: () => jawabKunci });
    await sampaiTinjau(page);
    await page.getByRole("button", { name: "Kirim 4 pelunasan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Kirim 4 pelunasan ke Accurate?" });
    await dlg.getByRole("button", { name: "Kirim 4 pelunasan" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Tidak ada yang dikirim ke Accurate.");
    await expect(dlg.getByRole("alert")).toContainText("belum berhak mengirim pelunasan");
    await expect(dlg).not.toContainText("pelunasan.kirim");
    expect(log.tulis).toHaveLength(0);
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(page.getByRole("region", { name: "Siap kirim" })).toBeVisible();

    // 400 KEY_IDENTITY_MISMATCH (kontrak §2): ditolak sebelum menulis; kalimat dari code.
    jawabKunci = json({ ok: false, error: "x", code: "KEY_IDENTITY_MISMATCH" }, 400);
    await page.getByRole("button", { name: "Kirim 4 pelunasan…" }).click();
    await dlg.getByRole("button", { name: "Kirim 4 pelunasan" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Kunci baris tidak cocok dengan pelanggan dan tanggalnya");
    await expect(dlg.getByRole("alert")).toContainText("Tidak ada yang dikirim ke Accurate.");
    expect(log.tulis).toHaveLength(0);
});

test("Galat kunci tak pasti (putus) dan BLOCKED_KEYS: belum pasti/usang, Kirim terkunci dengan alasan, ulangi pratinjau membuka lagi", async ({ page }) => {
    let mode: "putus" | "blok" | "ok" = "putus";
    const log = await pasang(page, { lock: () => (mode === "blok" ? json({ ok: true, lockId: "lock-2", blockedKeys: ["PAY_x"], blockedEntries: [] }) : undefined) });
    await page.route((u) => u.pathname === "/api/idempotency/lock", async (r) => {
        const body = r.request().postDataJSON() as Body;
        if (!body.preview && mode === "putus") { log.lock.push(body); return r.abort("connectionreset"); }
        return r.fallback();
    });
    await sampaiTinjau(page);
    const kirim = page.getByRole("button", { name: "Kirim 4 pelunasan…" });
    await kirim.click();
    const dlg = page.getByRole("dialog", { name: "Kirim 4 pelunasan ke Accurate?" });
    await dlg.getByRole("button", { name: "Kirim 4 pelunasan" }).click();
    await expect(dlg.getByRole("alert")).toContainText("hasilnya belum pasti");
    await expect(dlg.getByRole("alert")).toContainText("Tidak ada yang dikirim ke Accurate.");
    await expect(dlg.getByRole("button", { name: "Kirim 4 pelunasan" })).toBeDisabled();
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(page.getByText("Pratinjau usang.")).toBeVisible();
    await expect(kirim).toBeDisabled();
    await expect(footer(page)).toContainText("Ulangi pratinjau sebelum mengirim.");
    await page.screenshot({ path: "test-results/fiori-pelunasan-12-kunci-ragu.png", fullPage: true });

    mode = "blok";
    await page.getByRole("button", { name: "Ulangi pratinjau" }).click();
    await expect(kirim).toBeEnabled({ timeout: 60_000 });
    await kirim.click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim 4 pelunasan" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Status ganda berubah sejak pratinjau.");
    await page.getByRole("dialog").getByRole("button", { name: "Batal" }).click();
    await expect(kirim).toBeDisabled();
    await expect(footer(page)).toContainText("Status ganda berubah sejak pratinjau; ulangi pratinjau.");
    expect(log.tulis).toHaveLength(0);
    expect(log.lock).toHaveLength(2);
});

/** Kirim 4 baris; proxy putus → semua Tidak pasti (paket 1). */
async function sampaiHasilRagu(page: Page) {
    await sampaiTinjau(page);
    await page.getByRole("button", { name: "Kirim 4 pelunasan…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim 4 pelunasan" }).click();
    await expect(page.getByLabel("Ringkasan hasil")).toContainText("Tidak pasti4", { timeout: 60_000 });
}

test("Selesaikan tidak_ada: 409 database_unknown = pilihan ditutup; 502 = belum pasti + cari ulang; similar_found → terposting kandidat", async ({ page }) => {
    // Keadaan server tiruan (bukan hitungan GET: dev StrictMode memanggil pencarian dua kali saat dialog dibuka).
    let tersimpanB = false;
    let miripC = false;
    const log = await pasang(page, {
        tulis: () => "putus",
        resolve: (key) => {
            if (key.includes("PELANGGAN-A_")) return cari(key);
            if (key.includes("PELANGGAN-B_")) return cari(key, tersimpanB ? { status: "FAILED", eligible: false } : { invoiceNo: "INV/A/002", amount: 200000 });
            if (key.includes("PELANGGAN-C_")) return cari(key, { invoiceNo: "INV/A/003", amount: 300000,
                ...(miripC ? kandidat("PR.2026.10.00077", "INV/A/003", 250000) : {}) });
            return cari(key, { invoiceNo: "INV/A/004", amount: 50000 });
        },
        selesai: (body) => {
            const key = String(body.key);
            if (key.includes("PELANGGAN-A_")) return json({ ok: false, code: "database_unknown", error: "Database Accurate kiriman ini tidak tercatat (baris sebelum pembaruan)." }, 409);
            if (key.includes("PELANGGAN-B_")) { tersimpanB = true; return json({ error: "Bad gateway" }, 502); }
            if (key.includes("PELANGGAN-C_") && body.decision === "tidak_ada") {
                miripC = true;
                return json({ ok: false, code: "similar_found", error: "Ada pelunasan PR.2026.10.00077 yang menyentuh faktur INV/A/003.",
                    ...kandidat("PR.2026.10.00077", "INV/A/003", 250000), hint: "takeover" }, 409);
            }
            if (key.includes("PELANGGAN-C_")) return json({ ok: true, status: "SUCCESS", resolutionId: "res-c", receiptNumbers: ["PR.2026.10.00077"] });
            return json({ ok: true, status: "FAILED", resolutionId: "res-d", receiptNumbers: [] });
        },
    });
    await sampaiHasilRagu(page);
    const hasil = page.getByLabel("Ringkasan hasil");
    const sel = page.getByRole("dialog", { name: "Selesaikan pelunasan tidak pasti" });
    const isi = async (keputusan: RegExp) => {
        await sel.getByRole("radio", { name: keputusan }).check();
        await sel.getByLabel("Diperiksa di").fill("Accurate › Penerimaan Penjualan, pelanggan dan tanggal sama");
        await sel.getByRole("textbox", { name: "Alasan", exact: true }).fill("Tidak ada pelunasan untuk faktur ini di Accurate.");
    };

    // A: server menolak tidak_ada (database_unknown) → pesan + "Tidak ada yang diubah"; pilihan itu tidak ditawarkan lagi.
    await page.getByRole("button", { name: /^Selesaikan INV\/A\/001/ }).click();
    await expect(sel.getByRole("status", { name: "Hasil pencarian" })).toContainText("Tidak ada pelunasan di Accurate yang menyentuh faktur ini");
    await expect(sel.getByRole("radio", { name: /Tetapkan terposting/ })).toBeDisabled();
    await isi(/Tetapkan tidak ada/);
    await sel.getByRole("button", { name: "Tetapkan tidak ada" }).click();
    await expect(sel.getByRole("alert")).toContainText("Database Accurate kiriman ini tidak tercatat");
    await expect(sel.getByRole("alert")).toContainText("Tidak ada yang diubah.");
    await expect(sel.getByRole("radio", { name: /Tetapkan tidak ada/ })).toBeDisabled();
    await expect(sel.getByRole("radio", { name: /Tetapkan tidak ada/ }).locator("xpath=..")).toContainText("Tidak tersedia: Database Accurate kiriman ini tidak tercatat");
    await page.screenshot({ path: "test-results/fiori-pelunasan-13-selesaikan-ditolak.png", fullPage: true });
    await sel.getByRole("button", { name: "Batal" }).click();
    await expect(hasil).toContainText("Tidak pasti4");

    // B: 502 = hasilnya belum pasti → pencarian diulang (simpan terkunci selama itu); server kini FAILED → baris Gagal saat ditutup.
    await page.getByRole("button", { name: /^Selesaikan INV\/A\/002/ }).click();
    await isi(/Tetapkan tidak ada/);
    const cariSebelum = log.resolve.length;
    await sel.getByRole("button", { name: "Tetapkan tidak ada" }).click();
    await expect(sel.getByRole("alert")).toContainText("hasilnya belum pasti");
    await expect.poll(() => log.resolve.length).toBe(cariSebelum + 1);
    await expect(sel).toContainText("sudah tercatat tidak terkirim di server");
    await expect(sel.getByRole("button", { name: "Tetapkan terposting" })).toBeDisabled();
    await sel.getByRole("button", { name: "Batal" }).click();
    await expect(hasil).toContainText("Gagal1");
    await expect(hasil).toContainText("Tidak pasti3");

    // C: 409 similar_found → cari ulang menampilkan kandidat; tidak_ada ditutup; terposting dengan nomor kandidat tersimpan.
    await page.getByRole("button", { name: /^Selesaikan INV\/A\/003/ }).click();
    await isi(/Tetapkan tidak ada/);
    await sel.getByRole("button", { name: "Tetapkan tidak ada" }).click();
    await expect(sel.getByRole("alert")).toContainText("menyentuh faktur INV/A/003");
    await expect(sel.getByRole("alert")).toContainText("Bila baris ini cicilan yang BELUM terkirim, jangan diselesaikan di sini");
    await expect(sel.getByRole("list", { name: "Pelunasan yang menyentuh faktur ini" })).toContainText("PR.2026.10.00077 · 09/10/2026 · faktur INV/A/003 · Rp 250.000 (baris Rp 300.000)");
    await expect(sel.getByRole("radio", { name: /Tetapkan tidak ada/ })).toBeDisabled();
    await sel.getByRole("radio", { name: /Tetapkan terposting sebagai PR.2026.10.00077/ }).check();
    // Nominal kandidat ≠ baris: selisih jelas + jalan lain + konfirmasi wajib (acceptSimilar).
    await expect(sel).toContainText("Pelunasan PR.2026.10.00077 Rp 250.000 ≠ baris ini Rp 300.000 — bisa jadi cicilan lain.");
    await expect(sel.getByRole("button", { name: "Tetapkan terposting" })).toBeDisabled();
    await sel.getByRole("checkbox", { name: /PR.2026.10.00077 adalah kiriman baris ini/ }).check();
    await sel.getByRole("button", { name: "Tetapkan terposting" }).click();
    await expect(sel).toBeHidden();
    expect(log.selesai.at(-1)).toMatchObject({ decision: "terposting", accurateNumber: "PR.2026.10.00077", expectedDatabaseId: "77", acceptSimilar: true });

    // D: tidak_ada tersimpan → Gagal, boleh dikirim ulang.
    await page.getByRole("button", { name: /^Selesaikan INV\/A\/004/ }).click();
    await isi(/Tetapkan tidak ada/);
    await sel.getByRole("button", { name: "Tetapkan tidak ada" }).click();
    await expect(sel).toBeHidden();
    await expect(page.getByText("ditetapkan tidak ada di Accurate")).toBeVisible();
    await expect(hasil).toContainText("Terposting1");
    await expect(hasil).toContainText("Gagal2");
    await expect(hasil).toContainText("Tidak pasti1");
    expect(log.selesai.map((b) => b.decision)).toEqual(["tidak_ada", "tidak_ada", "tidak_ada", "terposting", "tidak_ada"]);
    await page.screenshot({ path: "test-results/fiori-pelunasan-14-hasil-diselesaikan.png", fullPage: true });
});

/** Ganti permKeys di payload RSC halaman /pelunasan (hanya di tes): buang kunci izin tertentu. */
async function tanpaIzin(page: Page, buang: string[]) {
    await page.route((u) => u.pathname === "/pelunasan", async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        const body = (await res.text()).replace(/permKeys(\\?)":\[([^\]]*)\]/g, (_, e: string, isi: string) =>
            `permKeys${e}":[${isi.split(",").filter((k) => !buang.some((x) => k.includes(`"${x}`))).join(",")}]`);
        return route.fulfill({ status: res.status(), headers, body });
    });
}

const BARIS_RAGU = { key: "PAY_PELANGGAN-Z_x", status: "UNKNOWN", customerNo: "PELANGGAN-Z", transDate: "08/10/2026", invoiceNo: "INV/Z/009", amount: 90000,
    databaseId: null, updatedAt: "2026-10-09T02:00:00.000Z", category: "uncertain" };

test("Tanpa izin Selesaikan: tombol di daftar dan di Hasil terkunci dengan alasan terlihat; server tidak dipanggil", async ({ page }) => {
    await tanpaIzin(page, ["finance.resolve_unknown"]);
    const log = await pasang(page, { tulis: () => "putus", barisRingkasan: [{ ...BARIS_RAGU, databaseId: "77" }] });
    await page.goto("/pelunasan", NAV);
    const daftar = page.getByRole("region", { name: "Perlu tindakan" });
    await expect(daftar.getByRole("button", { name: /^Selesaikan INV\/Z\/009/ })).toBeDisabled();
    await expect(daftar).toContainText("Selesaikan nonaktif: Hanya Finance");
    await page.getByRole("button", { name: /Pelunasan penjualan/ }).click();
    await page.getByLabel("Berkas Format Pelunasan").setInputFiles(berkas(BARIS));
    await page.getByRole("button", { name: "Lanjut ke Akun" }).click();
    await page.getByLabel("Rekening BG").fill("110104");
    await page.getByLabel("Akun Potongan 1").fill("4102");
    await page.getByRole("button", { name: "Lanjut ke Tinjau" }).click();
    await page.getByRole("button", { name: "Kirim 4 pelunasan…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim 4 pelunasan" }).click();
    await expect(page.getByLabel("Ringkasan hasil")).toContainText("Tidak pasti4", { timeout: 60_000 });
    await expect(page.getByRole("button", { name: /^Selesaikan INV\/A\/001/ })).toBeDisabled();
    await expect(page.getByRole("region", { name: "Hasil per baris" })).toContainText("Selesaikan nonaktif: Hanya Finance yang dapat menyelesaikan baris tidak pasti.");
    await expect(page.locator("main")).not.toContainText("finance.resolve_unknown");
    expect(log.resolve).toHaveLength(0);
    expect(log.selesai).toHaveLength(0);
    await page.screenshot({ path: "test-results/fiori-pelunasan-15-tanpa-izin-selesaikan.png", fullPage: true });
});

test("Daftar Perlu tindakan: galat ≠ kosong; baris lama tanpa database tidak menawarkan tidak_ada; kunci macet → alreadyResolved = muat ulang", async ({ page }) => {
    // Finance tanpa izin mengizinkan baris ganda: arah kirim ulang terkendali menyebut harus Finance yang berhak.
    await tanpaIzin(page, ["finance.override_duplicate"]);
    let mode: "galat" | "tanpaGema" | "ok" = "galat";
    const log = await pasang(page, {
        barisRingkasan: [
            BARIS_RAGU,
            { ...BARIS_RAGU, key: "PAY_PELANGGAN-Y_x", customerNo: "PELANGGAN-Y", invoiceNo: "INV/Y/001", databaseId: "77", status: "PROCESSING", category: "processingStale" },
            { ...BARIS_RAGU, key: "PAY_PELANGGAN-X_x", customerNo: "PELANGGAN-X", invoiceNo: "INV/X/001", databaseId: "88", status: "FAILED", category: "retryable" },
        ],
        summary: (url) => (mode === "galat" ? json({ ok: false, code: "x", error: "Ringkasan pelunasan gagal dibaca." }, 500)
            : mode === "tanpaGema" ? json({ ...KOSONG, rows: [] }) : url.searchParams.get("database") ? undefined : json({ ...KOSONG, rowsTruncated: true, rows: [
                BARIS_RAGU,
                { ...BARIS_RAGU, key: "PAY_PELANGGAN-Y_x", customerNo: "PELANGGAN-Y", invoiceNo: "INV/Y/001", databaseId: "77", status: "PROCESSING", category: "processingStale" },
                { ...BARIS_RAGU, key: "PAY_PELANGGAN-X_x", customerNo: "PELANGGAN-X", invoiceNo: "INV/X/001", databaseId: "88", status: "FAILED", category: "retryable" },
            ] })),
        resolve: (key) => (key.includes("PELANGGAN-Z_") ? cari(key, { invoiceNo: "INV/Z/009", amount: 90000 })
            : cari(key, { invoiceNo: "INV/Y/001", amount: 90000, status: "PROCESSING", ...kandidat("PR.2026.10.00009", "INV/Y/001", 80000) })),
        selesai: (_, n) => (n === 1 ? json({ ok: false, code: "forbidden", error: "Selesaikan pelunasan butuh izin." }, 403)
            : json({ ok: true, alreadyResolved: true, status: "SUCCESS", receiptNumbers: ["PR.2026.10.00009"] })),
    });
    await page.goto("/pelunasan", NAV);
    const daftar = page.getByRole("region", { name: "Perlu tindakan" });
    await expect(daftar.getByRole("alert")).toContainText("Daftar pelunasan gagal dimuat.");
    await expect(daftar).not.toContainText("Tidak ada pelunasan yang tidak pasti");
    // Bawaan = database aktif sesi: permintaan menyaring database=77; jawaban tanpa gema rowsDatabaseId = galat, bukan daftar kosong.
    expect(log.summary.every((q) => q.includes("database=77"))).toBe(true);
    mode = "tanpaGema";
    await daftar.getByRole("button", { name: "Coba lagi" }).click();
    await expect(daftar.getByRole("alert")).toContainText("Server tidak menyaring ke database yang diminta.");
    mode = "ok";
    await daftar.getByRole("button", { name: "Coba lagi" }).click();
    const tabel = daftar.getByRole("table", { name: "Perlu tindakan" });
    await expect(tabel).toContainText("INV/Y/001");
    await expect(tabel).not.toContainText("INV/Z/009");
    await daftar.getByLabel("Tampilkan").selectOption("semua");
    await expect(tabel).toContainText("INV/Z/009");
    expect(log.summary.at(-1)).not.toContain("database=");
    await expect(tabel).toContainText("tidak tercatat (kiriman sebelum pembaruan)");
    await expect(tabel).toContainText("PT CONTOH (id 77) · database aktif");
    await expect(tabel).toContainText("Tidak pasti · kunci macet");
    await expect(tabel).toContainText("Unggah ulang lewat wizard");
    await expect(daftar.getByRole("button", { name: /^Selesaikan INV\/Y\/001/ })).toBeEnabled();
    await expect(daftar).toContainText("Daftar dipotong: 200 baris terbaru ditampilkan.");
    await page.screenshot({ path: "test-results/fiori-pelunasan-16-daftar.png", fullPage: true });

    // Baris lama tanpa database tercatat: tidak ditemukan di database ini ≠ tidak ada — "tidak ada" tidak ditawarkan (data server).
    await daftar.getByRole("button", { name: /^Selesaikan INV\/Z\/009/ }).click();
    const sel = page.getByRole("dialog", { name: "Selesaikan pelunasan tidak pasti" });
    await expect(sel.getByRole("status", { name: "Hasil pencarian" })).toContainText("Tidak ada pelunasan di Accurate yang menyentuh faktur ini");
    await expect(sel.getByRole("radio", { name: /Tetapkan tidak ada/ })).toBeDisabled();
    await expect(sel).toContainText("Tidak tersedia: Database kiriman tidak tercatat");
    await sel.getByRole("button", { name: "Batal" }).click();
    expect(log.selesai).toHaveLength(0);

    // Kunci macet (PROCESSING basi) menyentuh faktur → terposting. 403 forbidden = simpan terkunci dengan alasan (tanpa suruhan menekan
    // ulang); dialog baru → server menjawab alreadyResolved (Finance lain lebih dulu) → daftar dimuat ulang.
    const isiY = async () => {
        await daftar.getByRole("button", { name: /^Selesaikan INV\/Y\/001/ }).click();
        await expect(sel.getByRole("status", { name: "Hasil pencarian" })).toContainText("Ada 1 pelunasan di Accurate yang menyentuh faktur ini");
        await expect(sel.getByRole("radio", { name: /Tetapkan tidak ada/ })).toBeDisabled();
        await sel.getByRole("radio", { name: /Tetapkan terposting sebagai PR.2026.10.00009/ }).check();
        await expect(sel).toContainText("Pelunasan PR.2026.10.00009 Rp 80.000 ≠ baris ini Rp 90.000 — bisa jadi cicilan lain.");
        await expect(sel).toContainText("Akun Anda tidak berhak mengizinkannya; minta Finance yang berhak mengizinkan baris ganda.");
        await sel.getByRole("checkbox", { name: /PR.2026.10.00009 adalah kiriman baris ini/ }).check();
        await sel.getByLabel("Diperiksa di").fill("Accurate › Penerimaan Penjualan, PELANGGAN-Y 08/10/2026");
        await sel.getByRole("textbox", { name: "Alasan", exact: true }).fill("Pelunasan terbentuk di Accurate, nilai dan faktur cocok.");
    };
    await isiY();
    await sel.getByRole("button", { name: "Tetapkan terposting" }).click();
    await expect(sel.getByRole("alert")).toContainText("Server menolak: akun Anda tidak (lagi) berhak menyelesaikan");
    await expect(sel.getByRole("button", { name: "Tetapkan terposting" })).toBeDisabled();
    await expect(sel.locator("footer .fi-why")).toContainText("minta admin menambahkan izinnya");
    await sel.getByRole("button", { name: "Batal" }).click();
    await isiY();
    const sebelum = log.summary.length;
    await sel.getByRole("button", { name: "Tetapkan terposting" }).click();
    await expect(sel).toBeHidden();
    await expect(daftar).toContainText("sudah diselesaikan sebelumnya (oleh Anda atau Finance lain)");
    await expect.poll(() => log.summary.length).toBeGreaterThan(sebelum);
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
});

test("Tanpa izin: Kirim/Izinkan nonaktif dengan alasan terlihat, tanpa nama kunci mentah", async ({ page }) => {
    // Akun tanpa izin kirim/Finance: permKeys di payload RSC diganti (hanya di tes).
    await tanpaIzin(page, ["pelunasan.kirim", "finance.override_duplicate", "finance.resolve_unknown"]);
    await pasang(page, { blok: (key) => (key.includes("PELANGGAN-A_") ? "ALREADY_SUCCESS" : undefined) });
    await sampaiTinjau(page);
    await expect(page.getByRole("button", { name: /^Kirim 3 pelunasan/ })).toBeDisabled();
    await expect(footer(page)).toContainText("belum berhak mengirim pelunasan");
    const ganda = page.getByRole("region", { name: "Potensi ganda" });
    await expect(ganda.getByRole("button", { name: "Izinkan yang dicentang…" })).toBeDisabled();
    await expect(ganda).toContainText("Izinkan nonaktif: Hanya Finance");
    await expect(ganda.getByRole("checkbox")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("pelunasan.kirim");
    await page.screenshot({ path: "test-results/fiori-pelunasan-11-tanpa-izin.png", fullPage: true });
});

// ── Susulan S6e (tinjauan UI 2b) ──────────────────────────────────────────────────────────────────────

test("Susulan 2b #3: baris terposting membawa nomor dari jawaban Accurate; Excel memisah Nomor Accurate dan Nomor mirip", async ({ page }) => {
    await pasang(page);
    await sampaiTinjau(page);
    await page.getByRole("button", { name: "Kirim 4 pelunasan…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim 4 pelunasan" }).click();
    await expect(page.getByLabel("Ringkasan hasil")).toContainText("Terposting4", { timeout: 60_000 });
    await expect(page.getByRole("table", { name: "Hasil per baris" })).toContainText("Terposting · PR.2026.10.00001 · paket 1");
    const unduh = page.waitForEvent("download");
    await page.getByRole("button", { name: "Laporan per baris (Excel)" }).click();
    const wb = XLSX.readFile(await (await unduh).path());
    const isi = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    expect(isi.map((r) => r["Nomor Accurate"]).sort()).toEqual(["PR.2026.10.00001", "PR.2026.10.00002", "PR.2026.10.00003", "PR.2026.10.00004"]);
    expect(isi.every((r) => r["Nomor mirip"] === "")).toBe(true);
});

test("Susulan 2b #1: server sudah SUCCESS saat dicari = Terposting tanpa nomor kandidat; nomor lihat jejak penyelesaian", async ({ page }) => {
    await pasang(page, {
        tulis: () => "putus",
        resolve: (key) => cari(key, { status: "SUCCESS", eligible: false, ...kandidat("PR.2026.10.00055", "INV/A/001", 100000) }),
    });
    await sampaiHasilRagu(page);
    await page.getByRole("button", { name: /^Selesaikan INV\/A\/001/ }).click();
    const sel = page.getByRole("dialog", { name: "Selesaikan pelunasan tidak pasti" });
    await expect(sel).toContainText("sudah tercatat terposting di server; nomor pelunasan Accurate lihat jejak penyelesaian.");
    await sel.getByRole("button", { name: "Batal" }).click();
    await expect(page.getByLabel("Ringkasan hasil")).toContainText("Terposting1");
    const tabel = page.getByRole("table", { name: "Hasil per baris" });
    await expect(tabel).toContainText("Diselesaikan: terposting — nomor pelunasan Accurate lihat jejak penyelesaian");
    await expect(tabel).not.toContainText("PR.2026.10.00055");
});

test("Susulan 2b #2/#8: POST Selesaikan 500 berbadan kosong = belum pasti + cari ulang; GET pencarian 403 = alasan izin tanpa Coba lagi", async ({ page }) => {
    const log = await pasang(page, {
        tulis: () => "putus",
        resolve: (key) => (key.includes("PELANGGAN-B_") ? json({ ok: false, code: "forbidden", error: "Selesaikan pelunasan butuh izin finance.resolve_unknown." }, 403) : cari(key)),
        selesai: () => ({ status: 500, contentType: "application/json", body: "" }),
    });
    await sampaiHasilRagu(page);
    const sel = page.getByRole("dialog", { name: "Selesaikan pelunasan tidak pasti" });

    // #2: 500 tanpa `code` (badan kosong) = hasilnya belum pasti, BUKAN "Tidak ada yang diubah"; pencarian dimuat ulang.
    await page.getByRole("button", { name: /^Selesaikan INV\/A\/001/ }).click();
    await sel.getByRole("radio", { name: /Tetapkan tidak ada/ }).check();
    await sel.getByLabel("Diperiksa di").fill("Accurate › Penerimaan Penjualan, pelanggan dan tanggal sama");
    await sel.getByRole("textbox", { name: "Alasan", exact: true }).fill("Tidak ada pelunasan untuk faktur ini di Accurate.");
    const cariSebelum = log.resolve.length;
    await sel.getByRole("button", { name: "Tetapkan tidak ada" }).click();
    await expect(sel.getByRole("alert")).toContainText("hasilnya belum pasti");
    await expect(sel.getByRole("alert")).not.toContainText("Tidak ada yang diubah");
    await expect.poll(() => log.resolve.length).toBeGreaterThan(cariSebelum);
    await sel.getByRole("button", { name: "Batal" }).click();

    // #8: pencarian 403 (izin dicabut sesudah halaman dibuka) = alasan izin; tidak menawarkan Coba lagi / Cari lagi.
    await page.getByRole("button", { name: /^Selesaikan INV\/A\/002/ }).click();
    await expect(sel.getByRole("alert")).toContainText("Server menolak: akun Anda tidak (lagi) berhak menyelesaikan baris tidak pasti");
    await expect(sel.getByRole("button", { name: "Coba lagi" })).toHaveCount(0);
    await expect(sel.getByRole("button", { name: "Cari lagi" })).toHaveCount(0);
    await sel.getByRole("textbox", { name: "Alasan", exact: true }).fill("Tidak ada pelunasan untuk faktur ini di Accurate.");
    await expect(sel.locator("footer .fi-why")).toContainText("Server menolak");
});
