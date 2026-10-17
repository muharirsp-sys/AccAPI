/*
 * Tujuan: Fiori S7b — layar Data Principal (/data-principal, FCL) di atas kontrak S7-2: daftar (cari lewat ejaan alias, status, hitungan
 *   varian/alias), Object Page (kepala dengan kode tetap, Varian, Alias, Riwayat berkursor `sebelum`, Dipakai di), tambah principal / varian /
 *   alias, hapus alias + dialog konfirmasi (alias kode tanpa tombol), aktif/nonaktif principal dan varian dengan konfirmasi yang menyebut
 *   nama, tanpa izin = tombol tersembunyi (upload vs delete), galat 403/409 dengan kalimat server tetap di dialog, galat muat dengan Coba
 *   lagi, kosong, ponsel 390 px, tanpa dialog native.
 * Caller: Playwright lokal (LOCAL_AUTH_BYPASS=true = izin admin; kunci dibuang lewat tanpaIzin):
 *   `npx playwright test tests/fiori-data-principal.spec.ts --config <config lokal port 3065> --workers=1`.
 * Dependensi: semua /api/principals/** di-mock page.route per docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md (tanpa DB). Data contoh generik.
 * Side Effects: Tangkapan di test-results/.
 */
import { expect, test, type Page } from "@playwright/test";

const NAV = { timeout: 90_000 } as const;
// Dokumen yang dijawab page.route (tanpaIzin) tidak punya ruang alamat lokal; tanpa ini Edge memblokir skrip localhost.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] } });
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- cermin JSON kontrak, bukan tipe aplikasi
type Jawab = ReturnType<typeof json> | "putus" | undefined;
type Tulis = { method: string; path: string; body: Obj | null };

const T0 = "2026-10-01T02:00:00.000Z";
const varian = (principalId: string, variantKey: string, name: string | null, isActive = true) => ({ principalId, variantKey, name, isActive, createdBy: "u1", createdAt: T0 });
const alias = (id: string, principalId: string, aliasAsli: string, jenis: string, sumber: string, variantKey: string | null = null) =>
    ({ id, aliasNorm: aliasAsli.toUpperCase(), principalId, variantKey, aliasAsli, jenis, sumber, createdBy: "u1", createdAt: T0 });
const principal = (id: string, code: string, name: string, isActive: boolean, variants: Obj[], aliases: Obj[]) =>
    ({ id, code, name, isActive, createdBy: "u1", createdAt: T0, updatedBy: "u1", updatedAt: T0, variants, aliases });

function benih(): Obj[] {
    return [
        principal("p-a", "PA", "PRINCIPLE A", true, [varian("p-a", "", "PRINCIPLE A UTAMA"), varian("p-a", "VARIAN_A", "VARIAN A")], [
            alias("a1", "p-a", "PA", "nama", "kode_principal"),
            alias("a2", "p-a", "PRINCIPLE A", "nama", "nama_resmi"),
            alias("a3", "p-a", "PRINSIP A", "nama_surat", "manual"),
        ]),
        principal("p-b", "PB", "PRINCIPLE B", false, [], [alias("b1", "p-b", "PB", "nama", "kode_principal")]),
    ];
}
const log = (id: number, principalId: string, entitas: string, kunci: string, aksi: string, after: Obj | null, before: Obj | null = null) =>
    ({ id, entitas, kunci, principalId, aksi, before, after, aktor: id === 1 ? "benih:S7-2" : "u1", waktu: T0 });

type Opsi = {
    /** Jawaban GET /api/principals ke-n (1 = pertama); undefined = bawaan. */
    get?: (n: number) => Jawab;
    /** Jawaban tulis; undefined = diteruskan ke tiruan stateful. */
    tulis?: (t: Tulis) => Jawab;
    daftar?: Obj[];
};

/** Tiruan server stateful + catatan permintaan. 25 baris riwayat untuk PRINCIPLE A (paginasi 20 + 5; id 1 = benih). */
async function pasang(page: Page, o: Opsi = {}) {
    const principals = o.daftar ?? benih();
    let idLog = 100;
    const riwayat: Obj[] = [log(1, "p-a", "principal", "p-a", "buat", { code: "PA", name: "PRINCIPLE A" }), log(2, "p-b", "principal", "p-b", "buat", { code: "PB", name: "PRINCIPLE B" })];
    for (let i = 3; i <= 26; i++) riwayat.push(log(i, "p-a", "alias", `x${i}`, "buat", { aliasAsli: `EJAAN LAMA ${i}`, jenis: "nama", variantKey: null }));
    const catat = (principalId: string, entitas: string, kunci: string, aksi: string, after: Obj | null, before: Obj | null = null) =>
        riwayat.push({ ...log(++idLog, principalId, entitas, kunci, aksi, after, before), aktor: "local-dev-admin", waktu: new Date().toISOString() });
    const cacatan = { get: 0, tulis: [] as Tulis[], riwayat: [] as string[] };

    await page.route((u) => u.pathname.startsWith("/api/principals"), async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        const seg = u.pathname.split("/").filter(Boolean).slice(2); // sesudah /api/principals
        const m = req.method();
        const body: Obj | null = req.postData() ? JSON.parse(req.postData()!) : null;
        if (m === "GET" && seg.length === 0) {
            cacatan.get++;
            const j = o.get?.(cacatan.get);
            if (j === "putus") return route.abort();
            return route.fulfill(j ?? json({ ok: true, principals }));
        }
        if (m === "GET" && seg[1] === "history") {
            cacatan.riwayat.push(u.pathname + u.search);
            const batas = Number(u.searchParams.get("batas") ?? 50);
            const sebelum = Number(u.searchParams.get("sebelum") ?? 0);
            const baris = riwayat.filter((l) => l.principalId === seg[0] && (!sebelum || l.id < sebelum)).sort((a, b) => b.id - a.id).slice(0, batas + 1);
            return route.fulfill(json({ ok: true, riwayat: baris.slice(0, batas), sebelum: baris.length > batas ? baris[batas - 1].id : null }));
        }
        cacatan.tulis.push({ method: m, path: u.pathname, body });
        const khusus = o.tulis?.({ method: m, path: u.pathname, body });
        if (khusus === "putus") return route.abort();
        if (khusus) return route.fulfill(khusus);

        const p = principals.find((x) => x.id === seg[0]);
        if (m === "POST" && seg.length === 0) {
            const baru = principal(`p-${String(body!.code).toLowerCase()}`, String(body!.code), String(body!.name), true, [], [alias(`k-${body!.code}`, `p-${String(body!.code).toLowerCase()}`, String(body!.code), "nama", "kode_principal")]);
            principals.push(baru);
            catat(baru.id, "principal", baru.id, "buat", { code: baru.code, name: baru.name });
            return route.fulfill(json({ ok: true, principal: baru, aliases: baru.aliases }, 201));
        }
        if (!p) return route.fulfill(json({ ok: false, code: "PRINCIPAL_TIDAK_ADA", error: "Principal tidak ditemukan." }, 404));
        if (m === "PATCH" && seg.length === 1) {
            const berubah = p.isActive !== body!.isActive;
            p.isActive = body!.isActive;
            if (berubah) catat(p.id, "principal", p.id, p.isActive ? "aktif" : "nonaktif", { code: p.code, name: p.name });
            return route.fulfill(json({ ok: true, principal: p, berubah }));
        }
        if (seg[1] === "variants" && m === "POST") {
            const v = varian(p.id, body!.variantKey, body!.name ?? null);
            p.variants.push(v);
            catat(p.id, "varian", `${p.id}:${v.variantKey}`, "buat", v);
            return route.fulfill(json({ ok: true, variant: v, aliases: [] }, 201));
        }
        if (seg[1] === "variants" && m === "PATCH") {
            const v = p.variants.find((x: Obj) => x.variantKey === body!.variantKey);
            v.isActive = body!.isActive;
            catat(p.id, "varian", `${p.id}:${v.variantKey}`, v.isActive ? "aktif" : "nonaktif", v);
            return route.fulfill(json({ ok: true, variant: v, berubah: true }));
        }
        if (seg[1] === "aliases" && m === "POST") {
            const a = alias(`n${++idLog}`, p.id, String(body!.alias), String(body!.jenis), "manual", body!.variantKey ?? null);
            p.aliases.push(a);
            catat(p.id, "alias", a.id, "buat", a);
            return route.fulfill(json({ ok: true, alias: a }, 201));
        }
        if (seg[1] === "aliases" && m === "DELETE") {
            const i = p.aliases.findIndex((x: Obj) => x.id === seg[2]);
            const [a] = p.aliases.splice(i, 1);
            catat(p.id, "alias", a.id, "hapus", null, a);
            return route.fulfill(json({ ok: true, alias: a }));
        }
        return route.fulfill(json({ ok: false, code: "TIDAK_DIKENAL", error: "tiruan: rute tidak dikenal" }, 404));
    });
    return cacatan;
}

/** Ganti nama kunci izin di dokumen /data-principal (hanya di tes): gerbang layout tetap lolos lewat principles.view. */
async function tanpaIzin(page: Page, kunci: string[]) {
    await page.route((u) => u.pathname === "/data-principal", async (route) => {
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers["content-length"];
        delete headers["content-encoding"];
        let body = await res.text();
        for (const k of kunci) body = body.split(`\\"${k}\\"`).join(`\\"${k}_tes\\"`);
        return route.fulfill({ status: res.status(), headers, body });
    });
}

const daftar = (page: Page) => page.getByRole("list", { name: "Daftar principal" });
const pilih = (page: Page, nama: string) => daftar(page).getByRole("button", { name: new RegExp(nama) }).click();
const dialog = (page: Page, nama?: string) => (nama ? page.getByRole("dialog", { name: nama }) : page.getByRole("dialog"));
const tanpaGulirSamping = async (page: Page) =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    page.on("dialog", (d) => { throw new Error(`window.${d.type()} masih dipakai: ${d.message()}`); });
});

test("Daftar: hitungan varian/alias, cari lewat ejaan alias, saringan status, kosong-karena-saringan", async ({ page }) => {
    await pasang(page);
    await page.goto("/data-principal", NAV);
    await expect(daftar(page).getByRole("button")).toHaveCount(2, NAV);
    await expect(daftar(page).getByRole("button", { name: /PRINCIPLE A/ })).toContainText("2 varian · 3 alias");
    await expect(daftar(page).getByRole("button", { name: /PRINCIPLE B/ })).toContainText("Nonaktif");
    await expect(page.getByText("1 dari 2 principal aktif.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pilih principal di daftar" })).toBeVisible();

    const cari = page.getByRole("searchbox", { name: "Cari" });
    await cari.fill("prinsip a"); // hanya ada sebagai alias PRINCIPLE A
    await expect(daftar(page).getByRole("button")).toHaveCount(1);
    await expect(daftar(page).getByRole("button", { name: /PRINCIPLE A/ })).toBeVisible();
    await cari.fill("zzz");
    await expect(page.getByRole("heading", { name: "Tidak ada principal “zzz”" })).toBeVisible();
    await cari.fill("");
    await page.getByRole("group", { name: "Status principal" }).getByRole("button", { name: /^Nonaktif/ }).click();
    await expect(daftar(page).getByRole("button")).toHaveCount(1);
    await expect(daftar(page).getByRole("button", { name: /PRINCIPLE B/ })).toBeVisible();
    await expect(page.getByText("Status: Nonaktif")).toBeVisible();
    await page.getByRole("button", { name: "Hapus semua" }).click();
    await expect(daftar(page).getByRole("button")).toHaveCount(2);
});

test("Object Page: kepala (kode tetap), Varian, Alias (alias kode tanpa Hapus), Riwayat berkursor, Dipakai di", async ({ page }) => {
    const c = await pasang(page);
    await page.goto("/data-principal", NAV);
    await pilih(page, "PRINCIPLE A");
    await expect(page.getByRole("heading", { name: "PRINCIPLE A", exact: true })).toBeVisible();
    const kepala = page.locator(".fi-oph");
    await expect(kepala).toContainText("PA");
    await expect(kepala).toContainText("Tidak bisa diubah");
    await expect(kepala).toContainText("Aktif");
    await expect(kepala.getByRole("button", { name: "Nonaktifkan…" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Ubah|Edit|Simpan)/ })).toHaveCount(0); // kode & nama tidak punya jalur ubah

    const v = page.getByRole("list", { name: "Varian PRINCIPLE A" }).getByRole("listitem");
    await expect(v).toHaveCount(2);
    await expect(v.nth(0)).toContainText("Dasar");
    await expect(v.nth(1)).toContainText("VARIAN_A");
    const a = page.getByRole("list", { name: "Alias PRINCIPLE A" }).getByRole("listitem");
    await expect(a).toHaveCount(3);
    await expect(a.filter({ hasText: "alias kode — tetap" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Hapus alias/ })).toHaveCount(2); // alias kode tidak punya tombol hapus
    await expect(page.getByRole("button", { name: "Hapus alias PA", exact: true })).toHaveCount(0);

    const r = page.getByRole("list", { name: "Riwayat principal" }).getByRole("listitem");
    await expect(r).toHaveCount(20, NAV);
    await page.getByRole("button", { name: "Muat riwayat lebih lama" }).click();
    await expect(r).toHaveCount(25);
    await expect(r.last()).toContainText("Principal dibuat");
    await expect(r.last()).toContainText("benih S7-2");
    await expect(page.getByRole("button", { name: "Muat riwayat lebih lama" })).toHaveCount(0);
    // React Strict Mode (dev) bisa memanggil efek dua kali: halaman pertama dihitung "minimal 1", halaman berkursor TEPAT 1.
    const pertama = c.riwayat.filter((x) => !x.includes("sebelum="));
    const lama = c.riwayat.filter((x) => x.includes("sebelum="));
    expect(pertama.length).toBeGreaterThanOrEqual(1);
    expect(pertama[0]).toContain("batas=20");
    expect(lama).toHaveLength(1);
    expect(lama[0]).toMatch(/sebelum=7$/); // kursor = id baris ke-20 yang dikembalikan (7)

    const dipakai = page.locator("#p-dipakai");
    for (const [nama, href] of [["Master Barang", "/master-barang"], ["Mapping Principal", "/principal-mapping"], ["Master Principle", "/principles"], ["Claim Workflow", "/claim-workflow"]]) {
        await expect(dipakai.getByRole("link", { name: new RegExp(nama) })).toHaveAttribute("href", href);
    }
    await page.screenshot({ path: "test-results/fiori-s7b-01-detail.png", fullPage: true });
});

test("Tambah varian + nonaktifkan varian (konfirmasi menyebut principal dan varian); alias hanya menawarkan varian aktif", async ({ page }) => {
    const c = await pasang(page);
    await page.goto("/data-principal", NAV);
    await pilih(page, "PRINCIPLE A");
    await page.getByRole("button", { name: "Tambah varian…" }).click();
    const d = dialog(page, "Tambah varian ke PRINCIPLE A");
    await expect(d.getByRole("button", { name: "Tambah varian", exact: true })).toBeDisabled(); // kode varian wajib
    await d.getByRole("textbox", { name: "Kode varian" }).fill("varian_b");
    await expect(d.getByRole("textbox", { name: "Kode varian" })).toHaveValue("VARIAN_B"); // huruf besar dari klien; server tetap merapikan
    await d.getByRole("textbox", { name: "Nama varian (opsional)" }).fill("VARIAN B");
    await d.getByRole("button", { name: "Tambah varian", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Varian VARIAN_B ditambahkan ke PRINCIPLE A." })).toBeVisible();
    expect(c.tulis).toEqual([{ method: "POST", path: "/api/principals/p-a/variants", body: { variantKey: "VARIAN_B", name: "VARIAN B" } }]);
    const v = page.getByRole("list", { name: "Varian PRINCIPLE A" }).getByRole("listitem");
    await expect(v).toHaveCount(3);
    await expect(v.last()).toContainText("VARIAN B");
    await expect(page.getByRole("list", { name: "Riwayat principal" }).getByRole("listitem").first()).toContainText("Varian VARIAN_B dibuat"); // Riwayat dimuat ulang

    await page.getByRole("button", { name: "Nonaktifkan varian VARIAN_A" }).click();
    const k = dialog(page, "Nonaktifkan varian VARIAN_A PRINCIPLE A?");
    await expect(k).toContainText("PA · PRINCIPLE A");
    await k.getByRole("button", { name: "Batal" }).click();
    expect(c.tulis).toHaveLength(1); // batal = tidak ada permintaan
    await page.getByRole("button", { name: "Nonaktifkan varian VARIAN_A" }).click();
    await dialog(page).getByRole("button", { name: "Nonaktifkan", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Varian VARIAN_A PRINCIPLE A dinonaktifkan." })).toBeVisible();
    expect(c.tulis[1]).toEqual({ method: "PATCH", path: "/api/principals/p-a/variants", body: { variantKey: "VARIAN_A", isActive: false } });
    await expect(page.getByRole("button", { name: "Aktifkan varian VARIAN_A" })).toBeVisible();

    await page.getByRole("button", { name: "Tambah alias…" }).click();
    const untuk = dialog(page, "Tambah alias ke PRINCIPLE A").getByRole("combobox", { name: "Berlaku untuk" });
    await expect(untuk.locator("option")).toHaveText(["Seluruh principal", "Varian Dasar", "Varian VARIAN_B"]); // VARIAN_A nonaktif tidak ditawarkan
});

test("Tambah alias (jenis + varian) lalu hapus alias lewat dialog konfirmasi; batal tidak mengirim apa pun", async ({ page }) => {
    const c = await pasang(page);
    await page.goto("/data-principal", NAV);
    await pilih(page, "PRINCIPLE A");
    await page.getByRole("button", { name: "Tambah alias…" }).click();
    const d = dialog(page, "Tambah alias ke PRINCIPLE A");
    await expect(d.getByRole("button", { name: "Tambah alias", exact: true })).toBeDisabled();
    await d.getByRole("textbox", { name: "Ejaan alias" }).fill("PRINSIP AY");
    await d.getByRole("combobox", { name: "Jenis" }).selectOption("nama_surat");
    await d.getByRole("combobox", { name: "Berlaku untuk" }).selectOption("v:VARIAN_A");
    await d.getByRole("button", { name: "Tambah alias", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Alias “PRINSIP AY” ditambahkan ke PRINCIPLE A." })).toBeVisible();
    expect(c.tulis).toEqual([{ method: "POST", path: "/api/principals/p-a/aliases", body: { alias: "PRINSIP AY", jenis: "nama_surat", variantKey: "VARIAN_A" } }]);
    const a = page.getByRole("list", { name: "Alias PRINCIPLE A" }).getByRole("listitem");
    await expect(a).toHaveCount(4);
    await expect(a.last()).toContainText("Varian VARIAN_A");

    await page.getByRole("button", { name: "Hapus alias PRINSIP A", exact: true }).click();
    const h = dialog(page, "Hapus alias “PRINSIP A” dari PRINCIPLE A?");
    await expect(h).toContainText("Penghapusan tercatat di riwayat.");
    await expect(h).toContainText("Nama di surat");
    await h.getByRole("button", { name: "Batal" }).click();
    await expect(a).toHaveCount(4);
    expect(c.tulis).toHaveLength(1);
    await page.getByRole("button", { name: "Hapus alias PRINSIP A", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Hapus alias", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Alias “PRINSIP A” dihapus dari PRINCIPLE A." })).toBeVisible();
    expect(c.tulis[1]).toEqual({ method: "DELETE", path: "/api/principals/p-a/aliases/a3", body: null });
    await expect(a).toHaveCount(3);
    await expect(page.getByRole("list", { name: "Riwayat principal" }).getByRole("listitem").first()).toContainText("Alias dihapus");
});

test("Nonaktif principal: dialog menyebut nama; batal tidak mengirim; sesudahnya Aktifkan + tambah varian/alias terkunci beralasan", async ({ page }) => {
    const c = await pasang(page);
    await page.goto("/data-principal", NAV);
    await pilih(page, "PRINCIPLE A");
    await page.locator(".fi-oph").getByRole("button", { name: "Nonaktifkan…" }).click();
    const d = dialog(page, "Nonaktifkan PRINCIPLE A?");
    await expect(d).toContainText("PA · PRINCIPLE A");
    await expect(d).toContainText("Varian dan alias tidak dihapus");
    await d.getByRole("button", { name: "Batal" }).click();
    expect(c.tulis).toEqual([]);
    await page.locator(".fi-oph").getByRole("button", { name: "Nonaktifkan…" }).click();
    await dialog(page).getByRole("button", { name: "Nonaktifkan", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Principal PRINCIPLE A dinonaktifkan." })).toBeVisible();
    expect(c.tulis).toEqual([{ method: "PATCH", path: "/api/principals/p-a", body: { isActive: false } }]);
    await expect(page.locator(".fi-oph")).toContainText("Nonaktif");
    await expect(page.locator(".fi-oph").getByRole("button", { name: "Aktifkan…" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tambah varian…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Tambah alias…" })).toBeDisabled();
    await expect(page.locator("#p-varian")).toContainText("Terkunci: Principal nonaktif — aktifkan dulu.");
    await expect(daftar(page).getByRole("button", { name: /PRINCIPLE A/ })).toContainText("Nonaktif");
    await expect(page.getByRole("list", { name: "Riwayat principal" }).getByRole("listitem").first()).toContainText("Principal dinonaktifkan");
});

test("Tambah principal: kode huruf besar, terpilih sesudahnya; KODE_SUDAH_ADA tampil dengan kalimat server dan dialog tetap terbuka", async ({ page }) => {
    const c = await pasang(page, { tulis: (t) => (t.body?.code === "PA" ? json({ ok: false, code: "KODE_SUDAH_ADA", error: "Kode PA sudah dipakai (kode tidak bisa diubah; kode salah = principal baru).", principalId: "p-a" }, 409) : undefined) });
    await page.goto("/data-principal", NAV);
    await page.getByRole("button", { name: "Tambah principal…" }).click();
    const d = dialog(page, "Tambah principal");
    await expect(d.getByRole("button", { name: "Tambah principal", exact: true })).toBeDisabled();
    await d.getByRole("textbox", { name: "Kode", exact: true }).fill("pa");
    await d.getByRole("textbox", { name: "Nama resmi" }).fill("PRINCIPLE LAIN");
    await d.getByRole("button", { name: "Tambah principal", exact: true }).click();
    await expect(d.getByRole("alert")).toContainText("Kode PA sudah dipakai");
    await expect(d).toBeVisible();
    await d.getByRole("textbox", { name: "Kode", exact: true }).fill("pc");
    await d.getByRole("textbox", { name: "Nama resmi" }).fill("PRINCIPLE C");
    await d.getByRole("button", { name: "Tambah principal", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Principal PC (PRINCIPLE C) ditambahkan." })).toBeVisible();
    expect(c.tulis.at(-1)).toEqual({ method: "POST", path: "/api/principals", body: { code: "PC", name: "PRINCIPLE C" } });
    await expect(daftar(page).getByRole("button")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: "PRINCIPLE C", exact: true })).toBeVisible(); // principal baru langsung terpilih
});

test("Galat 409 ALIAS_TABRAKAN dan 403 tampil dengan kalimat server di dialog; 409 memuat ulang data di belakang", async ({ page }) => {
    const c = await pasang(page, {
        tulis: (t) => t.path.endsWith("/aliases") ? json({ ok: false, code: "ALIAS_TABRAKAN", error: "Ejaan \"PRINSIP B\" sudah dipakai principal PB — tidak ditimpa.", pemilik: { code: "PB" } }, 409)
            : t.method === "PATCH" ? json({ error: "Forbidden" }, 403) : undefined,
    });
    await page.goto("/data-principal", NAV);
    await pilih(page, "PRINCIPLE A");
    await expect(page.getByRole("list", { name: "Alias PRINCIPLE A" })).toBeVisible();
    const awal = c.get;
    await page.getByRole("button", { name: "Tambah alias…" }).click();
    const d = dialog(page, "Tambah alias ke PRINCIPLE A");
    await d.getByRole("textbox", { name: "Ejaan alias" }).fill("PRINSIP B");
    await d.getByRole("button", { name: "Tambah alias", exact: true }).click();
    await expect(d.getByRole("alert")).toContainText("Ejaan \"PRINSIP B\" sudah dipakai principal PB — tidak ditimpa.");
    await expect(d.getByRole("textbox", { name: "Ejaan alias" })).toHaveValue("PRINSIP B"); // isian tidak dikosongkan
    await expect.poll(() => c.get).toBeGreaterThan(awal); // 409: data dimuat ulang
    await d.getByRole("button", { name: "Batal" }).click();
    const sesudah409 = c.get;

    await page.locator(".fi-oph").getByRole("button", { name: "Nonaktifkan…" }).click();
    await dialog(page).getByRole("button", { name: "Nonaktifkan", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("Forbidden — akun Anda belum berhak atas aksi ini");
    await expect(dialog(page)).toBeVisible();
    expect(c.get).toBe(sesudah409); // 403 tidak memuat ulang
});

test("Jawaban hilang saat tulis = 'belum pasti' + muat ulang tanpa ulang otomatis", async ({ page }) => {
    const c = await pasang(page, { tulis: (t) => (t.method === "PATCH" ? "putus" : undefined) });
    await page.goto("/data-principal", NAV);
    await pilih(page, "PRINCIPLE A");
    await expect(page.getByRole("list", { name: "Alias PRINCIPLE A" })).toBeVisible();
    const awal = c.get;
    await page.locator(".fi-oph").getByRole("button", { name: "Nonaktifkan…" }).click();
    await dialog(page).getByRole("button", { name: "Nonaktifkan", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Hasilnya belum pasti" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => c.get).toBeGreaterThan(awal);
    expect(c.tulis.filter((t) => t.method === "PATCH")).toHaveLength(1);
});

test("Galat muat tampil sebagai galat (bukan daftar kosong), kalimat server + Coba lagi; kosong sungguhan = Belum ada principal", async ({ page }) => {
    let gagal = true;
    await pasang(page, { get: () => (gagal ? json({ ok: false, code: "PRINCIPAL_DDL_BELUM", error: "Penjaga database principal belum terpasang persis. Hubungi IT Support — perubahan tidak disimpan." }, 503) : undefined) });
    await page.goto("/data-principal", NAV);
    await expect(page.getByRole("alert").filter({ hasText: "Daftar principal gagal dimuat" })).toContainText("Hubungi IT Support", NAV);
    await expect(page.getByRole("heading", { name: "Belum ada principal" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Tambah principal…" })).toBeDisabled(); // tulis terkunci selama data gagal dimuat
    gagal = false;
    await page.getByRole("button", { name: "Coba lagi" }).click();
    await expect(daftar(page).getByRole("button")).toHaveCount(2);

    await pasang(page, { daftar: [] }); // rute terbaru menang
    await page.reload();
    await expect(page.getByRole("heading", { name: "Belum ada principal" })).toBeVisible(NAV);
    await expect(page.getByText("Tambahkan principal pertama lewat tombol Tambah principal.")).toBeVisible();
});

test("Tanpa upload & delete: baca-saja, semua tombol tulis tersembunyi (bukan nonaktif)", async ({ page }) => {
    await tanpaIzin(page, ["principles.upload", "principles.delete"]);
    const c = await pasang(page);
    await page.goto("/data-principal", NAV);
    await expect(page.getByRole("status").filter({ hasText: "Baca-saja." })).toBeVisible(NAV);
    await pilih(page, "PRINCIPLE A");
    await expect(page.getByRole("heading", { name: "PRINCIPLE A", exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Alias PRINCIPLE A" }).getByRole("listitem")).toHaveCount(3);
    for (const nama of [/^Tambah principal/, /^Tambah varian/, /^Tambah alias/, /^Nonaktifkan/, /^Aktifkan/, /^Hapus alias/]) {
        await expect(page.getByRole("button", { name: nama })).toHaveCount(0);
    }
    await expect(page.getByRole("list", { name: "Riwayat principal" }).getByRole("listitem").first()).toBeVisible();
    expect(c.tulis).toEqual([]);
});

test("Hanya upload (tanpa delete): tambah/nonaktif tampil, Hapus alias tersembunyi", async ({ page }) => {
    await tanpaIzin(page, ["principles.delete"]);
    await pasang(page);
    await page.goto("/data-principal", NAV);
    await pilih(page, "PRINCIPLE A");
    await expect(page.getByRole("button", { name: "Tambah alias…" })).toBeEnabled(NAV);
    await expect(page.getByRole("button", { name: "Tambah varian…" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Tambah principal…" })).toBeEnabled();
    await expect(page.locator(".fi-oph").getByRole("button", { name: "Nonaktifkan…" })).toBeEnabled();
    await expect(page.getByRole("button", { name: /^Hapus alias/ })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Baca-saja." })).toHaveCount(0);
});

test("Ponsel 390 px: daftar → detail dengan Kembali, tanpa gulir menyamping; dialog muat di layar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await pasang(page);
    await page.goto("/data-principal", NAV);
    await expect(daftar(page).getByRole("button")).toHaveCount(2, NAV);
    await tanpaGulirSamping(page);
    await page.getByRole("searchbox", { name: "Cari" }).fill("principle b");
    await expect(daftar(page).getByRole("button")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Cari" }).fill("");
    await pilih(page, "PRINCIPLE A");
    await expect(page.getByRole("button", { name: "Kembali ke daftar" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "PRINCIPLE A", exact: true })).toBeVisible();
    await tanpaGulirSamping(page);
    await page.getByRole("button", { name: "Tambah alias…" }).click();
    const d = dialog(page, "Tambah alias ke PRINCIPLE A");
    await expect(d).toBeVisible();
    const kotak = (await d.boundingBox())!;
    expect(kotak.x).toBeGreaterThanOrEqual(0);
    expect(kotak.x + kotak.width).toBeLessThanOrEqual(390);
    await d.getByRole("button", { name: "Batal" }).click();
    await page.screenshot({ path: "test-results/fiori-s7b-02-ponsel.png", fullPage: true });
    await page.getByRole("button", { name: "Kembali ke daftar" }).click();
    await expect(daftar(page)).toBeVisible();
});
