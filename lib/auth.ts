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
import * as schema from "../db/schema";
import { pool } from "./db";

import { sendEmail } from "./email";
import { defaultRole, roleAccess } from "./rbac";

// D4 cutover: PostgreSQL. Pool dipakai bersama lib/db.ts — pool kedua hanya menggandakan
// koneksi ke DB yang sama dan menggandakan peluang kehabisan slot.
const authDb = drizzle(pool, { schema });
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
    // S7-1 BL-62: plugin admin TIDAK boleh dipanggil dari browser (melewati grup, penjaga BL-61, dan audit); rute server
    // /api/admin/users/** menggantikannya. disabledPaths hanya menutup router HTTP (404, cocok persis); auth.api.* server-side
    // (POST /api/admin/users, bootstrap/route.ts) tetap jalan. Uji lib/admin-otorisasi-route.test.ts memeriksa SEMUA endpoint
    // /admin/* plugin tertutup — endpoint baru sesudah upgrade Better Auth membuat uji merah.
    disabledPaths: [
        "/admin/create-user", "/admin/set-user-password", "/admin/set-role", "/admin/ban-user", "/admin/unban-user",
        "/admin/remove-user", "/admin/list-users", "/admin/get-user", "/admin/update-user", "/admin/has-permission",
        "/admin/impersonate-user", "/admin/stop-impersonating", "/admin/list-user-sessions", "/admin/revoke-user-session",
        "/admin/revoke-user-sessions",
    ],
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
        // S7-1 (peninjau keamanan S7c): reset lewat tautan lupa sandi mencabut SEMUA sesi lama user itu (Better Auth 1.6.22
        // api/routes/password.mjs: deleteUserSessions sesudah sandi diganti). Atur sandi oleh admin mencabut sesi di route sendiri.
        revokeSessionsOnPasswordReset: true,
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
