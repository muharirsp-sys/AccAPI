/*
 * Tujuan: Rekapan Nota Fiori (S2): Wave harian, Object Page wave, Nota kanvas, Mapping area — enam keadaan dan dialog pengganti prompt/confirm.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin): `npx playwright test tests/fiori-rekapan-nota.spec.ts`.
 * Dependensi: endpoint /api/rekapan-nota/* di-mock dengan page.route (tidak menyentuh DB/Accurate).
 * Main Functions: wave harian (default/galat unggah/kosong/memuat/dialog wave baru), object page (rilis ditahan, lepas 409, pool saring+pilih),
 *   kanvas (tandai 409, nihil), area (draf, terima Tinggi, memuat lama, galat), ponsel tanpa gulir menyamping, tanpa window.confirm/prompt.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const path = (p: string) => (url: URL) => url.pathname === p;

const WAVES = [
    { id: 316, tanggal: "2026-10-06", urutan: 1, nama: "Pagi 1", tipe: "reguler", status: "confirmed", jumlah_nota: 131, exception_open: 0 },
    { id: 317, tanggal: "2026-10-06", urutan: 2, nama: "Pagi 2", tipe: "reguler", status: "released", jumlah_nota: 93, exception_open: 4 },
    { id: 318, tanggal: "2026-10-06", urutan: 3, nama: "Sore", tipe: "reguler", status: "draft", jumlah_nota: 0, exception_open: 0 },
];
const POOL_NOTA = [
    { no_nota: "INV/2610/KN01381", kode_cust: "C1", customer: "TK HARAPAN BARU", salesman: "M-022 · Yusuf", area: "4", jumlah_baris: 9, total_pcs: 148, total_krt: 6, pareto: false },
    { no_nota: "INV/2610/KN01402", kode_cust: "C2", customer: "MIDI GOWA 2", salesman: "M-007 · Rahmat", area: "PGS", jumlah_baris: 4, total_pcs: 40, total_krt: 2.5, pareto: false },
    { no_nota: "INV/2610/KN01408", kode_cust: "C3", customer: "IDM DAENG TATA", salesman: "M-011 · Sinta", area: "5", jumlah_baris: 27, total_pcs: 600, total_krt: 52, pareto: true },
];
const POOL = { tanggal: "2026-10-06", tipe: "reguler", jumlahNota: 212, kanvasNihilOleh: null, tanpaArea: 19, disembunyikan: 6, nota: POOL_NOTA };
const PICK = [
    { id: 1, kode: "AREA-1", nama: "Area 1 / 10 / Pinggiran Utara", dimensi: "Area" }, { id: 2, kode: "AREA-2", nama: "Area 2 / 6 / 11", dimensi: "Area" },
    { id: 7, kode: "VOL-PARETO", nama: "Pareto", dimensi: "Volume" }, { id: 8, kode: "VOL-NONPARETO", nama: "Non Pareto", dimensi: "Volume" },
];
const DETAIL_RILIS = {
    wave: WAVES[1],
    nota: [
        { no_nota: "INV/2610/KN01388", prioritas: "urgent", snap_area: null, snap_pareto: true, snap_total_krt: 62.5, dilepas: false, dilepas_alasan: null, dilepas_at: null, dilepas_oleh: null, customer: "TK ANUGERAH", salesman: null, jumlah_baris: 10, total_pcs: 100 },
        { no_nota: "INV/2610/KN01391", prioritas: "normal", snap_area: "7", snap_pareto: false, snap_total_krt: 3, dilepas: false, dilepas_alasan: null, dilepas_at: null, dilepas_oleh: null, customer: "ALFAMART PETTARANI", salesman: null, jumlah_baris: 4, total_pcs: 30 },
        { no_nota: "INV/2610/KN01380", prioritas: "normal", snap_area: "2", snap_pareto: false, snap_total_krt: 5, dilepas: true, dilepas_alasan: "outlet tutup", dilepas_at: "2026-10-06T01:40:00Z", dilepas_oleh: "Bayu", customer: "UD SUMBER REJEKI", salesman: null, jumlah_baris: 3, total_pcs: 20 },
    ],
    exception: [
        { id: 1, jenis: "KONVERSI_BEDA_DENGAN_EXPORT", ref_tipe: "item", ref_kode: "ABC10520", keterangan: "Konversi di export 24 beda dengan master 12", status: "open" },
        { id: 2, jenis: "KONVERSI_TIDAK_ADA", ref_tipe: "item", ref_kode: "ABC21135", keterangan: "Item tidak punya isi per karton", status: "open" },
        { id: 3, jenis: "OUTLET_TANPA_AREA", ref_tipe: "customer", ref_kode: "C-MKS0418", keterangan: "Outlet belum punya area", status: "open" },
        { id: 4, jenis: "PRINCIPAL_BELUM_MASUK", ref_tipe: "principal", ref_kode: "FORISA", keterangan: "Ada di 30 hari terakhir", status: "open" },
    ],
    pickGroup: [PICK[0], PICK[3]], pickGroupTersedia: PICK,
    riwayat: [
        { event: "wave.released", created_at: "2026-10-06T01:05:00Z", payload: { jumlah_nota: 94, exception_open: 4 }, aktor: "Bayu" },
        { event: "wave.created", created_at: "2026-10-06T00:42:00Z", payload: { urutan: 2, tipe: "reguler" }, aktor: "Bayu" },
    ],
};
const DETAIL_DRAF = { wave: WAVES[2], nota: [], exception: [], pickGroup: [], pickGroupTersedia: PICK, riwayat: [] };
const KANVAS = {
    tanggal: "2026-10-06", jumlahNota: 4, ditandai: 1, nihil: null,
    nota: [
        { no_nota: "INV/2610/KN01384", kode_salesman: "M-014", salesman: "Irfan Hakim", customer: "TK BAHAGIA", jumlah_baris: 7, total_pcs: 84, kanvas: true, terkunci: false, di_wave: false },
        { no_nota: "INV/2610/KN01381", kode_salesman: "M-022", salesman: "Yusuf", customer: "TK HARAPAN BARU", jumlah_baris: 9, total_pcs: 148, kanvas: false, terkunci: null, di_wave: false },
        { no_nota: "INV/2610/KN01382", kode_salesman: "M-022", salesman: "Yusuf", customer: "TK FAJAR", jumlah_baris: 4, total_pcs: 40, kanvas: false, terkunci: null, di_wave: false },
        { no_nota: "INV/2610/KN01386", kode_salesman: "M-007", salesman: "Rahmat", customer: "TOKO BERKAH ABADI", jumlah_baris: 8, total_pcs: 96, kanvas: false, terkunci: null, di_wave: true },
    ],
};
const AREA = {
    jumlah: 3, dapatUsulan: 2, tinggi: 1,
    outlet: [
        { kode: "C-MKS0418", nama: "TK ANUGERAH", alamat: "Jl. Perintis Kemerdekaan KM 12, Tamalanrea", jumlah_nota: 14, usulan: "1", keyakinan: "TINGGI", alasan: "Kelurahan Tamalanrea: 9 dari 9 outlet ada di area 1" },
        { kode: "C-GWA0107", nama: "TK NUR IMAN", alamat: "Jl. Poros Malino", jumlah_nota: 6, usulan: "PGS", keyakinan: "SEDANG", alasan: "5 dari 6 outlet di area PGS" },
        { kode: "C-MRS0033", nama: "TK SUMBER REZEKI", alamat: "Jl. Poros Maros KM 30", jumlah_nota: 2, usulan: null, keyakinan: null, alasan: "Tidak ada outlet berarea yang cocok" },
    ],
};

async function noNativeDialogs(page: Page) {
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
}
async function noHorizontalOverflow(page: Page) {
    expect(await page.evaluate(() => {
        const main = document.querySelector("main");
        return document.documentElement.scrollWidth <= innerWidth && (!main || main.scrollWidth <= main.clientWidth + 1);
    })).toBe(true);
}
const NAV = { timeout: 60_000 } as const;

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await noNativeDialogs(page);
});

test.describe("Wave harian", () => {
    test("default: kartu ringkas + daftar; galat unggah tampil di halaman; dialog Wave baru mengirim urutan berikutnya", async ({ page }) => {
        let dibuat: unknown = null;
        await page.route(path("/api/rekapan-nota/wave"), (route) => {
            if (route.request().method() === "POST") { dibuat = route.request().postDataJSON(); return route.fulfill(json({ id: 319 }, 201)); }
            return route.fulfill(json({ wave: WAVES }));
        });
        await page.route(path("/api/rekapan-nota/pool"), (route) => route.fulfill(json(POOL)));
        await page.route(path("/api/rekapan-nota/upload"), (route) => route.fulfill(json({ error: "Tidak ada baris penjualan bruto bertanggal 2026-10-06 di file ini.", tanggalTersedia: ["2026-10-03", "2026-10-04"] }, 422)));
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto("/rekapan-nota", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("heading", { level: 1 })).toContainText("Wave", NAV);
        await expect(main.getByText("Pool reguler")).toBeVisible();
        await expect(main.getByRole("link", { name: /Exception terbuka/ })).toContainText("4");
        await expect(main.getByRole("link", { name: /Outlet tanpa area/ })).toContainText("19");
        const tabel = main.getByRole("table", { name: "Wave" });
        await expect(tabel.getByRole("row")).toHaveCount(4);
        await expect(tabel).toContainText("Dikonfirmasi");
        await expect(tabel).toContainText("Rilis");
        await expect(tabel).not.toContainText("released"); // tidak ada kode status mentah
        await page.screenshot({ path: "test-results/fiori-rekapan-wave-harian.png", fullPage: true });

        // Unggah: galat tampil sebagai strip di halaman, daftar wave tetap terlihat, berkas tetap sebagai draf.
        await main.getByRole("button", { name: "Unggah file export…" }).click();
        const dlg = page.getByRole("dialog");
        await expect(dlg.getByRole("button", { name: "Unggah ke pool" })).toBeDisabled();
        await dlg.getByLabel(/File export/).setInputFiles({ name: "Rincian Faktur 05-10.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("x") });
        await dlg.getByRole("button", { name: "Unggah ke pool" }).click();
        await expect(main.getByRole("alert")).toContainText("Tidak ada baris penjualan bruto");
        await expect(main.getByRole("alert")).toContainText("03/10/2026, 04/10/2026");
        await expect(tabel.getByRole("row")).toHaveCount(4);
        await expect(main.getByText(/dipilih untuk \d{2}\/\d{2}\/\d{4}, belum diunggah/)).toBeVisible();
        await page.screenshot({ path: "test-results/fiori-rekapan-wave-harian-galat.png", fullPage: true });

        // Wave baru: nama wajib; urutan dihitung dari daftar (3 setelah Sore).
        await main.getByRole("button", { name: "Wave baru…" }).click();
        await expect(page.getByRole("dialog").getByRole("button", { name: "Buat wave" })).toBeDisabled();
        await expect(page.getByRole("dialog")).toContainText("4, setelah Sore");
        await page.getByRole("dialog").getByLabel("Nama").fill("Malam");
        await page.getByRole("dialog").getByRole("button", { name: "Buat wave" }).click();
        await expect(page.getByRole("dialog")).toBeHidden();
        expect(dibuat).toMatchObject({ urutan: 4, nama: "Malam", tipe: "reguler" });
    });

    test("kosong: pool dan wave nihil → keadaan kosong + catatan BL-55; memuat: kerangka, bukan 'Belum ada wave'", async ({ page }) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });
        await page.route(path("/api/rekapan-nota/wave"), async (route) => { await gate; return route.fulfill(json({ wave: [] })); });
        await page.route(path("/api/rekapan-nota/pool"), async (route) => { await gate; return route.fulfill(json({ ...POOL, jumlahNota: 0, disembunyikan: 0, tanpaArea: 0, nota: [] })); });
        await page.goto("/rekapan-nota", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("status").filter({ hasText: "Memuat daftar wave" })).toBeVisible(NAV);
        await expect(main.getByText("Belum ada wave")).toHaveCount(0);
        release();
        await expect(main.getByRole("status").filter({ hasText: /Belum ada nota .* di pool/ })).toBeVisible();
        await expect(main.getByText("usulan BL-55")).toBeVisible();
    });

    test("ponsel 390 px: daftar, tanpa gulir menyamping", async ({ page }) => {
        await page.route(path("/api/rekapan-nota/wave"), (route) => route.fulfill(json({ wave: WAVES })));
        await page.route(path("/api/rekapan-nota/pool"), (route) => route.fulfill(json(POOL)));
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/rekapan-nota", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("list", { name: "Wave" }).getByRole("link")).toHaveCount(3, NAV);
        await noHorizontalOverflow(page);
        await page.screenshot({ path: "test-results/fiori-rekapan-wave-harian-ponsel.png", fullPage: true });
    });
});

test.describe("Object Page wave", () => {
    test("rilis dengan exception: konfirmasi ditahan dengan alasan; Lepas lewat dialog beralasan; 409 tampil di dialog", async ({ page }) => {
        await page.route(path("/api/rekapan-nota/wave/317"), (route) => route.fulfill(json(DETAIL_RILIS)));
        await page.route(path("/api/rekapan-nota/wave/317/nota"), (route) => route.fulfill(json({ error: "Wave sudah dikonfirmasi di layar lain; nota tidak bisa dilepas." }, 409)));
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto("/rekapan-nota/wave/317", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("heading", { level: 1, name: "Wave Pagi 2" })).toBeVisible(NAV);
        await expect(main.getByRole("list", { name: "Status wave" }).locator('[aria-current="step"]')).toContainText("Rilis");
        await expect(main.getByText("2 menahan konfirmasi")).toBeVisible();
        await expect(main.getByRole("table", { name: "Exception" })).toContainText("Isi per karton beda dengan file");
        await expect(main.getByText("usulan BL-24")).toBeVisible();
        const konfirmasi = main.getByRole("button", { name: "Konfirmasi selesai…" });
        await expect(konfirmasi).toBeDisabled();
        await expect(konfirmasi).toHaveAttribute("title", "Tutup 2 exception isi per karton dulu");
        await expect(main.getByText("2 exception isi per karton masih terbuka")).toBeVisible();
        // Baris dilepas: alasan, pelaku, jam (WITA).
        await expect(main.getByRole("table", { name: "Isi wave" })).not.toContainText("KN01380"); // saringan "Semua" = aktif saja
        await main.getByRole("group", { name: "Saring isi wave" }).getByRole("button", { name: /Dilepas/ }).click();
        await expect(main.getByRole("table", { name: "Isi wave" })).toContainText("Dilepas 6 Okt 09.40 · Bayu · outlet tutup");
        await main.getByRole("group", { name: "Saring isi wave" }).getByRole("button", { name: /Semua/ }).click();
        await expect(main.getByRole("list", { name: "Riwayat" }).or(main.locator(".fi-hist"))).toContainText("Merilis wave");
        await page.screenshot({ path: "test-results/fiori-rekapan-wave-rilis.png", fullPage: true });

        await main.getByRole("table", { name: "Isi wave" }).getByRole("row", { name: /KN01391/ }).getByRole("button", { name: "Lepas…" }).click();
        const dlg = page.getByRole("dialog");
        await expect(dlg.getByRole("heading")).toContainText("Lepas INV/2610/KN01391 dari Wave Pagi 2?");
        await expect(dlg.getByRole("button", { name: "Lepas nota" })).toBeDisabled();
        await dlg.getByLabel(/Alasan/).fill("Toko minta kirim besok");
        await dlg.getByRole("button", { name: "Lepas nota" }).click();
        await expect(dlg.getByRole("alert")).toContainText("sudah dikonfirmasi di layar lain");
        await expect(dlg.getByLabel(/Alasan/)).toHaveValue("Toko minta kirim besok"); // isian tidak dikosongkan
        await page.screenshot({ path: "test-results/fiori-rekapan-wave-lepas-galat.png" });
        await dlg.getByRole("button", { name: "Batal" }).click();

        // Batalkan wave: alasan wajib, menyebut perilaku hari ini (nota tetap tercatat).
        await main.getByRole("button", { name: "Batalkan wave…" }).click();
        await expect(page.getByRole("dialog")).toContainText("hari ini pembatalan belum mengembalikannya ke pool");
        await expect(page.getByRole("dialog").getByRole("button", { name: "Batalkan wave" })).toBeDisabled();
    });

    test("draf: pool dengan cari/saring, Pilih semua hanya yang terlihat, footer Tambah N nota; Rilis dialog", async ({ page }) => {
        let ditambah: unknown = null;
        await page.route(path("/api/rekapan-nota/wave/318"), (route) => route.fulfill(json(DETAIL_DRAF)));
        await page.route(path("/api/rekapan-nota/pool"), (route) => route.fulfill(json(POOL)));
        await page.route(path("/api/rekapan-nota/wave/318/nota"), (route) => { ditambah = route.request().postDataJSON(); return route.fulfill(json({ masuk: ["INV/2610/KN01381", "INV/2610/KN01402"], ditolak: [], pemilik: [] })); });
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto("/rekapan-nota/wave/318", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("heading", { level: 1, name: "Wave Sore" })).toBeVisible(NAV);
        await expect(main.getByRole("status").filter({ hasText: "Wave ini belum berisi nota" })).toBeVisible();
        const rilis = main.locator(".fi-ftb").getByRole("button", { name: "Rilis wave…" });
        await expect(rilis).toBeDisabled();
        await expect(rilis).toHaveAttribute("title", "Tambahkan nota dulu");
        const pool = main.getByRole("table", { name: "Pool" });
        await expect(pool.getByRole("row")).toHaveCount(4);
        await main.getByLabel("Salesman").selectOption("M-022 · Yusuf");
        await expect(pool.getByRole("row")).toHaveCount(2);
        await pool.getByLabel("Pilih semua baris").check();
        await main.getByRole("button", { name: /Hapus saringan Salesman/ }).click();
        await expect(pool.getByRole("row")).toHaveCount(4);
        await pool.getByLabel("Pilih INV/2610/KN01402").check();
        await expect(main.locator(".fi-ftb")).toContainText("2 dipilih");
        await page.screenshot({ path: "test-results/fiori-rekapan-wave-draf.png", fullPage: true });
        await main.getByRole("button", { name: "Tambah 2 nota" }).click();
        expect(ditambah).toMatchObject({ noNota: ["INV/2610/KN01381", "INV/2610/KN01402"], prioritas: "normal" });
        await expect(main.getByRole("status").filter({ hasText: "2 nota ditambahkan" })).toBeVisible();
    });

    test("ponsel: Object Page tanpa gulir menyamping", async ({ page }) => {
        await page.route(path("/api/rekapan-nota/wave/317"), (route) => route.fulfill(json(DETAIL_RILIS)));
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/rekapan-nota/wave/317", NAV);
        await expect(page.locator("main").getByRole("heading", { level: 1, name: "Wave Pagi 2" })).toBeVisible(NAV);
        await expect(page.locator("main").getByRole("list", { name: "Isi wave" })).toBeVisible();
        await noHorizontalOverflow(page);
        await page.screenshot({ path: "test-results/fiori-rekapan-wave-ponsel.png", fullPage: true });
    });
});

test.describe("Nota kanvas", () => {
    test("per salesman; nota di wave reguler tidak bisa dipilih; 409 tampil di halaman; nihil lewat dialog", async ({ page }) => {
        await page.route(path("/api/rekapan-nota/kanvas"), (route) => {
            if (route.request().method() === "POST") return route.fulfill(json({ error: "Sebagian nota sudah masuk wave reguler. Lepas dulu (take-out) sebelum ditandai kanvas.", bentrok: [{ no_nota: "INV/2610/KN01386", nama: "Pagi 1" }] }, 409));
            return route.fulfill(json(KANVAS));
        });
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto("/rekapan-nota/kanvas", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("heading", { level: 1 })).toContainText("Nota kanvas", NAV);
        await expect(main.getByRole("region", { name: "M-022 · Yusuf" })).toBeVisible();
        // Tabel dan daftar ponsel dua-duanya di DOM (container query memilih); cek di tabel.
        await expect(main.getByRole("table", { name: "Nota Rahmat" }).getByLabel("Pilih INV/2610/KN01386")).toBeDisabled();
        await expect(main.getByRole("button", { name: "Tandai semua 2 nota…" })).toBeVisible();
        const yusuf = main.getByRole("table", { name: "Nota Yusuf" });
        await yusuf.getByLabel("Pilih INV/2610/KN01381").check();
        await main.getByRole("button", { name: "Tandai kanvas (1)" }).click();
        await expect(main.getByRole("alert")).toContainText("INV/2610/KN01386 ada di Wave Pagi 1");
        await expect(yusuf.getByLabel("Pilih INV/2610/KN01381")).toBeChecked(); // pilihan tidak dikosongkan saat gagal
        await page.screenshot({ path: "test-results/fiori-rekapan-kanvas-galat.png", fullPage: true });

        await main.getByRole("button", { name: "Tandai semua 2 nota…" }).click();
        await expect(page.getByRole("dialog")).toContainText("INV/2610/KN01381 TK HARAPAN BARU");
        await page.getByRole("dialog").getByRole("button", { name: "Batal" }).click();

        const nihil = main.getByRole("button", { name: "Nyatakan nihil…" });
        await expect(nihil).toBeDisabled(); // masih ada 1 nota bertanda
        await expect(nihil).toHaveAttribute("title", "Masih ada nota bertanda kanvas");
    });

    test("kosong: nihil bisa dinyatakan lebih dulu lewat dialog dengan catatan", async ({ page }) => {
        let nihilBody: unknown = null;
        await page.route(path("/api/rekapan-nota/kanvas"), (route) => {
            if (route.request().method() === "PATCH") { nihilBody = route.request().postDataJSON(); return route.fulfill(json({ ok: true })); }
            return route.fulfill(json({ ...KANVAS, jumlahNota: 0, ditandai: 0, nota: [] }));
        });
        await page.goto("/rekapan-nota/kanvas", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("status").filter({ hasText: /Belum ada nota .* di pool/ })).toBeVisible(NAV);
        await expect(main.getByText("usulan BL-57")).toBeVisible();
        await main.getByRole("button", { name: "Nyatakan nihil…" }).click();
        await page.getByRole("dialog").getByLabel("Catatan").fill("Kanvaser M-014 cuti");
        await page.getByRole("dialog").getByRole("button", { name: "Nyatakan nihil" }).click();
        expect(nihilBody).toMatchObject({ nihil: true, catatan: "Kanvaser M-014 cuti" });
        await expect(main.getByRole("status").filter({ hasText: "Dicatat: tidak ada nota kanvas" })).toBeVisible();
    });
});

test.describe("Mapping area", () => {
    test("default: saring keyakinan, draf area final → footer Simpan; Terima usulan Tinggi lewat dialog", async ({ page }) => {
        let disimpan: unknown[] = [];
        await page.route(path("/api/rekapan-nota/area"), (route) => {
            if (route.request().method() === "POST") { disimpan.push(route.request().postDataJSON()); return route.fulfill(json({ tersimpan: 1, gagal: [] })); }
            return route.fulfill(json(AREA));
        });
        await page.setViewportSize({ width: 1366, height: 900 });
        await page.goto("/rekapan-nota/area", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("heading", { level: 1, name: "Mapping area" })).toBeVisible(NAV);
        const tabel = main.getByRole("table", { name: "Outlet tanpa area" });
        await expect(tabel.getByRole("row")).toHaveCount(4);
        await main.getByLabel("Keyakinan").selectOption("TANPA");
        await expect(tabel.getByRole("row")).toHaveCount(2);
        await main.getByRole("button", { name: /Hapus saringan Keyakinan/ }).click();
        await tabel.getByLabel("Area final TK SUMBER REZEKI").fill("luar kota"); // input juga ada di daftar ponsel (tersembunyi)
        await expect(main.locator(".fi-ftb")).toContainText("1 diubah");
        await page.screenshot({ path: "test-results/fiori-rekapan-area-draf.png", fullPage: true });
        await main.getByRole("button", { name: "Simpan 1 outlet" }).click();
        expect(disimpan[0]).toMatchObject({ terima: [{ kode: "C-MRS0033", area: "LUAR KOTA" }] });
        await expect(main.getByRole("status").filter({ hasText: "1 outlet dipetakan" })).toBeVisible();

        await main.getByRole("button", { name: "Terima 1 usulan Tinggi…" }).click();
        await expect(page.getByRole("dialog")).toContainText("C-MKS0418 · TK ANUGERAH");
        await page.getByRole("dialog").getByRole("button", { name: "Terima 1 usulan" }).click();
        expect(disimpan[1]).toMatchObject({ terima: [{ kode: "C-MKS0418", area: "1" }] });
        await expect(page.getByRole("dialog")).toBeHidden();
    });

    test("memuat lama: strip 'bisa sampai 2 menit' + kerangka; galat: bukan kosong, ada Coba lagi", async ({ page }) => {
        let gagal = true;
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => { release = r; });
        await page.route(path("/api/rekapan-nota/area"), async (route) => { await gate; return gagal ? route.fulfill(json({ error: "batas waktu" }, 504)) : route.fulfill(json({ jumlah: 0, outlet: [] })); });
        await page.goto("/rekapan-nota/area", NAV);
        const main = page.locator("main");
        await expect(main.getByRole("status").filter({ hasText: "Bisa sampai 2 menit" })).toBeVisible(NAV);
        release();
        await expect(main.getByRole("alert")).toContainText("Antrean gagal dimuat");
        await expect(main.getByText("Semua outlet di nota sudah punya area")).toHaveCount(0);
        gagal = false;
        await main.getByRole("button", { name: "Coba lagi" }).click();
        await expect(main.getByText("Semua outlet di nota sudah punya area")).toBeVisible();
    });
});
