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
const SETTINGS = { gtAoMode: "fixed240", branchNilaiJual: ["VINDA", "ABC"], smBerhak: ["HENDRIK"], konstanta: KONSTANTA, konstantaBawaan: KONSTANTA };
const USERS = [
    { id: "u1", name: "Bayu Saputra", email: "bayu@sp.test", hierarchyRole: null, hierarchyName: null },
    { id: "u2", name: "Lukman Hakim", email: "lukman@sp.test", hierarchyRole: null, hierarchyName: null },
    { id: "u3", name: "Andi Pratama", email: "andi@sp.test", hierarchyRole: "sales", hierarchyName: "MKS-07" },
];

type Opsi = { targets?: unknown[]; settingsGagal?: boolean; tolakTarget?: string };

/** Semua /api/insentif-sales/* dimock; permintaan tulis dicatat untuk diperiksa. */
async function mockApi(page: Page, opsi: Opsi = {}) {
    const tulis: Request[] = [];
    await page.route("**/api/insentif-sales/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace("/api/insentif-sales/", "");
        if (req.method() !== "GET") tulis.push(req);
        if (p === "targets" && req.method() === "GET") return route.fulfill(json({ rows: opsi.targets ?? [] }));
        if (p === "targets" && req.method() === "POST") {
            return opsi.tolakTarget ? route.fulfill(json({ error: opsi.tolakTarget }, 400)) : route.fulfill(json({ upserted: 2 }));
        }
        if (p === "progress" && req.method() === "GET") return route.fulfill(json({ rows: [{ salesCode: "MKS-07", realValue: 403_100_000, realEc: 1, realAo: 1, realIa: 1 }] }));
        if (p === "targets" && req.method() === "DELETE") return route.fulfill(json({ deleted: 1 }));
        if (p === "targets/template") return route.fulfill(json({ error: "Forbidden" }, 403));
        if (p === "progress" && req.method() === "POST") return route.fulfill(json({ inserted: 3, replaced: 2, skipped: 0 }));
        if (p === "progress" && req.method() === "DELETE") return route.fulfill(json({ deleted: 12, month: 9, year: 2026 }));
        if (p === "code-merge" && req.method() === "POST") return route.fulfill(json({ saved: 1 }));
        if (p === "spv-mismatch" && req.method() === "POST") return route.fulfill(json({ synced: 1, spvName: "MARTEN" }));
        if (p === "settings" && req.method() === "GET") return opsi.settingsGagal ? route.fulfill(json({ error: "Koneksi database terputus" }, 500)) : route.fulfill(json(SETTINGS));
        if (p === "settings" && req.method() === "PATCH") {
            const body = req.postDataJSON() as { konstanta?: unknown };
            return route.fulfill(json({ ...SETTINGS, konstanta: body.konstanta ?? KONSTANTA }));
        }
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
    await page.getByRole("dialog", { name: "Hapus realisasi September 2026?" }).getByRole("button", { name: "Hapus realisasi" }).click();
    await expect(main.getByText("12 baris realisasi September 2026 dihapus.")).toBeVisible();
    expect([terakhir().method(), new URL(terakhir().url()).pathname + new URL(terakhir().url()).search]).toEqual(["DELETE", "/api/insentif-sales/progress?month=9&year=2026"]);
    expect(tulis).toHaveLength(4);
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
    await expect(main.getByRole("complementary", { name: "Usulan AM-045" })).toBeVisible();
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
    expect(patch!.postDataJSON()).toEqual({ konstanta: { ...KONSTANTA, gt: { ...KONSTANTA.gt, pool1: 1_100_000 } } });

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
