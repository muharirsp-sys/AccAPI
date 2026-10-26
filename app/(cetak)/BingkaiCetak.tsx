/*
 * Tujuan: Bingkai Fiori di LAYAR pratinjau cetak (bilah atas: judul + nomor wave, Kembali ke wave, Cetak). Dipisah karena
 *         window.print() dan pembacaan rute butuh client component, sementara halaman cetaknya sengaja server component.
 *         Dipasang di layout dalam FioriScope ber-kelas `layar-saja`: `@media print` menyembunyikannya (display:none), jadi kertas
 *         tidak berubah sama sekali.
 * Caller: app/(cetak)/layout.tsx; WaveTidakAda dipakai halaman cetak saat wave tidak ada.
 * Side Effects: Membuka dialog cetak browser.
 */
"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ArrowLeft, Printer } from "lucide-react";
import { Button, EmptyState } from "@/components/fiori/core";
import { FioriScope } from "@/components/fiori/Scope";

export default function BingkaiCetak() {
    const { id } = useParams<{ id?: string }>();
    const jalur = usePathname();
    const judul = jalur.endsWith("/ttf") ? "Tanda Terima Faktur" : jalur.endsWith("/cetak-semua") ? "Cetak semua rekapan dan TTF" : "Lembar picking";
    return (
        <header className="bingkai-cetak">
            <Link className="fi-btn fi-btn--secondary" href={id ? `/rekapan-nota/wave/${id}` : "/rekapan-nota"}>
                <ArrowLeft className="fi-icon" aria-hidden />Kembali ke wave
            </Link>
            <h1>{judul}{id && <span> · Wave #{id}</span>}</h1>
            <Button variant="primary" icon={<Printer className="fi-icon" aria-hidden />} onClick={() => window.print()}>Cetak</Button>
        </header>
    );
}

/** Keadaan "wave tidak ditemukan" untuk halaman cetak (server): penjelasan + jalan kembali, bukan satu baris teks polos. */
export function WaveTidakAda() {
    return (
        <FioriScope className="layar-saja">
            <EmptyState title="Wave tidak ditemukan" message="Wave ini mungkin sudah dihapus atau nomornya salah. Kembali ke Rekapan Nota, lalu buka wave dari daftar."
                action={<Link className="fi-btn fi-btn--secondary" href="/rekapan-nota"><ArrowLeft className="fi-icon" aria-hidden />Kembali ke Rekapan Nota</Link>} />
        </FioriScope>
    );
}
