"use client";

/*
 * Tujuan: Input order internal yang dihitung aturan promo terbit, lalu dibekukan pada order.
 * Caller: navigasi ruang kerja (/orders); Web Sales terpisah memakai endpoint yang sama.
 * Dependensi: FastAPI /orders, resolveApiBase, /api/me untuk token CSRF.
 * Main Functions: OrdersPage, submitOrder, loadOrders, pullWebSales; pratinjau + saran promo.
 * Side Effects: HTTP ke backend; angka promo dihitung server, bukan di browser.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, Plus, ClipboardList, Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { resolveApiBase } from "@/lib/apiBase";

const API_BASE = resolveApiBase();

type Line = { code: string; unit: string; quantity: string; price: string };
type Result = {
    gross: string; discount: string; net: string;
    bonuses: { program_id: string; code: string; unit: string; quantity: string; eligible_codes?: string[] }[];
    applications: { program_id: string; minimum: string; discount: string }[];
};
type Order = { id: string; outlet: string; channel: string; order_date: string; status: string; created_at: string; result: Result; owner?: string };
type Suggestion = { program_id: string; program_name: string; threshold: string; codes: string[]; minimum: string; current: string; gap: string; message: string };
type PriceInfo = { code: string; unit: string; price: number; source: "tier" | "standard" | "missing"; priceCategoryName: string | null; branchName: string | null; effectiveDate: string | null; knownUnits: string[] | null };

let cachedCsrf = "";
async function csrfHeader(): Promise<Record<string, string>> {
    if (!cachedCsrf) {
        try {
            const res = await fetch(`${API_BASE}/api/me`, { credentials: "include", signal: AbortSignal.timeout(15_000) });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.csrf_token) cachedCsrf = String(data.csrf_token);
        } catch { /* backend masih memeriksa same-origin bila token tidak tersedia */ }
    }
    return cachedCsrf ? { "X-CSRF-Token": cachedCsrf } : {};
}

async function send(method: string, path: string, body?: unknown) {
    const res = await fetch(`${API_BASE}${path}`, {
        method, credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "Content-Type": "application/json", ...(await csrfHeader()) },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data, error: String(data?.detail || data?.error || `HTTP ${res.status}`) };
}

// Satuan sengaja KOSONG: menebak "PCS" membuat harga jatuh ke fallback standar dengan satuan
// yang salah (item `M5012001000740`: BAG 15.900 vs KRT 1.144.800). Satuan diisi dari master.
const emptyLine = (): Line => ({ code: "", unit: "", quantity: "1", price: "0" });

type ItemMaster = { found: boolean; name: string; units: string[] };

export default function OrdersPage() {
    const today = new Date().toISOString().split("T")[0];
    const [outlet, setOutlet] = useState("");
    const [channel, setChannel] = useState("");
    const [orderDate, setOrderDate] = useState(today);
    const [note, setNote] = useState("");
    const [lines, setLines] = useState<Line[]>([emptyLine()]);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<Result | null>(null);
    const [orders, setOrders] = useState<Order[]>([]);
    const [scope, setScope] = useState<"mine" | "all">("mine");
    const [customerNo, setCustomerNo] = useState("");
    const [preview, setPreview] = useState<{ result: Result | null; suggestions: Suggestion[]; prices: PriceInfo[] } | null>(null);
    const [previewNote, setPreviewNote] = useState("");

    const loadOrders = useCallback(async (which: "mine" | "all") => {
        const res = await send("GET", `/orders?scope=${which}`);
        if (!res.ok) return;
        setOrders(res.data.orders || []);
        setScope(res.data.scope === "all" ? "all" : "mine");
    }, []);

    useEffect(() => { loadOrders("mine"); }, [loadOrders]);

    // Satuan dan nama barang dari master Accurate, satu permintaan per kode baru.
    const [master, setMaster] = useState<Record<string, ItemMaster>>({});
    const codesKey = [...new Set(lines.map(line => line.code.trim()).filter(Boolean))].join(",");
    useEffect(() => {
        const pending = codesKey.split(",").filter(code => code && !(code in master));
        if (pending.length === 0) return;
        const timer = setTimeout(async () => {
            const loaded = await Promise.all(pending.map(async code => {
                const fallback: [string, ItemMaster] = [code, { found: false, name: "", units: [] }];
                try {
                    const res = await fetch(`/api/items/units?code=${encodeURIComponent(code)}`);
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || !data.ok) return fallback;
                    return [code, { found: Boolean(data.found), name: String(data.name ?? ""), units: (data.units ?? []) as string[] }] as [string, ItemMaster];
                } catch { return fallback; }
            }));
            setMaster(prev => ({ ...prev, ...Object.fromEntries(loaded) }));
        }, 400);
        return () => clearTimeout(timer);
        // master sengaja tidak masuk deps: sudah dijaga filter `code in master`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codesKey]);

    // Satuan yang tidak ada di master dibuang; satu-satunya satuan dipilih otomatis.
    useEffect(() => {
        setLines(prev => prev.map(line => {
            const info = master[line.code.trim()];
            if (!info || info.units.length === 0 || info.units.includes(line.unit)) return line;
            return { ...line, unit: info.units.length === 1 ? info.units[0] : "" };
        }));
    }, [master]);

    const previewKey = JSON.stringify([channel, orderDate, customerNo, lines.map(line => [line.code, line.unit, line.quantity])]);
    useEffect(() => {
        // Baris kosong diabaikan, tapi baris yang sudah ada kodenya WAJIB lengkap: kalau baris
        // setengah terisi hanya dibuang dari pratinjau, totalnya terlihat benar padahal kurang.
        const filled = lines.filter(line => line.code.trim());
        const ready = channel.trim() && /^\d{4}-\d{2}-\d{2}$/.test(orderDate) && filled.length > 0
            && filled.every(line => line.unit.trim() && Number(line.quantity) > 0);
        if (!ready) { setPreview(null); setPreviewNote(""); return; }
        const timer = setTimeout(async () => {
            const payload = {
                channel, order_date: orderDate, customer_no: customerNo.trim(),
                lines: filled.map(line => ({ code: line.code.trim(), unit: line.unit, quantity: line.quantity })),
            };
            const res = await fetch("/api/orders/preview", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) { setPreview(null); setPreviewNote(String(data?.error || "Pratinjau tidak tersedia")); return; }
            setPreviewNote("");
            setPreview({ result: data.result ?? null, suggestions: data.suggestions ?? [], prices: data.prices ?? [] });
        }, 600);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewKey]);

    const priceByCode = useMemo(() => {
        const map = new Map<string, PriceInfo>();
        for (const row of preview?.prices ?? []) map.set(`${row.code}|${row.unit}`, row);
        return map;
    }, [preview]);

    // Saran dipasang di bawah baris barangnya sendiri; sisanya masuk satu banner.
    const adviceByCode = useMemo(() => {
        const map = new Map<string, Suggestion>();
        for (const advice of preview?.suggestions ?? []) {
            for (const code of advice.codes) {
                const current = map.get(code);
                if (!current || Number(advice.gap) < Number(current.gap)) map.set(code, advice);
            }
        }
        return map;
    }, [preview]);

    const submitOrder = async () => {
        setBusy(true);
        setResult(null);
        try {
            const res = await send("POST", "/orders", { outlet, channel, order_date: orderDate, note, lines });
            if (!res.ok) { toast.error(res.error); return; }
            setResult(res.data.order.result);
            toast.success("Order tersimpan dengan aturan promo yang dibekukan.");
            loadOrders(scope);
        } finally {
            setBusy(false);
        }
    };

    // Basis data Web Sales terpisah; petugas menarik permintaan order ke internal.
    const pullWebSales = async () => {
        setBusy(true);
        try {
            const res = await send("POST", "/orders/pull", {});
            if (!res.ok) { toast.error(res.error); return; }
            const imported = (res.data.imported || []).length;
            const repeated = (res.data.already_imported || []).length;
            const failed = (res.data.failed || []) as { request_id: string; error: string }[];
            toast.success(`Ditarik ${imported} order baru${repeated ? `, ${repeated} sudah pernah masuk` : ""}${failed.length ? `, ${failed.length} gagal` : ""}`);
            failed.slice(0, 3).forEach(item => toast.error(`${item.request_id.slice(0, 8)}: ${item.error}`));
            loadOrders(scope);
        } finally {
            setBusy(false);
        }
    };

    const updateLine = (index: number, field: keyof Line, value: string) =>
        setLines(prev => prev.map((line, i) => (i === index ? { ...line, [field]: value } : line)));

    return (
        <div className="p-4 sm:p-8 space-y-6">
            <div className="flex items-center gap-3">
                <ClipboardList className="text-emerald-600" size={26} />
                <div>
                    <h1 className="text-2xl font-bold">Order Masuk</h1>
                    <p className="text-sm text-slate-400">Diskon dan bonus dihitung server dari aturan promo yang sudah diterbitkan, lalu dibekukan pada order ini.</p>
                </div>
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-2xl p-5 space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                    <label className="text-xs text-slate-400">Outlet
                        <input value={outlet} onChange={e => setOutlet(e.target.value)} placeholder="Nama / kode outlet"
                            className="block w-56 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-300" />
                    </label>
                    <label className="text-xs text-slate-400">Channel
                        <input value={channel} onChange={e => setChannel(e.target.value.toUpperCase())} placeholder="GT / RETAIL"
                            className="block w-32 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-300" />
                    </label>
                    <label className="text-xs text-slate-400">Tanggal order
                        <input type="date" value={orderDate} onChange={e => setOrderDate(e.target.value)}
                            className="block bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-300" />
                    </label>
                    <label className="text-xs text-slate-400">Kode pelanggan Accurate
                        <input value={customerNo} onChange={e => setCustomerNo(e.target.value)} placeholder="C.00000"
                            className="block w-36 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-300" />
                    </label>
                    <label className="text-xs text-slate-400 flex-1 min-w-48">Catatan
                        <input value={note} onChange={e => setNote(e.target.value)} placeholder="opsional"
                            className="block w-full bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-300" />
                    </label>
                </div>

                <div className="space-y-2">
                    {lines.map((line, index) => {
                        const info = master[line.code.trim()];
                        return (
                        <div key={index} className="flex flex-wrap items-center gap-2">
                            <input value={line.code} placeholder="kode" onChange={e => updateLine(index, "code", e.target.value)}
                                className="w-56 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-300" />
                            {/* Satuan dari master Accurate. Item tanpa daftar harga (mis. sebelum sync
                                harga jual jalan) tetap bisa diketik — server tidak punya master untuk
                                menolaknya; itu degradasi, bukan izin menebak. */}
                            {info && info.units.length > 0 ? (
                                <select aria-label="Satuan" value={line.unit} onChange={e => updateLine(index, "unit", e.target.value)}
                                    className="w-28 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-300">
                                    <option value="">satuan</option>
                                    {info.units.map(unit => <option key={unit} value={unit}>{unit}</option>)}
                                </select>
                            ) : (
                                <input aria-label="Satuan" value={line.unit} placeholder="satuan" onChange={e => updateLine(index, "unit", e.target.value.toUpperCase())}
                                    className="w-28 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-300" />
                            )}
                            <input value={line.quantity} placeholder="jumlah" onChange={e => updateLine(index, "quantity", e.target.value)}
                                className="w-28 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-300" />
                            <input value={line.price} placeholder="harga" onChange={e => updateLine(index, "price", e.target.value)}
                                className="w-28 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-300" />
                            {lines.length > 1 && (
                                <button onClick={() => setLines(prev => prev.filter((_, i) => i !== index))} className="text-rose-600 hover:text-rose-500" aria-label="Hapus baris">
                                    <Trash2 size={15} />
                                </button>
                            )}
                            {info && (
                                <p className={`w-full text-xs ${info.found ? "text-slate-400" : "text-rose-600"}`}>
                                    {!info.found
                                        ? `Kode ${line.code.trim()} tidak ada di master Accurate`
                                        : info.units.length === 0
                                            ? `${info.name} — belum ada daftar harga, satuan tidak dapat diperiksa`
                                            : info.name}
                                </p>
                            )}
                            {(() => {
                                const priceRow = priceByCode.get(`${line.code.trim()}|${line.unit.trim().toUpperCase()}`);
                                if (!priceRow) return null;
                                return (
                                    <p className="w-full text-xs text-slate-400">
                                        {priceRow.source === "tier"
                                            ? `Harga ${priceRow.priceCategoryName ?? "kategori"} ${priceRow.price} · ${priceRow.branchName ?? "-"} · berlaku ${priceRow.effectiveDate ?? "-"}`
                                            : `Harga standar ${priceRow.price} (kategori pelanggan belum tersedia)`}
                                    </p>
                                );
                            })()}
                            {adviceByCode.get(line.code.trim()) && (
                                <p className="w-full flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                                    <Lightbulb size={13} className="mt-0.5 shrink-0" aria-hidden />
                                    <span>{adviceByCode.get(line.code.trim())!.message}</span>
                                </p>
                            )}
                        </div>
                        );
                    })}
                </div>

                {previewNote && <p className="text-xs text-rose-600">{previewNote}</p>}

                {preview?.result && (
                    <div className="rounded-lg border border-white/10 bg-black/40 p-3 text-sm text-slate-300">
                        <p>Perkiraan: bruto <span className="font-semibold">{preview.result.gross}</span> · diskon <span className="font-semibold text-rose-600">{preview.result.discount}</span> · netto <span className="font-semibold text-emerald-400">{preview.result.net}</span></p>
                        <p className="text-xs text-slate-400">Harga diambil dari master Accurate; angka final dibekukan saat order disimpan.</p>
                        {(preview.suggestions.length > 0) && (
                            <ul className="mt-2 space-y-0.5">
                                {preview.suggestions.slice(0, 3).map(advice => (
                                    <li key={advice.program_id + advice.codes.join()} className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                                        <Lightbulb size={13} className="mt-0.5 shrink-0" aria-hidden />
                                        <span>{advice.message}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}

                <div className="flex flex-wrap items-center gap-3">
                    <button onClick={() => setLines(prev => [...prev, emptyLine()])} className="flex items-center gap-1 text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg">
                        <Plus size={14} /> Tambah baris
                    </button>
                    <button onClick={submitOrder} disabled={busy || !outlet.trim() || !channel.trim()} className="bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
                        Hitung dan simpan order
                    </button>
                </div>

                {result && (
                    <div className="rounded-lg border border-white/10 bg-black/40 p-3 text-sm text-slate-300 space-y-1">
                        <p>Bruto <span className="font-semibold">{result.gross}</span> · diskon <span className="font-semibold text-rose-600">{result.discount}</span> · netto <span className="font-semibold text-emerald-400">{result.net}</span></p>
                        {result.applications.map((item, i) => (
                            <p key={i} className="text-xs text-slate-400">{item.program_id}: minimum {item.minimum} → potongan {item.discount}</p>
                        ))}
                        {result.bonuses.map((item, i) => (
                            <p key={i} className="text-xs text-slate-400">
                                Bonus {item.quantity} {item.unit} {item.code || `dari barang yang dibeli (${(item.eligible_codes || []).join(", ")})`} ({item.program_id})
                            </p>
                        ))}
                    </div>
                )}
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-2xl p-5">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <h2 className="text-lg font-bold">Order terakhir ({scope === "all" ? "semua sales" : "milik saya"})</h2>
                    <div className="flex flex-wrap gap-2">
                        <button onClick={pullWebSales} disabled={busy} className="text-xs bg-amber-600 hover:bg-amber-500 text-white px-3 py-1.5 rounded-lg font-semibold disabled:opacity-50">
                            Tarik order Web Sales
                        </button>
                        {(["mine", "all"] as const).map(which => (
                            <button key={which} onClick={() => loadOrders(which)} className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg">
                                {which === "mine" ? "Milik saya" : "Semua"}
                            </button>
                        ))}
                    </div>
                </div>
                {orders.length === 0 ? (
                    <p className="text-sm text-slate-400">Belum ada order.</p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border border-white/10">
                        <table className="w-full text-xs text-slate-300">
                            <thead className="bg-black/40 text-slate-400">
                                <tr>{["Waktu", "Outlet", "Channel", "Tanggal", "Status", "Bruto", "Diskon", "Netto"].map(head => (
                                    <th key={head} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">{head}</th>
                                ))}</tr>
                            </thead>
                            <tbody>
                                {orders.map(order => (
                                    <tr key={order.id} className="border-t border-white/5">
                                        <td className="px-2 py-1.5 whitespace-nowrap">{order.created_at.slice(0, 16).replace("T", " ")}</td>
                                        <td className="px-2 py-1.5">{order.outlet}</td>
                                        <td className="px-2 py-1.5">{order.channel}</td>
                                        <td className="px-2 py-1.5 whitespace-nowrap">{order.order_date}</td>
                                        <td className="px-2 py-1.5">{order.status}</td>
                                        <td className="px-2 py-1.5">{order.result.gross}</td>
                                        <td className="px-2 py-1.5">{order.result.discount}</td>
                                        <td className="px-2 py-1.5">{order.result.net}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
