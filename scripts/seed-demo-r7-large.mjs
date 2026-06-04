// Tujuan: Seed demo Claim Workflow R7 ukuran besar (post-R7j single Excel
//         mode). Menambah banyak workflow + multi-No-Claim varieties supaya
//         halaman detail Daftar Claim bisa diuji dengan data yang lebih
//         realistis.
// Caller: `node scripts/seed-demo-r7-large.mjs`.
// Side Effects: INSERT/DELETE row dengan prefix BASE-* di tabel OFF + Claim
//               Workflow + claim_payment + audit log + PDF stub di
//               runtime/claim-workflow/.
// Aturan:
// - Refuse jika DATABASE_URL bukan SQLite lokal.
// - Idempotent: cleanup prefix BASE-* sebelum insert. Tidak menyentuh seed
//   lama prefix DEMO-*.
// - Tidak mengubah schema, business logic, atau API contract.
// - Tidak menulis status legacy (PEKA/EC/CN).

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
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
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
    console.error(`[seed-r7-large] REFUSED: DATABASE_URL bukan SQLite lokal (${databaseUrl}).`);
    process.exit(2);
}
const db = createClient({ url: databaseUrl });

// =============================================================================
// SECTION 2 — utilities
// =============================================================================

const now = new Date();
const NOW_MS = now.getTime();
const ACTOR_ID = "base-seed";
const ACTOR_NAME = "Base Seed Bot";
const ACTOR_ROLE = "admin";
const PREFIX = "BASE";
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

async function ensureTables() {
    const required = [
        "off_batch", "off_batch_item", "off_payment", "off_audit_log",
        "claim_workflow", "claim_submission", "claim_workflow_item",
        "claim_payment", "claim_audit_log",
    ];
    const missing = [];
    for (const name of required) {
        if (!(await tableExists(name))) missing.push(name);
    }
    if (missing.length > 0) {
        console.error(`[seed-r7-large] Tabel berikut belum ada: ${missing.join(", ")}`);
        console.error("[seed-r7-large] Jalankan dulu: node scripts/init-db.mjs");
        process.exit(3);
    }
}

// =============================================================================
// SECTION 3 — cleanup BASE prefix (idempotent, tidak menyentuh DEMO-*)
// =============================================================================

async function cleanupOldBase() {
    console.log("[seed-r7-large] Cleanup BASE-* lama...");
    const offRows = await db.execute(
        "SELECT id FROM off_batch WHERE no_pengajuan LIKE 'BASE-OFF-%'",
    );
    const offIds = offRows.rows.map((r) => String(r.id));

    const cwfRows = offIds.length > 0
        ? await db.execute({
            sql: `SELECT id FROM claim_workflow
                  WHERE claim_workflow_no LIKE 'BASE-CLAIM-%'
                     OR off_batch_id IN (${offIds.map(() => "?").join(",")})`,
            args: offIds,
        })
        : await db.execute(
            "SELECT id FROM claim_workflow WHERE claim_workflow_no LIKE 'BASE-CLAIM-%'",
        );
    const claimIds = cwfRows.rows.map((r) => String(r.id));

    if (claimIds.length > 0) {
        const ph = claimIds.map(() => "?").join(",");
        await db.execute({ sql: `DELETE FROM claim_audit_log WHERE claim_workflow_id IN (${ph})`, args: claimIds });
        await db.execute({ sql: `DELETE FROM claim_payment WHERE claim_workflow_id IN (${ph})`, args: claimIds });
        await db.execute({ sql: `DELETE FROM claim_workflow_item WHERE claim_workflow_id IN (${ph})`, args: claimIds });
        await db.execute({ sql: `DELETE FROM claim_submission WHERE claim_workflow_id IN (${ph})`, args: claimIds });
        await db.execute({ sql: `DELETE FROM claim_workflow WHERE id IN (${ph})`, args: claimIds });
    }
    if (offIds.length > 0) {
        const ph = offIds.map(() => "?").join(",");
        await db.execute({ sql: `DELETE FROM off_audit_log WHERE batch_id IN (${ph})`, args: offIds });
        if (await tableExists("off_notification")) {
            await db.execute({ sql: `DELETE FROM off_notification WHERE batch_id IN (${ph})`, args: offIds });
        }
        await db.execute({ sql: `DELETE FROM off_payment WHERE batch_id IN (${ph})`, args: offIds });
        await db.execute({ sql: `DELETE FROM off_batch_item WHERE batch_id IN (${ph})`, args: offIds });
    }
    await db.execute("DELETE FROM off_batch WHERE no_pengajuan LIKE 'BASE-OFF-%'");

    console.log(`  - off_batch: ${offIds.length} dihapus`);
    console.log(`  - claim_workflow: ${claimIds.length} dihapus`);
}

// =============================================================================
// SECTION 4 — principals + program catalog
// =============================================================================

const PRINCIPLES = [
    { code: "RB", name: "RECKITT BENCKISER, PT", noClaimCode: "RB" },
    { code: "KINO", name: "KINO INDONESIA. TBK, PT", noClaimCode: "KINO" },
    { code: "GDI", name: "GODREJ DISTRIBUSI INDONESIA, PT", noClaimCode: "GCPI" },
    { code: "MOTASA", name: "MOTASA INDONESIA, PT", noClaimCode: "MOTASA" },
];

const PROGRAMS = [
    "Promosi Diskon Nasional",
    "Bundling Promo",
    "Cashback Program",
    "Loyalty Reward",
    "Display Bonus",
    "Buy 1 Get 1",
    "Promosi Awal Bulan",
    "Promo Akhir Bulan",
];

const OUTLETS = [
    "Toko Berkah Jaya",
    "Toko Maju Bersama",
    "Toko Sumber Rejeki",
    "Toko Sentosa",
    "Toko Cahaya Abadi",
    "Toko Lancar Sejahtera",
    "Toko Mulia Mart",
    "Toko Karya Bersaudara",
    "Toko Indah Permai",
    "Toko Mitra Setia",
];

// =============================================================================
// SECTION 5 — OFF batch helpers (gen sumber claim semuanya OM Approved)
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

function buildOffItems(prefixSeq, principle, count) {
    const items = [];
    for (let i = 1; i <= count; i += 1) {
        const programIdx = (prefixSeq + i) % PROGRAMS.length;
        const outletIdx = (prefixSeq * 7 + i) % OUTLETS.length;
        items.push({
            id: randomUUID(),
            itemNo: i,
            rowNo: i,
            noSurat: `${PREFIX}-CLAIM-${principle.code}-${String(prefixSeq).padStart(3, "0")}/${String(i).padStart(3, "0")}`,
            namaProgram: `${PROGRAMS[programIdx]} ${principle.code} #${prefixSeq}`,
            periode: `${isoDate(60)} - ${isoDate(30)}`,
            toko: OUTLETS[outletIdx],
            barang: `Produk Sample ${principle.code} ${i}`,
            nominal: 2_000_000 + (i % 6) * 1_500_000 + (prefixSeq % 4) * 800_000,
            caraBayar: i % 2 === 0 ? "Tunai" : "Transfer",
            type: "OFF",
            deadline: isoDate(-15),
            kwt: 1, skp: 1, fp: 1, pc: 0, foto: 1, rekap: 0, others: 0,
        });
    }
    return items;
}

async function insertOffBatch(seq, config, principle, itemCount) {
    const batchId = randomUUID();
    const noPengajuan = `${PREFIX}-OFF-${String(seq).padStart(3, "0")}-${principle.code}`;
    const items = buildOffItems(seq, principle, itemCount);
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
            "Supervisor Demo Base", totalNominal,
            config.status, config.smStatus, config.claimStatus, config.omStatus,
            config.financeStatus, config.finalStatus, config.locked,
            ACTOR_ID, ACTOR_ID, ms(20),
            ACTOR_ID, ms(15), null,
            null, null, null,
            ACTOR_ID, ms(10), null, null,
            null, null, null,
            ACTOR_ID, ms(8), null,
            null, null, null,
            null, null, null, 0,
            null, null, null, null,
            null, null, null, 0, null,
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
            "base_seed_create_batch", null, config.status,
            "BASE seed: batch dibuat untuk demo R7 large.",
            JSON.stringify({ baseSeed: true, itemCount: items.length, principle: principle.code }),
            ms(20),
        ],
    });

    return { batchId, noPengajuan, items, totalNominal };
}

// =============================================================================
// SECTION 6 — Claim Workflow status configs (8 status x 4 principal = 32)
// =============================================================================

const CLAIM_STATUS_CONFIGS = [
    { key: "draft", status: "Draft", paidFraction: 0, hasPdf: false, hasSubmittedAt: false, hasNoClaim: false },
    { key: "need_revision", status: "Need Revision", paidFraction: 0, hasPdf: false, hasSubmittedAt: false, hasNoClaim: false },
    { key: "ready_to_submit", status: "Ready to Submit", paidFraction: 0, hasPdf: true, hasSubmittedAt: false, hasNoClaim: true },
    { key: "submitted", status: "Submitted to Principal", paidFraction: 0, hasPdf: true, hasSubmittedAt: true, hasNoClaim: true },
    { key: "partially_paid_30", status: "Partially Paid", paidFraction: 0.3, hasPdf: true, hasSubmittedAt: true, hasNoClaim: true, paymentRows: 1 },
    { key: "partially_paid_60", status: "Partially Paid", paidFraction: 0.6, hasPdf: true, hasSubmittedAt: true, hasNoClaim: true, paymentRows: 2 },
    { key: "paid", status: "Paid", paidFraction: 1, hasPdf: true, hasSubmittedAt: true, hasNoClaim: true, paymentRows: 1 },
    { key: "outstanding", status: "Outstanding", paidFraction: 0, hasPdf: true, hasSubmittedAt: true, hasNoClaim: true },
    { key: "closed", status: "Closed", paidFraction: 1, hasPdf: true, hasSubmittedAt: true, hasNoClaim: true, paymentRows: 1, isClosed: true },
];

// =============================================================================
// SECTION 7 — PDF stub generator (3 type per submission)
// =============================================================================

async function tryGenerateStubPdf(workflow, submission, options) {
    try {
        const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
        const pdfDoc = await PDFDocument.create();
        pdfDoc.setTitle(`${options.title} ${workflow.claimWorkflowNo}`);
        pdfDoc.setSubject(`${options.title} - ${workflow.principleName} (BASE seed)`);
        pdfDoc.setCreator("AccAPI Claim Workflow R7 Large Seed");
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const page = pdfDoc.addPage([595.28, 841.89]);
        page.drawText(options.title, { x: 48, y: 780, size: 18, font: bold, color: rgb(0.1, 0.13, 0.2) });
        page.drawText(`No: ${workflow.claimWorkflowNo}`, { x: 48, y: 750, size: 11, font });
        page.drawText(`Principle: ${workflow.principleName}`, { x: 48, y: 730, size: 11, font });
        page.drawText(`No Claim: ${submission.noClaim || "(belum)"}`, { x: 48, y: 710, size: 11, font });
        page.drawText(`Total Claim: Rp ${Number(submission.totalClaim || 0).toLocaleString("id-ID")}`, { x: 48, y: 690, size: 11, font });
        page.drawText("File PDF ini di-generate oleh seed lokal untuk keperluan demo UI R7.", { x: 48, y: 650, size: 10, font, color: rgb(0.4, 0.45, 0.5) });
        page.drawText("Bukan dokumen klaim sebenarnya; jangan dikirim ke principal.", { x: 48, y: 635, size: 10, font, color: rgb(0.4, 0.45, 0.5) });
        const bytes = await pdfDoc.save();
        const dir = join(process.cwd(), "runtime", "claim-workflow", workflow.id, "submissions", submission.id, options.directory);
        mkdirSync(dir, { recursive: true });
        const safe = (submission.noClaim || submission.id).replace(/[^a-zA-Z0-9._-]+/g, "-");
        const filePath = join(dir, `${safe}-${options.filenameSuffix}.pdf`);
        writeFileSync(filePath, bytes);
        return filePath;
    } catch (error) {
        console.warn(`  [warn] PDF ${options.kind} stub gagal: ${error?.message || error}`);
        return null;
    }
}

async function genThreePdfs(workflow, submission) {
    const letterPath = await tryGenerateStubPdf(workflow, submission, {
        kind: "claim-letter", title: "BASE CLAIM LETTER",
        directory: "claim-letter", filenameSuffix: "letter",
    });
    const summaryPath = await tryGenerateStubPdf(workflow, submission, {
        kind: "summary", title: "BASE CLAIM SUMMARY",
        directory: "summary", filenameSuffix: "summary",
    });
    const receiptPath = await tryGenerateStubPdf(workflow, submission, {
        kind: "receipt", title: "BASE KWITANSI CLAIM",
        directory: "receipt", filenameSuffix: "receipt",
    });
    return { letterPath, summaryPath, receiptPath };
}

// =============================================================================
// SECTION 8 — Claim Workflow inserter (single + multi submission)
// =============================================================================

let noClaimSequence = 1;
function nextNoClaim(principle) {
    const seq = String(noClaimSequence).padStart(2, "0");
    noClaimSequence += 1;
    return `${seq}/SUPER-${principle.noClaimCode}/${MONTH}/${YEAR}`;
}

async function insertClaimWorkflow({
    workflowSeq,
    config,
    offBatch,
    principle,
    multiSubmissionCount = 1,  // jika > 1, setiap item dipisah ke per_item submission baru
}) {
    const id = randomUUID();
    const claimWorkflowNo = `${PREFIX}-CLAIM-${String(workflowSeq).padStart(3, "0")}-${principle.code}`;

    const ppnRate = 11;
    const usePph = config.hasSubmittedAt || config.status === "Ready to Submit";
    const pphRate = usePph ? 2 : 0;

    // Hitung tax per item.
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

    // Insert workflow shell (totals di-update pakai workflow-level cache).
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
            null, null, null,  // no_claim mirror diisi belakangan untuk single
            config.isClosed ? ms(1) : null,
            config.isClosed ? ACTOR_ID : null,
            config.isClosed ? "BASE seed: workflow ditutup karena lunas + dokumen lengkap." : null,
            ACTOR_ID, ms(10), ms(1),
        ],
    });

    // Build submissions: jika multiSubmissionCount > 1, items dibagi ke
    // multiSubmissionCount per_item submissions. Sisanya (jika tidak habis
    // dibagi) dipindah ke last submission.
    const submissions = [];
    if (multiSubmissionCount > 1 && itemDetails.length >= multiSubmissionCount) {
        // Bagi item ke per_item submissions (1 item per submission).
        for (let i = 0; i < itemDetails.length; i += 1) {
            const item = itemDetails[i];
            const subId = randomUUID();
            const noClaim = config.hasNoClaim ? nextNoClaim(principle) : null;
            const subTotalDpp = item.dpp;
            const subTotalPpn = item.ppnAmount;
            const subTotalPph = item.pphAmount;
            const subTotalClaim = item.nilaiKlaim;
            const subPaid = round0(subTotalClaim * (config.paidFraction || 0));
            submissions.push({
                id: subId,
                scope: "per_item",
                scopeLabel: item.outlet,
                noClaim,
                items: [item],
                totalDpp: subTotalDpp,
                totalPpn: subTotalPpn,
                totalPph: subTotalPph,
                totalClaim: subTotalClaim,
                totalPaid: subPaid,
                remaining: Math.max(subTotalClaim - subPaid, 0),
            });
        }
    } else {
        // Single submission per_pengajuan.
        const subId = randomUUID();
        const noClaim = config.hasNoClaim ? nextNoClaim(principle) : null;
        submissions.push({
            id: subId,
            scope: "per_pengajuan",
            scopeLabel: claimWorkflowNo,
            noClaim,
            items: itemDetails,
            totalDpp, totalPpn, totalPph, totalClaim,
            totalPaid, remaining,
        });
    }

    // Insert submissions + items + PDFs.
    for (const sub of submissions) {
        let letterPath = null;
        let summaryPath = null;
        let receiptPath = null;
        let pdfGeneratedAt = null;
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
                config.isClosed ? "BASE seed: closed lunas + dokumen lengkap." : null,
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

        // Sync noClaim ke off_batch_item untuk setiap item submission ini.
        if (sub.noClaim) {
            for (const item of sub.items) {
                await db.execute({
                    sql: `UPDATE off_batch_item SET no_claim = ?, updated_at = ? WHERE id = ?`,
                    args: [sub.noClaim, ms(8), item.offBatchItemId],
                });
            }
        }

        // Payment rows per submission untuk Partially Paid / Paid / Closed.
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
                        `BASE seed payment ${p + 1}/${paymentRowCount}`,
                        null, ACTOR_ID, ms(3 + p), ms(3 + p),
                    ],
                });
            }
        }
    }

    // Mirror noClaim untuk single-submission workflow (legacy/cache).
    if (submissions.length === 1 && submissions[0].noClaim) {
        await db.execute({
            sql: `UPDATE claim_workflow SET no_claim = ?, no_claim_assigned_at = ?, no_claim_assigned_by = ?, updated_at = ? WHERE id = ?`,
            args: [submissions[0].noClaim, ms(8), ACTOR_ID, ms(1), id],
        });
    }

    // Mirror PDF path workflow-level untuk single-submission saja (legacy).
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

    // Audit trail ringkas per workflow.
    const auditEvents = [
        { action: "create_from_off", fromStatus: null, toStatus: "Draft",
          note: `BASE seed: dibuat dari OFF batch ${offBatch.noPengajuan}.`, at: ms(10) },
    ];
    if (multiSubmissionCount > 1) {
        auditEvents.push({
            action: "claim_submissions_created_per_item",
            fromStatus: "Draft", toStatus: "Draft",
            note: `BASE seed: ${submissions.length} per_item submission dibuat (multi No Claim).`,
            at: ms(9),
            metadataExtra: { createdCount: submissions.length, mode: "all_unassigned" },
        });
    }
    if (config.status === "Need Revision") {
        auditEvents.push({ action: "demo_seed_need_revision",
            fromStatus: "Draft", toStatus: "Need Revision",
            note: "BASE seed: ditandai Need Revision.", at: ms(8) });
    }
    if (["Ready to Submit", "Submitted to Principal", "Partially Paid", "Paid", "Outstanding", "Closed"].includes(config.status)) {
        auditEvents.push({ action: "mark_ready",
            fromStatus: "Draft", toStatus: "Ready to Submit",
            note: "BASE seed", at: ms(8) });
    }
    if (config.hasSubmittedAt) {
        auditEvents.push({ action: "submit_to_principal",
            fromStatus: "Ready to Submit", toStatus: "Submitted to Principal",
            note: null, at: ms(6) });
    }
    if (["Partially Paid", "Paid", "Outstanding", "Closed"].includes(config.status)) {
        auditEvents.push({ action: "demo_seed_advance_status",
            fromStatus: "Submitted to Principal", toStatus: config.status,
            note: "BASE seed: status lanjutan diisi langsung.", at: ms(5) });
    }
    if (config.isClosed) {
        auditEvents.push({ action: "claim_closed",
            fromStatus: "Paid", toStatus: "Closed",
            note: "BASE seed: closed lunas.", at: ms(1) });
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
                JSON.stringify({ baseSeed: true, totalDpp, totalPpn, totalPph, totalClaim, totalPaid, ...evt.metadataExtra }),
                evt.at,
            ],
        });
    }

    return {
        id, claimWorkflowNo,
        submissionCount: submissions.length,
        itemCount: itemDetails.length,
        totalClaim, totalPaid,
    };
}

// =============================================================================
// SECTION 9 — main runner
// =============================================================================

async function main() {
    console.log(`[seed-r7-large] DATABASE_URL=${databaseUrl}`);
    await ensureTables();
    await cleanupOldBase();

    const stats = {
        offBatches: 0,
        offBatchesFree: 0,
        workflowsSingle: 0,
        workflowsMulti: 0,
        submissions: 0,
        items: 0,
        pdfs: 0,
        payments: 0,
    };

    // 1) 12 OFF batch tanpa claim_workflow → siap diuji "create from off".
    console.log("[seed-r7-large] Insert 12 OFF batch FREE (siap dibuat claim baru)...");
    let seq = 1;
    for (let i = 0; i < 12; i += 1) {
        const principle = pickRand(PRINCIPLES, i);
        const itemCount = 2 + (i % 4);
        const batch = await insertOffBatch(seq++, OM_APPROVED, principle, itemCount);
        stats.offBatches += 1;
        stats.offBatchesFree += 1;
        console.log(`  - ${batch.noPengajuan} (${itemCount} item)`);
    }

    // 2) 8 status × 4 principal = 32 single-submission workflow.
    console.log("[seed-r7-large] Insert 32 single-submission Claim Workflow (8 status × 4 principal)...");
    let workflowSeq = 1;
    for (let s = 0; s < CLAIM_STATUS_CONFIGS.length; s += 1) {
        const config = CLAIM_STATUS_CONFIGS[s];
        for (let p = 0; p < PRINCIPLES.length; p += 1) {
            const principle = PRINCIPLES[p];
            const itemCount = 2 + ((s + p) % 4);
            const sourceBatch = await insertOffBatch(seq++, OM_APPROVED, principle, itemCount);
            stats.offBatches += 1;
            const wf = await insertClaimWorkflow({
                workflowSeq: workflowSeq++,
                config,
                offBatch: sourceBatch,
                principle,
                multiSubmissionCount: 1,
            });
            stats.workflowsSingle += 1;
            stats.submissions += wf.submissionCount;
            stats.items += wf.itemCount;
            if (config.hasPdf) stats.pdfs += wf.submissionCount * 3;
            if (config.paidFraction > 0) stats.payments += (config.paymentRows || 1) * wf.submissionCount;
            console.log(`  - ${wf.claimWorkflowNo} | ${config.status} | sub=${wf.submissionCount} | items=${wf.itemCount}`);
        }
    }

    // 3) Multi-No-Claim workflows: 4 principal × 2 status (Submitted + Partially Paid)
    //    dengan 4 item per OFF batch → 4 per_item submission per workflow.
    console.log("[seed-r7-large] Insert 8 multi-No-Claim Claim Workflow (4 principal × 2 status × 4 item)...");
    const multiConfigs = [
        CLAIM_STATUS_CONFIGS.find((c) => c.key === "submitted"),
        CLAIM_STATUS_CONFIGS.find((c) => c.key === "partially_paid_60"),
    ];
    for (let s = 0; s < multiConfigs.length; s += 1) {
        const config = multiConfigs[s];
        for (let p = 0; p < PRINCIPLES.length; p += 1) {
            const principle = PRINCIPLES[p];
            const itemCount = 4;
            const sourceBatch = await insertOffBatch(seq++, OM_APPROVED, principle, itemCount);
            stats.offBatches += 1;
            const wf = await insertClaimWorkflow({
                workflowSeq: workflowSeq++,
                config,
                offBatch: sourceBatch,
                principle,
                multiSubmissionCount: itemCount,
            });
            stats.workflowsMulti += 1;
            stats.submissions += wf.submissionCount;
            stats.items += wf.itemCount;
            if (config.hasPdf) stats.pdfs += wf.submissionCount * 3;
            if (config.paidFraction > 0) stats.payments += (config.paymentRows || 1) * wf.submissionCount;
            console.log(`  - ${wf.claimWorkflowNo} | ${config.status} (multi) | sub=${wf.submissionCount} | items=${wf.itemCount}`);
        }
    }

    console.log("");
    console.log("==================================================");
    console.log("[seed-r7-large] Selesai.");
    console.log(`  OFF batches               : ${stats.offBatches}`);
    console.log(`  OFF batches free (no claim): ${stats.offBatchesFree}`);
    console.log(`  Workflow single-submission: ${stats.workflowsSingle}`);
    console.log(`  Workflow multi-submission : ${stats.workflowsMulti}`);
    console.log(`  Total submissions         : ${stats.submissions}`);
    console.log(`  Total claim items         : ${stats.items}`);
    console.log(`  PDF stub                  : ${stats.pdfs}`);
    console.log(`  Claim payment rows        : ${stats.payments}`);
    console.log("");
    console.log("Verifikasi:");
    console.log("  /off-program-control");
    console.log("  /claim-workflow");
    console.log("  /claim-workflow/<id>  → cek Daftar Claim + Detail panel + Teknis/Riwayat");
    console.log("==================================================");
}

main().catch((error) => {
    console.error("[seed-r7-large] FAILED:", error);
    process.exit(1);
});
