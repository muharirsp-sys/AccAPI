import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { offAuditLog } from "@/db/schema";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
    const { id } = await context.params;
    const audit = await db.select().from(offAuditLog).where(eq(offAuditLog.batchId, id)).orderBy(asc(offAuditLog.createdAt));
    return NextResponse.json({ ok: true, audit });
}
