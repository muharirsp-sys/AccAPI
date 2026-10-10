/* S6-0e butir 6: GET /api/finance/purchase-payment/attempts — BACA-SAJA status attempt per kelompok Finance.
 * Bagian 1 tanpa DB: izin finance.view, validasi parameter, pemetaan status. Bagian 2 butuh Postgres EVALUASI
 * (AM040_DATABASE_URL, bukan produksi): attempt terbaru per subjek, basi menurut jam DB, nama aktor, kunci subjek
 * sama dengan POST (rekonsiliasi lama). Tanpa env itu bagian 2 dilewati dengan sebabnya. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { GET as getAttempts } from "../app/api/finance/purchase-payment/attempts/route.ts";
import { attemptStatus, latestAttemptsBySubject, PURCHASE_PAYMENT_OPERATION, purchasePaymentSubject } from "./accurate-write-attempt.ts";
import { auth } from "./auth.ts";
import { db } from "./db.ts";

/** Sesi & grup dipalsukan (tanpa bypass lokal); DB lain dan jaringan DILARANG. */
async function asUserWith<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const saved = [
        [auth.api, "getSession", Object.getOwnPropertyDescriptor(auth.api, "getSession")],
        [db, "select", Object.getOwnPropertyDescriptor(db, "select")],
        [globalThis, "fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch")],
    ] as const;
    const env = process.env.LOCAL_AUTH_BYPASS;
    delete process.env.LOCAL_AUTH_BYPASS;
    Object.defineProperty(auth.api, "getSession", { configurable: true, value: async () => ({ user: { id: "u-fin", role: "staff" }, session: { id: "s1" } }) });
    const rows = keys.map((key) => ({ groupId: "g1", key }));
    // getUserPermissions = select().from().leftJoin().where(); query attempt (select().from().leftJoin().where().orderBy()) melempar.
    Object.defineProperty(db, "select", { configurable: true, value: () => ({ from: () => ({ leftJoin: () => ({ where: () => Object.assign(Promise.resolve(rows), { orderBy: () => { throw new Error("DB attempt tidak tersedia di uji ini"); } }) }) }) }) });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => { throw new Error("TIDAK BOLEH ke jaringan"); } });
    try {
        return await fn();
    } finally {
        for (const [obj, k, d] of saved) {
            if (d) Object.defineProperty(obj, k, d);
            else delete (obj as unknown as Record<string, unknown>)[k];
        }
        if (env === undefined) delete process.env.LOCAL_AUTH_BYPASS;
        else process.env.LOCAL_AUTH_BYPASS = env;
    }
}

const get = (qs: string) => new NextRequest(`http://app.test/api/finance/purchase-payment/attempts${qs}`);

test("attempts: tanpa finance.view -> 403 {ok:false} berpesan Indonesia; parameter kosong -> 400 sebelum DB; DB gagal -> 503", async () => {
    const denied = await asUserWith(["finance.update", "finance.resolve_unknown"], () => getAttempts(get("?invoices=INV-1")));
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { ok: false, error: "Butuh izin finance.view." });

    const empty = await asUserWith(["finance.view"], () => getAttempts(get("?invoices=%20,%20")));
    assert.equal(empty.status, 400);
    assert.match(String((await empty.json() as { error: string }).error), /invoices wajib/);

    const many = await asUserWith(["finance.view"], () => getAttempts(get(`?${Array.from({ length: 101 }, (_, i) => `invoices=I${i}`).join("&")}`)));
    assert.equal(many.status, 400);

    const down = await asUserWith(["finance.view"], () => getAttempts(get("?invoices=INV-1")));
    assert.equal(down.status, 503);
    assert.equal((await down.json() as { ok: boolean }).ok, false);
});

test("attemptStatus: sending basi -> stale; ditolak/tak terhubung/diatestasi tidak ada -> failed", () => {
    assert.equal(attemptStatus("sending", false), "sending");
    assert.equal(attemptStatus("sending", true), "stale");
    assert.equal(attemptStatus("posted", true), "posted");
    assert.equal(attemptStatus("unknown", false), "unknown");
    for (const s of ["rejected", "not_sent", "resolved_absent"]) assert.equal(attemptStatus(s, false), "failed");
});

const PG_URL = process.env.AM040_DATABASE_URL ?? "";
const pgSkip = PG_URL ? false : "AM040_DATABASE_URL tidak di-set (Postgres evaluasi lokal AM-040)";

test("PG: attempt TERBARU per subjek, basi menurut jam DB, nama aktor, kunci subjek = POST", { skip: pgSkip }, async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2 });
    const pg = drizzle(pool);
    const tag = randomUUID().slice(0, 8);
    const userId = `u-${tag}`;
    const subj = (...invoices: string[]) => purchasePaymentSubject({ detailInvoice: invoices.map((invoiceNo) => ({ invoiceNo, paymentAmount: 1 })) });
    const insert = (subject: string, state: string, extra = "") => pool.query(
        `INSERT INTO accurate_write_attempt (id, operation, subject_key, target_db_id, payload_hash, actor, state, accurate_number, created_at, updated_at)
         VALUES ($1, $2, $3, 'DB-7', 'h', $4, $5, $6, now() ${extra}, now() ${extra})`,
        [randomUUID(), PURCHASE_PAYMENT_OPERATION, subject, userId, state, state === "posted" ? `PP-${tag}` : ""]);
    try {
        await pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, 'Finance Uji', $2, true, now(), now())`,
            [userId, `${tag}@x.test`]);
        const fresh = subj(`A-${tag}`), stale = subj(`B-${tag}`), posted = subj(`C-${tag}`, `c2-${tag}`), again = subj(`D-${tag}`), none = subj(`E-${tag}`);
        await insert(fresh, "sending");
        await insert(stale, "sending", "- interval '3 minutes'");
        await insert(posted, "posted");
        // Attempt lama 'rejected' lalu attempt baru 'unknown' -> yang tampil yang TERBARU.
        await insert(again, "rejected", "- interval '10 minutes'");
        await insert(again, "unknown");
        const map = await latestAttemptsBySubject(pg, PURCHASE_PAYMENT_OPERATION, [fresh, stale, posted, again, none]);
        assert.equal(attemptStatus(map.get(fresh)!.state, map.get(fresh)!.stale), "sending");
        assert.equal(attemptStatus(map.get(stale)!.state, map.get(stale)!.stale), "stale");
        assert.ok(map.get(stale)!.ageSeconds >= 170, `umur jam DB: ${map.get(stale)!.ageSeconds}`);
        assert.equal(map.get(posted)!.accurateNumber, `PP-${tag}`);
        assert.equal(map.get(posted)!.actorName, "Finance Uji");
        assert.equal(map.get(posted)!.targetDbId, "DB-7");
        assert.equal(map.get(again)!.state, "unknown");
        assert.equal(map.has(none), false);
        // Kunci subjek route = kunci POST (urutan & huruf faktur tidak berpengaruh).
        assert.equal(subj(`c2-${tag}`, `C-${tag}`), posted);
    } finally {
        await pool.query("DELETE FROM accurate_write_attempt WHERE actor = $1 AND state <> 'posted'", [userId]).catch(() => undefined);
        await pool.query(`DELETE FROM "user" WHERE id = $1`, [userId]).catch(() => undefined);
        await pool.end();
    }
});
