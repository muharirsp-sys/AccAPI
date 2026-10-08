/*
 * Tujuan: Templat format No Claim per principal (S4b, owner 8 Okt 2026) — bawaan kode ditimpa baris DB.
 * Caller: generator saran No Claim (detail Claim Workflow) dan layar S7 Pengaturan › Data principal.
 * Dependensi: tabel no_claim_template, mergeNoClaimTemplates/validateNoClaimTemplate (lib/claim-workflow/no-claim-rules).
 * Main Functions: GET daftar templat efektif; PUT simpan/ubah satu templat; DELETE kembalikan ke bawaan kode.
 * Side Effects: DB write no_claim_template (PUT/DELETE).
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { noClaimTemplate } from "@/db/schema";
import { mergeNoClaimTemplates, validateNoClaimTemplate } from "@/lib/claim-workflow/no-claim-rules";
import { requirePermissionH } from "@/lib/rbac/resolve";

export async function GET() {
    const gate = await requirePermissionH("claim_workflow.view");
    if (gate.response) return gate.response;
    const overrides = await db.select().from(noClaimTemplate);
    return NextResponse.json({ ok: true, templates: mergeNoClaimTemplates(overrides), overrides });
}

export async function PUT(request: Request) {
    const gate = await requirePermissionH("claim_workflow.edit");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return NextResponse.json({ ok: false, error: "Isi permintaan tidak valid." }, { status: 400 });
    const v = validateNoClaimTemplate(body as Record<string, unknown>);
    if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
    const values = { ...v.row, updatedBy: gate.session.user.name ?? gate.session.user.id, updatedAt: new Date() };
    await db.insert(noClaimTemplate).values(values)
        .onConflictDoUpdate({ target: [noClaimTemplate.principleCode, noClaimTemplate.variantKey], set: values });
    return NextResponse.json({ ok: true, template: values });
}

export async function DELETE(request: Request) {
    const gate = await requirePermissionH("claim_workflow.edit");
    if (gate.response) return gate.response;
    const q = new URL(request.url).searchParams;
    const principleCode = (q.get("principleCode") ?? "").trim().toUpperCase();
    const variantKey = (q.get("variantKey") ?? "").trim().toUpperCase();
    if (!principleCode) return NextResponse.json({ ok: false, error: "principleCode wajib diisi." }, { status: 400 });
    await db.delete(noClaimTemplate)
        .where(and(eq(noClaimTemplate.principleCode, principleCode), eq(noClaimTemplate.variantKey, variantKey)));
    return NextResponse.json({ ok: true });
}
