/*
 * Tujuan: Konfigurasi Better Auth server untuk email/password internal, admin RBAC, trusted origin lokal, dan adapter SQLite.
 * Caller: `app/api/auth/[...all]/route.ts`, dashboard layout, dan server-side auth checks.
 * Dependensi: Better Auth, Drizzle adapter, SQLite schema, email service, dan RBAC role access.
 * Main Functions: `auth`.
 * Side Effects: DB read/write auth ke SQLite dan pengiriman email reset/verifikasi saat flow terkait dipanggil.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import * as schema from "../db/schema";

import { sendEmail } from "./email";
import { defaultRole, roleAccess } from "./rbac";

const databaseUrl = process.env.DATABASE_URL || "file:sqlite.db";
const databaseFile = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : null;
if (databaseFile?.startsWith("/")) {
    mkdirSync(databaseFile.replace(/\/[^/]*$/, ""), { recursive: true });
}
const authDb = drizzle(createClient({ url: databaseUrl }), { schema });
const baseURL = process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const trustedOrigins = Array.from(new Set([
    baseURL,
    process.env.NEXT_PUBLIC_APP_URL,
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://localhost:3003",
    "http://localhost:3004",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    "http://127.0.0.1:3003",
    "http://127.0.0.1:3004",
].filter(Boolean) as string[]));

export const auth = betterAuth({
    baseURL,
    trustedOrigins,
    database: drizzleAdapter(authDb, {
        provider: "sqlite",
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
