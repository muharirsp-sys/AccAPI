"use client";

import { ShoppingCart } from "lucide-react";

export default function SalesDashboard() {
    return (
        <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4 mt-20">
            <ShoppingCart size={64} className="text-indigo-500/50" />
            <h1 className="text-2xl font-bold text-white">Modul Penjualan</h1>
            <p className="max-w-md text-center">Silakan pilih sub-modul seperti "Penerimaan Penjualan" di sidebar navigasi kiri.</p>
        </div>
    );
}
