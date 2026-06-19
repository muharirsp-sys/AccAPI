/*
 * Tujuan: Halaman login internal Better Auth email/password bergaya portal CV. Surya Perkasa.
 * Caller: Route auth `/login`.
 * Dependensi: `authClient`, router Next.js, toast Sonner, lucide-react.
 * Main Functions: `LoginPage`, `isEmailVerificationError`.
 * Side Effects: HTTP sign-in ke Better Auth dan navigasi browser setelah session berhasil.
 */
"use client";

import { useRef, useState } from "react";
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
    // ponytail: ref guard prevents triple-submit when Enter fires before setLoading batches
    const submitting = useRef(false);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submitting.current) return;
        submitting.current = true;
        setLoading(true);

        try {
            const { error } = await authClient.signIn.email({ email, password });

            if (error) {
                if (isEmailVerificationError(error)) {
                    toast.error("Email belum diverifikasi.", {
                        description: "Silakan periksa kotak masuk email Anda dan klik tautan verifikasi."
                    });
                } else {
                    toast.error(error.message || "Gagal masuk. Periksa kembali email dan kata sandi Anda.", {
                        description: error.status === 403 ? "Akses login ditolak oleh konfigurasi auth server." : undefined,
                    });
                }
            } else {
                toast.success("Login berhasil.");
                router.push("/");
                router.refresh();
                return; // keep loading=true while navigating; middleware handles redirect
            }
        } catch {
            toast.error("Terjadi kesalahan jaringan. Coba lagi.");
        } finally {
            submitting.current = false;
            setLoading(false);
        }
    };

    return (
        <main className="login-portal-shell min-h-screen overflow-x-hidden" style={{ fontFamily: BASE_FONT }}>
            <div className="grid min-h-screen md:grid-cols-[49%_51%]">

                <div className="p-8 bg-[#fffaf0]/74">
                    <form onSubmit={handleLogin} className="space-y-6">
                        <div>
                            <label htmlFor="email" className="block text-sm font-semibold text-[#574839] mb-1">Email</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Mail className="h-5 w-5 text-[#9a7a45]" />
                                </div>
                                <input
                                    id="email"
                                    type="email"
                                    required
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="block w-full pl-10 pr-3 py-2.5 border border-[#c79a3f]/24 rounded-xl focus:ring-[#d6a948] focus:border-[#c79a3f] sm:text-sm shadow-sm transition-colors text-[#2d241b] bg-white/72"
                                    placeholder="email@perusahaan.com"
                                />
                            </div>
                        </div>

                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label htmlFor="password" className="block text-sm font-semibold text-[#574839]">Password</label>
                                <Link href="/forgot-password" prefetch={false} className="text-xs font-semibold text-[#9a6424] hover:text-[#7a4e20]">
                                    Lupa Password?
                                </Link>
                            </div>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Lock className="h-5 w-5 text-[#9a7a45]" />
                                </div>
                                <input
                                    id="password"
                                    type="password"
                                    required
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="block w-full pl-10 pr-3 py-2.5 border border-[#c79a3f]/24 rounded-xl focus:ring-[#d6a948] focus:border-[#c79a3f] sm:text-sm shadow-sm transition-colors text-[#2d241b] bg-white/72"
                                    placeholder="••••••••"
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
                            aria-busy={loading}
                            className="w-full flex justify-center py-3 px-4 border border-[#f2d28a]/60 rounded-xl shadow-[0_14px_32px_rgba(199,154,63,0.28)] text-sm font-semibold text-[#3d2814] bg-gradient-to-r from-[#f2d28a] via-[#d6a948] to-[#b77a25] hover:shadow-[0_18px_40px_rgba(199,154,63,0.34)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#d6a948] transition-all disabled:opacity-50"
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
