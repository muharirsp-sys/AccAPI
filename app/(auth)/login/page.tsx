/*
 * Tujuan: Halaman masuk internal (Better Auth email + sandi) di kerangka auth Fiori; menampilkan galat yang dikirim lewat ?error=.
 * Caller: Route `/login` (guard dashboard, keluar dari menu profil, app/api/auth/callback/route.ts saat sesi app tidak ada).
 * Dependensi: authClient, komponen Fiori (Button, MessageStrip, FormField), kerangka app/(auth)/layout.tsx.
 * Main Functions: LoginPage, pesanDariUrl, pesanMasukGagal.
 * Side Effects: HTTP sign-in ke Better Auth; navigasi penuh ke / setelah sesi terbentuk.
 */
"use client";

import { use, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button, MessageStrip } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";

type Pesan = { tone: "neg" | "warn"; title: string; text?: string };

// Teks ?error= TIDAK pernah dicetak: hanya kode yang dikenal dipetakan, sisanya kalimat umum. Hari ini satu-satunya
// pengirim ke /login adalah app/api/auth/callback/route.ts:15; galat callback lain menuju /?error= (AM-033, slice terpisah).
// Map (bukan objek) supaya ?error=constructor / toString tidak mengenai properti prototipe.
const GALAT_URL = new Map<string, Pesan>([
    ["Accurate login requires app session", {
        tone: "warn", title: "Accurate belum terhubung.",
        text: "Sesi Ruang Kerja sudah berakhir saat kembali dari Accurate. Masuk, lalu hubungkan Accurate lagi dari Formulir Accurate (AOL).",
    }],
]);
const GALAT_URL_UMUM: Pesan = { tone: "warn", title: "Proses sebelumnya tidak selesai.", text: "Masuk, lalu coba lagi. Bila berulang, hubungi admin TI." };

function pesanDariUrl(error: string | string[] | undefined): Pesan | undefined {
    if (error === undefined) return undefined;
    return (typeof error === "string" && GALAT_URL.get(error)) || GALAT_URL_UMUM;
}

type AuthError = { status?: number; message?: string; code?: string };

/** Galat masuk generik: tidak membedakan email tidak ada vs sandi salah, dan tidak mencetak pesan server. */
function pesanMasukGagal(error: AuthError): Pesan {
    const teks = `${error.message || ""} ${error.code || ""}`.toLowerCase();
    if (error.status === 403 && teks.includes("email") && teks.includes("verif")) {
        return { tone: "neg", title: "Email belum diverifikasi.", text: "Minta admin memeriksa akun Anda." };
    }
    // ponytail: "15 menit" menyalin batas laju lib/auth.ts (/sign-in/email: 5 per 900 dtk per IP); ubah bersama bila batasnya berubah.
    if (error.status === 429) return { tone: "neg", title: "Terlalu banyak percobaan masuk.", text: "Coba lagi dalam 15 menit." };
    return { tone: "neg", title: "Email atau kata sandi salah." };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
    const pesanUrl = pesanDariUrl(use(searchParams).error);
    const [email, setEmail] = useState("");
    const [sandi, setSandi] = useState("");
    const [tampil, setTampil] = useState(false);
    const [loading, setLoading] = useState(false);
    const [salah, setSalah] = useState<{ email?: string; sandi?: string }>({});
    const [galat, setGalat] = useState<Pesan>();
    const emailRef = useRef<HTMLInputElement>(null);
    const sandiRef = useRef<HTMLInputElement>(null);
    const galatRef = useRef<HTMLDivElement>(null);

    // Fokus ke galat masuk supaya pembaca layar dan papan ketik langsung berada di pesannya.
    useEffect(() => { if (galat) galatRef.current?.focus(); }, [galat]);

    const handleLogin = async (e: FormEvent) => {
        e.preventDefault();
        const trimmedEmail = email.trim();
        const next = {
            email: !trimmedEmail ? "Email wajib diisi." : !EMAIL_PATTERN.test(trimmedEmail) ? "Format email belum sesuai." : undefined,
            sandi: !sandi ? "Kata sandi wajib diisi." : undefined,
        };
        setSalah(next);
        setGalat(undefined);
        if (next.email || next.sandi) {
            (next.email ? emailRef : sandiRef).current?.focus();
            return;
        }
        setLoading(true);
        try {
            const { error } = await authClient.signIn.email({ email: trimmedEmail, password: sandi });
            if (error) {
                setGalat(pesanMasukGagal(error));
                setLoading(false);
                return;
            }
            // ponytail: hard navigation, bukan router.push. router.push bergantung pada
            // RSC fetch yang bisa menggantung tanpa reject — tombol terkunci "Memproses..."
            // selamanya karena jalur sukses memang tidak pernah setLoading(false).
            window.location.assign("/");
        } catch {
            setGalat({ tone: "neg", title: "Server tidak dapat dihubungi.", text: "Periksa koneksi, lalu coba lagi." });
            setLoading(false);
        }
    };

    return (
        <>
            <h1 className="fi-title-1">Masuk ke Ruang Kerja</h1>
            {pesanUrl && <MessageStrip tone={pesanUrl.tone} title={pesanUrl.title}>{pesanUrl.text}</MessageStrip>}
            {galat && <div ref={galatRef} tabIndex={-1}><MessageStrip tone={galat.tone} title={galat.title}>{galat.text}</MessageStrip></div>}
            <form onSubmit={handleLogin} noValidate>
                <FormField label="Email" error={salah.email}>
                    {(a11y) => (
                        <input {...a11y} ref={emailRef} className="fi-input" type="email" autoComplete="username"
                            autoCapitalize="none" autoCorrect="off" spellCheck={false} value={email} disabled={loading}
                            onChange={(e) => { setEmail(e.target.value); setSalah((s) => ({ ...s, email: undefined })); }} />
                    )}
                </FormField>
                <FormField label="Kata sandi" error={salah.sandi}>
                    {(a11y) => (
                        <div className="fi-auth-pw">
                            <input {...a11y} ref={sandiRef} className="fi-input" type={tampil ? "text" : "password"} autoComplete="current-password"
                                // ponytail: saat "tampilkan sandi" input jadi type="text" dan keyboard HP mengapitalkan huruf pertama.
                                autoCapitalize="none" autoCorrect="off" spellCheck={false} value={sandi} disabled={loading}
                                onChange={(e) => { setSandi(e.target.value); setSalah((s) => ({ ...s, sandi: undefined })); }} />
                            <Button variant="icon" aria-label="Tampilkan sandi" aria-pressed={tampil} disabled={loading} onClick={() => setTampil((t) => !t)}
                                icon={tampil ? <EyeOff className="fi-icon" aria-hidden /> : <Eye className="fi-icon" aria-hidden />} />
                        </div>
                    )}
                </FormField>
                <div className="fi-auth-row"><Link href="/forgot-password">Lupa sandi?</Link></div>
                <Button type="submit" variant="primary" busy={loading}>{loading ? "Memproses…" : "Masuk"}</Button>
            </form>
            <p className="fi-small fi-muted">Akun dibuat admin. Belum punya akun? Hubungi admin TI.</p>
        </>
    );
}
