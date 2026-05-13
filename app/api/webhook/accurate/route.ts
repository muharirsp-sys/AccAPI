import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST(request: Request) {
    try {
        // 1. IP Whitelisting (Kebijakan Accurate 26 Feb 2026)
        const forwardedFor = request.headers.get("x-forwarded-for");
        const realIp = request.headers.get("x-real-ip");
        const clientIp = forwardedFor ? forwardedFor.split(",")[0].trim() : (realIp || "unknown");

        const allowedIps = ["202.78.195.250", "163.61.77.2", "127.0.0.1", "::1"]; // Termasuk localhost utk testing
        if (clientIp !== "unknown" && !allowedIps.includes(clientIp)) {
            console.warn(`[WEBHOOK BLOCKED] Unauthorized IP: ${clientIp}`);
            // Uncomment baris di bawah ini jika aplikasi sudah di-deploy ke production (VPS/Vercel)
            // return NextResponse.json({ error: "Unauthorized IP Address" }, { status: 403 });
        }

        // 2. Tangkap Body Webhook dari Accurate
        const payload = await request.json();

        // Accurate biasanya mengirim list objek jika terjadi aksi bulk
        console.log("----------------------------------------");
        console.log("🔔 [WEBHOOK ACCURATE DITERIMA]");

        // Simpan log ke file lokal di root folder project
        const logFilePath = path.join(process.cwd(), 'webhook_events.log');
        const timestamp = new Date().toISOString();
        const logEntry = {
            receivedAt: timestamp,
            clientIp,
            payload
        };

        fs.appendFileSync(logFilePath, JSON.stringify(logEntry) + "\n", 'utf8');
        console.log(`[+] Disimpan ke webhook_events.log`);

        // Contoh pembacaan sederhana jika payload berbentuk array (umumnya Accurate webhooks berupa array of events)
        if (Array.isArray(payload)) {
            payload.forEach((event: any) => {
                console.log(`>> Event: ${event?.eventType || 'UNKNOWN'} | Modul: ${event?.module || 'N/A'}`);
            });
        }

        console.log("----------------------------------------");

        // 3. Wajib balas 200 OK ke Accurate
        return NextResponse.json({ success: true, message: "Webhook processed" }, { status: 200 });

    } catch (err: any) {
        console.error("❌ [WEBHOOK ERROR]:", err.message);
        // Jika terjadi error, kita balas 500, Accurate akan mencatatnya sebagai Failed/Pending dan mungkin me-retry
        return NextResponse.json({ error: "Gagal memproses webhook" }, { status: 500 });
    }
}
