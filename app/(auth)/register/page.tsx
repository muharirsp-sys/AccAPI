/*
 * Tujuan: Halaman pendaftaran yang ditutup: akun dibuat admin (server: Better Auth disableSignUp).
 * Caller: Route `/register`.
 * Dependensi: kerangka app/(auth)/layout.tsx.
 * Main Functions: RegisterPage.
 * Side Effects: Tidak ada.
 */
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Pendaftaran ditutup" };

export default function RegisterPage() {
    return (
        <>
            <h1 className="fi-title-1">Pendaftaran ditutup</h1>
            <p className="fi-small fi-muted">Akun dibuat admin, lengkap dengan grup aksesnya. Hubungi admin TI untuk meminta akun.</p>
            <Link href="/login" className="fi-btn fi-btn--secondary">Kembali ke halaman masuk</Link>
        </>
    );
}
