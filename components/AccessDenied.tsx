/*
 * Tujuan: Pesan "Akses ditolak" eksplisit pengganti redirect senyap ke "/".
 * Caller: app/(dashboard)/layout.tsx (guard path), SidebarLayout (gerbang klien), admin/groups, admin/users, laporan-sales (guard permission).
 * Dependensi: next/link, lucide-react, FioriScope + kelas fi-* (pola ErrorState).
 * Main Functions: AccessDenied.
 * Side Effects: Tidak ada.
 */
import Link from "next/link";
import { House, LockKeyhole } from "lucide-react";
import { FioriScope } from "@/components/fiori/Scope";

// Kunci izin mentah ("users.manage") di dalam kurung pesan pemanggil: dipindah ke title, bukan kalimat yang dibaca semua orang.
const KUNCI = /\s*\(([a-z_]+\.[a-z_]+)\)/g;

export default function AccessDenied({
    message = "Anda tidak memiliki izin untuk membuka halaman ini.",
}: {
    message?: string;
}) {
    const kunci = [...message.matchAll(KUNCI)].map((m) => m[1]);
    return (
        <FioriScope className="fi-page">
            <div className="fi-state" role="alert">
                <span className="fi-state-ico" aria-hidden><LockKeyhole className="fi-icon" /></span>
                <h1 className="fi-title-2">Akses ditolak</h1>
                <p title={kunci.length ? `Izin: ${kunci.join(", ")}` : undefined}>{message.replace(KUNCI, "")}</p>
                <p>Hubungi admin bila Anda merasa seharusnya punya akses.</p>
                <Link href="/" className="fi-btn fi-btn--secondary"><House className="fi-icon" aria-hidden />Ke Beranda</Link>
            </div>
        </FioriScope>
    );
}
