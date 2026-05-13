"use client";

import { useEffect, useState, useMemo } from "react";
import { accurateFetch } from "@/lib/apiFetcher";
import { toast } from "sonner";
import { DataTable } from "@/components/DataTable";
import { Loader2, Package, Plus, FileUp, AlertTriangle } from "lucide-react";
import { ColumnDef } from "@tanstack/react-table";

interface Item {
    id: number;
    no: string;
    name: string;
    upcNo?: string;
    unitPrice?: number;
    itemType?: string;
    suspended?: boolean;
}

export default function ItemList() {
    const [data, setData] = useState<Item[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchItems = async () => {
            try {
                // Fetching common fields for items instantly from Local SQLite
                const response = await fetch("/api/local/items").then(res => res.json());
                
                if (response && response.d) {
                    setData(response.d);
                } else {
                    setData([]);
                }
            } catch (err: any) {
                setError(err.message);
                toast.error("Gagal memuat data barang & jasa");
            } finally {
                setIsLoading(false);
            }
        };

        fetchItems();
    }, []);

    const columns = useMemo<ColumnDef<Item>[]>(() => [
        {
            accessorKey: "no",
            header: "No. Barang",
            cell: (info) => <span className="font-medium text-slate-300">{info.getValue() as string}</span>,
        },
        {
            accessorKey: "name",
            header: "Nama Barang / Jasa",
            cell: (info) => <span className="font-bold text-indigo-300">{info.getValue() as string}</span>,
        },
        {
            accessorKey: "itemType",
            header: "Tipe",
            cell: (info) => {
                const type = info.getValue() as string;
                let badgeClass = "bg-slate-500/20 text-slate-300 border-slate-500/30";
                let label = type;
                
                if (type === 'INVENTORY') { badgeClass = "bg-blue-500/20 text-blue-400 border-blue-500/30"; label = "Persediaan"; }
                if (type === 'NON_INVENTORY') { badgeClass = "bg-amber-500/20 text-amber-400 border-amber-500/30"; label = "Non Persediaan"; }
                if (type === 'SERVICE') { badgeClass = "bg-purple-500/20 text-purple-400 border-purple-500/30"; label = "Jasa"; }
                if (type === 'GROUP') { badgeClass = "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"; label = "Barang Grup"; }

                return (
                    <span className={`px-2 py-0.5 rounded text-xs font-medium border ${badgeClass}`}>
                        {label || type}
                    </span>
                );
            }
        },
        {
            accessorKey: "upcNo",
            header: "Kode Barcode",
            cell: (info) => <span className="text-slate-400">{info.getValue() as string || '-'}</span>,
        },
        {
            accessorKey: "unitPrice",
            header: "Harga Jual Dasar",
            cell: (info) => (
                <span className="text-right block font-medium">
                    {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(info.getValue()) || 0)}
                </span>
            ),
        },
        {
            accessorKey: "suspended",
            header: "Status",
            cell: (info) => (
                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                    info.getValue() ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-green-500/20 text-green-400 border border-green-500/30'
                }`}>
                    {info.getValue() ? 'Nonaktif' : 'Aktif'}
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
                        <Package className="text-indigo-400" /> Barang & Jasa
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">Kelola data master inventori Anda.</p>
                </div>
                <div className="flex items-center gap-3">
                    <button className="flex items-center gap-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-lg shadow-indigo-500/10">
                        <FileUp size={16} />
                        Upload Massal
                    </button>
                    <button 
                        onClick={() => window.location.href = '/master/item/new'}
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
                        <p className="text-slate-300 font-medium">Memuat data barang...</p>
                    </div>
                ) : null}
                
                <DataTable data={data} columns={columns} searchPlaceholder="Cari barang atau jasa..." />
            </div>
        </div>
    );
}
