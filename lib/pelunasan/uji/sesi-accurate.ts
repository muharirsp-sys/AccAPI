/**
 * Tujuan: baris `accurate_oauth_session` TIRUAN untuk uji route S6e-2 (token terenkripsi dengan kunci uji, host diizinkan,
 *   database DB-1) — tanpa DB/jaringan.
 * Caller: lib/pelunasan-server-route.test.ts, lib/pelunasan-server-pg.test.ts.
 * Side Effects: menyetel ACCURATE_TOKEN_ENCRYPTION_KEY proses uji (format = encryptSecret di lib/accurate-session.ts).
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";

process.env.ACCURATE_TOKEN_ENCRYPTION_KEY = "kunci-uji-s6e2a";
const enc = (v: string) => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", createHash("sha256").update(process.env.ACCURATE_TOKEN_ENCRYPTION_KEY!).digest(), iv);
    const e = Buffer.concat([c.update(v, "utf8"), c.final()]);
    return `${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${e.toString("base64")}`;
};

export const sesiAccurate = (over: Record<string, unknown> = {}) => ({
    userId: "u-p", accessToken: enc("tok"), sessionHost: "https://public.accurate.id", sessionId: enc("sid"),
    databaseId: "DB-1", databaseAlias: "PT A", createdAt: new Date(), updatedAt: new Date(), ...over,
});
