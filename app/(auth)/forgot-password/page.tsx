"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Mail, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

export default function ForgotPasswordPage() {
    const [email, setEmail] = useState("");
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    const handleReset = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        // Anti user-enumeration: JANGAN cek keberadaan/verifikasi akun dulu (itu oracle
        // enumerasi + timing leak). Better Auth hanya mengirim email untuk akun terdaftar;
        // UI selalu menampilkan respons identik baik email ada maupun tidak.
        await authClient
            .requestPasswordReset({
                email,
                redirectTo: `${window.location.origin}/reset-password`,
            })
            .catch(() => {});

        toast.success("Jika email Anda terdaftar, tautan pengaturan ulang sandi telah dikirimkan.");
        setSubmitted(true);
        setLoading(false);
    };

    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
                <div className="bg-gradient-to-r from-blue-600 to-indigo-700 p-8 text-white relative">
                    <Link href="/login" aria-label="Kembali ke halaman masuk" className="absolute top-4 left-4 p-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors">
                        <ArrowLeft size={16} />
                    </Link>
                    <div className="text-center mt-4">
                        <h2 className="text-3xl font-extrabold tracking-tight">Lupa Password</h2>
                        <p className="mt-2 text-blue-100 text-sm">Masukan email untuk mendapatkan tautan akses ulang</p>
                    </div>
                </div>

                <div className="p-8">
                    {submitted ? (
                        <div className="text-center space-y-4">
                            <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
                                <Mail size={32} />
                            </div>
                            <h3 className="text-xl font-bold text-slate-800">Email Terkirim</h3>
                            <p className="text-slate-600 text-sm">Kami telah mengirimkan tautan reset password ke kotak masuk Anda. Tautan kedaluwarsa dalam 1 jam.</p>
                            <Link href="/login" className="inline-block mt-4 w-full py-3 px-4 rounded-lg bg-blue-50 text-blue-600 font-medium hover:bg-blue-100 transition-colors">
                                Kembali ke Login
                            </Link>
                        </div>
                    ) : (
                        <form onSubmit={handleReset} className="space-y-6">
                            <div>
                                <label htmlFor="forgot-email" className="block text-sm font-medium text-slate-700 mb-1">Alamat Email Terdaftar</label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <Mail className="h-5 w-5 text-slate-400" />
                                    </div>
                                    <input
                                        id="forgot-email"
                                        type="email"
                                        required
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        className="block w-full pl-10 pr-3 py-2.5 border border-slate-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 sm:text-sm shadow-sm transition-colors text-slate-900"
                                        placeholder="email@perusahaan.com"
                                    />
                                </div>
                            </div>

                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors disabled:opacity-50"
                            >
                                {loading ? "Memproses..." : "Kirim Tautan Reset"}
                            </button>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
}
