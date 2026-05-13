"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { accurateFetch } from "@/lib/apiFetcher";
import { toast } from "sonner";
import { ArrowLeft, Save, Box } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const warehouseSchema = z.object({
    name: z.string().min(1, "Nama Gudang wajib diisi"),
    description: z.string().optional(),
});

type WarehouseFormValues = z.infer<typeof warehouseSchema>;

export default function NewWarehouse() {
    const router = useRouter();
    const [isSubmitting, setIsSubmitting] = useState(false);

    const {
        register,
        handleSubmit,
        formState: { errors },
    } = useForm<WarehouseFormValues>({
        resolver: zodResolver(warehouseSchema),
        defaultValues: {
            name: "",
            description: "",
        },
    });

    const onSubmit = async (data: WarehouseFormValues) => {
        setIsSubmitting(true);
        try {
            const payload: any = {
                name: data.name,
                description: data.description,
            };

            const response = await accurateFetch("/api/warehouse/save.do", "POST", payload);

            if (response.s) {
                toast.success("Gudang berhasil disimpan!");
                router.push("/master/warehouse");
            } else {
                toast.error("Gagal menyimpan Gudang", {
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
                    <Link href="/master/warehouse" className="p-2 hover:bg-white/5 rounded-lg transition-colors text-slate-400 hover:text-white">
                        <ArrowLeft size={20} />
                    </Link>
                    <div className="w-px h-6 bg-white/10 mx-2"></div>
                    <div className="flex items-center gap-2">
                        <Box size={18} className="text-indigo-400" />
                        <h1 className="text-lg font-bold text-white tracking-tight">Gudang Baru</h1>
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
                    
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-300">
                            Nama Gudang <span className="text-red-400">*</span>
                        </label>
                        <input 
                            {...register("name")}
                            className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all font-medium"
                            placeholder="Gudang Pusat..."
                        />
                        {errors.name && <p className="text-xs text-red-400 mt-1">{errors.name.message}</p>}
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-300">
                            Keterangan
                        </label>
                        <textarea
                            {...register("description")}
                            className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all resize-none h-24"
                            placeholder="Catatan..."
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
