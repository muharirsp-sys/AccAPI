/*
 * Tujuan: Satu tombol cetak. Dipisah karena window.print() butuh client component,
 *         sementara halaman cetaknya sengaja server component (query langsung, tanpa API).
 * Caller: app/(cetak)/**\/page.tsx
 * Side Effects: Membuka dialog cetak browser.
 */
"use client";

export default function TombolCetak() {
    return (
        <button onClick={() => window.print()}
            className="rounded-lg border border-slate-400 px-4 py-2 text-sm font-semibold">
            Cetak
        </button>
    );
}
