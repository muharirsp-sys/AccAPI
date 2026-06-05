"use client";

/*
 * Tujuan: Halaman keranjang pengajuan pembayaran – konfirmasi sebelum diajukan ke Finance.
 * Caller: Next.js App Router route `/payments/cart/[draftId]`.
 * Dependensi: FastAPI /payments/cart-info, /payments/cart/submit, DatePickerField, lucide-react, sonner.
 * Main Functions: CartPage, loadCart, handleSubmit, recalcRow.
 * Side Effects: HTTP call ke FastAPI untuk load & submit cart.
 */

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { ShoppingCart, Send, ArrowLeft, AlertTriangle, Loader2, FileDown } from "lucide-react";
import { toast } from "sonner";
import DatePickerField from "@/components/ui/DatePickerField";

const API_BASE = process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:8000` : "http://localhost:8000");

let cachedCsrfToken = "";

async function getBackendCsrfToken(forceRefresh = false): Promise<string> {
    if (cachedCsrfToken && !forceRefresh) return cachedCsrfToken;
    const res = await fetch(`${API_BASE}/api/me`, { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.csrf_token) throw new Error("CSRF token backend tidak tersedia.");
    cachedCsrfToken = String(data.csrf_token);
    return cachedCsrfToken;
}

const api = {
    get: async (url: string) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const res = await fetch(fetchUrl, { credentials: "include" });
        const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        return { data, status: res.status, ok: res.ok };
    },
    post: async (url: string, body?: unknown) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const csrfToken = await getBackendCsrfToken();
        const init: RequestInit = {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
            body: JSON.stringify(body),
        };
        let res = await fetch(fetchUrl, init);
        if (res.status === 403) {
            const retryToken = await getBackendCsrfToken(true);
            init.headers = { "Content-Type": "application/json", "X-CSRF-Token": retryToken };
            res = await fetch(fetchUrl, init);
        }
        const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        return { data, status: res.status, ok: res.ok };
    },
};

interface CartItem {
    no: string;
    group_key: string;
    principle: string;
    tipe_pengajuan: string;
    total: number;
    total_display: string;
    invoice_concat: string;
    potongan: number;
    potongan_display: string;
    nilai_pembayaran: number;
    nilai_pembayaran_display: string;
    jenis_pembayaran: string;
    keterangan: string;
}

interface CartItemState extends CartItem {
    localPotongan: number;
    localNilaiPembayaran: number;
    localJenisPembayaran: string;
    localKeterangan: string;
}

function formatIdr(val: number): string {
    if (!val && val !== 0) return "0";
    return val.toLocaleString("id-ID");
}

function parseIdr(val: string): number {
    const digits = (val || "").replace(/\D/g, "");
    return digits ? Number(digits) : 0;
}

function tomorrowYmd(): string {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
}

export default function CartPage() {
    const params = useParams();
    const router = useRouter();
    const draftId = params.draftId as string;

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [items, setItems] = useState<CartItemState[]>([]);
    const [method, setMethod] = useState("");
    const [methodLabel, setMethodLabel] = useState("");
    const [targetDate, setTargetDate] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [submitResult, setSubmitResult] = useState<{ message: string; files: { url: string; label: string }[] } | null>(null);

    const loadCart = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const res = await api.get(`/payments/cart-info?draft=${encodeURIComponent(draftId)}`);
            if (!res.ok || !res.data.ok) {
                setError(res.data.error || "Gagal memuat keranjang.");
                return;
            }
            const cartItems: CartItemState[] = (res.data.items || []).map((item: CartItem) => {
                let potongan = Number(item.potongan || 0);
                if (potongan < 0) potongan = 0;
                if (potongan > item.total) potongan = item.total;
                const nilaiPembayaran = Math.max(item.total - potongan, 0);
                return {
                    ...item,
                    localPotongan: potongan,
                    localNilaiPembayaran: nilaiPembayaran,
                    localJenisPembayaran: item.jenis_pembayaran || "",
                    localKeterangan: item.keterangan || "",
                };
            });
            setItems(cartItems);
            setMethod(res.data.method || "");
            setMethodLabel(res.data.method_label || "");
            setTargetDate(res.data.target_payment_date || tomorrowYmd());
        } catch {
            setError("Gagal memuat keranjang. Silakan refresh.");
        } finally {
            setLoading(false);
        }
    }, [draftId]);

    useEffect(() => {
        if (draftId) loadCart();
    }, [draftId, loadCart]);

    const updateItem = (index: number, patch: Partial<CartItemState>) => {
        setItems((prev) => {
            const next = [...prev];
            const updated = { ...next[index], ...patch };
            // Recalculate payment when potongan changes
            if ("localPotongan" in patch) {
                let pot = updated.localPotongan;
                if (pot < 0) pot = 0;
                if (pot > updated.total) pot = updated.total;
                updated.localPotongan = pot;
                updated.localNilaiPembayaran = Math.max(updated.total - pot, 0);
            }
            next[index] = updated;
            return next;
        });
    };

    const totalInvoice = items.reduce((sum, it) => sum + it.total, 0);
    const totalPembayaran = items.reduce((sum, it) => sum + it.localNilaiPembayaran, 0);
    const totalPotongan = Math.max(totalInvoice - totalPembayaran, 0);

    const handleSubmit = async () => {
        if (!targetDate) {
            toast.error("Tanggal pengajuan pembayaran wajib diisi.");
            return;
        }
        const hasInvalid = items.some((it) => !it.localJenisPembayaran);
        if (hasInvalid) {
            toast.error("Jenis Pembayaran wajib diisi untuk semua baris.");
            return;
        }

        setSubmitting(true);
        setSubmitResult(null);
        try {
            const rows = items.map((it) => ({
                group_key: it.group_key,
                principle: it.principle,
                tipe_pengajuan: it.tipe_pengajuan,
                jenis_pembayaran: it.localJenisPembayaran,
                potongan: it.localPotongan,
                nilai_pembayaran: it.localNilaiPembayaran,
                keterangan: it.localKeterangan,
            }));
            const res = await api.post("/payments/cart/submit", {
                draft_id: draftId,
                target_payment_date: targetDate,
                items: rows,
            });
            if (!res.ok || !res.data.ok) {
                toast.error(res.data.error || "Gagal ajukan ke finance.");
                return;
            }
            toast.success("Pengajuan berhasil diproses!");
            setSubmitResult({
                message: "Pengajuan berhasil diproses.",
                files: res.data.files || [],
            });
        } catch {
            toast.error("Koneksi ke server gagal.");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="min-h-screen p-6 md:p-10">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
                <div>
                    <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">Keranjang Pengajuan Pembayaran</p>
                    <h1 className="mt-2 text-2xl md:text-3xl font-black text-white tracking-tight flex items-center gap-3">
                        <ShoppingCart className="text-purple-400" size={28} />
                        Konfirmasi Sebelum Diajukan ke Finance
                    </h1>
                    <p className="mt-1 text-sm text-slate-400">Isi jenis pembayaran & keterangan per principle.</p>
                </div>
                <button
                    onClick={() => router.push("/payments")}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-slate-200 hover:bg-white/10 transition-colors text-sm font-medium"
                >
                    <ArrowLeft size={16} /> Kembali ke LPB
                </button>
            </div>

            {/* Loading */}
            {loading && (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="animate-spin text-purple-400" size={32} />
                    <span className="ml-3 text-slate-400 text-lg">Memuat keranjang...</span>
                </div>
            )}

            {/* Error */}
            {!loading && error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-6 flex items-start gap-4">
                    <AlertTriangle className="text-red-400 flex-shrink-0 mt-0.5" size={24} />
                    <div>
                        <h3 className="text-white font-bold text-lg">Gagal Memuat Keranjang</h3>
                        <p className="text-red-300 mt-1 text-sm">{error}</p>
                        <button
                            onClick={loadCart}
                            className="mt-4 px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 text-sm font-medium transition-colors"
                        >
                            Coba Lagi
                        </button>
                    </div>
                </div>
            )}

            {/* Main Content */}
            {!loading && !error && (
                <>
                    {/* Summary Card */}
                    <div className="bg-[#1a1c23]/60 backdrop-blur-xl rounded-2xl border border-white/10 p-6 shadow-xl mb-8">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div>
                                <h2 className="text-lg font-bold text-white">Ringkasan Pengajuan</h2>
                                <p className="text-sm text-slate-400 mt-1">
                                    Draft: <span className="font-mono text-slate-300">{draftId}</span> | Metode: <span className="text-purple-300 font-semibold">{methodLabel || method || "-"}</span>
                                </p>
                            </div>
                            <button
                                onClick={handleSubmit}
                                disabled={submitting || !!submitResult}
                                className="flex items-center gap-2 px-5 py-3 rounded-xl bg-purple-600 text-white font-bold hover:bg-purple-500 shadow-lg shadow-purple-600/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {submitting ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                                Ajukan ke Finance
                            </button>
                        </div>

                        {/* Target Date */}
                        <div className="mt-5">
                            <label className="text-xs uppercase tracking-widest text-slate-500 font-semibold block mb-2">
                                Tanggal Pengajuan Pembayaran (Finance)
                            </label>
                            <div className="max-w-xs">
                                <DatePickerField
                                    value={targetDate}
                                    onChange={setTargetDate}
                                    placeholder="Pilih tanggal"
                                    ariaLabel="Tanggal pengajuan pembayaran"
                                />
                            </div>
                            <p className="mt-1.5 text-[11px] text-slate-500">
                                Contoh: pembayaran tanggal 26, pilih 2026-xx-26 agar masuk di tanggal itu pada halaman finance.
                            </p>
                        </div>

                        {/* Submit result */}
                        {submitResult && (
                            <div className="mt-5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4">
                                <p className="text-emerald-300 font-semibold">{submitResult.message}</p>
                                {submitResult.files.length > 0 && (
                                    <div className="mt-3 space-y-2">
                                        {submitResult.files.map((f, i) => (
                                            <a
                                                key={i}
                                                href={f.url.startsWith("http") ? f.url : `${API_BASE}${f.url}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center gap-2 text-sm text-emerald-200 hover:text-emerald-100 underline"
                                            >
                                                <FileDown size={14} /> {f.label}
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Totals */}
                        {items.length > 0 && (
                            <div className="mt-5 flex flex-wrap items-center gap-6 text-sm">
                                <div>
                                    <span className="text-slate-500">Total Invoice:</span>
                                    <span className="ml-2 font-mono font-bold text-white">Rp {formatIdr(totalInvoice)}</span>
                                </div>
                                <div>
                                    <span className="text-slate-500">Potongan:</span>
                                    <span className="ml-2 font-mono font-bold text-amber-400">Rp {formatIdr(totalPotongan)}</span>
                                </div>
                                <div>
                                    <span className="text-slate-500">Nilai Pembayaran:</span>
                                    <span className="ml-2 font-mono font-bold text-emerald-400">Rp {formatIdr(totalPembayaran)}</span>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Cart Table */}
                    <div className="bg-[#1a1c23]/60 backdrop-blur-xl rounded-2xl border border-white/10 shadow-xl overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[1000px] text-sm">
                                <thead>
                                    <tr className="border-b border-white/10 bg-purple-500/10">
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-purple-300">No.</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-purple-300">Principle</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-purple-300">Tipe Pengajuan</th>
                                        <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider text-purple-300">Nilai Invoice (Total)</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-purple-300">No. Invoice / Dokumen</th>
                                        <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider text-purple-300">Potongan</th>
                                        <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider text-purple-300">Nilai Pembayaran</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-purple-300">Jenis Pembayaran</th>
                                        <th className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-purple-300">Keterangan</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {items.map((item, idx) => (
                                        <tr
                                            key={idx}
                                            className="border-b border-white/5 hover:bg-white/[0.03] transition-colors"
                                        >
                                            <td className="px-4 py-3 text-slate-400 font-mono">{item.no || idx + 1}</td>
                                            <td className="px-4 py-3 text-white font-medium">{item.principle}</td>
                                            <td className="px-4 py-3 text-slate-300">{item.tipe_pengajuan}</td>
                                            <td className="px-4 py-3 text-right font-mono text-white">{item.total_display || formatIdr(item.total)}</td>
                                            <td className="px-4 py-3 text-slate-300 max-w-[300px] break-words whitespace-normal text-xs">{item.invoice_concat}</td>
                                            <td className="px-4 py-3">
                                                <div className="flex items-center gap-1 bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 focus-within:ring-1 focus-within:ring-purple-500/50">
                                                    <span className="text-[10px] font-bold text-slate-500 uppercase">Rp</span>
                                                    <input
                                                        type="text"
                                                        inputMode="numeric"
                                                        placeholder="0"
                                                        value={item.localPotongan > 0 ? formatIdr(item.localPotongan) : ""}
                                                        onChange={(e) => {
                                                            const val = parseIdr(e.target.value);
                                                            updateItem(idx, { localPotongan: val });
                                                        }}
                                                        onFocus={(e) => e.target.select()}
                                                        aria-label={`Potongan untuk ${item.principle}`}
                                                        className="bg-transparent border-0 outline-none text-right text-sm font-mono font-bold text-amber-300 w-full placeholder:text-slate-600"
                                                    />
                                                </div>
                                                <p className="text-[10px] text-slate-600 mt-1">Opsional</p>
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex items-center gap-1 bg-emerald-500/5 border border-emerald-500/20 rounded-lg px-2 py-1.5">
                                                    <span className="text-[10px] font-bold text-emerald-600 uppercase">Rp</span>
                                                    <input
                                                        type="text"
                                                        readOnly
                                                        tabIndex={-1}
                                                        value={formatIdr(item.localNilaiPembayaran)}
                                                        aria-label={`Nilai pembayaran untuk ${item.principle}`}
                                                        className="bg-transparent border-0 outline-none text-right text-sm font-mono font-bold text-emerald-400 w-full cursor-default"
                                                    />
                                                </div>
                                                <p className="text-[10px] text-slate-600 mt-1">Otomatis</p>
                                            </td>
                                            <td className="px-4 py-3">
                                                <select
                                                    value={item.localJenisPembayaran}
                                                    onChange={(e) => updateItem(idx, { localJenisPembayaran: e.target.value })}
                                                    className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-purple-500/50 w-full"
                                                >
                                                    <option value="">Pilih</option>
                                                    <option value="TRF">TRF</option>
                                                    <option value="DF">DF</option>
                                                    <option value="VA">VA</option>
                                                </select>
                                            </td>
                                            <td className="px-4 py-3">
                                                <textarea
                                                    value={item.localKeterangan}
                                                    onChange={(e) => updateItem(idx, { localKeterangan: e.target.value })}
                                                    placeholder="Keterangan..."
                                                    className="bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:ring-1 focus:ring-purple-500/50 w-full min-h-[40px] resize-y"
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                    {items.length === 0 && (
                                        <tr>
                                            <td colSpan={9} className="px-4 py-12 text-center text-slate-500">
                                                Tidak ada item dalam keranjang.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
