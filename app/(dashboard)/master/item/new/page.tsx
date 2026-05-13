"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { accurateFetch } from "@/lib/apiFetcher";
import { toast } from "sonner";
import { ArrowLeft, Save, Package, Tag, Layers } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AsyncSearchSelect } from "@/components/ui/AsyncSearchSelect";

const itemSchema = z.object({
    name: z.string().min(1, "Nama Barang wajib diisi"),
    no: z.string().optional(),
    itemType: z.enum(["INVENTORY", "NON_INVENTORY", "SERVICE", "GROUP"]),
    unitPrice: z.number().min(0, "Harga tidak valid").optional(),
    upcNo: z.string().optional(),
    itemCategory: z.object({
        label: z.string(),
        value: z.string(),
    }).optional(),
});

type ItemFormValues = z.infer<typeof itemSchema>;

export default function NewItem() {
    const router = useRouter();
    const [isSubmitting, setIsSubmitting] = useState(false);

    const {
        register,
        handleSubmit,
        control,
        formState: { errors },
    } = useForm<ItemFormValues>({
        resolver: zodResolver(itemSchema),
        defaultValues: {
            name: "",
            no: "",
            itemType: "INVENTORY",
            unitPrice: 0,
            upcNo: "",
        },
    });

    const onSubmit = async (data: ItemFormValues) => {
        setIsSubmitting(true);
        try {
            const payload: any = {
                name: data.name,
                itemType: data.itemType,
                unitPrice: data.unitPrice,
                upcNo: data.upcNo,
            };

            if (data.no) payload.no = data.no;
            if (data.itemCategory) payload.itemCategoryId = Number(data.itemCategory.value);

            const response = await accurateFetch("/api/item/save.do", "POST", payload);

            if (response.s && response.d?.[0]?.id) {
                // Dual-Write: Instantly Sync to Local SQLite
                try {
                    await fetch("/api/local/items/sync-single", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: response.d[0].id })
                    });
                } catch (e: any) {
                    console.warn("Failed immediate SQLite sync", e);
                }

                toast.success("Barang & Jasa berhasil disimpan!", {
                    description: `ID: ${response.d[0].id}`,
                });
                router.push("/master/item");
            } else {
                toast.error("Gagal menyimpan Barang", {
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
                    <Link href="/master/item" className="p-2 hover:bg-white/5 rounded-lg transition-colors text-slate-400 hover:text-white">
                        <ArrowLeft size={20} />
                    </Link>
                    <div className="w-px h-6 bg-white/10 mx-2"></div>
                    <div className="flex items-center gap-2">
                        <Package size={18} className="text-indigo-400" />
                        <h1 className="text-lg font-bold text-white tracking-tight">Barang / Jasa Baru</h1>
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

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-[#16181d]/80 rounded-2xl border border-white/5 shadow-2xl p-6 backdrop-blur-md space-y-5">
                    <h3 className="text-base font-semibold text-white flex items-center gap-2 border-b border-white/10 pb-3 mb-4">
                        <Layers size={16} className="text-slate-400" /> Klasifikasi Barang
                    </h3>
                    
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-300">
                            Tipe Barang <span className="text-red-400">*</span>
                        </label>
                        <select 
                            {...register("itemType")}
                            className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all appearance-none"
                        >
                            <option value="INVENTORY">Persediaan</option>
                            <option value="NON_INVENTORY">Non Persediaan</option>
                            <option value="SERVICE">Jasa</option>
                            <option value="GROUP">Grup</option>
                        </select>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-300">
                            Kategori Barang
                        </label>
                        <Controller
                            name="itemCategory"
                            control={control}
                            render={({ field }) => (
                                <AsyncSearchSelect
                                    placeholder="Umum"
                                    endpoint="/api/item-category/list.do"
                                    valueField="id"
                                    labelField="name"
                                    value={field.value}
                                    onChange={field.onChange}
                                />
                            )}
                        />
                    </div>
                </div>

                <div className="bg-[#16181d]/80 rounded-2xl border border-white/5 shadow-2xl p-6 backdrop-blur-md space-y-5">
                    <h3 className="text-base font-semibold text-white flex items-center gap-2 border-b border-white/10 pb-3 mb-4">
                        <Tag size={16} className="text-slate-400" /> Detail Barang & Jasa
                    </h3>

                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-300">
                            Nama Barang / Jasa <span className="text-red-400">*</span>
                        </label>
                        <input 
                            {...register("name")}
                            className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                            placeholder="Minyak Goreng 1L"
                        />
                        {errors.name && <p className="text-xs text-red-400 mt-1">{errors.name.message}</p>}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium text-slate-300">
                                Kode Barang
                            </label>
                            <input 
                                {...register("no")}
                                className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all font-mono text-sm"
                                placeholder="(Otomatis)"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-sm font-medium text-slate-300">
                                Kode Barcode (UPC)
                            </label>
                            <input 
                                {...register("upcNo")}
                                className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all font-mono text-sm"
                                placeholder="..."
                            />
                        </div>
                    </div>

                    <div className="space-y-1.5 pt-2">
                        <label className="text-sm font-medium text-slate-300 mb-2 block">
                            Harga Jual Dasar
                        </label>
                        <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium tracking-wide">Rp</span>
                            <input 
                                {...register("unitPrice", { valueAsNumber: true })}
                                type="number"
                                className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl pl-10 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                                placeholder="0"
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
