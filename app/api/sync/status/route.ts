import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { syncState } from "@/db/schema";

export async function GET(req: NextRequest) {
    try {
        const states = await db.select().from(syncState).all();
        
        return NextResponse.json({
            ok: true,
            states: states
        });
    } catch (error: any) {
        console.error("[SYNC STATUS ERROR]", error);
        return NextResponse.json({ error: error.message || "Failed to fetch sync status" }, { status: 500 });
    }
}
