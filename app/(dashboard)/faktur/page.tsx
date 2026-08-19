/*
 * Tujuan: Halaman Faktur Penjualan — cari faktur di cache DB, pilih kolom yang tampil, buka satu
 *   baris untuk melihat detail per item (qty, harga, diskon) yang diambil live dari Accurate.
 * Caller: Route dashboard /faktur (RBAC sales_history.view).
 * Dependensi: /api/faktur (daftar), /api/faktur/[id] (detail item).
 * Main Functions: FakturPage, ColumnPicker, DetailPanel.
 * Side Effects: fetch API; detail diambil saat baris dibuka; pilihan kolom disimpan di localStorage.
 * Catatan tema: WAJIB pakai token CSS (--surface, --luxury-*, --border-*) — aplikasi punya 3 tema
 *   (office-calm terang, neon, ios). Warna Tailwind hardcode akan rusak di tema lain.
 */
"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronLeft, ChevronRight, Columns3, ReceiptText, Search } from "lucide-react";

type Row = {
    id: number;
    number: string | null;
    transDate: string | null;
    customerNo: string | null;
    customerName: string | null;
    totalAmount: number | null;
    outstanding: number | null;
    status: string | null;
    dueDate: string | null;
    age: number | null;
    lastUpdateAt: string | null;
    createdAt: string | null;
};
type Item = { itemNo: string; itemName: string; quantity: number; unit: string; unitPrice: number; discount: number; total: number };
type Detail = {
    number: string; transDate: string; dueDate: string; customerNo: string; customerName: string;
    branchName: string; salesName: string; description: string; status: string;
    subTotal: number; totalDiscount: number; tax: number; totalAmount: number;
    paid: number; owing: number; paymentTerm: string; lastPaymentDate: string; items: Item[];
};

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const rp = (n: number | null | undefined) => "Rp " + nf.format(Number(n || 0));
const dash = (v: string | null | undefined) => (v && v.trim() ? v : "–");

const WaktuCell = ({ value }: { value: string | null }) =>
    value
        ? <span className="tabular-nums text-xs">{new Date(value).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })}</span>
        : <span style={{ color: "var(--luxury-subtle)" }}>–</span>;

type Align = "left" | "right";
type ColDef<T> = { key: string; label: string; align: Align; cell: (row: T) => React.ReactNode };

const INVOICE_COLUMNS: ColDef<Row>[] = [
    { key: "number", label: "No. Faktur", align: "left", cell: (r) => <span className="font-mono text-xs">{dash(r.number)}</span> },
    { key: "transDate", label: "Tanggal", align: "left", cell: (r) => dash(r.transDate) },
    { key: "customerName", label: "Pelanggan", align: "left", cell: (r) => dash(r.customerName) },
    { key: "customerNo", label: "Kode Pelanggan", align: "left", cell: (r) => <span className="font-mono text-xs">{dash(r.customerNo)}</span> },
    { key: "totalAmount", label: "Total", align: "right", cell: (r) => <span className="tabular-nums">{rp(r.totalAmount)}</span> },
    {
        key: "outstanding", label: "Sisa Tagihan", align: "right",
        // Terisi dari primeOwing lewat cron/webhook. Faktur lama yang belum kena sync sejak
        // 2026-08-19 masih null — tampilkan "–", jangan Rp 0 yang menyesatkan sebagai lunas.
        cell: (r) => r.outstanding === null || r.outstanding === undefined
            ? <span style={{ color: "var(--luxury-subtle)" }}>–</span>
            : <span className="tabular-nums" style={{ color: r.outstanding > 0 ? "var(--luxury-bronze)" : "var(--luxury-teal)" }}>{rp(r.outstanding)}</span>,
    },
    { key: "status", label: "Status", align: "left", cell: (r) => <StatusPill value={r.status} /> },
    { key: "dueDate", label: "Jatuh Tempo", align: "left", cell: (r) => dash(r.dueDate) },
    { key: "age", label: "Umur (hari)", align: "right", cell: (r) => <span className="tabular-nums">{r.age ?? "–"}</span> },
    {
        key: "createdAt", label: "Waktu Dibuat", align: "left",
        // Dasar pengurutan daftar ini. Hanya terisi untuk faktur yang masuk lewat webhook —
        // list.do tidak mengirim createDate, jadi faktur lama menampilkan "–".
        cell: (r) => <WaktuCell value={r.createdAt} />,
    },
    {
        key: "lastUpdateAt", label: "Waktu Perubahan", align: "left",
        // BUKAN waktu faktur dibuat: nilainya ikut berubah saat faktur dilunasi.
        cell: (r) => <WaktuCell value={r.lastUpdateAt} />,
    },
];

const ITEM_COLUMNS: ColDef<Item>[] = [
    { key: "itemNo", label: "Kode", align: "left", cell: (i) => <span className="font-mono text-xs opacity-70">{dash(i.itemNo)}</span> },
    { key: "itemName", label: "Nama Barang", align: "left", cell: (i) => dash(i.itemName) },
    { key: "quantity", label: "Qty", align: "right", cell: (i) => <span className="tabular-nums">{nf.format(i.quantity)}</span> },
    { key: "unit", label: "Satuan", align: "left", cell: (i) => dash(i.unit) },
    { key: "unitPrice", label: "Harga", align: "right", cell: (i) => <span className="tabular-nums">{rp(i.unitPrice)}</span> },
    { key: "discount", label: "Diskon", align: "right", cell: (i) => <span className="tabular-nums">{i.discount ? rp(i.discount) : "–"}</span> },
    { key: "total", label: "Total", align: "right", cell: (i) => <span className="tabular-nums">{rp(i.total)}</span> },
];

const DEFAULT_INVOICE_COLS = ["number", "transDate", "customerName", "totalAmount", "outstanding", "status", "createdAt"];
const DEFAULT_ITEM_COLS = ["itemNo", "itemName", "quantity", "unit", "unitPrice", "total"];
const STORAGE_KEY = "faktur.columns.v1";

// ponytail: localStorage, bukan tabel preferensi di DB. Pilihan kolom itu kenyamanan per-perangkat,
// bukan data bisnis — kalau hilang, tampilan kembali ke default dan tidak ada yang rusak.
function loadCols(): { invoice: string[]; item: string[] } | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.invoice) || !Array.isArray(parsed?.item)) return null;
        return { invoice: parsed.invoice, item: parsed.item };
    } catch {
        return null;
    }
}

function StatusPill({ value }: { value: string | null }) {
    const lunas = value === "Lunas";
    return (
        <span
            className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
            style={{
                color: lunas ? "var(--luxury-teal)" : "var(--luxury-soft)",
                background: lunas ? "color-mix(in srgb, var(--luxury-teal) 12%, transparent)" : "color-mix(in srgb, var(--luxury-soft) 14%, transparent)",
            }}
        >
            {dash(value)}
        </span>
    );
}

function ColumnPicker({
    invoiceCols, itemCols, onChange,
}: {
    invoiceCols: string[];
    itemCols: string[];
    onChange: (next: { invoice: string[]; item: string[] }) => void;
}) {
    const toggle = (scope: "invoice" | "item", key: string) => {
        const current = scope === "invoice" ? invoiceCols : itemCols;
        // Minimal satu kolom harus tersisa — tabel tanpa kolom bukan tampilan, itu bug.
        const next = current.includes(key)
            ? current.length > 1 ? current.filter((k) => k !== key) : current
            : [...current, key];
        onChange(scope === "invoice" ? { invoice: next, item: itemCols } : { invoice: invoiceCols, item: next });
    };

    const group = (scope: "invoice" | "item", defs: ColDef<never>[], selected: string[], title: string) => (
        <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--luxury-subtle)" }}>{title}</p>
            {defs.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--surface-2)]">
                    <input
                        type="checkbox"
                        checked={selected.includes(c.key)}
                        onChange={() => toggle(scope, c.key)}
                        className="h-4 w-4 rounded"
                        style={{ accentColor: "var(--luxury-gold)" }}
                    />
                    <span style={{ color: "var(--luxury-text)" }}>{c.label}</span>
                </label>
            ))}
        </div>
    );

    // <details> native: dapat keyboard, Esc, dan klik-di-luar dari browser tanpa satu baris JS.
    return (
        <details className="relative">
            <summary
                className="flex cursor-pointer list-none items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm transition-colors hover:bg-[var(--surface-2)]"
                style={{ borderColor: "var(--border-strong)", color: "var(--luxury-text)", background: "var(--surface)" }}
            >
                <Columns3 className="h-4 w-4" aria-hidden />
                Kolom
                <span className="tabular-nums text-xs" style={{ color: "var(--luxury-subtle)" }}>
                    {invoiceCols.length + itemCols.length}
                </span>
            </summary>
            <div
                className="absolute right-0 z-30 mt-2 grid w-[min(30rem,calc(100vw-2rem))] gap-5 rounded-2xl border p-4 shadow-[var(--luxury-shadow)] sm:grid-cols-2"
                style={{ borderColor: "var(--border-strong)", background: "var(--app-bg)" }}
            >
                {group("invoice", INVOICE_COLUMNS as ColDef<never>[], invoiceCols, "Kolom daftar faktur")}
                {group("item", ITEM_COLUMNS as ColDef<never>[], itemCols, "Kolom detail item")}
            </div>
        </details>
    );
}

function DetailPanel({ id, cols }: { id: number; cols: ColDef<Item>[] }) {
    const [detail, setDetail] = useState<Detail | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Panel selalu mount ulang saat faktur lain dibuka, jadi state awalnya sudah kosong.
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

    if (error) {
        return <p className="px-5 py-4 text-sm" style={{ color: "var(--luxury-bronze)" }}>{error}</p>;
    }
    if (!detail) {
        return (
            <div className="space-y-2 px-5 py-4" aria-live="polite" aria-busy="true">
                <span className="sr-only">Mengambil detail dari Accurate</span>
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className="h-7 rounded-md motion-safe:animate-pulse"
                        style={{ background: "var(--surface-2)", width: `${94 - i * 12}%` }}
                    />
                ))}
            </div>
        );
    }

    const meta = [
        ["Cabang", detail.branchName],
        ["Sales", detail.salesName],
        ["Jatuh tempo", detail.dueDate],
        ["Termin", detail.paymentTerm],
        ["Bayar terakhir", detail.lastPaymentDate],
        ["Keterangan", detail.description],
    ].filter(([, v]) => v);

    return (
        <div className="space-y-4 px-5 py-5">
            {meta.length > 0 && (
                <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    {meta.map(([label, value]) => (
                        <div key={label}>
                            <dt className="text-xs" style={{ color: "var(--luxury-subtle)" }}>{label}</dt>
                            <dd style={{ color: "var(--luxury-text)" }}>{value}</dd>
                        </div>
                    ))}
                </dl>
            )}

            {detail.items.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--luxury-soft)" }}>
                    Accurate tidak mengembalikan baris item untuk faktur ini.
                </p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[36rem] border-collapse text-sm">
                        <thead>
                            <tr style={{ color: "var(--luxury-subtle)" }}>
                                {cols.map((c) => (
                                    <th
                                        key={c.key}
                                        scope="col"
                                        className={`border-b px-3 py-2 text-xs font-medium ${c.align === "right" ? "text-right" : "text-left"}`}
                                        style={{ borderColor: "var(--border-soft)" }}
                                    >
                                        {c.label}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {detail.items.map((it, i) => (
                                <tr key={`${it.itemNo}-${i}`} style={{ color: "var(--luxury-text)" }}>
                                    {cols.map((c) => (
                                        <td key={c.key} className={`px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"}`}>
                                            {c.cell(it)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="flex flex-wrap justify-end gap-x-8 gap-y-1 text-sm">
                {([["Subtotal", detail.subTotal], ["Diskon", detail.totalDiscount], ["Pajak", detail.tax]] as const).map(([label, value]) => (
                    <span key={label} style={{ color: "var(--luxury-subtle)" }}>
                        {label} <span className="ml-1 tabular-nums" style={{ color: "var(--luxury-text)" }}>{rp(value)}</span>
                    </span>
                ))}
                <span style={{ color: "var(--luxury-subtle)" }}>
                    Total <span className="ml-1 font-semibold tabular-nums" style={{ color: "var(--luxury-gold)" }}>{rp(detail.totalAmount)}</span>
                </span>
                <span style={{ color: "var(--luxury-subtle)" }}>
                    Dibayar <span className="ml-1 tabular-nums" style={{ color: "var(--luxury-text)" }}>{rp(detail.paid)}</span>
                </span>
                {/* Sisa tagihan hanya ada di detail.do (primeOwing) — list.do tidak punya outstanding,
                    jadi angka ini tidak bisa ditarik dari cache DB. */}
                <span style={{ color: "var(--luxury-subtle)" }}>
                    Sisa tagihan{" "}
                    <span
                        className="ml-1 font-semibold tabular-nums"
                        style={{ color: detail.owing > 0 ? "var(--luxury-bronze)" : "var(--luxury-teal)" }}
                    >
                        {rp(detail.owing)}
                    </span>
                </span>
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
    const [cols, setCols] = useState({ invoice: DEFAULT_INVOICE_COLS, item: DEFAULT_ITEM_COLS });

    useEffect(() => {
        const stored = loadCols();
        if (stored) setCols(stored);
    }, []);

    const setColumns = useCallback((next: { invoice: string[]; item: string[] }) => {
        setCols(next);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* mode privat: tampilan tetap jalan */ }
    }, []);

    // Urutan kolom mengikuti definisi, bukan urutan klik — supaya tabel tidak acak setiap dipilih ulang.
    const invoiceCols = useMemo(() => INVOICE_COLUMNS.filter((c) => cols.invoice.includes(c.key)), [cols.invoice]);
    const itemCols = useMemo(() => ITEM_COLUMNS.filter((c) => cols.item.includes(c.key)), [cols.item]);

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

    const colCount = invoiceCols.length + 1;

    return (
        <div className="mx-auto w-full max-w-[var(--ui-content-wide)] space-y-6 px-[var(--ui-page-gutter)] py-6">
            <header className="flex items-start gap-3">
                <ReceiptText className="mt-0.5 h-6 w-6 shrink-0" style={{ color: "var(--luxury-gold)" }} aria-hidden />
                <div>
                    <h1 className="text-xl font-semibold" style={{ color: "var(--luxury-text)" }}>Faktur Penjualan</h1>
                    <p className="text-sm" style={{ color: "var(--luxury-muted)" }}>
                        Buka satu baris untuk melihat rincian barang, jumlah, dan harga langsung dari Accurate.
                    </p>
                </div>
            </header>

            <div className="flex flex-wrap items-center gap-3">
                <div className="relative min-w-[16rem] flex-1">
                    <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "var(--luxury-subtle)" }} aria-hidden />
                    <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        aria-label="Cari faktur"
                        placeholder="Cari nomor faktur atau nama pelanggan"
                        className="w-full rounded-xl border py-2.5 pl-10 pr-3 text-sm outline-none focus-visible:ring-2"
                        style={{ borderColor: "var(--border-strong)", background: "var(--surface)", color: "var(--luxury-text)" }}
                    />
                </div>
                <label className="flex cursor-pointer items-center gap-2.5 text-sm" style={{ color: "var(--luxury-text)" }}>
                    <input
                        type="checkbox"
                        checked={invOnly}
                        onChange={(e) => { setInvOnly(e.target.checked); setPage(1); }}
                        className="h-4 w-4 rounded"
                        style={{ accentColor: "var(--luxury-gold)" }}
                    />
                    Hanya nomor INV
                </label>
                <ColumnPicker invoiceCols={cols.invoice} itemCols={cols.item} onChange={setColumns} />
            </div>

            <div className="overflow-hidden rounded-[var(--ui-radius-panel)] border" style={{ borderColor: "var(--border-strong)", background: "var(--surface)" }}>
                <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                        <thead className="sticky top-0 z-10 backdrop-blur" style={{ background: "var(--surface-2)" }}>
                            <tr style={{ color: "var(--luxury-subtle)" }}>
                                <th scope="col" className="w-10 border-b px-3 py-3" style={{ borderColor: "var(--border-soft)" }}>
                                    <span className="sr-only">Buka detail</span>
                                </th>
                                {invoiceCols.map((c) => (
                                    <th
                                        key={c.key}
                                        scope="col"
                                        className={`whitespace-nowrap border-b px-3 py-3 text-xs font-medium ${c.align === "right" ? "text-right" : "text-left"}`}
                                        style={{ borderColor: "var(--border-soft)" }}
                                    >
                                        {c.label}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {loading && [0, 1, 2, 3, 4, 5].map((i) => (
                                <tr key={`skeleton-${i}`}>
                                    <td colSpan={colCount} className="px-3 py-2.5">
                                        <div className="h-5 rounded motion-safe:animate-pulse" style={{ background: "var(--surface-2)" }} />
                                    </td>
                                </tr>
                            ))}

                            {!loading && rows.length === 0 && (
                                <tr>
                                    <td colSpan={colCount} className="px-4 py-14 text-center">
                                        <p className="text-sm font-medium" style={{ color: "var(--luxury-text)" }}>
                                            {query ? `Tidak ada faktur yang cocok dengan "${query}".` : "Belum ada faktur di cache."}
                                        </p>
                                        <p className="mt-1 text-sm" style={{ color: "var(--luxury-muted)" }}>
                                            {query
                                                ? "Coba kata kunci lain, atau matikan filter “Hanya nomor INV” untuk memunculkan retur."
                                                : "Faktur akan muncul otomatis begitu Accurate mengirim webhook atau sync berjalan."}
                                        </p>
                                    </td>
                                </tr>
                            )}

                            {!loading && rows.map((row) => {
                                const open = openId === row.id;
                                return (
                                    <Fragment key={row.id}>
                                        <tr
                                            onClick={() => setOpenId(open ? null : row.id)}
                                            className="cursor-pointer border-b transition-colors hover:bg-[var(--surface-2)]"
                                            style={{ borderColor: "var(--border-soft)", color: "var(--luxury-text)", background: open ? "var(--surface-2)" : undefined }}
                                        >
                                            <td className="px-3 py-2.5">
                                                <button
                                                    type="button"
                                                    aria-expanded={open}
                                                    aria-label={`Detail faktur ${row.number ?? row.id}`}
                                                    onClick={(e) => { e.stopPropagation(); setOpenId(open ? null : row.id); }}
                                                    className="grid h-6 w-6 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2"
                                                    style={{ color: "var(--luxury-subtle)" }}
                                                >
                                                    <ChevronDown
                                                        className={`h-4 w-4 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
                                                        aria-hidden
                                                    />
                                                </button>
                                            </td>
                                            {invoiceCols.map((c) => (
                                                <td key={c.key} className={`px-3 py-2.5 ${c.align === "right" ? "text-right" : "text-left"}`}>
                                                    {c.cell(row)}
                                                </td>
                                            ))}
                                        </tr>
                                        {open && (
                                            <tr style={{ background: "var(--surface-2)" }}>
                                                <td colSpan={colCount} className="border-b p-0" style={{ borderColor: "var(--border-soft)" }}>
                                                    <DetailPanel id={row.id} cols={itemCols} />
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="flex items-center justify-between text-sm" style={{ color: "var(--luxury-muted)" }}>
                <span>Halaman {page}</span>
                <div className="flex gap-2">
                    <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1 || loading}
                        className="flex items-center gap-1.5 rounded-xl border px-3.5 py-2 transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:hover:bg-transparent"
                        style={{ borderColor: "var(--border-strong)", color: "var(--luxury-text)" }}
                    >
                        <ChevronLeft className="h-4 w-4" aria-hidden /> Sebelumnya
                    </button>
                    <button
                        onClick={() => setPage((p) => p + 1)}
                        disabled={!hasMore || loading}
                        className="flex items-center gap-1.5 rounded-xl border px-3.5 py-2 transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:hover:bg-transparent"
                        style={{ borderColor: "var(--border-strong)", color: "var(--luxury-text)" }}
                    >
                        Berikutnya <ChevronRight className="h-4 w-4" aria-hidden />
                    </button>
                </div>
            </div>
        </div>
    );
}
