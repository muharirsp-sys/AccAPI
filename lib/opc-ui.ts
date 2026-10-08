/*
 * Tujuan: Helper murni layar OFF Program Control (Fiori S4d): tipe DTO batch/item/pembayaran/refund/audit dari API yang ada,
 *   pemetaan enam sumbu status → satu alur 7 tahap (Draf → SM → Klaim → OM → Bayar → Final → Selesai, plus Dikembalikan/Dibatalkan),
 *   predikat antrean per tab (SALINAN predikat kode lama, nomor baris old-opc.tsx disebut), tab per peran, saringan klien
 *   (cari/principal/tahap/periode — salinan filter lama), label Indonesia, dan format tanggal WITA. Tidak ada logic bisnis baru.
 * Caller: app/(dashboard)/off-program-control/{OpcApp.tsx, opc/Bersama.tsx, opc/ObjectPageBatch.tsx, opc/peran/*}, lib/opc-ui.test.ts.
 * Dependensi: lib/off-program-control/{access,search} (murni), tipe FlowStep/Tone dari components/fiori/core.
 * Main Functions: tahapBatch, infoTahap, alurBatch, PREDIKAT, TAMPILAN, tabTerlihat, tabEfektif, subTampilan, saringBatch,
 *   opsiPrincipal, labelStatus, labelAksiAudit, labelPeranAktor, izinAksi, pdfBoleh, tanggalOpc, waktuWita, periodeBatch, totalBatch.
 * Side Effects: Tidak ada.
 */
import type { FlowStep, Tone } from "@/components/fiori/core";
import { canPerformOffAction, getOffAccessibleTabs, type OffAction, type OffRole, type OffTab } from "@/lib/off-program-control/access";
import { matchesSearch, normalizeSearchText } from "@/lib/off-program-control/search";

// ── DTO (bentuk respons API yang ADA; tidak ada kolom baru) ─────────────────────────────────────────────

export type RingkasanBayar = { totalNominal: number; totalPaid: number; remainingAmount: number; isFullyPaid: boolean };
export type PembayaranOpc = {
    id: string; batchId: string; paymentNo: number; paymentDate: string; paymentMethod: string; paidAmount: number;
    senderBank?: string | null; paymentSenderBank?: string | null; paymentProofName?: string | null; proofUrl?: string | null; note?: string | null;
};

/** Baris GET /api/off-program-control/batches (publicBatch + agregat) dan `batch` GET /batches/[id]. */
export type BatchOpc = {
    id: string; noPengajuan: string; gelombang?: string; principleName: string; principleCode: string; bulan: string; tahun: string;
    supervisorName: string; status: string; smStatus: string; claimStatus: string; omStatus: string; financeStatus: string; finalStatus: string;
    locked: boolean; totalNominal?: number | null;
    smNote?: string | null; claimNote?: string | null; omNote?: string | null; returnNote?: string | null; cancelNote?: string | null;
    financeNote?: string | null; finalClaimNote?: string | null;
    noClaim?: string | null; claimSubmittedDate?: string | null; claimDeadline?: string | null; completenessStatus?: string | null;
    paymentDate?: string | null; paidAmount?: number | null; verifiedAmount?: number | null;
    pdfUrl?: string | null; receiptPdfUrl?: string | null;
    createdAt?: string | null; updatedAt?: string | null; submittedAt?: string | null; smApprovedAt?: string | null;
    claimReviewedAt?: string | null; returnedAt?: string | null; paidAt?: string | null;
    summary?: { totalNominal: number; totalRows?: number; rowCount?: number; transfer?: number; tunai?: number };
    paymentSummary?: RingkasanBayar;
    payments?: PembayaranOpc[];
    createdByRole?: string | null; createdBy?: string | null;
    refundStatus?: string | null; refundAmount?: number | null; totalRefunded?: number | null;
    searchText?: string | null;
    periodDates?: { program?: string[]; pengajuan?: string[]; claim?: string[]; bayar?: string[] } | null;
    claimWorkflowId?: string | null; claimWorkflowStatus?: string | null;
};

export type ItemOpc = {
    id: string; itemNo: number; noSurat: string; noClaim?: string | null; namaProgram: string; periode: string | null; toko: string;
    barang: string | null; nominal: number; caraBayar: string | null; noRekening?: string | null;
    financePaymentStatus?: string | null; financePaidAmount?: number | null;
    type: string | null; normalizedType?: string | null; originalType?: string | null; typeIsLegacy?: boolean | null; pphExempt?: boolean | null;
    deadline: string | null; kwt: boolean; skp: boolean; fp: boolean; pc: boolean; foto: boolean; rekap: boolean; others: boolean; othersText: string | null;
    finalKwt?: boolean | null; finalSkp?: boolean | null; finalFp?: boolean | null; finalPc?: boolean | null; finalFoto?: boolean | null;
    finalRekap?: boolean | null; finalOthers?: boolean | null; finalOthersText?: string | null; finalCompletenessNote?: string | null;
};

export type RefundOpc = {
    id: string; batchId: string; refundNo: number; refundAmount: number; refundMethod: string; refundDate: string;
    senderName?: string | null; receiverBank?: string | null; proofUrl?: string | null; proofName?: string | null; note?: string | null;
    status: string; verifiedAt?: string | null; verificationNote?: string | null; createdAt?: string | null;
};
export type RingkasanRefund = {
    paidAmount: number; verifiedAmount: number; overpaidAmount: number; totalRefunded: number; pendingRefund: number;
    remainingRefund: number; isFullyRefunded: boolean;
};
export type AuditOpc = {
    id: string; batchId: string; itemId?: string | null; actorName?: string | null; actorRole?: string | null; action: string;
    fromStatus?: string | null; toStatus?: string | null; note?: string | null; correctionReason?: string | null;
    parentAuditLogId?: string | null; createdAt?: string | number | null; noPengajuan?: string | null; principleName?: string | null;
};

// ── Label status (salinan statusLabelMap old-opc.tsx 452–492 + status refund) ───────────────────────────

const LABEL_STATUS: Record<string, string> = {
    Draft: "Draf",
    "Submitted to SM": "Dikirim ke Sales Manager",
    "Waiting Review": "Menunggu tinjauan",
    "Returned by SM": "Dikembalikan oleh Sales Manager",
    "Returned by Claim": "Dikembalikan oleh Klaim",
    Returned: "Dikembalikan",
    "Approved by SM": "Disetujui Sales Manager",
    "Waiting Claim": "Menunggu Klaim",
    "Claim Approved": "Disetujui Klaim",
    "Waiting Approval": "Menunggu persetujuan",
    "Ready for OM": "Siap diproses OM",
    "Waiting OM": "Menunggu OM",
    "OM Approved": "Disetujui OM",
    "Cancelled by OM": "Dibatalkan OM",
    "Waiting Payment": "Menunggu pembayaran",
    "Partial Paid": "Dibayar sebagian",
    "Need Correction": "Perlu koreksi",
    Paid: "Sudah dibayar",
    "Returned to Finance": "Dikembalikan ke Keuangan",
    "Waiting Claim Final Verification": "Menunggu verifikasi final Klaim",
    "Incomplete Documents": "Kelengkapan belum lengkap",
    Completed: "Selesai",
    "Not Started": "Belum dimulai",
    Approved: "Disetujui",
    Cancelled: "Dibatalkan",
    "Overpaid - Pending Refund": "Kelebihan dana, menunggu pengembalian",
    "Pending Refund": "Menunggu pengembalian",
    "Partially Refunded": "Sebagian dikembalikan",
    "Fully Refunded": "Sudah dikembalikan penuh",
    "Not Applicable": "Tidak ada selisih",
    // "Notify OM" = omStatus sementara setelah SM setuju, sebelum Klaim meninjau (komentar #12 kode lama).
    "Notify OM": "Menunggu tinjauan OM",
    // Status refund (off_refund.status).
    Pending: "Menunggu verifikasi",
    Verified: "Terverifikasi",
    Rejected: "Ditolak",
};

/** Label Indonesia satu sumbu status; nilai yang tidak dikenal ditampilkan apa adanya (sama dengan kode lama). */
export function labelStatus(status: string | null | undefined): string {
    if (!status) return "–";
    return LABEL_STATUS[status] ?? status;
}

// ── Tahap: enam sumbu → satu alur ───────────────────────────────────────────────────────────────────────

export const ALUR_TAHAP = ["Draf", "SM", "Klaim", "OM", "Bayar", "Final", "Selesai"] as const;
export type TahapKey = "draf" | "dikembalikan" | "sm" | "klaim" | "om" | "bayar" | "final" | "selesai" | "dibatalkan";

/** Opsi saringan tahap (urut alur). */
export const OPSI_TAHAP: Array<{ kunci: TahapKey; label: string }> = [
    { kunci: "draf", label: "Draf" },
    { kunci: "dikembalikan", label: "Dikembalikan" },
    { kunci: "sm", label: "Menunggu SM" },
    { kunci: "klaim", label: "Menunggu Klaim" },
    { kunci: "om", label: "Menunggu OM" },
    { kunci: "bayar", label: "Menunggu bayar" },
    { kunci: "final", label: "Verifikasi final" },
    { kunci: "selesai", label: "Selesai" },
    { kunci: "dibatalkan", label: "Dibatalkan" },
];

const POSISI: Record<TahapKey, number> = { draf: 0, dikembalikan: 0, sm: 1, klaim: 2, om: 3, bayar: 4, final: 5, selesai: 6, dibatalkan: 3 };
type SumbuStatus = Pick<BatchOpc, "status" | "smStatus" | "claimStatus" | "omStatus" | "financeStatus" | "finalStatus">;

const dibatalkan = (b: SumbuStatus) => b.status === "Cancelled" || b.status === "Cancelled by OM" || b.omStatus === "Cancelled";
const selesai = (b: SumbuStatus) => b.status === "Completed" || b.finalStatus === "Completed" || b.finalStatus === "Fully Refunded";
const dikembalikanOleh = (b: SumbuStatus): "SM" | "Klaim" | null =>
    b.status === "Returned by Claim" || b.claimStatus === "Returned" ? "Klaim"
        : b.status === "Returned by SM" || b.smStatus === "Returned" ? "SM" : null;
const menungguSelisih = (b: SumbuStatus) =>
    b.status === "Overpaid - Pending Refund" || b.finalStatus === "Pending Refund" || b.finalStatus === "Partially Refunded";

/**
 * Tahap batch dari kolom status yang ada (tanpa kolom baru). Urutan cek = dari ujung alur ke awal, sehingga sumbu yang
 * tertinggal (mis. smStatus "Approved by SM" pada batch yang sudah dibayar) tidak menarik batch mundur.
 */
export function tahapBatch(b: SumbuStatus): TahapKey {
    if (dibatalkan(b)) return "dibatalkan";
    if (selesai(b)) return "selesai";
    if (dikembalikanOleh(b)) return "dikembalikan";
    if (b.status === "Draft") return "draf";
    if (menungguSelisih(b) || b.status === "Paid" || ["Waiting Claim Final Verification", "Incomplete Documents"].includes(b.finalStatus)) return "final";
    if (b.omStatus === "Approved" || ["Waiting Payment", "Partial Paid", "Need Correction"].includes(b.financeStatus)
        || ["OM Approved", "Partial Paid", "Returned to Finance"].includes(b.status)) return "bayar";
    if (b.claimStatus === "Approved" || b.omStatus === "Waiting Approval" || ["Claim Approved", "Ready for OM", "Waiting OM"].includes(b.status)) return "om";
    if (b.smStatus === "Approved by SM" || b.status === "Approved by SM") return "klaim";
    if (b.status === "Submitted to SM" || b.smStatus === "Waiting Review") return "sm";
    return "draf";
}

export type InfoTahap = { kunci: TahapKey; label: string; tone: Tone; pemilik: string | null; posisi: number };

/** Badge + pemilik tahap. Dikembalikan/Dibatalkan negatif; draf = "Draf" (bukan "Perlu Revisi Supervisor"); lewat SLA → kuning. */
export function infoTahap(b: SumbuStatus & Pick<BatchOpc, "createdByRole">, terlambat = false): InfoTahap {
    const kunci = tahapBatch(b);
    const pembuat = b.createdByRole === "claim" ? "Klaim" : "Supervisor";
    let label = OPSI_TAHAP.find((o) => o.kunci === kunci)!.label;
    let tone: Tone = "info";
    let pemilik: string | null = null;
    switch (kunci) {
        case "draf": tone = "neu"; pemilik = pembuat; break;
        case "dikembalikan": label = `Dikembalikan ${dikembalikanOleh(b)}`; tone = "neg"; pemilik = pembuat; break;
        case "sm": pemilik = "Sales Manager"; break;
        case "klaim": pemilik = "Klaim"; break;
        case "om": pemilik = "Operational Manager"; break;
        case "bayar":
            pemilik = "Keuangan";
            if (b.financeStatus === "Partial Paid" || b.status === "Partial Paid") { label = "Dibayar sebagian"; tone = "warn"; }
            else if (b.financeStatus === "Need Correction") { label = "Perlu koreksi bayar"; tone = "warn"; }
            break;
        case "final":
            pemilik = "Klaim";
            if (menungguSelisih(b)) { label = "Menunggu pengembalian selisih"; tone = "warn"; pemilik = "Supervisor (pengembalian) · Keuangan (verifikasi)"; }
            else if (b.finalStatus === "Incomplete Documents") { label = "Berkas belum lengkap"; tone = "warn"; }
            break;
        case "selesai": tone = "pos"; break;
        case "dibatalkan": tone = "neg"; break;
    }
    if (terlambat && (tone === "info" || tone === "neu")) tone = "warn";
    return { kunci, label, tone, pemilik, posisi: POSISI[kunci] };
}

/** Langkah `Flow` 7 tahap. Dibatalkan berhenti di OM; Selesai semua tuntas; tahap aktif lewat SLA = "late". */
export function alurBatch(b: SumbuStatus, terlambat = false): FlowStep[] {
    const kunci = tahapBatch(b);
    if (kunci === "dibatalkan") {
        return [...ALUR_TAHAP.slice(0, 3).map((label) => ({ label, state: "done" as const })), { label: "Dibatalkan", state: "stop" }];
    }
    if (kunci === "selesai") return ALUR_TAHAP.map((label) => ({ label, state: "done" }));
    const kini = POSISI[kunci];
    return ALUR_TAHAP.map((label, i) => ({ label, state: i < kini ? "done" : i === kini ? (terlambat ? "late" : "current") : "todo" }));
}

// ── Predikat per tab: SALINAN kode lama (jangan diubah tanpa mengubah perilaku tab lama) ────────────────

type B = BatchOpc;
export const PREDIKAT = {
    /** SPV, menu Pengajuan "Draf / Dikembalikan / Perlu Revisi" (old 3056–3063). */
    spvAntrean: (b: B) => b.status === "Draft" || b.status === "Returned by SM" || b.smStatus === "Returned" || b.status === "Returned by Claim" || b.claimStatus === "Returned",
    /** isSupervisorEditableBatch (old 734): SPV boleh mengubah. */
    spvBisaUbah: (b: B) => !b.locked && (b.status === "Draft" || b.status === "Returned by SM" || b.status === "Returned by Claim" || b.smStatus === "Returned" || b.claimStatus === "Returned"),
    /** isSmActionableBatch (old 745): antrean + aksi SM. */
    smAntrean: (b: B) => b.status === "Submitted to SM" && b.smStatus === "Waiting Review",
    /** hasPassedSalesManager (old 753): daftar tab Sales Manager. */
    smPantau: (b: B) => b.smStatus !== "Not Started" || ["Submitted to SM", "Waiting Review", "Approved by SM", "Returned by SM"].includes(b.status),
    /** isClaimQueueBatch (old 5293): antrean + aksi Validasi Setelah SM. */
    klaimAntrean: (b: B) => b.smStatus === "Approved by SM" && !["Approved", "Returned", "Returned by Claim"].includes(String(b.claimStatus || ""))
        && !["Cancelled", "Completed", "Claim Approved", "Returned by Claim"].includes(String(b.status || "")),
    /** isClaimInitialMonitoringBatch (old 5311): daftar Validasi Setelah SM. */
    klaimPantau: (b: B) => PREDIKAT.klaimAntrean(b) || ["Approved", "Returned", "Returned by Claim"].includes(String(b.claimStatus || ""))
        || ["Claim Approved", "Returned by Claim", "Completed"].includes(String(b.status || "")),
    /** isFinalClaimProcessable (old 5837): antrean + aksi Validasi Setelah Keuangan. */
    finalAntrean: (b: B) => b.financeStatus === "Paid" && ["Waiting Claim Final Verification", "Incomplete Documents"].includes(b.finalStatus),
    /** isFinalQueueBatch (old 5321): angka "menunggu" di hub Klaim lama (juga mensyaratkan lunas). */
    finalAntreanHub: (b: B) => b.financeStatus === "Paid" && ["Waiting Claim Final Verification", "Incomplete Documents"].includes(b.finalStatus)
        && b.status === "Paid" && b.paymentSummary?.isFullyPaid === true,
    /** Daftar Monitoring Final Klaim (old 5846). */
    finalPantau: (b: B) => (b.financeStatus === "Paid" && b.finalStatus === "Waiting Claim Final Verification") || b.finalStatus === "Incomplete Documents" || b.finalStatus === "Completed",
    /** Panel Data Klaim: batch CLM milik divisi Claim (old 6994); "Kirim ke SM" hanya untuk Draft (old 7099). */
    clmPantau: (b: B) => b.createdByRole === "claim",
    clmAntrean: (b: B) => b.createdByRole === "claim" && b.status === "Draft",
    /** isOmActionableBatch (old 765): antrean + aksi OM (daftar tab OM lama = semua batch). */
    omAntrean: (b: B) => b.claimStatus === "Approved" && b.omStatus === "Waiting Approval" && ["Claim Approved", "Ready for OM", "Waiting OM"].includes(b.status),
    /** isFinanceQueueBatch (old 8348): antrean Keuangan. */
    keuanganAntrean: (b: B) => b.smStatus === "Approved by SM" && b.claimStatus === "Approved" && b.omStatus === "Approved"
        && ["Waiting Payment", "Partial Paid", "Need Correction"].includes(b.financeStatus) && !["Cancelled by OM", "Paid", "Completed", "Cancelled"].includes(b.status),
    /** isFinanceActionableBatch (old 774): tombol bayar aktif. */
    keuanganBisaBayar: (b: B) => b.omStatus === "Approved" && ["Waiting Payment", "Partial Paid", "Need Correction"].includes(b.financeStatus),
    /** isFinanceMonitoringBatch (old 895): daftar tab Keuangan. */
    keuanganPantau: (b: B) => {
        const adaBayar = Number(b.paidAmount || 0) > 0 || Boolean(b.paymentSummary && b.paymentSummary.totalPaid > 0) || Boolean(b.payments?.length);
        return ["Waiting Payment", "Partial Paid", "Need Correction", "Paid"].includes(b.financeStatus) || b.status === "Paid" || b.status === "Partial Paid"
            || ((b.status === "Completed" || b.finalStatus === "Completed") && adaBayar);
    },
    /** Data Selisih SPV (old 3765): refund perlu diajukan. */
    selisihTerbuka: (b: B) => b.refundStatus === "Pending Refund" || b.refundStatus === "Partially Refunded",
    semua: () => true,
};

export type Predikat = (b: BatchOpc) => boolean;

/** Satu tampilan antrean di sebuah tab. `antrean` = "Menunggu Anda"; `pantau` = daftar tab lama (pemantauan). */
export type Tampilan = { kunci: string; label: string; antrean: Predikat; pantau?: Predikat; kosong: string };

export const TAMPILAN = {
    supervisor: [{ kunci: "pengajuan", label: "Draf & dikembalikan", antrean: PREDIKAT.spvAntrean, pantau: PREDIKAT.semua, kosong: "Tidak ada draf atau batch yang dikembalikan." }],
    sales: [{ kunci: "tinjauan", label: "Tinjauan SM", antrean: PREDIKAT.smAntrean, pantau: PREDIKAT.smPantau, kosong: "Tidak ada batch yang menunggu tinjauan Anda." }],
    claim: [
        // Syarat tahap ikut: data tak konsisten (mis. dibatalkan OM tapi smStatus disetujui) tidak masuk antrean/hitungan Klaim.
        { kunci: "after-sm", label: "Validasi setelah SM", antrean: (b) => PREDIKAT.klaimAntrean(b) && tahapBatch(b) === "klaim", pantau: PREDIKAT.klaimPantau, kosong: "Tidak ada batch yang menunggu validasi klaim." },
        { kunci: "after-finance", label: "Verifikasi final", antrean: (b) => PREDIKAT.finalAntrean(b) && tahapBatch(b) === "final", pantau: PREDIKAT.finalPantau, kosong: "Tidak ada batch yang menunggu verifikasi final." },
        { kunci: "data-claim", label: "Batch Claim (CLM)", antrean: PREDIKAT.clmAntrean, pantau: PREDIKAT.clmPantau, kosong: "Tidak ada draf batch CLM." },
    ],
    om: [{ kunci: "persetujuan", label: "Persetujuan OM", antrean: PREDIKAT.omAntrean, pantau: PREDIKAT.semua, kosong: "Tidak ada batch yang menunggu persetujuan OM." }],
    finance: [{ kunci: "pembayaran", label: "Pembayaran", antrean: PREDIKAT.keuanganAntrean, pantau: PREDIKAT.keuanganPantau, kosong: "Tidak ada batch yang menunggu pembayaran." }],
    overview: [{ kunci: "semua", label: "Semua pengajuan", antrean: PREDIKAT.semua, kosong: "Belum ada pengajuan." }],
} satisfies Record<Exclude<OffTab, "audit">, Tampilan[]>;

// ── Tab per peran (getOffAccessibleTabs; SM hanya tab Sales Manager, sama dengan kode lama 10616–10619) ──

export const TAB_OPC: Array<{ key: OffTab; label: string }> = [
    { key: "overview", label: "Ringkasan" },
    { key: "supervisor", label: "Supervisor" },
    { key: "sales", label: "Sales Manager" },
    { key: "claim", label: "Klaim" },
    { key: "om", label: "Operational Manager" },
    { key: "finance", label: "Keuangan" },
    { key: "audit", label: "Log audit" },
];

export function tabTerlihat(peran: OffRole): OffTab[] {
    const tabs = getOffAccessibleTabs(peran);
    return peran === "sales_manager" ? tabs.filter((t) => t === "sales") : tabs;
}

/** `?tab=` yang diminta bila boleh; selain itu tab pertama yang boleh (atau undefined bila tak ada akses). */
export function tabEfektif(peran: OffRole, diminta: string | null): OffTab | undefined {
    const boleh = tabTerlihat(peran);
    return boleh.find((t) => t === diminta) ?? boleh[0];
}

/**
 * Sub-tampilan dari URL. Klaim: `claimView` (Claim Workflow menaut `after-finance`; `after`/`final` = verifikasi final;
 * `data-claim` = batch CLM; selain itu Validasi setelah SM). Tab lain: `view`.
 */
export function subTampilan(tab: OffTab | undefined, claimView: string | null, view: string | null): string | null {
    if (tab === "claim") {
        if (claimView === "after" || claimView === "after-finance" || claimView === "final") return "after-finance";
        if (claimView === "data-claim") return "data-claim";
        return "after-sm";
    }
    return view || null;
}

/** Tab yang punya Object Page batch di kolom kedua (Log audit tidak). */
export const tabPunyaDetail = (tab: OffTab | undefined) => Boolean(tab) && tab !== "audit";

// ── Izin aksi: matriks peran OFF kode lama (canPerformOffAction). D-01/AM-026 belum diputuskan → jangan diubah di UI. ──

/**
 * `undefined` = boleh; selain itu kalimat alasan untuk `disabledReason`. Sengaja HANYA peran OFF (sama dengan kode lama):
 * izin granular `off_program_control.<aksi>` di grup akses (D-17) tetap ditegakkan server; galatnya tampil di dialog.
 */
export function izinAksi(peran: OffRole, aksi: OffAction): string | undefined {
    return canPerformOffAction(peran, aksi) ? undefined : "Peran OFF Anda tidak mencakup aksi ini.";
}

/**
 * Aturan #6 kode lama (2944–2945, 4331–4345): di tab Supervisor — dan untuk peran Supervisor — PDF surat pengajuan baru boleh
 * dibuka setelah Klaim menyetujui. Tab lain (Ringkasan/OM/Klaim/Keuangan) menautkannya bila ada, seperti drawer Ringkasan lama.
 */
export function pdfBoleh(b: Pick<BatchOpc, "pdfUrl" | "claimStatus">, peran: OffRole, tab: OffTab): boolean {
    if (!b.pdfUrl) return false;
    return (peran !== "supervisor" && tab !== "supervisor") || b.claimStatus === "Approved";
}

// ── Saringan klien (BL-13: 200 batch terbaru dari server, disaring di browser) ───────────────────────────

export type JenisTanggal = "program" | "pengajuan" | "claim" | "bayar";
export const JENIS_TANGGAL: Record<JenisTanggal, string> = {
    program: "Periode program", pengajuan: "Tanggal pengajuan", claim: "Tanggal pengajuan klaim", bayar: "Tanggal bayar",
};
export type Saringan = { cari: string; principal: string; tahap: TahapKey | ""; jenisTanggal: JenisTanggal; bulan: string; dari: string; sampai: string };
export const SARINGAN_KOSONG: Saringan = { cari: "", principal: "", tahap: "", jenisTanggal: "pengajuan", bulan: "", dari: "", sampai: "" };

/** Haystack cari: searchText dari server (termasuk item/toko) atau kolom batch (batchSearchText old 625). */
function teksCari(b: BatchOpc) {
    if (b.searchText) return b.searchText;
    return normalizeSearchText([b.noPengajuan, b.principleName, b.principleCode, b.supervisorName, b.status, b.smStatus, b.claimStatus,
        b.omStatus, b.financeStatus, b.finalStatus, b.noClaim].join(" "));
}

/** Periode (filterBatchesByPeriod old 1015): bulan "YYYY-MM" atau rentang tanggal pada jenis tanggal terpilih; tanpa saringan = semua. */
function cocokPeriode(b: BatchOpc, s: Saringan) {
    if (!s.bulan && !s.dari && !s.sampai) return true;
    const dates = b.periodDates?.[s.jenisTanggal] || [];
    if (dates.length === 0) return false;
    return dates.some((date) => {
        if (s.bulan) return date.slice(0, 7) === s.bulan;
        if (s.dari && date < s.dari) return false;
        if (s.sampai && date > s.sampai) return false;
        return true;
    });
}

export function saringBatch(rows: BatchOpc[], s: Saringan): BatchOpc[] {
    const q = normalizeSearchText(s.cari);
    return rows.filter((b) =>
        (!q || matchesSearch(teksCari(b), q))
        && (!s.principal || b.principleCode === s.principal)
        && (!s.tahap || tahapBatch(b) === s.tahap)
        && cocokPeriode(b, s));
}

export const jumlahSaringan = (s: Saringan) => [s.cari.trim(), s.principal, s.tahap, s.bulan || s.dari || s.sampai].filter(Boolean).length;

/** Opsi principal dari data yang dimuat (getPrincipalOptions old 681). */
export function opsiPrincipal(rows: BatchOpc[]) {
    return Array.from(new Map(rows.filter((b) => b.principleCode || b.principleName)
        .map((b) => [b.principleCode || b.principleName, { value: b.principleCode || b.principleName, label: b.principleName || b.principleCode }])).values())
        .sort((a, b) => a.label.localeCompare(b.label));
}

// ── Riwayat ─────────────────────────────────────────────────────────────────────────────────────────────

const AKSI_AUDIT: Record<string, string> = {
    create_batch: "Membuat batch", update_batch: "Mengubah batch", submit_to_sm: "Mengirim ke SM", pdf_generated: "PDF surat dibuat",
    receipt_pdf_generated: "Kwitansi dibuat", sm_approve: "Menyetujui (SM)", sm_return: "Mengembalikan ke SPV (SM)",
    mock_notification_created: "Notifikasi OM dibuat", claim_approve: "Menyetujui klaim", claim_return: "Mengembalikan (Klaim)",
    om_approve: "Menyetujui (OM)", om_cancel: "Membatalkan (OM)", finance_payment_added: "Mencatat pembayaran",
    final_remind_incomplete_documents: "Mengingatkan kelengkapan berkas", complete: "Menyelesaikan verifikasi final",
    final_claim_overpaid: "Verifikasi final: ada selisih yang harus dikembalikan", submit_refund: "Mengajukan pengembalian selisih",
    verify_refund: "Memverifikasi pengembalian", reject_refund: "Menolak pengembalian", refund_settled: "Selisih lunas dikembalikan",
    legacy_type_migrated: "Tipe program lama dipetakan", audit_correction: "Koreksi riwayat", period_closed: "Periode ditutup",
    period_unlocked: "Kunci periode dibuka",
};
export const labelAksiAudit = (action: string) => AKSI_AUDIT[action] ?? action.replace(/_/g, " ");

const PERAN_AKTOR: Record<string, string> = {
    supervisor: "SPV", sales_manager: "SM", claim: "Klaim", operational_manager: "OM", finance: "Keuangan", admin: "Admin", manager: "Admin",
};
export const labelPeranAktor = (role: string | null | undefined) => (role ? PERAN_AKTOR[role] ?? role : "");

export const LABEL_PERAN: Record<OffRole, string> = {
    admin: "Admin", supervisor: "Supervisor", sales_manager: "Sales Manager", claim: "Klaim", operational_manager: "Operational Manager",
    finance: "Keuangan", sales: "Sales", unknown: "Belum dikenali",
};

// ── Format ──────────────────────────────────────────────────────────────────────────────────────────────

const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

/** "2026-10-06" → "06/10/2026"; nilai lain apa adanya; kosong → "–". */
export function tanggalOpc(ymd: string | null | undefined): string {
    if (!ymd) return "–";
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
    return m && ymd.length <= 10 ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}

/** Timestamp → "06/10/2026 09.40" WITA. */
export function waktuWita(v: string | number | Date | null | undefined): string {
    if (v === null || v === undefined || v === "") return "–";
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    const tgl = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Makassar" }).format(d);
    const jam = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Makassar" }).format(d);
    return `${tgl} ${jam}`;
}

export const periodeBatch = (b: Pick<BatchOpc, "bulan" | "tahun">) => (b.bulan && b.tahun ? `${BULAN[Number(b.bulan) - 1] ?? b.bulan} ${b.tahun}` : "–");
export const totalBatch = (b: BatchOpc) => Number(b.summary?.totalNominal ?? b.totalNominal ?? 0);
export const jumlahItem = (b: BatchOpc) => Number(b.summary?.totalRows ?? b.summary?.rowCount ?? 0);

/** Kelengkapan awal dari SPV (itemDocsSummary old 499). */
export function kelengkapanItem(i: Pick<ItemOpc, "kwt" | "skp" | "fp" | "pc" | "foto" | "rekap" | "others">): string {
    const docs = [i.kwt && "KWT", i.skp && "SKP", i.fp && "FP", i.pc && "PC", i.foto && "Foto", i.rekap && "Rekap", i.others && "Lainnya"].filter(Boolean);
    return docs.length ? docs.join(", ") : "–";
}

/** Severity masalah SLA → tone badge. */
export const toneMasalah = (severity: "warning" | "danger" | "critical"): Tone => (severity === "warning" ? "warn" : "neg");
export const labelMasalah = (severity: "warning" | "danger" | "critical") => ({ warning: "Peringatan", danger: "Serius", critical: "Kritis" })[severity];
