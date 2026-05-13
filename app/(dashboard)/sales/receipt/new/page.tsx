"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { ArrowLeft, Save, Receipt, Loader2, RotateCcw, Search } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/Input";
import { AsyncSearchSelect } from "@/components/ui/AsyncSearchSelect";
import { accurateFetch } from "@/lib/apiFetcher";

// Zod Schema
const salesReceiptSchema = z.object({
    customer: z.object({
        value: z.string(),
        label: z.string(),
        originalData: z.any().optional()
    }),
    bank: z.object({
        value: z.string(),
        label: z.string(),
        originalData: z.any().optional()
    }),
    transDate: z.string().min(1, "Tanggal transaksi wajib diisi"),
    receiptNumber: z.string().optional(), // No Bukti
    chequeAmount: z.number().min(0, "Nilai pembayaran tidak boleh negatif"),
    description: z.string().optional(),
});

type SalesReceiptFormValues = z.infer<typeof salesReceiptSchema>;

interface OutstandingInvoice {
    id: number;
    number: string;
    transDate: string;
    totalAmount: number;
    primeOwing: number; // Terutang
    paymentAmount: number; // Bayar (Editable)
    selected: boolean;
}

export default function NewSalesReceipt() {
    const router = useRouter();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [outstandingInvoices, setOutstandingInvoices] = useState<OutstandingInvoice[]>([]);
    const [isLoadingInvoices, setIsLoadingInvoices] = useState(false);

    const {
        register,
        control,
        handleSubmit,
        watch,
        setValue,
        formState: { errors },
    } = useForm<SalesReceiptFormValues>({
        resolver: zodResolver(salesReceiptSchema),
        defaultValues: {
            transDate: new Date().toISOString().split('T')[0],
            chequeAmount: 0,
        },
    });

    const selectedCustomer = watch("customer");

    // Efek untuk memuat faktur outstanding ketika pelanggan dipilih
    useEffect(() => {
        if (!selectedCustomer?.value) {
            setOutstandingInvoices([]);
            return;
        }

        const fetchInvoices = async () => {
            setIsLoadingInvoices(true);
            try {
                // Mencari faktur yang belum lunas (UNPAID) untuk pelanggan ini. 
                // Asumsi endpoint dan filter standar Accurate
                const payload = {
                    fields: "id,number,transDate,totalAmount,primeOwing",
                    "filter.customerNo": selectedCustomer.value
                };
                
                const response = await accurateFetch("/api/sales-invoice/list.do", "GET", payload);
                if (response?.d) {
                    // Filter in memory for outstanding invoices > 0
                    const unpaid = response.d
                        .filter((inv: any) => inv.primeOwing > 0)
                        .map((inv: any) => ({
                            ...inv,
                            paymentAmount: 0,
                            selected: false,
                        }));
                    setOutstandingInvoices(unpaid);
                } else {
                    setOutstandingInvoices([]);
                }
            } catch (error) {
                console.error("Gagal memuat faktur pelanggan", error);
                toast.error("Gagal memuat faktur terutang pelanggan");
            } finally {
                setIsLoadingInvoices(false);
            }
        };

        fetchInvoices();
    }, [selectedCustomer?.value]);

    const handleInvoiceToggle = (id: number, checked: boolean) => {
        setOutstandingInvoices(prev => prev.map(inv => {
            if (inv.id === id) {
                const newPaymentAmount = checked ? inv.primeOwing : 0;
                return { ...inv, selected: checked, paymentAmount: newPaymentAmount };
            }
            return inv;
        }));
    };

    const handleInvoicePaymentChange = (id: number, amount: number) => {
        setOutstandingInvoices(prev => prev.map(inv => 
            inv.id === id ? { ...inv, paymentAmount: amount, selected: amount > 0 } : inv
        ));
    };

    // Kalkulasi ulang total bayar tiap kali ada perubahan di grid faktur
    useEffect(() => {
        const totalSelected = outstandingInvoices
            .filter(inv => inv.selected)
            .reduce((sum, inv) => sum + Number(inv.paymentAmount), 0);
            
        if (totalSelected > 0) {
            setValue("chequeAmount", totalSelected);
        }
    }, [outstandingInvoices, setValue]);

    const onSubmit = async (data: SalesReceiptFormValues) => {
        setIsSubmitting(true);
        try {
            // Build detail array dari faktur yang dipilih
            const detailInvoice = outstandingInvoices
                .filter(inv => inv.selected && inv.paymentAmount > 0)
                .map(inv => ({
                    invoiceNo: inv.number,
                    paymentAmount: inv.paymentAmount
                }));

            const accuratePayload = {
                customerNo: data.customer.value,
                transDate: data.transDate.split('-').reverse().join('/'),
                bankNo: data.bank.value,
                chequeAmount: data.chequeAmount,
                receiptNumber: data.receiptNumber || undefined,
                description: data.description || undefined,
                detailInvoice: detailInvoice
            };

            const response = await accurateFetch("/api/sales-receipt/save.do", "POST", accuratePayload);
            
            if (response && response.s) {
                toast.success(`Berhasil menyimpan Penerimaan!`);
                router.push("/sales/receipt");
                router.refresh();
            } else {
                toast.error(response?.d?.[0] || "Gagal menyimpan Penerimaan");
            }
        } catch (error: any) {
            toast.error(error.message || "Gagal menghubungkan ke server");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="flex flex-col h-full gap-4 max-w-6xl mx-auto w-full pb-10">
            {/* Header */}
            <div className="flex items-center justify-between bg-[#16181d]/80 p-4 rounded-xl border border-white/10 shadow-lg backdrop-blur-md">
                <div className="flex items-center gap-4">
                    <button 
                        onClick={() => router.push("/sales/receipt")}
                        className="p-2 bg-white/5 hover:bg-white/10 rounded-full transition-colors"
                    >
                        <ArrowLeft size={18} className="text-slate-300" />
                    </button>
                    <div>
                        <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                            <Receipt className="text-indigo-400 h-5 w-5" /> Penerimaan Penjualan Baru
                        </h1>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button 
                        type="button"
                        onClick={() => handleSubmit(onSubmit)()}
                        disabled={isSubmitting}
                        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/50 text-white px-5 py-2 rounded-lg text-sm font-medium transition-all shadow-lg"
                    >
                        {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} 
                        Simpan Data
                    </button>
                </div>
            </div>

            <form className="space-y-4">
                {/* Top Section: Accurate 2-Column Layout */}
                <div className="bg-[#16181d]/80 border border-white/10 shadow-xl backdrop-blur-md p-6 rounded-xl">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-12 gap-y-6">
                        {/* Kiri */}
                        <div className="space-y-5">
                            <Controller
                                name="customer"
                                control={control}
                                render={({ field }) => (
                                    <AsyncSearchSelect
                                        label="Terima dari"
                                        placeholder="Cari Pelanggan..."
                                        endpoint="/api/customer/list.do"
                                        valueField="customerNo"
                                        labelField={(item) => `[${item.customerNo || item.no || '?'}] ${item.name}`}
                                        searchField="name"
                                        value={field.value}
                                        onChange={field.onChange}
                                        error={errors.customer?.message}
                                        required
                                    />
                                )}
                            />

                            <Controller
                                name="bank"
                                control={control}
                                render={({ field }) => (
                                    <AsyncSearchSelect
                                        label="Bank"
                                        placeholder="Cari Akun Kas/Bank..."
                                        endpoint="/api/glaccount/list.do" 
                                        valueField="no"
                                        labelField={(item) => `[${item.no || item.accountNo || '?'}] ${item.name}`}
                                        searchField="name"
                                        // filter default Accurate on GLAccount is usually handled. You can customize extraFields.
                                        value={field.value}
                                        onChange={field.onChange}
                                        error={errors.bank?.message}
                                        required
                                    />
                                )}
                            />

                            <Controller
                                name="chequeAmount"
                                control={control}
                                render={({ field }) => (
                                    <Input
                                        label="Nilai Pembayaran"
                                        type="number"
                                        required
                                        value={field.value}
                                        onChange={(e) => field.onChange(Number(e.target.value))}
                                        error={errors.chequeAmount?.message}
                                    />
                                )}
                            />
                        </div>

                        {/* Kanan */}
                        <div className="space-y-5">
                            <Input
                                label="No Bukti Pnrmn"
                                placeholder="Otomatis jika dikosongkan"
                                {...register("receiptNumber")}
                                error={errors.receiptNumber?.message}
                            />

                            <Input
                                label="Tgl Bayar"
                                type="date"
                                {...register("transDate")}
                                error={errors.transDate?.message}
                                required
                            />

                            <Input
                                label="Keterangan"
                                placeholder="Catatan transaksi..."
                                {...register("description")}
                                error={errors.description?.message}
                            />
                        </div>
                    </div>
                </div>

                {/* Bottom Section: Invoice Selection Grid */}
                <div className="bg-[#16181d]/80 border border-white/10 shadow-xl backdrop-blur-md rounded-xl overflow-hidden flex flex-col min-h-[300px]">
                    <div className="p-3 border-b border-white/10 bg-black/20 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Search size={16} className="text-slate-400" />
                            <span className="text-sm font-medium text-slate-300">Cari/Pilih Faktur</span>
                        </div>
                        <span className="text-xs text-slate-500">
                            {outstandingInvoices.length} Faktur Terutang
                        </span>
                    </div>

                    <div className="flex-1 overflow-x-auto">
                        <table className="w-full text-sm text-left">
                            <thead className="text-xs text-slate-400 uppercase bg-black/40 border-b border-white/10">
                                <tr>
                                    <th className="px-4 py-3 w-10 text-center">Pilih</th>
                                    <th className="px-4 py-3">No. Faktur</th>
                                    <th className="px-4 py-3">Tgl Faktur</th>
                                    <th className="px-4 py-3 text-right">Total Faktur</th>
                                    <th className="px-4 py-3 text-right">Terutang</th>
                                    <th className="px-4 py-3 text-right">Bayar</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {isLoadingInvoices ? (
                                    <tr>
                                        <td colSpan={6} className="h-40 text-center">
                                            <div className="flex flex-col items-center justify-center gap-2 text-slate-400">
                                                <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
                                                <p>Memuat faktur pelanggan...</p>
                                            </div>
                                        </td>
                                    </tr>
                                ) : outstandingInvoices.length === 0 ? (
                                    <tr>
                                        <td colSpan={6} className="h-40 text-center text-slate-500">
                                            {selectedCustomer?.value 
                                                ? "Tidak ada faktur terutang untuk pelanggan ini." 
                                                : "Pilih pelanggan terlebih dahulu untuk melihat faktur terutang."}
                                        </td>
                                    </tr>
                                ) : (
                                    outstandingInvoices.map((inv) => (
                                        <tr key={inv.id} className={`hover:bg-white/5 transition-colors ${inv.selected ? 'bg-indigo-500/10' : ''}`}>
                                            <td className="px-4 py-3 text-center">
                                                <input 
                                                    type="checkbox" 
                                                    checked={inv.selected}
                                                    onChange={(e) => handleInvoiceToggle(inv.id, e.target.checked)}
                                                    className="w-4 h-4 rounded border-white/20 bg-black/20 text-indigo-500 focus:ring-indigo-500/50 cursor-pointer"
                                                />
                                            </td>
                                            <td className="px-4 py-3 font-medium text-indigo-200">{inv.number}</td>
                                            <td className="px-4 py-3 text-slate-300">{inv.transDate}</td>
                                            <td className="px-4 py-3 text-right text-slate-300">
                                                {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(inv.totalAmount)}
                                            </td>
                                            <td className="px-4 py-3 text-right text-red-300 font-medium">
                                                {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(inv.primeOwing)}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                <div className="flex justify-end">
                                                    <input 
                                                        type="number" 
                                                        value={inv.paymentAmount}
                                                        onChange={(e) => handleInvoicePaymentChange(inv.id, Number(e.target.value))}
                                                        disabled={!inv.selected}
                                                        className="w-32 bg-black/40 border border-white/10 rounded px-2 py-1 text-right text-white disabled:opacity-50 focus:ring-1 focus:ring-indigo-500 outline-none transition-all"
                                                    />
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Footer Totals (Mimicking Accurate's bottom right Totals) */}
                <div className="flex justify-end mt-4">
                    <div className="bg-[#16181d] border border-white/10 p-4 rounded-xl flex gap-8 items-center shadow-2xl backdrop-blur-md">
                        <div>
                            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-1">Nilai Pembayaran Form</p>
                            <p className="text-lg font-bold text-white">
                                {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(watch("chequeAmount") || 0)}
                            </p>
                        </div>
                        <div className="h-10 w-px bg-white/10"></div>
                        <div>
                            <p className="text-xs text-slate-500 font-medium uppercase tracking-wider mb-1">Total Faktur Dibayar</p>
                            <p className="text-lg font-bold text-indigo-400">
                                {new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(
                                    outstandingInvoices.filter(i => i.selected).reduce((acc, cur) => acc + cur.paymentAmount, 0)
                                )}
                            </p>
                        </div>
                    </div>
                </div>

            </form>
        </div>
    );
}
