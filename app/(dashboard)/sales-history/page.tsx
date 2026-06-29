/*
 * Tujuan: Halaman History Penjualan - cascade Tahun -> Principal -> Customer/Toko + pencarian produk, lalu tabel item FLAT
 *   (1 baris = 1 produk + No Faktur sejajar) untuk melihat history penjualan, bukan per-faktur.
 * Caller: Route dashboard /sales-history (guard RBAC sales_history.view di layout + server).
 * Dependensi: /api/sales-history/{years,principals,customers,item-search,import}, react-select, sonner.
 * Main Functions: SalesHistoryPage.
 * Side Effects: Fetch API cascade, fetch tabel item (Elasticsearch fuzzy bila tersedia, fallback SQLite), upload CSV e-Faktur, toast status.
 * Catatan: Tabel item hanya muncul setelah nama/kode produk diketik. Pencarian pakai Elasticsearch fuzzy (typo dibenarkan), fallback SQLite LIKE.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Select from "react-select";
import AsyncSelect from "react-select/async";
import type { StylesConfig, GroupBase } from "react-select";
import { toast } from "sonner";
import { CalendarDays, History, Upload, Building2, Store, Search, ChevronLeft, ChevronRight, X } from "lucide-react";

type Opt = { value: string; label: string };
type CustomerOpt = Opt & { nama: string; alamat: string; kota: string };
type ProductRow = {
    id: number;
    referensi: string;
    tanggal: string;
    principal: string;
    kodeCust: string;
    customerNama: string;
    kodeObjek: string;
    namaProduk: string;
    qty: number;
    satuan: string;
    hargaSatuan: number;
    hargaTotal: number;
    diskonRp: number;
    dpp: number;
    ppn: number;
};

const PAGE_SIZE = 50;
const currencyFmt = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rp = (n: number) => "Rp " + currencyFmt.format(Number(n || 0));
const pct = (diskon: number, bruto: number) => (bruto > 0 ? (diskon / bruto) * 100 : 0);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const selectStyles: StylesConfig<any, false, GroupBase<any>> = {
    control: (p, s) => ({ ...p, backgroundColor: "rgba(0,0,0,0.4)", borderColor: s.isFocused ? "rgba(99,102,241,0.6)" : "rgba(255,255,255,0.1)", boxShadow: "none", minHeight: 46, borderRadius: 12 }),
    menu: (p) => ({ ...p, backgroundColor: "#1a1c23", border: "1px solid rgba(255,255,255,0.1)", zIndex: 80 }),
    menuPortal: (p) => ({ ...p, zIndex: 9999 }),
    option: (p, s) => ({ ...p, backgroundColor: s.isFocused ? "rgba(99,102,241,0.15)" : "transparent", color: "#e2e8f0", cursor: "pointer" }),
    singleValue: (p) => ({ ...p, color: "#e2e8f0" }),
    input: (p) => ({ ...p, color: "#e2e8f0" }),
    placeholder: (p) => ({ ...p, color: "#64748b" }),
    indicatorSeparator: () => ({ display: "none" }),
};

function ItemHistoryTable({ rows, isLoading, hasQuery, frozen }: { rows: ProductRow[]; isLoading: boolean; hasQuery: boolean; frozen: boolean }) {
    // ponytail: overflow-clip (not overflow-hidden) agar sticky header tidak terperangkap di parent non-scrolling.
    const thFreeze = frozen ? "sticky top-0 z-20 bg-slate-100" : "";
    const th1Freeze = frozen ? "sticky top-0 left-0 z-30 bg-slate-100" : "";
    const td1Freeze = frozen ? "sticky left-0 z-10 bg-white group-hover:bg-slate-50" : "";
    return (
        <div className="overflow-clip rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto [overflow-y:clip]">
                <table className="w-full min-w-[1280px] table-fixed text-left text-sm">
                    <colgroup>
                        <col className="w-[11%]" />
                        <col className="w-[7%]" />
                        <col className="w-[12%]" />
                        <col className="w-[12%]" />
                        <col className="w-[22%]" />
                        <col className="w-[4%]" />
                        <col className="w-[4%]" />
                        <col className="w-[6%]" />
                        <col className="w-[6%]" />
                        <col className="w-[5%]" />
                        <col className="w-[5%]" />
                        <col className="w-[6%]" />
                    </colgroup>
                    <thead className="border-b border-slate-200 bg-slate-100 text-xs font-semibold uppercase text-slate-600">
                        <tr>
                            <th className={`px-4 py-3 ${th1Freeze}`}>No Faktur</th>
                            <th className={`px-4 py-3 ${thFreeze}`}>Tanggal</th>
                            <th className={`px-4 py-3 ${thFreeze}`}>Principal</th>
                            <th className={`px-4 py-3 ${thFreeze}`}>Customer / Toko</th>
                            <th className={`px-4 py-3 w-80 ${thFreeze}`}>Produk</th>
                            <th className={`px-4 py-3 text-right ${thFreeze}`}>Qty</th>
                            <th className={`px-4 py-3 ${thFreeze}`}>Satuan</th>
                            <th className={`px-4 py-3 text-right ${thFreeze}`}>Harga Satuan</th>
                            <th className={`px-4 py-3 text-right ${thFreeze}`}>Total Bruto</th>
                            <th className={`px-4 py-3 text-right ${thFreeze}`}>Diskon</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-slate-700">
                        {!hasQuery ? (
                            <tr><td colSpan={10} className="h-32 px-4 text-center text-slate-500">Ketik nama atau kode produk untuk menampilkan history penjualan.</td></tr>
                        ) : isLoading ? (
                            <tr><td colSpan={10} className="h-32 px-4 text-center text-slate-500">Memuat history item...</td></tr>
                        ) : rows.length ? (
                            rows.map((row) => (
                                <tr key={row.id} className="group hover:bg-slate-50">
                                    <td className={`px-4 py-3 font-semibold text-slate-800 ${td1Freeze}`}>{row.referensi}</td>
                                    <td className="px-4 py-3 tabular-nums">{row.tanggal}</td>
                                    <td className="px-4 py-3"><span className="block truncate" title={row.principal}>{row.principal}</span></td>
                                    <td className="px-4 py-3"><span className="block truncate font-medium" title={row.customerNama}>{row.customerNama}</span></td>
                                    <td className="px-4 py-3">
                                        <span className="block truncate font-medium" title={row.namaProduk}>{row.namaProduk}</span>
                                        <span className="block truncate text-xs text-slate-500" title={row.kodeObjek}>{row.kodeObjek}</span>
                                    </td>
                                    <td className="px-4 py-3 text-right tabular-nums">{Number(row.qty || 0).toLocaleString("id-ID")}</td>
                                    <td className="px-4 py-3 text-slate-600">{row.satuan || "-"}</td>
                                    <td className="px-4 py-3 text-right tabular-nums">{rp(row.hargaSatuan)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums">{rp(row.hargaTotal)}</td>
                                    <td className="px-4 py-3 text-right tabular-nums">
                                        <span className="block font-medium text-amber-600">{pct(row.diskonRp, row.hargaTotal).toFixed(1)}%</span>
                                        <span className="block text-xs text-slate-500">{rp(row.diskonRp)}</span>
                                    </td>
                                </tr>
                            ))
                        ) : (
                            <tr><td colSpan={10} className="h-32 px-4 text-center text-slate-500">Tidak ada item yang cocok dengan pencarian & filter ini.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export default function SalesHistoryPage() {
    const [menuPortalTarget, setMenuPortalTarget] = useState<HTMLElement | null>(null);
    const [yearOpts, setYearOpts] = useState<Opt[]>([]);
    const [year, setYear] = useState<Opt | null>(null);
    const [principalOpts, setPrincipalOpts] = useState<Opt[]>([]);
    const [principal, setPrincipal] = useState<Opt | null>(null);
    const [customer, setCustomer] = useState<CustomerOpt | null>(null);
    const [productInput, setProductInput] = useState("");
    const [productQuery, setProductQuery] = useState("");
    const [rows, setRows] = useState<ProductRow[]>([]);
    const [total, setTotal] = useState(0);
    const [totalApprox, setTotalApprox] = useState(false);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(false);
    const [searchBackend, setSearchBackend] = useState<"none" | "sqlite" | "elasticsearch">("none");
    const [uploading, setUploading] = useState(false);
    const [frozen, setFrozen] = useState(true);
    const selectPortalProps = { menuPortalTarget: menuPortalTarget ?? undefined, menuPosition: "fixed" as const };
    const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);

    useEffect(() => {
        setMenuPortalTarget(document.body);
    }, []);

    useEffect(() => {
        fetch("/api/sales-history/years", { credentials: "include" })
            .then((r) => r.json())
            .then((d) => { if (d.ok) setYearOpts((d.years as Record<string, unknown>[]).map((y) => ({ value: String(y.year), label: `${y.year} (${y.invoices})` }))); })
            .catch(() => {});
    }, []);

    useEffect(() => {
        const params = new URLSearchParams();
        if (year) params.set("year", year.value);
        const suffix = params.toString() ? `?${params}` : "";
        fetch(`/api/sales-history/principals${suffix}`, { credentials: "include" })
            .then((r) => r.json())
            .then((d) => { if (d.ok) setPrincipalOpts((d.principals as Record<string, unknown>[]).map((p) => ({ value: String(p.principal), label: `${p.principal} (${p.invoices})` }))); })
            .catch(() => {});
    }, [year]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setPage(1);
            setProductQuery(productInput.trim());
        }, 450);
        return () => window.clearTimeout(timer);
    }, [productInput]);

    useEffect(() => {
        // Item hanya tampil setelah produk diketik. Tanpa query: kosongkan tabel, jangan fetch.
        if (!productQuery) {
            setRows([]);
            setTotal(0);
            setTotalApprox(false);
            setSearchBackend("none");
            setLoading(false);
            return;
        }
        let cancelled = false;
        const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), product: productQuery });
        if (year) params.set("year", year.value);
        if (principal) params.set("principal", principal.value);
        if (customer) params.set("kodeCust", customer.value);

        setLoading(true);
        fetch(`/api/sales-history/item-search?${params}`, { credentials: "include" })
            .then((r) => r.json())
            .then((d) => {
                if (cancelled) return;
                if (!d.ok) {
                    toast.error(d.error || "Gagal memuat item.");
                    setRows([]);
                    setTotal(0);
                    setTotalApprox(false);
                    return;
                }
                setRows((d.items || []) as ProductRow[]);
                setTotal(Number(d.total || 0));
                setTotalApprox(Boolean(d.totalApproximate));
                setSearchBackend((d.searchBackend || "none") as "none" | "sqlite" | "elasticsearch");
            })
            .catch(() => { if (!cancelled) toast.error("Error jaringan saat memuat item."); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [year, principal, customer, productQuery, page]);

    const customerDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
    const loadCustomers = useCallback((input: string): Promise<CustomerOpt[]> => {
        return new Promise((resolve) => {
            if (customerDebounce.current) clearTimeout(customerDebounce.current);
            customerDebounce.current = setTimeout(async () => {
                const params = new URLSearchParams({ q: input, limit: "50" });
                if (year) params.set("year", year.value);
                if (principal) params.set("principal", principal.value);
                try {
                    const r = await fetch(`/api/sales-history/customers?${params}`, { credentials: "include" });
                    const d = await r.json();
                    if (!r.ok || !d.ok) { resolve([]); return; }
                    resolve((d.customers as Record<string, unknown>[]).map((c) => ({
                        value: String(c.kode), label: `${c.nama} - ${c.kode} (${c.invoices} faktur)`,
                        nama: String(c.nama), alamat: String(c.alamat ?? ""), kota: String(c.kota ?? ""),
                    })));
                } catch { resolve([]); }
            }, 350);
        });
    }, [year, principal]);

    // Saat principalOpts berubah (tahun berganti), lepas principal yang tidak ada di tahun baru.
    useEffect(() => {
        if (principalOpts.length === 0 || !principal) return;
        if (!principalOpts.some((p) => p.value === principal.value)) {
            toast.info(`Principal "${principal.label}" tidak ada di tahun yang dipilih.`);
            setPrincipal(null);
        }
    }, [principalOpts, principal]);

    const hasFilter = !!(year || principal || customer || productInput);
    const resetFilters = () => { setYear(null); setPrincipal(null); setCustomer(null); setProductInput(""); setPage(1); };

    const onYear = (opt: Opt | null) => { setYear(opt); setPage(1); };
    const onPrincipal = (opt: Opt | null) => { setPrincipal(opt); setPage(1); };
    const onCustomer = (opt: CustomerOpt | null) => { setCustomer(opt); setPage(1); };

    const onUpload = async (file: File | null) => {
        if (!file) return;
        setUploading(true);
        toast.info(`Mengimpor ${file.name}...`);
        try {
            const r = await fetch("/api/sales-history/import", {
                method: "POST", credentials: "include",
                headers: { "x-filename": file.name, "Content-Type": "text/csv" }, body: file,
            });
            const d = await r.json();
            if (r.ok && d.ok) toast.success(`Berhasil impor ${Number(d.imported || 0).toLocaleString("id-ID")} item dari ${d.sourceFile}.`);
            else toast.error(d.error || "Gagal impor (cek izin sales_history.manage).");
        } catch {
            toast.error("Error jaringan saat impor.");
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="pb-12">
            <div className="mb-6">
                <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-white">
                    <History className="text-indigo-400" />
                    History Penjualan
                </h1>
            </div>

            <div className="mb-6 grid gap-4 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-6 shadow-xl backdrop-blur-xl md:grid-cols-4">
                <div>
                    <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300"><CalendarDays size={16} /> Tahun</label>
                    <Select<Opt> {...selectPortalProps} options={yearOpts} value={year} onChange={onYear} styles={selectStyles} isClearable placeholder="Semua tahun..." noOptionsMessage={() => "Belum ada tahun"} />
                </div>
                <div>
                    <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300"><Building2 size={16} /> Principal</label>
                    <Select<Opt> {...selectPortalProps} options={principalOpts} value={principal} onChange={onPrincipal} styles={selectStyles} isClearable placeholder="Semua principal..." noOptionsMessage={() => "Belum ada data"} />
                </div>
                <div>
                    <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300"><Store size={16} /> Customer / Toko</label>
                    <AsyncSelect<CustomerOpt> {...selectPortalProps} key={`cust-${year?.value ?? "all"}-${principal?.value ?? "all"}`} cacheOptions defaultOptions loadOptions={loadCustomers} value={customer} onChange={onCustomer} styles={selectStyles} isClearable placeholder="Ketik nama/kode customer..." noOptionsMessage={() => "Tidak ada customer"} loadingMessage={() => "Mencari..."} />
                </div>
                <div>
                    <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-300"><Search size={16} /> Cari Produk</label>
                    <input
                        value={productInput}
                        onChange={(event) => setProductInput(event.target.value)}
                        placeholder="Nama/kode produk..."
                        className="h-[46px] w-full rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20"
                    />
                </div>
            </div>
            {hasFilter && (
                <div className="mb-3 flex justify-end">
                    <button
                        type="button"
                        onClick={resetFilters}
                        className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:border-red-500/30 hover:text-red-400"
                    >
                        <X size={13} />
                        Reset semua filter
                    </button>
                </div>
            )}

            <div className="mb-6 rounded-2xl border border-white/10 bg-white p-6 shadow-xl">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h2 className="text-lg font-bold text-slate-900">History Item</h2>
                        <p className="text-sm text-slate-500">
                            {productQuery
                                ? `${totalApprox ? "setidaknya " : ""}${total.toLocaleString("id-ID")} item - pencarian: ${searchBackend}`
                                : "Ketik nama/kode produk untuk mulai."}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-slate-500">
                        <button
                            type="button"
                            onClick={() => setFrozen((f) => !f)}
                            title={frozen ? "Nonaktifkan freeze pane" : "Aktifkan freeze pane (header + kolom No Faktur)"}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${frozen ? "border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                        >
                            Freeze {frozen ? "✓" : ""}
                        </button>
                        <button
                            type="button"
                            onClick={() => setPage((p) => Math.max(p - 1, 1))}
                            disabled={page <= 1 || loading || !productQuery}
                            className="rounded-lg border border-slate-200 p-2 disabled:opacity-40"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <span>Halaman {page} dari {pageCount}</span>
                        <button
                            type="button"
                            onClick={() => setPage((p) => Math.min(p + 1, pageCount))}
                            disabled={page >= pageCount || loading || !productQuery}
                            className="rounded-lg border border-slate-200 p-2 disabled:opacity-40"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </button>
                    </div>
                </div>
                <ItemHistoryTable rows={rows} isLoading={loading} hasQuery={Boolean(productQuery)} frozen={frozen} />
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-6 shadow-xl backdrop-blur-xl">
                <div className="mb-3 flex items-center gap-3">
                    <Upload className="text-indigo-400" size={22} />
                    <h2 className="text-lg font-bold text-white">Impor Data Item (CSV e-Faktur)</h2>
                </div>
                <p className="mb-4 text-sm text-slate-400">Upload CSV tetap tersedia untuk data e-Faktur. Data utama dari folder lokal diproses lewat script import.</p>
                <input
                    type="file"
                    accept=".csv,text/csv"
                    disabled={uploading}
                    onChange={(e) => onUpload(e.target.files?.[0] || null)}
                    className="block w-full overflow-hidden rounded-xl border border-white/10 bg-black/40 text-sm text-slate-400 file:mr-4 file:cursor-pointer file:border-0 file:bg-indigo-600 file:px-4 file:py-2.5 file:text-sm file:font-bold file:text-white hover:file:bg-indigo-500 disabled:opacity-50"
                />
            </div>
        </div>
    );
}
