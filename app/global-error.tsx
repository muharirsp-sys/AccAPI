"use client";
/*
 * Tujuan: Root error boundary — jaring terakhir bila error terjadi di root layout/render.
 *   Wajib me-render <html>/<body> sendiri karena menggantikan root layout saat error fatal.
 *   Tampilkan pesan rapi, JANGAN bocorkan stack/digest ke UI.
 * Caller: Next.js App Router otomatis saat error tidak tertangkap error boundary segmen.
 * Dependensi: react (useEffect), @sentry/nextjs, lib/muat-ulang-versi; fiori.css + FioriScope + ErrorState
 *   (CSS root layout tidak ikut termuat di sini, jadi fiori.css diimpor sendiri; terang/gelap mengikuti setelan perangkat).
 * Main Functions: GlobalError.
 * Side Effects: console.error(error) dan pengiriman exception ke Sentry Cloud (instrumentation-client: tanpa userInfo/httpBodies;
 *   TANPA beforeSend — jangan taruh data pelanggan di pesan Error); galat "versi lama" = muat ulang
 *   otomatis sekali (tidak dikirim ke Sentry). "Coba lagi" = muat ulang penuh.
 */
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { ErrorState } from "@/components/fiori/core";
import { fioriClass } from "@/components/fiori/Scope";
import "./fiori.css";
import { bolehMuatUlang, galatVersiLama } from "@/lib/muat-ulang-versi";

export default function GlobalError({
    error,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error(error);
        if (galatVersiLama(error)) { if (bolehMuatUlang()) window.location.reload(); return; }
        Sentry.captureException(error);
    }, [error]);

    return (
        <html lang="id-ID">
            <body className={fioriClass} style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
                <main className="fi-panel" style={{ width: "min(100%, 32rem)" }}>
                    <ErrorState title="Aplikasi mengalami gangguan"
                        message="Maaf, terjadi kesalahan tak terduga. Silakan muat ulang. Jika tetap bermasalah, hubungi admin."
                        onRetry={() => window.location.reload()} />
                </main>
            </body>
        </html>
    );
}
