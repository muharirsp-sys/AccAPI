import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST(request: Request) {
    try {
        const forwardedFor = request.headers.get("x-forwarded-for");
        const realIp = request.headers.get("x-real-ip");
        const clientIp = forwardedFor ? forwardedFor.split(",")[0].trim() : (realIp || "unknown");

        const allowedIps = ["202.78.195.250", "163.61.77.2", "127.0.0.1", "::1"];
        if (clientIp !== "unknown" && !allowedIps.includes(clientIp)) {
            console.warn(`[WEBHOOK BLOCKED] Unauthorized IP: ${clientIp}`);
            return NextResponse.json({ error: "Unauthorized IP Address" }, { status: 403 });
        }

        const payload = await request.json();

        console.log("----------------------------------------");
        console.log("[WEBHOOK ACCURATE DITERIMA]");

        const logFilePath = path.join(process.cwd(), 'webhook_events.log');
        const timestamp = new Date().toISOString();
        const logEntry = {
            receivedAt: timestamp,
            clientIp,
            payload
        };

        fs.appendFileSync(logFilePath, JSON.stringify(logEntry) + "\n", 'utf8');
        console.log(`[+] Disimpan ke webhook_events.log`);

        if (Array.isArray(payload)) {
            payload.forEach((event: { eventType?: unknown; module?: unknown }) => {
                console.log(`>> Event: ${event?.eventType || 'UNKNOWN'} | Modul: ${event?.module || 'N/A'}`);
            });
        }

        console.log("----------------------------------------");

        return NextResponse.json({ success: true, message: "Webhook processed" }, { status: 200 });
    } catch (err: unknown) {
        console.error("[WEBHOOK ERROR]:", err instanceof Error ? err.message : err);
        return NextResponse.json({ error: "Gagal memproses webhook" }, { status: 500 });
    }
}
