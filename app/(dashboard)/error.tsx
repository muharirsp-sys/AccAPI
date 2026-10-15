"use client";
/*
 * Tujuan: Error boundary untuk seluruh segmen dashboard — tangkap render error tak terduga
 *   agar user dapat halaman rapi + tombol "Coba lagi", bukan white screen / stack trace bocor.
 * Caller: Next.js App Router otomatis membungkus children app/(dashboard)/layout.tsx.
 * Dependensi: react (useEffect), @sentry/nextjs, lib/muat-ulang-versi.
 * Main Functions: DashboardError.
 * Side Effects: console.error(error); galat "versi lama" (berkas build lama hilang sesudah deploy) = muat ulang halaman otomatis
 *   sekali; galat lain dikirim ke Sentry (sebelumnya galat segmen dashboard tidak pernah sampai Sentry). "Coba lagi" = muat ulang penuh.
 */
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
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
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
            <div className="text-5xl">⚠️</div>
            <h2 className="text-xl font-bold text-white">Terjadi kesalahan saat memuat halaman</h2>
            <p className="max-w-md text-sm text-slate-400">
                Maaf, ada gangguan teknis. Coba muat ulang halaman. Jika tetap bermasalah, hubungi admin.
            </p>
            <button
                onClick={() => window.location.reload()}
                className="mt-2 rounded-lg bg-amber-500 px-5 py-2 text-sm font-semibold text-black transition hover:bg-amber-400"
            >
                Coba lagi
            </button>
        </div>
    );
}
