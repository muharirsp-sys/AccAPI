"use client";

import { useEffect, useState, useMemo } from "react";
import { accurateFetch } from "@/lib/apiFetcher";
import { DataTable } from "@/components/DataTable";
import { ColumnDef } from "@tanstack/react-table";
import { FileUp, Plus } from "lucide-react";

// Tipe data berdasarkan respons Accurate `/api/sales-receipt/list.do`
interface SalesReceipt {
    id: number;
    number: string;
    transDate: string;
    chequeAmount: number;
    customer: {
        name: string;
        no: string;
    } | null;
    status: string;
    bank: { name: string } | null;
    description: string;
    branch: { name: string } | null;
    void: boolean;
}

export default function SalesReceiptList() {
    const [data, setData] = useState<SalesReceipt[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        // Fetch data upon mount if session exists
        const loadAOLData = async () => {
            try {
                // Fields to request from Accurate UI
                const payload = {
                    fields: "id,number,transDate,chequeAmount,customer,status,bank,description,branch,void",
                };
                
                const response = await accurateFetch("/api/sales-receipt/list.do", "GET", payload);
                if (response && response.d) {
                    setData(response.d);
                }
            } catch (err) {
                console.error("Failed to load Sales Receipts:", err);
            } finally {
                setIsLoading(false);
            }
        };

        loadAOLData();
    }, []);

    // Definisikan Kolom TanStack Table
    const columns = useMemo<ColumnDef<SalesReceipt>[]>(() => [
        {
            id: "select",
            header: ({ table }) => (
                <div className="flex items-center justify-center">
                    <input
                        type="checkbox"
                        className="w-4 h-4 rounded border-white/20 bg-black/20 text-indigo-500 focus:ring-indigo-500/50"
                        checked={table.getIsAllPageRowsSelected()}
                        onChange={table.getToggleAllPageRowsSelectedHandler()}
                    />
                </div>
            ),
            cell: ({ row }) => (
                <div className="flex items-center justify-center">
                    <input
                        type="checkbox"
                        className="w-4 h-4 rounded border-white/20 bg-black/20 text-indigo-500 focus:ring-indigo-500/50"
                        checked={row.getIsSelected()}
                        onChange={row.getToggleSelectedHandler()}
                    />
                </div>
            ),
        },
        {
            accessorKey: "number",
            header: "Nomor #",
            cell: (info) => <span className="font-semibold text-indigo-200">{info.getValue() as string}</span>,
        },
        {
            accessorKey: "transDate",
            header: "Tanggal",
            cell: (info) => {
                const rawDate = info.getValue() as string;
                if (!rawDate) return "-";
                
                // If the date string already matches a display format (e.g. DD/MM/YYYY)
                if (rawDate.includes('/')) return rawDate;

                try {
                    const parsedDate = new Date(rawDate);
                    // Check if the date is invalid (NaN in getTime)
                    if (isNaN(parsedDate.getTime())) return rawDate;

                    return new Intl.DateTimeFormat('id-ID', {
                        day: '2-digit', month: '2-digit', year: 'numeric'
                    }).format(parsedDate);
                } catch (err) {
                    return rawDate;
                }
            },
        },
        {
            accessorKey: "customer.name",
            header: "Pelanggan",
            cell: (info) => (info.getValue() as string) || "-",
        },
        {
            accessorKey: "chequeAmount",
            header: "Nilai Cek",
            cell: (info) => {
                const amount = info.getValue() as number;
                return new Intl.NumberFormat('id-ID', {
                    style: 'currency', currency: 'IDR', minimumFractionDigits: 0
                }).format(amount || 0);
            },
        },
        {
            accessorKey: "status",
            header: "Status",
            cell: (info) => {
                const status = info.getValue() as string;
                let bg = "bg-slate-500/20 text-slate-300 border-slate-500/30";
                
                if (status === "APPROVED") bg = "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
                if (status === "UNAPPROVED") bg = "bg-amber-500/20 text-amber-300 border-amber-500/30";
                
                return (
                    <span className={`px-2.5 py-1 text-xs font-medium rounded-full border ${bg}`}>
                        {status}
                    </span>
                );
            }
        },
        {
            accessorKey: "bank.name",
            header: "Bank",
            cell: (info) => (info.getValue() as string) || "-",
        },
        {
            accessorKey: "branch.name",
            header: "Cabang",
            cell: (info) => (info.getValue() as string) || "-",
        },
        {
            accessorKey: "description",
            header: "Keterangan",
            cell: (info) => {
                const desc = info.getValue() as string;
                return desc ? <span className="truncate max-w-[200px] block" title={desc}>{desc}</span> : "-";
            },
        },
        {
            accessorKey: "void",
            header: "Void",
            cell: (info) => {
                const isVoid = info.getValue() as boolean;
                return isVoid 
                    ? <span className="text-red-400 font-semibold text-xs border border-red-500/30 bg-red-500/10 px-2 py-0.5 rounded">Ya</span> 
                    : <span className="text-slate-500 text-xs">Tidak</span>;
            }
        }
    ], []);

    return (
        <div className="flex flex-col h-full gap-6 max-w-7xl mx-auto w-full">
            {/* Header Module */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-white tracking-tight">Penerimaan Penjualan</h1>
                    <p className="text-sm text-slate-400 mt-1">Daftar transaksi penerimaan dari pelanggan.</p>
                </div>
                
                <div className="flex items-center gap-3">
                    <button className="flex items-center gap-2 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-lg shadow-indigo-500/10">
                        <FileUp size={16} />
                        Upload Massal
                    </button>
                    <button 
                        onClick={() => window.location.href = '/sales/receipt/new'}
                        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-lg shadow-indigo-600/20"
                    >
                        <Plus size={16} />
                        Data Baru
                    </button>
                </div>
            </div>

            {/* Data Grid Area */}
            <div className="flex-1 w-full min-h-0">
                <DataTable 
                    columns={columns} 
                    data={data}
                    isLoading={isLoading} 
                />
            </div>
        </div>
    );
}
