/*
 * Tujuan: Skema Drizzle SQLite untuk Better Auth, RBAC, cache master, idempotency lokal, dan OFF Program Control.
 * Caller: Better Auth adapter, route handler Next.js, script init-db, dan service cache lokal.
 * Dependensi: drizzle-orm/sqlite-core.
 * Main Functions: table `user`, `session`, `account`, `verification`, `syncState`, `item`, `customer`, `idempotencyLog`, `offBatch`, `offPeriodClosure`.
 * Side Effects: Definisi schema untuk DB read/write SQLite oleh caller.
 */
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
    id: text("id").primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull(),
    image: text('image'),
    role: text('role').default('viewer'),
    permissions: text('permissions').default('{}'),
    banned: integer('banned', { mode: 'boolean' }).default(false),
    banReason: text('banReason'),
    banExpires: integer('banExpires', { mode: 'timestamp' }),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull()
});

export const session = sqliteTable("session", {
    id: text("id").primaryKey(),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId').notNull().references(() => user.id),
    impersonatedBy: text('impersonatedBy')
});

export const account = sqliteTable("account", {
    id: text("id").primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId').notNull().references(() => user.id),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull()
});

export const verification = sqliteTable("verification", {
    id: text("id").primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }),
    updatedAt: integer('updatedAt', { mode: 'timestamp' })
});

// --- Enterprise Data Pipeline & Mirroring Cache --- //

export const syncState = sqliteTable("sync_state", {
    module: text("module").primaryKey(), // e.g., 'item', 'customer'
    lastSyncTimestamp: text("last_sync_timestamp"), // ISO string watermark
    lastPage: integer("last_page").default(1), // Checkpoint for initial load
    status: text("status").default('idle'), // 'idle', 'syncing', 'error'
    updatedAt: integer('updated_at', { mode: 'timestamp' })
});

export const item = sqliteTable("item", {
    id: integer("id").primaryKey(), // Accurate's internal numeric ID
    no: text("no").notNull(), // Item number/SKU
    name: text("name").notNull(),
    itemType: text("itemType"),
    unitPrice: integer("unitPrice"),
    rawData: text("raw_data", { mode: 'json' }), // Complete unprocessed payload
    lastUpdate: text("last_update") // Accurate's modified timestamp
});

export const customer = sqliteTable("customer", {
    id: integer("id").primaryKey(), // Accurate's internal numeric ID
    customerNo: text("customerNo").notNull(), 
    name: text("name").notNull(),
    balance: integer("balance"),
    rawData: text("raw_data", { mode: 'json' }), // Complete unprocessed payload
    lastUpdate: text("last_update") // Accurate's modified timestamp
});

export const idempotencyLog = sqliteTable("idempotency_log", {
    key: text("key").primaryKey(), 
    status: text("status").notNull(), 
    invoiceNo: text("invoiceNo"),
    customerNo: text("customerNo"),
    amount: real("amount"),
    transDate: text("transDate"),
    paymentMethod: text("paymentMethod"),
    source: text("source"),
    createdAt: integer('createdAt', { mode: 'timestamp' }),
    updatedAt: integer('updatedAt', { mode: 'timestamp' })
});

// --- OFF Program Control --- //

export const offBatch = sqliteTable("off_batch", {
    id: text("id").primaryKey(),
    noPengajuan: text("no_pengajuan").notNull().unique(),
    gelombang: text("gelombang").notNull(),
    principleCode: text("principle_code").notNull(),
    principleName: text("principle_name").notNull(),
    bulan: text("bulan").notNull(),
    tahun: text("tahun").notNull(),
    supervisorName: text("supervisor_name").notNull(),
    totalNominal: real("total_nominal").notNull().default(0),
    status: text("status").notNull().default("Draft"),
    smStatus: text("sm_status").notNull().default("Not Started"),
    claimStatus: text("claim_status").notNull().default("Not Started"),
    omStatus: text("om_status").notNull().default("Not Started"),
    financeStatus: text("finance_status").notNull().default("Not Started"),
    finalStatus: text("final_status").notNull().default("Not Started"),
    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by"),
    submittedBy: text("submitted_by"),
    submittedAt: integer("submitted_at", { mode: "timestamp" }),
    smApprovedBy: text("sm_approved_by"),
    smApprovedAt: integer("sm_approved_at", { mode: "timestamp" }),
    smNote: text("sm_note"),
    returnedBy: text("returned_by"),
    returnedAt: integer("returned_at", { mode: "timestamp" }),
    returnNote: text("return_note"),
    claimReviewedBy: text("claim_reviewed_by"),
    claimReviewedAt: integer("claim_reviewed_at", { mode: "timestamp" }),
    claimSubmittedDate: text("claim_submitted_date"),
    claimDeadline: text("claim_deadline"),
    noClaim: text("no_claim"),
    claimNote: text("claim_note"),
    completenessStatus: text("completeness_status"),
    omApprovedBy: text("om_approved_by"),
    omApprovedAt: integer("om_approved_at", { mode: "timestamp" }),
    omNote: text("om_note"),
    cancelledBy: text("cancelled_by"),
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    cancelNote: text("cancel_note"),
    paidBy: text("paid_by"),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    paymentDate: text("payment_date"),
    paidAmount: real("paid_amount"),
    paymentProofPath: text("payment_proof_path"),
    paymentProofName: text("payment_proof_name"),
    paymentProofMime: text("payment_proof_mime"),
    paymentProofSize: integer("payment_proof_size"),
    paymentMethod: text("payment_method"),
    paymentSenderBank: text("payment_sender_bank"),
    financeNote: text("finance_note"),
    verifiedAmount: real("verified_amount"),
    finalClaimNote: text("final_claim_note"),
    pdfPath: text("pdf_path"),
    pdfGeneratedAt: integer("pdf_generated_at", { mode: "timestamp" }),
    pdfStatus: text("pdf_status").notNull().default("pending"),
    receiptPdfPath: text("receipt_pdf_path"),
    receiptPdfGeneratedAt: integer("receipt_pdf_generated_at", { mode: "timestamp" }),
    receiptPdfStatus: text("receipt_pdf_status").notNull().default("pending"),
    // --- Refund (Pengembalian Dana Selisih) ---
    // refundStatus mencatat apakah ada selisih yang perlu dikembalikan setelah verifikasi final.
    // "Not Applicable" = tidak ada selisih, "Pending Refund" = ada selisih belum lunas,
    // "Partially Refunded" = sebagian dikembalikan, "Fully Refunded" = lunas.
    refundStatus: text("refund_status").notNull().default("Not Applicable"),
    refundAmount: real("refund_amount"), // Total selisih yang harus dikembalikan
    totalRefunded: real("total_refunded"), // Total yang sudah dikembalikan
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});

export const offPeriodClosure = sqliteTable("off_period_closure", {
    id: text("id").primaryKey(),
    principleCode: text("principle_code").notNull(),
    principleName: text("principle_name").notNull(),
    bulan: text("bulan").notNull(),
    tahun: text("tahun").notNull(),
    status: text("status").notNull().default("Terbuka"),
    totalSubmitted: real("total_submitted").notNull().default(0),
    totalClaimed: real("total_claimed").notNull().default(0),
    submittedCount: integer("submitted_count").notNull().default(0),
    claimedCount: integer("claimed_count").notNull().default(0),
    closedBy: text("closed_by"),
    closedAt: integer("closed_at", { mode: "timestamp" }),
    unlockedBy: text("unlocked_by"),
    unlockedAt: integer("unlocked_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});

export const offBatchItem = sqliteTable("off_batch_item", {
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
    nominal: real("nominal").notNull().default(0),
    caraBayar: text("cara_bayar"),
    type: text("type"),
    // --- Tipe Program (revisi dropdown + legacy) ---
    // originalType menyimpan nilai tipe asli sebelum normalisasi (audit legacy).
    // normalizedType menyimpan hasil normalisasi ke dropdown final.
    // typeIsLegacy menandai data lama (badge "Data Lama").
    originalType: text("original_type"),
    normalizedType: text("normalized_type"),
    typeIsLegacy: integer("type_is_legacy", { mode: "boolean" }).notNull().default(false),
    // --- PPh level item/toko (HOLD) ---
    // NOTE: PPh disiapkan nullable di level item/toko, tetapi perhitungan final
    // ditahan karena masih terkait format kwitansi setelah pembayaran.
    pphExempt: integer("pph_exempt", { mode: "boolean" }).notNull().default(false),
    pphAmount: real("pph_amount"),
    adjustmentPph: real("adjustment_pph"),
    deadline: text("deadline"),
    kwt: integer("kwt", { mode: "boolean" }).notNull().default(false),
    skp: integer("skp", { mode: "boolean" }).notNull().default(false),
    fp: integer("fp", { mode: "boolean" }).notNull().default(false),
    pc: integer("pc", { mode: "boolean" }).notNull().default(false),
    foto: integer("foto", { mode: "boolean" }).notNull().default(false),
    rekap: integer("rekap", { mode: "boolean" }).notNull().default(false),
    others: integer("others", { mode: "boolean" }).notNull().default(false),
    othersText: text("others_text"),
    finalKwt: integer("final_kwt", { mode: "boolean" }).notNull().default(false),
    finalSkp: integer("final_skp", { mode: "boolean" }).notNull().default(false),
    finalFp: integer("final_fp", { mode: "boolean" }).notNull().default(false),
    finalPc: integer("final_pc", { mode: "boolean" }).notNull().default(false),
    finalFoto: integer("final_foto", { mode: "boolean" }).notNull().default(false),
    finalRekap: integer("final_rekap", { mode: "boolean" }).notNull().default(false),
    finalOthers: integer("final_others", { mode: "boolean" }).notNull().default(false),
    finalOthersText: text("final_others_text"),
    finalCompletenessNote: text("final_completeness_note"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});

export const offPayment = sqliteTable("off_payment", {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => offBatch.id),
    paymentNo: integer("payment_no").notNull(),
    paymentDate: text("payment_date").notNull(),
    paidAmount: real("paid_amount").notNull().default(0),
    paymentMethod: text("payment_method").notNull(),
    paymentSenderBank: text("payment_sender_bank"),
    senderBank: text("sender_bank"),
    paymentProofPath: text("payment_proof_path"),
    paymentProofName: text("payment_proof_name"),
    paymentProofMime: text("payment_proof_mime"),
    paymentProofSize: integer("payment_proof_size"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});

export const offNotification = sqliteTable("off_notification", {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => offBatch.id),
    type: text("type").notNull(),
    to: text("to").notNull(),
    subject: text("subject").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull().default("created"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});

export const offAuditLog = sqliteTable("off_audit_log", {
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
    metadata: text("metadata", { mode: "json" }),
    // --- Correction (non-destructive) untuk akses Claim ---
    // Koreksi audit log TIDAK menghapus jejak lama. Setiap koreksi membuat baris
    // baru yang merujuk parentAuditLogId dan menyimpan snapshot previousValue/newValue.
    correctedBy: text("corrected_by"),
    correctedAt: integer("corrected_at", { mode: "timestamp" }),
    correctionReason: text("correction_reason"),
    previousValue: text("previous_value", { mode: "json" }),
    newValue: text("new_value", { mode: "json" }),
    parentAuditLogId: text("parent_audit_log_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});

// --- OFF Refund (Pengembalian Dana Selisih) --- //
// Mencatat pengembalian dana saat realisasi klaim < dana yang sudah dikeluarkan.
// Contoh: diajukan 100jt, sudah dibayar Finance, realisasi klaim hanya 80jt → selisih 20jt wajib dikembalikan.
// Batch tidak bisa Completed sampai selisih = 0.
export const offRefund = sqliteTable("off_refund", {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => offBatch.id),
    refundNo: integer("refund_no").notNull(),
    refundAmount: real("refund_amount").notNull().default(0),
    refundMethod: text("refund_method").notNull(), // "Transfer" | "Tunai" | "Kompensasi Batch Lain"
    refundDate: text("refund_date").notNull(),
    senderName: text("sender_name"), // Siapa yang mengembalikan
    receiverBank: text("receiver_bank"), // Bank penerima (untuk transfer)
    proofPath: text("proof_path"),
    proofName: text("proof_name"),
    proofMime: text("proof_mime"),
    proofSize: integer("proof_size"),
    note: text("note"),
    status: text("status").notNull().default("Pending"), // "Pending" | "Verified" | "Rejected"
    verifiedBy: text("verified_by"),
    verifiedAt: integer("verified_at", { mode: "timestamp" }),
    verificationNote: text("verification_note"),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});

// --- OFF Discount (Dashboard Diskon SPV) --- //
// Modul jejak digital pengajuan diskon SPV. BELUM menjadi workflow approval resmi.
// Field status disiapkan untuk kebutuhan masa depan, namun approval belum aktif.
export const offDiscountSubmission = sqliteTable("off_discount_submission", {
    id: text("id").primaryKey(),
    toko: text("toko").notNull(),
    principleCode: text("principle_code"),
    principleName: text("principle_name"),
    program: text("program"),
    nominal: real("nominal").notNull().default(0),
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
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull()
});

export const offDiscountAuditLog = sqliteTable("off_discount_audit_log", {
    id: text("id").primaryKey(),
    submissionId: text("submission_id").notNull().references(() => offDiscountSubmission.id),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    note: text("note"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});
