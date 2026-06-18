/*
 * Tujuan: Halaman login internal Better Auth email/password bergaya portal CV. Surya Perkasa.
 * Caller: Route auth `/login`.
 * Dependensi: `authClient`, router Next.js, toast Sonner, lucide-react.
 * Main Functions: `LoginPage`, `isEmailVerificationError`.
 * Side Effects: HTTP sign-in ke Better Auth dan navigasi browser setelah session berhasil.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { BarChart3, Eye, Lock, Mail, ShieldCheck, UsersRound } from "lucide-react";
import { toast } from "sonner";

type LoginAuthError = {
    status?: number;
    message?: string;
    code?: string;
};

type FeatureItem = {
    title: string;
    description: string;
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
};

function isEmailVerificationError(error: LoginAuthError) {
    const text = `${error.message || ""} ${error.code || ""}`.toLowerCase();
    return (
        error.status === 403 &&
        text.includes("email") &&
        (text.includes("verif") || text.includes("verify"))
    );
}

const BASE_FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
const FEATURE_ITEMS: FeatureItem[] = [
    {
        title: "Kontrol Operasional",
        description: "Pantau dan kelola operasional secara real-time.",
        icon: BarChart3,
    },
    {
        title: "Aman & Terpercaya",
        description: "Sistem terintegrasi dengan standar keamanan perusahaan.",
        icon: ShieldCheck,
    },
    {
        title: "Akses Internal",
        description: "Akun dibuat oleh admin internal perusahaan.",
        icon: UsersRound,
    },
];

export default function LoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        const { error } = await authClient.signIn.email({
            email,
            password,
        });

        if (error) {
            if (isEmailVerificationError(error)) {
                toast.error("Email belum diverifikasi.", {
                    description: "Silakan periksa kotak masuk email Anda dan klik tautan verifikasi.",
                });
            } else {
                toast.error(error.message || "Gagal masuk. Periksa kembali email dan kata sandi Anda.", {
                    description: error.status === 403 ? "Akses login ditolak oleh konfigurasi auth server." : undefined,
                });
            }
            setLoading(false);
        } else {
            toast.success("Login berhasil.");
            router.push("/");
            router.refresh();
        }
    };

    return (
        <main className="login-portal-shell min-h-screen overflow-hidden md:h-screen" style={{ fontFamily: BASE_FONT }}>
            <div className="grid min-h-screen md:h-screen md:grid-cols-[49%_51%] md:overflow-hidden">

                {/* Brand section: compact strip on mobile, full panel on md+ */}
                <section
                    className="login-portal-brand relative flex overflow-hidden px-6 py-7 sm:px-10 sm:py-9 md:h-screen md:px-10 md:py-11 lg:px-11 lg:py-12"
                >
                    <div
                        aria-hidden="true"
                        className="login-portal-dot-layer absolute inset-0 opacity-25"
                    />
                    <div
                        aria-hidden="true"
                        className="login-portal-pattern absolute inset-x-0 bottom-0 h-[60%] opacity-80"
                    />
                    {/* Decorative rings — hidden on mobile to keep header compact */}
                    <div
                        aria-hidden="true"
                        className="login-portal-ring absolute bottom-[16%] left-[34%] h-40 w-40 rounded-full hidden md:block"
                    />
                    <div
                        aria-hidden="true"
                        className="login-portal-ring absolute bottom-[7%] left-[48%] h-72 w-72 rounded-full hidden md:block"
                    />
                    <div
                        aria-hidden="true"
                        className="login-portal-ring absolute -right-28 -bottom-16 h-80 w-80 rounded-full hidden md:block"
                    />
                    <div
                        aria-hidden="true"
                        className="login-portal-ring absolute -right-16 -bottom-24 h-96 w-96 rounded-full hidden md:block"
                    />

                    <div className="relative z-10 flex w-full max-w-[520px] flex-col">
                        {/* Logo + brand name — always visible */}
                        <div className="flex items-center gap-3">
                            <div className="login-portal-logo relative flex h-11 w-11 items-center justify-center rounded-full">
                                <div className="login-portal-logo-ring h-7 w-7 rounded-full border-[5px]" />
                                <div className="login-portal-logo-bar absolute h-3.5 w-9 rotate-[-28deg] rounded-full" />
                                <div className="login-portal-logo-cut absolute h-2.5 w-7 rotate-[-28deg] rounded-full" />
                            </div>
                            <div>
                                <p className="login-portal-brand-title text-xl font-extrabold uppercase leading-tight tracking-tight">
                                    CV. Surya Perkasa
                                </p>
                                <p className="login-portal-brand-subtitle text-sm font-medium">
                                    Solusi Distribusi &amp; Logistik
                                </p>
                            </div>
                        </div>

                        {/* Hero text + feature list — hidden on mobile, shown md+ */}
                        <div className="hidden md:block">
                            <div className="mt-20 lg:mt-28">
                                <h1
                                    className="login-portal-hero-title max-w-[440px] text-5xl font-extrabold leading-[1.03] tracking-[-0.04em] lg:text-7xl"
                                >
                                    Portal CV. Surya Perkasa
                                </h1>
                                <p className="login-portal-hero-subtitle mt-5 text-xl font-medium">
                                    Masuk ke sistem kontrol
                                </p>
                            </div>

                            <div className="mt-7 space-y-4 lg:mt-12 lg:space-y-7">
                                {FEATURE_ITEMS.map((item) => {
                                    const Icon = item.icon;
                                    return (
                                        <div key={item.title} className="flex items-start gap-5">
                                            <div className="login-portal-feature-icon flex h-12 w-12 shrink-0 items-center justify-center rounded-full lg:h-14 lg:w-14">
                                                <Icon aria-hidden="true" className="h-6 w-6 lg:h-7 lg:w-7" strokeWidth={2.2} />
                                            </div>
                                            <div>
                                                <h2 className="login-portal-feature-title text-base font-bold lg:text-lg">
                                                    {item.title}
                                                </h2>
                                                <p className="login-portal-feature-copy mt-1 max-w-[310px] text-sm leading-[1.55] lg:leading-6">
                                                    {item.description}
                                                </p>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </section>

                {/* Form section */}
                <section
                    className="login-portal-form-side flex min-h-[calc(100vh-6rem)] items-center justify-center px-5 py-10 sm:px-10 md:h-screen md:min-h-0 md:overflow-hidden"
                >
                    <form
                        onSubmit={handleLogin}
                        className="login-portal-card w-full max-w-[430px] rounded-xl px-6 py-8 sm:px-9 sm:py-10"
                    >
                        <div className="text-center">
                            <h2 className="login-portal-card-title text-2xl font-extrabold tracking-[-0.02em]">
                                Selamat Datang
                            </h2>
                            <p className="login-portal-card-subtitle mt-3 text-sm font-medium">
                                Silakan masuk untuk melanjutkan
                            </p>
                        </div>

                        <div className="mt-8">
                            <label htmlFor="email" className="login-portal-label block text-sm font-extrabold">
                                Email
                            </label>
                            <div className="relative mt-3">
                                <Mail
                                    aria-hidden="true"
                                    className="login-portal-input-icon absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2"
                                    strokeWidth={1.9}
                                />
                                <input
                                    id="email"
                                    type="email"
                                    required
                                    autoComplete="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="email@perusahaan.com"
                                    disabled={loading}
                                    className="login-portal-input h-12 w-full rounded-lg pl-12 pr-4 text-sm font-medium outline-none transition disabled:opacity-60"
                                />
                            </div>
                        </div>

                        <div className="mt-6">
                            <div className="flex items-center justify-between">
                                <label htmlFor="password" className="login-portal-label block text-sm font-extrabold">
                                    Password
                                </label>
                                <Link
                                    href="/forgot-password"
                                    className="login-portal-forgot text-xs font-extrabold transition"
                                >
                                    Lupa Password?
                                </Link>
                            </div>
                            <div className="relative mt-3">
                                <Lock
                                    aria-hidden="true"
                                    className="login-portal-input-icon absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2"
                                    strokeWidth={1.9}
                                />
                                <input
                                    id="password"
                                    type="password"
                                    required
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="********"
                                    disabled={loading}
                                    className="login-portal-input h-12 w-full rounded-lg pl-12 pr-12 text-sm font-medium outline-none transition disabled:opacity-60"
                                />
                                <Eye
                                    aria-hidden="true"
                                    className="login-portal-input-icon absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2"
                                    strokeWidth={1.9}
                                />
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="login-portal-button mt-8 h-14 w-full rounded-lg text-base font-extrabold transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                        >
                            {loading ? "Memproses..." : "Masuk"}
                        </button>

                        <p className="login-portal-note mt-8 text-center text-sm font-medium">
                            Akun dibuat oleh admin internal.
                        </p>
                    </form>
                </section>
            </div>
        </main>
    );
}
