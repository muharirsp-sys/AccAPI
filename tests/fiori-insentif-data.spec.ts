/*
 * Tujuan: Fiori S4c Insentif Sales — layar Data periode (wizard: Kosong langkah 1, Draf panduan kolom + galat unduh templat,
 *   Pratinjau progres [cabang NILAI_JUAL, angka format Indonesia] lalu Terapkan lewat dialog dengan payload diperiksa, Galat impor
 *   target ditolak server tanpa menulis; keputusan per baris: gabung kode, pakai SPV, hapus target, hapus realisasi — payload/query
 *   diperiksa) dan Pengaturan (Default,
 *   GET settings gagal → editor terkunci, simpan konstanta lewat dialog, tautkan akun lewat dialog); ponsel 390 px tanpa gulir
 *   menyamping; tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-insentif-data.spec.ts --config playwright.fiori-local.config.ts`.
 * Dependensi: /api/insentif-sales/* di-mock dengan page.route (tidak menyentuh DB).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import * as XLSX from "xlsx";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;

const TARGET = (salesCode: string, salesName: string, principle: string, targetValue: number) => ({
    salesCode, salesName, principle, branch: principle, channel: "GT", spvName: "ANI", smName: "HENDRIK",
    targetValue, targetEc: 300, targetAo: 240, targetIa: 500, splmValue: 0, tipeSales: "exclusive", statusInsentif: "distributor_principle",
});
const KONSTANTA = {
    gt: { pool1: 1_000_000, aoAmbang: 240, bobotAo: 0.7, bobotValue: 0.3, mix2: 1_000_000, mix3: 1_200_000, mix4: 1_400_000, mix5: 1_500_000, ambangBayar: 0.9 },
    mt: { bobotValue: 350_000, bobotEc: 150_000, bobotAo: 150_000, bobotIa: 350_000, ambangIa: 0.8 },
    spv: { rate1: 1_500_000, rateBase: 200_000, rateFaktor: 1_200_000, rateFloor: 400_000, ambang: 1 },
    sm: { ambang1: 0.9, nominal1: 1_500_000, ambang2: 1.0, nominal2: 2_500_000, ambang3: 1.1, nominal3: 3_500_000 },
    pph: { rate: 0.025 },
};
/**
 * AM-045: versi konstanta = updatedAt ISO baris tersimpan (02/09 14.05 WITA). Simpan dari layar ini memberi 09/10 10.30, 10.31, …;
 * admin lain menyimpan 09/10 10.20 WITA.
 */
const VERSI = "2026-09-02T06:05:00.000Z";
const VERSI_BARU = "2026-10-09T02:30:00.000Z";
const VERSI_ADMIN_LAIN = "2026-10-09T02:20:00.000Z";
const SETTINGS = { gtAoMode: "fixed240", branchNilaiJual: ["VINDA", "ABC"], smBerhak: ["HENDRIK"], konstanta: KONSTANTA, konstantaSumber: "tersimpan", konstantaVersi: VERSI, konstantaBawaan: KONSTANTA };
const USERS = [
    { id: "u1", name: "Bayu Saputra", email: "bayu@sp.test", hierarchyRole: null, hierarchyName: null },
    { id: "u2", name: "Lukman Hakim", email: "lukman@sp.test", hierarchyRole: null, hierarchyName: null },
    { id: "u3", name: "Andi Pratama", email: "andi@sp.test", hierarchyRole: "sales", hierarchyName: "MKS-07" },
];

type Opsi = {
    targets?: unknown[]; settingsGagal?: boolean; tolakTarget?: string; tolakHapus?: string;
    /** GET settings 200 dengan konstantaSumber "gagal_baca" + konstanta BAWAAN (route AM-020). */
    konstantaGagalBaca?: boolean;
    /** PATCH konstanta berikutnya (sekali) putus tanpa jawaban; admin lain menyimpan di antaranya. */
    patchKonstanta?: "putus";
    /** Admin lain menyimpan konstanta tepat sebelum PATCH berikutnya (apa pun isinya) tiba — sekali. */
    adminLainSebelumPatch?: boolean;
    /** Jumlah GET settings (dibaca test untuk memastikan muat ulang). */
    getSettings?: number;
    /** Keadaan server settings; PATCH konstanta = CAS seperti route (versi beda → 409 KONSTANTA_BERUBAH). */
    server?: { konstanta: typeof KONSTANTA; versi: string | null; gtAoMode: string };
};
/** Angka admin lain: pool1 dan mix2 berubah. */
const KONSTANTA_LAIN = { ...KONSTANTA, gt: { ...KONSTANTA.gt, pool1: 1_250_000, mix2: 1_100_000 } };

/** Semua /api/insentif-sales/* dimock; permintaan tulis dicatat untuk diperiksa. */
async function mockApi(page: Page, opsi: Opsi = {}) {
    const tulis: Request[] = [];
    const server = (opsi.server ??= { konstanta: KONSTANTA, versi: VERSI, gtAoMode: "fixed240" });
    let simpanKe = 0;
    const adminLain = () => { server.konstanta = KONSTANTA_LAIN; server.versi = VERSI_ADMIN_LAIN; };
    const setelan = () => json({ ...SETTINGS, gtAoMode: server.gtAoMode, konstanta: server.konstanta, konstantaVersi: server.versi });
    await page.route("**/api/insentif-sales/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace("/api/insentif-sales/", "");
        if (req.method() !== "GET") tulis.push(req);
        if (p === "settings" && req.method() === "GET") {
            opsi.getSettings = (opsi.getSettings ?? 0) + 1;
            if (opsi.settingsGagal) return route.fulfill(json({ error: "Koneksi database terputus" }, 500));
            if (opsi.konstantaGagalBaca) return route.fulfill(json({ ...SETTINGS, konstanta: KONSTANTA, konstantaSumber: "gagal_baca", konstantaVersi: null }));
            return route.fulfill(setelan());
        }
        if (p === "settings" && req.method() === "PATCH") {
            const body = req.postDataJSON() as { konstanta?: typeof KONSTANTA; konstantaVersi?: string | null; gtAoMode?: string };
            if (opsi.adminLainSebelumPatch) { opsi.adminLainSebelumPatch = false; adminLain(); }
            if (body.konstanta && opsi.patchKonstanta === "putus") { opsi.patchKonstanta = undefined; adminLain(); return route.abort("failed"); }
            if (body.konstanta && body.konstantaVersi !== server.versi) {
                return route.fulfill(json({ error: "Konstanta sudah diubah admin lain sejak editor dimuat. Muat ulang, lalu ulangi perubahan.", code: "KONSTANTA_BERUBAH" }, 409));
            }
            if (body.gtAoMode) server.gtAoMode = body.gtAoMode;
            if (body.konstanta) { server.konstanta = body.konstanta; server.versi = new Date(Date.parse(VERSI_BARU) + 60_000 * simpanKe++).toISOString(); }
            return route.fulfill(setelan());
        }
        if (p === "targets" && req.method() === "GET") return route.fulfill(json({ rows: opsi.targets ?? [] }));
        if (p === "targets" && req.method() === "POST") {
            return opsi.tolakTarget ? route.fulfill(json({ error: opsi.tolakTarget }, 400)) : route.fulfill(json({ upserted: 2 }));
        }
        if (p === "progress" && req.method() === "GET") return route.fulfill(json({ rows: [{ salesCode: "MKS-07", realValue: 403_100_000, realEc: 1, realAo: 1, realIa: 1 }] }));
        if (p === "targets" && req.method() === "DELETE") return route.fulfill(json({ deleted: 1 }));
        if (p === "targets/template") return route.fulfill(json({ error: "Forbidden" }, 403));
        if (p === "progress" && req.method() === "POST") return route.fulfill(json({ inserted: 3, replaced: 2, skipped: 0 }));
        if (p === "progress" && req.method() === "DELETE") {
            const tolak = opsi.tolakHapus;
            opsi.tolakHapus = undefined; // sekali saja: percobaan berikutnya lolos
            return tolak ? route.fulfill(json({ error: tolak }, 400)) : route.fulfill(json({ deleted: 12, month: 9, year: 2026 }));
        }
        if (p === "code-merge" && req.method() === "POST") return route.fulfill(json({ saved: 1 }));
        if (p === "spv-mismatch" && req.method() === "POST") return route.fulfill(json({ synced: 1, spvName: "MARTEN" }));
        if (p === "code-merge") return route.fulfill(json({ groups: [{ prefix: "MKS-0", members: [{ salesCode: "MKS-07", salesName: "Andi Pratama" }, { salesCode: "ANDI P", salesName: "FS1_ANDI PRATAMA SAPUTRA MAKASSAR TIMUR GT" }] }] }));
        if (p === "spv-mismatch") return route.fulfill(json({ rows: [{ salesCode: "MKS-04", salesName: "Sinta Dewi", principle: "KINO NON FOOD", spvTarget: "ANI", spvClosing: ["MARTEN"] }] }));
        if (p === "unmatched") return route.fulfill(json({ rows: [] }));
        if (p === "hierarchy/my-identity") return route.fulfill(json({ identity: null, isAdmin: true }));
        if (p === "hierarchy/sm-spv") return route.fulfill(json({ rows: [{ id: "s1", spvName: "ANI", smName: "HENDRIK" }, { id: "s2", spvName: "MARTEN", smName: "HENDRIK" }] }));
        if (p === "hierarchy/spv-sales") return route.fulfill(json({ rows: [{ id: "a1", salesCode: "MKS-04", spvName: "ANI" }] }));
        if (p === "hierarchy/spv-sales/requests") return route.fulfill(json({ rows: [{ id: "r1", salesCode: "MKS-04", requestedBySpvName: "MARTEN", previousSpvName: "ANI" }] }));
        if (p === "hierarchy/user-identity" && req.method() === "GET") return route.fulfill(json({ users: USERS }));
        if (p === "hierarchy/user-identity" && req.method() === "POST") return route.fulfill(json({ ok: true }));
        return route.fulfill(json({ error: `mock tidak ada: ${req.method()} ${p}` }, 404));
    });
    return tulis;
}

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
const berkas = (name: string, isi: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(isi, "utf8") });
/** XLSX sungguhan: sel teks "1.234.567,89" tetap teks (CSV bisa ditebak lain oleh pembaca). */
function xlsx(name: string, aoa: unknown[][]) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Laporan");
    return { name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer };
}

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Data periode: Kosong di langkah 1, lalu Draf dengan panduan 14 kolom sesuai parser", async ({ page }) => {
    await mockApi(page, { targets: [] });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/data-periode?month=10&year=2026", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Data periode" })).toBeVisible(NAV);
    await expect(main.getByText("Target Oktober 2026 belum diunggah.")).toBeVisible();
    await expect(main.getByRole("list", { name: "Langkah unggah data" }).locator('[aria-current="step"]')).toContainText("Jenis & periode");
    const lanjut = main.getByRole("button", { name: "Lanjut" });
    await expect(lanjut).toBeDisabled();
    await expect(main.locator(".fi-ftb")).toContainText("Pilih jenis data");
    // Satu periode dari URL: tidak ada pemilih Bulan/Tahun sendiri.
    await expect(main.getByRole("combobox", { name: /Bulan|Tahun/ })).toHaveCount(0);
    await expect(main.locator(".fi-fbar").getByLabel("Periode").first()).toHaveValue("2026-10");

    await main.getByRole("group", { name: "Jenis data" }).getByRole("button", { name: "Target bulanan" }).click();
    for (const kolom of ["Kode Salesman", "Channel", "SPLM Value", "Tipe Sales", "Status Insentif"]) {
        await expect(main.locator("#unggah .fi-kv dt", { hasText: kolom }).first()).toBeVisible();
    }
    await expect(main.locator("#unggah .fi-kv dt")).toHaveCount(14);
    await expect(main.getByText("GT, TT, atau MT; kosong = TT")).toBeVisible();
    await expect(main.getByText(/NESTLE|UNILEVER|Template downloaded/)).toHaveCount(0);
    // Unduh templat gagal (mock 403) → pesan di halaman, bukan halaman galat yang tersimpan sebagai .xlsx.
    await main.getByRole("button", { name: "Unduh templat" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Templat gagal diunduh." })).toContainText("Forbidden");
    await expect(lanjut).toBeDisabled();
    await expect(main.locator(".fi-ftb")).toContainText("Pilih berkas dulu");
    await page.screenshot({ path: "test-results/data/data-draf.png", fullPage: true });
});

test("Data periode: pratinjau progres sebelum menulis, Terapkan lewat dialog, payload diringkas per hari", async ({ page }) => {
    const tulis = await mockApi(page, { targets: [TARGET("MKS-07", "Andi Pratama", "KINO NON FOOD", 412_000_000)] });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/data-periode?month=9&year=2026", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Progres harian" }).click({ timeout: 60_000 });
    // 46270/46271 = serial Excel 05/09 dan 06/09/2026. Baris 1: DPP teks format Indonesia. Baris 3 tanpa cabang → diturunkan dari
    // principal. Baris 4 tanpa kode → dilewati. Baris 5: cabang VINDA ada di setelan NILAI_JUAL → Value = NILAI_JUAL, bukan DPP.
    await main.locator('input[type="file"]').setInputFiles(xlsx("Laporan_Sep.xlsx", [
        ["KODE_SALESMAN", "SALESMAN", "PRINCIPAL", "JENISPRODUK", "TANGGAL", "DPP", "NILAI_JUAL", "EC", "AO", "IA", "NO_NOTA", "GOLONGAN"],
        ["MKS-07", "Andi Pratama", "KINO NON FOOD", "KINO NON FOOD", 46270, "1.234.567,89", 1300000, 1, 1, 2, "INV-1", "ANI"],
        ["MKS-07", "Andi Pratama", "KINO NON FOOD", "KINO NON FOOD", 46270, 500000, 550000, 0, 1, 1, "INV-2", "ANI"],
        ["MKS-07", "Andi Pratama", "KINO NON FOOD", "", 46271, -200000, -220000, 0, 0, 0, "RJ-1", "ANI"],
        ["", "", "KINO NON FOOD", "KINO NON FOOD", 46271, 300000, 300000, 1, 1, 1, "INV-3", ""],
        ["MKS-09", "Yusuf Amir", "VINDA", "VINDA", 46271, 800000, 880000, 1, 1, 1, "VD-1", "MARTEN"],
    ]));
    await expect(page.locator(".fi-draft")).toContainText("Draf belum diterapkan");
    await main.getByRole("button", { name: "Lanjut" }).click();

    await expect(main.getByRole("list", { name: "Langkah unggah data" }).locator('[aria-current="step"]')).toContainText("Pratinjau");
    await expect(main.locator(".fi-kc", { hasText: "Baris berkas" }).locator("b")).toHaveText("5");
    await expect(main.locator(".fi-kc", { hasText: "Diringkas" }).locator("b")).toHaveText("3");
    await expect(main.locator(".fi-kc", { hasText: "Dilewati" })).toContainText("Rp 300.000");
    const tabel = main.getByRole("table", { name: /Pratinjau progres September 2026/ });
    await expect(tabel.locator("tbody tr")).toHaveCount(2);
    await expect(tabel).toContainText("Rp 1.534.568");
    await expect(tabel).toContainText("Rp 880.000");
    await expect(main.getByRole("table", { name: "Kode sales mirip" })).toContainText("ANDI P");
    await expect(main.getByRole("table", { name: "SPV tidak sinkron" })).toContainText("Sinta Dewi");
    expect(tulis).toHaveLength(0); // pratinjau tidak menulis apa pun

    await main.getByRole("button", { name: "Terapkan progres…" }).click();
    const dialog = page.getByRole("dialog", { name: "Terapkan progres September 2026?" });
    await expect(dialog).toContainText("3 baris harian");
    await dialog.getByRole("button", { name: "Terapkan" }).click();
    await expect(main.getByText("Progres September 2026 diterapkan.")).toBeVisible();
    await expect(dialog).toBeHidden();

    const post = tulis.find((r) => r.method() === "POST" && r.url().endsWith("/api/insentif-sales/progress"));
    expect(post).toBeTruthy();
    const body = post!.postDataJSON() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(3);
    expect(body[0]).toMatchObject({ salesCode: "MKS-07", salesName: "Andi Pratama", principle: "KINO NON FOOD", branch: "KINO NON FOOD", date: "2026-09-05", periodMonth: 9, periodYear: 2026, achievedEc: 1, achievedAo: 2, achievedIa: 3, invoiceNumber: "INV-1", spvName: "ANI" });
    expect(body[0].achievedValueDpp).toBeCloseTo(1_734_567.89, 2); // "1.234.567,89" + 500.000 (DPP: cabang bukan NILAI_JUAL)
    expect(body[1]).toMatchObject({ branch: "KINO NON FOOD", date: "2026-09-06", achievedValueDpp: -200_000, invoiceNumber: "RJ-1" });
    expect(body[2]).toMatchObject({ salesCode: "MKS-09", branch: "VINDA", date: "2026-09-06", achievedValueDpp: 880_000, spvName: "MARTEN" });
    await page.screenshot({ path: "test-results/data/data-sukses.png", fullPage: true });
});

test("Data periode: Galat — server menolak target, tidak ada yang ditulis dan Terapkan terkunci", async ({ page }) => {
    const tulis = await mockApi(page, {
        targets: [TARGET("MKS-07", "Andi Pratama", "KINO NON FOOD", 400_000_000), TARGET("MKS-09", "Yusuf Amir", "VINDA", 100_000_000)],
        tolakTarget: 'Baris GWA-02: Channel tidak dikenal: "GX". Pakai GT, TT, atau MT.',
    });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/data-periode?month=10&year=2026", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Target bulanan" }).click({ timeout: 60_000 });
    await main.locator('input[type="file"]').setInputFiles(berkas("Target_Okt.csv", [
        "Kode Salesman,Nama Salesman,Principal,Cabang,Channel,SPV,SM,Target Value (Rp),Target EC,Target AO,Target IA,SPLM Value,Tipe Sales,Status Insentif",
        "MKS-07,Andi Pratama,KINO NON FOOD,KINO NON FOOD,GT,ANI,HENDRIK,412000000,300,240,500,0,Exclusive,Distributor+Principle",
        "GWA-02,Rudi Hartono,GODREJ,GODREJ,GX,MARTEN,HENDRIK,250000000,200,240,400,0,Exclusive,Distributor",
    ].join("\n")));
    await main.getByRole("button", { name: "Lanjut" }).click();
    await expect(main.locator(".fi-kc", { hasText: "Baru" }).locator("b")).toHaveText("1");
    await expect(main.locator(".fi-kc", { hasText: "Mengganti" }).locator("b")).toHaveText("1");
    await expect(main.getByText("1 baris target tersimpan tidak ada di berkas.")).toBeVisible(); // MKS-09 VINDA tetap, tidak dihapus

    await main.getByRole("button", { name: "Terapkan target…" }).click();
    const dialog = page.getByRole("dialog", { name: "Terapkan target Oktober 2026?" });
    await dialog.getByRole("button", { name: "Terapkan" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Tidak ada baris yang ditulis.");
    await dialog.getByRole("button", { name: "Batal" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Impor ditolak; tidak ada baris yang ditulis." })).toContainText("GX");
    await expect(main.getByRole("button", { name: "Terapkan target…" })).toBeDisabled();
    await expect(main.getByText("Target Oktober 2026 diterapkan.")).toHaveCount(0);

    expect(tulis.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual(["POST /api/insentif-sales/targets"]);
    const body = tulis[0].postDataJSON() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[1]).toMatchObject({ salesCode: "GWA-02", channel: "GX", periodMonth: 10, periodYear: 2026, tipeSales: "Exclusive", statusInsentif: "Distributor" });
    await page.screenshot({ path: "test-results/data/data-galat.png", fullPage: true });
});

test("Data periode (d): satu sel angka target tidak valid → seluruh impor batal di pratinjau, tidak ada POST targets", async ({ page }) => {
    const tulis = await mockApi(page, { targets: [] });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/data-periode?month=10&year=2026", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Target bulanan" }).click({ timeout: 60_000 });
    await expect(main.getByText(/teks yang bukan angka.*membatalkan seluruh impor/)).toBeVisible();
    // AM-017: sel terisi tapi bukan angka ("-" sebagai nol, "Rp 500.000,-") dulu terbaca 0 → target 0 → nominal salah.
    await main.locator('input[type="file"]').setInputFiles(xlsx("Target_Okt.xlsx", [
        ["Kode Salesman", "Nama Salesman", "Principal", "Cabang", "Channel", "SPV", "SM", "Target Value (Rp)", "Target EC", "Target AO", "Target IA", "SPLM Value", "Tipe Sales", "Status Insentif"],
        ["S-A", "SALES A", "PRINCIPLE A", "CABANG A", "GT", "SPV A", "SM A", 412000000, 300, 240, 500, "", "Exclusive", "Distributor"],
        ["S-B", "SALES B", "PRINCIPLE B", "CABANG A", "GT", "SPV A", "SM A", 250000000, "-", 240, 400, "", "Exclusive", "Distributor"],
    ]));
    await main.getByRole("button", { name: "Lanjut" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Berkas tidak bisa diterapkan." })).toContainText("1 baris berisi angka target tidak valid (mis. S-B)");
    await expect(main.getByRole("button", { name: "Terapkan target…" })).toBeDisabled();
    await page.screenshot({ path: "test-results/data/data-target-invalid.png", fullPage: true });
    expect(tulis).toHaveLength(0);
});

test("Data periode (d): angka progres terisi tapi tidak valid → seluruh impor batal; kosong tetap 0", async ({ page }) => {
    const tulis = await mockApi(page, { targets: [TARGET("S-A", "SALES A", "PRINCIPLE A", 100_000_000)] });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/data-periode?month=9&year=2026", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Progres harian" }).click({ timeout: 60_000 });
    await main.locator('input[type="file"]').setInputFiles(xlsx("Laporan_Sep.xlsx", [
        ["KODE_SALESMAN", "SALESMAN", "PRINCIPAL", "JENISPRODUK", "TANGGAL", "DPP", "NILAI_JUAL", "EC", "AO", "IA"],
        ["S-A", "SALES A", "PRINCIPLE A", "CABANG A", 46270, 500000, 550000, "", 1, 1],
        ["S-A", "SALES A", "PRINCIPLE A", "CABANG A", 46271, "-", 0, 0, 0, 0],
        ["S-B", "SALES B", "PRINCIPLE A", "CABANG A", 46271, 300000, 300000, "N/A", 1, 1],
    ]));
    await main.getByRole("button", { name: "Lanjut" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Berkas tidak bisa diterapkan." })).toContainText("2 baris berisi angka tidak valid (mis. S-A, S-B)");
    await expect(main.getByRole("button", { name: "Terapkan progres…" })).toBeDisabled();
    expect(tulis).toHaveLength(0);
});

test("Data periode: gabung kode, pakai SPV, hapus target, hapus realisasi — semua lewat dialog, payload/query diperiksa", async ({ page }) => {
    const tulis = await mockApi(page, { targets: [TARGET("MKS-07", "Andi Pratama", "KINO NON FOOD", 412_000_000)] });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/data-periode?month=9&year=2026", NAV);
    const main = page.locator("main");
    const tersimpan = main.getByRole("table", { name: "Target tersimpan September 2026" });
    for (const h of ["SPV / SM", "Tipe", "Status insentif", "EC · AO · IA"]) await expect(tersimpan.getByRole("columnheader", { name: h, exact: true })).toBeAttached(NAV);
    await expect(tersimpan.getByRole("button", { name: /Ubah/ })).toHaveCount(0); // tanpa input manual (owner 8 Okt)
    const terakhir = () => tulis[tulis.length - 1];

    const merge = main.getByRole("table", { name: "Kode sales mirip" });
    await merge.getByRole("combobox", { name: "Kode tujuan MKS-0" }).selectOption("MKS-07");
    await merge.getByRole("button", { name: "Gabungkan…" }).click();
    await page.getByRole("dialog", { name: "Gabungkan kelompok MKS-0 ke MKS-07?" }).getByRole("button", { name: "Gabungkan" }).click();
    await expect(main.getByText("MKS-0: 1 keputusan tersimpan untuk September 2026.")).toBeVisible();
    expect(terakhir().postDataJSON()).toEqual([{ fromSalesCode: "ANDI P", toSalesCode: "MKS-07", decision: "merge", prefix: "MKS-0", periodMonth: 9, periodYear: 2026 }]);

    await main.getByRole("table", { name: "SPV tidak sinkron" }).getByRole("button", { name: "Pakai MARTEN (laporan)…" }).click();
    await page.getByRole("dialog", { name: "Pakai SPV MARTEN untuk Sinta Dewi · KINO NON FOOD?" }).getByRole("button", { name: "Pakai MARTEN" }).click();
    await expect(main.getByText("MKS-04 / KINO NON FOOD → SPV MARTEN.")).toBeVisible();
    expect(new URL(terakhir().url()).pathname).toBe("/api/insentif-sales/spv-mismatch");
    expect(terakhir().postDataJSON()).toEqual({ salesCode: "MKS-04", principle: "KINO NON FOOD", periodMonth: 9, periodYear: 2026, spvName: "MARTEN" });

    await tersimpan.getByRole("button", { name: "Hapus…" }).click();
    await page.getByRole("dialog", { name: "Hapus target MKS-07 / KINO NON FOOD?" }).getByRole("button", { name: "Hapus baris target" }).click();
    await expect(main.getByText("Baris target MKS-07/KINO NON FOOD September 2026 dihapus.")).toBeVisible();
    const del = new URL(terakhir().url());
    expect([terakhir().method(), del.pathname, Object.fromEntries(del.searchParams)]).toEqual(["DELETE", "/api/insentif-sales/targets", { salesCode: "MKS-07", principle: "KINO NON FOOD", month: "9", year: "2026" }]);

    await main.getByRole("button", { name: "Hapus realisasi September 2026…" }).click();
    const hapus = page.getByRole("dialog", { name: "Hapus realisasi September 2026?" });
    await hapus.getByLabel("Alasan hapus realisasi").fill("Closing diunggah ulang");
    await hapus.getByRole("button", { name: "Hapus realisasi" }).click();
    await expect(main.getByText("12 baris realisasi September 2026 dihapus.")).toBeVisible();
    expect([terakhir().method(), new URL(terakhir().url()).pathname + new URL(terakhir().url()).search]).toEqual(["DELETE", "/api/insentif-sales/progress?month=9&year=2026"]);
    expect(terakhir().postDataJSON()).toEqual({ alasan: "Closing diunggah ulang" });
    expect(tulis).toHaveLength(4);
});

test("Hapus realisasi (owner 8 Okt): alasan wajib ≥ 5 karakter, DELETE membawa alasan; galat server tampil di dialog tanpa menghapus alasan", async ({ page }) => {
    const opsi: Opsi = { targets: [TARGET("S-A", "SALES A", "PRINCIPLE A", 100_000_000)], tolakHapus: "Alasan hapus realisasi wajib diisi (minimal 5 karakter)." };
    const tulis = await mockApi(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/data-periode?month=9&year=2026", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Hapus realisasi September 2026…" }).click(NAV);
    const dlg = page.getByRole("dialog", { name: "Hapus realisasi September 2026?" });
    const tombol = dlg.getByRole("button", { name: "Hapus realisasi" });
    const alasan = dlg.getByLabel("Alasan hapus realisasi");
    await expect(dlg).toContainText("Alasan, nama Anda, dan jumlah baris tercatat");
    await expect(tombol).toBeDisabled();
    await alasan.fill("  abc  "); // 3 karakter setelah dipangkas = ditolak server → tombol tetap nonaktif
    await expect(tombol).toBeDisabled();
    await expect(tombol).toHaveAttribute("title", "Alasan hapus realisasi minimal 5 karakter");
    await alasan.fill("  Closing diunggah dengan aturan lama  ");
    await tombol.click();
    await expect(dlg.getByRole("alert")).toContainText("Alasan hapus realisasi wajib diisi (minimal 5 karakter).");
    await expect(alasan).toHaveValue("  Closing diunggah dengan aturan lama  ");
    await page.screenshot({ path: "test-results/data/hapus-realisasi-alasan.png" });
    await tombol.click();
    await expect(dlg).toBeHidden();
    await expect(main.getByText("12 baris realisasi September 2026 dihapus.")).toBeVisible();
    const del = tulis.filter((r) => r.method() === "DELETE");
    expect(del.map((r) => [new URL(r.url()).pathname + new URL(r.url()).search, r.postDataJSON()])).toEqual([
        ["/api/insentif-sales/progress?month=9&year=2026", { alasan: "Closing diunggah dengan aturan lama" }],
        ["/api/insentif-sales/progress?month=9&year=2026", { alasan: "Closing diunggah dengan aturan lama" }],
    ]);
});

test("Data periode di ponsel 390 px: tanpa gulir menyamping", async ({ page }) => {
    await mockApi(page, { targets: [TARGET("MKS-07", "Andi Pratama", "KINO NON FOOD", 412_000_000)] });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/insentif-sales/data-periode?month=9&year=2026", NAV);
    const main = page.locator("main");
    await main.getByRole("button", { name: "Target bulanan" }).click({ timeout: 60_000 });
    await expect(main.locator("#unggah .fi-kv dt")).toHaveCount(14);
    await expect(main.getByRole("list", { name: "Target tersimpan September 2026" })).toContainText("Andi Pratama");
    // Pilihan "Gabung ke…" di bagian Kode sales mirip tidak melebar melewati layar.
    const pilih = main.getByRole("list", { name: "Kode sales mirip" }).getByRole("combobox", { name: "Kode tujuan MKS-0" });
    await expect(pilih).toBeVisible();
    const kotak = await pilih.boundingBox();
    expect(kotak!.x + kotak!.width).toBeLessThanOrEqual(390);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/data/data-ponsel.png", fullPage: true });
});

test("Pengaturan: Default — anchor bar, konstanta, hierarki, akun belum ditautkan", async ({ page }) => {
    await mockApi(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pengaturan", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeVisible(NAV);
    const anchors = main.getByRole("navigation", { name: "Bagian halaman" });
    for (const a of ["Konstanta", "Penyebut AO", "Cabang NILAI_JUAL", "SM dalam skema", "Hierarki", "Akun belum ditautkan", "Riwayat"]) {
        await expect(anchors.getByRole("link", { name: a, exact: true })).toBeVisible();
    }
    await expect(main.getByRole("spinbutton", { name: "Pool 1 principle" })).toHaveValue("1000000");
    await expect(main.getByRole("group", { name: "Penyebut AO GT/TT" }).getByRole("button", { name: "240 (tetap)" })).toHaveAttribute("aria-pressed", "true");
    await expect(main.getByRole("textbox", { name: "Cabang beracuan NILAI_JUAL" })).toHaveValue("VINDA\nABC");
    await expect(main.getByRole("table", { name: "Klaim salesman tertunda" })).toContainText("MARTEN");
    await expect(main.getByRole("table", { name: "Akun belum ditautkan" }).locator("tbody tr")).toHaveCount(2);
    await expect(main.getByRole("table", { name: "Akun tertaut" })).toContainText("MKS-07");
    await expect(main.getByRole("button", { name: "Simpan", exact: true })).toBeDisabled();
    await expect(main.locator(".fi-ftb")).toContainText("Belum ada perubahan konstanta");
    // AM-045 sudah ada: versi = waktu simpan terakhir (WITA), bukan catatan usulan lagi. BL-33 (riwayat) tetap usulan.
    await expect(main.locator(".fi-attrs")).toContainText("tersimpan 2 Sep 14.05 WITA");
    await expect(main.getByRole("complementary", { name: "Usulan AM-045" })).toHaveCount(0);
    await expect(main.getByRole("complementary", { name: "Usulan BL-33" })).toBeVisible();
    await page.screenshot({ path: "test-results/data/atur-default.png", fullPage: true });
});

test("Pengaturan: GET settings gagal → editor konstanta dikunci, hierarki tetap bisa dipakai", async ({ page }) => {
    const tulis = await mockApi(page, { settingsGagal: true });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pengaturan", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("alert").filter({ hasText: "editor dikunci" }).first()).toBeVisible(NAV);
    await expect(main.getByRole("spinbutton", { name: "Pool 1 principle" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Isi dengan bawaan" })).toBeDisabled();
    await expect(main.getByRole("textbox", { name: "Cabang beracuan NILAI_JUAL" })).toBeDisabled();
    await expect(main.getByRole("button", { name: "Simpan", exact: true })).toBeDisabled();
    await expect(main.locator(".fi-ftb")).toContainText("Editor konstanta terkunci");
    await expect(main.getByRole("table", { name: "Hierarki SPV → SM" })).toContainText("MARTEN");
    expect(tulis).toHaveLength(0);
});

test("Pengaturan (a): GET 200 dengan konstanta gagal_baca → editor dikunci, angka bawaan tidak tampil sebagai tersimpan, tidak ada PATCH", async ({ page }) => {
    const tulis = await mockApi(page, { konstantaGagalBaca: true });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pengaturan", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("alert").filter({ hasText: "Konstanta tersimpan gagal dibaca — editor dikunci" }).first()).toBeVisible(NAV);
    await expect(main.getByRole("spinbutton", { name: "Pool 1 principle" })).toHaveCount(0);
    await expect(main.locator("#konstanta").getByRole("button", { name: "Coba lagi" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Isi dengan bawaan" })).toBeDisabled();
    await expect(main.getByRole("button", { name: "Isi dengan bawaan" })).toHaveAttribute("title", /gagal dibaca/);
    await expect(main.getByRole("button", { name: "Simpan", exact: true })).toBeDisabled();
    await expect(main.locator(".fi-ftb")).toContainText("Editor konstanta terkunci");
    await expect(main.locator(".fi-attrs")).toContainText("gagal dibaca");
    // Penyebut AO tidak memakai angka bawaan sebagai label; bagian lain tetap bisa dipakai.
    await expect(main.getByRole("group", { name: "Penyebut AO GT/TT" }).getByRole("button", { name: "240 (tetap)" })).toHaveCount(0);
    await expect(main.getByRole("textbox", { name: "Cabang beracuan NILAI_JUAL" })).toBeEnabled();
    await expect(main.getByRole("table", { name: "Hierarki SPV → SM" })).toContainText("MARTEN");
    await page.screenshot({ path: "test-results/data/atur-gagal-baca.png", fullPage: true });
    expect(tulis).toHaveLength(0);
});

test("Pengaturan (b): PATCH 409 → dialog konflik, draf basi tidak terkirim lagi, muat ulang menampilkan angka admin lain", async ({ page }) => {
    const opsi: Opsi = { adminLainSebelumPatch: true };
    const tulis = await mockApi(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pengaturan", NAV);
    const main = page.locator("main");
    await main.getByRole("spinbutton", { name: "Pool 1 principle" }).fill("1100000", NAV);
    await main.getByRole("button", { name: "Simpan 1 perubahan…" }).click();
    await page.getByRole("dialog", { name: "Simpan 1 perubahan konstanta?" }).getByRole("button", { name: "Simpan", exact: true }).click();

    const konflik = page.getByRole("dialog", { name: "Konstanta sudah diubah admin lain" });
    await expect(konflik).toContainText("sejak editor dimuat");
    await expect(konflik).toContainText("1 angka, belum disimpan");
    await page.screenshot({ path: "test-results/data/atur-konflik.png" });
    await konflik.locator("footer").getByRole("button", { name: "Tutup" }).click();
    // Draf basi masih terlihat tetapi Simpan terkunci sampai dimuat ulang.
    await expect(main.getByRole("button", { name: "Simpan 1 perubahan…" })).toBeDisabled();
    await expect(main.locator(".fi-ftb")).toContainText("Konstanta sudah diubah admin lain");
    const getSebelum = opsi.getSettings ?? 0;
    await main.getByRole("status").filter({ hasText: "Konstanta sudah diubah admin lain" }).getByRole("button", { name: "Muat ulang" }).click();
    await expect(main.getByRole("spinbutton", { name: "Pool 1 principle" })).toHaveValue("1250000");
    expect(opsi.getSettings).toBeGreaterThan(getSebelum);
    await expect(page.locator(".fi-draft")).toHaveCount(0);
    await expect(main.locator(".fi-attrs")).toContainText("tersimpan 9 Okt 10.20 WITA");
    expect(tulis.filter((r) => r.method() === "PATCH")).toHaveLength(1);
});

test("Pengaturan (skenario 1): draf dari versi lama tetap membawa versi DASAR walau PATCH lain memberi versi baru → 409, angka admin lain utuh", async ({ page }) => {
    const opsi: Opsi = {};
    const tulis = await mockApi(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pengaturan", NAV);
    const main = page.locator("main");
    await main.getByRole("spinbutton", { name: "Pool 1 principle" }).fill("1100000", NAV); // draf dari versi 02/09
    // Admin lain menyimpan mix2; lalu admin ini mengganti penyebut AO — jawabannya membawa versi & angka admin lain.
    opsi.adminLainSebelumPatch = true;
    await main.getByRole("group", { name: "Penyebut AO GT/TT" }).getByRole("button", { name: "Target AO dari berkas" }).click();
    await page.getByRole("dialog", { name: /Ubah penyebut AO GT\/TT ke Target AO/ }).getByRole("button", { name: "Ubah penyebut AO" }).click();
    await expect(main.locator(".fi-attrs")).toContainText("tersimpan 9 Okt 10.20 WITA");
    await main.locator(".fi-ftb").getByRole("button", { name: /^Simpan \d+ perubahan…$/ }).click();
    await page.getByRole("dialog", { name: /^Simpan \d+ perubahan konstanta\?$/ }).getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Konstanta sudah diubah admin lain" })).toBeVisible();
    const patchKonst = tulis.filter((r) => r.method() === "PATCH" && "konstanta" in (r.postDataJSON() as object));
    expect(patchKonst).toHaveLength(1);
    expect((patchKonst[0].postDataJSON() as { konstantaVersi: unknown }).konstantaVersi).toBe(VERSI);
    expect(opsi.server!.konstanta.gt.mix2).toBe(1_100_000); // perubahan admin lain tidak dikembalikan
});

test("Pengaturan (skenario 2): PATCH konstanta tanpa jawaban → hasilnya belum pasti, dimuat ulang; simpan ulang draf membawa versi dasar → konflik", async ({ page }) => {
    const opsi: Opsi = { patchKonstanta: "putus" };
    const tulis = await mockApi(page, opsi);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pengaturan", NAV);
    const main = page.locator("main");
    await main.getByRole("spinbutton", { name: "Pool 1 principle" }).fill("1100000", NAV);
    await main.getByRole("button", { name: "Simpan 1 perubahan…" }).click();
    // Judul dialog ikut berubah setelah muat ulang (angka admin lain menambah selisih), jadi dicari dengan pola.
    const simpan = page.getByRole("dialog", { name: /^Simpan \d+ perubahan konstanta\?$/ });
    await simpan.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(simpan.getByRole("alert")).toContainText("Hasilnya belum pasti");
    await expect(simpan.getByRole("alert")).not.toContainText("Failed to fetch");
    await expect.poll(() => opsi.getSettings ?? 0).toBeGreaterThan(1);
    await simpan.getByRole("button", { name: "Batal" }).click();
    // Setelah dimuat ulang: draf tetap terlihat untuk diperiksa, tetapi dasarnya tetap versi lama — bukan versi hasil muat ulang.
    await expect(main.getByRole("spinbutton", { name: "Pool 1 principle" })).toHaveValue("1100000");
    await expect(main.locator(".fi-attrs")).toContainText("tersimpan 9 Okt 10.20 WITA");
    expect(tulis.filter((r) => r.method() === "PATCH")).toHaveLength(1);
    await main.locator(".fi-ftb").getByRole("button", { name: /^Simpan \d+ perubahan…$/ }).click();
    await page.getByRole("dialog", { name: /^Simpan \d+ perubahan konstanta\?$/ }).getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Konstanta sudah diubah admin lain" })).toBeVisible();
    const patch = tulis.filter((r) => r.method() === "PATCH");
    expect(patch).toHaveLength(2);
    expect((patch[1].postDataJSON() as { konstantaVersi: unknown }).konstantaVersi).toBe(VERSI);
    expect(opsi.server!.konstanta.gt.mix2).toBe(1_100_000);
});

test("Pengaturan: simpan konstanta lewat dialog (payload diperiksa) dan tautkan akun lewat dialog", async ({ page }) => {
    const tulis = await mockApi(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/insentif-sales/pengaturan", NAV);
    const main = page.locator("main");
    const pool = main.getByRole("spinbutton", { name: "Pool 1 principle" });
    await pool.fill("1100000", NAV);
    await expect(page.locator(".fi-draft")).toContainText("Draf belum disimpan");
    await expect(main.locator(".fi-ftb")).toContainText("1 konstanta diubah, belum disimpan");
    await main.getByRole("button", { name: "Simpan 1 perubahan…" }).click();
    const simpan = page.getByRole("dialog", { name: "Simpan 1 perubahan konstanta?" });
    await expect(simpan).toContainText("Rp 1.000.000 → Rp 1.100.000");
    await simpan.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(main.getByText(/Konstanta tersimpan \(1 angka berubah\)/)).toBeVisible();
    await expect(page.locator(".fi-draft")).toHaveCount(0);
    const patch = tulis.find((r) => r.method() === "PATCH");
    // (c) AM-045: PATCH konstanta membawa versi yang dimuat GET; route menolak 400 tanpa versi.
    expect(patch!.postDataJSON()).toEqual({ konstanta: { ...KONSTANTA, gt: { ...KONSTANTA.gt, pool1: 1_100_000 } }, konstantaVersi: VERSI });
    // Versi berikutnya diambil dari jawaban PATCH, bukan versi lama (kalau tidak, simpan kedua selalu 409).
    await expect(main.locator(".fi-attrs")).toContainText("tersimpan 9 Okt 10.30 WITA");
    await main.getByRole("spinbutton", { name: "Pool 1 principle" }).fill("1200000");
    await main.getByRole("button", { name: "Simpan 1 perubahan…" }).click();
    await page.getByRole("dialog", { name: "Simpan 1 perubahan konstanta?" }).getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page.locator(".fi-draft")).toHaveCount(0);
    const patch2 = tulis.filter((r) => r.method() === "PATCH")[1];
    expect(patch2.postDataJSON()).toMatchObject({ konstantaVersi: VERSI_BARU });

    await main.getByRole("table", { name: "Akun belum ditautkan" }).getByRole("row", { name: /Bayu Saputra/ }).getByRole("button", { name: "Tautkan…" }).click();
    const tautkan = page.getByRole("dialog", { name: "Tautkan akun Bayu Saputra?" });
    await expect(tautkan.getByRole("button", { name: "Tautkan" })).toBeDisabled();
    await tautkan.getByLabel("Peran").selectOption("sales");
    await tautkan.getByLabel("Identitas").fill("MKS-12");
    await tautkan.getByRole("button", { name: "Tautkan" }).click();
    await expect(main.getByText(/Bayu Saputra ditautkan ke Sales MKS-12/)).toBeVisible();
    const post = tulis.find((r) => r.method() === "POST" && r.url().endsWith("/hierarchy/user-identity"));
    expect(post!.postDataJSON()).toEqual({ userId: "u1", hierarchyRole: "sales", hierarchyName: "MKS-12" });
});

test("Pengaturan di ponsel 390 px: tanpa gulir menyamping", async ({ page }) => {
    await mockApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/insentif-sales/pengaturan", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("spinbutton", { name: "Pool 1 principle" })).toBeVisible(NAV);
    await expect(main.getByRole("list", { name: "Akun belum ditautkan" })).toContainText("Bayu Saputra");
    await noOverflow(page);
    await page.screenshot({ path: "test-results/data/atur-ponsel.png", fullPage: true });
});
