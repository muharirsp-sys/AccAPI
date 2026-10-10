/**
 * Tujuan: keputusan murni layar Finance untuk posting purchase-payment (tinjauan S6-0a): teks status C11, tab yang
 *   kalah klaim, dan "pasti belum terkirim". Aman untuk klien (tanpa DB/crypto).
 * Caller: app/(dashboard)/finance/posting.ts, lib/finance-ui.ts.
 * Side Effects: tidak ada.
 */

/** Pesan Accurate dari teks klasifikasi server (`Accurate menolak …: ["a","b"]`) -> "a; b". */
function accurateText(raw: string): string {
    try {
        const v = JSON.parse(raw) as unknown;
        if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ");
        if (typeof v === "string") return v;
    } catch { /* bukan JSON: pakai apa adanya */ }
    return raw.trim();
}

/**
 * Teks status posting di layar Finance. C11: penolakan Accurate = TIDAK PASTI — ditampilkan "Accurate menolak: …",
 * dibedakan dari tanpa jawaban (timeout/jaringan) dan dari status lama "gagal" yang galatnya ambigu (`rawStatus`).
 */
export function postStatusNote(status: string, error: string, rawStatus = status): string {
    if (status === "unknown") {
        const rejected = /^Accurate menolak[^:]*:\s*([\s\S]*)$/.exec(error.trim());
        if (rejected) {
            return `Accurate menolak: ${accurateText(rejected[1])} — status TIDAK PASTI (belum terbukti tidak tersimpan); cek purchase-payment di Accurate lalu selesaikan.`;
        }
        if (rawStatus === "failed") {
            return `TIDAK PASTI — tercatat "gagal" sebelum pembaruan, tetapi galatnya ambigu (${error || "tanpa pesan"}); cek purchase-payment sebelum posting ulang.`;
        }
        return `TIDAK PASTI — tanpa jawaban pasti dari Accurate${error ? ` (${error})` : ""}; cek purchase-payment sebelum posting ulang.`;
    }
    return status === "failed" ? `Post gagal: ${error}` : "";
}

type Conflict = {
    code?: string;
    live?: { state?: string; sameRecord?: boolean; sameTarget?: boolean; stale?: boolean } | null;
    generation?: number;
    currentGeneration?: number;
} | null | undefined;

/**
 * 409 dari command purchase-payment. `posted` = attempt record INI di database INI generasi terkini sudah posted
 * (rekonsiliasi); `in_flight` = record ini sedang diposting sesi/tab lain (attempt 'sending' SEGAR) — JANGAN menulis
 * apa pun ke ledger (hasilnya dicatat sesi itu); selain itu tidak pasti — termasuk 'sending' BASI (proses mati setelah
 * klaim, tinjauan N1): ledger ditulis unknown agar Finance bisa menyelesaikannya.
 */
export function purchasePaymentConflict(out: Conflict): "posted" | "in_flight" | "unknown" {
    const live = out?.live;
    if (live?.state === "sending" && live.sameRecord && !live.stale) return "in_flight";
    if (live?.state === "posted" && live.sameRecord && live.sameTarget && out?.generation === out?.currentGeneration) return "posted";
    return "unknown";
}

/** Command menolak SEBELUM klaim (validasi/izin/sesi, atau `claimed:false`) = pasti belum terkirim ke Accurate. */
export function certainlyNotSent(status: number, out: { claimed?: unknown; error?: unknown; live?: unknown } | null | undefined): boolean {
    if (out?.claimed === false) return true;
    return status >= 400 && status < 500 && status !== 409;
}

/**
 * Kode 409 command yang DIJAMIN ditolak sebelum klaim attempt (tidak ada yang dikirim ke Accurate). Daftar eksplisit: 409 lain
 * (konflik attempt, kode baru kelak) = tidak pasti — meski membawa claimed:false (tinjauan putaran 2 A).
 */
const KODE_409_TIDAK_TERKIRIM = new Set(["database_changed", "reopened_use_repost"]);

/** 409 yang pasti belum terkirim: claimed:false DAN kode terdaftar di KODE_409_TIDAK_TERKIRIM. */
export function conflictNotSent(status: number, out: { claimed?: unknown; code?: unknown } | null | undefined): boolean {
    return status === 409 && out?.claimed === false && KODE_409_TIDAK_TERKIRIM.has(String(out.code ?? ""));
}
