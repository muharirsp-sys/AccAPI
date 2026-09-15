/* Kunci: angka pada berkas ini ADALAH kontraknya. `python_backend/test_order_duplicate.py`
   memakai contoh yang sama persis; dua jawaban berbeda tentang "apakah order ini ganda"
   lebih buruk daripada tidak punya pemeriksaan sama sekali. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { duplicateFinding, findDuplicate, type OrderFingerprint } from "./order-duplicate.ts";

const order = (key: string, itemCodes: string[], over: Partial<OrderFingerprint> = {}): OrderFingerprint => ({
    key, outlet: "C-BA0003", orderDate: "2026-09-12", itemCodes, ...over,
});

test("MIRIP tapi tidak sama persis: inilah yang wajib dikonfirmasi", () => {
    // Order diketik ulang karena yang pertama dikira gagal, lalu satu barang ditambah.
    // Keduanya lalu terlihat sebagai order yang berbeda, dan barangnya keluar dua kali.
    const hit = findDuplicate(order("SO-2", ["K1", "K2", "K3", "K4"]), [order("SO-1", ["K1", "K2", "K3"])]);
    assert.ok(hit);
    assert.equal(hit.key, "SO-1");
    assert.deepEqual(hit.shared, ["K1", "K2", "K3"]);
    assert.equal(hit.containment, 1);
    assert.equal(hit.identical, false);
    assert.match(duplicateFinding(hit), /mirip 100%/);
    assert.match(duplicateFinding(hit), /SO-1/);
});

test("PERSIS SAMA juga ditahan, dengan kalimat yang berbeda", () => {
    const hit = findDuplicate(order("SO-2", ["K1", "K2"]), [order("SO-1", ["K2", "K1"])]);
    assert.ok(hit);
    assert.equal(hit.identical, true);
    assert.match(duplicateFinding(hit), /PERSIS SAMA/);
});

test("containment, bukan jaccard: 3 barang di dalam 10 barang tetap terbaca mirip", () => {
    // Jaccard-nya 0,3 — terlihat tidak mirip — padahal ini bentuk ketikan ulang paling khas:
    // sebagian isi order pertama dimasukkan lagi.
    const besar = ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", "K10"];
    const hit = findDuplicate(order("SO-2", ["K1", "K2", "K3"]), [order("SO-1", besar)]);
    assert.ok(hit);
    assert.equal(hit.containment, 1);
});

test("outlet berbeda atau tanggal berbeda BUKAN order ganda", () => {
    const isi = ["K1", "K2", "K3"];
    assert.equal(findDuplicate(order("SO-2", isi), [order("SO-1", isi, { outlet: "C-LAIN01" })]), null);
    assert.equal(findDuplicate(order("SO-2", isi), [order("SO-1", isi, { orderDate: "2026-09-13" })]), null);
    // Outlet ditulis beda huruf besar-kecil tetap outlet yang sama.
    assert.ok(findDuplicate(order("SO-2", isi), [order("SO-1", isi, { outlet: " c-ba0003 " })]));
});

test("di bawah ambang dibiarkan lewat; ambangnya bisa digeser tanpa membedah logikanya", () => {
    // 1 dari 4 = 0,25 — di bawah 0,5, dan memang tidak setiap barang yang sama berarti ganda.
    const sedikit = [order("SO-1", ["K1", "K9", "K8", "K7"])];
    assert.equal(findDuplicate(order("SO-2", ["K1", "K2", "K3", "K4"]), sedikit), null);
    assert.ok(findDuplicate(order("SO-2", ["K1", "K2", "K3", "K4"]), sedikit, 0.25));
});

test("yang dikembalikan adalah yang PALING mirip, bukan yang pertama ketemu", () => {
    const hit = findDuplicate(order("SO-3", ["K1", "K2", "K3", "K4"]), [
        order("SO-1", ["K1", "K2", "K9", "K8"]),   // containment 0,5
        order("SO-2", ["K1", "K2", "K3", "K4"]),   // containment 1
    ]);
    assert.equal(hit?.key, "SO-2");
});

test("order kosong dan order itu sendiri tidak pernah dianggap ganda", () => {
    assert.equal(findDuplicate(order("SO-1", []), [order("SO-2", ["K1"])]), null);
    assert.equal(findDuplicate(order("SO-1", ["K1", "K2"]), [order("SO-1", ["K1", "K2"])]), null);
    assert.equal(findDuplicate(order("SO-2", ["K1"]), [order("SO-1", [])]), null);
});
