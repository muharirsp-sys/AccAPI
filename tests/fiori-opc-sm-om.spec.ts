/*
 * Tujuan: Fiori S4d OFF Program Control — layar Sales Manager dan Operational Manager: ringkasan angka, Object Page dengan aksi
 *   tinjauan (Setujui & teruskan ke Klaim / Kembalikan ke SPV, alasan wajib), keputusan OM (Setujui / Batalkan, alasan wajib),
 *   pengajuan pengembalian selisih oleh SM, draf catatan + penjaga pindah batch, batch di tahap lain tanpa aksi (BL-06), galat ≠ kosong,
 *   payload tulis sama dengan kode lama, galat server tampil di dialog, ponsel 390 px tanpa gulir menyamping.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = admin):
 *   `npx playwright test tests/fiori-opc-sm-om.spec.ts --config playwright.fiori-local.config.ts --workers=1 --output=test-results/sm-om`.
 * Dependensi: /api/off-program-control/* dan /api/auth/get-session di-mock dengan page.route (tidak menyentuh DB).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const lalu = (hari: number) => new Date(Date.now() - hari * 864e5).toISOString();
const kini = lalu(0);
type Over = Record<string, unknown>;
type Batch = Record<string, unknown> & { id: string };

const batch = (id: string, no: string, principleCode: string, principleName: string, over: Over = {}): Batch => ({
    id, noPengajuan: no, gelombang: no.slice(0, 3), principleCode, principleName, bulan: no.split("/").at(-2), tahun: "2026",
    supervisorName: "Rahmat", status: "Draft", smStatus: "Not Started", claimStatus: "Not Started", omStatus: "Not Started",
    financeStatus: "Not Started", finalStatus: "Not Started", locked: false, createdBy: "u-spv", createdByRole: "supervisor",
    refundStatus: "Not Applicable", createdAt: kini, updatedAt: kini, payments: [],
    summary: { totalNominal: 4_300_000, totalRows: 2, transfer: 2_200_000, tunai: 2_100_000 },
    periodDates: { pengajuan: ["2026-10-02"], program: [], claim: [], bayar: [] }, ...over,
});
const SM = { smStatus: "Approved by SM", locked: true };
const KL = { ...SM, claimStatus: "Approved" };
const OMOK = { ...KL, omStatus: "Approved" };
const LUNAS = { ...OMOK, status: "Paid", financeStatus: "Paid", paymentSummary: { totalNominal: 4_300_000, totalPaid: 4_300_000, remainingAmount: 0, isFullyPaid: true } };
const awal = (): Batch[] => [
    batch("b-sm1", "007/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", { status: "Submitted to SM", smStatus: "Waiting Review", submittedAt: lalu(20) }),
    batch("b-sm2", "011/HEINZ/10/2026", "HEINZ", "HEINZ ABC INDONESIA, PT", { status: "Submitted to SM", smStatus: "Waiting Review", submittedAt: kini, supervisorName: "Zul" }),
    batch("b-klaim", "005/GDI/10/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { status: "Approved by SM", ...SM, omStatus: "Notify OM", smApprovedAt: kini }),
    batch("b-om", "002/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", {
        status: "Claim Approved", ...KL, omStatus: "Waiting Approval", claimReviewedAt: kini, claimNote: "Berkas lengkap, faktur pajak menyusul.",
        smNote: "Data sesuai surat.", noClaim: "KN-001", claimSubmittedDate: "2026-10-05", claimDeadline: "2099-11-05",
    }),
    batch("b-bayar", "004/URC/09/2026", "URC", "URC INDONESIA, PT", { status: "OM Approved", ...OMOK, financeStatus: "Waiting Payment", claimDeadline: "2099-10-30" }),
    batch("b-lebih", "008/HEINZ/09/2026", "HEINZ", "HEINZ ABC INDONESIA, PT", { ...LUNAS, finalStatus: "Pending Refund", refundStatus: "Pending Refund", verifiedAmount: 3_850_000 }),
    batch("b-kurang", "010/GDI/09/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { ...LUNAS, finalStatus: "Incomplete Documents", finalClaimNote: "Faktur pajak toko belum ada." }),
];
const item = (id: string, itemNo: number, toko: string, nominal: number, over: Over = {}) => ({
    id, itemNo, noSurat: "KINO/PRG/0931", namaProgram: "Display Zwitsal Okt", periode: "2026-10-01 - 2026-10-31", toko, barang: null, nominal,
    caraBayar: "Transfer", type: "Display", deadline: "2026-10-31", kwt: true, skp: true, fp: false, pc: false, foto: true, rekap: true, others: true,
    othersText: "Surat pernyataan toko", ...over,
});
const REFUND_KOSONG = { paidAmount: 0, verifiedAmount: 0, overpaidAmount: 0, totalRefunded: 0, pendingRefund: 0, remainingRefund: 0, isFullyRefunded: false };
const REFUND_LEBIH = { paidAmount: 4_300_000, verifiedAmount: 3_850_000, overpaidAmount: 450_000, totalRefunded: 0, pendingRefund: 0, remainingRefund: 450_000, isFullyRefunded: false };

type Tulis = { method: string; path: string; body: Over };
type Opsi = {
    daftar?: () => ReturnType<typeof json>;
    peran?: string;
    /** Akhiran path → pesan galat; permintaan pertama ke akhiran itu ditolak 409 (sekali). */
    gagalSekali?: Record<string, string>;
};

/** Semua endpoint OPC dimock dengan keadaan di memori: tulis mengubah batch, GET berikutnya membaca keadaan baru. */
async function mockOpc(page: Page, opsi: Opsi = {}) {
    const batches = awal();
    const tulis: Tulis[] = [];
    const gagal = new Map(Object.entries(opsi.gagalSekali ?? {}));
    const ubah = (id: string, u: Over) => Object.assign(batches.find((b) => b.id === id)!, u, { updatedAt: new Date().toISOString() });
    if (opsi.peran) {
        await page.route((u) => u.pathname === "/api/auth/get-session", (r) => r.fulfill(json({
            session: { id: "s1", userId: "u-1", token: "t", expiresAt: lalu(-1), createdAt: kini, updatedAt: kini },
            user: { id: "u-1", name: "Hendrik Saputra", email: "hendrik@example.invalid", emailVerified: true, role: opsi.peran, createdAt: kini, updatedAt: kini },
        })));
    }
    await page.route((u) => u.pathname.startsWith("/api/off-program-control/"), (r) => {
        const req = r.request();
        const p = new URL(req.url()).pathname;
        const m = /^\/api\/off-program-control\/batches\/([^/]+)(?:\/([a-z-]+))?$/.exec(p);
        if (req.method() !== "GET") {
            const body = (req.postDataJSON() ?? {}) as Over;
            tulis.push({ method: req.method(), path: p, body });
            if (!m) return r.fulfill(json({ ok: false, error: "tidak dimock" }, 404));
            const aksi = m[2] ?? "";
            const pesan = gagal.get(aksi);
            if (pesan) { gagal.delete(aksi); return r.fulfill(json({ ok: false, error: pesan }, 409)); }
            const id = decodeURIComponent(m[1]);
            if (aksi === "sm-approve") {
                ubah(id, { status: "Approved by SM", smStatus: "Approved by SM", smNote: body.note, locked: true, omStatus: "Notify OM", smApprovedAt: kini });
                return r.fulfill(json({ ok: true, message: "Pengajuan disetujui Sales Manager dan notifikasi OM dibuat.", notification: {
                    to: "operational.manager@company.local", subject: "Pengajuan OFF Approved by SM", status: "sent_mock",
                    message: "Ada batch pengajuan OFF yang sudah disetujui Sales Manager dan siap ditinjau OM." } }));
            }
            if (aksi === "sm-return") {
                ubah(id, { status: "Returned by SM", smStatus: "Returned", smNote: body.note, locked: false, returnedAt: kini });
                return r.fulfill(json({ ok: true, message: "Pengajuan dikembalikan ke Supervisor." }));
            }
            if (aksi === "om-decision") {
                ubah(id, body.action === "cancel"
                    ? { status: "Cancelled by OM", omStatus: "Cancelled", omNote: body.note, locked: true }
                    : { status: "OM Approved", omStatus: "Approved", financeStatus: "Waiting Payment", omNote: body.note, locked: true });
                return r.fulfill(json({ ok: true, message: "ok" }));
            }
            if (aksi === "refund") return r.fulfill(json({ ok: true, message: "Pengembalian dana #1 berhasil disubmit.", refundId: "rf-1" }));
            return r.fulfill(json({ ok: false, error: "tidak dimock" }, 404));
        }
        if (p === "/api/off-program-control/batches") return r.fulfill(opsi.daftar ? opsi.daftar() : json({ ok: true, batches }));
        if (!m) return r.fulfill(json({ ok: false, error: "tidak dimock" }, 404));
        const id = decodeURIComponent(m[1]);
        if (m[2] === "refund") return r.fulfill(json({ ok: true, refunds: [], summary: id === "b-lebih" ? REFUND_LEBIH : REFUND_KOSONG }));
        if (m[2] === "audit") return r.fulfill(json({ ok: true, audit: [] }));
        const b = batches.find((x) => x.id === id);
        if (!b) return r.fulfill(json({ ok: false, error: "Batch not found" }, 404));
        return r.fulfill(json({
            ok: true, batch: b, items: [item(`${id}-i1`, 1, "TK Mulia", 2_200_000), item(`${id}-i2`, 2, "UD Sejahtera", 2_100_000, { caraBayar: "Tunai", others: false, othersText: null })],
            payments: [], summary: { totalRows: 2, totalNominal: 4_300_000, transfer: 2_200_000, tunai: 2_100_000 },
            paymentSummary: b.paymentSummary ?? { totalNominal: 4_300_000, totalPaid: 0, remainingAmount: 4_300_000, isFullyPaid: false },
        }));
    });
    return tulis;
}

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
const antrean = (page: Page) => page.locator("main").getByRole("list", { name: /^Antrean / });
const detailOf = (page: Page) => page.locator("main").getByRole("region", { name: "Batch terbuka" });
const footer = (page: Page) => detailOf(page).locator(".fi-ftb");

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("SM: ringkasan, kelengkapan awal, catatan = draf (penjaga pindah batch), Setujui & teruskan ke Klaim lewat dialog (payload), notifikasi OM", async ({ page }) => {
    const tulis = await mockOpc(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=sales&batch=b-sm1", NAV);
    const main = page.locator("main");
    const detail = detailOf(page);
    await expect(detail.getByRole("heading", { level: 1, name: "007/KINO/10/2026" })).toBeVisible(NAV);
    const angka = main.getByRole("group", { name: "Ringkasan Sales Manager" });
    await expect(angka.locator(".fi-kc").filter({ hasText: "Menunggu tinjauan" })).toContainText("2");
    await expect(angka.locator(".fi-kc").filter({ hasText: "Total batch" })).toContainText("7");
    await expect(main.getByRole("region", { name: "Pengingat kelengkapan belum lengkap" })).toContainText("010/GDI/09/2026");
    await expect(main.getByRole("region", { name: "Pengingat kelengkapan belum lengkap" })).toContainText("Faktur pajak toko belum ada.");
    const lengkap = detail.getByRole("region", { name: "Kelengkapan awal dari SPV" });
    await expect(lengkap.getByRole("table")).toContainText("KWT, SKP, Foto, Rekap, Lainnya");
    await expect(lengkap.getByRole("table")).toContainText("Surat pernyataan toko");
    // Aksi utama di kanan, tolak negatif di kirinya.
    await expect(footer(page).getByRole("button")).toHaveText(["Kembalikan ke SPV…", "Setujui & teruskan ke Klaim…"], { useInnerText: true });
    await expect(footer(page).getByRole("button", { name: "Kembalikan ke SPV…" })).toHaveClass(/fi-btn--negative/);
    await expect(footer(page).getByRole("button", { name: "Setujui & teruskan ke Klaim…" })).toHaveClass(/fi-btn--primary/);
    await expect(detail.getByLabel("Usulan BL-06")).toBeVisible();

    // Draf: catatan diketik belum dikirim → indikator + penjaga pindah batch.
    await detail.getByRole("textbox", { name: "Catatan Sales Manager" }).fill("Cek ulang nominal TK Mulia");
    await expect(detail.getByText("Draf belum disimpan")).toBeVisible();
    await expect(detail.getByText("Belum dikirim", { exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-opc-sm-draf.png", fullPage: true });
    await antrean(page).getByRole("button", { name: /011\/HEINZ/ }).click();
    const tinggal = page.getByRole("dialog", { name: "Tinggalkan perubahan yang belum disimpan?" });
    await expect(tinggal).toBeVisible();
    await tinggal.getByRole("button", { name: "Batal" }).click();
    await expect(page).toHaveURL(/batch=b-sm1/);

    await footer(page).getByRole("button", { name: "Setujui & teruskan ke Klaim…" }).click();
    const dlg = page.getByRole("dialog", { name: "Setujui 007/KINO/10/2026 dan teruskan ke Klaim?" });
    await expect(dlg).toContainText("Cek ulang nominal TK Mulia");
    await expect(dlg).toContainText("Validasi Klaim, batas 2 hari kerja");
    await expect(dlg).toContainText("4.300.000");
    await page.screenshot({ path: "test-results/fiori-opc-sm-smok.png" });
    await dlg.getByRole("button", { name: "Setujui & teruskan" }).click();
    await expect(dlg).toBeHidden();
    expect(tulis).toEqual([{ method: "POST", path: "/api/off-program-control/batches/b-sm1/sm-approve", body: { note: "Cek ulang nominal TK Mulia" } }]);
    await expect(main.getByText("007/KINO/10/2026 disetujui dan diteruskan ke Klaim.")).toBeVisible();
    await expect(detail.getByText("Notifikasi untuk OM dibuat.")).toBeVisible();
    await expect(detail.getByText(/tiruan, tidak dikirim lewat email/)).toBeVisible();
    await expect(detail.getByText("Menunggu Klaim").first()).toBeVisible(NAV);
    await expect(detail.getByRole("button", { name: /Setujui & teruskan/ })).toHaveCount(0);
    await expect(detail.getByText("Draf belum disimpan")).toHaveCount(0);
    await expect(antrean(page).getByRole("button")).toHaveCount(1);
    await page.screenshot({ path: "test-results/fiori-opc-sm-sukses.png", fullPage: true });
    // Sukses: batch berikutnya di antrean.
    await footer(page).getByRole("button", { name: "Batch berikutnya" }).click();
    await expect(page).toHaveURL(/batch=b-sm2/);
    await expect(detail.getByRole("heading", { level: 1, name: "011/HEINZ/10/2026" })).toBeVisible(NAV);
});

test("SM Kembalikan: alasan wajib menahan tombol; galat server tampil di dialog dan alasan tetap; payload alasan ter-trim", async ({ page }) => {
    const tulis = await mockOpc(page, { gagalSekali: { "sm-return": "Batch tidak lagi menunggu review Sales Manager." } });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=sales&batch=b-sm2", NAV);
    const main = page.locator("main");
    const detail = detailOf(page);
    await expect(detail.getByRole("heading", { level: 1, name: "011/HEINZ/10/2026" })).toBeVisible(NAV);
    await footer(page).getByRole("button", { name: "Kembalikan ke SPV…" }).click();
    const dlg = page.getByRole("dialog", { name: "Kembalikan 011/HEINZ/10/2026 ke SPV?" });
    const tombol = dlg.getByRole("button", { name: "Kembalikan ke SPV" });
    await expect(tombol).toBeDisabled();
    await dlg.getByRole("textbox", { name: "Alasan pengembalian" }).fill("   ");
    await expect(tombol).toBeDisabled();
    await dlg.getByRole("textbox", { name: "Alasan pengembalian" }).fill("  Foto display TK Mulia belum ada  ");
    await expect(tombol).toBeEnabled();
    await tombol.click();
    await expect(dlg.getByRole("alert")).toHaveText("Batch tidak lagi menunggu review Sales Manager.");
    await expect(dlg.getByRole("textbox", { name: "Alasan pengembalian" })).toHaveValue("  Foto display TK Mulia belum ada  ");
    await page.screenshot({ path: "test-results/fiori-opc-sm-kembali-galat.png" });
    await tombol.click();
    await expect(dlg).toBeHidden();
    expect(tulis.map((t) => [t.path, t.body])).toEqual([
        ["/api/off-program-control/batches/b-sm2/sm-return", { note: "Foto display TK Mulia belum ada" }],
        ["/api/off-program-control/batches/b-sm2/sm-return", { note: "Foto display TK Mulia belum ada" }],
    ]);
    await expect(main.getByText("011/HEINZ/10/2026 dikembalikan ke SPV.")).toBeVisible();
    await expect(main.getByText("Batch kembali ke antrean Supervisor untuk diperbaiki.")).toBeVisible();
    await expect(main.getByText("Batch pindah ke antrean tahap berikutnya.")).toHaveCount(0);
    await expect(detail.getByRole("alert").filter({ hasText: "Dikembalikan SM: Foto display TK Mulia belum ada" })).toBeVisible(NAV);
    await expect(footer(page).getByRole("button", { name: /Kembalikan|Setujui/ })).toHaveCount(0);
});

test("SM: batch di tahap lain tanpa aksi tinjauan; pengembalian selisih diajukan lewat dialog (payload sama dengan kode lama)", async ({ page }) => {
    const tulis = await mockOpc(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=sales&batch=b-klaim", NAV);
    const main = page.locator("main");
    const detail = detailOf(page);
    await expect(detail.getByRole("heading", { level: 1, name: "005/GDI/10/2026" })).toBeVisible(NAV);
    await expect(detail.getByRole("button", { name: /Setujui|Kembalikan/ })).toHaveCount(0);
    await expect(detail.getByRole("region", { name: "Catatan untuk SPV" })).toHaveCount(0);
    await expect(detail.getByRole("region", { name: "Ajukan pengembalian selisih" })).toHaveCount(0);
    await expect(footer(page)).toContainText("Tidak ada aksi untuk Anda di batch ini.");

    await page.goto("/off-program-control?tab=sales&batch=b-lebih", NAV);
    await expect(detail.getByRole("heading", { level: 1, name: "008/HEINZ/09/2026" })).toBeVisible(NAV);
    await expect(detail.getByRole("button", { name: /Setujui|Kembalikan/ })).toHaveCount(0);
    const refund = detail.getByRole("region", { name: "Ajukan pengembalian selisih" });
    await expect(refund).toContainText("Rp 450.000");
    const ajukan = refund.getByRole("button", { name: "Ajukan pengembalian…" });
    await expect(ajukan).toBeDisabled();
    await refund.getByLabel("Jumlah pengembalian").fill("450.000");
    await expect(detail.getByText("Draf belum disimpan")).toBeVisible();
    await expect(ajukan).toBeDisabled();
    await refund.getByLabel("Tanggal pengembalian").fill("2026-10-07");
    await refund.getByLabel("Bank penerima").fill("BCA 0231");
    await expect(ajukan).toBeEnabled();
    await ajukan.click();
    const dlg = page.getByRole("dialog", { name: "Ajukan pengembalian Rp 450.000 untuk 008/HEINZ/09/2026?" });
    await expect(dlg).toContainText("07/10/2026");
    await dlg.getByRole("button", { name: "Ajukan pengembalian" }).click();
    await expect(dlg).toBeHidden();
    expect(tulis).toEqual([{ method: "POST", path: "/api/off-program-control/batches/b-lebih/refund", body: {
        refundAmount: 450000, refundMethod: "Transfer", refundDate: "2026-10-07", senderName: "", receiverBank: "BCA 0231", note: "" } }]);
    await expect(detail.getByText("Pengembalian Rp 450.000 untuk 008/HEINZ/09/2026 diajukan; menunggu verifikasi Keuangan.")).toBeVisible();
    await expect(detail.getByText("Draf belum disimpan")).toHaveCount(0);
    await expect(main.getByText("Batch pindah ke antrean tahap berikutnya.")).toHaveCount(0);
});

test("OM: ringkasan antrean langsung, ringkasan persetujuan, catatan = draf, Setujui lewat dialog (payload)", async ({ page }) => {
    const tulis = await mockOpc(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=om&batch=b-om", NAV);
    const main = page.locator("main");
    const detail = detailOf(page);
    await expect(detail.getByRole("heading", { level: 1, name: "002/KINO/10/2026" })).toBeVisible(NAV);
    const langsung = main.getByRole("group", { name: "Ringkasan antrean langsung" });
    await expect(langsung.locator(".fi-kc")).toHaveCount(7);
    await expect(langsung.locator(".fi-kc").filter({ hasText: "Menunggu persetujuan OM" })).toContainText("1");
    await expect(langsung.locator(".fi-kc").filter({ hasText: "Menunggu tinjauan SM" })).toContainText("2");
    const setuju = detail.getByRole("region", { name: "Persetujuan OM" });
    await expect(setuju).toContainText("Berkas lengkap, faktur pajak menyusul.");
    await expect(setuju).toContainText("Catatan SM: Data sesuai surat.");
    await expect(setuju).toContainText("KN-001");
    await expect(setuju).toContainText("Rp 2.100.000");
    await expect(setuju.getByText("Batch ini memakai lebih dari satu cara bayar.")).toBeVisible();
    await expect(detail.getByLabel("Usulan D-01")).toBeVisible();
    await expect(footer(page).getByRole("button")).toHaveText(["Batalkan…", "Setujui…"]);
    await expect(footer(page).getByRole("button", { name: "Batalkan…" })).toHaveClass(/fi-btn--negative/);

    await setuju.getByRole("textbox", { name: "Catatan OM" }).fill("Lanjut bayar");
    await expect(detail.getByText("Draf belum disimpan")).toBeVisible();
    await footer(page).getByRole("button", { name: "Setujui…" }).click();
    const dlg = page.getByRole("dialog", { name: "Setujui 002/KINO/10/2026?" });
    await expect(dlg).toContainText("Lanjut bayar");
    await expect(dlg).toContainText("No Claim KN-001");
    await page.screenshot({ path: "test-results/fiori-opc-om-omok.png" });
    await dlg.getByRole("button", { name: "Setujui", exact: true }).click();
    await expect(dlg).toBeHidden();
    expect(tulis).toEqual([{ method: "POST", path: "/api/off-program-control/batches/b-om/om-decision", body: { action: "approve", note: "Lanjut bayar" } }]);
    await expect(main.getByText("002/KINO/10/2026 disetujui OM dan diteruskan ke Keuangan.")).toBeVisible();
    await expect(detail.getByText("Menunggu bayar").first()).toBeVisible(NAV);
    await expect(detail.getByRole("button", { name: /Setujui…|Batalkan…/ })).toHaveCount(0);
    await expect(detail.getByText("Draf belum disimpan")).toHaveCount(0);
    await page.screenshot({ path: "test-results/fiori-opc-om-sukses.png", fullPage: true });
});

test("OM Batalkan: alasan wajib menahan tombol, galat server di dialog (alasan tetap), payload cancel; batch di tahap lain tanpa aksi", async ({ page }) => {
    const tulis = await mockOpc(page, { gagalSekali: { "om-decision": "Pengajuan tidak sedang menunggu persetujuan OM." } });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=om&batch=b-om", NAV);
    const main = page.locator("main");
    const detail = detailOf(page);
    await expect(detail.getByRole("heading", { level: 1, name: "002/KINO/10/2026" })).toBeVisible(NAV);
    await footer(page).getByRole("button", { name: "Batalkan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Batalkan 002/KINO/10/2026?" });
    await expect(dlg).toContainText("Pembatalan bersifat akhir.");
    const tombol = dlg.getByRole("button", { name: "Batalkan batch" });
    await expect(tombol).toBeDisabled();
    await dlg.getByRole("textbox", { name: "Alasan pembatalan" }).fill("Program dihentikan principal per 3 Okt");
    await expect(tombol).toBeEnabled();
    await tombol.click();
    await expect(dlg.locator("p[role=alert]")).toHaveText("Pengajuan tidak sedang menunggu persetujuan OM.");
    await expect(dlg.getByRole("textbox", { name: "Alasan pembatalan" })).toHaveValue("Program dihentikan principal per 3 Okt");
    // Batal di dialog benar-benar batal: tidak ada permintaan baru; alasan tetap sebagai draf catatan OM.
    await dlg.getByRole("button", { name: "Kembali", exact: true }).click();
    await expect(dlg).toBeHidden();
    await expect(detail.getByRole("textbox", { name: "Catatan OM" })).toHaveValue("Program dihentikan principal per 3 Okt");
    await expect(detail.getByText("Draf belum disimpan")).toBeVisible();
    expect(tulis).toHaveLength(1);
    await footer(page).getByRole("button", { name: "Batalkan…" }).click();
    await dlg.getByRole("button", { name: "Batalkan batch" }).click();
    await expect(dlg).toBeHidden();
    expect(tulis.map((t) => [t.path, t.body])).toEqual([
        ["/api/off-program-control/batches/b-om/om-decision", { action: "cancel", note: "Program dihentikan principal per 3 Okt" }],
        ["/api/off-program-control/batches/b-om/om-decision", { action: "cancel", note: "Program dihentikan principal per 3 Okt" }],
    ]);
    await expect(detail.getByText("002/KINO/10/2026 dibatalkan. Alur batch berhenti di tahap OM.")).toBeVisible();
    await expect(detail.getByRole("alert").filter({ hasText: "Dibatalkan: Program dihentikan principal per 3 Okt" })).toBeVisible(NAV);
    await expect(detail.getByRole("button", { name: /Setujui…|Batalkan…/ })).toHaveCount(0);
    await expect(main.getByText("Batch pindah ke antrean tahap berikutnya.")).toHaveCount(0);

    // Batch yang sudah disetujui OM (tahap bayar): tanpa aksi OM.
    await page.goto("/off-program-control?tab=om&batch=b-bayar", NAV);
    await expect(detail.getByRole("heading", { level: 1, name: "004/URC/09/2026" })).toBeVisible(NAV);
    await expect(detail.getByRole("region", { name: "Persetujuan OM" })).toBeVisible();
    await expect(detail.getByRole("textbox", { name: "Catatan OM" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: /Setujui…|Batalkan…/ })).toHaveCount(0);
    await expect(footer(page)).toHaveCount(0);
});

test("peran Sales Manager dari sesi: hanya antrean SM, tombol aktif", async ({ page }) => {
    await mockOpc(page, { peran: "sales_manager" });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=om&batch=b-sm1", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Peran OFF: Sales Manager.")).toBeVisible(NAV);
    await expect(main.getByRole("navigation", { name: "Antrean OFF Program Control" })).toHaveCount(0);
    await expect(antrean(page).getByRole("button")).toHaveCount(2, NAV);
    await expect(detailOf(page).getByRole("heading", { level: 1, name: "007/KINO/10/2026" })).toBeVisible(NAV);
    await expect(footer(page).getByRole("button", { name: "Setujui & teruskan ke Klaim…" })).toBeEnabled();
    await expect(footer(page).getByRole("button", { name: "Kembalikan ke SPV…" })).toBeEnabled();
});

test("galat daftar tidak tampil sebagai kosong atau angka nol; antrean kosong punya kalimatnya sendiri (SM dan OM)", async ({ page }) => {
    let gagal = true;
    await mockOpc(page, { daftar: () => (gagal ? json({ ok: false, error: "Server tidak menjawab." }, 500) : json({ ok: true, batches: [] })) });
    await page.setViewportSize({ width: 1366, height: 900 });
    const main = page.locator("main");
    for (const [tab, ringkas, kosong] of [
        ["sales", "Ringkasan Sales Manager", "Tidak ada batch yang menunggu tinjauan Anda."],
        ["om", "Ringkasan antrean langsung", "Tidak ada batch yang menunggu persetujuan OM."],
    ] as const) {
        gagal = true;
        await page.goto(`/off-program-control?tab=${tab}`, NAV);
        await expect(main.getByRole("heading", { name: "Antrean gagal dimuat" })).toBeVisible(NAV);
        await expect(main.getByText("Ini bukan daftar kosong.")).toBeVisible();
        await expect(main.getByRole("group", { name: ringkas })).toHaveCount(0);
        await expect(main.getByText(kosong)).toHaveCount(0);
        gagal = false;
        await main.getByRole("button", { name: "Coba lagi" }).click();
        await expect(main.getByRole("heading", { name: kosong })).toBeVisible(NAV);
        await expect(main.getByRole("group", { name: ringkas })).toBeVisible();
    }
});

test("ponsel 390 px: SM dan OM — aksi di footer, dialog, tanpa gulir menyamping", async ({ page }) => {
    await mockOpc(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/off-program-control?tab=sales", NAV);
    const main = page.locator("main");
    await expect(antrean(page).getByRole("button")).toHaveCount(2, NAV);
    await noOverflow(page);
    await antrean(page).getByRole("button", { name: /007\/KINO/ }).click();
    const detail = detailOf(page);
    await expect(detail.getByRole("heading", { level: 1, name: "007/KINO/10/2026" })).toBeVisible(NAV);
    await expect(detail.getByRole("list", { name: "Kelengkapan awal per item" })).toBeVisible();
    // Label pendek di ponsel (nama aksesibel tetap lengkap) dan teks tombol tidak terpotong.
    await expect(footer(page).getByRole("button")).toHaveText(["Kembalikan…", "Setujui…"], { useInnerText: true });
    expect(await footer(page).getByRole("button").evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-opc-sm-ponsel.png", fullPage: true });
    await footer(page).getByRole("button", { name: "Kembalikan ke SPV…" }).click();
    const dlg = page.getByRole("dialog", { name: "Kembalikan 007/KINO/10/2026 ke SPV?" });
    await expect(dlg).toBeVisible();
    await noOverflow(page);
    await dlg.getByRole("button", { name: "Batal", exact: true }).click();

    await page.goto("/off-program-control?tab=om", NAV);
    await expect(main.getByRole("group", { name: "Ringkasan antrean langsung" })).toBeVisible(NAV);
    await noOverflow(page);
    await antrean(page).getByRole("button", { name: /002\/KINO/ }).click();
    await expect(detail.getByRole("heading", { level: 1, name: "002/KINO/10/2026" })).toBeVisible(NAV);
    await expect(footer(page).getByRole("button", { name: "Setujui…" })).toBeVisible();
    expect(await footer(page).getByRole("button").evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-opc-om-ponsel.png", fullPage: true });
});
