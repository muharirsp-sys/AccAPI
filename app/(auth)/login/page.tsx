/*
 * Tujuan: Halaman login internal Better Auth email/password bergaya portal CV. Surya Perkasa.
 * Caller: Route auth `/login`.
 * Dependensi: `authClient`, router Next.js, toast Sonner, lucide-react.
 * Main Functions: `LoginPage`, `isEmailVerificationError`.
 * Side Effects: HTTP sign-in ke Better Auth dan navigasi browser setelah session berhasil.
 */
"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { AlertCircle, BarChart3, Eye, EyeOff, Lock, Mail, ShieldCheck, UsersRound } from "lucide-react";
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

type LoginFieldErrors = {
    email?: string;
    password?: string;
    general?: string;
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
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FEATURE_ITEMS: FeatureItem[] = [
    {
        title: "Pantau Operasional",
        description: "Kelola aktivitas dan data operasional secara lebih terpusat.",
        icon: BarChart3,
    },
    {
        title: "Akses Internal Aman",
        description: "Hanya pengguna terdaftar yang dapat masuk ke sistem.",
        icon: ShieldCheck,
    },
    {
        title: "Data Terintegrasi",
        description: "Mendukung proses monitoring, pelaporan, dan pengambilan keputusan.",
        icon: UsersRound,
    },
];

export default function LoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [errors, setErrors] = useState<LoginFieldErrors>({});

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmedEmail = email.trim();
        const nextErrors: LoginFieldErrors = {};

        if (!trimmedEmail) {
            nextErrors.email = "Email wajib diisi.";
        } else if (!EMAIL_PATTERN.test(trimmedEmail)) {
            nextErrors.email = "Format email belum sesuai.";
        }

        if (!password) {
            nextErrors.password = "Password wajib diisi.";
        }

        if (nextErrors.email || nextErrors.password) {
            setErrors(nextErrors);
            return;
        }

        setErrors({});
        setLoading(true);

        try {
            const { error } = await authClient.signIn.email({
                email: trimmedEmail,
                password,
            });

            if (error) {
                if (isEmailVerificationError(error)) {
                    setErrors({ general: "Email belum diverifikasi." });
                    toast.error("Email belum diverifikasi.", {
                        description: "Silakan periksa kotak masuk email Anda dan klik tautan verifikasi.",
                    });
                } else {
                    setErrors({ general: "Email atau password tidak sesuai." });
                    toast.error("Email atau password tidak sesuai.");
                }
                setLoading(false);
            } else {
                toast.success("Login berhasil.");
                router.push("/");
                router.refresh();
            }
        } catch {
            setErrors({ general: "Terjadi kesalahan. Coba lagi." });
            toast.error("Terjadi kesalahan saat login.");
            setLoading(false);
        }
    };

    return (
        <main className="login-portal-shell min-h-screen overflow-x-hidden" style={{ fontFamily: BASE_FONT }}>
            <div className="grid min-h-screen md:grid-cols-[49%_51%]">

                {/* Brand section: compact strip on mobile, full panel on md+ */}
                <section
                    className="login-portal-brand relative flex overflow-hidden px-6 py-7 sm:px-10 sm:py-9 md:min-h-screen md:px-10 md:py-8 lg:px-11 lg:py-10"
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
                        {/* Logo brand */}
                        <div
                            className="login-portal-logo-stack inline-grid w-fit items-center"
                            role="img"
                            aria-label="CV. Surya Perkasa Distribution Company"
                        >
                            <Image
                                src="/brand/logo_SP_horizontal.png"
                                alt=""
                                aria-hidden="true"
                                width={305}
                                height={95}
                                priority
                                unoptimized
                                className="login-portal-logo-mark login-portal-logo-mark-blue col-start-1 row-start-1 h-auto w-[min(64vw,15.5rem)] sm:w-[16rem] md:w-[14.5rem] lg:w-[16rem]"
                            />
                            <Image
                                src="/brand/logo_SP_horizontal_white.png"
                                alt=""
                                aria-hidden="true"
                                width={305}
                                height={95}
                                priority
                                unoptimized
                                className="login-portal-logo-mark login-portal-logo-mark-white col-start-1 row-start-1 h-auto w-[min(64vw,15.5rem)] sm:w-[16rem] md:w-[14.5rem] lg:w-[16rem]"
                            />
                        </div>

                        {/* Hero text + feature list — hidden on mobile, shown md+ */}
                        <div className="hidden md:block">
                            <div className="mt-12 lg:mt-16">
                                <h1
                                    className="login-portal-hero-title max-w-[390px] text-[clamp(2.25rem,3.7vw,3.65rem)] font-extrabold leading-[1.08] tracking-normal"
                                >
                                    Portal<br />CV. Surya Perkasa
                                </h1>
                                <p className="login-portal-hero-subtitle mt-4 text-lg font-medium lg:text-xl">
                                    Masuk ke sistem kontrol
                                </p>
                            </div>

                            <div className="mt-6 space-y-4 lg:mt-8 lg:space-y-5">
                                {FEATURE_ITEMS.map((item) => {
                                    const Icon = item.icon;
                                    return (
                                        <div key={item.title} className="flex items-start gap-4">
                                            <div className="login-portal-feature-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-full lg:h-12 lg:w-12">
                                                <Icon aria-hidden="true" className="h-5 w-5 lg:h-6 lg:w-6" strokeWidth={2.2} />
                                            </div>
                                            <div>
                                                <h2 className="login-portal-feature-title text-base font-bold">
                                                    {item.title}
                                                </h2>
                                                <p className="login-portal-feature-copy mt-1 max-w-[310px] text-sm leading-[1.5]">
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
                    className="login-portal-form-side flex min-h-[calc(100vh-6rem)] items-center justify-center px-5 py-10 sm:px-10 md:min-h-screen"
                >
                    <div className="login-portal-form-wrap flex w-full max-w-[430px] flex-col items-center">
                        <div
                            className="login-portal-mobile-logo login-portal-logo-stack mb-6 inline-grid w-fit items-center md:hidden"
                            role="img"
                            aria-label="CV. Surya Perkasa Distribution Company"
                        >
                            <Image
                                src="/brand/logo_SP_horizontal.png"
                                alt=""
                                aria-hidden="true"
                                width={305}
                                height={95}
                                priority
                                unoptimized
                                className="login-portal-logo-mark login-portal-logo-mark-blue col-start-1 row-start-1 h-auto"
                            />
                            <Image
                                src="/brand/logo_SP_horizontal_white.png"
                                alt=""
                                aria-hidden="true"
                                width={305}
                                height={95}
                                priority
                                unoptimized
                                className="login-portal-logo-mark login-portal-logo-mark-white col-start-1 row-start-1 h-auto"
                            />
                        </div>

                    <form
                        onSubmit={handleLogin}
                        noValidate
                        className="login-portal-card w-full max-w-[430px] rounded-2xl px-6 py-8 sm:px-9 sm:py-10"
                    >
                        <div className="text-center">
                            <h2 className="login-portal-card-title text-2xl font-extrabold tracking-normal">
                                Selamat Datang
                            </h2>
                            <p className="login-portal-card-subtitle mt-3 text-sm font-medium">
                                Masuk menggunakan akun internal perusahaan.
                            </p>
                        </div>

                        {errors.general ? (
                            <div className="login-portal-alert mt-6 flex items-start gap-3 rounded-lg px-4 py-3 text-sm font-semibold" role="alert">
                                <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2.2} />
                                <span>{errors.general}</span>
                            </div>
                        ) : null}

                        <div className={errors.general ? "mt-6" : "mt-8"}>
                            <label htmlFor="email" className="login-portal-label block text-sm font-bold">
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
                                    autoComplete="email"
                                    value={email}
                                    onChange={(e) => {
                                        setEmail(e.target.value);
                                        setErrors((current) => ({ ...current, email: undefined, general: undefined }));
                                    }}
                                    placeholder="Masukkan email Anda"
                                    disabled={loading}
                                    aria-invalid={Boolean(errors.email)}
                                    aria-describedby={errors.email ? "email-error" : undefined}
                                    className={`login-portal-input h-12 w-full rounded-lg pl-12 pr-4 text-sm font-medium outline-none transition disabled:opacity-60 ${errors.email ? "login-portal-input-error" : ""}`}
                                />
                            </div>
                            {errors.email ? (
                                <p id="email-error" className="login-portal-error mt-2 text-sm font-semibold">
                                    {errors.email}
                                </p>
                            ) : null}
                        </div>

                        <div className="mt-6">
                            <div className="flex items-center justify-between">
                                <label htmlFor="password" className="login-portal-label block text-sm font-bold">
                                    Password
                                </label>
                                <Link
                                    href="/forgot-password"
                                    aria-disabled={loading}
                                    tabIndex={loading ? -1 : undefined}
                                    onClick={(event) => {
                                        if (loading) event.preventDefault();
                                    }}
                                    className="login-portal-forgot inline-flex min-h-11 items-center text-xs font-bold transition"
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
                                    type={showPassword ? "text" : "password"}
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => {
                                        setPassword(e.target.value);
                                        setErrors((current) => ({ ...current, password: undefined, general: undefined }));
                                    }}
                                    placeholder="Masukkan password"
                                    disabled={loading}
                                    aria-invalid={Boolean(errors.password)}
                                    aria-describedby={errors.password ? "password-error" : undefined}
                                    className={`login-portal-input h-12 w-full rounded-lg pl-12 pr-12 text-sm font-medium outline-none transition disabled:opacity-60 ${errors.password ? "login-portal-input-error" : ""}`}
                                />
                                <button
                                    type="button"
                                    disabled={loading}
                                    aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}
                                    aria-pressed={showPassword}
                                    onClick={() => setShowPassword((current) => !current)}
                                    className="login-portal-password-toggle absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-45"
                                >
                                    {showPassword ? (
                                        <EyeOff aria-hidden="true" className="h-5 w-5" strokeWidth={1.9} />
                                    ) : (
                                        <Eye aria-hidden="true" className="h-5 w-5" strokeWidth={1.9} />
                                    )}
                                </button>
                            </div>
                            {errors.password ? (
                                <p id="password-error" className="login-portal-error mt-2 text-sm font-semibold">
                                    {errors.password}
                                </p>
                            ) : null}
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="login-portal-button mt-8 h-14 w-full rounded-lg text-base font-bold transition focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                        >
                            {loading ? "Memproses..." : "Masuk"}
                        </button>

                        <p className="login-portal-note mt-8 text-center text-sm font-medium">
                            Belum memiliki akun? Hubungi admin internal perusahaan.
                        </p>
                    </form>
                    </div>
                </section>
            </div>
        </main>
    );
}
