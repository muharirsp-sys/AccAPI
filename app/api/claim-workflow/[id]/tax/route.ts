/*
 * Tujuan: Persetujuan Tax untuk klaim ber-PPN/PPh (owner 6 Nov 2026). Satu POST { action, note?, sidik? }:
 *   kirim      : Claim (peran admin/claim + claim_workflow.update) mengirim klaim ke Tax setelah semua berkas aktif ber-No Claim.
 *   setujui    : Tax (claim_workflow.tax_review) menyetujui nilai pajak yang ia lihat (sidik harus sama dengan nilai sekarang).
 *   kembalikan : Tax mengembalikan ke Claim dengan catatan wajib.
 *   Surat, kwitansi, dan rekap baru bisa dibuat setelah disetujui (lib/claim-workflow/tax-db, gerbang di rute dokumen).
 * Caller: app/(dashboard)/claim-workflow/[id]/ClaimDetail.tsx.
 * Side Effects: UPDATE claim_workflow.tax_*; INSERT claim_audit_log (tax_dikirim / tax_disetujui / tax_dikembalikan).
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { claimWorkflow, claimWorkflowItem } from "@/db/schema";
import { db } from "@/lib/db";
import { getActiveSubmissions, lockClaimWorkflow, requireClaimSession, writeClaimAudit } from "@/lib/claim-workflow";
import { TAX_STATUS, klaimTerbuka, sidikPajak, tahapTax } from "@/lib/claim-workflow/tax";
import { requirePermissionH } from "@/lib/rbac/resolve";

type Context = { params: Promise<{ id: string }> };
type Aksi = "kirim" | "setujui" | "kembalikan";
type Tolak = { status: number; code: string; error: string };

const AKSI: Aksi[] = ["kirim", "setujui", "kembalikan"];
const CATATAN_MAKS = 500;
const AUDIT: Record<Aksi, string> = { kirim: "tax_dikirim", setujui: "tax_disetujui", kembalikan: "tax_dikembalikan" };
const KE: Record<Aksi, string> = { kirim: TAX_STATUS.menunggu, setujui: TAX_STATUS.disetujui, kembalikan: TAX_STATUS.dikembalikan };

export async function POST(request: Request, context: Context) {
    const actor = await requireClaimSession();
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as { action?: unknown; note?: unknown; sidik?: unknown };
    const action = AKSI.find((a) => a === body.action);
    if (!action) return NextResponse.json({ ok: false, code: "CLAIM_TAX_INVALID_ACTION", error: "Aksi harus kirim, setujui, atau kembalikan." }, { status: 400 });
    if (body.note != null && typeof body.note !== "string") return NextResponse.json({ ok: false, error: "Catatan harus berupa teks." }, { status: 400 });
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > CATATAN_MAKS) return NextResponse.json({ ok: false, error: `Catatan paling banyak ${CATATAN_MAKS} karakter.` }, { status: 400 });
    if (action === "kembalikan" && !note) return NextResponse.json({ ok: false, code: "CLAIM_TAX_NOTE_REQUIRED", error: "Tulis apa yang harus diperbaiki Claim." }, { status: 400 });

    if (action === "kirim") {
        if (actor.role !== "admin" && actor.role !== "claim") return NextResponse.json({ ok: false, error: "Hanya peran admin atau claim yang dapat mengirim ke Tax." }, { status: 403 });
        const gate = await requirePermissionH("claim_workflow.update");
        if (gate.response) return gate.response;
    } else {
        const gate = await requirePermissionH("claim_workflow.tax_review");
        if (gate.response) return gate.response;
    }

    const { id } = await context.params;
    try {
        const tolak = await db.transaction(async (tx): Promise<Tolak | null> => {
            await lockClaimWorkflow(tx, id);
            const [klaim] = await tx.select().from(claimWorkflow).where(eq(claimWorkflow.id, id));
            if (!klaim) return { status: 404, code: "CLAIM_NOT_FOUND", error: "Klaim tidak ditemukan." };
            if (!klaimTerbuka(klaim.status)) return { status: 409, code: "CLAIM_TAX_INVALID_STATE", error: "Pemeriksaan Tax hanya untuk klaim Draf atau Perlu revisi." };
            const items = await tx.select().from(claimWorkflowItem).where(eq(claimWorkflowItem.claimWorkflowId, id));
            const tahap = tahapTax(klaim, items);
            const sidik = sidikPajak(items);
            if (tahap === "tidak_perlu") return { status: 409, code: "CLAIM_TAX_TIDAK_PERLU", error: "Klaim ini tanpa PPN/PPh; tidak perlu ke Tax." };

            if (action === "kirim") {
                if (tahap === "menunggu") return { status: 409, code: "CLAIM_TAX_INVALID_STATE", error: "Klaim ini sudah menunggu pemeriksaan Tax." };
                if (tahap === "disetujui") return { status: 409, code: "CLAIM_TAX_INVALID_STATE", error: "Pajak klaim ini sudah disetujui Tax." };
                const tanpaNo = (await getActiveSubmissions(id, tx)).filter((s) => !String(s.noClaim || "").trim());
                if (tanpaNo.length) return { status: 422, code: "CLAIM_TAX_NO_CLAIM_REQUIRED", error: `Isi dan simpan No Claim ${tanpaNo.length} berkas dulu.` };
            } else {
                if (tahap !== "menunggu") return { status: 409, code: "CLAIM_TAX_INVALID_STATE", error: "Klaim ini tidak sedang menunggu pemeriksaan Tax." };
                if (action === "setujui" && body.sidik !== sidik) {
                    return { status: 409, code: "CLAIM_TAX_BERUBAH", error: "Nilai pajak berubah sejak halaman dibuka. Muat ulang, periksa lagi, lalu setujui." };
                }
            }

            const kini = new Date();
            await tx.update(claimWorkflow).set({
                taxStatus: KE[action], taxStatusAt: kini, taxNote: action === "kirim" ? null : note || null,
                taxSidik: action === "setujui" ? sidik : null, updatedAt: kini,
            }).where(eq(claimWorkflow.id, id));
            await writeClaimAudit({
                claimWorkflowId: id, actor, action: AUDIT[action], fromStatus: klaim.status, toStatus: klaim.status, note: note || null,
                metadata: { taxDari: klaim.taxStatus, taxKe: KE[action], sidik, totalPpn: klaim.totalPpn, totalPph: klaim.totalPph },
            }, tx);
            return null;
        });
        if (tolak) return NextResponse.json({ ok: false, code: tolak.code, error: tolak.error }, { status: tolak.status });
        return NextResponse.json({ ok: true, taxStatus: KE[action] });
    } catch (error) {
        console.error("[CLAIM TAX ERROR]", error);
        return NextResponse.json({ ok: false, error: "Gagal menyimpan pemeriksaan Tax." }, { status: 500 });
    }
}
