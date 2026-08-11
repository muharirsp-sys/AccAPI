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

// Bentuk payload Accurate belum pernah kita lihat langsung, jadi id dicari di beberapa nama
// yang mungkin. Kalau tak ketemu, event dilewati dan raw payload tetap ada di log untuk dibaca.
function extractInvoiceId(event: Record<string, unknown>): number | null {
    const raw = event.id ?? event.objectId ?? event.transactionId
        ?? (event.data as Record<string, unknown> | undefined)?.id;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
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

        // process.cwd() (/app) TIDAK persisten — hanya /app/data yang di-mount volume. Ikut
        // lokasi DB auth supaya log selamat dari redeploy; fallback cwd untuk dev lokal.
        const logDir = process.env.BETTER_AUTH_DB_PATH ? path.dirname(process.env.BETTER_AUTH_DB_PATH) : process.cwd();
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

        const events: Array<Record<string, unknown>> = Array.isArray(payload) ? payload : [payload];
        for (const event of events) {
            console.log(`>> Event: ${event?.eventType || 'UNKNOWN'} | Modul: ${event?.module || 'N/A'}`);
        }

        const accurate = await resolveSyncCredentials();
        if (!accurate.creds) {
            console.error(`[WEBHOOK] Kredensial Accurate tidak siap: ${accurate.error}`);
            return NextResponse.json({ error: accurate.error }, { status: 503 });
        }

        // ponytail: sekuensial tanpa antrean. Satu event = satu detail.do (~<1s), dan hanya
        // "Faktur Penjualan" yang aktif — jadi burst-nya kecil. Pindah ke worker/outbox kalau
        // nanti batch per webhook membesar atau modul lain ikut diaktifkan.
        const processed: unknown[] = [];
        const failed: Array<{ event: unknown; error: string }> = [];
        for (const event of events) {
            const id = extractInvoiceId(event);
            if (id === null) {
                failed.push({ event, error: "id faktur tidak ditemukan di payload" });
                continue;
            }
            try {
                const summary = await upsertSalesInvoiceById(id, accurate.creds);
                console.log(`[+] Faktur tersimpan: ${summary.number ?? id} | ${summary.customerName ?? '-'} | total ${summary.totalAmount} | sisa ${summary.outstanding} | ${summary.status ?? '-'}`);
                processed.push(summary);
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                console.error(`[WEBHOOK] Gagal proses faktur ${id}: ${message}`);
                failed.push({ event, error: message });
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
