/*
 * Tujuan: Tipe respons dan helper murni Object Page Claim Workflow (dipisah dari ClaimDetail.tsx supaya berkas komponen ringkas).
 * Caller: app/(dashboard)/claim-workflow/[id]/ClaimDetail.tsx.
 * Dependensi: lib/claim-workflow-ui, lib/promo-ui (rupiah), components/fiori/{core,interactive}.
 * Main Functions: kirimJson, tanpa, isiItem, persenTeks, judulBerkas, aktif, FormItemPonsel, AlurDokumen.
 * Side Effects: kirimJson melakukan fetch tulis (dipanggil komponen klien); sisanya pure.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";
import { hitungBaris, labelLingkup } from "@/lib/claim-workflow-ui";
import { rupiah } from "@/lib/promo-ui";

export type Workflow = {
    id: string; claimWorkflowNo: string; offBatchId: string; offNoPengajuan?: string | null; principleCode: string; principleName: string; status: string;
    totalDpp: number; totalPpn: number; totalPph: number; totalClaim: number; totalPaid: number; remainingAmount: number;
    submittedToPrincipalAt?: string | null; noClaim?: string | null;
    claimLetterPdfPath?: string | null; claimLetterGeneratedAt?: string | null; summaryPdfPath?: string | null; summaryGeneratedAt?: string | null;
    receiptPdfPath?: string | null; receiptGeneratedAt?: string | null;
    closedAt?: string | null; closedBy?: string | null; closeNote?: string | null; createdAt: string;
};
export type WorkflowItem = {
    id: string; noSurat?: string | null; jenisPromosi?: string | null; periode?: string | null; outlet?: string | null;
    dpp: number; ppnRate: number; ppnAmount: number; pphRate: number; pphAmount: number; nilaiKlaim: number; status: string; note?: string | null;
    claimSubmissionId?: string | null; updatedAt?: string | null;
};
export type Submission = {
    id: string; noClaim?: string | null; scope: string; scopeLabel?: string | null; status: string;
    totalClaim: number; totalPaid: number; remainingAmount: number; itemCount?: number;
    claimLetterPdfPath?: string | null; claimLetterGeneratedAt?: string | null; summaryPdfPath?: string | null; summaryGeneratedAt?: string | null;
    receiptPdfPath?: string | null; receiptGeneratedAt?: string | null;
};
export type AuditRow = { id: string; actorName?: string | null; actorRole?: string | null; action: string; note?: string | null; fromStatus?: string | null; toStatus?: string | null; metadata?: unknown; createdAt: string };
export type Payment = {
    id: string; claimSubmissionId?: string | null; paymentDate: string; paymentAmount: number; paymentType?: string | null; paymentNote?: string | null;
    voidedAt?: string | null; voidReason?: string | null; createdAt: string;
};
export type PaymentSummary = { totalClaim: number; totalPaid: number; remainingAmount: number; paymentStatus: string; activePaymentCount: number; voidedPaymentCount: number };
export type DetailResult = {
    ok?: boolean; error?: string; workflow?: Workflow; items?: WorkflowItem[]; payments?: Payment[]; paymentSummary?: PaymentSummary;
    submissions?: Submission[]; hasMultipleSubmissions?: boolean; noClaimList?: string[];
    canEditItems?: boolean; isReadOnly?: boolean; canGenerateClaimLetter?: boolean; canGenerateSummary?: boolean; canGenerateReceipt?: boolean;
    canAssignNoClaim?: boolean; canGenerateNoClaim?: boolean; noClaimGateReason?: string | null; offFinanceStatus?: string | null;
    offPaymentSummary?: { totalNominal: number; totalPaid: number; isFullyPaid: boolean } | null;
    canRecordPayment?: boolean; canVoidPayment?: boolean; canClose?: boolean; closeBlockers?: string[];
};
export type DrafItem = { dpp?: string; ppnRate?: string; pphRate?: string; note?: string };
export type DrafNc = { noClaim?: string; urut?: string; bulan?: string };
export type Dlg = "siap" | "draf" | "kirim" | "bayar" | "void" | "tutup" | "gabung" | "pindah" | null;
export type Bagian = "atas" | "item" | "noclaim" | "bayar" | "tutup";
export type Jawab = { ok?: boolean; error?: string; code?: string; currentUpdatedAt?: string | null; statusChanged?: boolean; workflow?: { status?: string } };
export type Fakta = Array<[string, ReactNode]>;

export async function kirimJson(url: string, method: string, body: unknown) {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Jawab;
    return { res, data };
}
export function tanpa<T>(rec: Record<string, T>, key: string) { const n = { ...rec }; delete n[key]; return n; }
/** Nilai baris yang sedang diubah: draf menimpa nilai server per isian (isian lain tetap nilai server). */
export const isiItem = (it: WorkflowItem, d: DrafItem = {}) => ({
    dpp: d.dpp ?? String(it.dpp), ppnRate: d.ppnRate ?? String(it.ppnRate), pphRate: d.pphRate ?? String(it.pphRate), note: d.note ?? (it.note || ""),
});
export const persenTeks = (v: number | string) => `${String(v).replace(".", ",")}%`;
export const judulBerkas = (s: Submission) => s.scopeLabel?.trim() || labelLingkup(s.scope);
export const aktif = (s: Submission) => Number(s.totalClaim || 0) > 0 || (s.itemCount ?? 0) > 0;

type FormItemProps = {
    it: WorkflowItem; v: ReturnType<typeof isiItem>; galat?: string; busy: boolean; berubah: boolean;
    onChange: (patch: DrafItem) => void; onSave: () => void; onCancel: () => void;
};

/** Formulir ubah pajak satu item di ponsel (tabel diganti daftar di bawah 600 px). */
export function FormItemPonsel({ it, v, galat, busy, berubah, onChange, onSave, onCancel }: FormItemProps) {
    const h = hitungBaris(v);
    return (
        <div className="fi-sect-in">
            <span><b className="fi-mono">{it.noSurat || "–"}</b> <span className="fi-small fi-subtle">{it.outlet}</span></span>
            <div className="fi-formgrid">
                <FormField label="DPP">{(a) => <input {...a} className="fi-input" type="number" min="0" step="any" inputMode="decimal" value={v.dpp} onChange={(e) => onChange({ dpp: e.target.value })} />}</FormField>
                <FormField label="PPN %">{(a) => <input {...a} className="fi-input" type="number" min="0" max="100" step="any" inputMode="decimal" value={v.ppnRate} onChange={(e) => onChange({ ppnRate: e.target.value })} />}</FormField>
                <FormField label="PPh %">{(a) => <input {...a} className="fi-input" type="number" min="0" max="100" step="any" inputMode="decimal" value={v.pphRate} onChange={(e) => onChange({ pphRate: e.target.value })} />}</FormField>
                <FormField label="Catatan">{(a) => <input {...a} className="fi-input" value={v.note} onChange={(e) => onChange({ note: e.target.value })} />}</FormField>
            </div>
            <p className="fi-small">Nilai klaim <b>{rupiah(h.nilaiKlaim)}</b> · PPN {rupiah(h.ppnAmount)} · PPh {rupiah(h.pphAmount)}</p>
            {galat && <p className="fi-msg" role="alert">{galat}</p>}
            <div className="fi-btnrow">
                <Button variant="primary" busy={busy} disabled={!berubah} disabledReason="Belum ada perubahan" onClick={onSave}>Simpan</Button>
                <Button variant="tertiary" onClick={onCancel}>Batal</Button>
            </div>
        </div>
    );
}

/** OFF Program Control → klaim → No Claim → pembayaran; simpul yang belum ada bergaris putus. */
export function AlurDokumen({ off, no, noClaims, jumlahBayar, dibayar }: { off?: string | null; no: string; noClaims: string[]; jumlahBayar: number; dibayar: number }) {
    return (
        <div className="fi-dflow" role="list" aria-label="Alur dokumen">
            <Link role="listitem" className="fi-dnode" href="/off-program-control?tab=claim&claimView=after-finance"><b>{off || "OFF"}</b><span>OFF Program Control</span></Link>
            <ArrowRight className="fi-icon" aria-hidden />
            <span role="listitem" className="fi-dnode"><b className="fi-mono">{no}</b><span>Claim Workflow</span></span>
            <ArrowRight className="fi-icon" aria-hidden />
            <span role="listitem" className="fi-dnode" data-off={noClaims.length === 0}><b className={noClaims.length ? "fi-mono" : undefined}>{noClaims.length ? noClaims.join(", ") : "No Claim"}</b><span>{noClaims.length ? "Berkas ke principal" : "belum"}</span></span>
            <ArrowRight className="fi-icon" aria-hidden />
            <span role="listitem" className="fi-dnode" data-off={jumlahBayar === 0}><b>Pembayaran</b><span>{jumlahBayar ? `${jumlahBayar} tercatat · ${rupiah(dibayar)}` : "belum"}</span></span>
        </div>
    );
}
