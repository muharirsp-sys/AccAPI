"use client";
/*
 * Tujuan: Root error boundary — jaring terakhir bila error terjadi di root layout/render.
 *   Wajib me-render <html>/<body> sendiri karena menggantikan root layout saat error fatal.
 *   Tampilkan pesan rapi, JANGAN bocorkan stack/digest ke UI.
 * Caller: Next.js App Router otomatis saat error tidak tertangkap error boundary segmen.
 * Dependensi: react (useEffect) dan @sentry/nextjs.
 * Main Functions: GlobalError.
 * Side Effects: console.error(error) dan pengiriman exception ter-sanitasi ke Sentry Cloud.
 */
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error(error);
        Sentry.captureException(error);
    }, [error]);

    return (
        <html lang="id">
            <body style={{ margin: 0, background: "#0f1115", color: "#e2e8f0", fontFamily: "system-ui, sans-serif" }}>
                <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24, textAlign: "center" }}>
                    <div style={{ fontSize: 48 }}>⚠️</div>
                    <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Aplikasi mengalami gangguan</h2>
                    <p style={{ maxWidth: 420, fontSize: 14, color: "#94a3b8", margin: 0 }}>
                        Maaf, terjadi kesalahan tak terduga. Silakan muat ulang. Jika tetap bermasalah, hubungi admin.
                    </p>
                    <button
                        onClick={reset}
                        style={{ marginTop: 8, borderRadius: 8, border: "none", background: "#f59e0b", color: "#000", padding: "8px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                    >
                        Coba lagi
                    </button>
                </div>
            </body>
        </html>
    );
}
