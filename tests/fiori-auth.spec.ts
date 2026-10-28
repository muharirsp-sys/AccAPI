/*
 * Tujuan: Perilaku halaman masuk dan sandi Fiori (S7c): satu kerangka, ?error= dipetakan, lupa sandi netral, atur ulang
 *   tanpa token / sandi tidak sama, galat masuk generik.
 * Caller: Playwright (`npx playwright test tests/fiori-auth.spec.ts --workers=1`) terhadap `next dev` dengan
 *   LOCAL_AUTH_BYPASS MATI (bypass mengalihkan /login ke /; uji melewati diri bila itu terjadi).
 * Dependensi: Playwright; halaman app/(auth)/*. Semua panggilan Better Auth (`/api/auth/**`) dimock — tanpa DB/SMTP/Accurate.
 * Main Functions: uji per halaman.
 * Side Effects: Tidak ada di luar peramban uji.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

const kartu = (page: Page) => page.locator(".fi-auth-card");

async function buka(page: Page, url: string) {
    await page.goto(url);
    test.skip(!page.url().includes(url.split("?")[0]), "Butuh LOCAL_AUTH_BYPASS mati: proxy mengalihkan /login ke /.");
    await expect(kartu(page)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); // hidrasi + render selesai
}

/** Mock satu endpoint Better Auth; mengembalikan daftar request yang tertangkap. */
async function mockAuth(page: Page, path: string, status: number, json: unknown) {
    const tertangkap: Request[] = [];
    await page.route(`**/api/auth/${path}`, (route) => {
        tertangkap.push(route.request());
        return route.fulfill({ status, json });
    });
    return tertangkap;
}

test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    // Panggilan Better Auth yang tidak diatur uji = 500, supaya tidak ada yang diam-diam sukses atau keluar ke server nyata.
    await page.route("**/api/auth/**", (route) => route.fulfill({ status: 500, json: { message: "tidak dimock" } }));
});

/** Kontras terendah teks panel merek (li, small) terhadap latarnya, memperhitungkan opacity. */
function kontrasPanel(page: Page) {
    return page.locator(".fi-auth-brand").evaluate((brand) => {
        const rgb = (s: string) => s.match(/[\d.]+/g)!.map(Number);
        const lum = (c: number[]) => {
            const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
        };
        const latar = rgb(getComputedStyle(brand).backgroundColor);
        return Math.min(...[...brand.querySelectorAll("li, small")].map((el) => {
            const cs = getComputedStyle(el);
            const [r, g, b, a = 1] = rgb(cs.color);
            const op = Number(cs.opacity) * a;
            const [l1, l2] = [lum([r, g, b].map((v, i) => v * op + latar[i] * (1 - op))), lum(latar)].sort((x, y) => y - x);
            return (l1 + 0.05) / (l2 + 0.05);
        }));
    });
}

test("satu kerangka: panel merek + kartu berlogo di keempat halaman; judul tab; ponsel tanpa panel merek dan tanpa gulir menyamping", async ({ page }) => {
    for (const [url, judul] of [["/login", "Masuk"], ["/forgot-password", "Lupa sandi"], ["/reset-password?token=t", "Atur ulang sandi"], ["/register", "Pendaftaran ditutup"]]) {
        await page.setViewportSize({ width: 1280, height: 800 });
        await buka(page, url);
        await expect(page).toHaveTitle(judul);
        await expect(page.locator(".fi-auth-brand")).toBeVisible();
        await expect(kartu(page).getByRole("img", { name: "CV. Surya Perkasa" })).toBeVisible();
        await page.setViewportSize({ width: 360, height: 760 });
        await expect(page.locator(".fi-auth-brand")).toBeHidden();
        await expect(kartu(page).getByRole("img", { name: "CV. Surya Perkasa" })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${url} menggulir menyamping`).toBe(true);
    }
    // Tema gelap mengikuti sistem: permukaan kartu berganti.
    await page.setViewportSize({ width: 1280, height: 800 });
    const latar = () => kartu(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    const terang = await latar();
    expect(await kontrasPanel(page)).toBeGreaterThanOrEqual(4.5);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(latar).not.toBe(terang);
    expect(await kontrasPanel(page), "kontras teks panel merek di tema gelap").toBeGreaterThanOrEqual(4.5);
});

test("?error= dikenal: kalimat Indonesia, teks mentah query tidak tampil", async ({ page }) => {
    await buka(page, "/login?error=Accurate+login+requires+app+session");
    await expect(kartu(page).getByRole("status")).toContainText("Accurate belum terhubung");
    await expect(page.locator(".fi-auth")).not.toContainText("requires app session");
});

test("?error= tak dikenal: kalimat umum, tanpa injeksi HTML", async ({ page }) => {
    for (const mentah of [`<img src=x onerror="window.__xss=1">Klik di sini`, "constructor", "toString"]) {
        await buka(page, `/login?error=${encodeURIComponent(mentah)}`);
        await expect(kartu(page).getByRole("status")).toContainText("Proses sebelumnya tidak selesai");
        await expect(page.locator(".fi-auth img")).toHaveCount(0);
        const html = await page.locator(".fi-auth").innerHTML();
        expect(html).not.toContain("onerror");
        expect(html).not.toContain(mentah === "toString" ? "toString" : mentah.slice(0, 11));
        expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
    }
});

test("masuk: isian kosong ditolak di klien dan fokus ke isian pertama yang salah", async ({ page }) => {
    const masuk = await mockAuth(page, "sign-in/email", 200, {});
    await buka(page, "/login");
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    await expect(kartu(page)).toContainText("Email wajib diisi.");
    await expect(kartu(page)).toContainText("Kata sandi wajib diisi.");
    await expect(page.getByLabel("Email")).toBeFocused();
    expect(masuk).toHaveLength(0);
});

test("masuk: galat generik tanpa teks server; 403 belum diverifikasi; 429 terlalu banyak percobaan; fokus ke galat", async ({ page }) => {
    const kasus = [
        [401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password RAHASIA-SERVER" }, "Email atau kata sandi salah."],
        [403, { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" }, "Email belum diverifikasi."],
        [429, { message: "Too many requests. Please try again later." }, "Terlalu banyak percobaan masuk."],
    ] as const;
    for (const [status, json, kalimat] of kasus) {
        await page.unrouteAll({ behavior: "wait" });
        await page.route("**/api/auth/**", (route) => route.fulfill({ status: 500, json: {} }));
        await mockAuth(page, "sign-in/email", status, json);
        await buka(page, "/login");
        await page.getByLabel("Email").fill("andi@contoh.test");
        await page.getByLabel("Kata sandi", { exact: true }).fill("salah-sekali");
        await page.getByRole("button", { name: "Masuk", exact: true }).click();
        const galat = kartu(page).getByRole("alert");
        await expect(galat).toContainText(kalimat);
        await expect(page.locator(".fi-auth")).not.toContainText("RAHASIA-SERVER");
        await expect(page.locator(":focus")).toContainText(kalimat);
    }
});

test("masuk: sukses mengirim email + sandi lalu pindah ke Beranda", async ({ page }) => {
    const masuk = await mockAuth(page, "sign-in/email", 200, { redirect: false, token: "t", user: { id: "u1", email: "andi@contoh.test", name: "Andi" } });
    await page.route((url) => url.pathname === "/", (route) => route.fulfill({ contentType: "text/html", body: "<p>Beranda uji</p>" }));
    await buka(page, "/login");
    await page.getByLabel("Email").fill(" andi@contoh.test ");
    await page.getByLabel("Kata sandi", { exact: true }).fill("rahasia123");
    await page.getByRole("button", { name: "Tampilkan sandi" }).click();
    await expect(page.getByLabel("Kata sandi", { exact: true })).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Masuk", exact: true }).click();
    await expect(page.getByText("Beranda uji")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    expect(masuk).toHaveLength(1);
    expect(masuk[0].postDataJSON()).toMatchObject({ email: "andi@contoh.test", password: "rahasia123" });
});

test("lupa sandi: layar identik untuk semua jawaban server non-5xx, dengan kalimat jujur; fokus ke judul", async ({ page }) => {
    const layar: string[] = [];
    // Jawaban 2xx/4xx bisa berbeda per akun; layar tidak boleh berbeda (tidak membocorkan email terdaftar).
    for (const [email, status] of [["terdaftar@contoh.test", 200], ["tidak-ada@contoh.test", 400], ["lain@contoh.test", 429]] as const) {
        await page.unrouteAll({ behavior: "wait" });
        await page.route("**/api/auth/**", (route) => route.fulfill({ status: 500, json: {} }));
        const r = await mockAuth(page, "request-password-reset", status, status === 200 ? { status: true, message: "If this email exists..." } : { code: "USER_NOT_FOUND", message: "not found" });
        await buka(page, "/forgot-password");
        await page.getByLabel("Email").fill(email);
        await page.getByRole("button", { name: "Kirim tautan" }).click();
        await expect(kartu(page)).toContainText("Bila email terdaftar, tautan dikirim.");
        await expect(kartu(page)).toContainText("Tidak menerima email? Minta admin mengatur sandi Anda.");
        await expect(page.getByRole("heading", { level: 1, name: "Permintaan diterima" })).toBeFocused();
        expect(r).toHaveLength(1);
        const body = r[0].postDataJSON() as { email: string; redirectTo: string };
        expect(body.email).toBe(email);
        expect(body.redirectTo).toMatch(/\/reset-password$/);
        layar.push(await kartu(page).innerHTML()); // markup, bukan hanya teks: atribut tersembunyi pun tidak boleh berbeda
    }
    expect(layar[1]).toBe(layar[0]);
    expect(layar[2]).toBe(layar[0]);
    await expect(kartu(page)).not.toContainText("lain@contoh.test");
});

test("lupa sandi: jaringan putus atau 5xx → galat dan form tetap; coba lagi → layar netral", async ({ page }) => {
    for (const putus of [true, false]) {
        await page.unrouteAll({ behavior: "wait" });
        await page.route("**/api/auth/**", (route) => route.fulfill({ status: 500, json: {} }));
        await page.route("**/api/auth/request-password-reset", (route) =>
            putus ? route.abort("failed") : route.fulfill({ status: 503, json: { message: "RAHASIA-SERVER" } }));
        await buka(page, "/forgot-password");
        await page.getByLabel("Email").fill("andi@contoh.test");
        await page.getByRole("button", { name: "Kirim tautan" }).click();
        await expect(kartu(page).getByRole("alert")).toContainText("Server tidak dapat dihubungi");
        await expect(page.locator(":focus")).toContainText("Server tidak dapat dihubungi");
        await expect(kartu(page)).not.toContainText("Permintaan diterima");
        await expect(kartu(page)).not.toContainText("RAHASIA-SERVER");
        await expect(page.getByLabel("Email")).toHaveValue("andi@contoh.test");
    }
    await mockAuth(page, "request-password-reset", 200, { status: true });
    await page.getByRole("button", { name: "Kirim tautan" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Permintaan diterima" })).toBeFocused();
    await expect(kartu(page).getByRole("alert")).toHaveCount(0);
});

test("atur ulang tanpa token atau token tak berlaku: pesan + Minta tautan baru, bukan tombol mati", async ({ page }) => {
    for (const url of ["/reset-password", "/reset-password?error=INVALID_TOKEN", "/reset-password?token=t&error=INVALID_TOKEN"]) {
        await buka(page, url);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tautan tidak berlaku");
        await expect(page.getByLabel("Sandi baru")).toHaveCount(0);
        await expect(kartu(page).getByRole("link", { name: "Minta tautan baru" })).toHaveAttribute("href", "/forgot-password");
    }
    await kartu(page).getByRole("link", { name: "Minta tautan baru" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
});

test("atur ulang: sandi pendek atau tidak sama mengunci Simpan; sama → tersimpan; token ditolak server → tautan tidak berlaku", async ({ page }) => {
    const simpan = await mockAuth(page, "reset-password", 200, { status: true });
    await buka(page, "/reset-password?token=TOKEN-UJI");
    const tombol = page.getByRole("button", { name: "Simpan sandi" });
    const baru = page.getByLabel("Sandi baru", { exact: true });
    const ulang = page.getByLabel("Ketik ulang sandi baru");
    // Alasan tombol nonaktif terlihat sebagai teks dan menjadi deskripsi tombol.
    await expect(tombol).toBeDisabled();
    await expect(kartu(page)).toContainText("Simpan aktif setelah sandi baru cukup panjang.");
    await expect(tombol).toHaveAccessibleDescription("Simpan aktif setelah sandi baru cukup panjang.");
    // Galat tidak muncul sejak karakter pertama: bantuan saja sampai isian ditinggalkan, lalu galat MENGGANTIKAN bantuan.
    await baru.fill("r");
    await expect(kartu(page)).toContainText("Minimal 6 karakter.");
    await expect(kartu(page)).not.toContainText("Sandi minimal 6 karakter.");
    await baru.blur();
    await expect(kartu(page)).toContainText("Sandi minimal 6 karakter.");
    await expect(kartu(page)).not.toContainText("Minimal 6 karakter.");
    await baru.fill("rahasia123");
    await expect(kartu(page)).not.toContainText("Sandi minimal 6 karakter.");
    await ulang.fill("rahasia12");
    await expect(kartu(page)).not.toContainText("Belum sama dengan sandi baru.");
    await expect(tombol).toBeDisabled();
    await expect(tombol).toHaveAccessibleDescription("Simpan aktif setelah ketik ulang sama dengan sandi baru.");
    await ulang.blur();
    await expect(kartu(page)).toContainText("Belum sama dengan sandi baru.");
    await ulang.fill("rahasia123");
    await expect(kartu(page)).not.toContainText("Belum sama dengan sandi baru.");
    await expect(tombol).toBeEnabled();
    await expect(kartu(page)).not.toContainText("Simpan aktif setelah");
    await tombol.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sandi tersimpan");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(kartu(page).getByRole("link", { name: "Masuk" })).toHaveAttribute("href", "/login");
    expect(simpan).toHaveLength(1);
    expect(simpan[0].postDataJSON()).toMatchObject({ token: "TOKEN-UJI", newPassword: "rahasia123" });

    await page.unrouteAll({ behavior: "wait" });
    await page.route("**/api/auth/**", (route) => route.fulfill({ status: 500, json: {} }));
    await mockAuth(page, "reset-password", 400, { code: "INVALID_TOKEN", message: "Invalid token" });
    await buka(page, "/reset-password?token=KEDALUWARSA");
    await page.getByLabel("Sandi baru", { exact: true }).fill("rahasia123");
    await page.getByLabel("Ketik ulang sandi baru").fill("rahasia123");
    await page.getByRole("button", { name: "Simpan sandi" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tautan tidak berlaku");
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(kartu(page).getByRole("link", { name: "Minta tautan baru" })).toBeVisible();
});

test("pendaftaran: halaman statis ditutup di kerangka yang sama", async ({ page }) => {
    await buka(page, "/register");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pendaftaran ditutup");
    await expect(kartu(page)).toContainText("Akun dibuat admin");
    await expect(kartu(page).getByRole("link", { name: "Kembali ke halaman masuk" })).toHaveAttribute("href", "/login");
    await expect(kartu(page).locator("input")).toHaveCount(0);
});
