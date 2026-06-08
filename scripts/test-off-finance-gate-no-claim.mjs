import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";

const db = createClient({ url: process.env.DATABASE_URL || "file:sqlite.db" });
const PREFIX = "TEST-OFF-GATE-NOCLAIM";
const NOW = new Date("2026-06-06T08:00:00.000Z").getTime();

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) pass += 1;
  else fail += 1;
  console.log(`${condition ? "PASS" : "FAIL"} :: ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function cleanup() {
  const rows = await db.execute({
    sql: "SELECT id FROM off_batch WHERE no_pengajuan LIKE ?",
    args: [`${PREFIX}%`],
  });
  for (const row of rows.rows) {
    const batchId = String(row.id);
    await db.execute({ sql: "DELETE FROM off_payment WHERE batch_id=?", args: [batchId] }).catch(() => {});
    await db.execute({ sql: "DELETE FROM off_batch_item WHERE batch_id=?", args: [batchId] }).catch(() => {});
    await db.execute({ sql: "DELETE FROM off_batch WHERE id=?", args: [batchId] }).catch(() => {});
  }
}

async function createBatch({ financeStatus = "Paid", headerTotal = 0, itemNominals = [], payments = [] }) {
  const batchId = randomUUID();
  await db.execute({
    sql: `INSERT INTO off_batch (id, no_pengajuan, gelombang, principle_code, principle_name, bulan, tahun, supervisor_name, total_nominal, status, sm_status, claim_status, om_status, finance_status, final_status, locked, pdf_status, receipt_pdf_status, updated_at, created_at)
          VALUES (?, ?, '999', 'MI', 'MARKETAMA INDAH, PT', '05', '2026', 'Gate Test', ?, ?, 'Approved by SM', 'Approved', 'Approved', ?, 'Waiting Claim Final Verification', 1, 'pending', 'pending', ?, ?)`,
    args: [batchId, `${PREFIX}-${randomUUID()}`, headerTotal, financeStatus === "Paid" ? "Paid" : "Partial Paid", financeStatus, NOW, NOW],
  });
  for (const [index, nominal] of itemNominals.entries()) {
    await db.execute({
      sql: `INSERT INTO off_batch_item (id, batch_id, item_no, row_no, no_surat, nama_program, nominal, cara_bayar, finance_payment_status, type, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'Gate Program', ?, 'Transfer', 'unpaid', 'Display', ?, ?)`,
      args: [randomUUID(), batchId, index + 1, index + 1, `GATE-${index + 1}`, nominal, NOW, NOW],
    });
  }
  for (const [index, amount] of payments.entries()) {
    await db.execute({
      sql: `INSERT INTO off_payment (id, batch_id, payment_no, payment_date, paid_amount, payment_method, created_at, updated_at)
            VALUES (?, ?, ?, '2026-06-06', ?, 'Transfer', ?, ?)`,
      args: [randomUUID(), batchId, index + 1, amount, NOW, NOW],
    });
  }
  return batchId;
}

async function gate(offBatchId) {
  const batchRows = await db.execute({
    sql: "SELECT status, finance_status, total_nominal FROM off_batch WHERE id=?",
    args: [offBatchId],
  });
  const batch = batchRows.rows[0];
  if (!batch) return { isPaid: false, totalNominal: 0, totalPaid: 0, nominalSource: "none", reason: "OFF Batch tidak ditemukan." };
  const itemRows = await db.execute({
    sql: "SELECT nominal FROM off_batch_item WHERE batch_id=?",
    args: [offBatchId],
  });
  const paymentRows = await db.execute({
    sql: "SELECT paid_amount FROM off_payment WHERE batch_id=?",
    args: [offBatchId],
  });
  const itemNominalTotal = itemRows.rows.reduce((sum, item) => sum + Number(item.nominal || 0), 0);
  const headerNominalTotal = Number(batch.total_nominal || 0);
  const nominalSource = itemNominalTotal > 0 ? "items" : headerNominalTotal > 0 ? "header" : "none";
  const totalNominal = nominalSource === "items" ? itemNominalTotal : nominalSource === "header" ? headerNominalTotal : 0;
  const totalPaid = paymentRows.rows.reduce((sum, payment) => sum + Number(payment.paid_amount || 0), 0);
  const financeStatusIsPaid = batch.finance_status === "Paid";
  const isFullyPaid = totalPaid >= totalNominal && totalNominal > 0;
  return { isPaid: financeStatusIsPaid && isFullyPaid, financeStatus: batch.finance_status, totalNominal, totalPaid, nominalSource };
}

try {
  await cleanup();

  const passItems = await createBatch({ headerTotal: 0, itemNominals: [4400000, 3750000, 4350000], payments: [12500000] });
  const passItemsGate = await gate(passItems);
  check("header 0 + item total + payment full => PASS", passItemsGate.isPaid && passItemsGate.totalNominal === 12500000 && passItemsGate.nominalSource === "items", JSON.stringify(passItemsGate));

  const failNoPayment = await createBatch({ headerTotal: 0, itemNominals: [4400000, 3750000, 4350000], payments: [] });
  const failNoPaymentGate = await gate(failNoPayment);
  check("header 0 + item total + payment 0 => FAIL", !failNoPaymentGate.isPaid && failNoPaymentGate.totalPaid === 0, JSON.stringify(failNoPaymentGate));

  const passHeader = await createBatch({ headerTotal: 12500000, itemNominals: [], payments: [12500000] });
  const passHeaderGate = await gate(passHeader);
  check("header fallback positive + no items + payment full => PASS", passHeaderGate.isPaid && passHeaderGate.nominalSource === "header", JSON.stringify(passHeaderGate));

  const failStatus = await createBatch({ financeStatus: "Partial Paid", headerTotal: 0, itemNominals: [12500000], payments: [12500000] });
  const failStatusGate = await gate(failStatus);
  check("financeStatus not Paid + payment full => FAIL", !failStatusGate.isPaid && failStatusGate.financeStatus !== "Paid", JSON.stringify(failStatusGate));

  const failZero = await createBatch({ headerTotal: 0, itemNominals: [], payments: [] });
  const failZeroGate = await gate(failZero);
  check("zero header + zero items => FAIL", !failZeroGate.isPaid && failZeroGate.totalNominal === 0 && failZeroGate.nominalSource === "none", JSON.stringify(failZeroGate));

  await cleanup();
  console.log(`\n==== OFF FINANCE GATE NO CLAIM: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail > 0 ? 1 : 0);
} catch (error) {
  console.error("FATAL", error);
  await cleanup().catch(() => {});
  process.exit(1);
}
