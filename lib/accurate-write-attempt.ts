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
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { accurateWriteAttempt } from "@/db/schema";
import { classifyBulkSaveResponse } from "@/lib/apiFetcher";

export const PURCHASE_PAYMENT_OPERATION = "purchase-payment/bulk-save";

export type AttemptState = "sending" | "posted" | "rejected" | "unknown" | "not_sent" | "resolved_absent";
/** Attempt HIDUP memblokir attempt baru untuk subjek yang sama (uq_accurate_write_attempt_live). */
const LIVE_STATES: AttemptState[] = ["sending", "posted", "unknown"];
/** Attempt belum-pasti yang lebih muda dari ini MUNGKIN masih diproses Accurate (fetch timeout 30 s).
 * Diukur dengan jam DB (`now()`), sama dengan jam penulisan `updated_at`. */
const STALE_SQL = sql`now() - interval '2 minutes'`;

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

/**
 * Batas kepercayaan: payload dari browser DIBANGUN ULANG dari allowlist (review sesi 2 M2) —
 * kunci tambahan (`id`, `number`, `detailInvoice[5].invoiceNo` rata) tidak ikut terkirim, jadi
 * yang dikirim, di-hash dan dijadikan subjek adalah objek yang sama.
 */
export function normalizePurchasePaymentPayload(payload: unknown): { item: PurchasePaymentItem } | { error: string } {
    if (!Array.isArray(payload) || payload.length !== 1) return { error: "payload wajib array berisi tepat 1 purchase-payment" };
    const p = (payload[0] ?? {}) as Record<string, unknown>;
    if (!isText(p.bankNo) || !isText(p.vendorNo)) return { error: "bankNo dan vendorNo wajib teks" };
    if (!isPositive(p.chequeAmount)) return { error: "chequeAmount wajib angka > 0" };
    if (typeof p.transDate !== "string" || !DMY.test(p.transDate) || typeof p.chequeDate !== "string" || !DMY.test(p.chequeDate)) {
        return { error: "transDate/chequeDate wajib dd/mm/yyyy" };
    }
    if (p.paymentMethod !== "BANK_TRANSFER") return { error: "paymentMethod wajib BANK_TRANSFER" };
    if (typeof p.description !== "string") return { error: "description wajib teks" };
    if (!Array.isArray(p.detailInvoice) || !p.detailInvoice.length) return { error: "detailInvoice wajib diisi" };
    const detailInvoice: PurchasePaymentItem["detailInvoice"] = [];
    for (const raw of p.detailInvoice as Record<string, unknown>[]) {
        const invoiceNo = raw?.invoiceNo;
        if (typeof invoiceNo !== "string" || !invoiceNo.trim() || invoiceNo.trim().toUpperCase() === "BELUM ADA") {
            return { error: "invoiceNo wajib teks, bukan kosong/BELUM ADA" };
        }
        if (!isPositive(raw.paymentAmount)) return { error: `paymentAmount ${invoiceNo} wajib angka > 0` };
        detailInvoice.push({ invoiceNo: invoiceNo.trim(), paymentAmount: raw.paymentAmount as number });
    }
    return {
        item: {
            bankNo: (p.bankNo as string).trim(),
            vendorNo: (p.vendorNo as string).trim(),
            chequeAmount: p.chequeAmount as number,
            transDate: p.transDate,
            chequeDate: p.chequeDate,
            paymentMethod: "BANK_TRANSFER",
            description: p.description,
            detailInvoice,
        },
    };
}

/**
 * Identitas bisnis attempt, diturunkan SERVER dari payload (bukan dari kunci kiriman browser):
 * himpunan nomor faktur pembelian Accurate. Membayar himpunan yang sama dua kali = bayar dobel,
 * apa pun draft/tab/user/mapping vendor asalnya — vendor sengaja TIDAK ikut agar ganti mapping
 * tidak membuka kirim ulang. Target DB juga TIDAK ikut: himpunan yang sama di database lain
 * diblok (fail-closed, H11) dan 409 memberi tahu targetDbId-nya. ponytail: tumpang-tindih
 * sebagian tidak tertangkap — klaim per faktur bila cicilan parsial dipastikan tidak ada.
 */
export function purchasePaymentSubject(item: Pick<PurchasePaymentItem, "detailInvoice">): string {
    const key = [...new Set(item.detailInvoice.map((it) => String(it.invoiceNo).trim().toUpperCase()))].sort().join(",");
    // Batas baris btree (~2.7 KB): himpunan faktur sangat panjang disimpan sebagai hash.
    return key.length > 1000 ? `sha256:${createHash("sha256").update(key).digest("hex")}` : key;
}

export const payloadHash = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

// Kode yang membuktikan koneksi TCP tidak pernah terbentuk -> request tidak pernah sampai.
const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * Klasifikasi jawaban host Accurate untuk request INI (C.16). Angka status saja bukan bukti
 * "belum diproses": 401/403/429/3xx/5xx = unknown.
 * C11 (owner 8 Okt 2026, tanpa sandbox): penolakan Accurate (amplop `{s:false, d}` atau semua item
 * `s:false`) BELUM TERBUKTI berarti tidak tersimpan -> unknown (Finance menyelesaikan lewat resolve),
 * bukan `rejected` yang membuka kirim ulang. Hanya `not_sent` (koneksi tak pernah terbentuk) yang
 * boleh diulang tanpa penyelesaian.
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
    if (!Array.isArray(data) && top?.s === false && top.d !== undefined) {
        return result("unknown", `Accurate menolak (HTTP ${status}), belum terbukti tidak tersimpan: ${JSON.stringify(top.d)}`);
    }
    if (status < 200 || status >= 300) return result("unknown", `HTTP ${status} tanpa amplop penolakan: ${text.slice(0, 200)}`);
    const o = classifyBulkSaveResponse(data);
    if (o.kind === "posted") return result("posted", "", o.id, o.number);
    return result("unknown", o.kind === "rejected" ? `Accurate menolak, belum terbukti tidak tersimpan: ${o.message}` : o.message);
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
            updatedAt: sql`now()`,
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
    /** Database Accurate sesi PENYELESAI — harus sama dengan target attempt (review sesi 2 M3). */
    resolverDbId: string;
};

export type ResolveResult =
    | { ok: true; attemptId: string; state: AttemptState }
    | { ok: false; code: "invalid" | "no_open_attempt" | "already_posted" | "wrong_database" | "in_flight" | "changed"; message: string; live?: Attempt };

/**
 * Penyelesaian manusia atas attempt `unknown` (atau `sending` basi) — C.15. Dicatat sebagai
 * atestasi manual (bukan verifikasi provider) dengan actor, waktu, alasan, sumber pemeriksaan
 * dan target DB; outcome lama dipertahankan di `resolution.previous_outcome`.
 * "Tidak ada" hanya setelah attempt basi 2 menit (Accurate mungkin masih memproses — M1);
 * "posted" dengan nomor boleh kapan saja untuk `unknown` (menutup kirim ulang, tidak membukanya).
 */
export async function resolveAttempt(input: ResolveInput): Promise<ResolveResult> {
    const { db, operation, subjectKey, decision } = input;
    if (input.reason.trim().length < 15) return { ok: false, code: "invalid", message: "alasan minimal 15 karakter" };
    if (!input.checkedSource.trim()) return { ok: false, code: "invalid", message: "sumber pemeriksaan wajib diisi" };
    if (decision === "posted" && !input.accurateNumber.trim()) return { ok: false, code: "invalid", message: "nomor purchase-payment wajib untuk keputusan posted" };

    const live = await findLive(db, operation, subjectKey);
    if (!live) return { ok: false, code: "no_open_attempt", message: "tidak ada attempt terbuka untuk subjek ini" };
    if (live.state === "posted") return { ok: false, code: "already_posted", message: `sudah posted ${live.accurateNumber}`, live };
    if (live.targetDbId !== input.resolverDbId) {
        return { ok: false, code: "wrong_database", message: `attempt ini dikirim ke database Accurate ${live.targetDbId}; buka database itu lalu periksa di sana`, live };
    }
    const needsStale = live.state === "sending" || decision === "absent";

    const next: AttemptState = decision === "posted" ? "posted" : "resolved_absent";
    const rows = await db.update(accurateWriteAttempt).set({
        state: next,
        accurateNumber: decision === "posted" ? input.accurateNumber.trim() : live.accurateNumber,
        resolution: {
            source: "manual_attestation",
            decision,
            by: input.actor,
            at: new Date().toISOString(),
            reason: input.reason.trim(),
            checked_source: input.checkedSource.trim(),
            target_db_id: live.targetDbId,
            accurate_number: input.accurateNumber.trim(),
            previous_state: live.state,
            resulting_state: next, // D-14: state sebelum & sesudah tercatat
            previous_outcome: live.outcome,
        },
        updatedAt: sql`now()`,
    }).where(and(
        eq(accurateWriteAttempt.id, live.id),
        eq(accurateWriteAttempt.state, live.state),
        ...(needsStale ? [lt(accurateWriteAttempt.updatedAt, STALE_SQL)] : []),
    )).returning({ id: accurateWriteAttempt.id });
    if (rows.length) return { ok: true, attemptId: live.id, state: next };
    const again = await findLive(db, operation, subjectKey);
    return again?.id === live.id && again.state === live.state
        ? { ok: false, code: "in_flight", message: "attempt baru saja dikirim — Accurate mungkin masih memproses; tunggu 2 menit lalu periksa lagi", live }
        : { ok: false, code: "changed", message: "attempt berubah saat diselesaikan — muat ulang" };
}
