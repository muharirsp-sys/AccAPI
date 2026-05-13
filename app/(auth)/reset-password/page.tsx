"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

function ResetPasswordForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const token = searchParams.get("token") || "";

    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);

    const handleReset = async (e: React.FormEvent) => {
        e.preventDefault();
        
        if (password !== confirmPassword) {
            toast.error("Password tidak cocok.");
            return;
        }

        if (password.length < 6) {
            toast.error("Password minimal 6 karakter.");
            return;
        }

        if (!token) {
            toast.error("Token Reset tidak valid atau tidak ditemukan dalam URL.");
            return;
        }

        setLoading(true);

        const { error } = await authClient.resetPassword({
            newPassword: password,
            token
        });

        if (error) {
            toast.error(error.message || "Kesalahan mendasar saat mereset password. Pastikan Link tidak kedaluwarsa.");
            setLoading(false);
        } else {
            toast.success("Password Anda telah berhasil di-reset!", {
                description: "Silakan gunakan kredensial baru Anda untuk login."
            });
            router.push("/login");
        }
    };

    return (
        <div className="p-8">
            <form onSubmit={handleReset} className="space-y-6">
                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Password Baru</label>
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
                            placeholder="Minimal 6 Karakter"
                        />
                    </div>
                </div>

                <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Konfirmasi Password Baru</label>
                    <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <Lock className="h-5 w-5 text-slate-400" />
                        </div>
                        <input
                            type="password"
                            required
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            className="block w-full pl-10 pr-3 py-2.5 border border-slate-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 sm:text-sm shadow-sm transition-colors text-slate-900"
                            placeholder="Ketik ulan sandi"
                        />
                    </div>
                </div>

                <button
                    type="submit"
                    disabled={loading || !token}
                    className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors disabled:opacity-50"
                >
                    {loading ? "Menyimpan Sandi..." : "Simpan Password Baru"}
                </button>
            </form>
            
            <div className="mt-6 text-center">
                <Link href="/login" className="text-sm font-medium text-slate-500 hover:text-slate-800 transition-colors">
                    Kembali ke halaman masuk
                </Link>
            </div>
        </div>
    );
}

export default function ResetPasswordPage() {
    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
                <div className="bg-gradient-to-r from-blue-600 to-indigo-700 p-8 text-white text-center">
                    <h2 className="text-3xl font-extrabold tracking-tight">Atur Ulang Sandi</h2>
                    <p className="mt-2 text-blue-100 text-sm">Gunakan form di bawah untuk mengubah password Anda yang hilang.</p>
                </div>

                <Suspense fallback={
                    <div className="p-12 text-center text-slate-500">Menganalisis Token...</div>
                }>
                    <ResetPasswordForm />
                </Suspense>
            </div>
        </div>
    );
}
