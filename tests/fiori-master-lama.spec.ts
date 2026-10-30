/*
 * Tujuan: Enam halaman lama yang dimigrasi ke Fiori (audit desain 001, M3): Master Principal, Mapping Principal, Master Barang,
 *   Laporan klaim, Pengaturan Summary, Realisasi program. Tiap halaman diuji pada keadaan memuat, kosong, galat (bukan kosong),
 *   data, dan sukses aksi tulis lewat dialog, serta ponsel 360 px tanpa gulir menyamping dan tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin): `npx playwright test tests/fiori-master-lama.spec.ts`.
 * Dependensi: /api/* dan FastAPI (localhost:8000) di-mock dengan page.route (tidak menyentuh DB, Accurate, atau backend). Data contoh generik.
 * Side Effects: Tangkapan layar di test-results/fiori-master-lama-*.png.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const NAV = { timeout: 90_000 } as const;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const path = (p: string) => (url: URL) => url.pathname === p;
// FastAPI di localhost:8000 dijawab dari tiruan; CORS mengikuti origin peminta (port uji berbeda-beda).
const fastapi = (r: Route, body: unknown, status = 200) => {
    const cors = { "access-control-allow-origin": r.request().headers()["origin"] ?? "*", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS" };
    return r.request().method() === "OPTIONS" ? r.fulfill({ status: 204, headers: cors }) : r.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
};
async function tanpaGulirSamping(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
    await page.setViewportSize({ width: 1366, height: 900 });
});

// ------------------------------------------------------------------------------------------------------ Master Principal
const MASTER = {
    a: { name: "PRINCIPLE A", filename: "master-a.xlsx", uploaded_by: "admin@contoh.test", created_at: "2026-10-05" },
    b: { name: "PRINCIPLE B", filename: "master-b.xlsx", uploaded_by: "", created_at: "2026-09-20" },
};

test("Master Principal: memuat, kosong, galat bukan kosong, hapus dan unggah lewat dialog/strip, ponsel 360", async ({ page }) => {
    let mode: "data" | "kosong" | "galat" | "lambat" = "lambat";
    let lepas!: () => void; const tahan = new Promise<void>((ok) => { lepas = ok; });
    const hapus: string[] = []; const tambah: string[] = [];
    const isi: Record<string, typeof MASTER.a> = { ...MASTER };
    await page.route((u) => u.host === "localhost:8000", async (r) => {
        const p = new URL(r.request().url()).pathname;
        if (r.request().method() === "OPTIONS") return fastapi(r, {});
        if (p === "/api/principles" && r.request().method() === "GET") {
            if (mode === "lambat") await tahan;
            if (mode === "galat") return fastapi(r, { ok: false }, 500);
            return fastapi(r, { ok: true, principles: mode === "kosong" ? {} : isi });
        }
        if (p.endsWith("/delete")) { hapus.push(p); delete isi[p.split("/")[3]]; return fastapi(r, { ok: true }); }
        if (p === "/api/principles/add") { tambah.push(r.request().postData() ?? ""); return fastapi(r, { ok: true }); }
        return fastapi(r, { ok: true });
    });
    await page.goto("/principles", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Master Principal" })).toBeVisible(NAV);
    // Memuat terlihat sebagai memuat, bukan sebagai "belum ada master".
    await expect(main.getByRole("status").filter({ hasText: "Memuat data" })).toBeAttached();
    await expect(main.getByText("Belum ada master principal")).toHaveCount(0);
    mode = "data"; lepas();
    const tabel = main.getByRole("table", { name: "Master principal aktif" });
    await expect(tabel).toContainText("PRINCIPLE A", NAV);
    await expect(tabel).toContainText("05/10/2026");
    await expect(tabel).toContainText("Sistem"); // uploaded_by kosong
    await page.screenshot({ path: "test-results/fiori-master-lama-principles.png", fullPage: true });

    // Hapus lewat dialog, bukan window.confirm; batal tidak mengirim apa pun.
    await tabel.getByRole("button", { name: "Hapus master PRINCIPLE B" }).click();
    let dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Hapus master PRINCIPLE B?" })).toBeVisible();
    await expect(dlg).toContainText("master-b.xlsx");
    await dlg.getByRole("button", { name: "Batal" }).click();
    expect(hapus).toEqual([]);
    await tabel.getByRole("button", { name: "Hapus master PRINCIPLE B" }).click();
    dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Hapus master" }).click();
    await expect(dlg).toBeHidden();
    expect(hapus).toEqual(["/api/principles/b/delete"]);
    await expect(main.getByRole("status").filter({ hasText: "Master principal dihapus." })).toBeVisible();
    await expect(tabel).not.toContainText("PRINCIPLE B");

    // Unggah: kolom berlabel terikat, strip sukses.
    await main.getByLabel("Nama principal").fill("PRINCIPLE C");
    await main.getByLabel("Berkas Excel master").setInputFiles({ name: "master-c.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });
    await main.getByRole("button", { name: "Simpan master" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Master berhasil diunggah." })).toBeVisible();
    expect(tambah[0]).toContain("PRINCIPLE C");

    mode = "kosong"; await page.reload();
    await expect(main.getByRole("heading", { name: "Belum ada master principal" })).toBeVisible(NAV);
    await expect(main.getByRole("alert")).toHaveCount(0);

    mode = "galat"; await page.reload();
    await expect(main.getByRole("alert").filter({ hasText: "Server sedang bermasalah" })).toBeVisible(NAV);
    await expect(main.getByText("Belum ada master principal")).toHaveCount(0); // galat tidak tampil sebagai kosong
    mode = "data"; await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(tabel).toContainText("PRINCIPLE A", NAV);

    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await expect(main.getByRole("heading", { level: 1, name: "Master Principal" })).toBeVisible(NAV);
    await expect(main.getByRole("list", { name: "Master principal aktif" })).toContainText("PRINCIPLE A", NAV);
    await tanpaGulirSamping(page);
    await page.screenshot({ path: "test-results/fiori-master-lama-principles-360.png", fullPage: true });
});

// ------------------------------------------------------------------------------------------------------ Mapping Principal
const MAP_ROWS = [
    { principal: "KINO NON FOOD", kind: "item", sourceCode: "SRC-001", targetCode: "KODE-A", unit: "BTL", packSize: "36", note: "contoh", updatedBy: "admin@contoh.test", updatedAt: "2026-10-05T01:30:00Z" },
    { principal: "KINO NON FOOD", kind: "item", sourceCode: "SRC-002", targetCode: "KODE-B", unit: "PCS", packSize: "12", note: "", updatedBy: "", updatedAt: "" },
];

test("Mapping Principal: galat bukan kosong dan baris saringan lain tidak tersisa; tambah, hapus, dan Muat lewat dialog; ponsel 360", async ({ page }) => {
    let mode: "data" | "kosong" | "galat" | "lambat" = "lambat";
    let lepas!: () => void; const tahan = new Promise<void>((ok) => { lepas = ok; });
    const diminta: string[] = []; const tulis: Array<{ m: string; u: string; b: unknown }> = [];
    await page.route(path("/api/principal-mapping"), async (r) => {
        const req = r.request(); const u = new URL(req.url());
        if (req.method() === "GET") {
            diminta.push(u.search);
            if (u.searchParams.get("principal") === "PRINCIPLE B") return r.fulfill(json({ ok: false, error: "koneksi database putus" }, 500));
            if (mode === "lambat") await tahan;
            if (mode === "galat") return r.fulfill(json({ ok: false, error: "koneksi database putus" }, 500));
            return r.fulfill(json({ ok: true, principal: "KINO NON FOOD", rows: mode === "kosong" ? [] : MAP_ROWS, total: mode === "kosong" ? 0 : 2, limit: 50, offset: 0 }));
        }
        tulis.push({ m: req.method(), u: u.search, b: req.postDataJSON() });
        return r.fulfill(json({ ok: true }));
    });
    const impor: string[] = [];
    await page.route(path("/api/principal-mapping/import"), (r) => {
        const badan = r.request().postDataBuffer()?.toString("latin1") ?? ""; impor.push(badan);
        return r.fulfill(json({ ok: true, result: [{ kind: "item", label: "Barang", sheet: "Barang", count: 12, issues: ["Baris 3 tidak punya kode internal"] }] }));
    });
    await page.goto("/principal-mapping", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Mapping Principal" })).toBeVisible(NAV);
    await expect(main.getByRole("status").filter({ hasText: "Memuat data" })).toBeAttached();
    await expect(main.getByText("Belum ada mapping")).toHaveCount(0);
    mode = "data"; lepas();
    const tabel = main.getByRole("table", { name: "Mapping barang" });
    await expect(tabel).toContainText("SRC-001", NAV);
    await expect(tabel).toContainText("05/10/2026 09.30"); // WITA, bukan zona perangkat
    await expect(main.getByRole("group", { name: "Jenis mapping" }).getByRole("button", { name: "Barang" })).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: "test-results/fiori-master-lama-mapping.png", fullPage: true });

    // Tambah/ubah lewat dialog berlabel; badan PUT sama dengan sebelum migrasi.
    await main.getByRole("button", { name: "Tambah baris" }).click();
    let dlg = page.getByRole("dialog");
    await dlg.getByLabel("Kode principal").fill("SRC-009");
    await dlg.getByLabel("Kode internal").fill("KODE-Z");
    await dlg.getByLabel("Satuan").fill("btl");
    await dlg.getByLabel("ISI per karton").fill("24");
    await dlg.getByRole("button", { name: "Simpan mapping" }).click();
    await expect(dlg).toBeHidden();
    expect(tulis[0]).toMatchObject({ m: "PUT", b: { principal: "KINO NON FOOD", kind: "item", sourceCode: "SRC-009", targetCode: "KODE-Z", unit: "BTL", packSize: "24" } });
    await expect(main.getByRole("status").filter({ hasText: "Mapping SRC-009 tersimpan." })).toBeVisible();

    // Hapus lewat dialog, bukan window.confirm.
    await tabel.getByRole("button", { name: "Hapus mapping SRC-002" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Hapus mapping SRC-002?" })).toBeVisible();
    await dlg.getByRole("button", { name: "Hapus mapping" }).click();
    await expect(dlg).toBeHidden();
    expect(tulis[1].m).toBe("DELETE");
    expect(tulis[1].u).toContain("sourceCode=SRC-002");

    // Muat mengganti seluruh mapping jenis itu: pratinjau dulu, lalu dialog dengan jumlah dan akibat.
    await expect(main.getByRole("button", { name: "Muat…" })).toBeDisabled();
    await main.getByLabel("Berkas Excel (tiga sheet mapping)").setInputFiles({ name: "mapping.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });
    await main.getByRole("button", { name: "Pratinjau" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Memuat akan mengganti seluruh mapping" })).toContainText("12 baris siap dimuat");
    await main.getByRole("button", { name: "Muat…" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Muat mapping ke KINO NON FOOD?" })).toBeVisible();
    await expect(dlg).toContainText("12 baris");
    await dlg.getByRole("button", { name: "Muat mapping" }).click();
    await expect(dlg).toBeHidden();
    expect(impor[0]).toMatch(/name="apply"\r\n\r\nfalse/);
    expect(impor[1]).toMatch(/name="apply"\r\n\r\ntrue/);

    // Ganti principal ke yang gagal dimuat: baris principal sebelumnya tidak boleh tersisa di bawah saringan baru.
    await main.getByLabel("Principal", { exact: true }).fill("PRINCIPLE B");
    await expect(main.getByRole("alert").filter({ hasText: "koneksi database putus" })).toBeVisible(NAV);
    await expect(main.getByText("SRC-001")).toHaveCount(0);
    await expect(main.getByText("Belum ada mapping")).toHaveCount(0);
    // Ketikan dijeda: huruf demi huruf tidak jadi permintaan sendiri-sendiri.
    expect(diminta.some((q) => /principal=PRINCIPLE\+?%?2?0?$/.test(q.split("&")[0]) && !q.includes("PRINCIPLE%20B"))).toBe(false);

    mode = "kosong"; await main.getByLabel("Principal", { exact: true }).fill("KINO NON FOOD");
    await expect(main.getByRole("heading", { name: "Belum ada mapping" })).toBeVisible(NAV);
    mode = "galat"; await main.getByLabel("Cari").fill("zzz");
    await expect(main.getByRole("alert").filter({ hasText: "koneksi database putus" })).toBeVisible(NAV);
    await expect(main.getByText("Belum ada mapping")).toHaveCount(0);

    mode = "data"; await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await expect(main.getByRole("list", { name: "Mapping barang" })).toContainText("SRC-001", NAV);
    await tanpaGulirSamping(page);
    await page.screenshot({ path: "test-results/fiori-master-lama-mapping-360.png", fullPage: true });
});

// ------------------------------------------------------------------------------------------------------ Master Barang
const detailMaster = (over: Record<string, unknown> = {}) => ({
    id: "mb1", principleCode: "PA", principleName: "PRINCIPLE A", principleNameNorm: "PRINCIPLE A", status: "review", revision: 3, itemCount: 2, errors: 0, warnings: 1, over50: 1, updatedAt: "2026-10-05T01:30:00Z",
    revisionHash: "h", sourceItems: [{ sourcePage: 1, namaBarang: "PRODUK A 250ML", isiCtn: 24, gramasi: "250 ML", kemasan: "BTL", confidence: 0.92 }, { namaBarang: "PRODUK B", confidence: 1 }],
    codebook: [{ key: "k1", level: "KLP", scope: "", sourceName: "KELOMPOK A", name: "KELOMPOK A", code: "01", generated: true }],
    formRows: [{ no: 1, kodePcpl: "A-1", namaBarangPrinciple: "PRODUK A 250ML", isiCtn: 24, kodeBarangWin2: "PA0100000000001", len15: 15, namaWin: "PRODUK A 250ML NAMA PANJANG SEKALI MELEBIHI BATAS", len50: 58 }, { no: 2, kodePcpl: "A-2", namaBarangPrinciple: "PRODUK B", isiCtn: 12, kodeBarangWin2: "PA0100000000002", len15: 15, namaWin: "PRODUK B", len50: 8 }],
    qc: { errors: 0, warnings: 1, over50: 1, invalidCodeLength: 0, lowConfidence: 0, duplicateCodes: 0, gramasiNearDup: 0, issues: [{ severity: "warning", code: "LEN_LEBIH", row: 1, message: "Nama barang baris 1 lebih dari 55 karakter." }] },
    confirmationState: { len50: { count: 1, complete: false } },
    sources: [{ id: "s1", fileName: "sumber-a.pdf", mimeType: "application/pdf", fileSize: 20480, sha256: "x", sourceKind: "pdf", extraction: { engine: "adapter" }, createdAt: "2026-10-05T01:00:00Z" }], audits: [],
    ...over,
});
const LIST_MB = { id: "mb1", principleCode: "PA", principleName: "PRINCIPLE A", status: "review", revision: 3, itemCount: 2, errors: 0, warnings: 1, over50: 1, updatedAt: "2026-10-05T01:30:00Z" };

test("Master Barang: galat bukan kosong, kosong, memuat; Finalisasi, Kamus Kode, dan Adaptasi lewat dialog; QC bernada status; ponsel 360", async ({ page }) => {
    let mode: "data" | "kosong" | "galat" | "lambat" = "lambat";
    let lepas!: () => void; const tahan = new Promise<void>((ok) => { lepas = ok; });
    const kirim: Array<Record<string, unknown>> = [];
    await page.route(path("/api/master-barang"), async (r) => {
        const req = r.request(); const u = new URL(req.url());
        if (req.method() === "GET") {
            if (mode === "lambat") await tahan;
            if (mode === "galat") return r.fulfill(json({ ok: false, error: "koneksi database putus" }, 500));
            if (mode === "kosong") return r.fulfill(json({ ok: true, masters: [] }));
            return u.searchParams.get("id") ? r.fulfill(json({ ok: true, master: detailMaster() })) : r.fulfill(json({ ok: true, masters: [LIST_MB] }));
        }
        const badan = req.postDataJSON() as Record<string, unknown>; kirim.push(badan);
        if (badan.action === "adapt_legacy") return r.fulfill(json({ ok: true, report: { adapted: 2, unchanged: 5, failed: 0 } }));
        return r.fulfill(json({ ok: true, master: detailMaster({ status: "ready" }) }));
    });
    await page.goto("/master-barang", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Master Barang" })).toBeVisible(NAV);
    await expect(main.getByRole("status").filter({ hasText: "Memuat daftar master" })).toBeAttached();
    await expect(main.getByText("Belum ada master", { exact: true })).toHaveCount(0);
    mode = "data"; lepas();
    await expect(main.getByRole("heading", { level: 2, name: "PRINCIPLE A" })).toBeVisible(NAV);
    await expect(main.getByRole("list", { name: "Daftar master barang" })).toContainText("Perlu tinjau");
    // Form Fix: wadah gulir bisa difokus dan berlabel; sel yang melewati batas ditandai teks, bukan warna saja.
    const wadah = main.locator(".fi-tablescroll").first();
    await expect(wadah).toHaveAttribute("tabindex", "0");
    await expect(wadah).toContainText("melebihi 55 karakter");
    // Unggah sumber: input berkas bisa dijangkau kibor dan labelnya bercincin fokus (bukan hidden / tanpa gaya fokus).
    const unggah = main.getByLabel("Unggah sumber");
    await unggah.focus();
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    expect(await unggah.evaluate((el) => getComputedStyle(el.closest("label")!).outlineStyle)).not.toBe("none");
    await page.screenshot({ path: "test-results/fiori-master-lama-master-barang.png", fullPage: true });

    const tabs = main.getByRole("group", { name: "Bagian master" });
    await tabs.getByRole("button", { name: /^QC/ }).click();
    await expect(tabs.getByRole("button", { name: /^QC/ })).toHaveAttribute("aria-pressed", "true");
    await expect(main.getByRole("table", { name: "Temuan QC" })).toContainText("Peringatan");
    await expect(main.getByRole("table", { name: "Temuan QC" })).not.toContainText("LEN_LEBIH"); // kode mentah tidak tampil

    // Finalisasi: dialog menyebut jumlah dan akibat; badan POST sama.
    await main.getByRole("button", { name: "Finalisasi…" }).click();
    let dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Finalisasi master PRINCIPLE A?" })).toBeVisible();
    await expect(dlg).toContainText("0 error, 1 peringatan");
    await dlg.getByRole("button", { name: "Batal" }).click();
    expect(kirim).toEqual([]);
    await main.getByRole("button", { name: "Finalisasi…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Finalisasi master" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(kirim[0]).toEqual({ action: "finalize", masterId: "mb1" });
    await expect(main.getByRole("status").filter({ hasText: "Master barang berstatus Siap." })).toBeVisible();

    // Kamus Kode: isian berlabel per baris, simpan lewat dialog.
    await tabs.getByRole("button", { name: "Kamus Kode" }).click();
    await main.getByLabel("Nama hasil baris 1").fill("kelompok z");
    await main.getByRole("button", { name: "Simpan kamus…" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Simpan Kamus Kode?" })).toBeVisible();
    await expect(dlg).toContainText("Form Fix dan QC dibuat ulang");
    await dlg.getByRole("button", { name: "Simpan kamus" }).click();
    await expect(dlg).toBeHidden();
    expect(kirim[1]).toMatchObject({ action: "update_codebook", masterId: "mb1", codebook: [{ key: "k1", name: "KELOMPOK Z", code: "01" }] });

    // Adaptasi master lama: dialog dengan cakupan, hasil di strip.
    await main.getByRole("button", { name: "Adaptasi master lama…" }).click();
    dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Adaptasi semua master lama?" })).toBeVisible();
    await dlg.getByRole("button", { name: "Adaptasi semua master" }).click();
    await expect(dlg).toBeHidden();
    expect(kirim.at(-1)).toEqual({ action: "adapt_legacy" });
    await expect(main.getByRole("status").filter({ hasText: "Adaptasi selesai: 2 file diadaptasi, 5 tetap, 0 gagal." })).toBeVisible();

    mode = "kosong"; await page.reload();
    await expect(main.getByRole("heading", { name: "Belum ada master", exact: true })).toBeVisible(NAV);
    mode = "galat"; await page.reload();
    // Galat 5xx: kalimat sebab di layar, teks teknis server hanya di konsol (Fase 3 audit desain 001).
    await expect(main.getByRole("alert").filter({ hasText: "Server sedang bermasalah" })).toBeVisible(NAV);
    await expect(main.getByText("koneksi database putus")).toHaveCount(0);
    await expect(main.getByText("Belum ada master", { exact: true })).toHaveCount(0); // galat tidak tampil sebagai kosong
    mode = "data"; await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("heading", { level: 2, name: "PRINCIPLE A" })).toBeVisible(NAV);

    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await expect(main.getByRole("heading", { level: 2, name: "PRINCIPLE A" })).toBeVisible(NAV);
    await tanpaGulirSamping(page);
    await page.screenshot({ path: "test-results/fiori-master-lama-master-barang-360.png", fullPage: true });
});

// ------------------------------------------------------------------------------------------------------ Laporan klaim
const LAPORAN = {
    ok: true, rowCount: 2,
    columns: [{ key: "claimWorkflowNo", label: "No Claim Workflow" }, { key: "status", label: "Status" }, { key: "totalClaim", label: "Total Claim" }, { key: "createdAt", label: "Dibuat" }],
    rows: [
        { claimWorkflowNo: "CLM/001/PA/10/2026", status: "Partially Paid", totalClaim: 12398750, createdAt: "2026-10-05T01:30:00Z" },
        { claimWorkflowNo: "CLM/002/PA/10/2026", status: "Draft", totalClaim: 4700000, createdAt: "2026-10-04T06:00:00Z" },
    ],
};

test("Laporan klaim: memuat, kosong, galat tanpa pesan, bagian dan saringan, unduh CSV, ponsel 360", async ({ page }) => {
    let mode: "data" | "kosong" | "galat" | "kosongan" | "lambat" = "lambat";
    let lepas!: () => void; const tahan = new Promise<void>((ok) => { lepas = ok; });
    const diminta: string[] = [];
    await page.route((u) => u.pathname.startsWith("/api/claim-workflow/reports/") && !u.pathname.endsWith("/export"), async (r) => {
        const u = new URL(r.request().url()); diminta.push(u.pathname + u.search);
        if (mode === "lambat") await tahan;
        if (mode === "galat") return r.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad Gateway</html>" }); // bukan JSON
        if (mode === "kosongan") return r.fulfill({ status: 500, contentType: "application/json", body: "{}" }); // galat tanpa pesan
        return r.fulfill(json(mode === "kosong" ? { ok: true, columns: LAPORAN.columns, rows: [], rowCount: 0 } : LAPORAN));
    });
    await page.route((u) => u.pathname.endsWith("/export"), (r) => r.fulfill({ status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="claim-summary-report.csv"' }, body: "a;b\r\n1;2" }));
    await page.goto("/claim-workflow/reports", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Laporan klaim" })).toBeVisible(NAV);
    await expect(main.getByRole("status").filter({ hasText: "Memuat laporan" })).toBeAttached();
    mode = "data"; lepas();
    const tabel = main.getByRole("table", { name: "Pratinjau laporan klaim ringkasan" });
    await expect(tabel).toContainText("CLM/001/PA/10/2026", NAV);
    await expect(tabel).toContainText("Dibayar sebagian"); // label tugas, bukan "Partially Paid"
    await expect(tabel).toContainText("05/10/2026 09.30"); // WITA
    await expect(main.locator(".fi-tablescroll").first()).toHaveAttribute("tabindex", "0");
    await page.screenshot({ path: "test-results/fiori-master-lama-laporan-klaim.png", fullPage: true });

    // Kode principal dijeda: huruf demi huruf tidak jadi satu permintaan per huruf.
    diminta.length = 0;
    await main.getByLabel("Kode principal").first().pressSequentially("PAB", { delay: 60 });
    await expect.poll(() => diminta.at(-1) ?? "").toContain("principleCode=PAB");
    expect(diminta.filter((q) => /principleCode=P(&|$)/.test(q))).toHaveLength(0);

    // Bagian lain memakai kunci bagian yang sama seperti sebelum migrasi.
    await main.getByRole("group", { name: "Jenis laporan" }).getByRole("button", { name: "Pembayaran" }).click();
    await expect.poll(() => diminta.at(-1) ?? "").toContain("/api/claim-workflow/reports/paid");
    await main.getByRole("group", { name: "Jenis laporan" }).getByRole("button", { name: "Ringkasan" }).click();
    await expect(tabel).toBeVisible(NAV);

    // Unduh CSV: tombol, sukses di strip.
    const unduh = page.waitForEvent("download");
    await main.getByRole("button", { name: "Unduh CSV Ringkasan" }).click();
    expect((await unduh).suggestedFilename()).toBe("claim-summary-report.csv");
    await expect(main.getByRole("status").filter({ hasText: "Unduhan CSV Ringkasan selesai." })).toBeVisible();

    mode = "kosong"; await page.reload();
    await expect(main.getByRole("heading", { name: "Tidak ada data untuk saringan ini" })).toBeVisible(NAV);
    mode = "galat"; await page.reload();
    await expect(main.getByRole("alert").filter({ hasText: "Server sedang bermasalah" })).toBeVisible(NAV);
    await expect(main.getByText(/Unexpected token/)).toHaveCount(0);
    await expect(main.getByText("Tidak ada data untuk saringan ini")).toHaveCount(0); // galat bukan kosong
    mode = "kosongan"; await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Server sedang bermasalah" })).toBeVisible(NAV); // galat tanpa pesan tetap berisi
    mode = "data"; await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(tabel).toContainText("CLM/002/PA/10/2026", NAV);

    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await expect(tabel).toBeVisible(NAV);
    await tanpaGulirSamping(page);
    await page.screenshot({ path: "test-results/fiori-master-lama-laporan-klaim-360.png", fullPage: true });
});

// ------------------------------------------------------------------------------------------------------ Pengaturan Summary
const DETAIL_S = {
    row_id: "r1", document_id: "SURAT-A/10", principal: "PRINCIPLE A", nama_program: "Program A", variant_barang: "KELOMPOK A", benefit: "Diskon 3%", ketentuan_pengambilan: "Beli 12 PCS",
    start: "2026-10-01", end: "2026-10-31", kode_barang: ["A-001"], conditions: ["Berlaku untuk outlet GT"], warnings: [], correction: "",
    settings: { threshold_metric: "quantity", aggregation: "invoice", benefit_type: "percentage", settlement: "on_invoice", mix_scope: "same_sku", amount: 3, minimum: 12, tiers: [{ grade: "A", minimum: 12, maximum: 23, amount: 3 }, { grade: "B", minimum: 24, maximum: null, amount: 5 }] },
};
const PAKET = (publikasi = false) => ({ id: "pk1", title: "Paket A", revision: 2, content: {
    details: [publikasi ? { ...DETAIL_S, publication: { draft_id: "d1", revision: 2 } } : DETAIL_S],
    summary: [{ summary_id: "s1", principal: "PRINCIPLE A", kelompok: "KELOMPOK A", channel: "GT", ketentuan: "Beli 12 PCS", benefit: "Diskon 3%", detail_ids: ["r1"] }],
    master: { "A-001": { name: "PRODUK A" } },
} });

test("Pengaturan Summary: galat daftar bukan kosong, buka paket, koreksi, Terbitkan lewat dialog (galat server tampil di dialog), ponsel 360", async ({ page }) => {
    let daftar: "data" | "galat" = "galat";
    let tolak = true; const publish: unknown[] = []; const simpan: unknown[] = [];
    let rujukan: Record<string, unknown> = { ok: true, tersedia: true, sebab: "", periode: "Oktober 2026", judul: "Summary Oktober 2026" };
    await page.route((u) => u.host === "localhost:8000", async (r) => {
        const p = new URL(r.request().url()).pathname; const m = r.request().method();
        if (m === "OPTIONS") return fastapi(r, {});
        if (p === "/api/me") return fastapi(r, { csrf_token: "t" });
        if (p === "/summary/review/reference" && m === "GET") return fastapi(r, rujukan);
        if (p === "/summary/review" && m === "GET") return daftar === "galat" ? fastapi(r, "<html>x</html>", 502) : fastapi(r, { packages: [{ id: "pk1", title: "Paket A", revision: 2 }] });
        if (p === "/summary/review/pk1" && m === "GET") return fastapi(r, { package: PAKET() });
        if (p === "/summary/review/pk1/details/r1" && m === "PUT") { simpan.push(r.request().postDataJSON()); return fastapi(r, { package: PAKET() }); }
        if (p === "/summary/review/pk1/details/r1/readiness") return fastapi(r, { issues: [], programs: [{ id: "p1" }] });
        if (p === "/summary/review/pk1/details/r1/publish") {
            publish.push(r.request().postDataJSON());
            if (tolak) { tolak = false; return fastapi(r, { detail: "Revisi paket sudah berubah. Muat ulang paket." }, 409); }
            return fastapi(r, { package: PAKET(true) });
        }
        return fastapi(r, {});
    });
    await page.goto("/summary/settings", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Pengaturan Summary" })).toBeVisible(NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Server sedang bermasalah" })).toBeVisible(NAV);
    await expect(main.getByText(/Unexpected token/)).toHaveCount(0);
    // Paket rujukan (No 81): label dari periode paket di server, bukan bulan tertulis di kode.
    await expect(main.getByRole("button", { name: "Buka paket rujukan Oktober 2026" })).toBeEnabled();
    daftar = "data"; await main.getByRole("button", { name: "Coba lagi" }).click();
    await main.getByLabel("Paket tersimpan").selectOption("pk1");
    await expect(main.getByRole("heading", { level: 2, name: "r1, KELOMPOK A" })).toBeVisible(NAV);
    await expect(main.getByRole("table", { name: "Ringkasan program" })).toContainText("PRINCIPLE A");
    await page.screenshot({ path: "test-results/fiori-master-lama-summary-settings.png", fullPage: true });

    // Koreksi: simpan tetap mengirim badan yang sama.
    await main.getByLabel("Minimum pembelian").fill("24");
    await expect(main.getByText("Simpan atau batalkan sebelum berpindah detail.")).toBeVisible();
    await main.getByRole("button", { name: "Simpan koreksi" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Koreksi tersimpan." })).toBeVisible();
    expect(simpan[0]).toMatchObject({ revision: 2, patch: { start: "2026-10-01", end: "2026-10-31", kode_barang: ["A-001"], settings: { minimum: 24 } } });

    // Terbitkan: butuh centang, lalu dialog dengan program dan akibat; galat server ada di dialog.
    await main.getByRole("button", { name: "Periksa kelengkapan aturan" }).click();
    await expect(main.getByRole("status").filter({ hasText: "1 aturan siap ditinjau dan diterbitkan." })).toBeVisible();
    await expect(main.getByRole("button", { name: "Terbitkan untuk order…" })).toBeDisabled();
    await main.getByLabel("Saya sudah memeriksa sumber, SKU, benefit, dan semua ketentuan.").check();
    await main.getByRole("button", { name: "Terbitkan untuk order…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Terbitkan aturan r1 untuk order?" })).toBeVisible();
    await expect(dlg).toContainText("SURAT-A/10");
    await expect(dlg).toContainText("Order berikutnya memakai versi ini");
    await dlg.getByRole("button", { name: "Terbitkan untuk order" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Revisi paket sudah berubah");
    await dlg.getByRole("button", { name: "Terbitkan untuk order" }).click();
    await expect(dlg).toBeHidden();
    expect(publish).toEqual([{ revision: 2, reviewed: true }, { revision: 2, reviewed: true }]);
    await expect(main.getByRole("status").filter({ hasText: "Aturan diterbitkan. Order berikutnya memakai versi ini." })).toBeVisible();
    await expect(main.getByText("Sudah diterbitkan sebagai versi tetap untuk order.")).toBeVisible();

    await page.setViewportSize({ width: 360, height: 800 });
    rujukan = { ok: true, tersedia: false, sebab: "Paket rujukan belum tersedia di server.", periode: null, judul: null };
    await page.reload();
    await expect(main.getByText("Paket rujukan belum tersedia di server.")).toBeVisible(NAV);
    await expect(main.getByRole("button", { name: "Buka paket rujukan", exact: true })).toHaveAttribute("aria-disabled", "true");
    await main.getByLabel("Paket tersimpan").selectOption("pk1");
    await expect(main.getByRole("heading", { level: 2, name: "r1, KELOMPOK A" })).toBeVisible(NAV);
    await tanpaGulirSamping(page);
    await page.screenshot({ path: "test-results/fiori-master-lama-summary-settings-360.png", fullPage: true });
});

// ------------------------------------------------------------------------------------------------------ Realisasi program
const BARIS_R = {
    orderId: "SO-0001", customer: "OUTLET A", date: "2026-10-05", state: "posted", invoiceId: "i1", invoiceNumber: "INV/XXXX/0001", databaseId: "db1",
    plannedDiscount: "12500", plannedPrograms: [{ name: "Program A", discount: "12500" }], realization: null, checkedAt: null,
};

test("Realisasi program: sebelum ditampilkan, kosong, galat bukan kosong, periksa ulang menampilkan badge dan total, ponsel 360", async ({ page }) => {
    let mode: "data" | "kosong" | "galat" = "data"; const periksa: unknown[] = []; const diminta: string[] = [];
    await page.route(path("/api/summary/realization"), (r) => {
        const req = r.request();
        if (req.method() === "POST") {
            periksa.push(req.postDataJSON());
            return r.fulfill(json({ ok: true, realization: { status: "verified", reason: "Isi faktur cocok dengan order", discount: 12500, programs: [{ id: "p1", name: "Program A", discount: 12500 }], bonuses: [] } }));
        }
        diminta.push(new URL(req.url()).search);
        if (mode === "galat") return r.fulfill({ status: 500, contentType: "application/json", body: "{}" });
        return r.fulfill(json({ ok: true, rows: mode === "kosong" ? [] : [BARIS_R], next: null }));
    });
    await page.goto("/summary/realization", NAV);
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "Realisasi program" })).toBeVisible(NAV);
    await expect(main.getByRole("status").filter({ hasText: "Pilih periode lalu tampilkan laporan." })).toBeVisible();
    // Periode bawaan: awal bulan sampai hari ini menurut WITA.
    const hari = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
    await expect(main.getByLabel("Sampai tanggal")).toHaveValue(hari);
    await expect(main.getByLabel("Dari tanggal")).toHaveValue(`${hari.slice(0, 7)}-01`);

    mode = "galat"; await main.getByRole("button", { name: "Tampilkan" }).click();
    await expect(main.getByRole("alert").filter({ hasText: "Server sedang bermasalah" })).toBeVisible(NAV);
    await expect(main.getByText("Belum ada order di periode ini")).toHaveCount(0); // galat bukan kosong
    mode = "kosong"; await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("heading", { name: "Belum ada order di periode ini" })).toBeVisible(NAV);

    mode = "data"; await main.getByRole("button", { name: "Tampilkan" }).click();
    const tabel = main.getByRole("table", { name: "Order dan faktur" });
    await expect(tabel).toContainText("OUTLET A", NAV);
    await expect(tabel).toContainText("05/10/2026");
    await expect(tabel).toContainText("Terposting");
    await expect(tabel.getByRole("link", { name: "INV/XXXX/0001" })).toHaveAttribute("href", "/faktur?invoiceId=i1&databaseId=db1");
    await expect(tabel).toContainText("Belum diperiksa");
    await tabel.getByRole("button", { name: "Periksa SO-0001 di Accurate" }).click();
    expect(periksa).toEqual([{ orderId: "SO-0001" }]);
    await expect(main.getByRole("status").filter({ hasText: "Isi faktur cocok dengan order" })).toBeVisible();
    await expect(tabel).toContainText("Cocok dengan faktur");
    await expect(main.getByRole("table", { name: "Total per program" })).toContainText("Program A");
    await page.screenshot({ path: "test-results/fiori-master-lama-realisasi.png", fullPage: true });

    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await main.getByRole("button", { name: "Tampilkan" }).click();
    await expect(main.getByRole("list", { name: "Order dan faktur" })).toContainText("OUTLET A", NAV);
    await tanpaGulirSamping(page);
    await page.screenshot({ path: "test-results/fiori-master-lama-realisasi-360.png", fullPage: true });
});
