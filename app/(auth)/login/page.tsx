"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Lock, Mail } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

export default function LoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);

    const [googleLoading, setGoogleLoading] = useState(false);

    const handleGoogleSignIn = async () => {
        setGoogleLoading(true);
        await authClient.signIn.social({
            provider: "google",
            callbackURL: "/"
        });
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        const { error } = await authClient.signIn.email({
            email,
            password
        });

        if (error) {
            if (error.status === 403) {
                toast.error("Email belum diverifikasi.", {
                    description: "Silakan periksa kotak masuk email Anda dan klik tautan verifikasi."
                });
            } else {
                toast.error(error.message || "Gagal masuk. Periksa kembali email dan kata sandi Anda.");
            }
            setLoading(false);
        } else {
            toast.success("Login berhasil.");
            router.push("/");
        }
    };

    const GoogleIcon = () => (
        <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
        </svg>
    );

    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
                <div className="bg-gradient-to-r from-blue-600 to-indigo-700 p-8 text-white text-center">
                    <h2 className="text-3xl font-extrabold tracking-tight">Portal CV. Surya Perkasa</h2>
                    <p className="mt-2 text-blue-100 text-sm">Masuk ke sistem kontrol</p>
                </div>

                <div className="p-8">
                    <button
                        type="button"
                        onClick={handleGoogleSignIn}
                        disabled={googleLoading || loading}
                        className="w-full flex justify-center items-center py-2.5 px-4 mb-5 border border-slate-300 rounded-lg shadow-sm text-sm font-medium text-slate-700 bg-white hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors disabled:opacity-50"
                    >
                        {googleLoading ? "Sedang Mengarahkan..." : <><GoogleIcon /> Lanjutkan dengan Google</>}
                    </button>

                    <div className="relative mb-5">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-slate-300"></div>
                        </div>
                        <div className="relative flex justify-center text-sm">
                            <span className="px-2 bg-white text-slate-500">Atau masuk dengan email</span>
                        </div>
                    </div>
                    <form onSubmit={handleLogin} className="space-y-6">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Mail className="h-5 w-5 text-slate-400" />
                                </div>
                                <input
                                    type="email"
                                    required
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="block w-full pl-10 pr-3 py-2.5 border border-slate-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 sm:text-sm shadow-sm transition-colors text-slate-900"
                                    placeholder="email@perusahaan.com"
                                />
                            </div>
                        </div>

                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <label className="block text-sm font-medium text-slate-700">Password</label>
                                <Link href="/forgot-password" className="text-xs font-semibold text-blue-600 hover:text-blue-500">
                                    Lupa Password?
                                </Link>
                            </div>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Lock className="h-5 w-5 text-slate-400" />
                                </div>
                                <input
                                    type="password"
                                    required
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="block w-full pl-10 pr-3 py-2.5 border border-slate-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 sm:text-sm shadow-sm transition-colors text-slate-900"
                                    placeholder="••••••••"
                                />
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors disabled:opacity-50"
                        >
                            {loading ? "Memproses..." : "Masuk"}
                        </button>
                    </form>
                    
                    <div className="mt-6 text-center">
                        <p className="text-sm text-slate-600">
                            Belum punya akun? <Link href="/register" className="font-medium text-blue-600 hover:text-blue-500">Daftar sekarang</Link>
                        </p>
                    </div>
                </div>
                <div className="bg-slate-50 px-8 py-4 border-t border-slate-100 text-center">
                    <p className="text-xs text-slate-500">&copy; 2026 Muh. Ari Ramadhan</p>
                </div>
            </div>
        </div>
    );
}
