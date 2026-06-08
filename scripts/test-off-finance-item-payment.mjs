import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";

const PREFIX = "TEST-OFF-FIN-ITEM";
const NOW = new Date("2026-05-25T08:00:00.000Z");
const db = createClient({ url: process.env.DATABASE_URL || "file:sqlite.db" });

let pass = 0;
let fail = 0;

function check(name, condition, detail = "") {
  if (condition) pass += 1;
  else fail += 1;
  console.log(`${condition ? "PASS" : "FAIL"} :: ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function cleanup() {
  const rows = await db.execute({ sql: "SELECT id FROM off_batch WHERE no_pengajuan LIKE ?", args: [`${PREFIX}%`] });
  const ids = rows.rows.map((row) => String(row.id));
  for (const id of ids) {
    await db.execute({ sql: "DELETE FROM off_audit_log WHERE batch_id=?", args: [id] }).catch(() => {});
    await db.execute({ sql: "DELETE FROM off_payment WHERE batch_id=?", args: [id] }).catch(() => {});
    await db.execute({ sql: "DELETE FROM off_batch_item WHERE batch_id=?", args: [id] }).catch(() => {});
    await db.execute({ sql: "DELETE FROM off_batch WHERE id=?", args: [id] }).catch(() => {});
  }
}

async function createBatch() {
  const batchId = randomUUID();
  const now = NOW.getTime();
  await db.execute({
    sql: `INSERT INTO off_batch (id, no_pengajuan, gelombang, principle_code, principle_name, bulan, tahun, supervisor_name, total_nominal, status, sm_status, claim_status, om_status, finance_status, final_status, locked, pdf_status, receipt_pdf_status, updated_at, created_at)
          VALUES (?, ?, '999', 'URC', 'URC INDONESIA, PT', '05', '2026', 'Tester', 6000, 'OM Approved', 'Approved by SM', 'Approved', 'Approved', 'Waiting Payment', 'Not Started', 1, 'pending', 'pending', ?, ?)`,
    args: [batchId, `${PREFIX}-${Date.now()}`, now, now],
  });
  const items = [
    [randomUUID(), batchId, 1, "Transfer", 1000],
    [randomUUID(), batchId, 2, "Transfer", 2000],
    [randomUUID(), batchId, 3, "Tunai", 3000],
  ];
  for (const [id, batch, no, method, nominal] of items) {
    await db.execute({
      sql: `INSERT INTO off_batch_item (id, batch_id, item_no, row_no, no_surat, nama_program, nominal, cara_bayar, finance_payment_status, type, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'Program', ?, ?, 'unpaid', 'Display', ?, ?)`,
      args: [id, batch, no, no, `SURAT-${no}`, nominal, method, now, now],
    });
  }
  return { batchId, transferIds: [items[0][0], items[1][0]], tunaiId: items[2][0] };
}

async function payItems(batchId, itemIds, requireProof = false, hasProof = false, clientPayload = {}) {
  const selected = await db.execute({
    sql: `SELECT id, nominal, cara_bayar, finance_payment_status, finance_payment_id FROM off_batch_item WHERE batch_id=? AND id IN (${itemIds.map(() => "?").join(",")})`,
    args: [batchId, ...itemIds],
  });
  const rows = selected.rows;
  const methods = Array.from(new Set(rows.map((row) => String(row.cara_bayar))));
  if (rows.length !== itemIds.length) throw new Error("invalid item ownership");
  if (rows.some((row) => row.finance_payment_status === "paid" || row.finance_payment_id)) throw new Error("already paid");
  if (methods.length !== 1) throw new Error("mixed method rejected");
  if (requireProof && methods[0] === "Transfer" && !hasProof) throw new Error("transfer proof required");
  const ignoredClientAmount = clientPayload.paidAmount;
  const ignoredClientMethod = clientPayload.paymentMethod;
  const total = rows.reduce((sum, row) => sum + Number(row.nominal || 0), 0);
  const paymentId = randomUUID();
  const paidBefore = await db.execute({ sql: "SELECT COALESCE(SUM(finance_paid_amount),0) AS total FROM off_batch_item WHERE batch_id=? AND finance_payment_status='paid'", args: [batchId] });
  const totalPaidAfter = Number(paidBefore.rows[0]?.total || 0) + total;
  const totalNominal = await db.execute({ sql: "SELECT COALESCE(SUM(nominal),0) AS total FROM off_batch_item WHERE batch_id=?", args: [batchId] });
  const isFullyPaid = totalPaidAfter === Number(totalNominal.rows[0]?.total || 0);
  await db.execute({ sql: "INSERT INTO off_payment (id, batch_id, payment_no, payment_date, paid_amount, payment_method, created_at, updated_at) VALUES (?, ?, 1, '2026-05-25', ?, ?, ?, ?)", args: [paymentId, batchId, total, methods[0], NOW.getTime(), NOW.getTime()] });
  for (const id of itemIds) {
    await db.execute({ sql: "UPDATE off_batch_item SET finance_payment_status='paid', finance_payment_id=?, finance_paid_amount=nominal, finance_paid_at=? WHERE id=?", args: [paymentId, NOW.getTime(), id] });
  }
  await db.execute({ sql: "UPDATE off_batch SET status=?, finance_status=?, final_status=?, paid_amount=?, updated_at=? WHERE id=?", args: [isFullyPaid ? "Paid" : "Partial Paid", isFullyPaid ? "Paid" : "Partial Paid", isFullyPaid ? "Waiting Claim Final Verification" : "Not Started", totalPaidAfter, NOW.getTime(), batchId] });
  return { total, method: methods[0], isFullyPaid, ignoredClientAmount, ignoredClientMethod };
}

try {
  await cleanup();
  const { batchId, transferIds, tunaiId } = await createBatch();
  await payItems(batchId, [transferIds[0], tunaiId]).then(() => check("mixed method rejected", false)).catch((error) => check("mixed method rejected", error.message === "mixed method rejected", error.message));
  await payItems(batchId, transferIds, true, false).then(() => check("transfer proof required", false)).catch((error) => check("transfer proof required", error.message === "transfer proof required", error.message));
  const first = await payItems(batchId, transferIds, true, true, { paidAmount: 999999, paymentMethod: "Tunai" });
  check("transfer selected total", first.total === 3000, String(first.total));
  check("transfer method from item", first.method === "Transfer", first.method);
  check("fake client amount ignored", first.ignoredClientAmount === 999999 && first.total === 3000, `${first.ignoredClientAmount}/${first.total}`);
  check("fake client method ignored", first.ignoredClientMethod === "Tunai" && first.method === "Transfer", `${first.ignoredClientMethod}/${first.method}`);
  const afterFirst = await db.execute({ sql: "SELECT status, finance_status, paid_amount FROM off_batch WHERE id=?", args: [batchId] });
  check("partial selected paid => Partial Paid", afterFirst.rows[0]?.finance_status === "Partial Paid" && afterFirst.rows[0]?.status === "Partial Paid", JSON.stringify(afterFirst.rows[0]));
  await payItems(batchId, [transferIds[0]]).then(() => check("paid row disabled/rejected", false)).catch((error) => check("paid row disabled/rejected", error.message === "already paid", error.message));
  const second = await payItems(batchId, [tunaiId], false, false);
  check("tunai proof optional", second.method === "Tunai" && second.total === 3000, `${second.method}/${second.total}`);
  const afterSecond = await db.execute({ sql: "SELECT status, finance_status, final_status, paid_amount FROM off_batch WHERE id=?", args: [batchId] });
  check("all items paid => Paid", afterSecond.rows[0]?.finance_status === "Paid" && afterSecond.rows[0]?.status === "Paid", JSON.stringify(afterSecond.rows[0]));
  await cleanup();
  console.log(`\n==== OFF FINANCE ITEM PAYMENT: ${pass} PASS / ${fail} FAIL ====`);
  process.exit(fail > 0 ? 1 : 0);
} catch (error) {
  console.error("FATAL", error);
  await cleanup().catch(() => {});
  process.exit(1);
}
