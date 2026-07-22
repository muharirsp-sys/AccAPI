import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accurateOAuthSession } from "@/db/schema";

const ALGORITHM = "aes-256-gcm";

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

async function ensureAccurateSessionTable() {
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS accurate_oauth_session (
            user_id TEXT PRIMARY KEY NOT NULL,
            access_token TEXT NOT NULL,
            session_host TEXT,
            session_id TEXT,
            database_id TEXT,
            database_alias TEXT,
            created_at TIMESTAMP NOT NULL,
            updated_at TIMESTAMP NOT NULL,
            FOREIGN KEY (user_id) REFERENCES "user"(id)
        )
    `);
}

export async function getAccurateSession(userId: string) {
    await ensureAccurateSessionTable();
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
    await ensureAccurateSessionTable();
    const existing = await getAccurateSession(userId);
    const now = new Date();

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

export async function clearAccurateSession(userId: string) {
    await ensureAccurateSessionTable();
    await db.delete(accurateOAuthSession).where(eq(accurateOAuthSession.userId, userId));
}
