/** Tujuan: Sesi OAuth Accurate terenkripsi beserta identitas database untuk sync/realisasi.
 * Caller: API Accurate, cron, webhook. Dependensi: crypto, Drizzle, session table.
 * Main Functions: getAccurateSession, upsertAccurateSession, resolveSyncCredentials, ensureFreshAccurateSession, periksaToken,
 *   peringatanKredensialSistem.
 * Side Effects: PostgreSQL dan HTTP pembaruan sesi; tidak menulis dokumen bisnis.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accurateOAuthSession, user } from "@/db/schema";
import type { AccurateCredentials } from "@/lib/sync";
import { PESAN_TOKEN_MATI, TokenAccurateMati } from "@/lib/accurate-401";

const ALGORITHM = "aes-256-gcm";

/** Peringatan kredensial sistem (peringatanKredensialSistem). ponytail: cache per proses 5 menit (satu server Next.js);
 *  masuk ulang mengosongkannya (upsertAccurateSession). */
let cekSistem: { sampai: number; hasil: Promise<string | null> } | null = null;

type AccurateSessionUpdate = {
    accessToken?: string;
    sessionHost?: string | null;
    sessionId?: string | null;
    databaseId?: string | null;
    databaseAlias?: string | null;
};

function encryptionKey() {
    const secret = process.env.ACCURATE_TOKEN_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET;
    if (!secret) {
        throw new Error("Server token encryption key is not configured.");
    }
    return createHash("sha256").update(secret).digest();
}

function encryptSecret(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptSecret(value: string) {
    const [ivText, tagText, encryptedText] = value.split(".");
    if (!ivText || !tagText || !encryptedText) {
        throw new Error("Stored Accurate credential is invalid.");
    }
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedText, "base64")),
        decipher.final(),
    ]);
    return decrypted.toString("utf8");
}

// DDL runtime (CREATE TABLE IF NOT EXISTS) DIHAPUS: role aplikasi `accapi_app` sengaja
// bukan owner dan tidak punya hak CREATE di schema public (runbook L1g, handover11).
// Akibatnya DDL itu melempar "permission denied for schema public" pada SETIAP panggilan
// dan mematikan fitur yang tabelnya sebenarnya sudah ada. Skema dikelola lewat db/schema.ts + DDL manual.

export async function getAccurateSession(userId: string) {
    const [row] = await db
        .select()
        .from(accurateOAuthSession)
        .where(eq(accurateOAuthSession.userId, userId))
        .limit(1);

    if (!row) return null;

    return {
        userId: row.userId,
        accessToken: decryptSecret(row.accessToken),
        sessionHost: row.sessionHost,
        sessionId: row.sessionId ? decryptSecret(row.sessionId) : null,
        databaseId: row.databaseId,
        databaseAlias: row.databaseAlias,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export async function upsertAccurateSession(userId: string, update: AccurateSessionUpdate) {
    // Baris lama yang TIDAK BISA didekripsi tidak boleh memblokir login ulang.
    // Insiden produksi 2026-09-08: kunci enkripsi berubah, seluruh sync mati, dan setiap
    // percobaan login ulang gagal dengan "Unsupported state or unable to authenticate data"
    // — karena baris usang itu dibaca DI SINI sebelum token baru sempat ditulis. Jadi
    // satu-satunya jalan pemulihan justru terhalang oleh kerusakan yang mau diperbaiki.
    // Selama pemanggil membawa access token baru, baris lama memang akan ditimpa seluruhnya.
    let existing: Awaited<ReturnType<typeof getAccurateSession>> = null;
    try {
        existing = await getAccurateSession(userId);
    } catch (error) {
        if (!update.accessToken) throw error; // tanpa token baru, tidak ada yang bisa dipulihkan
        console.warn(`[accurate-session] sesi lama user ${userId} tidak dapat didekripsi; ditimpa oleh login baru:`,
            error instanceof Error ? error.message : String(error));
        // Baris tetap ada, jadi cabang UPDATE di bawah yang dipakai — bukan INSERT (kena unique).
        const [stale] = await db.select({ createdAt: accurateOAuthSession.createdAt })
            .from(accurateOAuthSession).where(eq(accurateOAuthSession.userId, userId)).limit(1);
        existing = stale ? ({ createdAt: stale.createdAt } as Awaited<ReturnType<typeof getAccurateSession>>) : null;
    }
    const now = new Date();
    if (update.accessToken) cekSistem = null; // masuk ulang: peringatan beranda admin dihitung ulang, tidak menunggu 5 menit

    const nextAccessToken = update.accessToken ?? existing?.accessToken;
    if (!nextAccessToken) {
        throw new Error("Accurate access token is required.");
    }

    const values = {
        userId,
        accessToken: encryptSecret(nextAccessToken),
        sessionHost: update.sessionHost !== undefined ? update.sessionHost : existing?.sessionHost ?? null,
        sessionId: update.sessionId !== undefined
            ? update.sessionId ? encryptSecret(update.sessionId) : null
            : existing?.sessionId ? encryptSecret(existing.sessionId) : null,
        databaseId: update.databaseId !== undefined ? update.databaseId : existing?.databaseId ?? null,
        databaseAlias: update.databaseAlias !== undefined ? update.databaseAlias : existing?.databaseAlias ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };

    if (existing) {
        await db
            .update(accurateOAuthSession)
            .set(values)
            .where(eq(accurateOAuthSession.userId, userId));
    } else {
        await db.insert(accurateOAuthSession).values(values);
    }
}

/**
 * Fallback identitas proses non-interaktif: sesi TERBARU milik admin, bukan sesi terbaru siapa
 * saja. Hak baca cron = hak akun Accurate pemilik sesi. Insiden 2026-09-19: fakturist (viewer)
 * menghubungkan akun Accurate-nya sendiri, cron ikut memakainya, lalu retur/barang/karyawan
 * ditolak "tidak memiliki hak" dan faktur tinggal yang boleh dilihat akun itu — enam hari tanpa suara.
 * `sessions` wajib sudah urut updatedAt menurun.
 */
export function pickSyncUserId(sessions: Array<{ userId: string; role: string | null }>) {
    return sessions.find((s) => s.role === "admin")?.userId ?? "";
}

/** userId identitas proses non-interaktif: ACCURATE_SYNC_USER_ID, fallback sesi OAuth terbaru milik admin ("" = tidak ada). */
async function syncUserId() {
    const dariEnv = (process.env.ACCURATE_SYNC_USER_ID || "").trim();
    if (dariEnv) return dariEnv;
    const sessions = await db.select({ userId: accurateOAuthSession.userId, role: user.role })
        .from(accurateOAuthSession)
        .innerJoin(user, eq(user.id, accurateOAuthSession.userId))
        .orderBy(desc(accurateOAuthSession.updatedAt));
    return pickSyncUserId(sessions);
}

/**
 * Kredensial Accurate untuk proses non-interaktif (cron sync, webhook) — tidak ada user
 * yang sedang login saat kode ini jalan. userId dari ACCURATE_SYNC_USER_ID, fallback sesi
 * OAuth terbaru milik admin. Mengembalikan { error } (bukan throw) supaya caller bisa memilih HTTP status.
 * `creds.segarkanSesi` membuka ulang X-Session-ID saat pembaca (lib/sync fetchAccurate) mendapat 401 sesi habis; panggilan
 * paralel berbagi satu open-db.do.
 */
export async function resolveSyncCredentials(): Promise<
    { creds: AccurateCredentials; error?: undefined } | { creds?: undefined; error: string }
> {
    const userId = await syncUserId();
    if (!userId) return { error: "Tidak ada sesi Accurate milik admin. Set ACCURATE_SYNC_USER_ID atau login Accurate sebagai admin di /sesi-accurate." };

    let session = await getAccurateSession(userId);
    if (!session?.accessToken) return { error: "Tidak ada access token Accurate. Login ulang di /sesi-accurate." };
    // X-Session-ID berumur pendek dan habis independen dari access token.
    try {
        if (!session.sessionHost || !session.sessionId) session = await ensureFreshAccurateSession(userId);
    } catch (e) {
        if (e instanceof TokenAccurateMati) return { error: PESAN_TOKEN_MATI };
        throw e;
    }
    if (!session?.sessionHost || !session.sessionId || !session.accessToken) {
        return { error: "Sesi Accurate tidak bisa di-refresh: access token kemungkinan sudah kadaluarsa. Login ulang di /sesi-accurate." };
    }

    const keKredensial = (s: NonNullable<typeof session>): AccurateCredentials | null => (s.sessionHost && s.sessionId
        ? { sessionHost: s.sessionHost, sessionId: s.sessionId, apiKey: s.accessToken, databaseId: String(s.databaseId ?? "") }
        : null);
    let segar: Promise<AccurateCredentials | null> | null = null;
    const segarkanSesi = () => (segar ??= ensureFreshAccurateSession(userId)
        .then((s) => (s ? keKredensial(s) : null))
        .finally(() => { segar = null; }));
    return { creds: { ...keKredensial(session)!, segarkanSesi } };
}

export async function clearAccurateSession(userId: string) {
    await db.delete(accurateOAuthSession).where(eq(accurateOAuthSession.userId, userId));
}

/**
 * X-Session-ID Accurate berumur pendek dan habis independen dari access token. Dulu ini hanya
 * diisi lewat UI /api-wrapper (pilih database) — begitu login ulang me-null-kan session lama,
 * cron sync berhenti total sampai ada orang membuka UI itu. Fungsi ini menutup celah tsb:
 * refresh via open-db.do (kalau databaseId sudah tersimpan) atau db-list.do (ambil DB pertama
 * kalau belum pernah dipilih sama sekali). 401 di lapis akun = access token mati -> TokenAccurateMati (bukan null), supaya
 * pemanggil bisa menyuruh masuk ulang alih-alih "coba lagi".
 */
export async function ensureFreshAccurateSession(userId: string) {
    const session = await getAccurateSession(userId);
    if (!session?.accessToken) return null;

    let databaseId = session.databaseId;
    let databaseAlias = session.databaseAlias;

    if (!databaseId) {
        const listRes = await fetch("https://account.accurate.id/api/db-list.do", {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            signal: AbortSignal.timeout(30_000),
        });
        if (listRes.status === 401) throw new TokenAccurateMati();
        const listBody = await listRes.json().catch(() => null) as { s?: boolean; d?: Array<{ id: string; alias: string }> } | null;
        const first = listBody?.d?.[0];
        if (!listRes.ok || !listBody?.s || !first) return null;
        databaseId = first.id;
        databaseAlias = first.alias;
    }

    const openRes = await fetch(`https://account.accurate.id/api/open-db.do?id=${databaseId}`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        signal: AbortSignal.timeout(30_000),
    });
    if (openRes.status === 401) throw new TokenAccurateMati();
    const openBody = await openRes.json().catch(() => null) as { host?: string; session?: string } | null;
    if (!openRes.ok || !openBody?.host || !openBody?.session) return null;

    await upsertAccurateSession(userId, {
        sessionHost: openBody.host,
        sessionId: openBody.session,
        databaseId,
        databaseAlias,
    });

    return {
        ...session,
        sessionHost: openBody.host,
        sessionId: openBody.session,
        databaseId,
        databaseAlias,
    };
}

/**
 * Periksa access token dengan panggilan baca murah di lapis akun (db-list.do, tanpa X-Session-ID). true = hidup, false = mati
 * (401 di lapis akun hanya bisa berarti token), null = tidak terperiksa (jaringan, 5xx, bentuk lain) — jangan dianggap mati.
 */
export async function periksaToken(accessToken: string, timeoutMs = 8_000): Promise<boolean | null> {
    try {
        const res = await fetch("https://account.accurate.id/api/db-list.do", {
            headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401) return false;
        const body = res.ok ? await res.json().catch(() => null) as { s?: unknown } | null : null;
        return body?.s === true ? true : null;
    } catch {
        return null;
    }
}

/**
 * Peringatan beranda admin (insiden 22 Nov 2026): kredensial sistem (cron sync, webhook, stok live, detail faktur) mati.
 * null = sehat atau tidak terperiksa; galat DB/jaringan tidak memunculkan peringatan palsu.
 */
export function peringatanKredensialSistem(): Promise<string | null> {
    if (!cekSistem || cekSistem.sampai < Date.now()) {
        cekSistem = { sampai: Date.now() + 5 * 60_000, hasil: hitungPeringatanSistem() };
    }
    return cekSistem.hasil;
}

async function hitungPeringatanSistem(): Promise<string | null> {
    const AKIBAT = "Sampai itu, sinkron data, webhook faktur, stok terkini, dan detail faktur dari Accurate berhenti.";
    try {
        const userId = await syncUserId();
        if (!userId) return `Belum ada sesi Accurate milik admin. Masuk Accurate sebagai admin di /sesi-accurate. ${AKIBAT}`;
        const session = await getAccurateSession(userId);
        if (!session?.accessToken) return `Sesi Accurate sistem kosong. Masuk ulang Accurate di /sesi-accurate. ${AKIBAT}`;
        return (await periksaToken(session.accessToken, 5_000)) === false ? `${PESAN_TOKEN_MATI} ${AKIBAT}` : null;
    } catch (e) {
        console.warn("[accurate-session] peringatan kredensial sistem tidak terperiksa:", e instanceof Error ? e.name : typeof e);
        return null;
    }
}
