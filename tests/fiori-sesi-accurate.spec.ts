/*
 * Tujuan: Halaman /sesi-accurate + kartu Sesi Accurate di Konsol (S7-sesi, owner D-01 Q2, AM-033): belum masuk / masuk tanpa database /
 *   database aktif / Keluar / galat sesi & daftar ≠ kosong / kabar `?accurate=error&alasan=<kode>` dipetakan (teks query tidak tampil) /
 *   tautan Masuk = route login ber-`state` (cookie httpOnly+Secure+Lax hanya ke callback) / Konsol memakai kartu yang sama.
 * Caller: Playwright lokal, DUA mode server (config sementara, baseURL :3021, `--workers=1`):
 *   A. `LOCAL_AUTH_BYPASS=true` (izin admin, tanpa DB): blok "kartu".
 *   B. Akun nyata (server tanpa bypass + Postgres berisi 3 akun bergrup): set `PW_SESI_FAKTURIST`, `PW_SESI_TANPA_KUNCI`, `PW_SESI_KONSOL`
 *      = "email:sandi" (Fakturist = order.view+order.edit; tanpa kunci = dashboard.view; Konsol = dashboard.view+api_wrapper.view)
 *      → blok "akun nyata"; blok A dilewati.
 * Dependensi: /api/auth/accurate-session, /api/auth/db-list, /api/auth/open-db di-mock page.route. Route login ASLI dipanggil lewat
 *   route.fetch tanpa mengikuti redirect (page.route tidak mencegat permintaan hasil redirect) → peramban TIDAK pernah ke accurate.id
 *   (dijaga asersi); callback hanya diuji dengan state salah/hilang, yang ditolak sebelum code ditukar.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const BELUM = { ok: true, connected: false, databaseConnected: false, sessionHost: null, databaseId: null, databaseAlias: null };
const TANPA_DB = { ...BELUM, connected: true };
const AKTIF = { ok: true, connected: true, databaseConnected: true, sessionHost: "https://contoh.accurate.id", databaseId: "77", databaseAlias: "PT CONTOH" };
const DAFTAR = { s: true, d: [{ id: 77, alias: "PT CONTOH" }, { id: 88, alias: "PT CONTOH DUA" }] };
const AKUN_NYATA = Boolean(process.env.PW_SESI_FAKTURIST && process.env.PW_SESI_TANPA_KUNCI && process.env.PW_SESI_KONSOL);

type Jawab = ReturnType<typeof json>;
type Log = { sesi: number; hapus: number; daftar: number; buka: unknown[] };
async function pasang(page: Page, o: { sesi: () => Jawab; daftar?: () => Jawab; buka?: () => Jawab; hapus?: () => Jawab }) {
    const log: Log = { sesi: 0, hapus: 0, daftar: 0, buka: [] };
    await page.route((u) => u.pathname === "/api/auth/accurate-session", (r: Route) => {
        if (r.request().method() === "DELETE") { log.hapus++; return r.fulfill(o.hapus ? o.hapus() : json({ ok: true })); }
        log.sesi++; return r.fulfill(o.sesi());
    });
    await page.route((u) => u.pathname === "/api/auth/db-list", (r) => { log.daftar++; return r.fulfill(o.daftar ? o.daftar() : json(DAFTAR)); });
    await page.route((u) => u.pathname === "/api/auth/open-db", (r) => {
        log.buka.push(r.request().postDataJSON());
        return r.fulfill(o.buka ? o.buka() : json({ s: true, host: "https://contoh.accurate.id", session: "sesi-uji" }));
    });
    return log;
}
const kartu = (page: Page) => page.locator("main").getByRole("region", { name: "Sesi Accurate" });

/**
 * Klik "Masuk Accurate" memanggil route login ASLI (cookie state disetel), tetapi redirect ke Accurate diganti halaman tiruan.
 * Mengembalikan daftar permintaan ke *.accurate.id (harus kosong) dan URL authorize yang akan dituju.
 */
async function tanpaAccurate(page: Page) {
    const keAccurate: string[] = [];
    const lokasi: string[] = [];
    page.on("request", (r) => { if (/(^|\.)accurate\.id$/.test(new URL(r.url()).hostname)) keAccurate.push(r.url()); });
    await page.route((u) => u.pathname === "/api/auth/accurate-login", async (r) => {
        const res = await r.fetch({ maxRedirects: 0 });
        lokasi.push(res.headers()["location"] ?? "");
        await r.fulfill({ status: 200, headers: { "content-type": "text/html", "set-cookie": res.headers()["set-cookie"] ?? "" }, body: "<h1>Accurate tiruan</h1>" });
    });
    return { keAccurate, lokasi };
}

test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test.describe("kartu (LOCAL_AUTH_BYPASS)", () => {
    test.skip(AKUN_NYATA, "mode akun nyata: blok ini butuh bypass lokal");

    test("belum masuk: tombol Masuk = route login ber-returnTo daftar putih; Kembali hanya untuk returnTo sah; tautan di menu profil", async ({ page }) => {
        await pasang(page, { sesi: () => json(BELUM) });
        await page.goto("/sesi-accurate?returnTo=/pelunasan", { timeout: 90_000 });
        const k = kartu(page);
        await expect(k).toContainText("Belum masuk ke Accurate");
        await expect(k.getByRole("link", { name: "Masuk Accurate" })).toHaveAttribute("href", "/api/auth/accurate-login?returnTo=%2Fpelunasan");
        await expect(page.getByRole("link", { name: "Kembali ke Pelunasan" })).toHaveAttribute("href", "/pelunasan");
        await expect(k.getByRole("button", { name: "Keluar dari Accurate" })).toHaveCount(0);
        await page.screenshot({ path: "test-results/fiori-sesi-accurate-belum.png", fullPage: true });

        await page.goto("/sesi-accurate?returnTo=https://evil.example/x", { timeout: 90_000 });
        await expect(kartu(page).getByRole("link", { name: "Masuk Accurate" })).toHaveAttribute("href", "/api/auth/accurate-login?returnTo=%2Fsesi-accurate");
        await expect(page.getByRole("link", { name: /Kembali ke/ })).toHaveCount(0);

        await page.getByRole("button", { name: /Menu profil/ }).click();
        await expect(page.getByRole("dialog", { name: "Menu profil" }).getByRole("link", { name: /Sesi Accurate/ })).toHaveAttribute("href", "/sesi-accurate");
        await page.setViewportSize({ width: 390, height: 844 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });

    test("masuk tanpa database: pilih wajib, Buka mengirim id+alias, lalu Database aktif dari sesi terbaca ulang", async ({ page }) => {
        let sesi = TANPA_DB;
        const log = await pasang(page, { sesi: () => json(sesi) });
        await page.goto("/sesi-accurate", { timeout: 90_000 });
        const k = kartu(page);
        await expect(k).toContainText("Database belum dibuka");
        const pilih = k.getByLabel("Database Accurate");
        await expect(pilih.locator("option")).toHaveText(["Pilih database", "PT CONTOH", "PT CONTOH DUA"]);
        await k.getByRole("button", { name: "Buka database" }).click();
        await expect(k.getByRole("alert")).toContainText("Pilih database dulu.");
        expect(log.buka).toHaveLength(0);
        sesi = AKTIF;
        await pilih.selectOption("77");
        await k.getByRole("button", { name: "Buka database" }).click();
        await expect(k).toContainText("Database terbuka.");
        await expect(k).toContainText("Database aktif");
        await expect(k).toContainText("PT CONTOH (id 77)");
        await expect(k).toContainText("https://contoh.accurate.id");
        expect(log.buka).toEqual([{ id: "77", alias: "PT CONTOH" }]);
        await page.screenshot({ path: "test-results/fiori-sesi-accurate-aktif.png", fullPage: true });
    });

    test("database aktif → Keluar menghapus sesi; Keluar gagal = pesan galat, bukan 'sudah keluar'", async ({ page }) => {
        let sesi = AKTIF;
        let hapus = json({ ok: false, error: "x" }, 500);
        const log = await pasang(page, { sesi: () => json(sesi), hapus: () => hapus });
        await page.goto("/sesi-accurate", { timeout: 90_000 });
        const k = kartu(page);
        await expect(k).toContainText("PT CONTOH (id 77)");
        await k.getByRole("button", { name: "Keluar dari Accurate" }).click();
        await expect(k.getByRole("alert")).toContainText("Keluar gagal; sesi Accurate mungkin masih aktif.");
        await expect(k).not.toContainText("sudah keluar");
        hapus = json({ ok: true });
        sesi = BELUM;
        await k.getByRole("button", { name: "Keluar dari Accurate" }).click();
        await expect(k).toContainText("Anda sudah keluar dari Accurate.");
        await expect(k).toContainText("Belum masuk ke Accurate");
        expect(log.hapus).toBe(2);
    });

    test("galat: sesi tak terbaca ≠ belum masuk; daftar database gagal ≠ daftar kosong; Coba lagi memuat ulang", async ({ page }) => {
        let sesi = json({ ok: false, error: "Internal" }, 500);
        let daftar = json({ error: "Failed" }, 502);
        await pasang(page, { sesi: () => sesi, daftar: () => daftar });
        await page.goto("/sesi-accurate", { timeout: 90_000 });
        const k = kartu(page);
        await expect(k.getByRole("alert")).toContainText("Sesi Accurate tidak terbaca.");
        await expect(k).not.toContainText("Belum masuk ke Accurate");
        await expect(k.getByRole("link", { name: "Masuk Accurate" })).toHaveCount(0);
        sesi = json(TANPA_DB);
        await k.getByRole("button", { name: "Coba lagi" }).click();
        await expect(k.getByRole("alert")).toContainText("Daftar database tidak terbaca.");
        await expect(k.getByLabel("Database Accurate")).toHaveCount(0);
        daftar = json(DAFTAR);
        await k.getByRole("button", { name: "Coba lagi" }).click();
        await expect(k.getByLabel("Database Accurate")).toBeVisible();
    });

    test("kabar callback: kode dipetakan ke kalimat tetap, teks query tidak tampil, URL dibersihkan (returnTo tetap)", async ({ page }) => {
        await pasang(page, { sesi: () => json(BELUM) });
        const kasus: Array<[string, RegExp]> = [
            ["state_beda", /tidak dikenali/], ["state_hilang", /kedaluwarsa/], ["tanpa_kode", /tidak memberi kode izin/],
            ["konfigurasi", /belum lengkap\. Hubungi IT/], ["tukar_token_gagal", /menolak penukaran kode izin/], ["galat_server", /Server gagal menyelesaikan/],
        ];
        for (const [kode, teks] of kasus) {
            await page.goto(`/sesi-accurate?accurate=error&alasan=${kode}&returnTo=/antrean-faktur`, { timeout: 90_000 });
            const strip = kartu(page).getByRole("alert");
            await expect(strip).toContainText("Masuk Accurate gagal.");
            await expect(strip).toContainText(teks);
            await expect(page).toHaveURL(/\/sesi-accurate\?returnTo=%2Fantrean-faktur$/);
        }
        await page.goto("/sesi-accurate?accurate=error&alasan=%3Cb%3Eteks%20bebas%3C%2Fb%3E", { timeout: 90_000 });
        await expect(kartu(page).getByRole("alert")).toContainText("Masuk Accurate gagal.");
        await expect(page.locator("main")).not.toContainText("teks bebas");
        await page.goto("/sesi-accurate?accurate=connected", { timeout: 90_000 });
        await expect(kartu(page).getByRole("status").filter({ hasText: "Masuk Accurate berhasil." })).toBeVisible();
        await expect(page).toHaveURL(/\/sesi-accurate$/);
    });

    test("Konsol: kartu yang sama (Masuk ke Konsol, kabar galat terbaca); Eksekusi terkunci sampai database aktif", async ({ page }) => {
        let sesi = BELUM;
        await pasang(page, { sesi: () => json(sesi) });
        await page.goto("/api-wrapper?accurate=error&alasan=tukar_token_gagal", { timeout: 90_000 });
        const k = kartu(page);
        await expect(k.getByRole("alert")).toContainText("Accurate menolak penukaran kode izin.");
        await expect(k.getByRole("link", { name: "Masuk Accurate" })).toHaveAttribute("href", "/api/auth/accurate-login?returnTo=%2Fapi-wrapper");
        await expect(page.getByRole("button", { name: "Eksekusi Endpoint" })).toBeDisabled();
        await expect(page).toHaveURL(/\/api-wrapper$/);
        sesi = AKTIF;
        await page.reload();
        await expect(kartu(page)).toContainText("PT CONTOH (id 77)");
        await expect(page.getByRole("button", { name: "Eksekusi Endpoint" })).toBeEnabled();
        await page.screenshot({ path: "test-results/fiori-sesi-accurate-konsol.png", fullPage: true });
    });

    test("route login: 307 ke authorize Accurate ber-state, scope tidak berubah; cookie httpOnly+Secure+Lax 10 menit hanya ke callback", async ({ page, context }) => {
        const res = await page.request.get("/api/auth/accurate-login?returnTo=/pelunasan", { maxRedirects: 0 });
        expect(res.status()).toBe(307);
        const u = new URL(res.headers()["location"]);
        expect(`${u.origin}${u.pathname}`).toBe("https://account.accurate.id/oauth/authorize");
        expect(u.searchParams.get("state")?.length ?? 0).toBeGreaterThanOrEqual(40);
        expect(u.searchParams.get("scope")).toContain("sales_receipt_save");
        const setCookie = res.headers()["set-cookie"];
        for (const attr of [/HttpOnly/i, /Secure/i, /SameSite=lax/i, /Max-Age=600/i, /Path=\/api\/auth\/callback/i]) expect(setCookie).toMatch(attr);

        // Peramban sungguhan: klik Masuk → route login asli → halaman Accurate tiruan; cookie Secure tersimpan di http://localhost dan httpOnly.
        const jaga = await tanpaAccurate(page);
        await pasang(page, { sesi: () => json(BELUM) });
        await page.goto("/sesi-accurate", { timeout: 90_000 });
        await kartu(page).getByRole("link", { name: "Masuk Accurate" }).click();
        await expect(page.getByRole("heading", { name: "Accurate tiruan" })).toBeVisible();
        const state = new URL(jaga.lokasi[0]).searchParams.get("state");
        expect(state?.length ?? 0).toBeGreaterThanOrEqual(40);
        const c = (await context.cookies("http://localhost:3021/api/auth/callback")).find((x) => x.name === "accurate_oauth_state");
        expect(c?.httpOnly).toBe(true);
        expect(c?.secure).toBe(true);
        expect(decodeURIComponent(c?.value ?? "")).toBe(`${state}:/sesi-accurate`);
        expect(await page.evaluate(() => document.cookie)).not.toContain("accurate_oauth_state");
        expect(jaga.keAccurate).toEqual([]);
    });
});

/** Masuk aplikasi lewat Better Auth (akun dari env "email:sandi"). */
async function masuk(page: Page, env: string | undefined) {
    const [email, ...rest] = (env ?? "").split(":");
    const res = await page.request.post("/api/auth/sign-in/email", { headers: { Origin: "http://localhost:3021" }, data: { email, password: rest.join(":") } });
    expect(res.status(), "masuk aplikasi").toBe(200);
}

test.describe("akun nyata (tanpa bypass)", () => {
    test.skip(!AKUN_NYATA, "set PW_SESI_FAKTURIST, PW_SESI_TANPA_KUNCI, PW_SESI_KONSOL (server tanpa LOCAL_AUTH_BYPASS)");

    test("Fakturist (order.edit, tanpa api_wrapper.view): buka /sesi-accurate + menu profil; callback state salah/hilang ditolak berkode", async ({ page }) => {
        await masuk(page, process.env.PW_SESI_FAKTURIST);
        await pasang(page, { sesi: () => json(BELUM) });
        await page.goto("/sesi-accurate", { timeout: 90_000 });
        await expect(kartu(page)).toContainText("Belum masuk ke Accurate");
        await page.getByRole("button", { name: /Menu profil/ }).click();
        await expect(page.getByRole("dialog", { name: "Menu profil" }).getByRole("link", { name: /Sesi Accurate/ })).toBeVisible();
        await page.screenshot({ path: "test-results/fiori-sesi-accurate-fakturist.png", fullPage: true });

        // Mulai masuk sungguhan (cookie state), lalu Accurate "kembali" dengan state lain → ditolak sebelum code ditukar.
        const jaga = await tanpaAccurate(page);
        await page.goto("/sesi-accurate?returnTo=/antrean-faktur", { timeout: 90_000 });
        await kartu(page).getByRole("link", { name: "Masuk Accurate" }).click();
        await expect(page.getByRole("heading", { name: "Accurate tiruan" })).toBeVisible();
        await page.goto("/api/auth/callback?code=KODE-UJI&state=state-palsu", { timeout: 90_000 });
        await expect(page).toHaveURL(/\/sesi-accurate\?returnTo=%2Fantrean-faktur$/);
        await expect(kartu(page).getByRole("alert")).toContainText("tidak dikenali");
        await expect(page.getByRole("link", { name: "Kembali ke Antrean Faktur" })).toBeVisible();
        // Cookie sudah dihapus callback → percobaan ulang = state hilang.
        await page.goto("/api/auth/callback?code=KODE-UJI&state=state-palsu", { timeout: 90_000 });
        await expect(kartu(page).getByRole("alert")).toContainText("kedaluwarsa");
        expect(jaga.keAccurate).toEqual([]);
    });

    // S7-sesi: dulu matcher proxy.ts `(?!api|…)` melewatkan `/api-wrapper` → tanpa x-current-path layout menilai "/" (dashboard.view)
    // dan Konsol terbuka untuk siapa saja. Kini gerbang halaman Konsol berlaku (lib/proxy-matcher.test.ts).
    test("Fakturist tanpa api_wrapper.view: Konsol /api-wrapper ditolak", async ({ page }) => {
        await masuk(page, process.env.PW_SESI_FAKTURIST);
        await pasang(page, { sesi: () => json(BELUM) });
        await page.goto("/api-wrapper", { timeout: 90_000 });
        await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
        await expect(kartu(page)).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Eksekusi Endpoint" })).toHaveCount(0);

        // Peninjau OAuth #1: tombol Kembali ke tujuan terlarang tidak tampil; navigasi KLIEN (layout server tidak berjalan ulang)
        // dari halaman yang diizinkan ke Konsol tetap Akses ditolak (gerbang klien SidebarLayout), lalu kembali normal.
        await page.goto("/sesi-accurate?returnTo=/api-wrapper", { timeout: 90_000 });
        await expect(kartu(page)).toContainText("Belum masuk ke Accurate");
        await expect(page.getByRole("link", { name: /Kembali ke/ })).toHaveCount(0);
        await page.evaluate(() => (window as unknown as { next: { router: { push: (h: string) => void } } }).next.router.push("/api-wrapper"));
        await expect(page).toHaveURL(/\/api-wrapper$/);
        await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Eksekusi Endpoint" })).toHaveCount(0);
        await page.evaluate(() => (window as unknown as { next: { router: { push: (h: string) => void } } }).next.router.push("/sesi-accurate"));
        await expect(kartu(page)).toBeVisible();
        await expect(page.getByRole("heading", { name: "Akses ditolak" })).toHaveCount(0);
    });

    test("pemegang api_wrapper.view: Konsol terbuka dengan kartu Sesi Accurate", async ({ page }) => {
        await masuk(page, process.env.PW_SESI_KONSOL);
        await pasang(page, { sesi: () => json(AKTIF) });
        await page.goto("/api-wrapper", { timeout: 90_000 });
        await expect(kartu(page)).toContainText("PT CONTOH (id 77)");
        await expect(page.getByRole("button", { name: "Eksekusi Endpoint" })).toBeEnabled();
    });

    test("tanpa kunci apa pun: /sesi-accurate ditolak dan menu profil tanpa Sesi Accurate", async ({ page }) => {
        await masuk(page, process.env.PW_SESI_TANPA_KUNCI);
        await pasang(page, { sesi: () => json(BELUM) });
        await page.goto("/sesi-accurate", { timeout: 90_000 });
        await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
        await expect(kartu(page)).toHaveCount(0);
        await page.getByRole("button", { name: /Menu profil/ }).click();
        const menu = page.getByRole("dialog", { name: "Menu profil" });
        await expect(menu.getByRole("button", { name: /Keluar/ })).toBeVisible();
        await expect(menu.getByRole("link", { name: /Sesi Accurate/ })).toHaveCount(0);
    });
});
