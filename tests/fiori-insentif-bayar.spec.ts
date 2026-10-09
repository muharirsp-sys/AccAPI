/*
 * Tujuan: Fiori S4c Insentif Sales — Pembayaran (ubin 12 bulan = periode URL, total, pilih semua yang belum dibayar di saringan aktif,
 *   Tandai lunas lewat dialog dengan payload POST/PATCH diperiksa [tanggal bayar pilihan, batas awal periode..hari ini WITA, galat server di
 *   dialog], gagal sebagian di dialog, penerima terpilih di luar saringan disebut,
 *   galat ≠ kosong, ponsel 390 px) dan Support principal (draf per baris → simpan lewat dialog dengan payload diperiksa, galat 400 tanpa
 *   perubahan, hitung untuk SPV dan penyebut AO lewat dialog, normalisasi kunci SPV sama dengan server, kosong/galat, ponsel 390 px).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-insentif-bayar.spec.ts --config playwright.fiori-local.config.ts`.
 * Dependensi: /api/insentif-sales/{dashboard,spv-dashboard,sm-dashboard,payments,support,spv-support,spv-ikut,targets/*} di-mock dengan
 *   page.route (tidak menyentuh DB).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import * as XLSX from "xlsx";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const path = (p: string) => (url: URL) => url.pathname === p;
const NAV = { timeout: 60_000 } as const;
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
const tampil = (ymd: string) => ymd.split("-").reverse().join("/");
type Over = Record<string, unknown>;
type Kirim = { method: string; url: string; body: unknown };

const baris = (salesCode: string, salesName: string, principle: string, channel: string, spvName: string, over: Over = {}) => ({
    salesCode, salesName, principle, branch: "MAKASSAR", channel, tipeSales: "exclusive", statusInsentif: "distributor_principle", support: 0,
    spvName, smName: "HENDRIK",
    target: { value: 400_000_000, ec: 600, ao: 120, ia: 30, isq: 0.25, splm: 0 },
    real: { value: 416_000_000, ec: 610, ao: 250, ia: 70, isq: 0.28 },
    pct: { value: 104, ec: 101.7, ao: 208.3, isq: 112, total: 130 },
    incentive: { value: 300_000, ec: 0, ao: 700_000, isq: 0, total: 1_000_000 },
    ambangAo: 240, aoFile: false, paymentStatus: "belum", ...over,
});
const nol = { value: 0, ec: 0, ao: 0, isq: 0, total: 0 };
const dashboard = (rows: unknown[]) => ({
    month: 9, year: 2026, rows, progressFeed: null, cakupan: { dibatasi: false },
    opsiFilter: { principles: ["GODREJ", "KINO", "URC"], branches: ["MAKASSAR"], sm: ["HENDRIK"] },
});
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

// ── Pembayaran ──────────────────────────────────────────────────────────────
const ROWS_BAYAR = [
    baris("MKS-07", "Andi Pratama", "KINO", "GT", "ANI"),
    baris("MKS-08", "Sinta Dewi", "KINO", "GT", "ANI", { incentive: { value: 282_300, ec: 0, ao: 658_700, isq: 0, total: 941_000 } }),
    baris("MKS-21", "Rudi Hartono", "GODREJ", "GT", "MARTEN", { pct: { value: 88, ec: 90, ao: 125, isq: 100, total: 90 }, real: { value: 352_000_000, ec: 540, ao: 150, ia: 40, isq: 0.27 }, incentive: nol }),
    baris("MKS-11", "Rizal Fahmi", "URC", "GT", "YARMAN", { paymentStatus: "lunas", incentive: { value: 240_000, ec: 0, ao: 560_000, isq: 0, total: 800_000 } }),
];
const det = (principle: string, insentif: number) => ({ principle, targetValue: 1_000_000_000, realisasiValue: 1_010_000_000, pctValue: 1, rate: 2_000_000, support: 0, porsiDistributor: 2_000_000, insentif });
const SPV = [
    { spvName: "ANI", jumlahValid: 2, ratePerPrincipal: 2_000_000, total: 4_000_000, rincian: [det("KINO", 2_000_000), det("URC", 2_000_000)] },
    { spvName: "YARMAN", jumlahValid: 1, ratePerPrincipal: 1_200_000, total: 1_200_000, rincian: [det("URC", 1_200_000)] },
];
const SM = [
    { smName: "HENDRIK", jumlahBaris: 46, targetValue: 4_730_000_000, realisasiValue: 4_701_000_000, pctValue: 0.994, berhak: true, total: 1_500_000 },
    { smName: "DARMA", jumlahBaris: 12, targetValue: 900_000_000, realisasiValue: 950_000_000, pctValue: 1.055, berhak: false, total: 0 },
];
const bayar = (id: string, salesCode: string, salesName: string, principle: string, periodMonth: number, totalIncentive: number, paymentStatus: string, over: Over = {}) => ({
    id, salesCode, salesName, principle, branch: "MAKASSAR", periodMonth, periodYear: 2026, totalIncentive, paymentStatus, paymentProofUrl: null, paymentDate: null, ...over,
});
const PAYMENTS = [
    bayar("pay-sinta", "MKS-08", "Sinta Dewi", "KINO", 9, 900_000, "belum"), // hitung ulang Rp 941.000
    bayar("pay-rizal", "MKS-11", "Rizal Fahmi", "URC", 9, 800_000, "lunas", { paymentDate: "2026-10-03T02:00:00.000Z", paidByName: "Dewi Lestari" }),
    bayar("pay-agu", "MKS-07", "Andi Pratama", "KINO", 8, 1_000_000, "lunas", { paymentDate: "2026-09-04T02:00:00.000Z", paidByName: "Dewi Lestari" }),
];

/** Mock Pembayaran. `gagalPost(kode)` → respons gagal untuk POST kode itu. Mengembalikan daftar tulis yang terkirim. */
async function mockBayar(page: Page, opsi: { rows?: unknown[]; spv?: () => ReturnType<typeof json>; payments?: () => ReturnType<typeof json>; gagalPost?: (kode: string) => ReturnType<typeof json> | null; gagalBacaSetelahTulis?: boolean } = {}) {
    const kirim: Kirim[] = [];
    let payments = PAYMENTS.map((p) => ({ ...p }));
    const lunaskan = (cocok: (p: { id: string; salesCode: string }) => boolean, baru?: ReturnType<typeof bayar>) => {
        payments = payments.map((p) => (cocok(p) ? { ...p, paymentStatus: "lunas", paymentDate: "2026-10-08T02:20:00.000Z", paidByName: "LOCAL Admin" } : p));
        if (baru) payments.push(baru);
    };
    await page.route(path("/api/insentif-sales/dashboard"), (r) => r.fulfill(json(dashboard(opsi.rows ?? ROWS_BAYAR))));
    await page.route(path("/api/insentif-sales/spv-dashboard"), (r) => r.fulfill(opsi.spv ? opsi.spv() : json({ rows: opsi.rows ? [] : SPV })));
    await page.route(path("/api/insentif-sales/sm-dashboard"), (r) => r.fulfill(json({ rows: opsi.rows ? [] : SM })));
    await page.route(path("/api/insentif-sales/payments"), (r: Route) => {
        const req = r.request();
        if (req.method() === "GET") {
            if (opsi.gagalBacaSetelahTulis && kirim.length > 0) return r.fulfill({ status: 500, contentType: "text/plain", body: "" });
            return r.fulfill(opsi.payments ? opsi.payments() : json({ month: null, year: 2026, rows: payments }));
        }
        const body = req.postDataJSON() as { salesCode: string; salesName: string; principle: string; totalIncentive: number };
        kirim.push({ method: "POST", url: "/api/insentif-sales/payments", body });
        const gagal = opsi.gagalPost?.(body.salesCode);
        if (gagal) return r.fulfill(gagal);
        lunaskan(() => false, bayar(`pay-${body.salesCode}`, body.salesCode, body.salesName, body.principle, 9, body.totalIncentive, "lunas", { paymentDate: "2026-10-08T02:20:00.000Z", paidByName: "LOCAL Admin" }));
        return r.fulfill(json({ id: `pay-${body.salesCode}`, action: "created" }, 201));
    });
    await page.route((u) => u.pathname.startsWith("/api/insentif-sales/payments/"), (r) => {
        const id = new URL(r.request().url()).pathname.split("/").pop()!;
        kirim.push({ method: "PATCH", url: `/api/insentif-sales/payments/${id}`, body: r.request().postDataJSON() });
        lunaskan((p) => p.id === id);
        return r.fulfill(json({ id, updated: true }));
    });
    return kirim;
}

test("Pembayaran: ubin 12 bulan + total, pilih semua yang belum dibayar, Tandai lunas lewat dialog (payload POST/PATCH), baris lunas bertanggal", async ({ page }) => {
    const kirim = await mockBayar(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pembayaran?month=9&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Pembayaran" })).toBeVisible(NAV);
    const tabel = main.getByRole("table", { name: "Insentif September 2026" });
    await expect(tabel.locator("tbody tr")).toHaveCount(7, NAV); // 4 sales + 2 SPV + 1 SM (SM Rp 0 di luar skema tidak dibuat barisnya)

    const ubin = main.getByRole("group", { name: "Pilih bulan 2026" });
    await expect(ubin.getByRole("button")).toHaveCount(12);
    const sep = ubin.getByRole("button", { name: /September/ });
    await expect(sep).toHaveAttribute("aria-pressed", "true");
    await expect(sep).toContainText("Rp 9,4 Jt");
    await expect(sep).toContainText("belum: Rp 8,6 Jt");
    await expect(ubin.getByRole("button", { name: /Agustus/ })).toContainText("Lunas");
    await expect(ubin.getByRole("button", { name: /Juli/ })).toContainText("belum dihitung");

    await expect(tabel.locator("tbody tr").filter({ hasText: "Rizal Fahmi" })).toContainText("Lunas");
    await expect(tabel.locator("tbody tr").filter({ hasText: "Rizal Fahmi" })).toContainText("03/10/2026 · Dewi Lestari");
    await expect(tabel.locator("tbody tr").filter({ hasText: "Rudi Hartono" })).toContainText("Rp 0 · belum 90,0%");
    await expect(tabel.locator("tbody tr").filter({ hasText: "Sinta Dewi" })).toContainText("tercatat Rp 900.000 — nominal ini yang ditandai lunas");
    await expect(main.getByRole("checkbox", { name: "Pilih Rudi Hartono GODREJ" })).toBeDisabled();
    await expect(main.getByRole("checkbox", { name: "Pilih Rizal Fahmi URC" })).toBeDisabled();
    await expect(main.getByText("Upload")).toHaveCount(0);
    await expect(main.getByText("usulan BL-27")).toBeVisible();

    const footer = main.locator(".fi-ftb");
    await expect(footer.getByRole("button", { name: "Tandai lunas…" })).toBeDisabled();
    await main.getByRole("checkbox", { name: "Pilih semua baris" }).check();
    await expect(footer).toContainText("5 dipilih · Bruto Rp 8.600.000 · PPh 2,5% -Rp 215.000 · Netto Rp 8.385.000");
    await expect(main.getByText("Pilihan belum disimpan")).toBeVisible();
    await expect(tabel.locator("tbody tr").filter({ hasText: "Andi Pratama" })).toContainText("Akan dibayar");
    await page.screenshot({ path: "test-results/fiori-insentif-bayar-pilih.png", fullPage: true });

    await footer.getByRole("button", { name: "Tandai 5 lunas…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Tandai 5 penerima September 2026 lunas?" })).toBeVisible();
    await expect(dlg).toContainText("2 Sales, 2 SPV, 1 SM");
    await expect(dlg).toContainText("Rp 8.600.000");
    await expect(dlg).toContainText("Rp 8.385.000");
    await expect(dlg).toContainText("Sinta Dewi tercatat Rp 900.000, hitung ulang Rp 941.000");
    await expect(dlg.getByLabel("Tanggal bayar")).toHaveValue(HARI_INI); // bawaan hari ini WITA (owner 8 Okt)
    await expect(dlg).toContainText(`${tampil(HARI_INI)} (WITA) · dicatat bersama nama Anda`);
    await expect(dlg.getByText("usulan BL-27")).toBeVisible();
    await expect(dlg.getByText("usulan BL-47")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-insentif-bayar-dialog.png" });
    await dlg.getByRole("button", { name: "Tandai lunas" }).click();
    await expect(dlg).toBeHidden();

    // Urutan & bentuk panggilan sama dengan kode lama: POST untuk yang belum tercatat, PATCH {paymentStatus} untuk yang sudah.
    expect(kirim).toHaveLength(5);
    const posts = kirim.filter((k) => k.method === "POST").map((k) => k.body);
    expect(posts).toEqual(expect.arrayContaining([
        { salesCode: "MKS-07", salesName: "Andi Pratama", principle: "KINO", branch: "MAKASSAR", periodMonth: 9, periodYear: 2026, totalIncentive: 1_000_000, paymentStatus: "lunas", paymentDate: HARI_INI },
        { salesCode: "SPV:ANI", salesName: "ANI", principle: "-", branch: "-", periodMonth: 9, periodYear: 2026, totalIncentive: 4_000_000, paymentStatus: "lunas", paymentDate: HARI_INI },
        { salesCode: "SM:HENDRIK", salesName: "HENDRIK", principle: "-", branch: "-", periodMonth: 9, periodYear: 2026, totalIncentive: 1_500_000, paymentStatus: "lunas", paymentDate: HARI_INI },
    ]));
    expect(posts).toHaveLength(4);
    expect(kirim.find((k) => k.method === "PATCH")).toEqual({ method: "PATCH", url: "/api/insentif-sales/payments/pay-sinta", body: { paymentStatus: "lunas", paymentDate: HARI_INI } });

    await expect(main.getByRole("status").filter({ hasText: "5 pembayaran September 2026 ditandai lunas" })).toBeVisible();
    await expect(tabel.locator("tbody tr").filter({ hasText: "Andi Pratama" })).toContainText("08/10/2026 · LOCAL Admin");
    await expect(sep).toContainText("Lunas");
    await expect(footer.getByRole("button", { name: "Tandai lunas…" })).toBeDisabled();
    await page.screenshot({ path: "test-results/fiori-insentif-bayar-sukses.png", fullPage: true });

    await ubin.getByRole("button", { name: /Agustus/ }).click();
    await expect(page).toHaveURL(/month=8/, NAV);
});

const CABANG_A = { branch: "CABANG A", smName: "SM A" };
test("Tanggal bayar (owner 8 Okt): bawaan hari ini WITA, batas awal periode..hari ini, tanggal mundur dikirim di POST dan PATCH; galat server di dialog", async ({ page }) => {
    let tolakSekali = true;
    const kirim = await mockBayar(page, {
        rows: [baris("S-A1", "SALES A", "PRINCIPLE A", "GT", "SPV A", CABANG_A), baris("S-B1", "SALES B", "PRINCIPLE B", "GT", "SPV A", CABANG_A)],
        payments: () => json({ rows: [bayar("pay-b1", "S-B1", "SALES B", "PRINCIPLE B", 9, 1_000_000, "belum", { branch: "CABANG A" })] }),
        gagalPost: () => {
            if (!tolakSekali) return null;
            tolakSekali = false;
            return json({ error: "Tanggal bayar 2026-09-30 lebih awal dari awal periode insentif (2026-10-01)." }, 400);
        },
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pembayaran?month=9&year=2026", NAV);
    const main = page.locator("main");
    await main.getByRole("checkbox", { name: "Pilih semua baris" }).check(NAV);
    await main.locator(".fi-ftb").getByRole("button", { name: "Tandai 2 lunas…" }).click();
    const dlg = page.getByRole("dialog");
    const tanggal = dlg.getByLabel("Tanggal bayar");
    const tombol = dlg.getByRole("button", { name: "Tandai lunas" });
    await expect(tanggal).toHaveValue(HARI_INI);
    await expect(tanggal).toHaveAttribute("min", "2026-09-01");
    await expect(tanggal).toHaveAttribute("max", HARI_INI);
    await expect(tombol).toBeEnabled();
    const batas = `Tanggal bayar harus 01/09/2026 s.d. ${tampil(HARI_INI)} (WITA)`;
    const besok = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date(Date.now() + 864e5));
    for (const salah of ["2026-08-31", besok]) {
        await tanggal.fill(salah);
        await expect(tombol).toBeDisabled();
        await expect(tombol).toHaveAttribute("title", batas);
        await expect(dlg.getByText(batas)).toBeVisible();
    }
    await tanggal.fill("2026-09-30");
    await expect(tombol).toBeEnabled();
    await expect(dlg).toContainText("30/09/2026 (WITA) · dicatat bersama nama Anda");
    expect(kirim).toHaveLength(0);
    await page.screenshot({ path: "test-results/fiori-insentif-bayar-tanggal.png" });

    // Galat validasi server (mis. periode/jam server berbeda) tampil di dialog; tanggal pilihan tidak hilang.
    await tombol.click();
    await expect(dlg.getByRole("alert")).toContainText("SALES A: Tanggal bayar 2026-09-30 lebih awal dari awal periode insentif (2026-10-01).");
    await expect(dlg.getByRole("heading", { name: "Tandai 1 penerima September 2026 lunas?" })).toBeVisible();
    await expect(tanggal).toHaveValue("2026-09-30");
    await tombol.click();
    await expect(dlg).toBeHidden();
    await expect(main.getByRole("status").filter({ hasText: "1 pembayaran September 2026 ditandai lunas" })).toContainText("tanggal bayar 30/09/2026");

    const post = { salesCode: "S-A1", salesName: "SALES A", principle: "PRINCIPLE A", branch: "CABANG A", periodMonth: 9, periodYear: 2026, totalIncentive: 1_000_000, paymentStatus: "lunas", paymentDate: "2026-09-30" };
    expect(kirim.filter((k) => k.method === "POST")).toEqual([{ method: "POST", url: "/api/insentif-sales/payments", body: post }, { method: "POST", url: "/api/insentif-sales/payments", body: post }]);
    expect(kirim.filter((k) => k.method === "PATCH")).toEqual([{ method: "PATCH", url: "/api/insentif-sales/payments/pay-b1", body: { paymentStatus: "lunas", paymentDate: "2026-09-30" } }]);
});

test("Pembayaran: pilih semua hanya di saringan aktif; terpilih di luar saringan disebut namanya + Tampilkan; gagal sebagian tampil di dialog", async ({ page }) => {
    const kirim = await mockBayar(page, { gagalPost: (kode) => (kode === "SPV:YARMAN" ? json({ error: "SPV:YARMAN: di luar cakupan Anda." }, 403) : null) });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pembayaran?month=9&year=2026&principle=KINO", NAV);
    const main = page.locator("main");
    const tabel = main.getByRole("table", { name: "Insentif September 2026" });
    await expect(tabel.locator("tbody tr")).toHaveCount(2, NAV);
    await main.getByRole("checkbox", { name: "Pilih semua baris" }).check();
    await expect(main.locator(".fi-ftb")).toContainText("2 dipilih");

    // Hapus saringan, pilih SPV/SM juga, lalu saring lagi: yang terpilih di luar saringan disebut namanya.
    await main.locator(".fi-fbar").getByLabel("Principal", { exact: true }).selectOption("ALL");
    await expect(tabel.locator("tbody tr")).toHaveCount(7);
    await main.getByRole("checkbox", { name: "Pilih SPV ANI" }).check();
    await main.getByRole("checkbox", { name: "Pilih SPV YARMAN" }).check();
    await main.getByRole("checkbox", { name: "Pilih SM HENDRIK" }).check();
    await main.locator(".fi-fbar").getByLabel("Principal", { exact: true }).selectOption("KINO");
    await expect(page).toHaveURL(/principle=KINO/);
    const info = main.getByRole("status").filter({ hasText: "3 penerima terpilih tidak terlihat karena saringan" });
    await expect(info).toContainText("ANI, YARMAN, HENDRIK");
    await expect(info).toContainText("SPV dan SM tidak berprincipal");
    await expect(main.locator(".fi-ftb")).toContainText("5 dipilih");
    await expect(main.locator(".fi-ftb")).toContainText("3 di luar saringan");
    await page.screenshot({ path: "test-results/fiori-insentif-bayar-luar-saringan.png", fullPage: true });

    await main.locator(".fi-ftb").getByRole("button", { name: "Tandai 5 lunas…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("3 ikut ditandai: ANI, YARMAN, HENDRIK");
    await dlg.getByRole("button", { name: "Tandai lunas" }).click();
    await expect(dlg.getByRole("alert")).toContainText("4 pembayaran berhasil, 1 gagal. Pilihan yang gagal tetap dipertahankan.");
    await expect(dlg.getByRole("alert")).toContainText("YARMAN: SPV:YARMAN: di luar cakupan Anda.");
    await expect(dlg.getByRole("heading", { name: "Tandai 1 penerima September 2026 lunas?" })).toBeVisible();
    expect(kirim).toHaveLength(5);
    await page.screenshot({ path: "test-results/fiori-insentif-bayar-gagal-sebagian.png" });
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(main.getByRole("status").filter({ hasText: "4 pembayaran September 2026 ditandai lunas" })).toBeVisible();

    await main.getByRole("status").filter({ hasText: "1 penerima terpilih tidak terlihat" }).getByRole("button", { name: "Tampilkan" }).click();
    await expect(page).not.toHaveURL(/principle=/);
    await expect(main.getByRole("checkbox", { name: "Pilih SPV YARMAN" })).toBeChecked();
});

test("Pembayaran: galat pembayaran/SPV bukan kosong dan mengunci penandaan; ponsel 390 px memilih dari daftar", async ({ page }) => {
    let mode: "galat" | "spv" | "isi" = "galat";
    await mockBayar(page, {
        payments: () => (mode === "galat" ? json({ error: "Koneksi database terputus" }, 500) : json({ rows: PAYMENTS })),
        spv: () => (mode === "spv" ? json({ error: "Koneksi database terputus" }, 500) : json({ rows: [] })),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pembayaran?month=9&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("alert").filter({ hasText: "Data pembayaran belum berhasil dimuat." })).toContainText("tidak terlihat sebagai belum dibayar", NAV);
    await expect(main.getByText(/Belum ada insentif/)).toHaveCount(0);

    mode = "spv";
    await page.reload(NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Insentif SPV belum berhasil dimuat (Koneksi database terputus)." })).toContainText("total bulan ini belum termasuk SPV", NAV);
    await expect(main.getByRole("table", { name: "Insentif September 2026" }).locator("tbody tr").filter({ hasText: "ANI" })).toHaveCount(0);
    // Sumber gagal → kotak pilih dan Tandai lunas terkunci; ubin bulan ini "Belum lengkap", bukan Lunas.
    await expect(main.getByRole("checkbox", { name: "Pilih Andi Pratama KINO" })).toBeDisabled();
    await expect(main.locator(".fi-ftb")).toContainText("Data insentif SPV gagal dimuat — muat ulang dulu sebelum menandai");
    await expect(main.locator(".fi-ftb").getByRole("button", { name: "Tandai lunas…" })).toBeDisabled();
    await expect(main.getByRole("group", { name: "Pilih bulan 2026" }).getByRole("button", { name: /September/ })).toContainText("Belum lengkap");

    mode = "isi";

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload(NAV);
    await expect(main.getByRole("list", { name: "Insentif September 2026" })).toBeVisible(NAV);
    await noOverflow(page);
    await main.getByRole("checkbox", { name: "Pilih Andi Pratama KINO" }).check();
    await expect(main.locator(".fi-ftb")).toContainText("1 dipilih");
    await page.screenshot({ path: "test-results/fiori-insentif-bayar-ponsel.png", fullPage: true });
});

test("Pembayaran: muat ulang status gagal setelah Tandai lunas → tampilan diganti galat, tidak ada POST kedua, tanpa 'HTTP 500'", async ({ page }) => {
    const kirim = await mockBayar(page, { gagalBacaSetelahTulis: true });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pembayaran?month=9&year=2026", NAV);
    const main = page.locator("main");
    await main.getByRole("checkbox", { name: "Pilih Andi Pratama KINO" }).check(NAV);
    await main.locator(".fi-ftb").getByRole("button", { name: "Tandai 1 lunas…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Tandai lunas" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Data pembayaran belum berhasil dimuat." })).toContainText("tidak terlihat sebagai belum dibayar", NAV);
    await expect(main.getByText(/HTTP \d+/)).toHaveCount(0);
    await expect(main.getByRole("checkbox")).toHaveCount(0);
    await expect(main.getByRole("button", { name: /Tandai/ })).toHaveCount(0);
    await expect(main.getByText("Belum dibayar", { exact: true })).toHaveCount(0);
    expect(kirim).toHaveLength(1);
});

test("Pembayaran kosong: periode belum dihitung", async ({ page }) => {
    await mockBayar(page, { rows: [] });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pembayaran?month=10&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Belum ada insentif Oktober 2026")).toBeVisible(NAV);
    await expect(main.getByRole("group", { name: "Pilih bulan 2026" }).getByRole("button", { name: /Oktober/ })).toHaveAttribute("aria-pressed", "true");
});

// ── Support principal ───────────────────────────────────────────────────────
const ROWS_SUP = [
    baris("MKS-07", "Andi Pratama", "KINO", "GT", "ANI"),
    baris("MKS-21", "Rudi Hartono", "GODREJ", "GT", "MARTEN", {
        statusInsentif: "distributor", support: 300_000, target: { value: 400_000_000, ec: 600, ao: 180, ia: 30, isq: 0.25, splm: 0 },
        pct: { value: 88, ec: 90, ao: 83.3, isq: 100, total: 90 }, real: { value: 352_000_000, ec: 540, ao: 150, ia: 40, isq: 0.27 }, incentive: nol,
    }),
    baris("MKS-30", "Yusuf Amir", "VINDA", "GT", "YARMAN  S", { statusInsentif: "principle", incentive: nol }),
    baris("MKS-40", "Dodi Kurniawan", "MOTASA", "GT", "ANI", { statusInsentif: "principle", incentive: nol }),
    baris("MKS-12", "Bayu Saputra", "KINO", "MT", "ANI", { ambangAo: 120, incentive: { value: 350_000, ec: 150_000, ao: 131_500, isq: 350_000, total: 981_500 } }),
];

async function mockSup(page: Page, opsi: { dash?: () => ReturnType<typeof json>; spvSupport?: () => ReturnType<typeof json>; support?: () => ReturnType<typeof json> | "putus" } = {}) {
    const kirim: Kirim[] = [];
    const catat = (r: Route) => { kirim.push({ method: r.request().method(), url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() }); };
    await page.route(path("/api/insentif-sales/dashboard"), (r) => r.fulfill(opsi.dash ? opsi.dash() : json(dashboard(ROWS_SUP))));
    await page.route(path("/api/insentif-sales/spv-support"), (r) => {
        if (r.request().method() === "GET") return r.fulfill(opsi.spvSupport ? opsi.spvSupport() : json({ rows: [{ spvName: "MARTEN", principle: "GODREJ", supportAmount: 4_170_000 }] }));
        catat(r);
        return r.fulfill(json({ upserted: 5 }));
    });
    // Server menyimpan kunci lewat pasanganKey: spasi ganda dirapikan.
    await page.route(path("/api/insentif-sales/spv-ikut"), (r) => {
        if (r.request().method() === "GET") return r.fulfill(json({ ikut: ["YARMAN S|VINDA"] }));
        catat(r);
        return r.fulfill(json({ ikut: true }));
    });
    await page.route(path("/api/insentif-sales/support"), (r) => {
        catat(r);
        const jawab = opsi.support ? opsi.support() : json({ upserted: 5 });
        return jawab === "putus" ? r.abort("failed") : r.fulfill(jawab);
    });
    await page.route(path("/api/insentif-sales/targets/status"), (r) => { catat(r); return r.fulfill(json({ updated: 1, tidakDitemukan: 0 })); });
    await page.route(path("/api/insentif-sales/targets/ao-file"), (r) => { catat(r); return r.fulfill(json({ pakaiFile: true })); });
    return kirim;
}

test("Support: draf per baris → Simpan & hitung ulang lewat dialog (payload support + status diperiksa), sukses", async ({ page }) => {
    const kirim = await mockSup(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/support?month=9&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Support principal" })).toBeVisible(NAV);
    const sales = main.getByRole("table", { name: "Support sales" });
    await expect(sales.locator("tbody tr")).toHaveCount(5, NAV);
    await expect(sales.getByRole("columnheader", { name: "Insentif (hitung terakhir)" })).toBeVisible();
    await expect(sales.locator("tbody tr").filter({ hasText: "MKS-21" })).toContainText("belum 90,0%");
    await expect(main.locator(".fi-ftb").getByRole("button", { name: "Simpan & hitung ulang…" })).toBeDisabled();

    await main.getByRole("spinbutton", { name: "Support MKS-07 KINO" }).fill("250000");
    await main.getByRole("combobox", { name: "Status insentif MKS-21 GODREJ" }).selectOption("distributor_principle");
    await expect(sales.locator("tbody tr").filter({ hasText: "MKS-07" })).toContainText("diubah");
    await expect(sales.locator("tbody tr").filter({ hasText: "MKS-07" })).toContainText("sebelumnya Rp 0");
    await expect(sales.locator("tbody tr").filter({ hasText: "MKS-21" })).toContainText("sebelumnya Distributor");
    await expect(main.getByText("Draf belum disimpan")).toBeVisible();
    await expect(main.locator(".fi-ftb")).toContainText("2 perubahan di 2 baris belum disimpan");
    await page.screenshot({ path: "test-results/fiori-insentif-support-draf.png", fullPage: true });

    await main.locator(".fi-ftb").getByRole("button", { name: "Simpan & hitung ulang…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Simpan 2 perubahan dan hitung ulang September 2026?" })).toBeVisible();
    await expect(dlg).toContainText("Support Rp 0 → Rp 250.000");
    await expect(dlg).toContainText("Status Distributor → Distributor + Principle");
    await expect(dlg).toContainText("support principle dikurangkan dari pool");
    await expect(dlg.getByText("usulan BL-33")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-insentif-support-dialog.png" });
    await dlg.getByRole("button", { name: "Simpan & hitung ulang" }).click();
    await expect(dlg).toBeHidden();

    expect(kirim.map((k) => `${k.method} ${k.url}`)).toEqual(["POST /api/insentif-sales/support", "PATCH /api/insentif-sales/targets/status"]);
    expect(kirim[0].body).toEqual([
        { salesCode: "MKS-07", principle: "KINO", periodMonth: 9, periodYear: 2026, supportAmount: 250_000 },
        { salesCode: "MKS-21", principle: "GODREJ", periodMonth: 9, periodYear: 2026, supportAmount: 300_000 },
        { salesCode: "MKS-30", principle: "VINDA", periodMonth: 9, periodYear: 2026, supportAmount: 0 },
        { salesCode: "MKS-40", principle: "MOTASA", periodMonth: 9, periodYear: 2026, supportAmount: 0 },
        { salesCode: "MKS-12", principle: "KINO", periodMonth: 9, periodYear: 2026, supportAmount: 0 },
    ]);
    expect(kirim[1].body).toEqual([{ salesCode: "MKS-21", principle: "GODREJ", periodMonth: 9, periodYear: 2026, statusInsentif: "distributor_principle" }]);
    await expect(main.getByRole("status").filter({ hasText: "2 perubahan tersimpan" })).toContainText("insentif September 2026 dihitung ulang");
    await expect(main.locator(".fi-ftb")).toContainText("Belum ada perubahan");
});

test("Support: galat 400 server tampil di dialog dan halaman, tidak ada yang berubah, draf tetap; jaringan putus = hasil tidak pasti", async ({ page }) => {
    let putus = false;
    const kirim = await mockSup(page, { support: () => (putus ? "putus" : json({ error: "Support tidak valid: MKS-07/KINO (-5)" }, 400)) });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/support?month=9&year=2026", NAV);
    const main = page.locator("main");
    await main.getByRole("spinbutton", { name: "Support MKS-07 KINO" }).fill("-5", NAV);
    await main.getByRole("combobox", { name: "Status insentif MKS-21 GODREJ" }).selectOption("distributor_principle");
    await main.locator(".fi-ftb").getByRole("button", { name: "Simpan & hitung ulang…" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Simpan & hitung ulang" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Support tidak valid: MKS-07/KINO (-5) Tidak ada yang diubah.");
    expect(kirim.map((k) => k.url)).toEqual(["/api/insentif-sales/support"]); // status tidak dikirim
    await page.screenshot({ path: "test-results/fiori-insentif-support-galat.png" });
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Tidak ada yang diubah." })).toBeVisible();
    await expect(main.locator(".fi-ftb")).toContainText("2 perubahan di 2 baris belum disimpan");
    await expect(main.getByRole("spinbutton", { name: "Support MKS-07 KINO" })).toHaveValue("-5");

    putus = true;
    await main.locator(".fi-ftb").getByRole("button", { name: "Simpan & hitung ulang…" }).click();
    await dlg.getByRole("button", { name: "Simpan & hitung ulang" }).click();
    await expect(dlg.getByRole("alert")).toContainText("hasilnya tidak pasti — muat ulang untuk memeriksa");
    await expect(dlg.getByRole("alert")).not.toContainText("Tidak ada yang diubah");
    await expect(dlg.getByRole("alert")).not.toContainText("Failed to fetch");
    expect(kirim.map((k) => k.url)).toEqual(["/api/insentif-sales/support", "/api/insentif-sales/support"]);
});

test("Support: isian bukan angka tidak diam-diam jadi Rp 0 — Simpan dikunci, tidak ada yang dikirim; kosong tetap 0", async ({ page }) => {
    const kirim = await mockSup(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/support?month=9&year=2026", NAV);
    const main = page.locator("main");
    // MKS-21 tersimpan Rp 300.000. "1e"/"e" = isian number tak terbaca: peramban melaporkan value "" (badInput), dulu terkirim sebagai 0.
    const isi = main.getByRole("spinbutton", { name: "Support MKS-21 GODREJ" });
    const baris21 = main.getByRole("table", { name: "Support sales" }).locator("tbody tr").filter({ hasText: "MKS-21" });
    const simpan = main.locator(".fi-ftb").getByRole("button", { name: "Simpan & hitung ulang…" });
    await isi.fill("", NAV);
    await isi.pressSequentially("1e");
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", /bukan angka/);
    await expect(baris21).toContainText("bukan angka");
    await isi.press("Backspace"); // "1" sah lagi
    await expect(baris21).not.toContainText("bukan angka");
    // "" → "e": value DOM tetap "" sehingga React menahan onChange — tanpa onInput ini terkirim sebagai 0.
    await isi.fill("");
    await isi.pressSequentially("e");
    await expect(simpan).toBeDisabled();
    await expect(baris21).toContainText("bukan angka");
    expect(kirim).toHaveLength(0);
    // Dikosongkan = 0 (kebijakan kolom kosong) tetap boleh disimpan.
    await isi.press("Backspace");
    await expect(baris21).not.toContainText("bukan angka");
    await expect(simpan).toBeEnabled();
    await simpan.click();
    await page.getByRole("dialog").getByRole("button", { name: "Simpan & hitung ulang" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect((kirim[0].body as Array<{ salesCode: string; supportAmount: unknown }>).find((r) => r.salesCode === "MKS-21")?.supportAmount).toBe(0);
});

test("Support: Excel — baris di luar periode tidak membatalkan impor, \"-\" = Rp 0, teks lain di baris periode menolak", async ({ page }) => {
    const kirim = await mockSup(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/support?month=9&year=2026", NAV);
    const main = page.locator("main");
    const berkas = (rows: unknown[][]) => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Kode Salesman", "Nama", "Principal", "Support (Rp)"], ...rows]), "Support Sales");
        return { name: "support.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer };
    };
    const input = main.getByLabel("Berkas Excel support sales");
    await expect(main.getByRole("table", { name: "Support sales" }).locator("tbody tr")).toHaveCount(5, NAV);
    // S-LAIN tidak ada di periode ini → dilewati; teks tidak validnya tidak boleh membatalkan baris yang dipakai.
    await input.setInputFiles(berkas([["MKS-07", "", "KINO", 250000], ["MKS-21", "", "GODREJ", "-"], ["S-LAIN", "", "KINO", "N/A"]]));
    await expect(main.getByRole("status").filter({ hasText: "2 baris support sales terisi dari Excel" })).toContainText("1 baris dilewati");
    await expect(main.getByRole("spinbutton", { name: "Support MKS-07 KINO" })).toHaveValue("250000");
    await expect(main.getByRole("spinbutton", { name: "Support MKS-21 GODREJ" })).toHaveValue("0");
    // Baris periode dengan teks bukan angka tetap menolak seluruh berkas.
    await input.setInputFiles(berkas([["MKS-07", "", "KINO", 300000], ["MKS-12", "", "KINO", "N/A"]]));
    await expect(main.getByRole("alert").filter({ hasText: "bernilai tidak valid (mis. MKS-12/KINO)" })).toBeVisible();
    await expect(main.getByRole("spinbutton", { name: "Support MKS-07 KINO" })).toHaveValue("250000");
    expect(kirim).toHaveLength(0);
});

test("Support: hitung untuk SPV dan penyebut AO lewat dialog yang menyebut akibatnya; kunci SPV dinormalisasi seperti server", async ({ page }) => {
    const kirim = await mockSup(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/support?month=9&year=2026", NAV);
    const main = page.locator("main");
    const spv = main.getByRole("table", { name: "Support SPV" });
    await expect(spv.locator("tbody tr")).toHaveCount(4, NAV); // ANI×KINO (2 sales), ANI×MOTASA, MARTEN×GODREJ, YARMAN  S×VINDA
    await expect(main.getByRole("spinbutton", { name: "Support SPV MARTEN GODREJ" })).toHaveValue("4170000");
    // "YARMAN  S" (spasi ganda) cocok dengan "YARMAN S|VINDA" dari server — dulu /s+/ tidak merapikan spasi.
    await expect(spv.getByRole("button", { name: /Dihitung untuk SPV: VINDA untuk YARMAN\s+S/ })).toHaveAttribute("aria-pressed", "true");

    await spv.getByRole("button", { name: /Hitung untuk SPV: MOTASA untuk ANI/ }).click();
    let dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Hitung MOTASA untuk SPV ANI periode September 2026?" })).toBeVisible();
    await expect(dlg).toContainText("rate per principal-nya ikut berubah");
    await dlg.getByRole("button", { name: "Hitung untuk SPV" }).click();
    await expect(dlg).toBeHidden();
    expect(kirim[0]).toEqual({ method: "PATCH", url: "/api/insentif-sales/spv-ikut", body: { spvName: "ANI", principle: "MOTASA", periodMonth: 9, periodYear: 2026, ikut: true } });

    await main.getByRole("button", { name: "Pakai target file (180) untuk MKS-21 GODREJ…" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Nilai AO MKS-21 / GODREJ terhadap Target AO file?" })).toBeVisible();
    await expect(dlg).toContainText("÷ 240 → ÷ 180");
    await expect(dlg).toContainText("nominal AO-nya dihitung ulang");
    await dlg.getByRole("button", { name: "Pakai target file" }).click();
    await expect(dlg).toBeHidden();
    expect(kirim[1]).toEqual({ method: "PATCH", url: "/api/insentif-sales/targets/ao-file", body: { salesCode: "MKS-21", principle: "GODREJ", periodMonth: 9, periodYear: 2026, pakaiFile: true } });
    await expect(main.getByRole("status").filter({ hasText: "AO MKS-21/GODREJ → ÷ 180" })).toBeVisible();
});

test("Support: kosong = target belum diunggah; galat dashboard/support SPV bukan kosong; ponsel 390 px", async ({ page }) => {
    let mode: "kosong" | "galat" | "isi" = "kosong";
    await mockSup(page, {
        dash: () => (mode === "kosong" ? json(dashboard([])) : mode === "galat" ? json({ error: "Koneksi database terputus" }, 500) : json(dashboard(ROWS_SUP))),
        spvSupport: () => (mode === "isi" ? json({ error: "Koneksi database terputus" }, 500) : json({ rows: [] })),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/support?month=9&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Target September 2026 belum diunggah")).toBeVisible(NAV);
    await expect(main.getByRole("link", { name: "Buka Data periode" })).toHaveAttribute("href", "/insentif-sales/data-periode?month=9&year=2026");

    mode = "galat";
    await page.reload(NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Data insentif belum berhasil dimuat" })).toBeVisible(NAV);
    await expect(main.getByText(/belum diunggah/)).toHaveCount(0);

    mode = "isi";
    await page.reload(NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Support SPV belum berhasil dimuat." })).toContainText("tidak tertimpa nol", NAV);
    await expect(main.getByRole("spinbutton", { name: /Support SPV/ })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload(NAV);
    await expect(main.getByRole("list", { name: "Support sales" })).toBeVisible(NAV);
    await noOverflow(page);
    await main.getByRole("spinbutton", { name: "Support MKS-07 KINO" }).fill("100000");
    await expect(main.locator(".fi-ftb")).toContainText("1 perubahan di 1 baris belum disimpan");
    await page.screenshot({ path: "test-results/fiori-insentif-support-ponsel.png", fullPage: true });
});
