/*
 * Tujuan: Tambal faktur yang event webhook-nya PERNAH TIBA tapi barisnya tidak ada di DB.
 *   Dibuktikan live 2026-08-21: INV/2608/VI00275 (id 314414) dan INV/2608/M200655 (id 314662)
 *   tercatat di webhook_events.log tapi tidak pernah tersimpan. Tanpa ini, faktur seperti itu
 *   baru muncul saat cron sync menyapu seluruh 2.000 halaman — bisa berjam-jam kemudian.
 * Caller: cron VPS (Bearer CRON_SECRET). `?check=1` hanya melaporkan, tidak mengubah apa pun.
 * Dependensi: webhook_events.log, lib/accurate-webhook (ekstraksi id), lib/sync (upsert), RBAC cron.
 * Main Functions: GET memilih log runtime, menemukan invoice hilang, dan menambalnya dengan batas per run.
 * Side Effects: upsert baris sales_invoice yang hilang ATAU tersimpan tanpa rincian baris
 *   (`detailItem`). Idempoten — aman diulang. `?from=&to=` (yyyy-MM-dd) menyapu yang tanpa rincian per tanggal faktur.
 *
 * Kenapa berbasis log, bukan menyapu Accurate: log sudah menyimpan TEPAT id mana yang pernah
 * dikirim Accurate, jadi penambalan ini hanya menyentuh faktur yang benar-benar hilang. Jauh
 * lebih murah daripada sync penuh, sehingga boleh dijalankan tiap jam.
 */
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { and, asc, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { salesInvoiceCache } from "@/db/schema";
import { requireCronSecret } from "@/lib/api-security";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { extractLoggedInvoiceIdsSince } from "@/lib/accurate-webhook";
import { AccurateInvoiceGoneError, upsertSalesInvoiceById } from "@/lib/sync";

export const runtime = "nodejs";
export const maxDuration = 3600;

// Batas per panggilan supaya satu run tidak menghabiskan rate limit Accurate. Sisanya tertangani
// panggilan berikutnya (id yang sudah masuk otomatis tidak terhitung hilang lagi).
const DEFAULT_LIMIT = 200;

// Hanya event beberapa hari terakhir. Log menyimpan seluruh riwayat dan mayoritas id lama sudah
// DIHAPUS di Accurate (1.189 dari 15.436 per 2026-08-21, semuanya balas "respons tanpa data"),
// jadi tanpa batas ini penambal membakar panggilan API untuk faktur yang tidak akan pernah ada.
// Faktur lama yang benar-benar hilang tetap tertangani cron sync penuh 4x/hari.
const DEFAULT_HOURS = 48;

export async function GET(req: Request) {
    const gate = requireCronSecret(req);
    if (gate.response) return gate.response;

    const { searchParams } = new URL(req.url);
    const checkOnly = searchParams.get("check") === "1";
    const hours = Math.min(Math.max(Number(searchParams.get("hours")) || DEFAULT_HOURS, 1), 24 * 365);
    const limit = Math.min(Math.max(Number(searchParams.get("limit")) || DEFAULT_LIMIT, 1), 2000);
    // `?jeda=` ms antar panggilan detail.do (0..2000, bawaan 150): perlambat untuk tambalan massal di jam kerja.
    const jedaParam = Number(searchParams.get("jeda"));
    const jedaMs = Number.isFinite(jedaParam) && searchParams.has("jeda") ? Math.min(Math.max(jedaParam, 0), 2000) : 150;

    // `?from=2026-09-01&to=2026-09-30`: faktur TERSIMPAN tanpa rincian baris pada rentang tanggal
    // faktur itu, semua principal — tidak lewat log. Sebelum penjagaan di lib/sync (2026-09-12
    // 09:19), sync cron menimpa `raw_data` hasil webhook dengan jawaban list.do yang tidak membawa
    // `detailItem`. Rinciannya hilang, barisnya tetap ada, jadi penambal "yang hilang" di bawah tidak
    // pernah menyentuhnya: 280 faktur KINO bertanggal 1-11 Sep 2026 (Rp 1,46 miliar, diukur 25 Sep) tak terbaca
    // Rekap Promo, dan 57 di antaranya tidak tercatat di log webhook sama sekali.
    // ponytail: rentang dibatasi 93 hari; faktur lama banyak yang sudah dihapus di Accurate dan
    // hanya membakar panggilan API. Perlebar bila memang perlu menambal satu kuartal lebih.
    // `?hantu=1`: periksa ulang calon faktur hantu — semua yang bukan INV/ (draf DFT.*, RJN/) dan
    // nomor INV yang tersimpan di lebih dari satu id (dihapus lalu dibuat ulang dengan nomor sama).
    // detail.do per id; yang terbukti tiada dibuang oleh upsertSalesInvoiceById, yang hidup disegarkan.
    // Probe 15 Okt 2026: 164 baris (55 DFT Agu–Sep + 6 id INV lama), sisa ±Rp 86 jt. Jalankan `?check=1` dulu.
    // ponytail: calon dipilih dari pola, bukan dari selisih sapuan list.do penuh — paging offset Accurate
    // bisa melompati baris saat data berubah, jadi "tidak terlihat di sync" bukan bukti terhapus.
    if (searchParams.get("hantu") === "1") {
        const rows = await db.execute(sql`SELECT id FROM sales_invoice
            WHERE number IS NULL OR number NOT LIKE 'INV/%'
               OR number IN (SELECT number FROM sales_invoice WHERE number LIKE 'INV/%' GROUP BY number HAVING count(*) > 1)
            ORDER BY id`);
        const ids = (rows.rows as Array<{ id: number | string }>).map((row) => Number(row.id));
        if (checkOnly || ids.length === 0) return NextResponse.json({ ok: true, checkOnly, hantu: true, calon: ids.length, calonIds: ids.slice(0, 200) });
        const hasil = await tambal(ids, limit, jedaMs);
        return NextResponse.json({ hantu: true, ...hasil }, { status: "error" in hasil ? 503 : 200 });
    }

    const from = searchParams.get("from") ?? "";
    const to = searchParams.get("to") ?? "";
    if (from || to) {
        const iso = /^\d{4}-\d{2}-\d{2}$/;
        const hari = (Date.parse(to) - Date.parse(from)) / 86_400_000;
        if (!iso.test(from) || !iso.test(to) || !(hari >= 0 && hari <= 93)) {
            return NextResponse.json({ ok: false, error: "from dan to wajib yyyy-MM-dd, from <= to, paling lebar 93 hari" }, { status: 400 });
        }
        const rows = await db.select({ id: salesInvoiceCache.id }).from(salesInvoiceCache)
            .where(and(
                sql`to_date(${salesInvoiceCache.transDate}, 'DD/MM/YYYY') between ${from}::date and ${to}::date`,
                sql`${salesInvoiceCache.rawData}::text not like '%detailItem%'`,
            ))
            .orderBy(asc(salesInvoiceCache.id));
        const ids = rows.map((row) => row.id);
        if (checkOnly || ids.length === 0) return NextResponse.json({ ok: true, checkOnly, from, to, missing: ids.length });
        const hasil = await tambal(ids, limit, jedaMs);
        return NextResponse.json({ from, to, ...hasil }, { status: "error" in hasil ? 503 : 200 });
    }

    // Sama seperti route webhook: hanya /app/data yang persisten (volume docker-compose).
    const logDir = fs.existsSync("/app/data") ? "/app/data" : process.cwd();
    const files = [path.join(logDir, "webhook_events.log"), path.join(logDir, "webhook_events.log.1")]
        .filter((f) => fs.existsSync(/* turbopackIgnore: true */ f));
    if (files.length === 0) {
        return NextResponse.json({ ok: false, error: `webhook_events.log tidak ditemukan di ${logDir}` }, { status: 404 });
    }

    // Batasi ke jendela `hours`: log menyimpan seluruh riwayat dan mayoritas id lama sudah
    // dihapus di Accurate, jadi tanpa batas ini penambal mengejar faktur yang tidak ada lagi.
    const sinceMs = Date.now() - hours * 60 * 60 * 1000;
    const loggedIds = extractLoggedInvoiceIdsSince(
        files.map((f) => fs.readFileSync(f, "utf8")).join("\n"),
        sinceMs,
    );
    if (loggedIds.length === 0) {
        return NextResponse.json({ ok: true, hours, loggedIds: 0, missing: 0, processed: [], failed: [] });
    }

    // Chunk 1000 id per query — batas parameter Postgres, bukan pilihan gaya.
    // "Ada" = tersimpan DENGAN rincian baris. Baris tanpa `detailItem` sama saja hilang bagi Rekap
    // Promo dan verifikasi balik. Itu bisa terjadi bila detail.do gagal saat webhook lalu sync cron
    // menyimpan barisnya dari list.do — tanpa ini ia tidak pernah diambil ulang.
    const present = new Set<number>();
    for (let i = 0; i < loggedIds.length; i += 1000) {
        const rows = await db
            .select({ id: salesInvoiceCache.id })
            .from(salesInvoiceCache)
            .where(and(inArray(salesInvoiceCache.id, loggedIds.slice(i, i + 1000)),
                sql`${salesInvoiceCache.rawData}::text like '%detailItem%'`));
        for (const r of rows) present.add(r.id);
    }

    const missing = loggedIds.filter((id) => !present.has(id));
    if (checkOnly || missing.length === 0) {
        return NextResponse.json({
            ok: true,
            checkOnly,
            hours,
            loggedIds: loggedIds.length,
            missing: missing.length,
            missingIds: missing.slice(0, 50),
        });
    }

    const hasil = await tambal(missing, limit, jedaMs);
    return NextResponse.json({ hours, loggedIds: loggedIds.length, ...hasil }, { status: "error" in hasil ? 503 : 200 });
}

const tidur = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Satu panggilan detail.do dengan jeda sesudahnya, dan coba ulang bila Accurate membalas 429.
 * Tanpa jeda, penambal beruntun ±5 permintaan/detik pada token sinkron dan Accurate menolak sebagian
 * (14 Okt 2026: 8 dari 2.000 saat jam kerja). Batas resmi Accurate tak terdokumentasi — jeda 150 ms
 * sama dengan lib/sync. ponytail: backoff tetap 2/4/8 dtk, tidak membaca Retry-After.
 */
async function denganJeda<T>(fn: () => Promise<T>, jedaMs: number): Promise<T> {
    for (let coba = 0; ; coba++) {
        try {
            const hasil = await fn();
            await tidur(jedaMs);
            return hasil;
        } catch (e) {
            if (coba >= 3 || !/HTTP 429/.test(e instanceof Error ? e.message : String(e))) throw e;
            await tidur(2000 * 2 ** coba);
        }
    }
}

/** Ambil ulang `detail.do` untuk `ids` (paling banyak `limit`) dan simpan; dipakai kedua mode. */
async function tambal(ids: number[], limit: number, jedaMs: number) {
    const accurate = await resolveSyncCredentials();
    if (!accurate.creds) return { ok: false, error: accurate.error, missing: ids.length };

    const processed: unknown[] = [];
    const gone: number[] = [];
    const failed: Array<{ id: number; error: string }> = [];
    for (const id of ids.slice(0, limit)) {
        try {
            const summary = await denganJeda(() => upsertSalesInvoiceById(id, accurate.creds), jedaMs);
            console.log(`[BACKFILL] Faktur ditambal: ${summary.number ?? id} | ${summary.customerName ?? "-"} | total ${summary.totalAmount} | sisa ${summary.outstanding}`);
            processed.push(summary);
        } catch (e) {
            // Faktur yang sudah dihapus di Accurate BUKAN kegagalan — kondisi normal, dan
            // menghitungnya sebagai error membuat cron berisik setiap jam tanpa ada yang bisa
            // diperbaiki. Dipisah supaya `ok` hanya false kalau ada masalah sungguhan.
            if (e instanceof AccurateInvoiceGoneError) {
                gone.push(id);
                continue;
            }
            const message = e instanceof Error ? e.message : String(e);
            console.error(`[BACKFILL] Gagal menambal faktur ${id}: ${message}`);
            failed.push({ id, error: message });
        }
    }

    console.log(`[BACKFILL] ${processed.length} ditambal, ${gone.length} sudah dihapus di Accurate, ${failed.length} gagal, ${Math.max(0, ids.length - limit)} sisa`);
    return {
        ok: failed.length === 0,
        missing: ids.length,
        remaining: Math.max(0, ids.length - limit),
        processed,
        gone,
        failed,
    };
}
