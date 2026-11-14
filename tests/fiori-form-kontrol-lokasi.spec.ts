/*
 * Tujuan: Tab Validasi Lokasi Form Kontrol (owner 14 Nov 2026): ringkasan status titik, pengajuan lokasi ke IT (setujui + pindah titik / tolak
 *   beralasan), antrean perbaikan lokasi (tetapkan titik tengah), unggah berkas status titik (multipart). Payload ke /api/form-kontrol/lokasi.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin): `npx playwright test tests/fiori-form-kontrol-lokasi.spec.ts`.
 * Dependensi: /api/form-kontrol/* di-mock dengan page.route (tidak menyentuh DB). Side Effects: tangkapan di test-results/lokasi.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const SCOPE = { role: "admin", allowedSalesCodes: null, principles: ["PRINCIPLE A"] };
const AJUAN = [
    { id: "aj-1", salesCode: "S-01", custCode: "C-01", custName: "TOKO A", principle: "PRINCIPLE A", tanggal: "2026-11-14", tahap: "checkin",
        lat: -5.1477, lng: 119.4335, akurasi: 12, titikLat: -5.1477, titikLng: 119.4327, statusTitik: "fix", jarakM: 85, radiusM: 20,
        alasan: "titik toko di peta salah, toko di belakang pasar", status: "menunggu", diajukanPada: "2026-11-14T01:00:00Z", catatanPutusan: null, titikDipindah: false },
    { id: "aj-2", salesCode: "S-02", custCode: "C-02", custName: "TOKO B", principle: "PRINCIPLE A", tanggal: "2026-11-14", tahap: "checkout",
        lat: -5.16, lng: 119.44, akurasi: 30, titikLat: -5.15, titikLng: 119.44, statusTitik: "validasi", jarakM: 1112, radiusM: 100,
        alasan: "check-out di gudang toko yang terpisah", status: "menunggu", diajukanPada: "2026-11-14T02:00:00Z", catatanPutusan: null, titikDipindah: false },
];
const ANTREAN = [{
    custCode: "C-03", custName: "TOKO C", alamat: "JL. CONTOH 3", kota: "KOTA A", titikSekarang: null,
    tengah: { lat: -5.1401, lng: 119.4201, sebaranM: 18, jumlah: 3, salesman: 2 },
    checkin: [{ salesCode: "S-01", tanggal: "2026-11-13", lat: -5.1401, lng: 119.4201, akurasi: 8 }, { salesCode: "S-02", tanggal: "2026-11-12", lat: -5.1402, lng: 119.4202, akurasi: 15 }],
}];

async function mock(page: Page) {
    const tulis: Request[] = [];
    await page.route("**/api/form-kontrol/**", (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace("/api/form-kontrol/", "");
        if (req.method() !== "GET") tulis.push(req);
        if (p === "my-scope") return route.fulfill(json(SCOPE));
        if (p === "lokasi" && req.method() === "GET") {
            const bagian = url.searchParams.get("bagian");
            if (bagian === "pengajuan") return route.fulfill(json({ rows: url.searchParams.get("status") === "menunggu" ? AJUAN : [] }));
            if (bagian === "antrean") return route.fulfill(json({ rows: ANTREAN }));
            return route.fulfill(json({ ringkasan: { tokoJks: 1200, fix: 900, validasi: 40, tanpaTitik: 260, pengajuanMenunggu: 2 } }));
        }
        if (p === "lokasi") return route.fulfill(json({ success: true, ditandaiValidasi: 40, ditetapkanFix: 2, tanpaTitik: 5, titikDipindah: true }));
        return route.fulfill(json({ rows: [] }));
    });
    return tulis;
}

test("Validasi Lokasi: ringkasan, setujui + pindah titik, tolak beralasan, tetapkan titik tengah, unggah status titik", async ({ page }) => {
    const tulis = await mock(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/form-kontrol?tab=lokasi", NAV);
    const r = page.getByRole("region", { name: "Validasi lokasi toko" });
    await expect(r.getByRole("heading", { name: "Validasi Lokasi" })).toBeVisible(NAV);
    await expect(r.getByText("Pengajuan menunggu IT")).toBeVisible();
    const tabel = r.getByRole("table", { name: "Pengajuan lokasi" });
    const a = tabel.getByRole("row").filter({ hasText: "TOKO A" });
    await expect(a).toContainText("85 m (batas 20 m)");
    await expect(a).toContainText("Titik fix · akurasi GPS ±12 m");
    await expect(a.getByRole("link", { name: "Titik salesman" })).toHaveAttribute("href", /query=-5\.147700,119\.433500/);
    await page.screenshot({ path: "test-results/lokasi/validasi-lokasi.png", fullPage: true });

    // Setujui (check-in): pindah titik TIDAK tercentang bawaan (titik salesman bisa saja bukan toko); dicentang sadar.
    await a.getByRole("button", { name: "Setujui…" }).click();
    const d1 = page.getByRole("dialog", { name: /Setujui check-in di luar batas/ });
    await expect(d1).toContainText("±12 m");
    const pindah = d1.getByRole("checkbox", { name: "Pindahkan titik toko ke lokasi salesman" });
    await expect(pindah).not.toBeChecked();
    await pindah.check();
    await d1.getByRole("button", { name: "Setujui" }).click();
    await expect(r.getByText(/TOKO A disetujui; titik toko dipindah/)).toBeVisible();

    // Tolak (check-out): alasan wajib.
    await tabel.getByRole("row").filter({ hasText: "TOKO B" }).getByRole("button", { name: "Tolak…" }).click();
    const d2 = page.getByRole("dialog", { name: /Tolak check-out di luar batas/ });
    await expect(d2.getByRole("button", { name: "Tolak pengajuan" })).toBeDisabled();
    await d2.getByRole("textbox").fill("bukan di toko");
    await d2.getByRole("button", { name: "Tolak pengajuan" }).click();
    await expect(r.getByText("Pengajuan TOKO B ditolak.")).toBeVisible();

    // Antrean: tetapkan titik tengah.
    await expect(r.getByText("3 check-in dari 2 salesman · titik tengah, sebaran ±18 m")).toBeVisible();
    await r.getByRole("button", { name: "Tetapkan titik tengah…" }).click();
    await page.getByRole("dialog", { name: "Tetapkan titik toko?" }).getByRole("button", { name: "Tetapkan titik" }).click();
    await expect(r.getByText("Titik TOKO C ditetapkan (fix).")).toBeVisible();

    const json1 = tulis.filter((q) => (q.headers()["content-type"] ?? "").includes("application/json")).map((q) => q.postDataJSON());
    expect(json1).toEqual([
        { aksi: "putuskan", id: "aj-1", keputusan: "disetujui", pindahTitik: true },
        { aksi: "putuskan", id: "aj-2", keputusan: "ditolak", catatan: "bukan di toko" },
        { aksi: "tetapkan", custCode: "C-03", lat: -5.1401, lng: 119.4201 },
    ]);

    // Unggah status titik: multipart `file`.
    await r.getByRole("button", { name: "Unggah status titik" }).click();
    const d3 = page.getByRole("dialog", { name: "Terapkan status titik toko?" });
    await expect(d3.getByRole("button", { name: "Terapkan status" })).toBeDisabled();
    await d3.locator('input[type="file"]').setInputFiles({ name: "selisih_titik_alamat.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("PK") });
    await d3.getByRole("button", { name: "Terapkan status" }).click();
    await expect(r.getByText(/40 titik ditandai perlu validasi, 2 titik fix dari kolom BENAR; 5 toko di berkas belum punya titik/)).toBeVisible();
    const multipart = tulis.filter((q) => (q.headers()["content-type"] ?? "").includes("multipart/form-data"));
    expect(multipart).toHaveLength(1);
    expect(multipart[0].postData() ?? "").toContain('name="file"; filename="selisih_titik_alamat.xlsx"');
});
