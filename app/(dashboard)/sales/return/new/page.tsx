"use client";

import { useState } from "react";
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { accurateFetch } from "@/lib/apiFetcher";
import { toast } from "sonner";
import { ArrowLeft, Save, FileText, ArrowLeftRight, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AsyncSearchSelect } from "@/components/ui/AsyncSearchSelect";

const returnSchema = z.object({
    customer: z.object({ label: z.string(), value: z.string() }),
    transDate: z.string().min(1, "Tanggal retur wajib diisi"),
    number: z.string().optional(),
    description: z.string().optional(),
    details: z.array(z.object({
        item: z.object({ label: z.string(), value: z.string(), originalData: z.any() }),
        quantity: z.number().min(1, "Minimal 1"),
        unitPrice: z.number().min(0),
    })).min(1, "Minimal satu barang yang diretur"),
});

type ReturnFormValues = z.infer<typeof returnSchema>;

export default function NewSalesReturn() {
    const router = useRouter();
    const [isSubmitting, setIsSubmitting] = useState(false);

    const {
        register,
        handleSubmit,
        control,
        watch,
        setValue,
        formState: { errors },
    } = useForm<ReturnFormValues>({
        resolver: zodResolver(returnSchema),
        defaultValues: {
            transDate: new Date().toISOString().split('T')[0],
            number: "",
            description: "",
            details: [],
        },
    });

    const { fields, append, remove } = useFieldArray({
        control,
        name: "details",
    });

    const watchDetails = watch("details");
    
    const calculateTotal = () => {
        return watchDetails.reduce((sum, row) => sum + ((row.quantity || 0) * (row.unitPrice || 0)), 0);
    };

    const onSubmit = async (data: ReturnFormValues) => {
        setIsSubmitting(true);
        try {
            // Mapping for Accurate structure
            const payload: any = {
                customerNo: data.customer.value,
                transDate: data.transDate.split("-").reverse().join("/"), // yyyy-mm-dd -> dd/mm/yyyy
                description: data.description,
            };

            if (data.number) payload.number = data.number;

            // Mapping details
            data.details.forEach((row, index) => {
                payload[`detailItem[${index}].itemNo`] = row.item.value;
                payload[`detailItem[${index}].quantity`] = row.quantity;
                payload[`detailItem[${index}].unitPrice`] = row.unitPrice;
            });

            const response = await accurateFetch("/api/sales-return/save.do", "POST", payload);

            if (response.s) {
                toast.success("Retur Penjualan berhasil dibuat!", {
                    description: `No: ${response.d[0]?.number || "Otomatis"}`,
                });
                router.push("/sales/return");
            } else {
                toast.error("Gagal membuat Retur", {
                    description: response.d || "Respons tidak valid",
                });
            }
        } catch (error: any) {
            toast.error("Terjadi Kesalahan", {
                description: error.message,
            });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="flex flex-col h-full gap-6 pb-12">
            {/* Header Area */}
            <div className="flex items-center justify-between bg-[#16181d]/80 rounded-2xl border border-white/5 shadow-2xl p-4 backdrop-blur-md sticky top-0 z-20">
                <div className="flex items-center gap-3">
                    <Link href="/sales/return" className="p-2 hover:bg-white/5 rounded-lg transition-colors text-slate-400 hover:text-white">
                        <ArrowLeft size={20} />
                    </Link>
                    <div className="w-px h-6 bg-white/10 mx-2"></div>
                    <div className="flex items-center gap-2">
                        <ArrowLeftRight size={18} className="text-indigo-400" />
                        <h1 className="text-lg font-bold text-white tracking-tight">Retur Penjualan Baru</h1>
                    </div>
                </div>
                
                <button 
                    onClick={handleSubmit(onSubmit)}
                    disabled={isSubmitting}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all shadow-lg shadow-indigo-600/20"
                >
                    {isSubmitting ? (
                        <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                    ) : <Save size={16} />}
                    {isSubmitting ? "Menyimpan data..." : "Simpan Data"}
                </button>
            </div>

            <div className="bg-[#16181d]/80 rounded-2xl border border-white/5 shadow-2xl p-6 backdrop-blur-md space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="space-y-4">
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium text-slate-300">
                                Pelanggan <span className="text-red-400">*</span>
                            </label>
                            <Controller
                                name="customer"
                                control={control}
                                render={({ field }) => (
                                    <AsyncSearchSelect
                                        placeholder="Cari Pelanggan..."
                                        endpoint="/api/customer/list.do"
                                        valueField="customerNo"
                                        labelField={(item) => `[${item.customerNo || item.no || '?'}] ${item.name}`}
                                        value={field.value}
                                        onChange={field.onChange}
                                        error={errors.customer?.message}
                                        required
                                    />
                                )}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium text-slate-300">
                                Keterangan
                            </label>
                            <textarea
                                {...register("description")}
                                className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all resize-none h-24"
                                placeholder="Catatan retur..."
                            />
                        </div>
                    </div>

                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-slate-300">
                                    No Bukti Retur
                                </label>
                                <input 
                                    {...register("number")}
                                    className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all font-mono text-sm disabled:opacity-50"
                                    placeholder="Otomatis"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-slate-300">
                                    Tgl. Retur <span className="text-red-400">*</span>
                                </label>
                                <input 
                                    type="date"
                                    {...register("transDate")}
                                    className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all [color-scheme:dark]"
                                />
                                {errors.transDate && <p className="text-xs text-red-400 mt-1">{errors.transDate.message}</p>}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Item Details Grid */}
            <div className="bg-[#16181d]/80 rounded-2xl border border-white/5 shadow-2xl overflow-hidden backdrop-blur-md flex flex-col">
                <div className="p-4 border-b border-white/5 flex items-center justify-between">
                    <h3 className="text-sm font-bold tracking-wide text-slate-300 flex items-center gap-2">
                        <FileText size={16} className="text-indigo-400" />
                        Rincian Barang Diretur
                    </h3>
                    <button 
                        type="button"
                        onClick={() => append({ item: undefined as any, quantity: 1, unitPrice: 0 })}
                        className="text-xs bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 border border-indigo-500/30"
                    >
                        <Plus size={14} /> Tambah Baris
                    </button>
                </div>

                <div className="w-full overflow-x-auto">
                    <table className="w-full text-left text-sm text-slate-400">
                        <thead className="text-xs uppercase bg-[#0a0a0c]/50 text-slate-500 border-b border-white/5 font-semibold">
                            <tr>
                                <th scope="col" className="px-6 py-3 min-w-[300px]">Cari Barang</th>
                                <th scope="col" className="px-6 py-3 w-32 text-right">Kts Diretur</th>
                                <th scope="col" className="px-6 py-3 w-48 text-right">Harga Satuan</th>
                                <th scope="col" className="px-6 py-3 w-48 text-right">Total</th>
                                <th scope="col" className="px-6 py-3 text-center w-16"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {fields.map((field, index) => (
                                <tr key={field.id} className="hover:bg-white/[0.02] transition-colors group">
                                    <td className="px-6 py-3">
                                        <Controller
                                            name={`details.${index}.item`}
                                            control={control}
                                            render={({ field }) => (
                                                <AsyncSearchSelect
                                                    placeholder="Ketik nama atau kode barang..."
                                                    endpoint="/api/item/list.do"
                                                    valueField="no"
                                                    labelField={(item) => `[${item.no}] ${item.name}`}
                                                    value={field.value}
                                                    onChange={(val) => {
                                                        field.onChange(val);
                                                        // Auto-fill price
                                                        if (val && val.originalData && val.originalData.unitPrice) {
                                                            setValue(`details.${index}.unitPrice`, val.originalData.unitPrice);
                                                        }
                                                    }}
                                                />
                                            )}
                                        />
                                    </td>
                                    <td className="px-6 py-3 text-right">
                                        <input 
                                            {...register(`details.${index}.quantity`, { valueAsNumber: true })}
                                            type="number"
                                            min="1"
                                            className="w-full text-right bg-transparent border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-indigo-500"
                                        />
                                    </td>
                                    <td className="px-6 py-3 text-right">
                                        <input 
                                            {...register(`details.${index}.unitPrice`, { valueAsNumber: true })}
                                            type="number"
                                            min="0"
                                            className="w-full text-right bg-transparent border border-white/10 rounded-lg px-3 py-2 text-white outline-none focus:border-indigo-500"
                                        />
                                    </td>
                                    <td className="px-6 py-3 text-right text-emerald-400 font-medium">
                                        {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format((watchDetails[index]?.quantity || 0) * (watchDetails[index]?.unitPrice || 0))}
                                    </td>
                                    <td className="px-6 py-3 text-center">
                                        <button 
                                            type="button" 
                                            onClick={() => remove(index)}
                                            className="text-slate-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                            {fields.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-6 py-8 text-center text-slate-500 italic">
                                        Belum ada barang yang diretur.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Total Footer */}
            <div className="flex justify-end mt-4">
                <div className="bg-[#16181d]/80 rounded-2xl border border-white/5 shadow-2xl p-6 backdrop-blur-md min-w-[300px]">
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-400">Total Nilai Retur</span>
                        <span className="text-2xl font-bold text-amber-400">
                            {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(calculateTotal())}
                        </span>
                    </div>
                </div>
            </div>

            {/* Main Validation Errors */}
            {(errors.customer || errors.details) && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm">
                    {errors.customer?.message || errors.details?.message}
                    {errors.details && typeof errors.details === 'object' && Array.isArray(errors.details) && (
                        <ul className="list-disc pl-5 mt-1 opacity-80">
                            {errors.details.map((err, i) => err && <li key={i}>Baris {i+1}: {err.item?.message || err.quantity?.message || err.unitPrice?.message}</li>)}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
