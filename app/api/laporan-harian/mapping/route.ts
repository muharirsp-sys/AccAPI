/*
 * Tujuan: API admin untuk membaca dan memperbarui mapping penerima serta lookup SPV/SM laporan harian.
 * Caller: app/(dashboard)/laporan-harian/mapping/page.tsx.
 * Dependensi: requirePermission, db/reportRecipient, default penerima khusus, FastAPI /laporan-harian/mapping.
 * Main Functions: GET, PUT.
 * Side Effects: DB read/write report_recipient dan HTTP read/write lookup backend.
 */
import { NextRequest, NextResponse } from "next/server";
import { asc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { reportRecipient } from "@/db/schema";
import { requirePermission } from "@/lib/rbac/resolve";
import { withSpecialReportRecipients } from "@/lib/laporan-harian/default-recipients";

export const runtime = "nodejs";

type Lookups = {
    principal_to_spv: Record<string, string>;
    conca_to_spv: Record<string, string>;
    jp_map: Record<string, string>;
    sm_map: Record<string, string>;
    distribution_rules: unknown[];
};

type RecipientInput = { keyword?: unknown; emails?: unknown; active?: unknown };

function fastapiHeaders(): HeadersInit {
    const token = process.env.LH_MAPPING_TOKEN?.trim();
    return token ? { "X-LH-Mapping-Token": token } : {};
}

function fastapiBase(): string {
    return process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || "http://localhost:8000";
}

function validLookups(value: unknown): value is Lookups {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    const mapsValid = ["principal_to_spv", "conca_to_spv", "jp_map", "sm_map"]
        .every((key) => row[key] && typeof row[key] === "object" && !Array.isArray(row[key]));
    return mapsValid && Array.isArray(row.distribution_rules);
}

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "laporan_harian.manage");
    if (gate.response) return gate.response;
    const [storedRecipients, lookupResponse] = await Promise.all([
        db.select().from(reportRecipient).orderBy(asc(reportRecipient.keyword)),
        fetch(`${fastapiBase()}/laporan-harian/mapping`, { cache: "no-store", headers: fastapiHeaders() }),
    ]);
    if (!lookupResponse.ok) {
        return NextResponse.json({ error: "Mapping backend tidak dapat dibaca" }, { status: 502 });
    }
    const recipients = withSpecialReportRecipients(storedRecipients);
    return NextResponse.json({ recipients, lookups: await lookupResponse.json() });
}

export async function PUT(req: NextRequest) {
    const gate = await requirePermission(req, "laporan_harian.manage");
    if (gate.response) return gate.response;
    let body: { recipients?: RecipientInput[]; lookups?: unknown };
    try { body = await req.json(); } catch {
        return NextResponse.json({ error: "Body JSON tidak valid" }, { status: 400 });
    }
    if (!Array.isArray(body.recipients) || !validLookups(body.lookups)) {
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

    const backendResponse = await fetch(`${fastapiBase()}/laporan-harian/mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...fastapiHeaders() },
        body: JSON.stringify(body.lookups),
    });
    if (!backendResponse.ok) {
        return NextResponse.json({ error: "Mapping lookup gagal disimpan di backend" }, { status: 502 });
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
