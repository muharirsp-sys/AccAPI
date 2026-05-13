"use client";

import { Database } from "lucide-react";

export default function MasterDashboard() {
    return (
        <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4 mt-20">
            <Database size={64} className="text-indigo-500/50" />
            <h1 className="text-2xl font-bold text-white">Master Data Dashboard</h1>
            <p className="max-w-md text-center">Modul ini akan segera hadir. Di sini Anda akan mengelola data Pelanggan, Pemasok, dan Barang & Jasa.</p>
        </div>
    );
}
