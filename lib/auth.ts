import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db";
import * as schema from "../db/schema";

import { sendEmail } from "./email";

export const auth = betterAuth({
    database: drizzleAdapter(db, {
        provider: "sqlite",
        schema: {
            ...schema
        }
    }),
    socialProviders: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID as string,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
        }
    },
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        minPasswordLength: 6,
        sendResetPassword: async ({ user, url, token }) => {
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
        sendVerificationEmail: async ({ user, url, token }) => {
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
