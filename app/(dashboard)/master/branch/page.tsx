"use client";

import { useEffect, useState, useMemo } from "react";
import { accurateFetch } from "@/lib/apiFetcher";
import { toast } from "sonner";
import { DataTable } from "@/components/DataTable";
import { Loader2, GitBranch, Plus, FileUp, AlertTriangle } from "lucide-react";
import { ColumnDef } from "@tanstack/react-table";

interface Branch {
    id: number;
    no: string;
    name: string;
    suspended?: boolean;
}

export default function BranchList() {
    const [data, setData] = useState<Branch[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchBranches = async () => {
            try {
                const payload = {
                    fields: "id,no,name,suspended",
                };
                const response = await accurateFetch("/api/branch/list.do", "GET", payload);
                if (response && response.d) {
                    setData(response.d);
                } else {
                    setData([]);
                }
            } catch (err: any) {
                setError(err.message);
                toast.error("Gagal memuat data Cabang");
            } finally {
                setIsLoading(false);
            }
        };

        fetchBranches();
    }, []);

    const columns = useMemo<ColumnDef<Branch>[]>(() => [
        {
            accessorKey: "no",
            header: "Kode Cabang",
            cell: (info) => <span className="font-medium text-slate-300">{info.getValue() as string}</span>,
        },
        {
            accessorKey: "name",
            header: "Nama Cabang",
            cell: (info) => <span className="font-bold text-indigo-300">{info.getValue() as string}</span>,
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
                        <GitBranch className="text-indigo-400" /> Cabang
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">Daftar entitas operasional cabang.</p>
                </div>
                <div className="flex items-center gap-3">
                    <button className="flex items-center gap-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-lg shadow-indigo-500/10">
                        <FileUp size={16} />
                        Upload Massal
                    </button>
                    <button 
                        onClick={() => window.location.href = '/master/branch/new'}
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
                        <p className="text-slate-300 font-medium">Memuat data cabang...</p>
                    </div>
                ) : null}
                
                <DataTable data={data} columns={columns} searchPlaceholder="Cari nama cabang..." />
            </div>
        </div>
    );
}
