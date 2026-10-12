/*
 * Tujuan: Fiori S7a — User & Akses Group (FCL) di atas kontrak S7-1: buat user (grup awal wajib, sandi bertopeng ketik dua kali —
 *   tidak muncul di DOM/URL), atur sandi, nonaktif (alasan; akun sendiri dicegah), bintang + peringatan role WAJIB (§4), keluarkan →
 *   GRUP_TERAKHIR (dicegah di layar + jawaban server), simpan izin = dialog SELISIH (+/−, anggota terkena; mencabut users.manage =
 *   peringatan + tombol tegas, TANPA isian alasan karena server tidak mencatatnya), ADMIN_TERAKHIR → kalimat dari `code`, users.view =
 *   baca-saja beralasan terbaca, users.manage saja lolos gerbang halaman (anyOf), galat ≠ kosong, jawaban tidak pasti (putus) =
 *   "belum pasti" + muat ulang, riwayat berkursor, ponsel 390 px, tanpa dialog native.
 *   O2: bagian "Karyawan Accurate (salesman)" — tautan sekarang + cabang + status, cari karyawan, yang sudah tertaut ke akun lain ditandai,
 *   tautkan/lepas lewat dialog (PUT/DELETE), kode galat O1 -> kalimat, users.view baca-saja, galat ≠ kosong, jawaban tidak pasti, riwayat.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin, aktor "local-dev-admin"):
 *   `npx playwright test tests/fiori-admin-user-grup.spec.ts --config <config lokal port 3026> --workers=1`.
 * Dependensi: semua /api/admin/** di-mock page.route per docs/handover/S7-KONTRAK-ADMIN-API.md (tidak menyentuh DB/Better Auth).
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const NAV = { timeout: 90_000 } as const;
// Dokumen yang dijawab page.route (tanpaIzin) tidak punya ruang alamat lokal; tanpa ini Edge memblokir skrip localhost.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] } });
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
type Jawab = ReturnType<typeof json> | "putus";
type Tulis = { method: string; path: string; body: Record<string, unknown> | null };

const G = {
    admin: { id: "g-admin", name: "Admin", isPreset: true },
    fin: { id: "g-fin", name: "Finance", isPreset: true },
    promo: { id: "g-promo", name: "Promo A", isPreset: false },
    promo2: { id: "g-promo2", name: "Promo C", isPreset: false },
};
const user = (id: string, name: string, role: string, groups: Array<{ id: string; name: string; isPreset: boolean; isPrimary: boolean }>, banned = false, alasan = "Pindah ke CABANG A") => {
    const utama = groups.find((g) => g.isPrimary) ?? (groups.length === 1 ? groups[0] : null);
    return {
        id, name, email: `${name.toLowerCase().replace(" ", ".")}@contoh.test`, role, permissions: "{}", emailVerified: true, banned, banReason: banned ? alasan : null,
        groups, primaryGroupId: utama?.id ?? null, primaryGroupName: utama?.name ?? null, groupId: utama?.id ?? null, groupName: utama?.name ?? null,
    };
};
const USERS = [
    user("u-a", "USER A", "admin", [{ ...G.admin, isPrimary: true }, { ...G.fin, isPrimary: false }]),
    user("u-b", "USER B", "finance", [{ ...G.fin, isPrimary: true }]),
    user("u-c", "USER C", "viewer", [{ ...G.promo, isPrimary: true }], true),
    user("local-dev-admin", "ADMIN LOKAL", "admin", [{ ...G.admin, isPrimary: true }]),
    user("u-d", "USER D", "viewer", [], true), // nonaktif & tanpa grup (akses role lama) — aktivasi harus menambah grup dulu
    user("u-f", "USER F", "viewer", [{ ...G.fin, isPrimary: true }], true, "sedang disiapkan (S7-1)"), // pembuatan gagal sebagian (kontrak USER_SETENGAH_JADI): IT Support menghapusnya
    user("u-e", "USER E", "viewer", [{ ...G.promo2, isPrimary: true }, { ...G.admin, isPrimary: false }]), // Promo C berbintang + Admin: hapus Promo C -> utama Admin -> role admin
];
const GROUPS = [
    { id: "g-admin", name: "Admin", description: "Semua izin", isPreset: true, permCount: 3, memberCount: 2 },
    { id: "g-fin", name: "Finance", description: "Transfer dan pembayaran", isPreset: true, permCount: 3, memberCount: 2 },
    { id: "g-promo", name: "Promo A", description: "", isPreset: false, permCount: 2, memberCount: 1 },
    { id: "g-promo2", name: "Promo C", description: "", isPreset: false, permCount: 1, memberCount: 1 },
];
const DETAIL: Record<string, unknown> = {
    "g-fin": { group: { id: "g-fin", name: "Finance", description: "Transfer dan pembayaran", isPreset: true }, permissions: ["finance.view", "finance.approve", "payments.view"],
        members: [{ userId: "u-a", userName: "USER A", userEmail: "user.a@contoh.test", isPrimary: false }, { userId: "u-b", userName: "USER B", userEmail: "user.b@contoh.test", isPrimary: true }] },
    "g-promo": { group: { id: "g-promo", name: "Promo A", description: "", isPreset: false }, permissions: ["users.view", "users.manage"],
        members: [{ userId: "u-c", userName: "USER C", userEmail: "user.c@contoh.test", isPrimary: true }] },
    "g-admin": { group: { id: "g-admin", name: "Admin", description: "Semua izin", isPreset: true }, permissions: ["users.view", "users.manage", "dashboard.view"],
        members: [{ userId: "u-a", userName: "USER A", userEmail: "user.a@contoh.test", isPrimary: true }, { userId: "u-e", userName: "USER E", userEmail: "user.e@contoh.test", isPrimary: false }] },
    "g-promo2": { group: { id: "g-promo2", name: "Promo C", description: "", isPreset: false }, permissions: ["dashboard.view"],
        members: [{ userId: "u-e", userName: "USER E", userEmail: "user.e@contoh.test", isPrimary: true }] },
};
const RIWAYAT_1 = { ok: true, nextCursor: "kursor-1", items: [
    { id: "h1", action: "user_group.assign", actorName: "ADMIN LOKAL", targetUserName: "USER A", targetGroupName: "Finance", detail: { groupName: "Finance" }, createdAt: "2026-10-11T02:30:00.000Z" },
] };
const RIWAYAT_2 = { ok: true, nextCursor: null, items: [
    { id: "h0", action: "user.create", actorName: "ADMIN LOKAL", targetUserName: "USER A", targetGroupName: "Admin", detail: { groupNames: ["Admin"] }, createdAt: "2026-10-01T01:00:00.000Z" },
] };

// ------------------------------------------------------------------ O2: tautan salesman (kontrak O1 §3)
const TAUTAN_LAMA = { salesCode: "S-OLD", salesName: "SALES LAMA", employeeId: 3, employeeName: "SALES LAMA", branchId: 50, branchName: "CABANG A", salesman: true, suspended: false, aktif: true };
const PILIHAN = [
    { id: 1, number: "M-SLA", name: "SALES A", branchId: 50, branchName: "CABANG A", terhubungKe: null },
    { id: 2, number: "M-SLB", name: "SALES B", branchId: 50, branchName: "CABANG A", terhubungKe: { userId: "u-c", name: "USER C", email: "user.c@contoh.test" } },
    { id: 3, number: "S-OLD", name: "SALES LAMA", branchId: 50, branchName: "CABANG A", terhubungKe: { userId: "u-b", name: "USER B", email: "user.b@contoh.test" } },
    { id: 4, number: "M-SLC", name: "SALES C", branchId: 90, branchName: "CABANG B", terhubungKe: null },
];
const salesmanGet = (tautan: unknown[]) => json({ ok: true, tautan, pilihan: PILIHAN });

type Opsi = {
    /** GET /api/admin/users/[id]/salesman (id user, urutan panggilan). Bawaan: tidak ada tautan. */
    salesman?: (id: string, n: number) => Jawab | undefined;
    riwayat?: Jawab;
    users?: (n: number) => Jawab | undefined;
    groups?: (n: number) => Jawab | undefined;
    detail?: (id: string, n: number) => Jawab | undefined;
    tulis?: (t: Tulis) => Jawab | undefined;
};

function bawaan({ method, path, body }: Tulis): Jawab {
    if (path === "/api/admin/users" && method === "POST") return json({ ok: true, user: { id: "u-baru", name: body?.name, email: body?.email, role: "finance", groupIds: body?.groupIds, primaryGroupId: "g-fin" } }, 201);
    if (path.endsWith("/password")) return json({ ok: true, sessionsRevoked: 2 });
    if (path.endsWith("/status")) return json({ ok: true, changed: true, active: body?.active, sessionsRevoked: body?.active ? 0 : 1 });
    if (path.endsWith("/primary-group")) return json({ ok: true, changed: true, primaryGroupId: method === "PUT" ? body?.groupId : null, role: method === "PUT" ? "finance" : "viewer", roleChanged: true });
    if (path.endsWith("/salesman")) return json(method === "PUT" ? { ok: true, changed: true, tautan: { salesCode: body?.employeeNumber, employeeName: "SALES A", employeeId: 1, branchId: 50, branchName: "CABANG A" } } : { ok: true, changed: true });
    if (path.endsWith("/members")) return json(method === "POST" ? { ok: true, added: true, primaryGroupId: "g-fin", role: "finance" } : { ok: true, primaryGroupId: null, role: "viewer" });
    if (path === "/api/admin/groups" && method === "POST") return json({ ok: true, group: { id: "g-baru", name: body?.name, description: body?.description, isPreset: false } }, 201);
    return json({ ok: true });
}

async function pasang(page: Page, o: Opsi = {}) {
    const log = { get: [] as string[], tulis: [] as Tulis[], urls: [] as string[], native: 0 };
    const n: Record<string, number> = {};
    const hit = (k: string) => (n[k] = (n[k] ?? 0) + 1);
    page.on("dialog", (d) => { log.native++; void d.dismiss(); });
    page.on("request", (r) => log.urls.push(r.url()));
    await page.route((u) => u.pathname.startsWith("/api/admin/"), async (route: Route) => {
        const req = route.request();
        const url = new URL(req.url());
        const p = url.pathname;
        let r: Jawab | undefined;
        if (req.method() === "GET") {
            log.get.push(p + url.search);
            if (p === "/api/admin/users/permissions") r = o.users?.(hit("users")) ?? json({ users: USERS });
            else if (p === "/api/admin/groups") r = o.groups?.(hit("groups")) ?? json({ groups: GROUPS });
            else if (p.endsWith("/history")) r = o.riwayat ?? json(url.searchParams.get("cursor") ? RIWAYAT_2 : RIWAYAT_1);
            else if (p.endsWith("/salesman")) { const id = p.split("/")[4]; r = o.salesman?.(id, hit(`s-${id}`)) ?? salesmanGet([]); }
            else {
                const id = p.split("/")[4];
                r = o.detail?.(id, hit(`d-${id}`)) ?? (DETAIL[id] ? json(DETAIL[id]) : json({ error: "Group tidak ditemukan" }, 404));
            }
        } else {
            const t = { method: req.method(), path: p, body: req.postData() ? JSON.parse(req.postData()!) as Record<string, unknown> : null };
            log.tulis.push(t);
            r = o.tulis?.(t) ?? bawaan(t);
        }
        return r === "putus" ? route.abort("connectionreset") : route.fulfill(r);
    });
    return { log, n };
}

/**
 * Cabut satu kunci izin di payload RSC halaman (hanya di tes): kunci diganti nama (`users.manage` -> `users.manage_tes`) di semua
 * potongan payload — larik permKeys bisa terbelah di antara potongan `__next_f.push`, jadi tidak disaring per larik.
 * Dokumen yang dijawab page.route tidak punya ruang alamat lokal: Edge memblokir skrip localhost (Local Network Access) dan
 * halaman tidak pernah terhidrasi — berkas ini berjalan dengan fitur itu dimatikan (test.use di atas).
 */
async function tanpaIzin(page: Page, path: string, kunci: string) {
    await page.route((u) => u.pathname === path, async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        const body = (await res.text()).replaceAll(`\\"${kunci}\\"`, `\\"${kunci}_tes\\"`);
        return route.fulfill({ status: res.status(), headers, body });
    });
}

/**
 * Izin yang BISA dicabut di tengah sesi: dokumen dan permintaan RSC (router.refresh) halaman `path` diteruskan apa adanya sampai
 * `dicabut = true`, sesudahnya kunci diganti nama di keduanya (HTML: `\"kunci\"`, aliran RSC: `"kunci"`). `refresh` = jumlah permintaan RSC.
 */
async function izinBisaDicabut(page: Page, path: string, kunci: string) {
    const s = { dicabut: false, refresh: 0 };
    await page.route((u) => u.pathname === path, async (route) => {
        if (route.request().headers()["rsc"] === "1") s.refresh++;
        const res = await route.fetch();
        if (!s.dicabut) return route.fulfill({ response: res });
        const headers = { ...res.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        const body = (await res.text()).replaceAll(`\\"${kunci}\\"`, `\\"${kunci}_tes\\"`).replaceAll(`"${kunci}"`, `"${kunci}_tes"`);
        return route.fulfill({ status: res.status(), headers, body });
    });
    return s;
}

const daftarUser = (page: Page) => page.getByRole("list", { name: "Daftar user" });
async function bukaUser(page: Page, nama: string) {
    await daftarUser(page).getByRole("button", { name: new RegExp(`${nama}\\b`) }).click();
    await expect(page.getByRole("heading", { level: 1, name: nama })).toBeVisible();
}

test("Buat user: grup awal wajib, sandi bertopeng ketik dua kali (tidak di DOM/URL), satu permintaan atomik, user baru terpilih", async ({ page }) => {
    const SANDI = "Rahasia-S7a-91";
    let dibuat = false; // dev StrictMode memuat dua kali saat mount: pakai penanda, bukan hitungan
    const { log } = await pasang(page, {
        users: () => (dibuat ? json({ users: [...USERS, user("u-baru", "USER BARU", "finance", [{ ...G.fin, isPrimary: true }])] }) : undefined),
        tulis: (t) => { if (t.path === "/api/admin/users") dibuat = true; return undefined; },
    });
    await page.goto("/admin/users", NAV);
    await expect(daftarUser(page).getByRole("button", { name: /USER A\b/ })).toBeVisible();
    await page.getByRole("button", { name: "Buat user…" }).click();
    const dlg = page.getByRole("dialog", { name: "Buat user" });
    const buat = dlg.getByRole("button", { name: "Buat user" });
    await dlg.getByRole("textbox", { name: "Nama", exact: true }).fill("USER BARU");
    await dlg.getByLabel("Email").fill("user.baru@contoh.test");
    await expect(buat).toBeDisabled();
    await expect(dlg).toContainText("Pilih minimal satu grup awal");
    await dlg.getByRole("checkbox", { name: "Finance" }).check();
    await expect(dlg).toContainText("Isi sandi sementara");
    const s1 = dlg.getByLabel("Sandi sementara"), s2 = dlg.getByLabel("Ketik ulang sandi");
    await expect(s1).toHaveAttribute("type", "password");
    await expect(s2).toHaveAttribute("type", "password");
    await s1.fill("pendek");
    await s2.fill("pendeX");
    await expect(dlg).toContainText("Belum sama dengan sandi");
    await expect(buat).toBeDisabled();
    await s1.fill(SANDI);
    await s2.fill(SANDI);
    await expect(buat).toBeEnabled();
    expect(await page.content()).not.toContain(SANDI); // kolom tak terkendali: nilai tidak tersinkron ke atribut DOM
    await page.screenshot({ path: "test-results/fiori-s7a-01-buat-user.png", fullPage: true });
    await buat.click();
    await expect(page.getByRole("status").filter({ hasText: "USER BARU dibuat dengan grup Finance" })).toBeVisible();
    expect(log.tulis).toEqual([{ method: "POST", path: "/api/admin/users", body: { name: "USER BARU", email: "user.baru@contoh.test", password: SANDI, groupIds: ["g-fin"] } }]);
    await expect(page.getByRole("heading", { level: 1, name: "USER BARU" })).toBeVisible();
    expect(await page.content()).not.toContain(SANDI);
    expect(log.urls.filter((u) => u.includes(SANDI))).toEqual([]);
    expect(page.url()).not.toContain(SANDI);
    expect(log.native).toBe(0);
});

test("Atur sandi: dialog bertopeng, sesi diakhiri; akun sendiri diperingatkan; sandi tidak pernah di DOM", async ({ page }) => {
    const SANDI = "Sementara-77";
    const { log } = await pasang(page);
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    await page.getByRole("button", { name: "Atur sandi sementara…" }).click();
    const dlg = page.getByRole("dialog", { name: "Atur sandi sementara untuk USER B" });
    await expect(dlg).toContainText("Semua sesi user ini diakhiri");
    await dlg.getByLabel("Sandi sementara").fill(SANDI);
    await expect(dlg.getByRole("button", { name: "Simpan sandi" })).toBeDisabled();
    await expect(dlg).toContainText("Ketik ulang sandi");
    await dlg.getByLabel("Ketik ulang sandi").fill(SANDI);
    expect(await page.content()).not.toContain(SANDI);
    await dlg.getByRole("button", { name: "Simpan sandi" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sandi USER B diatur; 2 sesi diakhiri" })).toBeVisible();
    expect(log.tulis).toEqual([{ method: "POST", path: "/api/admin/users/u-b/password", body: { password: SANDI } }]);
    expect(await page.content()).not.toContain(SANDI);
    // Akun sendiri: peringatan sesi ikut diakhiri.
    await bukaUser(page, "ADMIN LOKAL");
    await page.getByRole("button", { name: "Atur sandi sementara…" }).click();
    await expect(page.getByRole("dialog", { name: "Atur sandi sementara untuk ADMIN LOKAL" })).toContainText("Sesi Anda juga diakhiri");
    expect(log.native).toBe(0);
});

test("Nonaktifkan: alasan opsional terkirim, sesi diakhiri; akun sendiri dicegah; ADMIN_TERAKHIR = kalimat dari code", async ({ page }) => {
    const { log } = await pasang(page, {
        tulis: (t) => (t.path === "/api/admin/users/u-a/status" ? json({ ok: false, code: "ADMIN_TERAKHIR", error: "teks server mentah" }, 409) : undefined),
    });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    await page.getByRole("button", { name: "Nonaktifkan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Nonaktifkan USER B?" });
    await expect(dlg).toContainText("User tidak dihapus");
    await dlg.getByLabel("Alasan (opsional)").fill("Pindah ke CABANG A");
    await dlg.getByRole("button", { name: "Nonaktifkan" }).click();
    await expect(page.getByRole("status").filter({ hasText: "USER B dinonaktifkan; 1 sesi diakhiri" })).toBeVisible();
    expect(log.tulis[0]).toEqual({ method: "POST", path: "/api/admin/users/u-b/status", body: { active: false, reason: "Pindah ke CABANG A" } });

    await bukaUser(page, "ADMIN LOKAL");
    await page.getByRole("button", { name: "Nonaktifkan…" }).click();
    const diri = page.getByRole("dialog", { name: "Nonaktifkan ADMIN LOKAL?" });
    await expect(diri.getByRole("button", { name: "Nonaktifkan" })).toBeDisabled();
    await expect(diri).toContainText("Anda tidak bisa menonaktifkan akun sendiri");
    await diri.getByRole("button", { name: "Batal" }).click();

    await bukaUser(page, "USER A");
    await page.getByRole("button", { name: "Nonaktifkan…" }).click();
    const a = page.getByRole("dialog", { name: "Nonaktifkan USER A?" });
    await a.getByRole("button", { name: "Nonaktifkan" }).click();
    await expect(a.getByRole("alert")).toContainText("Minimal satu admin aktif harus tersisa");
    await expect(a).not.toContainText("teks server mentah");
    await page.screenshot({ path: "test-results/fiori-s7a-02-admin-terakhir.png", fullPage: true });
    expect(log.tulis.map((t) => t.path)).toEqual(["/api/admin/users/u-b/status", "/api/admin/users/u-a/status"]);
    expect(log.native).toBe(0);
});

test("Bintang: lepas bintang Admin memperingatkan role → viewer (kontrak §4); jadikan utama; riwayat berkursor", async ({ page }) => {
    const { log } = await pasang(page);
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER A");
    const riwayat = page.getByRole("list", { name: "Riwayat" });
    await expect(riwayat).toContainText("Ditambahkan ke grup");
    await expect(riwayat).toContainText("Finance");
    await page.getByRole("button", { name: "Muat riwayat lebih lama" }).click();
    await expect(riwayat).toContainText("User dibuat");
    await expect(page.getByRole("button", { name: "Muat riwayat lebih lama" })).toHaveCount(0);
    expect([...new Set(log.get.filter((g) => g.includes("/history")))]).toEqual(["/api/admin/users/u-a/history?limit=20", "/api/admin/users/u-a/history?limit=20&cursor=kursor-1"]);

    await page.getByRole("button", { name: "Lepas bintang Admin" }).click();
    const dlg = page.getByRole("dialog", { name: "Lepas bintang Admin dari USER A?" });
    await expect(dlg).toContainText("Role identitas lama akan menjadi viewer");
    await expect(dlg).toContainText("ACCURATE_SYNC_USER_ID");
    await expect(dlg).toContainText("admin → viewer");
    await page.screenshot({ path: "test-results/fiori-s7a-03-lepas-bintang.png", fullPage: true });
    await dlg.getByRole("button", { name: "Lepas bintang" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Role identitas kini viewer" })).toBeVisible();

    await page.getByRole("button", { name: "Jadikan Finance grup utama" }).click();
    const jd = page.getByRole("dialog", { name: "Jadikan Finance grup utama USER A?" });
    await expect(jd).toContainText("Role identitas lama akan menjadi finance");
    await jd.getByRole("button", { name: "Jadikan utama" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Grup utama USER A: Finance" })).toBeVisible();
    expect(log.tulis).toEqual([
        { method: "DELETE", path: "/api/admin/users/u-a/primary-group", body: null },
        { method: "PUT", path: "/api/admin/users/u-a/primary-group", body: { groupId: "g-fin" } },
    ]);
});

test("Keluarkan: grup terakhir dicegah di layar; data usang → server GRUP_TERAKHIR dipetakan ke kalimat + tindakan", async ({ page }) => {
    const { log } = await pasang(page, {
        tulis: (t) => (t.path.endsWith("/members") && t.method === "DELETE"
            ? json({ ok: false, code: "GRUP_TERAKHIR", error: "x", users: [{ id: "u-a", name: "USER A" }] }, 409) : undefined),
    });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    await page.getByRole("button", { name: "Keluarkan dari Finance" }).click();
    const dlg = page.getByRole("dialog", { name: "Keluarkan USER B dari Finance?" });
    await expect(dlg.getByRole("button", { name: "Keluarkan" })).toBeDisabled();
    await expect(dlg).toContainText("USER B hanya punya grup ini. User tidak boleh tanpa grup");
    await dlg.getByRole("button", { name: "Batal" }).click();

    await page.goto("/admin/groups", NAV);
    await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bFinance\b/ }).click();
    await page.getByRole("button", { name: "Keluarkan USER A" }).click();
    const k = page.getByRole("dialog", { name: "Keluarkan USER A dari Finance?" });
    await expect(k).toContainText("Admin"); // grup tersisa
    await k.getByRole("button", { name: "Keluarkan" }).click();
    await expect(k.getByRole("alert")).toContainText("Ditolak: USER A hanya punya grup ini");
    await expect(k.getByRole("alert")).toContainText("Nonaktifkan");
    expect(log.tulis).toEqual([{ method: "DELETE", path: "/api/admin/groups/g-fin/members", body: { userId: "u-a" } }]);
    expect(log.native).toBe(0);
});

test("Simpan izin: dialog SELISIH (+/−, anggota terkena) → PATCH kunci persis; cabut users.manage = peringatan + tombol tegas tanpa isian alasan; KUNCI_TIDAK_VALID", async ({ page }) => {
    let patchKe = 0;
    const { log } = await pasang(page, {
        tulis: (t) => (t.method === "PATCH" && ++patchKe === 2 ? json({ ok: false, code: "KUNCI_TIDAK_VALID", error: "x", invalid: ["finance.reopen"] }, 400) : undefined),
    });
    await page.goto("/admin/groups", NAV);
    await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bFinance\b/ }).click();
    const simpan = page.getByRole("button", { name: "Simpan izin…" });
    await expect(simpan).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Nama grup" })).toBeDisabled(); // preset: nama terkunci
    await expect(page.getByRole("button", { name: "Hapus grup…" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Payments · Hapus" }).check();
    await page.getByRole("checkbox", { name: "Finance · Approve" }).uncheck();
    await expect(page.getByText("+1 −1 belum disimpan")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-s7a-04-draf-izin.png", fullPage: true });
    await simpan.click();
    const dlg = page.getByRole("dialog", { name: "Simpan izin grup Finance?" });
    await expect(dlg.getByRole("list", { name: "Izin ditambah" })).toContainText("+ Payments · Hapus");
    await expect(dlg.getByRole("list", { name: "Izin dicabut" })).toContainText("− Finance · Approve");
    await expect(dlg).toContainText("2 anggota: USER A, USER B");
    await dlg.getByRole("button", { name: "Simpan izin" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Grup Finance tersimpan: 1 ditambah, 1 dicabut; tercatat di riwayat" })).toBeVisible();
    expect(log.tulis[0].method).toBe("PATCH");
    expect(log.tulis[0].path).toBe("/api/admin/groups/g-fin");
    expect((log.tulis[0].body?.permissions as string[]).sort()).toEqual(["finance.view", "payments.delete", "payments.view"]);

    // Grup custom: cabut users.manage = peringatan + tombol tegas, TANPA isian alasan (server tidak mencatatnya, jadi tidak boleh
    // diwajibkan); server menolak kunci tak dikenal -> kalimat jelas, draf tetap.
    await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bPromo A\b/ }).click();
    await page.getByRole("checkbox", { name: "Users & RBAC · Manage" }).uncheck();
    await page.getByRole("button", { name: "Simpan izin…" }).click();
    const d2 = page.getByRole("dialog", { name: "Simpan izin grup Promo A?" });
    await expect(d2).toContainText("Mencabut Kelola user (users.manage)");
    await expect(d2).toContainText("bukan alasannya");
    await expect(d2.getByRole("textbox")).toHaveCount(0);
    await expect(d2.getByRole("button", { name: "Simpan izin", exact: true })).toHaveCount(0); // tombol biasa diganti yang tegas
    await d2.getByRole("button", { name: "Simpan dan cabut Kelola user" }).click();
    await expect(d2.getByRole("alert")).toContainText("kunci izin tidak dikenal (finance.reopen)");
    await expect(page.getByText("+0 −1 belum disimpan")).toBeVisible();
    expect(Object.keys(log.tulis[1].body ?? {})).toEqual(["permissions"]); // tidak ada field alasan yang dikirim/dibuang server
    expect(log.native).toBe(0);
});

test("Grup preset Admin: Users · Manage terkunci; centang modul tidak mencabutnya", async ({ page }) => {
    await pasang(page);
    await page.goto("/admin/groups", NAV);
    await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bAdmin\b/ }).click();
    await expect(page.getByRole("checkbox", { name: "Users & RBAC · Manage" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Semua izin Users & RBAC" }).click(); // nyalakan semua
    await page.getByRole("checkbox", { name: "Semua izin Users & RBAC" }).click(); // cabut semua
    await expect(page.getByRole("checkbox", { name: "Users & RBAC · Manage" })).toBeChecked();
});

test("Gerbang halaman: pemegang users.manage SAJA (tanpa users.view) tetap masuk /admin/users lewat navigasi klien; menu User & RBAC muncul", async ({ page }) => {
    // Kunci users.view dicabut dari payload dokumen /admin/groups (kunci SidebarLayout di peramban); users.manage tetap ada.
    await tanpaIzin(page, "/admin/groups", "users.view");
    await pasang(page);
    await page.goto("/admin/groups", NAV);
    await expect(page.getByRole("list", { name: "Daftar grup" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Menu ruang kerja" }).getByRole("link", { name: "User & RBAC" })).toBeVisible();
    // Navigasi klien: layout server TIDAK dijalankan ulang; gerbang klien SidebarLayout menilai /admin/users dengan kunci yang sama.
    await page.locator("main").getByRole("link", { name: "User", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole("heading", { level: 1, name: "User" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toHaveCount(0);
    await expect(daftarUser(page).getByRole("button", { name: /USER A/ })).toBeVisible();
});

test("users.view: semua baca-saja dengan alasan terbaca; daftar grup tidak diminta; tidak ada tulisan", async ({ page }) => {
    await tanpaIzin(page, "/admin/users", "users.manage");
    const { log } = await pasang(page);
    await page.goto("/admin/users", NAV);
    await expect(page.getByRole("status").filter({ hasText: "Baca-saja." })).toContainText("users.view");
    await expect(page.getByRole("button", { name: "Buat user…" })).toBeDisabled();
    await bukaUser(page, "USER A");
    await expect(page.getByRole("button", { name: "Atur sandi sementara…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Nonaktifkan…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Keluarkan dari Finance" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Lepas bintang Admin" })).toBeDisabled();
    await expect(page.getByText("Terkunci: Baca-saja: butuh izin Kelola user (users.manage).").first()).toBeVisible();
    await expect(page.getByRole("list", { name: "Riwayat" })).toContainText("Ditambahkan ke grup"); // baca tetap jalan
    await page.screenshot({ path: "test-results/fiori-s7a-05-baca-saja.png", fullPage: true });
    expect(log.get.filter((g) => g.startsWith("/api/admin/groups"))).toEqual([]);
    expect(log.tulis).toEqual([]);
});

test("Galat ≠ kosong: daftar user 403/putus tampil sebagai galat beralasan; Coba lagi memuat; tulis terkunci saat memuat", async ({ page }) => {
    let mode: "403" | "putus" | "ok" = "403";
    await pasang(page, { users: () => (mode === "403" ? json({ error: "Forbidden" }, 403) : mode === "putus" ? "putus" : undefined) });
    await page.goto("/admin/users", NAV);
    const galat = page.getByRole("alert").filter({ hasText: "Daftar user gagal dimuat" });
    await expect(galat).toContainText("tidak berizin");
    await expect(page.getByText("Belum ada user")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Buat user…" })).toBeDisabled();
    mode = "putus";
    await galat.getByRole("button", { name: "Coba lagi" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Daftar user gagal dimuat" })).toContainText("Server tidak menjawab dengan jelas");
    mode = "ok";
    await page.getByRole("alert").getByRole("button", { name: "Coba lagi" }).click();
    await expect(daftarUser(page).getByRole("button", { name: /USER A\b/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Buat user…" })).toBeEnabled();
});

test("Jawaban tidak pasti (putus) = 'hasilnya belum pasti' + muat ulang; detail grup galat ≠ kosong", async ({ page }) => {
    const { log } = await pasang(page, {
        tulis: (t) => (t.path.endsWith("/status") ? "putus" : undefined),
        detail: (id) => (id === "g-promo" ? json({ ok: false, code: "GAGAL_SIMPAN" }, 503) : undefined),
    });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    const sebelum = log.get.filter((g) => g === "/api/admin/users/permissions").length;
    await page.getByRole("button", { name: "Nonaktifkan…" }).click();
    await page.getByRole("dialog", { name: "Nonaktifkan USER B?" }).getByRole("button", { name: "Nonaktifkan" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Hasilnya belum pasti" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => log.get.filter((g) => g === "/api/admin/users/permissions").length).toBeGreaterThan(sebelum);
    await page.screenshot({ path: "test-results/fiori-s7a-06-belum-pasti.png", fullPage: true });

    await page.goto("/admin/groups", NAV);
    await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bPromo A\b/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Detail grup gagal dimuat" })).toBeVisible();
    await expect(page.getByText("Belum ada anggota")).toHaveCount(0);
});

test("Aktifkan user nonaktif; user tanpa grup: aktivasi dicegah, Tambah ke grup memperingatkan role (viewer → admin)", async ({ page }) => {
    const { log } = await pasang(page);
    await page.goto("/admin/users", NAV);
    await expect(daftarUser(page).getByRole("button", { name: /USER A/ })).toBeVisible();
    await expect(daftarUser(page).getByRole("button", { name: /USER C/ })).toHaveCount(0); // saringan bawaan = Aktif
    await page.getByRole("group", { name: "Status akun" }).getByRole("button", { name: /^Nonaktif/ }).click();
    await expect(daftarUser(page).getByRole("button", { name: /USER D/ })).toContainText("Tanpa grup");
    await bukaUser(page, "USER C");
    await page.getByRole("button", { name: "Aktifkan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Aktifkan USER C?" });
    await expect(dlg).toContainText("Bisa masuk lagi dengan sandi terakhirnya");
    await dlg.getByRole("button", { name: "Aktifkan", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "USER C diaktifkan." })).toBeVisible();
    expect(log.tulis).toEqual([{ method: "POST", path: "/api/admin/users/u-c/status", body: { active: true } }]);

    await bukaUser(page, "USER D");
    await expect(page.getByText("Belum punya grup.")).toBeVisible();
    await page.getByRole("button", { name: "Aktifkan…" }).click();
    const d = page.getByRole("dialog", { name: "Aktifkan USER D?" });
    await expect(d.getByRole("button", { name: "Aktifkan", exact: true })).toBeDisabled();
    await expect(d).toContainText("Tambahkan USER D ke grup dulu");
    await d.getByRole("button", { name: "Batal" }).click();

    await page.getByRole("combobox", { name: "Tambah ke grup" }).selectOption({ label: "Admin (preset)" });
    await expect(page.getByText("Role identitas lama akan menjadi admin (sekarang viewer).")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-s7a-09-tanpa-grup.png", fullPage: true });
    await page.getByRole("button", { name: "Tambah ke grup", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "USER D ditambahkan ke Admin" })).toBeVisible();
    expect(log.tulis[1]).toEqual({ method: "POST", path: "/api/admin/groups/g-admin/members", body: { userId: "u-d" } });
    expect(log.native).toBe(0);
});

test("Akses Group: riwayat grup, tambah anggota, draf dibuang lewat dialog, hapus dicegah di layar, grup baru, hapus ditolak server (GRUP_TERAKHIR) lalu berhasil", async ({ page }) => {
    let baru = false, hapusKe = 0;
    const { log } = await pasang(page, {
        groups: () => (baru ? json({ groups: [...GROUPS, { id: "g-baru", name: "Promo B", description: "", isPreset: false, permCount: 0, memberCount: 0 }] }) : undefined),
        detail: (id) => (id === "g-baru" ? json({ group: { id: "g-baru", name: "Promo B", description: "", isPreset: false }, permissions: [], members: [] }) : undefined),
        tulis: (t) => {
            if (t.path === "/api/admin/groups" && t.method === "POST") baru = true;
            if (t.method === "DELETE" && t.path === "/api/admin/groups/g-baru" && ++hapusKe === 1) return json({ ok: false, code: "GRUP_TERAKHIR", error: "x", users: [{ id: "u-x", name: "USER X" }] }, 409);
            return undefined;
        },
    });
    await page.goto("/admin/groups", NAV);
    const grupList = page.getByRole("list", { name: "Daftar grup" });
    await grupList.getByRole("button", { name: /\bFinance\b/ }).click();
    await expect(page.getByRole("list", { name: "Riwayat" })).toContainText("USER A"); // sudut grup menyebut user

    await page.getByRole("combobox", { name: "Tambah anggota" }).selectOption({ label: "USER D (user.d@contoh.test)" });
    await page.getByRole("button", { name: "Tambah anggota", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "USER D ditambahkan ke Finance" })).toBeVisible();

    // Draf izin tidak dibuang diam-diam: pindah grup lewat dialog (Batal menahan draf, Buang membuangnya).
    await page.getByRole("checkbox", { name: "Payments · Hapus" }).check();
    await expect(page.getByText("+1 −0 belum disimpan")).toBeVisible();
    await grupList.getByRole("button", { name: /\bPromo A\b/ }).click();
    const buang = page.getByRole("dialog", { name: "Buang perubahan pada grup Finance?" });
    await buang.getByRole("button", { name: "Batal", exact: true }).click();
    await expect(page.getByText("+1 −0 belum disimpan")).toBeVisible();
    await grupList.getByRole("button", { name: /\bPromo A\b/ }).click();
    await buang.getByRole("button", { name: "Buang perubahan" }).click();
    await expect(page.getByText(/\+\d+ −\d+ belum disimpan/)).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Users & RBAC · Manage" })).toBeChecked();

    // Hapus dicegah di layar: USER C hanya punya grup Promo A.
    await page.getByRole("button", { name: "Hapus grup…" }).click();
    const cegah = page.getByRole("dialog", { name: "Hapus grup Promo A?" });
    await expect(cegah.getByRole("button", { name: "Hapus grup" })).toBeDisabled();
    await expect(cegah).toContainText("Ditolak: USER C hanya punya grup ini");
    await cegah.getByRole("button", { name: "Batal", exact: true }).click();

    // Grup baru -> terpilih; hapus: server menolak (data usang) -> kalimat + tindakan; ulangi -> berhasil.
    await page.getByRole("button", { name: "Grup baru…" }).click();
    const gb = page.getByRole("dialog", { name: "Grup baru" });
    await expect(gb.getByRole("button", { name: "Buat grup" })).toBeDisabled();
    await gb.getByRole("textbox", { name: "Nama grup" }).fill("Promo B");
    await gb.getByRole("button", { name: "Buat grup" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Grup Promo B dibuat tanpa izin dan anggota" })).toBeVisible();
    await expect(page.getByText("Grup ini belum punya izin.")).toBeVisible();
    await page.getByRole("button", { name: "Hapus grup…" }).click();
    const hp = page.getByRole("dialog", { name: "Hapus grup Promo B?" });
    await hp.getByRole("button", { name: "Hapus grup" }).click();
    await expect(hp.getByRole("alert")).toContainText("Ditolak: USER X hanya punya grup ini");
    await expect(hp.getByRole("alert")).toContainText("Nonaktifkan");
    await hp.getByRole("button", { name: "Hapus grup" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Grup Promo B dihapus." })).toBeVisible();
    await expect(page.getByText("Pilih grup di daftar")).toBeVisible();
    expect(log.tulis).toEqual([
        { method: "POST", path: "/api/admin/groups/g-fin/members", body: { userId: "u-d" } },
        { method: "POST", path: "/api/admin/groups", body: { name: "Promo B", description: "" } },
        { method: "DELETE", path: "/api/admin/groups/g-baru", body: null },
        { method: "DELETE", path: "/api/admin/groups/g-baru", body: null },
    ]);
    expect(log.native).toBe(0);
});

for (const [nama, jawaban] of [
    ["IZIN_BERUBAH (403 berkode)", json({ ok: false, code: "IZIN_BERUBAH", error: "x" }, 403)],
    ["403 tanpa kode (gerbang requirePermission)", json({ error: "Forbidden" }, 403)],
] as const) {
    test(`${nama}: izin disegarkan lewat router.refresh (permintaan RSC) + data dimuat ulang; tombol tulis mengikuti izin baru`, async ({ page }) => {
        const izin = await izinBisaDicabut(page, "/admin/users", "users.manage");
        const { log } = await pasang(page, { tulis: (t) => (t.path.endsWith("/status") ? jawaban : undefined) });
        await page.goto("/admin/users", NAV);
        await bukaUser(page, "USER B");
        await expect(page.getByRole("button", { name: "Buat user…" })).toBeEnabled();
        await expect(page.getByRole("status").filter({ hasText: "Baca-saja." })).toHaveCount(0);
        const rscSebelum = izin.refresh, daftarSebelum = log.get.filter((g) => g === "/api/admin/users/permissions").length;
        izin.dicabut = true; // admin lain mencabut users.manage Anda sesudah halaman dimuat
        await page.getByRole("button", { name: "Nonaktifkan…" }).click();
        await page.getByRole("dialog", { name: "Nonaktifkan USER B?" }).getByRole("button", { name: "Nonaktifkan" }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect.poll(() => izin.refresh, "router.refresh: permintaan RSC ke halaman").toBeGreaterThan(rscSebelum);
        await expect.poll(() => log.get.filter((g) => g === "/api/admin/users/permissions").length, "data dimuat ulang").toBeGreaterThan(daftarSebelum);
        await expect(page.getByRole("status").filter({ hasText: "Baca-saja." })).toContainText("users.view"); // izin layout baru terbaca
        await expect(page.getByRole("button", { name: "Buat user…" })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Atur sandi sementara…" })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Nonaktifkan…" })).toBeDisabled();
        expect(log.tulis.map((t) => t.path)).toEqual(["/api/admin/users/u-b/status"]); // tidak ada tulisan ulang otomatis
    });
}

test("Tambah anggota di Akses Group: perkiraan role + peringatan sebelum klik (user tanpa grup -> preset Admin = role admin); tanpa perubahan = tanpa peringatan", async ({ page }) => {
    const { log } = await pasang(page);
    await page.goto("/admin/groups", NAV);
    await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bAdmin\b/ }).click();
    const pilih = page.getByRole("combobox", { name: "Tambah anggota" });
    await pilih.selectOption({ label: "USER B (user.b@contoh.test)" }); // USER B: 1 grup (Finance) -> utama tetap Finance, role tidak berubah
    await expect(page.getByText(/Role identitas lama akan menjadi/)).toHaveCount(0);
    await pilih.selectOption({ label: "USER D (user.d@contoh.test)" }); // USER D: tanpa grup, role viewer -> Admin menjadi utama -> role admin
    await expect(page.getByText("Role identitas lama akan menjadi admin (sekarang viewer).")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-s7a-11-tambah-anggota-role.png", fullPage: true });
    await page.getByRole("button", { name: "Tambah anggota", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "USER D ditambahkan ke Admin" })).toBeVisible();
    expect(log.tulis).toEqual([{ method: "POST", path: "/api/admin/groups/g-admin/members", body: { userId: "u-d" } }]);
});

test("Hapus grup: dialog memperkirakan role identitas tiap anggota yang berubah ([Promo C★, Admin] -> admin) sebelum konfirmasi", async ({ page }) => {
    await pasang(page);
    await page.goto("/admin/groups", NAV);
    await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bPromo C\b/ }).click();
    await page.getByRole("button", { name: "Hapus grup…" }).click();
    const dlg = page.getByRole("dialog", { name: "Hapus grup Promo C?" });
    await expect(dlg.getByRole("button", { name: "Hapus grup" })).toBeEnabled(); // USER E masih punya grup Admin
    await expect(dlg).toContainText("USER E: viewer → admin");
    await expect(dlg).toContainText("Role identitas lama berubah");
    await page.screenshot({ path: "test-results/fiori-s7a-12-hapus-grup-role.png", fullPage: true });
    await expect(dlg.getByRole("list", { name: "Role identitas berubah" })).toHaveCount(1);
    await dlg.getByRole("button", { name: "Batal", exact: true }).click();
});

test("Kunci usang (ada di DB, tak ada di registry): tidak tampil tetapi diumumkan; dialog selisih mencantumkan 'dibuang'; PATCH tanpa kunci itu (server menolak KUNCI_TIDAK_VALID bila ikut)", async ({ page }) => {
    const USANG = "finance.reopen_lama";
    const fin = DETAIL["g-fin"] as { permissions: string[] };
    const { log } = await pasang(page, {
        detail: (id) => (id === "g-fin" ? json({ ...fin, permissions: [...fin.permissions, USANG] }) : undefined),
        tulis: (t) => (t.method === "PATCH" && (t.body?.permissions as string[] | undefined)?.includes(USANG)
            ? json({ ok: false, code: "KUNCI_TIDAK_VALID", error: "x", invalid: [USANG] }, 400) : undefined),
    });
    await page.goto("/admin/groups", NAV);
    await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bFinance\b/ }).click();
    await expect(page.getByRole("status").filter({ hasText: /memuat 1 kunci usang/ })).toContainText(USANG);
    await expect(page.getByRole("button", { name: "Simpan izin…" })).toBeDisabled(); // kunci usang saja bukan draf
    await page.getByRole("checkbox", { name: "Payments · Hapus" }).check();
    await page.getByRole("button", { name: "Simpan izin…" }).click();
    const dlg = page.getByRole("dialog", { name: "Simpan izin grup Finance?" });
    await expect(dlg.getByRole("list", { name: "Kunci usang dibuang" })).toContainText(USANG);
    await expect(dlg.getByRole("list", { name: "Izin ditambah" })).toContainText("+ Payments · Hapus");
    await expect(dlg).toContainText("tercatat dicabut");
    await dlg.getByRole("button", { name: "Simpan izin", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 kunci usang dibuang" })).toBeVisible();
    expect((log.tulis[0].body?.permissions as string[]).sort()).toEqual(["finance.approve", "finance.view", "payments.delete", "payments.view"]);
});

test("Draf izin: tautan dalam aplikasi (header, menu samping) tidak membuang draf diam-diam — dialog Buang perubahan; tautan hash tidak ditahan", async ({ page }) => {
    await pasang(page);
    await page.goto("/admin/groups", NAV);
    await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bFinance\b/ }).click();
    await page.getByRole("checkbox", { name: "Payments · Hapus" }).check();
    const dlg = page.getByRole("dialog", { name: "Buang perubahan pada grup Finance?" });
    await page.getByRole("link", { name: "Anggota", exact: true }).click(); // AnchorBar (#g-anggota) saat ADA draf: halaman sama, tidak ditahan
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/#g-anggota$/);

    await page.locator("main").getByRole("link", { name: "User", exact: true }).click(); // tautan header halaman
    await expect(dlg).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/groups(#g-anggota)?$/);
    await expect(dlg).toContainText("/admin/users");
    await dlg.getByRole("button", { name: "Batal", exact: true }).click();
    await expect(page.getByText("+1 −0 belum disimpan")).toBeVisible(); // draf utuh

    await page.getByRole("navigation", { name: "Menu ruang kerja" }).getByRole("link", { name: "User & RBAC" }).click(); // menu samping
    await expect(dlg).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/groups(#g-anggota)?$/);
    await dlg.getByRole("button", { name: "Buang perubahan" }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole("heading", { level: 1, name: "User" })).toBeVisible();
});

test("User 'Sedang disiapkan' (pembuatan gagal sebagian): tidak bisa diaktifkan, alasan terbaca — IT Support menghapusnya", async ({ page }) => {
    const { log } = await pasang(page);
    await page.goto("/admin/users", NAV);
    await page.getByRole("group", { name: "Status akun" }).getByRole("button", { name: /^Nonaktif/ }).click();
    await expect(daftarUser(page).getByRole("button", { name: /USER F/ })).toContainText("Sedang disiapkan");
    await bukaUser(page, "USER F");
    await expect(page.getByRole("button", { name: "Aktifkan…" })).toBeDisabled();
    const strip = page.getByRole("status").filter({ hasText: "belum selesai dibuat" });
    await expect(strip).toContainText("IT Support");
    await expect(strip).toContainText("u-f");
    await expect(page.getByText("Terkunci: User ini setengah jadi")).toBeVisible();
    await page.screenshot({ path: "test-results/fiori-s7a-13-sedang-disiapkan.png", fullPage: true });
    // USER C nonaktif biasa tetap bisa diaktifkan.
    await bukaUser(page, "USER C");
    await expect(page.getByRole("button", { name: "Aktifkan…" })).toBeEnabled();
    expect(log.tulis).toEqual([]);
});

for (const [lebar, tinggi] of [[390, 844], [1280, 800]] as const) {
    test(`Footer Akses Group keadaan Draf ${lebar} px: tombol utuh, tak bertumpuk, tombol final di kanan bawah`, async ({ page }) => {
        await page.setViewportSize({ width: lebar, height: tinggi });
        await pasang(page);
        await page.goto("/admin/groups", NAV);
        await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bFinance\b/ }).click();
        await page.getByRole("checkbox", { name: "Payments · Hapus" }).check();
        const footer = page.locator(".fi-ftb");
        const simpan = footer.getByRole("button", { name: "Simpan izin…" });
        const batal = footer.getByRole("button", { name: "Batal perubahan" });
        await expect(simpan).toBeVisible();
        await expect(batal).toBeVisible();
        await expect(footer.getByRole("button", { name: "Hapus grup…" })).toHaveCount(0); // aksi hapus di header objek, bukan di footer Draf
        // Label tidak meluap dari tombolnya (bug 390 px: "impan" menimpa "Batal perubahan").
        for (const tombol of [simpan, batal]) expect(await tombol.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        const f = (await footer.boundingBox())!, a = (await batal.boundingBox())!, b = (await simpan.boundingBox())!;
        const bertumpuk = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(bertumpuk, "Batal perubahan dan Simpan izin tidak boleh bertumpuk").toBe(false);
        // Aksi final di kanan bawah: tombol utama paling kanan, rapat ke tepi kanan footer, tidak turun ke kiri.
        expect(b.x).toBeGreaterThanOrEqual(a.x);
        expect(b.x + b.width).toBeGreaterThanOrEqual(f.x + f.width - 24);
        if (lebar >= 1000) expect(b.x, "di layar lebar tombol final tidak turun ke kiri").toBeGreaterThan(f.x + f.width / 2);
        expect(b.y + b.height).toBeLessThanOrEqual(tinggi);
        expect(b.y).toBeGreaterThan(tinggi / 2);
        if (lebar >= 1000) expect(Math.abs(a.y - b.y), "satu baris di layar lebar").toBeLessThan(8);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `test-results/fiori-s7a-10-footer-draf-${lebar}.png` });
    });
}

test("Ponsel 390 px: daftar ↔ detail tanpa gulir menyamping halaman", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await pasang(page);
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER A");
    await expect(page.getByRole("button", { name: "Kembali ke daftar" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/fiori-s7a-07-ponsel-user.png", fullPage: true });
    await page.goto("/admin/groups", NAV);
    await page.getByRole("list", { name: "Daftar grup" }).getByRole("button", { name: /\bFinance\b/ }).click();
    await expect(page.getByRole("checkbox", { name: "Payments · Hapus" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/fiori-s7a-08-ponsel-grup.png", fullPage: true });
});

// ---------------------------------------------------------------------------------------------- O2: Karyawan Accurate (salesman)

const bagianSalesman = (page: Page) => page.locator("#u-salesman");

test("Salesman Accurate: tautan sekarang + cabang + status; cari karyawan; yang tertaut ke akun lain ditandai dan tidak bisa dipilih; tautkan = PUT employeeNumber", async ({ page }) => {
    let tertaut = true;
    const { log, n } = await pasang(page, {
        salesman: (id) => (id === "u-b" ? salesmanGet(tertaut ? [TAUTAN_LAMA] : [{ ...TAUTAN_LAMA, salesCode: "M-SLA", salesName: "SALES A", employeeName: "SALES A", employeeId: 1 }]) : undefined),
        tulis: (t) => { if (t.path.endsWith("/salesman")) tertaut = false; return undefined; },
    });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    const b = bagianSalesman(page);
    await expect(b.getByText("SALES LAMA · S-OLD")).toBeVisible(NAV);
    await expect(b).toContainText("Cabang salesman");
    await expect(b).toContainText("CABANG A");
    await expect(b.getByText("Aktif", { exact: true })).toBeVisible();
    await expect(b).toContainText("Order Sales hanya untuk pelanggan dan barang cabang CABANG A");
    const daftar = b.getByRole("list", { name: "Karyawan salesman Accurate" });
    await expect(daftar.getByRole("listitem")).toHaveCount(4);
    // Sudah tertaut ke akun lain: ditandai, tidak bisa dipilih. Yang tertaut ke akun INI ditandai juga.
    const sudah = daftar.getByRole("listitem").filter({ hasText: "SALES B" });
    await expect(sudah).toContainText("Sudah ditautkan ke USER C");
    await expect(sudah.getByRole("button")).toHaveCount(0);
    await expect(daftar.getByRole("listitem").filter({ hasText: "SALES LAMA" })).toContainText("Tertaut ke akun ini");
    // Cari (nama / nomor / cabang).
    await b.getByLabel("Cari karyawan salesman").fill("cabang b");
    await expect(daftar.getByRole("listitem")).toHaveCount(1);
    await expect(daftar).toContainText("SALES C");
    await b.getByLabel("Cari karyawan salesman").fill("zzz");
    await expect(b.getByRole("heading", { name: "Tidak ada karyawan “zzz”" })).toBeVisible();
    await b.getByLabel("Cari karyawan salesman").fill("");
    await page.screenshot({ path: "test-results/fiori-o2-admin-salesman.png", fullPage: true });

    await daftar.getByRole("listitem").filter({ hasText: "SALES A" }).first().getByRole("button").click();
    const dlg = page.getByRole("dialog", { name: "Tautkan USER B ke SALES A?" });
    await expect(dlg).toContainText("Mengganti");
    await expect(dlg).toContainText("SALES LAMA · S-OLD");
    await expect(dlg).toContainText("Cabang salesman");
    await expect(dlg).toContainText("Tautan lama diganti.");
    const getSebelum = n["s-u-b"];
    await dlg.getByRole("button", { name: "Tautkan", exact: true }).click();
    await expect(dlg).toBeHidden();
    expect(log.tulis.filter((t) => t.path.endsWith("/salesman"))).toEqual([{ method: "PUT", path: "/api/admin/users/u-b/salesman", body: { employeeNumber: "M-SLA" } }]);
    await expect(page.getByRole("status").filter({ hasText: "USER B ditautkan ke SALES A (M-SLA), cabang CABANG A." })).toBeVisible();
    await expect.poll(() => n["s-u-b"]).toBeGreaterThan(getSebelum); // dibaca ulang dari server
    await expect(b.getByText("SALES A · M-SLA")).toBeVisible(NAV);
});

test("Salesman Accurate: Lepas lewat dialog konfirmasi (akibat disebut) = DELETE; sesudahnya 'belum dihubungkan' dan Lepas terkunci beralasan", async ({ page }) => {
    let tertaut = true;
    const { log } = await pasang(page, {
        salesman: (id) => (id === "u-b" ? salesmanGet(tertaut ? [TAUTAN_LAMA] : []) : undefined),
        tulis: (t) => { if (t.method === "DELETE" && t.path.endsWith("/salesman")) tertaut = false; return undefined; },
    });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    const b = bagianSalesman(page);
    await expect(b.getByText("SALES LAMA · S-OLD")).toBeVisible(NAV);
    await b.getByRole("button", { name: "Lepas tautan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Lepas tautan USER B dari karyawan Accurate?" });
    await expect(dlg).toContainText("tidak bisa memakai Order Sales sampai ditautkan lagi");
    await expect(dlg).toContainText("Order yang sudah dikirim tidak terpengaruh");
    expect(log.tulis.filter((t) => t.path.endsWith("/salesman"))).toHaveLength(0); // belum ada yang ditulis sebelum konfirmasi
    await dlg.getByRole("button", { name: "Lepas tautan", exact: true }).click();
    await expect(dlg).toBeHidden();
    expect(log.tulis.filter((t) => t.path.endsWith("/salesman"))).toEqual([{ method: "DELETE", path: "/api/admin/users/u-b/salesman", body: null }]);
    await expect(page.getByRole("status").filter({ hasText: "Tautan USER B ke karyawan Accurate dilepas (profil sales tetap)." })).toBeVisible();
    await expect(b.getByText("Belum dihubungkan ke karyawan Accurate.")).toBeVisible(NAV);
    await expect(b.getByRole("button", { name: "Lepas tautan…" })).toBeDisabled();
    await expect(b.getByRole("button", { name: "Lepas tautan…" })).toHaveAttribute("title", "Belum ada tautan untuk dilepas");
});

test("Salesman Accurate: kode galat O1 → kalimat jelas (bukan kode); data berubah = dialog tertutup + muat ulang; kode baru = kalimat server di dialog", async ({ page }) => {
    let jawab: Jawab | undefined = json({ ok: false, code: "KARYAWAN_SUDAH_TERHUBUNG", error: "Karyawan M-SLA sudah tertaut ke akun USER C.", terhubungKe: { userId: "u-c", name: "USER C" } }, 409);
    const { n } = await pasang(page, { salesman: (id) => (id === "u-b" ? salesmanGet([]) : undefined), tulis: (t) => (t.path.endsWith("/salesman") ? jawab : undefined) });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    const b = bagianSalesman(page);
    const daftar = b.getByRole("list", { name: "Karyawan salesman Accurate" });
    const pilihSalesA = async () => { await daftar.getByRole("listitem").filter({ hasText: "SALES A" }).first().getByRole("button").click(); await page.getByRole("dialog").getByRole("button", { name: "Tautkan", exact: true }).click(); };
    await expect(daftar).toBeVisible(NAV);
    const sebelum = n["s-u-b"];
    await pilihSalesA();
    await expect(page.getByRole("dialog")).toBeHidden();
    const strip = page.getByRole("alert").filter({ hasText: "Karyawan itu sudah ditautkan ke akun USER C." });
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Lepas dulu dari akun itu, atau pilih karyawan lain.");
    await expect(strip).not.toContainText("KARYAWAN_SUDAH_TERHUBUNG");
    await expect.poll(() => n["s-u-b"]).toBeGreaterThan(sebelum); // data penentu dimuat ulang

    // Kode yang belum dikenal (mis. laporan Form Kontrol berkode lama): kalimat server tampil di dialog, dialog tetap terbuka.
    jawab = json({ ok: false, code: "LAPORAN_FORM_KONTROL_BERKODE", error: "Ada laporan Form Kontrol berkode S-OLD; tautan tidak bisa diganti." }, 409);
    await daftar.getByRole("listitem").filter({ hasText: "SALES A" }).first().getByRole("button").click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Tautkan", exact: true }).click();
    await expect(dlg.getByRole("alert")).toHaveText("Ada laporan Form Kontrol berkode S-OLD; tautan tidak bisa diganti.");
    await dlg.getByRole("button", { name: "Batal" }).click();

    for (const [code, kalimat] of [
        ["KARYAWAN_BUKAN_SALESMAN_AKTIF", "Karyawan itu bukan salesman aktif di Accurate"],
        ["KARYAWAN_TANPA_CABANG", "Karyawan itu belum punya cabang di Accurate"],
        ["KARYAWAN_TIDAK_ADA", "Karyawan itu tidak ada di master pegawai hasil sinkron Accurate"],
        ["PROFIL_GANDA", "Akun ini punya lebih dari satu profil sales"],
    ] as const) {
        jawab = json({ ok: false, code, error: "teks server" }, code === "KARYAWAN_TIDAK_ADA" ? 404 : 409);
        await daftar.getByRole("listitem").filter({ hasText: "SALES A" }).first().getByRole("button").click();
        await page.getByRole("dialog").getByRole("button", { name: "Tautkan", exact: true }).click();
        const baris = page.getByRole("alert").filter({ hasText: kalimat });
        await expect(baris.or(page.getByRole("dialog").getByRole("alert").filter({ hasText: kalimat })).first()).toBeVisible();
        if (await page.getByRole("dialog").isVisible()) await page.getByRole("dialog").getByRole("button", { name: "Batal" }).click();
    }
});

test("Salesman Accurate: tautan tidak aktif dijelaskan sebabnya; galat muat ≠ kosong + Coba lagi; jawaban tidak pasti = belum pasti + muat ulang", async ({ page }) => {
    let gagal: "500" | null = "500";
    let putus = false;
    const { n } = await pasang(page, {
        salesman: (id) => {
            if (id !== "u-b") return undefined;
            if (gagal) return json({ ok: false, error: "Gagal membaca" }, 500);
            return salesmanGet([{ ...TAUTAN_LAMA, suspended: true, aktif: false }]);
        },
        tulis: (t) => (putus && t.path.endsWith("/salesman") ? "putus" : undefined),
    });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    const b = bagianSalesman(page);
    await expect(b.getByRole("heading", { name: "Tautan karyawan Accurate gagal dimuat" })).toBeVisible(NAV);
    await expect(b.getByText("Belum dihubungkan ke karyawan Accurate.")).toHaveCount(0);
    gagal = null;
    await b.getByRole("button", { name: "Coba lagi" }).click();
    await expect(b.getByText("Tidak aktif", { exact: true })).toBeVisible(NAV);
    await expect(b).toContainText("karyawannya nonaktif di Accurate");
    await expect(b).toContainText("Tautan ini belum bisa dipakai.");

    putus = true;
    const sebelum = n["s-u-b"];
    await b.getByRole("list", { name: "Karyawan salesman Accurate" }).getByRole("listitem").filter({ hasText: "SALES A" }).first().getByRole("button").click();
    await page.getByRole("dialog").getByRole("button", { name: "Tautkan", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("alert").or(page.getByRole("status")).filter({ hasText: "Hasilnya belum pasti" }).first()).toBeVisible();
    await expect.poll(() => n["s-u-b"]).toBeGreaterThan(sebelum);
});

test("Salesman Accurate: users.view = baca-saja (tautan terlihat, tidak ada pilihan/Lepas)", async ({ page }) => {
    await tanpaIzin(page, "/admin/users", "users.manage");
    await pasang(page, { salesman: (id) => (id === "u-b" ? salesmanGet([TAUTAN_LAMA]) : undefined) });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    const b = bagianSalesman(page);
    await expect(b.getByText("SALES LAMA · S-OLD")).toBeVisible(NAV);
    await expect(b).toContainText("Baca-saja: menautkan atau melepas karyawan butuh izin Kelola user (users.manage).");
    await expect(b.getByLabel("Cari karyawan salesman")).toHaveCount(0);
    await expect(b.getByRole("button", { name: "Lepas tautan…" })).toHaveCount(0);
});

test("Riwayat user: tautan salesman tercatat sebagai label + sebelum → sesudah + cabang", async ({ page }) => {
    await pasang(page, { riwayat: json({ ok: true, nextCursor: null, items: [
        { id: "h9", action: "salesman.link", actorName: "ADMIN LOKAL", targetUserName: "USER B", detail: { userName: "USER B",
            sebelum: { salesCode: "S-OLD", salesName: "SALES LAMA" }, sesudah: { salesCode: "M-SLA", salesName: "SALES A", branchName: "CABANG A" } }, createdAt: "2026-10-12T02:30:00.000Z" },
        { id: "h8", action: "salesman.unlink", actorName: "ADMIN LOKAL", targetUserName: "USER B", detail: { userName: "USER B", dihapus: [{ salesCode: "S-OLD", salesName: "SALES LAMA" }] }, createdAt: "2026-10-11T02:30:00.000Z" },
    ] }) });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    const r = page.getByRole("list", { name: "Riwayat" });
    await expect(r.getByRole("listitem").first()).toContainText("Salesman Accurate ditautkan", NAV);
    await expect(r.getByRole("listitem").first()).toContainText("SALES LAMA (S-OLD) → SALES A (M-SLA) · cabang CABANG A");
    await expect(r.getByRole("listitem").nth(1)).toContainText("Tautan salesman Accurate dilepas");
    await expect(r.getByRole("listitem").nth(1)).toContainText("dilepas: SALES LAMA (S-OLD)");
});

test("Ponsel 390 px: bagian Karyawan Accurate (salesman) tanpa gulir menyamping", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await pasang(page, { salesman: (id) => (id === "u-b" ? salesmanGet([TAUTAN_LAMA]) : undefined) });
    await page.goto("/admin/users", NAV);
    await daftarUser(page).getByRole("button", { name: /USER B\b/ }).click();
    await expect(bagianSalesman(page).getByText("SALES LAMA · S-OLD")).toBeVisible(NAV);
    expect(await page.evaluate(() => { const m = document.querySelector("main"); return document.documentElement.scrollWidth <= innerWidth && (!m || m.scrollWidth <= m.clientWidth + 1); })).toBe(true);
    await page.screenshot({ path: "test-results/fiori-o2-admin-salesman-390.png", fullPage: true });
});

// ---------------------------------------------------------------------------------------------- O2 tahap 2 (O1 putaran 1): lepas = tautan mati, ganti kode berlaporan

test("Salesman Accurate (tahap 2): Lepas hanya mematikan tautan — profil/kode/hierarki Form Kontrol TETAP (kalimat dialog + hasil); profil dilepas bisa ditautkan ulang; kode profil akun lain tidak bisa dipilih", async ({ page }) => {
    let lepas = false;
    const dilepas = { ...TAUTAN_LAMA, terhubung: false, aktif: false };
    const { log } = await pasang(page, {
        salesman: (id) => {
            if (id !== "u-b") return undefined;
            return json({ ok: true,
                tautan: [lepas ? dilepas : TAUTAN_LAMA],
                pilihan: [
                    { id: 1, number: "M-SLA", name: "SALES A", branchId: 50, branchName: "CABANG A", terhubungKe: null },
                    { id: 3, number: "S-OLD", name: "SALES LAMA", branchId: 50, branchName: "CABANG A", terhubungKe: lepas ? { userId: "u-b", name: "USER B", email: "user.b@contoh.test", terhubung: false } : { userId: "u-b", name: "USER B", email: "user.b@contoh.test", terhubung: true } },
                    { id: 5, number: "M-SLX", name: "SALES X", branchId: 90, branchName: "CABANG B", terhubungKe: { userId: "u-c", name: "USER C", email: "user.c@contoh.test", terhubung: false } },
                ] });
        },
        tulis: (t) => { if (t.method === "DELETE" && t.path.endsWith("/salesman")) lepas = true; return undefined; },
    });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    const b = bagianSalesman(page);
    await expect(b.getByText("SALES LAMA · S-OLD")).toBeVisible(NAV);
    await b.getByRole("button", { name: "Lepas tautan…" }).click();
    const dlg = page.getByRole("dialog", { name: "Lepas tautan USER B dari karyawan Accurate?" });
    await expect(dlg).toContainText("Profil sales, kode, dan hierarki Form Kontrol tidak dihapus; hanya tautan ke karyawan Accurate yang dimatikan");
    await expect(dlg).not.toContainText(/dihapus dari|hapus profil/i);
    await dlg.getByRole("button", { name: "Lepas tautan", exact: true }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "Tautan USER B ke karyawan Accurate dilepas (profil sales tetap)." })).toBeVisible();
    expect(log.tulis.filter((t) => t.path.endsWith("/salesman"))).toEqual([{ method: "DELETE", path: "/api/admin/users/u-b/salesman", body: null }]);
    // Sesudah dilepas: belum terhubung, profil disebut TETAP ada; Lepas terkunci; menautkan ulang karyawan yang sama dimungkinkan.
    await expect(b.getByText("Belum dihubungkan ke karyawan Accurate.")).toBeVisible(NAV);
    await expect(b).toContainText("Profil sales SALES LAMA (S-OLD) tetap ada (tautannya dilepas)");
    await expect(b.getByRole("button", { name: "Lepas tautan…" })).toBeDisabled();
    const daftar = b.getByRole("list", { name: "Karyawan salesman Accurate" });
    const lama = daftar.getByRole("listitem").filter({ hasText: "SALES LAMA" });
    await expect(lama.getByRole("button")).toHaveCount(1); // profil akun ini yang dilepas: boleh ditautkan ulang
    await expect(lama).not.toContainText("Tertaut ke akun ini");
    const milikLain = daftar.getByRole("listitem").filter({ hasText: "SALES X" });
    await expect(milikLain).toContainText("Kode dipegang profil lama USER C (tautan dilepas)");
    await expect(milikLain.getByRole("button")).toHaveCount(0); // kode unik: dipegang profil akun lain
});

test("Salesman Accurate (tahap 2): KODE_DIPAKAI_FORM_KONTROL = dialog konfirmasi berisi hitungan laporan; konfirmasi = PUT ulang konfirmasiGantiKode:true; batal = tidak ada tulis kedua", async ({ page }) => {
    let konfirmasi = false;
    const { log } = await pasang(page, {
        salesman: (id) => (id === "u-b" ? salesmanGet([TAUTAN_LAMA]) : undefined),
        tulis: (t) => {
            if (!t.path.endsWith("/salesman") || t.method !== "PUT") return undefined;
            if (t.body?.konfirmasiGantiKode === true) { konfirmasi = true; return undefined; }
            return json({ ok: false, code: "KODE_DIPAKAI_FORM_KONTROL", error: "Kode S-OLD punya laporan Form Kontrol", laporan: { laporanHarian: 4, ao: 2, merchandising: 1, jks: 3, total: 10 } }, 409);
        },
    });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    const b = bagianSalesman(page);
    const daftar = b.getByRole("list", { name: "Karyawan salesman Accurate" });
    await expect(daftar).toBeVisible(NAV);
    const pilih = async () => { await daftar.getByRole("listitem").filter({ hasText: "SALES A" }).first().getByRole("button").click(); await page.getByRole("dialog").getByRole("button", { name: "Tautkan", exact: true }).click(); };
    await pilih();
    const kode = page.getByRole("dialog", { name: "Ganti kode salesman USER B yang punya laporan Form Kontrol?" });
    await expect(kode).toBeVisible();
    await expect(kode).toContainText("10 laporan Form Kontrol berkode S-OLD");
    await expect(kode).toContainText("Laporan harian");
    await expect(kode).toContainText("Kontrol AO");
    await expect(kode).toContainText("Merchandising");
    await expect(kode).toContainText("Daftar toko (JKS)");
    await expect(kode).toContainText("M-SLA");
    expect(log.tulis.filter((t) => t.path.endsWith("/salesman"))).toHaveLength(1);
    await expect(page.getByRole("alert").filter({ hasText: "KODE_DIPAKAI_FORM_KONTROL" })).toHaveCount(0);
    // Batal: tidak ada tulis kedua.
    await kode.getByRole("button", { name: "Batal" }).click();
    await expect(kode).toBeHidden();
    expect(log.tulis.filter((t) => t.path.endsWith("/salesman"))).toHaveLength(1);
    // Konfirmasi: PUT ulang membawa konfirmasiGantiKode.
    await pilih();
    await page.getByRole("dialog", { name: /Ganti kode salesman USER B/ }).getByRole("button", { name: "Ganti kode dan tautkan" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    const put = log.tulis.filter((t) => t.path.endsWith("/salesman"));
    expect(put.at(-1)).toEqual({ method: "PUT", path: "/api/admin/users/u-b/salesman", body: { employeeNumber: "M-SLA", konfirmasiGantiKode: true } });
    expect(konfirmasi).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "USER B ditautkan ke SALES A (M-SLA), cabang CABANG A." })).toBeVisible();
});

test("Salesman Accurate (tahap 2): KODE_DIPAKAI_PROFIL_LAIN = kalimat jelas di dialog (bukan kode), tidak memuat ulang", async ({ page }) => {
    await pasang(page, {
        salesman: (id) => (id === "u-b" ? salesmanGet([]) : undefined),
        tulis: (t) => (t.path.endsWith("/salesman") ? json({ ok: false, code: "KODE_DIPAKAI_PROFIL_LAIN", error: "teks server" }, 409) : undefined),
    });
    await page.goto("/admin/users", NAV);
    await bukaUser(page, "USER B");
    const daftar = bagianSalesman(page).getByRole("list", { name: "Karyawan salesman Accurate" });
    await expect(daftar).toBeVisible(NAV);
    await daftar.getByRole("listitem").filter({ hasText: "SALES A" }).first().getByRole("button").click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "Tautkan", exact: true }).click();
    await expect(dlg.getByRole("alert")).toContainText("Kode karyawan itu masih dipegang profil Form Kontrol akun lain yang tautannya sudah dilepas");
    await expect(dlg.getByRole("alert")).not.toContainText("KODE_DIPAKAI_PROFIL_LAIN");
});
