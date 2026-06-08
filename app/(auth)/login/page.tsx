/*
 * Tujuan: Halaman login internal Better Auth email/password bergaya warm luxury dengan pesan error yang membedakan origin dev dan verifikasi email.
 * Caller: Route auth `/login`.
 * Dependensi: `authClient`, router Next.js, toast Sonner, link reset password.
 * Main Functions: `LoginPage`, `isEmailVerificationError`, form login glassmorphism.
 * Side Effects: HTTP sign-in ke Better Auth dan navigasi browser setelah session berhasil.
 */
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Lock, Mail } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

type LoginAuthError = {
    status?: number;
    message?: string;
    code?: string;
};

function isEmailVerificationError(error: LoginAuthError) {
    const text = `${error.message || ""} ${error.code || ""}`.toLowerCase();
    return (
        error.status === 403 &&
        text.includes("email") &&
        (text.includes("verif") || text.includes("verify"))
    );
}

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
            password
        });

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
            setLoading(false);
        } else {
            toast.success("Login berhasil.");
            router.push("/");
            router.refresh();
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-[radial-gradient(circle_at_20%_12%,rgba(242,210,138,0.45),transparent_28rem),radial-gradient(circle_at_80%_85%,rgba(199,154,63,0.20),transparent_30rem),linear-gradient(135deg,#fff8ea,#f4ead9)]">
            <div className="max-w-md w-full bg-[#fffaf0]/82 rounded-[2rem] shadow-[0_28px_90px_rgba(122,78,32,0.16),0_8px_28px_rgba(122,78,32,0.10)] overflow-hidden border border-[#c79a3f]/20 backdrop-blur-2xl">
                <div className="relative bg-gradient-to-br from-[#fff3d1] via-[#e4ba62] to-[#9a6424] p-8 text-white text-center overflow-hidden">
                    <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent"></div>
                    <div className="absolute -right-16 -top-20 h-48 w-48 rounded-full bg-white/20 blur-3xl"></div>
                    <h2 className="text-3xl font-extrabold tracking-tight">Portal CV. Surya Perkasa</h2>
                    <p className="mt-2 text-[#4f3218]/80 text-sm font-medium">Masuk ke sistem kontrol</p>
                </div>

                <div className="p-8 bg-[#fffaf0]/74">
                    <form onSubmit={handleLogin} className="space-y-6">
                        <div>
                            <label className="block text-sm font-semibold text-[#574839] mb-1">Email</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Mail className="h-5 w-5 text-[#9a7a45]" />
                                </div>
                                <input
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
                                <label className="block text-sm font-semibold text-[#574839]">Password</label>
                                <Link href="/forgot-password" className="text-xs font-semibold text-[#9a6424] hover:text-[#7a4e20]">
                                    Lupa Password?
                                </Link>
                            </div>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Lock className="h-5 w-5 text-[#9a7a45]" />
                                </div>
                                <input
                                    type="password"
                                    required
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="block w-full pl-10 pr-3 py-2.5 border border-[#c79a3f]/24 rounded-xl focus:ring-[#d6a948] focus:border-[#c79a3f] sm:text-sm shadow-sm transition-colors text-[#2d241b] bg-white/72"
                                    placeholder="••••••••"
                                />
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full flex justify-center py-3 px-4 border border-[#f2d28a]/60 rounded-xl shadow-[0_14px_32px_rgba(199,154,63,0.28)] text-sm font-semibold text-[#3d2814] bg-gradient-to-r from-[#f2d28a] via-[#d6a948] to-[#b77a25] hover:shadow-[0_18px_40px_rgba(199,154,63,0.34)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#d6a948] transition-all disabled:opacity-50"
                        >
                            {loading ? "Memproses..." : "Masuk"}
                        </button>
                    </form>
                    
                    <div className="mt-6 text-center">
                        <p className="text-sm text-[#766753]">
                            Akun dibuat oleh admin internal.
                        </p>
                    </div>
                </div>
                <div className="bg-[#f7ead0]/72 px-8 py-4 border-t border-[#c79a3f]/14 text-center">
                    <p className="text-xs text-[#927f66]">&copy; 2026 Muh. Ari Ramadhan</p>
                </div>
            </div>
        </div>
    );
}
