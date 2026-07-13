/*
 * Tujuan: Konfigurasi Better Auth server untuk email/password internal, admin RBAC, trusted origin lokal, dan adapter PostgreSQL.
 * Caller: `app/api/auth/[...all]/route.ts`, dashboard layout, dan server-side auth checks.
 * Dependensi: Better Auth, Drizzle adapter, schema PostgreSQL, email service, dan RBAC role access.
 * Main Functions: `auth`.
 * Side Effects: DB read/write auth ke PostgreSQL dan pengiriman email reset/verifikasi saat flow terkait dipanggil.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../db/schema";

import { sendEmail } from "./email";
import { defaultRole, roleAccess } from "./rbac";

// D4 cutover: PostgreSQL (pool terpisah dari lib/db.ts, paritas dengan struktur lama).
const authDb = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }), { schema });
const baseURL = process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

function isAllowedTrustedOrigin(origin: string) {
    try {
        const parsed = new URL(origin);
        const isLocal = ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname);
        return !isLocal || parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

const trustedOrigins = Array.from(new Set([
    baseURL,
    process.env.NEXT_PUBLIC_APP_URL,
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
].filter((origin): origin is string => typeof origin === "string" && isAllowedTrustedOrigin(origin))));

export const auth = betterAuth({
    baseURL,
    trustedOrigins,
    rateLimit: {
        // ponytail: explicit — don't rely on NODE_ENV inference; custom rule gentler than
        // the 3/10s default while still blocking brute force (5 per 15 min per IP)
        enabled: true,
        storage: "memory",
        customRules: {
            "/sign-in/email": { window: 900, max: 5 },
        },
    },
    advanced: {
        // Coolify uses Traefik — read real client IP from forwarded headers
        ipAddress: {
            ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
        },
    },
    database: drizzleAdapter(authDb, {
        provider: "pg",
        schema: {
            ...schema
        }
    }),
    plugins: [
        admin({
            defaultRole,
            adminRoles: ["admin"],
            roles: roleAccess,
        }),
    ],
    emailAndPassword: {
        enabled: true,
        disableSignUp: true,
        requireEmailVerification: true,
        minPasswordLength: 6,
        sendResetPassword: async ({ user, url }) => {
            void sendEmail({
                to: user.email,
                subject: "Reset Password Akses ERP Anda",
                text: `Seseorang meminta reset password akun Anda.\n\nSilakan klik tautan berikut untuk mengubah password Anda (Berlaku 1 jam):\n${url}`,
                html: `<div style="font-family: sans-serif; padding: 20px; color: #333;">
                    <h2>Permintaan Reset Password</h2>
                    <p>Merespons permintaan lupa password terkait akun <strong>${user.email}</strong>, Anda dapat mengatur ulang kredensial melalui tautan di bawah ini:</p>
                    <a href="${url}" style="display: inline-block; padding: 10px 20px; background-color: #4f46e5; color: white; text-decoration: none; border-radius: 5px; margin: 15px 0;">Reset Password Sekarang</a>
                    <p>Jika Anda tidak pernah meminta ini, harap abaikan pesan ini.</p>
                </div>`
            });
        },
    },
    emailVerification: {
        sendVerificationEmail: async ({ user, url }) => {
            void sendEmail({
                to: user.email,
                subject: "Verifikasi Pendaftaran Akun ERP ERP CV. Surya Perkasa",
                text: `Terima kasih telah mendaftar!\n\nMohon lakukan verifikasi email dengan mengklik tautan berikut (Berlaku 24 jam):\n${url}`,
                html: `<div style="font-family: sans-serif; padding: 20px; color: #333;">
                    <h2>Satu Langkah Lagi...</h2>
                    <p>Terima kasih telah bergabung. Untuk memastikan keamanan, kami perlu memverifikasi kepemilikan alamat email ini.</p>
                    <a href="${url}" style="display: inline-block; padding: 10px 20px; background-color: #10b981; color: white; text-decoration: none; border-radius: 5px; margin: 15px 0;">Verifikasi Email Saya</a>
                    <p>Tautan ini hanya akan aktif dalam waktu sementara.</p>
                </div>`
            });
        },
    },
});
