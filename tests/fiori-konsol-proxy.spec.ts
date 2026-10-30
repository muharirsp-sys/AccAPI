/*
 * Tujuan: S7-1b butir 3 — Konsol (/api-wrapper) membaca penolakan /api/proxy SEBELUM diteruskan (4xx + sent:false: tanpa
 *   api_wrapper.execute / endpoint di luar katalog) sebagai "ditolak, tidak terkirim": berhenti di tahap itu, pesan server tampil apa
 *   adanya, tanpa status TIDAK DIKETAHUI, tanpa pembacaan riwayat Accurate dan tanpa kiriman ulang.
 *   Audit desain 001 M1: tulis hanya sesudah ConfirmDialog (Kirim = satu POST, Batal = nol POST; fakta endpoint, jumlah baris,
 *   database aktif, tidak bisa ditarik), JSON rusak = galat di halaman tanpa dialog, hasil parser berkas tidak berlabel terkirim,
 *   override duplikat pelunasan lewat dialog beralasan (min 15 sesudah trim, alasan yang sama sampai ke lock idempotency).
 *   Audit desain 001 kelompok 3: log galat tidak diunduh otomatis (No 7, tombol "Unduh log galat"; Status tanpa em dash);
 *   tab Unggah Excel tanpa berkas: Kirim nonaktif beralasan dan nol POST (usulan G); laporan Retur Manual Format Pelunasan lewat strip
 *   + tombol, tanpa unduhan otomatis (pola No 7).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true):
 *   `npx playwright test tests/fiori-konsol-proxy.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: /api/auth/accurate-session, /api/auth/db-list, /api/proxy, /api/idempotency/{lock,complete} di-mock dengan page.route
 *   (tanpa Accurate, tanpa DB).
 * Side Effects: tidak ada.
 */
import { expect, test, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

const NAV = { timeout: 90_000 } as const;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const IZIN = "Tulis ke Accurate lewat Konsol butuh izin Konsol · Eksekusi (api_wrapper.execute). Tidak ada yang dikirim.";
const KATALOG = "Endpoint ini tidak ada di katalog tulis Konsol (hanya save.do/bulk-save.do katalog; hapus dan endpoint lain ditolak). Tidak ada yang dikirim.";

type Panggilan = { endpointPath: string; method: string };
async function mockKonsol(page: Page, jawab: (p: Panggilan) => { status: number; body: unknown }) {
    const proxy: Array<{ endpointPath: string; method: string }> = [];
    await page.route((u) => u.pathname === "/api/auth/accurate-session", (r) => r.fulfill(json({
        ok: true, connected: true, databaseConnected: true, sessionHost: "https://public.accurate.id", databaseId: "DB-1", databaseAlias: "PT A",
    })));
    await page.route((u) => u.pathname === "/api/auth/db-list", (r) => r.fulfill(json({ d: [{ id: "DB-1", alias: "PT A" }] })));
    await page.route((u) => u.pathname === "/api/proxy", (r) => {
        const b = r.request().postDataJSON() as Panggilan;
        proxy.push({ endpointPath: b.endpointPath, method: b.method });
        const j = jawab(b);
        return r.fulfill(json(j.body, j.status));
    });
    return proxy;
}

const KIRIM = "Kirim ke Accurate…";
const hasil = (page: Page) => page.getByRole("region", { name: "Hasil" });

async function isi(page: Page, route: string, payload: unknown) {
    await page.goto("/api-wrapper", NAV);
    await expect(page.getByRole("button", { name: KIRIM })).toBeEnabled(NAV);
    await page.getByLabel("Endpoint API").selectOption(route);
    await page.getByLabel("Payload JSON").fill(JSON.stringify(payload));
}

/** Tombol Kirim membuka ConfirmDialog; tulis baru berjalan sesudah tombol konfirmasi (label "Kirim …"). */
async function konfirmasi(page: Page) {
    await page.getByRole("button", { name: KIRIM }).click();
    const dlg = page.getByRole("dialog", { name: /ke Accurate\?$/ });
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: /^Kirim/ }).click();
    await expect(dlg).toBeHidden();
}

async function eksekusi(page: Page, route: string, payload: unknown) {
    await isi(page, route, payload);
    await konfirmasi(page);
}

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} tidak diharapkan: ${d.message()}`); });
});

test("bulk-save tanpa api_wrapper.execute: 403 berkode sent:false -> berhenti di tahap 1, pesan server apa adanya, bukan TIDAK DIKETAHUI", async ({ page }) => {
    const proxy = await mockKonsol(page, () => ({ status: 403, body: { error: IZIN, code: "PERMISSION_REQUIRED", permission: "api_wrapper.execute", sent: false } }));
    // 150 baris = 2 tahap (100 + 50): tahap 2 TIDAK boleh dikirim, dan tidak ada pembacaan riwayat (GET list.do).
    const baris = Array.from({ length: 150 }, (_, i) => ({ customerNo: `C-${i}`, transDate: "01/10/2026", detailItem: [{ itemNo: "I1", quantity: 1 }] }));
    await eksekusi(page, "salesReturnBulkSave", baris);
    const log = hasil(page).getByRole("alert");
    await expect(log).toContainText(IZIN, NAV);
    await expect(page.getByText(/TIDAK DIKETAHUI|TIDAK PASTI/)).toHaveCount(0);
    expect(proxy).toEqual([{ endpointPath: "/api/sales-return/bulk-save.do", method: "POST" }]);
});

test("save.do di luar katalog / sesi belum lengkap: penolakan proxy sebelum diteruskan tampil apa adanya; tidak dikirim ulang", async ({ page }) => {
    let jawaban = { status: 403, body: { error: KATALOG, code: "ENDPOINT_TIDAK_DIIZINKAN", sent: false } as Record<string, unknown> };
    const proxy = await mockKonsol(page, () => jawaban);
    await eksekusi(page, "purchaseOrder", { vendorNo: "V-01" });
    await expect(page.getByText(KATALOG).first()).toBeVisible(NAV);
    expect(proxy).toEqual([{ endpointPath: "/api/purchase-order/save.do", method: "POST" }]);

    jawaban = { status: 400, body: { error: "Sesi Accurate belum lengkap. Login dan pilih database terlebih dahulu.", code: "ACCURATE_SESSION_INCOMPLETE", sent: false } };
    await konfirmasi(page);
    await expect(page.getByText("Sesi Accurate belum lengkap. Login dan pilih database terlebih dahulu.").first()).toBeVisible(NAV);
    expect(proxy).toHaveLength(2);
});

test("tinjauan A: tahap 1 = 504 (TIDAK PASTI), tahap 2 = 400 sent:false -> ringkasan menandai tidak pasti + Excel (100 TIDAK DIKETAHUI, 50 tidak terkirim), tanpa kirim ulang", async ({ page }) => {
    const SESI = "Sesi Accurate belum lengkap. Login dan pilih database terlebih dahulu.";
    let tulis = 0;
    const proxy = await mockKonsol(page, (p) => {
        if (p.method === "GET") return { status: 200, body: { s: true, d: [] } }; // riwayat Accurate: tidak ditemukan
        tulis += 1;
        return tulis === 1
            ? { status: 504, body: { error: "Accurate tidak merespons dalam 30 detik (timeout). Status tulis TIDAK PASTI: periksa di Accurate sebelum mengirim ulang." } }
            : { status: 400, body: { error: SESI, code: "ACCURATE_SESSION_INCOMPLETE", sent: false } };
    });
    const baris = Array.from({ length: 150 }, (_, i) => ({ customerNo: `C-${i}`, transDate: "01/10/2026", detailItem: [{ itemNo: "I1", quantity: 1 }] }));
    const unduhan: string[] = [];
    page.on("download", (d) => unduhan.push(d.suggestedFilename()));
    await eksekusi(page, "salesReturnBulkSave", baris);
    const log = hasil(page).getByRole("alert");
    await expect(log).toContainText(SESI, NAV);
    await expect(log).toContainText("100 baris TIDAK DIKETAHUI");
    await expect(log).toContainText("2 tahap gagal");
    await expect(log).toContainText("tekan Unduh log galat");
    // No 7: tidak ada unduhan otomatis (dulu setTimeout 2 dtk); log galat hanya lewat tombol.
    await page.waitForTimeout(3_000);
    expect(unduhan).toEqual([]);
    const unduh = page.waitForEvent("download");
    await hasil(page).getByRole("button", { name: "Unduh log galat" }).click();
    const berkas = await (await unduh).path();
    const isi = XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.readFile(berkas).Sheets["Error Log"]);
    const hitung = (awal: string) => isi.filter((r) => String(r.Status).startsWith(awal)).length;
    expect([isi.length, hitung("TIDAK DIKETAHUI"), hitung("Gagal: tidak terkirim")]).toEqual([150, 100, 50]);
    expect(isi.filter((r) => String(r.Status).includes("—"))).toEqual([]);
    expect(proxy.filter((p) => p.method === "POST").map((p) => p.endpointPath)).toEqual(["/api/sales-return/bulk-save.do", "/api/sales-return/bulk-save.do"]);
});

test("Kirim: dialog menyebut endpoint, jumlah baris, database aktif, tidak bisa ditarik; Batal = nol POST, Kirim = tepat satu POST", async ({ page }) => {
    const proxy = await mockKonsol(page, () => ({ status: 200, body: { s: true, d: [1, 2, 3].map((i) => ({ s: true, d: `OK-${i}` })) } }));
    const baris = [1, 2, 3].map((i) => ({ customerNo: `PELANGGAN-${i}`, transDate: "01/10/2026", detailItem: [{ itemNo: "BARANG-A", quantity: 1 }] }));
    await isi(page, "salesReturnBulkSave", baris);
    await page.getByRole("button", { name: KIRIM }).click();
    const dlg = page.getByRole("dialog", { name: "Kirim 3 baris ke Accurate?" });
    await expect(dlg).toContainText("/api/sales-return/bulk-save.do");
    await expect(dlg).toContainText("3 baris, 1 tahap");
    await expect(dlg).toContainText("PT A");
    await expect(dlg).toContainText("tidak bisa ditarik");
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(dlg).toBeHidden();
    expect(proxy).toEqual([]);

    await page.getByRole("button", { name: KIRIM }).click();
    await dlg.getByRole("button", { name: "Kirim 3 baris" }).click();
    await expect(hasil(page).getByRole("status").filter({ hasText: "Accurate menerima kiriman." })).toBeVisible(NAV);
    expect(proxy).toEqual([{ endpointPath: "/api/sales-return/bulk-save.do", method: "POST" }]);
});

test("usulan G: tab Unggah Excel tanpa berkas = Kirim nonaktif dengan alasan terlihat, nol POST (tulis dan baca)", async ({ page }) => {
    const proxy = await mockKonsol(page, () => ({ status: 200, body: { s: true, d: [] } }));
    for (const route of ["salesReturnBulkSave", "purchaseOrder"]) {
        await isi(page, route, [{ customerNo: "PELANGGAN-A" }]);
        await page.getByRole("button", { name: "Unggah Excel" }).click();
        const kirim = page.getByRole("button", { name: KIRIM });
        await expect(kirim).toBeDisabled();
        await expect(kirim).toHaveAttribute("aria-disabled", "true"); // tetap di urutan Tab (pola disabledReason)
        await expect(page.getByText("Unggah berkas Excel dulu.", { exact: false }).first()).toBeVisible();
        await kirim.click({ force: true });
        await kirim.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: /ke Accurate\?$/ })).toHaveCount(0);
        // Kembali ke Payload JSON: Kirim aktif lagi dan memakai isi editor, bukan contoh payload bawaan.
        await page.getByRole("button", { name: "Payload JSON" }).click();
        await expect(kirim).toBeEnabled();
    }
    await page.waitForTimeout(1_000);
    expect(proxy).toEqual([]);
});

test("Format Pelunasan dengan retur yang tidak ketemu: strip + tombol Unduh retur manual, tanpa unduhan otomatis, nol POST", async ({ page }) => {
    const proxy = await mockKonsol(page, () => ({ status: 200, body: { s: true, d: [], sp: { page: 1, pageCount: 1, rowCount: 0 } } }));
    const unduhan: string[] = [];
    page.on("download", (d) => unduhan.push(d.suggestedFilename()));
    await page.goto("/api-wrapper", NAV);
    await expect(page.getByRole("button", { name: KIRIM })).toBeEnabled(NAV);
    await page.getByLabel("Endpoint API").selectOption("salesReceiptBulkSave");
    await page.getByRole("button", { name: "Unggah Excel" }).click();
    const ws = XLSX.utils.json_to_sheet([{ "Code Outlet": "PELANGGAN-A", "No. Nota": "INV/A/001", "Tunai": 100000, "No.SRB Rt Ktr": "SRB A.0001", "Pot.RT Ktr": 50000 }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pelunasan");
    await page.locator('input[type="file"]').setInputFiles({ name: "format-pelunasan.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer });
    const strip = page.getByRole("status").filter({ hasText: "retur atau potongan lain yang belum diproses" });
    await expect(strip).toBeVisible(NAV);
    await page.waitForTimeout(2_000); // dulu setTimeout 800 ms mengunduh otomatis
    expect(unduhan).toEqual([]);
    const unduh = page.waitForEvent("download");
    await strip.getByRole("button", { name: "Unduh retur manual (Excel)" }).click();
    const d = await unduh;
    expect(d.suggestedFilename()).toMatch(/^Retur_PotLain_Manual_.*\.xlsx$/);
    const isi = XLSX.utils.sheet_to_json<Record<string, unknown>>(XLSX.readFile(await d.path()).Sheets["Retur Manual"]);
    expect(isi).toHaveLength(1);
    expect(isi[0]).toMatchObject({ "Code Outlet": "PELANGGAN-A", "Referensi Retur/Pot.Lain": expect.stringContaining("SRB A.0001"), "Aksi Manual": "Retur/Pot.Lain perlu diproses manual di Accurate" });
    expect(proxy.filter((p) => p.method !== "GET")).toEqual([]);
});

test("JSON rusak: galat di halaman (role alert, bukan toast), dialog tidak terbuka, nol POST", async ({ page }) => {
    const proxy = await mockKonsol(page, () => ({ status: 200, body: { s: true, d: [] } }));
    await isi(page, "purchaseOrder", {});
    await page.getByLabel("Payload JSON").fill("{ rusak");
    await page.getByRole("button", { name: KIRIM }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Payload JSON tidak valid." })).toBeVisible();
    await expect(page.getByRole("dialog", { name: /ke Accurate\?$/ })).toHaveCount(0);
    expect(proxy).toEqual([]);
});

test("override duplikat pelunasan: alasan < 15 karakter menahan kiriman, Batal = nol tulis; 15 karakter = lock membawa alasan yang sama + satu POST", async ({ page }) => {
    const kunciTulis: Array<Record<string, unknown>> = [];
    const proxy = await mockKonsol(page, (p) => p.method === "GET"
        ? { status: 200, body: { s: true, d: [], sp: { pageCount: 1 } } } // riwayat Accurate: kosong
        : { status: 200, body: { s: true, d: [{ s: true, d: "Berhasil", r: { number: "SR-A-0001" } }] } });
    await page.route((u) => u.pathname === "/api/idempotency/lock", (r) => {
        const b = r.request().postDataJSON() as { keys: Array<{ key: string }>; preview?: boolean };
        if (b.preview) return r.fulfill(json({ blockedEntries: b.keys.map((k) => ({ key: k.key, reason: "ALREADY_SUCCESS" })) }));
        kunciTulis.push(b as unknown as Record<string, unknown>);
        return r.fulfill(json({ lockId: "KUNCI-1" }));
    });
    await page.route((u) => u.pathname === "/api/idempotency/complete", (r) => r.fulfill(json({ ok: true })));
    const tulis = () => proxy.filter((p) => p.method === "POST");

    const baris = [{ customerNo: "PELANGGAN-A", transDate: "01/10/2026", bankNo: "KAS-A", chequeAmount: 1500, detailInvoice: [{ invoiceNo: "INV/A/001", paymentAmount: 1500 }] }];
    await eksekusi(page, "salesReceiptBulkSave", baris);
    const tinjau = page.getByRole("dialog", { name: "Kirim pelunasan yang mirip kiriman lain?" });
    await expect(tinjau).toBeVisible(NAV);
    await expect(tinjau).toContainText("Sudah pernah terkirim");
    // Tanpa centang: tidak ada yang dikirim, galat di dialog (bukan toast).
    await tinjau.getByRole("button", { name: "Kirim 0 baris ke Accurate" }).click();
    await expect(tinjau.getByRole("alert")).toContainText("Belum ada baris yang dipilih");
    expect(kunciTulis).toEqual([]);
    await tinjau.getByRole("checkbox").check();
    await tinjau.getByRole("button", { name: "Kirim 1 baris ke Accurate" }).click();

    const ov = page.getByRole("dialog", { name: "Kirim ulang 1 blok yang ditandai ganda?" });
    await expect(ov).toContainText("INV/A/001");
    const alasan = ov.getByLabel("Alasan override");
    const tombol = ov.getByRole("button", { name: "Override dan kirim" });
    await alasan.fill("  terlalu pendek  "); // 14 karakter sesudah trim
    await expect(tombol).toBeDisabled();
    await ov.getByRole("button", { name: "Batal" }).click();
    await expect(ov).toBeHidden();
    expect(kunciTulis).toEqual([]);
    expect(tulis()).toEqual([]);

    await tinjau.getByRole("button", { name: "Kirim 1 baris ke Accurate" }).click();
    await expect(alasan).toHaveValue(""); // alasan lama tidak terbawa
    await alasan.fill("  Ulang oleh Fina  "); // 15 karakter sesudah trim
    await expect(tombol).toBeEnabled();
    await tombol.click();
    await expect.poll(() => tulis().length, NAV).toBe(1);
    expect(tulis()).toEqual([{ endpointPath: "/api/sales-receipt/bulk-save.do", method: "POST" }]);
    expect(kunciTulis).toHaveLength(1);
    expect(kunciTulis[0].overrideReason).toBe("Ulang oleh Fina");
    expect(kunciTulis[0].allowLockedKeys).toHaveLength(1);
    expect(kunciTulis[0].expectedDatabaseId).toBe("DB-1");
});
