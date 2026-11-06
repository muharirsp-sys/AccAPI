/*
 * Tujuan: Gerbang Tax untuk rute dokumen klaim (buat & unduh surat, rekap, kwitansi): tolak 409 selama klaim berpajak belum disetujui Tax.
 * Caller: app/api/claim-workflow/[id]/{claim-letter,summary,receipt,documents/generate-all} dan submissions/[submissionId]/{claim-letter,summary,receipt}.
 * Main Functions: tolakDokumenBelumTax.
 * Side Effects: Baca DB (claim_workflow, claim_workflow_item).
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { claimWorkflow, claimWorkflowItem } from "@/db/schema";
import { db } from "@/lib/db";
import { alasanTaxDokumen, klaimTerbuka } from "./tax";

const KOLOM_PAJAK = {
    id: claimWorkflowItem.id, dpp: claimWorkflowItem.dpp, ppnRate: claimWorkflowItem.ppnRate, ppnAmount: claimWorkflowItem.ppnAmount,
    pphRate: claimWorkflowItem.pphRate, pphAmount: claimWorkflowItem.pphAmount,
};

/** null = boleh lanjut (termasuk klaim tak ditemukan: rute sendiri yang menjawab 404). */
export async function tolakDokumenBelumTax(id: string): Promise<NextResponse | null> {
    const [klaim] = await db.select({ status: claimWorkflow.status, taxStatus: claimWorkflow.taxStatus, taxSidik: claimWorkflow.taxSidik })
        .from(claimWorkflow).where(eq(claimWorkflow.id, id));
    if (!klaim || !klaimTerbuka(klaim.status)) return null;
    const items = await db.select(KOLOM_PAJAK).from(claimWorkflowItem).where(eq(claimWorkflowItem.claimWorkflowId, id));
    const alasan = alasanTaxDokumen(klaim, items);
    return alasan ? NextResponse.json({ ok: false, code: "CLAIM_TAX_BELUM_DISETUJUI", error: alasan }, { status: 409 }) : null;
}
