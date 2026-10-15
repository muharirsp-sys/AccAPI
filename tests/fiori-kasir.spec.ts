/*
 * Tujuan: Fiori K2b layar Kasir ↔ Incaso (/kasir, BL-59) — 6 keadaan (Default/Memuat/Kosong/Galat/Sukses/Draf), angka Incaso tidak lengkap =
 *   "belum terbaca" BUKAN Rp 0, dialog setoran (Form Kasir wajib bila > 0, bukti transfer WAJIB, Giro wajib nomor BG + jatuh tempo; "Rp 1.250.000"
 *   terkirim "1250000"; multipart; klik ganda = satu POST), 409 SETORAN_BERUBAH, koneksi putus = "belum pasti" tanpa ulang otomatis + muat ulang
 *   + banding, Tutup basi -> segarkan berjeda ≥ 6 dtk (page.clock) -> dialog -> POST sidik, segarkan 502 BACA_GAGAL = pasti, hapus_massal
 *   (kasir.buka vs bukan), pelunasan ditolak, terkunci 20.00 + Buka kembali, jelaskan selisih, ponsel 390 px.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin; kunci dibuang lewat tanpaIzin):
 *   `npx playwright test tests/fiori-kasir.spec.ts --config playwright.fiori-local.config.ts --workers=1`.
 * Dependensi: semua endpoint Kasir di-mock page.route per docs/handover/KASIR-KONTRAK.md §7–§8 (tanpa DB, tanpa Accurate). Data contoh generik.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 90_000 } as const;
type Obj = Record<string, unknown>;

const jamLagi = (jam: number) => new Date(Date.now() + jam * 3_600_000).toISOString();
const menitLalu = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const setoran = (tunai: string, transfer: string, giro = "0.00") =>
    ({ tunai, transfer, giro, total: (Number(tunai) + Number(transfer) + Number(giro)).toFixed(2) });
function orang(kode: string, nama: string, o: Obj = {}): Obj {
    return { orang: kode, nama, kode: kode ? [kode] : [], pelunasan: "0.00", pelunasanPerMetode: {}, jumlahFaktur: 0, setoran: null, dasar: [], setoranPerKode: [],
        setoranTerakhir: null, selisih: null, status: null, dijelaskan: false, salesmanIdTakDikenal: [], ...o };
}
const A = orang("SALES-A", "SALES A", {
    pelunasan: "12480000.00", pelunasanPerMetode: { CASH_OTHER: "4480000.00", BANK_TRANSFER: "8000000.00" }, jumlahFaktur: 9,
    setoran: setoran("4480000.00", "8000000.00"), dasar: [{ kode: "SALES-A", revisi: 1 }],
    setoranPerKode: [{ kode: "SALES-A", revisi: 1, ...setoran("4480000.00", "8000000.00") }],
    setoranTerakhir: { id: 11, kode: "SALES-A", revisi: 1, noFormKasir: "FK-0410", buktiUrl: "/api/kasir/bukti?id=11", giroNomor: null, giroJatuhTempo: null,
        catatan: null, oleh: "KASIR A", pada: "2026-10-05T02:00:00.000Z" },
    selisih: "0.00", status: "klop", dijelaskan: false,
});
const B = orang("SALES-B", "SALES B", {
    pelunasan: "9150050.00", pelunasanPerMetode: { CASH_OTHER: "9150050.00" }, jumlahFaktur: 7,
    setoran: setoran("8750000.00", "0.00"), dasar: [{ kode: "SALES-B", revisi: 1 }], setoranPerKode: [{ kode: "SALES-B", revisi: 1, ...setoran("8750000.00", "0.00") }],
    setoranTerakhir: { id: 12, kode: "SALES-B", revisi: 1, noFormKasir: "FK-0411", buktiUrl: null, giroNomor: null, giroJatuhTempo: null, catatan: null,
        oleh: "KASIR A", pada: "2026-10-05T02:10:00.000Z" },
    selisih: "-400050.00", status: "selisih",
});
const C = orang("SALES-C", "SALES C", { pelunasan: "3600000.00", pelunasanPerMetode: { CASH_OTHER: "3600000.00" }, jumlahFaktur: 4, selisih: "-3600000.00", status: "belum_setor" });
const TANPA = orang("", "Tanpa salesman", { pelunasan: "250000.00", pelunasanPerMetode: { CASH_OTHER: "250000.00" }, jumlahFaktur: 1, selisih: "-250000.00", status: "belum_setor" });
const EMBER = { pelunasanId: 501, nomor: "SR/2610/0201", metode: "BANK_TRANSFER", chequeAmount: "1000000.00", jumlahInvoicePayment: "900000.00", sisa: "100000.00",
    arah: "lebih_bayar", alasan: "jumlah_invoice_payment_beda", orang: [{ orang: "SALES-A", nama: "SALES A" }], dijelaskan: false };
const BACA_LENGKAP = (o: Obj = {}) => ({ databaseId: "77", tanggal: "", status: "lengkap", aktif: false, sebab: null, pesan: null, jumlahDaftar: 9, sisaDetail: 0,
    ditolak: [], mulaiPada: menitLalu(6), selesaiPada: menitLalu(5), lengkapPada: menitLalu(5), akun: "ADMIN SINKRON", pemicu: "cron", pemicuOleh: null,
    penuhTertundaPada: null, ...o });

/** GET /api/kasir bawaan (lengkap, 4 orang + 1 ember + 1 non-kas, terhalang). `o` menimpa bagian atas. */
function hari(o: Obj = {}): Obj {
    const lengkap = (o.incaso as Obj | undefined)?.lengkap ?? true;
    return {
        ok: true, tanggal: "", sekarang: new Date().toISOString(),
        hari: { terkunci: false, sebab: null, kunciBerikutnya: jamLagi(6), bolehDiubah: true, hariKerja: true, berubahSejakDitutup: false, event: [] },
        baca: BACA_LENGKAP(), segarUntukTutup: true,
        incaso: { lengkap: true, sebab: null, pesan: null },
        total: { pelunasan: "25480050.00", setoran: "21230000.00", selisih: "-4250050.00", takTeralokasi: "100000.00", takTeralokasiBelumDijelaskan: 1, nonKas: "50000.00", klop: 1, jumlahOrang: 4 },
        orang: [A, B, C, TANPA],
        takTeralokasi: [EMBER],
        nonKas: [{ pelunasanId: 601, nomor: "SR/2610/0300", metode: "OTHERS", chequeAmount: "50000.00" }],
        penghalangTutup: { bisaDitutup: false, alasan: ["Selisih SALES-B belum dijelaskan: setoran Rp 8.750.000 lawan pelunasan Rp 9.150.050 (−Rp 400.050).", "SALES-C belum setor dan belum dijelaskan: pelunasan Rp 3.600.000."] },
        sidik: "sidik-1",
        riwayat: { setoran: [
            { id: 11, kode: "SALES-A", orang: "SALES-A", revisi: 1, ...setoran("4480000.00", "8000000.00"), noFormKasir: "FK-0410", buktiUrl: "/api/kasir/bukti?id=11", giroNomor: null, giroJatuhTempo: null, catatan: null, oleh: "KASIR A", pada: "2026-10-05T02:00:00.000Z" },
            { id: 12, kode: "SALES-B", orang: "SALES-B", revisi: 1, ...setoran("8750000.00", "0.00"), noFormKasir: "FK-0411", buktiUrl: null, giroNomor: null, giroJatuhTempo: null, catatan: null, oleh: "KASIR A", pada: "2026-10-05T02:10:00.000Z" },
        ], penjelasan: [] },
        pegawai: [{ kode: "SALES-D", orang: "SALES-D", nama: "SALES D" }, { kode: "SALES-A", orang: "SALES-A", nama: "SALES A" }],
        ...o,
        ...(lengkap ? {} : {
            total: { pelunasan: null, setoran: "21230000.00", selisih: null, takTeralokasi: null, takTeralokasiBelumDijelaskan: null, nonKas: null, klop: null, jumlahOrang: 3 },
            orang: [A, B].map((x) => ({ ...x, pelunasan: null, pelunasanPerMetode: null, jumlahFaktur: null, selisih: null, status: null, dijelaskan: null, salesmanIdTakDikenal: null })),
            takTeralokasi: null, nonKas: null, penghalangTutup: null, sidik: null, segarUntukTutup: false,
        }),
    };
}
/** Hari siap ditutup: semua klop, tanpa ember. */
const SIAP = (o: Obj = {}) => hari({
    orang: [A], takTeralokasi: [], nonKas: [], penghalangTutup: { bisaDitutup: true, alasan: [] },
    total: { pelunasan: "12480000.00", setoran: "12480000.00", selisih: "0.00", takTeralokasi: "0.00", takTeralokasiBelumDijelaskan: 0, nonKas: "0.00", klop: 1, jumlahOrang: 1 },
    ...o,
});

type Jawab = ReturnType<typeof json> | "putus";
type Opsi = {
    get?: (n: number, url: URL) => Jawab | Promise<Jawab>;
    setoran?: (n: number) => Jawab | Promise<Jawab>;
    jelaskan?: (n: number) => Jawab;
    tutup?: (n: number) => Jawab;
    buka?: (n: number) => Jawab;
    segarkan?: (n: number, body: Obj) => Jawab;
};
type Log = { get: string[]; setoran: { body: string; type: string }[]; jelaskan: Obj[]; tutup: Obj[]; buka: Obj[]; segarkan: Obj[] };

async function pasang(page: Page, o: Opsi = {}) {
    const log: Log = { get: [], setoran: [], jelaskan: [], tutup: [], buka: [], segarkan: [] };
    const jawab = async (r: Route, j: Jawab | Promise<Jawab>) => { const x = await j; return x === "putus" ? r.abort("connectionreset") : r.fulfill(x); };
    await page.route((u) => u.pathname === "/api/kasir", (r) => {
        const url = new URL(r.request().url());
        log.get.push(url.search);
        if (url.searchParams.get("orang") !== null) {
            return r.fulfill(json({ ...hari(), rincian: { orang: url.searchParams.get("orang"), pelunasan: [
                { pelunasanId: 301, nomor: "SR/2610/0127", metode: "CASH_OTHER", chequeAmount: "2400000.00", bagian: "2400000.00",
                    faktur: [{ fakturId: 9001, nomorFaktur: "INV/2610/KN01355", invoicePayment: "2400000.00" }] },
            ] } }));
        }
        return jawab(r, o.get ? o.get(log.get.filter((s) => !s.includes("orang=")).length, url) : json(hari()));
    });
    await page.route((u) => u.pathname === "/api/kasir/setoran", (r) => {
        log.setoran.push({ body: r.request().postData() ?? "", type: r.request().headers()["content-type"] ?? "" });
        return jawab(r, o.setoran ? o.setoran(log.setoran.length) : json({ ok: true, orang: "SALES-D", revisi: [{ kode: "SALES-D", revisi: 1 }], buktiUrl: null }));
    });
    await page.route((u) => u.pathname === "/api/kasir/jelaskan", (r) => {
        log.jelaskan.push(r.request().postDataJSON() as Obj);
        return jawab(r, o.jelaskan ? o.jelaskan(log.jelaskan.length) : json({ ok: true, id: 1 }));
    });
    await page.route((u) => u.pathname === "/api/kasir/tutup", (r) => {
        log.tutup.push(r.request().postDataJSON() as Obj);
        return jawab(r, o.tutup ? o.tutup(log.tutup.length) : json({ ok: true, event: { id: 1, pada: new Date().toISOString() } }));
    });
    await page.route((u) => u.pathname === "/api/kasir/buka", (r) => {
        log.buka.push(r.request().postDataJSON() as Obj);
        return jawab(r, o.buka ? o.buka(log.buka.length) : json({ ok: true, kunciBerikutnya: jamLagi(6) }));
    });
    await page.route((u) => u.pathname === "/api/kasir/segarkan", (r) => {
        const body = r.request().postDataJSON() as Obj;
        log.segarkan.push(body);
        return jawab(r, o.segarkan ? o.segarkan(log.segarkan.length, body) : json({ ok: true, status: BACA_LENGKAP() }));
    });
    return log;
}

/** Buang kunci izin dari payload RSC halaman /kasir (hanya di tes). */
async function tanpaIzin(page: Page, buang: string[]) {
    await page.route((u) => u.pathname === "/kasir", async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        const body = (await res.text()).replace(/permKeys(\\?)":\[([^\]]*)\]/g, (_, e: string, isi: string) =>
            `permKeys${e}":[${isi.split(",").filter((k) => !buang.some((x) => k.includes(`"${x}`))).join(",")}]`);
        return route.fulfill({ status: res.status(), headers, body });
    });
}

const main = (page: Page) => page.locator("main");
const footer = (page: Page) => page.locator(".fi-ftb");
const kpi = (page: Page, label: string) => main(page).getByRole("group", { name: label, exact: true });
async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= document.documentElement.clientWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
const PNG = { name: "bukti.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex") };

test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights"] } });
test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Default: KPI, daftar orang (Tanpa salesman terlihat), tak teralokasi, non-kas, rincian orang dengan aturan Rp 100, faktur, revisi", async ({ page }) => {
    const log = await pasang(page);
    await page.goto("/kasir", NAV);
    const m = main(page);
    await expect(m.getByRole("heading", { name: "Kasir ↔ Incaso", level: 1 })).toBeVisible(NAV);
    await expect(m.locator(".fi-page-head")).toContainText("Terbuka sampai");
    await expect(m.locator(".fi-page-head")).toContainText("Lengkap");
    await expect(m.locator(".fi-page-head")).toContainText("akun sinkron ADMIN SINKRON");
    await expect(kpi(page, "Pelunasan Incaso")).toContainText("Rp 25.480.050");
    await expect(kpi(page, "Klop")).toContainText("1 dari 4");
    await expect(kpi(page, "Tak teralokasi")).toContainText("1 belum dijelaskan");
    const daftar = m.getByRole("list", { name: "Daftar orang" });
    await expect(daftar.getByRole("button")).toHaveCount(4);
    await expect(daftar.getByRole("button", { name: /SALES-B · SALES B/ })).toContainText("Selisih");
    await expect(daftar.getByRole("button", { name: /SALES-C/ })).toContainText("Belum setor");
    await expect(daftar.getByRole("button", { name: /Tanpa salesman/ })).toBeVisible();
    await expect(m.getByRole("list", { name: "Uang tak teralokasi" })).toContainText("Lebih bayar");
    await expect(m.getByRole("list", { name: "Pelunasan non-kas" })).toContainText("SR/2610/0300");
    // Tutup terhalang: alasan TERLIHAT di kaki, tanpa nama kunci mentah.
    await expect(page.getByRole("button", { name: "Tutup hari…" })).toBeDisabled();
    await expect(footer(page)).toContainText("2 hal belum dijelaskan: Selisih SALES-B");
    await expect(footer(page)).not.toContainText("kasir.");
    await page.screenshot({ path: "test-results/fiori-kasir-1-default.png", fullPage: true });

    await daftar.getByRole("button", { name: /SALES-B/ }).click();
    const d = m.getByRole("region", { name: "Rincian orang" });
    await expect(d).toContainText("Klop bila setoran Rp 9.150.050 atau Rp 9.150.100 (dibulatkan ke atas ke Rp 100)");
    await expect(d).toContainText("Incaso Rp 9.150.050 · Kasir Rp 8.750.000");
    await expect(d.getByRole("list", { name: "Rincian faktur" })).toContainText("INV/2610/KN01355", NAV);
    expect(log.get.some((s) => s.includes("orang=SALES-B"))).toBe(true);
    await expect(d).toContainText("Revisi 1: Tunai Rp 8.750.000");
    await expect(d.getByRole("button", { name: "Koreksi setoran…" })).toBeEnabled();
    await expect(d.getByRole("button", { name: "Jelaskan…" })).toBeEnabled();
    await daftar.getByRole("button", { name: /Tanpa salesman/ }).click();
    await expect(d.getByRole("button", { name: /setoran…/ })).toHaveCount(0);
    await expect(d).toContainText("Setoran tidak bisa dicatat untuk Tanpa salesman");
});

test("Memuat lalu Kosong: belum ada pelunasan Incaso, Setoran… tetap bisa", async ({ page }) => {
    let lepas: () => void = () => {};
    const tahan = new Promise<void>((r) => { lepas = r; });
    await pasang(page, { get: async () => { await tahan; return json(SIAP({ orang: [], penghalangTutup: { bisaDitutup: true, alasan: [] },
        total: { pelunasan: "0.00", setoran: "0.00", selisih: "0.00", takTeralokasi: "0.00", takTeralokasiBelumDijelaskan: 0, nonKas: "0.00", klop: 0, jumlahOrang: 0 } })); } });
    await page.goto("/kasir", NAV);
    await expect(main(page).getByText("Membaca pelunasan Accurate dan setoran Kasir")).toBeAttached(NAV);
    await page.screenshot({ path: "test-results/fiori-kasir-2-memuat.png", fullPage: true });
    lepas();
    await expect(main(page).getByText(/Belum ada pelunasan Incaso untuk/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Setoran…" })).toBeEnabled();
    await page.screenshot({ path: "test-results/fiori-kasir-3-kosong.png", fullPage: true });
});

test("Galat: GET 500 = galat (bukan kosong) + Coba lagi; Incaso belum terbaca = 'belum terbaca' bukan Rp 0, Tutup terhalang, setoran tetap bisa", async ({ page }) => {
    // Mode dev (StrictMode) memanggil GET dua kali saat pasang: gagal sampai tes menekan Coba lagi.
    let gagal = true;
    await pasang(page, { get: () => gagal ? json({ ok: false, kode: "GALAT_INTERNAL", error: "Gagal memuat hari Kasir." }, 500)
        : json(hari({ baca: null, incaso: { lengkap: false, sebab: "SESI_SINKRON", pesan: "Sesi Accurate akun sinkron kedaluwarsa — admin login ulang di /sesi-accurate lalu pilih database" } })) });
    await page.goto("/kasir", NAV);
    const m = main(page);
    await expect(m.getByRole("alert").filter({ hasText: "Data Kasir belum bisa ditampilkan" })).toContainText("Gagal memuat hari Kasir.", NAV);
    await expect(m.getByText("Belum ada setoran tercatat")).toHaveCount(0);
    gagal = false;
    await m.getByRole("button", { name: "Coba lagi" }).click();
    await expect(m.getByText("Angka Incaso belum terbaca.")).toBeVisible();
    await expect(m.getByRole("alert").filter({ hasText: "Angka Incaso belum terbaca." })).toContainText("Sesi Accurate akun sinkron kedaluwarsa");
    for (const label of ["Pelunasan Incaso", "Selisih", "Klop", "Tak teralokasi", "Non-kas"]) {
        await expect(kpi(page, label)).toContainText("belum terbaca · bukan nol");
        await expect(kpi(page, label)).not.toContainText("Rp 0");
    }
    await expect(m.getByRole("list", { name: "Daftar orang" })).toContainText("Incaso belum terbaca");
    await expect(page.getByRole("button", { name: "Tutup hari…" })).toBeDisabled();
    await expect(footer(page)).toContainText("Sesi Accurate akun sinkron belum tersedia");
    await expect(page.getByRole("button", { name: "Setoran…" })).toBeEnabled();
    await page.screenshot({ path: "test-results/fiori-kasir-4-galat-incaso.png", fullPage: true });
});

test("Setoran: Form Kasir / bukti transfer / Giro BG + jatuh tempo wajib; 'Rp 1.250.000' terkirim '1250000' (multipart); klik ganda = satu POST; Draf; Sukses", async ({ page }) => {
    const log = await pasang(page, { setoran: async () => { await new Promise((r) => setTimeout(r, 800)); return json({ ok: true, orang: "SALES-D", revisi: [{ kode: "SALES-D", revisi: 1 }], buktiUrl: "/api/kasir/bukti?id=20" }); } });
    await page.goto("/kasir", NAV);
    await page.getByRole("button", { name: "Setoran…" }).click(NAV);
    const dlg = page.getByRole("dialog");
    const simpan = dlg.getByRole("button", { name: "Simpan setoran" });
    await expect(simpan).toBeDisabled();
    await expect(dlg).toContainText("Pilih pegawai dulu");
    await dlg.getByLabel("Pegawai").selectOption("SALES-D");
    await dlg.getByLabel("Tunai").fill("Rp 1.250.000");
    await expect(dlg).toContainText("Draf belum disimpan");
    await expect(dlg).toContainText("Isi Nomor Form Kasir (wajib bila setoran lebih dari 0)");
    await expect(simpan).toBeDisabled();
    await dlg.getByLabel("Nomor Form Kasir").fill("FK-0415");
    await expect(simpan).toBeEnabled();
    await dlg.getByLabel("Transfer").fill("500.000,50");
    await expect(dlg).toContainText("Unggah bukti transfer (foto/PDF) — wajib untuk setoran Transfer");
    await expect(simpan).toBeDisabled();
    await dlg.getByLabel("Bukti transfer").setInputFiles(PNG);
    await expect(simpan).toBeEnabled();
    await dlg.getByLabel("Giro").fill("100.000");
    await expect(dlg).toContainText("Isi nomor BG (wajib untuk setoran Giro)");
    await dlg.getByLabel("Nomor BG").fill("BG-0001");
    await expect(dlg).toContainText("Isi tanggal jatuh tempo Giro");
    await dlg.getByLabel("Jatuh tempo Giro").fill("2000-01-01");
    await expect(dlg).toContainText("Jatuh tempo Giro harus antara");
    const tgl = await page.getByLabel("Tanggal").inputValue();
    await dlg.getByLabel("Jatuh tempo Giro").fill(tgl);
    await dlg.getByLabel("Tunai").fill("1.250.000,555");
    await expect(dlg).toContainText("Maksimal 2 angka di belakang koma.");
    await dlg.getByLabel("Tunai").fill("Rp 1.250.000");
    await expect(dlg).toContainText("Total setoran");
    await expect(dlg).toContainText("Rp 1.850.000,5");
    await expect(simpan).toBeEnabled();
    await page.screenshot({ path: "test-results/fiori-kasir-5-draf-setoran.png", fullPage: true });
    const nGet = log.get.length;
    await simpan.dblclick();
    await expect(dlg).toBeHidden();
    expect(log.setoran).toHaveLength(1);
    const kiriman = log.setoran[0];
    expect(kiriman.type).toContain("multipart/form-data");
    expect(kiriman.body).toContain('"tunai":"1250000"');
    expect(kiriman.body).toContain('"transfer":"500000.5"');
    expect(kiriman.body).toContain('"giro":"100000"');
    expect(kiriman.body).toContain('"noFormKasir":"FK-0415"');
    expect(kiriman.body).toContain('"giroNomor":"BG-0001"');
    expect(kiriman.body).toContain(`"giroJatuhTempo":"${tgl}"`);
    expect(kiriman.body).toContain('"dasar":[]');
    expect(kiriman.body).toContain('filename="bukti.png"');
    await expect(main(page).getByRole("status").filter({ hasText: "Setoran SALES-D · SALES D tersimpan (revisi 1)." })).toBeVisible();
    await expect.poll(() => log.get.length).toBeGreaterThan(nGet);
    await page.screenshot({ path: "test-results/fiori-kasir-6-sukses-setoran.png", fullPage: true });
});

test("Koreksi setoran: revisi lama tampil, dasar dikirim balik; 409 SETORAN_BERUBAH = pesan + muat ulang; transfer 0 = JSON tanpa bukti", async ({ page }) => {
    const log = await pasang(page, { setoran: () => json({ ok: false, kode: "SETORAN_BERUBAH", error: "Setoran orang ini sudah berubah.",
        keadaan: { orang: "SALES-B", dasar: [{ kode: "SALES-B", revisi: 2 }], setoranPerKode: [], setoran: setoran("9150050.00", "0.00") } }, 409) });
    await page.goto("/kasir", NAV);
    await main(page).getByRole("list", { name: "Daftar orang" }).getByRole("button", { name: /SALES-B/ }).click(NAV);
    await main(page).getByRole("region", { name: "Rincian orang" }).getByRole("button", { name: "Koreksi setoran…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("SALES-B revisi 1: Tunai Rp 8.750.000");
    await expect(dlg.getByLabel("Tunai")).toHaveValue("8.750.000");
    await expect(dlg.getByLabel("Nomor Form Kasir")).toHaveValue("FK-0411");
    await dlg.getByLabel("Tunai").fill("9.150.100");
    await expect(dlg).toContainText("Klop");
    const nGet = log.get.length;
    await dlg.getByRole("button", { name: "Simpan setoran" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Setoran orang ini sudah berubah. Data dimuat ulang — periksa revisi terbaru");
    expect(log.setoran[0].type).toContain("application/json");
    const isi = JSON.parse(log.setoran[0].body) as Obj;
    expect(isi).toMatchObject({ orang: "SALES-B", tunai: "9150100", transfer: "0", giro: "0", dasar: [{ kode: "SALES-B", revisi: 1 }] });
    expect(isi).not.toHaveProperty("buktiLama");
    await expect.poll(() => log.get.length).toBeGreaterThan(nGet);
});

test("Tidak pasti: koneksi putus = 'belum pasti', TANPA ulang otomatis; muat ulang lalu banding revisi; tulis terkunci sampai diperiksa", async ({ page }) => {
    let tersimpan = false;
    const log = await pasang(page, {
        setoran: () => { tersimpan = true; return "putus"; },
        get: () => {
            if (!tersimpan) return json(hari());
            const C2 = { ...C, setoran: setoran("3600000.00", "0.00"), dasar: [{ kode: "SALES-C", revisi: 1 }], setoranPerKode: [{ kode: "SALES-C", revisi: 1, ...setoran("3600000.00", "0.00") }], status: "klop", selisih: "0.00" };
            return json(hari({ orang: [A, B, C2, TANPA] }));
        },
    });
    await page.goto("/kasir", NAV);
    await main(page).getByRole("list", { name: "Daftar orang" }).getByRole("button", { name: /SALES-C/ }).click(NAV);
    await main(page).getByRole("region", { name: "Rincian orang" }).getByRole("button", { name: "Catat setoran…" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Tunai").fill("3.600.000");
    await dlg.getByLabel("Nomor Form Kasir").fill("FK-0412");
    await dlg.getByRole("button", { name: "Simpan setoran" }).click();
    await expect(dlg).toBeHidden();
    const strip = main(page).getByRole("status").filter({ hasText: "belum pasti" });
    await expect(strip).toContainText("Hasil setoran SALES-C · SALES C belum pasti.");
    await expect(strip).toContainText("tidak diulang otomatis");
    await expect(strip).toContainText("Tersimpan: setoran SALES-C · SALES C revisi 1 tercatat dengan nominal yang Anda kirim.");
    await page.waitForTimeout(1500);
    expect(log.setoran).toHaveLength(1);
    await page.screenshot({ path: "test-results/fiori-kasir-7-tidak-pasti.png", fullPage: true });
});

test("Tutup basi: segarkan berjeda ≥ 6 dtk (page.clock) dengan 'Membaca n/N', lalu dialog Tutup → POST sidik → toast", async ({ page }) => {
    await page.clock.install({ time: new Date() });
    let segar = false;
    const log = await pasang(page, {
        get: () => json(SIAP({ segarUntukTutup: segar, sidik: segar ? "sidik-2" : "sidik-1", baca: BACA_LENGKAP({ lengkapPada: segar ? menitLalu(0) : menitLalu(20) }) })),
        segarkan: (n) => {
            if (n === 1) return json({ ok: true, status: BACA_LENGKAP({ status: "sebagian", jumlahDaftar: 9, sisaDetail: 4, lengkapPada: menitLalu(20) }) });
            segar = true;
            return json({ ok: true, status: BACA_LENGKAP() });
        },
    });
    await page.goto("/kasir", NAV);
    const tutup = page.getByRole("button", { name: "Tutup hari…" });
    await expect(tutup).toBeEnabled(NAV);
    await tutup.click();
    await expect(main(page).getByText(/Membaca 5\/9 · percobaan 1 dari 20/)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(log.segarkan).toHaveLength(1);
    expect(log.segarkan[0]).toEqual({ tanggal: await page.getByLabel("Tanggal").inputValue() });
    await page.screenshot({ path: "test-results/fiori-kasir-8-segarkan-berjeda.png", fullPage: true });
    await page.clock.runFor(6_100);
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("Tutup hari", NAV);
    expect(log.segarkan).toHaveLength(2);
    await expect(dlg).toContainText("1 dari 1 orang");
    await expect(dlg).toContainText("Pelunasan dibaca lengkap");
    await dlg.getByRole("button", { name: "Tutup hari", exact: true }).click();
    await expect(dlg).toBeHidden();
    expect(log.tutup).toEqual([{ tanggal: log.segarkan[0].tanggal, sidik: "sidik-2" }]);
    await expect(main(page).getByRole("status").filter({ hasText: /^Hari .* ditutup\.$/ })).toBeVisible();
});

test("Segarkan: SEDANG_DIBACA diulang berjeda + Batal; 502 BACA_GAGAL = jawaban PASTI (bukan 'belum pasti')", async ({ page }) => {
    await page.clock.install({ time: new Date() });
    const log = await pasang(page, {
        segarkan: (n) => n === 1 ? json({ ok: false, kode: "SEDANG_DIBACA", error: "Pelunasan tanggal ini sedang dibaca — coba lagi sebentar.", status: BACA_LENGKAP({ status: "berjalan", aktif: true }) }, 409)
            : json({ ok: false, kode: "BACA_GAGAL", error: "Accurate menjawab 500 untuk list.do.", status: BACA_LENGKAP({ status: "gagal", sebab: "accurate_5xx" }) }, 502),
    });
    await page.goto("/kasir", NAV);
    await page.getByRole("button", { name: "Segarkan", exact: true }).click(NAV);
    await expect(main(page).getByText(/Sedang dibaca pembaca lain/)).toBeVisible();
    await main(page).getByRole("button", { name: "Batal" }).click();
    await page.clock.runFor(7_000);
    expect(log.segarkan).toHaveLength(1);
    await page.getByRole("button", { name: "Segarkan", exact: true }).click();
    await expect(main(page).getByRole("alert").filter({ hasText: "Accurate menjawab 500 untuk list.do." })).toBeVisible();
    await expect(main(page)).not.toContainText("belum pasti");
    expect(log.segarkan).toHaveLength(2);
});

const MASSAL = BACA_LENGKAP({ status: "gagal", sebab: "hapus_massal", pesan: "Penghapusan massal ditahan.", ditolak: [
    { id: 1, nomor: "SR/2610/0101", sebab: "hapus_massal", pesan: "" }, { id: 2, nomor: "SR/2610/0102", sebab: "hapus_massal", pesan: "" }] });

test("Hapus massal: nomor terlihat; pemegang Buka (OM/Admin) mengonfirmasi → POST konfirmasiHapus", async ({ page }) => {
    const log = await pasang(page, { get: () => json(hari({ baca: MASSAL, incaso: { lengkap: false, sebab: "BACA_BELUM_LENGKAP", pesan: "Pelunasan Incaso gagal dibaca. Angka Incaso belum ditampilkan (bukan nol)." } })) });
    await page.goto("/kasir", NAV);
    const strip = main(page).getByRole("status").filter({ hasText: "Pembaca menahan penghapusan 2 pelunasan" });
    await expect(strip).toContainText("SR/2610/0101, SR/2610/0102", NAV);
    await expect(footer(page)).toContainText("Penghapusan pelunasan dari cache menunggu konfirmasi OM/Admin");
    await strip.getByRole("button", { name: "Konfirmasi hapus…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("SR/2610/0101, SR/2610/0102");
    await dlg.getByRole("button", { name: "Hapus 2 dari cache" }).click();
    await expect.poll(() => log.segarkan.length).toBe(1);
    expect(log.segarkan[0]).toMatchObject({ konfirmasiHapus: true });
});

test("Hapus massal tanpa izin Buka: 'Minta OM/Admin mengonfirmasi', tanpa tombol; tanpa izin Catat/Tutup = nonaktif beralasan", async ({ page }) => {
    await tanpaIzin(page, ["kasir.buka", "kasir.catat", "kasir.tutup"]);
    const log = await pasang(page, { get: () => json(hari({ baca: MASSAL, incaso: { lengkap: false, sebab: "BACA_BELUM_LENGKAP", pesan: "Pelunasan Incaso gagal dibaca. Angka Incaso belum ditampilkan (bukan nol)." } })) });
    await page.goto("/kasir", NAV);
    const strip = main(page).getByRole("status").filter({ hasText: "Pembaca menahan penghapusan" });
    await expect(strip).toContainText("Minta OM/Admin mengonfirmasi", NAV);
    await expect(strip.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Baca penuh" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Setoran…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Tutup hari…" })).toBeDisabled();
    await expect(footer(page)).toContainText("belum berhak menutup hari Kasir");
    await expect(footer(page)).toContainText("Setoran: Akun Anda belum berhak mencatat setoran");
    expect(log.segarkan).toHaveLength(0);
});

test("Pelunasan DITOLAK pembaca: nomor + 'perbaiki di Accurate', Tutup terhalang, tanpa tombol jelaskan untuknya", async ({ page }) => {
    await pasang(page, { get: () => json(hari({
        baca: BACA_LENGKAP({ status: "gagal", sebab: "bentuk", pesan: "1 pelunasan ditolak.", ditolak: [{ id: 7, nomor: "SR/2610/0777", sebab: "bentuk", pesan: "invoicePayment absen" }] }),
        incaso: { lengkap: false, sebab: "BACA_BELUM_LENGKAP", pesan: "Pelunasan Incaso gagal dibaca: 1 pelunasan ditolak. Angka Incaso belum ditampilkan (bukan nol)." } })) });
    await page.goto("/kasir", NAV);
    const strip = main(page).getByRole("alert").filter({ hasText: "pelunasan ditolak pembaca" });
    await expect(strip).toContainText("SR/2610/0777 (invoicePayment absen)", NAV);
    await expect(strip).toContainText("Perbaiki di Accurate; hari tak bisa ditutup");
    await expect(strip.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Tutup hari…" })).toBeDisabled();
    await expect(footer(page)).toContainText("Ada pelunasan ditolak pembaca");
});

test("Terkunci 20.00 WITA (page.clock): lewat kunciBerikutnya → muat ulang sendiri, tulis terkunci beralasan; Buka kembali (alasan ≥ 15) → terbuka", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-10-05T11:59:00Z") }); // 19.59 WITA
    let terbuka = false;
    // Tanggal bawaan = hari ini menurut jam SERVER; tes memilih 5 Okt (jam peramban dipalsukan). Hitungan GET hanya untuk 5 Okt.
    let n5 = 0;
    const log = await pasang(page, {
        get: (_n, url) => url.searchParams.get("tanggal") !== "2026-10-05" ? json(hari()) : ++n5 === 1 ? json(hari({ hari: { terkunci: false, sebab: null, kunciBerikutnya: "2026-10-05T12:00:00.000Z", bolehDiubah: true, hariKerja: true, berubahSejakDitutup: false, event: [] } }))
            : json(hari({ hari: terbuka
                ? { terkunci: false, sebab: null, kunciBerikutnya: "2026-10-06T12:00:00.000Z", bolehDiubah: true, hariKerja: true, berubahSejakDitutup: false,
                    event: [{ id: 1, jenis: "kunci", alasan: null, oleh: "Sistem", pada: "2026-10-05T12:00:05.000Z" }, { id: 2, jenis: "buka", alasan: "Setoran SALES-C datang terlambat", oleh: "OM A", pada: "2026-10-05T12:05:00.000Z" }] }
                : { terkunci: true, sebab: "kunci", kunciBerikutnya: null, bolehDiubah: false, hariKerja: true, berubahSejakDitutup: false,
                    event: [{ id: 1, jenis: "kunci", alasan: null, oleh: "Sistem", pada: "2026-10-05T12:00:05.000Z" }] } })),
        buka: () => { terbuka = true; return json({ ok: true, kunciBerikutnya: "2026-10-06T12:00:00.000Z" }); },
    });
    await page.goto("/kasir", NAV);
    await expect(page.getByRole("button", { name: "Setoran…" })).toBeEnabled(NAV);
    await page.getByLabel("Tanggal").fill("2026-10-05");
    await expect(main(page).locator(".fi-page-head")).toContainText("Terbuka sampai 20.00 WITA");
    await expect(page.getByRole("button", { name: "Setoran…" })).toBeEnabled();
    await page.clock.runFor(62_000);
    await expect(main(page).locator(".fi-page-head")).toContainText("Terkunci otomatis 20.00 WITA");
    expect(n5).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole("button", { name: "Setoran…" })).toBeDisabled();
    await expect(footer(page)).toContainText("Hari terkunci otomatis 20.00 WITA");
    await page.screenshot({ path: "test-results/fiori-kasir-9-terkunci.png", fullPage: true });
    await page.getByRole("button", { name: "Buka kembali…" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Alasan membuka").fill("terlambat");
    await expect(dlg.getByRole("button", { name: "Buka kembali" })).toBeDisabled();
    await expect(dlg).toContainText("Alasan minimal 15 karakter");
    await dlg.getByLabel("Alasan membuka").fill("Setoran SALES-C datang terlambat");
    await dlg.getByRole("button", { name: "Buka kembali" }).click();
    await expect(dlg).toBeHidden();
    expect(log.buka).toEqual([{ tanggal: "2026-10-05", alasan: "Setoran SALES-C datang terlambat" }]);
    await expect(main(page).locator(".fi-page-head")).toContainText("Dibuka kembali oleh OM A: Setoran SALES-C datang terlambat");
    await expect(page.getByRole("button", { name: "Setoran…" })).toBeEnabled();
});

test("Jelaskan selisih: minimal 15 + tindak lanjut; 409 ANGKA_BERUBAH = pesan + muat ulang; berikutnya tersimpan", async ({ page }) => {
    const log = await pasang(page, { jelaskan: (n) => n === 1 ? json({ ok: false, kode: "ANGKA_BERUBAH", error: "Angka berubah.", keadaan: { angka: { pelunasan: "9150050.00", setoran: "9000000.00" }, status: "selisih" } }, 409) : json({ ok: true, id: 5 }) });
    await page.goto("/kasir", NAV);
    await main(page).getByRole("list", { name: "Daftar orang" }).getByRole("button", { name: /SALES-B/ }).click(NAV);
    await main(page).getByRole("region", { name: "Rincian orang" }).getByRole("button", { name: "Jelaskan…" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("Jelaskan selisih SALES-B · SALES B · −Rp 400.050");
    const simpan = dlg.getByRole("button", { name: "Simpan penjelasan" });
    await dlg.getByLabel("Penjelasan").fill("uang kurang");
    await expect(dlg).toContainText("Penjelasan minimal 15 karakter");
    await dlg.getByLabel("Penjelasan").fill("Salesman setor susulan besok pagi");
    await expect(dlg).toContainText("Pilih tindak lanjut");
    await expect(simpan).toBeDisabled();
    await dlg.getByLabel("Tindak lanjut").selectOption("setor_susulan");
    const nGet = log.get.length;
    await simpan.click();
    await expect(dlg.getByRole("alert")).toContainText("Angka berubah. Angka sudah berubah sejak dimuat");
    await expect.poll(() => log.get.length).toBeGreaterThan(nGet);
    expect(log.jelaskan[0]).toEqual({ tanggal: log.jelaskan[0].tanggal, jenis: "selisih", orang: "SALES-B", angka: { pelunasan: "9150050.00", setoran: "8750000.00" },
        penjelasan: "Salesman setor susulan besok pagi", tindakLanjut: "setor_susulan" });
    await simpan.click();
    await expect(dlg).toBeHidden();
    await expect(main(page).getByRole("status").filter({ hasText: "Penjelasan selisih SALES-B · SALES B tersimpan." })).toBeVisible();
});

test("Ponsel 390 px: satu kolom, tanpa gulir menyamping, detail + Kembali, kaki Setoran…/Tutup hari…", async ({ page }) => {
    await pasang(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/kasir", NAV);
    await expect(main(page).getByRole("list", { name: "Daftar orang" })).toBeVisible(NAV);
    await noOverflow(page);
    await expect(page.getByRole("button", { name: "Setoran…" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tutup hari…" })).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-kasir-10-ponsel.png", fullPage: true });
    await main(page).getByRole("list", { name: "Daftar orang" }).getByRole("button", { name: /SALES-B/ }).click();
    await expect(main(page).getByRole("button", { name: "Kembali ke daftar" })).toBeVisible();
    await expect(main(page).getByRole("list", { name: "Rincian faktur" })).toBeVisible(NAV);
    await noOverflow(page);
    await page.screenshot({ path: "test-results/fiori-kasir-11-ponsel-detail.png", fullPage: true });
    await main(page).getByRole("button", { name: "Kembali ke daftar" }).click();
    await expect(main(page).getByRole("list", { name: "Daftar orang" })).toBeVisible();
});
