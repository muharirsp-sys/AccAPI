/* Tinjauan S6b A-1/B-1 (10 Okt 2026): POST /api/finance/purchase-payment dikunci ke database yang DILIHAT Finance di dialog
 * BL-03. Klien mengirim `expectedDatabaseId`; server membandingkannya dengan database sesi Accurate SAAT POST, sebelum klaim
 * attempt — beda = 409 {code:"database_changed", claimed:false}, tanpa = 400 {claimed:false}. Sesi, izin, dan DB dipalsukan;
 * klaim (db.execute) dicatat lalu melempar, jaringan dilarang — tidak ada yang bisa terkirim. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as postPurchasePayment } from "../app/api/finance/purchase-payment/route.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

const KUNCI = "kunci-uji-s6b-database";

/** Sama dengan encryptSecret lib/accurate-session (aes-256-gcm, iv.tag.isi base64) — baris sesi palsu harus bisa didekripsi. */
function enkripsi(value: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", createHash("sha256").update(KUNCI).digest(), iv);
    const isi = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${isi.toString("base64")}`;
}

/**
 * Jalankan POST sebagai user berizin `keys` dengan sesi Accurate di database `dbId`. `klaim` = berapa kali klaim attempt dicoba.
 * `reopened` = subjek sudah dibuka ulang (ADR-004): INSERT klaim tidak menyisipkan apa pun, generasi terkini 1.
 */
async function kirim(keys: string[], dbId: string, body: Record<string, unknown>, opsi: { reopened?: boolean } = {}) {
    const saved = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [db, "execute", Object.getOwnPropertyDescriptor(db, "execute")],
        [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
    ] as const;
    const env = { bypass: process.env.LOCAL_AUTH_BYPASS, kunci: process.env.ACCURATE_TOKEN_ENCRYPTION_KEY };
    delete process.env.LOCAL_AUTH_BYPASS;
    process.env.ACCURATE_TOKEN_ENCRYPTION_KEY = KUNCI;
    let klaim = 0;
    let jaringan = 0;
    const perms = keys.map((key) => ({ groupId: "g1", key }));
    const sesi = { userId: "u-fin", accessToken: enkripsi("tok"), sessionHost: "https://zeus.accurate.id", sessionId: enkripsi("sid"),
        databaseId: dbId, databaseAlias: `PT CONTOH ${dbId}`, createdAt: new Date(), updatedAt: new Date() };
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-fin", role: "staff" }, session: { id: "s1" } }) });
    // getUserPermissions = select().from().leftJoin().where(); getAccurateSession = select().from().where().limit(1).
    // currentGeneration (lib/accurate-write-attempt) = select().from().where() yang di-await langsung → [{ g }].
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: () => ({ leftJoin: () => ({ where: async () => perms }),
        where: () => Object.assign(Promise.resolve([{ g: opsi.reopened ? 1 : 0 }]), { limit: async () => [sesi] }) }) }) });
    Object.defineProperty(db, "execute", { configurable: true, value: async () => {
        klaim += 1;
        if (opsi.reopened) return { rows: [] };
        throw new Error("uji: klaim attempt dihentikan di sini");
    } });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => { jaringan += 1; throw new Error("TIDAK BOLEH ke jaringan"); } });
    try {
        const res = await postPurchasePayment(new NextRequest("http://app.test/api/finance/purchase-payment", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        }));
        return { status: res.status, body: await res.json() as Record<string, unknown>, klaim, jaringan };
    } finally {
        for (const [obj, k, d] of saved) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        if (env.bypass === undefined) delete process.env.LOCAL_AUTH_BYPASS; else process.env.LOCAL_AUTH_BYPASS = env.bypass;
        if (env.kunci === undefined) delete process.env.ACCURATE_TOKEN_ENCRYPTION_KEY; else process.env.ACCURATE_TOKEN_ENCRYPTION_KEY = env.kunci;
    }
}

const PAYLOAD = [{ bankNo: "1102-03", vendorNo: "V-0012", chequeAmount: 1000, transDate: "10/10/2026", chequeDate: "10/10/2026",
    paymentMethod: "BANK_TRANSFER", description: "SPPD: 031", detailInvoice: [{ invoiceNo: "LPB-A/0918", paymentAmount: 1000 }] }];
const BODY = { clientRef: "DRAFT-0418|-|PRINCIPLE A|LPB", payload: PAYLOAD };

test("A-1: izin tetap finance.update — tanpa izin 403 sebelum sesi/klaim", async () => {
    const r = await kirim(["finance.view", "finance.resolve_unknown"], "1001", { ...BODY, expectedDatabaseId: "1001" });
    assert.equal(r.status, 403);
    assert.equal(r.klaim, 0);
});

test("A-1: database sesi saat POST berbeda dari yang dilihat Finance -> 409 database_changed, claimed:false, tanpa klaim", async () => {
    const r = await kirim(["finance.update"], "2002", { ...BODY, expectedDatabaseId: "1001" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "database_changed");
    assert.equal(r.body.claimed, false);
    assert.equal(r.body.live, null, "bukan konflik attempt: klien tidak boleh memperlakukannya sebagai tidak pasti");
    assert.match(String(r.body.error), /database Accurate berganti/i);
    assert.match(String(r.body.error), /tidak ada yang dikirim/i);
    assert.equal(r.klaim, 0, "tidak boleh sampai klaim attempt");
});

test("A-1: kontrol positif — database sama (angka vs teks) lolos ke klaim attempt", async () => {
    const r = await kirim(["finance.update"], "1001", { ...BODY, expectedDatabaseId: 1001 });
    assert.equal(r.klaim, 1, "database sama harus sampai klaim");
    assert.equal(r.status, 503); // klaim dihentikan uji = galat sebelum kirim
    assert.equal(r.body.claimed, false);
});

test("A-1: tanpa expectedDatabaseId (klien lama / kiriman buatan) -> 400 claimed:false, tanpa klaim", async () => {
    for (const expectedDatabaseId of [undefined, "", "  ", null]) {
        const r = await kirim(["finance.update"], "1001", { ...BODY, expectedDatabaseId });
        assert.equal(r.status, 400, `expectedDatabaseId=${JSON.stringify(expectedDatabaseId)}`);
        assert.equal(r.body.claimed, false);
        assert.equal(r.klaim, 0);
    }
});

test("Putaran 2 B-6: subjek dibuka ulang (reopened_use_repost) -> 409 claimed:false; klaim tidak menyisipkan apa pun, tidak ada kiriman", async () => {
    const r = await kirim(["finance.update"], "1001", { ...BODY, expectedDatabaseId: "1001" }, { reopened: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "reopened_use_repost");
    assert.equal(r.body.claimed, false, "tidak ada attempt yang diklaim/dikirim di jalur ini");
    assert.equal(r.body.live, null);
    assert.equal(r.klaim, 1, "hanya INSERT klaim (tanpa baris) — tidak ada UPDATE hasil kiriman");
    assert.equal(r.jaringan, 0, "tidak ada kiriman ke Accurate");
});
