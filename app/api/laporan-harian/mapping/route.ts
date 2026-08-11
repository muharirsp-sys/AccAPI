/*
 * Tujuan: API admin untuk membaca dan memperbarui mapping penerima email laporan harian (report_recipient).
 * Caller: app/(dashboard)/laporan-harian/mapping/page.tsx.
 * Dependensi: requirePermission, db/reportRecipient.
 * Main Functions: GET, PUT.
 * Side Effects: DB read/write report_recipient.
 */
import { NextRequest, NextResponse } from "next/server";
import { asc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { reportRecipient } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

type RecipientInput = { keyword?: unknown; emails?: unknown; active?: unknown };

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "laporan_harian.manage");
    if (gate.response) return gate.response;
    const recipients = await db.select().from(reportRecipient).orderBy(asc(reportRecipient.keyword));
    return NextResponse.json({ recipients });
}

export async function PUT(req: NextRequest) {
    const gate = await requirePermission(req, "laporan_harian.manage");
    if (gate.response) return gate.response;
    let body: { recipients?: RecipientInput[] };
    try { body = await req.json(); } catch {
        return NextResponse.json({ error: "Body JSON tidak valid" }, { status: 400 });
    }
    if (!Array.isArray(body.recipients)) {
        return NextResponse.json({ error: "Format mapping tidak valid" }, { status: 400 });
    }
    const normalized = body.recipients.map((item) => ({
        keyword: String(item.keyword ?? "").trim().toUpperCase(),
        emails: String(item.emails ?? "").trim(),
        active: item.active !== false,
    }));
    if (normalized.some((item) => !item.keyword || !item.emails)) {
        return NextResponse.json({ error: "Keyword dan email wajib diisi" }, { status: 400 });
    }
    if (new Set(normalized.map((item) => item.keyword.toLowerCase())).size !== normalized.length) {
        return NextResponse.json({ error: "Keyword penerima tidak boleh duplikat" }, { status: 400 });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
        await tx.update(reportRecipient).set({ active: false, updatedAt: now });
        if (normalized.length) {
            await tx.insert(reportRecipient).values(normalized.map((item) => ({
                id: randomUUID(),
                ...item,
                createdAt: now,
                updatedAt: now,
            }))).onConflictDoUpdate({
                target: reportRecipient.keyword,
                set: {
                    emails: sql`excluded.emails`,
                    active: sql`excluded.active`,
                    updatedAt: now,
                },
            });
        }
    });
    return NextResponse.json({ ok: true, recipients: normalized.length });
}
