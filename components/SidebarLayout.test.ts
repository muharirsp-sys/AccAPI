/*
 * Tujuan: Memastikan katalog sidebar tidak menghilangkan modul atau melewati izin; gerbang klien SidebarLayout menolak halaman
 *   terlarang yang dicapai tanpa layout server berjalan ulang (navigasi klien, pemasangan ulang dari cache router).
 * Caller: npx tsx --test components/SidebarLayout.test.ts.
 * Dependensi: node:test, workspace-navigation, react-dom/server + konteks router Next (render SidebarLayout tanpa server).
 * Main Functions: tes kelengkapan, default-deny, pencocokan route terdalam, gerbang klien.
 * Side Effects: Tidak ada.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
<<<<<<< HEAD
import { WORKSPACE_GROUPS, HOME_ITEM, ROLE_PROFILES, navigationForPermissions, activeNavigationItem, profileFor, roleProfile, roleShortcuts } from "../config/workspace-navigation";
import { canAccessPathWithKeys } from "../lib/rbac";
=======
import { canAccessPathWithKeys } from "../lib/rbac";
import { WORKSPACE_GROUPS, HOME_ITEM, navigationForPermissions, activeNavigationItem, roleProfile, roleShortcuts } from "../config/workspace-navigation";
>>>>>>> origin/feat/s7b-data-principal-ui

// ponytail: next/font/google kosong di luar kompilator Next, padahal Scope.tsx memanggilnya saat dimuat → stub di cache require
// SEBELUM SidebarLayout dimuat. Plafon: konteks router diambil dari jalur internal next/dist; bila Next memindahkannya, uji ini
// gagal dimuat (bukan lulus diam-diam) — perbarui jalurnya.
require.cache[require.resolve("next/font/google")] = { exports: { Plus_Jakarta_Sans: () => ({ variable: "" }), Geist_Mono: () => ({ variable: "" }) } } as never;

/** Render shell pada URL `pathname` dengan kunci `permKeys` — seperti sesudah navigasi klien atau pemasangan ulang, tanpa layout server. */
async function shell(pathname: string, permKeys: string[], primaryGroup?: string | null) {
    const { default: SidebarLayout } = await import("./SidebarLayout");
    const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {}, hmrRefresh() {} };
    return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
        createElement(PathnameContext.Provider, { value: pathname },
            createElement(SidebarLayout, { permKeys, primaryGroup }, createElement("p", null, "ISI-HALAMAN")))));
}
/** Isi <main> saja: pesan gagal tetap pendek. */
const isiMain = (html: string) => html.slice(html.indexOf("<main"), html.indexOf("</main>"));

test("all existing modules appear exactly once across six groups", () => {
    const items = WORKSPACE_GROUPS.flatMap(group => group.items);
    assert.equal(WORKSPACE_GROUPS.length, 6);
    // 25 sejak Validator Diskon dihapus (19 Sep 2026): menunya memakan Excel unggahan manual
    // dan tidak pernah membaca `promo_rule`, jadi ia tak pernah memeriksa aturan yang berlaku.
    // 26 sejak Normalisasi Diskon (24 Sep 2026). 27 sejak Penerima laporan (Fiori S3, 7 Okt 2026).
    // 28 sejak wizard Pelunasan (Fiori S6e-2, 10 Okt 2026): Admin Incaso mengirim pelunasan tanpa Konsol AOL.
    // 29 sejak Kasir ↔ Incaso (Fiori K2b, 15 Okt 2026): Kasir mencatat setoran dan menutup hari terhadap pelunasan Incaso.
    // 30 sejak Supervisor Review (16 Okt 2026): SPV/SM/Admin melihat ringkasan harian per salesman (supervisor_review.view).
    // 31 sejak Data Principal (S7b, 17 Okt 2026): daftar resmi principal + varian + alias (principles.view; tulis principles.upload).
    assert.equal(items.length, 31);
    assert.equal(WORKSPACE_GROUPS.find(group => group.id === "settings")?.items.find(item => item.href === "/data-principal")?.name, "Data Principal");
    assert.equal(WORKSPACE_GROUPS.find(group => group.id === "operations")?.items.find(item => item.href === "/supervisor-review")?.name, "Supervisor Review");
    assert.ok(items.some(item => item.href === "/pelunasan"));
    assert.equal(WORKSPACE_GROUPS.find(group => group.id === "finance")?.items.find(item => item.href === "/kasir")?.name, "Kasir ↔ Incaso");
    // Master Barang ikut katalog: ia yang MEMBUAT master principal baru, dan matcher
    // deterministik jalur Summary menuntut master berpola `BRAND - JENIS`. Tanpa layar ini
    // satu-satunya cara menambah principal adalah menyusun berkasnya di luar sistem.
    assert.ok(items.some(item => item.href === "/master-barang"));
    // Mapping Principal ikut katalog: terjemahan kode principal -> internal adalah master
    // data yang harus bisa diperbaiki admin lewat UI, bukan lewat berkas di share.
    assert.ok(items.some(item => item.href === "/principal-mapping"));
    assert.ok(items.some(item => item.href === "/principal-order"));
    // Antrean faktur ikut katalog: tab error dan laporan OM adalah layar yang sama.
    assert.ok(items.some(item => item.href === "/antrean-faktur"));
    // Rekap promo ikut katalog: rekap akhir bulan dibaca dari faktur nyata Accurate.
    assert.ok(items.some(item => item.href === "/rekap-promo"));
    // Normalisasi Diskon ikut katalog: potongan tak bertuan di faktur luar web digolongkan di sana.
    assert.ok(items.some(item => item.href === "/normalisasi-diskon"));
    // Aturan promo ikut katalog: aturan terbit harus bisa dibuat dan diperbaiki dengan tangan,
    // bukan hanya dimuat dari berkas — satu outlet baru tidak boleh menunggu berkas disusun ulang.
    assert.ok(items.some(item => item.href === "/aturan-promo"));
    assert.equal(new Set(items.map(item => item.href)).size, items.length);
    assert.ok(items.some(item => item.href === "/payments/sppd"));
    assert.ok(items.some(item => item.href === "/rekapan-nota"));
    // Halaman sales ikut katalog supaya filter izin (`websales.create`) yang menentukan
    // siapa melihatnya — bukan hard-code di dua tempat.
    assert.ok(items.some(item => item.href === "/sales"));
});
test("Data Principal dibuka principles.view, bukan dashboard.view (tanpa entri jatuh ke '/')", () => {
    assert.equal(canAccessPathWithKeys("/data-principal", ["principles.view"]), true);
    assert.equal(canAccessPathWithKeys("/data-principal", ["dashboard.view"]), false);
});
test("navigation is default-deny and removes empty groups", () => {
    assert.deepEqual(navigationForPermissions(() => false), []);
    const groups = navigationForPermissions(href => href === "/summary");
    assert.deepEqual(groups.map(group => [group.id, group.items.map(item => item.href)]), [["promo", ["/summary"]]]);
});
test("deepest route wins and prefix collisions cannot activate an unrelated module", () => {
    const items = [HOME_ITEM, ...WORKSPACE_GROUPS.flatMap(group => group.items)];
    assert.equal(activeNavigationItem("/payments/sppd", items)?.name, "Format SPPD");
    assert.equal(activeNavigationItem("/payments/cart/123", items)?.href, "/payments");
    assert.equal(activeNavigationItem("/payments-other", items), undefined);
    assert.equal(activeNavigationItem("/", items)?.href, "/");
});
test("bottom-nav shortcuts follow the role guessed from permissions and never leak a forbidden page", () => {
    const all = WORKSPACE_GROUPS.flatMap(group => group.items);
    const allowed = (hrefs: string[]) => all.filter(item => hrefs.includes(item.href));
    const salesman = new Set(["websales.create", "form_kontrol.view"]);
    assert.equal(roleProfile(salesman)?.id, "salesman");
    assert.deepEqual(roleShortcuts(salesman, allowed(["/sales", "/form-kontrol", "/insentif-sales"])).map(item => item.href), ["/form-kontrol", "/sales", "/insentif-sales"]);
    // Admin punya semua izin: profil pertama (admin) menang, bukan gabungan.
    assert.equal(roleProfile(new Set(["users.manage", "finance.transfer", "order.create"]))?.id, "admin");
    // Pintasan yang tidak diizinkan tidak muncul; sisanya diisi item lain yang boleh dibuka.
    const gudang = roleShortcuts(new Set(["rekapan_nota.manage"]), allowed(["/rekapan-nota", "/faktur"]));
    assert.deepEqual(gudang.map(item => item.href), ["/rekapan-nota", "/faktur"]);
    assert.equal(roleProfile(new Set(["dashboard.view"])), undefined);
    // Admin Incaso = pelunasan.kirim tanpa izin Finance; Finance yang juga mengirim pelunasan tetap profil Finance.
    assert.equal(roleProfile(new Set(["pelunasan.kirim"]))?.id, "incaso");
    assert.equal(roleProfile(new Set(["pelunasan.kirim", "finance.transfer"]))?.id, "finance");
    // Susulan S6e (tinjauan 2b): incaso SESUDAH peran utama — pemegang peran lain yang juga diberi pelunasan.kirim tetap
    // mendapat Beranda perannya sendiri, bukan Beranda Admin Incaso.
    for (const [kunci, id] of [["websales.create", "salesman"], ["off_program_control.sm_approve", "sm"], ["claim_workflow.create", "claim"],
        ["order.create", "fakturist"], ["rekapan_nota.manage", "gudang"], ["users.manage", "admin"]]) {
        assert.equal(roleProfile(new Set(["pelunasan.kirim", kunci]))?.id, id, kunci);
    }
    assert.deepEqual(roleShortcuts(new Set(), []), []);
});
test("S7-3 (owner 17 Okt): profil Beranda dari nama ★ grup utama, tahan huruf besar/kecil & spasi; Staff/Viewer/custom/tanpa bintang = tebakan kunci lama", () => {
    const PRESET: Array<[string, string]> = [["Admin", "admin"], ["Finance", "finance"], ["Salesman", "salesman"], ["SM", "sm"], ["Manager", "sm"],
        ["SPV", "spv"], ["OM", "om"], ["Kasir", "kasir"], ["Claim", "claim"], ["Fakturist", "fakturist"], ["Admin Sales", "fakturist"],
        ["Admin Gudang", "gudang"], ["Admin Incaso", "incaso"]];
    const kosong = new Set<string>();
    for (const [grup, id] of PRESET) assert.equal(profileFor(grup, kosong)?.id, id, grup);
    for (const grup of ["admin gudang", "  ADMIN   GUDANG ", "AdminGudang", "admin	gudang"]) assert.equal(profileFor(grup, kosong)?.id, "gudang", grup);
    assert.equal(profileFor(" spv ", kosong)?.id, "spv");
    assert.equal(profileFor("manager", kosong)?.id, "sm");
    // Grup utama menang atas tebakan kunci (izin tetap gabungan semua grup): Kasir yang juga memegang users.manage = Beranda Kasir.
    assert.equal(profileFor("Kasir", new Set(["users.manage"]))?.id, "kasir");
    // Staff, Viewer, grup custom (walau namanya memuat kata preset), tanpa bintang -> tebakan kunci lama.
    for (const grup of ["Staff", "Viewer", "Gudang CABANG A", "SPV CABANG A", null, undefined, ""]) {
        assert.equal(profileFor(grup, new Set(["off_program_control.sm_approve"]))?.id, "sm", String(grup));
        assert.equal(profileFor(grup, new Set(["users.manage", "order.create"]))?.id, "admin", String(grup));
        assert.equal(profileFor(grup, kosong), undefined, String(grup));
    }
    // Profil baru hanya lewat grup utama: kunci Kasir/OM/SPV tidak mengubah tebakan lama.
    assert.equal(roleProfile(new Set(["kasir.view", "supervisor_review.view", "off_program_control.om_approve", "off_program_control.create_batch"])), undefined);
});
test("S7-3: pintasan profil = daftar owner, semuanya ada di katalog, dan tidak pernah ke halaman tanpa izin", () => {
    const pintasan = (id: string) => ROLE_PROFILES.find(p => p.id === id)?.shortcuts;
    assert.deepEqual(pintasan("spv"), ["/supervisor-review", "/form-kontrol", "/insentif-sales"]);
    assert.deepEqual(pintasan("om"), ["/kasir", "/pelunasan", "/finance"]);
    assert.deepEqual(pintasan("kasir"), ["/kasir"]);
    assert.deepEqual(pintasan("sm"), ["/off-program-control", "/form-kontrol", "/insentif-sales", "/supervisor-review"]);
    const katalog = new Set(WORKSPACE_GROUPS.flatMap(g => g.items.map(i => i.href)));
    for (const p of ROLE_PROFILES) for (const href of p.shortcuts) assert.ok(katalog.has(href), `${p.id}: ${href} tidak di katalog`);
    const izinkan = (keys: string[]) => {
        const set = new Set(keys);
        return { set, allowed: navigationForPermissions(href => canAccessPathWithKeys(href, set)).flatMap(g => g.items) };
    };
    for (const keys of [[], ["dashboard.view"], ["kasir.view"], ["dashboard.view", "supervisor_review.view", "pelunasan.kirim"], ["dashboard.view", "off_program_control.view", "finance.view"]]) {
        const { set, allowed } = izinkan(keys);
        for (const p of ROLE_PROFILES) {
            for (const item of roleShortcuts(set, allowed, 4, p)) assert.ok(canAccessPathWithKeys(item.href, set), `${p.id}: ${item.href} tanpa izin [${keys.join(", ")}]`);
        }
    }
    // OM tanpa pelunasan.kirim: Pelunasan tidak muncul; kekurangan diisi halaman lain yang boleh dibuka.
    const om = izinkan(["dashboard.view", "kasir.view", "finance.view"]);
    assert.deepEqual(roleShortcuts(om.set, om.allowed, 3, profileFor("OM", om.set)).map(i => i.href), ["/kasir", "/finance", "/form-kontrol"]);
    const spv = izinkan(["dashboard.view", "supervisor_review.view", "insentif_sales.view"]);
    assert.deepEqual(roleShortcuts(spv.set, spv.allowed, 3, profileFor("SPV", spv.set)).map(i => i.href), ["/supervisor-review", "/form-kontrol", "/insentif-sales"]);
});
test("S7-3: shell memakai profil grup utama untuk label peran dan navigasi bawah; tanpa grup utama = tebakan kunci", async () => {
    const keys = ["dashboard.view", "kasir.view", "users.manage", "finance.view"];
    const bnav = (html: string) => [...html.slice(html.indexOf('aria-label="Navigasi utama"')).matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    const kasir = await shell("/", keys, " kasir ");
    assert.match(kasir, /<small>Kasir<\/small>/);
    assert.deepEqual(bnav(kasir).slice(0, 2), ["/", "/kasir"]);
    const tebak = await shell("/", keys, null);
    assert.match(tebak, /<small>Admin<\/small>/);
    assert.deepEqual(bnav(tebak).slice(0, 2), ["/", "/admin/groups"]);
});
test("bottom-nav labels are unique across the whole catalog", () => {
    const labels = [HOME_ITEM, ...WORKSPACE_GROUPS.flatMap(group => group.items)].map(item => item.short ?? item.name.split(" ")[0]);
    assert.deepEqual(labels.filter((label, index) => labels.indexOf(label) !== index), []);
});
test("client gate re-checks the URL with the same keys: a forbidden page reached without the server layout stays denied", async () => {
    const fakturist = ["dashboard.view", "order.view", "order.edit"];
    // Tinjauan #159: /sesi-accurate (server) → router.push /api-wrapper → pindah grup route (/forgot-password) → Back. Router memasang
    // ulang layout dari cache, jadi SidebarLayout dipasang baru di /api-wrapper tanpa layout server berjalan. Dulu useState(pathname)
    // mencatat /api-wrapper sebagai "path yang sudah digerbang server" → Konsol tampil.
    const remount = isiMain(await shell("/api-wrapper", fakturist));
    assert.match(remount, /Akses ditolak/);
    assert.doesNotMatch(remount, /ISI-HALAMAN/);
    assert.doesNotMatch(isiMain(await shell("/api-wrapper/apa-saja", fakturist)), /ISI-HALAMAN/);
    // Halaman yang diizinkan tetap tampil (salah satu SESI_ACCURATE_KEYS cukup untuk /sesi-accurate).
    assert.match(isiMain(await shell("/sesi-accurate", fakturist)), /ISI-HALAMAN/);
    assert.match(isiMain(await shell("/api-wrapper", ["dashboard.view", "api_wrapper.view"])), /ISI-HALAMAN/);
});
