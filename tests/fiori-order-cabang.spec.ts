/*
 * Tujuan: Fiori O2 — Order per cabang Accurate: Order Sales (salesman: cari pelanggan jeda 300 ms + min 2 huruf + hanya cabang sendiri,
 *   cari barang hanya cabang pelanggan dengan satuan + harga per cabang, pratinjau mengirim customer_no dan menampilkan program promo per
 *   baris + ringkasan, akun belum tertaut = penjelasan bukan formulir kosong, galat ≠ kosong, kosong dengan sebab, barang beda cabang
 *   ditolak, harga belum ada mengunci Kirim, penolakan server berkode, ponsel 390 px) dan Order baru/manual (petugas: semua cabang +
 *   saringan cabang, barang mengikuti cabang pelanggan, ganti pelanggan beda cabang = konfirmasi, cabang tanpa barang).
 *   Tahap 2 (O1 putaran 1): simpan Order Sales + Order Baru membawa `sidik` pratinjau terakhir; PRATINJAU_BERUBAH = belum tersimpan, angka baru +
 *   konfirmasi ulang; ubah isian = sidik lama batal (Kirim terkunci sampai pratinjau segar); kode galat baru jadi kalimat; harga petugas hanya
 *   untuk baris tanpa harga master; ORDER_GANDA + konfirmasi; flag cabangTanpaBarang.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-order-cabang.spec.ts --config <config lokal> --workers=1 --output=test-results/order-cabang`.
 * Dependensi: tests/helpers/order-cabang-mock.ts (mock kontrak O1 + FastAPI Web Sales). Tidak menyentuh DB maupun Accurate.
 * Side Effects: Tangkapan di test-results/order-cabang.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ID_WEBSALES, mockOrderCabang, mockOrdersInternal, mockWebsales, pilihBarang, pilihPelanggan, pratinjauContoh, type Jawab, type PreviewBody } from "./helpers/order-cabang-mock";

const NAV = { timeout: 60_000 } as const;
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

const bukaSales = async (page: Page) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/sales", NAV);
    return page.locator("main");
};
/** Permintaan pencarian yang membawa kata kunci (probe cakupan tanpa `q` tidak dihitung). */
const dengan = (urls: URL[]) => urls.filter((u) => u.searchParams.has("q"));

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
async function target44(root: Locator) {
    const kecil = await root.evaluate((el) => {
        const out: string[] = [];
        el.querySelectorAll("button, a[href], select, textarea, input").forEach((node) => {
            const e = node as HTMLInputElement;
            if (e.closest(".fi-crumb")) return;
            const box = e.getBoundingClientRect();
            if (!box.width || !box.height) return;
            const nama = `${e.tagName} "${(e.getAttribute("aria-label") || e.textContent || e.name || "").trim().slice(0, 40)}"`;
            if (e.type === "checkbox" || e.type === "radio") return;
            if (Math.min(box.width, box.height) < 43.5) out.push(`${nama} ${Math.round(box.width)}×${Math.round(box.height)}`);
        });
        return out;
    });
    expect(kecil).toEqual([]);
}

test("Order Sales: cari pelanggan (jeda 300 ms, min 2 huruf, hanya cabang sendiri) → cari barang cabang pelanggan → harga per satuan → promo di pratinjau → kirim", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page, { cabang: opsi });
    const main = await bukaSales(page);
    await expect(main.getByText("cabang CABANG A").first()).toBeVisible(NAV); // cakupan dari karyawan Accurate tertaut
    const cari = main.getByLabel("Cari pelanggan");
    await expect(cari).toBeVisible();
    await expect(main.getByText("Hanya pelanggan cabang CABANG A")).toBeVisible();

    // Satu huruf: tidak ada permintaan, ada petunjuk.
    await cari.fill("P");
    await page.waitForTimeout(700);
    expect(dengan(log.pelanggan)).toHaveLength(0);
    await expect(main.getByText("Hasil muncul setelah 2 huruf pertama.")).toBeVisible();
    // Ketik cepat (jeda antar ketukan < 300 ms): tepat SATU permintaan, untuk kata terakhir.
    await cari.fill("");
    await cari.pressSequentially("PELANG", { delay: 40 });
    const hasil = main.getByRole("list", { name: "Hasil pencarian pelanggan" });
    await expect(hasil.getByRole("button")).toHaveCount(3, NAV); // PELANGGAN A, B, D — C dan E bukan cabang salesman
    expect(dengan(log.pelanggan).map((u) => u.searchParams.get("q"))).toEqual(["PELANG"]);
    await expect(hasil).toContainText("Cabang CABANG A · channel GT");
    await expect(hasil).not.toContainText("PELANGGAN C");
    await expect(hasil).not.toContainText("CABANG B");
    await expect(hasil).toContainText("channel belum ada"); // PELANGGAN D: kategori belum diisi, tetap terlihat dengan sebabnya
    await page.screenshot({ path: "test-results/order-cabang/sales-cari-pelanggan.png", fullPage: true });

    await hasil.getByRole("button", { name: /PELANGGAN A/ }).click();
    const kartu = main.getByRole("group", { name: "Pelanggan terpilih" });
    await expect(kartu).toContainText("PELANGGAN A");
    await expect(kartu).toContainText("C-01");
    await expect(kartu).toContainText("Cabang CABANG A");
    await expect(kartu).toContainText("Channel GT");
    await expect(kartu).toContainText("harga GROSIR");
    await expect(main.getByLabel("Outlet")).toHaveValue("PELANGGAN A");

    // Barang: hanya cabang pelanggan; satuan + harga per cabang; tanpa daftar harga tidak bisa dipilih.
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Cari barang").fill("BARANG");
    const barang = b1.getByRole("list", { name: "Hasil pencarian barang" });
    await expect(barang).toContainText("BARANG A", NAV);
    expect(log.barang.at(-1)!.searchParams.get("customerId")).toBe("1");
    expect(log.barang.at(-1)!.searchParams.get("tanggal")).toBe(HARI_INI);
    await expect(barang).toContainText("KRT Rp 576.000 · PCS Rp 24.000");
    await expect(barang).not.toContainText("BARANG B"); // barang CABANG B tidak pernah ditawarkan
    await expect(barang.getByRole("button")).toHaveCount(2); // A-1 dan A-4; A-2 (semua satuan tanpa harga sah) dan A-3 (belum ada daftar harga) tidak bisa dipilih sales
    await expect(barang).toContainText("Belum bisa dipilih");
    await barang.getByRole("button", { name: /BARANG A\b.*KRT/ }).click();
    await expect(b1.getByRole("group", { name: "Barang 1 terpilih" })).toContainText("A-1 · CABANG A");
    const satuan = b1.getByLabel("Satuan");
    await expect(satuan.locator("option")).toHaveText(["pilih", "KRT · Rp 576.000", "PCS · Rp 24.000"]);
    await satuan.selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");

    // Pratinjau: customer_no dikirim; harga per cabang; promo per baris + ringkasan.
    await expect(b1).toContainText("Harga ada", NAV);
    await expect(b1).toContainText("Rp 576.000 per KRT");
    expect(log.preview.at(-1)).toMatchObject({ channel: "GT", customer_no: "C-01", order_date: HARI_INI, lines: [{ code: "A-1", unit: "KRT", quantity: "2" }] });
    const promo = b1.getByRole("group", { name: "Promo barang 1" });
    await expect(promo).toContainText("Diskon promo Rp 115.200");
    await expect(promo).toContainText("10%");
    await expect(promo).toContainText("Bonus 2 PCS");
    await expect(promo).toContainText("netto Rp 1.036.800");
    await expect(b1).toContainText("Tambah 3 KRT lagi untuk diskon 15%");
    const panel = main.getByRole("group", { name: "Perkiraan nilai order" });
    await expect(panel).toContainText("Rp 1.152.000");
    await expect(panel).toContainText("Netto estimasi");
    await expect(panel).toContainText("Rp 1.036.800");
    await expect(panel.getByRole("list", { name: "Program promo yang berlaku" })).toContainText("PROMO A — potongan Rp 115.200");
    await expect(panel).toContainText("Tidak berlaku untuk outlet ini: PROMO C (khusus outlet MT)");
    await page.screenshot({ path: "test-results/order-cabang/sales-promo.png", fullPage: true });

    await main.getByRole("button", { name: "Kirim order…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("Cabang");
    await expect(dlg).toContainText("CABANG A");
    await expect(dlg).toContainText("Rp 1.036.800");
    await dlg.getByRole("button", { name: "Kirim order" }).click();
    await expect(dlg).toBeHidden();
    // Simpan membawa SIDIK pratinjau terakhir (bukan harga): sales tidak pernah mengirim harga.
    expect(log.sidik.at(-1)).toMatch(/^[0-9a-f]{64}$/);
    expect(ws.kirim).toEqual([{ outlet: "PELANGGAN A", channel: "GT", order_date: HARI_INI, note: "", customer_no: "C-01", sidik: log.sidik.at(-1), lines: [{ code: "A-1", unit: "KRT", quantity: "2" }] }]);
    await expect(main.getByRole("status").filter({ hasText: `No. permintaan #${ID_WEBSALES.slice(0, 8)}` })).toBeVisible();
});

test("Order Sales: akun belum ditautkan / karyawan tidak aktif = penjelasan 'hubungi Admin', bukan formulir kosong", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales", akun: "belum-terhubung" });
    await mockWebsales(page);
    const main = await bukaSales(page);
    await expect(main.getByText("Akun Anda belum dihubungkan ke karyawan Accurate.")).toBeVisible(NAV);
    await expect(main).toContainText("Hubungi Admin untuk menautkan akun Anda");
    await expect(main.getByLabel("Cari pelanggan")).toHaveCount(0);
    await expect(main.getByRole("heading", { name: "Pelanggan" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Kirim order…" })).toHaveCount(0);
    await expect(main.getByRole("region", { name: "Order saya" })).toBeVisible(); // order lama tetap terlihat
    await page.screenshot({ path: "test-results/order-cabang/sales-belum-terhubung.png", fullPage: true });

    opsi.akun = "tidak-aktif";
    await page.reload(NAV);
    await expect(main.getByText("Karyawan Accurate Anda tidak aktif.")).toBeVisible(NAV);
    await expect(main).toContainText("Hubungi Admin untuk memeriksa data karyawan Anda di Accurate");
    await expect(main.getByLabel("Cari pelanggan")).toHaveCount(0);
});

test("Order Sales: pencarian gagal = galat + tindakan + Coba lagi (bukan 'tidak ada pelanggan'); cabang tak terbaca = formulir terkunci + Coba lagi", async ({ page }) => {
    let gagal: "putus" | "html" | null = "putus";
    let cakupanGagal = true;
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    opsi.pelanggan = (url) => {
        if (!url.searchParams.has("q")) return cakupanGagal ? { status: 502, html: "<html>Bad Gateway</html>" } : undefined;
        return gagal === "putus" ? "putus" : gagal === "html" ? { status: 502, html: "<html>Bad Gateway</html>" } : undefined;
    };
    await mockWebsales(page);
    const main = await bukaSales(page);
    // Probe cabang gagal: bukan "belum tertaut", bukan formulir kosong.
    await expect(main.getByRole("heading", { name: "Cabang Anda belum terbaca" })).toBeVisible(NAV);
    await expect(main.getByLabel("Cari pelanggan")).toHaveCount(0);
    const kirim = page.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Cabang Anda belum terbaca; muat ulang halaman ini");
    cakupanGagal = false;
    await main.getByRole("button", { name: "Coba lagi" }).first().click();
    const cari = main.getByLabel("Cari pelanggan");
    await expect(cari).toBeVisible(NAV);

    await cari.fill("PELANG");
    const galat = main.getByText("Tidak tersambung ke server.");
    await expect(galat).toBeVisible(NAV);
    await expect(main).toContainText("Periksa sinyal, lalu coba lagi.");
    await expect(main.getByText(/Tidak ada pelanggan/)).toHaveCount(0);
    gagal = "html";
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByText("Hasilnya belum pasti.").first()).toBeVisible(NAV);
    await expect(main).toContainText("Muat ulang data, lalu periksa sebelum mengulang.");
    gagal = null;
    await main.getByRole("button", { name: "Coba lagi" }).click();
    await expect(main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button")).toHaveCount(3, NAV);
});

test("Order Sales: kosong dengan sebab — pelanggan tak ada, barang tak cocok, cabang tanpa barang", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page);
    const main = await bukaSales(page);
    await main.getByLabel("Cari pelanggan").fill("ZZ");
    await expect(main.getByRole("heading", { name: "Tidak ada pelanggan “ZZ”" })).toBeVisible(NAV);
    await expect(main).toContainText("Pencarian hanya mencakup cabang Anda");
    await pilihPelanggan(main, "PELANG", "PELANGGAN A");

    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Cari barang").fill("QQ");
    await expect(b1.getByRole("heading", { name: "Tidak ada barang “QQ” di cabang CABANG A" })).toBeVisible(NAV);
    await expect(b1).not.toContainText("belum punya barang");

    // Cabang tanpa barang sama sekali: dijelaskan, bukan daftar kosong polos (probe tanpa kata kunci).
    opsi.barang = (url) => (url.searchParams.has("q") ? { body: { ok: true, tanggal: HARI_INI, branchId: 50, cabangTanpaBarang: true, items: [] } } : undefined);
    await b1.getByLabel("Cari barang").fill("RR");
    await expect(b1.getByRole("heading", { name: "Cabang CABANG A belum punya barang yang bisa diorder" })).toBeVisible(NAV);
    await expect(b1).toContainText("Hubungi Admin untuk menyinkronkan master barang");
    expect(log.barang.filter((u) => u.searchParams.has("q") && u.searchParams.get("q") === "RR")).toHaveLength(1); // satu permintaan: flag dari server, bukan tebakan
});

test("Order Sales: pencarian lama dibatalkan — jawaban yang telat tidak menimpa hasil ketikan terbaru", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page);
    opsi.pelanggan = async (url) => {
        if (url.searchParams.get("q") === "PELANGGAN A") await new Promise((ok) => setTimeout(ok, 2500)); // jawaban lambat untuk ketikan lama
        return undefined;
    };
    const main = await bukaSales(page);
    const cari = main.getByLabel("Cari pelanggan");
    await cari.fill("PELANGGAN A");
    await expect.poll(() => dengan(log.pelanggan).length, NAV).toBe(1); // permintaan lama berangkat
    await cari.fill("PELANGGAN B");
    const hasil = main.getByRole("list", { name: "Hasil pencarian pelanggan" });
    await expect(hasil.getByRole("button")).toHaveCount(1, NAV);
    await expect(hasil).toContainText("PELANGGAN B");
    await page.waitForTimeout(2800);
    await expect(hasil).not.toContainText("PELANGGAN A");
    expect(log.dibatalkan.some((s) => s.includes("q=PELANGGAN+A"))).toBe(true); // AbortController membatalkan permintaan lama
});

test("Order Sales: barang beda cabang ditolak server = kalimat di barisnya + Kirim terkunci; barang cabang lain tak pernah ditawarkan", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page);
    const main = await bukaSales(page);
    await pilihPelanggan(main, "PELANG", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "BARANG", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await expect(b1).toContainText("Harga ada", NAV);
    // Server menolak: barang ini ternyata milik cabang lain (data master berubah sesudah dipilih).
    opsi.preview = () => ({ status: 409, body: { ok: false, kode: "BARANG_BEDA_CABANG", error: "Barang bukan barang cabang CABANG A milik pelanggan ini: A-1 (cabang CABANG B)",
        barang: [{ code: "A-1", name: "BARANG A", branchId: 90, branchName: "CABANG B", tag: "TAG B" }] } });
    await b1.getByLabel("Jumlah").fill("3");
    await expect(b1.getByRole("alert")).toContainText("BARANG A milik cabang CABANG B, bukan cabang pelanggan.");
    await expect(b1.getByRole("alert")).toContainText("Hapus barang itu, lalu cari barang yang milik cabang pelanggan.");
    await expect(main.getByRole("alert").filter({ hasText: "Barang bukan milik cabang pelanggan." })).toBeVisible();
    const kirim = page.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Hapus atau ganti barang 1: Barang bukan milik cabang pelanggan");
    expect(ws.kirim).toHaveLength(0);
    // Mengganti barang dengan yang sah membuka kunci.
    opsi.preview = undefined;
    await b1.getByRole("button", { name: "Ganti barang 1" }).click();
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await expect(kirim).toBeEnabled(NAV);
});

test("Order Sales: barang tanpa harga master sah tidak bisa dipesan (pencarian + satuan); harga hilang sesudah dipilih = ditandai dan Kirim terkunci", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page, { cabang: opsi });
    const main = await bukaSales(page);
    await pilihPelanggan(main, "PELANG", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    // Semua satuan tanpa harga sah: tidak ada tombol pilih (sales tidak menentukan harga).
    await b1.getByLabel("Cari barang").fill("A-2");
    const barang = b1.getByRole("list", { name: "Hasil pencarian barang" });
    await expect(barang).toContainText("BARANG A2", NAV);
    await expect(barang).toContainText("LSN harga belum ada");
    await expect(barang).toContainText("Belum bisa dipilih");
    await expect(barang.getByRole("button")).toHaveCount(0);

    // Satu satuan berharga + satu tanpa harga sah: yang tanpa harga tidak bisa dipilih di daftar satuan.
    opsi.barang = (url) => (url.searchParams.get("q") === "A-9" ? { body: { ok: true, tanggal: HARI_INI, branchId: 50, cabangTanpaBarang: false, items: [
        { id: 99, no: "A-9", name: "BARANG A9", branchId: 50, branchName: "CABANG A", tag: "TAG A", units: [
            { unit: "KRT", price: 500000, source: "tier", branchName: "CABANG A", effectiveDate: "2026-10-01" }, { unit: "PCS", price: null, source: "standard", branchName: null, effectiveDate: null }] }] } } : undefined);
    await b1.getByLabel("Cari barang").fill("A-9");
    await b1.getByRole("list", { name: "Hasil pencarian barang" }).getByRole("button", { name: /BARANG A9/ }).click();
    await expect(b1.getByLabel("Satuan").locator("option")).toHaveText(["pilih", "KRT · Rp 500.000", "PCS · harga belum ada"]);
    await expect(b1.getByLabel("Satuan").locator("option", { hasText: "PCS" })).toBeDisabled();

    // Harga hilang di server sesudah dipilih (data master berubah): ditandai di barisnya, Kirim terkunci.
    opsi.preview = () => ({ status: 409, body: { ok: false, kode: "HARGA_BELUM_ADA", error: "Harga belum tersedia dari Accurate untuk: A-9", missing: ["A-9"] } });
    await b1.getByLabel("Satuan").selectOption("KRT");
    await expect(b1).toContainText("Harga belum ada", NAV);
    await expect(b1).toContainText("Minta petugas melengkapinya");
    const kirim = page.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Harga barang 1 belum ada di Accurate untuk cabang ini — belum bisa dikirim");
    expect(ws.kirim).toHaveLength(0);
});

test("Order Sales: penolakan simpan berkode dari server tampil sebagai kalimat + tindakan di dialog; draf dan isian tetap", async ({ page }) => {
    await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page, { tolak: { status: 403, body: { ok: false, detail: "Akun ini belum ditautkan ke karyawan salesman Accurate.", kode: "SALESMAN_BELUM_TERHUBUNG" } } });
    const main = await bukaSales(page);
    await pilihPelanggan(main, "PELANG", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "BARANG", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await expect(b1).toContainText("Harga ada", NAV);
    await main.getByRole("button", { name: "Kirim order…" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Kirim order" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Akun Anda belum dihubungkan ke karyawan Accurate.");
    await expect(dlg.getByRole("alert")).toContainText("Hubungi Admin");
    await expect(dlg.getByRole("alert")).not.toContainText("SALESMAN_BELUM_TERHUBUNG");
    expect(ws.kirim).toHaveLength(1);
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(b1.getByLabel("Jumlah")).toHaveValue("1"); // isian tidak hilang
});

test("Order Sales: pemulihan draf membaca ulang pelanggan dan barang dari master (cabang/harga bisa berubah sejak draf ditulis)", async ({ page }) => {
    await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page);
    page.removeAllListeners("dialog");
    page.on("dialog", (d) => { if (d.type() !== "beforeunload") throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); return d.accept(); });
    const main = await bukaSales(page);
    await pilihPelanggan(main, "PELANG", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "BARANG", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("4");
    await expect(main.getByText("tersimpan sebagai draf di ponsel ini")).toBeVisible();
    await page.reload(NAV);
    const tawaran = main.getByRole("status").filter({ hasText: "Ada draf order di ponsel ini." });
    await expect(tawaran).toContainText("C-01 · PELANGGAN A · 1 barang", NAV);
    await expect(main.getByLabel("Cari pelanggan")).toBeVisible(); // belum dipulihkan diam-diam
    await tawaran.getByRole("button", { name: "Pulihkan draf" }).click();
    await expect(main.getByRole("group", { name: "Pelanggan terpilih" })).toContainText("Cabang CABANG A", NAV);
    await expect(b1.getByRole("group", { name: "Barang 1 terpilih" })).toContainText("BARANG A", NAV);
    await expect(b1.getByLabel("Satuan")).toHaveValue("KRT");
    await expect(b1.getByLabel("Jumlah")).toHaveValue("4");
    await expect(b1).toContainText("Harga ada", NAV);
    await expect(page.getByRole("button", { name: "Kirim order…" })).toBeEnabled();
});

test("Order Sales: barang dari draf yang sudah tak ada di cabang pelanggan = galat di barisnya (bukan hilang diam-diam), Kirim terkunci", async ({ page }) => {
    await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page);
    page.removeAllListeners("dialog");
    page.on("dialog", (d) => { if (d.type() !== "beforeunload") throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); return d.accept(); });
    await page.addInitScript(() => localStorage.setItem("accapi.order-sales.draf.v1.local-dev-admin", JSON.stringify({
        customerNo: "C-01", outlet: "PELANGGAN A", note: "", lines: [{ code: "A-1", unit: "KRT", quantity: "1" }, { code: "X-9", unit: "KRT", quantity: "1" }], tidakPasti: "", disimpan: "" })));
    const main = await bukaSales(page);
    await main.getByRole("status").filter({ hasText: "Ada draf order di ponsel ini." }).getByRole("button", { name: "Pulihkan draf" }).click();
    const b2 = main.getByRole("listitem", { name: "Barang 2" });
    await expect(b2.getByRole("alert")).toContainText("Barang tidak ditemukan.", NAV);
    await expect(b2).toContainText("Barang X-9 tidak ada di cabang pelanggan ini");
    await expect(main.getByRole("listitem", { name: "Barang 1" }).getByRole("group", { name: "Barang 1 terpilih" })).toContainText("BARANG A", NAV);
    const kirim = page.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Menunggu data barang 2");
    await b2.getByRole("button", { name: "Cari barang lain" }).click();
    await expect(b2.getByLabel("Cari barang")).toBeVisible();
});

test.describe("ponsel 390 px (layar sentuh)", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("Order Sales: cari pelanggan, cari barang, pratinjau promo — tanpa gulir menyamping, kontrol ≥ 44 px", async ({ page }) => {
        await mockOrderCabang(page, { peran: "sales" });
        await mockWebsales(page);
        await page.goto("/sales", NAV);
        const main = page.locator("main");
        await expect(main.getByLabel("Cari pelanggan")).toBeVisible(NAV);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        await noOverflow(page);
        await target44(main);
        await main.getByLabel("Cari pelanggan").fill("PELANG");
        await expect(main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button")).toHaveCount(3, NAV);
        await noOverflow(page);
        await target44(main);
        await page.screenshot({ path: "test-results/order-cabang/ponsel-sales-pelanggan.png", fullPage: true });
        await main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button", { name: /PELANGGAN A/ }).click();
        const b1 = main.getByRole("listitem", { name: "Barang 1" });
        await b1.getByLabel("Cari barang").fill("BARANG");
        await expect(b1.getByRole("list", { name: "Hasil pencarian barang" })).toContainText("KRT Rp 576.000", NAV);
        await noOverflow(page);
        await target44(main);
        await page.screenshot({ path: "test-results/order-cabang/ponsel-sales-barang.png", fullPage: true });
        await b1.getByRole("list", { name: "Hasil pencarian barang" }).getByRole("button", { name: /BARANG A\b.*KRT/ }).click();
        await b1.getByLabel("Satuan").selectOption("KRT");
        await b1.getByLabel("Jumlah").fill("2");
        await expect(main.getByRole("group", { name: "Perkiraan nilai order" })).toContainText("Program promo yang berlaku", NAV);
        await expect(b1.getByRole("group", { name: "Promo hampir tercapai barang 1" }).getByRole("button", { name: "Tambah 3 KRT" })).toBeVisible(); // kartu ajakan ikut terukur: tanpa gulir menyamping, tombol ≥ 44 px
        await noOverflow(page);
        await target44(main);
        await page.screenshot({ path: "test-results/order-cabang/ponsel-sales-promo.png", fullPage: true });
    });

    test("Order Sales + Order baru: SEMUA kolom isian (pencarian pelanggan/barang, satuan, jumlah, tanggal, harga) dan kolom `fi-input fi-mono` ≥ 16 px di layar sentuh — tidak memicu zoom iOS", async ({ page }) => {
        test.setTimeout(120_000); // dua halaman + kompilasi dev pertama
        const { opsi } = await mockOrderCabang(page, { peran: "sales" });
        await mockWebsales(page, { cabang: opsi });
        await mockOrdersInternal(page, { cabang: opsi });
        // Pindah dari Order Sales yang berisi draf memicu peringatan "perubahan belum disimpan" (beforeunload) — diterima; dialog peramban lain tetap galat.
        page.removeAllListeners("dialog");
        page.on("dialog", (d) => { if (d.type() !== "beforeunload") throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); return d.accept(); });
        /** Ukuran huruf terhitung semua kolom isian terlihat di <main> + satu kolom `fi-input fi-mono` uji (dipasang di lingkup .fiori halaman itu). */
        const ukuran = async () => page.evaluate(() => {
            const host = document.querySelector("main .fiori") ?? document.querySelector(".fiori") ?? document.body;
            host.querySelector("[data-uji-mono]")?.remove();
            const mono = document.createElement("input");
            mono.className = "fi-input fi-mono";
            mono.setAttribute("data-uji-mono", "1");
            mono.setAttribute("aria-label", "uji fi-mono");
            host.appendChild(mono);
            return [...document.querySelectorAll<HTMLElement>("main input, main select, main textarea")]
                .filter((el) => el.getBoundingClientRect().width > 0 && !["checkbox", "radio", "hidden"].includes((el as HTMLInputElement).type))
                .map((el) => ({ nama: `${el.tagName.toLowerCase()}.${el.className.replace(/\s+/g, ".")} ${el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? ""}`.trim(), px: parseFloat(getComputedStyle(el).fontSize) }));
        });
        const kecil = (rows: { nama: string; px: number }[]) => rows.filter((r) => r.px < 16);

        await page.goto("/sales", NAV);
        const main = page.locator("main");
        await expect(main.getByLabel("Cari pelanggan")).toBeVisible(NAV);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        let rows = await ukuran();
        expect(rows.some((r) => r.nama.includes("fi-mono"))).toBe(true); // kolom uji ikut terukur
        expect(kecil(rows)).toEqual([]);
        await pilihPelanggan(main, "PELANG", "PELANGGAN A");
        const b1 = main.getByRole("listitem", { name: "Barang 1" });
        await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
        await b1.getByLabel("Satuan").selectOption("KRT");
        await b1.getByLabel("Jumlah").fill("2");
        await expect(b1).toContainText("Harga ada", NAV);
        rows = await ukuran();
        expect(rows.length).toBeGreaterThan(5); // pencarian, outlet, tanggal, catatan, satuan, jumlah, uji
        expect(kecil(rows)).toEqual([]);

        await page.goto("/orders/baru", NAV);
        await expect(main.getByLabel("Cari pelanggan")).toBeVisible(NAV);
        expect(kecil(await ukuran())).toEqual([]);
        // Ketikan sebelum hidrasi halaman baru hilang: diulang sampai hasil pencarian muncul.
        await expect(async () => {
            await main.getByLabel("Cari pelanggan").fill("PELANGGAN A");
            await expect(main.getByRole("list", { name: "Hasil pencarian pelanggan" })).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button", { name: /PELANGGAN A/ }).click();
        const c1 = main.getByRole("listitem", { name: "Barang 1" });
        await c1.getByLabel("Cari barang").fill("BARANG");
        await expect(c1.getByRole("list", { name: "Hasil pencarian barang" })).toContainText("BARANG A", NAV);
        expect(kecil(await ukuran())).toEqual([]); // kolom pencarian barang saat hasil terbuka
        await c1.getByRole("list", { name: "Hasil pencarian barang" }).getByRole("button", { name: /BARANG A\b.*KRT/ }).click();
        await c1.getByLabel("Satuan").selectOption("KRT");
        await expect(c1.getByLabel("Harga")).toHaveValue("576000", NAV);
        rows = await ukuran();
        expect(rows.some((r) => r.nama.includes("Harga"))).toBe(true); // kolom harga (baca-saja) ikut terukur
        expect(kecil(rows)).toEqual([]);
    });

    test("Order baru: pelanggan semua cabang + saringan cabang + dialog ganti pelanggan — tanpa gulir menyamping", async ({ page }) => {
        await mockOrderCabang(page);
        await page.route((u) => u.host === "localhost:8000", (r) => r.fulfill({ status: 200, headers: { "access-control-allow-origin": r.request().headers()["origin"] ?? "*", "content-type": "application/json" }, body: JSON.stringify({ ok: true }) }));
        await page.goto("/orders/baru", NAV);
        const main = page.locator("main");
        await main.getByLabel("Cari pelanggan").fill("PEL");
        await expect(main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button")).toHaveCount(5, NAV);
        await expect(main.getByLabel("Saring cabang")).toBeVisible();
        await noOverflow(page);
        await target44(main);
        await page.screenshot({ path: "test-results/order-cabang/ponsel-baru-pelanggan.png", fullPage: true });
    });
});

// ---------------------------------------------------------------------------------------------- Order baru / manual (petugas, semua cabang)

test("Order baru: cari pelanggan semua cabang + saring cabang; barang mengikuti cabang pelanggan; harga per cabang; promo; simpan", async ({ page }) => {
    const { log } = await mockOrderCabang(page);
    const orders = await mockOrdersInternal(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    const cari = main.getByLabel("Cari pelanggan");
    await cari.fill("PEL");
    const hasil = main.getByRole("list", { name: "Hasil pencarian pelanggan" });
    await expect(hasil.getByRole("button")).toHaveCount(5, NAV); // semua cabang
    await expect(hasil).toContainText("Cabang CABANG B");
    await expect(hasil).toContainText("Cabang CABANG C");
    const saring = main.getByLabel("Saring cabang");
    await expect(saring.locator("option")).toHaveText(["Semua cabang", "CABANG A", "CABANG B", "CABANG C"]);
    await saring.selectOption({ label: "CABANG B" });
    await expect(hasil.getByRole("button")).toHaveCount(1, NAV);
    expect(log.pelanggan.at(-1)!.searchParams.get("branchId")).toBe("90");
    await hasil.getByRole("button", { name: /PELANGGAN C/ }).click();
    await expect(main.getByRole("group", { name: "Pelanggan terpilih" })).toContainText("Cabang CABANG B");
    await expect(main.getByLabel("Outlet")).toHaveValue("PELANGGAN C");

    // Barang cabang B saja, harga cabang B.
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Cari barang").fill("BARANG");
    const barang = b1.getByRole("list", { name: "Hasil pencarian barang" });
    await expect(barang.getByRole("button")).toHaveCount(1, NAV);
    await expect(barang).toContainText("BARANG B");
    await expect(barang).toContainText("KRT Rp 700.000");
    expect(log.barang.at(-1)!.searchParams.get("customerId")).toBe("3");
    await barang.getByRole("button", { name: /BARANG B/ }).click();
    await expect(b1.getByLabel("Satuan")).toHaveValue("KRT"); // satu-satunya satuan
    await b1.getByLabel("Jumlah").fill("2");
    await expect(b1.getByLabel("Harga")).toHaveValue("700000", NAV);
    await expect(b1.getByLabel("Harga")).toHaveAttribute("readonly", ""); // harga master baca-saja
    await expect(b1).toContainText("Harga master");
    await expect(b1).toContainText("GROSIR · CABANG B · berlaku 01/10/2026");
    expect(log.preview.at(-1)).toMatchObject({ customer_no: "C-03", channel: "GT" });
    await expect(b1.getByRole("group", { name: "Promo barang 1" })).toContainText("Tanpa diskon promo");
    const panel = main.getByRole("group", { name: "Perkiraan nilai order" });
    await expect(panel).toContainText("PPN 11%");
    await expect(panel).toContainText("Rp 1.400.000");
    await page.screenshot({ path: "test-results/order-cabang/baru-cabang-b.png", fullPage: true });

    await page.getByRole("button", { name: "Simpan order…" }).click();
    const dlg = page.getByRole("dialog", { name: "Simpan order untuk PELANGGAN C?" });
    await expect(dlg).toContainText("CABANG B");
    await dlg.getByRole("button", { name: "Simpan order" }).click();
    await expect.poll(() => orders.simpan.length).toBe(1);
    expect(orders.simpan[0]).toMatchObject({ outlet: "PELANGGAN C", channel: "GT", customer_no: "C-03", sidik: log.sidik.at(-1), lines: [{ code: "B-1", unit: "KRT", quantity: "2" }] });
    expect(orders.simpan[0].lines).toEqual([{ code: "B-1", unit: "KRT", quantity: "2" }]); // baris berharga master TIDAK membawa harga (server menolaknya)
});

test("Order baru: promo A-1 tampil per baris dan ringkasan yang sama dengan Order Sales (pratinjau = yang dibekukan)", async ({ page }) => {
    await mockOrderCabang(page);
    await mockOrdersInternal(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    const promo = b1.getByRole("group", { name: "Promo barang 1" });
    await expect(promo).toContainText("Diskon promo Rp 115.200", NAV);
    await expect(promo).toContainText("Bonus 2 PCS");
    const panel = main.getByRole("group", { name: "Perkiraan nilai order" });
    await expect(panel.getByRole("list", { name: "Program promo yang berlaku" })).toContainText("PROMO A — potongan Rp 115.200");
    await expect(panel).toContainText("Rp 1.036.800");
    await expect(panel).toContainText("Tidak berlaku untuk outlet ini: PROMO C (khusus outlet MT)"); // pelanggan GT

    // Pelanggan MT (cabang sama): hasil promo mengikuti jawaban server untuk pelanggannya — tidak ada program yang diblokir.
    await main.getByRole("group", { name: "Pelanggan terpilih" }).getByRole("button", { name: "Ganti pelanggan" }).click();
    await main.getByLabel("Cari pelanggan").fill("PELANGGAN B");
    await main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button", { name: /PELANGGAN B/ }).click();
    await expect.poll(() => main.getByRole("group", { name: "Perkiraan nilai order" }).textContent()).not.toContain("PROMO C");
    await expect(main.getByRole("group", { name: "Perkiraan nilai order" })).toContainText("PROMO A — potongan Rp 115.200");
});

test("Order baru: 20 hasil teratas = petunjuk persempit pencarian (bukan seolah hanya itu yang ada)", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page);
    await mockOrdersInternal(page);
    opsi.pelanggan = (url) => (url.searchParams.has("q")
        ? { body: { ok: true, cakupan: { semua: true, branchId: null, branchName: null }, items: Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, customerNo: `C-${100 + i}`, name: `PELANGGAN X${i}`, branchId: 50, branchName: "CABANG A", categoryName: "General Trade", channel: "GT", priceCategoryName: "GROSIR", alamat: null })) } }
        : undefined);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await main.getByLabel("Cari pelanggan").fill("PELANGGAN X");
    await expect(main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button")).toHaveCount(20, NAV);
    await expect(main.getByText("Menampilkan 20 teratas — persempit pencarian dengan nama atau kode yang lebih lengkap.")).toBeVisible();
});

test("Order baru: ganti pelanggan ke cabang lain dengan baris terisi = konfirmasi (baris dibuang, tidak diam); cabang sama = baris tetap; batal = tidak berubah", async ({ page }) => {
    const { log } = await mockOrderCabang(page);
    await mockOrdersInternal(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    await expect(b1).toContainText("Harga master", NAV);
    const kartu = main.getByRole("group", { name: "Pelanggan terpilih" });

    // Cabang sama (A -> A): tanpa dialog, baris tetap.
    await kartu.getByRole("button", { name: "Ganti pelanggan" }).click();
    await expect(main.getByRole("button", { name: "Batal ganti — tetap PELANGGAN A" })).toBeVisible();
    await main.getByLabel("Cari pelanggan").fill("PELANGGAN B");
    await main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button", { name: /PELANGGAN B/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(kartu).toContainText("PELANGGAN B");
    await expect(kartu).toContainText("Channel MT");
    await expect(b1.getByRole("group", { name: "Barang 1 terpilih" })).toContainText("BARANG A");
    await expect.poll(() => log.preview.at(-1)?.customer_no).toBe("C-02"); // harga dihitung ulang untuk pelanggan baru

    // Batal ganti: pelanggan lama tetap.
    await kartu.getByRole("button", { name: "Ganti pelanggan" }).click();
    await main.getByRole("button", { name: "Batal ganti — tetap PELANGGAN B" }).click();
    await expect(kartu).toContainText("PELANGGAN B");

    // Cabang lain (A -> B) dengan baris terisi: konfirmasi menyebut baris yang dibuang.
    await kartu.getByRole("button", { name: "Ganti pelanggan" }).click();
    await main.getByLabel("Cari pelanggan").fill("PELANGGAN C");
    await main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button", { name: /PELANGGAN C/ }).click();
    const dlg = page.getByRole("dialog", { name: "Ganti pelanggan ke PELANGGAN C?" });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("cabang CABANG B");
    await expect(dlg).toContainText("Barang dibuang");
    await expect(dlg).toContainText("1 baris");
    await expect(dlg).toContainText("BARANG A (A-1 · cabang CABANG A)");
    await page.screenshot({ path: "test-results/order-cabang/baru-ganti-cabang.png" });
    await dlg.getByRole("button", { name: "Tetap di pelanggan sekarang" }).click();
    await expect(dlg).toBeHidden();
    await expect(kartu).toContainText("PELANGGAN B"); // tidak berubah
    await expect(b1.getByRole("group", { name: "Barang 1 terpilih" })).toContainText("BARANG A");

    await kartu.getByRole("button", { name: "Ganti pelanggan" }).click();
    await main.getByLabel("Cari pelanggan").fill("PELANGGAN C");
    await main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button", { name: /PELANGGAN C/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Ganti dan buang 1 baris" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(kartu).toContainText("PELANGGAN C");
    await expect(kartu).toContainText("Cabang CABANG B");
    await expect(b1.getByLabel("Cari barang")).toBeVisible(); // barisnya direset, bukan membawa barang cabang A
    await expect(b1).not.toContainText("BARANG A");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", "Cari dan pilih minimal satu barang");
});

test("Order baru: cabang tanpa barang dijelaskan; pelanggan tanpa channel ditahan dengan sebabnya; pelanggan nonaktif/tak ada = kalimat + tindakan", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page);
    await mockOrdersInternal(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN E", "PELANGGAN E");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Cari barang").fill("BARANG");
    await expect(b1.getByRole("heading", { name: "Cabang CABANG C belum punya barang yang bisa diorder" })).toBeVisible(NAV);

    await main.getByRole("group", { name: "Pelanggan terpilih" }).getByRole("button", { name: "Ganti pelanggan" }).click();
    await main.getByLabel("Cari pelanggan").fill("PELANGGAN D");
    await main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button", { name: /PELANGGAN D/ }).click();
    await expect(main.locator(".fi-strip").getByText("Outlet C-04 belum punya kategori (TT/MT) di Accurate. Isi kategorinya di Accurate lebih dulu.")).toBeVisible();
    await expect(main.getByRole("group", { name: "Pelanggan terpilih" })).toContainText("Channel belum ada");
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", /belum punya kategori/);

    // Pelanggan nonaktif ketika pratinjau: kalimat + tindakan, Simpan terkunci.
    await main.getByRole("group", { name: "Pelanggan terpilih" }).getByRole("button", { name: "Ganti pelanggan" }).click();
    await main.getByLabel("Cari pelanggan").fill("PELANGGAN A");
    await main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button", { name: /PELANGGAN A/ }).click();
    opsi.preview = () => ({ status: 409, body: { ok: false, kode: "PELANGGAN_SUSPENDED", error: "Pelanggan C-01 (PELANGGAN A) nonaktif (suspended) di Accurate; tidak bisa diorder." } });
    await b1.getByLabel("Jumlah").fill("5");
    await expect(main.getByRole("alert").filter({ hasText: "Pelanggan nonaktif di Accurate." })).toBeVisible(NAV);
    await expect(main.getByRole("alert").filter({ hasText: "Pilih pelanggan lain, atau aktifkan kembali di Accurate lalu sinkronkan." })).toBeVisible();
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", "Pelanggan nonaktif di Accurate. Pilih pelanggan lain, atau aktifkan kembali di Accurate lalu sinkronkan.");
});

test("Order baru: harga petugas HANYA untuk baris tanpa harga master — master baca-saja, petugas wajib > 0 dengan sumbernya; harga tidak dikirim untuk baris master", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page);
    const orders = await mockOrdersInternal(page, { cabang: opsi });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await expect(b1.getByLabel("Harga")).toHaveValue("576000", NAV);
    await expect(b1.getByLabel("Harga")).toHaveAttribute("readonly", "");
    await expect(b1).toContainText("Harga master");

    await main.getByRole("button", { name: "Tambah barang" }).click();
    const b2 = main.getByRole("listitem", { name: "Barang 2" });
    await pilihBarang(b2, "A-2", "BARANG A2");
    const harga = b2.getByLabel("Harga");
    await expect(harga).not.toHaveAttribute("readonly", "");
    await expect(b2).toContainText("Harga master belum ada — isi harga petugas (lebih dari 0).");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", "Isi harga barang 2 (harga master belum ada)");
    // Harga tidak sah: tidak dikirim ke pratinjau, Simpan terkunci dengan kalimat yang menjelaskan aturannya.
    for (const salah of ["0", "-5", "1,5", "12.34567"]) {
        await harga.fill(salah);
        await expect(simpan).toHaveAttribute("title", "Harga barang 2 harus angka lebih dari 0 (desimal pakai titik, maksimal 4 digit)");
        await expect(b2.getByText("Isi angka lebih dari 0 (desimal pakai titik, maksimal 4 digit).")).toBeVisible();
    }
    expect(log.preview.every((b) => b.lines.every((l) => !l.price))).toBe(true); // belum ada harga sah yang dikirim
    await harga.fill("50000");
    await expect(b2).toContainText("Harga petugas", NAV);
    await expect(b2).toContainText("diisi petugas (harga master belum ada)");
    await expect(simpan).toBeEnabled();
    // Pratinjau membawa harga petugas HANYA untuk baris A-2; A-1 (berharga master) tanpa price.
    const akhir = log.preview.at(-1)!;
    expect(akhir.lines.find((l) => l.code === "A-1")!.price).toBeUndefined();
    expect(akhir.lines.find((l) => l.code === "A-2")!.price).toBe("50000");
    await expect(main.locator(".fi-strip").getByText("1 barang memakai harga petugas (harga master belum ada).")).toBeVisible();
    // Dikosongkan = kembali ke harga master (belum ada) = terkunci lagi.
    await harga.fill("");
    await expect(simpan).toHaveAttribute("title", "Isi harga barang 2 (harga master belum ada)");
    await harga.fill("15000");
    await expect(simpan).toBeEnabled();
    await simpan.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("1 barang (harga master belum ada)");
    await dlg.getByRole("button", { name: "Simpan order" }).click();
    await expect.poll(() => orders.simpan.length).toBe(1);
    expect(orders.simpan[0].lines).toEqual([{ code: "A-1", unit: "KRT", quantity: "1" }, { code: "A-2", unit: "LSN", quantity: "1", price: "15000" }]);
    expect(orders.simpan[0].sidik).toBe(log.sidik.at(-1));
});

test("jawaban putus pada pencarian barang Order baru = galat + Coba lagi, bukan daftar kosong", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page);
    await mockOrdersInternal(page);
    let gagal = true;
    opsi.barang = () => (gagal ? "putus" : undefined);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await b1.getByLabel("Cari barang").fill("BARANG");
    await expect(b1.getByText("Tidak tersambung ke server.")).toBeVisible(NAV);
    await expect(b1.getByText(/Tidak ada barang/)).toHaveCount(0);
    gagal = false;
    await b1.getByRole("button", { name: "Coba lagi" }).click();
    await expect(b1.getByRole("list", { name: "Hasil pencarian barang" })).toContainText("BARANG A", NAV);
});

// ---------------------------------------------------------------------------------------------- Tahap 2: sidik (pratinjau = tersimpan)

/** Isi Order Sales siap kirim: PELANGGAN A + BARANG A (KRT) x 2. */
async function isiSalesSiap(page: Page) {
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANG", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    return { main, b1 };
}

test("Order Sales (sidik): PRATINJAU_BERUBAH = BELUM terkirim, angka baru tampil, kirim lagi minta konfirmasi ulang dan membawa sidik BARU", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page, { cabang: opsi });
    await bukaSales(page);
    const { main, b1 } = await isiSalesSiap(page);
    await expect(b1).toContainText("Harga ada", NAV);
    const sidikLama = log.sidik.at(-1)!;
    const panel = main.getByRole("group", { name: "Perkiraan nilai order" });
    await expect(panel).toContainText("Rp 1.036.800");
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeEnabled(NAV);

    opsi.geser = 5000; // server: harga/aturan berubah sesudah pratinjau dilihat
    await kirim.click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(ws.kirim).toHaveLength(1); // satu percobaan, ditolak: TIDAK ada kirim ulang diam-diam
    expect(ws.kirim[0].sidik).toBe(sidikLama);
    const strip = main.getByRole("status").filter({ hasText: "Hitungan berubah sejak pratinjau — order BELUM terkirim." });
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Rp 1.036.800 menjadi Rp 1.041.800");
    await expect(main.getByRole("status").filter({ hasText: "Order terkirim · No. permintaan" })).toHaveCount(0);
    // Pratinjau dihitung ulang: angka baru + sidik baru, lalu Kirim terbuka lagi — tetapi lewat dialog konfirmasi yang menyebut perubahannya.
    await expect(panel).toContainText("Rp 1.041.800", NAV);
    expect(log.sidik.at(-1)).not.toBe(sidikLama);
    await expect(kirim).toBeEnabled(NAV);
    await kirim.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("Angka berubah sejak pratinjau sebelumnya: netto Rp 1.036.800 menjadi Rp 1.041.800.");
    await dlg.getByRole("button", { name: "Kirim order" }).click();
    await expect(dlg).toBeHidden();
    expect(ws.kirim).toHaveLength(2);
    expect(ws.kirim[1].sidik).toBe(log.sidik.at(-1));
    expect(ws.kirim[1].sidik).not.toBe(sidikLama);
    await expect(main.getByRole("status").filter({ hasText: `No. permintaan #${ID_WEBSALES.slice(0, 8)}` })).toBeVisible();
});

test("Order Sales (sidik): mengubah baris/pelanggan/tanggal membatalkan sidik lama — Kirim terkunci sampai pratinjau segar; yang dikirim = sidik terbaru", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page, { cabang: opsi });
    await bukaSales(page);
    const { main, b1 } = await isiSalesSiap(page);
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeEnabled(NAV);
    const sidikLama = log.sidik.at(-1)!;

    // Pratinjau berikutnya ditahan: selama itu isian sudah berubah dan sidik lama TIDAK boleh dipakai.
    let lepas: () => void = () => {};
    const tahan = new Promise<void>((ok) => { lepas = ok; });
    const sebelum = log.preview.length;
    opsi.preview = async (_b, n) => { if (n > sebelum) await tahan; return undefined; };
    await b1.getByLabel("Jumlah").fill("5");
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Menunggu harga dihitung");
    await expect(main.getByText("Menunggu harga dihitung")).toBeVisible();
    expect(ws.kirim).toHaveLength(0);
    lepas();
    await expect(kirim).toBeEnabled(NAV);
    const sidikBaru = log.sidik.at(-1)!;
    expect(sidikBaru).not.toBe(sidikLama);
    await kirim.click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(ws.kirim).toHaveLength(1);
    expect(ws.kirim[0]).toMatchObject({ sidik: sidikBaru, lines: [{ code: "A-1", unit: "KRT", quantity: "5" }] });
});

test("Order Sales (sidik): tanggal diganti = pratinjau lama usang (Kirim terkunci) dan sidik baru dipakai", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page, { cabang: opsi });
    await bukaSales(page);
    const { main } = await isiSalesSiap(page);
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeEnabled(NAV);
    const sidikLama = log.sidik.at(-1)!;
    const kemarin = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const sebelum = log.preview.length;
    await main.getByLabel("Tanggal order").fill(kemarin);
    await expect.poll(() => log.preview.length, NAV).toBeGreaterThan(sebelum);
    await expect(kirim).toBeEnabled(NAV);
    expect(log.preview.at(-1)!.order_date).toBe(kemarin);
    expect(log.sidik.at(-1)).not.toBe(sidikLama); // tanggal ikut sidik
    await kirim.click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(ws.kirim[0]).toMatchObject({ order_date: kemarin, sidik: log.sidik.at(-1) });
});

test("Order Sales (sidik): perkiraan gagal = Kirim terkunci + Hitung ulang (server tidak menerima simpan tanpa sidik); channel master beda = ditahan", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page, { cabang: opsi });
    await bukaSales(page);
    let gagal = true;
    opsi.preview = () => (gagal ? "putus" : undefined);
    const { main, b1 } = await isiSalesSiap(page);
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(main.getByText("Perkiraan harga tidak tersedia.")).toBeVisible(NAV);
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Perkiraan harga belum tersedia — hitung ulang dulu");
    gagal = false;
    await main.getByRole("button", { name: "Hitung ulang" }).click();
    await expect(b1).toContainText("Harga ada", NAV);
    await expect(kirim).toBeEnabled();

    // channel_masalah dari pratinjau: simpan pasti ditolak CHANNEL_BEDA_MASTER — tampil dan Kirim ditahan.
    opsi.channelMasalah = "Channel outlet C-01 menurut master MT, bukan GT";
    await b1.getByLabel("Jumlah").fill("3");
    await expect(main.getByText("Channel pelanggan berbeda dari master.")).toBeVisible(NAV);
    await expect(main).toContainText("menurut master MT, bukan GT");
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Channel outlet C-01 menurut master MT, bukan GT");
    expect(ws.kirim).toHaveLength(0);
    expect(log.sidik.length).toBeGreaterThan(0);
});

test("Order Sales (kode galat simpan): SIDIK_WAJIB dan KONFIGURASI_SERVER = kalimat + tindakan, PASTI tidak tersimpan (bukan 'belum pasti'); LAYANAN_TIDAK_PASTI = belum pasti", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    const wsOpsi: Parameters<typeof mockWebsales>[1] = { cabang: opsi, tolak: { status: 400, body: { ok: false, detail: "Hitung pratinjau order dulu.", kode: "SIDIK_WAJIB" } } };
    const ws = await mockWebsales(page, wsOpsi);
    await bukaSales(page);
    const { main } = await isiSalesSiap(page);
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeEnabled(NAV);
    await kirim.click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Kirim order" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Pratinjau belum dihitung.");
    await expect(dlg.getByRole("alert")).toContainText("Tunggu perkiraan harga dan promo selesai");
    await expect(dlg.getByRole("alert")).not.toContainText("SIDIK_WAJIB");

    wsOpsi.tolak = { status: 503, body: { ok: false, detail: "CRON_SECRET belum di-set", kode: "KONFIGURASI_SERVER" } };
    await dlg.getByRole("button", { name: "Kirim order" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Konfigurasi server bermasalah.");
    await expect(dlg.getByRole("alert")).toContainText("Hubungi Admin untuk memperbaiki konfigurasi server");
    await expect(dlg.getByRole("alert")).not.toContainText(/sesi login berakhir/i);
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Hasil kirim belum pasti." })).toHaveCount(0); // pasti tidak tersimpan
    await expect(kirim).toBeEnabled();

    wsOpsi.tolak = { status: 503, body: { ok: false, detail: "Next tidak menjawab", kode: "LAYANAN_TIDAK_PASTI" } };
    await kirim.click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).click();
    await expect(main.getByRole("status").filter({ hasText: "Hasil kirim belum pasti." })).toBeVisible(NAV);
    await expect(kirim).toBeDisabled();
    expect(ws.kirim).toHaveLength(3);
});

test("Order Sales: 'Order saya' menampilkan permintaan DITOLAK dengan sebabnya (kode -> kalimat), bukan 'menunggu'", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page, { cabang: opsi, baris: [
        { id: "9a9a9a9a-0000-4000-8000-000000000009", outlet: "PELANGGAN A", channel: "GT", order_date: HARI_INI, customer_no: "C-01", status: "rejected", created_at: new Date().toISOString(), pulled_at: null,
            reject_code: "PRATINJAU_BERUBAH", reject_reason: "Harga atau promo berubah sejak pratinjau", rejected_at: new Date().toISOString() },
    ] });
    const main = await bukaSales(page);
    const saya = main.getByRole("region", { name: "Order saya" });
    await expect(saya).toContainText("#9a9a9a9a", NAV);
    await expect(saya).toContainText("Ditolak petugas");
    await expect(saya).toContainText("Hitungan berubah sejak pratinjau.");
    await expect(saya).toContainText("buat order baru dengan isian yang sudah dibetulkan");
    await expect(saya).not.toContainText("PRATINJAU_BERUBAH");
    await expect(saya).not.toContainText("Menunggu ditarik petugas");
});

test("Order baru (sidik): simpan membawa sidik; PRATINJAU_BERUBAH = belum tersimpan + angka baru + konfirmasi ulang; ORDER_GANDA = centang konfirmasi lalu confirm_duplicate", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page);
    const antrean: Parameters<typeof mockOrdersInternal>[1] = { cabang: opsi };
    const orders = await mockOrdersInternal(page, antrean);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeEnabled(NAV);
    const sidikLama = log.sidik.at(-1)!;

    opsi.geser = 7000;
    await simpan.click();
    await page.getByRole("dialog").getByRole("button", { name: "Simpan order" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(orders.simpan).toHaveLength(1);
    expect(orders.simpan[0].sidik).toBe(sidikLama);
    const strip = main.getByRole("status").filter({ hasText: "Hitungan berubah sejak pratinjau — order BELUM tersimpan." });
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Rp 1.036.800 menjadi Rp 1.043.800");
    await expect(main.getByRole("group", { name: "Perkiraan nilai order" })).toContainText("Rp 1.043.800", NAV);
    await expect(simpan).toBeEnabled(NAV);

    // ORDER_GANDA pada simpan berikutnya: kalimat + tindakan, centang konfirmasi wajib, lalu confirm_duplicate.
    antrean.antrean = [{ status: 409, body: { ok: false, detail: "Mirip dengan order lain milik outlet ini pada tanggal yang sama", kode: "ORDER_GANDA" } }];
    await simpan.click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("Angka berubah sejak pratinjau sebelumnya: netto Rp 1.036.800 menjadi Rp 1.043.800.");
    await dlg.getByRole("button", { name: "Simpan dengan angka baru" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Diduga order ganda.");
    await expect(dlg.getByRole("alert")).toContainText("Mirip dengan order lain milik outlet ini");
    await expect(dlg.getByRole("alert")).toContainText("Periksa Order Masuk dulu. Bila memang BUKAN order ganda, centang konfirmasi di dialog lalu simpan lagi.");
    expect(orders.simpan[1].sidik).toBe(log.sidik.at(-1));
    expect(orders.simpan[1].confirm_duplicate).toBeUndefined();
    const ya = dlg.getByRole("checkbox", { name: /BUKAN order ganda/ });
    await expect(dlg.getByRole("button", { name: "Simpan dengan angka baru" })).toBeDisabled();
    await ya.check();
    await expect(dlg.getByRole("button", { name: "Simpan dengan angka baru" })).toBeEnabled();
    await dlg.getByRole("button", { name: "Simpan dengan angka baru" }).click();
    await expect.poll(() => orders.simpan.length).toBe(3);
    expect(orders.simpan[2]).toMatchObject({ confirm_duplicate: true, sidik: log.sidik.at(-1) });
});

test("Order baru (sidik): mengubah barang/jumlah membatalkan sidik lama; KONFIGURASI_SERVER = pasti tidak tersimpan (bukan belum pasti)", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page);
    const antrean: Parameters<typeof mockOrdersInternal>[1] = { cabang: opsi, antrean: [{ status: 503, body: { ok: false, detail: "CRON_SECRET belum di-set", kode: "KONFIGURASI_SERVER" } }] };
    const orders = await mockOrdersInternal(page, antrean);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeEnabled(NAV);
    const sidikLama = log.sidik.at(-1)!;
    let lepas: () => void = () => {};
    const tahan = new Promise<void>((ok) => { lepas = ok; });
    const sebelum = log.preview.length;
    opsi.preview = async (_b, n) => { if (n > sebelum) await tahan; return undefined; };
    await b1.getByLabel("Jumlah").fill("4");
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", "Menunggu harga dihitung");
    lepas();
    await expect(simpan).toBeEnabled(NAV);
    expect(log.sidik.at(-1)).not.toBe(sidikLama);
    await simpan.click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Simpan order" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Konfigurasi server bermasalah.");
    await expect(dlg.getByRole("alert")).toContainText("Hubungi Admin");
    await expect(dlg.getByRole("alert")).not.toContainText(/sesi login berakhir/i);
    expect(orders.simpan[0].sidik).toBe(log.sidik.at(-1));
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(main.getByText("Hasil simpan belum pasti.")).toHaveCount(0);
    await expect(simpan).toBeEnabled();
});

test("Order baru: HARGA_PETUGAS_TIDAK_DIIZINKAN (baris berharga master + harga petugas) = per baris 'sudah punya harga master' + Kosongkan harga, Simpan terkunci; UI tidak pernah mengirim harga untuk baris master", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page);
    await mockOrdersInternal(page, { cabang: opsi });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await expect(b1).toContainText("Harga master", NAV);
    // Server menolak (mis. data master berubah sesudah klasifikasi layar): kalimat per baris + tindakan, bukan layar kosong.
    opsi.preview = () => ({ status: 409, body: { ok: false, kode: "HARGA_PETUGAS_TIDAK_DIIZINKAN", error: "Harga master cabang CABANG A sudah ada untuk: A-1 KRT (Rp 576000). Harga petugas hanya untuk barang TANPA harga master; kosongkan harganya.",
        barang: [{ code: "A-1", unit: "KRT", hargaMaster: 576000 }] } });
    await b1.getByLabel("Jumlah").fill("3");
    await expect(b1.getByRole("alert")).toContainText("Sudah punya harga master Rp 576.000; harga petugas hanya untuk barang tanpa harga master.", NAV);
    await expect(b1.getByRole("alert")).toContainText("Kosongkan harga di barisnya");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", "Kosongkan harga barang 1: Harga petugas tidak diizinkan");
    expect(log.preview.every((b) => b.lines.every((l) => !l.price))).toBe(true);
});

test("Order Sales + Order baru: angka pratinjau berlabel 'sebelum PPN'; harga dari cabang default bertanda kecil 'harga cabang default'", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page, { cabang: opsi });
    await bukaSales(page);
    const { main, b1 } = await isiSalesSiap(page);
    const panel = main.getByRole("group", { name: "Perkiraan nilai order" });
    await expect(panel).toContainText("Netto estimasi (sebelum PPN)", NAV);
    await expect(panel).toContainText("Angka di atas sebelum PPN; PPN 11% ditambahkan saat faktur.");
    await expect(main.getByText("netto estimasi Rp 1.036.800 sebelum PPN")).toBeVisible();
    await expect(b1).not.toContainText("harga cabang default"); // cabang pelanggan punya baris harga sendiri
    await main.getByRole("button", { name: "Kirim order…" }).click();
    await expect(page.getByRole("dialog")).toContainText("Netto estimasi (sebelum PPN)");
    await page.getByRole("dialog").getByRole("button", { name: "Batal" }).click();
    // Harga dari fallback cabang default: bertanda sumbernya.
    opsi.preview = (b) => {
        const j = pratinjauContoh(b);
        if (j !== "putus" && j.body) (j.body as { prices: Record<string, unknown>[] }).prices = (j.body as { prices: Record<string, unknown>[] }).prices.map((p) => ({ ...p, hargaDefault: true, branchName: "CABANG DEFAULT" }));
        return j;
    };
    await b1.getByLabel("Jumlah").fill("3");
    await expect(b1).toContainText("harga cabang default · CABANG DEFAULT", NAV);
});

test("Order baru: ringkasan 'sebelum PPN' + PPN 11% + total faktur; BONUS_TIDAK_BISA_DIORDER = program promo tidak bisa dipakai (kalimat + tindakan), Simpan terkunci", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page);
    await mockOrdersInternal(page, { cabang: opsi });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    const panel = main.getByRole("group", { name: "Perkiraan nilai order" });
    await expect(panel).toContainText("Netto estimasi (sebelum PPN)", NAV);
    await expect(panel).toContainText("PPN 11%");
    await expect(panel).toContainText("Total faktur (estimasi)");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeEnabled();
    opsi.preview = () => ({ status: 409, body: { ok: false, kode: "BONUS_TIDAK_BISA_DIORDER", error: "Barang bonus promo tidak bisa diorder untuk pelanggan cabang CABANG A: G-9 (barang cabang CABANG B)",
        bonus: [{ code: "G-9", name: "BARANG G", alasan: "barang cabang CABANG B" }] } });
    await b1.getByLabel("Jumlah").fill("3");
    const strip = main.getByRole("alert").filter({ hasText: "Program promo tidak bisa dipakai." });
    await expect(strip).toBeVisible(NAV);
    await expect(strip).toContainText("Program promo untuk barang bonus G-9 BARANG G (barang cabang CABANG B) tidak bisa dipakai");
    await expect(strip).toContainText("Hubungi Admin untuk memeriksa barang bonus di Summary promo");
    await expect(strip).not.toContainText("BONUS_TIDAK_BISA_DIORDER");
    await expect(simpan).toBeDisabled();
});

test("Order Sales + Order baru: ATURAN_TERBIT_RUSAK (keadaan server) = kalimat 'bukan karena isian Anda' + tindakan Admin; Kirim/Simpan terkunci", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page, { cabang: opsi });
    await bukaSales(page);
    const { main } = await isiSalesSiap(page);
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeEnabled(NAV);
    opsi.preview = () => ({ status: 409, body: { ok: false, kode: "ATURAN_TERBIT_RUSAK", error: "Aturan terbit d1d1d1d1 program P-1 tidak lolos validasi: harga negatif" } });
    await main.getByLabel("Jumlah").first().fill("3");
    const strip = main.getByRole("alert").filter({ hasText: "Aturan promo terbit rusak." });
    await expect(strip).toBeVisible(NAV);
    await expect(strip).toContainText("tidak lolos validasi: harga negatif");
    await expect(strip).toContainText("bukan karena isian Anda");
    await expect(strip).not.toContainText("ATURAN_TERBIT_RUSAK");
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", /^Aturan promo terbit rusak\. Order belum bisa dihitung/);
});

// ---------------------------------------------------------------------------------------------- Promo "hampir dapat" (kartu ajakan di baris)

/** Server hipotetis: PROMO A baru berlaku mulai 5 KRT — di bawahnya tanpa diskon/bonus (saran menunjuk ke 5 KRT), sehingga "tercapai" bisa dibedakan dari "belum". */
function promoMulai5(b: PreviewBody): Jawab {
    const j = pratinjauContoh(b);
    const a1 = b.lines.find((l) => l.code === "A-1" && l.unit === "KRT");
    if (j === "putus" || !j.body || !a1 || Number(a1.quantity) >= 5) return j;
    const h = j.body as { result: { gross: string; discount: string; net: string; lines: { gross: string; net: string; percents: string[] }[]; applications: unknown[]; bonuses: unknown[] } };
    Object.assign(h.result, { discount: "0.00", net: h.result.gross, applications: [], bonuses: [] });
    h.result.lines = h.result.lines.map((l) => ({ ...l, net: l.gross, percents: [] }));
    return j;
}

test("Order Sales (promo hampir dapat): kartu kemajuan + kalimat server + tombol Tambah mengubah jumlah lalu pratinjau BARU; tercapai = penanda 'Program … terpakai'; tombol tidak mengirim", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page, { cabang: opsi });
    let tahan: Promise<void> | null = null;
    opsi.preview = async (b) => { if (tahan) await tahan; return promoMulai5(b); };
    await bukaSales(page);
    const { main, b1 } = await isiSalesSiap(page); // A-1 KRT x 2
    const kartu = b1.getByRole("group", { name: "Promo hampir tercapai barang 1" });
    await expect(kartu).toBeVisible(NAV);
    await expect(kartu).toContainText("PROMO A");
    await expect(kartu).toContainText("2 / 5 KRT");
    const bar = kartu.getByRole("progressbar", { name: "Kemajuan PROMO A" });
    await expect(bar).toHaveAttribute("aria-valuenow", "2");
    await expect(bar).toHaveAttribute("aria-valuemax", "5");
    await expect(kartu).toContainText("Tambah 3 KRT lagi untuk diskon 15%"); // kalimat server apa adanya, bukan angka buatan layar
    await expect(b1.getByRole("group", { name: "Promo barang 1" })).not.toContainText("terpakai"); // belum tercapai
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeEnabled(NAV);
    const sidikLama = log.sidik.at(-1)!;

    // Pratinjau berikutnya ditahan: tepat sesudah ketukan isian sudah berubah dan sidik lama tak boleh dipakai.
    let lepas: () => void = () => {};
    tahan = new Promise<void>((ok) => { lepas = ok; });
    await kartu.getByRole("button", { name: "Tambah 3 KRT" }).click();
    await expect(b1.getByLabel("Jumlah")).toHaveValue("5");
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Menunggu harga dihitung");
    lepas();
    await expect(kirim).toBeEnabled(NAV);
    expect(log.preview.at(-1)!.lines[0].quantity).toBe("5"); // pratinjau baru dengan jumlah baru
    expect(log.sidik.at(-1)).not.toBe(sidikLama);
    // Tercapai: kartu hilang, penanda sukses muncul di baris.
    await expect(b1.getByRole("group", { name: "Promo hampir tercapai barang 1" })).toHaveCount(0);
    await expect(b1.getByRole("group", { name: "Promo barang 1" })).toContainText("Program PROMO A terpakai");
    expect(ws.kirim).toHaveLength(0); // tombol HANYA mengubah jumlah; tidak mengirim apa pun
});

test("Order baru (promo hampir dapat): beberapa saran satu baris tampil SEMUA urut gap terkecil; tombol Tambah hanya program jumlah satu barang bersatuan sama; mix menyebut barangnya di baris pertama; program nilai di ringkasan", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page);
    const orders = await mockOrdersInternal(page, { cabang: opsi });
    opsi.saranTambahan = [
        { program_id: "prog-m", program_name: "PROMO MIX", threshold: "quantity", codes: ["A-1", "A-4"], minimum: "12", current: "7", gap: "5", message: "Tambah 5 KRT lagi untuk diskon 2%" },
        { program_id: "prog-v", program_name: "PROMO NILAI", threshold: "value", codes: ["A-1", "A-4"], minimum: "3000000", current: "1500000", gap: "1500000", message: "Tambah Rp 1.500.000 lagi untuk potongan Rp 50.000" },
        { program_id: "prog-u", program_name: "PROMO PCS", threshold: "quantity", codes: ["A-1"], minimum: "12", current: "10", gap: "2", message: "Tambah 2 PCS lagi untuk bonus 1 PCS" },
        { program_id: "prog-b", program_name: "PROMO BONUS", threshold: "quantity", codes: ["A-1"], minimum: "3", current: "2", gap: "1", message: "Tambah 1 KRT lagi untuk bonus 1 PCS" },
    ];
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    await main.getByRole("button", { name: "Tambah barang" }).click();
    const b2 = main.getByRole("listitem", { name: "Barang 2" });
    await pilihBarang(b2, "A-4", "BARANG A4");
    await b2.getByLabel("Satuan").selectOption("LSN");
    await b2.getByLabel("Jumlah").fill("4");

    const kartu = b1.getByRole("group", { name: "Promo hampir tercapai barang 1" });
    await expect(kartu).toBeVisible(NAV);
    // Semua saran baris itu, urut gap terkecil: BONUS (1), PCS (2), A (3), MIX (5).
    const bar = kartu.getByRole("progressbar");
    await expect(bar).toHaveCount(4);
    await expect(bar.nth(0)).toHaveAttribute("aria-label", "Kemajuan PROMO BONUS");
    await expect(bar.nth(1)).toHaveAttribute("aria-label", "Kemajuan PROMO PCS");
    await expect(bar.nth(2)).toHaveAttribute("aria-label", "Kemajuan PROMO A");
    await expect(bar.nth(3)).toHaveAttribute("aria-label", "Kemajuan PROMO MIX");
    await expect(kartu).toContainText("10 / 12 PCS");
    // Tombol hanya untuk program jumlah satu barang bersatuan sama (KRT): BONUS dan A. PCS (satuan beda) dan MIX tanpa tombol.
    await expect(kartu.getByRole("button")).toHaveCount(2);
    await expect(kartu.getByRole("button", { name: "Tambah 1 KRT" })).toBeVisible();
    await expect(kartu.getByRole("button", { name: "Tambah 3 KRT" })).toBeVisible();
    await expect(kartu.getByRole("button", { name: /Tambah 2 PCS/ })).toHaveCount(0);
    await expect(kartu.getByRole("button", { name: /Tambah 5/ })).toHaveCount(0);
    await expect(kartu).toContainText("Dihitung dari: BARANG A, BARANG A4"); // mix menyebut barang yang dihitung
    await expect(b2).not.toContainText("Dihitung dari:"); // ... hanya di baris pertama, tidak diulang di baris kedua
    await expect(b2.getByRole("group", { name: "Promo hampir tercapai barang 2" })).toHaveCount(0);
    // Program nilai: ringkasan order, tanpa tombol.
    const ringkas = main.getByRole("group", { name: "Promo hampir tercapai (seluruh order)" });
    await expect(ringkas).toContainText("PROMO NILAI", NAV);
    await expect(ringkas).toContainText("Rp 1.500.000 / Rp 3.000.000");
    await expect(ringkas).toContainText("Tambah Rp 1.500.000 lagi untuk potongan Rp 50.000");
    await expect(ringkas.getByRole("button")).toHaveCount(0);

    // Tombol menaikkan jumlah baris itu (+3) lalu pratinjau dihitung ulang; tidak menyimpan.
    await kartu.getByRole("button", { name: "Tambah 3 KRT" }).click();
    await expect(b1.getByLabel("Jumlah")).toHaveValue("5");
    await expect.poll(() => log.preview.at(-1)?.lines.find((l) => l.code === "A-1")?.quantity, NAV).toBe("5");
    expect(orders.simpan).toHaveLength(0);
});

// ---------------------------------------------------------------------------------------------- Putaran 1 peninjau

/** Server hipotetis: harga master A-2 LSN SUDAH terbit (daftar pencarian masih usang: LSN tanpa harga). Dengan harga petugas = ditolak; tanpa = dihitung dari master Rp 50.000. */
function masterA2Terbit(b: PreviewBody): Jawab {
    if (b.lines.some((l) => l.code === "A-2" && l.price)) {
        return { status: 409, body: { ok: false, kode: "HARGA_PETUGAS_TIDAK_DIIZINKAN", error: "Harga master cabang CABANG A sudah ada untuk: A-2 LSN (Rp 50000). Harga petugas hanya untuk barang TANPA harga master; kosongkan harganya.",
            barang: [{ code: "A-2", unit: "LSN", hargaMaster: 50000 }] } };
    }
    const j = pratinjauContoh({ ...b, lines: b.lines.map((l) => (l.code === "A-2" ? { ...l, price: "50000" } : l)) });
    if (j === "putus" || !j.body) return j;
    const h = j.body as { lines: { sumber_harga: string }[]; prices: { source: string; hargaMaster: number | null }[] };
    h.lines.forEach((l) => { l.sumber_harga = "master"; });
    h.prices.forEach((p) => { p.source = "tier"; p.hargaMaster = 50000; });
    return j;
}

test("Order baru (putaran 1 peninjau #3): daftar pencarian usang (tanpa harga master) tetapi pratinjau melaporkan harga master = baris berharga master — tidak buntu 'Isi harga' <-> 'Kosongkan harga'", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page);
    await mockOrdersInternal(page, { cabang: opsi });
    opsi.preview = masterA2Terbit;
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-2", "BARANG A2");
    await b1.getByLabel("Satuan").selectOption("LSN");
    await b1.getByLabel("Jumlah").fill("2");
    const harga = b1.getByLabel("Harga", { exact: true });
    await expect(harga).toBeEditable(NAV); // menurut daftar pencarian: tanpa harga master -> harga petugas
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await harga.fill("40000");
    await expect(b1.getByRole("alert")).toContainText("Sudah punya harga master Rp 50.000", NAV);
    await expect(simpan).toBeDisabled();
    await harga.fill(""); // sesuai petunjuk: kosongkan harga
    // Pratinjau tanpa harga melaporkan harga master -> pratinjau = sumber kebenaran: baris berharga master (baca-saja), Simpan terbuka.
    await expect(simpan).toBeEnabled(NAV);
    await expect(harga).not.toBeEditable();
    await expect(harga).toHaveValue("50000");
    await expect(b1).toContainText("Harga master");
    await expect(b1.getByRole("alert")).toHaveCount(0);
    // Tidak berputar: tidak ada pratinjau tambahan dan harga tidak dikirim untuk baris master.
    const n = log.preview.length;
    await page.waitForTimeout(1500);
    expect(log.preview.length).toBe(n);
    expect(log.preview.at(-1)!.lines[0].price).toBeUndefined();
});

test("Order Sales (putaran 1 peninjau #4): tanggal order dikosongkan = Kirim terkunci dengan alasan 'Isi tanggal order' (bukan aktif tanpa alasan); diisi lagi = terbuka", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page, { cabang: opsi });
    await bukaSales(page);
    const { main } = await isiSalesSiap(page);
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeEnabled(NAV);
    await main.getByLabel("Tanggal order").fill("");
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Isi tanggal order");
    await main.getByLabel("Tanggal order").fill(HARI_INI);
    await expect(kirim).toBeEnabled(NAV);
});

test("Order baru (putaran 1 peninjau #4): tanggal order dikosongkan = Simpan terkunci dengan alasan 'Isi tanggal order'; diisi lagi = terbuka", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page);
    await mockOrdersInternal(page, { cabang: opsi });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeEnabled(NAV);
    await main.getByLabel("Tanggal order").fill("");
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", "Isi tanggal order");
    await main.getByLabel("Tanggal order").fill(HARI_INI);
    await expect(simpan).toBeEnabled(NAV);
});

test("Order Sales (putaran 1 peninjau #5): jawaban 2xx tanpa ok ({}) = hasil kirim BELUM PASTI (bukan 'ditolak'), Kirim terkunci sampai Order saya diperiksa — tepat 1 POST", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page, { cabang: opsi, tolak: { status: 200, body: {} } });
    await bukaSales(page);
    const { main } = await isiSalesSiap(page);
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeEnabled(NAV);
    await kirim.click();
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(main.getByRole("status").filter({ hasText: "Hasil kirim belum pasti." })).toBeVisible();
    await expect(main.getByText("Permintaan ditolak server")).toHaveCount(0);
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Periksa Order saya dulu — order terakhir mungkin sudah masuk");
    expect(ws.kirim).toHaveLength(1);
});

test("Order Sales (putaran 1 peninjau #6): jumlah desimal ditolak di kolomnya (bilangan bulat > 0, papan angka), Kirim terkunci, tidak ada pratinjau dengan jumlah desimal; bulat = terbuka", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page, { cabang: opsi });
    await bukaSales(page);
    const { main, b1 } = await isiSalesSiap(page);
    const kirim = main.getByRole("button", { name: "Kirim order…" });
    await expect(kirim).toBeEnabled(NAV);
    const jumlah = b1.getByLabel("Jumlah");
    await expect(jumlah).toHaveAttribute("inputmode", "numeric");
    await jumlah.fill("2.5");
    await expect(jumlah).toHaveAttribute("aria-invalid", "true");
    await expect(b1).toContainText("Jumlah harus bilangan bulat lebih dari 0");
    await expect(kirim).toBeDisabled();
    await expect(kirim).toHaveAttribute("title", "Lengkapi satuan dan jumlah barang 1");
    await page.waitForTimeout(900); // lewat jeda pratinjau: desimal tidak pernah dikirim
    expect(log.preview.every((b) => b.lines.every((l) => /^\d+$/.test(l.quantity)))).toBe(true);
    await jumlah.fill("3");
    await expect(b1).not.toContainText("Jumlah harus bilangan bulat");
    await expect(kirim).toBeEnabled(NAV);
});

test("Order baru (putaran 1 peninjau #6): jumlah desimal ditolak di kolomnya, Simpan terkunci; bulat = terbuka", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page);
    await mockOrdersInternal(page, { cabang: opsi });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    const jumlah = b1.getByLabel("Jumlah");
    await jumlah.fill("2");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeEnabled(NAV);
    await jumlah.fill("2.5");
    await expect(jumlah).toHaveAttribute("aria-invalid", "true");
    await expect(b1).toContainText("Jumlah harus bilangan bulat lebih dari 0");
    await expect(simpan).toBeDisabled();
    await page.waitForTimeout(900);
    expect(log.preview.every((b) => b.lines.every((l) => /^\d+$/.test(l.quantity)))).toBe(true);
    await jumlah.fill("3");
    await expect(simpan).toBeEnabled(NAV);
});

test("Order Sales (putaran 1 peninjau #7): 'harga cabang default' hanya dari flag server hargaDefault — nama cabang harga yang berbeda tanpa flag TIDAK ditebak sebagai default", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page, { cabang: opsi });
    await bukaSales(page);
    const { b1 } = await isiSalesSiap(page);
    await expect(b1).toContainText("Harga ada", NAV);
    const ubahCabang = (hargaDefault: boolean) => (b: PreviewBody): Jawab => {
        const j = pratinjauContoh(b);
        if (j !== "putus" && j.body) (j.body as { prices: Record<string, unknown>[] }).prices = (j.body as { prices: Record<string, unknown>[] }).prices.map((p) => ({ ...p, hargaDefault, branchName: "CABANG LAIN" }));
        return j;
    };
    opsi.preview = ubahCabang(false); // nama cabang harga != cabang pelanggan, tetapi server TIDAK menandai default
    await b1.getByLabel("Jumlah").fill("3");
    await expect(b1).toContainText("Harga ada", NAV);
    await expect(b1).not.toContainText("harga cabang default");
    opsi.preview = ubahCabang(true); // server menandai default
    await b1.getByLabel("Jumlah").fill("4");
    await expect(b1).toContainText("harga cabang default · CABANG LAIN", NAV);
});

test("Order Sales (putaran 1 peninjau #8): dua ketukan cepat pada tombol konfirmasi Kirim saat server lambat = tepat 1 POST (penjaga inFlight)", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page, { cabang: opsi, lambatMs: 1500 });
    await bukaSales(page);
    const { main } = await isiSalesSiap(page);
    await expect(main.getByRole("button", { name: "Kirim order…" })).toBeEnabled(NAV);
    await main.getByRole("button", { name: "Kirim order…" }).click();
    // Dua klik dalam SATU tugas JS: atribut disabled baru berlaku sesudah render, hanya ref inFlight yang bisa menahan yang kedua.
    await page.getByRole("dialog").getByRole("button", { name: "Kirim order" }).evaluate((el: HTMLElement) => { el.click(); el.click(); });
    await expect(page.getByRole("dialog")).toBeHidden(NAV);
    expect(ws.kirim).toHaveLength(1);
});

test("Order baru (putaran 1 peninjau #8): dua ketukan cepat pada tombol konfirmasi Simpan saat server lambat = tepat 1 POST (penjaga inFlight)", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page);
    const orders = await mockOrdersInternal(page, { cabang: opsi, lambatMs: 1500 });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeEnabled(NAV);
    await simpan.click();
    await page.getByRole("dialog").getByRole("button", { name: "Simpan order" }).evaluate((el: HTMLElement) => { el.click(); el.click(); });
    await expect.poll(() => orders.simpan.length, NAV).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(2200); // lewat jeda server: POST kedua (bila ada) sudah tercatat
    expect(orders.simpan).toHaveLength(1);
});

test("Order Sales (putaran 1 peninjau #9): jeda pencarian TERUKUR >= 300 ms antara ketukan terakhir dan permintaan (bukan sekadar 'satu permintaan')", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page, { cabang: opsi });
    type Ukur = { akhirKetik: number; permintaan: number[] };
    await page.addInitScript(() => {
        const w = window as unknown as { __cari: Ukur };
        w.__cari = { akhirKetik: 0, permintaan: [] };
        document.addEventListener("input", () => { w.__cari.akhirKetik = performance.now(); }, true);
        const asli = window.fetch.bind(window);
        window.fetch = (...a: Parameters<typeof fetch>) => {
            const u = String(a[0] instanceof Request ? a[0].url : a[0]);
            if (u.includes("/api/customers/search") && u.includes("q=")) w.__cari.permintaan.push(performance.now());
            return asli(...a);
        };
    });
    const main = await bukaSales(page);
    await expect(main.getByLabel("Cari pelanggan")).toBeVisible(NAV);
    await main.getByLabel("Cari pelanggan").pressSequentially("PELANG", { delay: 40 });
    await expect(main.getByRole("list", { name: "Hasil pencarian pelanggan" }).getByRole("button")).toHaveCount(3, NAV);
    const t = await page.evaluate(() => (window as unknown as { __cari: Ukur }).__cari);
    expect(t.permintaan).toHaveLength(1);
    expect(t.permintaan[0] - t.akhirKetik).toBeGreaterThanOrEqual(295); // jeda 300 ms (toleransi pembulatan jam)
});

// ---------------------------------------------------------------------------------------------- Putaran 2 peninjau

test("Order Sales (putaran 2 peninjau #1): kode + satuan sama di dua baris = saran milik baris masing-masing (jumlah === current); tombol di baris 2 hanya mengubah baris 2", async ({ page }) => {
    const { log, opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page, { cabang: opsi });
    await bukaSales(page);
    const { main, b1 } = await isiSalesSiap(page); // baris 1: A-1 KRT x 2
    await b1.getByLabel("Jumlah").fill("1");
    await main.getByRole("button", { name: "Tambah barang" }).click();
    const b2 = main.getByRole("listitem", { name: "Barang 2" });
    await pilihBarang(b2, "A-1", "BARANG A\\b.*KRT");
    await b2.getByLabel("Satuan").selectOption("KRT");
    await b2.getByLabel("Jumlah").fill("3");
    const k1 = b1.getByRole("group", { name: "Promo hampir tercapai barang 1" });
    const k2 = b2.getByRole("group", { name: "Promo hampir tercapai barang 2" });
    await expect(k1).toContainText("1 / 5 KRT", NAV);
    await expect(k1.getByRole("button", { name: "Tambah 4 KRT" })).toBeVisible();
    await expect(k1).not.toContainText("3 / 5 KRT"); // dulu kartu baris 2 ikut menempel di baris 1
    await expect(k2).toContainText("3 / 5 KRT", NAV);
    await expect(k2.getByRole("button", { name: "Tambah 2 KRT" })).toBeVisible();
    await expect(k2.getByRole("progressbar")).toHaveCount(1);
    // Tombol baris 2: hanya baris 2 yang berubah (3 -> 5), baris 1 tetap 1.
    await k2.getByRole("button", { name: "Tambah 2 KRT" }).click();
    await expect(b2.getByLabel("Jumlah")).toHaveValue("5");
    await expect(b1.getByLabel("Jumlah")).toHaveValue("1");
    await expect.poll(() => log.preview.at(-1)?.lines.map((l) => l.quantity).join(","), NAV).toBe("1,5");
});

test("Order baru (putaran 2 peninjau #1): dua baris kode+satuan+jumlah sama = ambigu: SATU kartu di ringkasan yang menyebut baris 1 dan 2, TANPA tombol, tidak ada kartu di baris", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page);
    await mockOrdersInternal(page, { cabang: opsi });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("3");
    await main.getByRole("button", { name: "Tambah barang" }).click();
    const b2 = main.getByRole("listitem", { name: "Barang 2" });
    await pilihBarang(b2, "A-1", "BARANG A\\b.*KRT");
    await b2.getByLabel("Satuan").selectOption("KRT");
    await b2.getByLabel("Jumlah").fill("3");
    const ringkas = main.getByRole("group", { name: "Promo hampir tercapai (seluruh order)" });
    await expect(ringkas).toBeVisible(NAV);
    await expect(ringkas.getByRole("progressbar")).toHaveCount(1); // saran kembar digabung
    await expect(ringkas).toContainText("3 / 5 KRT");
    await expect(ringkas).toContainText("barang yang sama ada di baris 1, 2");
    await expect(ringkas.getByRole("button")).toHaveCount(0);
    await expect(b1.getByRole("group", { name: "Promo hampir tercapai barang 1" })).toHaveCount(0);
    await expect(b2.getByRole("group", { name: "Promo hampir tercapai barang 2" })).toHaveCount(0);
});

test("Order Sales (putaran 2 peninjau #3): N tombol = ceil(gap) dari field gap (kalimat server membulatkan 2,5 jadi 'Tambah 2'): tombol 'Tambah 3 KRT', bukan 'Tambah 2'; gap 0 = tanpa tombol", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page, { peran: "sales" });
    await mockWebsales(page, { cabang: opsi });
    opsi.saranTambahan = [
        { program_id: "prog-g", program_name: "PROMO GAP", threshold: "quantity", codes: ["A-1"], minimum: "6.5", current: "4", gap: "2.5", message: "Tambah 2 KRT lagi untuk diskon 3%" },
        { program_id: "prog-0", program_name: "PROMO NOL", threshold: "quantity", codes: ["A-1"], minimum: "4", current: "4", gap: "0", message: "Tambah 0 KRT lagi untuk diskon 4%" },
    ];
    await bukaSales(page);
    const { b1 } = await isiSalesSiap(page);
    await b1.getByLabel("Jumlah").fill("4");
    const kartu = b1.getByRole("group", { name: "Promo hampir tercapai barang 1" });
    await expect(kartu).toContainText("PROMO GAP", NAV);
    await expect(kartu).toContainText("Tambah 2 KRT lagi untuk diskon 3%"); // kalimat server apa adanya
    await expect(kartu.getByRole("button", { name: "Tambah 3 KRT" })).toBeVisible(); // ceil(2,5)
    await expect(kartu.getByRole("button", { name: "Tambah 2 KRT" })).toHaveCount(0);
    await expect(kartu).toContainText("PROMO NOL");
    await expect(kartu.getByRole("button")).toHaveCount(2); // PROMO A (gap 1) dan PROMO GAP; PROMO NOL (gap 0) tanpa tombol
    await kartu.getByRole("button", { name: "Tambah 3 KRT" }).click();
    await expect(b1.getByLabel("Jumlah")).toHaveValue("7");
});

test("Order baru (putaran 2 peninjau #2): simpan dijawab 2xx tanpa ok/id ({} atau {ok:true}) = hasil BELUM PASTI — tidak pindah halaman, Simpan terkunci sampai Order Masuk diperiksa, tepat 1 POST", async ({ page }) => {
    const { opsi } = await mockOrderCabang(page);
    const antrean: Jawab[] = [{ status: 200, body: {} }];
    const orders = await mockOrdersInternal(page, { cabang: opsi, antrean });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-1", "BARANG A\\b.*KRT");
    await b1.getByLabel("Satuan").selectOption("KRT");
    await b1.getByLabel("Jumlah").fill("2");
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toBeEnabled(NAV);
    await simpan.click();
    await page.getByRole("dialog").getByRole("button", { name: "Simpan order" }).click();
    await expect(page.getByRole("dialog")).toBeHidden(NAV);
    await expect(main.getByRole("status").filter({ hasText: "Hasil simpan belum pasti." })).toBeVisible();
    await expect(page).toHaveURL(/\/orders\/baru$/); // tidak dibawa ke /orders seolah tersimpan
    await expect(simpan).toBeDisabled();
    await expect(simpan).toHaveAttribute("title", "Periksa Order Masuk dulu — order terakhir mungkin sudah tersimpan");
    expect(orders.simpan).toHaveLength(1);
    // {ok:true} tanpa id order = juga belum pasti. Mengubah isian melepas tahanan.
    antrean.push({ status: 200, body: { ok: true } });
    await b1.getByLabel("Jumlah").fill("3");
    await expect(simpan).toBeEnabled(NAV);
    await simpan.click();
    await page.getByRole("dialog").getByRole("button", { name: "Simpan order" }).click();
    await expect(page.getByRole("dialog")).toBeHidden(NAV);
    await expect(main.getByRole("status").filter({ hasText: "Hasil simpan belum pasti." })).toBeVisible();
    await expect(page).toHaveURL(/\/orders\/baru$/);
    expect(orders.simpan).toHaveLength(2);
});
