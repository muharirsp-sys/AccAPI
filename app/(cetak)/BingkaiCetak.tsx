/*
 * Tujuan: Bingkai Fiori di LAYAR pratinjau cetak (bilah atas: judul + nomor wave, Kembali ke wave, Cetak). Dipisah karena
 *         window.print() dan pembacaan rute butuh client component, sementara halaman cetaknya sengaja server component.
 *         Dipasang di layout dalam FioriScope ber-kelas `layar-saja`: `@media print` menyembunyikannya (display:none), jadi kertas
 *         tidak berubah sama sekali.
 * Caller: app/(cetak)/layout.tsx
 * Side Effects: Membuka dialog cetak browser.
 */
"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/fiori/core";

export default function BingkaiCetak() {
    const { id } = useParams<{ id?: string }>();
    const ttf = usePathname().endsWith("/ttf");
    return (
        <header className="bingkai-cetak">
            <Link className="fi-btn fi-btn--secondary" href={id ? `/rekapan-nota/wave/${id}` : "/rekapan-nota"}>
                <ArrowLeft className="fi-icon" aria-hidden />Kembali ke wave
            </Link>
            <h1>{ttf ? "Tanda Terima Faktur" : "Lembar picking"}{id && <span> · Wave #{id}</span>}</h1>
            <Button variant="primary" icon={<Printer className="fi-icon" aria-hidden />} onClick={() => window.print()}>Cetak</Button>
        </header>
    );
}
