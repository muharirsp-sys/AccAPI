/*
 * Tujuan: Fiori S6a putaran tinjauan — pratinjau basi tidak dipasangkan dengan berkas lain, total pengajuan dibaca ulang dari server,
 *   lompatan besar nomor SPPD wajib diketik ulang, dan perilaku tahan-galat (≥ 500 = belum pasti, 200 tanpa data = galat, 404 tanpa
 *   penolakan server = galat, kunci operasi Format SPPD di tingkat halaman, tanggal bayar lampau, alasan nonaktif dialog terlihat,
 *   403 diulang sekali dengan token baru).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-pembayaran-tinjauan.spec.ts --config <config lokal> --workers=1`.
 * Dependensi: FastAPI (dev: http://localhost:8000) di-mock dengan page.route; header CORS memantulkan Origin halaman (port bebas).
 * Side Effects: Tidak ada.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const NAV = { timeout: 60_000 } as const;
const cors = (r: Route) => ({
    "access-control-allow-origin": r.request().headers()["origin"] ?? "*", "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, OPTIONS",
});
const json = (r: Route, body: unknown, status = 200) => r.fulfill({ status, headers: { ...cors(r), "content-type": "application/json" }, body: JSON.stringify(body) });
const tunda = (ms: number) => new Promise((res) => setTimeout(res, ms));
const berkas = (name: string) => ({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(name) });
const namaBerkas = (r: Route) => r.request().postDataBuffer()?.toString("latin1").match(/filename="([^"]+)"/)?.[1] ?? "";
const hariIni = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
const tahun = hariIni().slice(0, 4);

const LENGKAP = { tipe_pengajuan: "LPB", tgl_invoice: "2026-10-06", jt_invoice: "2026-11-05", status_pembayaran: "", locked_reason: "" };
const REKAMAN = [{ ...LENGKAP, record_id: "LPB-A-001", no_lpb: "LPB-A-001", principle: "PRINCIPLE A", invoice_no: "INV-A-1", nilai_invoice: "12.400.000", nilai_win: 12_400_000, updated_at: "u1" }];
const SETELAN = { last_sequence: 31, sequence_year: Number(tahun), number_template: "{seq:03d}/SPA/PDSB/{roman_month}/{year}", fixed_jaminan_date: "2026-02-19", maturity_months: 6, items_per_page: 7 };
const CART = { ok: true, method: "NON_PANIN", method_label: "Non Panin", target_payment_date: "2026-10-12", items: [
    { no: 1, group_key: "PRINCIPLE A||LPB", principle: "PRINCIPLE A", tipe_pengajuan: "LPB", total: 31_350_000, invoice_concat: "INV-A-1, INV-A-2", potongan: 0, nilai_pembayaran: 31_350_000, jenis_pembayaran: "", keterangan: "" },
] };
type Kirim = { path: string; search: string; body: unknown };

/** Mock FastAPI; `ganti` mengembalikan "lewat" untuk jawaban bawaan. */
async function mock(page: Page, ganti: (p: string, r: Route) => Promise<unknown> | unknown = () => "lewat") {
    const kirim: Kirim[] = [];
    let me = 0;
    await page.route((u) => u.host === "localhost:8000", async (r) => {
        if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors(r) });
        const url = new URL(r.request().url());
        if (r.request().method() === "POST") {
            const ct = r.request().headers()["content-type"] ?? "";
            kirim.push({ path: url.pathname, search: url.search, body: ct.includes("json") ? r.request().postDataJSON() : namaBerkas(r) });
        }
        if (url.pathname === "/api/me") { me += 1; return json(r, { ok: true, csrf_token: `t${me}` }); }
        if ((await ganti(url.pathname, r)) !== "lewat") return;
        if (url.pathname === "/payments/data") return json(r, { ok: true, data: REKAMAN });
        if (url.pathname === "/payments/sppd/settings") return json(r, { ok: true, settings: SETELAN, effective_last_sequence: 31, preview_number: "032/SPA/PDSB/X/2026" });
        if (url.pathname === "/api/bank-data") return json(r, { ok: true, items: [{ principle: "PT PRINCIPLE A", bank: "BANK A", rekening: "0213", penerima: "PT PRINCIPLE A", has_rekening: true }] });
        if (url.pathname === "/api/bank-data/match-report") return json(r, { ok: true, report: { matched: [], unmatched: [], ambiguous: [], empty_rekening: [] } });
        return json(r, { ok: true });
    });
    return { kirim, me: () => me };
}

// ── Butir 1: pratinjau basi ──
test("Unggah LPB: pratinjau berkas LAMA yang datang terlambat tidak dipasangkan dengan berkas BARU", async ({ page }) => {
    const { kirim } = await mock(page, async (p, r) => {
        if (p !== "/payments/upload") return "lewat";
        if (namaBerkas(r) === "LAMA.xlsx") { await tunda(4_000); return json(r, { ok: true, dry_run: true, can_apply: true, rows: 5, total_nilai_win: 5, total_nilai_invoice: 5, duplicates: [], duplicates_in_file: [], invalid: [] }); }
        return json(r, { ok: true, dry_run: true, can_apply: false, rows: 2, total_nilai_win: 2, total_nilai_invoice: 2, duplicates: [], duplicates_in_file: ["LPB-X"], invalid: [], error: "No. LPB LPB-X ganda di berkas, gagal upload" });
    });
    await page.goto("/payments", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("table", { name: "Rekaman" }).getByText("LPB-A-001")).toBeVisible(NAV);
    await main.getByRole("button", { name: "Unggah LPB" }).click();
    const dlg = page.getByRole("dialog");
    const input = dlg.getByLabel("Berkas LPB (.xlsx/.xls)");
    await input.setInputFiles(berkas("LAMA.xlsx"));
    await input.setInputFiles(berkas("BARU.xlsx"));
    await expect(dlg.getByText("No. LPB LPB-X ganda di berkas, gagal upload")).toBeVisible();
    await tunda(5_000); // jawaban pratinjau LAMA tiba sesudahnya
    await expect(dlg.getByText("No. LPB LPB-X ganda di berkas, gagal upload")).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Simpan 5 LPB" })).toHaveCount(0);
    await expect(dlg.getByRole("button", { name: /^Simpan/ })).toBeDisabled();
    expect(kirim.filter((k) => k.path === "/payments/upload").map((k) => k.search)).toEqual(["?dry_run=1", "?dry_run=1"]);
});

test("Excel SPPD: pratinjau berkas LAMA yang terlambat tidak mengaktifkan Terapkan untuk berkas BARU", async ({ page }) => {
    const { kirim } = await mock(page, async (p, r) => {
        if (p !== "/payments/sppd/upload") return "lewat";
        if (namaBerkas(r) === "LAMA.xlsx") { await tunda(4_000); return json(r, { ok: true, dry_run: true, can_apply: true, updated: 3, unchanged: 0, changes: [], locked: [], not_found: [], errors: [], blocked_columns: [] }); }
        return json(r, { ok: true, dry_run: true, can_apply: false, updated: 1, unchanged: 0, changes: [], locked: [{ record_id: "LPB-B-7", no_lpb: "LPB-B-7", reason: "sudah ditransfer" }], not_found: [], errors: [], blocked_columns: [] });
    });
    await page.goto("/payments/sppd", NAV);
    const main = page.locator("main");
    await expect(main.getByLabel("Nomor surat terakhir")).toHaveValue("31", NAV);
    await main.getByRole("button", { name: "Unggah Excel data SPPD…" }).click();
    const dlg = page.getByRole("dialog");
    const input = dlg.getByLabel("Berkas Excel data SPPD (.xlsx/.xls)");
    await input.setInputFiles(berkas("LAMA.xlsx"));
    await input.setInputFiles(berkas("BARU.xlsx"));
    await expect(dlg.getByText("LPB-B-7 (sudah ditransfer)")).toBeVisible();
    await tunda(5_000);
    await expect(dlg.getByText("LPB-B-7 (sudah ditransfer)")).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Terapkan 3 perubahan" })).toHaveCount(0);
    expect(kirim.filter((k) => k.path === "/payments/sppd/upload").map((k) => k.search)).toEqual(["?dry_run=1", "?dry_run=1"]);
});

// ── Butir 2: total sesudah Ajukan dibaca ulang dari server ──
test("Keranjang: sesudah Ajukan, nilai bayar dibaca ulang dari server dan beda dengan tampilan diperingatkan", async ({ page }) => {
    await mock(page, (p, r) => {
        if (p === "/payments/cart-info") return json(r, CART);
        if (p === "/payments/cart/submit") return json(r, { ok: true, submission_id: "c41e0d27", files: [] });
        if (p === "/payments/submissions/c41e0d27") return json(r, { ok: true, data: { id: "c41e0d27", total_pembayaran: 30_000_000, records: [], files: [], cart_items: {} } });
        return "lewat";
    });
    await page.goto("/payments/cart/7f3c91ab", NAV);
    const main = page.locator("main");
    await main.getByLabel("Jenis pembayaran PRINCIPLE A").selectOption("TRF", NAV);
    await main.getByLabel("Potongan PRINCIPLE A").fill("900.000");
    await main.getByRole("button", { name: "Ajukan ke Finance…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Ajukan ke Finance" }).click();
    await expect(main.getByText("Pengajuan c41e0d27 dibuat.")).toBeVisible();
    await expect(main.getByText("Nilai bayar tercatat di server: Rp 30.000.000")).toBeVisible();
    await expect(main.getByText("berbeda dari Rp 30.450.000 yang tampil sebelum Ajukan", { exact: false })).toBeVisible();
});

// ── Butir 3: lompatan besar nomor SPPD wajib diketik ulang ──
test("Format SPPD: lompatan nomor > 50 wajib diketik ulang di dialog sebelum Simpan", async ({ page }) => {
    const { kirim } = await mock(page, (p, r) => {
        if (p === "/payments/sppd/settings" && r.request().method() === "POST") return json(r, { ok: true, settings: { ...SETELAN, last_sequence: 310 }, effective_last_sequence: 310, preview_number: "311/SPA/PDSB/X/2026" });
        return "lewat";
    });
    await page.goto("/payments/sppd", NAV);
    const main = page.locator("main");
    await main.getByLabel("Nomor surat terakhir").fill("310", NAV);
    await main.getByRole("button", { name: "Simpan…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByText("Nomor naik 279 sekaligus", { exact: false })).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Simpan", exact: true })).toBeDisabled();
    await expect(dlg.getByText("Ketik ulang nomor 310 untuk melanjutkan.")).toBeVisible(); // alasan nonaktif terlihat (butir 4f)
    await dlg.getByLabel("Ketik ulang nomor surat terakhir").fill("301");
    await expect(dlg.getByRole("button", { name: "Simpan", exact: true })).toBeDisabled();
    await dlg.getByLabel("Ketik ulang nomor surat terakhir").fill("310");
    await dlg.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(main.getByText("Format SPPD tersimpan.")).toBeVisible();
    expect(kirim.filter((k) => k.path === "/payments/sppd/settings")[0].body).toMatchObject({ last_sequence: 310, expected_last_sequence: 31 });
});

test("Format SPPD: lompatan kecil (≤ 50) tidak meminta ketik ulang", async ({ page }) => {
    await mock(page);
    await page.goto("/payments/sppd", NAV);
    const main = page.locator("main");
    await main.getByLabel("Nomor surat terakhir").fill("40", NAV);
    await main.getByRole("button", { name: "Simpan…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByLabel("Ketik ulang nomor surat terakhir")).toHaveCount(0);
    await expect(dlg.getByRole("button", { name: "Simpan", exact: true })).toBeEnabled();
});
