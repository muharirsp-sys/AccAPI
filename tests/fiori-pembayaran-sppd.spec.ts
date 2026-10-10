/*
 * Tujuan: Fiori S6a Format SPPD (it08) — setelan gagal dimuat = Simpan terkunci (AM-019), nomor SPPD tidak boleh turun (D-05, validasi
 *   layar), Simpan hanya mengirim nomor bila diubah (+ expected_last_sequence), Restore backup pratinjau → pulihkan, ganti nama
 *   principal pratinjau → terapkan (terkunci dilewati, mapping Finance), Excel SPPD dengan baris terkunci tidak bisa diterapkan,
 *   master rekening kosong = EmptyState.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-pembayaran-sppd.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: FastAPI (dev: http://localhost:8000) di-mock dengan page.route + CORS/OPTIONS 204 + /api/me csrf.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const NAV = { timeout: 60_000 } as const;
const CORS = { "access-control-allow-origin": "http://localhost:3012", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (r: Route, body: unknown, status = 200) => r.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
const html = (r: Route, status = 500) => r.fulfill({ status, headers: { ...CORS, "content-type": "text/html" }, body: "<html>Internal Server Error</html>" });
const tahun = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date()).slice(0, 4);

const SETELAN = { last_sequence: 31, sequence_year: Number(tahun), number_template: "{seq:03d}/SPA/PDSB/{roman_month}/{year}", fixed_jaminan_date: "2026-02-19", maturity_months: 6, items_per_page: 7, updated_by: "betterauth|admin|admin.a@contoh.test" };
const BANK = [{ principle: "PT PRINCIPLE A", bank: "BANK A", rekening: "0213000000", penerima: "PT PRINCIPLE A", has_rekening: true }];
const LAPORAN = { matched: [{ web_name: "PRINCIPLE A", excel_name: "PT PRINCIPLE A", bank: "BANK A", rekening: "0213000000", penerima: "PT PRINCIPLE A" }], unmatched: ["PRINCIPLE C"], ambiguous: [], empty_rekening: [] };
type Kirim = { path: string; search: string; body: unknown };

async function mock(page: Page, ganti: (p: string, r: Route) => Promise<void> | void | "lewat" = () => "lewat") {
    const kirim: Kirim[] = [];
    await page.route((u) => u.host === "localhost:8000", async (r) => {
        if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
        const url = new URL(r.request().url());
        if (r.request().method() === "POST") {
            const ct = r.request().headers()["content-type"] ?? "";
            kirim.push({ path: url.pathname, search: url.search, body: ct.includes("json") ? r.request().postDataJSON() : "berkas" });
        }
        if (url.pathname === "/api/me") return json(r, { ok: true, csrf_token: "t" });
        if ((await ganti(url.pathname, r)) !== "lewat") return;
        if (url.pathname === "/payments/sppd/settings") return json(r, { ok: true, settings: SETELAN, next_sequence: 32, effective_last_sequence: 31, preview_number: "032/SPA/PDSB/X/2026" });
        if (url.pathname === "/api/bank-data") return json(r, { ok: true, items: BANK });
        if (url.pathname === "/api/bank-data/match-report") return json(r, { ok: true, report: LAPORAN });
        return json(r, { ok: true });
    });
    return kirim;
}

test("Format SPPD: gagal muat = Simpan terkunci; nomor tidak boleh turun; Simpan mengirim nomor hanya bila diubah", async ({ page }) => {
    let rusak = true;
    const kirim = await mock(page, (p, r) => {
        if (p === "/payments/sppd/settings" && r.request().method() === "GET" && rusak) return html(r);
        if (p === "/payments/sppd/settings" && r.request().method() === "POST") {
            const b = r.request().postDataJSON() as { maturity_months: number; last_sequence?: number };
            return json(r, { ok: true, settings: { ...SETELAN, maturity_months: b.maturity_months, last_sequence: b.last_sequence ?? 31 }, preview_number: b.last_sequence ? `0${b.last_sequence + 1}/SPA/PDSB/X/2026` : "032/SPA/PDSB/X/2026" });
        }
        return "lewat";
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/payments/sppd", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Format SPPD Bank Panin" })).toBeVisible(NAV);
    await expect(main.getByText("Setelan SPPD gagal dimuat")).toBeVisible(NAV);
    await expect(main.locator(".fi-ftb")).toContainText("Setelan SPPD belum berhasil dimuat — muat ulang dulu agar urutan nomor tidak mundur.");
    await expect(main.getByRole("button", { name: "Simpan…" })).toBeDisabled();
    await expect(main.getByLabel("Nomor surat terakhir")).toHaveCount(0); // nilai bawaan tidak ditampilkan sebagai nilai tersimpan

    rusak = false;
    await main.getByRole("button", { name: "Coba lagi" }).click();
    const nomor = main.getByLabel("Nomor surat terakhir");
    await expect(nomor).toHaveValue("31");
    await expect(main.locator(".fi-attrs")).toContainText("032/SPA/PDSB/X/2026");

    await nomor.fill("28");
    await expect(main.getByText(`Nomor urut SPPD tidak boleh turun di dalam satu tahun: nomor terakhir ${tahun} adalah 031.`, { exact: false })).toBeVisible();
    await expect(main.locator(".fi-ftb")).toContainText("Perbaiki isian yang ditandai dulu.");
    await expect(main.getByRole("button", { name: "Simpan…" })).toBeDisabled();
    await page.screenshot({ path: "test-results/s6a-format-turun.png", fullPage: true });

    await nomor.fill("31");
    await main.getByLabel("Jatuh tempo bank (bulan)").fill("25");
    await expect(main.getByText("Jatuh tempo bank 1–24 bulan.")).toBeVisible();
    await main.getByLabel("Jatuh tempo bank (bulan)").fill("9");
    await main.getByRole("button", { name: "Simpan…" }).click();
    let dlg = page.getByRole("dialog");
    await expect(dlg.getByText("6 → 9")).toBeVisible();
    await dlg.getByRole("button", { name: "Simpan" }).click();
    await expect(main.getByText("Format SPPD tersimpan.")).toBeVisible();
    await expect(main.getByText("Jatuh tempo bank (bulan) 6 → 9", { exact: false })).toBeVisible();
    const pertama = kirim.filter((k) => k.path === "/payments/sppd/settings")[0].body as Record<string, unknown>;
    expect(pertama).toEqual({ number_template: SETELAN.number_template, fixed_jaminan_date: "2026-02-19", maturity_months: 9, items_per_page: 7 });

    await nomor.fill("35");
    await expect(main.locator(".fi-attrs")).toContainText(/036\/SPA\/PDSB\/[IVX]+\//); // pratinjau lokal dari templat
    await main.getByRole("button", { name: "Simpan…" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByText("Nomor 032–035 tidak akan terbit.")).toBeVisible();
    await dlg.getByRole("button", { name: "Simpan" }).click();
    await expect(main.getByText("Nomor surat terakhir 31 → 35", { exact: false })).toBeVisible();
    const kedua = kirim.filter((k) => k.path === "/payments/sppd/settings")[1].body as Record<string, unknown>;
    expect(kedua).toMatchObject({ last_sequence: 35, expected_last_sequence: 31 });
});

test("Format SPPD: restore backup pratinjau → pulihkan (nomor naik); ganti nama pratinjau → terapkan; Excel dengan baris terkunci tidak bisa diterapkan", async ({ page }) => {
    const kirim = await mock(page, (p, r) => {
        const dry = new URL(r.request().url()).searchParams.get("dry_run");
        if (p === "/payments/sppd/restore-backup") return dry === "1"
            ? json(r, { ok: true, dry_run: true, can_apply: true, records: 3, submissions: 1, new_submissions: 1, draft_records: 1, sppd: { year: 2026, last_sequence_before: 30, max_restored: 45, last_sequence_after: 45, next_number: "046/SPA/PDSB/X/2026" }, conflicts: [] })
            : json(r, { ok: true, dry_run: false, mode: "restore_backup", added: 3, sppd: { last_sequence_before: 30, last_sequence_after: 45, next_number: "046/SPA/PDSB/X/2026" } });
        if (p === "/api/bank-data/replace-principle-name") {
            const b = r.request().postDataJSON() as { dry_run: number };
            return json(r, { ok: true, dry_run: b.dry_run === 1, matched: 2, replaced: 1, locked_skipped: 1, locked: [{ record_id: "LPB-B-007", reason: "sudah ditransfer" }], per_status: { Draf: 1, "Sudah Transfer": 1 }, finance_mapping: { old_name_has_mapping: true, new_name_has_mapping: false, needs_remap: true }, samples: ["LPB-C-1"] });
        }
        if (p === "/payments/sppd/upload") return json(r, { ok: true, dry_run: true, can_apply: false, updated: 1, unchanged: 0, changes: [{ record_id: "LPB-B-007", no_lpb: "LPB-B-007", principle: "PRINCIPLE B", fields: [{ field: "nilai_invoice", old: 1000, new: 1500 }] }], locked: [{ record_id: "LPB-B-007", no_lpb: "LPB-B-007", reason: "sudah ditransfer" }], not_found: [], errors: [], blocked_columns: ["AJUKAN"] });
        return "lewat";
    });
    await page.goto("/payments/sppd", NAV);
    const main = page.locator("main");
    await expect(main.getByLabel("Nomor surat terakhir")).toHaveValue("31", NAV);

    await main.getByRole("button", { name: "Restore backup…" }).click();
    let dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("button", { name: "Pulihkan" })).toBeDisabled();
    await dlg.getByLabel("Berkas backup PAYMENTS (.xlsx)").setInputFiles({ name: "backup_payments.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });
    await expect(dlg.getByText("terakhir 30 → 45 (tertinggi di berkas 45); berikutnya 046/SPA/PDSB/X/2026 — tidak pernah turun")).toBeVisible();
    expect(kirim.filter((k) => k.path === "/payments/sppd/restore-backup").map((k) => k.search)).toEqual(["?dry_run=1"]);
    await dlg.getByRole("button", { name: "Pulihkan 3 rekaman" }).click();
    await expect(main.getByText("Restore backup berhasil: 3 rekaman ditambahkan.")).toBeVisible();
    expect(kirim.filter((k) => k.path === "/payments/sppd/restore-backup").map((k) => k.search)).toEqual(["?dry_run=1", "?dry_run=0"]);

    await main.getByRole("button", { name: "Samakan nama…" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByLabel("Nama lama (di rekaman)")).toHaveValue("PRINCIPLE C");
    await dlg.getByLabel("Nama baru (sesuai master rekening)").fill("PT PRINCIPLE C");
    await expect(dlg.getByRole("button", { name: "Terapkan" })).toBeDisabled();
    await dlg.getByRole("button", { name: "Pratinjau" }).click();
    await expect(dlg.getByText("1 rekaman terkunci (diajukan/ditransfer/terposting)")).toBeVisible();
    await expect(dlg.getByText("tersimpan dengan nama lama; atur ulang di Finance setelah ini")).toBeVisible();
    await dlg.getByRole("button", { name: "Terapkan ke 1 rekaman" }).click();
    await expect(main.getByText("1 rekaman diganti dari “PRINCIPLE C” menjadi “PT PRINCIPLE C”.")).toBeVisible();
    const ganti = kirim.filter((k) => k.path === "/api/bank-data/replace-principle-name").map((k) => k.body);
    expect(ganti).toEqual([{ old_name: "PRINCIPLE C", new_name: "PT PRINCIPLE C", dry_run: 1 }, { old_name: "PRINCIPLE C", new_name: "PT PRINCIPLE C", dry_run: 0 }]);

    await main.getByRole("button", { name: "Unggah Excel data SPPD…" }).click();
    dlg = page.getByRole("dialog");
    await dlg.getByLabel("Berkas Excel data SPPD (.xlsx/.xls)").setInputFiles({ name: "Data_SPPD_Okt.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });
    await expect(dlg.getByText("LPB-B-007 (sudah ditransfer)")).toBeVisible();
    await expect(dlg.getByText("nilai_invoice Rp 1.000 → Rp 1.500", { exact: false })).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Terapkan 1 perubahan" })).toBeDisabled();
    expect(kirim.filter((k) => k.path === "/payments/sppd/upload").map((k) => k.search)).toEqual(["?dry_run=1"]);
    await page.screenshot({ path: "test-results/s6a-format-excel-terkunci.png", fullPage: true });
});

test("Format SPPD: master rekening kosong = EmptyState (bukan galat), galat rekening = ErrorState; ponsel tanpa gulir samping", async ({ page }) => {
    let kosong = true;
    await mock(page, (p, r) => {
        if (p === "/api/bank-data") return kosong ? json(r, { ok: true, items: [] }) : html(r, 502);
        return "lewat";
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/payments/sppd", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Data rekening tidak ditemukan")).toBeVisible(NAV);
    await expect(main.getByRole("button", { name: /upload|unggah master/i })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/s6a-format-ponsel.png", fullPage: true });
    kosong = false;
    await main.getByRole("button", { name: "Muat ulang" }).click();
    await expect(main.getByText("Data rekening gagal dimuat")).toBeVisible();
    await expect(main.getByText("Data rekening tidak ditemukan")).toHaveCount(0);
});
