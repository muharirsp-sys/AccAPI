/*
 * Tujuan: Halaman Lupa sandi: minta tautan atur ulang lewat Better Auth dengan layar hasil yang NETRAL.
 * Caller: Route `/forgot-password` (tautan "Lupa sandi?" di /login, "Minta tautan baru" di /reset-password).
 * Dependensi: authClient.requestPasswordReset, komponen Fiori, kerangka app/(auth)/layout.tsx.
 * Main Functions: ForgotPasswordPage.
 * Side Effects: HTTP ke Better Auth (server mengirim email hanya untuk akun terdaftar).
 */
"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Button, MessageStrip } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordPage() {
    const [email, setEmail] = useState("");
    const [salah, setSalah] = useState<string>();
    const [loading, setLoading] = useState(false);
    const [terkirim, setTerkirim] = useState(false);
    const emailRef = useRef<HTMLInputElement>(null);

    const handleReset = async (e: FormEvent) => {
        e.preventDefault();
        const trimmed = email.trim();
        const pesan = !trimmed ? "Email wajib diisi." : !EMAIL_PATTERN.test(trimmed) ? "Format email belum sesuai." : undefined;
        setSalah(pesan);
        if (pesan) { emailRef.current?.focus(); return; }
        setLoading(true);
        // Anti user-enumeration: JANGAN cek keberadaan/verifikasi akun dulu (itu oracle
        // enumerasi + timing leak). Better Auth hanya mengirim email untuk akun terdaftar;
        // UI selalu menampilkan layar identik apa pun jawaban server, dan tidak mengulang email yang diketik.
        await authClient
            .requestPasswordReset({ email: trimmed, redirectTo: `${window.location.origin}/reset-password` })
            .catch(() => {});
        setTerkirim(true);
        setLoading(false);
    };

    if (terkirim) {
        return (
            <>
                <h1 className="fi-title-1">Permintaan diterima</h1>
                <MessageStrip tone="info">Bila email terdaftar, tautan dikirim. Tautan berlaku 1 jam.</MessageStrip>
                {/* Owner 11 Okt: email akun belum tentu alamat nyata; admin mengatur sandi lewat dialog di halaman User. */}
                <p className="fi-small fi-muted">Tidak menerima surel? Minta admin mengatur sandi Anda.</p>
                <Link href="/login" className="fi-btn fi-btn--secondary">Kembali ke halaman masuk</Link>
            </>
        );
    }

    return (
        <>
            <h1 className="fi-title-1">Lupa sandi</h1>
            <p className="fi-small fi-muted">Masukkan email akun Anda. Bila terdaftar, tautan atur ulang sandi dikirim ke email itu.</p>
            <form onSubmit={handleReset} noValidate>
                <FormField label="Email" error={salah}>
                    {(a11y) => (
                        <input {...a11y} ref={emailRef} className="fi-input" type="email" autoComplete="email" value={email} disabled={loading}
                            onChange={(e) => { setEmail(e.target.value); setSalah(undefined); }} />
                    )}
                </FormField>
                <Button type="submit" variant="primary" busy={loading}>{loading ? "Memproses…" : "Kirim tautan"}</Button>
            </form>
            <Link href="/login" className="fi-btn fi-btn--tertiary">Kembali ke halaman masuk</Link>
        </>
    );
}
