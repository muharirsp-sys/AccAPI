/* Insiden 2026-09-19: fakturist (viewer) menghubungkan akun Accurate-nya sendiri, sesinya jadi
   yang terbaru, dan cron ikut memakainya — retur/barang/karyawan ditolak "tidak memiliki hak",
   faktur tinggal yang boleh dilihat fakturist, enam hari tanpa suara. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSyncUserId, redactAccurateSecrets } from "./accurate-session.ts";

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

// 11 Okt 2026: badan 401 webhook-renew.do menggemakan access token ke log container.
test("token di badan galat Accurate disensor sebelum masuk log", () => {
    const token = "3f2b9c1e-8a4d-4f6b-9e21-7c5d0a1b2c3d";
    const body = JSON.stringify({ error: "invalid_token", error_description: `Invalid access token: ${token}` });
    const out = redactAccurateSecrets(body);
    assert.ok(!out.includes(token), out);
    assert.match(out, /invalid_token/);
    assert.equal(redactAccurateSecrets(`sesi ${token.toUpperCase()} kedaluwarsa`), "sesi [REDACTED] kedaluwarsa");
    assert.equal(redactAccurateSecrets("refresh token: abc123XYZ"), "refresh token: [REDACTED]");
});
