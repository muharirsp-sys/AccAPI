/*
 * Tujuan: Fiori S6a Pembayaran (it08) — Rekaman (tile = saringan, kunci baris dari server, galat ≠ kosong, simpan PER REKAMAN dengan
 *   hasil per baris, unggah pratinjau → simpan), Keranjang (rute + tanggal WITA, rekening dicek sebelum Ajukan, submit tidak pasti →
 *   draf terpakai dikunci), Pengajuan & SPPD (daftar → detail, 404, galat).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-pembayaran.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: FastAPI (dev: http://localhost:8000) di-mock dengan page.route + CORS/OPTIONS 204 + /api/me csrf.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const NAV = { timeout: 60_000 } as const;
// Asal halaman = baseURL proyek Playwright (port bebas), dibaca saat uji berjalan — bukan port tetap.
const CORS = () => ({
    "access-control-allow-origin": new URL(test.info().project.use.baseURL ?? "http://localhost:3000").origin, "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, OPTIONS",
});
const json = (r: Route, body: unknown, status = 200) => r.fulfill({ status, headers: { ...CORS(), "content-type": "application/json" }, body: JSON.stringify(body) });
const html = (r: Route, status = 502) => r.fulfill({ status, headers: { ...CORS(), "content-type": "text/html" }, body: "<html><body>Bad Gateway</body></html>" });
const besokWita = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date(Date.now() + 864e5));

const LENGKAP = { tipe_pengajuan: "LPB", tgl_invoice: "2026-10-06", jt_invoice: "2026-11-05", status_pembayaran: "", locked_reason: "" };
const REKAMAN = [
    { ...LENGKAP, record_id: "LPB-A-001", no_lpb: "LPB-A-001", principle: "PRINCIPLE A", invoice_no: "INV-A-1", nilai_invoice: "12.400.000", nilai_win: 12_400_000, nilai_win_display: "12.400.000", updated_at: "u1" },
    { ...LENGKAP, record_id: "LPB-A-002", no_lpb: "LPB-A-002", principle: "PRINCIPLE A", invoice_no: "INV-A-2", nilai_invoice: "18.950.000", nilai_win: 18_900_000, nilai_win_display: "18.900.000" },
    { ...LENGKAP, record_id: "CBD_1A2B3C4D", tipe_pengajuan: "CBD", no_lpb: "", principle: "PRINCIPLE B", invoice_no: "INV-B-9", nilai_invoice: "12.500.000", nilai_win: 12_500_000, tgl_invoice: "", jt_invoice: "" },
    { ...LENGKAP, record_id: "LPB-A-003", no_lpb: "LPB-A-003", principle: "PRINCIPLE A", invoice_no: "", nilai_invoice: "17.750.000", nilai_win: 17_750_000 },
    { ...LENGKAP, record_id: "LPB-B-010", no_lpb: "LPB-B-010", principle: "PRINCIPLE B", invoice_no: "INV-B-10", nilai_invoice: "18.400.000", nilai_win: 18_400_000, status_pembayaran: "Belum Transfer", submission_id: "1f2e3d4c", sppd_no: "031/SPA/PDSB/X/2026", locked_reason: "sudah diajukan; minta Finance mengembalikan (Ajukan Ulang)" },
    { ...LENGKAP, record_id: "LPB-B-007", no_lpb: "LPB-B-007", principle: "PRINCIPLE B", invoice_no: "INV-B-7", nilai_invoice: "12.600.000", nilai_win: 12_600_000, status_pembayaran: "Sudah Transfer", submission_id: "0a0b0c0d", sppd_no: "030/SPA/PDSB/X/2026", accurate_purchase_payment_number: "PP/2610/0029", locked_reason: "sudah ditransfer" },
    { ...LENGKAP, record_id: "LPB-A-004", no_lpb: "LPB-A-004", principle: "PRINCIPLE A", invoice_no: "INV-A-4", nilai_invoice: "5.000.000", nilai_win: 5_000_000, status_pembayaran: "Ajukan Ulang", submission_id: "0a0b0c0d" },
];

type Kirim = { path: string; search: string; body: unknown };

/** Mock FastAPI. `jawab` boleh mengganti jawaban per path; default = data di atas. */
async function mockFastapi(page: Page, jawab: (path: string, r: Route, kirim: Kirim[]) => Promise<void> | void | "lewat" = () => "lewat") {
    const kirim: Kirim[] = [];
    await page.route((u) => u.host === "localhost:8000", async (r) => {
        if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS() });
        const url = new URL(r.request().url());
        if (r.request().method() === "POST") {
            const ct = r.request().headers()["content-type"] ?? "";
            kirim.push({ path: url.pathname, search: url.search, body: ct.includes("json") ? r.request().postDataJSON() : "berkas" });
        }
        if (url.pathname === "/api/me") return json(r, { ok: true, csrf_token: "t" });
        const hasil = await jawab(url.pathname, r, kirim);
        if (hasil !== "lewat") return;
        if (url.pathname === "/payments/data") return json(r, { ok: true, data: REKAMAN });
        return json(r, { ok: true });
    });
    return kirim;
}

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("Rekaman: galat bukan kosong, tile menyaring, baris terkunci tidak bisa diubah/dihapus/dipilih, ponsel tanpa gulir samping", async ({ page }) => {
    let mode: "rusak" | "kosong" | "isi" = "rusak";
    await mockFastapi(page, (p, r) => {
        if (p !== "/payments/data") return "lewat";
        return mode === "rusak" ? html(r, 500) : json(r, { ok: true, data: mode === "kosong" ? [] : REKAMAN });
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/payments", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Rekaman pembayaran" })).toBeVisible(NAV);
    await expect(main.getByRole("heading", { name: "Data gagal dimuat" })).toBeVisible(NAV);
    await expect(main.getByText("Belum ada rekaman pembayaran")).toHaveCount(0);
    await expect(main.getByText("jawaban rusak")).toBeVisible();
    await expect(main.getByRole("button", { name: "Buat keranjang…" })).toBeDisabled();

    mode = "kosong";
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByText("Belum ada rekaman pembayaran")).toBeVisible();

    mode = "isi";
    await main.getByRole("button", { name: "Muat ulang" }).click();
    const tabel = main.getByRole("table", { name: "Rekaman" });
    await expect(tabel.getByText("LPB-A-001")).toBeVisible();
    const tiles = main.getByRole("group", { name: "Saring menurut status" });
    await expect(tiles.getByRole("button", { name: /Siap diajukan\s*3/ })).toBeVisible();
    await expect(tiles.getByRole("button", { name: /Draf · belum lengkap\s*1/ })).toBeVisible();
    await expect(main.getByText("Kurang: No. invoice")).toBeVisible();

    await tiles.getByRole("button", { name: /Sudah transfer/ }).click();
    await expect(tiles.getByRole("button", { name: /Sudah transfer/ })).toHaveAttribute("aria-pressed", "true");
    await expect(tabel.getByRole("row")).toHaveCount(2); // kepala + 1 baris
    await expect(tabel.getByText("Terkunci: sudah ditransfer")).toBeVisible();
    await expect(tabel.getByRole("checkbox", { name: "Pilih LPB-B-007" })).toBeDisabled();

    await tabel.getByRole("button", { name: "Buka rincian LPB-B-007" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByText("Terkunci: sudah ditransfer.", { exact: true })).toBeVisible();
    await expect(dlg.getByLabel("Nilai invoice")).toHaveAttribute("readonly", "");
    await expect(dlg.getByRole("button", { name: "Hapus rekaman…" })).toBeDisabled();
    await expect(dlg.getByText("Hapus nonaktif: Terkunci: sudah ditransfer.")).toBeVisible();
    await dlg.getByRole("button", { name: "Selesai" }).click();

    // Diajukan juga terkunci (BL-49); centang tidak tersedia.
    await tiles.getByRole("button", { name: /Diajukan · belum transfer/ }).click();
    await expect(tabel.getByText(/Terkunci: sudah diajukan/)).toBeVisible();
    await expect(tabel.getByRole("checkbox", { name: "Pilih LPB-B-010" })).toBeDisabled();
    await page.screenshot({ path: "test-results/s6a-rekaman-desktop.png", fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await tiles.getByRole("button", { name: /Diajukan · belum transfer/ }).click();
    await expect(main.getByRole("list", { name: "Rekaman" }).getByText("LPB-A-001")).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/s6a-rekaman-ponsel.png", fullPage: true });
});

test("Rekaman: simpan PER REKAMAN — satu rekaman ditolak server (409 terkunci), rekaman lain tersimpan; angka rusak diblok di layar; pilihan tidak dikirim", async ({ page }) => {
    const kirim = await mockFastapi(page, (p, r) => {
        if (p !== "/payments/update") return "lewat";
        const item = (r.request().postDataJSON() as { items: Array<{ record_id: string }> }).items[0];
        // Rekaman terkunci sejak halaman dimuat (diajukan di tab lain) → 409 untuk rekaman ini saja.
        if (item.record_id === "CBD_1A2B3C4D") return json(r, { ok: false, error: "Simpan ditolak — rekaman terkunci: CBD_1A2B3C4D (sudah diajukan). Tidak ada yang diubah.", locked: [{ record_id: "CBD_1A2B3C4D", no_lpb: "", principle: "PRINCIPLE B", reason: "sudah diajukan", fields: ["nilai_invoice"] }] }, 409);
        return json(r, { ok: true, updated: 1, updated_ids: [item.record_id], skipped: 0 });
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/payments", NAV);
    const main = page.locator("main");
    const tabel = main.getByRole("table", { name: "Rekaman" });
    await expect(tabel.getByText("LPB-A-001")).toBeVisible(NAV);

    // Pilihan layar: dua baris siap dicentang → TIDAK ikut ke /payments/update (pilihan bukan data).
    await tabel.getByRole("checkbox", { name: "Pilih LPB-A-002" }).check();

    const ubah = async (id: string, label: string, nilai: string) => {
        await tabel.getByRole("button", { name: `Buka rincian ${id}` }).click();
        const dlg = page.getByRole("dialog");
        await dlg.getByLabel(label, { exact: true }).fill(nilai);
        return dlg;
    };
    let dlg = await ubah("LPB-A-003", "No. invoice", "INV-A-3");
    await dlg.getByRole("button", { name: "Selesai" }).click();
    dlg = await ubah("LPB-A-001", "Nilai invoice", "17.750.00O");
    await expect(dlg.getByText("“17.750.00O” bukan angka rupiah")).toBeVisible();
    await dlg.getByRole("button", { name: "Selesai" }).click();
    await expect(main.getByText("Perbaiki isian yang bukan angka dulu.")).toBeVisible();
    await expect(main.getByRole("button", { name: /Simpan \d perubahan/ })).toBeDisabled();
    dlg = await ubah("LPB-A-001", "Nilai invoice", "12.450.000");
    await expect(dlg.getByText("Sebelumnya: 12.400.000")).toBeVisible();
    await dlg.getByRole("button", { name: "Selesai" }).click();
    dlg = await ubah("CBD_1A2B3C4D", "Nilai invoice", "12.600.000");
    await dlg.getByRole("button", { name: "Selesai" }).click();
    await expect(main.getByText("3 isian di 3 rekaman belum disimpan.", { exact: false })).toBeVisible();
    await expect(main.getByText("Simpan atau batalkan perubahan isian dulu.")).toHaveCount(0); // footer simpan menggantikan footer keranjang
    await main.getByRole("button", { name: "Simpan 3 perubahan" }).click();

    await expect(main.getByText("2 dari 3 rekaman tersimpan.")).toBeVisible();
    const upd = kirim.filter((k) => k.path === "/payments/update");
    expect(upd).toHaveLength(3);
    for (const k of upd) {
        const items = (k.body as { items: Array<Record<string, unknown>> }).items;
        expect(items).toHaveLength(1);
        expect(items[0]).not.toHaveProperty("ajukan");
    }
    expect(upd.map((k) => (k.body as { items: Array<Record<string, unknown>> }).items[0])).toEqual(expect.arrayContaining([
        { record_id: "LPB-A-003", source_updated_at: "", invoice_no: "INV-A-3" },
        { record_id: "LPB-A-001", source_updated_at: "u1", nilai_invoice: "12.450.000" },
        { record_id: "CBD_1A2B3C4D", source_updated_at: "", nilai_invoice: "12.600.000" },
    ]));
    await expect(tabel.getByText("Ditolak: Simpan ditolak — rekaman terkunci: CBD_1A2B3C4D (sudah diajukan). Tidak ada yang diubah.")).toBeVisible();
    // Isian yang ditolak tetap di layar; yang tersimpan hilang dari draf.
    await expect(main.getByRole("button", { name: "Simpan 1 perubahan" })).toBeEnabled();
    await page.screenshot({ path: "test-results/s6a-rekaman-simpan-sebagian.png", fullPage: true });
});

test("Rekaman: unggah LPB = pratinjau dulu (tanpa tulis), lalu simpan; baris baru ditandai", async ({ page }) => {
    let sesudah = false;
    const kirim = await mockFastapi(page, (p, r) => {
        const q = new URL(r.request().url()).searchParams.get("dry_run");
        if (p === "/payments/data") return json(r, { ok: true, data: sesudah ? [...REKAMAN, { ...LENGKAP, record_id: "LPB-C-100", no_lpb: "LPB-C-100", principle: "PRINCIPLE C", invoice_no: "INV-C-1", nilai_invoice: "2.000.000" }] : REKAMAN });
        if (p !== "/payments/upload") return "lewat";
        if (q === "1") return json(r, { ok: true, dry_run: true, can_apply: true, rows: 1, total_nilai_win: 2_000_000, total_nilai_invoice: 2_000_000, duplicates: [], duplicates_in_file: [], invalid: [] });
        sesudah = true;
        return json(r, { ok: true, dry_run: false, added: 1, rows: 1 });
    });
    await page.goto("/payments", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("table", { name: "Rekaman" }).getByText("LPB-A-001")).toBeVisible(NAV);
    await main.getByRole("button", { name: "Unggah LPB" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Berkas LPB (.xlsx/.xls)").setInputFiles({ name: "LPB_OKT.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });
    await expect(dlg.getByText("Pratinjau bersih.")).toBeVisible();
    await expect(dlg.getByText("1 LPB", { exact: true })).toBeVisible();
    expect(kirim.filter((k) => k.path === "/payments/upload").map((k) => k.search)).toEqual(["?dry_run=1"]);
    await dlg.getByRole("button", { name: "Simpan 1 LPB" }).click();
    await expect(main.getByText("1 LPB dari LPB_OKT.xlsx tersimpan.", { exact: false })).toBeVisible();
    expect(kirim.filter((k) => k.path === "/payments/upload").map((k) => k.search)).toEqual(["?dry_run=1", "?dry_run=0"]);
    const baris = main.getByRole("table", { name: "Rekaman" }).getByRole("row", { name: /LPB-C-100/ });
    await expect(baris.getByText("Baru")).toBeVisible();
});

test("Keranjang: pilih → rute + tanggal bayar besok WITA → rekening tidak ditemukan memblok Ajukan sebelum klik", async ({ page }) => {
    test.setTimeout(300_000); // navigasi klien pertama ke rute keranjang = kompilasi dev (bisa > 60 dtk)
    const kirim = await mockFastapi(page, (p, r) => {
        const u = new URL(r.request().url());
        if (p === "/payments/cart/create") return json(r, { ok: true, draft_id: "7f3c91ab" });
        if (p === "/payments/cart-info") return json(r, { ok: true, method: "BANK_PANIN", method_label: "Bank Panin", target_payment_date: besokWita(), items: [
            { no: 1, group_key: "PRINCIPLE A||LPB", principle: "PRINCIPLE A", tipe_pengajuan: "LPB", total: 12_400_000, invoice_concat: "INV-A-1", potongan: 0, nilai_pembayaran: 12_400_000, jenis_pembayaran: "", keterangan: "" },
            { no: 2, group_key: "PRINCIPLE B||CBD", principle: "PRINCIPLE B", tipe_pengajuan: "CBD", total: 12_500_000, invoice_concat: "INV-B-9", potongan: 0, nilai_pembayaran: 12_500_000, jenis_pembayaran: "", keterangan: "" },
        ] });
        if (p === "/api/bank-data/lookup") return u.searchParams.get("principle") === "PRINCIPLE A"
            ? json(r, { ok: true, status: "matched", data: { principle: "PT PRINCIPLE A", bank: "BANK A", rekening: "0213000000", penerima: "PT PRINCIPLE A", has_rekening: true } })
            : json(r, { ok: true, status: "unmatched", data: null });
        if (p === "/payments/sppd/settings") return json(r, { ok: true, settings: { last_sequence: 31 }, effective_last_sequence: 31, preview_number: "032/SPA/PDSB/X/2026" });
        return "lewat";
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/payments", NAV);
    const main = page.locator("main");
    const tabel = main.getByRole("table", { name: "Rekaman" });
    await expect(tabel.getByText("LPB-A-001")).toBeVisible(NAV);
    await tabel.getByRole("checkbox", { name: "Pilih LPB-A-001" }).check();
    await tabel.getByRole("checkbox", { name: "Pilih CBD_1A2B3C4D" }).check();
    await expect(main.getByText("2 dipilih")).toBeVisible();
    await expect(main.getByText("Rp 24.900.000")).toBeVisible();
    // Pilihan tidak menyeberangi saringan: sembunyikan PRINCIPLE B → hanya 1 yang ikut.
    await main.locator(".fi-fbar-fields").getByLabel("Principal").selectOption("PRINCIPLE A");
    await expect(main.getByText("1 dipilih")).toBeVisible();
    await main.locator(".fi-fbar-fields").getByLabel("Principal").selectOption("");
    await expect(main.getByText("2 dipilih")).toBeVisible();

    await main.getByRole("button", { name: "Buat keranjang…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("button", { name: "Buat keranjang" })).toBeDisabled();
    await expect(dlg.getByLabel("Tanggal bayar Finance")).toHaveValue(besokWita());
    await dlg.getByRole("radio", { name: /Bank Panin/ }).check();
    await dlg.getByRole("button", { name: "Buat keranjang" }).click();
    await expect(page).toHaveURL(/\/payments\/cart\/7f3c91ab$/, { timeout: 240_000 });
    expect(kirim.find((k) => k.path === "/payments/cart/create")?.body).toEqual({ method: "BANK_PANIN", record_ids: ["LPB-A-001", "CBD_1A2B3C4D"], target_payment_date: besokWita() });

    await expect(main.getByText("032/SPA/PDSB/X/2026").first()).toBeVisible(NAV);
    await expect(main.getByText("Rekening PRINCIPLE B tidak ditemukan di master rekening.")).toBeVisible();
    await expect(main.getByText("Rekening cocok")).toBeVisible();
    await expect(main.getByRole("button", { name: "Ajukan ke Finance…" })).toBeDisabled();
    await expect(main.locator(".fi-ftb")).toContainText("Jenis Pembayaran wajib diisi untuk semua baris.");
    await main.getByLabel("Jenis pembayaran PRINCIPLE A").selectOption("TRF");
    await main.getByLabel("Jenis pembayaran PRINCIPLE B").selectOption("VA");
    await expect(main.locator(".fi-ftb")).toContainText("Rekening PRINCIPLE B belum ditemukan di master rekening.");
    await expect(main.getByRole("button", { name: "Ajukan ke Finance…" })).toBeDisabled();
    await page.screenshot({ path: "test-results/s6a-keranjang-rekening.png", fullPage: true });
});

const CART_OK = { ok: true, method: "BANK_PANIN", method_label: "Bank Panin", target_payment_date: "2026-10-12", items: [
    { no: 1, group_key: "PRINCIPLE A||LPB", principle: "PRINCIPLE A", tipe_pengajuan: "LPB", total: 31_350_000, invoice_concat: "INV-A-1, INV-A-2", potongan: 0, nilai_pembayaran: 31_350_000, jenis_pembayaran: "", keterangan: "" },
] };
const REK_OK = { ok: true, status: "matched", data: { principle: "PT PRINCIPLE A", bank: "BANK A", rekening: "0213000000", penerima: "PT PRINCIPLE A", has_rekening: true } };

test("Keranjang: potongan ketat, Ajukan lewat dialog dengan nomor SPPD, langkah 3 berkas + Buka pengajuan", async ({ page }) => {
    const kirim = await mockFastapi(page, (p, r) => {
        if (p === "/payments/cart-info") return json(r, CART_OK);
        if (p === "/api/bank-data/lookup") return json(r, REK_OK);
        if (p === "/payments/sppd/settings") return json(r, { ok: true, settings: { last_sequence: 31 }, effective_last_sequence: 31, preview_number: "032/SPA/PDSB/X/2026" });
        if (p === "/payments/cart/submit") return json(r, { ok: true, submission_id: "c41e0d27", files: [{ label: "Invoice PRINCIPLE A (LPB)", url: "/payments/files/invoice_c41e0d27_a.xlsx" }, { label: "SPPD Bank Panin", url: "/payments/files/sppd_c41e0d27.docx" }] });
        return "lewat";
    });
    await page.goto("/payments/cart/7f3c91ab", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Keranjang pengajuan" })).toBeVisible(NAV);
    await main.getByLabel("Jenis pembayaran PRINCIPLE A").selectOption("DF");
    await main.getByLabel("Potongan PRINCIPLE A").fill("9OO.000");
    await expect(main.getByText("“9OO.000” bukan angka rupiah.")).toBeVisible();
    await expect(main.getByRole("button", { name: "Ajukan ke Finance…" })).toBeDisabled();
    await main.getByLabel("Potongan PRINCIPLE A").fill("900.000");
    await expect(main.getByText("nilai bayar Rp 30.450.000", { exact: false })).toBeVisible();
    await main.getByRole("button", { name: "Ajukan ke Finance…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByText("032/SPA/PDSB/X/2026 (perkiraan)")).toBeVisible();
    await expect(dlg.getByText("1 dari 1 cocok di master")).toBeVisible();
    await dlg.getByRole("button", { name: "Ajukan ke Finance" }).click();
    await expect(main.getByText("Pengajuan c41e0d27 dibuat.")).toBeVisible();
    const sub = kirim.find((k) => k.path === "/payments/cart/submit")?.body;
    expect(sub).toEqual({ draft_id: "7f3c91ab", target_payment_date: "2026-10-12", items: [{ group_key: "PRINCIPLE A||LPB", principle: "PRINCIPLE A", tipe_pengajuan: "LPB", jenis_pembayaran: "DF", potongan: 900000, nilai_pembayaran: 30450000, keterangan: "" }] });
    await expect(main.getByRole("link", { name: "Buka pengajuan" })).toHaveAttribute("href", "/payments/pengajuan/c41e0d27");
    await expect(main.getByRole("list", { name: "Berkas pengajuan" }).getByRole("link", { name: "Unduh" })).toHaveCount(2);
    await page.screenshot({ path: "test-results/s6a-keranjang-sukses.png", fullPage: true });
});

test("Keranjang: jawaban Ajukan tidak pasti → muat ulang → draf terpakai (404) = terkunci, tidak diajukan dua kali", async ({ page }) => {
    let terpakai = false;
    const kirim = await mockFastapi(page, (p, r) => {
        if (p === "/payments/cart-info") return terpakai ? json(r, { ok: false, error: "Draft tidak ditemukan." }, 404) : json(r, CART_OK);
        if (p === "/api/bank-data/lookup") return json(r, REK_OK);
        if (p === "/payments/sppd/settings") return json(r, { ok: true, settings: { last_sequence: 31 }, effective_last_sequence: 31, preview_number: "032/SPA/PDSB/X/2026" });
        if (p === "/payments/cart/submit") { terpakai = true; return r.abort("connectionreset"); }
        return "lewat";
    });
    await page.goto("/payments/cart/7f3c91ab", NAV);
    const main = page.locator("main");
    await main.getByLabel("Jenis pembayaran PRINCIPLE A").selectOption("TRF", NAV);
    await main.getByRole("button", { name: "Ajukan ke Finance…" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Ajukan ke Finance" }).click();
    await expect(dlg.getByText(/Hasilnya belum pasti/)).toBeVisible();
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(main.getByText("Draf sudah terpakai.")).toBeVisible();
    await expect(main.getByText("Keranjang tidak ditemukan atau sudah diajukan")).toBeVisible();
    await expect(main.getByRole("button", { name: "Ajukan ke Finance…" })).toHaveCount(0);
    expect(kirim.filter((k) => k.path === "/payments/cart/submit")).toHaveLength(1);
});

const SUB = { id: "1f2e3d4c", sppd_no: "031/SPA/PDSB/X/2026", created_at: "2026-10-09 02:00:00", created_at_wita: "2026-10-09 10:00:00", created_by: "betterauth|staff|staf.a@contoh.test", target_payment_date: "2026-10-10", method: "BANK_PANIN", route_label: "Bank Panin (SPPD)", record_count: 2, principles: ["PRINCIPLE A", "PRINCIPLE B"], total_invoice: 31_350_000, total_potongan: 0, total_pembayaran: 31_350_000, transfer: { "Sudah Transfer": 1, "Belum Transfer": 1 }, posting: { posted: 1, belum: 1 }, status: "sebagian", status_label: "Sebagian ditransfer", file_count: 2 };

test("Pengajuan & SPPD: galat bukan kosong, daftar → detail dengan status per baris Finance dan berkas; 404 = tidak ditemukan", async ({ page }) => {
    let rusak = true;
    await mockFastapi(page, (p, r) => {
        if (p === "/payments/submissions") return rusak ? html(r, 502) : json(r, { ok: true, data: [SUB], total: 1, limit: 50, offset: 0 });
        if (p === "/payments/submissions/1f2e3d4c") return json(r, { ok: true, data: { ...SUB, files: [{ label: "SPPD Bank Panin", name: "sppd_1f2e3d4c.docx", url: "/payments/files/sppd_1f2e3d4c.docx" }], cart_items: { "PRINCIPLE A||LPB": { principle: "PRINCIPLE A", tipe_pengajuan: "LPB", jenis_pembayaran: "TRF", potongan: 0, nilai_pembayaran: 18_950_000, keterangan: "" } }, records: [
            { record_id: "LPB-A-002", no_lpb: "LPB-A-002", tipe_pengajuan: "LPB", principle: "PRINCIPLE A", invoice_no: "INV-A-2", nilai_invoice: 18_950_000, potongan: 0, nilai_pembayaran: 18_950_000, jenis_pembayaran: "TRF", status_pembayaran: "Sudah Transfer", transfer_date: "2026-10-10", accurate_post_status: "posted", accurate_purchase_payment_number: "PP/2610/0031", locked_reason: "sudah terposting di Accurate (PP/2610/0031)" },
            { record_id: "LPB-B-010", no_lpb: "LPB-B-010", tipe_pengajuan: "LPB", principle: "PRINCIPLE B", invoice_no: "INV-B-10", nilai_invoice: 12_400_000, potongan: 0, nilai_pembayaran: 12_400_000, jenis_pembayaran: "TRF", status_pembayaran: "Belum Transfer", transfer_date: "", accurate_post_status: "", accurate_purchase_payment_number: "", locked_reason: "sudah diajukan; minta Finance mengembalikan (Ajukan Ulang)" },
        ] } });
        if (p.startsWith("/payments/submissions/")) return json(r, { ok: false, error: "Pengajuan tidak ditemukan." }, 404);
        return "lewat";
    });
    await page.goto("/payments/pengajuan", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Data gagal dimuat" })).toBeVisible(NAV);
    await expect(main.getByText("Belum ada pengajuan")).toHaveCount(0);
    rusak = false;
    await main.getByRole("button", { name: "Coba lagi" }).click();
    const daftar = main.getByRole("table", { name: "Pengajuan" });
    await expect(daftar.getByRole("link", { name: "031/SPA/PDSB/X/2026" })).toBeVisible();
    await expect(daftar.getByText("Sebagian ditransfer")).toBeVisible();
    await expect(daftar.getByText("09/10/2026 10.00")).toBeVisible();
    await daftar.getByRole("link", { name: "031/SPA/PDSB/X/2026" }).click();
    await expect(page).toHaveURL(/\/payments\/pengajuan\/1f2e3d4c$/, NAV);
    await expect(main.getByRole("heading", { level: 1, name: "031/SPA/PDSB/X/2026" })).toBeVisible(NAV);
    const baris = main.getByRole("table", { name: "Baris Finance" });
    await expect(baris.getByRole("row", { name: /LPB-A-002/ }).getByText("Terposting", { exact: true })).toBeVisible();
    await expect(baris.getByRole("row", { name: /LPB-B-010/ }).getByText("Belum transfer", { exact: true })).toBeVisible();
    await expect(baris.getByText("PP/2610/0031", { exact: true })).toBeVisible();
    await expect(main.getByRole("list", { name: "Berkas pengajuan" }).getByRole("link", { name: "Unduh" })).toHaveAttribute("href", "http://localhost:8000/payments/files/sppd_1f2e3d4c.docx");
    await page.screenshot({ path: "test-results/s6a-pengajuan-detail.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);

    await page.goto("/payments/pengajuan/tidakada", NAV);
    await expect(main.getByText("Pengajuan tidak ditemukan")).toBeVisible(NAV);
});
