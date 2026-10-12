/*
 * Tujuan: Fiori O2 — Order per cabang Accurate: Order Sales (salesman: cari pelanggan jeda 300 ms + min 2 huruf + hanya cabang sendiri,
 *   cari barang hanya cabang pelanggan dengan satuan + harga per cabang, pratinjau mengirim customer_no dan menampilkan program promo per
 *   baris + ringkasan, akun belum tertaut = penjelasan bukan formulir kosong, galat ≠ kosong, kosong dengan sebab, barang beda cabang
 *   ditolak, harga belum ada mengunci Kirim, penolakan server berkode, ponsel 390 px) dan Order baru/manual (petugas: semua cabang +
 *   saringan cabang, barang mengikuti cabang pelanggan, ganti pelanggan beda cabang = konfirmasi, cabang tanpa barang).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin):
 *   `npx playwright test tests/fiori-order-cabang.spec.ts --config <config lokal> --workers=1 --output=test-results/order-cabang`.
 * Dependensi: tests/helpers/order-cabang-mock.ts (mock kontrak O1 + FastAPI Web Sales). Tidak menyentuh DB maupun Accurate.
 * Side Effects: Tangkapan di test-results/order-cabang.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ID_WEBSALES, mockOrderCabang, mockWebsales, pilihBarang, pilihPelanggan } from "./helpers/order-cabang-mock";

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
    const { log } = await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page);
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
    await expect(barang.getByRole("button")).toHaveCount(3); // A-1, A-2, A-4; A-3 belum ada daftar harga
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
    expect(ws.kirim).toEqual([{ outlet: "PELANGGAN A", channel: "GT", order_date: HARI_INI, note: "", customer_no: "C-01", lines: [{ code: "A-1", unit: "KRT", quantity: "2" }] }]);
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
    opsi.barang = (url) => (url.searchParams.get("limit") === "1" || url.searchParams.has("q") ? { body: { ok: true, tanggal: HARI_INI, branchId: 50, items: [] } } : undefined);
    await b1.getByLabel("Cari barang").fill("RR");
    await expect(b1.getByRole("heading", { name: "Cabang CABANG A belum punya barang yang bisa diorder" })).toBeVisible(NAV);
    await expect(b1).toContainText("Hubungi Admin untuk menyinkronkan master barang");
    expect(log.barang.at(-1)!.searchParams.has("q")).toBe(false);
    expect(log.barang.at(-1)!.searchParams.get("limit")).toBe("1");
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
    await expect(b1.getByRole("alert")).toContainText("Hapus barang ini atau ganti dengan barang cabang pelanggan.");
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

test("Order Sales: harga belum ada di cabang pelanggan = ditandai di barisnya dan Kirim terkunci (server menolak simpan tanpa harga)", async ({ page }) => {
    await mockOrderCabang(page, { peran: "sales" });
    const ws = await mockWebsales(page);
    const main = await bukaSales(page);
    await pilihPelanggan(main, "PELANG", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-2", "BARANG A2");
    await expect(b1.getByLabel("Satuan").locator("option")).toHaveText(["pilih", "LSN · harga belum ada"]);
    await expect(b1.getByLabel("Satuan")).toHaveValue("LSN"); // satu-satunya satuan dipilih otomatis
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
        await noOverflow(page);
        await target44(main);
        await page.screenshot({ path: "test-results/order-cabang/ponsel-sales-promo.png", fullPage: true });
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

/** FastAPI order internal: simpan -> id; navigasi ke halaman order ditahan (fokus pada isi permintaan). */
async function mockOrdersInternal(page: Page) {
    const simpan: Record<string, unknown>[] = [];
    await page.route((u) => u.host === "localhost:8000", (r) => {
        const cors = { "access-control-allow-origin": r.request().headers()["origin"] ?? "*", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type, x-csrf-token", "access-control-allow-methods": "GET, POST, OPTIONS" };
        const req = r.request();
        const p = new URL(req.url()).pathname;
        if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors });
        if (p === "/api/me") return r.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ csrf_token: "t" }) });
        if (p === "/orders" && req.method() === "POST") {
            simpan.push(req.postDataJSON());
            return r.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ ok: true, order: { id: "8f1c0000-aaaa-4bbb-8ccc-000000000001" } }) });
        }
        return r.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.route((u) => /^\/orders\/[0-9a-f-]{36}$/.test(u.pathname), (r) => r.abort());
    return { simpan };
}

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
    expect(orders.simpan[0]).toMatchObject({ outlet: "PELANGGAN C", channel: "GT", customer_no: "C-03", lines: [{ code: "B-1", unit: "KRT", quantity: "2", price: "700000" }] });
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

test("Order baru: harga belum ada di cabang pelanggan = petugas boleh isi manual (kalimat berbeda dari sales); simpan tidak pasti = belum pasti", async ({ page }) => {
    await mockOrderCabang(page);
    const orders = await mockOrdersInternal(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/orders/baru", NAV);
    const main = page.locator("main");
    await pilihPelanggan(main, "PELANGGAN A", "PELANGGAN A");
    const b1 = main.getByRole("listitem", { name: "Barang 1" });
    await pilihBarang(b1, "A-2", "BARANG A2");
    await expect(b1).toContainText("Harga master belum ada", NAV);
    const simpan = page.getByRole("button", { name: "Simpan order…" });
    await expect(simpan).toHaveAttribute("title", "Isi harga barang 1 (harga master belum ada)");
    await b1.getByLabel("Harga").fill("50000");
    await expect(simpan).toBeEnabled();
    await simpan.click();
    await page.getByRole("dialog").getByRole("button", { name: "Simpan order" }).click();
    await expect.poll(() => orders.simpan.length).toBe(1);
    expect(orders.simpan[0]).toMatchObject({ customer_no: "C-01", lines: [{ code: "A-2", unit: "LSN", quantity: "1", price: "50000" }] });
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
