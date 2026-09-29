"use client";

/*
 * Tujuan: Halaman Finance untuk review, mapping Accurate, upload bukti transfer, format nilai decimal, dan posting purchase-payment.
 * Caller: Next.js App Router route `/finance`.
 * Dependensi: FastAPI payments finance endpoints, command /api/finance/purchase-payment (klaim attempt server), DatePickerField, lucide-react, sonner.
 * Main Functions: FinancePage, fetchData, formatMoneyDisplay, handleSaveMapping, handleMarkStatus, handleApproveTransfer.
 * Side Effects: HTTP call ke FastAPI, upload bukti transfer, post Accurate purchase-payment/bulk-save.do, update payments.json.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, DollarSign, Download, FileUp, RefreshCcw, Save, Search, Send, XCircle } from "lucide-react";
import { toast } from "sonner";
import DatePickerField from "@/components/ui/DatePickerField";
import { fuzzyMatch } from "@/lib/fuzzySearch";
import { resolveApiBase } from "@/lib/apiBase";

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

const API_BASE = resolveApiBase();
let cachedCsrfToken = "";

function parseMoneyAmount(value: unknown): number {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const raw = String(value ?? "").trim();
    if (!raw) return 0;
    const cleaned = raw.replace(/[^0-9.,-]/g, "");
    const hasComma = cleaned.includes(",");
    const hasDot = cleaned.includes(".");
    let normalized = cleaned;

    if (hasComma && hasDot) {
        normalized = cleaned.lastIndexOf(".") > cleaned.lastIndexOf(",")
            ? cleaned.replace(/,/g, "")
            : cleaned.replace(/\./g, "").replace(",", ".");
    } else if (hasComma) {
        const parts = cleaned.split(",");
        normalized = parts.length === 2 && parts[1].length <= 2
            ? cleaned.replace(",", ".")
            : cleaned.replace(/,/g, "");
    } else if (hasDot) {
        const parts = cleaned.split(".");
        normalized = parts.length > 2 || parts[parts.length - 1].length === 3
            ? cleaned.replace(/\./g, "")
            : cleaned;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoneyDisplay(value: unknown): string {
    const raw = String(value ?? "").trim();
    if (!raw) return "0.00";
    return parseMoneyAmount(value).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

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
        const data = await res.json();
        return { data, status: res.status, ok: res.ok };
    },
    postJson: async (url: string, body: unknown) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const csrfToken = await getBackendCsrfToken();
        const requestInit = (token: string): RequestInit => ({
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
            body: JSON.stringify(body),
        });
        let res = await fetch(fetchUrl, requestInit(csrfToken));
        if (res.status === 403) {
            const retryToken = await getBackendCsrfToken(true);
            res = await fetch(fetchUrl, requestInit(retryToken));
        }
        const data = await res.json();
        return { data, status: res.status, ok: res.ok };
    },
    postForm: async (url: string, body: FormData) => {
        const fetchUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        const csrfToken = await getBackendCsrfToken();
        const requestInit = (token: string): RequestInit => ({
            method: "POST",
            credentials: "include",
            headers: { "X-CSRF-Token": token },
            body,
        });
        let res = await fetch(fetchUrl, requestInit(csrfToken));
        if (res.status === 403) {
            const retryToken = await getBackendCsrfToken(true);
            res = await fetch(fetchUrl, requestInit(retryToken));
        }
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

function getErrorMessage(err: unknown, fallback: string) {
    return err instanceof Error ? err.message : fallback;
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
    const postingRef = useRef(new Set<string>());

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
                const rows: FinanceRecord[] = (res.data.data || []).map((record: FinanceRecord) => ({
                    ...record,
                    total_invoice_display: formatMoneyDisplay(record.total_invoice_display || record.total_invoice),
                    total_potongan_display: formatMoneyDisplay(record.total_potongan_display),
                    total_nilai_display: formatMoneyDisplay(record.total_nilai_display || record.total_nilai),
                    detail_invoices: (record.detail_invoices || []).map((item) => ({
                        ...item,
                        paymentAmountDisplay: formatMoneyDisplay(item.paymentAmountDisplay || item.paymentAmount),
                    })),
                }));
                setRecords(rows);
                setTotalAll(formatMoneyDisplay(res.data.total_all_display || res.data.total_all));
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
        if (!search.trim()) return records;
        return records.filter((r) =>
            fuzzyMatch(r.principle, search) ||
            fuzzyMatch(r.draft_label, search) ||
            fuzzyMatch(r.invoice_concat, search) ||
            fuzzyMatch(r.sppd_no, search)
        );
    }, [records, search]);

    const handleDateChange = (value: string) => {
        setDateFilter(value);
        fetchData(value);
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
        // Review #3: dua klik cepat sama-sama lolos sebelum state busy ter-render -> dua
        // purchase-payment. Ref sinkron menahan klik kedua sejak awal.
        if (postingRef.current.has(key)) return;
        postingRef.current.add(key);
        try {
            await approveTransfer(record, key);
        } finally {
            postingRef.current.delete(key);
        }
    };

    const approveTransfer = async (record: FinanceRecord, key: string) => {
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
        const sessionRes = await fetch("/api/auth/accurate-session");
        const sessionData = await sessionRes.json().catch(() => ({}));
        if (!sessionRes.ok || !sessionData.databaseConnected) {
            toast.error("Login dan open database Accurate dulu sebelum posting purchase-payment.");
            return;
        }

        setBusyKey(key);
        let proof: ProofMeta | undefined;
        let payload: PurchasePaymentPayload[] = [];
        let sent = false;
        let accurateRes: unknown;
        // Command server menolak SEBELUM klaim (4xx) = pasti belum terkirim ke Accurate.
        let notSent = false;
        // AM-014: "failed" hanya bila Accurate MENJAWAB menolak (atau gagal sebelum terkirim).
        // Timeout/non-JSON/gateway/sukses tanpa id = "unknown": tombol posting dikunci sampai
        // seseorang memeriksa purchase-payment di Accurate — mengulang buta = bayar dua kali.
        const recordNotPosted = async (postStatus: "failed" | "unknown", message: string, response?: unknown) => {
            // Kunci LOKAL dulu: bila pencatatan ke server gagal, tombol tetap terkunci (review #3).
            if (postStatus === "unknown") {
                setRecords((prev) => prev.map((r) => recordKey(r) === key ? { ...r, accurate_post_status: "unknown", accurate_post_error: message } : r));
            }
            if (!proof?.proof_id) return;
            try {
                await updateFinanceStatus(record, {
                    status_pembayaran: "Sudah Transfer",
                    transfer_date: transferDate,
                    proof_id: proof.proof_id,
                    accurate_post_status: postStatus,
                    accurate_post_error: message.slice(0, 1000),
                    ...(response === undefined ? {} : { accurate_post_response: response }),
                    accurate_payload_digest: `${proof.sha256 || ""}:${JSON.stringify(payload).length}`,
                });
                await fetchData(dateFilter);
            } catch {
                // keep the original Accurate error visible
            }
        };
        const unknownMessage = (message: string) =>
            `Status posting TIDAK PASTI (${message}). Cek purchase-payment di Accurate sebelum mencoba lagi.`;
        try {
            const saved = await handleSaveMapping(record);
            if (!saved) return;
            proof = await uploadProof(key, record.transfer_proof);
            payload = buildPurchasePaymentPayload(record, mapping, proof, transferDate);
            sent = true;
            // AM-014 / C.12: server mengklaim attempt SEBELUM kirim, jadi reload / tab lain / user
            // lain untuk himpunan faktur yang sama mendapat 409, bukan purchase-payment kedua.
            const res = await fetch("/api/finance/purchase-payment", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ clientRef: key, payload }),
            });
            const out = await res.json().catch(() => null) as {
                state?: string; accurateId?: string; accurateNumber?: string; message?: string; response?: unknown; error?: string;
                live?: { attemptId: string; state: string; accurateId: string; accurateNumber: string } | null;
            } | null;
            let posted: { id: string; number: string; note?: string } | null = null;
            if (res.status === 409 && out?.live?.state === "posted") {
                // Attempt sebelumnya SUDAH posted (mis. browser ditutup sebelum sempat mencatat).
                posted = { id: out.live.accurateId, number: out.live.accurateNumber, note: `attempt server ${out.live.attemptId} sudah posted ${out.live.accurateNumber}` };
            } else if (res.status === 409) {
                await recordNotPosted("unknown", out?.error || "attempt sebelumnya belum pasti", out?.live);
                toast.error(unknownMessage(out?.error || "attempt sebelumnya belum pasti"), { duration: 15000 });
                return;
            } else if (!res.ok || !out?.state) {
                notSent = res.status >= 400 && res.status < 500;
                throw new Error(out?.error || `Command posting gagal (HTTP ${res.status})`);
            } else {
                accurateRes = out.response;
                if (out.state !== "posted") {
                    const failed = out.state === "rejected" || out.state === "not_sent";
                    await recordNotPosted(failed ? "failed" : "unknown", out.message || out.state, out.response);
                    toast.error(failed ? (out.message || out.state) : unknownMessage(out.message || out.state), { duration: 15000 });
                    return;
                }
                posted = { id: out.accurateId || "", number: out.accurateNumber || "" };
            }
            await updateFinanceStatus(record, {
                status_pembayaran: "Sudah Transfer",
                transfer_date: transferDate,
                proof_id: proof.proof_id,
                accurate_post_status: "posted",
                accurate_purchase_payment_number: posted.number,
                accurate_purchase_payment_id: posted.id,
                accurate_post_response: accurateRes ?? out?.live,
                accurate_payload_digest: `${proof.sha256 || ""}:${JSON.stringify(payload).length}`,
                ...(posted.note ? { resolution_note: posted.note } : {}),
            });
            toast.success(`Sudah transfer dan posted ke Accurate (${posted.number}).`);
            await fetchData(dateFilter);
        } catch (err: unknown) {
            const message = getErrorMessage(err, "Gagal posting purchase-payment Accurate.");
            // Belum sampai command, atau command menolak sebelum klaim = pasti tidak terkirim.
            // Selain itu (jaringan putus ke command, 5xx, pencatatan "posted" ke FastAPI gagal)
            // server MUNGKIN sudah mengirim: tidak pasti, attempt server tetap memblokir.
            const outcome = !sent || notSent ? ({ kind: "rejected", message } as const) : ({ kind: "unknown", message } as const);
            await recordNotPosted(outcome.kind === "rejected" ? "failed" : "unknown", message, accurateRes);
            toast.error(outcome.kind === "rejected" ? message : unknownMessage(message), { duration: 15000 });
        } finally {
            setBusyKey("");
        }
    };

    // Penyelesaian status TIDAK PASTI oleh manusia: dicatat server sebagai atestasi manual
    // (accurate_post_resolution.source = "manual_attestation"), bukan verifikasi provider.
    const handleResolveUnknown = async (record: FinanceRecord) => {
        const found = window.prompt(
            "Status posting TIDAK PASTI. Cek purchase-payment di Accurate.\n" +
            "Ketik NOMOR purchase-payment bila SUDAH ADA, atau ketik TIDAK ADA bila benar-benar tidak ada (posting ulang dibuka).",
        );
        if (found === null) return;
        const typed = found.trim();
        // Review #3: pilihan berbahaya (buka posting ulang) harus diketik, bukan default Enter kosong.
        if (!typed) {
            toast.error("Tidak ada yang diubah. Ketik nomor purchase-payment, atau TIDAK ADA.");
            return;
        }
        const number = typed.toUpperCase() === "TIDAK ADA" ? "" : typed;
        // C.15: sumber pemeriksaan wajib — "TIDAK ADA" tanpa jejak di mana dicek bukan bukti.
        const checked = window.prompt("Di mana Anda memeriksa? (mis. Accurate > Pembayaran Pembelian, database X, rentang tanggal Y)");
        if (!checked?.trim()) {
            toast.error("Sumber pemeriksaan wajib diisi. Tidak ada yang diubah.");
            return;
        }
        const key = recordKey(record);
        setBusyKey(key);
        try {
            const note = number ? `dicek manual di Accurate: ${number} ada` : "dicek manual di Accurate: tidak ditemukan";
            const r = await fetch("/api/finance/purchase-payment/resolve", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    invoiceNos: (record.detail_invoices || []).map((it) => it.invoiceNo),
                    decision: number ? "posted" : "absent",
                    accurateNumber: number,
                    reason: note,
                    checkedSource: checked.trim(),
                }),
            });
            const rOut = await r.json().catch(() => ({})) as { code?: string; error?: string };
            // 404 = unknown lama tanpa attempt server (sebelum command ada): lanjut ke catatan FastAPI.
            const serverOk = r.ok || r.status === 404 || (rOut.code === "already_posted" && Boolean(number));
            if (!serverOk) throw new Error(rOut.error || `Penyelesaian attempt server gagal (HTTP ${r.status})`);
            await updateFinanceStatus(record, {
                status_pembayaran: "Sudah Transfer",
                transfer_date: record.transfer_date || "",
                proof_id: record.transfer_proof?.proof_id || "",
                accurate_post_status: number ? "posted" : "failed",
                ...(number ? { accurate_purchase_payment_number: number } : { accurate_post_error: "dicek manual: tidak ada di Accurate" }),
                resolution_note: number ? `dicek manual di Accurate: ${number} ada` : "dicek manual di Accurate: tidak ditemukan",
            });
            toast.success(number ? `Ditandai posted (manual): ${number}` : "Ditandai tidak ada di Accurate — boleh posting ulang.");
            await fetchData(dateFilter);
        } catch (err: unknown) {
            toast.error(getErrorMessage(err, "Gagal menyimpan penyelesaian."));
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
                    <DatePickerField value={dateFilter} onChange={handleDateChange} className="w-[170px] py-2.5" ariaLabel="Filter tanggal finance" />
                    <div className="relative flex items-center">
                        <Search className="absolute left-3 text-slate-400" size={16} />
                        <input type="text" placeholder="Cari principle, draft, invoice, SPPD..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 pr-4 py-2.5 text-sm border border-white/10 rounded-lg outline-none bg-black/40 text-slate-300 w-80" />
                    </div>
                    <button onClick={() => fetchData(dateFilter)} className="flex items-center gap-2 bg-white/5 border border-white/10 text-slate-300 px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-white/10">
                        <RefreshCcw size={16} /> Refresh
                    </button>
                    <button onClick={handleExport} className="office-calm-contrast-text flex items-center gap-2 bg-emerald-600/20 border border-emerald-500/30 text-emerald-400 px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-emerald-500/30">
                        <Download size={16} /> Export Excel
                    </button>
                </div>
            </div>

            {errorMsg && (
                <div className="ui-state-panel--error mb-4 flex items-start gap-3 rounded-lg border p-4">
                    <AlertCircle className="shrink-0 text-[#b42318]" />
                    <p className="text-sm font-medium text-[#b42318]">{errorMsg}</p>
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
                            <thead className="office-calm-contrast-text bg-black/60 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
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
                                    const unknownPost = record.accurate_post_status === "unknown";
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
                                                    <DatePickerField value={transferDates[key] || ""} onChange={(value) => setTransferDates((prev) => ({ ...prev, [key]: value }))} className="py-1.5 text-xs focus:border-emerald-500" ariaLabel="Tanggal transfer" />
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
                                                {unknownPost && <div className="mt-2 max-w-[220px] text-[11px] text-amber-300" title={record.accurate_post_error}>Status Accurate TIDAK PASTI — cek purchase-payment sebelum posting ulang</div>}
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex flex-col gap-2 w-[190px]">
                                                    <button disabled={isBusy || posted || unknownPost} onClick={() => handleApproveTransfer(record)} className="inline-flex items-center justify-center gap-2 bg-emerald-600 text-white font-bold px-3 py-2 rounded hover:bg-emerald-500 disabled:opacity-50">
                                                        <Send size={14} /> Sudah Transfer
                                                    </button>
                                                    {unknownPost && (
                                                        <button disabled={isBusy} onClick={() => handleResolveUnknown(record)} className="inline-flex items-center justify-center gap-1 bg-amber-500/10 border border-amber-500/30 text-amber-300 px-2 py-1.5 rounded hover:bg-amber-500/20 disabled:opacity-50">
                                                            <AlertTriangle size={13} /> Sudah dicek di Accurate
                                                        </button>
                                                    )}
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
