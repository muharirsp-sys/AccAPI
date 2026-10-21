/*
 * Tujuan: R4 NOO — kartu toko baru (kode NOO) di "Rute hari ini" memperlihatkan STATUS PENGAJUAN (Menunggu SPV / Disetujui / Ditolak /
 *   Terdaftar, label LABEL_STATUS_NOO) + alasan tolak dalam teks kecil; toko DITOLAK tetap di rute hari itu (kunjungan sudah terjadi) dan
 *   bertanda jelas; pelanggan luar rute biasa & baris JKS tanpa tanda NOO; server lama tanpa status = teks lama. Salesman 390 px.
 *   Data generik (TOKO BARU A…, PELANGGAN A, PRINCIPLE A).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true): `npx playwright test tests/fiori-noo-status-rute.spec.ts --config playwright.fiori-local.config.ts`.
 * Dependensi: /api/form-kontrol/* di-mock (page.route). Tidak menyentuh DB.
 * Side Effects: Tangkapan di test-results/noo.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const SALESMAN = { role: "salesman", salesCode: "S-01", salesName: "SALES A", spvName: "SPV A", allowedSalesCodes: ["S-01"], principles: ["PRINCIPLE A"],
    principalCabang: null, alasanCabang: null };
const baris = (custCode: string, custName: string, over: Record<string, unknown> = {}) => ({ id: `r-${custCode}`, salesCode: "S-01", custCode, custName,
    principle: "PRINCIPLE A", aoStatus: null, monthlyOrderCount: 0, needsAttention: false, checkinAt: null, checkoutAt: null, luarRute: false,
    nooStatus: null, nooAlasanTolak: null, ...over });
const ALASAN = "Toko ternyata cabang pelanggan lama.";
const RUTE = [
    baris("C-100001", "PELANGGAN A"),
    baris("NOO-7K3Q9ZTA", "TOKO BARU A", { luarRute: true, nooStatus: "menunggu_spv" }),
    baris("NOO-8M4R2YUB", "TOKO BARU B", { luarRute: true, nooStatus: "ditolak", nooAlasanTolak: ALASAN, aoStatus: "not_order",
        checkinAt: "2026-10-17T09:00:00+08:00", checkoutAt: "2026-10-17T09:10:00+08:00" }),
    baris("NOO-9N5S3XVC", "TOKO BARU C", { luarRute: true, nooStatus: "disetujui" }),
    baris("NOO-2P6T4WWD", "TOKO BARU D", { luarRute: true, nooStatus: "terdaftar" }),
    baris("C-200014-CBA", "TOKO LAIN SEKALI", { luarRute: true }),
    // Server lama (belum mengirim status): kartu NOO tetap seperti sebelum R4.
    baris("NOO-5Q7U8ZYE", "TOKO BARU E", { luarRute: true, nooStatus: undefined, nooAlasanTolak: undefined }),
];

async function mockFk(page: Page) {
    await page.route("**/api/form-kontrol/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace("/api/form-kontrol/", "");
        if (p === "my-scope") return route.fulfill(json(SALESMAN));
        if (p === "reasons") return route.fulfill(json({ rows: [] }));
        if (p === "ao-control" && req.method() === "GET") return route.fulfill(json({ rows: RUTE, summary: {}, date: url.searchParams.get("date") }));
        return route.fulfill(json({ rows: [] }));
    });
}

test.describe.configure({ timeout: 150_000 });
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("kartu rute NOO: badge status pengajuan + alasan tolak; ditolak tetap di rute; non-NOO tanpa tanda; server lama = teks lama", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await mockFk(page);
    await page.goto("/form-kontrol?tab=ao", NAV);
    const daftar = page.getByRole("region", { name: "Rute hari ini" }).getByRole("list", { name: "Toko di rute" });
    await expect(daftar.getByRole("listitem")).toHaveCount(RUTE.length, NAV);
    const kartu = (nama: string) => daftar.getByRole("listitem").filter({ hasText: nama });
    const badge = (nama: string, label: string) => kartu(nama).locator(".fi-badge", { hasText: label });

    await expect(badge("TOKO BARU A", "Menunggu SPV")).toHaveCount(1);
    await expect(badge("TOKO BARU C", "Disetujui — menunggu didaftarkan")).toHaveCount(1);
    await expect(badge("TOKO BARU D", "Terdaftar")).toHaveCount(1);
    // Ditolak: tetap di rute (kunjungan sudah terjadi), bertanda + alasan; badge kunjungan tetap ada (Tidak order).
    await expect(badge("TOKO BARU B", "Ditolak")).toHaveCount(1);
    await expect(kartu("TOKO BARU B")).toContainText(`Alasan ditolak: ${ALASAN}`);
    await expect(kartu("TOKO BARU B").locator(".fi-badge", { hasText: "Tidak order" })).toHaveCount(1);
    // Pembaca layar: badge status pengajuan dibedakan dari badge kunjungan.
    await expect(badge("TOKO BARU B", "Ditolak").locator(".sr-only")).toHaveText("Status pengajuan: ");
    // Alasan hanya pada yang ditolak.
    await expect(daftar.getByText("Alasan ditolak:")).toHaveCount(1);
    // Bukan NOO / server lama: tanpa badge status pengajuan.
    for (const nama of ["PELANGGAN A", "TOKO LAIN SEKALI", "TOKO BARU E"]) {
        for (const label of ["Menunggu SPV", "Disetujui", "Ditolak", "Terdaftar"]) await expect(badge(nama, label), `${nama} / ${label}`).toHaveCount(0);
    }
    await expect(kartu("TOKO LAIN SEKALI")).toContainText("Luar rute");
    await expect(kartu("TOKO BARU E")).toContainText("Toko baru (NOO) · tanpa order");
    await expect(kartu("TOKO BARU A")).toContainText("Toko baru (NOO) · tanpa order");

    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
    await daftar.screenshot({ path: "test-results/noo/r4-status-kartu-rute.png" });
});
