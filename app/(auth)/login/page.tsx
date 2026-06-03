"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Lock, Mail } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import AppButton from "@/components/ui/AppButton";
import AppInput from "@/components/ui/AppInput";

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
        <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4 dark:bg-gray-900">
            <div className="w-full max-w-[420px]">
                <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-theme-md dark:border-gray-800 dark:bg-white/[0.03]">
                    <div className="mb-8 text-center">
                        <h2 className="text-2xl font-bold text-gray-800 dark:text-white/90">
                            Portal CV. Surya Perkasa
                        </h2>
                        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                            Masuk ke sistem kontrol
                        </p>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-5">
                        <AppInput
                            label="Email"
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="email@perusahaan.com"
                            icon={<Mail className="h-5 w-5" />}
                            className="h-12"
                        />

                        <div>
                            <div className="mb-1.5 flex items-center justify-between">
                                <span className="text-sm font-medium text-gray-700 dark:text-gray-400">
                                    Password
                                </span>
                                <Link
                                    href="/forgot-password"
                                    className="text-sm font-semibold text-brand-500 hover:text-brand-600 dark:text-brand-400"
                                >
                                    Lupa Password?
                                </Link>
                            </div>
                            <AppInput
                                type="password"
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="••••••••"
                                icon={<Lock className="h-5 w-5" />}
                                className="h-12"
                            />
                        </div>

                        <AppButton
                            type="submit"
                            disabled={loading}
                            className="h-12 w-full"
                        >
                            {loading ? "Memproses..." : "Masuk"}
                        </AppButton>
                    </form>

                    <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
                        Akun dibuat oleh admin internal.
                    </p>
                </div>

                <p className="mt-6 text-center text-sm text-gray-400 dark:text-gray-600">
                    &copy; 2026 Muh. Ari Ramadhan
                </p>
            </div>
        </div>
    );
}
