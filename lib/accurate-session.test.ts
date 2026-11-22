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

/* Insiden 22 Nov 2026: token mati / X-Session-ID habis pada kredensial sistem (cron, webhook, stok live, detail faktur). */
import type { TestContext } from "node:test";
import { db } from "./db.ts";
import { resolveSyncCredentials, upsertAccurateSession } from "./accurate-session.ts";
import { PESAN_TOKEN_MATI } from "./accurate-401.ts";

const RAHASIA = "0d4c5a6e-1111-4222-8333-944455556666";

/** DB palsu satu baris sesi (dienkripsi lewat upsert asli) + fetch palsu; mengembalikan url fetch yang terjadi. */
async function sistemPalsu(t: TestContext, sesi: { sessionHost: string | null; sessionId: string | null }, jawab: (url: string) => Response) {
    for (const [k, v] of [["ACCURATE_TOKEN_ENCRYPTION_KEY", "kunci-uji"], ["ACCURATE_SYNC_USER_ID", "admin-1"]]) {
        const lama = process.env[k];
        process.env[k] = v;
        t.after(() => { if (lama === undefined) delete process.env[k]; else process.env[k] = lama; });
    }
    let baris: Record<string, unknown> | null = null;
    t.mock.method(db, "select", () => ({ from: () => ({ where: () => ({ limit: async () => (baris ? [baris] : []) }) }) }));
    t.mock.method(db, "insert", () => ({ values: async (v: Record<string, unknown>) => { baris = v; } }));
    t.mock.method(db, "update", () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { baris = v; } }) }));
    await upsertAccurateSession("admin-1", { accessToken: RAHASIA, databaseId: "77", databaseAlias: "PT CONTOH", ...sesi });
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL) => { urls.push(String(url)); return jawab(String(url)); });
    return urls;
}

test("kredensial sistem: open-db.do menjawab 401 -> pesan token kedaluwarsa (bukan 'coba lagi' samar)", async (t) => {
    const urls = await sistemPalsu(t, { sessionHost: null, sessionId: null },
        () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 }));
    const hasil = await resolveSyncCredentials();
    assert.deepEqual(hasil, { error: PESAN_TOKEN_MATI });
    assert.deepEqual(urls, ["https://account.accurate.id/api/open-db.do?id=77"]);
});

test("kredensial sistem: segarkanSesi paralel (rincian 4 pekerja) berbagi satu open-db.do, lalu boleh membuka lagi", async (t) => {
    const urls = await sistemPalsu(t, { sessionHost: "https://iris.accurate.id", sessionId: "sesi-lama" },
        () => new Response(JSON.stringify({ host: "https://iris.accurate.id", session: `sesi-${Date.now()}` }), { status: 200 }));
    const { creds } = await resolveSyncCredentials();
    assert.ok(creds?.segarkanSesi);
    assert.equal(creds.sessionId, "sesi-lama");
    assert.equal(urls.length, 0, "sesi tersimpan lengkap: tidak membuka ulang di depan");
    const [a, b, c] = await Promise.all([creds.segarkanSesi(), creds.segarkanSesi(), creds.segarkanSesi()]);
    assert.equal(urls.length, 1);
    assert.equal(a?.sessionId, b?.sessionId);
    assert.equal(b?.sessionId, c?.sessionId);
    assert.equal(a?.apiKey, RAHASIA);
    assert.equal(a?.databaseId, "77");
    await creds.segarkanSesi();
    assert.equal(urls.length, 2, "sesudah selesai, habis lagi = buka lagi (bukan hasil lama)");
});
