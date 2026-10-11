/**
 * Tujuan: "Selesaikan" pelunasan TIDAK PASTI (S6e-2 butir 5, owner #7) — keputusan `terposting` (nomor Accurate wajib, harus
 *   ditemukan pencarian) atau `tidak_ada` (baris FAILED = boleh dikirim ulang), SESUDAH server mencari di Accurate. Tercatat di
 *   idempotency_resolution (siapa, kapan, database, sumber, alasan, nomor).
 * Caller: app/api/idempotency/resolve/route.ts (GET memakai bolehDiselesaikan; POST memakai selesaikanPelunasan).
 * Dependensi: idempotency_log ("databaseId" dari lock), idempotency_resolution (DDL_S6E2.sql), pencarian `cari` DIINJEKSI
 *   (route: periksaRiwayatAccurate + bacaAccurate dengan sesi pemanggil).
 * Bukti (orkestrator 11 Okt, tinjauan B1 / REV-B D): pencarian = pelunasan di grup pelanggan+tanggal yang MENYENTUH faktur mana
 *   pun dari baris (`mirip`, berapa pun nominal/potongan) — kiriman koreksi (nominal lain) atau potongan yang dibaca berbeda tidak
 *   boleh terbaca "tidak ada". `tidak_ada` hanya bila tidak ada satu pun; `terposting` = nomor salah satu kandidat itu.
 * Side Effects: satu transaksi — UPDATE idempotency_log (CAS status + updatedAt teramati) + INSERT idempotency_resolution.
 * Aturan (orkestrator 10 Okt): database lock NULL (baris sebelum S6e-2) -> `terposting` boleh (nomor ditemukan di database sesi),
 *   `tidak_ada` DITOLAK (database_unknown) — tanpa tahu database kiriman, "tidak ditemukan" bisa berarti terposting di database lain.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { idempotencyLog, idempotencyResolution } from "@/db/schema";
import { STALE_PROCESSING_MS } from "@/lib/idempotency-lock";
import type { StrukAccurate, TargetRiwayat } from "@/lib/pelunasan/pratinjau-ganda";

/** Umur minimum sebelum Selesaikan (pola Finance purchase-payment: 2 mnt). */
export const UMUR_SELESAIKAN_MS = 2 * 60 * 1000;

type BarisLog = { status: string; updatedAt: Date | null; createdAt: Date | null };
const umurMs = (r: BarisLog, now: Date) => {
    const t = (r.updatedAt ?? r.createdAt)?.getTime();
    return t === undefined ? null : now.getTime() - t;
};

/** UNKNOWN; SENDING >= 2 mnt (bukan kiriman yang sedang berjalan); PROCESSING > 15 mnt (basi lock). */
export function bolehDiselesaikan(r: BarisLog, now: Date): boolean {
    const umur = umurMs(r, now);
    if (r.status === "UNKNOWN") return true;
    if (r.status === "SENDING") return umur !== null && umur >= UMUR_SELESAIKAN_MS;
    if (r.status === "PROCESSING") return umur !== null && umur > STALE_PROCESSING_MS;
    return false;
}

/**
 * Target pencarian dari baris idempotency_log. Faktur = kolom invoiceNo (koreksi dijangkar lewat kolom ini) DAN segmen sidik jari
 * kunci (baris persis) — gabungan, lebih banyak menyentuh = lebih aman. Tanpa nominal: hanya `mirip`, tidak dicocokkan kasar.
 */
export function targetDariLog(r: { key: string; customerNo: string | null; transDate: string | null; invoiceNo: string | null }): TargetRiwayat {
    const kolom = `,${r.invoiceNo ?? ""},`;
    return {
        key: r.key, customerNo: String(r.customerNo ?? "").trim(), transDate: String(r.transDate ?? "").trim(), nominal: new Map(),
        menyentuh: (no) => kolom.includes(`,${no},`) || r.key.includes(`_${no}|`) || r.key.includes(`;${no}|`),
    };
}

/** Kandidat untuk UI/jawaban galat: nomor + faktur + nominal (Finance memilih `terposting` dari sini). */
export const nomorKandidat = (k: StrukAccurate[]) => [...new Set(k.map((s) => s.number).filter(Boolean))];
export type HasilCari = { mirip: Map<string, StrukAccurate[]>; gagal: Map<string, string> };

export type InputSelesaikan = { key: string; decision: "terposting" | "tidak_ada"; accurateNumber: string; reason: string; checkedSource: string };

/** Validasi murah SEBELUM DB/Accurate. Teks = 400. */
export function cekInputSelesaikan(b: Record<string, unknown> | null): string | InputSelesaikan {
    const t = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const key = t(b?.key);
    const decision = b?.decision === "terposting" || b?.decision === "tidak_ada" ? b.decision : null;
    if (!key || !decision) return "key dan decision (terposting | tidak_ada) wajib.";
    const reason = t(b?.reason).slice(0, 1000);
    if (reason.length < 15) return "Alasan wajib (minimal 15 karakter).";
    const checkedSource = t(b?.checkedSource).slice(0, 200);
    if (!checkedSource) return "checkedSource wajib (di mana pelunasan diperiksa).";
    const accurateNumber = t(b?.accurateNumber).slice(0, 100);
    if (decision === "terposting" && !accurateNumber) return "Keputusan terposting wajib nomor pelunasan Accurate.";
    return { key, decision, accurateNumber, reason, checkedSource };
}

type Hasil = { status: number; body: Record<string, unknown> };
const tolak = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Hasil =>
    ({ status, body: { ok: false, code, error, ...extra } });

export async function selesaikanPelunasan(db: NodePgDatabase, inp: InputSelesaikan & { actor: string; sessionDatabaseId: string },
    cari: (t: TargetRiwayat) => Promise<HasilCari>, now = new Date()): Promise<Hasil> {
    const [row] = await db.select().from(idempotencyLog).where(eq(idempotencyLog.key, inp.key)).limit(1);
    if (!row) return tolak(404, "not_found", "Baris pelunasan tidak ditemukan.");
    const tujuan = inp.decision === "terposting" ? "SUCCESS" : "FAILED";
    // Klik ganda / dua tab: keputusan yang sama sudah tercatat = sukses tanpa menulis.
    if (row.status === tujuan) return { status: 200, body: { ok: true, alreadyResolved: true, status: row.status } };
    if (!bolehDiselesaikan(row, now)) {
        return tolak(409, "not_eligible", `Baris berstatus ${row.status} — hanya Tidak pasti (UNKNOWN, atau kiriman macet ≥ 2 menit) yang bisa diselesaikan.`);
    }
    const umur = umurMs(row, now);
    if (inp.decision === "tidak_ada" && (umur === null || umur < UMUR_SELESAIKAN_MS)) {
        return tolak(409, "not_eligible", "Tunggu minimal 2 menit sejak kiriman terakhir sebelum menetapkan tidak ada.");
    }
    if (row.databaseId === null) {
        if (inp.decision === "tidak_ada") {
            return tolak(409, "database_unknown", "Database Accurate kiriman ini tidak tercatat (baris sebelum pembaruan). "
                + "\"Tidak ada\" di database yang terbuka bisa berarti sudah terposting di database lain — kirim ulang bisa dobel. "
                + "Tetapkan terposting bila ditemukan, atau pakai override Finance di tinjauan unggah.");
        }
    } else if (row.databaseId !== inp.sessionDatabaseId) {
        return tolak(409, "wrong_database", `Baris ini dikirim ke database ${row.databaseId}; buka database itu dulu lalu cari lagi.`,
            { lockDatabaseId: row.databaseId });
    }

    // Server MENCARI dulu: pelunasan pelanggan+tanggal yang menyentuh faktur baris (bukan sidik jari persis).
    const hasil = await cari(targetDariLog(row));
    const galat = hasil.gagal.get(row.key);
    if (galat !== undefined) return tolak(409, "search_failed", `Pencarian di Accurate gagal (${galat}) — tidak ada yang diubah; coba lagi.`);
    const candidates = hasil.mirip.get(row.key) ?? [];
    const nomor = nomorKandidat(candidates);
    if (inp.decision === "terposting" && !nomor.includes(inp.accurateNumber)) {
        return tolak(409, "number_mismatch", nomor.length
            ? `Nomor ${inp.accurateNumber} bukan pelunasan pelanggan+tanggal ini yang menyentuh faktur baris (${nomor.join(", ")}).`
            : `Tidak ada pelunasan pelanggan+tanggal ini yang menyentuh faktur baris — nomor ${inp.accurateNumber} tidak bisa dicocokkan.`,
        { receiptNumbers: nomor, candidates });
    }
    if (inp.decision === "tidak_ada" && candidates.length) {
        return tolak(409, "similar_found", `Ada pelunasan di Accurate untuk pelanggan+tanggal ini yang menyentuh faktur baris (${nomor.join(", ") || "tanpa nomor"})`
            + " — periksa nominalnya; bila itu kiriman ini, tetapkan terposting. \"Tidak ada\" ditolak.", { receiptNumbers: nomor, candidates });
    }

    const id = randomUUID();
    let berubah = true;
    await db.transaction(async (tx) => {
        // CAS status + updatedAt teramati (pola takeover lock): kiriman/keputusan lain di antaranya = tidak menimpa.
        const r = await tx.update(idempotencyLog).set({ status: tujuan, updatedAt: now })
            .where(and(eq(idempotencyLog.key, row.key), eq(idempotencyLog.status, row.status),
                sql`date_trunc('milliseconds', ${idempotencyLog.updatedAt}) IS NOT DISTINCT FROM ${row.updatedAt ? row.updatedAt.toISOString() : null}::timestamp`))
            .returning({ key: idempotencyLog.key });
        if (!r.length) { berubah = false; tx.rollback(); }
        await tx.insert(idempotencyResolution).values({
            id, key: row.key, lockId: row.lockId, previousStatus: row.status, decision: inp.decision,
            accurateNumber: inp.decision === "terposting" ? inp.accurateNumber : null, databaseId: inp.sessionDatabaseId,
            checkedSource: inp.checkedSource, reason: inp.reason, actor: inp.actor,
        });
    }).catch((e: unknown) => { if (!(e instanceof TransactionRollbackError)) throw e; });
    if (!berubah) return tolak(409, "changed", "Status baris berubah saat diselesaikan — muat ulang lalu periksa lagi.");
    return { status: 200, body: { ok: true, status: tujuan, resolutionId: id, receiptNumbers: nomor } };
}
