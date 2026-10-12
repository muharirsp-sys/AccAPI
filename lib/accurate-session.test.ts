/* Insiden 2026-09-19: fakturist (viewer) menghubungkan akun Accurate-nya sendiri, sesinya jadi
   yang terbaru, dan cron ikut memakainya — retur/barang/karyawan ditolak "tidak memiliki hak",
   faktur tinggal yang boleh dilihat fakturist, enam hari tanpa suara. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSyncUserId } from "./accurate-session.ts";

test("sesi non-admin yang lebih baru tidak merebut identitas cron", () => {
    // urut updatedAt menurun, persis bentuk produksi 2026-09-25
    const sessions = [
        { userId: "fakturist1", role: "viewer" },
        { userId: "ari", role: "admin" },
    ];
    assert.equal(pickSyncUserId(sessions), "ari");
});

test("tanpa sesi admin -> kosong, supaya gagal keras alih-alih jalan dengan hak orang lain", () => {
    assert.equal(pickSyncUserId([{ userId: "fakturist1", role: "viewer" }, { userId: "x", role: null }]), "");
});
