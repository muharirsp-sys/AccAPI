"use client";

import { useEffect, useState, useMemo } from "react";
import { accurateFetch } from "@/lib/apiFetcher";
import { toast } from "sonner";
import { DataTable } from "@/components/DataTable";
import { Loader2, ArrowLeftRight, Plus, FileUp, AlertTriangle } from "lucide-react";
import { ColumnDef } from "@tanstack/react-table";

interface SalesReturn {
    id: number;
    number: string;
    transDate: string;
    customer: { name: string; no: string };
    totalAmount: number;
    description?: string;
}

export default function SalesReturnList() {
    const [data, setData] = useState<SalesReturn[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchReturns = async () => {
            try {
                // Fetching common fields for Sales Returns
                const payload = {
                    fields: "id,number,transDate,customer,totalAmount,description",
                };
                const response = await accurateFetch("/api/sales-return/list.do", "GET", payload);
                if (response && response.d) {
                    setData(response.d);
                } else {
                    setData([]);
                }
            } catch (err: any) {
                setError(err.message);
                toast.error("Gagal memuat data Retur Penjualan");
            } finally {
                setIsLoading(false);
            }
        };

        fetchReturns();
    }, []);

    const columns = useMemo<ColumnDef<SalesReturn>[]>(() => [
        {
            accessorKey: "number",
            header: "No. Retur",
            cell: (info) => <span className="font-medium text-slate-300">{info.getValue() as string}</span>,
        },
        {
            accessorKey: "transDate",
            header: "Tgl. Retur",
            cell: (info) => {
                const rawDate = info.getValue() as string;
                if (!rawDate) return "-";
                // Mengubah format dd/MM/yyyy menjadi object Date JavaScript
                let dateStr = rawDate;
                if(rawDate.includes('/')) {
                   const [d, m, y] = rawDate.split('/');
                   dateStr = `${y}-${m}-${d}`;
                }
                
                try {
                    return new Intl.DateTimeFormat('id-ID', {
                        day: '2-digit', month: 'short', year: 'numeric'
                    }).format(new Date(dateStr));
                } catch(e) { return rawDate; }
            },
        },
        {
            accessorFn: (row) => row.customer?.name || '-',
            id: "customerName",
            header: "Pelanggan",
            cell: (info) => <span className="font-bold text-indigo-300">{info.getValue() as string}</span>,
        },
        {
            accessorKey: "description",
            header: "Keterangan",
            cell: (info) => <span className="text-slate-400 truncate max-w-[200px] block">{info.getValue() as string || '-'}</span>,
        },
        {
            accessorKey: "totalAmount",
            header: "Total Retur",
            cell: (info) => (
                <span className="text-right block font-medium text-amber-400">
                    {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(info.getValue()) || 0)}
                </span>
            ),
        }
    ], []);

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
                <AlertTriangle size={48} className="text-red-500 opacity-50" />
                <div>
                    <h2 className="text-xl font-bold text-slate-200">Koneksi Terputus</h2>
                    <p className="text-slate-400 max-w-md mx-auto mt-2">{error}</p>
                </div>
                <button 
                    onClick={() => window.location.reload()}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors"
                >
                    Coba Lagi
                </button>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full gap-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
                        <ArrowLeftRight className="text-indigo-400" /> Retur Penjualan
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">Daftar pengembalian barang dari pelanggan.</p>
                </div>
                <div className="flex items-center gap-3">
                    <button className="flex items-center gap-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-lg shadow-indigo-500/10">
                        <FileUp size={16} />
                        Upload Massal
                    </button>
                    <button 
                        onClick={() => window.location.href = '/sales/return/new'}
                        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-lg shadow-indigo-600/20"
                    >
                        <Plus size={16} />
                        Data Baru
                    </button>
                </div>
            </div>

            <div className="flex-1 bg-[#16181d]/80 rounded-2xl border border-white/5 shadow-2xl overflow-hidden backdrop-blur-md relative flex flex-col">
                {isLoading ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm z-10">
                        <Loader2 size={32} className="text-indigo-500 animate-spin mb-4" />
                        <p className="text-slate-300 font-medium">Memuat retur penjulan...</p>
                    </div>
                ) : null}
                
                <DataTable data={data} columns={columns} searchPlaceholder="Cari pelanggan atau no retur..." />
            </div>
        </div>
    );
}
