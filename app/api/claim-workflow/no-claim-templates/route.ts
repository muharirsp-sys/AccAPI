/*
 * Tujuan: Templat format No Claim per principal (S4b, owner 8 Okt 2026) — bawaan kode ditimpa baris DB.
 * Caller: generator saran No Claim (app/(dashboard)/claim-workflow/[id]/page.tsx) dan layar S7 Pengaturan › Data principal.
 * Dependensi: tabel no_claim_template + no_claim_template_log, mergeNoClaimTemplates/validateNoClaimTemplate.
 * Main Functions: GET daftar templat efektif; PUT simpan/ubah satu templat; DELETE kembalikan ke bawaan kode.
 * Side Effects: DB write no_claim_template + no_claim_template_log (PUT/DELETE, satu transaksi).
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { noClaimTemplate, noClaimTemplateLog } from "@/db/schema";
import { mergeNoClaimTemplates, validateNoClaimTemplate } from "@/lib/claim-workflow/no-claim-rules";
import { requirePermissionH } from "@/lib/rbac/resolve";

const gagal = (error: unknown) => {
    console.error("[NO CLAIM TEMPLATE ERROR]", error);
    return NextResponse.json({ ok: false, error: "Gagal memproses templat No Claim." }, { status: 500 });
};

const where = (principleCode: string, variantKey: string) =>
    and(eq(noClaimTemplate.principleCode, principleCode), eq(noClaimTemplate.variantKey, variantKey));

export async function GET() {
    const gate = await requirePermissionH("claim_workflow.view");
    if (gate.response) return gate.response;
    try {
        const overrides = await db.select().from(noClaimTemplate);
        return NextResponse.json({ ok: true, templates: mergeNoClaimTemplates(overrides), overrides });
    } catch (error) {
        return gagal(error);
    }
}

export async function PUT(request: Request) {
    const gate = await requirePermissionH("claim_workflow.edit");
    if (gate.response) return gate.response;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return NextResponse.json({ ok: false, error: "Isi permintaan tidak valid." }, { status: 400 });
    const v = validateNoClaimTemplate(body as Record<string, unknown>);
    if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
    const actor = gate.session.user.name ?? gate.session.user.id;
    const now = new Date();
    const values = { ...v.row, updatedBy: actor, updatedAt: now };
    try {
        await db.transaction(async (tx) => {
            const [before] = await tx.select().from(noClaimTemplate).where(where(v.row.principleCode, v.row.variantKey));
            await tx.insert(noClaimTemplate).values(values)
                .onConflictDoUpdate({ target: [noClaimTemplate.principleCode, noClaimTemplate.variantKey], set: values });
            await tx.insert(noClaimTemplateLog).values({
                principleCode: v.row.principleCode, variantKey: v.row.variantKey, action: "set",
                before: before ?? null, after: v.row, actor, createdAt: now,
            });
        });
        return NextResponse.json({ ok: true, template: values });
    } catch (error) {
        return gagal(error);
    }
}

export async function DELETE(request: Request) {
    const gate = await requirePermissionH("claim_workflow.edit");
    if (gate.response) return gate.response;
    const q = new URL(request.url).searchParams;
    const principleCode = (q.get("principleCode") ?? "").trim().toUpperCase();
    const variantKey = (q.get("variantKey") ?? "").trim().toUpperCase();
    if (!principleCode) return NextResponse.json({ ok: false, error: "principleCode wajib diisi." }, { status: 400 });
    const actor = gate.session.user.name ?? gate.session.user.id;
    try {
        await db.transaction(async (tx) => {
            const removed = await tx.delete(noClaimTemplate).where(where(principleCode, variantKey)).returning();
            if (removed.length) await tx.insert(noClaimTemplateLog).values({
                principleCode, variantKey, action: "reset", before: removed[0], after: null, actor, createdAt: new Date(),
            });
        });
        return NextResponse.json({ ok: true });
    } catch (error) {
        return gagal(error);
    }
}
