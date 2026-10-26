/*
 * Tujuan: Satu kerangka Fiori untuk halaman masuk, lupa sandi, atur ulang sandi, dan pendaftaran: panel merek + kartu.
 * Caller: Next.js route group (auth): /login, /forgot-password, /reset-password, /register.
 * Dependensi: FioriScope (token + font, tema terang/gelap mengikuti html[data-scheme]/sistem), kelas fi-auth* di app/fiori.css.
 * Main Functions: AuthLayout.
 * Side Effects: Tidak ada; tidak membaca sesi (halaman publik).
 */
import type { ReactNode } from "react";
import { FioriScope } from "@/components/fiori/Scope";

const POKOK = [
    "Order, faktur, dan pelunasan langsung ke Accurate",
    "OFF Program, klaim, dan promo dalam satu alur persetujuan",
    "Rute, kunjungan, dan insentif tim lapangan",
];

export default function AuthLayout({ children }: { children: ReactNode }) {
    return (
        <FioriScope className="fi-auth">
            {/* Nama merek dibawa logo di kartu (selalu tampil); logo panel dekoratif supaya tidak dibaca dua kali. */}
            <div className="fi-auth-brand">
                <span className="fi-auth-brandlogo" aria-hidden />
                <ul>
                    {/* Tanpa ikon centang: tiga centang identik hanya hiasan (audit No 128). */}
                    {POKOK.map((teks) => <li key={teks}>{teks}</li>)}
                </ul>
                <small>CV. Surya Perkasa · Makassar</small>
            </div>
            <main className="fi-auth-side">
                <div className="fi-auth-card">
                    <span className="fi-logo" role="img" aria-label="CV. Surya Perkasa" />
                    {children}
                </div>
            </main>
        </FioriScope>
    );
}
