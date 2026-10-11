/*
 * Tujuan: Halaman Atur ulang sandi dari tautan email (Better Auth): sandi baru + ketik ulang, atau pesan tautan tidak berlaku.
 * Caller: Route `/reset-password?token=…` (Better Auth mengalihkan ke sini; token kedaluwarsa → `?error=INVALID_TOKEN`).
 * Dependensi: authClient.resetPassword, komponen Fiori, kerangka app/(auth)/layout.tsx.
 * Main Functions: ResetPasswordPage.
 * Side Effects: HTTP ke Better Auth untuk menyimpan sandi baru (token sekali pakai).
 */
"use client";

import { use, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Button, MessageStrip } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";

// Sama dengan server: lib/auth.ts emailAndPassword.minPasswordLength (6). Server tetap penentu akhir.
const MIN_SANDI = 6;

// Kode galat Better Auth → kalimat; pesan server tidak pernah dicetak.
const GALAT_SIMPAN = new Map<string, string>([
    ["PASSWORD_TOO_SHORT", `Sandi minimal ${MIN_SANDI} karakter.`],
    ["PASSWORD_TOO_LONG", "Sandi maksimal 128 karakter."],
]);

type Keadaan = "isi" | "tak-berlaku" | "tersimpan";

export default function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string | string[]; error?: string | string[] }> }) {
    const query = use(searchParams);
    const token = typeof query.token === "string" ? query.token : "";
    const awal: Keadaan = token && query.error === undefined ? "isi" : "tak-berlaku";
    const [keadaan, setKeadaan] = useState<Keadaan>(awal);
    const judulRef = useRef<HTMLHeadingElement>(null);
    // Keadaan berganti (tersimpan / tautan ditolak server) → fokus ke judul baru, bukan hilang ke <body>.
    useEffect(() => { if (keadaan !== awal) judulRef.current?.focus(); }, [keadaan, awal]);
    const [sandi, setSandi] = useState("");
    const [ulang, setUlang] = useState("");
    const [loading, setLoading] = useState(false);
    const [galat, setGalat] = useState<string>();

    const pendek = sandi.length < MIN_SANDI;
    const beda = ulang !== sandi;
    const terkunci = pendek ? `Sandi minimal ${MIN_SANDI} karakter.` : beda ? "Ketik ulang sandi yang sama dulu." : undefined;

    const handleReset = async (e: FormEvent) => {
        e.preventDefault();
        if (terkunci || loading) return;
        setLoading(true);
        setGalat(undefined);
        try {
            const { error } = await authClient.resetPassword({ newPassword: sandi, token });
            if (!error) setKeadaan("tersimpan");
            else if (error.code === "INVALID_TOKEN") setKeadaan("tak-berlaku");
            else setGalat(GALAT_SIMPAN.get(error.code ?? "") ?? "Sandi belum tersimpan. Coba lagi.");
        } catch {
            setGalat("Server tidak dapat dihubungi. Periksa koneksi, lalu coba lagi.");
        }
        setLoading(false);
    };

    if (keadaan === "tak-berlaku") {
        return (
            <>
                <h1 ref={judulRef} tabIndex={-1} className="fi-title-1">Tautan tidak berlaku</h1>
                <MessageStrip tone="warn">Tautan atur ulang sandi ini sudah kedaluwarsa, sudah dipakai, atau tidak lengkap.</MessageStrip>
                <Link href="/forgot-password" className="fi-btn fi-btn--primary">Minta tautan baru</Link>
                <Link href="/login" className="fi-btn fi-btn--tertiary">Kembali ke halaman masuk</Link>
            </>
        );
    }

    if (keadaan === "tersimpan") {
        return (
            <>
                <h1 ref={judulRef} tabIndex={-1} className="fi-title-1">Sandi tersimpan</h1>
                <MessageStrip tone="pos">Sandi baru sudah tersimpan. Masuk dengan sandi baru.</MessageStrip>
                <Link href="/login" className="fi-btn fi-btn--primary">Masuk</Link>
            </>
        );
    }

    return (
        <>
            <h1 className="fi-title-1">Atur sandi baru</h1>
            {galat && <MessageStrip tone="neg">{galat}</MessageStrip>}
            <form onSubmit={handleReset} noValidate>
                <FormField label="Sandi baru" help={`Minimal ${MIN_SANDI} karakter.`} error={sandi && pendek ? `Sandi minimal ${MIN_SANDI} karakter.` : undefined}>
                    {(a11y) => (
                        <input {...a11y} className="fi-input" type="password" autoComplete="new-password" value={sandi} disabled={loading}
                            onChange={(e) => setSandi(e.target.value)} />
                    )}
                </FormField>
                <FormField label="Ketik ulang sandi baru" error={ulang && beda ? "Belum sama dengan sandi baru." : undefined}>
                    {(a11y) => (
                        <input {...a11y} className="fi-input" type="password" autoComplete="new-password" value={ulang} disabled={loading}
                            onChange={(e) => setUlang(e.target.value)} />
                    )}
                </FormField>
                <Button type="submit" variant="primary" busy={loading} disabled={Boolean(terkunci)} disabledReason={terkunci}>
                    {loading ? "Menyimpan…" : "Simpan sandi"}
                </Button>
            </form>
            <Link href="/login" className="fi-btn fi-btn--tertiary">Kembali ke halaman masuk</Link>
        </>
    );
}
