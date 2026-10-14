/*
 * Tujuan: NOO — toko baru dari kunjungan salesman (owner 13 Okt 2026) di layar: salesman 390 px (formulir di Rute hari ini: isian, foto toko
 *   + KTP lewat kamera, GPS wajib + izin ditolak dijelaskan, kirim multipart ber-id tetap, duplikat → "minta konfirmasi SPV: pemilik sama",
 *   kartu NOO di rute tanpa ORDER), SPV 390 px (rincian, NIK tersamar, Lihat KTP lewat POST + hilang saat ditutup, setujui duplikat WAJIB
 *   centang, tolak beralasan), SM pengganti (setujui + KTP), Admin (antrean, Salin, saran + cari, tautkan), Dashboard SPV bertanda NOO.
 *   Putaran 2 (peninjau B): galat daftar/rincian/cari = galat (bukan kosong, aksi dikunci) [T1, S6]; kirim ganda = 1 POST [S7]; pindah tab
 *   saat formulir terisi ditanya dulu [S1]; galat per isian + "Ke isian" [S2]; fokus kembali ke "Lihat KTP" [S3]; lencana + strip NOO
 *   menunggu [S4]; selesai terpotong diberitahukan; batal kunjungan NOO tidak membatalkan pengajuan [R3].
 *   Data generik (TOKO BARU A, PEMILIK A, CABANG A, PRINCIPLE A).
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true): `npx playwright test tests/fiori-form-kontrol-noo.spec.ts --config playwright.fiori-local.config.ts`.
 * Dependensi: /api/form-kontrol/* di-mock (page.route). Tidak menyentuh DB.
 * Side Effects: Tangkapan di test-results/noo.
 */
import { expect, test, type Page, type Request, type Route } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const NAV = { timeout: 60_000 } as const;
const HARI_INI = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const NIK = "7371010101010012";

const SALESMAN = { role: "salesman", salesCode: "S-01", salesName: "SALES A", spvName: "SPV A", allowedSalesCodes: ["S-01"], principles: ["PRINCIPLE A"],
    principalCabang: null, alasanCabang: null };
const SPV = { role: "spv", salesName: "SPV A", spvName: "SPV A", allowedSalesCodes: ["S-01"], principles: ["PRINCIPLE A"] };
const ADMIN = { role: "admin", allowedSalesCodes: null, principles: ["PRINCIPLE A"] };
const baris = (custCode: string, custName: string, over: Record<string, unknown> = {}) => ({ id: `r-${custCode}`, salesCode: "S-01", custCode, custName,
    principle: "PRINCIPLE A", aoStatus: null, monthlyOrderCount: 0, needsAttention: false, checkinAt: null, checkoutAt: null, luarRute: false, ...over });
const BOLEH = { putuskan: false, ktp: false, tautkan: false, kunjungi: false };
const noo = (over: Record<string, unknown> = {}) => ({
    id: "n-1", kode: "NOO-7K3Q9ZTA", salesCode: "S-01", salesName: "SALES A", principle: "PRINCIPLE A", branchId: 50, branchName: "CABANG A", tanggal: HARI_INI,
    namaToko: "TOKO BARU A", alamat: "JL. CONTOH 1", status: "menunggu_spv", gpsFlag: null, duplikatDengan: null, dibuatOlehNama: "Sales A",
    dibuatPada: `${HARI_INI}T09:00:00+08:00`, diputuskanOlehNama: null, diputuskanPada: null, alasanTolak: null, customerNo: null, ditautkanOlehNama: null,
    ditautkanPada: null, boleh: BOLEH, namaPemilik: "PEMILIK A", noHp: "081234567890", namaKtp: "PEMILIK A", nikTersamar: "7371••••••••0012",
    lat: -5.1477, lng: 119.4327, akurasi: 15, alasanDuplikat: null, duplikatDikonfirmasi: false, fotoToko: "/api/form-kontrol/noo/n-1/foto-toko",
    duplikat: Boolean(over.duplikatDengan), ...over,
});

/** hook: true = permintaan sudah dijawab hook (galat/tunda buatan), false = lanjut ke mock biasa. */
type Hook = (route: Route, req: Request, p: string, url: URL) => Promise<boolean> | boolean;
type Opsi = { scope?: unknown; rute?: Record<string, unknown>[]; daftar?: Record<string, unknown>[]; rinci?: Record<string, Record<string, unknown>>;
    saran?: unknown[]; nooPost?: { status: number; body: unknown }[]; spv?: unknown; hook?: Hook; terpotong?: boolean };

async function mockFk(page: Page, opsi: Opsi) {
    const baca: URL[] = [];
    const tulis: Request[] = [];
    await page.route("**/api/form-kontrol/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname.replace("/api/form-kontrol/", "");
        if (req.method() === "GET") baca.push(url); else tulis.push(req);
        if (opsi.hook && (await opsi.hook(route, req, p, url))) return;
        if (p === "my-scope") return route.fulfill(json(opsi.scope ?? SALESMAN));
        if (p === "reasons") return route.fulfill(json({ rows: [{ id: "R01", reasonCode: "R01", label: "Stok masih cukup", category: "stok" }] }));
        if (p === "ao-control" && req.method() === "GET") return route.fulfill(json({ rows: opsi.rute ?? [], summary: {}, date: url.searchParams.get("date") }));
        if (p === "noo" && req.method() === "GET") {
            const st = url.searchParams.get("status")?.split(",");
            // Daftar mengikuti aksi yang sudah dikirim (rinci[id] = keadaan terbaru) — lencana "N menunggu" bisa turun sesudah Setujui.
            const rows = (opsi.daftar ?? []).map((r) => ({ ...r, ...(opsi.rinci?.[String(r.id)] ?? {}) }));
            return route.fulfill(json({ ok: true, rows: rows.filter((r) => !st || st.includes(String(r.status))), selesaiTerpotong: Boolean(opsi.terpotong), batasSelesai: 300 }));
        }
        if (p === "noo" && req.method() === "POST") {
            const j = opsi.nooPost?.shift();
            if (j) return route.fulfill(json(j.body, j.status));
            opsi.rute = [...(opsi.rute ?? []), baris("NOO-7K3Q9ZTA", "TOKO BARU A", { id: "l-noo", luarRute: true })];
            return route.fulfill(json({ ok: true, baru: true, row: noo() }, 201));
        }
        const satu = p.match(/^noo\/([^/]+)(\/ktp|\/foto-toko)?$/);
        if (satu) {
            const [, id, sub] = satu;
            if (sub === "/foto-toko") return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
            if (sub === "/ktp") return route.fulfill(json({ ok: true, kode: "NOO-7K3Q9ZTA", nik: NIK, namaKtp: "PEMILIK A", foto: `data:image/png;base64,${PNG.toString("base64")}` }));
            if (req.method() === "GET") {
                const row = opsi.rinci?.[id] ?? noo();
                const cari = url.searchParams.get("cari");
                return route.fulfill(json({ ok: true, row, pembanding: row.duplikatDengan ? { kode: row.duplikatDengan, namaToko: "TOKO LAMA A", status: "terdaftar",
                    salesCode: "S-02", alamat: "JL. CONTOH 9", customerNo: "C-100009-CBA" } : null,
                    saran: (row.boleh as typeof BOLEH).tautkan ? (cari ? [{ id: 14, customerNo: "C-200014-CBA", name: "TOKO HASIL CARI", alamat: null, skor: null }] : opsi.saran ?? []) : null }));
            }
            const b = req.postDataJSON() as Record<string, unknown>;
            const lama = opsi.rinci?.[id] ?? noo();
            const baru = b.aksi === "setujui" ? { status: "disetujui", boleh: { ...BOLEH, ktp: true } } : b.aksi === "tolak" ? { status: "ditolak", alasanTolak: b.alasan }
                : b.aksi === "tautkan" ? { status: "terdaftar", customerNo: "C-200011-CBA", boleh: BOLEH } : {};
            opsi.rinci = { ...opsi.rinci, [id]: { ...lama, ...baru } };
            return route.fulfill(json({ ok: true, row: opsi.rinci[id] }));
        }
        if (p === "visit") return route.fulfill(json({
            store: { id: "l-noo", salesCode: "S-01", salesName: "SALES A", custCode: "NOO-7K3Q9ZTA", custName: "TOKO BARU A", market: null, alamat: "JL. CONTOH 1",
                kota: null, principle: "PRINCIPLE A", visitFrequency: 0, luarRute: true },
            ao: { id: "a1", status: "not_visited", noOrderReasonCode: null, noOrderNote: null, checkinAt: `${HARI_INI}T09:00:00+08:00`,
                checkinPhotoUrl: "/api/uploads/form-kontrol/in.jpg", checkoutAt: null, checkoutPhotoUrl: null },
            merch: null,
        }));
        if (p === "spv-dashboard") return route.fulfill(json(opsi.spv ?? { rows: [], spvName: "SPV A" }));
        if (p === "sales-profiles") return route.fulfill(json({ rows: [] }));
        return route.fulfill(json({ success: true, id: "x" }));
    });
    await page.route("**/api/uploads/form-kontrol/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    return { baca, tulis };
}
const postKe = (tulis: Request[], akhir: string) => tulis.filter((r) => new URL(r.url()).pathname.endsWith(akhir));

async function noOverflow(page: Page) {
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
}
/** Isi formulir NOO lengkap (foto lewat kamera → berkas). */
async function isiFormulir(page: Page, f: ReturnType<Page["getByRole"]>, o: { nik?: string } = {}) {
    await f.getByLabel("Nama toko").fill("TOKO BARU A");
    await f.getByLabel("Nama pemilik").fill("PEMILIK A");
    await f.getByLabel("Alamat toko").fill("JL. CONTOH 1");
    await f.getByLabel("No. HP pemilik").fill("0812-3456-7890");
    await f.getByLabel("NIK (16 angka)").fill(o.nik ?? NIK);
    await f.getByLabel("Nama sesuai KTP").fill("PEMILIK A");
    for (const [tombol, judul] of [["Ambil foto toko", "Foto toko"], ["Ambil foto KTP", "Foto KTP"]]) {
        await f.getByRole("button", { name: tombol }).click();
        // Peninjau B R1: judul kamera sesuai fotonya (bukan "Foto Bukti Kunjungan").
        const kamera = page.getByRole("dialog", { name: judul });
        await kamera.locator('input[type="file"]').setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: PNG });
        await kamera.getByRole("button", { name: /Gunakan/ }).click();
        await expect(kamera).toBeHidden();
    }
}

test.describe.configure({ timeout: 150_000 });
test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test.describe("salesman ponsel 390 px", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: -5.1477, longitude: 119.4327, accuracy: 15 } });

    test("formulir NOO: validasi terlihat, GPS + 2 foto wajib, kirim multipart → kartu NOO di rute (tanpa ORDER), tidak masuk daftar Order Sales", async ({ page }) => {
        const m = await mockFk(page, { rute: [baris("C-100001", "PELANGGAN A")] });
        await page.goto("/form-kontrol?tab=ao", NAV);
        const r = page.getByRole("region", { name: "Rute hari ini" });
        await expect(r.getByRole("list", { name: "Toko di rute" }).getByRole("listitem")).toHaveCount(1, NAV);
        const sek = r.getByRole("region", { name: "Toko baru (NOO)" });
        await sek.getByRole("button", { name: "Toko baru (belum ada di Accurate)" }).click();
        const f = sek.getByRole("form", { name: "Formulir toko baru" });
        const kirim = f.getByRole("button", { name: "Ajukan toko baru" });
        await expect(kirim).toBeDisabled();
        await expect(f).toContainText("Nama toko wajib diisi.");
        await isiFormulir(page, f, { nik: "737101010101" });
        await expect(f).toContainText("NIK harus tepat 16 angka sesuai KTP.");
        await f.getByLabel("NIK (16 angka)").fill(NIK);
        await expect(f).toContainText("Lokasi GPS toko wajib");
        await f.getByRole("button", { name: "Ambil lokasi" }).click();
        await expect(f.getByRole("status").filter({ hasText: "-5.147700, 119.432700" })).toBeVisible();
        await expect(kirim).toBeEnabled();
        await noOverflow(page);
        await page.screenshot({ path: "test-results/noo/salesman-formulir.png", fullPage: true });
        await kirim.click();

        await expect(sek.getByText(/TOKO BARU A diajukan sebagai toko baru NOO-7K3Q9ZTA/)).toBeVisible(NAV);
        const post = postKe(m.tulis, "/api/form-kontrol/noo");
        expect(post).toHaveLength(1);
        expect(post[0].headers()["content-type"]).toMatch(/^multipart\/form-data/);
        const isi = post[0].postDataBuffer()!.toString("latin1");
        for (const [k, v] of [["salesCode", "S-01"], ["principle", "PRINCIPLE A"], ["nik", NIK], ["noHp", "0812-3456-7890"], ["lat", "-5.1477"], ["lng", "119.4327"]]) {
            expect(isi, k).toContain(`name="${k}"\r\n\r\n${v}`);
        }
        expect(isi).toMatch(/name="id"\r\n\r\n[0-9a-f-]{36}/);
        expect(isi).toContain('name="fotoToko"; filename="toko.jpg"');
        expect(isi).toContain('name="fotoKtp"; filename="ktp.jpg"');
        expect(isi).not.toContain('name="pemilikSama"');
        // Kartu NOO di rute: penanda, tautan kunjungan; daftar toko Order Sales (sessionStorage) tanpa NOO.
        const kartu = r.getByRole("list", { name: "Toko di rute" }).getByRole("listitem").filter({ hasText: "TOKO BARU A" });
        await expect(kartu).toContainText("Toko baru (NOO) · tanpa order", NAV);
        const tersimpan = await page.evaluate(() => sessionStorage.getItem("fk-rute-hari-ini"));
        expect(JSON.parse(tersimpan!).toko.map((t: { kode: string }) => t.kode)).toEqual(["C-100001"]);
        await expect(f).toBeHidden();
        await noOverflow(page);
        await page.screenshot({ path: "test-results/noo/salesman-rute-noo.png", fullPage: true });
    });

    test("duplikat: 409 NOO_DUPLIKAT → pembanding tampil; kirim ulang hanya sebagai 'pemilik sama' + alasan, id SAMA", async ({ page }) => {
        const m = await mockFk(page, { nooPost: [{ status: 409, body: { ok: false, kode: "NOO_DUPLIKAT", error: "NIK atau No. HP ini sudah dipakai NOO lain yang belum ditolak: NOO-AAAA1111 TOKO LAMA A (NIK sama).",
            pembanding: [{ kode: "NOO-AAAA1111", namaToko: "TOKO LAMA A", status: "terdaftar", cocok: ["NIK"] }] } }] });
        await page.goto("/form-kontrol?tab=ao", NAV);
        const sek = page.getByRole("region", { name: "Toko baru (NOO)" });
        await sek.getByRole("button", { name: "Toko baru (belum ada di Accurate)" }).click(NAV);
        const f = sek.getByRole("form", { name: "Formulir toko baru" });
        await isiFormulir(page, f);
        await f.getByRole("button", { name: "Ambil lokasi" }).click();
        await f.getByRole("button", { name: "Ajukan toko baru" }).click();
        await expect(f.getByRole("status").filter({ hasText: "NIK atau No. HP sudah dipakai NOO lain." })).toContainText("NOO-AAAA1111 TOKO LAMA A · NIK sama", NAV);
        const kirim = f.getByRole("button", { name: "Ajukan toko baru" });
        await expect(kirim).toBeDisabled();
        await f.getByRole("checkbox", { name: "Minta konfirmasi SPV: pemilik sama" }).check();
        await expect(f).toContainText("Tulis alasan pemilik sama untuk SPV");
        await f.getByLabel("Alasan untuk SPV").fill("Pemilik membuka toko kedua di pasar.");
        await expect(kirim).toBeEnabled();
        await noOverflow(page);
        await page.screenshot({ path: "test-results/noo/salesman-duplikat.png", fullPage: true });
        await kirim.click();
        await expect(sek.getByText(/diajukan sebagai toko baru/)).toBeVisible(NAV);
        const isi = postKe(m.tulis, "/api/form-kontrol/noo").map((q) => q.postDataBuffer()!.toString("latin1"));
        expect(isi).toHaveLength(2);
        const id = (s: string) => s.match(/name="id"\r\n\r\n([0-9a-f-]{36})/)![1];
        expect(id(isi[1])).toBe(id(isi[0]));
        expect(isi[1]).toContain('name="pemilikSama"\r\n\r\nya');
        expect(isi[1]).toContain('name="alasanDuplikat"\r\n\r\nPemilik membuka toko kedua di pasar.');
    });

    test("kunjungan NOO: hanya TIDAK ORDER + penjelasan; header Toko baru (NOO)", async ({ page }) => {
        const m = await mockFk(page, {});
        await page.goto(`/form-kontrol/visit/NOO-7K3Q9ZTA?salesCode=S-01&principle=PRINCIPLE+A&date=${HARI_INI}`, NAV);
        await expect(page.getByRole("heading", { name: "TOKO BARU A" })).toBeVisible(NAV);
        await expect(page.getByText("Toko baru (NOO)", { exact: true })).toBeVisible();
        await expect(page.getByRole("radio", { name: "ORDER", exact: true })).toHaveCount(0);
        await expect(page.getByText("Toko baru (NOO), belum terdaftar di Accurate:")).toBeVisible();
        await page.getByRole("radio", { name: "TIDAK ORDER" }).check();
        await page.getByLabel("Alasan tidak order").selectOption("R01");
        await page.getByRole("button", { name: "Simpan & lanjut" }).click();
        await expect.poll(() => postKe(m.tulis, "/ao-control").map((q) => q.postDataJSON().status)).toEqual(["not_order"]);
        await noOverflow(page);
        await page.screenshot({ path: "test-results/noo/salesman-kunjungan-noo.png", fullPage: true });
    });
});

test.describe("izin lokasi ditolak (390 px)", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: [] });
    test("Ambil lokasi ditolak → cara menyalakan izin; kirim tetap terkunci", async ({ page, context }) => {
        await context.clearPermissions();
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
                getCurrentPosition: (_ok: unknown, gagal: (e: { code: number }) => void) => setTimeout(() => gagal({ code: 1 }), 10),
            } });
        });
        await mockFk(page, {});
        await page.goto("/form-kontrol?tab=ao", NAV);
        const sek = page.getByRole("region", { name: "Toko baru (NOO)" });
        await sek.getByRole("button", { name: "Toko baru (belum ada di Accurate)" }).click(NAV);
        const f = sek.getByRole("form", { name: "Formulir toko baru" });
        await isiFormulir(page, f);
        await f.getByRole("button", { name: "Ambil lokasi" }).click();
        await expect(f.getByRole("alert").filter({ hasText: "Izin lokasi ditolak" })).toContainText("Izin situs → Lokasi → Izinkan");
        await expect(f.getByRole("button", { name: "Ajukan toko baru" })).toBeDisabled();
        await expect(f).toContainText("Lokasi GPS toko wajib");
        await noOverflow(page);
    });
});

test.describe("SPV ponsel 390 px", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("rincian: NIK tersamar, Lihat KTP (POST, NIK penuh hanya di dialog, hilang saat ditutup); duplikat WAJIB centang; tolak beralasan", async ({ page }) => {
        const dup = noo({ id: "n-2", kode: "NOO-DUPL2222", namaToko: "TOKO BARU A CABANG 2", duplikatDengan: "NOO-AAAA1111", alasanDuplikat: "Pemilik membuka toko kedua.",
            boleh: { ...BOLEH, putuskan: true, ktp: true } });
        const biasa = noo({ id: "n-3", kode: "NOO-BIASA333", namaToko: "TOKO BARU B", boleh: { ...BOLEH, putuskan: true, ktp: true } });
        const m = await mockFk(page, { scope: SPV, daftar: [dup, biasa], rinci: { "n-2": dup, "n-3": biasa } });
        await page.goto("/form-kontrol?tab=noo", NAV);
        const daftar = page.getByRole("list", { name: "Menunggu persetujuan" });
        await expect(daftar.getByRole("listitem")).toHaveCount(2, NAV);
        await expect(daftar).toContainText("kemungkinan pemilik sama");
        await daftar.getByRole("button", { name: /TOKO BARU A CABANG 2/ }).click();
        const rinci = page.getByRole("region", { name: "Rincian toko baru" });
        await expect(rinci.getByText("7371••••••••0012")).toBeVisible(NAV);
        await expect(rinci).toContainText("NIK atau No. HP sama dengan NOO-AAAA1111.");
        await expect(rinci).toContainText("TOKO LAMA A");
        await expect(rinci.getByRole("img", { name: "Foto toko TOKO BARU A CABANG 2" })).toBeVisible();
        await expect(rinci.getByRole("link", { name: "Buka di peta" })).toHaveAttribute("href", "https://www.google.com/maps?q=-5.1477,119.4327");
        expect(await page.content()).not.toContain(NIK);
        await noOverflow(page);
        await page.screenshot({ path: "test-results/noo/spv-rincian.png", fullPage: true });

        await rinci.getByRole("button", { name: "Lihat KTP" }).click();
        const ktp = page.getByRole("dialog", { name: "KTP NOO-DUPL2222" });
        await expect(ktp).toContainText(NIK, NAV);
        await expect(ktp.getByRole("img", { name: /Foto KTP/ })).toBeVisible();
        expect(postKe(m.tulis, "/n-2/ktp").length).toBeGreaterThanOrEqual(1);
        expect(m.baca.some((u) => u.pathname.endsWith("/ktp")), "KTP tidak pernah lewat GET").toBe(false);
        await page.screenshot({ path: "test-results/noo/spv-ktp.png", fullPage: true });
        await ktp.getByRole("button", { name: "Tutup" }).click();
        await expect(ktp).toBeHidden();
        expect(await page.content(), "NIK penuh dibuang dari DOM sesudah dialog ditutup").not.toContain(NIK);

        await rinci.getByRole("button", { name: "Setujui" }).click();
        const setuju = page.getByRole("dialog", { name: /Setujui toko baru/ });
        const tombol = setuju.getByRole("button", { name: "Setujui" });
        await expect(tombol).toBeDisabled();
        await expect(setuju).toContainText("Centang konfirmasi pemilik sama dulu");
        await setuju.getByRole("checkbox", { name: /Pemilik toko memang sama dengan NOO-AAAA1111/ }).check();
        await tombol.click();
        await expect(setuju).toBeHidden(NAV);
        expect(postKe(m.tulis, "/noo/n-2").map((q) => q.postDataJSON())).toEqual([{ aksi: "setujui", konfirmasiPemilikSama: true }]);
        await expect(rinci).toContainText("NOO-DUPL2222 disetujui; masuk antrean Admin.");

        await page.getByRole("button", { name: "Kembali ke daftar" }).click();
        await daftar.getByRole("button", { name: /TOKO BARU B/ }).click();
        await rinci.getByRole("button", { name: "Tolak…" }).click();
        const tolak = page.getByRole("dialog", { name: /Tolak toko baru/ });
        await tolak.getByLabel("Alasan penolakan").fill("abc");
        await expect(tolak.getByRole("button", { name: "Tolak" })).toBeDisabled();
        await tolak.getByLabel("Alasan penolakan").fill("Lokasi tidak sesuai foto.");
        await tolak.getByRole("button", { name: "Tolak" }).click();
        await expect(tolak).toBeHidden(NAV);
        expect(postKe(m.tulis, "/noo/n-3").map((q) => q.postDataJSON())).toEqual([{ aksi: "tolak", alasan: "Lokasi tidak sesuai foto." }]);
        await noOverflow(page);
    });

    test("SM pengganti: setujui + Lihat KTP (owner 13 Okt malam); Manager: lihat tanpa KTP & tanpa aksi", async ({ page }) => {
        const r = noo({ boleh: { ...BOLEH, putuskan: true, ktp: true } });
        await mockFk(page, { scope: { role: "sm", smName: "SM A", salesName: "SM A", allowedSalesCodes: ["S-01"], principles: ["PRINCIPLE A"] }, daftar: [r], rinci: { "n-1": r } });
        await page.goto("/form-kontrol?tab=noo", NAV);
        await page.getByRole("list", { name: "Menunggu persetujuan" }).getByRole("button", { name: /TOKO BARU A/ }).click(NAV);
        const rinci = page.getByRole("region", { name: "Rincian toko baru" });
        await expect(rinci.getByRole("button", { name: "Setujui" })).toBeVisible(NAV);
        await expect(rinci.getByRole("button", { name: "Lihat KTP" })).toBeVisible();
    });

    test("Manager: rincian tanpa Lihat KTP, tanpa Setujui/Tautkan", async ({ page }) => {
        const r = noo({ status: "disetujui", diputuskanOlehNama: "SPV A (SPV)", diputuskanPada: `${HARI_INI}T10:00:00+08:00`, boleh: BOLEH });
        await mockFk(page, { scope: { role: "manager", allowedSalesCodes: null, principles: ["PRINCIPLE A"] }, daftar: [r], rinci: { "n-1": r } });
        await page.goto("/form-kontrol?tab=noo", NAV);
        await page.getByRole("list", { name: "Disetujui — daftarkan di Accurate" }).getByRole("button", { name: /TOKO BARU A/ }).click(NAV);
        const rinci = page.getByRole("region", { name: "Rincian toko baru" });
        await expect(rinci).toContainText("KTP lengkap hanya untuk SPV/SM tim dan Admin.", NAV);
        await expect(rinci).toContainText("Menunggu Admin mendaftarkan toko ini di Accurate");
        for (const t of ["Lihat KTP", "Setujui", "Tautkan…"]) await expect(rinci.getByRole("button", { name: t })).toHaveCount(0);
    });

    test("Dashboard SPV: kunjungan NOO bertanda Toko baru (NOO)", async ({ page }) => {
        await mockFk(page, { scope: SPV, spv: { spvName: "SPV A", rows: [{ salesCode: "S-01", salesName: "SALES A", totalRoute: 1, ordered: 0, notOrder: 1, notVisited: 0, checkedIn: 1,
            checkedOut: 1, submittedAt: null, tindakLanjut: null, spvAck: false, spvAckAt: null, totalFieldMinutes: 10, periodMonth: 10, periodYear: 2026,
            visits: [{ custCode: "NOO-7K3Q9ZTA", custName: "TOKO BARU A", luarRute: true, status: "not_order", checkinAt: `${HARI_INI}T09:00:00+08:00`,
                checkoutAt: `${HARI_INI}T09:10:00+08:00`, durationMinutes: 10, gpsFlag: null, durFlag: null, checkinPhotoUrl: null, checkoutPhotoUrl: null,
                merchDone: 0, merchTotal: 6, merchStepPhotos: null }] }] } });
        await page.goto("/form-kontrol/spv-dashboard", NAV);
        await page.getByText("Detail kunjungan (1)").click(NAV);
        await expect(page.getByRole("listitem").filter({ hasText: "TOKO BARU A" })).toContainText("Toko baru (NOO)", NAV);
        await noOverflow(page);
    });
});

test.describe("Admin", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("antrean disetujui: data siap salin, saran + cari, tautkan lewat dialog → terdaftar", async ({ page, context }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        const r = noo({ status: "disetujui", diputuskanOlehNama: "SPV A (SPV)", diputuskanPada: `${HARI_INI}T10:00:00+08:00`, boleh: { ...BOLEH, ktp: true, tautkan: true } });
        const m = await mockFk(page, { scope: ADMIN, daftar: [r], rinci: { "n-1": r },
            saran: [{ id: 11, customerNo: "C-200011-CBA", name: "TOKO BARU A", alamat: "JL. CONTOH 1", skor: 0.83 }] });
        await page.goto("/form-kontrol?tab=noo", NAV);
        const daftar = page.getByRole("list", { name: "Disetujui — daftarkan di Accurate" });
        await daftar.getByRole("button", { name: /TOKO BARU A/ }).click(NAV);
        const rinci = page.getByRole("region", { name: "Rincian toko baru" });
        await rinci.getByRole("button", { name: "Salin nomor HP" }).click(NAV);
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("081234567890");
        await expect(rinci.getByRole("radio", { name: /C-200011-CBA TOKO BARU A · JL. CONTOH 1 · kemiripan 83%/ })).toBeVisible();
        await rinci.getByLabel("Cari nama atau kode pelanggan").fill("hasil");
        await rinci.getByRole("button", { name: "Cari" }).click();
        await expect(rinci.getByRole("radio", { name: /C-200014-CBA TOKO HASIL CARI/ })).toBeVisible(NAV);
        expect(m.baca.some((u) => u.pathname.endsWith("/noo/n-1") && u.searchParams.get("cari") === "hasil")).toBe(true);
        const tautkan = rinci.getByRole("button", { name: "Tautkan…" });
        await expect(tautkan).toBeDisabled();
        await rinci.getByRole("radio", { name: /C-200014-CBA/ }).check();
        await noOverflow(page);
        await page.screenshot({ path: "test-results/noo/admin-tautkan.png", fullPage: true });
        await tautkan.click();
        const d = page.getByRole("dialog", { name: "Tautkan NOO-7K3Q9ZTA ke C-200014-CBA?" });
        await d.getByRole("button", { name: "Tautkan" }).click();
        await expect(d).toBeHidden(NAV);
        expect(postKe(m.tulis, "/noo/n-1").map((q) => q.postDataJSON())).toEqual([{ aksi: "tautkan", customerId: 14 }]);
        await expect(rinci).toContainText("Terdaftar sebagai C-200011-CBA.", NAV);
    });
});

// ============================================================================ putaran 2 (peninjau B 13 Okt)

test.describe("putaran 2 — salesman 390 px", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: -5.1477, longitude: 119.4327, accuracy: 15 } });

    test("S7 kirim ganda: dblclick + Enter berulang = 1 POST; tombol terkunci + aria-busy selama kirim", async ({ page }) => {
        const m = await mockFk(page, { hook: async (_route, req, p) => {
            if (p === "noo" && req.method() === "POST") await new Promise((r) => setTimeout(r, 1500));
            return false;
        } });
        await page.goto("/form-kontrol?tab=ao", NAV);
        const sek = page.getByRole("region", { name: "Toko baru (NOO)" });
        await sek.getByRole("button", { name: "Toko baru (belum ada di Accurate)" }).click(NAV);
        const f = sek.getByRole("form", { name: "Formulir toko baru" });
        await isiFormulir(page, f);
        await f.getByRole("button", { name: "Ambil lokasi" }).click();
        const kirim = f.getByRole("button", { name: "Ajukan toko baru" });
        await expect(kirim).toBeEnabled();
        await kirim.dblclick();
        await f.getByLabel("Nama toko").press("Enter").catch(() => {});
        await expect(kirim).toHaveAttribute("aria-busy", "true");
        await expect(kirim).toBeDisabled();
        await f.getByLabel("Nama toko").press("Enter").catch(() => {});
        await expect(sek.getByText(/diajukan sebagai toko baru/)).toBeVisible(NAV);
        expect(postKe(m.tulis, "/api/form-kontrol/noo")).toHaveLength(1);
    });

    test("S2 galat per isian: aria-invalid + pesan di isian sesudah disentuh; galat pertama = isian salah paling atas; 'Ke isian' memfokuskan", async ({ page }) => {
        await mockFk(page, {});
        await page.goto("/form-kontrol?tab=ao", NAV);
        const sek = page.getByRole("region", { name: "Toko baru (NOO)" });
        await sek.getByRole("button", { name: "Toko baru (belum ada di Accurate)" }).click(NAV);
        const f = sek.getByRole("form", { name: "Formulir toko baru" });
        const hp = f.getByLabel("No. HP pemilik");
        await expect(hp).not.toHaveAttribute("aria-invalid", "true");
        await f.getByLabel("Nama toko").fill("TOKO BARU A");
        await f.getByLabel("Nama pemilik").fill("PEMILIK A");
        await f.getByLabel("Alamat toko").fill("JL. CONTOH 1");
        await hp.fill("0211234567");
        await f.getByLabel("Nama sesuai KTP").focus(); // keluar dari HP = disentuh
        await expect(hp).toHaveAttribute("aria-invalid", "true");
        const pesanHp = page.locator(`#${(await hp.getAttribute("aria-describedby"))!.split(" ")[0]}`);
        await expect(pesanHp).toHaveText("No. HP pemilik harus nomor seluler Indonesia (08…, +62…), 10–13 angka.");
        // Nama KTP (isian terakhir) kosong juga, tetapi yang disebut di bawah tombol = HP (lebih atas).
        await expect(f.locator(".fi-why")).toContainText("No. HP pemilik harus nomor seluler Indonesia");
        await f.getByRole("button", { name: "Ke isian yang belum benar" }).click();
        await expect(hp).toBeFocused();
        await expect(f.getByLabel("Nama sesuai KTP")).toHaveAttribute("aria-invalid", "true");
        await noOverflow(page);
    });

    test("S1 pindah tab saat formulir terisi: ditanya dulu; 'Tetap di sini' = isian + foto utuh; 'Buang' = pindah tab", async ({ page }) => {
        await mockFk(page, {});
        await page.goto("/form-kontrol?tab=ao", NAV);
        const sek = page.getByRole("region", { name: "Toko baru (NOO)" });
        await sek.getByRole("button", { name: "Toko baru (belum ada di Accurate)" }).click(NAV);
        const f = sek.getByRole("form", { name: "Formulir toko baru" });
        await isiFormulir(page, f);
        const tabNoo = page.getByRole("navigation", { name: "Modul Form Kontrol" }).getByRole("link", { name: /Toko Baru \(NOO\)/ });
        await tabNoo.click();
        const tanya = page.getByRole("dialog", { name: "Buang isian toko baru?" });
        await expect(tanya).toBeVisible(NAV);
        await tanya.getByRole("button", { name: "Tetap di sini" }).click();
        await expect(tanya).toBeHidden();
        await expect(page).toHaveURL(/tab=ao/);
        await expect(f.getByLabel("Nama toko")).toHaveValue("TOKO BARU A");
        await expect(f.getByRole("img", { name: "Pratinjau foto KTP" })).toBeVisible();
        await tabNoo.click();
        await page.getByRole("dialog", { name: "Buang isian toko baru?" }).getByRole("button", { name: "Buang isian dan pindah" }).click();
        await expect(page).toHaveURL(/tab=noo/, NAV);
        await expect(page.getByRole("region", { name: "Toko baru", exact: true })).toBeVisible(NAV);
    });

    test("R3 batalkan kunjungan NOO: dialog menyebut pengajuan tetap menunggu SPV + jalan kembali", async ({ page }) => {
        await mockFk(page, { rute: [baris("NOO-7K3Q9ZTA", "TOKO BARU A", { id: "l-noo", luarRute: true })] });
        await page.goto("/form-kontrol?tab=ao", NAV);
        await page.getByRole("button", { name: "Batalkan kunjungan TOKO BARU A" }).click(NAV);
        const d = page.getByRole("dialog", { name: "Batalkan kunjungan TOKO BARU A?" });
        await expect(d).toContainText("pengajuan toko baru TETAP menunggu SPV");
        await expect(d).toContainText("Toko baru (NOO) · hari ini");
        await expect(d).not.toContainText("Luar rute · hari ini");
    });
});

test.describe("putaran 2 — SPV/Admin 390 px", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("S6 galat daftar 500 / putus / 403 = ErrorState (bukan kosong); muat ulang berhasil → daftar", async ({ page }) => {
        let mode = 1;
        const r = noo({ boleh: { ...BOLEH, putuskan: true, ktp: true } });
        await mockFk(page, { scope: SPV, daftar: [r], rinci: { "n-1": r }, hook: async (route, req, p) => {
            if (p !== "noo" || req.method() !== "GET" || mode === 0) return false;
            if (mode === 2) await route.abort("failed");
            else await route.fulfill(mode === 1 ? json({ ok: false, error: "Internal server error" }, 500) : json({ ok: false, kode: "LUAR_CAKUPAN", error: "Daftar toko baru di luar cakupan akun Anda." }, 403));
            return true;
        } });
        await page.goto("/form-kontrol?tab=noo", NAV);
        const tab = page.getByRole("region", { name: "Toko baru", exact: true });
        for (const md of [1, 2, 3]) {
            mode = md;
            if (md > 1) await tab.getByRole("button", { name: /Coba lagi|Muat ulang/ }).first().click();
            await expect(tab.getByText("Toko baru belum bisa ditampilkan")).toBeVisible(NAV);
            await expect(tab.getByText("Daftar toko baru gagal dimuat.", { exact: false })).toBeVisible();
            await expect(tab.getByText("Belum ada pengajuan toko baru")).toHaveCount(0);
        }
        mode = 0;
        await tab.getByRole("button", { name: "Muat ulang" }).first().click();
        await expect(tab.getByRole("list", { name: "Menunggu persetujuan" }).getByRole("listitem")).toHaveCount(1, NAV);
    });

    test("B T1 rincian: muat ulang gagal sesudah Setujui = strip galat + aksi dikunci (bukan status lama tanpa tanda); foto toko 404 = kalimat + muat ulang", async ({ page }) => {
        let rinciGagal = false;
        const r = noo({ boleh: { ...BOLEH, putuskan: true, ktp: true } });
        await mockFk(page, { scope: SPV, daftar: [r], rinci: { "n-1": r }, hook: async (route, req, p) => {
            if (p === "noo/n-1" && req.method() === "GET" && rinciGagal) { await route.fulfill(json({ ok: false, error: "Internal server error" }, 500)); return true; }
            if (p === "noo/n-1/foto-toko") { await route.fulfill({ status: 404, contentType: "application/json", body: "{}" }); return true; }
            return false;
        } });
        await page.goto("/form-kontrol?tab=noo", NAV);
        await page.getByRole("list", { name: "Menunggu persetujuan" }).getByRole("button", { name: /TOKO BARU A/ }).click(NAV);
        const rinci = page.getByRole("region", { name: "Rincian toko baru" });
        await expect(rinci.getByRole("status").filter({ hasText: "Foto toko gagal dimuat." })).toBeVisible(NAV);
        await expect(rinci.getByRole("button", { name: "Muat ulang foto" })).toBeVisible();
        rinciGagal = true;
        await rinci.getByRole("button", { name: "Setujui" }).click();
        const d = page.getByRole("dialog", { name: /Setujui toko baru/ });
        await d.getByRole("button", { name: "Setujui" }).click();
        await expect(d).toBeHidden(NAV);
        await expect(rinci.getByRole("alert").filter({ hasText: "Gagal memuat ulang rincian." })).toBeVisible(NAV);
        await expect(rinci.getByRole("button", { name: "Setujui" })).toBeDisabled();
        await expect(rinci.getByRole("button", { name: "Tolak…" })).toBeDisabled();
        await noOverflow(page);
    });

    test("B T1 Admin cari: 500 / putus = galat (tanpa 'Hasil …' maupun 'Belum ada pelanggan cocok'), Tautkan dikunci; cari berhasil sesudahnya", async ({ page }) => {
        let cari = "";
        const r = noo({ status: "disetujui", diputuskanOlehNama: "SPV A (SPV)", diputuskanPada: `${HARI_INI}T10:00:00+08:00`, boleh: { ...BOLEH, ktp: true, tautkan: true } });
        await mockFk(page, { scope: ADMIN, daftar: [r], rinci: { "n-1": r }, saran: [{ id: 11, customerNo: "C-200011-CBA", name: "TOKO BARU A", alamat: "JL. CONTOH 1", skor: 0.83 }],
            hook: async (route, req, p, url) => {
                cari = url.searchParams.get("cari") ?? "";
                if (p !== "noo/n-1" || req.method() !== "GET") return false;
                if (cari === "galat") { await route.fulfill(json({ ok: false, error: "Internal server error" }, 500)); return true; }
                if (cari === "putus") { await route.abort("failed"); return true; }
                return false;
            } });
        await page.goto("/form-kontrol?tab=noo", NAV);
        await page.getByRole("list", { name: "Disetujui — daftarkan di Accurate" }).getByRole("button", { name: /TOKO BARU A/ }).click(NAV);
        const rinci = page.getByRole("region", { name: "Rincian toko baru" });
        await rinci.getByRole("radio", { name: /C-200011-CBA/ }).check(NAV);
        for (const q of ["galat", "putus"]) {
            await rinci.getByLabel("Cari nama atau kode pelanggan").fill(q);
            await rinci.getByRole("button", { name: "Cari" }).click();
            await expect(rinci.getByRole("alert").filter({ hasText: "Gagal memuat ulang rincian." })).toBeVisible(NAV);
            await expect(rinci).toContainText(`Pencarian "${q}" gagal dimuat — bukan berarti pelanggan belum ada.`);
            await expect(rinci.getByText(/Belum ada pelanggan cocok/)).toHaveCount(0);
            await expect(rinci.getByText(/^Hasil "/)).toHaveCount(0);
            await expect(rinci.getByRole("radio")).toHaveCount(0);
            await expect(rinci.getByRole("button", { name: "Tautkan…" })).toBeDisabled();
        }
        await rinci.getByLabel("Cari nama atau kode pelanggan").fill("hasil");
        await rinci.getByRole("button", { name: "Cari" }).click();
        await expect(rinci.getByText('Hasil "hasil" di cabang CABANG A:')).toBeVisible(NAV);
        await expect(rinci.getByRole("alert")).toHaveCount(0);
        await expect(rinci.getByRole("radio", { name: /C-200014-CBA TOKO HASIL CARI/ })).toBeVisible();
    });

    test("S3 Lihat KTP: fokus kembali ke tombol sesudah Escape maupun Tutup; NIK tidak tersisa di DOM", async ({ page }) => {
        const r = noo({ boleh: { ...BOLEH, putuskan: true, ktp: true } });
        await mockFk(page, { scope: SPV, daftar: [r], rinci: { "n-1": r } });
        await page.goto("/form-kontrol?tab=noo", NAV);
        await page.getByRole("list", { name: "Menunggu persetujuan" }).getByRole("button", { name: /TOKO BARU A/ }).click(NAV);
        const rinci = page.getByRole("region", { name: "Rincian toko baru" });
        const lihat = rinci.getByRole("button", { name: "Lihat KTP" });
        for (const tutup of ["Escape", "Tutup"]) {
            await lihat.click(NAV);
            const ktp = page.getByRole("dialog", { name: "KTP NOO-7K3Q9ZTA" });
            await expect(ktp).toContainText(NIK, NAV);
            if (tutup === "Escape") await page.keyboard.press("Escape"); else await ktp.getByRole("button", { name: "Tutup" }).click();
            await expect(ktp).toBeHidden();
            await expect(lihat).toBeFocused();
            expect(await page.content(), `NIK penuh dibuang sesudah ${tutup}`).not.toContain(NIK);
        }
    });

    test("S4 lencana tab Toko Baru = NOO menunggu keputusan akun ini; Dashboard SPV memberi strip + tautan", async ({ page }) => {
        const bisa = noo({ boleh: { ...BOLEH, putuskan: true, ktp: true } });
        const lain = noo({ id: "n-2", kode: "NOO-LAIN2222", namaToko: "TOKO BARU B", boleh: BOLEH });
        await mockFk(page, { scope: SPV, daftar: [bisa, lain] });
        await page.goto("/form-kontrol?tab=ao", NAV);
        const tabNoo = page.getByRole("navigation", { name: "Modul Form Kontrol" }).getByRole("link", { name: /Toko Baru \(NOO\)/ });
        await expect(tabNoo).toHaveAccessibleName("Toko Baru (NOO) (1 menunggu persetujuan)", NAV);
        await page.goto("/form-kontrol/spv-dashboard", NAV);
        const strip = page.getByRole("status").filter({ hasText: "1 toko baru (NOO) menunggu persetujuan Anda." });
        await expect(strip).toBeVisible(NAV);
        await expect(strip.getByRole("link", { name: "Buka Toko Baru (NOO)" })).toHaveAttribute("href", "/form-kontrol?tab=noo");
        await noOverflow(page);
    });

    test("selesai terpotong: kelompok Terdaftar/ditolak memberi tahu hanya 300 terbaru; aktif tetap tampil", async ({ page }) => {
        const tolak = noo({ id: "n-9", kode: "NOO-TOLAK999", namaToko: "TOKO DITOLAK", status: "ditolak", alasanTolak: "Uji.", diputuskanOlehNama: "SPV A", diputuskanPada: `${HARI_INI}T10:00:00+08:00` });
        await mockFk(page, { scope: ADMIN, daftar: [noo(), tolak], terpotong: true });
        await page.goto("/form-kontrol?tab=noo", NAV);
        const tab = page.getByRole("region", { name: "Toko baru", exact: true });
        await expect(tab.getByRole("list", { name: "Menunggu persetujuan" }).getByRole("listitem")).toHaveCount(1, NAV);
        await expect(tab).toContainText("1 toko (300 terbaru)");
        await expect(tab).toContainText("Hanya 300 toko terdaftar/ditolak terbaru yang tampil; yang menunggu dan disetujui selalu tampil semua.");
    });
});

// ============================================================================ putaran 3 (verifikasi delta 14 Okt)

test.describe("putaran 3 — 390 px", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ["geolocation"], geolocation: { latitude: -5.1477, longitude: 119.4327, accuracy: 15 } });

    test("S-b1 tombol Kembali saat formulir terisi: ditanya dulu; Tetap = isian utuh; Buang = mundur; formulir dibuang = Kembali biasa", async ({ page }) => {
        await mockFk(page, {});
        await page.goto("/form-kontrol?tab=noo", NAV);
        await expect(page.getByRole("region", { name: "Toko baru", exact: true })).toBeVisible(NAV);
        await page.goto("/form-kontrol?tab=ao", NAV);
        const sek = page.getByRole("region", { name: "Toko baru (NOO)" });
        const buka = async () => {
            await sek.getByRole("button", { name: "Toko baru (belum ada di Accurate)" }).click(NAV);
            await sek.getByRole("form", { name: "Formulir toko baru" }).getByLabel("Nama toko").fill("TOKO BARU A");
        };
        await buka();
        const f = sek.getByRole("form", { name: "Formulir toko baru" });
        const tanya = page.getByRole("dialog", { name: "Buang isian toko baru?" });
        await page.goBack({ waitUntil: "commit" });
        await expect(tanya).toBeVisible(NAV);
        await expect(page).toHaveURL(/tab=ao/);
        await tanya.getByRole("button", { name: "Tetap di sini" }).click();
        await expect(tanya).toBeHidden();
        await expect(f.getByLabel("Nama toko")).toHaveValue("TOKO BARU A");
        await page.goBack({ waitUntil: "commit" });
        await expect(tanya).toBeVisible(NAV);
        await tanya.getByRole("button", { name: "Buang isian dan pindah" }).click();
        await expect(page).toHaveURL(/tab=noo/, NAV);
        // Formulir dibuang lewat "Batal" → penjaga dilepas: satu kali Kembali langsung ke halaman sebelumnya, tanpa dialog.
        await page.goto("/form-kontrol?tab=ao", NAV);
        await buka();
        await f.getByRole("button", { name: "Batal" }).click();
        await expect(f).toBeHidden();
        await page.goBack({ waitUntil: "commit" });
        await expect(page).toHaveURL(/tab=noo/, NAV);
        await expect(tanya).toHaveCount(0);
    });

    test("R-b3 galat isian diumumkan (aria-live) + galat foto/GPS terhubung ke tombolnya (aria-describedby)", async ({ page }) => {
        await mockFk(page, {});
        await page.goto("/form-kontrol?tab=ao", NAV);
        const sek = page.getByRole("region", { name: "Toko baru (NOO)" });
        await sek.getByRole("button", { name: "Toko baru (belum ada di Accurate)" }).click(NAV);
        const f = sek.getByRole("form", { name: "Formulir toko baru" });
        const live = f.locator('[aria-live="polite"][data-uji="galat-live"]');
        await expect(live).toContainText("Nama toko wajib diisi.");
        await f.getByLabel("Nama toko").fill("TOKO BARU A");
        await expect(live).toContainText("Nama pemilik wajib diisi.");
        await f.getByRole("button", { name: "Ke isian yang belum benar" }).click();
        for (const [tombol, pesan] of [["Ambil foto toko", "Ambil foto toko dulu."], ["Ambil lokasi", "Lokasi GPS toko wajib"], ["Ambil foto KTP", "Ambil foto KTP dulu."]]) {
            const b = f.getByRole("button", { name: tombol });
            await expect(b).toHaveAttribute("aria-invalid", "true");
            const id = await b.getAttribute("aria-describedby");
            expect(id, tombol).toBeTruthy();
            await expect(page.locator(`[id="${id}"]`)).toContainText(pesan);
        }
    });

    test("R-b1 + R-b2: lencana turun sesudah Setujui tanpa muat ulang halaman; tab Toko Baru berlencana tergulir ke layar", async ({ page }) => {
        const r = noo({ boleh: { ...BOLEH, putuskan: true, ktp: true } });
        await mockFk(page, { scope: SPV, daftar: [r], rinci: { "n-1": r } });
        await page.goto("/form-kontrol?tab=noo", NAV);
        const nav = page.getByRole("navigation", { name: "Modul Form Kontrol" });
        const tabNoo = nav.getByRole("link", { name: /Toko Baru \(NOO\)/ });
        await expect(tabNoo).toHaveAccessibleName("Toko Baru (NOO) (1 menunggu persetujuan)", NAV);
        await expect.poll(() => tabNoo.evaluate((a) => { const n = a.closest("nav")!.getBoundingClientRect(), t = a.getBoundingClientRect();
            return t.left >= n.left - 1 && t.right <= n.right + 1; })).toBe(true);
        expect(await nav.evaluate((n) => n.scrollLeft)).toBeGreaterThan(0);
        await page.getByRole("list", { name: "Menunggu persetujuan" }).getByRole("button", { name: /TOKO BARU A/ }).click();
        const rinci = page.getByRole("region", { name: "Rincian toko baru" });
        await rinci.getByRole("button", { name: "Setujui" }).click(NAV);
        const d = page.getByRole("dialog", { name: /Setujui toko baru/ });
        await d.getByRole("button", { name: "Setujui" }).click();
        await expect(d).toBeHidden(NAV);
        await expect(tabNoo).toHaveAccessibleName("Toko Baru (NOO)", NAV);
        await expect(tabNoo.locator(".fi-count")).toHaveCount(0);
    });
});
