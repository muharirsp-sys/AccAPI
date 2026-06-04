// Tujuan: Seed data demo realistis untuk OFF Program Control + Claim Workflow
//         lokal supaya UI dashboard bisa diuji per status tanpa perlu manual
//         menjalankan flow approval dari awal.
// Caller: `node scripts/seed-demo-workflows.mjs` atau `npm run seed:demo`.
// Side Effects: INSERT/DELETE row dengan prefix DEMO-* di tabel OFF + Claim
//               Workflow + claim_payment + audit log.
//               TIDAK menyentuh user/session/account, TIDAK menghapus data
//               non-demo, TIDAK mengubah status route/UI.
//
// Aturan:
// - Refuse jika DATABASE_URL bukan SQLite lokal.
// - Idempotent: cleanup demo lama berdasarkan prefix sebelum insert.
// - Semua item identifikasi pakai prefix DEMO-OFF-*, DEMO-CLAIM-*,
//   DEMO-PAYMENT-*.
// - Tidak menulis EC/CN ke claim_workflow_item — workflow PEKA/EC/CN sudah
//   retired (lihat lib/claim-workflow/constants.ts).
// - Tidak mengubah API/UI route. Hanya seed data.

import { createClient } from "@libsql/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

// =============================================================================
// SECTION 1 — env loader + local SQLite guard
// =============================================================================

function loadEnv() {
    const envPath = resolve(process.cwd(), ".env");
    if (!existsSync(envPath)) return;
    const content = readFileSync(envPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadEnv();

const databaseUrl = process.env.DATABASE_URL || "file:sqlite.db";
function isLocalSqlite(url) {
    if (!url.startsWith("file:")) return false;
    const filePath = url.slice("file:".length);
    if (!filePath) return false;
    if (filePath.startsWith("/app/")) return false;
    return true;
}

if (!isLocalSqlite(databaseUrl)) {
    console.error(`[seed-demo] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    console.error("[seed-demo] Hanya boleh dijalankan untuk file:sqlite.db lokal.");
    process.exit(2);
}

const db = createClient({ url: databaseUrl });

// =============================================================================
// SECTION 2 — utilities
// =============================================================================

const now = new Date();
const NOW_MS = now.getTime();
const ACTOR_ID = "demo-seed";
const ACTOR_NAME = "Demo Seed";
const ACTOR_ROLE = "admin";

function ms(daysAgo) {
    return NOW_MS - daysAgo * 24 * 60 * 60 * 1000;
}

function isoDate(daysAgo) {
    const d = new Date(ms(daysAgo));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function round0(value) {
    return Math.round(Number(value) || 0);
}

function calculateClaimAmount(dpp, ppnRate, pphRate) {
    const ppnAmount = round0(dpp * ppnRate / 100);
    const pphAmount = round0(dpp * pphRate / 100);
    return {
        ppnAmount,
        pphAmount,
        nilaiKlaim: dpp + ppnAmount - pphAmount,
    };
}

async function tableExists(name) {
    const result = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        args: [name],
    });
    return result.rows.length > 0;
}

async function ensureTables() {
    const required = [
        "off_batch", "off_batch_item", "off_payment", "off_audit_log",
        "claim_workflow", "claim_submission", "claim_workflow_item", "claim_payment",
        "claim_audit_log",
    ];
    const missing = [];
    for (const name of required) {
        if (!(await tableExists(name))) missing.push(name);
    }
    if (missing.length > 0) {
        console.error(`[seed-demo] Tabel berikut belum ada: ${missing.join(", ")}`);
        console.error("[seed-demo] Jalankan dulu: node scripts/init-db.mjs");
        process.exit(3);
    }
}

// =============================================================================
// SECTION 3 — cleanup demo lama (idempotent)
// =============================================================================

async function cleanupOldDemo() {
    console.log("[seed-demo] Cleanup demo lama berdasarkan prefix...");
    // Order: child -> parent (ada FOREIGN KEY).
    // Kunci dari demo:
    //   off_batch.no_pengajuan LIKE 'DEMO-OFF-%'
    //   claim_workflow.claim_workflow_no LIKE 'DEMO-CLAIM-%'
    const offBatchIds = await db.execute(
        "SELECT id FROM off_batch WHERE no_pengajuan LIKE 'DEMO-OFF-%'",
    );
    const offIds = offBatchIds.rows.map((r) => r.id);

    const cwfIds = offIds.length > 0
        ? await db.execute({
            sql: `SELECT id FROM claim_workflow
                  WHERE claim_workflow_no LIKE 'DEMO-CLAIM-%'
                     OR claim_workflow_no LIKE 'CLM/DEMO-OFF-%'
                     OR off_batch_id IN (${offIds.map(() => "?").join(",")})`,
            args: offIds,
        })
        : await db.execute(
            "SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE 'DEMO-CLAIM-%' OR claim_workflow_no LIKE 'CLM/DEMO-OFF-%'",
        );
    const claimIds = cwfIds.rows.map((r) => r.id);

    if (claimIds.length > 0) {
        const placeholders = claimIds.map(() => "?").join(",");
        await db.execute({ sql: `DELETE FROM claim_audit_log WHERE claim_workflow_id IN (${placeholders})`, args: claimIds });
        await db.execute({ sql: `DELETE FROM claim_payment WHERE claim_workflow_id IN (${placeholders})`, args: claimIds });
        await db.execute({ sql: `DELETE FROM claim_workflow_item WHERE claim_workflow_id IN (${placeholders})`, args: claimIds });
        await db.execute({ sql: `DELETE FROM claim_submission WHERE claim_workflow_id IN (${placeholders})`, args: claimIds });
    }
    if (claimIds.length > 0) {
        const placeholders = claimIds.map(() => "?").join(",");
        await db.execute({ sql: `DELETE FROM claim_workflow WHERE id IN (${placeholders})`, args: claimIds });
    }

    if (offIds.length > 0) {
        const placeholders = offIds.map(() => "?").join(",");
        await db.execute({ sql: `DELETE FROM off_audit_log WHERE batch_id IN (${placeholders})`, args: offIds });
        await db.execute({ sql: `DELETE FROM off_notification WHERE batch_id IN (${placeholders})`, args: offIds });
        await db.execute({ sql: `DELETE FROM off_payment WHERE batch_id IN (${placeholders})`, args: offIds });
        await db.execute({ sql: `DELETE FROM off_batch_item WHERE batch_id IN (${placeholders})`, args: offIds });
    }
    await db.execute("DELETE FROM off_batch WHERE no_pengajuan LIKE 'DEMO-OFF-%'");

    // Jika tabel legacy claim_peka_report masih ada di DB lokal lama, bersihkan
    // baris demo PEKA agar tidak menumpuk. Aplikasi sudah tidak menulisnya
    // lagi, tapi DB lama mungkin masih punya tabel ini.
    if (await tableExists("claim_peka_report")) {
        await db.execute("DELETE FROM claim_peka_report WHERE source_file LIKE 'DEMO-PEKA-%'");
        console.log(`  - claim_peka_report (legacy): prefix DEMO-PEKA-* dibersihkan`);
    }

    console.log(`  - off_batch: ${offIds.length} dihapus`);
    console.log(`  - claim_workflow: ${claimIds.length} dihapus`);
}

// =============================================================================
// SECTION 4 — definisi demo OFF batch per status
// =============================================================================

const PRINCIPLES = [
    { code: "RB", name: "RECKITT BENCKISER, PT" },
    { code: "KINO", name: "KINO INDONESIA. TBK, PT" },
    { code: "GDI", name: "GODREJ DISTRIBUSI INDONESIA, PT" },
    { code: "MOTASA", name: "MOTASA INDONESIA, PT" },
];

function pickPrinciple(index) {
    return PRINCIPLES[index % PRINCIPLES.length];
}

// Konfigurasi setiap status OFF: kombinasi field status saling terkait
// (status, smStatus, claimStatus, omStatus, financeStatus, finalStatus, locked)
// disusun mengikuti pola yang ditulis route handler resmi:
//   submit         -> Submitted to SM
//   sm-approve     -> Approved by SM, smStatus=Approved by SM, locked=1
//   sm-return      -> Returned by SM, smStatus=Returned, locked=0
//   claim-review approve -> Claim Approved, claimStatus=Approved, omStatus=Waiting Approval, locked=1
//   claim-review return  -> Returned by Claim, claimStatus=Returned, locked=0
//   om-decision approve  -> OM Approved, omStatus=Approved, financeStatus=Waiting Payment, locked=1
//   om-decision cancel   -> Cancelled by OM, omStatus=Cancelled, locked=1
//   finance-payment partial -> Partial Paid, financeStatus=Partial Paid
//   finance-payment full    -> Paid, financeStatus=Paid, finalStatus=Waiting Claim Final Verification
//   final-claim complete    -> Completed, finalStatus=Completed
const OFF_STATUS_CONFIGS = [
    {
        key: "draft",
        status: "Draft",
        smStatus: "Not Started",
        claimStatus: "Not Started",
        omStatus: "Not Started",
        financeStatus: "Not Started",
        finalStatus: "Not Started",
        locked: 0,
        pdfStatus: "pending",
    },
    {
        key: "submitted_to_sm",
        status: "Submitted to SM",
        smStatus: "Waiting Review",
        claimStatus: "Not Started",
        omStatus: "Not Started",
        financeStatus: "Not Started",
        finalStatus: "Not Started",
        locked: 0,
        pdfStatus: "generated",
    },
    {
        key: "returned_by_sm",
        status: "Returned by SM",
        smStatus: "Returned",
        claimStatus: "Not Started",
        omStatus: "Not Started",
        financeStatus: "Not Started",
        finalStatus: "Not Started",
        locked: 0,
        smNote: "DEMO: tolong revisi nominal item ke-1 sesuai SKP terbaru.",
        pdfStatus: "generated",
    },
    {
        key: "approved_by_sm",
        status: "Approved by SM",
        smStatus: "Approved by SM",
        claimStatus: "Not Started",
        omStatus: "Notify OM",
        financeStatus: "Not Started",
        finalStatus: "Not Started",
        locked: 1,
        pdfStatus: "generated",
    },
    {
        key: "returned_by_claim",
        status: "Returned by Claim",
        smStatus: "Approved by SM",
        claimStatus: "Returned",
        omStatus: "Notify OM",
        financeStatus: "Not Started",
        finalStatus: "Not Started",
        locked: 0,
        claimNote: "DEMO: kelengkapan dokumen kurang KWT.",
        pdfStatus: "generated",
    },
    {
        key: "claim_approved",
        status: "Claim Approved",
        smStatus: "Approved by SM",
        claimStatus: "Approved",
        omStatus: "Waiting Approval",
        financeStatus: "Not Started",
        finalStatus: "Not Started",
        locked: 1,
        claimSubmittedDate: isoDate(2),
        claimDeadline: isoDate(-30),
        claimNote: "DEMO: lengkapi tanggal pengajuan dan deadline.",
        completenessStatus: "Aman",
        pdfStatus: "generated",
    },
    {
        key: "cancelled_by_om",
        status: "Cancelled by OM",
        smStatus: "Approved by SM",
        claimStatus: "Approved",
        omStatus: "Cancelled",
        financeStatus: "Not Started",
        finalStatus: "Not Started",
        locked: 1,
        omNote: "DEMO: program promosi dihentikan principal.",
        pdfStatus: "generated",
    },
    {
        key: "om_approved",
        status: "OM Approved",
        smStatus: "Approved by SM",
        claimStatus: "Approved",
        omStatus: "Approved",
        financeStatus: "Waiting Payment",
        finalStatus: "Not Started",
        locked: 1,
        pdfStatus: "generated",
    },
    {
        key: "partial_paid",
        status: "Partial Paid",
        smStatus: "Approved by SM",
        claimStatus: "Approved",
        omStatus: "Approved",
        financeStatus: "Partial Paid",
        finalStatus: "Not Started",
        locked: 1,
        pdfStatus: "generated",
        partialFraction: 0.5,
    },
    {
        key: "paid",
        status: "Paid",
        smStatus: "Approved by SM",
        claimStatus: "Approved",
        omStatus: "Approved",
        financeStatus: "Paid",
        finalStatus: "Waiting Claim Final Verification",
        locked: 1,
        pdfStatus: "generated",
        partialFraction: 1,
    },
    {
        key: "completed",
        status: "Completed",
        smStatus: "Approved by SM",
        claimStatus: "Approved",
        omStatus: "Approved",
        financeStatus: "Paid",
        finalStatus: "Completed",
        locked: 1,
        pdfStatus: "generated",
        partialFraction: 1,
    },
];

function buildOffItems(prefixSeq, principle, count = 2) {
    // Setiap item: nominal default 5_000_000 + idx*1_500_000 supaya bervariasi.
    // noSurat memakai pola DEMO-CLAIM-{principleCode}-{seq}/{itemNo} agar
    // mudah dikorelasikan dengan claim workflow item.
    const items = [];
    for (let i = 1; i <= count; i += 1) {
        items.push({
            id: randomUUID(),
            itemNo: i,
            rowNo: i,
            noSurat: `DEMO-CLAIM-${principle.code}-${prefixSeq}/${String(i).padStart(3, "0")}`,
            namaProgram: `Program Promosi ${principle.code} #${prefixSeq}`,
            periode: `${isoDate(60)} - ${isoDate(30)}`,
            toko: `Toko Demo ${principle.code}-${i}`,
            barang: `Produk Sample ${principle.code} ${i}`,
            nominal: 5_000_000 + (i - 1) * 1_500_000,
            caraBayar: i % 2 === 0 ? "Tunai" : "Transfer",
            type: "OFF",
            deadline: isoDate(-15),
            kwt: 1, skp: 1, fp: 1, pc: 0, foto: 1, rekap: 0, others: 0,
        });
    }
    return items;
}

async function insertOffBatch(seq, config, principle) {
    const batchId = randomUUID();
    const noPengajuan = `DEMO-OFF-${String(seq).padStart(3, "0")}-${principle.code}`;
    const items = buildOffItems(seq, principle, 2);
    const totalNominal = items.reduce((sum, it) => sum + it.nominal, 0);

    const partialFraction = config.partialFraction ?? 0;
    const paidAmount = round0(totalNominal * partialFraction);

    await db.execute({
        sql: `INSERT INTO off_batch (
            id, no_pengajuan, gelombang, principle_code, principle_name, bulan, tahun,
            supervisor_name, total_nominal, status, sm_status, claim_status, om_status,
            finance_status, final_status, locked, created_by, submitted_by, submitted_at,
            sm_approved_by, sm_approved_at, sm_note, returned_by, returned_at, return_note,
            claim_reviewed_by, claim_reviewed_at, claim_submitted_date, claim_deadline,
            no_claim, claim_note, completeness_status,
            om_approved_by, om_approved_at, om_note,
            cancelled_by, cancelled_at, cancel_note,
            paid_by, paid_at, payment_date, paid_amount,
            payment_proof_path, payment_proof_name, payment_proof_mime, payment_proof_size,
            payment_method, payment_sender_bank, finance_note, verified_amount, final_claim_note,
            pdf_path, pdf_generated_at, pdf_status,
            receipt_pdf_path, receipt_pdf_generated_at, receipt_pdf_status,
            updated_at, created_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?
        )`,
        args: [
            batchId, noPengajuan, "DEMO", principle.code, principle.name,
            String(now.getMonth() + 1).padStart(2, "0"), String(now.getFullYear()),
            "Supervisor Demo",
            totalNominal,
            config.status, config.smStatus, config.claimStatus, config.omStatus,
            config.financeStatus, config.finalStatus, config.locked,
            ACTOR_ID, ACTOR_ID, ms(20),
            config.smStatus === "Approved by SM" ? ACTOR_ID : null,
            config.smStatus === "Approved by SM" ? ms(15) : null,
            null,
            config.smStatus === "Returned" ? ACTOR_ID : null,
            config.smStatus === "Returned" ? ms(14) : null,
            config.smNote || null,
            ["Approved", "Returned"].includes(config.claimStatus) ? ACTOR_ID : null,
            ["Approved", "Returned"].includes(config.claimStatus) ? ms(10) : null,
            config.claimSubmittedDate || null,
            config.claimDeadline || null,
            null,
            config.claimNote || null,
            config.completenessStatus || null,
            config.omStatus === "Approved" ? ACTOR_ID : null,
            config.omStatus === "Approved" ? ms(8) : null,
            config.omNote || null,
            config.omStatus === "Cancelled" ? ACTOR_ID : null,
            config.omStatus === "Cancelled" ? ms(8) : null,
            null,
            paidAmount > 0 ? ACTOR_ID : null,
            paidAmount > 0 ? ms(5) : null,
            paidAmount > 0 ? isoDate(5) : null,
            paidAmount,
            null, null, null, null,
            paidAmount > 0 ? "Transfer" : null,
            paidAmount > 0 ? "BCA Demo" : null,
            null,
            config.finalStatus === "Completed" ? paidAmount : 0,
            null,
            null, null, config.pdfStatus || "pending",
            null, null, "pending",
            ms(1), ms(20),
        ],
    });

    for (const item of items) {
        await db.execute({
            sql: `INSERT INTO off_batch_item (
                id, batch_id, item_no, row_no, no_surat, no_claim, nama_program,
                periode, toko, barang, nominal, cara_bayar, type, deadline,
                kwt, skp, fp, pc, foto, rekap, others, others_text,
                final_kwt, final_skp, final_fp, final_pc, final_foto, final_rekap,
                final_others, final_others_text, final_completeness_note,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?
            )`,
            args: [
                item.id, batchId, item.itemNo, item.rowNo, item.noSurat, null, item.namaProgram,
                item.periode, item.toko, item.barang, item.nominal, item.caraBayar, item.type, item.deadline,
                item.kwt, item.skp, item.fp, item.pc, item.foto, item.rekap, item.others, null,
                config.finalStatus === "Completed" ? 1 : 0,
                config.finalStatus === "Completed" ? 1 : 0,
                config.finalStatus === "Completed" ? 1 : 0,
                0, 0, 0, 0, null, null,
                ms(20), ms(1),
            ],
        });
    }

    if (paidAmount > 0) {
        await db.execute({
            sql: `INSERT INTO off_payment (
                id, batch_id, payment_no, payment_date, paid_amount, payment_method,
                payment_sender_bank, sender_bank, payment_proof_path, payment_proof_name,
                payment_proof_mime, payment_proof_size, note, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                randomUUID(), batchId, 1, isoDate(5), paidAmount, "Transfer",
                "BCA Demo", "BCA Demo", null, null, null, null,
                "DEMO seed payment", ACTOR_ID, ms(5), ms(5),
            ],
        });
    }

    await db.execute({
        sql: `INSERT INTO off_audit_log (id, batch_id, item_id, actor_id, actor_name, actor_role,
            action, from_status, to_status, note, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            randomUUID(), batchId, null, ACTOR_ID, ACTOR_NAME, ACTOR_ROLE,
            "demo_seed_create_batch", null, config.status,
            "DEMO seed: batch dibuat untuk demo status " + config.key,
            JSON.stringify({ demo: true, seedKey: config.key, itemCount: items.length }),
            ms(20),
        ],
    });

    return { batchId, noPengajuan, items, totalNominal, paidAmount };
}

// =============================================================================
// SECTION 5 — definisi demo Claim Workflow per status
// =============================================================================
//
// Status Claim Workflow setelah cleanup PEKA/EC/CN:
//   Draft -> Need Revision -> Ready to Submit -> Submitted to Principal
//   -> Partially Paid -> Paid -> Closed
//   plus Outstanding (monitoring) dan Cancelled.
//
// Demo me-cover semua status production di atas. Pembayaran dari principal
// (Partially Paid / Paid) disimulasikan via claim_payment row.

const CLAIM_WORKFLOW_CONFIGS = [
    {
        key: "draft",
        status: "Draft",
        paidFraction: 0,
        hasPdf: false,
        hasSubmittedAt: false,
        hasNoClaim: false,
    },
    {
        key: "need_revision",
        status: "Need Revision",
        paidFraction: 0,
        hasPdf: false,
        hasSubmittedAt: false,
        hasNoClaim: false,
    },
    {
        key: "ready_to_submit",
        status: "Ready to Submit",
        paidFraction: 0,
        hasPdf: true,
        hasSubmittedAt: false,
        hasNoClaim: true,
    },
    {
        key: "submitted_to_principal",
        status: "Submitted to Principal",
        paidFraction: 0,
        hasPdf: true,
        hasSubmittedAt: true,
        hasNoClaim: true,
    },
    {
        key: "partially_paid",
        status: "Partially Paid",
        paidFraction: 0.5,
        hasPdf: true,
        hasSubmittedAt: true,
        hasNoClaim: true,
    },
    {
        key: "paid",
        status: "Paid",
        paidFraction: 1,
        hasPdf: true,
        hasSubmittedAt: true,
        hasNoClaim: true,
    },
    {
        key: "outstanding",
        status: "Outstanding",
        paidFraction: 0,
        hasPdf: true,
        hasSubmittedAt: true,
        hasNoClaim: true,
    },
    {
        key: "closed",
        status: "Closed",
        paidFraction: 1,
        hasPdf: true,
        hasSubmittedAt: true,
        hasNoClaim: true,
        isClosed: true,
    },
];

const CLAIM_STATUS_KNOWN = new Set([
    "Draft", "Need Revision", "Ready to Submit", "Submitted to Principal",
    "Partially Paid", "Paid", "Outstanding", "Closed", "Cancelled",
]);

// Generate PDF stub minimal pakai pdf-lib supaya path yang disimpan ke DB
// benar-benar valid dan bisa dibuka via /api/claim-workflow/[id]/...
// Kalau pdf-lib gagal di-load, kembalikan null dan caller akan log skip.
async function tryGenerateClaimLetterPdf(workflow) {
    return tryGenerateStubPdf(workflow, {
        kind: "claim-letter",
        title: "DEMO CLAIM LETTER",
        subjectSuffix: "(DEMO)",
        directory: "letters",
        filenameSuffix: "demo",
    });
}

async function tryGenerateClaimSummaryPdf(workflow) {
    return tryGenerateStubPdf(workflow, {
        kind: "summary",
        title: "DEMO CLAIM SUMMARY",
        subjectSuffix: "(DEMO Summary)",
        directory: "summaries",
        filenameSuffix: "summary-demo",
    });
}

async function tryGenerateClaimReceiptPdf(workflow) {
    return tryGenerateStubPdf(workflow, {
        kind: "receipt",
        title: "DEMO KWITANSI CLAIM",
        subjectSuffix: "(DEMO Receipt)",
        directory: "receipts",
        filenameSuffix: "receipt-demo",
    });
}

async function tryGenerateStubPdf(workflow, options) {
    try {
        const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
        const pdfDoc = await PDFDocument.create();
        pdfDoc.setTitle(`${options.title} ${workflow.claimWorkflowNo}`);
        pdfDoc.setSubject(`${options.title} - ${workflow.principleName} ${options.subjectSuffix}`);
        pdfDoc.setCreator("AccAPI Claim Workflow Demo Seed");
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const page = pdfDoc.addPage([595.28, 841.89]);
        page.drawText(options.title, {
            x: 48, y: 780, size: 18, font: bold, color: rgb(0.1, 0.13, 0.2),
        });
        page.drawText(`No: ${workflow.claimWorkflowNo}`, {
            x: 48, y: 750, size: 11, font, color: rgb(0.18, 0.22, 0.28),
        });
        page.drawText(`Principle: ${workflow.principleName}`, {
            x: 48, y: 730, size: 11, font, color: rgb(0.18, 0.22, 0.28),
        });
        page.drawText(`Status: ${workflow.status}`, {
            x: 48, y: 710, size: 11, font,
        });
        page.drawText(`Total Claim: Rp ${Number(workflow.totalClaim || 0).toLocaleString("id-ID")}`, {
            x: 48, y: 690, size: 11, font,
        });
        page.drawText("File PDF ini di-generate oleh seed lokal untuk keperluan demo UI.", {
            x: 48, y: 650, size: 10, font, color: rgb(0.4, 0.45, 0.5),
        });
        page.drawText("Bukan dokumen klaim sebenarnya; jangan dikirim ke principal.", {
            x: 48, y: 635, size: 10, font, color: rgb(0.4, 0.45, 0.5),
        });
        const bytes = await pdfDoc.save();
        const dir = join(process.cwd(), "runtime", "claim-workflow", options.directory);
        mkdirSync(dir, { recursive: true });
        const safe = workflow.claimWorkflowNo.replace(/[^a-zA-Z0-9._-]+/g, "-");
        const filePath = join(dir, `${safe}-${options.filenameSuffix}.pdf`);
        writeFileSync(filePath, bytes);
        return filePath;
    } catch (error) {
        console.warn(`  [warn] PDF ${options.kind} stub gagal untuk ${workflow.claimWorkflowNo}: ${error?.message || error}`);
        return null;
    }
}

async function insertClaimWorkflow(seq, config, offBatch, principle) {
    const id = randomUUID();
    const submissionId = randomUUID();
    const claimWorkflowNo = `DEMO-CLAIM-${String(seq).padStart(3, "0")}-${principle.code}`;
    // Phase R1: noClaim utama disimpan di claim_workflow dan disinkronkan
    // ke off_batch_item.no_claim. Demo memakai pola DEMO-NOCLAIM-{seq}/...
    // supaya jelas bukan No Claim production.
    const noClaim = config.hasNoClaim
        ? `DEMO-NOCLAIM-${String(seq).padStart(3, "0")}/${principle.code}/${String(now.getFullYear())}`
        : null;

    // Item dari OFF batch sumber. DPP = nominal item.
    // Cleanup PEKA: tidak ada lagi flag applyEcCn — pphRate ditentukan oleh
    // status workflow saja (Submitted+ pakai 2% sesuai praktik klaim).
    const ppnRate = 11; // standar PPN saat ini
    const usePph = config.hasSubmittedAt || config.status === "Ready to Submit";
    const pphRate = usePph ? 2 : 0;
    let totalDpp = 0;
    let totalPpn = 0;
    let totalPph = 0;
    let totalClaim = 0;

    const items = offBatch.items.map((it) => {
        const dpp = it.nominal;
        const calc = calculateClaimAmount(dpp, ppnRate, pphRate);
        totalDpp += dpp;
        totalPpn += calc.ppnAmount;
        totalPph += calc.pphAmount;
        totalClaim += calc.nilaiKlaim;
        return {
            id: randomUUID(),
            offBatchItemId: it.id,
            noSurat: it.noSurat,
            jenisPromosi: it.namaProgram,
            periode: it.periode,
            outlet: it.toko,
            dpp,
            ppnRate,
            ppnAmount: calc.ppnAmount,
            pphRate,
            pphAmount: calc.pphAmount,
            nilaiKlaim: calc.nilaiKlaim,
            status: "Draft",
            note: null,
        };
    });

    const totalPaid = round0(totalClaim * (config.paidFraction || 0));
    const remainingAmount = Math.max(totalClaim - totalPaid, 0);

    let pdfPath = null;
    let pdfGeneratedAt = null;
    let summaryPdfPath = null;
    let summaryGeneratedAt = null;
    let receiptPdfPath = null;
    let receiptGeneratedAt = null;
    if (config.hasPdf) {
        pdfPath = await tryGenerateClaimLetterPdf({
            claimWorkflowNo, principleName: principle.name, status: config.status, totalClaim,
        });
        if (pdfPath) pdfGeneratedAt = ms(7);
        summaryPdfPath = await tryGenerateClaimSummaryPdf({
            claimWorkflowNo, principleName: principle.name, status: config.status, totalClaim,
        });
        if (summaryPdfPath) summaryGeneratedAt = ms(7);
        receiptPdfPath = await tryGenerateClaimReceiptPdf({
            claimWorkflowNo, principleName: principle.name, status: config.status, totalClaim,
        });
        if (receiptPdfPath) receiptGeneratedAt = ms(7);
    }

    await db.execute({
        sql: `INSERT INTO claim_workflow (
            id, off_batch_id, claim_workflow_no, principle_code, principle_name, status,
            total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount,
            submitted_to_principal_at, claim_letter_pdf_path, claim_letter_generated_at,
            claim_letter_generated_by,
            summary_pdf_path, summary_generated_at, summary_generated_by,
            receipt_pdf_path, receipt_generated_at, receipt_generated_by,
            no_claim, no_claim_assigned_at, no_claim_assigned_by,
            closed_at, closed_by, close_note,
            created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            id, offBatch.batchId, claimWorkflowNo, principle.code, principle.name, config.status,
            totalDpp, totalPpn, totalPph, totalClaim, totalPaid, remainingAmount,
            config.hasSubmittedAt ? ms(6) : null,
            pdfPath, pdfGeneratedAt,
            pdfPath ? ACTOR_ID : null,
            summaryPdfPath, summaryGeneratedAt, summaryPdfPath ? ACTOR_ID : null,
            receiptPdfPath, receiptGeneratedAt, receiptPdfPath ? ACTOR_ID : null,
            noClaim, noClaim ? ms(8) : null, noClaim ? ACTOR_ID : null,
            config.isClosed ? ms(1) : null,
            config.isClosed ? ACTOR_ID : null,
            config.isClosed
                ? "DEMO seed: workflow ditutup karena pembayaran lunas dan dokumen lengkap."
                : null,
            ACTOR_ID, ms(10), ms(1),
        ],
    });

    await db.execute({
        sql: `INSERT INTO claim_submission (
            id, claim_workflow_id, no_claim, no_claim_assigned_at, no_claim_assigned_by,
            scope, scope_label, status,
            total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount,
            submitted_to_principal_at,
            claim_letter_pdf_path, claim_letter_generated_at, claim_letter_generated_by,
            summary_pdf_path, summary_generated_at, summary_generated_by,
            receipt_pdf_path, receipt_generated_at, receipt_generated_by,
            closed_at, closed_by, close_note,
            created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            submissionId, id, noClaim, noClaim ? ms(8) : null, noClaim ? ACTOR_ID : null,
            "per_pengajuan", claimWorkflowNo, config.status,
            totalDpp, totalPpn, totalPph, totalClaim, totalPaid, remainingAmount,
            config.hasSubmittedAt ? ms(6) : null,
            pdfPath, pdfGeneratedAt, pdfPath ? ACTOR_ID : null,
            summaryPdfPath, summaryGeneratedAt, summaryPdfPath ? ACTOR_ID : null,
            receiptPdfPath, receiptGeneratedAt, receiptPdfPath ? ACTOR_ID : null,
            config.isClosed ? ms(1) : null,
            config.isClosed ? ACTOR_ID : null,
            config.isClosed
                ? "DEMO seed: workflow ditutup karena pembayaran lunas dan dokumen lengkap."
                : null,
            ACTOR_ID, ms(10), ms(1),
        ],
    });

    // Sync noClaim ke semua off_batch_item milik OFF batch sumber claim ini.
    // Ini meniru efek transaksi `PATCH /api/claim-workflow/[id]/no-claim`.
    if (noClaim) {
        await db.execute({
            sql: `UPDATE off_batch_item SET no_claim = ?, updated_at = ? WHERE batch_id = ?`,
            args: [noClaim, ms(8), offBatch.batchId],
        });
    }

    for (const item of items) {
        await db.execute({
            sql: `INSERT INTO claim_workflow_item (
                id, claim_workflow_id, claim_submission_id, off_batch_item_id, no_surat, jenis_promosi,
                periode, outlet, dpp, ppn_rate, ppn_amount, pph_rate, pph_amount, nilai_klaim,
                status, note, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                item.id, id, submissionId, item.offBatchItemId, item.noSurat, item.jenisPromosi,
                item.periode, item.outlet, item.dpp, item.ppnRate, item.ppnAmount,
                item.pphRate, item.pphAmount, item.nilaiKlaim,
                item.status, item.note,
                ms(10), ms(1),
            ],
        });
    }

    // Audit trail seed: create_from_off + transitions disimulasikan secara
    // ringkas. Metadata `demo: true` menandai bahwa ini bukan aksi user nyata.
    const auditEvents = [];
    auditEvents.push({
        action: "create_from_off",
        fromStatus: null,
        toStatus: "Draft",
        note: "DEMO seed: dibuat dari OFF batch demo " + offBatch.noPengajuan,
        at: ms(10),
    });
    if (config.status === "Need Revision") {
        auditEvents.push({
            action: "demo_seed_need_revision",
            fromStatus: "Draft",
            toStatus: "Need Revision",
            note: "DEMO seed: workflow ditandai Need Revision untuk display.",
            at: ms(9),
        });
    }
    if (config.status !== "Draft" && config.status !== "Need Revision") {
        auditEvents.push({
            action: "mark_ready",
            fromStatus: "Draft",
            toStatus: "Ready to Submit",
            note: "DEMO seed",
            at: ms(8),
        });
    }
    if (noClaim) {
        auditEvents.push({
            action: "no_claim_assigned",
            fromStatus: "Draft",
            toStatus: "Draft",
            note: "DEMO seed: No Claim utama di-assign.",
            at: ms(8),
            metadataExtra: {
                previousNoClaim: null,
                newNoClaim: noClaim,
                offBatchId: offBatch.batchId,
                assignedBy: ACTOR_ID,
            },
        });
        auditEvents.push({
            action: "no_claim_synced_to_off",
            fromStatus: "Draft",
            toStatus: "Draft",
            note: "DEMO seed: No Claim disinkronkan ke OFF item.",
            at: ms(8),
            metadataExtra: {
                previousNoClaim: null,
                newNoClaim: noClaim,
                offBatchId: offBatch.batchId,
                syncedItemCount: offBatch.items.length,
                assignedBy: ACTOR_ID,
            },
        });
    }
    if (pdfPath) {
        auditEvents.push({
            action: "claim_letter_generated",
            fromStatus: config.status === "Ready to Submit" ? "Ready to Submit" : "Submitted to Principal",
            toStatus: config.status === "Ready to Submit" ? "Ready to Submit" : "Submitted to Principal",
            note: null,
            at: ms(7),
            metadataExtra: { claimLetterPdfPath: pdfPath, demo: true },
        });
    }
    if (summaryPdfPath) {
        auditEvents.push({
            action: "claim_summary_generated",
            fromStatus: config.status === "Ready to Submit" ? "Ready to Submit" : "Submitted to Principal",
            toStatus: config.status === "Ready to Submit" ? "Ready to Submit" : "Submitted to Principal",
            note: null,
            at: ms(7),
            metadataExtra: { pdfPath: summaryPdfPath, demo: true },
        });
    }
    if (receiptPdfPath) {
        auditEvents.push({
            action: "claim_receipt_generated",
            fromStatus: config.status === "Ready to Submit" ? "Ready to Submit" : "Submitted to Principal",
            toStatus: config.status === "Ready to Submit" ? "Ready to Submit" : "Submitted to Principal",
            note: null,
            at: ms(7),
            metadataExtra: { pdfPath: receiptPdfPath, demo: true },
        });
    }
    if (config.hasSubmittedAt) {
        auditEvents.push({
            action: "submit_to_principal",
            fromStatus: "Ready to Submit",
            toStatus: "Submitted to Principal",
            note: null,
            at: ms(6),
        });
    }
    if (["Partially Paid", "Paid", "Outstanding", "Closed"].includes(config.status)) {
        auditEvents.push({
            action: "demo_seed_advance_status",
            fromStatus: "Submitted to Principal",
            toStatus: config.status,
            note: "DEMO seed: status lanjutan diisi langsung untuk display dashboard.",
            at: ms(5),
        });
    }
    if (config.paidFraction > 0) {
        auditEvents.push({
            action: "demo_payment_seeded",
            fromStatus: config.status,
            toStatus: config.status,
            note: "DEMO seed: payment row dibuat untuk display.",
            at: ms(3),
            metadataExtra: { totalPaid, remainingAmount, demo: true },
        });
    }
    if (config.isClosed) {
        auditEvents.push({
            action: "closed_seeded",
            fromStatus: "Paid",
            toStatus: "Closed",
            note: "DEMO seed: workflow ditandai Closed untuk display.",
            at: ms(1),
        });
    }

    for (const evt of auditEvents) {
        await db.execute({
            sql: `INSERT INTO claim_audit_log (
                id, claim_workflow_id, actor_id, actor_name, actor_role,
                action, from_status, to_status, note, metadata, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                randomUUID(), id, ACTOR_ID, ACTOR_NAME, ACTOR_ROLE,
                evt.action, evt.fromStatus, evt.toStatus, evt.note,
                JSON.stringify({ demo: true, totalDpp, totalPpn, totalPph, totalClaim, totalPaid, ...evt.metadataExtra }),
                evt.at,
            ],
        });
    }

    // Claim payment seed — hanya untuk Partially Paid / Paid / Closed.
    if (config.paidFraction > 0) {
        await db.execute({
            sql: `INSERT INTO claim_payment (
                id, claim_workflow_id, claim_submission_id, payment_date, payment_amount, payment_type,
                payment_note, proof_path, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                randomUUID(), id, submissionId, isoDate(3), totalPaid, "Transfer",
                "DEMO-PAYMENT seed",
                null, ACTOR_ID, ms(3), ms(3),
            ],
        });
    }

    return { id, claimWorkflowNo, items, totalClaim, totalPaid, hasPdf: Boolean(pdfPath) };
}

// =============================================================================
// SECTION 6 — main runner
// =============================================================================

async function main() {
    console.log(`[seed-demo] DATABASE_URL=${databaseUrl}`);
    await ensureTables();
    await cleanupOldDemo();

    console.log("[seed-demo] Insert OFF demo batches...");
    const offBatches = {};
    for (let i = 0; i < OFF_STATUS_CONFIGS.length; i += 1) {
        const config = OFF_STATUS_CONFIGS[i];
        const principle = pickPrinciple(i);
        const batch = await insertOffBatch(i + 1, config, principle);
        offBatches[config.key] = batch;
        console.log(`  - ${batch.noPengajuan.padEnd(28)} ${config.status}`);
    }

    console.log("[seed-demo] Insert OFF batches sumber Claim Workflow (semua OM Approved)...");
    const omApprovedConfig = OFF_STATUS_CONFIGS.find((c) => c.key === "om_approved");
    const claimSourceBatches = [];
    for (let i = 0; i < CLAIM_WORKFLOW_CONFIGS.length; i += 1) {
        const seq = OFF_STATUS_CONFIGS.length + 1 + i;
        const principle = pickPrinciple(i);
        const batch = await insertOffBatch(seq, omApprovedConfig, principle);
        claimSourceBatches.push(batch);
        console.log(`  - ${batch.noPengajuan.padEnd(28)} (untuk claim ${CLAIM_WORKFLOW_CONFIGS[i].key})`);
    }

    console.log("[seed-demo] Insert Claim Workflow demos...");
    const claimResults = {};
    let pdfCount = 0;
    let skippedFutureCount = 0;
    for (let i = 0; i < CLAIM_WORKFLOW_CONFIGS.length; i += 1) {
        const config = CLAIM_WORKFLOW_CONFIGS[i];
        if (!CLAIM_STATUS_KNOWN.has(config.status)) {
            console.log(`  [skip] status "${config.status}" tidak terdaftar di constants Claim Workflow.`);
            skippedFutureCount += 1;
            continue;
        }
        const principle = pickPrinciple(i);
        const claim = await insertClaimWorkflow(
            i + 1, config, claimSourceBatches[i], principle,
        );
        claimResults[config.key] = claim;
        if (claim.hasPdf) pdfCount += 1;
        console.log(`  - ${claim.claimWorkflowNo.padEnd(28)} ${config.status}${claim.hasPdf ? " [PDF]" : ""}`);
    }

    console.log("");
    console.log("==================================================");
    console.log("[seed-demo] Selesai.");
    console.log(`  OFF batches               : ${OFF_STATUS_CONFIGS.length + claimSourceBatches.length} (${OFF_STATUS_CONFIGS.length} status coverage + ${claimSourceBatches.length} sumber claim)`);
    console.log(`  Claim Workflow records    : ${Object.keys(claimResults).length}`);
    console.log(`  Claim Letter PDF generated: ${pdfCount}`);
    console.log(`  Status non-listed         : ${skippedFutureCount}`);
    console.log("");
    console.log("Verifikasi UI:");
    console.log("  /off-program-control");
    console.log("  /claim-workflow");
    console.log("  /claim-workflow/<id>  (lihat dokumen Claim Letter, Summary, Kwitansi)");
    console.log("==================================================");
}

main().catch((error) => {
    console.error("[seed-demo] FAILED:", error);
    process.exit(1);
});
