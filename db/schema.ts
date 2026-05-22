import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  role: text("role").default("viewer"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("banReason"),
  banExpires: integer("banExpires", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
  impersonatedBy: text("impersonatedBy"),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", {
    mode: "timestamp",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});

// --- Enterprise Data Pipeline & Mirroring Cache --- //

export const syncState = sqliteTable("sync_state", {
  module: text("module").primaryKey(), // e.g., 'item', 'customer'
  lastSyncTimestamp: text("last_sync_timestamp"), // ISO string watermark
  lastPage: integer("last_page").default(1), // Checkpoint for initial load
  status: text("status").default("idle"), // 'idle', 'syncing', 'error'
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

export const item = sqliteTable("item", {
  id: integer("id").primaryKey(), // Accurate's internal numeric ID
  no: text("no").notNull(), // Item number/SKU
  name: text("name").notNull(),
  itemType: text("itemType"),
  unitPrice: integer("unitPrice"),
  rawData: text("raw_data", { mode: "json" }), // Complete unprocessed payload
  lastUpdate: text("last_update"), // Accurate's modified timestamp
});

export const customer = sqliteTable("customer", {
  id: integer("id").primaryKey(), // Accurate's internal numeric ID
  customerNo: text("customerNo").notNull(),
  name: text("name").notNull(),
  balance: integer("balance"),
  rawData: text("raw_data", { mode: "json" }), // Complete unprocessed payload
  lastUpdate: text("last_update"), // Accurate's modified timestamp
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
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});

export const offBatch = sqliteTable("off_batch", {
  id: text("id").primaryKey(),
  noPengajuan: text("no_pengajuan").notNull().unique(),
  gelombang: text("gelombang").notNull(),
  principleCode: text("principle_code").notNull(),
  principleName: text("principle_name").notNull(),
  bulan: text("bulan").notNull(),
  tahun: text("tahun").notNull(),
  supervisorName: text("supervisor_name").notNull(),
  status: text("status").notNull().default("Draft"),
  smStatus: text("sm_status").notNull().default("Waiting"),
  claimStatus: text("claim_status").notNull().default("Not Started"),
  omStatus: text("om_status").notNull().default("Not Started"),
  financeStatus: text("finance_status").notNull().default("Not Started"),
  finalStatus: text("final_status").notNull().default("Not Started"),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  smNote: text("sm_note"),
  claimNote: text("claim_note"),
  omNote: text("om_note"),
  financeNote: text("finance_note"),
  finalClaimNote: text("final_claim_note"),
  noClaim: text("no_claim"),
  claimSubmittedDate: text("claim_submitted_date"),
  claimDeadline: text("claim_deadline"),
  paymentDate: text("payment_date"),
  paidAmount: real("paid_amount"),
  verifiedAmount: real("verified_amount"),
  pdfPath: text("pdf_path"),
  pdfStatus: text("pdf_status").notNull().default("pending"),
  pdfGeneratedAt: integer("pdf_generated_at", { mode: "timestamp" }),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const offBatchItem = sqliteTable("off_batch_item", {
  id: text("id").primaryKey(),
  batchId: text("batch_id")
    .notNull()
    .references(() => offBatch.id),
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
  deadline: text("deadline"),
  kwt: integer("kwt", { mode: "boolean" }).notNull().default(false),
  skp: integer("skp", { mode: "boolean" }).notNull().default(false),
  fp: integer("fp", { mode: "boolean" }).notNull().default(false),
  pc: integer("pc", { mode: "boolean" }).notNull().default(false),
  foto: integer("foto", { mode: "boolean" }).notNull().default(false),
  rekap: integer("rekap", { mode: "boolean" }).notNull().default(false),
  others: integer("others", { mode: "boolean" }).notNull().default(false),
  othersText: text("others_text"),
  // --- Final Claim checklist (diisi oleh Claim setelah Finance bayar) ---
  finalKwt: integer("final_kwt", { mode: "boolean" }).notNull().default(false),
  finalSkp: integer("final_skp", { mode: "boolean" }).notNull().default(false),
  finalFp: integer("final_fp", { mode: "boolean" }).notNull().default(false),
  finalPc: integer("final_pc", { mode: "boolean" }).notNull().default(false),
  finalFoto: integer("final_foto", { mode: "boolean" })
    .notNull()
    .default(false),
  finalRekap: integer("final_rekap", { mode: "boolean" })
    .notNull()
    .default(false),
  finalOthers: integer("final_others", { mode: "boolean" })
    .notNull()
    .default(false),
  finalOthersText: text("final_others_text"),
  finalCompletenessNote: text("final_completeness_note"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const offPayment = sqliteTable("off_payment", {
  id: text("id").primaryKey(),
  batchId: text("batch_id")
    .notNull()
    .references(() => offBatch.id),
  paymentNo: integer("payment_no").notNull(),
  paymentDate: text("payment_date").notNull(),
  paymentMethod: text("payment_method").notNull(),
  paidAmount: real("paid_amount").notNull().default(0),
  senderBank: text("sender_bank"),
  paymentProofName: text("payment_proof_name").notNull(),
  paymentProofPath: text("payment_proof_path"),
  paymentProofMime: text("payment_proof_mime"),
  paymentProofSize: integer("payment_proof_size"),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const offNotification = sqliteTable("off_notification", {
  id: text("id").primaryKey(),
  batchId: text("batch_id")
    .notNull()
    .references(() => offBatch.id),
  type: text("type").notNull(),
  to: text("to").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("created"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const offAuditLog = sqliteTable("off_audit_log", {
  id: text("id").primaryKey(),
  batchId: text("batch_id")
    .notNull()
    .references(() => offBatch.id),
  itemId: text("item_id"),
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  actorRole: text("actor_role"),
  action: text("action").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  note: text("note"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
