"use client";
/*
 * Tujuan: Error boundary untuk seluruh segmen dashboard — tangkap render error tak terduga
 *   agar user dapat halaman rapi + tombol "Coba lagi", bukan white screen / stack trace bocor.
 * Caller: Next.js App Router otomatis membungkus children app/(dashboard)/layout.tsx.
 * Dependensi: react (useEffect), @sentry/nextjs, lib/muat-ulang-versi, FioriScope + ErrorState Fiori (isi halaman tidak otomatis di dalam .fiori, sama seperti loading.tsx).
 * Main Functions: DashboardError.
 * Side Effects: console.error(error); galat "versi lama" (berkas build lama hilang sesudah deploy) = muat ulang halaman otomatis
 *   sekali; galat lain dikirim ke Sentry (sebelumnya galat segmen dashboard tidak pernah sampai Sentry). "Coba lagi" = muat ulang penuh.
 */
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { ErrorState } from "@/components/fiori/core";
import { FioriScope } from "@/components/fiori/Scope";
import { bolehMuatUlang, galatVersiLama } from "@/lib/muat-ulang-versi";

export default function DashboardError({
    error,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        // ponytail: log ke console untuk dev; JANGAN render error.message/stack ke UI (bisa bocor detail)
        console.error(error);
        if (galatVersiLama(error)) { if (bolehMuatUlang()) window.location.reload(); return; }
        Sentry.captureException(error);
    }, [error]);

    return (
        <FioriScope className="fi-page">
            <div className="fi-panel">
                <ErrorState title="Terjadi kesalahan saat memuat halaman"
                    message="Maaf, ada gangguan teknis. Coba muat ulang halaman. Jika tetap bermasalah, hubungi admin."
                    onRetry={() => window.location.reload()} />
            </div>
        </FioriScope>
    );
}
