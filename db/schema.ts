/*
 * Tujuan: Skema Drizzle PostgreSQL untuk Better Auth, RBAC, cache master, dan idempotency lokal.
 * Caller: Better Auth adapter, route handler Next.js, script init-db, dan service cache lokal.
 * Dependensi: drizzle-orm/pg-core.
 * Main Functions: table `user`, `session`, `account`, `verification`, `syncState`, `item`, `customer`, `idempotencyLog`.
 * Side Effects: Definisi schema untuk DB read/write PostgreSQL oleh caller.
 */
import { pgTable, text, integer, bigint, doublePrecision, timestamp, boolean, jsonb, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
    id: text("id").primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('emailVerified').notNull(),
    image: text('image'),
    role: text('role').default('viewer'),
    permissions: text('permissions').default('{}'),
    banned: boolean('banned').default(false),
    banReason: text('banReason'),
    banExpires: timestamp('banExpires'),
    // Identitas hierarki insentif (Bagian C, opt-in per-user) — null = tidak ada scoping,
    // user lihat semua sesuai permission normal (perilaku existing, tidak berubah).
    // 'spv' | 'sm' | null. Diisi manual oleh admin lewat Kelola Hierarki kalau mau
    // enforce "SPV/SM cuma lihat bawahan sendiri". Lihat lib/insentif-hierarchy-scope.ts.
    hierarchyRole: text('hierarchyRole'),
    hierarchyName: text('hierarchyName'), // exact spv_name/sm_name string di sales_targets
    createdAt: timestamp('createdAt').notNull(),
    updatedAt: timestamp('updatedAt').notNull()
});

export const session = pgTable("session", {
    id: text("id").primaryKey(),
    expiresAt: timestamp('expiresAt').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('createdAt').notNull(),
    updatedAt: timestamp('updatedAt').notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId').notNull().references(() => user.id),
    impersonatedBy: text('impersonatedBy')
});

export const account = pgTable("account", {
    id: text("id").primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId').notNull().references(() => user.id),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('createdAt').notNull(),
    updatedAt: timestamp('updatedAt').notNull()
});

export const verification = pgTable("verification", {
    id: text("id").primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expiresAt').notNull(),
    createdAt: timestamp('createdAt'),
    updatedAt: timestamp('updatedAt')
});

// --- Enterprise Data Pipeline & Mirroring Cache --- //

export const syncState = pgTable("sync_state", {
    module: text("module").primaryKey(), // e.g., 'item', 'customer'
    lastSyncTimestamp: text("last_sync_timestamp"), // ISO string watermark
    lastPage: integer("last_page").default(1), // Checkpoint for initial load
    status: text("status").default('idle'), // 'idle', 'syncing', 'error'
    updatedAt: timestamp('updated_at')
});

export const item = pgTable("item", {
    id: bigint("id", { mode: "number" }).primaryKey(), // Accurate's internal numeric ID
    no: text("no").notNull(), // Item number/SKU
    name: text("name").notNull(),
    itemType: text("itemType"),
    // Audit F3: real, bukan integer — harga desimal terpotong kalau integer (diubah selagi tabel kosong)
    unitPrice: doublePrecision("unitPrice"),
    rawData: jsonb("raw_data"), // Complete unprocessed payload
    lastUpdate: text("last_update") // Accurate's modified timestamp
});

export const customer = pgTable("customer", {
    id: bigint("id", { mode: "number" }).primaryKey(), // Accurate's internal numeric ID
    customerNo: text("customerNo").notNull(),
    name: text("name").notNull(),
    // Audit F3: real — saldo piutang bisa desimal
    balance: doublePrecision("balance"),
    rawData: jsonb("raw_data"), // Complete unprocessed payload
    lastUpdate: text("last_update") // Accurate's modified timestamp
});

// Audit F3 / PRD 02-03: cache faktur penjualan (sumber piutang/nota) dari Accurate.
// Kolom typed nullable — hanya diisi bila field tersedia di respons list.do; rawData
// menyimpan payload utuh sehingga tidak ada data yang dikarang.
export const salesInvoiceCache = pgTable("sales_invoice", {
    id: bigint("id", { mode: "number" }).primaryKey(), // Accurate's internal numeric ID
    number: text("number"),
    transDate: text("trans_date"),
    customerNo: text("customer_no"),
    customerName: text("customer_name"),
    totalAmount: doublePrecision("total_amount"),
    outstanding: doublePrecision("outstanding"),
    status: text("status"),
    rawData: jsonb("raw_data"),
    lastUpdate: text("last_update")
}, (t) => [
    index("idx_sales_invoice_trans_date").on(t.transDate),
    index("idx_sales_invoice_customer_no").on(t.customerNo)
]);

// Audit F3 / PRD 03: cache retur penjualan dari Accurate (bahan claim retur).
export const salesReturnCache = pgTable("sales_return", {
    id: bigint("id", { mode: "number" }).primaryKey(),
    number: text("number"),
    transDate: text("trans_date"),
    customerNo: text("customer_no"),
    customerName: text("customer_name"),
    totalAmount: doublePrecision("total_amount"),
    status: text("status"),
    rawData: jsonb("raw_data"),
    lastUpdate: text("last_update")
}, (t) => [
    index("idx_sales_return_trans_date").on(t.transDate),
    index("idx_sales_return_customer_no").on(t.customerNo)
]);

export const idempotencyLog = pgTable("idempotency_log", {
    key: text("key").primaryKey(), 
    status: text("status").notNull(), 
    invoiceNo: text("invoiceNo"),
    customerNo: text("customerNo"),
    amount: doublePrecision("amount"),
    transDate: text("transDate"),
    paymentMethod: text("paymentMethod"),
    source: text("source"),
    createdAt: timestamp('createdAt'),
    updatedAt: timestamp('updatedAt')
});

export const accurateOAuthSession = pgTable("accurate_oauth_session", {
    userId: text("user_id").primaryKey().references(() => user.id),
    accessToken: text("access_token").notNull(),
    sessionHost: text("session_host"),
    sessionId: text("session_id"),
    databaseId: text("database_id"),
    databaseAlias: text("database_alias"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
});

// --- OFF Program Control --- //

export const offBatch = pgTable("off_batch", {
    id: text("id").primaryKey(),
    noPengajuan: text("no_pengajuan").notNull().unique(),
    gelombang: text("gelombang").notNull(),
    principleCode: text("principle_code").notNull(),
    principleName: text("principle_name").notNull(),
    bulan: text("bulan").notNull(),
    tahun: text("tahun").notNull(),
    supervisorName: text("supervisor_name").notNull(),
    totalNominal: doublePrecision("total_nominal").notNull().default(0),
    status: text("status").notNull().default("Draft"),
    smStatus: text("sm_status").notNull().default("Not Started"),
    claimStatus: text("claim_status").notNull().default("Not Started"),
    omStatus: text("om_status").notNull().default("Not Started"),
    financeStatus: text("finance_status").notNull().default("Not Started"),
    finalStatus: text("final_status").notNull().default("Not Started"),
    locked: boolean("locked").notNull().default(false),
    createdBy: text("created_by"),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at"),
    smApprovedBy: text("sm_approved_by"),
    smApprovedAt: timestamp("sm_approved_at"),
    smNote: text("sm_note"),
    returnedBy: text("returned_by"),
    returnedAt: timestamp("returned_at"),
    returnNote: text("return_note"),
    claimReviewedBy: text("claim_reviewed_by"),
    claimReviewedAt: timestamp("claim_reviewed_at"),
    claimSubmittedDate: text("claim_submitted_date"),
    claimDeadline: text("claim_deadline"),
    noClaim: text("no_claim"),
    claimNote: text("claim_note"),
    completenessStatus: text("completeness_status"),
    omApprovedBy: text("om_approved_by"),
    omApprovedAt: timestamp("om_approved_at"),
    omNote: text("om_note"),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at"),
    cancelNote: text("cancel_note"),
    paidBy: text("paid_by"),
    paidAt: timestamp("paid_at"),
    paymentDate: text("payment_date"),
    paidAmount: doublePrecision("paid_amount"),
    paymentProofPath: text("payment_proof_path"),
    paymentProofName: text("payment_proof_name"),
    paymentProofMime: text("payment_proof_mime"),
    paymentProofSize: integer("payment_proof_size"),
    paymentMethod: text("payment_method"),
    paymentSenderBank: text("payment_sender_bank"),
    financeNote: text("finance_note"),
    verifiedAmount: doublePrecision("verified_amount"),
    finalClaimNote: text("final_claim_note"),
    pdfPath: text("pdf_path"),
    pdfGeneratedAt: timestamp("pdf_generated_at"),
    pdfStatus: text("pdf_status").notNull().default("pending"),
    receiptPdfPath: text("receipt_pdf_path"),
    receiptPdfGeneratedAt: timestamp("receipt_pdf_generated_at"),
    receiptPdfStatus: text("receipt_pdf_status").notNull().default("pending"),
    refundStatus: text("refund_status").notNull().default("Not Applicable"),
    refundAmount: doublePrecision("refund_amount"),
    totalRefunded: doublePrecision("total_refunded"),
    // No Rekening diinput SPV; hanya ditampilkan ke divisi Keuangan/Pembayaran (#8).
    noRekening: text("no_rekening"),
    // Penanda asal pengajuan: "supervisor" (default) | "claim" (#1-3).
    createdByRole: text("created_by_role"),
    updatedAt: timestamp("updated_at").notNull(),
    createdAt: timestamp("created_at").notNull()
}, (t) => [
    // Audit F1: list terbaru (ORDER BY created_at DESC LIMIT), filter SPV, lookup periode/no-urut
    index("idx_off_batch_created_at").on(t.createdAt),
    index("idx_off_batch_created_by").on(t.createdBy, t.createdAt),
    index("idx_off_batch_periode").on(t.principleCode, t.tahun, t.bulan)
]);

export const offPeriodClosure = pgTable("off_period_closure", {
    id: text("id").primaryKey(),
    principleCode: text("principle_code").notNull(),
    principleName: text("principle_name").notNull(),
    bulan: text("bulan").notNull(),
    tahun: text("tahun").notNull(),
    status: text("status").notNull().default("Terbuka"),
    totalSubmitted: doublePrecision("total_submitted").notNull().default(0),
    totalClaimed: doublePrecision("total_claimed").notNull().default(0),
    submittedCount: integer("submitted_count").notNull().default(0),
    claimedCount: integer("claimed_count").notNull().default(0),
    closedBy: text("closed_by"),
    closedAt: timestamp("closed_at"),
    unlockedBy: text("unlocked_by"),
    unlockedAt: timestamp("unlocked_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull()
});

export const offBatchItem = pgTable("off_batch_item", {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => offBatch.id),
    itemNo: integer("item_no").notNull(),
    rowNo: integer("row_no").notNull(),
    noSurat: text("no_surat"),
    noClaim: text("no_claim"),
    namaProgram: text("nama_program").notNull(),
    periode: text("periode"),
    toko: text("toko"),
    barang: text("barang"),
    nominal: doublePrecision("nominal").notNull().default(0),
    caraBayar: text("cara_bayar"),
    noRekening: text("no_rekening"),
    financePaymentStatus: text("finance_payment_status").notNull().default("unpaid"),
    financePaidAt: timestamp("finance_paid_at"),
    financePaymentId: text("finance_payment_id"),
    financePaidAmount: doublePrecision("finance_paid_amount"),
    type: text("type"),
    // --- Tipe Program (revisi dropdown + legacy) ---
    // originalType menyimpan nilai tipe asli sebelum normalisasi (audit legacy).
    // normalizedType menyimpan hasil normalisasi ke dropdown final.
    // typeIsLegacy menandai data lama (badge "Data Lama").
    originalType: text("original_type"),
    normalizedType: text("normalized_type"),
    typeIsLegacy: boolean("type_is_legacy").notNull().default(false),
    // --- PPh level item/toko (HOLD) ---
    // NOTE: PPh disiapkan nullable di level item/toko, tetapi perhitungan final
    // ditahan karena masih terkait format kwitansi setelah pembayaran.
    pphExempt: boolean("pph_exempt").notNull().default(false),
    pphAmount: doublePrecision("pph_amount"),
    adjustmentPph: doublePrecision("adjustment_pph"),
    deadline: text("deadline"),
    kwt: boolean("kwt").notNull().default(false),
    skp: boolean("skp").notNull().default(false),
    fp: boolean("fp").notNull().default(false),
    pc: boolean("pc").notNull().default(false),
    foto: boolean("foto").notNull().default(false),
    rekap: boolean("rekap").notNull().default(false),
    others: boolean("others").notNull().default(false),
    othersText: text("others_text"),
    finalKwt: boolean("final_kwt").notNull().default(false),
    finalSkp: boolean("final_skp").notNull().default(false),
    finalFp: boolean("final_fp").notNull().default(false),
    finalPc: boolean("final_pc").notNull().default(false),
    finalFoto: boolean("final_foto").notNull().default(false),
    finalRekap: boolean("final_rekap").notNull().default(false),
    finalOthers: boolean("final_others").notNull().default(false),
    finalOthersText: text("final_others_text"),
    finalCompletenessNote: text("final_completeness_note"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull()
}, (t) => [index("idx_off_batch_item_batch").on(t.batchId)]);

export const offPayment = pgTable("off_payment", {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => offBatch.id),
    paymentNo: integer("payment_no").notNull(),
    paymentDate: text("payment_date").notNull(),
    paidAmount: doublePrecision("paid_amount").notNull().default(0),
    paymentMethod: text("payment_method").notNull(),
    paymentSenderBank: text("payment_sender_bank"),
    senderBank: text("sender_bank"),
    paymentProofPath: text("payment_proof_path"),
    paymentProofName: text("payment_proof_name"),
    paymentProofMime: text("payment_proof_mime"),
    paymentProofSize: integer("payment_proof_size"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull()
}, (t) => [index("idx_off_payment_batch").on(t.batchId)]);

export const offRefund = pgTable("off_refund", {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => offBatch.id),
    refundNo: integer("refund_no").notNull(),
    refundAmount: doublePrecision("refund_amount").notNull().default(0),
    refundMethod: text("refund_method").notNull(),
    refundDate: text("refund_date").notNull(),
    senderName: text("sender_name"),
    receiverBank: text("receiver_bank"),
    proofPath: text("proof_path"),
    proofName: text("proof_name"),
    proofMime: text("proof_mime"),
    proofSize: integer("proof_size"),
    note: text("note"),
    status: text("status").notNull().default("Pending"),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at"),
    verificationNote: text("verification_note"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull()
}, (t) => [index("idx_off_refund_batch").on(t.batchId)]);

export const offNotification = pgTable("off_notification", {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => offBatch.id),
    type: text("type").notNull(),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull().default("created"),
    createdAt: timestamp("created_at").notNull()
}, (t) => [index("idx_off_notification_batch").on(t.batchId)]);

export const offAuditLog = pgTable("off_audit_log", {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => offBatch.id),
    itemId: text("item_id"),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    note: text("note"),
    metadata: jsonb("metadata"),
    // --- Correction (non-destructive) untuk akses Claim ---
    // Koreksi audit log TIDAK menghapus jejak lama. Setiap koreksi membuat baris
    // baru yang merujuk parentAuditLogId dan menyimpan snapshot previousValue/newValue.
    correctedBy: text("corrected_by"),
    correctedAt: timestamp("corrected_at"),
    correctionReason: text("correction_reason"),
    previousValue: jsonb("previous_value"),
    newValue: jsonb("new_value"),
    parentAuditLogId: text("parent_audit_log_id"),
    createdAt: timestamp("created_at").notNull()
}, (t) => [index("idx_off_audit_log_batch").on(t.batchId)]);

// --- OFF Discount (Dashboard Diskon SPV) --- //
// Modul jejak digital pengajuan diskon SPV. BELUM menjadi workflow approval resmi.
// Field status disiapkan untuk kebutuhan masa depan, namun approval belum aktif.
export const offDiscountSubmission = pgTable("off_discount_submission", {
    id: text("id").primaryKey(),
    toko: text("toko").notNull(),
    principleCode: text("principle_code"),
    principleName: text("principle_name"),
    program: text("program"),
    nominal: doublePrecision("nominal").notNull().default(0),
    alasan: text("alasan"),
    tanggal: text("tanggal"),
    // status hanya disiapkan untuk masa depan; default "Tercatat" (belum approval resmi).
    status: text("status").notNull().default("Tercatat"),
    catatan: text("catatan"),
    documentPath: text("document_path"),
    documentName: text("document_name"),
    documentMime: text("document_mime"),
    documentSize: integer("document_size"),
    createdById: text("created_by_id"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull()
});

export const offDiscountAuditLog = pgTable("off_discount_audit_log", {
    id: text("id").primaryKey(),
    submissionId: text("submission_id").notNull().references(() => offDiscountSubmission.id),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    note: text("note"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull()
});

// --- Claim Workflow (may start after OFF OM Approved) --- //

export const claimWorkflow = pgTable("claim_workflow", {
    id: text("id").primaryKey(),
    offBatchId: text("off_batch_id").notNull().unique().references(() => offBatch.id),
    claimWorkflowNo: text("claim_workflow_no").notNull().unique(),
    principleCode: text("principle_code").notNull(),
    principleName: text("principle_name").notNull(),
    // Phase R7a — Multi No Claim + Direct Claim Source (additive only):
    // - `sourceType` mendokumentasikan asal data klaim. Saat ini selalu
    //   `off_program`; nilai `direct_kwitansi` dan `manual` disiapkan
    //   untuk R7f (deferred).
    // - `sourceRefId` menyimpan referensi ke sumber non-OFF di masa depan.
    //   Saat ini selalu NULL.
    // - `aggregateStatus` menyimpan status gabungan dari semua submission.
    //   Saat ini mirror dari `status` sampai R7e mengaktifkannya.
    sourceType: text("source_type").notNull().default("off_program"),
    sourceRefId: text("source_ref_id"),
    aggregateStatus: text("aggregate_status"),
    status: text("status").notNull().default("Draft"),
    totalDpp: doublePrecision("total_dpp").notNull().default(0),
    totalPpn: doublePrecision("total_ppn").notNull().default(0),
    totalPph: doublePrecision("total_pph").notNull().default(0),
    totalClaim: doublePrecision("total_claim").notNull().default(0),
    totalPaid: doublePrecision("total_paid").notNull().default(0),
    remainingAmount: doublePrecision("remaining_amount").notNull().default(0),
    submittedToPrincipalAt: timestamp("submitted_to_principal_at"),
    claimLetterPdfPath: text("claim_letter_pdf_path"),
    claimLetterGeneratedAt: timestamp("claim_letter_generated_at"),
    claimLetterGeneratedBy: text("claim_letter_generated_by"),
    summaryPdfPath: text("summary_pdf_path"),
    summaryGeneratedAt: timestamp("summary_generated_at"),
    summaryGeneratedBy: text("summary_generated_by"),
    receiptPdfPath: text("receipt_pdf_path"),
    receiptGeneratedAt: timestamp("receipt_generated_at"),
    receiptGeneratedBy: text("receipt_generated_by"),
    noClaim: text("no_claim"),
    noClaimAssignedAt: timestamp("no_claim_assigned_at"),
    noClaimAssignedBy: text("no_claim_assigned_by"),
    closedAt: timestamp("closed_at"),
    closedBy: text("closed_by"),
    closeNote: text("close_note"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull()
});

export const claimWorkflowItem = pgTable("claim_workflow_item", {
    id: text("id").primaryKey(),
    claimWorkflowId: text("claim_workflow_id").notNull().references(() => claimWorkflow.id),
    // Phase R7a — Multi No Claim (additive):
    // `claimSubmissionId` di R7a bersifat nullable; diisi oleh backfill
    // migration atau oleh route R7b saat item di-assign ke submission.
    // Di R7b ke atas kolom ini menjadi wajib secara bisnis, tetapi
    // diberlakukan di app layer mulai R7b.
    claimSubmissionId: text("claim_submission_id"),
    offBatchItemId: text("off_batch_item_id").references(() => offBatchItem.id),
    noSurat: text("no_surat"),
    jenisPromosi: text("jenis_promosi"),
    periode: text("periode"),
    outlet: text("outlet"),
    dpp: doublePrecision("dpp").notNull().default(0),
    ppnRate: doublePrecision("ppn_rate").notNull().default(0),
    ppnAmount: doublePrecision("ppn_amount").notNull().default(0),
    pphRate: doublePrecision("pph_rate").notNull().default(0),
    pphAmount: doublePrecision("pph_amount").notNull().default(0),
    nilaiKlaim: doublePrecision("nilai_klaim").notNull().default(0),
    status: text("status").notNull().default("Draft"),
    note: text("note"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (table) => ({
    workflowIdx: index("idx_claim_workflow_item_workflow_id").on(table.claimWorkflowId),
    offBatchItemIdx: index("idx_claim_workflow_item_off_batch_item_id").on(table.offBatchItemId),
    submissionIdx: index("idx_claim_workflow_item_submission_id").on(table.claimSubmissionId),
}));

export const claimPayment = pgTable("claim_payment", {
    id: text("id").primaryKey(),
    claimWorkflowId: text("claim_workflow_id").notNull().references(() => claimWorkflow.id),
    // Phase R7a — Multi No Claim (additive):
    // Payment akan pindah ke level submission di Phase R7d. Di R7a kolom
    // ini bersifat opsional dan diisi oleh migration backfill ke default
    // submission per workflow. `claimWorkflowId` tetap dipertahankan
    // sebagai redundant pointer agar query agregate tetap cepat dan
    // backward-compat dengan route existing.
    claimSubmissionId: text("claim_submission_id"),
    paymentDate: text("payment_date").notNull(),
    paymentAmount: doublePrecision("payment_amount").notNull().default(0),
    paymentType: text("payment_type"),
    paymentNote: text("payment_note"),
    proofPath: text("proof_path"),
    createdBy: text("created_by"),
    // Phase R3 — Principal Payment + Outstanding:
    // Void adalah pengganti hard delete untuk koreksi pembayaran.
    // Active payment didefinisikan `voided_at IS NULL`. totalPaid hanya
    // menjumlahkan active payment. Audit log mencatat alasan void di
    // metadata + `void_reason` agar trace lengkap.
    voidedAt: timestamp("voided_at"),
    voidedBy: text("voided_by"),
    voidReason: text("void_reason"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (table) => ({
    workflowIdx: index("idx_claim_payment_workflow_id").on(table.claimWorkflowId),
    voidedAtIdx: index("idx_claim_payment_voided_at").on(table.voidedAt),
    submissionIdx: index("idx_claim_payment_submission_id").on(table.claimSubmissionId),
}));

export const claimAuditLog = pgTable("claim_audit_log", {
    id: text("id").primaryKey(),
    claimWorkflowId: text("claim_workflow_id").notNull().references(() => claimWorkflow.id),
    // Phase R7a — Multi No Claim (additive):
    // Audit tetap satu tabel terpusat. Untuk audit yang scope-nya satu
    // submission (mis. assign No Claim, generate dokumen submission),
    // kolom `claimSubmissionId` diisi dan `auditScope = "submission"`.
    // Audit existing biarkan NULL / `auditScope = "workflow"` supaya
    // timeline UI tetap bisa membedakan.
    claimSubmissionId: text("claim_submission_id"),
    auditScope: text("audit_scope"),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    note: text("note"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull(),
}, (table) => ({
    workflowIdx: index("idx_claim_audit_log_workflow_id").on(table.claimWorkflowId),
    createdAtIdx: index("idx_claim_audit_log_created_at").on(table.createdAt),
    submissionIdx: index("idx_claim_audit_log_submission_id").on(table.claimSubmissionId),
}));

// Phase R7a — Multi No Claim + Direct Claim Source (additive):
// `claim_submission` adalah container baru untuk SATU No Claim. Satu
// `claim_workflow` boleh punya banyak `claim_submission`. Di R7a tabel ini
// hanya dibuat + di-backfill (1 default submission per workflow lama)
// supaya schema siap dipakai oleh Phase R7b ke depan.
export const claimSubmission = pgTable("claim_submission", {
    id: text("id").primaryKey(),
    claimWorkflowId: text("claim_workflow_id").notNull().references(() => claimWorkflow.id),
    noClaim: text("no_claim"),
    noClaimAssignedAt: timestamp("no_claim_assigned_at"),
    noClaimAssignedBy: text("no_claim_assigned_by"),
    scope: text("scope").notNull().default("per_pengajuan"),
    scopeLabel: text("scope_label"),
    status: text("status").notNull().default("Draft"),
    totalDpp: doublePrecision("total_dpp").notNull().default(0),
    totalPpn: doublePrecision("total_ppn").notNull().default(0),
    totalPph: doublePrecision("total_pph").notNull().default(0),
    totalClaim: doublePrecision("total_claim").notNull().default(0),
    totalPaid: doublePrecision("total_paid").notNull().default(0),
    remainingAmount: doublePrecision("remaining_amount").notNull().default(0),
    submittedToPrincipalAt: timestamp("submitted_to_principal_at"),
    claimLetterPdfPath: text("claim_letter_pdf_path"),
    claimLetterGeneratedAt: timestamp("claim_letter_generated_at"),
    claimLetterGeneratedBy: text("claim_letter_generated_by"),
    summaryPdfPath: text("summary_pdf_path"),
    summaryGeneratedAt: timestamp("summary_generated_at"),
    summaryGeneratedBy: text("summary_generated_by"),
    receiptPdfPath: text("receipt_pdf_path"),
    receiptGeneratedAt: timestamp("receipt_generated_at"),
    receiptGeneratedBy: text("receipt_generated_by"),
    closedAt: timestamp("closed_at"),
    closedBy: text("closed_by"),
    closeNote: text("close_note"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (table) => ({
    workflowIdx: index("idx_claim_submission_workflow_id").on(table.claimWorkflowId),
    statusIdx: index("idx_claim_submission_status").on(table.status),
}));

// ============================================================
// Insentif Sales Module — new tables (add-on)
// ============================================================

export const salesProfile = pgTable("sales_profile", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id),
    salesCode: text("sales_code").notNull().unique(),
    salesName: text("sales_name").notNull(),
    principle: text("principle").notNull(),
    branch: text("branch").notNull(),
    channel: text("channel").notNull().default("TT"),
    spvName: text("spv_name"),
    smName: text("sm_name"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (t) => ({
    codeIdx: index("idx_sales_profile_code").on(t.salesCode),
    userIdx: index("idx_sales_profile_user").on(t.userId),
}));

export const salesTargets = pgTable("sales_targets", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull(),
    salesName: text("sales_name").notNull(),
    principle: text("principle").notNull(),
    branch: text("branch").notNull(),
    channel: text("channel").notNull().default("TT"),
    spvName: text("spv_name"),
    smName: text("sm_name"),
    periodMonth: integer("period_month").notNull(),
    periodYear: integer("period_year").notNull(),
    targetValue: doublePrecision("target_value").notNull().default(0),
    targetEc: integer("target_ec").notNull().default(0),
    targetAo: integer("target_ao").notNull().default(0),
    targetIa: integer("target_ia").notNull().default(0),
    splmValue: doublePrecision("splm_value").notNull().default(0),
    // Insentif GT (lib/insentif-sales-calc): "mix" | "exclusive".
    tipeSales: text("tipe_sales").notNull().default("exclusive"),
    // "distributor_principle" | "distributor" | "principle" (full principle → tak ikut skema).
    statusInsentif: text("status_insentif").notNull().default("distributor_principle"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (t) => ({
    periodIdx: index("idx_sales_targets_period").on(t.periodMonth, t.periodYear),
    codeIdx: index("idx_sales_targets_code").on(t.salesCode),
}));

export const salesDailyProgress = pgTable("sales_daily_progress", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull(),
    principle: text("principle").notNull(),
    branch: text("branch").notNull(),
    date: text("date").notNull(),
    periodMonth: integer("period_month").notNull(),
    periodYear: integer("period_year").notNull(),
    invoiceNumber: text("invoice_number"),
    achievedValueDpp: doublePrecision("achieved_value_dpp").notNull().default(0),
    achievedEc: integer("achieved_ec").notNull().default(0),
    achievedAo: integer("achieved_ao").notNull().default(0),
    achievedIa: integer("achieved_ia").notNull().default(0),
    uploadedBy: text("uploaded_by"),
    createdAt: timestamp("created_at").notNull(),
}, (t) => ({
    periodIdx: index("idx_sdp_period").on(t.periodMonth, t.periodYear),
    codeIdx: index("idx_sdp_code").on(t.salesCode),
    dateIdx: index("idx_sdp_date").on(t.date),
}));

export const incentiveTiers = pgTable("incentive_tiers", {
    id: text("id").primaryKey(),
    principle: text("principle").notNull().default("ALL"),
    branch: text("branch").notNull().default("ALL"),
    kpiType: text("kpi_type").notNull(),
    minPercentage: doublePrecision("min_percentage").notNull(),
    maxPercentage: doublePrecision("max_percentage").notNull(),
    incentiveAmount: doublePrecision("incentive_amount").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (t) => ({
    kpiIdx: index("idx_incentive_tiers_kpi").on(t.kpiType),
}));

export const incentivePayments = pgTable("incentive_payments", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull(),
    salesName: text("sales_name").notNull(),
    principle: text("principle").notNull(),
    branch: text("branch").notNull(),
    periodMonth: integer("period_month").notNull(),
    periodYear: integer("period_year").notNull(),
    totalIncentive: doublePrecision("total_incentive").notNull().default(0),
    paymentStatus: text("payment_status").notNull().default("belum"),
    paymentProofUrl: text("payment_proof_url"),
    paymentDate: timestamp("payment_date"),
    paidBy: text("paid_by"),
    paidByName: text("paid_by_name"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (t) => ({
    periodIdx: index("idx_inc_payments_period").on(t.periodMonth, t.periodYear),
    codeIdx: index("idx_inc_payments_code").on(t.salesCode),
    statusIdx: index("idx_inc_payments_status").on(t.paymentStatus),
}));

// Support principle per salesman+principle+periode. Diisi Finance saat payout (setelah bulan tutup).
// Dikurangkan dari konstanta insentif GT — lihat lib/insentif-sales-calc.
export const incentiveSupport = pgTable("incentive_support", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull(),
    principle: text("principle").notNull(),
    periodMonth: integer("period_month").notNull(),
    periodYear: integer("period_year").notNull(),
    supportAmount: doublePrecision("support_amount").notNull().default(0),
    inputBy: text("input_by"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (t) => ({
    periodIdx: index("idx_inc_support_period").on(t.periodMonth, t.periodYear),
    codeIdx: index("idx_inc_support_code").on(t.salesCode),
}));

// ── Hierarki pelaporan SM → SPV → Sales (Bagian C) ──────────────────────────
// Additive, BELUM di-wire ke kalkulasi insentif atau scoping RBAC apapun.
// Key masih teks bebas (sales_code/spv_name/sm_name) — konsisten dgn sales_targets,
// bukan FK ke user.id (SPV/SM belum tentu punya akun login). Upsert-by-key (1 baris
// per sales_code / per spv_name) — tidak ada histori/period, reassign = overwrite.
export const spvSalesAssignment = pgTable("spv_sales_assignment", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull().unique(),
    spvName: text("spv_name").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (t) => ({
    spvIdx: index("idx_spv_sales_assignment_spv").on(t.spvName),
}));

export const smSpvAssignment = pgTable("sm_spv_assignment", {
    id: text("id").primaryKey(),
    spvName: text("spv_name").notNull().unique(),
    smName: text("sm_name").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (t) => ({
    smIdx: index("idx_sm_spv_assignment_sm").on(t.smName),
}));

// Klaim salesman baru oleh SPV (self-service kalau salesCode belum dipegang siapapun;
// kalau sudah dipegang SPV lain -> jadi pending, tunggu approve admin — "rolling").
export const spvSalesClaimRequest = pgTable("spv_sales_claim_request", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull(),
    requestedBySpvName: text("requested_by_spv_name").notNull(),
    requestedByUserId: text("requested_by_user_id").notNull(),
    previousSpvName: text("previous_spv_name"), // null kalau sebelumnya unclaimed
    status: text("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected'
    createdAt: timestamp("created_at").notNull(),
    decidedAt: timestamp("decided_at"),
    decidedByUserId: text("decided_by_user_id"),
}, (t) => ({
    statusIdx: index("idx_spv_claim_request_status").on(t.status),
    salesIdx: index("idx_spv_claim_request_sales").on(t.salesCode),
}));

// ============================================================
// Form Kontrol SUPER Module
// ============================================================

export const jksMaster = pgTable("jks_master", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull(),
    salesName: text("sales_name").notNull(),
    custCode: text("cust_code").notNull(),
    custName: text("cust_name").notNull(),
    market: text("market"),
    alamat: text("alamat"),
    kota: text("kota"),
    hariKunjungan: text("hari_kunjungan"),
    mingguPattern: text("minggu_pattern").notNull().default("all"),
    area: text("area"),
    rayon: text("rayon"),
    principle: text("principle").notNull(),
    channel: text("channel").notNull().default("TT"),
    visitFrequency: integer("visit_frequency").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (t) => ({
    salesPrincipleIdx: index("idx_jks_sales_principle").on(t.salesCode, t.principle),
    custCodeIdx: index("idx_jks_cust_code").on(t.custCode),
    principleHariIdx: index("idx_jks_principle_hari").on(t.principle, t.hariKunjungan),
    uniqueEntry: uniqueIndex("idx_jks_unique").on(t.salesCode, t.custCode, t.principle),
}));

export const salesOutletTxn = pgTable("sales_outlet_txn", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull(),
    custCode: text("cust_code").notNull(),
    principle: text("principle").notNull(),
    date: text("date").notNull(),
    periodMonth: integer("period_month").notNull(),
    periodYear: integer("period_year").notNull(),
    invoiceNumber: text("invoice_number"),
    valueDpp: doublePrecision("value_dpp").notNull().default(0),
    createdAt: timestamp("created_at").notNull(),
}, (t) => ({
    custDateIdx: index("idx_sot_cust_date").on(t.custCode, t.date),
    salesPeriodIdx: index("idx_sot_sales_period").on(t.salesCode, t.periodMonth, t.periodYear),
}));

export const noOrderReason = pgTable("no_order_reason", {
    id: text("id").primaryKey(),
    reasonCode: text("reason_code").notNull().unique(),
    label: text("label").notNull(),
    category: text("category").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
});

export const aoControlDaily = pgTable("ao_control_daily", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull(),
    custCode: text("cust_code").notNull(),
    principle: text("principle").notNull(),
    date: text("date").notNull(),
    periodMonth: integer("period_month").notNull(),
    periodYear: integer("period_year").notNull(),
    status: text("status").notNull().default("not_visited"),
    orderValueDpp: doublePrecision("order_value_dpp"),
    invoiceNumber: text("invoice_number"),
    isVisited: boolean("is_visited"),
    noOrderReasonCode: text("no_order_reason_code"),
    noOrderNote: text("no_order_note"),
    checkinAt: timestamp("checkin_at"),
    checkinPhotoUrl: text("checkin_photo_url"),
    checkoutAt: timestamp("checkout_at"),
    checkoutPhotoUrl: text("checkout_photo_url"),
    checkinLat: doublePrecision("checkin_lat"),
    checkinLng: doublePrecision("checkin_lng"),
    checkinAccuracy: doublePrecision("checkin_accuracy"),
    gpsFlag: text("gps_flag"), // null = OK; comma-joined flags utk review SPV
    autoMatched: boolean("auto_matched").notNull().default(false),
    source: text("source").notNull().default("manual"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
}, (t) => ({
    salesDateIdx: index("idx_ao_sales_date").on(t.salesCode, t.date),
    custPeriodIdx: index("idx_ao_cust_period").on(t.custCode, t.periodMonth, t.periodYear),
    statusIdx: index("idx_ao_status").on(t.status),
    uniqueEntry: uniqueIndex("idx_ao_unique").on(t.salesCode, t.custCode, t.principle, t.date),
}));

export const merchandisingCheck = pgTable("merchandising_check", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull(),
    custCode: text("cust_code").notNull(),
    principle: text("principle").notNull(),
    date: text("date").notNull(),
    produkJelas: boolean("produk_jelas").notNull().default(false),
    displayRapi: boolean("display_rapi").notNull().default(false),
    dibersihkan: boolean("dibersihkan").notNull().default(false),
    ditataulang: boolean("ditataulang").notNull().default(false),
    posisiMudah: boolean("posisi_mudah").notNull().default(false),
    semuaSku: boolean("semua_sku").notNull().default(false),
    photoUrl: text("photo_url"),
    stepPhotos: jsonb("step_photos"),
    note: text("note"),
    createdAt: timestamp("created_at").notNull(),
}, (t) => ({
    salesDateIdx: index("idx_merch_sales_date").on(t.salesCode, t.date),
    custDateIdx: index("idx_merch_cust_date").on(t.custCode, t.date),
}));

export const salesmanDailyReport = pgTable("salesman_daily_report", {
    id: text("id").primaryKey(),
    salesCode: text("sales_code").notNull(),
    date: text("date").notNull(),
    periodMonth: integer("period_month").notNull(),
    periodYear: integer("period_year").notNull(),
    totalTokoJks: integer("total_toko_jks").notNull().default(0),
    totalOrder: integer("total_order").notNull().default(0),
    totalActive: integer("total_active").notNull().default(0),
    totalNotOrder: integer("total_not_order").notNull().default(0),
    totalNotVisited: integer("total_not_visited").notNull().default(0),
    reasonSummary: jsonb("reason_summary"),
    tindakLanjut: text("tindak_lanjut"),
    submittedAt: timestamp("submitted_at"),
    spvAck: boolean("spv_ack").notNull().default(false),
    spvAckBy: text("spv_ack_by"),
    spvAckAt: timestamp("spv_ack_at"),
}, (t) => ({
    salesPeriodIdx: index("idx_sdr_sales_period").on(t.salesCode, t.periodMonth, t.periodYear),
    dateIdx: index("idx_sdr_date").on(t.date),
    uniqueEntry: uniqueIndex("idx_sdr_unique").on(t.salesCode, t.date),
}));

export const spvBriefing = pgTable("spv_briefing", {
    id: text("id").primaryKey(),
    spvName: text("spv_name").notNull(),
    date: text("date").notNull(),
    session: text("session").notNull(),
    agenda: jsonb("agenda"),
    tokoDialas: jsonb("toko_dibahas"),
    penyebab: text("penyebab"),
    solusi: text("solusi"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull(),
}, (t) => ({
    spvDateIdx: index("idx_briefing_spv_date").on(t.spvName, t.date),
}));

export const smControl = pgTable("sm_control", {
    id: text("id").primaryKey(),
    smName: text("sm_name").notNull(),
    date: text("date").notNull(),
    spvChecked: jsonb("spv_checked"),
    jksChecked: boolean("jks_checked").notNull().default(false),
    fotoChecked: boolean("foto_checked").notNull().default(false),
    coachingNote: text("coaching_note"),
    deviations: jsonb("deviations"),
    followUp: text("follow_up"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull(),
}, (t) => ({
    smDateIdx: index("idx_sm_control_date").on(t.smName, t.date),
}));

export const kontrolAuditLog = pgTable("kontrol_audit_log", {
    id: text("id").primaryKey(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at").notNull(),
}, (t) => ({
    entityIdx: index("idx_kal_entity").on(t.entity, t.entityId),
    actorIdx: index("idx_kal_actor").on(t.actorId),
}));

// --- Dynamic RBAC: Access Group (Fase 2/4) --- //
// Additive di atas user.role + user.permissions (keduanya TIDAK dihapus; dibaca
// sebagai override legacy selama transisi). Akses user = UNION permission semua group.

export const accessGroup = pgTable("access_group", {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description"),
    isPreset: boolean("is_preset").notNull().default(false),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
});

// permission_key = "module.action" (mis. "off_program_control.sm_approve").
// Divalidasi ke permission registry (P3) saat tulis — TIDAK ada tabel permissions.
export const groupPermission = pgTable("group_permission", {
    groupId: text("group_id").notNull().references(() => accessGroup.id),
    permissionKey: text("permission_key").notNull(),
}, (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.permissionKey] }),
    groupIdx: index("idx_group_permission_group").on(t.groupId),
}));

export const userGroup = pgTable("user_group", {
    userId: text("user_id").notNull().references(() => user.id),
    groupId: text("group_id").notNull().references(() => accessGroup.id),
    assignedBy: text("assigned_by"),
    assignedAt: timestamp("assigned_at").notNull(),
}, (t) => ({
    pk: primaryKey({ columns: [t.userId, t.groupId] }),
    userIdx: index("idx_user_group_user").on(t.userId),
    groupIdx: index("idx_user_group_group").on(t.groupId),
}));

// Jejak audit perubahan otorisasi: siapa ubah group/permission siapa, kapan.
export const permissionAuditLog = pgTable("permission_audit_log", {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id"),
    actorName: text("actor_name"),
    action: text("action").notNull(), // "group.create" | "user_group.assign" | "group_permission.add" | ...
    targetUserId: text("target_user_id"),
    targetGroupId: text("target_group_id"),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at").notNull(),
}, (t) => ({
    actorIdx: index("idx_pal_actor").on(t.actorUserId),
    targetUserIdx: index("idx_pal_target_user").on(t.targetUserId),
    targetGroupIdx: index("idx_pal_target_group").on(t.targetGroupId),
}));

// --- Laporan Harian per SPV/SM (modul baru) --- //
// Menggantikan pipeline Excel lama (Power Query 2.3 + generate_laporan.exe + kirim_laporan.exe).
// report_recipient = pengganti mapping_laporan.csv (keyword SPV -> daftar email).
// report_run       = audit tiap proses upload/kirim (dry-run vs sent).
export const reportRecipient = pgTable("report_recipient", {
    id: text("id").primaryKey(),
    keyword: text("keyword").notNull().unique(),   // mis. "ANDRI", "MOTASA 1" (match nama file/SPV)
    emails: text("emails").notNull(),              // dipisah koma/titik-koma
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
});

export const reportRun = pgTable("report_run", {
    id: text("id").primaryKey(),
    reportDate: text("report_date").notNull(),     // YYYY-MM-DD periode laporan
    status: text("status").notNull().default("dry_run"), // 'dry_run' | 'sent' | 'failed'
    fileCount: integer("file_count").notNull().default(0),
    emailCount: integer("email_count").notNull().default(0),
    salesRows: integer("sales_rows").notNull().default(0),
    progressRows: integer("progress_rows").notNull().default(0),
    note: text("note"),
    uploadedBy: text("uploaded_by"),
    createdAt: timestamp("created_at").notNull(),
}, (t) => ({
    dateIdx: index("idx_report_run_date").on(t.reportDate),
}));

// log per-penerima tiap run (dry-run preview + hasil kirim)
export const reportRunRecipient = pgTable("report_run_recipient", {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => reportRun.id),
    keyword: text("keyword").notNull(),
    email: text("email").notNull(),
    fileName: text("file_name"),
    sendStatus: text("send_status").notNull().default("pending"), // 'pending' | 'sent' | 'failed'
    error: text("error"),
}, (t) => ({
    runIdx: index("idx_rrr_run").on(t.runId),
}));
