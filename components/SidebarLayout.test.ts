/*
 * Tujuan: Memastikan katalog sidebar tidak menghilangkan modul atau melewati izin.
 * Caller: npx tsx --test components/SidebarLayout.test.ts.
 * Dependensi: node:test, workspace-navigation.
 * Main Functions: tes kelengkapan, default-deny, dan pencocokan route terdalam.
 * Side Effects: Tidak ada.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_GROUPS, HOME_ITEM, navigationForPermissions, activeNavigationItem } from "../config/workspace-navigation";

test("all existing modules appear exactly once across six groups", () => {
    const items = WORKSPACE_GROUPS.flatMap(group => group.items);
    assert.equal(WORKSPACE_GROUPS.length, 6);
    assert.equal(items.length, 23);
    // Mapping Principal ikut katalog: terjemahan kode principal -> internal adalah master
    // data yang harus bisa diperbaiki admin lewat UI, bukan lewat berkas di share.
    assert.ok(items.some(item => item.href === "/principal-mapping"));
    assert.ok(items.some(item => item.href === "/principal-order"));
    // Antrean faktur ikut katalog: tab error dan laporan OM adalah layar yang sama.
    assert.ok(items.some(item => item.href === "/antrean-faktur"));
    assert.equal(new Set(items.map(item => item.href)).size, items.length);
    assert.ok(items.some(item => item.href === "/payments/sppd"));
    assert.ok(items.some(item => item.href === "/rekapan-nota"));
    // Halaman sales ikut katalog supaya filter izin (`websales.create`) yang menentukan
    // siapa melihatnya — bukan hard-code di dua tempat.
    assert.ok(items.some(item => item.href === "/sales"));
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
