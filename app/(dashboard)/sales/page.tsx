"use client";

/*
 * Tujuan: Halaman order untuk sales di lapangan — kirim kuantitas, lihat nilai dan promo.
 * Caller: navigasi ruang kerja (/sales); dibatasi izin `websales.create` (bukan `order.create`).
 * Dependensi: /api/customers/lookup, /api/items/units, /api/orders/preview, FastAPI /websales/orders.
 * Main Functions: SalesOrderPage, submitRequest, loadRequests.
 * Side Effects: HTTP; permintaan order masuk ke basis data Web Sales yang terpisah.
 *
 * Sales TIDAK mengirim harga: yang dikirim hanya kode, satuan, jumlah. Nilai transaksi
 * dihitung server dari master Accurate + aturan promo terbit, dan ditampilkan di sini supaya
 * sales tahu angkanya. Satuan hanya boleh dari master (salah satuan = nilai salah puluhan kali).
 */

import { useCallback, useEffect, useState } from "react";
import { Trash2, Plus, Smartphone, Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { resolveApiBase } from "@/lib/apiBase";

const API_BASE = resolveApiBase();

type Line = { code: string; unit: string; quantity: string };
type ItemMaster = { found: boolean; name: string; units: string[] };
type CustomerMaster = { found: boolean; name: string; area: string; priceCategoryName: string };
type Suggestion = { program_id: string; message: string; codes: string[] };
type PriceInfo = { code: string; unit: string; price: number; source: string; priceCategoryName: string | null };
type Preview = { result: { gross: string; discount: string; net: string; bonuses: { code: string; unit: string; quantity: string; eligible_codes?: string[] }[] } | null; suggestions: Suggestion[]; prices: PriceInfo[] };
type RequestRow = { id: string; outlet: string; channel: string; order_date: string; status: string; created_at: string };

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

const emptyLine = (): Line => ({ code: "", unit: "", quantity: "1" });
const field = "w-full bg-black/50 border border-white/10 rounded-lg px-2 py-2 text-sm text-slate-300";

export default function SalesOrderPage() {
    const today = new Date().toISOString().split("T")[0];
    const [customerNo, setCustomerNo] = useState("");
    const [customer, setCustomer] = useState<CustomerMaster | null>(null);
    const [outlet, setOutlet] = useState("");
    const [channel, setChannel] = useState("");
    const [orderDate, setOrderDate] = useState(today);
    const [note, setNote] = useState("");
    const [lines, setLines] = useState<Line[]>([emptyLine()]);
    const [master, setMaster] = useState<Record<string, ItemMaster>>({});
    const [preview, setPreview] = useState<Preview | null>(null);
    const [previewNote, setPreviewNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [requests, setRequests] = useState<RequestRow[]>([]);

    const loadRequests = useCallback(async () => {
        const res = await send("GET", "/websales/orders");
        if (res.ok) setRequests(res.data.requests || []);
    }, []);
    useEffect(() => { loadRequests(); }, [loadRequests]);

    // Konfirmasi pelanggan: nama dan kategori harga. Outlet diisi otomatis supaya sales
    // tidak mengetik nama yang berbeda dari master.
    useEffect(() => {
        const code = customerNo.trim();
        if (!code) { setCustomer(null); return; }
        const timer = setTimeout(async () => {
            try {
                const res = await fetch(`/api/customers/lookup?no=${encodeURIComponent(code)}`);
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.ok) { setCustomer(null); return; }
                setCustomer({ found: Boolean(data.found), name: String(data.name ?? ""), area: String(data.area ?? ""), priceCategoryName: String(data.priceCategoryName ?? "") });
                if (data.found && !outlet.trim()) setOutlet(String(data.name ?? ""));
            } catch { setCustomer(null); }
        }, 400);
        return () => clearTimeout(timer);
        // outlet sengaja tidak masuk deps: prefill hanya saat outlet masih kosong.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [customerNo]);

    // Satuan dari master Accurate, satu permintaan per kode baru.
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codesKey]);

    useEffect(() => {
        setLines(prev => prev.map(line => {
            const info = master[line.code.trim()];
            if (!info || info.units.length === 0 || info.units.includes(line.unit)) return line;
            return { ...line, unit: info.units.length === 1 ? info.units[0] : "" };
        }));
    }, [master]);

    // Nilai transaksi dan saran promo dihitung server; sales melihat, tidak menentukan.
    const previewKey = JSON.stringify([channel, orderDate, customerNo, lines]);
    useEffect(() => {
        const filled = lines.filter(line => line.code.trim());
        const ready = channel.trim() && /^\d{4}-\d{2}-\d{2}$/.test(orderDate) && filled.length > 0
            && filled.every(line => line.unit.trim() && Number(line.quantity) > 0);
        if (!ready) { setPreview(null); setPreviewNote(""); return; }
        const timer = setTimeout(async () => {
            const res = await fetch("/api/orders/preview", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    channel, order_date: orderDate, customer_no: customerNo.trim(),
                    lines: filled.map(line => ({ code: line.code.trim(), unit: line.unit, quantity: line.quantity })),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) { setPreview(null); setPreviewNote(String(data?.error || "Perkiraan tidak tersedia")); return; }
            setPreviewNote("");
            setPreview({ result: data.result ?? null, suggestions: data.suggestions ?? [], prices: data.prices ?? [] });
        }, 600);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewKey]);

    const updateLine = (index: number, key: keyof Line, value: string) =>
        setLines(prev => prev.map((line, i) => (i === index ? { ...line, [key]: value } : line)));

    const submitRequest = async () => {
        const filled = lines.filter(line => line.code.trim() && line.unit.trim() && Number(line.quantity) > 0);
        if (filled.length !== lines.filter(line => line.code.trim()).length) {
            toast.error("Lengkapi satuan dan jumlah setiap baris.");
            return;
        }
        setBusy(true);
        try {
            const res = await send("POST", "/websales/orders", {
                outlet, channel, order_date: orderDate, note, customer_no: customerNo.trim(),
                lines: filled.map(line => ({ code: line.code.trim(), unit: line.unit, quantity: line.quantity })),
            });
            if (!res.ok) { toast.error(res.error); return; }
            toast.success("Order terkirim; menunggu ditarik petugas.");
            setLines([emptyLine()]);
            setNote("");
            setPreview(null);
            loadRequests();
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="p-4 sm:p-8 space-y-5 max-w-3xl">
            <div className="flex items-center gap-3">
                <Smartphone className="text-emerald-600" size={26} />
                <div>
                    <h1 className="text-2xl font-bold">Order Sales</h1>
                    <p className="text-sm text-slate-400">Kirim jumlah barang; harga, diskon, dan bonus dihitung server dari master Accurate dan promo yang berlaku.</p>
                </div>
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-2xl p-4 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-xs text-slate-400">Kode pelanggan Accurate
                        <input value={customerNo} onChange={e => setCustomerNo(e.target.value)} placeholder="C.00000" className={field} />
                    </label>
                    <label className="text-xs text-slate-400">Outlet
                        <input value={outlet} onChange={e => setOutlet(e.target.value)} placeholder="Nama outlet" className={field} />
                    </label>
                </div>
                {customer && (
                    <p className={`text-xs ${customer.found ? "text-slate-400" : "text-rose-600"}`}>
                        {customer.found
                            ? `${customer.name}${customer.area ? ` · ${customer.area}` : ""} · harga ${customer.priceCategoryName || "standar (kategori belum tersedia)"}`
                            : `Kode ${customerNo.trim()} tidak ada di master Accurate`}
                    </p>
                )}
                <div className="grid gap-3 sm:grid-cols-3">
                    <label className="text-xs text-slate-400">Channel
                        <input value={channel} onChange={e => setChannel(e.target.value.toUpperCase())} placeholder="GT / RETAIL" className={field} />
                    </label>
                    <label className="text-xs text-slate-400">Tanggal order
                        <input type="date" value={orderDate} onChange={e => setOrderDate(e.target.value)} className={field} />
                    </label>
                    <label className="text-xs text-slate-400">Catatan
                        <input value={note} onChange={e => setNote(e.target.value)} placeholder="opsional" className={field} />
                    </label>
                </div>

                <div className="space-y-3">
                    {lines.map((line, index) => {
                        const info = master[line.code.trim()];
                        const price = preview?.prices.find(row => row.code === line.code.trim() && row.unit === line.unit);
                        const advice = preview?.suggestions.find(item => item.codes.includes(line.code.trim()));
                        return (
                            <div key={index} className="rounded-lg border border-white/10 p-3 space-y-2">
                                <div className="flex items-center gap-2">
                                    <input value={line.code} placeholder="kode barang" onChange={e => updateLine(index, "code", e.target.value)} className={field} />
                                    {lines.length > 1 && (
                                        <button onClick={() => setLines(prev => prev.filter((_, i) => i !== index))} className="text-rose-600 hover:text-rose-500 shrink-0" aria-label="Hapus baris">
                                            <Trash2 size={16} />
                                        </button>
                                    )}
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    {info && info.units.length > 0 ? (
                                        <select aria-label="Satuan" value={line.unit} onChange={e => updateLine(index, "unit", e.target.value)} className={field}>
                                            <option value="">satuan</option>
                                            {info.units.map(unit => <option key={unit} value={unit}>{unit}</option>)}
                                        </select>
                                    ) : (
                                        <input aria-label="Satuan" value={line.unit} placeholder="satuan" onChange={e => updateLine(index, "unit", e.target.value.toUpperCase())} className={field} />
                                    )}
                                    <input inputMode="numeric" value={line.quantity} placeholder="jumlah" onChange={e => updateLine(index, "quantity", e.target.value)} className={field} />
                                </div>
                                {info && (
                                    <p className={`text-xs ${info.found ? "text-slate-400" : "text-rose-600"}`}>
                                        {!info.found
                                            ? `Kode ${line.code.trim()} tidak ada di master Accurate`
                                            : info.units.length === 0
                                                ? `${info.name} — belum ada daftar harga`
                                                : info.name}
                                    </p>
                                )}
                                {price && <p className="text-xs text-slate-400">Harga {price.priceCategoryName || "standar"} {price.price}</p>}
                                {advice && (
                                    <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                                        <Lightbulb size={13} className="mt-0.5 shrink-0" aria-hidden />
                                        <span>{advice.message}</span>
                                    </p>
                                )}
                            </div>
                        );
                    })}
                </div>

                {previewNote && <p className="text-xs text-rose-600">{previewNote}</p>}

                {preview?.result && (
                    <div className="rounded-lg border border-white/10 bg-black/40 p-3 text-sm text-slate-300 space-y-1">
                        <p>Bruto <span className="font-semibold">{preview.result.gross}</span></p>
                        <p>Diskon <span className="font-semibold text-rose-600">{preview.result.discount}</span></p>
                        <p>Netto <span className="font-semibold text-emerald-400">{preview.result.net}</span></p>
                        {preview.result.bonuses.map((bonus, i) => (
                            <p key={i} className="text-xs text-slate-400">
                                Bonus {bonus.quantity} {bonus.unit} {bonus.code || `dari barang yang dibeli (${(bonus.eligible_codes || []).join(", ")})`}
                            </p>
                        ))}
                        <p className="text-xs text-slate-400">Perkiraan; angka final dibekukan petugas saat order diproses.</p>
                    </div>
                )}

                <div className="flex flex-wrap gap-2">
                    <button onClick={() => setLines(prev => [...prev, emptyLine()])} className="flex items-center gap-1 text-xs bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 rounded-lg">
                        <Plus size={14} /> Tambah barang
                    </button>
                    <button onClick={submitRequest} disabled={busy || !outlet.trim() || !channel.trim() || !customerNo.trim()}
                        className="bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50">
                        Kirim order
                    </button>
                </div>
            </div>

            <div className="bg-[#1a1c23]/60 border border-white/10 rounded-2xl p-4">
                <h2 className="text-lg font-bold mb-2">Order saya</h2>
                {requests.length === 0 ? (
                    <p className="text-sm text-slate-400">Belum ada order terkirim.</p>
                ) : (
                    <ul className="space-y-2">
                        {requests.map(row => (
                            <li key={row.id} className="rounded-lg border border-white/10 p-2 text-xs text-slate-300">
                                <span className="font-semibold">{row.outlet}</span> · {row.channel} · {row.order_date}
                                <span className={`ml-2 ${row.status === "pulled" ? "text-emerald-400" : "text-amber-400"}`}>
                                    {row.status === "pulled" ? "sudah diproses" : "menunggu"}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
