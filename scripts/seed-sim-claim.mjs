// Tujuan: Seed data simulasi Claim Workflow besar-besaran untuk testing.
//         Menghapus semua data dummy lama, lalu membuat data baru yang cover
//         semua 25 principal × 9 status + multi-submission + free OFF batches.
// Caller: `node scripts/seed-sim-claim.mjs`
// Side Effects: DELETE semua data transaksional, lalu INSERT baru.
//               TIDAK menyentuh user/session/account.

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
    console.error(`[seed-sim] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}
const db = createClient({ url: databaseUrl });

// =============================================================================
// SECTION 2 — utilities
// =============================================================================

const now = new Date();
const NOW_MS = now.getTime();
const ACTOR_ID = "sim-seed";
const ACTOR_NAME = "Sim Seed Bot";
const ACTOR_ROLE = "admin";
const PREFIX = "SIM";
const YEAR = String(now.getFullYear());
const MONTH = String(now.getMonth() + 1).padStart(2, "0");

function ms(daysAgo) {
    return NOW_MS - daysAgo * 24 * 60 * 60 * 1000;
}
function isoDate(daysAgo) {
    const d = new Date(ms(daysAgo));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function round0(value) {
    return Math.round(Number(value) || 0);
}
function calculateClaimAmount(dpp, ppnRate, pphRate) {
    const ppnAmount = round0(dpp * ppnRate / 100);
    const pphAmount = round0(dpp * pphRate / 100);
    return { ppnAmount, pphAmount, nilaiKlaim: dpp + ppnAmount - pphAmount };
}
function pickRand(list, idx) {
    return list[idx % list.length];
}

async function tableExists(name) {
    const result = await db.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        args: [name],
    });
    return result.rows.length > 0;
}

// =============================================================================
// SECTION 3 — ALL 25 principals (from lib/off-program-control/constants.ts)
//   noClaimKey from lib/claim-workflow/no-claim-rules.ts
// =============================================================================

const PRINCIPLES = [
    { code: "RB",       name: "RECKITT BENCKISER, PT",                  noClaimKey: null },
    { code: "FKS",      name: "FKS FOOD SEJAHTERA, PT",                 noClaimKey: "FKS" },
    { code: "FON",      name: "FONTERRA BRANDS INDONESIA, PT",          noClaimKey: "FON" },
    { code: "REBO",     name: "GUMINDO BOGAMANIS, PT",                  noClaimKey: "GUMINDO" },
    { code: "MI",       name: "MARKETAMA INDAH, PT",                    noClaimKey: "MI" },
    { code: "PAS",      name: "PRIMARASA ABADI SEJAHTERA, PT",          noClaimKey: "PAS" },
    { code: "SPS",      name: "SUN PAPER SOURCE, PT",                   noClaimKey: "GTK" },
    { code: "GDI",      name: "GODREJ DISTRIBUSI INDONESIA, PT",        noClaimKey: "GCPI" },
    { code: "DOLPHIN",  name: "DOLPHIN, PT",                            noClaimKey: "DLP" },
    { code: "UNIBIS",   name: "UNIVERSAL INDOFOOD PRODUCT, PT",         noClaimKey: "UN" },
    { code: "URC",      name: "URC INDONESIA, PT",                      noClaimKey: "RC" },
    { code: "HEINZ",    name: "HEINZ ABC INDONESIA, PT",                noClaimKey: "HZ" },
    { code: "ENI",      name: "ENERGIZER INDONESIA, PT",                noClaimKey: "DC" },
    { code: "NATUR",    name: "GONDOWANGI TRADISIONAL KOSMETIK, PT",    noClaimKey: "FRN" },
    { code: "MR",       name: "MUSTIKA RATUBUANA INTERNATIONAL",        noClaimKey: "MRBI" },
    { code: "PRISKILA", name: "PRISKILA PRIMA MAKMUR, PT",              noClaimKey: "PR" },
    { code: "USM",      name: "UNITAMA SARI MAS, PT",                   noClaimKey: "USM" },
    { code: "VINDA",    name: "VINDA INTERNATIONAL INDONESIA, PT",      noClaimKey: "VII" },
    { code: "KINO",     name: "KINO INDONESIA. TBK, PT",                noClaimKey: "KN" },
    { code: "ABC",      name: "ABC PRESIDENT INDONESIA, PT",            noClaimKey: "ABCPI" },
    { code: "CUSSONS",  name: "PZ CUSSONS INDONESIA, PT",               noClaimKey: "CUS" },
    { code: "SHINZUI",  name: "FOKUS RITEL NUSAPRIMA, PT",              noClaimKey: "MS" },
    { code: "FRS",      name: "FORISA NUSAPERSADA, PT",                 noClaimKey: "FRS" },
    { code: "MOTASA",   name: "MOTASA INDONESIA, PT",                   noClaimKey: "MTS" },
    { code: "PURATOS",  name: "PURATOS, PT",                            noClaimKey: "PI" },
];

const PROGRAMS = [
    "Promosi Diskon Nasional", "Bundling Promo", "Cashback Program",
    "Loyalty Reward", "Display Bonus", "Buy 1 Get 1",
    "Promosi Awal Bulan", "Promo Akhir Bulan", "Flash Sale Weekend",
    "Promo Tahun Baru", "Diskon Lebaran", "Promo Natal",
];

const OUTLETS = [
    "Toko Berkah Jaya", "Toko Maju Bersama", "Toko Sumber Rejeki",
    "Toko Sentosa", "Toko Cahaya Abadi", "Toko Lancar Sejahtera",
    "Toko Mulia Mart", "Toko Karya Bersaudara", "Toko Indah Permai",
    "Toko Mitra Setia", "Toko Barokah", "Toko Sinar Jaya",
    "Toko Harapan Baru", "Toko Gemilang", "Toko Pilar Mas",
];

const SUPERVISORS = [
    "Ahmad Supervisor", "Budi Supervisor", "Citra Supervisor",
    "Dewi Supervisor", "Eko Supervisor",
];

// =============================================================================
// SECTION 4 — cleanup ALL transactional data
// =============================================================================

const CLEANUP_TABLES = [
    "claim_audit_log", "claim_payment", "claim_peka_report",
    "claim_workflow_item", "claim_submission", "claim_workflow",
    "off_audit_log", "off_notification", "off_payment",
    "off_batch_item", "off_batch", "idempotency_log",
];

async function cleanupAll() {
    console.log("[seed-sim] Cleanup semua data transaksional...");
    for (const table of CLEANUP_TABLES) {
        if (!(await tableExists(table))) continue;
        const before = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
        const count = Number(before.rows[0]?.n || 0);
        if (count === 0) continue;
        await db.execute(`DELETE FROM ${table}`);
        console.log(`  - ${table}: ${count} baris dihapus`);
    }
    console.log("[seed-sim] Cleanup selesai. User/session/account tetap utuh.\n");
}

// =============================================================================
// SECTION 5 — No Claim builder (follows no-claim-rules.ts patterns)
// =============================================================================

let noClaimSeq = 0;
function buildNoClaim(principle, yearOverride) {
    noClaimSeq += 1;
    const seq = String(noClaimSeq).padStart(2, "0");
    const y = yearOverride || YEAR;
    if (!principle.noClaimKey) {
        // RB pattern: {seq}/SP-{month}/{year2}
        return `${seq}/SP-${MONTH}/${y.slice(-2)}`;
    }
    // Standard: {seq}/SUPER-{key}/{month}/{year4}
    return `${seq}/SUPER-${principle.noClaimKey}/${MONTH}/${y}`;
}

// =============================================================================
// SECTION 6 — OFF batch inserter
// =============================================================================

const OM_APPROVED = {
    status: "OM Approved",
    smStatus: "Approved by SM",
    claimStatus: "Approved",
    omStatus: "Approved",
    financeStatus: "Waiting Payment",
    finalStatus: "Not Started",
    locked: 1,
    pdfStatus: "generated",
};

const FINANCE_PAID = {
    ...OM_APPROVED,
    financeStatus: "Paid",
    finalStatus: "Completed",
};

async function insertOffBatch(seq, config, principle, itemCount, supervisorName) {
    const batchId = randomUUID();
    const noPengajuan = `${PREFIX}-OFF-${String(seq).padStart(3, "0")}-${principle.code}`;
    const items = [];
    for (let i = 1; i <= itemCount; i += 1) {
        const programIdx = (seq + i) % PROGRAMS.length;
        const outletIdx = (seq * 7 + i) % OUTLETS.length;
        items.push({
            id: randomUUID(),
            itemNo: i,
            rowNo: i,
            noSurat: `${PREFIX}-SRT-${principle.code}-${String(seq).padStart(3, "0")}/${String(i).padStart(3, "0")}`,
            namaProgram: `${PROGRAMS[programIdx]} ${principle.code} #${seq}`,
            periode: `${isoDate(60)} - ${isoDate(30)}`,
            toko: OUTLETS[outletIdx],
            barang: `Produk ${principle.code} ${i}`,
            nominal: 1_500_000 + (i % 6) * 1_200_000 + (seq % 5) * 600_000,
            caraBayar: i % 2 === 0 ? "Tunai" : "Transfer",
            type: "OFF",
            deadline: isoDate(-15),
            kwt: 1, skp: 1, fp: 1, pc: 0, foto: 1, rekap: 0, others: 0,
        });
    }
    const totalNominal = items.reduce((s, it) => s + it.nominal, 0);

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
            batchId, noPengajuan, "GEL-1", principle.code, principle.name, MONTH, YEAR,
            supervisorName || pickRand(SUPERVISORS, seq), totalNominal,
            config.status, config.smStatus, config.claimStatus, config.omStatus,
            config.financeStatus, config.finalStatus, config.locked,
            ACTOR_ID, ACTOR_ID, ms(20),
            ACTOR_ID, ms(15), null,
            null, null, null,
            ACTOR_ID, ms(10), null, null,
            null, null, null,
            ACTOR_ID, ms(8), null,
            null, null, null,
            config.financeStatus === "Paid" ? ACTOR_ID : null,
            config.financeStatus === "Paid" ? ms(5) : null,
            config.financeStatus === "Paid" ? isoDate(5) : null,
            config.financeStatus === "Paid" ? totalNominal : 0,
            null, null, null, null,
            config.financeStatus === "Paid" ? "Transfer" : null,
            config.financeStatus === "Paid" ? "BCA" : null,
            null, 0, null,
            null, null, config.pdfStatus,
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                item.id, batchId, item.itemNo, item.rowNo, item.noSurat, null, item.namaProgram,
                item.periode, item.toko, item.barang, item.nominal, item.caraBayar, item.type, item.deadline,
                item.kwt, item.skp, item.fp, item.pc, item.foto, item.rekap, item.others, null,
                0, 0, 0, 0, 0, 0, 0, null, null,
                ms(20), ms(1),
            ],
        });
    }

    await db.execute({
        sql: `INSERT INTO off_audit_log (id, batch_id, item_id, actor_id, actor_name, actor_role,
            action, from_status, to_status, note, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            randomUUID(), batchId, null, ACTOR_ID, ACTOR_NAME, ACTOR_ROLE,
            "sim_seed_create_batch", null, config.status,
            `SIM seed: batch ${noPengajuan} dibuat.`,
            JSON.stringify({ simSeed: true, itemCount: items.length, principle: principle.code }),
            ms(20),
        ],
    });

    return { batchId, noPengajuan, items, totalNominal };
}

// =============================================================================
// SECTION 7 — Claim Workflow status configs
// =============================================================================

const CLAIM_CONFIGS = [
    { key: "draft",              status: "Draft",              paidFraction: 0,   hasPdf: false, hasSubmittedAt: false, hasNoClaim: false },
    { key: "need_revision",      status: "Need Revision",      paidFraction: 0,   hasPdf: false, hasSubmittedAt: false, hasNoClaim: false },
    { key: "ready_to_submit",    status: "Ready to Submit",    paidFraction: 0,   hasPdf: true,  hasSubmittedAt: false, hasNoClaim: true },
    { key: "submitted",         status: "Submitted to Principal", paidFraction: 0, hasPdf: true,  hasSubmittedAt: true,  hasNoClaim: true },
    { key: "partially_paid_30", status: "Partially Paid",     paidFraction: 0.3, hasPdf: true,  hasSubmittedAt: true,  hasNoClaim: true, paymentRows: 1 },
    { key: "partially_paid_60", status: "Partially Paid",     paidFraction: 0.6, hasPdf: true,  hasSubmittedAt: true,  hasNoClaim: true, paymentRows: 2 },
    { key: "paid",              status: "Paid",               paidFraction: 1,   hasPdf: true,  hasSubmittedAt: true,  hasNoClaim: true, paymentRows: 1 },
    { key: "outstanding",       status: "Outstanding",        paidFraction: 0,   hasPdf: true,  hasSubmittedAt: true,  hasNoClaim: true },
    { key: "closed",            status: "Closed",             paidFraction: 1,   hasPdf: true,  hasSubmittedAt: true,  hasNoClaim: true, paymentRows: 1, isClosed: true },
];

// =============================================================================
// SECTION 8 — PDF stub generator
// =============================================================================

async function tryGenerateStubPdf(workflow, submission, options) {
    try {
        const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
        const pdfDoc = await PDFDocument.create();
        pdfDoc.setTitle(`${options.title} ${workflow.claimWorkflowNo}`);
        pdfDoc.setSubject(`${options.title} - ${workflow.principleName} (SIM seed)`);
        pdfDoc.setCreator("AccAPI Claim Workflow Sim Seed");
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const page = pdfDoc.addPage([595.28, 841.89]);
        page.drawText(options.title, { x: 48, y: 780, size: 18, font: bold, color: rgb(0.1, 0.13, 0.2) });
        page.drawText(`No: ${workflow.claimWorkflowNo}`, { x: 48, y: 750, size: 11, font });
        page.drawText(`Principle: ${workflow.principleName}`, { x: 48, y: 730, size: 11, font });
        page.drawText(`No Claim: ${submission.noClaim || "(belum)"}`, { x: 48, y: 710, size: 11, font });
        page.drawText(`Total Claim: Rp ${Number(submission.totalClaim || 0).toLocaleString("id-ID")}`, { x: 48, y: 690, size: 11, font });
        page.drawText("File PDF ini di-generate oleh seed lokal untuk keperluan simulasi.", { x: 48, y: 650, size: 10, font, color: rgb(0.4, 0.45, 0.5) });
        const bytes = await pdfDoc.save();
        const dir = join(process.cwd(), "runtime", "claim-workflow", workflow.id, "submissions", submission.id, options.directory);
        mkdirSync(dir, { recursive: true });
        const safe = (submission.noClaim || submission.id).replace(/[^a-zA-Z0-9._-]+/g, "-");
        const filePath = join(dir, `${safe}-${options.filenameSuffix}.pdf`);
        writeFileSync(filePath, bytes);
        return filePath;
    } catch (error) {
        return null;
    }
}

async function genThreePdfs(workflow, submission) {
    const [letterPath, summaryPath, receiptPath] = await Promise.all([
        tryGenerateStubPdf(workflow, submission, { kind: "claim-letter", title: "SIM CLAIM LETTER", directory: "claim-letter", filenameSuffix: "letter" }),
        tryGenerateStubPdf(workflow, submission, { kind: "summary", title: "SIM CLAIM SUMMARY", directory: "summary", filenameSuffix: "summary" }),
        tryGenerateStubPdf(workflow, submission, { kind: "receipt", title: "SIM KWITANSI CLAIM", directory: "receipt", filenameSuffix: "receipt" }),
    ]);
    return { letterPath, summaryPath, receiptPath };
}

// =============================================================================
// SECTION 9 — Claim Workflow inserter
// =============================================================================

async function insertClaimWorkflow({ workflowSeq, config, offBatch, principle, multiSubmissionCount = 1 }) {
    const id = randomUUID();
    const claimWorkflowNo = `${PREFIX}-CLAIM-${String(workflowSeq).padStart(3, "0")}-${principle.code}`;
    const ppnRate = 11;
    const usePph = config.hasSubmittedAt || config.status === "Ready to Submit";
    const pphRate = usePph ? 2 : 0;

    const itemDetails = offBatch.items.map((it) => {
        const dpp = it.nominal;
        const calc = calculateClaimAmount(dpp, ppnRate, pphRate);
        return {
            id: randomUUID(),
            offBatchItemId: it.id,
            noSurat: it.noSurat,
            jenisPromosi: it.namaProgram,
            periode: it.periode,
            outlet: it.toko,
            dpp, ppnRate, ppnAmount: calc.ppnAmount,
            pphRate, pphAmount: calc.pphAmount,
            nilaiKlaim: calc.nilaiKlaim,
        };
    });

    const totalDpp = itemDetails.reduce((s, it) => s + it.dpp, 0);
    const totalPpn = itemDetails.reduce((s, it) => s + it.ppnAmount, 0);
    const totalPph = itemDetails.reduce((s, it) => s + it.pphAmount, 0);
    const totalClaim = itemDetails.reduce((s, it) => s + it.nilaiKlaim, 0);
    const totalPaid = round0(totalClaim * (config.paidFraction || 0));
    const remaining = Math.max(totalClaim - totalPaid, 0);

    await db.execute({
        sql: `INSERT INTO claim_workflow (
            id, off_batch_id, claim_workflow_no, principle_code, principle_name, status,
            total_dpp, total_ppn, total_pph, total_claim, total_paid, remaining_amount,
            submitted_to_principal_at, claim_letter_pdf_path, claim_letter_generated_at,
            claim_letter_generated_by, summary_pdf_path, summary_generated_at, summary_generated_by,
            receipt_pdf_path, receipt_generated_at, receipt_generated_by,
            no_claim, no_claim_assigned_at, no_claim_assigned_by,
            closed_at, closed_by, close_note,
            created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
            id, offBatch.batchId, claimWorkflowNo, principle.code, principle.name, config.status,
            totalDpp, totalPpn, totalPph, totalClaim, totalPaid, remaining,
            config.hasSubmittedAt ? ms(6) : null,
            null, null, null, null, null, null, null, null, null,
            null, null, null,
            config.isClosed ? ms(1) : null,
            config.isClosed ? ACTOR_ID : null,
            config.isClosed ? "SIM seed: closed lunas + dokumen lengkap." : null,
            ACTOR_ID, ms(10), ms(1),
        ],
    });

    // Build submissions
    const submissions = [];
    if (multiSubmissionCount > 1 && itemDetails.length >= multiSubmissionCount) {
        for (let i = 0; i < itemDetails.length; i += 1) {
            const item = itemDetails[i];
            const subId = randomUUID();
            const noClaim = config.hasNoClaim ? buildNoClaim(principle) : null;
            const subPaid = round0(item.nilaiKlaim * (config.paidFraction || 0));
            submissions.push({
                id: subId, scope: "per_item", scopeLabel: item.outlet,
                noClaim, items: [item],
                totalDpp: item.dpp, totalPpn: item.ppnAmount, totalPph: item.pphAmount,
                totalClaim: item.nilaiKlaim, totalPaid: subPaid,
                remaining: Math.max(item.nilaiKlaim - subPaid, 0),
            });
        }
    } else {
        const subId = randomUUID();
        const noClaim = config.hasNoClaim ? buildNoClaim(principle) : null;
        submissions.push({
            id: subId, scope: "per_pengajuan", scopeLabel: claimWorkflowNo,
            noClaim, items: itemDetails,
            totalDpp, totalPpn, totalPph, totalClaim, totalPaid, remaining,
        });
    }

    // Insert submissions + items + PDFs
    for (const sub of submissions) {
        let letterPath = null, summaryPath = null, receiptPath = null, pdfGeneratedAt = null;
        if (config.hasPdf && sub.noClaim) {
            const pdfs = await genThreePdfs(
                { id, claimWorkflowNo, principleName: principle.name },
                { id: sub.id, noClaim: sub.noClaim, totalClaim: sub.totalClaim },
            );
            letterPath = pdfs.letterPath;
            summaryPath = pdfs.summaryPath;
            receiptPath = pdfs.receiptPath;
            pdfGeneratedAt = ms(7);
        }

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
                sub.id, id, sub.noClaim, sub.noClaim ? ms(8) : null, sub.noClaim ? ACTOR_ID : null,
                sub.scope, sub.scopeLabel, config.status,
                sub.totalDpp, sub.totalPpn, sub.totalPph, sub.totalClaim, sub.totalPaid, sub.remaining,
                config.hasSubmittedAt ? ms(6) : null,
                letterPath, pdfGeneratedAt, letterPath ? ACTOR_ID : null,
                summaryPath, pdfGeneratedAt, summaryPath ? ACTOR_ID : null,
                receiptPath, pdfGeneratedAt, receiptPath ? ACTOR_ID : null,
                config.isClosed ? ms(1) : null,
                config.isClosed ? ACTOR_ID : null,
                config.isClosed ? "SIM seed: closed lunas." : null,
                ACTOR_ID, ms(10), ms(1),
            ],
        });

        for (const item of sub.items) {
            await db.execute({
                sql: `INSERT INTO claim_workflow_item (
                    id, claim_workflow_id, claim_submission_id, off_batch_item_id, no_surat, jenis_promosi,
                    periode, outlet, dpp, ppn_rate, ppn_amount, pph_rate, pph_amount, nilai_klaim,
                    status, note, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                    item.id, id, sub.id, item.offBatchItemId, item.noSurat, item.jenisPromosi,
                    item.periode, item.outlet, item.dpp, item.ppnRate, item.ppnAmount,
                    item.pphRate, item.pphAmount, item.nilaiKlaim,
                    "Draft", null, ms(10), ms(1),
                ],
            });
        }

        if (sub.noClaim) {
            for (const item of sub.items) {
                await db.execute({
                    sql: `UPDATE off_batch_item SET no_claim = ?, updated_at = ? WHERE id = ?`,
                    args: [sub.noClaim, ms(8), item.offBatchItemId],
                });
            }
        }

        if (sub.totalPaid > 0) {
            const paymentRowCount = config.paymentRows || 1;
            const perPayment = round0(sub.totalPaid / paymentRowCount);
            for (let p = 0; p < paymentRowCount; p += 1) {
                const amount = (p === paymentRowCount - 1)
                    ? sub.totalPaid - perPayment * (paymentRowCount - 1)
                    : perPayment;
                await db.execute({
                    sql: `INSERT INTO claim_payment (
                        id, claim_workflow_id, claim_submission_id, payment_date, payment_amount, payment_type,
                        payment_note, proof_path, created_by, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    args: [
                        randomUUID(), id, sub.id, isoDate(3 + p),
                        amount, "Transfer",
                        `SIM seed payment ${p + 1}/${paymentRowCount}`,
                        null, ACTOR_ID, ms(3 + p), ms(3 + p),
                    ],
                });
            }
        }
    }

    // Mirror noClaim for single-submission
    if (submissions.length === 1 && submissions[0].noClaim) {
        await db.execute({
            sql: `UPDATE claim_workflow SET no_claim = ?, no_claim_assigned_at = ?, no_claim_assigned_by = ?, updated_at = ? WHERE id = ?`,
            args: [submissions[0].noClaim, ms(8), ACTOR_ID, ms(1), id],
        });
    }

    // Mirror PDF path for single-submission
    if (submissions.length === 1 && config.hasPdf) {
        const sub = submissions[0];
        const subRow = (await db.execute({
            sql: "SELECT claim_letter_pdf_path, summary_pdf_path, receipt_pdf_path, claim_letter_generated_at FROM claim_submission WHERE id = ?",
            args: [sub.id],
        })).rows[0];
        if (subRow) {
            await db.execute({
                sql: `UPDATE claim_workflow SET
                    claim_letter_pdf_path = ?, claim_letter_generated_at = ?, claim_letter_generated_by = ?,
                    summary_pdf_path = ?, summary_generated_at = ?, summary_generated_by = ?,
                    receipt_pdf_path = ?, receipt_generated_at = ?, receipt_generated_by = ?,
                    updated_at = ?
                    WHERE id = ?`,
                args: [
                    subRow.claim_letter_pdf_path, subRow.claim_letter_generated_at, ACTOR_ID,
                    subRow.summary_pdf_path, subRow.claim_letter_generated_at, ACTOR_ID,
                    subRow.receipt_pdf_path, subRow.claim_letter_generated_at, ACTOR_ID,
                    ms(1), id,
                ],
            });
        }
    }

    // Audit trail
    const auditEvents = [
        { action: "create_from_off", fromStatus: null, toStatus: "Draft",
          note: `SIM seed: dibuat dari OFF batch ${offBatch.noPengajuan}.`, at: ms(10) },
    ];
    if (multiSubmissionCount > 1) {
        auditEvents.push({
            action: "claim_submissions_created_per_item",
            fromStatus: "Draft", toStatus: "Draft",
            note: `SIM seed: ${submissions.length} per_item submission dibuat.`,
            at: ms(9),
            metadataExtra: { createdCount: submissions.length, mode: "all_unassigned" },
        });
    }
    if (config.status === "Need Revision") {
        auditEvents.push({ action: "return_to_draft",
            fromStatus: "Draft", toStatus: "Need Revision",
            note: "SIM seed: ditandai Need Revision.", at: ms(8) });
    }
    if (["Ready to Submit", "Submitted to Principal", "Partially Paid", "Paid", "Outstanding", "Closed"].includes(config.status)) {
        auditEvents.push({ action: "mark_ready",
            fromStatus: "Draft", toStatus: "Ready to Submit",
            note: "SIM seed", at: ms(8) });
    }
    if (config.hasSubmittedAt) {
        auditEvents.push({ action: "submit_to_principal",
            fromStatus: "Ready to Submit", toStatus: "Submitted to Principal",
            note: null, at: ms(6) });
    }
    if (["Partially Paid", "Paid", "Outstanding", "Closed"].includes(config.status)) {
        auditEvents.push({ action: "demo_seed_advance_status",
            fromStatus: "Submitted to Principal", toStatus: config.status,
            note: "SIM seed: status lanjutan.", at: ms(5) });
    }
    if (config.isClosed) {
        auditEvents.push({ action: "claim_closed",
            fromStatus: "Paid", toStatus: "Closed",
            note: "SIM seed: closed lunas.", at: ms(1) });
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
                JSON.stringify({ simSeed: true, totalDpp, totalPpn, totalPph, totalClaim, totalPaid, ...evt.metadataExtra }),
                evt.at,
            ],
        });
    }

    return { id, claimWorkflowNo, submissionCount: submissions.length, itemCount: itemDetails.length, totalClaim, totalPaid };
}

// =============================================================================
// SECTION 10 — main runner
// =============================================================================

async function main() {
    console.log(`[seed-sim] DATABASE_URL=${databaseUrl}`);
    console.log(`[seed-sim] Tanggal: ${YEAR}-${MONTH}`);
    console.log("");

    await cleanupAll();

    const stats = {
        offBatchesFree: 0,
        offBatchesLinked: 0,
        workflows: 0,
        submissions: 0,
        items: 0,
        pdfs: 0,
        payments: 0,
    };

    let offSeq = 1;
    let wfSeq = 1;

    // ---------------------------------------------------------------
    // A) 25 OFF batches free (1 per principal, siap di-claim baru)
    // ---------------------------------------------------------------
    console.log("[seed-sim] A) 25 OFF batch FREE (1 per principal, siap create claim baru)...");
    for (let i = 0; i < PRINCIPLES.length; i += 1) {
        const principle = PRINCIPLES[i];
        const itemCount = 3 + (i % 4);
        const batch = await insertOffBatch(offSeq++, OM_APPROVED, principle, itemCount);
        stats.offBatchesFree += 1;
        console.log(`  - ${batch.noPengajuan} (${itemCount} items) [FREE]`);
    }

    // ---------------------------------------------------------------
    // B) 25 principals × 9 status = 225 single-submission workflows
    // ---------------------------------------------------------------
    console.log("\n[seed-sim] B) 225 Claim Workflow single-submission (25 principal × 9 status)...");
    for (let s = 0; s < CLAIM_CONFIGS.length; s += 1) {
        const config = CLAIM_CONFIGS[s];
        for (let p = 0; p < PRINCIPLES.length; p += 1) {
            const principle = PRINCIPLES[p];
            const itemCount = 2 + ((s + p) % 5);
            const sourceBatch = await insertOffBatch(offSeq++, OM_APPROVED, principle, itemCount);
            stats.offBatchesLinked += 1;
            const wf = await insertClaimWorkflow({
                workflowSeq: wfSeq++,
                config,
                offBatch: sourceBatch,
                principle,
                multiSubmissionCount: 1,
            });
            stats.workflows += 1;
            stats.submissions += wf.submissionCount;
            stats.items += wf.itemCount;
            if (config.hasPdf) stats.pdfs += wf.submissionCount * 3;
            if (config.paidFraction > 0) stats.payments += (config.paymentRows || 1) * wf.submissionCount;
        }
        console.log(`  - Status "${config.status}": 25 workflow selesai`);
    }

    // ---------------------------------------------------------------
    // C) Multi-submission: 10 principals × 2 status × 4 items
    // ---------------------------------------------------------------
    const multiPrinciples = PRINCIPLES.slice(0, 10);
    const multiConfigs = [
        CLAIM_CONFIGS.find((c) => c.key === "submitted"),
        CLAIM_CONFIGS.find((c) => c.key === "partially_paid_60"),
    ];
    console.log(`\n[seed-sim] C) ${multiPrinciples.length * multiConfigs.length} Claim Workflow multi-submission (${multiPrinciples.length} principal × ${multiConfigs.length} status × 4 items)...`);
    for (const config of multiConfigs) {
        for (const principle of multiPrinciples) {
            const itemCount = 4;
            const sourceBatch = await insertOffBatch(offSeq++, OM_APPROVED, principle, itemCount);
            stats.offBatchesLinked += 1;
            const wf = await insertClaimWorkflow({
                workflowSeq: wfSeq++,
                config,
                offBatch: sourceBatch,
                principle,
                multiSubmissionCount: itemCount,
            });
            stats.workflows += 1;
            stats.submissions += wf.submissionCount;
            stats.items += wf.itemCount;
            if (config.hasPdf) stats.pdfs += wf.submissionCount * 3;
            if (config.paidFraction > 0) stats.payments += (config.paymentRows || 1) * wf.submissionCount;
        }
    }
    console.log(`  - ${multiPrinciples.length * multiConfigs.length} multi-submission workflow selesai`);

    // ---------------------------------------------------------------
    // Summary
    // ---------------------------------------------------------------
    const totalOff = stats.offBatchesFree + stats.offBatchesLinked;
    console.log("\n==================================================");
    console.log("[seed-sim] SELESAI.");
    console.log(`  OFF batches total          : ${totalOff}`);
    console.log(`    - Free (no claim)        : ${stats.offBatchesFree}`);
    console.log(`    - Linked (with claim)    : ${stats.offBatchesLinked}`);
    console.log(`  Claim Workflows            : ${stats.workflows}`);
    console.log(`  Total submissions          : ${stats.submissions}`);
    console.log(`  Total claim items          : ${stats.items}`);
    console.log(`  PDF stubs                  : ${stats.pdfs}`);
    console.log(`  Claim payment rows         : ${stats.payments}`);
    console.log("==================================================");
    console.log("");
    console.log("Verifikasi di browser:");
    console.log("  /off-program-control  → 25 free + 245 linked batches");
    console.log("  /claim-workflow       → 245 workflows semua status");
    console.log("  /claim-workflow/<id>  → detail, items, submissions, payments");
    console.log("==================================================");
}

main().catch((error) => {
    console.error("[seed-sim] FAILED:", error);
    process.exit(1);
});
