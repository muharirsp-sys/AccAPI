/*
 * Tujuan: Kendali unggah berkas Fiori (`.fi-input[type="file"]`) tidak terpotong: tombol "Choose File" muat di dalam kotak, di 390 dan 1366 px,
 *   terang/gelap, density compact (32 px) dan cozy/pointer kasar (44 px); input biasa di sebelahnya tetap setinggi --ctl-h.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin): `npx playwright test tests/fiori-file-input.spec.ts`.
 * Dependensi: /summary (FastAPI di-mock di localhost:8000) dan /rekapan-nota (endpoint /api/rekapan-nota/* di-mock); app/fiori.css.
 * Main Functions: ukur kotak vs `::file-selector-button` lewat getComputedStyle; tangkapan di test-results/fiori-file-input-*.png.
 * Side Effects: localStorage peramban uji (tema Surya, density); tidak ada HTTP ke backend/Accurate.
 */
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const path = (p: string) => (url: URL) => url.pathname === p;
const NAV = { timeout: 90_000 } as const;
const BERKAS = { name: "Master Principal KINO Oktober 2026 versi revisi akhir.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") };

// FastAPI Summary di-mock; CORS mengikuti origin peminta (port uji berbeda-beda).
const fastapi = (r: Route, body: unknown) => {
    const cors = { "access-control-allow-origin": r.request().headers()["origin"] ?? "*", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, PUT, OPTIONS" };
    return r.request().method() === "OPTIONS" ? r.fulfill({ status: 204, headers: cors }) : r.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });
};

test.use({ deviceScaleFactor: 2 }); // tangkapan tajam untuk ditinjau mata

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        if (sessionStorage.getItem("fiori-test-init")) return;
        sessionStorage.setItem("fiori-test-init", "1");
        localStorage.setItem("off-theme", "surya"); // tema pemilik: tombol berkas dulu hijau dan terpotong
        localStorage.removeItem("fiori-scheme");
        localStorage.removeItem("fiori-density");
    });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
});

/** Summary: "Atau unggah Excel master baru" satu .fi-formgrid dengan select biasa. */
async function bukaSummary(page: Page) {
    await page.route((u) => u.host === "localhost:8000", (r) => {
        const p = new URL(r.request().url()).pathname;
        if (p === "/api/principles") return fastapi(r, { ok: true, principles: { k1: { name: "KINO NON FOOD", filename: "kino.xlsx" } } });
        if (p === "/api/me") return fastapi(r, { csrf_token: "t" });
        return fastapi(r, { ok: true, drafts: [] });
    });
    await page.route(path("/api/promo-rule/from-summary"), (r) => r.fulfill(json({ ok: true, published: [] })));
    await page.goto("/summary", NAV);
    const berkas = page.getByLabel("Atau unggah Excel master baru");
    await expect(berkas).toBeVisible(NAV);
    const baris = page.locator(".fi-formgrid").filter({ has: berkas });
    return { berkas, baris, tetangga: baris.getByLabel("Principal tersimpan") };
}

/** Rekapan Nota: dialog Unggah memuat input tanggal (biasa) di atas input berkas. */
async function bukaDialogUnggah(page: Page) {
    await page.route(path("/api/rekapan-nota/wave"), (r) => r.fulfill(json({ wave: [] })));
    await page.route(path("/api/rekapan-nota/pool"), (r) => r.fulfill(json({ tanggal: "2026-10-06", tipe: "reguler", jumlahNota: 0, kanvasNihilOleh: null, tanpaArea: 0, disembunyikan: 0, nota: [] })));
    await page.goto("/rekapan-nota", NAV);
    await page.locator("main").getByRole("button", { name: "Unggah file export…" }).click(NAV);
    const dlg = page.getByRole("dialog");
    const berkas = dlg.getByLabel(/File export/);
    await expect(berkas).toBeVisible();
    return { berkas, tetangga: dlg.getByLabel(/Tanggal data/), dlg };
}

/** Tinggi kotak vs `::file-selector-button` (px, getComputedStyle), area isi = di dalam border + padding kotak. */
const ukur = (loc: Locator) => loc.evaluate((el) => {
    const cs = getComputedStyle(el);
    const bt = getComputedStyle(el, "::file-selector-button");
    const px = (v: string) => parseFloat(v) || 0;
    return {
        kotak: el.getBoundingClientRect().height,
        isi: el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
        tombol: px(bt.height) + px(bt.marginTop) + px(bt.marginBottom),
        lebarTombol: px(bt.width),
        fontKotak: px(cs.fontSize),
        ctlH: px(getComputedStyle(el.closest(".fiori") ?? document.body).getPropertyValue("--ctl-h")),
    };
});
const tinggi = (loc: Locator) => loc.evaluate((el) => el.getBoundingClientRect().height);

/** Latar tombol terpakai vs warna token Fiori (diselesaikan lewat elemen probe) -- hijau tema Surya (#17694f) berarti aturan lama bocor kembali. */
const latarTombol = (loc: Locator, token: string) => loc.evaluate((el, t) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${t})`;
    (el.closest(".fiori") ?? document.body).appendChild(probe);
    const harapan = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { bg: getComputedStyle(el, "::file-selector-button").backgroundColor, harapan };
}, token);
const HIJAU_SURYA = "rgb(23, 105, 79)";

async function periksa(berkas: Locator, tetangga: Locator, tinggiKotak: number, tokenLatar = "--surface-2") {
    const u = await ukur(berkas);
    const latar = await latarTombol(berkas, tokenLatar);
    expect(latar.bg, "tombol bukan hijau tema Surya (aturan lama workspace.css tidak bocor ke .fi-input)").not.toBe(HIJAU_SURYA);
    expect(latar.bg, `latar tombol = token ${tokenLatar}`).toBe(latar.harapan);
    expect(u.ctlH, "density yang diuji").toBe(tinggiKotak);
    expect(u.kotak, "kotak berkas setinggi --ctl-h").toBeCloseTo(tinggiKotak, 0);
    expect(await tinggi(tetangga), "input biasa di sebelahnya setinggi --ctl-h").toBeCloseTo(tinggiKotak, 0);
    expect(u.lebarTombol, "tombol punya lebar terukur (bukan pseudo kosong)").toBeGreaterThan(60);
    expect(u.tombol, "tombol (dengan margin) muat di area isi kotak").toBeLessThanOrEqual(u.isi);
    expect(u.tombol, "tombol tidak mengecil jadi sliver").toBeGreaterThanOrEqual(u.isi - 8);
    return u;
}

for (const [lebar, tema] of [[1366, "terang"], [390, "terang"], [1366, "gelap"], [390, "gelap"]] as const) {
    test(`Summary ${lebar} px ${tema}: tombol Choose File muat di dalam kotak`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce", colorScheme: tema === "gelap" ? "dark" : "light" });
        await page.setViewportSize({ width: lebar, height: 900 });
        const { berkas, baris, tetangga } = await bukaSummary(page);
        await berkas.setInputFiles(BERKAS); // unggahMaster membaca balasan mock; yang dibutuhkan hanya nama berkas tampil di kotak
        await baris.screenshot({ path: `test-results/fiori-file-input-summary-${lebar}-${tema}.png` });
        await berkas.screenshot({ path: `test-results/fiori-file-input-summary-${lebar}-${tema}-kotak.png` });
        await periksa(berkas, tetangga, 32);
        const lebarKotak = await berkas.evaluate((el) => el.getBoundingClientRect().width);
        expect(lebarKotak, "kotak tidak melebihi lebar viewport").toBeLessThanOrEqual(lebar);
    });
}

test("Summary 390 px density cozy: kotak 44 px, tombol muat, teks kotak 16 px", async ({ page }) => {
    await page.addInitScript(() => { localStorage.setItem("fiori-density", "cozy"); });
    await page.setViewportSize({ width: 390, height: 844 });
    const { berkas, baris, tetangga } = await bukaSummary(page);
    await berkas.setInputFiles(BERKAS);
    await baris.screenshot({ path: "test-results/fiori-file-input-summary-390-cozy.png" });
    const u = await periksa(berkas, tetangga, 44);
    expect(u.fontKotak).toBeGreaterThanOrEqual(15);
});

test.describe("pointer kasar (ponsel sungguhan)", () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    test("Summary: kotak 44 px, teks kotak >= 16 px (tanpa zoom iOS), tombol muat", async ({ page }) => {
        const { berkas, baris, tetangga } = await bukaSummary(page);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "emulasi pointer kasar aktif").toBe(true);
        await berkas.setInputFiles(BERKAS);
        await baris.screenshot({ path: "test-results/fiori-file-input-summary-390-sentuh.png" });
        const u = await periksa(berkas, tetangga, 44);
        expect(u.fontKotak).toBeGreaterThanOrEqual(16);
    });
});

test("Rekapan Nota (dialog) 1366 px: berkas bersebelahan dengan input tanggal, keduanya setinggi --ctl-h; fokus kibor terlihat", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    const { berkas, tetangga, dlg } = await bukaDialogUnggah(page);
    await dlg.screenshot({ path: "test-results/fiori-file-input-dialog-1366-kosong.png" });
    await periksa(berkas, tetangga, 32);
    await berkas.setInputFiles(BERKAS);
    await berkas.focus();
    await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); // fokus lewat kibor -> :focus-visible
    await dlg.screenshot({ path: "test-results/fiori-file-input-dialog-1366-fokus.png" });
    expect(await berkas.evaluate((el) => getComputedStyle(el).boxShadow), "cincin fokus terlihat").not.toBe("none");
});

test("berkas nonaktif: tombol tetap muat dan bernada nonaktif (bukan hijau/primer)", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    const { berkas, baris, tetangga } = await bukaSummary(page);
    await berkas.evaluate((el: HTMLInputElement) => { el.disabled = true; });
    await baris.screenshot({ path: "test-results/fiori-file-input-summary-1366-nonaktif.png" });
    await periksa(berkas, tetangga, 32, "--surface-3"); // nonaktif: latar --surface-3, bukan --surface-2 maupun hijau Surya
    expect(await berkas.evaluate((el) => getComputedStyle(el, "::file-selector-button").cursor)).toBe("default");
});
