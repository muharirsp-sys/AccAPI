/*
 * Tujuan: Beranda per peran (S1b): tile dari endpoint yang ada, galat per sumber, semua beres, memuat, ponsel.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin); peran lain lewat ?peran= (id profil) atau ?grup= (nama ★ grup utama,
 *   S7-3) — keduanya hanya development.
 * Dependensi: halaman /, respons endpoint di-mock dengan page.route (tidak menyentuh DB/Accurate).
 * Main Functions: fakturist (tile, pantauan, galat per sumber, coba lagi), gudang (tanggal WITA), semua beres, memuat, ponsel,
 *   profil dari ★ grup utama (SPV, OM, Kasir, Manager, fallback), K3 tiga tile Kasir (angka, belum terbaca, galat, OM tanpa tile).
 * Side Effects: Tangkapan di test-results.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const OUTBOX = { ok: true, escalateAfterMinutes: 120, summary: { queued: 7, sending: 0, unknown: 1, rejected: 2 }, overdue: 3, overdueQueue: 3, overdueBatches: 0, pendingBatches: [{ reviewCount: 6 }, { reviewCount: 2 }], rows: [] };
const RINGKASAN_KASIR = { ok: true, tanggal: "2026-10-17", sekarang: "2026-10-17T02:00:00.000Z",
    incaso: { lengkap: true, sebab: null, pesan: null }, baca: { status: "lengkap", lengkapPada: "2026-10-17T01:55:00.000Z" },
    selisih: { orang: 2, takTeralokasi: 1, jumlah: 3 }, belumSetor: { jumlah: 4, belumDijelaskan: 3 },
    hariBelumDitutup: { jumlah: 3, tanggal: ["2026-10-14", "2026-10-16", "2026-10-17"], jendela: [] } };
const VERIFY = { ok: true, checked: 100, summary: { cocok: 98, selisih: 1, dijelaskan: 1, "tak-terperiksa": 0 }, rows: [] };

async function mockFakturist(page: Page, verify: () => ReturnType<typeof json>) {
    await page.route("**/api/invoice-outbox", (route) => route.fulfill(json(OUTBOX)));
    await page.route("**/api/invoice-verify", (route) => route.fulfill(verify()));
}

test("fakturist: tiles count from the queue, verification error stays local and can be retried", async ({ page }) => {
    let verifyOk = false;
    await mockFakturist(page, () => (verifyOk ? json(VERIFY) : json({ ok: false, error: "x" }, 500)));
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/?peran=fakturist");
    await expect(page.getByRole("heading", { level: 1, name: /^Selamat (pagi|siang|sore|malam), / })).toBeVisible();
    const tugas = page.getByRole("region", { name: /Perlu tindakan/ });
    const antrean = tugas.getByRole("link", { name: /Antrean belum terkirim/ });
    await expect(antrean).toContainText("10"); // 7 antre + 1 tidak pasti + 2 ditolak
    await expect(antrean).toContainText("3 lewat 2 jam · 2 ditolak · 1 tidak pasti");
    await expect(antrean).toHaveAttribute("href", "/antrean-faktur");
    await expect(tugas.getByRole("link", { name: /Batch perlu tinjau/ })).toContainText("8 baris perlu tinjau");
    // Galat satu sumber: tile itu menyatakan gagal, tile lain tetap berangka; strip menyebut sumbernya.
    const selisih = tugas.getByRole("button", { name: /Selisih verifikasi/ });
    await expect(selisih).toContainText("Tidak bisa dimuat");
    await expect(page.getByRole("alert").filter({ hasText: "Verifikasi balik faktur gagal dimuat." })).toBeVisible();
    await expect(page.getByRole("region", { name: "Pantauan" })).toContainText("Ditolak Accurate");
    await page.screenshot({ path: "test-results/fiori-beranda-fakturist-galat.png", fullPage: true });
    verifyOk = true;
    await selisih.click();
    await expect(tugas.getByRole("link", { name: /Selisih verifikasi/ })).toContainText("Dari 100 faktur terbaru");
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0); // di luar main ada pengumum rute Next (role=alert)
    await page.screenshot({ path: "test-results/fiori-beranda-fakturist.png", fullPage: true });
});

test("gudang: wave and kanvas are requested for today in WITA", async ({ page }) => {
    const urls: string[] = [];
    await page.route((url) => url.pathname === "/api/rekapan-nota/wave", (route) => { urls.push(route.request().url()); return route.fulfill(json({ wave: [
        { id: 316, nama: "Pagi 1", status: "dikonfirmasi", jumlah_nota: 131, exception_open: 0 },
        { id: 317, nama: "Pagi 2", status: "rilis", jumlah_nota: 93, exception_open: 4 },
    ] })); });
    await page.route((url) => url.pathname === "/api/rekapan-nota/kanvas", (route) => { urls.push(route.request().url()); return route.fulfill(json({ jumlahNota: 218, ditandai: 6, nihil: 0 })); });
    await page.goto("/?peran=gudang");
    const tugas = page.getByRole("region", { name: /Perlu tindakan/ });
    await expect(tugas.getByRole("link", { name: /Exception terbuka/ })).toContainText("4");
    await expect(tugas.getByRole("link", { name: /Nota kanvas/ })).toContainText("Dari 218 nota hari ini");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const url of urls) expect(new URL(url).searchParams.get("tanggal")).toBe(today);
    await expect(page.getByRole("region", { name: "Pantauan" })).toContainText("Pagi 2");
});

test("all clear when every count is zero, and tiles show skeletons while loading", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/invoice-outbox", async (route) => { await gate; return route.fulfill(json({ ...OUTBOX, summary: {}, overdueQueue: 0, pendingBatches: [] })); });
    await page.route("**/api/invoice-verify", async (route) => { await gate; return route.fulfill(json({ ...VERIFY, summary: { selisih: 0 } })); });
    await page.goto("/?peran=fakturist");
    const tugas = page.getByRole("region", { name: /Perlu tindakan/ });
    await expect(tugas.getByText("memuat…")).toBeVisible();
    await expect(tugas.locator('[aria-busy="true"]')).toHaveCount(3);
    release();
    await expect(tugas.getByText("Tidak ada yang perlu Anda tindak lanjuti")).toBeVisible();
    await expect(tugas.getByText("semua beres")).toBeVisible();
});

test("mobile: two-column tiles, shortcuts and no horizontal scroll", async ({ page }) => {
    await mockFakturist(page, () => json(VERIFY));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?peran=fakturist");
    await expect(page.getByRole("region", { name: /Perlu tindakan/ }).getByRole("link", { name: /Antrean belum terkirim/ })).toContainText("10");
    await expect(page.getByRole("region", { name: "Pintasan" }).getByRole("link")).toHaveCount(4);
    expect(await page.evaluate(() => { const main = document.querySelector("main")!; return document.documentElement.scrollWidth <= innerWidth && main.scrollWidth <= main.clientWidth + 1; })).toBe(true);
    await page.screenshot({ path: "test-results/fiori-beranda-fakturist-390.png", fullPage: true });
});

test("S7-3: profil Beranda mengikuti ★ grup utama (SPV, OM, Kasir, Manager); grup custom / tanpa grup = tebakan izin", async ({ page }) => {
    await page.route("**/api/off-program-control/batches", (route) => route.fulfill(json({ batches: [{ noPengajuan: "OFF-A-1", principleName: "PRINCIPLE A", supervisorName: "SPV A", status: "Submitted to SM", smStatus: "Waiting Review" }] })));
    await page.route("**/api/admin/users/permissions", (route) => route.fulfill(json({ users: [] })));
    const tugas = page.getByRole("region", { name: /Perlu tindakan/ });
    const buka = async (query: string) => {
        await page.goto(`/${query}`);
        await expect(page.getByRole("heading", { level: 1, name: /^Selamat (pagi|siang|sore|malam), / })).toBeVisible();
        const links = page.getByRole("region", { name: "Pintasan" }).getByRole("link");
        await expect(links).toHaveCount(4); // izin admin (bypass): kekurangan diisi halaman lain yang boleh dibuka
        return links.evaluateAll((els) => els.map((el) => el.getAttribute("href")));
    };

    expect((await buka("?grup=SPV")).slice(0, 3)).toEqual(["/supervisor-review", "/form-kontrol", "/insentif-sales"]);
    await expect(tugas).toHaveCount(0); // profil baru tidak memuat tugas peran lain
    await page.screenshot({ path: "test-results/fiori-beranda-s73-spv.png", fullPage: true });
    expect((await buka("?grup=om")).slice(0, 3)).toEqual(["/kasir", "/pelunasan", "/finance"]);
    await expect(tugas).toHaveCount(0);
    await page.route((url) => url.pathname === "/api/kasir/ringkasan", (route) => route.fulfill(json(RINGKASAN_KASIR)));
    expect((await buka("?grup=%20KASIR%20"))[0]).toBe("/kasir");
    await expect(tugas.getByRole("link")).toHaveCount(3); // K3: tiga tile Kasir (tanpa tile peran lain)

    expect(await buka("?grup=Manager")).toEqual(["/off-program-control", "/form-kontrol", "/insentif-sales", "/supervisor-review"]);
    await expect(tugas.getByRole("link", { name: /Persetujuan OFF/ })).toContainText("1");
    await expect(page.getByRole("region", { name: "Pantauan" })).toContainText("OFF-A-1");

    // Fallback: tanpa grup utama dan grup custom (nama memuat kata preset) = tebakan izin (bypass = admin).
    for (const query of ["", "?grup=Gudang%20CABANG%20A", "?grup=Staff"]) {
        expect((await buka(query)).slice(0, 3), query).toEqual(["/admin/groups", "/api-wrapper", "/principles"]);
        await expect(tugas.getByRole("link", { name: /User tanpa grup/ })).toBeVisible();
    }
});

test("K3: profil Kasir — tiga tile dari ringkasan; belum terbaca bukan 0 dan bukan semua beres; galat tidak jadi nol; OM tanpa tile Kasir", async ({ page }) => {
    const urls: string[] = [];
    let jawab: () => ReturnType<typeof json> = () => json(RINGKASAN_KASIR);
    await page.route((url) => url.pathname === "/api/kasir/ringkasan", (route) => { urls.push(route.request().url()); return route.fulfill(jawab()); });
    const tugas = page.getByRole("region", { name: /Perlu tindakan/ });
    const tile = (nama: RegExp) => tugas.getByRole("link", { name: nama });

    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/?grup=Kasir");
    await expect(tile(/Selisih belum dijelaskan/)).toContainText("3");
    await expect(tile(/Selisih belum dijelaskan/)).toContainText("2 selisih orang · 1 uang tak teralokasi");
    await expect(tile(/Salesman belum menyetor/)).toContainText("4");
    await expect(tile(/Salesman belum menyetor/)).toContainText("3 belum dijelaskan");
    await expect(tile(/Hari belum ditutup/)).toContainText("Termasuk hari ini · terlama 14 Okt");
    await expect(tile(/Hari belum ditutup/)).toContainText("minta OM/Admin membuka kembali");
    for (const nama of [/Selisih belum dijelaskan/, /Salesman belum menyetor/, /Hari belum ditutup/]) await expect(tile(nama)).toHaveAttribute("href", "/kasir");
    await expect(tugas.getByRole("link")).toHaveCount(3);
    // Satu sumber bersama untuk ketiga tile (bukan satu permintaan per tile; dev StrictMode boleh menggandakan efek menjadi 2), tanggal = hari ini WITA.
    const hariIni = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls.length).toBeLessThanOrEqual(2);
    for (const url of urls) expect(new URL(url).searchParams.get("tanggal")).toBe(hariIni);
    await page.screenshot({ path: "test-results/fiori-beranda-k3-kasir.png", fullPage: true });

    // Incaso belum lengkap: tile 1-2 "belum terbaca" (bukan 0, bukan "semua beres"); tile 3 tetap berangka.
    jawab = () => json({ ...RINGKASAN_KASIR, incaso: { lengkap: false, sebab: "BACA_BELUM_LENGKAP", pesan: "x" }, baca: { status: "sebagian", lengkapPada: null }, selisih: null, belumSetor: null });
    await page.goto("/?grup=Kasir");
    for (const nama of [/Selisih belum dijelaskan/, /Salesman belum menyetor/]) {
        await expect(tile(nama)).toContainText("belum terbaca");
        await expect(tile(nama)).not.toContainText(/(^|\s)0(\s|$)/);
    }
    await expect(tile(/Hari belum ditutup/)).toContainText("3");
    await expect(tugas.getByText("semua beres")).toHaveCount(0);
    // Semua nol dan lengkap = semua beres.
    jawab = () => json({ ...RINGKASAN_KASIR, selisih: { orang: 0, takTeralokasi: 0, jumlah: 0 }, belumSetor: { jumlah: 0, belumDijelaskan: 0 }, hariBelumDitutup: { jumlah: 0, tanggal: [], jendela: [] } });
    await page.goto("/?grup=Kasir");
    await expect(tugas.getByText("semua beres")).toBeVisible();
    // Semua Incaso belum terbaca TIDAK boleh jadi "semua beres" walau Tutup nol.
    jawab = () => json({ ...RINGKASAN_KASIR, incaso: { lengkap: false, sebab: "SESI_SINKRON", pesan: "x" }, baca: null, selisih: null, belumSetor: null, hariBelumDitutup: { jumlah: 0, tanggal: [], jendela: [] } });
    await page.goto("/?grup=Kasir");
    await expect(tile(/Salesman belum menyetor/)).toContainText("Sesi Accurate akun sinkron belum tersedia");
    await expect(tugas.getByText("semua beres")).toHaveCount(0);
    // Jawaban tanpa angka dan HTTP 500 = galat (Coba lagi), tidak pernah nol.
    for (const bad of [() => json({ ok: true }), () => json({ ok: false, kode: "GALAT_INTERNAL" }, 500)]) {
        jawab = bad;
        await page.goto("/?grup=Kasir");
        await expect(tugas.getByRole("button", { name: /Selisih belum dijelaskan/ })).toContainText("Tidak bisa dimuat");
        await expect(page.getByRole("alert").filter({ hasText: "Ringkasan Kasir gagal dimuat." })).toBeVisible();
        await expect(tugas.getByText("semua beres")).toHaveCount(0);
    }

    // OM memegang kasir.view tetapi tidak mendapat tile Kasir dan tidak memanggil ringkasan.
    const sebelum = urls.length;
    await page.goto("/?grup=om");
    await expect(page.getByRole("region", { name: "Pintasan" }).getByRole("link").first()).toHaveAttribute("href", "/kasir");
    await expect(tugas).toHaveCount(0);
    expect(urls.length).toBe(sebelum);
});
