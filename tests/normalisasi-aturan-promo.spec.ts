/*
 * Tujuan: Regresi UI Normalisasi Diskon (wajib aturan promo dasar) dan saringan Periode Aturan Promo,
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

test("Normalisasi: memuat, lalu Disc Claim wajib memilih aturan yang berlaku; kirim ganda dicegah", async ({ page }) => {
    let lepas!: () => void;
    const tahan = new Promise<void>((resolve) => { lepas = resolve; });
    await bukaNormalisasi(page, async (route) => { await tahan; await json(route, rekap); });
    // Memuat terlihat sebagai memuat, BUKAN sebagai "tidak ada potongan".
    await expect(page.getByRole("status").filter({ hasText: "Memuat potongan tak bertuan" })).toBeAttached();
    await expect(page.getByText("Tidak ada potongan tak bertuan pada periode ini.")).toHaveCount(0);
    lepas();

    const simpan = page.getByRole("button", { name: /^Simpan/ });
    await expect(page.getByText("Centang potongan di tabel yang akan dinormalisasi.")).toBeVisible();
    await expect(simpan).toBeDisabled();

    await page.getByRole("checkbox", { name: "Pilih INV/2610/KN00001 posisi 4" }).check();
    await expect(page.getByText("Pilih jenis normalisasi.")).toBeVisible();
    await expect(simpan).toBeDisabled();

    const jenis = page.getByLabel("Jenis normalisasi");
    const dasar = page.getByLabel("Aturan promo dasar");
    // Disc Distributor tanpa aturan distributor yang berlaku: tidak bisa disimpan, dan sebabnya disebut.
    await jenis.selectOption("distributor");
    await expect(dasar).toBeDisabled();
    await expect(page.getByText("Tidak ada aturan promo yang berlaku untuk potongan ini.", { exact: false })).toBeVisible();
    await expect(simpan).toBeDisabled();

    await jenis.selectOption("principal");
    await expect(dasar).toBeEnabled();
    // Nilai yang sama dengan potongannya (0,75%) didahulukan.
    await expect(dasar.locator("option").nth(1)).toContainText("nilai sama");
    await expect(simpan).toBeDisabled();
    await dasar.selectOption("12");
    await expect(simpan).toBeEnabled();

    const kiriman: unknown[] = [];
    await page.route((url) => url.pathname === "/api/promo-recap/normalisasi", async (route) => {
        kiriman.push(route.request().postDataJSON());
        await new Promise((resolve) => setTimeout(resolve, 400));
        await json(route, { ok: true, disimpan: 1, bucket: "principal", aturan: "DISCOUNT REGULER" });
    });
    page.on("dialog", (dialog) => void dialog.accept());
    await simpan.dblclick();
    await expect(page.getByText("1 potongan dinormalisasi sebagai Disc Claim")).toBeVisible();
    expect(kiriman).toHaveLength(1);
    expect(kiriman[0]).toMatchObject({ bucket: "principal", promoRuleId: 12, rows: [{ lineKey: "1", positions: "4", branchName: "KINO NON FOOD" }] });
});

test("Normalisasi: penolakan server ditampilkan dan pilihan tidak hilang", async ({ page }) => {
    await bukaNormalisasi(page);
    await page.getByRole("checkbox", { name: "Pilih INV/2610/KN00001 posisi 4" }).check();
    await page.getByLabel("Jenis normalisasi").selectOption("principal");
    await page.getByLabel("Aturan promo dasar").selectOption("11");
    await page.route((url) => url.pathname === "/api/promo-recap/normalisasi", (route) =>
        json(route, { ok: false, error: "Aturan BP2610007911 tidak berlaku untuk INV/2610/KN00001: tanggal faktur di luar periode" }, 422));
    page.on("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Simpan sebagai Disc Claim" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Tidak tersimpan: Aturan BP2610007911 tidak berlaku" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Pilih INV/2610/KN00001 posisi 4" })).toBeChecked();
    await expect(page.getByRole("button", { name: "Simpan sebagai Disc Claim" })).toBeEnabled();
});

test("Normalisasi: galat memuat terlihat sebagai galat, bisa dicoba lagi", async ({ page }) => {
    let gagal = true;
    await bukaNormalisasi(page, (route) => (gagal ? json(route, { ok: false, error: "statement timeout" }, 500) : json(route, rekap)));
    await expect(page.getByRole("alert").filter({ hasText: "Gagal memuat data: statement timeout" }).first()).toBeVisible();
    await expect(page.getByText("Tidak ada potongan tak bertuan pada periode ini.")).toHaveCount(0);
    gagal = false;
    await page.getByRole("button", { name: "Coba lagi" }).first().click();
    await expect(page.getByText("ALFAMART MAJU JAYA")).toBeVisible();
});

test("Aturan Promo: Periode bergabung dengan saringan lain, bisa dihapus; memuat/kosong/galat berbeda", async ({ page }) => {
    const diminta: URLSearchParams[] = [];
    let jawaban: "isi" | "kosong" | "galat" = "isi";
    await page.route((url) => url.pathname === "/api/promo-rule", async (route) => {
        diminta.push(new URL(route.request().url()).searchParams);
        if (jawaban === "galat") return json(route, { ok: false, error: "koneksi database putus" }, 500);
        const rules = jawaban === "kosong" ? [] : [{ ...aturan(11), principal: "KINO NON FOOD", active: true, triggerQty: "0",
            triggerUnit: "PCS", benefitUnit: "%", channel: "", note: "", importedBy: "" }];
        return json(route, { ok: true, principals: ["KINO NON FOOD"], total: 1, rules, truncated: 0 });
    });
    await page.goto("/aturan-promo");
    await expect(page.getByText("BP2610007911")).toBeVisible();
    // Tanggal tampil dd/mm/yyyy.
    await expect(page.getByText("01/10/2026")).toBeVisible();

    await page.getByRole("combobox", { name: "Principal", exact: true }).selectOption("KINO NON FOOD");
    await page.getByRole("combobox", { name: "Tanggungan" }).selectOption("PRINCIPAL");
    await page.getByLabel("Periode dari").fill("2026-09-01");
    await page.getByLabel("Periode sampai").fill("2026-09-30");
    await page.getByRole("searchbox", { name: "Cari" }).fill("B&B");
    await expect.poll(() => diminta.at(-1)?.toString()).toContain("q=B%26B");
    const akhir = diminta.at(-1)!;
    expect(Object.fromEntries(akhir)).toMatchObject({ principal: "KINO NON FOOD", beban: "PRINCIPAL", dari: "2026-09-01", sampai: "2026-09-30", q: "B&B" });
    await expect(page.getByText("yang berlaku 01/09/2026 – 30/09/2026", { exact: false })).toBeVisible();

    jawaban = "kosong";
    await page.getByRole("button", { name: "Hapus saringan periode" }).click();
    await expect.poll(() => diminta.at(-1)?.has("dari")).toBe(false);
    expect(diminta.at(-1)?.get("principal")).toBe("KINO NON FOOD");
    await expect(page.getByText("Tidak ada aturan promo yang sesuai saringan.")).toBeVisible();

    jawaban = "galat";
    await page.getByRole("button", { name: "Muat ulang" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "koneksi database putus" })).toBeVisible();
});
