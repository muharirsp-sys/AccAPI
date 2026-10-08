/*
 * Tujuan: Fiori S4d OFF Program Control — peran Keuangan (ZONA UANG): pilih item satu cara bayar, draf + penjaga pindah batch,
 *   Catat pembayaran lewat dialog `bayar` dengan FormData diperiksa (sama dengan kode lama), Batal tidak mengirim, klik ganda = satu POST,
 *   tolakan server tampil di dialog dan mengunci sampai detail segar, detail gagal dimuat ulang = tombol terkunci, lunas → verifikasi
 *   final Klaim; pengembalian selisih: Tolak wajib alasan (Batal tidak mengirim), Verifikasi, data usang/gagal = terkunci; batch yang
 *   tidak menunggu bayar tanpa aksi (BL-06); Ajukan pengembalian dari Keuangan (kode lama) dengan payload diperiksa; jawaban 504/502
 *   HTML proxy = "hasil tidak pasti" tanpa HTML mentah; galat ≠ kosong; ponsel 390 px tanpa gulir menyamping.
 * Caller: Playwright lokal: `npx playwright test tests/fiori-opc-keuangan.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: /api/off-program-control/* dan /api/auth/get-session di-mock dengan page.route (tidak menyentuh DB).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const kini = new Date().toISOString();
type Over = Record<string, unknown>;
type Baris = Record<string, unknown> & { id: string };

const OMOK = { smStatus: "Approved by SM", claimStatus: "Approved", omStatus: "Approved", locked: true };
const batch = (id: string, no: string, principleCode: string, principleName: string, over: Over = {}): Baris => ({
    id, noPengajuan: no, gelombang: no.slice(0, 3), principleCode, principleName, bulan: no.split("/").at(-2), tahun: "2026",
    supervisorName: "Rahmat", status: "OM Approved", ...OMOK, financeStatus: "Waiting Payment", finalStatus: "Not Started",
    createdBy: "u-spv", createdByRole: "supervisor", refundStatus: "Not Applicable", createdAt: kini, updatedAt: kini, payments: [],
    periodDates: { pengajuan: ["2026-09-20"], program: [], claim: [], bayar: [] }, ...over,
});
const item = (id: string, itemNo: number, toko: string, nominal: number, caraBayar: string, over: Over = {}): Baris => ({
    id, itemNo, noSurat: "URC/PRG/0904", namaProgram: "Display Piattos Sep", periode: "2026-09-01 - 2026-09-30", toko, barang: "Piattos 75g",
    nominal, caraBayar, noRekening: caraBayar === "Transfer" ? "BRI 0231-01-004512-50-3" : null, type: "Display", deadline: "2026-09-30",
    kwt: true, skp: true, fp: false, pc: false, foto: true, rekap: true, others: false, othersText: null, financePaymentStatus: null, financePaymentId: null, ...over,
});

function dataAwal() {
    return {
        batches: [
            batch("b-bayar", "004/URC/09/2026", "URC", "URC INDONESIA, PT", { status: "Partial Paid", financeStatus: "Partial Paid", financeNote: "Transfer dari rekening operasional", claimDeadline: "2099-10-30" }),
            batch("b-bayar2", "012/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", { bulan: "10" }),
            batch("b-lebih", "008/HEINZ/09/2026", "HEINZ", "HEINZ ABC INDONESIA, PT", { status: "Paid", financeStatus: "Paid", finalStatus: "Pending Refund", refundStatus: "Pending Refund", supervisorName: "Zul" }),
        ],
        items: {
            "b-bayar": [
                item("b-bayar-i1", 1, "TK Mulia", 2_200_000, "Transfer"),
                item("b-bayar-i2", 2, "UD Sejahtera", 2_100_000, "Tunai"),
                item("b-bayar-i3", 3, "TK Abadi", 1_500_000, "Transfer", { financePaymentStatus: "paid", financePaymentId: "p-0", financePaidAmount: 1_500_000 }),
            ],
            "b-bayar2": [item("b-bayar2-i1", 1, "TK Sinar Jaya", 900_000, "Tunai")],
            "b-lebih": [item("b-lebih-i1", 1, "TK Makmur", 4_300_000, "Transfer", { financePaymentStatus: "paid", financePaymentId: "p-9" })],
        } as Record<string, Baris[]>,
        payments: {
            "b-bayar": [{ id: "p-0", batchId: "b-bayar", paymentNo: 1, paymentDate: "2026-10-01", paymentMethod: "Transfer", paidAmount: 1_500_000, senderBank: "BCA", paymentProofName: "OPC-004-1.pdf", proofUrl: "/api/off-program-control/payments/p-0/proof", note: null }],
            "b-bayar2": [],
            "b-lebih": [{ id: "p-9", batchId: "b-lebih", paymentNo: 1, paymentDate: "2026-09-25", paymentMethod: "Transfer", paidAmount: 4_300_000, senderBank: "BCA", paymentProofName: "OPC-008-1.pdf", proofUrl: null, note: null }],
        } as Record<string, Baris[]>,
        refunds: [
            { id: "rf-1", batchId: "b-lebih", refundNo: 1, refundAmount: 450_000, refundMethod: "Transfer", refundDate: "2026-10-03", senderName: "Zul", receiverBank: "BCA operasional", note: "transfer balik", status: "Pending" },
            { id: "rf-2", batchId: "b-lebih", refundNo: 2, refundAmount: 200_000, refundMethod: "Tunai", refundDate: "2026-10-05", senderName: "Zul", receiverBank: null, note: null, status: "Pending" },
        ] as Baris[],
    };
}

/** Tolakan tiruan: JSON `{ok:false,error}` atau halaman HTML proxy; `setelahCommit` = data sudah tersimpan sebelum jawaban gagal. */
type Tolak = { status: number; error?: string; html?: string; setelahCommit?: boolean };
type Opsi = { peran?: string; tundaBayar?: number; tolakBayar?: Tolak[]; tolakRefund?: Tolak[]; daftar?: () => ReturnType<typeof json> };
const jawabTolak = (t: Tolak) => (t.html ? { status: t.status, contentType: "text/html", body: t.html } : json({ ok: false, error: t.error }, t.status));

/** Semua endpoint OPC dimock dengan keadaan yang berubah setelah tulis. Mengembalikan catatan tulis + saklar galat. */
async function mockOpc(page: Page, opsi: Opsi = {}) {
    const s = dataAwal();
    const tolak = [...(opsi.tolakBayar ?? [])];
    const tolakRefund = [...(opsi.tolakRefund ?? [])];
    const m = { tulis: [] as string[], bayar: [] as string[], refund: [] as unknown[], ajukan: [] as unknown[], gagalDetail: false, gagalRefund: false, getDetail: 0 };
    if (opsi.peran) {
        await page.route((u) => u.pathname === "/api/auth/get-session", (r) => r.fulfill(json({
            session: { id: "s1", userId: "u-1", token: "t", expiresAt: new Date(Date.now() + 864e5).toISOString(), createdAt: kini, updatedAt: kini },
            user: { id: "u-1", name: "Dewi Lestari", email: "dewi@example.invalid", emailVerified: true, role: opsi.peran, createdAt: kini, updatedAt: kini },
        })));
    }
    const ringkas = (id: string) => {
        const total = s.items[id].reduce((t, i) => t + Number(i.nominal), 0);
        const paid = s.payments[id].reduce((t, p) => t + Number(p.paidAmount), 0);
        return { totalNominal: total, totalPaid: paid, remainingAmount: total - paid, isFullyPaid: total - paid === 0 };
    };
    const daftarBatch = () => s.batches.map((b) => ({ ...b, summary: { totalNominal: ringkas(b.id).totalNominal, totalRows: s.items[b.id].length }, paymentSummary: ringkas(b.id) }));
    await page.route((u) => u.pathname.startsWith("/api/off-program-control/"), async (r) => {
        const req = r.request();
        const p = new URL(req.url()).pathname;
        if (p === "/api/off-program-control/batches") return r.fulfill(opsi.daftar ? opsi.daftar() : json({ ok: true, batches: daftarBatch() }));
        const x = /^\/api\/off-program-control\/batches\/([^/]+)(?:\/(refund|audit|finance-payment))?$/.exec(p);
        if (!x) return r.fulfill(json({ ok: false, error: "tidak dimock" }, 404));
        const id = decodeURIComponent(x[1]);
        const b = s.batches.find((y) => y.id === id)!;
        if (req.method() !== "GET") {
            m.tulis.push(`${req.method()} ${p}`);
            if (x[2] === "finance-payment" && req.method() === "POST") {
                const body = req.postDataBuffer()?.toString("latin1") ?? "";
                m.bayar.push(body);
                if (opsi.tundaBayar) await new Promise((ok) => setTimeout(ok, opsi.tundaBayar));
                const t = tolak.shift();
                if (t && !t.setelahCommit) return r.fulfill(jawabTolak(t));
                const ids = JSON.parse(bidang(body, "itemIds") ?? "[]") as string[];
                const pilih = s.items[id].filter((i) => ids.includes(i.id));
                const paymentNo = s.payments[id].length + 1;
                const bayar = { id: `p-${id}-${paymentNo}`, batchId: id, paymentNo, paymentDate: bidang(body, "paymentDate"), paymentMethod: pilih[0].caraBayar,
                    paidAmount: pilih.reduce((t, i) => t + Number(i.nominal), 0), senderBank: bidang(body, "senderBank"), paymentProofName: `OPC-${paymentNo}.pdf`,
                    proofUrl: `/api/off-program-control/payments/p-${id}-${paymentNo}/proof`, note: bidang(body, "note") };
                s.payments[id].push(bayar);
                for (const i of pilih) Object.assign(i, { financePaymentStatus: "paid", financePaymentId: bayar.id });
                const ps = ringkas(id);
                Object.assign(b, ps.isFullyPaid
                    ? { status: "Paid", financeStatus: "Paid", finalStatus: "Waiting Claim Final Verification" }
                    : { status: "Partial Paid", financeStatus: "Partial Paid" });
                if (t) return r.fulfill(jawabTolak(t));
                return r.fulfill(json({ ok: true, message: ps.isFullyPaid ? "Pembayaran lunas dan dikirim ke Claim Final Verification." : "Pembayaran berhasil dicatat. Pengajuan masih Partial Paid di Keuangan.", payment: bayar, paymentSummary: ps }));
            }
            if (x[2] === "refund" && req.method() === "PATCH") {
                const body = req.postDataJSON() as { refundId: string; action: string; note: string };
                m.refund.push(body);
                const t = tolakRefund.shift();
                if (t && !t.setelahCommit) return r.fulfill(jawabTolak(t));
                const rf = s.refunds.find((y) => y.id === body.refundId)!;
                rf.status = body.action === "verify" ? "Verified" : "Rejected";
                rf.verificationNote = body.note || null;
                if (body.action === "verify") b.refundStatus = "Partially Refunded";
                return r.fulfill(json({ ok: true, message: `Pengembalian #${rf.refundNo} diproses.` }));
            }
            if (x[2] === "refund" && req.method() === "POST") {
                const body = req.postDataJSON() as Over;
                m.ajukan.push(body);
                s.refunds.push({ id: `rf-${s.refunds.length + 1}`, batchId: id, refundNo: s.refunds.length + 1, ...body, status: "Pending" });
                return r.fulfill(json({ ok: true, message: "Refund berhasil disubmit." }));
            }
            return r.fulfill(json({ ok: false, error: "tidak dimock" }, 405));
        }
        if (x[2] === "audit") return r.fulfill(json({ ok: true, audit: [] }));
        if (x[2] === "refund") {
            if (m.gagalRefund) return r.fulfill(json({ ok: false, error: "Gagal memuat data refund." }, 500));
            const refunds = s.refunds.filter((y) => y.batchId === id);
            const verified = refunds.filter((y) => y.status === "Verified").reduce((t, y) => t + Number(y.refundAmount), 0);
            const pending = refunds.filter((y) => y.status === "Pending").reduce((t, y) => t + Number(y.refundAmount), 0);
            const over = id === "b-lebih" ? 650_000 : 0;
            return r.fulfill(json({ ok: true, refunds, summary: { paidAmount: 4_300_000, verifiedAmount: 4_300_000 - over, overpaidAmount: over, totalRefunded: verified, pendingRefund: pending, remainingRefund: over - verified, isFullyRefunded: false } }));
        }
        m.getDetail += 1;
        if (m.gagalDetail) return r.fulfill(json({ ok: false, error: "Gagal mengambil detail batch." }, 500));
        const ps = ringkas(id);
        return r.fulfill(json({ ok: true, batch: { ...b }, items: s.items[id].map((i) => ({ ...i })), payments: s.payments[id],
            summary: { totalRows: s.items[id].length, totalNominal: ps.totalNominal }, paymentSummary: ps }));
    });
    return m;
}

/** Isian multipart: nilai teks, atau nama berkas untuk isian berkas. */
function bidang(body: string, nama: string): string | undefined {
    const x = new RegExp(`name="${nama}"(?:; filename="([^"]*)")?\\r\\n(?:Content-Type: [^\\r]*\\r\\n)?\\r\\n([^\\r]*)`).exec(body);
    return x ? x[1] ?? x[2] : undefined;
}
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
const antrean = (page: Page) => page.locator("main").getByRole("list", { name: /^Antrean / });
const PDF = { name: "bukti_urc.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 bukti transfer") };

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Catat pembayaran: pilih item satu cara bayar, draf, dialog dengan FormData sama kode lama; Batal tidak mengirim; klik ganda = satu POST", async ({ page }) => {
    const m = await mockOpc(page, { peran: "finance", tundaBayar: 800 });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=finance&batch=b-bayar", NAV);
    const main = page.locator("main");
    const detail = main.getByRole("region", { name: "Batch terbuka" });
    await expect(detail.getByRole("heading", { level: 1, name: "004/URC/09/2026" })).toBeVisible(NAV);
    await expect(main.getByText("Peran OFF: Keuangan.")).toBeVisible();
    const footer = detail.locator(".fi-ftb");
    const catat = footer.getByRole("button", { name: "Catat pembayaran…" });
    await expect(catat).toBeDisabled();
    await expect(footer).toContainText("Pilih item yang akan dibayar dulu.");
    const tabel = detail.getByRole("table", { name: "Item batch" });
    await expect(tabel.getByRole("checkbox", { name: /TK Abadi/ })).toBeDisabled(); // sudah dibayar
    await expect(tabel.getByRole("row", { name: /TK Abadi/ })).toContainText("Dibayar");
    await expect(detail.getByText("Batch ini memiliki lebih dari satu cara bayar.")).toBeVisible();

    // "Pilih semua" pada batch Transfer + Tunai ditolak seperti toggle lama.
    await tabel.getByRole("checkbox", { name: "Pilih semua baris" }).click();
    await expect(detail.getByText("Pilih item dengan cara bayar yang sama.").first()).toBeVisible();
    await expect(tabel.getByRole("checkbox", { name: /TK Mulia/ })).not.toBeChecked();
    await tabel.getByRole("checkbox", { name: /TK Mulia/ }).check();
    await expect(tabel.getByRole("checkbox", { name: /UD Sejahtera/ })).toBeDisabled(); // cara bayar lain
    await expect(detail.getByText("Draf belum disimpan")).toBeVisible();
    await expect(footer).toContainText("1 item dipilih · Rp 2.200.000 · Transfer · Isi tanggal bayar dulu.");

    // Lampiran divalidasi seperti kode lama (jenis berkas), pesan sama.
    const lampiran = detail.getByLabel("Lampiran bank (opsional)");
    await lampiran.setInputFiles({ name: "catatan.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await expect(detail.getByText("File bukti pembayaran harus PDF/PNG/JPG/JPEG.").first()).toBeVisible();
    await lampiran.setInputFiles(PDF);
    await detail.getByLabel("Tanggal bayar").fill("2026-10-06");
    await detail.getByLabel("Bank pengirim").fill("BCA");
    const catatan = detail.getByLabel("Catatan Keuangan");
    await expect(catatan).toHaveValue("Transfer dari rekening operasional"); // diisi dari batch seperti kode lama
    await catatan.fill("Transfer gelombang 2");
    await expect(catat).toBeEnabled();

    // Draf menahan pindah batch: Batal = tetap di batch ini dengan pilihan utuh.
    await antrean(page).getByRole("button", { name: /012\/KINO\/10\/2026/ }).click();
    const tinggal = page.getByRole("dialog", { name: "Tinggalkan perubahan yang belum disimpan?" });
    await expect(tinggal).toBeVisible();
    await tinggal.getByRole("button", { name: "Batal" }).click();
    await expect(page).toHaveURL(/batch=b-bayar(&|$)/);
    await expect(tabel.getByRole("checkbox", { name: /TK Mulia/ })).toBeChecked();

    await catat.click();
    const dlg = page.getByRole("dialog", { name: "Catat pembayaran 004/URC/09/2026?" });
    await expect(dlg).toBeVisible();
    for (const t of ["1 dari 2 item yang belum dibayar", "Transfer", "Rp 2.200.000", "06/10/2026", "BCA", "bukti_urc.pdf · divalidasi, tidak disimpan", "Rp 4.300.000"]) await expect(dlg).toContainText(t);
    await expect(dlg.getByLabel("Usulan BL-08")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-opc-keuangan-dialog.png" });
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(dlg).toBeHidden();
    expect(m.tulis).toEqual([]); // Batal tidak mengirim apa pun

    await catat.click();
    const ok = dlg.getByRole("button", { name: "Catat Rp 2.200.000" });
    await ok.dblclick();
    await expect(ok).toBeDisabled(); // busy selama POST berjalan
    await expect(dlg).toBeHidden({ timeout: 15_000 });
    expect(m.tulis).toEqual(["POST /api/off-program-control/batches/b-bayar/finance-payment"]); // klik ganda = satu POST
    const body = m.bayar[0];
    expect(bidang(body, "paymentDate")).toBe("2026-10-06");
    expect(bidang(body, "senderBank")).toBe("BCA");
    expect(bidang(body, "note")).toBe("Transfer gelombang 2");
    expect(bidang(body, "itemIds")).toBe('["b-bayar-i1"]');
    expect(bidang(body, "paymentProof")).toBe("bukti_urc.pdf");

    // Sebagian: tetap di Keuangan, hasil pembayaran tampil, pilihan & draf kosong, bank dipertahankan.
    const hasil = detail.getByRole("status").filter({ hasText: "Pembayaran ke-2 tercatat." });
    await expect(hasil).toBeVisible(NAV);
    await expect(hasil).toContainText("Rp 2.100.000");
    await expect(hasil).toContainText("Belum lunas");
    await expect(tabel.getByRole("row", { name: /TK Mulia/ })).toContainText("Dibayar");
    await expect(detail.getByText("Draf belum disimpan")).toHaveCount(0);
    await expect(footer).toContainText("Pilih item yang akan dibayar dulu.");
    await expect(detail.getByLabel("Bank pengirim")).toHaveValue("BCA");
    await expect(detail.getByLabel("Tanggal bayar")).toHaveValue("");
    await expect(page).toHaveURL(/batch=b-bayar(&|$)/);
    await page.screenshot({ path: "test-results/fiori-opc-keuangan-sebagian.png", fullPage: true });
});

test("tolakan server tampil di dialog dan mengunci sampai detail segar; detail gagal dimuat ulang = terkunci; lunas → verifikasi final Klaim", async ({ page }) => {
    const m = await mockOpc(page, { tolakBayar: [{ status: 409, error: "Item yang sudah dibayar tidak boleh dipilih lagi." }] });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=finance&batch=b-bayar2", NAV);
    const main = page.locator("main");
    const detail = main.getByRole("region", { name: "Batch terbuka" });
    await expect(detail.getByRole("heading", { level: 1, name: "012/KINO/10/2026" })).toBeVisible(NAV);
    const tabel = detail.getByRole("table", { name: "Item batch" });
    await tabel.getByRole("checkbox", { name: /TK Sinar Jaya/ }).check();
    await detail.getByLabel("Tanggal bayar").fill("2026-10-07");
    const footer = detail.locator(".fi-ftb");
    const catat = footer.getByRole("button", { name: "Catat pembayaran…" });
    await catat.click();
    const dlg = page.getByRole("dialog", { name: "Catat pembayaran 012/KINO/10/2026?" });
    m.gagalDetail = true; // muat ulang sesudah tolakan juga gagal
    await dlg.getByRole("button", { name: "Catat Rp 900.000" }).click();
    await expect(dlg.getByRole("alert")).toHaveText("Item yang sudah dibayar tidak boleh dipilih lagi.", NAV);
    await expect(detail.getByRole("alert").filter({ hasText: "Gagal memuat ulang detail." })).toBeVisible(NAV);
    // Status di layar = hasil sebelumnya → Catat terkunci dengan alasan, di dialog maupun footer.
    await expect(dlg.getByRole("button", { name: "Catat Rp 900.000" })).toBeDisabled();
    await expect(dlg.getByRole("button", { name: "Catat Rp 900.000" })).toHaveAttribute("title", /gagal dimuat ulang/);
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(catat).toBeDisabled();
    await expect(footer).toContainText("Detail batch gagal dimuat ulang");
    await expect(tabel.getByRole("checkbox", { name: /TK Sinar Jaya/ })).toBeDisabled();
    await page.screenshot({ path: "test-results/fiori-opc-keuangan-terkunci.png", fullPage: true });

    m.gagalDetail = false;
    await detail.getByRole("alert").filter({ hasText: "Gagal memuat ulang detail." }).getByRole("button", { name: "Coba lagi" }).click();
    await expect(catat).toBeEnabled(NAV); // detail segar: pilihan dan tanggal masih ada
    await catat.click();
    await dlg.getByRole("button", { name: "Catat Rp 900.000" }).click();
    await expect(dlg).toBeHidden(NAV);
    await expect(main.getByRole("status").filter({ hasText: "Pembayaran lunas. Batch diteruskan ke verifikasi final Klaim." }).first()).toBeVisible(NAV);
    await expect(detail.getByRole("status").filter({ hasText: "Pembayaran lunas." })).toContainText("Lunas");
    await expect(antrean(page)).not.toContainText("012/KINO/10/2026", NAV);
    await expect(detail.getByRole("button", { name: "Catat pembayaran…" })).toHaveCount(0); // BL-06: batch lunas tanpa aksi bayar
    expect(m.tulis).toEqual(Array(2).fill("POST /api/off-program-control/batches/b-bayar2/finance-payment"));
    expect(m.bayar.map((b) => bidang(b, "itemIds"))).toEqual(['["b-bayar2-i1"]', '["b-bayar2-i1"]']);
    expect(bidang(m.bayar[1], "paymentProof")).toBeUndefined(); // tanpa lampiran = tanpa isian berkas, seperti kode lama
});

test("pengembalian selisih: Tolak wajib alasan dan Batal tidak mengirim; Verifikasi; data usang/gagal = terkunci; tanpa aksi bayar (BL-06)", async ({ page }) => {
    const m = await mockOpc(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=finance&view=selisih&batch=b-lebih", NAV);
    const main = page.locator("main");
    const detail = main.getByRole("region", { name: "Batch terbuka" });
    await expect(detail.getByRole("heading", { level: 1, name: "008/HEINZ/09/2026" })).toBeVisible(NAV);
    await expect(main.getByRole("group", { name: "Tampilan antrean" }).getByRole("button", { name: /Pengembalian selisih/ })).toHaveAttribute("aria-pressed", "true");
    await expect(antrean(page).getByRole("button")).toHaveCount(1);
    await expect(detail.getByRole("button", { name: "Catat pembayaran…" })).toHaveCount(0);
    const bagian = detail.getByRole("region", { name: "Verifikasi pengembalian" });
    await expect(bagian.getByRole("list", { name: "Pengembalian menunggu verifikasi" }).getByRole("listitem")).toHaveCount(2, NAV);

    await bagian.getByRole("button", { name: "Tolak pengembalian ke-1" }).click();
    const tolak = page.getByRole("dialog", { name: "Tolak pengembalian Rp 450.000?" });
    await expect(tolak).toBeVisible();
    await expect(tolak).toContainText("Batal menutup dialog tanpa mengubah apa pun.");
    const kirimTolak = tolak.getByRole("button", { name: "Tolak pengembalian" });
    await expect(kirimTolak).toBeDisabled(); // alasan wajib
    await tolak.getByLabel("Alasan penolakan").fill("Dana belum masuk");
    await tolak.getByRole("button", { name: "Batal" }).click();
    await expect(tolak).toBeHidden();
    expect(m.tulis).toEqual([]); // prompt lama tetap menolak walau Batal; dialog tidak

    await bagian.getByRole("button", { name: "Tolak pengembalian ke-1" }).click();
    await expect(tolak.getByLabel("Alasan penolakan")).toHaveValue(""); // alasan lama tidak terbawa
    await tolak.getByLabel("Alasan penolakan").fill("Dana belum masuk di rekening operasional per 6 Okt.");
    m.gagalDetail = true; // muat ulang sesudah menolak gagal → data pengembalian usang
    await kirimTolak.click();
    await expect(tolak).toBeHidden(NAV);
    expect(m.refund).toEqual([{ refundId: "rf-1", action: "reject", note: "Dana belum masuk di rekening operasional per 6 Okt." }]);
    await expect(detail.getByRole("status").filter({ hasText: "Pengembalian ke-1 (Rp 450.000) ditolak" })).toBeVisible();
    await expect(detail.getByRole("alert").filter({ hasText: "Gagal memuat ulang detail." })).toBeVisible(NAV);
    await expect(bagian.getByRole("button", { name: "Verifikasi pengembalian ke-2" })).toBeDisabled();
    await expect(bagian).toContainText("Detail batch gagal dimuat ulang");

    m.gagalDetail = false;
    await detail.getByRole("alert").filter({ hasText: "Gagal memuat ulang detail." }).getByRole("button", { name: "Coba lagi" }).click();
    await expect(bagian.getByRole("list", { name: "Pengembalian menunggu verifikasi" }).getByRole("listitem")).toHaveCount(1, NAV);
    await bagian.getByRole("button", { name: "Verifikasi pengembalian ke-2" }).click();
    const verif = page.getByRole("dialog", { name: "Verifikasi pengembalian Rp 200.000?" });
    await expect(verif).toContainText("008/HEINZ/09/2026");
    m.gagalRefund = true; // sesudah verifikasi, data pengembalian gagal dimuat
    await verif.getByRole("button", { name: "Verifikasi pengembalian" }).click();
    await expect(verif).toBeHidden(NAV);
    expect(m.refund.at(-1)).toEqual({ refundId: "rf-2", action: "verify", note: "" });
    await expect(bagian.getByText("Pengembalian yang menunggu verifikasi belum bisa ditampilkan.")).toBeVisible(NAV);
    await expect(bagian.getByRole("button", { name: /^Verifikasi pengembalian/ })).toHaveCount(0);
    expect(m.tulis).toEqual(Array(2).fill("PATCH /api/off-program-control/batches/b-lebih/refund"));
});

test("Ajukan pengembalian dari Keuangan (kode lama: submit_refund atau finance_payment, sisa > 0): payload sama, lewat dialog", async ({ page }) => {
    const m = await mockOpc(page, { peran: "finance" });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=finance&view=selisih&batch=b-lebih", NAV);
    const detail = page.locator("main").getByRole("region", { name: "Batch terbuka" });
    const bagian = detail.getByRole("region", { name: "Ajukan pengembalian" });
    await expect(bagian).toContainText("Rp 650.000", NAV); // sisa yang harus dikembalikan
    const ajukan = bagian.getByRole("button", { name: "Ajukan pengembalian…" });
    await expect(ajukan).toBeDisabled();
    await bagian.getByLabel("Jumlah pengembalian").fill("250.000");
    await bagian.getByLabel("Cara pengembalian").selectOption("Tunai");
    await bagian.getByLabel("Tanggal pengembalian").fill("2026-10-08");
    await bagian.getByLabel("Nama pengirim").fill("Zul");
    await bagian.getByLabel("Bank penerima").fill("BCA operasional");
    await bagian.getByLabel("Catatan", { exact: true }).fill("sisa selisih");
    await expect(detail.getByText("Draf belum disimpan")).toBeVisible();
    await ajukan.click();
    const dlg = page.getByRole("dialog", { name: "Ajukan pengembalian Rp 250.000 untuk 008/HEINZ/09/2026?" });
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "Batal" }).click();
    expect(m.tulis).toEqual([]);
    await ajukan.click();
    await dlg.getByRole("button", { name: "Ajukan pengembalian", exact: true }).click();
    await expect(dlg).toBeHidden(NAV);
    expect(m.ajukan).toEqual([{ refundAmount: 250_000, refundMethod: "Tunai", refundDate: "2026-10-08", senderName: "Zul", receiverBank: "BCA operasional", note: "sisa selisih" }]);
    await expect(detail.getByRole("status").filter({ hasText: "Pengembalian Rp 250.000 untuk 008/HEINZ/09/2026 diajukan" })).toBeVisible();
    await expect(detail.getByRole("list", { name: "Pengembalian menunggu verifikasi" }).getByRole("listitem")).toHaveCount(3, NAV);
    await expect(detail.getByText("Draf belum disimpan")).toHaveCount(0);
});

const HTML_504 = "<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>nginx</center></body></html>";

test("jawaban 504 HTML proxy sesudah tersimpan = hasil tidak pasti tanpa HTML; muat ulang mengeluarkan item yang ternyata lunas (tidak bisa dibayar ulang)", async ({ page }) => {
    const m = await mockOpc(page, { tolakBayar: [{ status: 504, html: HTML_504, setelahCommit: true }] });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=finance&batch=b-bayar", NAV);
    const detail = page.locator("main").getByRole("region", { name: "Batch terbuka" });
    const tabel = detail.getByRole("table", { name: "Item batch" });
    await tabel.getByRole("checkbox", { name: /TK Mulia/ }).check({ timeout: NAV.timeout });
    await detail.getByLabel("Tanggal bayar").fill("2026-10-06");
    await detail.locator(".fi-ftb").getByRole("button", { name: "Catat pembayaran…" }).click();
    const dlg = page.getByRole("dialog", { name: "Catat pembayaran 004/URC/09/2026?" });
    await dlg.getByRole("button", { name: "Catat Rp 2.200.000" }).click();
    const galat = dlg.getByRole("alert");
    await expect(galat).toContainText("Server tidak memberi jawaban yang pasti", NAV);
    await expect(galat).not.toContainText("<");
    await expect(galat).not.toContainText("nginx");
    // Server ternyata menyimpan: sesudah muat ulang TK Mulia lunas dan keluar dari pilihan → Catat tidak bisa diulang.
    await expect(dlg.getByRole("button", { name: /^Catat Rp/ })).toHaveAttribute("title", "Pilih item yang akan dibayar dulu.", NAV);
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(tabel.getByRole("row", { name: /TK Mulia/ })).toContainText("Dibayar");
    await expect(detail.getByRole("status").filter({ hasText: "Hasil aksi terakhir belum pasti." })).toBeVisible();
    expect(m.tulis).toEqual(["POST /api/off-program-control/batches/b-bayar/finance-payment"]);
});

test("jawaban 502 HTML pada verifikasi pengembalian = hasil tidak pasti tanpa HTML; detail dimuat ulang", async ({ page }) => {
    const m = await mockOpc(page, { tolakRefund: [{ status: 502, html: HTML_504.replaceAll("504 Gateway Time-out", "502 Bad Gateway") }] });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=finance&view=selisih&batch=b-lebih", NAV);
    const detail = page.locator("main").getByRole("region", { name: "Batch terbuka" });
    await detail.getByRole("button", { name: "Verifikasi pengembalian ke-1" }).click({ timeout: NAV.timeout });
    const dlg = page.getByRole("dialog", { name: "Verifikasi pengembalian Rp 450.000?" });
    const getSebelum = m.getDetail;
    await dlg.getByRole("button", { name: "Verifikasi pengembalian" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Server tidak memberi jawaban yang pasti", NAV);
    await expect(dlg.getByRole("alert")).not.toContainText("<");
    await expect.poll(() => m.getDetail).toBeGreaterThan(getSebelum);
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(detail.getByRole("status").filter({ hasText: "Hasil aksi terakhir belum pasti." })).toBeVisible();
    expect(m.tulis).toEqual(["PATCH /api/off-program-control/batches/b-lebih/refund"]);
});

test("antrean Keuangan: galat bukan kosong; kosong per tampilan", async ({ page }) => {
    let mode: "galat" | "kosong" = "galat";
    await mockOpc(page, { daftar: () => (mode === "galat" ? json({ ok: false, error: "Server sedang sibuk." }, 500) : json({ ok: true, batches: [] })) });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=finance", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Antrean gagal dimuat" })).toBeVisible(NAV);
    await expect(main.getByText("Tidak ada batch yang menunggu pembayaran.")).toHaveCount(0);
    mode = "kosong";
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("heading", { name: "Tidak ada batch yang menunggu pembayaran." })).toBeVisible(NAV);
    await main.getByRole("group", { name: "Tampilan antrean" }).getByRole("button", { name: /Pengembalian selisih/ }).click();
    await expect(main.getByRole("heading", { name: "Tidak ada batch dengan selisih yang belum kembali." })).toBeVisible(NAV);
});

test("ponsel 390 px: pilih item di daftar, dialog bayar, tanpa gulir menyamping; Kembali ke daftar dijaga draf", async ({ page }) => {
    const m = await mockOpc(page, { peran: "finance" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/off-program-control?tab=finance&batch=b-bayar", NAV);
    const main = page.locator("main");
    const detail = main.getByRole("region", { name: "Batch terbuka" });
    await expect(detail.getByRole("heading", { level: 1, name: "004/URC/09/2026" })).toBeVisible(NAV);
    const daftarItem = detail.getByRole("list", { name: "Item batch" });
    await expect(daftarItem).toBeVisible();
    await expect(daftarItem.getByRole("checkbox", { name: /TK Abadi/ })).toBeDisabled();
    await daftarItem.getByRole("checkbox", { name: /TK Mulia/ }).check();
    await expect(daftarItem.getByRole("checkbox", { name: /UD Sejahtera/ })).toBeDisabled();
    await detail.getByLabel("Tanggal bayar").fill("2026-10-06");
    const footer = detail.locator(".fi-ftb");
    await expect(footer).toContainText("1 item dipilih");
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-opc-keuangan-ponsel.png", fullPage: true });
    await footer.getByRole("button", { name: "Catat pembayaran…" }).click();
    const dlg = page.getByRole("dialog", { name: "Catat pembayaran 004/URC/09/2026?" });
    await expect(dlg).toBeVisible();
    await noOverflow(page);
    await dlg.getByRole("button", { name: "Batal" }).click();
    await detail.getByRole("button", { name: "Kembali ke daftar" }).click();
    const tinggal = page.getByRole("dialog", { name: "Tinggalkan perubahan yang belum disimpan?" });
    await tinggal.getByRole("button", { name: "Tinggalkan" }).click();
    await expect(page).not.toHaveURL(/batch=/);
    await expect(antrean(page)).toBeVisible();
    await noOverflow(page);
    expect(m.tulis).toEqual([]);
});
