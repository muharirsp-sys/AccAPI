/* AM-014 / C.12–C.16: klaim attempt tulis Accurate sebelum kirim.
 * Bagian 1 murni. Bagian 2 butuh Postgres EVALUASI (AM-040, bukan produksi) lewat
 * AM040_DATABASE_URL + tabel dari scripts/migrate-pg.mjs, dan provider SIMULASI lokal —
 * bukan bukti provider Accurate asli. Tanpa env itu bagian 2 dilewati dengan sebabnya. */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { accurateWriteAttempt } from "../db/schema.ts";
import {
    classifyProviderReply, purchasePaymentSubject, resolveAttempt, runGuardedWrite,
    validatePurchasePaymentPayload, SENDING_STALE_MS, type PurchasePaymentItem,
} from "./accurate-write-attempt.ts";

const item = (over: Partial<PurchasePaymentItem> = {}): PurchasePaymentItem => ({
    bankNo: "1101", vendorNo: "V-01", chequeAmount: 150_000, transDate: "29/09/2026", chequeDate: "29/09/2026",
    paymentMethod: "BANK_TRANSFER", description: "SPPD: 001",
    detailInvoice: [{ invoiceNo: "INV-2", paymentAmount: 100_000 }, { invoiceNo: "inv-1 ", paymentAmount: 50_000 }],
    ...over,
});
const ok = (id = "77", number = "PP-001") => JSON.stringify({ s: true, d: [{ s: true, d: ["ok"], r: { id, number } }] });

test("klasifikasi jawaban provider: hanya amplop penolakan yang rejected (C.16)", () => {
    const c = (status: number, text: string) => classifyProviderReply({ status, text }).state;
    assert.equal(c(200, ok()), "posted");
    assert.equal(classifyProviderReply({ status: 200, text: ok("9", "PP-9") }).number, "PP-9");
    assert.equal(c(200, JSON.stringify({ s: false, d: ["Vendor tidak ditemukan"] })), "rejected");
    assert.equal(c(200, JSON.stringify({ s: true, d: [{ s: false, d: ["x"] }] })), "rejected");
    assert.equal(c(401, JSON.stringify({ s: false, d: ["token expired"] })), "rejected", "amplop Accurate = Accurate menjawab");
    assert.equal(c(401, JSON.stringify({ error: "invalid_token" })), "unknown", "401 tanpa amplop bukan bukti belum diproses");
    assert.equal(c(429, "Too Many Requests"), "unknown");
    assert.equal(c(403, "<html>forbidden</html>"), "unknown");
    assert.equal(c(502, JSON.stringify({ s: false, d: ["gateway"] })), "unknown", "5xx beramplop tetap tidak pasti");
    assert.equal(c(302, ""), "unknown");
    assert.equal(c(200, "null"), "unknown");
    assert.equal(c(200, "<html>"), "unknown");
    assert.equal(c(200, JSON.stringify({ s: true, d: [{ s: true, d: ["ok"] }] })), "unknown", "sukses tanpa id");
    assert.equal(c(200, JSON.stringify({ s: true, d: [{ s: true, r: { id: "1" } }, { s: false, d: ["x"] }] })), "unknown", "parsial");
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    assert.equal(classifyProviderReply({ error: refused }).state, "not_sent");
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    assert.equal(classifyProviderReply({ error: reset }).state, "unknown");
    assert.equal(classifyProviderReply({ error: new DOMException("t", "TimeoutError") }).state, "unknown");
});

test("validasi payload di batas kepercayaan + subjek diturunkan server", () => {
    assert.equal(validatePurchasePaymentPayload([item()]), null);
    assert.match(String(validatePurchasePaymentPayload([item(), item()])), /tepat 1/);
    assert.match(String(validatePurchasePaymentPayload(item())), /array/);
    assert.match(String(validatePurchasePaymentPayload([item({ chequeAmount: Number.NaN })])), /chequeAmount/);
    assert.match(String(validatePurchasePaymentPayload([item({ chequeAmount: "150000" as unknown as number })])), /chequeAmount/);
    assert.match(String(validatePurchasePaymentPayload([item({ transDate: "2026-09-29" })])), /dd\/mm/);
    assert.match(String(validatePurchasePaymentPayload([item({ detailInvoice: [{ invoiceNo: "BELUM ADA", paymentAmount: 1 }] })])), /BELUM ADA/);
    assert.match(String(validatePurchasePaymentPayload([item({ detailInvoice: [{ invoiceNo: "A", paymentAmount: 0 }] })])), /paymentAmount/);
    // Urutan faktur, spasi dan huruf tidak mengubah identitas; ganti vendor TIDAK membuka subjek baru.
    assert.equal(purchasePaymentSubject(item()), "INV-1,INV-2");
    assert.equal(purchasePaymentSubject(item({ detailInvoice: [{ invoiceNo: "INV-1", paymentAmount: 1 }, { invoiceNo: "inv-2", paymentAmount: 1 }] })), "INV-1,INV-2");
    assert.equal(purchasePaymentSubject(item({ vendorNo: "V-02" })), purchasePaymentSubject(item()));
    assert.notEqual(purchasePaymentSubject(item({ detailInvoice: [{ invoiceNo: "INV-1", paymentAmount: 1 }] })), purchasePaymentSubject(item()));
});

// ---------------------------------------------------------------- Postgres evaluasi (AM-040)
const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

/** Provider SIMULASI berlabel: HTTP lokal yang meniru jawaban/kegagalan host Accurate. */
async function simulatedProvider(handler: (res: import("node:http").ServerResponse, req: import("node:http").IncomingMessage) => void) {
    let hits = 0;
    const server: Server = createServer((req, res) => {
        hits += 1;
        req.resume();
        req.on("end", () => handler(res, req));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/accurate/api/purchase-payment/bulk-save.do`;
    const send = async (timeoutMs = 2_000) => {
        const res = await fetch(url, { method: "POST", body: "{}", signal: AbortSignal.timeout(timeoutMs) });
        return { status: res.status, text: await res.text() };
    };
    return { send, hits: () => hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test("PG: dua sesi/klik bersamaan -> SATU kirim; posted lalu 'browser ditutup' -> retry diblok", { skip: pgSkip }, async () => {
    const poolA = new Pool({ connectionString: PG_URL, max: 2 });
    const poolB = new Pool({ connectionString: PG_URL, max: 2 });
    const provider = await simulatedProvider((res) => setTimeout(() => res.end(ok()), 150));
    try {
        const subjectKey = `test|${randomUUID()}`;
        const base = { operation: "purchase-payment/bulk-save", subjectKey, clientRef: "k", targetDbId: "DB-1", payload: [item()], send: () => provider.send() };
        const [a, b] = await Promise.all([
            runGuardedWrite({ ...base, db: drizzle(poolA), actor: "user-a" }),
            runGuardedWrite({ ...base, db: drizzle(poolB), actor: "user-b" }),
        ]);
        assert.equal(provider.hits(), 1, "dua pengiriman untuk satu subjek");
        assert.equal([a, b].filter((r) => r.claimed).length, 1);
        // Browser ditutup setelah sukses: laporan ke FastAPI tidak pernah terjadi, tapi server tahu.
        const retry = await runGuardedWrite({ ...base, db: drizzle(poolA), actor: "user-a" });
        assert.equal(retry.claimed, false);
        assert.equal(retry.claimed === false && retry.live?.state, "posted");
        assert.equal(retry.claimed === false && retry.live?.accurateNumber, "PP-001");
        assert.equal(provider.hits(), 1);
    } finally {
        await provider.close();
        await poolA.end();
        await poolB.end();
    }
});

test("PG: barrier nyata — klaim sesi A belum commit, sesi B menunggu lalu ditolak tanpa kirim", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 3 });
    const subjectKey = `test|${randomUUID()}`;
    const holder = await pool.connect();
    let sends = 0;
    try {
        await holder.query("BEGIN");
        await holder.query(
            `INSERT INTO accurate_write_attempt (id, operation, subject_key, target_db_id, payload_hash, actor, state)
             VALUES ($1, 'purchase-payment/bulk-save', $2, 'DB-1', 'h', 'user-a', 'sending')`, [randomUUID(), subjectKey]);
        const pending = runGuardedWrite({
            db: drizzle(pool), operation: "purchase-payment/bulk-save", subjectKey, clientRef: "", targetDbId: "DB-1",
            actor: "user-b", payload: [item()], send: async () => { sends += 1; return { status: 200, text: ok() }; },
        });
        await new Promise((r) => setTimeout(r, 300)); // B pasti sudah menunggu di index unik
        assert.equal(sends, 0, "B mengirim sebelum A commit");
        await holder.query("COMMIT");
        const b = await pending;
        assert.equal(b.claimed, false);
        assert.equal(sends, 0);
    } finally {
        holder.release();
        await pool.end();
    }
});

test("PG: respons hilang / timeout / proses mati / lease basi -> tetap blokir, tidak ada recreate otomatis", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 3 });
    const db = drizzle(pool);
    const run = (subjectKey: string, send: () => Promise<{ status: number; text: string }>) => runGuardedWrite({
        db, operation: "purchase-payment/bulk-save", subjectKey, clientRef: "", targetDbId: "DB-1", actor: "u", payload: [item()], send,
    });
    const lost = await simulatedProvider((res) => res.socket?.destroy()); // terima lalu putus
    const hang = await simulatedProvider(() => { /* tidak pernah menjawab */ });
    try {
        for (const [name, send] of [["respons hilang", () => lost.send()], ["timeout", () => hang.send(200)]] as const) {
            const subjectKey = `test|${randomUUID()}`;
            const first = await run(subjectKey, send);
            assert.equal(first.claimed && first.outcome.state, "unknown", name);
            const again = await run(subjectKey, async () => { throw new Error("TIDAK BOLEH DIKIRIM ULANG"); });
            assert.equal(again.claimed, false, `${name}: dikirim ulang`);
        }
        // Proses mati setelah MUNGKIN kirim: baris 'sending' 1 jam lalu (lease "kedaluwarsa").
        const deadKey = `test|${randomUUID()}`;
        await pool.query(
            `INSERT INTO accurate_write_attempt (id, operation, subject_key, target_db_id, payload_hash, actor, state, updated_at)
             VALUES ($1, 'purchase-payment/bulk-save', $2, 'DB-1', 'h', 'u', 'sending', now() - interval '1 hour')`, [randomUUID(), deadKey]);
        const afterCrash = await run(deadKey, async () => { throw new Error("TIDAK BOLEH DIKIRIM"); });
        assert.equal(afterCrash.claimed, false, "sending basi diambil alih diam-diam");
    } finally {
        await lost.close();
        await hang.close();
        await pool.end();
    }
});

test("PG: hasil gagal tersimpan setelah kirim -> baris tetap sending & memblokir; resolve menunggu basi", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 3 });
    const db = drizzle(pool);
    const subjectKey = `test|${randomUUID()}`;
    const base = { operation: "purchase-payment/bulk-save", subjectKey, clientRef: "", targetDbId: "DB-1", actor: "u", payload: [item()] };
    try {
        const update = mock.method(db, "update", () => { throw new Error("DB putus setelah Accurate menjawab"); });
        const first = await runGuardedWrite({ ...base, db, send: async () => ({ status: 200, text: ok() }) });
        update.mock.restore();
        assert.equal(first.claimed && first.persisted, false);
        assert.equal(first.claimed && first.outcome.state, "posted", "jawaban provider tetap dilaporkan ke pemanggil");
        const again = await runGuardedWrite({ ...base, db, send: async () => { throw new Error("TIDAK BOLEH"); } });
        assert.equal(again.claimed === false && again.live?.state, "sending");
        const resolveBase = { db, operation: base.operation, subjectKey, accurateNumber: "", reason: "dicek di daftar Pembayaran Pembelian", checkedSource: "Accurate DB-1 list 29/09", actor: "spv" };
        const early = await resolveAttempt({ ...resolveBase, decision: "absent" });
        assert.equal(!early.ok && early.code, "in_flight");
        const later = await resolveAttempt({ ...resolveBase, decision: "posted", accurateNumber: "PP-001", now: new Date(Date.now() + SENDING_STALE_MS + 60_000) });
        assert.equal(later.ok && later.state, "posted");
    } finally {
        await pool.end();
    }
});

test("PG: ditolak / tak terhubung boleh diulang; atestasi 'tidak ada' membuka ulang tanpa menghapus jejak", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 3 });
    const db = drizzle(pool);
    const run = (subjectKey: string, send: () => Promise<{ status: number; text: string }>) => runGuardedWrite({
        db, operation: "purchase-payment/bulk-save", subjectKey, clientRef: "", targetDbId: "DB-1", actor: "u", payload: [item()], send,
    });
    const closed = await simulatedProvider(() => undefined);
    await closed.close(); // port kosong -> ECONNREFUSED
    try {
        const rejKey = `test|${randomUUID()}`;
        const rej = await run(rejKey, async () => ({ status: 200, text: JSON.stringify({ s: false, d: ["Bank tidak valid"] }) }));
        assert.equal(rej.claimed && rej.outcome.state, "rejected");
        assert.equal((await run(rejKey, async () => ({ status: 200, text: ok() }))).claimed, true, "penolakan valid harus bisa diperbaiki & diulang");

        const refusedKey = `test|${randomUUID()}`;
        const refused = await run(refusedKey, () => closed.send());
        assert.equal(refused.claimed && refused.outcome.state, "not_sent");
        assert.equal((await run(refusedKey, async () => ({ status: 200, text: ok() }))).claimed, true);

        const unkKey = `test|${randomUUID()}`;
        await run(unkKey, async () => ({ status: 504, text: "Gateway Timeout" }));
        const r = { db, operation: "purchase-payment/bulk-save", subjectKey: unkKey, accurateNumber: "", checkedSource: "Accurate DB-1", actor: "spv" };
        assert.equal((await resolveAttempt({ ...r, decision: "absent", reason: "pendek" })).ok, false, "alasan wajib");
        const res = await resolveAttempt({ ...r, decision: "absent", reason: "dicek manual: tidak ada di daftar PP" });
        assert.equal(res.ok && res.state, "resolved_absent");
        const reopened = await run(unkKey, async () => ({ status: 200, text: ok("88", "PP-088") }));
        assert.equal(reopened.claimed && reopened.outcome.state, "posted");
        const rows = await db.select().from(accurateWriteAttempt).where(eq(accurateWriteAttempt.subjectKey, unkKey));
        assert.equal(rows.length, 2, "attempt lama hilang");
        const resolved = rows.find((x) => x.state === "resolved_absent");
        assert.equal((resolved?.resolution as { previous_state?: string; checked_source?: string })?.previous_state, "unknown");
        assert.equal((resolved?.resolution as { checked_source?: string })?.checked_source, "Accurate DB-1");
        const posted = await resolveAttempt({ ...r, decision: "absent", reason: "coba tandai tidak ada padahal posted" });
        assert.equal(!posted.ok && posted.code, "already_posted", "posted tidak bisa diatestasi 'tidak ada'");
    } finally {
        await pool.end();
    }
});
