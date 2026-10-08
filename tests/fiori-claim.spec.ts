/*
 * Tujuan: Fiori S4b Claim Workflow — List Report (kartu = saringan, kolom No Claim, baris membuka klaimnya, galat bukan kosong) dan
 *   Object Page (semua bagian + anchor bar, varian BL, dialog Tandai siap / Kembalikan ke draf / Kirim / Catat pembayaran / Batalkan
 *   pembayaran / Tutup, konflik versi item 409 dengan muat ulang baris), ponsel 390 px tanpa gulir menyamping, tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin): `npx playwright test tests/fiori-claim.spec.ts`.
 * Dependensi: /api/claim-workflow/* di-mock dengan page.route (tidak menyentuh DB/Accurate).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const path = (p: string) => (url: URL) => url.pathname === p;
const NAV = { timeout: 60_000 } as const;
const hariLalu = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

const LIST = [
    { id: "wf-draft", claimWorkflowNo: "CLM/004/URC/09/2026", offBatchId: "ob1", offNoPengajuan: "004/URC/09/2026", principleName: "URC", status: "Draft", totalClaim: 7902500, totalPaid: 0, remainingAmount: 7902500, noClaimList: [], createdAt: "2026-10-05T06:00:00Z", offFinanceStatus: "Paid", documentStatus: "partial", canGenerateNoClaim: true },
    { id: "wf-ready", claimWorkflowNo: "CLM/005/KINO/09/2026", offBatchId: "ob2", principleName: "KINO", status: "Ready to Submit", totalClaim: 4700000, totalPaid: 0, remainingAmount: 4700000, noClaimList: ["05/SUPER-KN/09/2026"], createdAt: "2026-10-04T06:00:00Z", offFinanceStatus: "Paid", documentStatus: "complete" },
    { id: "wf-sent", claimWorkflowNo: "CLM/002/KINO/08/2026", offBatchId: "ob3", principleName: "KINO", status: "Partially Paid", totalClaim: 12398750, totalPaid: 3000000, remainingAmount: 9398750, noClaimList: ["02/SUPER-KN/08/2026"], createdAt: "2026-08-15T06:00:00Z", submittedToPrincipalAt: hariLalu(47), offFinanceStatus: "Paid", documentStatus: "complete" },
    { id: "wf-paid", claimWorkflowNo: "CLM/004/HEINZ/09/2026", offBatchId: "ob4", principleName: "HEINZ", status: "Paid", totalClaim: 8100000, totalPaid: 8100000, remainingAmount: 0, noClaimList: ["004/HZ/09/2026"], createdAt: "2026-09-02T06:00:00Z", submittedToPrincipalAt: hariLalu(28), offFinanceStatus: "Paid", documentStatus: "complete" },
];
const OUT = {
    ok: true,
    outstanding: [{ workflowId: "wf-sent", submissionId: "s-sent", claimWorkflowNo: "CLM/002/KINO/08/2026", noClaim: "02/SUPER-KN/08/2026", principleName: "KINO", status: "Partially Paid", totalClaim: 12398750, totalPaid: 3000000, remainingAmount: 9398750, daysOutstanding: 47 }],
    summary: { submissionCount: 1, totalClaim: 12398750, totalPaid: 3000000, totalOutstanding: 9398750 },
};

const DOK = { claimLetterPdfPath: "l.pdf", claimLetterGeneratedAt: "2026-10-05T06:20:00Z", summaryPdfPath: "s.pdf", summaryGeneratedAt: "2026-10-05T06:21:00Z", receiptPdfPath: "r.pdf", receiptGeneratedAt: "2026-10-05T06:22:00Z" };
const item = (id: string, outlet: string, dpp: number, extra: Record<string, unknown> = {}) => ({
    id, noSurat: "URC/PRG/0811", jenisPromosi: "Display Piattos Sep", periode: "01/09–30/09", outlet, dpp, ppnRate: 11, ppnAmount: Math.round(dpp * 0.11),
    pphRate: 2, pphAmount: Math.round(dpp * 0.02), nilaiKlaim: dpp + Math.round(dpp * 0.11) - Math.round(dpp * 0.02), status: "Draft", note: null,
    claimSubmissionId: "s1", updatedAt: "2026-10-05T06:10:00.000Z", ...extra,
});
function detail(id: string, no: string, status: string, over: Record<string, unknown> = {}, sub: Record<string, unknown> = {}) {
    const items = [item("it-1", "TK Cahaya", 2750000), item("it-2", "UD Barokah", 2500000)];
    const total = items.reduce((a, it) => a + it.nilaiKlaim, 0);
    return {
        ok: true,
        workflow: { id, claimWorkflowNo: no, offBatchId: "ob", offNoPengajuan: no.replace("CLM/", ""), principleCode: "KINO", principleName: "KINO", status, totalDpp: 5250000, totalPpn: 577500, totalPph: 105000, totalClaim: total, totalPaid: 0, remainingAmount: total, createdAt: "2026-10-05T06:00:00Z", ...over },
        items, payments: [], paymentSummary: { totalClaim: total, totalPaid: 0, remainingAmount: total, paymentStatus: status, activePaymentCount: 0, voidedPaymentCount: 0 },
        submissions: [{ id: "s1", noClaim: null, scope: "per_pengajuan", scopeLabel: null, status, totalClaim: total, totalPaid: 0, remainingAmount: total, itemCount: 2, ...sub }],
        hasMultipleSubmissions: false, canEditItems: true, isReadOnly: false, canGenerateClaimLetter: true, canGenerateSummary: true, canGenerateReceipt: true,
        canAssignNoClaim: true, canGenerateNoClaim: true, noClaimGateReason: null, offFinanceStatus: "Paid", offPaymentSummary: { totalNominal: 1, totalPaid: 1, isFullyPaid: true },
        canRecordPayment: false, canVoidPayment: true, canClose: false, closeBlockers: [],
    };
}
const AUDIT = [{ id: "a1", actorName: "Rina", actorRole: "claim", action: "create_from_off", createdAt: "2026-10-05T06:02:00Z" }];

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Daftar: kartu = saringan, kolom No Claim, baris membuka klaimnya; galat tidak tampil sebagai kosong", async ({ page }) => {
    let gagal = false;
    await page.route(path("/api/claim-workflow"), (r) => gagal ? r.fulfill(json({ ok: false, error: "Gagal mengambil daftar Claim Workflow." }, 500)) : r.fulfill(json({ ok: true, workflows: LIST, pagination: { hasMore: false } })));
    await page.route(path("/api/claim-workflow/outstanding"), (r) => r.fulfill(json(OUT)));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/claim-workflow", NAV);
    const main = page.locator("main");
    const tabel = main.getByRole("table", { name: "Klaim" });
    await expect(tabel.getByRole("columnheader", { name: "No Claim" })).toBeVisible(NAV);
    await expect(tabel).toContainText("02/SUPER-KN/08/2026");
    await expect(tabel.getByRole("link", { name: "CLM/002/KINO/08/2026" })).toHaveAttribute("href", "/claim-workflow/wf-sent");
    await expect(tabel.getByRole("link", { name: "Isi No Claim" })).toHaveAttribute("href", "/claim-workflow/wf-draft?focus=no-claim");
    await expect(tabel.getByText("Dibayar sebagian")).toBeVisible();
    await expect(tabel.getByRole("cell", { name: "47 hari", exact: true })).toBeVisible(); // kolom Umur (salinan pop-in tersembunyi tidak dihitung)

    const kartu = main.getByRole("group", { name: "Saring menurut tahap" });
    await kartu.getByRole("button", { name: /Siap dikirim/ }).click();
    await expect(kartu.getByRole("button", { name: /Siap dikirim/ })).toHaveAttribute("aria-pressed", "true");
    await expect(main.getByRole("table", { name: /Siap dikirim/ }).locator("tbody tr")).toHaveCount(1);
    await kartu.getByRole("button", { name: /Ditutup/ }).click();
    await expect(main.getByText("Tidak ada klaim dengan tahap Ditutup")).toBeVisible();
    const belum = kartu.getByRole("button", { name: /Belum lunas/ });
    await expect(belum.locator("b")).toHaveText("1");
    await belum.click();
    await expect(main.getByRole("table", { name: "Belum lunas per No Claim" }).getByRole("link", { name: "CLM/002/KINO/08/2026" })).toHaveAttribute("href", "/claim-workflow/wf-sent");
    await page.screenshot({ path: "test-results/fiori-claim-daftar.png", fullPage: true });

    gagal = true;
    await page.reload(NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Gagal mengambil daftar Claim Workflow." })).toBeVisible(NAV);
    await expect(main.getByText("Belum ada klaim")).toHaveCount(0);
});

test("Detail draf: semua bagian + anchor bar, varian BL, Tandai siap nonaktif beralasan; item 409 menyebut siapa/kapan + muat ulang baris", async ({ page }) => {
    const patch: unknown[] = [];
    let audit = AUDIT;
    await page.route(path("/api/claim-workflow/wf-draft"), (r) => r.fulfill(json(detail("wf-draft", "CLM/004/URC/09/2026", "Draft", { claimLetterPdfPath: "l.pdf", claimLetterGeneratedAt: "2026-10-05T06:20:00Z" }))));
    await page.route(path("/api/claim-workflow/wf-draft/audit"), (r) => r.fulfill(json({ ok: true, audit })));
    await page.route(path("/api/claim-workflow/wf-draft/items/it-2"), (r) => {
        patch.push(r.request().postDataJSON());
        audit = [...AUDIT, { id: "a2", actorName: "Ani", actorRole: "claim", action: "update_item_tax", metadata: { itemId: "it-2", dpp: 2500000, ppnRate: 11, pphRate: 2 }, createdAt: "2026-10-07T01:12:00Z" } as never];
        return r.fulfill(json({ ok: false, code: "CONFLICT", error: "Item ini sudah diubah pengguna lain.", currentUpdatedAt: "2026-10-07T01:12:00.000Z" }, 409));
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/claim-workflow/wf-draft", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "CLM/004/URC/09/2026" })).toBeVisible(NAV);
    for (const nama of ["Item klaim", "No Claim & dokumen", "Pembayaran dari principal", "Penutupan", "Riwayat", "Alur dokumen"]) {
        await expect(main.getByRole("region", { name: nama })).toBeVisible();
    }
    await expect(main.getByRole("navigation", { name: "Bagian halaman" }).getByRole("link")).toHaveCount(6);
    for (const bl of ["BL-15", "BL-07", "BL-33", "BL-35"]) await expect(main.getByText(`usulan ${bl}`)).toBeVisible();
    await expect(main.getByRole("list", { name: "Tahap klaim" }).locator('[aria-current="step"]')).toContainText("Draf");
    await expect(main.getByRole("region", { name: "Riwayat" })).toContainText("Membuat klaim dari OFF Program Control");
    const siap = main.getByRole("button", { name: "Tandai siap dikirim…" });
    await expect(siap).toBeDisabled();
    await expect(main.locator(".fi-ftb")).toContainText("Isi No Claim 1 berkas dulu.");

    await main.getByRole("button", { name: "Ubah pajak item 2" }).click();
    await main.getByRole("spinbutton", { name: "PPh % item 2" }).fill("1.5");
    await expect(main.getByText("Draf belum disimpan")).toBeVisible();
    await expect(main.getByText("Belum disimpan: PPh 2% → 1,5%")).toBeVisible();
    await expect(main.getByRole("table", { name: "Item klaim" })).toContainText("Rp 37.500"); // 2.500.000 × 1,5% dibulatkan ke rupiah
    await page.screenshot({ path: "test-results/fiori-claim-draf.png", fullPage: true });
    await main.getByRole("table", { name: "Item klaim" }).getByRole("button", { name: "Simpan" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "diubah Ani" })).toContainText("sejak Anda membuka halaman ini");
    expect(patch[0]).toEqual({ dpp: "2500000", ppnRate: "11", pphRate: "1.5", note: "", expectedUpdatedAt: "2026-10-05T06:10:00.000Z" });
    await main.getByRole("button", { name: "Muat ulang baris itu" }).click();
    await expect(main.getByText("Item 2 dimuat ulang dengan versi terbaru.")).toBeVisible();
    await expect(main.getByRole("spinbutton", { name: "PPh % item 2" })).toHaveCount(0);
});

test("Tandai siap lewat dialog; Siap dikirim: Kembalikan ke draf menyebut dokumen yang dihapus + alasan, Kirim ke principal", async ({ page }) => {
    const status: Array<{ url: string; body: unknown }> = [];
    const lengkap = detail("wf-lengkap", "CLM/006/KINO/10/2026", "Draft", DOK, { noClaim: "06/SUPER-KN/10/2026" });
    const siapKirim = detail("wf-ready", "CLM/005/KINO/09/2026", "Ready to Submit", DOK, { noClaim: "05/SUPER-KN/09/2026", ...DOK });
    await page.route(path("/api/claim-workflow/wf-lengkap"), (r) => r.fulfill(json(lengkap)));
    await page.route(path("/api/claim-workflow/wf-ready"), (r) => r.fulfill(json(siapKirim)));
    await page.route((u) => /^\/api\/claim-workflow\/wf-(lengkap|ready)\/audit$/.test(u.pathname), (r) => r.fulfill(json({ ok: true, audit: AUDIT })));
    await page.route((u) => /^\/api\/claim-workflow\/wf-(lengkap|ready)\/status$/.test(u.pathname), (r) => { status.push({ url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() }); return r.fulfill(json({ ok: true })); });
    await page.setViewportSize({ width: 1366, height: 900 });

    await page.goto("/claim-workflow/wf-lengkap", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Tandai siap dikirim…" }).click(NAV);
    let dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Tandai CLM/006/KINO/10/2026 siap dikirim?" })).toBeVisible();
    await expect(dlg).toContainText("06/SUPER-KN/10/2026");
    await dlg.getByRole("button", { name: "Tandai siap dikirim" }).click();
    await expect(dlg).toBeHidden();
    expect(status[0]).toEqual({ url: "/api/claim-workflow/wf-lengkap/status", body: { action: "mark_ready" } });
    await expect(main.getByRole("status").filter({ hasText: "ditandai siap dikirim" })).toBeVisible();

    await page.goto("/claim-workflow/wf-ready", NAV);
    await main.getByRole("button", { name: "Kembalikan ke draf…" }).click(NAV);
    dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("6 dokumen PDF yang sudah dibuat akan dihapus");
    await expect(dlg).toContainText("Surat klaim, Ringkasan, Kwitansi, 3 dokumen berkas");
    await expect(dlg.getByRole("button", { name: "Kembalikan ke draf" })).toBeDisabled();
    await dlg.getByLabel("Alasan").fill("PPN item 2 salah tarif");
    await page.screenshot({ path: "test-results/fiori-claim-dialog-draf.png" });
    await dlg.getByRole("button", { name: "Kembalikan ke draf" }).click();
    await expect(dlg).toBeHidden();
    expect(status[1]).toEqual({ url: "/api/claim-workflow/wf-ready/status", body: { action: "return_to_draft", note: "PPN item 2 salah tarif" } });

    await main.getByRole("button", { name: "Kirim ke principal…" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Kirim CLM/005/KINO/09/2026 ke principal?" })).toBeVisible();
    await expect(dlg).toContainText("umur tagihan dihitung dari sini");
    await dlg.getByRole("button", { name: "Kirim ke principal" }).click();
    await expect(dlg).toBeHidden();
    expect(status[2]).toEqual({ url: "/api/claim-workflow/wf-ready/status", body: { action: "submit_to_principal" } });
});

test("Menunggu bayar: dialog Catat pembayaran mengirim badan yang sama; Batalkan pembayaran beralasan; varian BL-14/07/08", async ({ page }) => {
    const kirim: Array<{ url: string; body: unknown }> = [];
    const sent = detail("wf-sent", "CLM/002/KINO/08/2026", "Partially Paid", { ...DOK, totalPaid: 3000000, remainingAmount: 2722500, submittedToPrincipalAt: hariLalu(47) }, { noClaim: "02/SUPER-KN/08/2026", ...DOK, totalPaid: 3000000, remainingAmount: 2722500 });
    Object.assign(sent, {
        canRecordPayment: true,
        payments: [{ id: "p1", claimSubmissionId: "s1", paymentDate: "2026-09-22", paymentAmount: 3000000, paymentType: "Transfer", paymentNote: "termin 1", voidedAt: null, createdAt: "2026-09-22T02:00:00Z" }],
        paymentSummary: { totalClaim: 5722500, totalPaid: 3000000, remainingAmount: 2722500, paymentStatus: "Partially Paid", activePaymentCount: 1, voidedPaymentCount: 0 },
    });
    await page.route(path("/api/claim-workflow/wf-sent"), (r) => r.fulfill(json(sent)));
    await page.route(path("/api/claim-workflow/wf-sent/audit"), (r) => r.fulfill(json({ ok: true, audit: AUDIT })));
    await page.route((u) => u.pathname.startsWith("/api/claim-workflow/wf-sent/payments"), (r) => { kirim.push({ url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() }); return r.fulfill(json({ ok: true, statusChanged: true, workflow: { status: "Paid" } })); });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/claim-workflow/wf-sent", NAV);
    const main = page.locator("main");
    const bayar = main.getByRole("region", { name: "Pembayaran dari principal" });
    await expect(bayar).toContainText("termin 1", NAV);
    for (const bl of ["BL-14", "BL-07", "BL-08"]) await expect(main.getByText(`usulan ${bl}`)).toBeVisible();
    await expect(main.locator(".fi-ftb")).toContainText("Dikirim 47 hari lalu");

    await main.locator(".fi-ftb").getByRole("button", { name: "Catat pembayaran…" }).click();
    await expect(bayar.getByText("Nominal harus lebih dari 0.")).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
    await bayar.getByLabel("Tanggal diterima").fill("2026-10-06");
    await bayar.getByLabel("Nominal").fill("2722500");
    await expect(main.getByText("Draf belum disimpan")).toBeVisible();
    await bayar.getByRole("button", { name: "Catat pembayaran…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Catat pembayaran Rp 2.722.500 dari KINO?" })).toBeVisible();
    await expect(dlg).toContainText("Rp 0 → status Lunas");
    await page.screenshot({ path: "test-results/fiori-claim-dialog-bayar.png" });
    await dlg.getByRole("button", { name: "Catat Rp 2.722.500" }).click();
    await expect(dlg).toBeHidden();
    expect(kirim[0]).toEqual({ url: "/api/claim-workflow/wf-sent/payments", body: { paymentDate: "2026-10-06", paymentAmount: 2722500, paymentType: "Transfer", paymentNote: null } });
    await expect(bayar.getByRole("status").filter({ hasText: "Pembayaran Rp 2.722.500 tercatat. Status klaim: Lunas." })).toBeVisible();

    await bayar.getByRole("table", { name: "Riwayat pembayaran" }).getByRole("button", { name: "Batalkan…" }).click();
    const dv = page.getByRole("dialog");
    await expect(dv.getByRole("heading", { name: "Batalkan pembayaran Rp 3.000.000?" })).toBeVisible();
    await expect(dv).toContainText("Sisa menjadi Rp 5.722.500");
    await dv.getByLabel("Alasan").fill("salah alamat");
    await dv.getByRole("button", { name: "Batalkan pembayaran" }).click();
    await expect(dv).toBeHidden();
    expect(kirim[1]).toEqual({ url: "/api/claim-workflow/wf-sent/payments/p1/void", body: { reason: "salah alamat" } });
});

test("Lunas: daftar periksa delapan syarat, Tutup klaim lewat dialog dengan catatan", async ({ page }) => {
    let tutup: unknown = null;
    const paid = detail("wf-paid", "CLM/004/HEINZ/09/2026", "Paid", { ...DOK, submittedToPrincipalAt: hariLalu(28) }, { noClaim: "004/HZ/09/2026", ...DOK });
    const total = paid.workflow.totalClaim;
    Object.assign(paid.workflow, { totalPaid: total, remainingAmount: 0 });
    Object.assign(paid.submissions[0], { totalPaid: total, remainingAmount: 0 });
    Object.assign(paid, {
        payments: [{ id: "p1", claimSubmissionId: "s1", paymentDate: "2026-10-02", paymentAmount: total, paymentType: "Transfer", paymentNote: null, voidedAt: null, createdAt: "2026-10-02T02:00:00Z" }],
        paymentSummary: { totalClaim: total, totalPaid: total, remainingAmount: 0, paymentStatus: "Paid", activePaymentCount: 1, voidedPaymentCount: 0 },
    });
    await page.route(path("/api/claim-workflow/wf-paid"), (r) => r.fulfill(json(paid)));
    await page.route(path("/api/claim-workflow/wf-paid/audit"), (r) => r.fulfill(json({ ok: true, audit: AUDIT })));
    await page.route(path("/api/claim-workflow/wf-paid/close"), (r) => { tutup = r.request().postDataJSON(); return r.fulfill(json({ ok: true, workflow: { status: "Closed" } })); });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/claim-workflow/wf-paid", NAV);
    const main = page.locator("main");
    const syarat = main.getByRole("list", { name: "Syarat penutupan" });
    await expect(syarat.locator('li[data-ok="true"]')).toHaveCount(8, NAV);
    const tombol = main.locator(".fi-ftb").getByRole("button", { name: "Tutup klaim…" });
    await expect(tombol).toBeDisabled();
    await main.getByLabel("Catatan penutupan").fill("Lunas satu termin, bukti transfer lengkap");
    await expect(main.getByText("Draf belum disimpan")).toBeVisible();
    await tombol.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Tutup klaim CLM/004/HEINZ/09/2026?" })).toBeVisible();
    await expect(dlg).toContainText("Lunas satu termin, bukti transfer lengkap");
    await dlg.getByRole("button", { name: "Tutup klaim" }).click();
    await expect(dlg).toBeHidden();
    expect(tutup).toEqual({ note: "Lunas satu termin, bukti transfer lengkap" });
    await expect(main.getByRole("status").filter({ hasText: "CLM/004/HEINZ/09/2026 ditutup." })).toBeVisible();
});

test("Banyak berkas: pembayaran ke berkas yang masih bersisa (URL per berkas), kelebihan bayar ditahan, tutup berkas yang lunas", async ({ page }) => {
    const kirim: Array<{ url: string; body: unknown }> = [];
    const multi = detail("wf-multi", "CLM/007/KINO/10/2026", "Partially Paid", { ...DOK, totalPaid: 3997500, remainingAmount: 1725000, submittedToPrincipalAt: hariLalu(12) });
    multi.items[1].claimSubmissionId = "s2";
    Object.assign(multi, {
        hasMultipleSubmissions: true, canRecordPayment: true,
        submissions: [
            { id: "s1", noClaim: "01/SUPER-KN/10/2026", scope: "per_item", scopeLabel: null, status: "Paid", totalClaim: 2997500, totalPaid: 2997500, remainingAmount: 0, itemCount: 1, ...DOK },
            { id: "s2", noClaim: "02/SUPER-KN/10/2026", scope: "per_item", scopeLabel: null, status: "Partially Paid", totalClaim: 2725000, totalPaid: 1000000, remainingAmount: 1725000, itemCount: 1, ...DOK },
        ],
        payments: [
            { id: "p1", claimSubmissionId: "s1", paymentDate: "2026-10-01", paymentAmount: 2997500, paymentType: "Transfer", paymentNote: null, voidedAt: null, createdAt: "2026-10-01T02:00:00Z" },
            { id: "p2", claimSubmissionId: "s2", paymentDate: "2026-10-02", paymentAmount: 1000000, paymentType: "Transfer", paymentNote: null, voidedAt: null, createdAt: "2026-10-02T02:00:00Z" },
        ],
        paymentSummary: { totalClaim: 5722500, totalPaid: 3997500, remainingAmount: 1725000, paymentStatus: "Partially Paid", activePaymentCount: 2, voidedPaymentCount: 0 },
    });
    await page.route(path("/api/claim-workflow/wf-multi"), (r) => r.fulfill(json(multi)));
    await page.route(path("/api/claim-workflow/wf-multi/audit"), (r) => r.fulfill(json({ ok: true, audit: AUDIT })));
    await page.route((u) => u.pathname.startsWith("/api/claim-workflow/wf-multi/submissions/"), (r) => { kirim.push({ url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() }); return r.fulfill(json({ ok: true })); });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/claim-workflow/wf-multi", NAV);
    const main = page.locator("main");
    const bayar = main.getByRole("region", { name: "Pembayaran dari principal" });
    await expect(bayar.getByLabel("Berkas")).toHaveValue("s2", NAV); // bawaan: berkas pertama yang masih bersisa
    await bayar.getByLabel("Tanggal diterima").fill("2026-10-07");
    await bayar.getByLabel("Nominal").fill("2000000");
    await bayar.getByRole("button", { name: "Catat pembayaran…" }).click();
    await expect(bayar.getByText("Melebihi sisa Rp 1.725.000")).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();
    await bayar.getByLabel("Nominal").fill("1725000");
    await bayar.getByRole("button", { name: "Catat pembayaran…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("02/SUPER-KN/10/2026");
    await dlg.getByRole("button", { name: "Catat Rp 1.725.000" }).click();
    await expect(dlg).toBeHidden();
    expect(kirim[0]).toEqual({ url: "/api/claim-workflow/wf-multi/submissions/s2/payments", body: { paymentDate: "2026-10-07", paymentAmount: 1725000, paymentType: "Transfer", paymentNote: null } });

    const tutup = main.getByRole("region", { name: "Penutupan" });
    await expect(tutup.getByLabel("Berkas yang ditutup")).toHaveValue("s1"); // bawaan: berkas yang sudah lunas
    await expect(tutup.getByRole("list", { name: "Syarat penutupan" }).locator('li[data-ok="true"]')).toHaveCount(8);
    await tutup.getByLabel("Catatan penutupan").fill("Berkas 01 lunas");
    await tutup.getByRole("button", { name: "Tutup berkas…" }).click();
    const dt = page.getByRole("dialog");
    await expect(dt.getByRole("heading", { name: "Tutup berkas 01/SUPER-KN/10/2026?" })).toBeVisible();
    await dt.getByRole("button", { name: "Tutup berkas" }).click();
    await expect(dt).toBeHidden();
    expect(kirim[1]).toEqual({ url: "/api/claim-workflow/wf-multi/submissions/s1/close", body: { note: "Berkas 01 lunas" } });
});

test("Ponsel 390 px: daftar dan detail tanpa gulir menyamping; klaim yang tidak ada = kosong, bukan galat", async ({ page }) => {
    await page.route(path("/api/claim-workflow"), (r) => r.fulfill(json({ ok: true, workflows: LIST })));
    await page.route(path("/api/claim-workflow/outstanding"), (r) => r.fulfill(json(OUT)));
    await page.route(path("/api/claim-workflow/wf-draft"), (r) => r.fulfill(json(detail("wf-draft", "CLM/004/URC/09/2026", "Draft"))));
    await page.route(path("/api/claim-workflow/wf-draft/audit"), (r) => r.fulfill(json({ ok: true, audit: AUDIT })));
    await page.route(path("/api/claim-workflow/hilang"), (r) => r.fulfill(json({ ok: false, error: "Claim Workflow not found" }, 404)));
    await page.route(path("/api/claim-workflow/hilang/audit"), (r) => r.fulfill(json({ ok: false, error: "Claim Workflow not found" }, 404)));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/claim-workflow", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("link", { name: /CLM\/002\/KINO\/08\/2026/ })).toBeVisible(NAV);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-claim-ponsel-daftar.png", fullPage: true });

    await page.goto("/claim-workflow/wf-draft", NAV);
    await expect(main.getByRole("heading", { level: 1, name: "CLM/004/URC/09/2026" })).toBeVisible(NAV);
    await main.getByRole("button", { name: "Ubah" }).first().click();
    await expect(main.getByRole("spinbutton", { name: "PPh %", exact: true })).toBeVisible(); // formulir ponsel, bukan isian tabel yang tersembunyi
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-claim-ponsel-detail.png", fullPage: true });

    await page.goto("/claim-workflow/hilang", NAV);
    await expect(main.getByText("Klaim tidak ditemukan")).toBeVisible(NAV);
    await expect(main.getByRole("alert")).toHaveCount(0);
});
