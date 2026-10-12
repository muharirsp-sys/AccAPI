/*
 * Tujuan: Fiori S4d OFF Program Control — peran Klaim: Validasi setelah SM (isian, draf, Setujui klaim lewat dialog `claimok` dengan payload
 *   claim-review diperiksa, batch pindah ke OM), Kembalikan (`kembali`, alasan wajib, galat server di dialog tanpa menghapus alasan, draf
 *   menahan pindah batch), setuju batch buatan sendiri (`sendiri`, BL-10: alasan wajib ≥ 5 → `alasanSendiri`, #132), Selesaikan verifikasi
 *   final batch buatan sendiri + alasan di Riwayat, batch terminal tanpa aksi (BL-06), Verifikasi final
 *   (`claimView=after`: No Claim + checklist per item, nilai fix → selisih, Ingatkan + Selesaikan dengan payload final-claim diperiksa,
 *   lalu Claim Workflow 409 → dibuka), Batch CLM (form di kolom kedua, nomor otomatis, payload POST /batches, Kirim ke SM), ponsel 390 px.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true; sesi peran Klaim dimock):
 *   `npx playwright test tests/fiori-opc-klaim.spec.ts --config playwright.fiori-local.config.ts --workers=1 --output=test-results/klaim`.
 * Dependensi: /api/off-program-control/*, /api/claim-workflow/from-off-batch/*, /api/auth/get-session di-mock dengan page.route.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const lalu = (hari: number) => new Date(Date.now() - hari * 864e5).toISOString();
const kini = lalu(0);
type Over = Record<string, unknown>;
type Kirim = { method: string; path: string; body: unknown };

const batch = (id: string, no: string, principleCode: string, principleName: string, over: Over = {}) => ({
    id, noPengajuan: no, gelombang: no.slice(0, 3), principleCode, principleName, bulan: "10", tahun: "2026",
    supervisorName: "Rahmat", status: "Draft", smStatus: "Not Started", claimStatus: "Not Started", omStatus: "Not Started",
    financeStatus: "Not Started", finalStatus: "Not Started", locked: false, createdBy: "u-spv", createdByRole: "supervisor",
    refundStatus: "Not Applicable", createdAt: kini, updatedAt: kini, payments: [],
    summary: { totalNominal: 4_300_000, totalRows: 2, transfer: 2_200_000, tunai: 2_100_000 },
    periodDates: { pengajuan: ["2026-10-02"], program: [], claim: [], bayar: [] }, ...over,
});
const SM = { smStatus: "Approved by SM", locked: true, smApprovedAt: kini };
const OMOK = { ...SM, claimStatus: "Approved", omStatus: "Approved" };
const LUNAS = { totalNominal: 4_300_000, totalPaid: 4_300_000, remainingAmount: 0, isFullyPaid: true };
const awalBatches = () => [
    batch("b-klaim", "005/GDI/10/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { status: "Approved by SM", ...SM, omStatus: "Notify OM", smNote: "Foto display sudah dicek SM." }),
    batch("b-sendiri", "001/CLM/GDI/10/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { status: "Approved by SM", ...SM, createdBy: "u-1", createdByRole: "claim", supervisorName: "Divisi Claim" }),
    batch("b-om", "002/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", { status: "Claim Approved", ...SM, claimStatus: "Approved", omStatus: "Waiting Approval", claimSubmittedDate: "2026-10-05", claimDeadline: "2099-11-05" }),
    batch("b-bayar", "004/URC/09/2026", "URC", "URC INDONESIA, PT", { status: "OM Approved", ...OMOK, financeStatus: "Waiting Payment", claimWorkflowId: "wf-1", claimWorkflowStatus: "Draft", claimDeadline: "2099-10-30" }),
    // Sumbu tidak konsisten: isClaimQueueBatch lama masih benar ("Cancelled by OM" tidak dikecualikan) — UI baru tidak memberi aksi (BL-06).
    batch("b-batal", "008/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", { status: "Cancelled by OM", ...SM, omStatus: "Cancelled", cancelNote: "Program dihentikan principal." }),
    batch("b-final", "001/RB/09/2026", "RB", "RECKITT BENCKISER, PT", { status: "Paid", ...OMOK, financeStatus: "Paid", finalStatus: "Waiting Claim Final Verification", bulan: "09", paidAt: kini, paidAmount: 4_300_000, paymentDate: "2026-10-06", financeNote: "Transfer BCA", paymentSummary: LUNAS }),
    batch("b-selesai", "003/GDI/09/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { status: "Completed", ...OMOK, financeStatus: "Paid", finalStatus: "Completed", bulan: "09", verifiedAmount: 4_300_000, finalClaimNote: "Lengkap.", paymentSummary: LUNAS }),
    batch("b-clmdraf", "002/CLM/RB/10/2026", "RB", "RECKITT BENCKISER, PT", { createdBy: "u-1", createdByRole: "claim", supervisorName: "Divisi Claim" }),
];
const item = (bid: string, n: number, noSurat: string, toko: string, nominal: number, over: Over = {}) => ({
    id: `${bid}-i${n}`, itemNo: n, noSurat, namaProgram: "Display Okt", periode: "2026-10-01 - 2026-10-31", toko, barang: null, nominal,
    caraBayar: n === 1 ? "Transfer" : "Tunai", type: "Display", deadline: "2026-10-31", kwt: true, skp: true, fp: false, pc: false, foto: true, rekap: true,
    others: false, othersText: null, noClaim: null, ...over,
});
const awalItems = (bid: string, kode: string) => [item(bid, 1, `${kode}/PRG/0931`, "TK Mulia", 2_200_000), item(bid, 2, `${kode}/PRG/0932`, "UD Sejahtera", 2_100_000)];
const PEMBAYARAN = [{ id: "p1", batchId: "b-final", paymentNo: 1, paymentDate: "2026-10-06", paymentMethod: "Transfer", paidAmount: 4_300_000, senderBank: "BCA", paymentProofName: "bukti_rb.pdf", proofUrl: "/api/off-program-control/payments/p1/proof", note: null }];

type Opsi = {
    gagal?: (path: string, body: Over) => ReturnType<typeof json> | null;
    /** Baris daftar (polling) lebih baru dari detail: kolom yang ditimpa hanya di GET /batches. */
    daftarUbah?: Record<string, Over>;
    /** Batch yang GET detailnya sedang gagal (diubah test saat berjalan). */
    detailGagal?: Set<string>;
    /** Batch tambahan (data contoh generik) dan isi GET /batches/[id]/audit per batch. */
    tambahan?: Array<Over & { id: string }>;
    audit?: Record<string, unknown[]>;
};

/** Mock OPC + sesi Klaim (u-1). Tulis mengubah status batch seperti route asli (garis besar) dan dicatat di `kirim`. */
async function mockKlaim(page: Page, opsi: Opsi = {}) {
    const kirim: Kirim[] = [];
    const batches = [...awalBatches(), ...(opsi.tambahan ?? [])] as Array<Over & { id: string }>;
    const items = new Map<string, Array<Over & { id: string }>>(batches.map((b) => [b.id, awalItems(b.id, String(b.principleCode))]));
    const ubah = (id: string, over: Over) => { const b = batches.find((x) => x.id === id)!; Object.assign(b, over, { updatedAt: new Date().toISOString() }); };
    await page.route((u) => u.pathname === "/api/auth/get-session", (r) => r.fulfill(json({
        session: { id: "s1", userId: "u-1", token: "t", expiresAt: lalu(-1), createdAt: kini, updatedAt: kini },
        user: { id: "u-1", name: "Rina Amalia", email: "rina@example.invalid", emailVerified: true, role: "claim", createdAt: kini, updatedAt: kini },
    })));
    await page.route((u) => u.pathname.startsWith("/api/claim-workflow/from-off-batch/"), (r) => {
        kirim.push({ method: r.request().method(), path: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
        return r.fulfill(json({ ok: false, code: "CLAIM_WORKFLOW_ALREADY_EXISTS", error: "Claim Workflow untuk OFF batch ini sudah ada.", workflow: { id: "wf-9" } }, 409));
    });
    await page.route((u) => u.pathname.startsWith("/api/off-program-control/"), (r) => {
        const req = r.request();
        const url = new URL(req.url());
        const p = url.pathname;
        if (req.method() !== "GET") {
            const body = (req.postDataJSON() ?? {}) as Over;
            kirim.push({ method: req.method(), path: p, body });
            const gagal = opsi.gagal?.(p, body);
            if (gagal) return r.fulfill(gagal);
            if (p === "/api/off-program-control/batches") {
                const baru = batch("b-new", `002/CLM/${body.principleCode}/${body.bulan}/${body.tahun}`, String(body.principleCode), String(body.principleName),
                    { createdBy: "u-1", createdByRole: "claim", supervisorName: "Divisi Claim", bulan: body.bulan, tahun: body.tahun });
                batches.unshift(baru);
                items.set("b-new", (body.items as Over[]).map((x, i) => item("b-new", i + 1, String(x.noSurat), String(x.toko), 1_000, { caraBayar: x.caraBayar })));
                return r.fulfill(json({ ok: true, batchId: "b-new", noPengajuan: baru.noPengajuan, gelombang: "002" }));
            }
            const m = /^\/api\/off-program-control\/batches\/([^/]+)\/(claim-review|final-claim|submit)$/.exec(p);
            if (!m) return r.fulfill(json({ ok: false, error: "tidak dimock" }, 404));
            const id = decodeURIComponent(m[1]);
            if (m[2] === "claim-review") {
                if (body.action === "return") ubah(id, { status: "Returned by Claim", claimStatus: "Returned", claimNote: body.note, locked: false, returnedAt: kini });
                else ubah(id, { status: "Claim Approved", claimStatus: "Approved", omStatus: "Waiting Approval", claimSubmittedDate: body.claimSubmittedDate, claimDeadline: body.claimDeadline, claimNote: body.note, claimReviewedAt: kini });
                return r.fulfill(json({ ok: true, message: "ok" }));
            }
            if (m[2] === "final-claim") {
                if (body.action === "remind_incomplete_documents") { ubah(id, { finalStatus: "Incomplete Documents", finalClaimNote: body.note }); return r.fulfill(json({ ok: true })); }
                const verified = Number(body.verifiedAmount ?? 4_300_000);
                const lebih = Math.max(0, 4_300_000 - verified);
                for (const ref of body.claimRefs as Over[]) Object.assign(items.get(id)!.find((x) => x.id === ref.itemId)!, ref);
                ubah(id, lebih > 0
                    ? { status: "Overpaid - Pending Refund", finalStatus: "Pending Refund", refundStatus: "Pending Refund", verifiedAmount: verified, finalClaimNote: body.note }
                    : { status: "Completed", finalStatus: "Completed", verifiedAmount: verified, finalClaimNote: body.note });
                return r.fulfill(json({ ok: true, overpaidAmount: lebih, refundRequired: lebih > 0 }));
            }
            ubah(id, { status: "Submitted to SM", smStatus: "Waiting Review", submittedAt: kini });
            return r.fulfill(json({ ok: true, batchId: id }));
        }
        if (p === "/api/off-program-control/batches") return r.fulfill(json({ ok: true, batches: batches.map((b) => ({ ...b, ...opsi.daftarUbah?.[b.id] })) }));
        if (p === "/api/off-program-control/batches/next-number") {
            const q = url.searchParams;
            return r.fulfill(json({ ok: true, gelombang: "002", noPengajuan: `002/CLM/${q.get("principleCode")}/${q.get("bulan")}/${q.get("tahun")}` }));
        }
        const m = /^\/api\/off-program-control\/batches\/([^/]+)(?:\/(refund|audit))?$/.exec(p);
        if (!m) return r.fulfill(json({ ok: false, error: "tidak dimock" }, 404));
        const id = decodeURIComponent(m[1]);
        if (m[2] === "refund") return r.fulfill(json({ ok: true, refunds: [], summary: { paidAmount: 0, verifiedAmount: 0, overpaidAmount: 0, totalRefunded: 0, pendingRefund: 0, remainingRefund: 0, isFullyRefunded: false } }));
        if (m[2] === "audit") return r.fulfill(json({ ok: true, audit: opsi.audit?.[id] ?? [] }));
        const b = batches.find((x) => x.id === id);
        if (opsi.detailGagal?.has(id)) return r.fulfill(json({ ok: false, error: "Gagal mengambil detail batch." }, 500));
        if (!b) return r.fulfill(json({ ok: false, error: "Pengajuan tidak ditemukan." }, 404));
        const { claimWorkflowId: _w, claimWorkflowStatus: _s, payments: _p, paymentSummary, ...dto } = b; // GET /batches/[id] tidak membawa agregat daftar
        void _w; void _s; void _p;
        const bayar = id === "b-final" || id === "b-selesai" ? PEMBAYARAN : [];
        return r.fulfill(json({
            ok: true, batch: dto, items: items.get(id) ?? [], payments: bayar,
            summary: { totalRows: 2, totalNominal: 4_300_000, transfer: 2_200_000, tunai: 2_100_000 },
            paymentSummary: paymentSummary ?? { totalNominal: 4_300_000, totalPaid: 0, remainingAmount: 4_300_000, isFullyPaid: false },
        }));
    });
    return kirim;
}

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
const antrean = (page: Page) => page.locator("main").getByRole("list", { name: /^Antrean / });
const kolomBatch = (page: Page) => page.locator("main").getByRole("region", { name: "Batch terbuka" });

test.beforeEach(async ({ page }) => {
    test.setTimeout(240_000); // mode dev: kompilasi rute pertama (OPC, Claim Workflow) lambat
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => {
        // beforeunload = penjaga draf (useUnsavedGuard), bukan dialog native pengganti ConfirmDialog.
        if (d.type() === "beforeunload") return void d.accept();
        throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`);
    });
});

test("Validasi setelah SM: isian + draf, Setujui klaim lewat dialog (payload claim-review sama), batch pindah ke OM", async ({ page }) => {
    const kirim = await mockKlaim(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=claim&batch=b-klaim", NAV);
    const main = page.locator("main");
    const detail = kolomBatch(page);
    await expect(detail.getByRole("heading", { level: 1, name: "005/GDI/10/2026" })).toBeVisible(NAV);
    // Antrean "Menunggu Anda" = batch yang punya aksi: batch dibatalkan dengan sumbu tidak konsisten tidak ikut (BL-06).
    await expect(antrean(page).getByRole("button")).toHaveCount(2);
    await expect(antrean(page)).not.toContainText("008/KINO/10/2026");

    const isi = detail.getByRole("region", { name: "Isi validasi" });
    await expect(isi.getByText("Checklist Supervisor bukan persetujuan.")).toBeVisible();
    await expect(isi.getByText("Foto display sudah dicek SM.")).toBeVisible();
    await expect(isi.getByRole("radio", { name: "Lengkap" })).toBeChecked();
    await expect(isi.getByLabel("Usulan BL-06")).toBeVisible();
    const footer = detail.locator(".fi-ftb");
    const setuju = footer.getByRole("button", { name: "Setujui klaim…" });
    await expect(setuju).toBeDisabled();
    await expect(footer).toContainText("Setujui nonaktif: Isi tanggal diajukan ke principal dulu.");
    await expect(footer.getByRole("button", { name: "Kembalikan…" })).toBeEnabled();

    await isi.getByLabel("Tanggal diajukan ke principal").fill("2026-10-06");
    await expect(detail.getByText("Draf belum disimpan")).toBeVisible();
    await isi.getByLabel("Deadline klaim").fill("2026-11-06");
    await expect(footer).toContainText("Keterangan kelengkapan wajib diisi sebelum Setujui klaim.");
    await isi.getByLabel("Keterangan kelengkapan").fill("Berkas lengkap, faktur pajak menyusul.");
    await isi.getByRole("radio", { name: "Kurang" }).check();
    await expect(setuju).toBeDisabled();
    await expect(footer).toContainText("Kelengkapan harus Lengkap untuk menyetujui");
    await isi.getByRole("radio", { name: "Lengkap" }).check();
    await expect(setuju).toBeEnabled();
    await expect(footer).toContainText("Isian validasi belum dikirim.");
    await page.screenshot({ path: "test-results/fiori-opc-klaim-validasi.png", fullPage: true });

    await setuju.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Setujui klaim 005/GDI/10/2026?" })).toBeVisible();
    await expect(dlg).toContainText("06/10/2026");
    await expect(dlg).toContainText("06/11/2026");
    await expect(dlg).toContainText("2 item · Rp 4.300.000");
    await expect(dlg).toContainText("Persetujuan Operational Manager");
    await expect(dlg.getByLabel("Usulan BL-11")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-opc-klaim-claimok.png" });
    await dlg.getByRole("button", { name: "Setujui klaim" }).click();
    await expect(dlg).toBeHidden();

    expect(kirim).toEqual([{
        method: "POST", path: "/api/off-program-control/batches/b-klaim/claim-review",
        // Bukan pembuat batch: `alasanSendiri` tetap dikirim kosong (layar Fiori tidak pernah memakai jalur transisi server).
        body: { action: "approve", claimSubmittedDate: "2026-10-06", claimDeadline: "2026-11-06", completenessStatus: "Lengkap", note: "Berkas lengkap, faktur pajak menyusul.", alasanSendiri: "" },
    }]);
    await expect(main.getByRole("status").filter({ hasText: "Klaim 005/GDI/10/2026 disetujui dan diteruskan ke OM." })).toBeVisible();
    await expect(detail.getByText("Menunggu OM").first()).toBeVisible(NAV);
    await expect(detail.getByText("Baca-saja.")).toBeVisible();
    await expect(detail.getByRole("button", { name: "Setujui klaim…" })).toHaveCount(0);
    await expect(detail.getByText("Draf belum disimpan")).toHaveCount(0);
    await expect(antrean(page).getByRole("button")).toHaveCount(1);
    await expect(antrean(page)).not.toContainText("005/GDI/10/2026");
});

test("Kembalikan: alasan wajib di dialog, galat server tampil di dialog tanpa menghapus alasan; draf menahan pindah batch", async ({ page }) => {
    let tolak = true;
    const kirim = await mockKlaim(page, {
        gagal: (p) => {
            if (!p.endsWith("/claim-review") || !tolak) return null;
            tolak = false;
            return json({ ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." }, 409);
        },
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=claim&batch=b-klaim", NAV);
    const main = page.locator("main");
    const detail = kolomBatch(page);
    const isi = detail.getByRole("region", { name: "Isi validasi" });
    await isi.getByLabel("Keterangan kelengkapan").fill("Faktur pajak item 2 belum ada", NAV);
    await isi.getByRole("radio", { name: "Kurang" }).check();

    // Draf: pindah batch meminta konfirmasi; Batal benar-benar batal.
    await antrean(page).getByRole("button", { name: /001\/CLM\/GDI\/10\/2026/ }).click();
    const tinggal = page.getByRole("dialog");
    await expect(tinggal.getByRole("heading", { name: "Tinggalkan perubahan yang belum disimpan?" })).toBeVisible();
    await tinggal.getByRole("button", { name: "Batal" }).click();
    await expect(page).toHaveURL(/batch=b-klaim/);
    await expect(isi.getByLabel("Keterangan kelengkapan")).toHaveValue("Faktur pajak item 2 belum ada");

    await detail.locator(".fi-ftb").getByRole("button", { name: "Kembalikan…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Kembalikan 005/GDI/10/2026 untuk diperbaiki?" })).toBeVisible();
    const alasan = dlg.getByLabel("Alasan pengembalian");
    await expect(alasan).toHaveValue("Faktur pajak item 2 belum ada"); // usulan dari keterangan kelengkapan
    await alasan.fill("");
    await expect(dlg.getByRole("button", { name: "Kembalikan" })).toBeDisabled();
    await alasan.fill("Faktur pajak item 2 belum ada; lengkapi lalu kirim ulang.");
    await dlg.getByRole("button", { name: "Kembalikan" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Periode ini sudah ditutup dan tidak dapat diubah.");
    await expect(alasan).toHaveValue("Faktur pajak item 2 belum ada; lengkapi lalu kirim ulang.");
    await page.screenshot({ path: "test-results/fiori-opc-klaim-kembali-galat.png" });
    await dlg.getByRole("button", { name: "Kembalikan" }).click();
    await expect(dlg).toBeHidden();

    const body = { action: "return", note: "Faktur pajak item 2 belum ada; lengkapi lalu kirim ulang.", completenessStatus: "Kurang" };
    expect(kirim).toEqual([
        { method: "POST", path: "/api/off-program-control/batches/b-klaim/claim-review", body },
        { method: "POST", path: "/api/off-program-control/batches/b-klaim/claim-review", body },
    ]);
    const sukses = main.getByRole("status").filter({ hasText: "005/GDI/10/2026 dikembalikan untuk diperbaiki." });
    await expect(sukses).toContainText("Batch kembali ke SPV pembuatnya.");
    await expect(sukses).not.toContainText("pindah ke antrean");
    await expect(detail.getByRole("alert").filter({ hasText: "Dikembalikan Klaim: Faktur pajak item 2 belum ada; lengkapi lalu kirim ulang." })).toBeVisible(NAV);
    await expect(detail.getByRole("button", { name: "Kembalikan…" })).toHaveCount(0);
});

test("Setujui batch buatan sendiri (BL-10, #132): alasan wajib ≥ 5 karakter → alasanSendiri di payload; galat server di dialog", async ({ page }) => {
    let tolak = true;
    const kirim = await mockKlaim(page, {
        gagal: (p) => {
            if (!p.endsWith("/claim-review") || !tolak) return null;
            tolak = false;
            return json({ ok: false, error: "Anda pembuat pengajuan ini. Alasan menyetujui sendiri wajib diisi (minimal 5 karakter)." }, 400);
        },
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=claim&batch=b-sendiri", NAV);
    const detail = kolomBatch(page);
    const isi = detail.getByRole("region", { name: "Isi validasi" });
    await isi.getByLabel("Tanggal diajukan ke principal").fill("2026-10-07", NAV);
    await isi.getByLabel("Deadline klaim").fill("2026-11-07");
    await isi.getByLabel("Keterangan kelengkapan").fill("Data direksi lengkap.");
    await detail.locator(".fi-ftb").getByRole("button", { name: "Setujui klaim…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Setujui batch yang Anda buat sendiri?" })).toBeVisible();
    await expect(dlg).toContainText("Anda (Rina Amalia)");
    await expect(dlg).toContainText("001/CLM/GDI/10/2026");
    await expect(dlg).toContainText("persetujuan dan alasannya tersimpan di Riwayat batch ini");
    await expect(dlg.getByLabel("Usulan BL-10")).toHaveCount(0);
    const tombol = dlg.getByRole("button", { name: "Setujui klaim" });
    const alasan = dlg.getByLabel("Alasan setuju sendiri");
    await expect(tombol).toBeDisabled();
    await alasan.fill(" abcd ");
    await expect(tombol).toBeDisabled();
    await expect(tombol).toHaveAttribute("title", "Alasan setuju sendiri minimal 5 karakter");
    expect(kirim).toEqual([]);
    await alasan.fill("Tim Klaim hanya satu orang minggu ini");
    await tombol.click();
    await expect(dlg.getByRole("alert")).toContainText("Anda pembuat pengajuan ini. Alasan menyetujui sendiri wajib diisi");
    await expect(alasan).toHaveValue("Tim Klaim hanya satu orang minggu ini");
    await page.screenshot({ path: "test-results/fiori-opc-klaim-sendiri.png" });
    await tombol.click();
    await expect(dlg).toBeHidden();
    const kiriman = {
        method: "POST", path: "/api/off-program-control/batches/b-sendiri/claim-review",
        body: { action: "approve", claimSubmittedDate: "2026-10-07", claimDeadline: "2026-11-07", completenessStatus: "Lengkap", note: "Data direksi lengkap.", alasanSendiri: "Tim Klaim hanya satu orang minggu ini" },
    };
    expect(kirim).toEqual([kiriman, kiriman]);
});

test("Selesaikan verifikasi final batch buatan sendiri (BL-10, #132): alasan wajib → alasanSendiri; Riwayat menampilkan alasan dan penanda tanpa alasan", async ({ page }) => {
    const fs = batch("b-fs", "001/CLM/PRA/09/2026", "PRA", "PRINCIPLE A", {
        status: "Paid", ...OMOK, financeStatus: "Paid", finalStatus: "Waiting Claim Final Verification", bulan: "09", paidAt: kini, paidAmount: 4_300_000,
        paymentDate: "2026-10-06", financeNote: "Transfer BANK A", paymentSummary: LUNAS, createdBy: "u-1", createdByRole: "claim", supervisorName: "Divisi Klaim",
    });
    const audit = [
        { id: "au1", batchId: "b-fs", actorName: "KLAIM A", actorRole: "claim", action: "claim_approve", fromStatus: "Waiting Review", toStatus: "Approved", note: "Lengkap.", createdAt: lalu(3), metadata: { alasanSendiri: null, sendiriTanpaAlasan: true } },
        { id: "au2", batchId: "b-fs", actorName: "KLAIM A", actorRole: "claim", action: "complete", fromStatus: "Incomplete Documents", toStatus: "Completed", note: "", createdAt: lalu(1), metadata: { alasanSendiri: "Tim Klaim hanya satu orang", sendiriTanpaAlasan: false } },
    ];
    const kirim = await mockKlaim(page, { tambahan: [fs], audit: { "b-fs": audit } });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=claim&claimView=after&batch=b-fs", NAV);
    const detail = kolomBatch(page);
    await expect(detail.getByRole("heading", { level: 1, name: "001/CLM/PRA/09/2026" })).toBeVisible(NAV);
    const riwayat = detail.getByRole("list", { name: "Riwayat aksi" });
    await expect(riwayat).toContainText("Alasan setuju sendiri: Tim Klaim hanya satu orang");
    await expect(riwayat).toContainText("Disetujui sendiri tanpa alasan (layar lama)");

    const final = detail.getByRole("region", { name: "Verifikasi final" });
    for (const n of [1, 2]) {
        const it = final.getByRole("group", { name: `Item ${n}` });
        await it.getByLabel("No Claim").fill(`CLM-A-00${n}`);
        await it.getByRole("checkbox", { name: "KWT" }).check();
    }
    await detail.locator(".fi-ftb").getByRole("button", { name: "Selesaikan…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Selesaikan verifikasi final 001/CLM/PRA/09/2026 yang Anda buat sendiri?" })).toBeVisible();
    await expect(dlg).toContainText("hasil dan alasannya tersimpan di Riwayat batch ini");
    await expect(dlg.getByLabel("Usulan BL-10")).toHaveCount(0);
    const tombol = dlg.getByRole("button", { name: "Selesaikan" });
    const alasan = dlg.getByLabel("Alasan setuju sendiri");
    await expect(tombol).toBeDisabled();
    await alasan.fill("abc");
    await expect(tombol).toHaveAttribute("title", "Alasan setuju sendiri minimal 5 karakter");
    await alasan.fill("  Pemeriksa final sedang cuti  ");
    await tombol.click();
    await expect(dlg).toBeHidden();
    const ref = (n: number) => ({ itemId: `b-fs-i${n}`, noSurat: `PRA/PRG/093${n}`, noClaim: `CLM-A-00${n}`, finalKwt: true, finalSkp: false, finalFp: false, finalPc: false, finalFoto: false, finalRekap: false, finalOthers: false, finalOthersText: "", finalCompletenessNote: "" });
    expect(kirim).toEqual([{
        method: "POST", path: "/api/off-program-control/batches/b-fs/final-claim",
        body: { action: "complete", note: "", alasanSendiri: "Pemeriksa final sedang cuti", claimRefs: [ref(1), ref(2)] },
    }]);
});

test("Batch terminal tanpa aksi Klaim (BL-06): disetujui OM, dibayar, dibatalkan, selesai; tanpa permintaan tulis", async ({ page }) => {
    const kirim = await mockKlaim(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    const detail = kolomBatch(page);
    for (const [id, no] of [["b-om", "002/KINO/10/2026"], ["b-bayar", "004/URC/09/2026"], ["b-batal", "008/KINO/10/2026"], ["b-selesai", "003/GDI/09/2026"]]) {
        await page.goto(`/off-program-control?tab=claim&batch=${id}`, NAV);
        await expect(detail.getByRole("heading", { level: 1, name: no })).toBeVisible(NAV);
        await expect(detail.getByText("Baca-saja.")).toBeVisible();
        for (const nama of ["Setujui klaim…", "Kembalikan…", "Selesaikan…", "Ingatkan kelengkapan…", "Kirim ke SM…"]) {
            await expect(detail.getByRole("button", { name: nama })).toHaveCount(0);
        }
        await expect(detail.getByRole("region", { name: "Isi validasi" })).toHaveCount(0);
        await expect(detail.getByLabel("Usulan BL-06")).toBeVisible();
    }
    // Disetujui OM + sudah ada Claim Workflow: tanpa footer aksi; hanya tautan buka Claim Workflow di bawah header.
    await page.goto("/off-program-control?tab=claim&batch=b-bayar", NAV);
    await expect(detail.getByRole("status").filter({ hasText: "Claim Workflow: sudah dibuat" }).getByRole("button", { name: "Buka Claim Workflow" })).toBeVisible(NAV);
    await expect(detail.locator(".fi-ftb")).toHaveCount(0);
    // Selesai: hasil verifikasi final baca-saja.
    await page.goto("/off-program-control?tab=claim&claimView=after&batch=b-selesai", NAV);
    const final = detail.getByRole("region", { name: "Verifikasi final" });
    await expect(final.getByRole("table", { name: "Hasil verifikasi final per item" })).toBeVisible(NAV);
    await expect(final).toContainText("Lengkap.");
    await page.screenshot({ path: "test-results/fiori-opc-klaim-terminal.png", fullPage: true });
    expect(kirim).toEqual([]);
});

test("Detail usang (BL-06): daftar terbaru menunjukkan batch sudah lewat tahap → tanpa aksi Klaim + Muat ulang; tanpa permintaan tulis", async ({ page }) => {
    const kirim = await mockKlaim(page, {
        daftarUbah: {
            // Detail dibuka saat "Approved by SM", lalu polling daftar menunjukkan batch sudah lunas.
            "b-klaim": { status: "Paid", claimStatus: "Approved", omStatus: "Approved", financeStatus: "Paid", finalStatus: "Waiting Claim Final Verification", paymentSummary: LUNAS },
            "b-final": { status: "Completed", finalStatus: "Completed" },
        },
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    const detail = kolomBatch(page);
    await page.goto("/off-program-control?tab=claim&batch=b-klaim", NAV);
    await expect(detail.getByRole("heading", { level: 1, name: "005/GDI/10/2026" })).toBeVisible(NAV);
    const usang = detail.getByRole("status").filter({ hasText: "Status batch berubah." });
    await expect(usang).toContainText("Daftar terbaru menunjukkan batch ini di tahap Verifikasi final");
    for (const nama of ["Setujui klaim…", "Kembalikan…"]) await expect(detail.getByRole("button", { name: nama })).toHaveCount(0);
    await expect(detail.getByRole("region", { name: "Isi validasi" })).toHaveCount(0);
    await expect(usang.getByRole("button", { name: "Muat ulang" })).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-opc-klaim-usang.png", fullPage: true });

    await page.goto("/off-program-control?tab=claim&claimView=after&batch=b-final", NAV);
    await expect(detail.getByRole("heading", { level: 1, name: "001/RB/09/2026" })).toBeVisible(NAV);
    await expect(detail.getByRole("status").filter({ hasText: "Status batch berubah." })).toContainText("tahap Selesai");
    for (const nama of ["Selesaikan…", "Ingatkan kelengkapan…"]) await expect(detail.getByRole("button", { name: nama })).toHaveCount(0);
    expect(kirim).toEqual([]);
});

test("Verifikasi final (claimView=after): No Claim + checklist per item, Ingatkan + Selesaikan lewat dialog (payload final-claim), lalu Claim Workflow", async ({ page }) => {
    const detailGagal = new Set<string>();
    const kirim = await mockKlaim(page, { detailGagal });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=claim&claimView=after&batch=b-final", NAV);
    const main = page.locator("main");
    const detail = kolomBatch(page);
    await expect(detail.getByRole("heading", { level: 1, name: "001/RB/09/2026" })).toBeVisible(NAV);
    await expect(main.getByRole("group", { name: "Tampilan antrean" }).getByRole("button", { name: /Verifikasi final/ })).toHaveAttribute("aria-pressed", "true");
    const final = detail.getByRole("region", { name: "Verifikasi final" });
    await expect(final).toContainText("Rp 4.300.000");
    await expect(final).toContainText("Transfer BCA");
    const footer = detail.locator(".fi-ftb");
    await expect(footer.getByRole("button", { name: "Selesaikan…" })).toBeDisabled();
    await expect(footer).toContainText("Selesaikan nonaktif: No Claim wajib diisi untuk No Surat: RB/PRG/0931, RB/PRG/0932.");
    await expect(footer.getByRole("button", { name: "Ingatkan kelengkapan…" })).toBeDisabled();

    // Ingatkan kelengkapan: catatan wajib; isian No Claim yang sudah diketik tetap (tidak ikut tersimpan).
    const item1 = final.getByRole("group", { name: "Item 1" });
    const item2 = final.getByRole("group", { name: "Item 2" });
    await item1.getByLabel("No Claim").fill("CLM-RB-001");
    await final.getByLabel("Catatan verifikasi final").fill("Faktur pajak item 2 menyusul.");
    await expect(detail.getByText("Draf belum disimpan")).toBeVisible();
    await footer.getByRole("button", { name: "Ingatkan kelengkapan…" }).click();
    let dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Kirim pengingat kelengkapan 001/RB/09/2026?" })).toBeVisible();
    await expect(dlg).toContainText("belum ikut tersimpan");
    detailGagal.add("b-final"); // muat ulang detail sesudah aksi gagal → aksi status terkunci (hasil sebelumnya bisa usang)
    await dlg.getByRole("button", { name: "Kirim pengingat" }).click();
    await expect(dlg).toBeHidden();
    const pengingat = main.getByRole("status").filter({ hasText: "Pengingat kelengkapan 001/RB/09/2026" });
    await expect(pengingat).toContainText("Batch tetap menunggu verifikasi final Klaim.");
    await expect(pengingat).not.toContainText("pindah ke antrean");
    await expect(footer).toContainText("Detail batch gagal dimuat ulang; status di layar bisa usang.", NAV);
    await expect(footer.getByRole("button", { name: "Selesaikan…" })).toBeDisabled();
    await expect(footer.getByRole("button", { name: "Ingatkan kelengkapan…" })).toBeDisabled();
    detailGagal.delete("b-final");
    await detail.getByRole("alert").filter({ hasText: "Gagal memuat ulang detail." }).getByRole("button", { name: "Coba lagi" }).click();
    await expect(detail.getByText("Berkas belum lengkap").first()).toBeVisible(NAV);
    await expect(footer.getByRole("button", { name: "Ingatkan kelengkapan…" })).toBeEnabled();
    await expect(item1.getByLabel("No Claim")).toHaveValue("CLM-RB-001");

    await item1.getByRole("checkbox", { name: "KWT" }).check();
    await expect(footer).toContainText("No Claim wajib diisi untuk No Surat: RB/PRG/0932.");
    await item2.getByLabel("No Claim").fill("CLM-RB-002");
    await expect(footer).toContainText("Checklist kelengkapan final wajib diisi minimal satu untuk No Surat: RB/PRG/0932.");
    await expect(item2.getByLabel("Keterangan lainnya")).toBeDisabled();
    await item2.getByRole("checkbox", { name: "Foto" }).check();
    await item2.getByRole("checkbox", { name: "Lainnya" }).check();
    await item2.getByLabel("Keterangan lainnya").fill("Surat jalan");
    await item2.getByLabel("Catatan kelengkapan final").fill("Asli menyusul");
    await final.getByLabel("Nilai fix (isi bila berbeda)").fill("4000000");
    await expect(final.getByRole("status").filter({ hasText: "Selisih Rp 300.000." })).toContainText("Akan masuk Data Selisih");
    await expect(footer.getByRole("button", { name: "Selesaikan…" })).toBeEnabled();
    await page.screenshot({ path: "test-results/fiori-opc-klaim-final.png", fullPage: true });

    await footer.getByRole("button", { name: "Selesaikan…" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Selesaikan verifikasi final 001/RB/09/2026?" })).toBeVisible();
    await expect(dlg).toContainText("Rp 4.000.000");
    await expect(dlg).toContainText("Selisih Rp 300.000 masuk Data Selisih");
    await dlg.getByRole("button", { name: "Selesaikan" }).click();
    await expect(dlg).toBeHidden();

    const ref = (n: number, over: Over) => ({
        itemId: `b-final-i${n}`, noSurat: `RB/PRG/093${n}`, finalKwt: false, finalSkp: false, finalFp: false, finalPc: false, finalFoto: false, finalRekap: false,
        finalOthers: false, finalOthersText: "", finalCompletenessNote: "", ...over,
    });
    expect(kirim).toEqual([
        { method: "POST", path: "/api/off-program-control/batches/b-final/final-claim", body: { action: "remind_incomplete_documents", note: "Faktur pajak item 2 menyusul." } },
        {
            method: "POST", path: "/api/off-program-control/batches/b-final/final-claim",
            body: {
                action: "complete", note: "Faktur pajak item 2 menyusul.", verifiedAmount: 4_000_000, alasanSendiri: "",
                claimRefs: [
                    ref(1, { noClaim: "CLM-RB-001", finalKwt: true }),
                    ref(2, { noClaim: "CLM-RB-002", finalFoto: true, finalOthers: true, finalOthersText: "Surat jalan", finalCompletenessNote: "Asli menyusul" }),
                ],
            },
        },
    ]);
    await expect(main.getByRole("status").filter({ hasText: "Verifikasi final 001/RB/09/2026 selesai; selisih Rp 300.000 perlu dikembalikan." })).toBeVisible();
    await expect(detail.getByText("Menunggu pengembalian selisih").first()).toBeVisible(NAV);
    await expect(detail.getByRole("table", { name: "Hasil verifikasi final per item" })).toContainText("CLM-RB-002");

    // Claim Workflow (OM sudah menyetujui): buat → 409 sudah ada → workflow lama dibuka di fokus No Claim.
    await detail.getByRole("button", { name: "Buat Claim Workflow…" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Buat Claim Workflow untuk 001/RB/09/2026?" })).toBeVisible();
    await expect(dlg).toContainText("CLM/001/RB/09/2026");
    await dlg.getByRole("button", { name: "Buat dan buka" }).click();
    await expect(page).toHaveURL(/\/claim-workflow\/wf-9\?focus=no-claim/, NAV);
    expect(kirim.at(-1)).toEqual({ method: "POST", path: "/api/claim-workflow/from-off-batch/b-final", body: {} });
});

test("Batch CLM: form di kolom kedua (clm=baru), nomor otomatis, Simpan draf lewat dialog (payload POST /batches), lalu Kirim ke SM", async ({ page }) => {
    const kirim = await mockKlaim(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=claim&claimView=data-claim", NAV);
    const main = page.locator("main");
    await expect(antrean(page).getByRole("button")).toHaveCount(1, NAV);
    await expect(antrean(page)).toContainText("002/CLM/RB/10/2026");
    await main.getByRole("button", { name: "Buat batch CLM" }).click();
    await expect(page).toHaveURL(/clm=baru/);
    const form = main.getByRole("region", { name: "Batch terbuka" });
    await expect(form.getByRole("heading", { level: 1, name: "Batch CLM baru" })).toBeVisible(NAV);

    await form.getByLabel("Principal").selectOption("GODREJ DISTRIBUSI INDONESIA, PT");
    await form.getByLabel("Bulan").selectOption("10");
    await form.getByLabel("Tahun").fill("2026");
    await expect(form.getByText("002/CLM/GDI/10/2026").first()).toBeVisible(NAV);
    const footer = form.locator(".fi-ftb");
    const simpan = footer.getByRole("button", { name: "Simpan sebagai draf…" });
    await expect(simpan).toBeDisabled();

    const b1 = form.getByRole("group", { name: "Baris 1" });
    await b1.getByLabel("No Surat").fill("GDI/DIR/01");
    await b1.getByLabel("Nama program").fill("Insentif Q3");
    await b1.getByLabel("Toko").fill("TK Mulia");
    await b1.getByLabel("Nominal").fill("1.500.000");
    await expect(footer).toContainText("Simpan nonaktif: Tipe program baris 1 belum dipilih.");
    await b1.getByLabel("Tipe program (CLM)").selectOption("Insentif");
    await expect(footer).toContainText("No Rekening baris 1 wajib diisi untuk Transfer.");
    await b1.getByLabel("No rekening").fill("BRI 0231");
    await form.getByRole("button", { name: "Tambah baris" }).click();
    const b2 = form.getByRole("group", { name: "Baris 2" });
    await b2.getByLabel("Tipe program (CLM)").selectOption("Retur");
    await b2.getByLabel("Cara bayar").selectOption("Tunai");
    await expect(b2.getByLabel("No rekening")).toHaveAttribute("readonly", "");
    await b2.getByLabel("Nominal").fill("250000");
    await expect(form.getByText("Draf belum disimpan")).toBeVisible();
    await expect(simpan).toBeEnabled();
    await page.screenshot({ path: "test-results/fiori-opc-klaim-clm.png", fullPage: true });

    await simpan.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Simpan batch CLM sebagai draf?" })).toBeVisible();
    await expect(dlg).toContainText("GODREJ DISTRIBUSI INDONESIA, PT (GDI)");
    await expect(dlg).toContainText("Oktober 2026");
    await expect(dlg).toContainText("2 · Rp 1.750.000");
    await dlg.getByRole("button", { name: "Simpan draf" }).click();
    await expect(dlg).toBeHidden();

    const baris = (over: Over) => ({
        noSurat: "", namaProgram: "", periodeAwal: "", periodeAkhir: "", toko: "", barang: "", nominal: "", caraBayar: "Transfer", noRekening: "", type: "",
        originalType: "", deadline: "", kwt: false, skp: false, fp: false, pc: false, foto: false, rekap: false, others: false, othersText: "", ...over,
    });
    expect(kirim.filter((k) => k.method === "POST")).toEqual([{
        method: "POST", path: "/api/off-program-control/batches",
        body: {
            principleName: "GODREJ DISTRIBUSI INDONESIA, PT", principleCode: "GDI", bulan: "10", tahun: "2026", supervisorName: "Divisi Claim",
            items: [
                baris({ noSurat: "GDI/DIR/01", namaProgram: "Insentif Q3", toko: "TK Mulia", nominal: "1.500.000", noRekening: "BRI 0231", type: "Insentif", originalType: "Insentif" }),
                baris({ nominal: "250000", caraBayar: "Tunai", type: "Retur", originalType: "Retur" }),
            ],
        },
    }]);
    const ok = form.getByRole("status").filter({ hasText: "Batch CLM 002/CLM/GDI/10/2026 tersimpan sebagai draf." });
    await expect(ok).toBeVisible();
    await expect(form.getByText("Draf belum disimpan")).toHaveCount(0);
    await expect(antrean(page).getByRole("button")).toHaveCount(2, NAV);
    await ok.getByRole("button", { name: "Buka batch" }).click();
    await expect(page).toHaveURL(/batch=b-new/);
    await expect(page).not.toHaveURL(/clm=baru/);

    const detail = kolomBatch(page);
    await expect(detail.getByRole("heading", { level: 1, name: "002/CLM/GDI/10/2026" })).toBeVisible(NAV);
    await detail.locator(".fi-ftb").getByRole("button", { name: "Kirim ke SM…" }).click();
    const kirimDlg = page.getByRole("dialog");
    await expect(kirimDlg.getByRole("heading", { name: "Kirim 002/CLM/GDI/10/2026 ke SM?" })).toBeVisible();
    await kirimDlg.getByRole("button", { name: "Kirim ke SM" }).click();
    await expect(kirimDlg).toBeHidden();
    expect(kirim.at(-1)).toEqual({ method: "POST", path: "/api/off-program-control/batches/b-new/submit", body: {} });
    await expect(main.getByRole("status").filter({ hasText: "002/CLM/GDI/10/2026 dikirim ke SM." })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Kirim ke SM…" })).toHaveCount(0, NAV);
});

test("ponsel 390 px: validasi Klaim + dialog dan form CLM tanpa gulir menyamping", async ({ page }) => {
    await mockKlaim(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/off-program-control?tab=claim", NAV);
    await expect(antrean(page).getByRole("button")).toHaveCount(2, NAV);
    await noOverflow(page);
    await antrean(page).getByRole("button", { name: /005\/GDI\/10\/2026/ }).click();
    const detail = kolomBatch(page);
    const isi = detail.getByRole("region", { name: "Isi validasi" });
    await isi.getByLabel("Tanggal diajukan ke principal").fill("2026-10-06", NAV);
    await isi.getByLabel("Deadline klaim").fill("2026-11-06");
    await isi.getByLabel("Keterangan kelengkapan").fill("Lengkap.");
    await expect(detail.locator(".fi-ftb").getByRole("button", { name: "Setujui klaim…" })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-opc-klaim-ponsel.png", fullPage: true });
    await detail.locator(".fi-ftb").getByRole("button", { name: "Setujui klaim…" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Setujui klaim 005/GDI/10/2026?" })).toBeVisible();
    await noOverflow(page);
    await page.getByRole("dialog").getByRole("button", { name: "Batal" }).click();

    await page.goto("/off-program-control?tab=claim&claimView=after&batch=b-final", NAV);
    await expect(detail.getByRole("region", { name: "Verifikasi final" }).getByRole("group", { name: "Item 1" })).toBeVisible(NAV);
    await noOverflow(page);
    await page.goto("/off-program-control?tab=claim&claimView=data-claim&clm=baru", NAV);
    await expect(page.locator("main").getByRole("heading", { level: 1, name: "Batch CLM baru" })).toBeVisible(NAV);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-opc-klaim-ponsel-clm.png", fullPage: true });
});
