/*
 * Tujuan: Regresi UI Normalisasi Diskon (wajib aturan promo dasar, dialog Golongkan Fiori S4a) dan saringan Aturan Promo,
 *   termasuk keadaan memuat / kosong / galat dan penjaga kirim ganda.
 * Caller: `npx playwright test tests/normalisasi-aturan-promo.spec.ts` terhadap dev server dengan
 *   LOCAL_AUTH_BYPASS=true (lihat tests/local-off-auth-bypass.spec.ts).
 * Dependensi: @playwright/test. API dipalsukan lewat page.route — tidak menyentuh DB maupun Accurate.
 * Side Effects: Tidak ada.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const baris = (over: Record<string, unknown>) => ({
    bucket: "unowned", invoiceNo: "INV/2610/KN00001", invoiceId: "9000001", lineKey: "1", transDate: "2026-10-01",
    branchName: "KINO NON FOOD", customerNo: "C-AL0063-KN", customerName: "ALFAMART MAJU JAYA",
    itemCode: "K1041001025010", itemName: "KNF B&B 250ML", positions: "4", percent: 0.75, amount: 2533.68,
    suratProgram: "", promoGroup: "", reason: "0.75% (posisi 4) tidak sama dengan aturan principal yang berlaku",
    calonAturan: { principal: [11, 12], distributor: [] }, ...over,
});

const aturan = (id: number, over: Record<string, unknown> = {}) => ({
    id, suratProgram: `BP26100079${id}`, promoGroup: "B&B ALL VARIANT", promoLabel: "PROMO ON PO", itemCode: "K1041001025010",
    itemName: "", customerCode: "", periodStart: "2026-10-01", periodEnd: "2026-10-31", tierNo: 1,
    benefitType: "DISC_PCT", benefitValue: "3", benefitBeban: "PRINCIPAL", outletList: "", outletListMode: "", ...over,
});

const rekap = {
    ok: true, principals: ["KINO NON FOOD"], webInvoiceIds: [],
    recap: { rows: [baris({}), baris({ invoiceNo: "INV/2610/KN00003", invoiceId: "9000003", lineKey: "3", customerNo: "C-TK0002-KN",
        customerName: "TOKO BERKAH", positions: "1", percent: 2, amount: 10000, calonAturan: { principal: [], distributor: [] },
        reason: "tidak ada aturan distributor untuk outlet ini" })] },
    aturan: [aturan(11), aturan(12, { benefitValue: "0.75", customerCode: "C-AL0063", itemCode: "", tierNo: 4, suratProgram: "DISCOUNT REGULER" })],
};

const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function bukaNormalisasi(page: Page, jawab: (route: Route) => Promise<void> = (route) => json(route, rekap)) {
    await page.route((url) => url.pathname === "/api/promo-recap", jawab);
    await page.goto("/normalisasi-diskon");
}

/** Pilih baris, buka dialog Golongkan, pilih beban. */
async function golongkan(page: Page, baris: string[], beban: "principal" | "distributor") {
    for (const nama of baris) await page.getByRole("checkbox", { name: nama }).check();
    await page.getByRole("button", { name: "Golongkan…" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Beban").selectOption(beban);
    return dlg;
}

test("Normalisasi: memuat, lalu Klaim principal wajib memilih aturan yang berlaku; kirim ganda dicegah", async ({ page }) => {
    let lepas!: () => void;
    const tahan = new Promise<void>((resolve) => { lepas = resolve; });
    await bukaNormalisasi(page, async (route) => { await tahan; await json(route, rekap); });
    // Memuat terlihat sebagai memuat, BUKAN sebagai "tidak ada potongan".
    await expect(page.locator("main").getByRole("status").filter({ hasText: "Memuat data" })).toBeAttached();
    await expect(page.getByText("Tidak ada potongan tak bertuan pada periode ini")).toHaveCount(0);
    lepas();

    await expect(page.getByRole("button", { name: "Golongkan…" })).toHaveCount(0); // belum ada yang dipilih
    const dlg = await golongkan(page, ["Pilih INV/2610/KN00001 posisi 4"], "distributor");
    const dasar = dlg.getByLabel(/Aturan promo dasar/);
    const simpan = dlg.getByRole("button", { name: /^Golongkan sebagai/ });
    // Beban distributor tanpa aturan distributor yang berlaku: tidak bisa disimpan, dan sebabnya disebut.
    await expect(dasar).toBeDisabled();
    await expect(dlg.getByText("Tidak ada aturan promo yang berlaku untuk potongan ini.", { exact: false })).toBeVisible();
    await expect(simpan).toBeDisabled();

    await dlg.getByLabel("Beban").selectOption("principal");
    await expect(dasar).toBeEnabled();
    // Nilai yang sama dengan potongannya (0,75%) didahulukan.
    await expect(dasar.locator("option").nth(1)).toContainText("nilai sama");
    await expect(simpan).toBeDisabled();
    await dasar.selectOption("DISCOUNT REGULER");
    await expect(simpan).toBeEnabled();

    const kiriman: unknown[] = [];
    await page.route((url) => url.pathname === "/api/promo-recap/normalisasi", async (route) => {
        kiriman.push(route.request().postDataJSON());
        await new Promise((resolve) => setTimeout(resolve, 400));
        await json(route, { ok: true, disimpan: 1, bucket: "principal", aturan: "DISCOUNT REGULER" });
    });
    await simpan.dblclick();
    await expect(page.getByText("1 potongan digolongkan sebagai Klaim principal.")).toBeVisible();
    expect(kiriman).toHaveLength(1);
    expect(kiriman[0]).toMatchObject({ bucket: "principal", rows: [{ promoRuleId: 12, lineKey: "1", positions: "4", branchName: "KINO NON FOOD" }] });
});

test("Normalisasi: penolakan server ditampilkan di dialog dan pilihan tidak hilang", async ({ page }) => {
    await bukaNormalisasi(page);
    const dlg = await golongkan(page, ["Pilih INV/2610/KN00001 posisi 4"], "principal");
    await dlg.getByLabel(/Aturan promo dasar/).selectOption("BP2610007911");
    await page.route((url) => url.pathname === "/api/promo-recap/normalisasi", (route) =>
        json(route, { ok: false, error: "Aturan BP2610007911 tidak berlaku untuk INV/2610/KN00001: tanggal faktur di luar periode" }, 422));
    await dlg.getByRole("button", { name: "Golongkan sebagai Klaim principal" }).click();
    await expect(dlg.getByRole("alert").filter({ hasText: "Aturan BP2610007911 tidak berlaku" })).toBeVisible();
    await expect(dlg.getByLabel(/Aturan promo dasar/)).toHaveValue("BP2610007911");
    await dlg.getByRole("button", { name: "Batal" }).click();
    await expect(page.getByRole("checkbox", { name: "Pilih INV/2610/KN00001 posisi 4" })).toBeChecked();
});

test("Normalisasi: galat memuat terlihat sebagai galat, bisa dicoba lagi", async ({ page }) => {
    let gagal = true;
    await bukaNormalisasi(page, (route) => (gagal ? json(route, { ok: false, error: "statement timeout" }, 500) : json(route, rekap)));
    await expect(page.locator("main").getByRole("alert").filter({ hasText: "statement timeout" }).first()).toBeVisible();
    await expect(page.getByText("Tidak ada potongan tak bertuan pada periode ini")).toHaveCount(0);
    gagal = false;
    await page.getByRole("button", { name: "Coba lagi" }).first().click();
    await expect(page.getByRole("table", { name: "Tak bertuan" }).getByText("ALFAMART MAJU JAYA")).toBeVisible();
});

test("Aturan Promo: saringan bergabung dan bisa dihapus; tanggal dd/mm/yyyy; kosong dan galat berbeda", async ({ page }) => {
    const diminta: URLSearchParams[] = [];
    let jawaban: "isi" | "kosong" | "galat" = "isi";
    await page.route((url) => url.pathname === "/api/promo-rule", async (route) => {
        diminta.push(new URL(route.request().url()).searchParams);
        if (jawaban === "galat") return json(route, { ok: false, error: "koneksi database putus" }, 500);
        const rules = jawaban === "kosong" ? [] : [{ ...aturan(11), principal: "KINO NON FOOD", active: true, triggerQty: "0",
            triggerUnit: "PCS", benefitUnit: "%", channel: "", note: "", importedBy: "", periodStart: "2026-10-01", periodEnd: "2099-10-31" }];
        return json(route, { ok: true, principals: ["KINO NON FOOD"], total: 1, rules, truncated: 0 });
    });
    await page.goto("/aturan-promo");
    const daftar = page.getByRole("list", { name: "Daftar aturan" });
    await expect(daftar.getByRole("button", { name: /#11/ })).toContainText("BP2610007911");
    await daftar.getByRole("button", { name: /#11/ }).click();
    // Tanggal tampil dd/mm/yyyy.
    await expect(page.getByRole("region", { name: "Detail aturan" })).toContainText("01/10/2026 – 31/10/2099");

    const saringan = page.locator(".fi-fbar"); // formulir detail juga punya isian Principal dan Beban
    await saringan.getByRole("combobox", { name: "Principal", exact: true }).selectOption("KINO NON FOOD");
    await saringan.getByRole("combobox", { name: "Beban" }).selectOption("PRINCIPAL");
    await saringan.getByLabel("Berlaku dari").fill("2026-09-01");
    await saringan.getByLabel("Berlaku sampai").fill("2026-09-30");
    await page.getByRole("searchbox", { name: "Cari" }).fill("B&B");
    await expect.poll(() => diminta.at(-1)?.toString()).toContain("q=B%26B");
    expect(Object.fromEntries(diminta.at(-1)!)).toMatchObject({ principal: "KINO NON FOOD", beban: "PRINCIPAL", dari: "2026-09-01", sampai: "2026-09-30", q: "B&B" });
    await expect(page.getByRole("list", { name: "Saringan aktif" })).toContainText("Berlaku: 01/09/2026 – 30/09/2026");

    jawaban = "kosong";
    await page.getByRole("button", { name: "Hapus saringan Berlaku: 01/09/2026 – 30/09/2026" }).click();
    await expect.poll(() => diminta.at(-1)?.has("dari")).toBe(false);
    expect(diminta.at(-1)?.get("principal")).toBe("KINO NON FOOD");
    await expect(page.getByText("Tidak ada aturan untuk “B&B”")).toBeVisible();

    jawaban = "galat";
    await page.getByRole("searchbox", { name: "Cari" }).fill("B&B ALL");
    await expect(page.getByRole("alert").filter({ hasText: "koneksi database putus" })).toBeVisible();
});

test("Normalisasi: keputusan yang tidak dipakai lagi ada di kelompok Perlu diputuskan ulang dan bisa dirujukkan ulang", async ({ page }) => {
    const bekas = baris({ invoiceNo: "INV/2609/KN00999", invoiceId: "9000999", lineKey: "9", bekasNormalisasi: "principal",
        reason: "0.75% (posisi 4) tidak sama — normalisasi Disc Claim oleh ari TIDAK dipakai: keputusan lama tanpa aturan promo dasar — putuskan ulang dengan aturan" });
    await bukaNormalisasi(page, (route) => json(route, { ...rekap, recap: { rows: [...rekap.recap.rows, bekas] } }));
    await page.getByRole("group", { name: "Kelompok potongan" }).getByRole("button", { name: "Perlu diputuskan ulang 1" }).click();
    await expect(page.getByRole("table", { name: "Perlu diputuskan ulang" }).getByText("TOKO BERKAH")).toHaveCount(0);
    const dlg = await golongkan(page, ["Pilih INV/2609/KN00999 posisi 4"], "principal");
    await dlg.getByLabel(/Aturan promo dasar/).selectOption("BP2610007911");
    await expect(dlg.getByRole("button", { name: "Golongkan sebagai Klaim principal" })).toBeEnabled();
});

test("Normalisasi: satu faktur, dua barang — satu surat, tiap barang memakai aturannya sendiri", async ({ page }) => {
    // INV/2610/KN00011: bonus Amusing Vanilla + Gel Enchanting dalam satu baris (faktur x posisi x persen).
    const dua = [
        baris({ invoiceNo: "INV/2610/KN00011", invoiceId: "355605", lineKey: "a", itemCode: "K1111005005010", positions: "1", percent: 100,
            amount: 45946.2, calonAturan: { principal: [490], distributor: [] } }),
        baris({ invoiceNo: "INV/2610/KN00011", invoiceId: "355605", lineKey: "b", itemCode: "K1111009010010", positions: "1", percent: 100,
            amount: 81081, calonAturan: { principal: [499], distributor: [] } }),
    ];
    const eskulin = (id: number, itemCode: string) => aturan(id, { suratProgram: "BP2610009097", promoGroup: "ESKULIN - COLOGNE", itemCode,
        benefitType: "BONUS_QTY", benefitValue: "1", outletList: "LOYALTY", outletListMode: "INCLUDE" });
    await bukaNormalisasi(page, (route) => json(route, { ...rekap, recap: { rows: dua }, aturan: [eskulin(490, "K1111005005010"), eskulin(499, "K1111009010010")] }));
    await expect(page.getByText("Surat berlaku: 1 klaim principal · 0 beban distributor")).toBeVisible();
    const dlg = await golongkan(page, ["Pilih INV/2610/KN00011 posisi 1"], "principal");
    const dasar = dlg.getByLabel(/Aturan promo dasar/);
    await expect(dasar.locator("option", { hasText: "BP2610009097" })).toContainText("BP2610009097 · ESKULIN - COLOGNE · bonus 1 · 2 aturan (per barang)");
    await dasar.selectOption("BP2610009097");
    const kiriman: Array<{ rows: Array<{ promoRuleId: number; itemCode: string }> }> = [];
    await page.route((url) => url.pathname === "/api/promo-recap/normalisasi", async (route) => {
        kiriman.push(route.request().postDataJSON());
        await json(route, { ok: true, disimpan: 2, bucket: "principal", aturan: "BP2610009097" });
    });
    await dlg.getByRole("button", { name: "Golongkan sebagai Klaim principal" }).click();
    await expect(page.getByText("2 potongan digolongkan sebagai Klaim principal.")).toBeVisible();
    expect(kiriman[0].rows.map((row) => [row.itemCode, row.promoRuleId])).toEqual([["K1111005005010", 490], ["K1111009010010", 499]]);
});

test("Normalisasi: otomatis per baris hanya untuk yang punya tepat satu aturan bernilai sama; sisanya dilewati", async ({ page }) => {
    const ambigu = baris({ invoiceNo: "INV/2610/KN00006", invoiceId: "9000006", lineKey: "6", positions: "1", percent: 2.5, amount: 4500,
        customerName: "TOKO WINDA", calonAturan: { principal: [21, 22], distributor: [] } });
    const dua = (id: number, surat: string) => aturan(id, { suratProgram: surat, benefitValue: "2.5" });
    await bukaNormalisasi(page, (route) => json(route, { ...rekap, recap: { rows: [...rekap.recap.rows, ambigu] },
        aturan: [...rekap.aturan, dua(21, "BP2609009001"), dua(22, "BP2609009002")] }));
    await page.getByRole("table", { name: "Tak bertuan" }).getByRole("checkbox", { name: "Pilih semua baris" }).check();
    await page.getByRole("button", { name: "Golongkan…" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Beban").selectOption("principal");
    // Tiga faktur, surat berbeda: tidak ada satu surat untuk semuanya.
    await expect(dlg.getByText("Tidak ada satu surat untuk semua potongan terpilih — pilih “Otomatis per baris”", { exact: false })).toBeVisible();
    const dasar = dlg.getByLabel(/Aturan promo dasar/);
    await expect(dasar.locator("option", { hasText: "Otomatis per baris — 1 dari 3 potongan" })).toHaveCount(1);
    await dasar.selectOption("__otomatis__");
    // Pilihan otomatis tetap TERLIHAT terpilih, bukan kembali ke placeholder.
    await expect(dasar).toHaveValue("__otomatis__");
    await expect(dlg.getByText("Otomatis per baris: 1 potongan memakai aturan yang nilainya sama persis (surat DISCOUNT REGULER); 2 dilewati", { exact: false })).toBeVisible();

    const kiriman: Array<{ rows: Array<{ promoRuleId: number; invoiceNo: string }> }> = [];
    await page.route((url) => url.pathname === "/api/promo-recap/normalisasi", async (route) => {
        kiriman.push(route.request().postDataJSON());
        await json(route, { ok: true, disimpan: 1, bucket: "principal", aturan: "DISCOUNT REGULER" });
    });
    await dlg.getByRole("button", { name: "Golongkan sebagai Klaim principal" }).click();
    await expect(page.getByText("1 potongan digolongkan sebagai Klaim principal; 2 dilewati, tetap tak bertuan.")).toBeVisible();
    // Hanya potongan yang tidak ambigu yang terkirim, dengan aturan bernilai sama (0,75% tarif posisi 4).
    expect(kiriman).toHaveLength(1);
    expect(kiriman[0].rows.map((row) => [row.invoiceNo, row.promoRuleId])).toEqual([["INV/2610/KN00001", 12]]);
});
