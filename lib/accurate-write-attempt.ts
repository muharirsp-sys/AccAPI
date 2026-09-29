/**
 * Tujuan: Cegah pengiriman ganda ke Accurate secara server-side (AM-014 / C.12–C.16): attempt
 *   diklaim atomik di Postgres SEBELUM request keluar, hasil dicatat per tahap, attempt yang
 *   tidak pasti tidak pernah dibuka ulang otomatis.
 * Caller: app/api/finance/purchase-payment/route.ts dan .../resolve/route.ts.
 * Dependensi: tabel accurate_write_attempt (db/schema.ts, scripts/migrate-pg.mjs),
 *   classifyBulkSaveResponse (lib/apiFetcher.ts).
 * Main Functions: purchasePaymentSubject, validatePurchasePaymentPayload, classifyProviderReply,
 *   runGuardedWrite, resolveAttempt.
 * Side Effects: INSERT/UPDATE accurate_write_attempt; `send` (jaringan) dipanggil TANPA
 *   transaksi DB terbuka — klaim sudah commit sendiri sebelum kirim.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { accurateWriteAttempt } from "@/db/schema";
import { classifyBulkSaveResponse } from "@/lib/apiFetcher";

export const PURCHASE_PAYMENT_OPERATION = "purchase-payment/bulk-save";

export type AttemptState = "sending" | "posted" | "rejected" | "unknown" | "not_sent" | "resolved_absent";
/** Attempt HIDUP memblokir attempt baru untuk subjek yang sama (uq_accurate_write_attempt_live). */
const LIVE_STATES: AttemptState[] = ["sending", "posted", "unknown"];
/** `sending` lebih tua dari ini = proses mati setelah MUNGKIN kirim (fetch timeout 30 s). */
export const SENDING_STALE_MS = 2 * 60_000;

export type Attempt = typeof accurateWriteAttempt.$inferSelect;
export type ProviderReply = { status: number; text: string } | { error: unknown };
export type Classified = { state: "posted" | "rejected" | "unknown" | "not_sent"; message: string; id: string; number: string };

export type PurchasePaymentItem = {
    bankNo: string;
    vendorNo: string;
    chequeAmount: number;
    transDate: string;
    chequeDate: string;
    paymentMethod: string;
    description: string;
    detailInvoice: { invoiceNo: string; paymentAmount: number }[];
};

const isPositive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const isText = (v: unknown) => typeof v === "string" && v.trim() !== "";
const DMY = /^\d{2}\/\d{2}\/\d{4}$/;

/** Validasi di batas kepercayaan: payload dari browser. null = valid, string = alasan tolak. */
export function validatePurchasePaymentPayload(payload: unknown): string | null {
    if (!Array.isArray(payload) || payload.length !== 1) return "payload wajib array berisi tepat 1 purchase-payment";
    const p = payload[0] as Partial<PurchasePaymentItem>;
    if (!isText(p.bankNo) || !isText(p.vendorNo)) return "bankNo dan vendorNo wajib";
    if (!isPositive(p.chequeAmount)) return "chequeAmount wajib angka > 0";
    if (!DMY.test(String(p.transDate)) || !DMY.test(String(p.chequeDate))) return "transDate/chequeDate wajib dd/mm/yyyy";
    if (p.paymentMethod !== "BANK_TRANSFER") return "paymentMethod wajib BANK_TRANSFER";
    if (typeof p.description !== "string") return "description wajib teks";
    if (!Array.isArray(p.detailInvoice) || !p.detailInvoice.length) return "detailInvoice wajib diisi";
    for (const it of p.detailInvoice) {
        const no = String(it?.invoiceNo ?? "").trim().toUpperCase();
        if (!no || no === "BELUM ADA") return "invoiceNo kosong/BELUM ADA tidak boleh dipost";
        if (!isPositive(it?.paymentAmount)) return `paymentAmount ${no} wajib angka > 0`;
    }
    return null;
}

/**
 * Identitas bisnis attempt, diturunkan SERVER dari payload (bukan dari kunci kiriman browser):
 * himpunan nomor faktur pembelian Accurate (unik per database). Membayar himpunan yang sama dua
 * kali = bayar dobel, apa pun draft/tab/user/mapping vendor asalnya — vendor sengaja TIDAK ikut
 * agar ganti mapping tidak membuka kirim ulang. ponytail: tumpang-tindih sebagian tidak
 * tertangkap — klaim per faktur bila cicilan parsial pernah dipastikan tidak ada.
 */
export function purchasePaymentSubject(item: Pick<PurchasePaymentItem, "detailInvoice">): string {
    return [...new Set(item.detailInvoice.map((it) => String(it.invoiceNo).trim().toUpperCase()))].sort().join(",");
}

export const payloadHash = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

// Kode yang membuktikan koneksi TCP tidak pernah terbentuk -> request tidak pernah sampai.
const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * Klasifikasi jawaban host Accurate untuk request INI (C.16). Angka status saja bukan bukti
 * "belum diproses": 401/403/429/3xx/5xx tanpa amplop penolakan Accurate = unknown. Hanya
 * amplop `{s:false, d}` (HTTP < 500) atau penolakan per item yang `rejected`.
 */
export function classifyProviderReply(reply: ProviderReply): Classified {
    const result = (state: Classified["state"], message: string, id = "", number = ""): Classified =>
        ({ state, message: message.slice(0, 500), id, number });
    if ("error" in reply) {
        const err = reply.error as { name?: string; message?: string; cause?: { code?: string } } | undefined;
        const code = err?.cause?.code ?? "";
        return NEVER_CONNECTED.has(code)
            ? result("not_sent", `tidak terhubung ke Accurate (${code})`)
            : result("unknown", `tanpa jawaban (${err?.name ?? "Error"}: ${err?.message ?? String(reply.error)})`);
    }
    const { status, text } = reply;
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return result("unknown", `respons non-JSON (HTTP ${status})`);
    }
    const top = data as { s?: unknown; d?: unknown } | null;
    if (status >= 200 && status < 500 && !Array.isArray(data) && top?.s === false && top.d !== undefined) {
        return result("rejected", JSON.stringify(top.d));
    }
    if (status < 200 || status >= 300) return result("unknown", `HTTP ${status} tanpa amplop penolakan: ${text.slice(0, 200)}`);
    const o = classifyBulkSaveResponse(data);
    return o.kind === "posted" ? result("posted", "", o.id, o.number) : result(o.kind, o.message);
}

type GuardedWriteInput = {
    db: NodePgDatabase;
    operation: string;
    subjectKey: string;
    clientRef: string;
    targetDbId: string;
    actor: string;
    payload: unknown;
    send: () => Promise<{ status: number; text: string }>;
};

export type GuardedWriteResult =
    | { claimed: false; live: Attempt | null }
    | { claimed: true; attemptId: string; outcome: Classified; response: unknown; persisted: boolean };

async function findLive(db: NodePgDatabase, operation: string, subjectKey: string) {
    const [live] = await db.select().from(accurateWriteAttempt).where(and(
        eq(accurateWriteAttempt.operation, operation),
        eq(accurateWriteAttempt.subjectKey, subjectKey),
        inArray(accurateWriteAttempt.state, LIVE_STATES),
    )).limit(1);
    return live ?? null;
}

/**
 * Klaim -> kirim -> catat. Klaim = satu INSERT yang ditolak unique partial index bila sudah ada
 * attempt hidup, jadi dua tab / dua user / reload hanya menghasilkan SATU pengiriman.
 * Gagal mencatat hasil setelah kirim membiarkan baris `sending` — tetap memblokir (C.16).
 */
export async function runGuardedWrite(input: GuardedWriteInput): Promise<GuardedWriteResult> {
    const { db, operation, subjectKey } = input;
    const attemptId = randomUUID();
    const claimed = await db.insert(accurateWriteAttempt).values({
        id: attemptId,
        operation,
        subjectKey,
        clientRef: input.clientRef,
        targetDbId: input.targetDbId,
        payloadHash: payloadHash(input.payload),
        actor: input.actor,
        state: "sending",
    }).onConflictDoNothing().returning({ id: accurateWriteAttempt.id });
    if (!claimed.length) return { claimed: false, live: await findLive(db, operation, subjectKey) };

    let reply: ProviderReply;
    try {
        reply = await input.send();
    } catch (error) {
        reply = { error };
    }
    const outcome = classifyProviderReply(reply);
    let response: unknown = null;
    if ("text" in reply) {
        try { response = JSON.parse(reply.text); } catch { response = reply.text.slice(0, 2000); }
    }
    const stage = "error" in reply
        ? { transport: outcome.state === "not_sent" ? "not_connected" : "no_reply" }
        : { transport: "replied", http_status: reply.status, response_excerpt: reply.text.slice(0, 2000) };
    let persisted = true;
    try {
        await db.update(accurateWriteAttempt).set({
            state: outcome.state,
            outcome: { ...stage, message: outcome.message },
            accurateId: outcome.id,
            accurateNumber: outcome.number,
            updatedAt: new Date(),
        }).where(and(eq(accurateWriteAttempt.id, attemptId), eq(accurateWriteAttempt.state, "sending")));
    } catch (err) {
        persisted = false;
        console.error("[accurate-write-attempt] hasil tidak tercatat, attempt tetap sending:", attemptId, err);
    }
    return { claimed: true, attemptId, outcome, response, persisted };
}

type ResolveInput = {
    db: NodePgDatabase;
    operation: string;
    subjectKey: string;
    decision: "posted" | "absent";
    accurateNumber: string;
    reason: string;
    checkedSource: string;
    actor: string;
    now?: Date;
};

export type ResolveResult =
    | { ok: true; attemptId: string; state: AttemptState }
    | { ok: false; code: "invalid" | "no_open_attempt" | "already_posted" | "in_flight" | "changed"; message: string; live?: Attempt };

/**
 * Penyelesaian manusia atas attempt `unknown` (atau `sending` basi) — C.15. Dicatat sebagai
 * atestasi manual (bukan verifikasi provider) dengan actor, waktu, alasan, sumber pemeriksaan
 * dan target DB; outcome lama dipertahankan di `resolution.previous_outcome`.
 */
export async function resolveAttempt(input: ResolveInput): Promise<ResolveResult> {
    const { db, operation, subjectKey, decision } = input;
    const now = input.now ?? new Date();
    if (input.reason.trim().length < 15) return { ok: false, code: "invalid", message: "alasan minimal 15 karakter" };
    if (!input.checkedSource.trim()) return { ok: false, code: "invalid", message: "sumber pemeriksaan wajib diisi" };
    if (decision === "posted" && !input.accurateNumber.trim()) return { ok: false, code: "invalid", message: "nomor purchase-payment wajib untuk keputusan posted" };

    const live = await findLive(db, operation, subjectKey);
    if (!live) return { ok: false, code: "no_open_attempt", message: "tidak ada attempt terbuka untuk subjek ini" };
    if (live.state === "posted") return { ok: false, code: "already_posted", message: `sudah posted ${live.accurateNumber}`, live };
    const staleBefore = new Date(now.getTime() - SENDING_STALE_MS);
    if (live.state === "sending" && live.updatedAt > staleBefore) {
        return { ok: false, code: "in_flight", message: "attempt masih dikirim — tunggu 2 menit lalu periksa Accurate", live };
    }

    const next: AttemptState = decision === "posted" ? "posted" : "resolved_absent";
    const rows = await db.update(accurateWriteAttempt).set({
        state: next,
        accurateNumber: decision === "posted" ? input.accurateNumber.trim() : live.accurateNumber,
        resolution: {
            source: "manual_attestation",
            decision,
            by: input.actor,
            at: now.toISOString(),
            reason: input.reason.trim(),
            checked_source: input.checkedSource.trim(),
            target_db_id: live.targetDbId,
            accurate_number: input.accurateNumber.trim(),
            previous_state: live.state,
            previous_outcome: live.outcome,
        },
        updatedAt: now,
    }).where(and(
        eq(accurateWriteAttempt.id, live.id),
        eq(accurateWriteAttempt.state, live.state),
        ...(live.state === "sending" ? [lt(accurateWriteAttempt.updatedAt, staleBefore)] : []),
    )).returning({ id: accurateWriteAttempt.id });
    if (!rows.length) return { ok: false, code: "changed", message: "attempt berubah saat diselesaikan — muat ulang" };
    return { ok: true, attemptId: live.id, state: next };
}
