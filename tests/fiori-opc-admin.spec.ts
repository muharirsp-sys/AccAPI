/*
 * Tujuan: Fiori S4d OFF Program Control — layar admin: Ringkasan (Overview Page: kesehatan proses, antrean per tahap/divisi, lewat SLA,
 *   pengajuan bermasalah, Tutup periode lewat dialog `tutup` dengan payload POST /periods diperiksa — satu principal dan semua
 *   principal termasuk gagal sebagian — lalu Buka kunci lewat dialog; refund tertunda disebut tanpa memblok; Batal benar-benar batal;
 *   periode terpilih dan fakta dialog beku saat daftar dimuat ulang;
 *   metrik non-admin untuk OM; galat ≠ kosong) dan Log audit (koreksi lewat dialog dengan alasan wajib + payload diperiksa, galat di
 *   dialog, ekspor CSV mengikuti saringan, galat daftar ≠ kosong), ponsel 390 px tanpa gulir menyamping.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = admin):
 *   `npx playwright test tests/fiori-opc-admin.spec.ts --config playwright.fiori-local.config.ts --workers=1 --output=test-results/admin`.
 * Dependensi: /api/off-program-control/* dan /api/auth/get-session di-mock dengan page.route (tidak menyentuh DB).
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
    id, noPengajuan: no, gelombang: no.slice(0, 3), principleCode, principleName, bulan: no.split("/").at(-2), tahun: no.split("/").at(-1),
    supervisorName: "Rahmat", status: "Draft", smStatus: "Not Started", claimStatus: "Not Started", omStatus: "Not Started",
    financeStatus: "Not Started", finalStatus: "Not Started", locked: false, createdBy: "u-spv", createdByRole: "supervisor",
    refundStatus: "Not Applicable", createdAt: kini, updatedAt: kini, payments: [],
    summary: { totalNominal: 4_300_000, totalRows: 2 }, periodDates: { pengajuan: ["2026-10-02"] }, ...over,
});
const lunas = (n: number) => ({ paymentSummary: { totalNominal: n, totalPaid: n, remainingAmount: 0, isFullyPaid: true }, summary: { totalNominal: n, totalRows: 2 } });
const SM = { smStatus: "Approved by SM", locked: true };
const OMOK = { ...SM, claimStatus: "Approved", omStatus: "Approved" };
const BATCHES = [
    batch("b-sm1", "007/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", { status: "Submitted to SM", smStatus: "Waiting Review", submittedAt: lalu(20) }),
    batch("b-ret", "006/ENI/10/2026", "ENI", "ENERGIZER INDONESIA, PT", { status: "Returned by SM", smStatus: "Returned", returnedAt: kini }),
    batch("b-draf", "009/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", { updatedAt: lalu(10), createdAt: lalu(10) }),
    batch("b-om", "002/KINO/10/2026", "KINO", "KINO INDONESIA. TBK, PT", { status: "Claim Approved", ...SM, claimStatus: "Approved", omStatus: "Waiting Approval", claimDeadline: "2099-11-05" }),
    // September 2026: URC belum dibayar (belum sesuai); GDI, RB cocok; HEINZ cocok tetapi refund tertunda.
    batch("b-bayar", "004/URC/09/2026", "URC", "URC INDONESIA, PT", { status: "OM Approved", ...OMOK, financeStatus: "Waiting Payment", claimDeadline: "2020-01-31" }),
    batch("b-final", "001/RB/09/2026", "RB", "RECKITT BENCKISER, PT", { status: "Paid", ...OMOK, financeStatus: "Paid", finalStatus: "Waiting Claim Final Verification", ...lunas(4_300_000) }),
    batch("b-selesai", "003/GDI/09/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { status: "Completed", ...OMOK, financeStatus: "Paid", finalStatus: "Completed", ...lunas(2_150_000) }),
    batch("b-heinz", "008/HEINZ/09/2026", "HEINZ", "HEINZ ABC INDONESIA, PT", { status: "Overpaid - Pending Refund", ...OMOK, financeStatus: "Paid", finalStatus: "Pending Refund", refundStatus: "Pending Refund", ...lunas(9_800_000) }),
    // Agustus 2026: dua principal, keduanya cocok (untuk tutup semua principal).
    batch("b-ag1", "010/KINO/08/2026", "KINO", "KINO INDONESIA. TBK, PT", { status: "Completed", ...OMOK, financeStatus: "Paid", finalStatus: "Completed", ...lunas(2_000_000) }),
    batch("b-ag2", "011/GDI/08/2026", "GDI", "GODREJ DISTRIBUSI INDONESIA, PT", { status: "Completed", ...OMOK, financeStatus: "Paid", finalStatus: "Completed", ...lunas(1_000_000) }),
];
const AUDIT = [
    { id: "a3", batchId: "b-sm1", actorName: "Rina", actorRole: "claim", action: "audit_correction", fromStatus: "Draft", toStatus: "Submitted to SM", note: "Dikirim ulang", correctionReason: "Salah ketik catatan", parentAuditLogId: "a2", previousValue: { note: "Dikrim" }, createdAt: lalu(1) },
    { id: "a2", batchId: "b-sm1", actorName: "Rahmat", actorRole: "supervisor", action: "submit_to_sm", fromStatus: "Draft", toStatus: "Submitted to SM", note: "Dikrim", createdAt: lalu(20) },
    { id: "a1", batchId: "b-sm1", actorName: "Rahmat", actorRole: "supervisor", action: "create_batch", toStatus: "Draft", createdAt: lalu(21) },
].map((a) => ({ ...a, noPengajuan: "007/KINO/10/2026", principleName: "KINO INDONESIA. TBK, PT" }));

type Opsi = {
    daftar?: () => ReturnType<typeof json>;
    audit?: () => ReturnType<typeof json>;
    /** Jawaban POST (periods / correction); bawaan sukses. */
    tulis?: (k: Kirim) => ReturnType<typeof json> | null;
    peran?: string;
};
/** Semua endpoint OPC dimock. Mengembalikan daftar permintaan tulis (method, path, body) dan hitungan GET audit. */
async function mockOpc(page: Page, opsi: Opsi = {}) {
    const kirim: Kirim[] = [];
    const getAudit: string[] = [];
    if (opsi.peran) {
        await page.route((u) => u.pathname === "/api/auth/get-session", (r) => r.fulfill(json({
            session: { id: "s1", userId: "u-1", token: "t", expiresAt: lalu(-1), createdAt: kini, updatedAt: kini },
            user: { id: "u-1", name: "Oki", email: "oki@example.invalid", emailVerified: true, role: opsi.peran, createdAt: kini, updatedAt: kini },
        })));
    }
    await page.route((u) => u.pathname.startsWith("/api/off-program-control/"), (r) => {
        const req = r.request();
        const url = new URL(req.url());
        const p = url.pathname;
        if (req.method() !== "GET") {
            const k: Kirim = { method: req.method(), path: p, body: req.postDataJSON() };
            kirim.push(k);
            const jawab = opsi.tulis?.(k);
            if (jawab) return r.fulfill(jawab);
            if (p === "/api/off-program-control/periods") {
                const tutup = (k.body as Over).action === "close";
                return r.fulfill(json({ ok: true, status: tutup ? "Ditutup" : "Terbuka", message: tutup ? "Periode berhasil ditutup. Data pada periode ini sudah dikunci." : "Kunci periode berhasil dibuka oleh Admin." }));
            }
            if (/^\/api\/off-program-control\/audit\/[^/]+\/correction$/.test(p)) return r.fulfill(json({ ok: true, message: "Koreksi tercatat sebagai riwayat baru tanpa menghapus jejak lama." }));
            return r.fulfill(json({ ok: false, error: "tidak dimock" }, 405));
        }
        if (p === "/api/off-program-control/batches") return r.fulfill(opsi.daftar ? opsi.daftar() : json({ ok: true, batches: BATCHES }));
        if (p === "/api/off-program-control/audit") { getAudit.push(url.search); return r.fulfill(opsi.audit ? opsi.audit() : json({ ok: true, audit: AUDIT })); }
        return r.fulfill(json({ ok: false, error: "tidak dimock" }, 404));
    });
    return { kirim, getAudit };
}

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
const PERIODS = "/api/off-program-control/periods";

// Server dev: kompilasi rute pertama setelah perubahan bisa memakan >30 dtk.
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Ringkasan admin: kesehatan proses, per tahap, per divisi, bermasalah, aktivitas; tanpa permintaan tulis", async ({ page }) => {
    const { kirim } = await mockOpc(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control", NAV);
    const main = page.locator("main");
    const kesehatan = main.getByRole("group", { name: "Kesehatan proses" });
    await expect(kesehatan).toContainText("Pengajuan aktif", NAV);
    await expect(kesehatan).toContainText("Lewat batas klaim1"); // 004/URC (deadline 2020) — isOverdueBatch kode lama
    await expect(main.getByRole("group", { name: "Batch per tahap" }).getByRole("button", { name: /Menunggu SM/ })).toContainText("1");
    const perhatian = main.getByRole("list", { name: "Butuh perhatian" });
    await expect(perhatian).toContainText("Lewat batas klaim");
    await expect(perhatian).toContainText("Terlalu lama diproses"); // 009/KINO tidak berubah 10 hari
    await expect(perhatian).toContainText("Pengajuan dan klaim belum sesuai");
    // Bagian di kolom kartu (< 600 px) tampil sebagai daftar (ResponsiveTable, container query).
    const bermasalah = main.getByRole("list", { name: "Pengajuan bermasalah" });
    await expect(bermasalah).toContainText("004/URC/09/2026");
    await expect(bermasalah.getByRole("button", { name: /006\/ENI\/10\/2026/ })).toContainText("Dikembalikan");
    await expect(main.getByRole("list", { name: "Batch lewat SLA" })).toContainText("007/KINO/10/2026");
    await expect(main.getByRole("list", { name: "Aktivitas terakhir" }).getByRole("button")).toHaveCount(5);
    for (const bl of ["BL-11", "BL-12", "BL-13"]) await expect(main.getByLabel(`Usulan ${bl}`).first()).toBeVisible();
    // Kerangka menggulir di dalam <main>: tangkapan seluruh halaman lewat viewport tinggi.
    await page.setViewportSize({ width: 1366, height: 3000 });
    await page.screenshot({ path: "test-results/fiori-opc-admin-ringkasan.png" });
    await page.setViewportSize({ width: 1366, height: 900 });

    // Antrean per divisi membuka tab divisi itu; Final Klaim membuka verifikasi final Klaim.
    const divisi = main.getByRole("group", { name: "Antrean per divisi" });
    await expect(divisi.getByRole("button", { name: /^Sales Manager/ })).toContainText("1");
    await divisi.getByRole("button", { name: /^Final Klaim/ }).click();
    await expect(page).toHaveURL(/tab=claim/);
    await expect(page).toHaveURL(/claimView=after-finance/);
    // Pengajuan bermasalah membuka batch di "Semua pengajuan".
    await page.goto("/off-program-control", NAV);
    await bermasalah.getByRole("button", { name: /004\/URC\/09\/2026/ }).click();
    await expect(page).toHaveURL(/batch=b-bayar/);
    await expect(main.getByRole("group", { name: "Tampilan ringkasan" }).getByRole("button", { name: /Semua pengajuan/ })).toHaveAttribute("aria-pressed", "true");
    expect(kirim).toEqual([]);
});

test("Tutup periode satu principal lewat dialog: refund tertunda disebut, payload sama dengan kode lama, sukses, lalu buka kunci lewat dialog", async ({ page }) => {
    const { kirim } = await mockOpc(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control", NAV);
    const periode = page.locator("main").getByRole("region", { name: "Tutup periode" });
    await periode.getByLabel("Bulan").selectOption("09", NAV);
    await periode.getByLabel("Tahun").fill("2026");
    // Semua principal September: URC belum dibayar → tombol nonaktif dengan alasan, strip peringatan.
    await expect(periode.getByRole("button", { name: "Tutup periode…" })).toBeDisabled();
    await expect(periode.getByText("Tutup periode nonaktif: Total pengajuan dan total klaim belum sesuai.")).toBeVisible();
    await expect(page.locator("main").getByRole("list", { name: "Diajukan vs diklaim per principal" }).getByRole("listitem").filter({ hasText: "URC" })).toContainText("Belum sesuai");

    await periode.getByLabel("Principal").selectOption("HEINZ");
    await expect(periode.getByRole("group", { name: "Angka periode terpilih" })).toContainText("Refund tertunda1");
    await expect(periode.getByRole("link", { name: "Unduh rekonsiliasi" })).toHaveAttribute("href", "/api/off-program-control/periods/reconciliation?principleCode=HEINZ&bulan=09&tahun=2026");

    // Batal benar-benar batal.
    await periode.getByRole("button", { name: "Tutup periode…" }).click();
    let dlg = page.getByRole("dialog", { name: "Tutup periode September 2026 untuk HEINZ ABC INDONESIA, PT?" });
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(dlg).toBeHidden();
    expect(kirim).toEqual([]);

    await periode.getByRole("button", { name: "Tutup periode…" }).click();
    await expect(dlg).toContainText("Refund tertunda");
    await expect(dlg).toContainText("1 · 008/HEINZ/09/2026");
    await expect(dlg).toContainText("Rp 9.800.000");
    await expect(dlg.getByLabel("Usulan BL-12")).toContainText("hanya bisa diselesaikan admin");
    await page.screenshot({ path: "test-results/fiori-opc-admin-tutup.png" });
    await dlg.getByRole("button", { name: "Tutup periode", exact: true }).click();
    await expect(dlg).toBeHidden();
    expect(kirim).toEqual([{ method: "POST", path: PERIODS, body: { action: "close", principleCode: "HEINZ", bulan: "09", tahun: "2026" } }]);
    await expect(periode.getByRole("status").filter({ hasText: "Periode September 2026 berhasil ditutup." })).toContainText("Data pada periode ini sudah dikunci.");
    await expect(periode).toContainText(/Ditutup \d{2}\.\d{2}/);

    // Buka kunci: dialog konfirmasi (endpoint belum menerima alasan → VariantNote BL-12), payload sama dengan kode lama.
    await periode.getByRole("button", { name: "Buka kunci periode…" }).click();
    dlg = page.getByRole("dialog", { name: "Buka kunci periode September 2026 untuk HEINZ ABC INDONESIA, PT?" });
    await expect(dlg.getByLabel("Usulan BL-12")).toContainText("alasan wajib");
    await expect(dlg.getByRole("textbox")).toHaveCount(0);
    await dlg.getByRole("button", { name: "Buka kunci", exact: true }).click();
    await expect(dlg).toBeHidden();
    expect(kirim[1]).toEqual({ method: "POST", path: PERIODS, body: { action: "unlock", principleCode: "HEINZ", bulan: "09", tahun: "2026" } });
    await expect(periode.getByRole("status").filter({ hasText: "Kunci periode September 2026 dibuka." })).toBeVisible();
    await expect(periode.getByRole("button", { name: "Buka kunci periode…" })).toHaveCount(0);
});

test("Tutup semua principal: satu POST per principal; gagal sebagian tampil di dialog (isian tetap), ulang berhasil", async ({ page }) => {
    let tolakGdi = true;
    const { kirim } = await mockOpc(page, {
        tulis: (k) => (tolakGdi && (k.body as Over).principleCode === "GDI"
            ? json({ ok: false, error: "Periode belum dapat ditutup karena total pengajuan dan total klaim belum sesuai." }, 409) : null),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control", NAV);
    const periode = page.locator("main").getByRole("region", { name: "Tutup periode" });
    await periode.getByLabel("Bulan").selectOption("08", NAV);
    await periode.getByLabel("Tahun").fill("2026");
    await periode.getByRole("button", { name: "Tutup periode…" }).click();
    const dlg = page.getByRole("dialog", { name: "Tutup periode Agustus 2026?" });
    await expect(dlg).toContainText("Semua principal (2): KINO, GDI");
    await expect(dlg).toContainText("Satu permintaan per principal");
    await dlg.getByRole("button", { name: "Tutup periode", exact: true }).click();
    await expect(dlg.getByRole("alert")).toContainText("1 principal gagal diproses: GDI (Periode belum dapat ditutup karena total pengajuan dan total klaim belum sesuai.). 1 principal lain sudah ditutup: KINO.");
    await expect(dlg).toBeVisible();
    const badan = (pc: string) => ({ method: "POST", path: PERIODS, body: { action: "close", principleCode: pc, bulan: "08", tahun: "2026" } });
    expect(kirim).toHaveLength(2);
    expect(kirim).toEqual(expect.arrayContaining([badan("KINO"), badan("GDI")]));

    tolakGdi = false;
    await dlg.getByRole("button", { name: "Tutup periode", exact: true }).click();
    await expect(dlg).toBeHidden();
    expect(kirim).toHaveLength(4);
    await expect(periode.getByRole("status").filter({ hasText: "Periode Agustus 2026 berhasil ditutup." })).toContainText("Semua 2 principal berhasil ditutup untuk periode Agustus 2026.");
});

test("periode terpilih beku: muat ulang daftar dengan batch periode lain tidak menggeser periode maupun fakta dan POST dialog", async ({ page }) => {
    let daftar = BATCHES;
    const { kirim } = await mockOpc(page, { daftar: () => json({ ok: true, batches: daftar }) });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control", NAV);
    const main = page.locator("main");
    const periode = main.getByRole("region", { name: "Tutup periode" });
    const tampilan = main.locator('[aria-label="Tampilan ringkasan"]'); // textContent tetap terbaca walau dialog modal membuat halaman inert
    // Polling/fokus tab memuat ulang daftar (useDaftarBatch); batch terbaru kini November.
    const segarkan = async (baru: typeof BATCHES, n: number) => {
        daftar = baru;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect(tampilan).toContainText(`Semua pengajuan (${n})`);
    };
    await expect(periode.getByLabel("Bulan")).toHaveValue("10", NAV);
    await segarkan([batch("b-nov", "012/KINO/11/2026", "KINO", "KINO INDONESIA. TBK, PT"), ...BATCHES], 11);
    await expect(periode.getByLabel("Bulan")).toHaveValue("10");
    await expect(periode.getByLabel("Tahun")).toHaveValue("2026");
    await expect(main.getByRole("region", { name: "Diajukan vs diklaim" })).toContainText("Oktober 2026");

    // Dialog terbuka: batch Agustus baru (HEINZ) tiba di latar — fakta dan POST tetap potret saat dialog dibuka.
    await periode.getByLabel("Bulan").selectOption("08");
    await periode.getByRole("button", { name: "Tutup periode…" }).click();
    const dlg = page.getByRole("dialog", { name: "Tutup periode Agustus 2026?" });
    await expect(dlg).toContainText("Semua principal (2): KINO, GDI");
    await expect(dlg).toContainText("2 · 2 Selesai");
    await segarkan([batch("b-ag3", "013/HEINZ/08/2026", "HEINZ", "HEINZ ABC INDONESIA, PT", { status: "Completed", ...OMOK, financeStatus: "Paid", finalStatus: "Completed", ...lunas(500_000) }), ...daftar], 12);
    await expect(dlg).toContainText("Semua principal (2): KINO, GDI");
    await expect(dlg).not.toContainText("HEINZ");
    await dlg.getByRole("button", { name: "Tutup periode", exact: true }).click();
    await expect(dlg).toBeHidden();
    expect(kirim.map((k) => (k.body as Over).principleCode).sort()).toEqual(["GDI", "KINO"]);
    expect(kirim.every((k) => (k.body as Over).bulan === "08" && (k.body as Over).tahun === "2026")).toBe(true);
    await expect(periode.getByLabel("Bulan")).toHaveValue("08");
});

test("OM: metrik non-admin, tanpa panel admin; Tutup periode tetap tampil (izin diperiksa server)", async ({ page }) => {
    await mockOpc(page, { peran: "om" });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=overview", NAV);
    const main = page.locator("main");
    const metrik = main.getByRole("group", { name: "Metrik pengajuan" });
    await expect(metrik).toContainText("Menunggu tinjauan SM1", NAV);
    await expect(metrik).toContainText("Menunggu persetujuan OM1");
    await expect(main.getByRole("group", { name: "Kesehatan proses" })).toHaveCount(0);
    await expect(main.getByRole("group", { name: "Antrean per divisi" })).toHaveCount(0);
    await expect(main.getByRole("region", { name: "Tutup periode" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Diajukan vs diklaim" })).toBeVisible();
});

test("galat ringkasan tidak tampil sebagai kosong; kosong = belum ada batch", async ({ page }) => {
    let gagal = true;
    let kosong = false;
    await mockOpc(page, { daftar: () => (gagal ? json({ ok: false, error: "Data pengajuan belum berhasil dimuat. Silakan coba lagi." }, 500) : json({ ok: true, batches: kosong ? [] : BATCHES })) });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { name: "Ringkasan gagal dimuat" })).toBeVisible(NAV);
    await expect(main.getByText("Angka tidak ditampilkan agar tidak terbaca sebagai nol.")).toBeVisible();
    await expect(main.getByRole("heading", { name: "Belum ada batch" })).toHaveCount(0);
    await expect(main.getByRole("region", { name: "Tutup periode" })).toHaveCount(0);
    gagal = false;
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("region", { name: "Tutup periode" })).toBeVisible(NAV);
    kosong = true;
    await page.goto("/off-program-control", NAV);
    await expect(main.getByRole("heading", { name: "Belum ada batch" })).toBeVisible(NAV);
    await expect(main.getByRole("heading", { name: "Ringkasan gagal dimuat" })).toHaveCount(0);
});

test("Log audit: koreksi lewat dialog (alasan wajib, payload, galat di dialog), ekspor CSV mengikuti saringan", async ({ page }) => {
    let tolak = true;
    const { kirim, getAudit } = await mockOpc(page, {
        tulis: (k) => (tolak && k.path.endsWith("/correction") ? json({ ok: false, error: "Gagal menyimpan koreksi audit log." }, 500) : null),
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=audit", NAV);
    const main = page.locator("main");
    const log = main.getByRole("table", { name: "Log audit OFF Program Control" });
    await expect(log.locator("tbody tr")).toHaveCount(3, NAV);
    // Baris koreksi: badge, alasan, catatan sebelumnya; tanpa tombol koreksi.
    const barisKoreksi = log.getByRole("row", { name: /Koreksi riwayat/ });
    await expect(barisKoreksi).toContainText("Alasan koreksi: Salah ketik catatan · Dikirim ulang (sebelumnya: Dikrim)");
    await expect(barisKoreksi.getByRole("button", { name: /^Koreksi log/ })).toHaveCount(0);

    const ekspor = main.getByRole("link", { name: "Ekspor CSV" });
    await expect(ekspor).toHaveAttribute("href", "/api/off-program-control/audit?format=csv");
    await main.locator(".fi-fbar-fields").getByLabel("Bulan").fill("2026-09");
    await expect(ekspor).toHaveAttribute("href", "/api/off-program-control/audit?format=csv&dateFrom=2026-09-01&dateTo=2026-09-30");
    await expect.poll(() => getAudit.at(-1)).toBe("?dateFrom=2026-09-01&dateTo=2026-09-30");
    await main.getByRole("list", { name: "Saringan aktif" }).getByRole("button", { name: "Hapus semua" }).click();

    await log.getByRole("button", { name: "Koreksi log Mengirim ke SM 007/KINO/10/2026" }).click();
    const dlg = page.getByRole("dialog", { name: "Koreksi log Mengirim ke SM pada 007/KINO/10/2026?" });
    await expect(dlg).toContainText("Perubahan pada audit log akan tercatat sebagai riwayat koreksi.");
    await expect(dlg.getByLabel("Catatan baru (opsional)")).toHaveValue("Dikrim");
    const simpan = dlg.getByRole("button", { name: "Simpan koreksi" });
    await expect(simpan).toBeDisabled(); // alasan wajib
    await dlg.getByLabel("Catatan baru (opsional)").fill("Dikirim ulang ke SM");
    await dlg.getByLabel("Alasan koreksi").fill("  Catatan SPV salah ketik  ");
    await simpan.click();
    await expect(dlg.getByRole("alert")).toContainText("Gagal menyimpan koreksi audit log.");
    await expect(dlg.getByLabel("Alasan koreksi")).toHaveValue("  Catatan SPV salah ketik  "); // isian tidak dikosongkan
    tolak = false;
    const nGet = getAudit.length;
    await simpan.click();
    await expect(dlg).toBeHidden();
    expect(kirim.map((k) => [k.method, k.path, k.body])).toEqual([
        ["POST", "/api/off-program-control/audit/a2/correction", { correctionReason: "Catatan SPV salah ketik", note: "Dikirim ulang ke SM" }],
        ["POST", "/api/off-program-control/audit/a2/correction", { correctionReason: "Catatan SPV salah ketik", note: "Dikirim ulang ke SM" }],
    ]);
    await expect(main.getByRole("status").filter({ hasText: "Koreksi tercatat sebagai riwayat baru tanpa menghapus jejak lama." })).toBeVisible();
    await expect.poll(() => getAudit.length).toBeGreaterThan(nGet); // daftar dimuat ulang
    await expect(main.getByLabel("Usulan BL-33")).toBeVisible();
});

test("Log audit: galat daftar tidak tampil sebagai kosong; kosong dan saringan berbeda", async ({ page }) => {
    let mode: "galat" | "kosong" = "galat";
    await mockOpc(page, { audit: () => (mode === "galat" ? json({ ok: false, error: "Gagal mengambil audit log." }, 500) : json({ ok: true, audit: [] })) });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/off-program-control?tab=audit", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("alert").filter({ hasText: "Gagal mengambil audit log." })).toBeVisible(NAV);
    await expect(main.getByRole("heading", { name: "Belum ada log audit" })).toHaveCount(0);
    mode = "kosong";
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("heading", { name: "Belum ada log audit" })).toBeVisible(NAV);
    await main.locator(".fi-fbar-fields").getByLabel("Cari").fill("tidak-ada");
    await expect(main.getByRole("heading", { name: "Tidak ada log yang cocok dengan saringan" })).toBeVisible(NAV);
});

test("ponsel 390 px: Ringkasan dan dialog tutup periode tanpa gulir menyamping", async ({ page }) => {
    await mockOpc(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/off-program-control", NAV);
    const periode = page.locator("main").getByRole("region", { name: "Tutup periode" });
    await expect(periode).toBeVisible(NAV);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-opc-admin-ponsel.png", fullPage: true });
    await periode.getByLabel("Bulan").selectOption("09");
    await periode.getByLabel("Principal").selectOption("GDI");
    await periode.getByRole("button", { name: "Tutup periode…" }).click();
    const dlg = page.getByRole("dialog", { name: /Tutup periode September 2026/ });
    await expect(dlg).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-opc-admin-ponsel-tutup.png" });
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(dlg).toBeHidden();
});

test("ponsel 390 px: Log audit sebagai daftar, koreksi tetap terjangkau, tanpa gulir menyamping", async ({ page }) => {
    await mockOpc(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/off-program-control?tab=audit", NAV);
    const daftar = page.locator("main").getByRole("list", { name: "Log audit OFF Program Control" });
    await expect(daftar.getByRole("button", { name: /^Koreksi log/ })).toHaveCount(2, NAV);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-opc-admin-ponsel-audit.png", fullPage: true });
    await daftar.getByRole("button", { name: /^Koreksi log Membuat batch/ }).click();
    await expect(page.getByRole("dialog", { name: "Koreksi log Membuat batch pada 007/KINO/10/2026?" })).toBeVisible();
    await noOverflow(page);
});
