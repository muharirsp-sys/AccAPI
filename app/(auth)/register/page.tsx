import Link from "next/link";
import { UserPlus } from "lucide-react";

export default function RegisterPage() {
    return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
                <div className="bg-gradient-to-r from-blue-600 to-indigo-700 p-8 text-white text-center">
                    <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-white/15 flex items-center justify-center">
                        <UserPlus className="h-6 w-6" />
                    </div>
                    <h2 className="text-3xl font-extrabold tracking-tight">Pendaftaran Internal</h2>
                    <p className="mt-2 text-blue-100 text-sm">Akun dibuat dan diatur oleh admin.</p>
                </div>

                <div className="p-8 text-center space-y-5">
                    <p className="text-sm text-slate-600 leading-6">
                        Untuk menjaga akses sistem tetap internal, pendaftaran publik dinonaktifkan.
                        Minta admin membuat akun dan menentukan role Anda.
                    </p>
                    <Link
                        href="/login"
                        className="inline-flex w-full justify-center py-3 px-4 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                    >
                        Kembali ke Login
                    </Link>
                </div>
            </div>
        </div>
    );
}
