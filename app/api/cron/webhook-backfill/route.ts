/*
 * Tujuan: Tambal faktur yang event webhook-nya PERNAH TIBA tapi barisnya tidak ada di DB.
 *   Dibuktikan live 2026-08-21: INV/2608/VI00275 (id 314414) dan INV/2608/M200655 (id 314662)
 *   tercatat di webhook_events.log tapi tidak pernah tersimpan. Tanpa ini, faktur seperti itu
 *   baru muncul saat cron sync menyapu seluruh 2.000 halaman — bisa berjam-jam kemudian.
 * Caller: cron VPS (Bearer CRON_SECRET). `?check=1` hanya melaporkan, tidak mengubah apa pun.
 * Dependensi: webhook_events.log, lib/accurate-webhook (ekstraksi id), lib/sync (upsert), RBAC cron.
 * Side Effects: upsert baris sales_invoice yang hilang. Idempoten — aman diulang.
 *
 * Kenapa berbasis log, bukan menyapu Accurate: log sudah menyimpan TEPAT id mana yang pernah
 * dikirim Accurate, jadi penambalan ini hanya menyentuh faktur yang benar-benar hilang. Jauh
 * lebih murah daripada sync penuh, sehingga boleh dijalankan tiap jam.
 */
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesInvoiceCache } from "@/db/schema";
import { requireCronSecret } from "@/lib/api-security";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { extractLoggedInvoiceIds } from "@/lib/accurate-webhook";
import { upsertSalesInvoiceById } from "@/lib/sync";

export const runtime = "nodejs";
export const maxDuration = 3600;

// Batas per panggilan supaya satu run tidak menghabiskan rate limit Accurate. Sisanya tertangani
// panggilan berikutnya (id yang sudah masuk otomatis tidak terhitung hilang lagi).
const DEFAULT_LIMIT = 200;

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;

    const { searchParams } = new URL(req.url);
    const checkOnly = searchParams.get("check") === "1";
    const limit = Math.min(Math.max(Number(searchParams.get("limit")) || DEFAULT_LIMIT, 1), 2000);

    // Sama seperti route webhook: hanya /app/data yang persisten (volume docker-compose).
    const logDir = fs.existsSync("/app/data") ? "/app/data" : process.cwd();
    const files = [path.join(logDir, "webhook_events.log"), path.join(logDir, "webhook_events.log.1")]
        .filter((f) => fs.existsSync(f));
    if (files.length === 0) {
        return NextResponse.json({ ok: false, error: `webhook_events.log tidak ditemukan di ${logDir}` }, { status: 404 });
    }

    const loggedIds = extractLoggedInvoiceIds(files.map((f) => fs.readFileSync(f, "utf8")).join("\n"));
    if (loggedIds.length === 0) {
        return NextResponse.json({ ok: true, loggedIds: 0, missing: 0, processed: [], failed: [] });
    }

    // Chunk 1000 id per query — batas parameter Postgres, bukan pilihan gaya.
    const present = new Set<number>();
    for (let i = 0; i < loggedIds.length; i += 1000) {
        const rows = await db
            .select({ id: salesInvoiceCache.id })
            .from(salesInvoiceCache)
            .where(inArray(salesInvoiceCache.id, loggedIds.slice(i, i + 1000)));
        for (const r of rows) present.add(r.id);
    }

    const missing = loggedIds.filter((id) => !present.has(id));
    if (checkOnly || missing.length === 0) {
        return NextResponse.json({
            ok: true,
            checkOnly,
            loggedIds: loggedIds.length,
            missing: missing.length,
            missingIds: missing.slice(0, 50),
        });
    }

    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) {
        return NextResponse.json({ ok: false, error: accurate.error }, { status: 503 });
    }

    const processed: unknown[] = [];
    const failed: Array<{ id: number; error: string }> = [];
    for (const id of missing.slice(0, limit)) {
        try {
            const summary = await upsertSalesInvoiceById(id, accurate.creds);
            console.log(`[BACKFILL] Faktur ditambal: ${summary.number ?? id} | ${summary.customerName ?? "-"} | total ${summary.totalAmount} | sisa ${summary.outstanding}`);
            processed.push(summary);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`[BACKFILL] Gagal menambal faktur ${id}: ${message}`);
            failed.push({ id, error: message });
        }
    }

    console.log(`[BACKFILL] ${processed.length} ditambal, ${failed.length} gagal, ${Math.max(0, missing.length - limit)} sisa untuk run berikutnya`);
    return NextResponse.json({
        ok: failed.length === 0,
        loggedIds: loggedIds.length,
        missing: missing.length,
        remaining: Math.max(0, missing.length - limit),
        processed,
        failed,
    });
}
