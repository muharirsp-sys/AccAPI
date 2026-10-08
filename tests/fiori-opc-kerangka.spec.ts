/*
 * Tujuan: Fiori S4d OFF Program Control — kerangka: tiap tab membuka antreannya (predikat kode lama), `?batch=` membuka Object
 *   Page di kolom kedua (desktop) / layar detail + "Kembali ke daftar" (ponsel 390 px, tanpa gulir menyamping), tautan lama
 *   (`?tab=sales` Beranda, `?tab=claim&claimView=after` Claim Workflow), peran dari sesi (Klaim hanya Klaim + Log audit),
 *   galat daftar/detail ≠ kosong (juga di lonceng dan pencarian), kosong, saringan, lonceng (klik kedua menutup) dan pencarian membuka
 *   batch, penjaga draf (tujuan sama tanpa dialog; "Tinggalkan" tidak mematikan penjaga bila form tetap terbuka), tulisOpc (504 HTML
 *   = hasil tidak pasti; 4xx JSON = pesan server), tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = admin):
 *   `npx playwright test tests/fiori-opc-kerangka.spec.ts --config playwright.fiori-local.config.ts`.
 * Dependensi: /api/off-program-control/* dan /api/auth/get-session di-mock dengan page.route (tidak menyentuh DB).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const lalu = (hari: number) => new Date(Date.now() - hari * 864e5).toISOString();
const kini = lalu(0);
type Over = Record<string, unknown>;

const batch = (id: string, no: string, principleCode: string, principleName: string, over: Over = {}) => ({
    id, noPengajuan: no, gelombang: no.slice(0, 3), principleCode, principleName, bulan: no.split("/").at(-2), tahun: "2026",
    supervisorName: "Rahmat", status: "Draft", smStatus: "Not Started", claimStatus: "Not Started", omStatus: "Not Started",
    financeStatus: "Not Started", finalStatus: "Not Started", locked: false, createdBy: "u-spv", createdByRole: "supervisor",
    refundStatus: "Not Applicable", createdAt: kini, updatedAt: kini, payments: [],
    summary: { totalNominal: 4_300_000, totalRows: 2, transfer: 4_300_000, tunai: 0 },
    periodDates: { pengajuan: ["2026-10-02"], program: [], claim: [], bayar: [] }, ...over,
});
const SM = { smStatus: "Approved by SM", locked: true };
const KL = { ...SM, claimStatus: "Approved" };
const OMOK = { ...KL, omStatus: "Approved" };
const BATCHES = [
    batch("b-sm1", "007/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", { status: "Submitted to SM", smStatus: "Waiting Review", submittedAt: lalu(20), summary: { totalNominal: 18_742_500, totalRows: 4 } }),
    batch("b-sm2", "011/HEINZ/10/2026", "HEINZ", "HEINZ ABC INDONESIA, PT", { status: "Submitted to SM", smStatus: "Waiting Review", submittedAt: kini, supervisorName: "Zul" }),
    batch("b-ret", "006/ENI/10/2026", "ENI", "ENERGIZER INDONESIA, PT", { status: "Returned by SM", smStatus: "Returned", smNote: "Nominal TK Mulia melebihi surat program.", returnedAt: kini }),
    batch("b-draf", "009/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT"),
    batch("b-klaim", "005/GDI/10/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { status: "Approved by SM", ...SM, omStatus: "Notify OM", smApprovedAt: kini }),
    batch("b-om", "002/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", { status: "Claim Approved", ...KL, omStatus: "Waiting Approval", claimReviewedAt: kini, claimSubmittedDate: "2026-10-05", claimDeadline: "2099-11-05" }),
    batch("b-bayar", "004/URC/09/2026", "URC", "URC INDONESIA, PT", { status: "OM Approved", ...OMOK, financeStatus: "Waiting Payment", claimWorkflowId: "wf-1", claimWorkflowStatus: "Draft", bulan: "09", claimDeadline: "2099-10-30", periodDates: { pengajuan: ["2026-09-20"] } }),
    batch("b-final", "001/RB/09/2026", "RB", "RECKITT BENCKISER, PT", { status: "Paid", ...OMOK, financeStatus: "Paid", finalStatus: "Waiting Claim Final Verification", paidAt: kini, bulan: "09", paymentSummary: { totalNominal: 4_300_000, totalPaid: 4_300_000, remainingAmount: 0, isFullyPaid: true }, periodDates: { pengajuan: ["2026-09-03"] } }),
    batch("b-selesai", "003/GDI/09/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { status: "Completed", ...OMOK, financeStatus: "Paid", finalStatus: "Completed", bulan: "09" }),
    batch("b-clm", "001/CLM/GDI/10/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { createdByRole: "claim", supervisorName: "Rina (Claim)" }),
];
const item = (id: string, itemNo: number, toko: string, nominal: number, over: Over = {}) => ({
    id, itemNo, noSurat: "KINO/PRG/0931", namaProgram: "Display Zwitsal Okt", periode: "2026-10-01 - 2026-10-31", toko, barang: null, nominal,
    caraBayar: "Transfer", type: "Display", deadline: "2026-10-31", kwt: true, skp: true, fp: false, pc: false, foto: true, rekap: true, others: false, othersText: null, ...over,
});
const AUDIT = [
    { id: "a1", batchId: "b-sm1", actorName: "Rahmat", actorRole: "supervisor", action: "create_batch", toStatus: "Draft", createdAt: lalu(21) },
    { id: "a2", batchId: "b-sm1", actorName: "Rahmat", actorRole: "supervisor", action: "submit_to_sm", fromStatus: "Draft", toStatus: "Submitted to SM", createdAt: lalu(20) },
];
function detail(id: string) {
    const b = BATCHES.find((x) => x.id === id)!;
    const { claimWorkflowId: _w, claimWorkflowStatus: _s, ...dto } = b as Over; // GET /batches/[id] tidak membawa agregat Claim Workflow
    void _w; void _s;
    const bayar = id === "b-final" ? [{ id: "p1", batchId: id, paymentNo: 1, paymentDate: "2026-10-06", paymentMethod: "Transfer", paidAmount: 4_300_000, senderBank: "BCA", paymentProofName: "bukti_rb.pdf", proofUrl: "/api/off-program-control/payments/p1/proof", note: null }] : [];
    return { ok: true, batch: dto, items: [item(`${id}-i1`, 1, "TK Mulia", 2_200_000), item(`${id}-i2`, 2, "UD Sejahtera", 2_100_000, { caraBayar: "Tunai" })], payments: bayar,
        summary: { totalRows: 2, totalNominal: 4_300_000, transfer: 2_200_000, tunai: 2_100_000 },
        paymentSummary: { totalNominal: 4_300_000, totalPaid: bayar.length ? 4_300_000 : 0, remainingAmount: bayar.length ? 0 : 4_300_000, isFullyPaid: bayar.length > 0 } };
}

type Respon = { status: number; contentType: string; body: string };
type Opsi = { daftar?: () => Respon; detail?: (id: string) => Respon | null; peran?: string; tulis?: (method: string, path: string) => Respon | null };
/** Semua endpoint OPC dimock. Mengembalikan daftar permintaan bukan-GET (harus kosong: kerangka tidak menulis). */
async function mockOpc(page: Page, opsi: Opsi = {}) {
    const tulis: string[] = [];
    if (opsi.peran) {
        await page.route((u) => u.pathname === "/api/auth/get-session", (r) => r.fulfill(json({
            session: { id: "s1", userId: "u-1", token: "t", expiresAt: lalu(-1), createdAt: kini, updatedAt: kini },
            user: { id: "u-1", name: "Rina Amalia", email: "rina@example.invalid", emailVerified: true, role: opsi.peran, createdAt: kini, updatedAt: kini },
        })));
    }
    await page.route((u) => u.pathname.startsWith("/api/off-program-control/"), (r) => {
        const req = r.request();
        const p = new URL(req.url()).pathname;
        if (req.method() !== "GET") { tulis.push(`${req.method()} ${p}`); return r.fulfill(opsi.tulis?.(req.method(), p) ?? json({ ok: false, error: "tidak boleh menulis" }, 405)); }
        if (p === "/api/off-program-control/batches") return r.fulfill(opsi.daftar ? opsi.daftar() : json({ ok: true, batches: BATCHES }));
        if (p === "/api/off-program-control/audit") return r.fulfill(json({ ok: true, audit: AUDIT.map((a) => ({ ...a, noPengajuan: "007/KINO/10/2026", principleName: "KINO" })) }));
        const m = /^\/api\/off-program-control\/batches\/([^/]+)(?:\/(refund|audit))?$/.exec(p);
        if (!m) return r.fulfill(json({ ok: false, error: "tidak dimock" }, 404));
        const id = decodeURIComponent(m[1]);
        if (m[2] === "refund") {
            if (id === "b-final") return r.fulfill(json({ ok: true,
                refunds: [{ id: "r1", batchId: id, refundNo: 1, refundAmount: 450_000, refundMethod: "Transfer", refundDate: "2026-10-07", senderName: "Zul", note: "Transfer balik selisih", status: "Pending" }],
                summary: { paidAmount: 4_300_000, verifiedAmount: 3_850_000, overpaidAmount: 450_000, totalRefunded: 0, pendingRefund: 450_000, remainingRefund: 450_000, isFullyRefunded: false } }));
            return r.fulfill(json({ ok: true, refunds: [], summary: { paidAmount: 0, verifiedAmount: 0, overpaidAmount: 0, totalRefunded: 0, pendingRefund: 0, remainingRefund: 0, isFullyRefunded: false } }));
        }
        if (m[2] === "audit") return r.fulfill(json({ ok: true, audit: AUDIT.filter((a) => a.batchId === id) }));
        return r.fulfill(opsi.detail?.(id) ?? json(detail(id)));
    });
    return tulis;
}

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
const antrean = (page: Page) => page.locator("main").getByRole("list", { name: /^Antrean / });

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("tiap tab membuka antreannya (predikat kode lama); Ringkasan per tahap; Log audit", async ({ page }) => {
    const tulis = await mockOpc(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "OFF Program Control" })).toBeVisible(NAV);
    await expect(main.getByRole("group", { name: "Batch per tahap" }).getByRole("button", { name: /Menunggu SM/ })).toContainText("2", NAV);
    await expect(main.getByText("1 lewat SLA")).toBeVisible();
    const nav = main.getByRole("navigation", { name: "Antrean OFF Program Control" });
    await expect(nav.getByRole("link")).toHaveCount(7);
    await page.screenshot({ path: "test-results/fiori-opc-ringkasan.png", fullPage: true });

    const harap: Array<[string, string[]]> = [
        ["Supervisor", ["006/ENI/10/2026", "009/KINO/10/2026", "001/CLM/GDI/10/2026"]],
        ["Sales Manager", ["007/KINO/10/2026", "011/HEINZ/10/2026"]],
        ["Klaim", ["005/GDI/10/2026"]],
        ["Operational Manager", ["002/KINO/10/2026"]],
        ["Keuangan", ["004/URC/09/2026"]],
    ];
    for (const [tab, nomor] of harap) {
        await nav.getByRole("link", { name: new RegExp(`^${tab}`) }).click();
        await expect(nav.getByRole("link", { name: new RegExp(`^${tab}`) })).toHaveAttribute("aria-current", "page");
        await expect(antrean(page).getByRole("button")).toHaveCount(nomor.length, NAV);
        for (const n of nomor) await expect(antrean(page)).toContainText(n);
    }
    // Klaim: tiga tampilan claimView; Verifikasi final = isFinalClaimProcessable.
    await nav.getByRole("link", { name: /^Klaim/ }).click();
    const tampilan = main.getByRole("group", { name: "Tampilan antrean" });
    await tampilan.getByRole("button", { name: /Verifikasi final/ }).click();
    await expect(page).toHaveURL(/claimView=after-finance/);
    await expect(antrean(page)).toContainText("001/RB/09/2026");
    // "Semua" = daftar tab lama (pemantauan): Keuangan memuat juga batch yang sudah dibayar.
    await nav.getByRole("link", { name: /^Keuangan/ }).click();
    await main.getByRole("group", { name: "Cakupan antrean" }).getByRole("button", { name: /Semua/ }).click();
    await expect(antrean(page)).toContainText("001/RB/09/2026");
    await expect(antrean(page)).toContainText("003/GDI/09/2026");

    await nav.getByRole("link", { name: /^Log audit/ }).click();
    const log = main.getByRole("table", { name: "Log audit OFF Program Control" });
    await expect(log.locator("tbody tr")).toHaveCount(2, NAV);
    await expect(log).toContainText("Mengirim ke SM");
    expect(tulis).toEqual([]);
});

test("?batch= membuka Object Page di kolom kedua: header, Flow 7 tahap, lewat SLA, item, riwayat, alur dokumen (aksi peran diuji di spec peran)", async ({ page }) => {
    const tulis = await mockOpc(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=sales&batch=b-sm1", NAV);
    const main = page.locator("main");
    const detail = main.getByRole("region", { name: "Batch terbuka" });
    await expect(detail.getByRole("heading", { level: 1, name: "007/KINO/10/2026" })).toBeVisible(NAV);
    await expect(antrean(page).getByRole("button", { name: /007\/KINO\/10\/2026/ })).toHaveAttribute("aria-current", "true");
    await expect(detail.getByText("Menunggu SM").first()).toBeVisible();
    const flow = detail.getByRole("list", { name: "Tahap batch" });
    await expect(flow.getByRole("listitem")).toHaveCount(7);
    await expect(flow.locator('[aria-current="step"]')).toContainText("SM");
    await expect(flow.locator('[aria-current="step"]')).toHaveAttribute("data-state", "late");
    await expect(detail.getByText("Lewat SLA: Sales Manager belum review.")).toBeVisible();
    await expect(detail.getByRole("navigation", { name: "Bagian halaman" }).getByRole("link")).toContainText(["Item", "Validasi klaim", "Pembayaran", "Riwayat", "Alur dokumen"]); // bagian bersama; modul peran boleh menyisipkan bagian sendiri
    await expect(detail.getByRole("table", { name: "Item batch" }).locator("tbody tr")).toHaveCount(2);
    await expect(detail.getByRole("list", { name: "Riwayat aksi" }).getByRole("listitem").first()).toContainText("Rahmat (SPV) · Mengirim ke SM");
    await expect(detail.getByText("Dikirim ke Sales Manager").first()).toBeVisible(); // enam sumbu status, label Indonesia
    await expect(detail.getByText("Belum ada pembayaran")).toBeVisible();
    await expect(detail.getByText("Tidak ada selisih yang perlu dikembalikan.")).toBeVisible();
    for (const bl of ["BL-11", "BL-07", "BL-33", "BL-35"]) await expect(detail.getByLabel(`Usulan ${bl}`).first()).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-opc-objectpage.png", fullPage: true });

    // Alur dokumen menaut Claim Workflow bila daftar membawa relasinya; pindah batch lewat daftar.
    await page.goto("/off-program-control?tab=finance", NAV);
    await antrean(page).getByRole("button", { name: /004\/URC\/09\/2026/ }).click();
    await expect(page).toHaveURL(/batch=b-bayar/);
    await expect(detail.getByRole("link", { name: /Claim Workflow/ })).toHaveAttribute("href", "/claim-workflow/wf-1", NAV);
    // Riwayat pengembalian selisih memuat kolom Pengirim dan Catatan seperti RefundPanel lama.
    await page.goto("/off-program-control?tab=overview&batch=b-final", NAV);
    const riwayatRefund = detail.getByRole("table", { name: "Riwayat pengembalian" });
    await expect(riwayatRefund.locator("th", { hasText: "Pengirim" })).toBeAttached(NAV); // kolom secondary: tersembunyi di wadah sempit, isinya pindah ke pop-in
    await expect(riwayatRefund.locator("tbody tr")).toHaveCount(1);
    await expect(riwayatRefund.locator("tbody tr")).toContainText("Zul");
    await expect(riwayatRefund.locator("tbody tr")).toContainText("Transfer balik selisih");
    await expect(detail.getByText("Kelebihan dana")).toBeVisible();
    // Batch dikembalikan: catatan pengembalian tampil, badge negatif.
    await page.goto("/off-program-control?tab=supervisor&batch=b-ret", NAV);
    await expect(detail.getByRole("alert").filter({ hasText: "Dikembalikan SM: Nominal TK Mulia melebihi surat program." })).toBeVisible(NAV);
    expect(tulis).toEqual([]);
});

test("ponsel 390 px: daftar ↔ layar detail + Kembali ke daftar, item sebagai daftar, tanpa gulir menyamping", async ({ page }) => {
    await mockOpc(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/off-program-control?tab=sales", NAV);
    const main = page.locator("main");
    await expect(antrean(page).getByRole("button")).toHaveCount(2, NAV);
    await noOverflow(page);
    await antrean(page).getByRole("button", { name: /011\/HEINZ\/10\/2026/ }).click();
    await expect(page).toHaveURL(/batch=b-sm2/);
    const detail = main.getByRole("region", { name: "Batch terbuka" });
    await expect(detail.getByRole("heading", { level: 1, name: "011/HEINZ/10/2026" })).toBeVisible(NAV);
    await expect(antrean(page)).toBeHidden();
    await expect(detail.getByRole("list", { name: "Item batch" })).toBeVisible(); // bukan tabel 18 kolom
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-opc-ponsel-detail.png", fullPage: true });
    await detail.getByRole("button", { name: "Kembali ke daftar" }).click();
    await expect(page).not.toHaveURL(/batch=/);
    await expect(antrean(page)).toBeVisible();
    await noOverflow(page);
});

test("peran dari sesi: Klaim hanya Klaim + Log audit; claimView=after (Claim Workflow) membuka Verifikasi final; ?tab=sales jatuh ke Klaim", async ({ page }) => {
    await mockOpc(page, { peran: "claim" });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=claim&claimView=after", NAV);
    const main = page.locator("main");
    const nav = main.getByRole("navigation", { name: "Antrean OFF Program Control" });
    await expect(nav.getByRole("link")).toHaveText([/^Klaim/, /^Log audit/], NAV);
    await expect(main.getByText("Peran OFF: Klaim.")).toBeVisible();
    await expect(main.getByRole("group", { name: "Tampilan antrean" }).getByRole("button", { name: /Verifikasi final/ })).toHaveAttribute("aria-pressed", "true");
    await expect(antrean(page).getByRole("button")).toHaveCount(1);
    await expect(antrean(page)).toContainText("001/RB/09/2026");
    await page.goto("/off-program-control?tab=sales", NAV);
    await expect(nav.getByRole("link", { name: /^Klaim/ })).toHaveAttribute("aria-current", "page", NAV);
    await expect(antrean(page)).toContainText("005/GDI/10/2026");
});

test("galat daftar dan detail tidak tampil sebagai kosong; kosong dan saringan punya kalimat berbeda", async ({ page }) => {
    let gagal = true;
    let kosong = false;
    await mockOpc(page, {
        daftar: () => (gagal ? json({ ok: false, error: "Data pengajuan belum berhasil dimuat. Silakan coba lagi." }, 500) : json({ ok: true, batches: kosong ? [] : BATCHES })),
        detail: (id) => (id === "b-sm2" ? json({ ok: false, error: "Gagal mengambil detail batch." }, 500) : null),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=sales", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Antrean gagal dimuat" })).toBeVisible(NAV);
    await expect(main.getByText("Ini bukan daftar kosong.")).toBeVisible();
    await expect(main.getByText("Tidak ada batch yang menunggu tinjauan Anda.")).toHaveCount(0);
    // Lonceng dan pencarian juga tidak membaca galat sebagai kosong.
    await main.getByRole("button", { name: /Pengajuan bermasalah/ }).click();
    const lonceng = page.getByRole("dialog", { name: "Pengajuan bermasalah" });
    await expect(lonceng).toContainText("Daftar pengajuan gagal dimuat");
    await expect(lonceng).not.toContainText("Tidak ada pengajuan yang lewat SLA");
    await page.keyboard.press("Escape");
    await expect(lonceng).toBeHidden();
    await page.keyboard.press("Control+k");
    const cari = main.getByRole("combobox", { name: "Cari pengajuan OFF" });
    await cari.fill("KINO");
    await expect(main.getByRole("listbox", { name: "Hasil pencarian pengajuan OFF" })).toContainText("Daftar pengajuan gagal dimuat, jadi pencarian belum bisa dipakai.");
    await expect(main.getByText("Tidak ditemukan batch yang cocok.")).toHaveCount(0);
    await cari.press("Escape");
    gagal = false;
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(antrean(page).getByRole("button")).toHaveCount(2, NAV);

    // Detail gagal → ErrorState di kolom kedua, daftar tetap.
    await antrean(page).getByRole("button", { name: /011\/HEINZ/ }).click();
    await expect(main.getByRole("heading", { name: "Detail batch gagal dimuat" })).toBeVisible(NAV);
    await expect(main.getByText("Gagal mengambil detail batch.")).toBeVisible();

    // Saringan yang tidak cocok ≠ antrean kosong.
    await main.locator(".fi-fbar-fields").getByLabel("Cari").fill("tidak-ada-yang-cocok");
    await expect(main.getByRole("heading", { name: "Tidak ada batch yang cocok dengan saringan" })).toBeVisible();
    await main.getByRole("button", { name: "Hapus saringan", exact: true }).click();
    await expect(antrean(page).getByRole("button")).toHaveCount(2);
    await main.locator(".fi-fbar-fields").getByLabel("Principal").selectOption("HEINZ");
    await expect(antrean(page).getByRole("button")).toHaveCount(1);
    await expect(main.getByRole("list", { name: "Saringan aktif" })).toContainText("Principal: HEINZ ABC INDONESIA, PT");

    // Antrean kosong (server menjawab daftar kosong).
    kosong = true;
    await page.goto("/off-program-control?tab=sales", NAV);
    await expect(main.getByRole("heading", { name: "Tidak ada batch yang menunggu tinjauan Anda." })).toBeVisible(NAV);
    await page.goto("/off-program-control", NAV);
    await expect(main.getByRole("heading", { name: "Belum ada batch" })).toBeVisible(NAV);
    gagal = true;
    await page.goto("/off-program-control", NAV);
    await expect(main.getByRole("heading", { name: "Ringkasan gagal dimuat" })).toBeVisible(NAV);
});

test("lonceng dan pencarian (Ctrl K) membuka batch di kolom kedua untuk peran apa pun, juga dari Log audit", async ({ page }) => {
    await mockOpc(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=finance", NAV);
    const main = page.locator("main");
    await expect(antrean(page).getByRole("button")).toHaveCount(1, NAV);
    await main.getByRole("button", { name: /Pengajuan bermasalah/ }).click();
    const lonceng = page.getByRole("dialog", { name: "Pengajuan bermasalah" });
    await expect(lonceng).toContainText("007/KINO/10/2026");
    await expect(lonceng).toContainText("Sales Manager belum review");
    await page.screenshot({ path: "test-results/fiori-opc-lonceng.png" });
    // Popover di bawah tombol, tidak menutupinya: klik kedua menutup, klik ketiga membuka lagi.
    const tombolLonceng = main.getByRole("button", { name: /Pengajuan bermasalah/ });
    await tombolLonceng.click();
    await expect(lonceng).toBeHidden();
    await tombolLonceng.click();
    await expect(lonceng).toBeVisible();
    await lonceng.getByRole("button", { name: "Buka pengajuan" }).first().click();
    await expect(page).toHaveURL(/tab=finance.*batch=b-sm1|batch=b-sm1.*tab=finance/);
    await expect(main.getByRole("heading", { level: 1, name: "007/KINO/10/2026" })).toBeVisible(NAV);

    await page.keyboard.press("Control+k");
    const cari = main.getByRole("combobox", { name: "Cari pengajuan OFF" });
    await expect(cari).toBeFocused();
    await cari.fill("HEINZ");
    await expect(main.getByRole("option", { name: /011\/HEINZ\/10\/2026/ })).toBeVisible();
    await cari.press("Enter");
    await expect(page).toHaveURL(/batch=b-sm2/);
    await expect(main.getByRole("heading", { level: 1, name: "011/HEINZ/10/2026" })).toBeVisible(NAV);

    // Log audit tidak punya kolom kedua: batch dibuka di Ringkasan › Semua pengajuan.
    await page.goto("/off-program-control?tab=audit", NAV);
    await main.getByRole("table", { name: "Log audit OFF Program Control" }).getByRole("button", { name: "Buka batch" }).first().click();
    await expect(page).toHaveURL(/tab=overview/);
    await expect(main.getByRole("heading", { level: 1, name: "007/KINO/10/2026" })).toBeVisible(NAV);
    await expect(main.getByRole("group", { name: "Tampilan ringkasan" }).getByRole("button", { name: /Semua pengajuan/ })).toHaveAttribute("aria-pressed", "true");
});

test("penjaga draf: tujuan sama tanpa dialog; Tinggalkan tidak mematikan penjaga selama form tetap terbuka; editor dibongkar mematikannya", async ({ page }) => {
    await mockOpc(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=claim&batch=b-klaim", NAV);
    const main = page.locator("main");
    const ket = main.getByLabel("Keterangan kelengkapan");
    await ket.fill("Faktur pajak item 2 menyusul", NAV);
    const tinggal = page.getByRole("dialog", { name: "Tinggalkan perubahan yang belum disimpan?" });
    const dicegah = () => page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    expect(await dicegah()).toBe(true);

    // Tujuan = URL sekarang (klik batch yang sedang terbuka, Ctrl K ke batch yang sama): tanpa dialog, isian utuh.
    await antrean(page).getByRole("button", { name: /005\/GDI\/10\/2026/ }).click();
    await page.keyboard.press("Control+k");
    await main.getByRole("combobox", { name: "Cari pengajuan OFF" }).fill("005/GDI");
    await main.getByRole("option", { name: /005\/GDI\/10\/2026/ }).click();
    await expect(tinggal).toBeHidden();
    await expect(ket).toHaveValue("Faktur pajak item 2 menyusul");

    // Ganti tampilan (batch sama tetap terbuka): dialog → Tinggalkan; form tidak dibongkar → penjaga tetap hidup.
    await main.getByRole("group", { name: "Tampilan antrean" }).getByRole("button", { name: /Verifikasi final/ }).click();
    await expect(tinggal).toBeVisible();
    await tinggal.getByRole("button", { name: "Tinggalkan" }).click();
    await expect(page).toHaveURL(/claimView=after-finance/);
    await expect(page).toHaveURL(/batch=b-klaim/);
    await expect(ket).toHaveValue("Faktur pajak item 2 menyusul");
    expect(await dicegah()).toBe(true);
    await antrean(page).getByRole("button", { name: /001\/RB\/09\/2026/ }).click();
    await expect(tinggal).toBeVisible(); // penjaga masih bekerja
    await tinggal.getByRole("button", { name: "Batal" }).click();
    await expect(page).toHaveURL(/batch=b-klaim/);
    await expect(ket).toHaveValue("Faktur pajak item 2 menyusul");

    // Pindah batch membongkar editor: cleanup-nya mematikan penjaga.
    await antrean(page).getByRole("button", { name: /001\/RB\/09\/2026/ }).click();
    await tinggal.getByRole("button", { name: "Tinggalkan" }).click();
    await expect(page).toHaveURL(/batch=b-final/);
    await expect(main.getByRole("heading", { level: 1, name: "001/RB/09/2026" })).toBeVisible(NAV);
    expect(await dicegah()).toBe(false);
});

test("tulisOpc: 504 HTML dari proxy = hasil tidak pasti tanpa HTML mentah; 4xx JSON = pesan server di dialog", async ({ page }) => {
    let respon: Respon = { status: 504, contentType: "text/html", body: "<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>nginx</center></body></html>" };
    const tulis = await mockOpc(page, { tulis: () => respon });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=sales&batch=b-sm1", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Setujui & teruskan ke Klaim…" }).click(NAV);
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Setujui & teruskan", exact: true }).click();
    const galat = dlg.getByRole("alert");
    await expect(galat).toHaveText("Server tidak memberi jawaban yang pasti — hasilnya belum pasti; muat ulang untuk memeriksa sebelum mengulang.");
    await expect(dlg).not.toContainText("Gateway");
    await expect(dlg).not.toContainText("<html");
    respon = json({ ok: false, error: "Batch tidak sedang menunggu tinjauan SM." }, 409);
    await dlg.getByRole("button", { name: "Setujui & teruskan", exact: true }).click();
    await expect(galat).toHaveText("Batch tidak sedang menunggu tinjauan SM.");
    expect(tulis).toEqual(["POST /api/off-program-control/batches/b-sm1/sm-approve", "POST /api/off-program-control/batches/b-sm1/sm-approve"]);
});
