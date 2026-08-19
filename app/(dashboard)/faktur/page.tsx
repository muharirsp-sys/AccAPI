/*
 * Tujuan: Halaman Faktur Penjualan — cari faktur di cache DB, buka satu baris untuk melihat
 *   detail per item (qty, harga, diskon) yang diambil live dari Accurate detail.do.
 * Caller: Route dashboard /faktur (RBAC sales_history.view).
 * Dependensi: /api/faktur (daftar), /api/faktur/[id] (detail item).
 * Main Functions: FakturPage, DetailPanel.
 * Side Effects: fetch API; detail hanya diambil saat baris dibuka (bukan saat daftar dimuat).
 */
"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Loader2, ReceiptText, Search } from "lucide-react";

type Row = {
    id: number;
    number: string | null;
    transDate: string | null;
    customerNo: string | null;
    customerName: string | null;
    totalAmount: number | null;
    status: string | null;
    dueDate: string | null;
    age: number | null;
};
type Item = { itemNo: string; itemName: string; quantity: number; unit: string; unitPrice: number; discount: number; total: number };
type Detail = {
    number: string; transDate: string; dueDate: string; customerNo: string; customerName: string;
    branchName: string; salesName: string; description: string; status: string;
    subTotal: number; totalDiscount: number; tax: number; totalAmount: number; items: Item[];
};

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const rp = (n: number | null | undefined) => "Rp " + nf.format(Number(n || 0));

function DetailPanel({ id }: { id: number }) {
    const [detail, setDetail] = useState<Detail | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Tanpa reset state: panel ini selalu mount ulang saat faktur lain dibuka (hanya satu
        // baris terbuka), jadi state awalnya sudah kosong.
        let alive = true;
        fetch(`/api/faktur/${id}`)
            .then((r) => r.json())
            .then((j) => {
                if (!alive) return;
                if (j?.ok) setDetail(j.faktur);
                else setError(j?.error || "Gagal memuat detail.");
            })
            .catch(() => { if (alive) setError("Gagal menghubungi server."); });
        return () => { alive = false; };
    }, [id]);

    if (error) return <div className="px-4 py-3 text-sm text-rose-300">{error}</div>;
    if (!detail) {
        return (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Mengambil detail dari Accurate…
            </div>
        );
    }

    return (
        <div className="space-y-3 px-4 py-4">
            <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-3">
                {detail.branchName && <div>Cabang: <span className="text-slate-200">{detail.branchName}</span></div>}
                {detail.salesName && <div>Sales: <span className="text-slate-200">{detail.salesName}</span></div>}
                {detail.dueDate && <div>Jatuh tempo: <span className="text-slate-200">{detail.dueDate}</span></div>}
                {detail.description && <div className="sm:col-span-3">Keterangan: <span className="text-slate-200">{detail.description}</span></div>}
            </div>

            {detail.items.length === 0 ? (
                <p className="text-sm text-amber-300">Accurate tidak mengembalikan baris item untuk faktur ini.</p>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-white/10">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="bg-white/5 text-xs uppercase tracking-wide text-slate-400">
                            <tr>
                                <th className="px-3 py-2 text-left font-medium">Kode</th>
                                <th className="px-3 py-2 text-left font-medium">Nama Barang</th>
                                <th className="px-3 py-2 text-right font-medium">Qty</th>
                                <th className="px-3 py-2 text-left font-medium">Satuan</th>
                                <th className="px-3 py-2 text-right font-medium">Harga</th>
                                <th className="px-3 py-2 text-right font-medium">Diskon</th>
                                <th className="px-3 py-2 text-right font-medium">Total</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {detail.items.map((it, i) => (
                                <tr key={`${it.itemNo}-${i}`} className="text-slate-200">
                                    <td className="px-3 py-2 font-mono text-xs text-slate-400">{it.itemNo || "-"}</td>
                                    <td className="px-3 py-2">{it.itemName || "-"}</td>
                                    <td className="px-3 py-2 text-right tabular-nums">{nf.format(it.quantity)}</td>
                                    <td className="px-3 py-2 text-slate-400">{it.unit || "-"}</td>
                                    <td className="px-3 py-2 text-right tabular-nums">{rp(it.unitPrice)}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-amber-300">{it.discount ? rp(it.discount) : "-"}</td>
                                    <td className="px-3 py-2 text-right tabular-nums">{rp(it.total)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-sm">
                <span className="text-slate-400">Subtotal <span className="ml-1 tabular-nums text-slate-200">{rp(detail.subTotal)}</span></span>
                <span className="text-slate-400">Diskon <span className="ml-1 tabular-nums text-slate-200">{rp(detail.totalDiscount)}</span></span>
                <span className="text-slate-400">Pajak <span className="ml-1 tabular-nums text-slate-200">{rp(detail.tax)}</span></span>
                <span className="text-slate-400">Total <span className="ml-1 font-semibold tabular-nums text-indigo-300">{rp(detail.totalAmount)}</span></span>
            </div>
        </div>
    );
}

export default function FakturPage() {
    const [q, setQ] = useState("");
    const [query, setQuery] = useState("");
    const [invOnly, setInvOnly] = useState(true);
    const [page, setPage] = useState(1);
    const [rows, setRows] = useState<Row[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [openId, setOpenId] = useState<number | null>(null);

    // Debounce ketikan — tanpa ini tiap huruf memicu ILIKE ke ~179k baris.
    useEffect(() => {
        const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 350);
        return () => clearTimeout(t);
    }, [q]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ page: String(page) });
            if (query) params.set("q", query);
            if (!invOnly) params.set("all", "1");
            const res = await fetch(`/api/faktur?${params}`);
            const json = await res.json();
            if (!json?.ok) throw new Error(json?.error || "Gagal memuat daftar faktur.");
            setRows(json.rows);
            setHasMore(json.hasMore);
            setOpenId(null);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal memuat daftar faktur.");
            setRows([]);
            setHasMore(false);
        } finally {
            setLoading(false);
        }
    }, [page, query, invOnly]);

    useEffect(() => { load(); }, [load]);

    return (
        <div className="space-y-5 p-4 sm:p-6">
            <header className="flex items-center gap-3">
                <ReceiptText className="h-6 w-6 text-indigo-300" />
                <div>
                    <h1 className="text-xl font-semibold text-slate-100">Faktur Penjualan</h1>
                    <p className="text-sm text-slate-400">Klik baris untuk melihat detail per item langsung dari Accurate.</p>
                </div>
            </header>

            <div className="flex flex-wrap items-center gap-3">
                <div className="relative min-w-[260px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Cari nomor faktur atau nama pelanggan…"
                        className="w-full rounded-xl border border-white/10 bg-black/40 py-2.5 pl-10 pr-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-indigo-500/60 focus:outline-none"
                    />
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
                    <input
                        type="checkbox"
                        checked={invOnly}
                        onChange={(e) => { setInvOnly(e.target.checked); setPage(1); }}
                        className="h-4 w-4 accent-indigo-500"
                    />
                    Hanya nomor INV
                </label>
            </div>

            <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#1a1c23]/60">
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-sm">
                        <thead className="bg-white/5 text-xs uppercase tracking-wide text-slate-400">
                            <tr>
                                <th className="w-8 px-3 py-3" />
                                <th className="px-3 py-3 text-left font-medium">No. Faktur</th>
                                <th className="px-3 py-3 text-left font-medium">Tanggal</th>
                                <th className="px-3 py-3 text-left font-medium">Pelanggan</th>
                                <th className="px-3 py-3 text-right font-medium">Total</th>
                                <th className="px-3 py-3 text-left font-medium">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {loading && (
                                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                                </td></tr>
                            )}
                            {!loading && rows.length === 0 && (
                                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Tidak ada faktur yang cocok.</td></tr>
                            )}
                            {!loading && rows.map((row) => (
                                <Fragment key={row.id}>
                                    <tr
                                        onClick={() => setOpenId(openId === row.id ? null : row.id)}
                                        className="cursor-pointer text-slate-200 hover:bg-white/5"
                                    >
                                        <td className="px-3 py-3 text-slate-500">
                                            {openId === row.id ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                        </td>
                                        <td className="px-3 py-3 font-mono text-xs">{row.number || "-"}</td>
                                        <td className="px-3 py-3 text-slate-400">{row.transDate || "-"}</td>
                                        <td className="px-3 py-3">
                                            {row.customerName || "-"}
                                            {row.customerNo && <span className="ml-2 text-xs text-slate-500">{row.customerNo}</span>}
                                        </td>
                                        <td className="px-3 py-3 text-right tabular-nums">{rp(row.totalAmount)}</td>
                                        <td className="px-3 py-3">
                                            <span className={row.status === "Lunas" ? "text-emerald-300" : "text-amber-300"}>{row.status || "-"}</span>
                                        </td>
                                    </tr>
                                    {openId === row.id && (
                                        <tr className="bg-black/30">
                                            <td colSpan={6} className="p-0"><DetailPanel id={row.id} /></td>
                                        </tr>
                                    )}
                                </Fragment>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="flex items-center justify-between text-sm text-slate-400">
                <span>Halaman {page}</span>
                <div className="flex gap-2">
                    <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1 || loading}
                        className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 disabled:opacity-40"
                    >
                        <ChevronLeft className="h-4 w-4" /> Sebelumnya
                    </button>
                    <button
                        onClick={() => setPage((p) => p + 1)}
                        disabled={!hasMore || loading}
                        className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 disabled:opacity-40"
                    >
                        Berikutnya <ChevronRight className="h-4 w-4" />
                    </button>
                </div>
            </div>
        </div>
    );
}
