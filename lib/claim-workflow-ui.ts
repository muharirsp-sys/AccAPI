/*
 * Tujuan: Helper murni layar Claim Workflow (Fiori S4b): satu set badge status, alur tahap, umur sejak dikirim ke principal,
 *   pratinjau pajak dengan pembulatan yang sama dengan server, daftar periksa penutupan, kalimat riwayat, pola No Claim terbaca,
 *   dan pesan galat muat. Tidak ada logic bisnis baru — hanya penyajian.
 * Caller: app/(dashboard)/claim-workflow/ClaimList.tsx, app/(dashboard)/claim-workflow/[id]/ClaimDetail.tsx, claim-workflow-ui.test.ts.
 * Dependensi: lib/claim-workflow/{constants,calculations} (pure).
 * Main Functions: statusKlaim, tahapKlaim, alurKlaim, umurHari, hitungBaris, syaratTutup, kalimatAudit, polaTerbaca, labelLingkup,
 *   tanggalWita, pesanGalat, DOKUMEN.
 * Side Effects: Tidak ada.
 */
import type { FlowStep, Tone } from "@/components/fiori/core";
import { claimWorkflowStatuses as S, isLegacyPekaStatus } from "@/lib/claim-workflow/constants";
import { calculateClaimAmount } from "@/lib/claim-workflow/calculations";
import { rupiah } from "@/lib/promo-ui";

/** Satu set badge (A3): Dibayar sebagian kuning, Lunas hijau, Ditutup netral. Kode status mentah tidak tampil. */
const STATUS_KLAIM: Record<string, { label: string; tone: Tone }> = {
    [S.draft]: { label: "Draf", tone: "neu" },
    [S.needRevision]: { label: "Perlu revisi", tone: "warn" },
    [S.readyToSubmit]: { label: "Siap dikirim", tone: "info" },
    [S.submittedToPrincipal]: { label: "Dikirim", tone: "info" },
    [S.outstanding]: { label: "Menunggu bayar", tone: "warn" },
    [S.partiallyPaid]: { label: "Dibayar sebagian", tone: "warn" },
    [S.paid]: { label: "Lunas", tone: "pos" },
    [S.closed]: { label: "Ditutup", tone: "neu" },
    [S.cancelled]: { label: "Dibatalkan", tone: "neg" },
};

/** Status PEKA lama (alur sudah pensiun) diperlakukan sebagai Dikirim, sama seperti server. */
export function statusKlaim(status: string | null | undefined): { label: string; tone: Tone } {
    if (!status) return STATUS_KLAIM[S.draft];
    if (isLegacyPekaStatus(status)) return STATUS_KLAIM[S.submittedToPrincipal];
    return STATUS_KLAIM[status] ?? { label: "Status tidak dikenal", tone: "neu" };
}

export type TahapKey = "draf" | "siap" | "dikirim" | "sebagian" | "lunas" | "ditutup" | "batal" | "lain";

/** Tahap kerja untuk tile saring dan footer: satu aksi utama per tahap. */
export function tahapKlaim(status: string | null | undefined): TahapKey {
    if (!status || status === S.draft || status === S.needRevision) return "draf";
    if (status === S.readyToSubmit) return "siap";
    if (status === S.submittedToPrincipal || status === S.outstanding || isLegacyPekaStatus(status)) return "dikirim";
    if (status === S.partiallyPaid) return "sebagian";
    if (status === S.paid) return "lunas";
    if (status === S.closed) return "ditutup";
    if (status === S.cancelled) return "batal";
    return "lain";
}

const ALUR = ["Draf", "Siap dikirim", "Dikirim", "Dibayar", "Ditutup"] as const;

/** Langkah Draf → Siap dikirim → Dikirim → Dibayar → Ditutup; Perlu revisi = langkah Draf terlambat, Dibatalkan = berhenti. */
export function alurKlaim(status: string | null | undefined): FlowStep[] {
    const tahap = tahapKlaim(status);
    if (tahap === "batal") return [{ label: "Draf", state: "done" }, { label: "Siap dikirim", state: "done" }, { label: "Dikirim", state: "done" }, { label: "Dibatalkan", state: "stop" }];
    const kini = { draf: 0, siap: 1, dikirim: 2, sebagian: 3, lunas: 4, ditutup: 5, lain: 0 }[tahap];
    return ALUR.map((label, i) => ({
        label,
        state: i < kini ? "done" : i === kini ? (status === S.needRevision ? "late" : "current") : "todo",
    }));
}

/** Satu definisi umur: hari penuh sejak dikirim ke principal (sama dengan dayDiff di /api/claim-workflow/outstanding). */
export function umurHari(dikirimPada: string | Date | null | undefined, now = Date.now()): number | null {
    if (!dikirimPada) return null;
    const t = (dikirimPada instanceof Date ? dikirimPada : new Date(dikirimPada)).getTime();
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.floor((now - t) / 86_400_000));
}

const angka = (v: string | number | null | undefined) => Number(v || 0) || 0;

/** Pratinjau pajak satu item dengan fungsi server (PPN/PPh dibulatkan ke rupiah), bukan toFixed(2). */
export function hitungBaris(v: { dpp: string | number; ppnRate: string | number; pphRate: string | number }) {
    return calculateClaimAmount(angka(v.dpp), angka(v.ppnRate), angka(v.pphRate));
}

type BerkasTutup = {
    status: string; noClaim?: string | null; totalClaim: number; totalPaid: number; remainingAmount: number;
    claimLetterPdfPath?: string | null; summaryPdfPath?: string | null; receiptPdfPath?: string | null;
};

/** Delapan syarat penutupan berkas (cermin close/route.ts), dalam bahasa tugas. */
export function syaratTutup(b: BerkasTutup, pembayaranAktif: number): Array<{ label: string; ok: boolean }> {
    const total = Number(b.totalClaim || 0);
    const dibayar = Number(b.totalPaid || 0);
    return [
        { label: "Status Lunas", ok: b.status === S.paid },
        { label: "Sisa tagihan Rp 0", ok: Number(b.remainingAmount || 0) === 0 },
        { label: "Dibayar sebesar total klaim (lebih dari 0)", ok: dibayar >= total && total > 0 },
        { label: "Ada pembayaran aktif", ok: pembayaranAktif > 0 },
        { label: "No Claim terisi", ok: Boolean(String(b.noClaim ?? "").trim()) },
        { label: "Surat klaim (PDF) ada", ok: Boolean(b.claimLetterPdfPath) },
        { label: "Ringkasan (PDF) ada", ok: Boolean(b.summaryPdfPath) },
        { label: "Kwitansi (PDF) ada", ok: Boolean(b.receiptPdfPath) },
    ];
}

export const DOKUMEN = [
    { key: "claim-letter", label: "Surat klaim", path: "claimLetterPdfPath", at: "claimLetterGeneratedAt" },
    { key: "summary", label: "Ringkasan", path: "summaryPdfPath", at: "summaryGeneratedAt" },
    { key: "receipt", label: "Kwitansi", path: "receiptPdfPath", at: "receiptGeneratedAt" },
] as const;

const AKSI: Record<string, string> = {
    create_from_off: "Membuat klaim dari OFF Program Control",
    mark_ready: "Menandai siap dikirim",
    return_to_draft: "Mengembalikan ke draf",
    submit_to_principal: "Mengirim ke principal",
    update_item_tax: "Mengubah pajak item",
    claim_documents_generated_all: "Membuat surat klaim, ringkasan, dan kwitansi",
    claim_letter_generated: "Membuat surat klaim",
    claim_letter_combined_generated: "Membuat surat klaim gabungan",
    pdf_generated: "Membuat surat klaim",
    claim_summary_generated: "Membuat ringkasan",
    claim_receipt_generated: "Membuat kwitansi",
    receipt_pdf_generated: "Membuat kwitansi",
    no_claim_assigned: "Mengisi No Claim",
    no_claim_changed_invalidated_documents: "Mengganti No Claim; dokumen lama dihapus",
    no_claim_synced_to_off: "Menyalin No Claim ke OFF Program Control",
    claim_submission_created: "Membuat berkas klaim",
    claim_submissions_created_per_item: "Membuat berkas klaim per item",
    claim_submission_updated: "Mengubah berkas klaim",
    claim_submission_merged: "Menggabungkan berkas klaim",
    claim_submission_items_assigned: "Memindahkan item ke berkas lain",
    claim_submission_status_synced: "Menyelaraskan status berkas",
    payment_created: "Mencatat pembayaran",
    payment_voided: "Membatalkan pembayaran",
    payment_status_recalculated: "Menghitung ulang status pembayaran",
    claim_closed: "Menutup klaim",
};

type AuditLike = { action: string; note?: string | null; fromStatus?: string | null; toStatus?: string | null; metadata?: unknown };

/** Baris riwayat sebagai kalimat (bukan kode aksi) + perubahan singkat: status lama → baru, nominal, catatan. */
export function kalimatAudit(e: AuditLike): { apa: string; ubah?: string } {
    const meta = (e.metadata && typeof e.metadata === "object" ? e.metadata : {}) as Record<string, unknown>;
    const bagian: string[] = [];
    if (e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus) bagian.push(`${statusKlaim(e.fromStatus).label} → ${statusKlaim(e.toStatus).label}`);
    if (e.action === "update_item_tax" && meta.dpp !== undefined) bagian.push(`DPP ${rupiah(Number(meta.dpp))} · PPN ${meta.ppnRate}% · PPh ${meta.pphRate}%`);
    if (typeof meta.paymentAmount === "number" || typeof meta.paymentAmount === "string") bagian.push(rupiah(Number(meta.paymentAmount)));
    if (e.note) bagian.push(e.note);
    return { apa: AKSI[e.action] ?? "Mencatat perubahan lain", ubah: bagian.length ? bagian.join(" · ") : undefined };
}

/** "{seq}/SUPER-KN/{month}/{year4}" → "{urut}/SUPER-KN/{bulan}/{tahun}". */
export const polaTerbaca = (pattern: string) =>
    pattern.replace(/\{seq\}/g, "{urut}").replace(/\{month\}/g, "{bulan}").replace(/\{year4\}/g, "{tahun}").replace(/\{year2\}/g, "{tahun 2 digit}");

const LINGKUP: Record<string, string> = { per_pengajuan: "Per pengajuan", per_program: "Per program", per_toko: "Per toko", per_item: "Per item", custom: "Kustom" };
export const labelLingkup = (scope: string | null | undefined) => (scope ? LINGKUP[scope] ?? "Berkas klaim" : "Berkas klaim");

/** Timestamp → dd/mm/yyyy menurut WITA. */
export function tanggalWita(iso: string | Date | null | undefined) {
    if (!iso) return "";
    const d = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Makassar" }).format(d);
}

/**
 * Galat muat yang bisa dibaca: respons kosong/bukan JSON atau hanya kode HTTP → kalimat umum (+ kode), bukan
 * "Unexpected end of JSON input". Pesan server yang bermakna dipertahankan.
 */
export function pesanGalat(umum: string, galat?: string | null): string {
    if (!galat) return umum;
    if (/^HTTP \d+$/.test(galat)) return `${umum} Server menjawab ${galat}.`;
    if (/JSON|Unexpected (end|token)/i.test(galat)) return umum;
    return galat;
}
