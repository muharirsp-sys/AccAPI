"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { accurateFetch } from "@/lib/apiFetcher";
import { toast } from "sonner";
import { ArrowLeft, Save, Users, Building, Phone } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AsyncSearchSelect } from "@/components/ui/AsyncSearchSelect";

const customerSchema = z.object({
    name: z.string().min(1, "Nama Pelanggan wajib diisi"),
    no: z.string().optional(),
    email: z.string().email("Format email tidak valid").optional().or(z.literal("")),
    workPhone: z.string().optional(),
    customerCategory: z.object({
        label: z.string(),
        value: z.string(),
    }).optional(),
});

type CustomerFormValues = z.infer<typeof customerSchema>;

export default function NewCustomer() {
    const router = useRouter();
    const [isSubmitting, setIsSubmitting] = useState(false);

    const {
        register,
        handleSubmit,
        control,
        formState: { errors },
    } = useForm<CustomerFormValues>({
        resolver: zodResolver(customerSchema),
        defaultValues: {
            name: "",
            no: "",
            email: "",
            workPhone: "",
        },
    });

    const onSubmit = async (data: CustomerFormValues) => {
        setIsSubmitting(true);
        try {
            const payload: any = {
                name: data.name,
                email: data.email,
                workPhone: data.workPhone,
            };

            if (data.no) payload.no = data.no;
            if (data.customerCategory) payload.customerCategoryId = Number(data.customerCategory.value);

            const response = await accurateFetch("/api/customer/save.do", "POST", payload);

            if (response.s && response.d?.[0]?.id) {
                // Dual-Write: Instantly Sync to Local SQLite
                try {
                    await fetch("/api/local/customers/sync-single", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: response.d[0].id })
                    });
                } catch (e: any) {
                    console.warn("Failed immediate SQLite sync", e);
                }

                toast.success("Pelanggan berhasil disimpan!", {
                    description: `ID: ${response.d[0].id}`,
                });
                router.push("/master/customer");
            } else {
                toast.error("Gagal menyimpan Pelanggan", {
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
                    <Link href="/master/customer" className="p-2 hover:bg-white/5 rounded-lg transition-colors text-slate-400 hover:text-white">
                        <ArrowLeft size={20} />
                    </Link>
                    <div className="w-px h-6 bg-white/10 mx-2"></div>
                    <div className="flex items-center gap-2">
                        <Users size={18} className="text-indigo-400" />
                        <h1 className="text-lg font-bold text-white tracking-tight">Pelanggan Baru</h1>
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
                        <Building size={16} className="text-slate-400" /> Informasi Utama
                    </h3>
                    
                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-300">
                            Kategori <span className="text-red-400">*</span>
                        </label>
                        <Controller
                            name="customerCategory"
                            control={control}
                            render={({ field }) => (
                                <AsyncSearchSelect
                                    placeholder="Umum"
                                    endpoint="/api/customer-category/list.do"
                                    valueField="id"
                                    labelField="name"
                                    value={field.value}
                                    onChange={field.onChange}
                                />
                            )}
                        />
                        <p className="text-xs text-slate-500">Kosongkan jika Umum</p>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-300">
                            Nama Pelanggan <span className="text-red-400">*</span>
                        </label>
                        <input 
                            {...register("name")}
                            className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                            placeholder="PT. Bintang Mode..."
                        />
                        {errors.name && <p className="text-xs text-red-400 mt-1">{errors.name.message}</p>}
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-300">
                            No. Pelanggan
                        </label>
                        <input 
                            {...register("no")}
                            className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all font-mono text-sm"
                            placeholder="Otomatis jika dikosongkan"
                        />
                    </div>
                </div>

                <div className="bg-[#16181d]/80 rounded-2xl border border-white/5 shadow-2xl p-6 backdrop-blur-md space-y-5">
                    <h3 className="text-base font-semibold text-white flex items-center gap-2 border-b border-white/10 pb-3 mb-4">
                        <Phone size={16} className="text-slate-400" /> Kontak Pribadi
                    </h3>

                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-300">
                            Email
                        </label>
                        <input 
                            {...register("email")}
                            type="email"
                            className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                            placeholder="email@perusahaan.com"
                        />
                        {errors.email && <p className="text-xs text-red-400 mt-1">{errors.email.message}</p>}
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-sm font-medium text-slate-300">
                            No. Telepon Binis
                        </label>
                        <input 
                            {...register("workPhone")}
                            className="w-full bg-[#0a0a0c]/50 border border-white/10 text-white rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                            placeholder="021-..."
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
