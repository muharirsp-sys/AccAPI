import { NextRequest, NextResponse } from "next/server";
import { syncModule } from "@/lib/sync";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { moduleName, endpoint, sessionHost, sessionId, apiKey } = body;

        if (!moduleName || !endpoint || !sessionHost || !sessionId || !apiKey) {
            return NextResponse.json({ error: "Missing required sync parameters or Accurate credentials." }, { status: 400 });
        }

        const creds = { sessionHost, sessionId, apiKey };

        // WARNING: In a production Vercel/Serverless environment, long-running sync 
        // processes will timeout! For Self-Hosted VPS deployments, Node.js can handle it.
        // We do NOT await the syncModule to block the UI, we run it in the background asynchronously.
        // Although Next.js 14+ might kill dangling promises if edge runtime, 
        // standard Node.js server will run this fine.
        syncModule(moduleName as 'item' | 'customer', endpoint, creds)
            .then(res => console.log(`[SYNC COMPLETE] ${moduleName}:`, res))
            .catch(err => console.error(`[SYNC FATAL ERROR] ${moduleName}:`, err));

        // Return immediately so the HTTP request completes and the UI shows "Sync Started"
        return NextResponse.json({ message: "Sinkronisasi berjalan di belakang layar (Background Job Started)" });
    } catch (error: any) {
        console.error("[SYNC TRIGGER ERROR]", error);
        return NextResponse.json({ error: error.message || "Failed to trigger sync" }, { status: 500 });
    }
}
