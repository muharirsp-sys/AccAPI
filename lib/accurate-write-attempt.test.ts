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
    classifyProviderReply, normalizePurchasePaymentPayload, purchasePaymentSubject, resolveAttempt, runGuardedWrite,
    type PurchasePaymentItem,
} from "./accurate-write-attempt.ts";

const item = (over: Partial<PurchasePaymentItem> = {}): PurchasePaymentItem => ({
    bankNo: "1101", vendorNo: "V-01", chequeAmount: 150_000, transDate: "29/09/2026", chequeDate: "29/09/2026",
    paymentMethod: "BANK_TRANSFER", description: "SPPD: 001",
    detailInvoice: [{ invoiceNo: "INV-2", paymentAmount: 100_000 }, { invoiceNo: "inv-1 ", paymentAmount: 50_000 }],
    ...over,
});
const ok = (id = "77", number = "PP-001") => JSON.stringify({ s: true, d: [{ s: true, d: ["ok"], r: { id, number } }] });

// C11 (owner 8 Okt 2026, tanpa sandbox): penolakan Accurate belum terbukti "tidak tersimpan" -> unknown (bukan
// rejected yang membuka kirim ulang). Hanya not_sent (koneksi tak pernah terbentuk) yang boleh diulang tanpa Finance.
test("klasifikasi jawaban provider: penolakan belum terbukti = unknown; tidak ada yang rejected (C.16 + C11)", () => {
    const c = (status: number, text: string) => classifyProviderReply({ status, text }).state;
    assert.equal(c(200, ok()), "posted");
    assert.equal(classifyProviderReply({ status: 200, text: ok("9", "PP-9") }).number, "PP-9");
    assert.equal(c(200, JSON.stringify({ s: false, d: ["Vendor tidak ditemukan"] })), "unknown");
    assert.match(classifyProviderReply({ status: 200, text: JSON.stringify({ s: false, d: ["Vendor tidak ditemukan"] }) }).message, /Vendor tidak ditemukan/);
    assert.equal(c(200, JSON.stringify({ s: true, d: [{ s: false, d: ["x"] }] })), "unknown");
    assert.equal(c(200, JSON.stringify([{ s: false, d: ["x"] }])), "unknown");
    assert.equal(c(401, JSON.stringify({ s: false, d: ["token expired"] })), "unknown", "amplop 401 belum terbukti tak diproses");
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

test("payload dibangun ulang dari allowlist di batas kepercayaan + subjek diturunkan server", () => {
    const err = (payload: unknown) => { const r = normalizePurchasePaymentPayload(payload); return "error" in r ? r.error : ""; };
    const good = normalizePurchasePaymentPayload([item()]);
    assert.ok("item" in good);
    assert.match(err([item(), item()]), /tepat 1/);
    assert.match(err(item()), /array/);
    assert.match(err([item({ chequeAmount: Number.NaN })]), /chequeAmount/);
    assert.match(err([item({ chequeAmount: "150000" as unknown as number })]), /chequeAmount/);
    assert.match(err([item({ transDate: "2026-09-29" })]), /dd\/mm/);
    assert.match(err([item({ detailInvoice: [{ invoiceNo: "BELUM ADA", paymentAmount: 1 }] })]), /BELUM ADA/);
    assert.match(err([item({ detailInvoice: [{ invoiceNo: "A", paymentAmount: 0 }] })]), /paymentAmount/);
    // Review M2: invoiceNo bukan teks ditolak; kunci tambahan TIDAK ikut ke objek yang dikirim.
    assert.match(err([item({ detailInvoice: [{ invoiceNo: { x: 1 } as unknown as string, paymentAmount: 1 }] })]), /invoiceNo/);
    const sneaky = normalizePurchasePaymentPayload([{ ...item(), id: "999", number: "PP-OLD", "detailInvoice[5].invoiceNo": "INV-X",
        detailInvoice: [{ invoiceNo: "INV-1", paymentAmount: 5, id: "7" }] }]);
    assert.ok("item" in sneaky);
    assert.deepEqual(Object.keys(sneaky.item).sort(), ["bankNo", "chequeAmount", "chequeDate", "description", "detailInvoice", "paymentMethod", "transDate", "vendorNo"]);
    assert.deepEqual(sneaky.item.detailInvoice, [{ invoiceNo: "INV-1", paymentAmount: 5 }]);
    const many = Array.from({ length: 200 }, (_, i) => ({ invoiceNo: `PI/2026/09/${String(i).padStart(5, "0")}`, paymentAmount: 1 }));
    assert.match(purchasePaymentSubject({ detailInvoice: many }), /^sha256:[0-9a-f]{64}$/, "subjek panjang melewati batas index btree");
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
        const resolveBase = { db, operation: base.operation, subjectKey, accurateNumber: "", reason: "dicek di daftar Pembayaran Pembelian", checkedSource: "Accurate DB-1 list 29/09", actor: "spv", resolverDbId: "DB-1" };
        const early = await resolveAttempt({ ...resolveBase, decision: "absent" });
        assert.equal(!early.ok && early.code, "in_flight");
        const earlyPosted = await resolveAttempt({ ...resolveBase, decision: "posted", accurateNumber: "PP-001" });
        assert.equal(!earlyPosted.ok && earlyPosted.code, "in_flight", "sending segar bisa masih ditulis request yang berjalan");
        await pool.query("UPDATE accurate_write_attempt SET updated_at = now() - interval '3 minutes' WHERE subject_key = $1", [subjectKey]);
        const later = await resolveAttempt({ ...resolveBase, decision: "posted", accurateNumber: "PP-001" });
        assert.equal(later.ok && later.state, "posted");
    } finally {
        await pool.end();
    }
});

test("PG: ditolak = tidak pasti (C11) memblokir; tak terhubung boleh diulang; atestasi 'tidak ada' membuka ulang tanpa menghapus jejak", { skip: pgSkip }, async () => {
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
        assert.equal(rej.claimed && rej.outcome.state, "unknown");
        const rejAgain = await run(rejKey, async () => { throw new Error("TIDAK BOLEH DIKIRIM ULANG"); });
        assert.equal(rejAgain.claimed === false && rejAgain.live?.state, "unknown", "penolakan belum terbukti tidak membuka kirim ulang");

        const refusedKey = `test|${randomUUID()}`;
        const refused = await run(refusedKey, () => closed.send());
        assert.equal(refused.claimed && refused.outcome.state, "not_sent");
        assert.equal((await run(refusedKey, async () => ({ status: 200, text: ok() }))).claimed, true);

        const unkKey = `test|${randomUUID()}`;
        await run(unkKey, async () => ({ status: 504, text: "Gateway Timeout" }));
        const r = { db, operation: "purchase-payment/bulk-save", subjectKey: unkKey, accurateNumber: "", checkedSource: "Accurate DB-1", actor: "spv", resolverDbId: "DB-1" };
        assert.equal((await resolveAttempt({ ...r, decision: "absent", reason: "pendek" })).ok, false, "alasan wajib");
        // Review M1: unknown segar -> "tidak ada" ditolak (Accurate mungkin masih memproses).
        const fresh = await resolveAttempt({ ...r, decision: "absent", reason: "dicek manual: tidak ada di daftar PP" });
        assert.equal(!fresh.ok && fresh.code, "in_flight");
        // Review M3: diperiksa di database lain -> ditolak.
        await pool.query("UPDATE accurate_write_attempt SET updated_at = now() - interval '3 minutes' WHERE subject_key = $1", [unkKey]);
        const otherDb = await resolveAttempt({ ...r, resolverDbId: "DB-2", decision: "absent", reason: "dicek manual: tidak ada di daftar PP" });
        assert.equal(!otherDb.ok && otherDb.code, "wrong_database");
        const res = await resolveAttempt({ ...r, decision: "absent", reason: "dicek manual: tidak ada di daftar PP" });
        assert.equal(res.ok && res.state, "resolved_absent");
        const reopened = await run(unkKey, async () => ({ status: 200, text: ok("88", "PP-088") }));
        assert.equal(reopened.claimed && reopened.outcome.state, "posted");
        const rows = await db.select().from(accurateWriteAttempt).where(eq(accurateWriteAttempt.subjectKey, unkKey));
        assert.equal(rows.length, 2, "attempt lama hilang");
        const resolved = rows.find((x) => x.state === "resolved_absent");
        assert.equal((resolved?.resolution as { previous_state?: string; checked_source?: string })?.previous_state, "unknown");
        assert.equal((resolved?.resolution as { checked_source?: string })?.checked_source, "Accurate DB-1");
        assert.equal((resolved?.resolution as { resulting_state?: string })?.resulting_state, "resolved_absent"); // D-14
        const posted = await resolveAttempt({ ...r, decision: "absent", reason: "coba tandai tidak ada padahal posted" });
        assert.equal(!posted.ok && posted.code, "already_posted", "posted tidak bisa diatestasi 'tidak ada'");
    } finally {
        await pool.end();
    }
});

// ---------------------------------------------------------------- C14: bentuk final ADR-004 rev 3.1 rilis A
// Skema generasi + tabel reopen dibuat migrate-pg/drizzle; reopen/repost (rilis B, D-15) BELUM ada, jadi kode
// selalu mengklaim generasi 0. Baris reopen di bawah disisipkan langsung untuk meniru data rilis B. Trigger &
// FK melingkar attempt->reopen = DDL manual (tidak dijalankan) — uji ini tidak bergantung padanya.
const OP = "purchase-payment/bulk-save";
const pgCode = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));
const REOPEN_SQL = `INSERT INTO accurate_write_attempt_reopen (id, operation, subject_key, from_attempt_id, target_db_id, actor,
        from_generation, to_generation, old_accurate_id, old_accurate_number, reason, checked_source, verification)
    VALUES ($1, $2, $3, $4, $5, 'fin', $6, $7, '77', 'PP-001', $8, 'Accurate DB-1', $9)`;
type ReopenOpt = Partial<{ id: string; db: string; from: number; to: number; reason: string; ver: string }>;
const insertReopen = (pool: Pool, subjectKey: string, attemptId: string, o: ReopenOpt = {}) => pool.query(REOPEN_SQL, [
    o.id ?? randomUUID(), OP, subjectKey, attemptId, o.db ?? "DB-1", o.from ?? 0, o.to ?? 1,
    o.reason ?? "PP-001 dihapus di Accurate oleh Finance", o.ver ?? '{"method":"manual_attestation"}']);
const postedAttempt = async (pool: Pool, subjectKey: string) => {
    const id = randomUUID();
    await pool.query(
        `INSERT INTO accurate_write_attempt (id, operation, subject_key, target_db_id, payload_hash, actor, state, accurate_id, accurate_number)
         VALUES ($1, $2, $3, 'DB-1', 'h', 'u', 'posted', '77', 'PP-001')`, [id, OP, subjectKey]);
    return id;
};

test("PG: C14 — klaim generasi 0 tanpa reopen; constraint DB menjaga generasi, reopen & index hidup per generasi", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 3 });
    const db = drizzle(pool);
    try {
        const subjectKey = `test|${randomUUID()}`;
        const first = await runGuardedWrite({ db, operation: OP, subjectKey, clientRef: "", targetDbId: "DB-1", actor: "u", payload: [item()],
            send: async () => ({ status: 200, text: ok() }) });
        assert.equal(first.claimed, true);
        const [row] = (await pool.query("SELECT id, generation, reopen_id FROM accurate_write_attempt WHERE subject_key = $1", [subjectKey])).rows;
        assert.deepEqual({ generation: row.generation, reopen_id: row.reopen_id }, { generation: 0, reopen_id: null });

        // Tabel reopen (rilis B nanti) — constraint inline yang dibuat otomatis.
        const reopen = (o: ReopenOpt = {}) => insertReopen(pool, subjectKey, row.id, o);
        assert.equal(await pgCode(reopen({ ver: "{}" })), "23514", "verification '{}' ditolak");
        assert.equal(await pgCode(reopen({ reason: "pendek" })), "23514", "alasan < 15 karakter ditolak");
        assert.equal(await pgCode(reopen({ to: 2 })), "23514", "to_generation harus from_generation + 1");
        assert.equal(await pgCode(reopen({ db: "DB-2" })), "23503", "DB target reopen harus sama dengan attempt asal (FK identitas)");
        assert.equal(await pgCode(reopen({ from: 1, to: 2 })), "23503", "generasi asal harus generasi attempt (FK identitas)");
        const reopenId = randomUUID();
        assert.equal(await pgCode(reopen({ id: reopenId })), "ok");
        assert.equal(await pgCode(reopen()), "23505", "satu reopen per attempt asal / per generasi");

        const ins = (gen: number, rid: string | null) => pool.query(
            `INSERT INTO accurate_write_attempt (id, operation, subject_key, target_db_id, payload_hash, actor, state, generation, reopen_id)
             VALUES ($1, $2, $3, 'DB-1', 'h', 'u', 'sending', $4, $5)`, [randomUUID(), OP, subjectKey, gen, rid]);
        assert.equal(await pgCode(ins(1, null)), "23514", "generasi > 0 tanpa reopen_id ditolak CHECK");
        assert.equal(await pgCode(ins(0, reopenId)), "23514", "generasi 0 dengan reopen_id ditolak CHECK");
        assert.equal(await pgCode(ins(-1, null)), "23514", "generasi negatif ditolak");
        assert.equal(await pgCode(ins(0, null)), "23505", "attempt hidup baru generasi 0 di samping posted generasi 0 = bentrok index");
        // Index hidup PER GENERASI: generasi 1 boleh hidup berdampingan dengan generasi 0 posted (rilis B).
        assert.equal(await pgCode(ins(1, reopenId)), "ok");
        assert.equal(await pgCode(ins(1, reopenId)), "23505", "dua attempt hidup generasi 1 ditolak");
    } finally {
        await pool.end();
    }
});

test("PG: C14 — subjek yang sudah dibuka ulang: kiriman biasa ditolak tanpa kirim; resolve hanya generasi terkini", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 3 });
    const db = drizzle(pool);
    const subjectKey = `test|${randomUUID()}`;
    try {
        const attemptId = await postedAttempt(pool, subjectKey);
        await insertReopen(pool, subjectKey, attemptId);
        const snap = async () => (await pool.query("SELECT row_to_json(a)::text AS j FROM accurate_write_attempt a WHERE id = $1", [attemptId])).rows[0].j;
        const before = await snap();
        let sends = 0;
        const r = await runGuardedWrite({ db, operation: OP, subjectKey, clientRef: "k", targetDbId: "DB-1", actor: "u", payload: [item()],
            send: async () => { sends += 1; return { status: 200, text: ok() }; } });
        assert.equal(sends, 0, "subjek dibuka ulang dikirim lewat jalur biasa");
        assert.equal(r.claimed, false);
        assert.equal(r.claimed === false && r.reopened, true);
        assert.equal(r.claimed === false && r.currentGeneration, 1);
        assert.equal(r.claimed === false && r.live, null, "attempt posted generasi lama tidak dilaporkan sebagai hasil kiriman ini");
        const resolved = await resolveAttempt({ db, operation: OP, subjectKey, decision: "absent", accurateNumber: "",
            reason: "dicek manual: tidak ada di daftar PP", checkedSource: "Accurate DB-1", actor: "spv", resolverDbId: "DB-1" });
        assert.equal(!resolved.ok && resolved.code, "no_open_attempt", "resolve menyentuh generasi lama");
        assert.equal(await snap(), before, "baris generasi 0 posted berubah");
        // Subjek TANPA reopen: 409 biasa membawa generasi 0 = generasi terkini (UI boleh merekonsiliasi posted).
        const plain = `test|${randomUUID()}`;
        await postedAttempt(pool, plain);
        const again = await runGuardedWrite({ db, operation: OP, subjectKey: plain, clientRef: "k", targetDbId: "DB-1", actor: "u", payload: [item()],
            send: async () => { sends += 1; return { status: 200, text: ok() }; } });
        assert.equal(sends, 0);
        assert.equal(again.claimed === false && again.reopened, false);
        assert.equal(again.claimed === false && again.live?.state, "posted");
        assert.equal(again.claimed === false && `${again.generation}/${again.currentGeneration}`, "0/0");
    } finally {
        await pool.end();
    }
});

// DDL manual ADR-004 (docs/handover/DDL_ADR004.sql) — dijalankan IT Support saat deploy, bukan migrate-pg. Uji ini
// melewat di DB yang belum menjalankannya; di DB yang sudah, membuktikan immutability & FK melingkar bekerja.
test("PG: DDL manual ADR-004 — posted/reopen immutable, transisi daftar putih, FK melingkar", { skip: pgSkip }, async (t) => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    try {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('trg_accurate_write_attempt_guard',
            'trg_accurate_write_attempt_no_truncate', 'trg_accurate_write_attempt_reopen_guard', 'trg_accurate_write_attempt_reopen_no_truncate')`);
        if (rows[0].n < 4) { t.skip("DDL manual ADR-004 belum dijalankan di DB ini (docs/handover/DDL_ADR004.sql)"); return; }
        const subjectKey = `test|${randomUUID()}`;
        const attemptId = await postedAttempt(pool, subjectKey);
        const q = (text: string, values: unknown[] = []) => pgCode(pool.query(text, values));
        assert.equal(await q("UPDATE accurate_write_attempt SET updated_at = now() WHERE id = $1", [attemptId]), "23001", "baris posted berubah");
        assert.equal(await q("DELETE FROM accurate_write_attempt WHERE id = $1", [attemptId]), "23001", "attempt terhapus");
        const row = async (state: string) => {
            const id = randomUUID();
            await pool.query(`INSERT INTO accurate_write_attempt (id, operation, subject_key, target_db_id, payload_hash, actor, state)
                VALUES ($1, $2, $3, 'DB-1', 'h', 'u', $4)`, [id, OP, `test|${randomUUID()}`, state]);
            return id;
        };
        const unk = await row("unknown");
        assert.equal(await q("UPDATE accurate_write_attempt SET state = 'rejected' WHERE id = $1", [unk]), "23001", "unknown -> rejected");
        assert.equal(await q("UPDATE accurate_write_attempt SET state = 'posted' WHERE id = $1", [unk]), "23001", "unknown -> posted tanpa resolution");
        assert.equal(await q("UPDATE accurate_write_attempt SET updated_at = now() WHERE id = $1", [unk]), "ok", "state sama boleh");
        assert.equal(await q(`UPDATE accurate_write_attempt SET state = 'posted', resolution = '{"by":"fin"}' WHERE id = $1`, [unk]), "ok");
        const snd = await row("sending");
        assert.equal(await q("UPDATE accurate_write_attempt SET actor = 'lain' WHERE id = $1", [snd]), "23001", "kolom identitas berubah");
        assert.equal(await q("UPDATE accurate_write_attempt SET state = 'resolved_absent' WHERE id = $1", [snd]), "23514", "resolved_absent tanpa resolution");
        assert.equal(await q("UPDATE accurate_write_attempt SET state = 'unknown' WHERE id = $1", [snd]), "ok", "sending -> apa pun");
        // Reopen: nomor lama harus sama dengan attempt asal; sesudah tercatat tidak bisa diubah/dihapus.
        assert.equal(await q(REOPEN_SQL.replace("'PP-001'", "'PP-LAIN'"), [randomUUID(), OP, subjectKey, attemptId, "DB-1", 0, 1,
            "PP-001 dihapus di Accurate oleh Finance", '{"method":"manual_attestation"}']), "23514", "nomor lama beda");
        const reopenId = randomUUID();
        assert.equal(await pgCode(insertReopen(pool, subjectKey, attemptId, { id: reopenId })), "ok");
        assert.equal(await q("UPDATE accurate_write_attempt_reopen SET reason = reason || '!' WHERE id = $1", [reopenId]), "23001");
        assert.equal(await q("DELETE FROM accurate_write_attempt_reopen WHERE id = $1", [reopenId]), "23001");
        // FK melingkar: generasi 1 hanya dengan reopen subjek/generasi/DB yang sama.
        const gen1 = (rid: string, db = "DB-1") => q(`INSERT INTO accurate_write_attempt (id, operation, subject_key, target_db_id,
            payload_hash, actor, state, generation, reopen_id) VALUES ($1, $2, $3, $4, 'h', 'u', 'sending', 1, $5)`, [randomUUID(), OP, subjectKey, db, rid]);
        assert.equal(await gen1(randomUUID()), "23503", "reopen_id tak dikenal");
        assert.equal(await gen1(reopenId, "DB-2"), "23503", "DB beda dari reopen");
        assert.equal(await gen1(reopenId), "ok");
        const c = await pool.connect();
        try {
            await c.query("BEGIN");
            const code = await pgCode(c.query("TRUNCATE accurate_write_attempt_reopen"));
            assert.ok(code === "23001" || code === "0A000", `TRUNCATE reopen lolos (${code})`);
        } finally {
            await c.query("ROLLBACK");
            c.release();
        }
    } finally {
        await pool.end();
    }
});
