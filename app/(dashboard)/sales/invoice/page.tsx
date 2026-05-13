"use client";

import { useEffect, useState, useMemo } from "react";
import { accurateFetch } from "@/lib/apiFetcher";
import { toast } from "sonner";
import { DataTable } from "@/components/DataTable";
import { Loader2, FileText, Plus, FileUp, AlertTriangle } from "lucide-react";
import { ColumnDef } from "@tanstack/react-table";

interface SalesInvoice {
    id: number;
    number: string;
    transDate: string;
    customer: { name: string; no: string };
    totalAmount: number;
    primeOwing: number;
    description?: string;
}

export default function SalesInvoiceList() {
    const [data, setData] = useState<SalesInvoice[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchInvoices = async () => {
            try {
                // Fetching common fields for Sales Invoices
                const payload = {
                    fields: "id,number,transDate,customer,totalAmount,primeOwing,description",
                };
                const response = await accurateFetch("/api/sales-invoice/list.do", "GET", payload);
                if (response && response.d) {
                    setData(response.d);
                } else {
                    setData([]);
                }
            } catch (err: any) {
                setError(err.message);
                toast.error("Gagal memuat data Faktur Penjualan");
            } finally {
                setIsLoading(false);
            }
        };

        fetchInvoices();
    }, []);

    const columns = useMemo<ColumnDef<SalesInvoice>[]>(() => [
        {
            accessorKey: "number",
            header: "No. Faktur",
            cell: (info) => <span className="font-medium text-slate-300">{info.getValue() as string}</span>,
        },
        {
            accessorKey: "transDate",
            header: "Tgl. Faktur",
            cell: (info) => {
                const rawDate = info.getValue() as string;
                if (!rawDate) return "-";
                // Mengubah format dd/MM/yyyy menjadi object Date JavaScript (MM/dd/yyyy untuk JS standard constructor jika string)
                // Accurate return string like '22/03/2026'
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
            header: "Total Faktur",
            cell: (info) => (
                <span className="text-right block font-medium">
                    {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(info.getValue()) || 0)}
                </span>
            ),
        },
        {
            accessorKey: "primeOwing",
            header: "Sisa Tagihan",
            cell: (info) => {
                const val = Number(info.getValue()) || 0;
                return (
                    <span className={`text-right block font-bold ${val > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val)}
                    </span>
                );
            }
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
                        <FileText className="text-indigo-400" /> Faktur Penjualan
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">Kelola daftar tagihan piutang belum terbayar maupun lunas.</p>
                </div>
                <div className="flex items-center gap-3">
                    <button className="flex items-center gap-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-lg shadow-indigo-500/10">
                        <FileUp size={16} />
                        Upload Massal
                    </button>
                    <button 
                        onClick={() => window.location.href = '/sales/invoice/new'}
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
                        <p className="text-slate-300 font-medium">Memuat faktur...</p>
                    </div>
                ) : null}
                
                <DataTable data={data} columns={columns} searchPlaceholder="Cari nomor pelangan atau faktur..." />
            </div>
        </div>
    );
}
