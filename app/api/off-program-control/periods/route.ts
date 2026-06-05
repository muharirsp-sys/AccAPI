/*
 * Tujuan: API tutup/buka periode OFF Program Control berdasarkan principal dan periode.
 * Caller: OverviewTab halaman OFF Program Control.
 * Dependensi: Better Auth OFF session, Drizzle SQLite, offBatch/offBatchItem/offPayment/offPeriodClosure, audit OFF.
 * Main Functions: POST close/unlock periode, ensurePeriodClosureTable, summarizePeriod.
 * Side Effects: DB read/write SQLite untuk status periode dan audit log.
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { offBatch, offBatchItem, offPayment, offPeriodClosure } from "@/db/schema";
import {
  canActorPerformOffAction,
  getPrincipleByCode,
  requireOffSession,
  writeOffAudit,
} from "@/lib/off-program-control";

type PeriodAction = "close" | "unlock";

async function ensurePeriodClosureTable() {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS off_period_closure (
      id TEXT PRIMARY KEY,
      principle_code TEXT NOT NULL,
      principle_name TEXT NOT NULL,
      bulan TEXT NOT NULL,
      tahun TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Terbuka',
      total_submitted REAL NOT NULL DEFAULT 0,
      total_claimed REAL NOT NULL DEFAULT 0,
      submitted_count INTEGER NOT NULL DEFAULT 0,
      claimed_count INTEGER NOT NULL DEFAULT 0,
      closed_by TEXT,
      closed_at INTEGER,
      unlocked_by TEXT,
      unlocked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS off_period_closure_key_idx
    ON off_period_closure (principle_code, bulan, tahun)
  `);
}

function moneyComparable(value: number) {
  return Math.round(Number(value || 0));
}

async function summarizePeriod(input: {
  principleCode: string;
  bulan: string;
  tahun: string;
}) {
  const batches = await db
    .select()
    .from(offBatch)
    .where(
      and(
        eq(offBatch.principleCode, input.principleCode),
        eq(offBatch.bulan, input.bulan),
        eq(offBatch.tahun, input.tahun),
      ),
    );
  const batchIds = batches.map((batch) => batch.id);
  if (batchIds.length === 0) {
    return {
      batches,
      totalSubmitted: 0,
      totalClaimed: 0,
      submittedCount: 0,
      claimedCount: 0,
      isMatched: false,
    };
  }

  const [items, payments] = await Promise.all([
    db.select().from(offBatchItem).where(inArray(offBatchItem.batchId, batchIds)),
    db.select().from(offPayment).where(inArray(offPayment.batchId, batchIds)),
  ]);
  const claimedBatchIds = new Set(
    batches
      .filter((batch) => String(batch.noClaim || "").trim().length > 0)
      .map((batch) => batch.id),
  );

  const totalSubmitted = items.reduce(
    (total, item) => total + Number(item.nominal || 0),
    0,
  );
  const totalClaimed = payments.reduce(
    (total, payment) => total + Number(payment.paidAmount || 0),
    0,
  );

  return {
    batches,
    totalSubmitted,
    totalClaimed,
    submittedCount: batches.length,
    claimedCount: claimedBatchIds.size,
    isMatched:
      batches.length > 0 &&
      moneyComparable(totalSubmitted) === moneyComparable(totalClaimed),
  };
}

export async function POST(request: Request) {
  await ensurePeriodClosureTable();
  const actor = await requireOffSession();
  if (!actor) {
    return NextResponse.json(
      { ok: false, error: "Anda tidak memiliki akses untuk melakukan tindakan ini." },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action || "") as PeriodAction;
  const principleCode = String(body.principleCode || "").trim();
  const bulan = String(body.bulan || "").trim().padStart(2, "0");
  const tahun = String(body.tahun || "").trim();
  const principle = getPrincipleByCode(principleCode);

  if (!["close", "unlock"].includes(action) || !principle || !bulan || !tahun) {
    return NextResponse.json(
      { ok: false, error: "Principal dan periode wajib diisi dengan benar." },
      { status: 400 },
    );
  }
  if (action === "close" && !canActorPerformOffAction(actor, "period_close")) {
    return NextResponse.json(
      { ok: false, error: "Anda tidak memiliki akses untuk menutup periode." },
      { status: 403 },
    );
  }
  if (action === "unlock" && !canActorPerformOffAction(actor, "period_unlock")) {
    return NextResponse.json(
      { ok: false, error: "Anda tidak memiliki akses untuk membuka kunci periode." },
      { status: 403 },
    );
  }

  const summary = await summarizePeriod({ principleCode, bulan, tahun });
  if (action === "close" && !summary.isMatched) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Periode belum dapat ditutup karena total pengajuan dan total klaim belum sesuai.",
        summary,
      },
      { status: 409 },
    );
  }

  const now = new Date();
  const [existing] = await db
    .select()
    .from(offPeriodClosure)
    .where(
      and(
        eq(offPeriodClosure.principleCode, principleCode),
        eq(offPeriodClosure.bulan, bulan),
        eq(offPeriodClosure.tahun, tahun),
      ),
    );

  const nextStatus = action === "close" ? "Ditutup" : "Terbuka";
  const closurePatch = {
    principleCode,
    principleName: principle.name,
    bulan,
    tahun,
    status: nextStatus,
    totalSubmitted: summary.totalSubmitted,
    totalClaimed: summary.totalClaimed,
    submittedCount: summary.submittedCount,
    claimedCount: summary.claimedCount,
    closedBy: action === "close" ? actor.id : existing?.closedBy || null,
    closedAt: action === "close" ? now : existing?.closedAt || null,
    unlockedBy: action === "unlock" ? actor.id : existing?.unlockedBy || null,
    unlockedAt: action === "unlock" ? now : existing?.unlockedAt || null,
    updatedAt: now,
  };

  if (existing) {
    await db
      .update(offPeriodClosure)
      .set(closurePatch)
      .where(eq(offPeriodClosure.id, existing.id));
  } else {
    await db.insert(offPeriodClosure).values({
      id: randomUUID(),
      ...closurePatch,
      createdAt: now,
    });
  }

  await Promise.all(
    summary.batches.map((batch) =>
      writeOffAudit({
        batchId: batch.id,
        actor,
        action: action === "close" ? "period_closed" : "period_unlocked",
        fromStatus: existing?.status || "Terbuka",
        toStatus: nextStatus,
        metadata: {
          principleCode,
          bulan,
          tahun,
          totalSubmitted: summary.totalSubmitted,
          totalClaimed: summary.totalClaimed,
        },
      }),
    ),
  );

  return NextResponse.json({
    ok: true,
    message:
      action === "close"
        ? "Periode berhasil ditutup. Data pada periode ini sudah dikunci."
        : "Kunci periode berhasil dibuka oleh Admin.",
    status: nextStatus,
    summary,
  });
}
