/*
 * Tujuan: Fiori S4d OFF Program Control — layar SPV (it03): Default (batch dikembalikan SM dibuka mode ubah, item ditandai), Draf
 *   (indikator + konfirmasi keluar), Kirim ke SM lewat dialog `kirimsm` dengan ringkasan perubahan (PATCH LALU submit, payload kode
 *   lama diperiksa), Sukses (batch pindah ke tahap SM), No Surat duplikat lewat dialog, galat server di dialog, konflik 409 (BL-09),
 *   batch baru (POST, nomor otomatis), Data selisih + ajukan pengembalian, PDF #6, pengingat kelengkapan, Diskon SPV, ponsel 390 px.
 * Caller: Playwright lokal: `npx playwright test tests/fiori-opc-spv.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: /api/off-program-control/* dan /api/auth/get-session (peran supervisor) di-mock dengan page.route (tidak menyentuh DB).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const kini = new Date().toISOString();
const MM = String(new Date().getMonth() + 1).padStart(2, "0");
const YYYY = String(new Date().getFullYear());
type Over = Record<string, unknown>;
type Tulis = { method: string; path: string; body: unknown };

const batch = (id: string, no: string, principleCode: string, principleName: string, over: Over = {}) => ({
    id, noPengajuan: no, gelombang: no.slice(0, 3), principleCode, principleName, bulan: no.split("/").at(-2), tahun: "2026",
    supervisorName: "Rahmat", status: "Draft", smStatus: "Not Started", claimStatus: "Not Started", omStatus: "Not Started",
    financeStatus: "Not Started", finalStatus: "Not Started", locked: false, createdBy: "u-spv", createdByRole: "supervisor",
    refundStatus: "Not Applicable", createdAt: kini, updatedAt: kini, payments: [],
    summary: { totalNominal: 4_300_000, totalRows: 2 }, periodDates: { pengajuan: ["2026-10-02"] }, ...over,
});
const item = (id: string, itemNo: number, toko: string, nominal: number, over: Over = {}) => ({
    id, itemNo, noSurat: "ENI/PRG/0931", namaProgram: "Display Zwitsal Okt", periode: "2026-10-01 - 2026-10-31", toko, barang: null, nominal,
    caraBayar: "Transfer", noRekening: "BRI 0231-01", type: "Display", normalizedType: "Display", originalType: "Display", typeIsLegacy: false, pphExempt: false,
    deadline: "2026-10-31", kwt: true, skp: true, fp: false, pc: false, foto: true, rekap: true, others: false, othersText: null, ...over,
});
const PAID = { smStatus: "Approved by SM", claimStatus: "Approved", omStatus: "Approved", financeStatus: "Paid", locked: true };

function awal() {
    const batches = [
        batch("b-ret", "006/ENI/10/2026", "ENI", "ENERGIZER INDONESIA, PT", { status: "Returned by SM", smStatus: "Returned", smNote: "Nominal TK Mulia melebihi surat program.", returnedAt: kini }),
        batch("b-draf", "009/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT"),
        batch("b-sm", "007/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", { status: "Submitted to SM", smStatus: "Waiting Review", submittedAt: kini, pdfUrl: "/api/off-program-control/batches/b-sm/pdf" }),
        batch("b-ok", "003/GDI/10/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { status: "Claim Approved", smStatus: "Approved by SM", claimStatus: "Approved", omStatus: "Waiting Approval", locked: true, pdfUrl: "/api/off-program-control/batches/b-ok/pdf" }),
        batch("b-sel", "008/HEINZ/09/2026", "HEINZ", "HEINZ ABC INDONESIA, PT", { status: "Paid", ...PAID, finalStatus: "Pending Refund", refundStatus: "Pending Refund", refundAmount: 450_000, bulan: "09" }),
        batch("b-inc", "004/URC/09/2026", "URC", "URC INDONESIA, PT", { status: "Paid", ...PAID, finalStatus: "Incomplete Documents", finalClaimNote: "Faktur pajak item 2 belum ada.", bulan: "09" }),
        batch("b-lain", "001/RB/10/2026", "RB", "RECKITT BENCKISER, PT", { createdBy: "u-lain" }), // milik SPV lain: tidak boleh tampil
    ] as Array<Record<string, unknown>>;
    const items: Record<string, unknown[]> = {
        "b-ret": [
            item("i1", 1, "TK Mulia", 2_200_000),
            // Tipe lama yang tidak dikenali → dikosongkan, SPV wajib memilih ulang (item ditandai).
            item("i2", 2, "UD Sejahtera", 2_100_000, { caraBayar: "Tunai", noRekening: null, type: "Promo", normalizedType: null, originalType: "Promo", typeIsLegacy: true }),
        ],
        "b-draf": [item("d1", 1, "TK Sinar Jaya", 1_500_000, { noSurat: "KINO/PRG/0931" })],
    };
    return { batches, items };
}

type Opsi = {
    patch?: (id: string, body: Record<string, unknown>, ke: number) => ReturnType<typeof json> | null;
    post?: (body: Record<string, unknown>) => ReturnType<typeof json> | null;
    refund?: (id: string) => ReturnType<typeof json> | null;
    diskon?: () => ReturnType<typeof json>;
};

/** Semua endpoint OPC dimock (berstatus: PATCH/POST/submit mengubah data). Mengembalikan daftar permintaan tulis berurutan. */
async function mockSpv(page: Page, opsi: Opsi = {}) {
    const s = awal();
    const tulis: Tulis[] = [];
    let nPatch = 0;
    const cari = (id: string) => s.batches.find((b) => b.id === id);
    const keItem = (id: string, xs: Array<Record<string, unknown>>) => xs.map((x, i) => ({
        ...x, id: `${id}-v${nPatch}-${i}`, itemNo: i + 1, nominal: Number(String(x.nominal).replace(/[^\d]/g, "")) || 0, normalizedType: x.type,
        typeIsLegacy: false, barang: x.barang || null, noRekening: x.noRekening || null,
    }));
    await page.route((u) => u.pathname === "/api/auth/get-session", (r) => r.fulfill(json({
        session: { id: "s1", userId: "u-spv", token: "t", expiresAt: new Date(Date.now() + 864e5).toISOString(), createdAt: kini, updatedAt: kini },
        user: { id: "u-spv", name: "Rahmat Hidayat", email: "rahmat@example.invalid", emailVerified: true, role: "supervisor", createdAt: kini, updatedAt: kini },
    })));
    await page.route((u) => u.pathname.startsWith("/api/off-program-control/"), async (r) => {
        const req = r.request();
        const url = new URL(req.url());
        const p = url.pathname;
        const m = req.method();
        if (m !== "GET") tulis.push({ method: m, path: p, body: badan(req) });
        if (p === "/api/off-program-control/discount") {
            if (m === "POST") return r.fulfill(json({ ok: true, id: "dk-2", message: "Pengajuan diskon tercatat sebagai jejak digital." }));
            return r.fulfill(opsi.diskon ? opsi.diskon() : json({ ok: true, submissions: [{ id: "dk-1", toko: "TK Lama", principleName: "KINO INDONESIA. TBK, PT", program: "Diskon akhir bulan", nominal: 250_000, alasan: "Stok lama", tanggal: "2026-10-03", status: "Tercatat", createdByName: "Rahmat" }] }));
        }
        if (p === "/api/off-program-control/batches/next-number") {
            const k = url.searchParams.get("principleCode");
            return r.fulfill(json({ ok: true, gelombang: "004", noPengajuan: `004/${k}/${url.searchParams.get("bulan")}/${url.searchParams.get("tahun")}` }));
        }
        if (p === "/api/off-program-control/batches") {
            if (m === "POST") {
                const body = badan(req) as Record<string, unknown>;
                const khusus = opsi.post?.(body);
                if (khusus) return r.fulfill(khusus);
                const no = `004/${body.principleCode}/${body.bulan}/${body.tahun}`;
                s.batches.push(batch("b-baru", no, String(body.principleCode), String(body.principleName), { bulan: body.bulan, tahun: body.tahun, updatedAt: new Date().toISOString() }));
                s.items["b-baru"] = keItem("b-baru", body.items as Array<Record<string, unknown>>);
                return r.fulfill(json({ ok: true, batchId: "b-baru", noPengajuan: no, gelombang: "004" }));
            }
            return r.fulfill(json({ ok: true, batches: s.batches }));
        }
        const mm = /^\/api\/off-program-control\/batches\/([^/]+)(?:\/(refund|audit|submit))?$/.exec(p);
        if (!mm) return r.fulfill(json({ ok: false, error: "tidak dimock" }, 404));
        const id = decodeURIComponent(mm[1]);
        const b = cari(id);
        if (!b) return r.fulfill(json({ ok: false, error: "Batch not found" }, 404));
        if (mm[2] === "audit") return r.fulfill(json({ ok: true, audit: [] }));
        if (mm[2] === "refund") {
            if (m === "POST") return r.fulfill(json({ ok: true, message: "Pengembalian dana #1 sebesar Rp 450.000 berhasil disubmit. Menunggu verifikasi Finance.", refundId: "rf1" }));
            const khusus = opsi.refund?.(id);
            if (khusus) return r.fulfill(khusus);
            const sel = id === "b-sel";
            return r.fulfill(json({ ok: true, refunds: [], summary: { paidAmount: sel ? 4_300_000 : 0, verifiedAmount: sel ? 3_850_000 : 0, overpaidAmount: sel ? 450_000 : 0, totalRefunded: 0, pendingRefund: 0, remainingRefund: sel ? 450_000 : 0, isFullyRefunded: false } }));
        }
        if (mm[2] === "submit") {
            Object.assign(b, { status: "Submitted to SM", smStatus: "Waiting Review", submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pdfUrl: `/api/off-program-control/batches/${id}/pdf` });
            return r.fulfill(json({ ok: true, batchId: id, noPengajuan: b.noPengajuan, pdfUrl: b.pdfUrl, summary: { total: 3_100_000, transfer: 1_000_000, tunai: 2_100_000 } }));
        }
        if (m === "PATCH") {
            nPatch += 1;
            const body = badan(req) as Record<string, unknown>;
            const khusus = opsi.patch?.(id, body, nPatch);
            if (khusus) return r.fulfill(khusus);
            s.items[id] = keItem(id, body.items as Array<Record<string, unknown>>);
            Object.assign(b, { updatedAt: new Date(Date.now() + nPatch * 1000).toISOString() });
            return r.fulfill(json({ ok: true, batch: b, items: s.items[id] }));
        }
        const its = (s.items[id] ?? []) as Array<{ nominal: number }>;
        const total = its.reduce((t, x) => t + x.nominal, 0);
        return r.fulfill(json({ ok: true, batch: b, items: its, payments: [], summary: { totalRows: its.length, totalNominal: total },
            paymentSummary: { totalNominal: total, totalPaid: 0, remainingAmount: total, isFullyPaid: false } }));
    });
    return tulis;
}

function badan(req: Request): unknown {
    const ct = req.headers()["content-type"] ?? "";
    if (ct.includes("application/json")) return req.postDataJSON();
    return req.postDataBuffer()?.toString("utf8") ?? null;
}

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
const antrean = (page: Page) => page.locator("main").getByRole("list", { name: /^Antrean / });
const detailOf = (page: Page) => page.locator("main").getByRole("region", { name: "Batch terbuka" });

test.describe.configure({ timeout: 150_000 });
let kunciGanda: string[] = [];
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
    kunciGanda = [];
    page.on("console", (m) => { if (/two children with the same key/i.test(m.text())) kunciGanda.push(m.text()); });
});
test.afterEach(() => { expect(kunciGanda, "kunci React ganda").toEqual([]); });

test("Default → Draf (konfirmasi keluar) → Kirim ke SM: dialog ringkasan, PATCH lalu submit dengan payload kode lama → Sukses", async ({ page }) => {
    const tulis = await mockSpv(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/off-program-control?batch=b-ret", NAV);
    const main = page.locator("main");
    const detail = detailOf(page);
    await expect(detail.getByRole("heading", { level: 1, name: "006/ENI/10/2026" })).toBeVisible(NAV);
    // Hanya batch milik SPV ini; antrean Draf & dikembalikan.
    await expect(antrean(page).getByRole("button")).toHaveCount(2);
    await expect(antrean(page)).not.toContainText("001/RB/10/2026");
    await expect(main.getByRole("region", { name: "Pengingat kelengkapan belum lengkap" })).toContainText("Faktur pajak item 2 belum ada.");
    // Default: mode ubah, nomor asli, catatan SM, item 2 ditandai, Kirim nonaktif dengan alasan validasi kode lama.
    await expect(detail.getByRole("alert").filter({ hasText: "Nominal TK Mulia melebihi surat program." })).toBeVisible();
    await expect(detail.getByRole("region", { name: "Setup batch" })).toContainText("006/ENI/10/2026");
    const tabel = detail.getByRole("table", { name: "Daftar item" });
    await expect(tabel.locator("tbody tr").nth(1)).toContainText("Perlu dilengkapi");
    const form2 = detail.getByRole("region", { name: "Ubah item 2" });
    await expect(form2.getByText('Tipe lama "Promo" perlu dipilih ulang.')).toBeVisible();
    const kirim = detail.getByRole("button", { name: "Kirim ke SM…" });
    await expect(kirim).toBeDisabled();
    await expect(detail.locator(".fi-ftb")).toContainText("Tipe program pada baris 2 wajib dipilih dari dropdown (Display/Visibility/Promo On Store/Event/Sample) sebelum dikirim ke Sales Manager.");
    await expect(detail.getByRole("button", { name: "Simpan draf" })).toBeDisabled();
    await page.screenshot({ path: "test-results/fiori-opc-spv-default.png", fullPage: true });

    // Draf: perbaiki tipe item 2, ubah nominal item 1.
    await form2.getByLabel("Tipe program").selectOption("Display");
    await detail.getByRole("button", { name: "Ubah item 1" }).click();
    const form1 = detail.getByRole("region", { name: "Ubah item 1" });
    await form1.getByLabel("Nominal").fill("Rp 1.000.000");
    await expect(detail.getByText("Draf belum disimpan").first()).toBeVisible();
    await expect(detail.getByText("Perubahan belum disimpan:")).toBeVisible();
    await expect(kirim).toBeEnabled();
    // Pindah batch dengan draf → konfirmasi; Batal tetap di batch ini.
    await antrean(page).getByRole("button", { name: /009\/KINO\/10\/2026/ }).click();
    const tinggal = page.getByRole("dialog", { name: "Tinggalkan perubahan yang belum disimpan?" });
    await expect(tinggal).toBeVisible();
    await tinggal.getByRole("button", { name: "Batal" }).click();
    await expect(page).toHaveURL(/batch=b-ret/);
    await expect(form1.getByLabel("Nominal")).toHaveValue("Rp 1.000.000");
    await page.screenshot({ path: "test-results/fiori-opc-spv-draf.png", fullPage: true });

    // Kirim ke SM lewat dialog berisi ringkasan perubahan.
    await kirim.click();
    const dlg = page.getByRole("dialog", { name: "Kirim 006/ENI/10/2026 ke SM?" });
    await expect(dlg).toContainText("Item 1 nominal: Rp 2.200.000 → Rp 1.000.000");
    await expect(dlg).toContainText("Item 2 tipe: kosong → Display");
    await expect(dlg).toContainText("2 · Rp 3.100.000");
    await expect(dlg.getByLabel("Usulan BL-09")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-opc-spv-kirimsm.png" });
    await dlg.getByRole("button", { name: "Kirim ke SM" }).click();
    await expect(dlg).toBeHidden(NAV);

    // Dua panggilan, urutan sama dengan kode lama: PATCH lalu POST submit.
    expect(tulis.map((t) => `${t.method} ${t.path}`)).toEqual([
        "PATCH /api/off-program-control/batches/b-ret",
        "POST /api/off-program-control/batches/b-ret/submit",
    ]);
    const body = tulis[0].body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["bulan", "forceDuplicateNoSurat", "items", "principleCode", "principleName", "supervisorName", "tahun"]);
    expect(body).toMatchObject({ supervisorName: "Rahmat", principleCode: "ENI", principleName: "ENERGIZER INDONESIA, PT", bulan: "10", tahun: "2026", forceDuplicateNoSurat: false });
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
        noSurat: "ENI/PRG/0931", namaProgram: "Display Zwitsal Okt", periodeAwal: "2026-10-01", periodeAkhir: "2026-10-31", periode: "2026-10-01 - 2026-10-31",
        toko: "TK Mulia", barang: "", nominal: "Rp 1.000.000", caraBayar: "Transfer", noRekening: "BRI 0231-01", type: "Display", originalType: "Display",
        pphExempt: false, deadline: "2026-10-31", kwt: true, skp: true, fp: false, pc: false, foto: true, rekap: true, others: false, othersText: "",
    });
    expect(items[1]).toMatchObject({ toko: "UD Sejahtera", nominal: "Rp 2.100.000", caraBayar: "Tunai", noRekening: "", type: "Display", originalType: "Promo" });
    expect(tulis[1].body).toBeNull(); // submit tanpa body (kode lama)

    // Sukses: batch terkunci, pindah ke tahap SM, hilang dari antrean "Menunggu Anda".
    await expect(main.getByText("Batch 006/ENI/10/2026 berhasil dikirim ke Sales Manager.").first()).toBeVisible(NAV);
    await expect(detail.getByRole("list", { name: "Tahap batch" }).locator('[aria-current="step"]')).toContainText("SM", NAV);
    await expect(detail.getByRole("button", { name: "Kirim ke SM…" })).toHaveCount(0);
    await expect(detail.locator(".fi-ftb")).toContainText("Tidak ada aksi lain untuk Anda di tahap ini.");
    await expect(detail.getByText("dapat dicetak setelah pengajuan disetujui Klaim.").first()).toBeVisible();
    await expect(antrean(page).getByRole("button", { name: /006\/ENI\/10\/2026/ })).toHaveCount(0, NAV);
    await page.screenshot({ path: "test-results/fiori-opc-spv-sukses.png", fullPage: true });
});

test("No Surat duplikat lewat dialog; galat server tampil di dialog; konflik 409 = strip + BL-09", async ({ page }) => {
    let mode: "dup" | "500" | "periode" | "409" | "ok" = "dup";
    const tulis = await mockSpv(page, {
        patch: (_id, body) => {
            if (mode === "dup" && body.forceDuplicateNoSurat !== true) {
                return json({ ok: false, code: "DUPLICATE_NO_SURAT", message: "No Surat berikut sudah pernah dipakai pada principle KINO INDONESIA. TBK, PT: KINO/PRG/0931.", principleCode: "KINO", principleName: "KINO INDONESIA. TBK, PT",
                    // Server mengirim satu konflik per item: No Surat yang sama dua kali di batch lain → satu baris di dialog.
                    conflicts: [1, 2].map(() => ({ noSurat: "KINO/PRG/0931", batchId: "b-x", noPengajuan: "002/KINO/09/2026", principleCode: "KINO", principleName: "KINO INDONESIA. TBK, PT", status: "Paid" })) }, 409);
            }
            if (mode === "500") return json({ ok: false, error: "Gagal menyimpan revisi batch." }, 500);
            if (mode === "periode") return json({ ok: false, error: "Periode ini sudah ditutup dan tidak dapat diubah." }, 409);
            if (mode === "409") return json({ ok: false, error: "Batch hanya bisa diedit saat Draft atau Returned/Rejected dan belum terkunci." }, 409);
            return null;
        },
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/off-program-control?batch=b-draf", NAV);
    const detail = detailOf(page);
    await expect(detail.getByRole("heading", { level: 1, name: "009/KINO/10/2026" })).toBeVisible(NAV);
    const simpan = detail.getByRole("button", { name: "Simpan draf" });

    // Duplikat → dialog; Batal = benar-benar batal.
    await simpan.click();
    let dup = page.getByRole("dialog", { name: "Tetap simpan dengan No Surat yang sudah dipakai?" });
    await expect(dup).toContainText("002/KINO/09/2026");
    await expect(dup).toContainText("Sudah dibayar");
    await expect(dup.locator("tbody tr")).toHaveCount(1); // DOM (tabel/daftar dipilih lewat lebar wadah)
    await page.screenshot({ path: "test-results/fiori-opc-spv-duplikat.png" });
    await dup.getByRole("button", { name: "Batal" }).click();
    await expect(detail.getByText("Penyimpanan draf dibatalkan oleh Supervisor.")).toBeVisible();
    expect(tulis).toHaveLength(1);
    // Lanjutkan → PATCH kedua dengan forceDuplicateNoSurat true.
    await simpan.click();
    dup = page.getByRole("dialog", { name: "Tetap simpan dengan No Surat yang sudah dipakai?" });
    await dup.getByRole("button", { name: "Saya yakin, lanjutkan" }).click();
    await expect(dup).toBeHidden(NAV);
    await expect(detail.getByText("Draf 009/KINO/10/2026 berhasil disimpan.")).toBeVisible(NAV);
    expect(tulis.map((t) => (t.body as Record<string, unknown>).forceDuplicateNoSurat)).toEqual([false, false, true]);

    // Galat server (500) tampil di dialog; dialog tetap terbuka; submit tidak dipanggil.
    mode = "500";
    await detail.getByRole("button", { name: "Kirim ke SM…" }).click();
    const dlg = page.getByRole("dialog", { name: "Kirim 009/KINO/10/2026 ke SM?" });
    await expect(dlg).toContainText("Tidak ada; dikirim apa adanya");
    await dlg.getByRole("button", { name: "Kirim ke SM" }).click();
    await expect(dlg.getByRole("alert")).toHaveText("Gagal menyimpan revisi batch.");
    await expect(dlg).toBeVisible();
    expect(tulis.some((t) => t.path.endsWith("/submit"))).toBe(false);
    await page.screenshot({ path: "test-results/fiori-opc-spv-galat-dialog.png" });
    await dlg.getByRole("button", { name: "Batal" }).click();

    // 409 "periode ditutup" = galat biasa di dialog, bukan konflik versi: tanpa strip konflik, tombol tetap aktif.
    mode = "periode";
    await detail.getByRole("button", { name: "Kirim ke SM…" }).click();
    await dlg.getByRole("button", { name: "Kirim ke SM" }).click();
    await expect(dlg.getByRole("alert")).toHaveText("Periode ini sudah ditutup dan tidak dapat diubah.");
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(detail.getByRole("alert").filter({ hasText: "Perubahan ditolak server" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Kirim ke SM…" })).toBeEnabled();

    // 409 (batch berubah sejak dibuka) → galat di dialog + strip halaman + BL-09; tombol nonaktif sampai muat ulang.
    mode = "409";
    await detail.getByRole("button", { name: "Kirim ke SM…" }).click();
    await dlg.getByRole("button", { name: "Kirim ke SM" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Batch hanya bisa diedit saat Draft");
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(detail.getByRole("alert").filter({ hasText: "Perubahan ditolak server" })).toBeVisible();
    await expect(detail.getByLabel("Usulan BL-09")).toBeVisible();
    await expect(detail.getByRole("button", { name: "Kirim ke SM…" })).toBeDisabled();
    await page.screenshot({ path: "test-results/fiori-opc-spv-konflik.png", fullPage: true });
    mode = "ok";
    await detail.getByRole("button", { name: "Muat ulang" }).click();
    await expect(detail.getByRole("alert").filter({ hasText: "Perubahan ditolak server" })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Kirim ke SM…" })).toBeEnabled();
    expect(tulis.some((t) => t.path.endsWith("/submit"))).toBe(false);
});

test("Batch baru di kolom kedua: nomor otomatis per principal, validasi kode lama, Simpan draf (POST) lalu batch tersimpan terbuka", async ({ page }) => {
    let sudahDikirim = true;
    const tulis = await mockSpv(page, {
        post: () => (sudahDikirim ? json({ ok: false, code: "ALREADY_SUBMITTED", message: "No Pengajuan otomatis sedang dipakai. Silakan coba simpan ulang." }, 409) : null),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/off-program-control", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Batch baru" }).click(NAV);
    await expect(page).toHaveURL(/view=baru/);
    const detail = detailOf(page);
    await expect(detail.getByRole("heading", { level: 1, name: "Batch baru" })).toBeVisible(NAV);
    const setup = detail.getByRole("region", { name: "Setup batch" });
    await expect(setup).toContainText(`004/RB/${MM}/${YYYY}`);
    await setup.getByLabel("Principal", { exact: true }).selectOption("KINO INDONESIA. TBK, PT");
    await expect(setup).toContainText(`004/KINO/${MM}/${YYYY}`);
    await expect(setup.getByLabel("Nama supervisor")).toHaveValue("Rahmat Hidayat");
    await expect(detail.locator(".fi-ftb")).toContainText("Tipe program pada baris 1 wajib dipilih");

    const form = detail.getByRole("region", { name: "Ubah item 1" });
    await form.getByLabel("No Surat").fill("KINO/PRG/1001");
    await form.getByLabel("Toko").fill("TK Baru");
    await form.getByLabel("Nominal").fill("Rp 750.000");
    await form.getByLabel("Tipe program").selectOption("Event");
    await expect(detail.locator(".fi-ftb")).toContainText("No Rekening pada baris 1 wajib diisi karena Cara Bayar adalah Transfer.");
    await expect(form.getByText("Wajib diisi karena cara bayar Transfer.")).toBeVisible();
    await form.getByLabel("Cara bayar").selectOption("Tunai");
    await expect(detail.getByRole("button", { name: "Simpan draf" })).toBeEnabled();
    await page.screenshot({ path: "test-results/fiori-opc-spv-baru.png", fullPage: true });

    // ALREADY_SUBMITTED saat Kirim (old 3496–3511): pesan lama + ringkasan, submit TIDAK dipanggil, form tetap terbuka.
    await detail.getByRole("button", { name: "Kirim ke SM…" }).click();
    const dlg = page.getByRole("dialog", { name: `Kirim batch baru 004/KINO/${MM}/${YYYY} ke SM?` });
    await dlg.getByRole("button", { name: "Kirim ke SM" }).click();
    await expect(dlg).toBeHidden(NAV);
    await expect(detail.getByText("Pengajuan ini sudah pernah dikirim.")).toBeVisible();
    await expect(detail.getByText("Silakan cek PDF atau lanjutkan alur persetujuan.")).toBeVisible();
    await expect(detail.locator(".fi-panel").filter({ hasText: "Jumlah baris terkirim" })).toContainText(`004/KINO/${MM}/${YYYY}`);
    expect(tulis.map((t) => `${t.method} ${t.path}`)).toEqual(["POST /api/off-program-control/batches"]);

    sudahDikirim = false;
    await detail.getByRole("button", { name: "Simpan draf" }).click();

    // Tanpa dialog "Tinggalkan perubahan" (draf sudah tersimpan); batch baru terbuka dalam mode ubah.
    await expect(page).toHaveURL(/batch=b-baru/, NAV);
    await expect(page).not.toHaveURL(/view=baru/);
    await expect(detail.getByRole("heading", { level: 1, name: `004/KINO/${MM}/${YYYY}` })).toBeVisible(NAV);
    await expect(detail.getByText(`Draf 004/KINO/${MM}/${YYYY} berhasil disimpan.`)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Tinggalkan perubahan yang belum disimpan?" })).toBeHidden();
    await expect(detail.getByRole("region", { name: "Setup batch" })).toBeVisible();
    expect(tulis.map((t) => `${t.method} ${t.path}`)).toEqual(["POST /api/off-program-control/batches", "POST /api/off-program-control/batches"]);
    expect(tulis[1].body).toMatchObject({
        supervisorName: "Rahmat Hidayat", principleCode: "KINO", principleName: "KINO INDONESIA. TBK, PT", bulan: MM, tahun: YYYY, forceDuplicateNoSurat: false,
        items: [{ noSurat: "KINO/PRG/1001", toko: "TK Baru", nominal: "Rp 750.000", caraBayar: "Tunai", noRekening: "", type: "Event", originalType: "Event", periode: "" }],
    });
});

test("Data selisih: ajukan pengembalian lewat dialog (payload kode lama); PDF surat hanya setelah Klaim menyetujui (#6)", async ({ page }) => {
    let refundGagal = true;
    const tulis = await mockSpv(page, { refund: () => (refundGagal ? json({ ok: false, error: "Gagal memuat data refund." }, 500) : null) });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/off-program-control", NAV);
    const main = page.locator("main");
    await main.getByRole("group", { name: "Tampilan antrean" }).getByRole("button", { name: /Data selisih/ }).click(NAV);
    await expect(page).toHaveURL(/view=selisih/);
    await expect(main.getByText("Supervisor wajib mengajukan pengembalian dana")).toBeVisible();
    await expect(main.getByText("Rp 450.000 perlu kembali · Menunggu pengembalian")).toBeVisible(); // old 3786–3807
    await expect(antrean(page).getByRole("button")).toHaveCount(1);
    await antrean(page).getByRole("button", { name: /008\/HEINZ\/09\/2026/ }).click();
    const detail = detailOf(page);
    const refund = detail.getByRole("region", { name: "Ajukan pengembalian" });
    // GET refund gagal → galat di tempat form, bukan bagian yang hilang.
    await expect(refund.getByRole("alert")).toContainText("Data pengembalian selisih gagal dimuat.", NAV);
    refundGagal = false;
    await refund.getByRole("button", { name: "Coba lagi" }).click();
    await expect(refund).toContainText("Rp 450.000", NAV);
    const ajukan = refund.getByRole("button", { name: "Ajukan pengembalian…" });
    await expect(ajukan).toBeDisabled();
    await refund.getByLabel("Jumlah pengembalian").fill("Rp 450.000");
    await refund.getByLabel("Tanggal pengembalian").fill("2026-10-07");
    await refund.getByLabel("Bank penerima").fill("BCA");
    await ajukan.click();
    const dlg = page.getByRole("dialog", { name: "Ajukan pengembalian Rp 450.000?" });
    await expect(dlg).toContainText("07/10/2026");
    await dlg.getByRole("button", { name: "Ajukan pengembalian" }).click();
    await expect(dlg).toBeHidden(NAV);
    await expect(detail.getByText("Pengembalian dana #1 sebesar Rp 450.000 berhasil disubmit. Menunggu verifikasi Finance.")).toBeVisible();
    expect(tulis).toEqual([{ method: "POST", path: "/api/off-program-control/batches/b-sel/refund",
        body: { refundAmount: 450000, refundMethod: "Transfer", refundDate: "2026-10-07", senderName: "", receiverBank: "BCA", note: "" } }]);

    // PDF #6: unduh hanya setelah Klaim menyetujui; batch yang baru dikirim hanya catatan.
    await page.goto("/off-program-control?batch=b-ok", NAV);
    await expect(detail.getByRole("link", { name: "Unduh PDF surat" })).toHaveAttribute("href", "/api/off-program-control/batches/b-ok/pdf", NAV);
    await page.goto("/off-program-control?batch=b-sm", NAV);
    await expect(detail.getByText("dapat dicetak setelah pengajuan disetujui Klaim.")).toBeVisible(NAV);
    await expect(detail.getByRole("link", { name: "Unduh PDF surat" })).toHaveCount(0);
    await expect(detail.getByText("Batch sudah dikirim/disetujui atau terkunci.")).toBeVisible();
    await expect(detail.locator(".fi-ftb")).toHaveCount(0);
});

test("Diskon SPV: daftar, galat ≠ kosong, catat lewat dialog (FormData kode lama)", async ({ page }) => {
    let gagal = true;
    const tulis = await mockSpv(page, { diskon: () => (gagal ? json({ ok: false, error: "Gagal mengambil pengajuan diskon." }, 500) : json({ ok: true, submissions: [] })) });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?view=diskon", NAV);
    const main = page.locator("main");
    await expect(main.getByText("Gagal mengambil pengajuan diskon.")).toBeVisible(NAV);
    await expect(main.getByText("Belum ada pengajuan diskon.")).toHaveCount(0);
    gagal = false;
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByText("Belum ada pengajuan diskon.")).toBeVisible(NAV);
    const form = main.getByRole("region", { name: "Catat pengajuan diskon" });
    await expect(form.getByRole("button", { name: "Catat pengajuan diskon…" })).toBeDisabled();
    await form.getByLabel("Toko / customer").fill("TK Diskon");
    await form.getByLabel("Principal").selectOption("KINO INDONESIA. TBK, PT");
    await form.getByLabel("Nominal diskon").fill("Rp 125.000");
    await form.getByRole("button", { name: "Catat pengajuan diskon…" }).click();
    const dlg = page.getByRole("dialog", { name: "Catat pengajuan diskon untuk TK Diskon?" });
    await dlg.getByRole("button", { name: "Catat pengajuan" }).click();
    await expect(dlg).toBeHidden(NAV);
    await expect(main.getByText("Pengajuan diskon tercatat sebagai jejak digital.")).toBeVisible();
    expect(tulis).toHaveLength(1);
    const fd = String(tulis[0].body);
    for (const [k, v] of [["toko", "TK Diskon"], ["principleName", "KINO INDONESIA. TBK, PT"], ["principleCode", "KINO"], ["nominal", "Rp 125.000"]]) {
        expect(fd).toContain(`name="${k}"\r\n\r\n${v}\r\n`);
    }
    // Ctrl K dari Diskon membuka batch di kolom kedua; tombol Diskon menutup batch dan kembali ke Diskon.
    await page.keyboard.press("Control+k");
    const cari = main.getByRole("combobox", { name: "Cari pengajuan OFF" });
    await cari.fill("ENI");
    await cari.press("Enter");
    await expect(page).toHaveURL(/batch=b-ret/);
    await expect(detailOf(page).getByRole("heading", { level: 1, name: "006/ENI/10/2026" })).toBeVisible(NAV);
    await main.getByRole("button", { name: "Pengajuan diskon SPV" }).click();
    await expect(page).not.toHaveURL(/batch=/);
    await expect(main.getByRole("button", { name: "Kembali ke pengajuan" })).toBeVisible(NAV);
    await main.getByRole("button", { name: "Kembali ke pengajuan" }).click();
    await expect(page).not.toHaveURL(/view=diskon/);
});

test("ponsel 390 px: mode ubah sebagai daftar item + form berlabel; batch baru; tanpa gulir menyamping", async ({ page }) => {
    await mockSpv(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const detail = detailOf(page);
    await page.goto("/off-program-control?view=baru", NAV);
    await expect(detail.getByRole("heading", { level: 1, name: "Batch baru" })).toBeVisible(NAV);
    await expect(detail.getByRole("list", { name: "Daftar item" })).toBeVisible();
    await noOverflow(page);
    await page.goto("/off-program-control?batch=b-ret", NAV);
    await expect(detail.getByRole("heading", { level: 1, name: "006/ENI/10/2026" })).toBeVisible(NAV);
    const daftar = detail.getByRole("list", { name: "Daftar item" });
    await expect(daftar).toBeVisible();
    await expect(detail.getByRole("table", { name: "Daftar item" })).toBeHidden();
    await noOverflow(page);
    await daftar.getByRole("button", { name: /Item 1/ }).click();
    const form1 = detail.getByRole("region", { name: "Ubah item 1" });
    await expect(form1.getByLabel("Nominal")).toBeVisible();
    await form1.getByLabel("Nominal").fill("Rp 1.000.000");
    await expect(detail.getByRole("button", { name: "Kirim ke SM…" })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-opc-spv-ponsel.png", fullPage: true });
});
