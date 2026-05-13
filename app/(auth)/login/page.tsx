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

    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
                <div className="bg-gradient-to-r from-blue-600 to-indigo-700 p-8 text-white text-center">
                    <h2 className="text-3xl font-extrabold tracking-tight">Portal CV. Surya Perkasa</h2>
                    <p className="mt-2 text-blue-100 text-sm">Masuk ke sistem kontrol</p>
                </div>

                <div className="p-8">
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
                            Akun dibuat oleh admin internal.
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
