/*
 * Tujuan: Terima webhook Accurate dan segarkan cache faktur penjualan (Accurate -> sales_invoice).
 * Caller: Accurate Online (push, bukan request user). Hanya modul "Faktur Penjualan" yang di-subscribe.
 * Dependensi: lib/accurate-session (kredensial non-interaktif), lib/sync (upsert faktur).
 * Side Effects: append webhook_events.log + upsert tabel sales_invoice.
 */
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { resolveSyncCredentials } from '@/lib/accurate-session';
import { upsertSalesInvoiceById } from '@/lib/sync';

// Bentuk payload dibuktikan live 2026-08-11 (webhook_events.log production): array envelope
// { databaseId, type: "SALES_INVOICE", timestamp, uuid, data: [{ salesInvoiceId, salesInvoiceNo,
// isDownPayment, salesInvoiceTotalAmount, action: "WRITE" }] } — BUKAN { eventType, module, id }
// seperti tebakan awal. `data` adalah array (bisa >1 baris per envelope).
function flattenSalesInvoiceIds(payload: unknown): number[] {
    const envelopes = (Array.isArray(payload) ? payload : [payload]) as Array<{
        type?: string;
        data?: Array<{ salesInvoiceId?: unknown }>;
    }>;
    const ids: number[] = [];
    for (const envelope of envelopes) {
        if (envelope?.type !== "SALES_INVOICE") continue;
        for (const record of envelope?.data ?? []) {
            const id = Number(record?.salesInvoiceId);
            if (Number.isFinite(id) && id > 0) ids.push(id);
        }
    }
    return ids;
}

export async function POST(request: Request) {
    try {
        const forwardedFor = request.headers.get("x-forwarded-for");
        const realIp = request.headers.get("x-real-ip");
        const clientIp = forwardedFor ? forwardedFor.split(",")[0].trim() : (realIp || "unknown");

        const allowedIps = ["202.78.195.250", "163.61.77.2", "127.0.0.1", "::1"];
        // Fail-closed: IP "unknown" (header XFF/real-ip absen) ditolak, bukan di-bypass.
        if (!allowedIps.includes(clientIp)) {
            console.warn(`[WEBHOOK BLOCKED] Unauthorized IP: ${clientIp}`);
            return NextResponse.json({ error: "Unauthorized IP Address" }, { status: 403 });
        }

        const payload = await request.json();

        console.log("----------------------------------------");
        console.log("[WEBHOOK ACCURATE DITERIMA]");

        // process.cwd() (/app) TIDAK persisten — hanya /app/data yang di-mount volume (docker-compose.yml).
        // BETTER_AUTH_DB_PATH terbukti TIDAK di-set di production (env kosong), jadi cek langsung
        // keberadaan direktori volumenya daripada bergantung ke env yang mungkin tidak ada.
        const logDir = fs.existsSync('/app/data') ? '/app/data' : process.cwd();
        const logFilePath = path.join(logDir, 'webhook_events.log');
        const timestamp = new Date().toISOString();
        const logEntry = {
            receivedAt: timestamp,
            clientIp,
            payload
        };

        // Cap per-entry agar payload jumbo tak membengkakkan disk dalam satu hit.
        // Raw payload ditulis SEBELUM diproses: kalau pemrosesan gagal, event tidak hilang.
        const entry = JSON.stringify(logEntry);
        fs.appendFileSync(logFilePath, (entry.length > 100_000 ? entry.slice(0, 100_000) : entry) + "\n", 'utf8');
        console.log(`[+] Disimpan ke webhook_events.log`);

        const invoiceIds = flattenSalesInvoiceIds(payload);
        console.log(`>> ${invoiceIds.length} faktur penjualan terdeteksi: ${invoiceIds.join(", ") || "(tidak ada — payload bukan tipe SALES_INVOICE atau kosong)"}`);

        const accurate = await resolveSyncCredentials();
        if (!accurate.creds) {
            console.error(`[WEBHOOK] Kredensial Accurate tidak siap: ${accurate.error}`);
            return NextResponse.json({ error: accurate.error }, { status: 503 });
        }

        // ponytail: sekuensial tanpa antrean. Satu event = satu detail.do (~<1s), dan hanya
        // "Faktur Penjualan" yang aktif — jadi burst-nya kecil. Pindah ke worker/outbox kalau
        // nanti batch per webhook membesar atau modul lain ikut diaktifkan.
        const processed: unknown[] = [];
        const failed: Array<{ id: number; error: string }> = [];
        for (const id of invoiceIds) {
            try {
                const summary = await upsertSalesInvoiceById(id, accurate.creds);
                console.log(`[+] Faktur tersimpan: ${summary.number ?? id} | ${summary.customerName ?? '-'} | total ${summary.totalAmount} | sisa ${summary.outstanding} | ${summary.status ?? '-'}`);
                processed.push(summary);
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                console.error(`[WEBHOOK] Gagal proses faktur ${id}: ${message}`);
                failed.push({ id, error: message });
            }
        }

        console.log("----------------------------------------");

        // Gagal sebagian -> 502 supaya tercatat di webhook-history.do Accurate dan bisa dikirim
        // ulang. Upsert idempoten, jadi pengiriman ulang tidak menggandakan data.
        return NextResponse.json(
            { success: failed.length === 0, processed, failed },
            { status: failed.length === 0 ? 200 : 502 }
        );
    } catch (err: unknown) {
        console.error("[WEBHOOK ERROR]:", err instanceof Error ? err.message : err);
        return NextResponse.json({ error: "Gagal memproses webhook" }, { status: 500 });
    }
}
