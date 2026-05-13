"use client";

/*
 * Tujuan: Halaman finance untuk review, mapping Accurate, upload bukti transfer, dan posting purchase-payment.
 * Caller: Next.js App Router route `/finance`.
 * Dependensi: FastAPI payments finance endpoints, accurateFetch Accurate proxy, lucide-react, sonner.
 * Main Functions: FinancePage, fetchData, handleSaveMapping, handleMarkStatus, handleApproveTransfer.
 * Side Effects: HTTP call ke FastAPI, upload bukti transfer, post Accurate purchase-payment/bulk-save.do, update payments.json.
 */

import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Calendar, CheckCircle2, DollarSign, Download, FileUp, RefreshCcw, Save, Search, Send, XCircle } from "lucide-react";
import { toast } from "sonner";
import { accurateFetch } from "@/lib/apiFetcher";

interface FinanceMapping {
    principle?: string;
    vendorNo?: string;
    vendorName?: string;
    bankNo?: string;
    bankName?: string;
}

interface ProofMeta {
    proof_id?: string;
    original_filename?: string;
    stored_filename?: string;
    sha256?: string;
    url?: string;
}

interface DetailInvoice {
    record_id: string;
    invoiceNo: string;
    paymentAmount: number;
    paymentAmountDisplay?: string;
}

interface FinanceRecord {
    draft_label: string;
    draft_id: string;
    submission_id: string;
    principle: string;
    tipe_pengajuan: string;
    total_invoice: number;
    total_invoice_display: string;
    total_potongan_display: string;
    invoice_concat: string;
    detail_invoices: DetailInvoice[];
    total_nilai: number;
    total_nilai_display: string;
    keterangan: string;
    payment_method: string;
    submitted_date: string;
    status_pembayaran: string;
    sppd_no?: string;
    transfer_date?: string;
    transfer_proof?: ProofMeta;
    accurate_post_status?: string;
    accurate_post_error?: string;
    accurate_purchase_payment_number?: string;
    mapping?: FinanceMapping;
}

interface PurchasePaymentPayload {
    bankNo: string;
    vendorNo: string;
    chequeAmount: number;
    transDate: string;
    chequeDate: string;
    paymentMethod: string;
    description: string;
    detailInvoice: Array<{ invoiceNo: string; paymentAmount: number }>;
}

const API_BASE = process.env.NEXT_PUBLIC_FASTAPI_BASE_URL || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:8000` : "http://localhost:8000");

const api = {
    get: async (url: string) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const res = await fetch(fetchUrl, { credentials: "include" });
        const data = await res.json();
        return { data, status: res.status, ok: res.ok };
    },
    postJson: async (url: string, body: unknown) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const res = await fetch(fetchUrl, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        return { data, status: res.status, ok: res.ok };
    },
    postForm: async (url: string, body: FormData) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const res = await fetch(fetchUrl, {
            method: "POST",
            credentials: "include",
            body,
        });
        const data = await res.json();
        return { data, status: res.status, ok: res.ok };
    },
};

function recordKey(record: FinanceRecord) {
    return `${record.draft_id || "-"}|${record.submission_id || "-"}|${record.principle}|${record.tipe_pengajuan}`;
}

function toAccurateDate(ymd: string) {
    const [year, month, day] = ymd.split("-");
    if (!year || !month || !day) return "";
    return `${day}/${month}/${year}`;
}

function hasAccurateSession() {
    if (typeof window === "undefined") return false;
    return Boolean(
        sessionStorage.getItem("accurateApiKey") &&
        sessionStorage.getItem("accurateHost") &&
        sessionStorage.getItem("accurateSession")
    );
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function getErrorMessage(err: unknown, fallback: string) {
    return err instanceof Error ? err.message : fallback;
}

function extractAccurateIdentity(data: unknown) {
    const first = Array.isArray(data) ? data[0] : data;
    const firstRecord = asRecord(first);
    const body = asRecord(firstRecord.d || firstRecord.data || firstRecord);
    const nestedR = asRecord(body.r);
    const nestedD = asRecord(body.d);
    return {
        number: String(body.number || nestedR.number || nestedD.number || ""),
        id: String(body.id || nestedR.id || nestedD.id || ""),
    };
}

function assertBulkSuccess(data: unknown) {
    if (Array.isArray(data)) {
        const failed = data.filter((item) => !asRecord(item).s);
        if (failed.length > 0) {
            const first = asRecord(failed[0]);
            throw new Error(JSON.stringify(first.d || first, null, 2));
        }
    }
}

export default function FinancePage() {
    const [loading, setLoading] = useState(true);
    const [records, setRecords] = useState<FinanceRecord[]>([]);
    const [totalAll, setTotalAll] = useState("");
    const [dateFilter, setDateFilter] = useState("");
    const [search, setSearch] = useState("");
    const [errorMsg, setErrorMsg] = useState("");
    const [mappingDrafts, setMappingDrafts] = useState<Record<string, FinanceMapping>>({});
    const [transferDates, setTransferDates] = useState<Record<string, string>>({});
    const [proofFiles, setProofFiles] = useState<Record<string, File | null>>({});
    const [busyKey, setBusyKey] = useState("");

    useEffect(() => {
        const today = new Date().toISOString().split("T")[0];
        setDateFilter(today);
        fetchData(today);
    }, []);

    const fetchData = async (date: string) => {
        try {
            setLoading(true);
            setErrorMsg("");
            const res = await api.get(`/payments/finance/data?date=${encodeURIComponent(date)}`);
            if (res.data.ok) {
                const rows: FinanceRecord[] = res.data.data || [];
                setRecords(rows);
                setTotalAll(res.data.total_all_display || "Rp 0");
                if (res.data.date) setDateFilter(res.data.date);
                setMappingDrafts((prev) => {
                    const next = { ...prev };
                    rows.forEach((row) => {
                        const key = recordKey(row);
                        if (!next[key]) next[key] = row.mapping || {};
                    });
                    return next;
                });
                setTransferDates((prev) => {
                    const next = { ...prev };
                    rows.forEach((row) => {
                        const key = recordKey(row);
                        if (!next[key]) next[key] = row.transfer_date || row.submitted_date || date;
                    });
                    return next;
                });
            } else {
                setErrorMsg(res.data.error || "Gagal memuat data finance.");
            }
        } catch {
            setErrorMsg("Koneksi ke backend Python gagal. Pastikan localhost:8000 aktif.");
        } finally {
            setLoading(false);
        }
    };

    const filtered = useMemo(() => {
        const q = search.toLowerCase();
        return records.filter((r) =>
            (r.principle || "").toLowerCase().includes(q) ||
            (r.draft_label || "").toLowerCase().includes(q) ||
            (r.invoice_concat || "").toLowerCase().includes(q) ||
            (r.sppd_no || "").toLowerCase().includes(q)
        );
    }, [records, search]);

    const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setDateFilter(val);
        fetchData(val);
    };

    const handleExport = () => {
        let url = `${API_BASE}/payments/finance/export`;
        if (dateFilter) url += `?from=${dateFilter}&to=${dateFilter}`;
        window.open(url, "_blank");
    };

    const patchMapping = (key: string, patch: FinanceMapping) => {
        setMappingDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...patch } }));
    };

    const handleSaveMapping = async (record: FinanceRecord) => {
        const key = recordKey(record);
        const draft = mappingDrafts[key] || {};
        if (!draft.vendorNo || !draft.bankNo) {
            toast.error("Vendor No dan Bank No Accurate wajib diisi.");
            return false;
        }
        const res = await api.postJson("/payments/finance/mapping", {
            principle: record.principle,
            vendorNo: draft.vendorNo,
            vendorName: draft.vendorName || "",
            bankNo: draft.bankNo,
            bankName: draft.bankName || "",
        });
        if (!res.data.ok) {
            toast.error(res.data.error || "Gagal menyimpan mapping Accurate.");
            return false;
        }
        toast.success("Mapping Accurate tersimpan.");
        return true;
    };

    const updateFinanceStatus = async (record: FinanceRecord, body: Record<string, unknown>) => {
        const res = await api.postJson("/payments/finance/update", {
            items: [{
                principle: record.principle,
                tipe_pengajuan: record.tipe_pengajuan,
                submission_id: record.submission_id,
                draft_id: record.draft_id,
                date: dateFilter,
                ...body,
            }],
        });
        if (!res.data.ok) throw new Error(res.data.error || "Gagal update status finance.");
        return res.data;
    };

    const handleMarkStatus = async (record: FinanceRecord, status: "Belum Transfer" | "Ajukan Ulang") => {
        const key = recordKey(record);
        setBusyKey(key);
        try {
            await updateFinanceStatus(record, { status_pembayaran: status });
            toast.success(`Status disimpan: ${status}`);
            await fetchData(dateFilter);
        } catch (err: unknown) {
            toast.error(getErrorMessage(err, "Gagal menyimpan status."));
        } finally {
            setBusyKey("");
        }
    };

    const uploadProof = async (key: string, existing?: ProofMeta) => {
        if (existing?.proof_id) return existing;
        const file = proofFiles[key];
        if (!file) throw new Error("Bukti transfer wajib diupload.");
        const fd = new FormData();
        fd.append("file", file);
        const res = await api.postForm("/payments/finance/proof", fd);
        if (!res.data.ok) throw new Error(res.data.error || "Gagal upload bukti transfer.");
        return res.data.proof as ProofMeta;
    };

    const buildPurchasePaymentPayload = (record: FinanceRecord, mapping: FinanceMapping, proof: ProofMeta, transferDate: string): PurchasePaymentPayload[] => {
        const invalidInvoices = (record.detail_invoices || []).filter((item) => {
            const invoice = String(item.invoiceNo || "").trim().toUpperCase();
            return !invoice || invoice === "BELUM ADA";
        });
        if (invalidInvoices.length > 0 || !record.detail_invoices?.length) {
            throw new Error("No Invoice wajib valid sebelum post purchase-payment Accurate. Invoice kosong/BELUM ADA tidak boleh dipost.");
        }
        const accDate = toAccurateDate(transferDate);
        return [{
            bankNo: mapping.bankNo || "",
            vendorNo: mapping.vendorNo || "",
            chequeAmount: Number(record.total_nilai || 0),
            transDate: accDate,
            chequeDate: accDate,
            paymentMethod: "BANK_TRANSFER",
            description: [
                `SPPD: ${record.sppd_no || "-"}`,
                `Draft: ${record.draft_label || record.draft_id || "-"}`,
                `Submission: ${record.submission_id || "-"}`,
                `Bukti: ${proof.stored_filename || proof.original_filename || "-"}`,
                `SHA256: ${(proof.sha256 || "").slice(0, 16)}`,
            ].join(" | "),
            detailInvoice: record.detail_invoices.map((item) => ({
                invoiceNo: item.invoiceNo,
                paymentAmount: Number(item.paymentAmount || 0),
            })),
        }];
    };

    const handleApproveTransfer = async (record: FinanceRecord) => {
        const key = recordKey(record);
        const transferDate = transferDates[key] || "";
        const mapping = mappingDrafts[key] || record.mapping || {};
        if (record.accurate_post_status === "posted") {
            toast.error("Record ini sudah posted ke Accurate.");
            return;
        }
        if (!transferDate) {
            toast.error("Tanggal transfer wajib diisi.");
            return;
        }
        if (!mapping.vendorNo || !mapping.bankNo) {
            toast.error("Mapping Vendor No dan Bank No Accurate wajib lengkap.");
            return;
        }
        if (!hasAccurateSession()) {
            toast.error("Login dan open database Accurate dulu sebelum posting purchase-payment.");
            return;
        }

        setBusyKey(key);
        let proof: ProofMeta | undefined;
        let payload: PurchasePaymentPayload[] = [];
        try {
            const saved = await handleSaveMapping(record);
            if (!saved) return;
            proof = await uploadProof(key, record.transfer_proof);
            payload = buildPurchasePaymentPayload(record, mapping, proof, transferDate);
            const accurateRes = await accurateFetch("/api/purchase-payment/bulk-save.do", "POST", payload);
            assertBulkSuccess(accurateRes);
            const identity = extractAccurateIdentity(accurateRes);
            await updateFinanceStatus(record, {
                status_pembayaran: "Sudah Transfer",
                transfer_date: transferDate,
                proof_id: proof.proof_id,
                accurate_post_status: "posted",
                accurate_purchase_payment_number: identity.number,
                accurate_purchase_payment_id: identity.id,
                accurate_post_response: accurateRes,
                accurate_payload_digest: `${proof.sha256 || ""}:${JSON.stringify(payload).length}`,
            });
            toast.success("Sudah transfer dan posted ke Accurate.");
            await fetchData(dateFilter);
        } catch (err: unknown) {
            const message = getErrorMessage(err, "Gagal posting purchase-payment Accurate.");
            if (proof?.proof_id) {
                try {
                    await updateFinanceStatus(record, {
                        status_pembayaran: "Sudah Transfer",
                        transfer_date: transferDate,
                        proof_id: proof.proof_id,
                        accurate_post_status: "failed",
                        accurate_post_error: message.slice(0, 1000),
                        accurate_payload_digest: `${proof.sha256 || ""}:${JSON.stringify(payload).length}`,
                    });
                    await fetchData(dateFilter);
                } catch {
                    // keep the original Accurate error visible
                }
            }
            toast.error(message);
        } finally {
            setBusyKey("");
        }
    };

    return (
        <div className="max-w-[1800px] mx-auto pb-12">
            <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
                        <DollarSign className="text-emerald-500" />
                        Manajemen Finance
                    </h1>
                    <p className="text-slate-400 mt-1 text-sm">Approve transfer, simpan bukti server, lalu post purchase-payment Accurate.</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <div className="relative flex items-center">
                        <Calendar className="absolute left-3 text-slate-400" size={16} />
                        <input type="date" value={dateFilter} onChange={handleDateChange} className="pl-9 pr-4 py-2.5 text-sm border border-white/10 rounded-lg outline-none bg-black/40 text-slate-300" />
                    </div>
                    <div className="relative flex items-center">
                        <Search className="absolute left-3 text-slate-400" size={16} />
                        <input type="text" placeholder="Cari principle, draft, invoice, SPPD..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 pr-4 py-2.5 text-sm border border-white/10 rounded-lg outline-none bg-black/40 text-slate-300 w-80" />
                    </div>
                    <button onClick={() => fetchData(dateFilter)} className="flex items-center gap-2 bg-white/5 border border-white/10 text-slate-300 px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-white/10">
                        <RefreshCcw size={16} /> Refresh
                    </button>
                    <button onClick={handleExport} className="flex items-center gap-2 bg-emerald-600/20 border border-emerald-500/30 text-emerald-400 px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-emerald-500/30">
                        <Download size={16} /> Export Excel
                    </button>
                </div>
            </div>

            {errorMsg && (
                <div className="mb-4 p-4 rounded-lg bg-red-500/10 border border-red-500/20 flex items-start gap-3">
                    <AlertCircle className="text-red-400 shrink-0" />
                    <p className="text-red-200 text-sm font-medium">{errorMsg}</p>
                </div>
            )}

            <div className="bg-[#1a1c23]/60 rounded-lg shadow-xl border border-white/10 overflow-hidden">
                <div className="p-4 border-b border-white/5 flex items-center justify-between bg-black/40">
                    <h2 className="text-base font-bold text-white">Daftar Pengajuan Pembayaran</h2>
                    <div className="text-sm text-slate-400">Total: <span className="font-mono font-bold text-emerald-400">{totalAll}</span></div>
                </div>

                <div className="overflow-x-auto w-full relative">
                    {loading && records.length === 0 ? (
                        <div className="p-12 text-center text-slate-400 animate-pulse">Memuat integrasi data Finance...</div>
                    ) : (
                        <table className="w-full min-w-[1900px] text-xs text-left">
                            <thead className="bg-black/60 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                                <tr className="whitespace-nowrap">
                                    <th className="px-4 py-3">Draft</th>
                                    <th className="px-4 py-3">Principle</th>
                                    <th className="px-4 py-3">SPPD</th>
                                    <th className="px-4 py-3 text-right">Invoice</th>
                                    <th className="px-4 py-3 text-right">Bayar</th>
                                    <th className="px-4 py-3">Tagihan</th>
                                    <th className="px-4 py-3">Mapping Accurate</th>
                                    <th className="px-4 py-3">Transfer + Bukti</th>
                                    <th className="px-4 py-3">Status</th>
                                    <th className="px-4 py-3">Aksi</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                                {filtered.length === 0 ? (
                                    <tr>
                                        <td colSpan={10} className="px-5 py-12 text-center text-slate-500 italic">Tidak ada data finance untuk tanggal {dateFilter}.</td>
                                    </tr>
                                ) : filtered.map((record) => {
                                    const key = recordKey(record);
                                    const mapping = mappingDrafts[key] || record.mapping || {};
                                    const isBusy = busyKey === key;
                                    const posted = record.accurate_post_status === "posted";
                                    const failedPost = record.accurate_post_status === "failed";
                                    return (
                                        <tr key={key} className="hover:bg-white/[0.02] align-top">
                                            <td className="px-4 py-3 font-mono font-bold text-slate-300 whitespace-nowrap">
                                                {record.draft_label === "-" && record.submission_id ? `SUB-${record.submission_id}` : record.draft_label}
                                                <div className="mt-1 text-[10px] text-slate-500">{record.tipe_pengajuan} | {record.payment_method || "-"}</div>
                                            </td>
                                            <td className="px-4 py-3 text-slate-300 max-w-[220px]">
                                                <div className="font-semibold truncate" title={record.principle}>{record.principle}</div>
                                                <div className="mt-1 text-[10px] text-slate-500">Tanggal: {record.submitted_date}</div>
                                            </td>
                                            <td className="px-4 py-3 font-mono text-slate-400">{record.sppd_no || "-"}</td>
                                            <td className="px-4 py-3 text-right font-mono text-slate-300">{record.total_invoice_display}</td>
                                            <td className="px-4 py-3 text-right font-mono font-bold text-emerald-400">{record.total_nilai_display}</td>
                                            <td className="px-4 py-3 text-slate-500 max-w-[240px]">
                                                <div className="truncate" title={record.invoice_concat}>{record.invoice_concat || "-"}</div>
                                                <div className="mt-1 text-[10px] text-slate-600">{record.detail_invoices?.length || 0} invoice</div>
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="grid grid-cols-2 gap-2 w-[300px]">
                                                    <input value={mapping.vendorNo || ""} onChange={(e) => patchMapping(key, { vendorNo: e.target.value })} placeholder="Vendor No" className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-slate-200 outline-none focus:border-emerald-500" />
                                                    <input value={mapping.bankNo || ""} onChange={(e) => patchMapping(key, { bankNo: e.target.value })} placeholder="Bank No" className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-slate-200 outline-none focus:border-emerald-500" />
                                                    <input value={mapping.vendorName || ""} onChange={(e) => patchMapping(key, { vendorName: e.target.value })} placeholder="Vendor Name" className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-slate-400 outline-none focus:border-emerald-500" />
                                                    <input value={mapping.bankName || ""} onChange={(e) => patchMapping(key, { bankName: e.target.value })} placeholder="Bank Name" className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-slate-400 outline-none focus:border-emerald-500" />
                                                </div>
                                                <button disabled={isBusy} onClick={() => handleSaveMapping(record)} className="mt-2 inline-flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 disabled:opacity-50">
                                                    <Save size={12} /> Simpan mapping
                                                </button>
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex flex-col gap-2 w-[260px]">
                                                    <input type="date" value={transferDates[key] || ""} onChange={(e) => setTransferDates((prev) => ({ ...prev, [key]: e.target.value }))} className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-slate-200 outline-none focus:border-emerald-500" />
                                                    <label className="inline-flex items-center gap-2 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-slate-300 cursor-pointer hover:bg-white/10">
                                                        <FileUp size={14} />
                                                        <span className="truncate">{proofFiles[key]?.name || record.transfer_proof?.original_filename || "Upload bukti"}</span>
                                                        <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={(e) => setProofFiles((prev) => ({ ...prev, [key]: e.target.files?.[0] || null }))} />
                                                    </label>
                                                    {record.transfer_proof?.url && (
                                                        <a href={`${API_BASE}${record.transfer_proof.url}`} target="_blank" className="text-[11px] text-blue-300 hover:text-blue-200">Lihat bukti tersimpan</a>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className={`inline-flex items-center gap-1 px-2 py-1 rounded border font-bold ${record.status_pembayaran.toLowerCase().includes("sudah") ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : record.status_pembayaran.toLowerCase().includes("ulang") ? "bg-amber-500/10 text-amber-400 border-amber-500/30" : "bg-white/5 text-slate-400 border-white/10"}`}>
                                                    {record.status_pembayaran || "Belum Transfer"}
                                                </span>
                                                {posted && <div className="mt-2 text-[11px] text-emerald-400">Posted Accurate {record.accurate_purchase_payment_number || ""}</div>}
                                                {failedPost && <div className="mt-2 max-w-[220px] text-[11px] text-red-300 truncate" title={record.accurate_post_error}>Post gagal: {record.accurate_post_error}</div>}
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex flex-col gap-2 w-[190px]">
                                                    <button disabled={isBusy || posted} onClick={() => handleApproveTransfer(record)} className="inline-flex items-center justify-center gap-2 bg-emerald-600 text-white font-bold px-3 py-2 rounded hover:bg-emerald-500 disabled:opacity-50">
                                                        <Send size={14} /> Sudah Transfer
                                                    </button>
                                                    <div className="grid grid-cols-2 gap-2">
                                                        <button disabled={isBusy} onClick={() => handleMarkStatus(record, "Belum Transfer")} className="inline-flex items-center justify-center gap-1 bg-white/5 border border-white/10 text-slate-300 px-2 py-1.5 rounded hover:bg-white/10 disabled:opacity-50">
                                                            <XCircle size={13} /> Belum
                                                        </button>
                                                        <button disabled={isBusy} onClick={() => handleMarkStatus(record, "Ajukan Ulang")} className="inline-flex items-center justify-center gap-1 bg-amber-500/10 border border-amber-500/20 text-amber-300 px-2 py-1.5 rounded hover:bg-amber-500/20 disabled:opacity-50">
                                                            <CheckCircle2 size={13} /> Ulang
                                                        </button>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
}
