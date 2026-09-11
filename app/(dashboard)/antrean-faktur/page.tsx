/*
 * Tujuan: Satu layar untuk antrean faktur Accurate — yang menunggu, yang ditolak, yang TIDAK
 *         PASTI — dengan umur masalah dan eskalasi ke OM setelah 2 jam.
 * Caller: Route dashboard `/antrean-faktur`.
 * Dependensi: /api/invoice-outbox, toast Sonner, lucide-react.
 * Main Functions: AntreanFakturPage, load, act.
 * Side Effects: HTTP; tindakan hanya `resend` dan `discard`, keduanya khusus yang DITOLAK.
 *
 * Laporan OM bukan halaman terpisah: saringan "hanya lewat 2 jam" pada layar ini adalah
 * laporannya — daftar yang sama, isian yang sama (faktur, sales, jenis masalah, umurnya),
 * dan tidak ada angka kedua yang bisa berbeda dari layar admin.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Send, Trash2, HelpCircle, CheckCircle2, Clock } from "lucide-react";
import { toast } from "sonner";

type Row = {
    orderId: string; soNo: string | null; source: string; customerNo: string; outlet: string; salesman: string;
    orderDate: string; state: string; attempts: number; lastError: string; accurateNumber: string;
    queuedBy: string; createdAt: string; updatedAt: string; ageMinutes: number; overdue: boolean;
};

type Data = {
    escalateAfterMinutes: number;
    summary: Record<string, number>;
    overdue: number;
    rows: Row[];
};

const STATES: { key: string; label: string; hint: string; className: string }[] = [
    { key: "queued", label: "Menunggu kirim", hint: "sudah diantrekan, belum dikirim", className: "text-slate-200" },
    { key: "sending", label: "Sedang dikirim", hint: "permintaan sedang berjalan", className: "text-blue-300" },
    { key: "rejected", label: "Ditolak Accurate", hint: "Accurate menjawab dan menolak; aman diperbaiki lalu dikirim ulang", className: "text-amber-300" },
    { key: "unknown", label: "TIDAK PASTI", hint: "Accurate tidak menjawab; fakturnya mungkin sudah terbentuk", className: "text-red-300" },
    { key: "posted", label: "Terkirim", hint: "faktur sudah terbentuk di Accurate", className: "text-emerald-300" },
];

const usia = (minutes: number) => (minutes < 60 ? `${minutes} menit` : `${Math.floor(minutes / 60)} jam ${minutes % 60} menit`);

export default function AntreanFakturPage() {
    const [data, setData] = useState<Data | null>(null);
    const [picked, setPicked] = useState<string[]>([]);
    const [onlyOverdue, setOnlyOverdue] = useState(false);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        const query = new URLSearchParams();
        if (picked.length) query.set("state", picked.join(","));
        if (onlyOverdue) query.set("overdue", "1");
        const res = await fetch(`/api/invoice-outbox?${query.toString()}`, { credentials: "include" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) { toast.error(body.error ?? "Antrean gagal dimuat"); return; }
        setData(body);
    }, [picked, onlyOverdue]);

    useEffect(() => { void load(); }, [load]);

    async function act(orderId: string, action: "resend" | "discard") {
        if (action === "discard" && !confirm(
            "Buang baris ini dari antrean? Pakai ini kalau angkanya yang salah — batch yang sudah "
            + "diperbaiki bisa diantrekan ulang setelahnya.")) return;
        setBusy(true);
        try {
            const res = await fetch("/api/invoice-outbox", {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId, action }),
            });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Tindakan gagal");
            toast.success(action === "resend" ? "Dilepas ulang ke antrean kirim" : "Dibuang dari antrean");
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Tindakan gagal");
        } finally {
            setBusy(false);
        }
    }

    const toggle = (key: string) => setPicked((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);

    return (
        <div className="p-6 space-y-6 text-slate-200">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold text-white">Antrean Faktur</h1>
                <p className="text-sm text-slate-400">
                    Faktur yang menunggu dikirim ke Accurate, yang ditolak, dan yang tidak jelas nasibnya.
                    Umur dihitung sejak faktur masuk antrean dan belum sampai ke Accurate — menekan
                    Kirim ulang tidak menyetel ulang jamnya. Lewat {data?.escalateAfterMinutes ?? 120} menit masuk laporan OM.
                </p>
            </header>

            {!!data?.overdue && (
                <div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-4">
                    <AlertTriangle className="text-red-300" size={20} />
                    <div className="flex-1">
                        <p className="font-medium text-red-200">{data.overdue} faktur menggantung lebih dari 2 jam</p>
                        <p className="text-xs text-red-200/80">Ini isi laporan OM. Centang saringan di bawah untuk melihat hanya yang itu.</p>
                    </div>
                    <button onClick={() => setOnlyOverdue(true)} className="rounded bg-red-500/20 px-3 py-1.5 text-sm text-red-100">
                        Tampilkan
                    </button>
                </div>
            )}

            <section className="flex flex-wrap items-center gap-2">
                {STATES.map((state) => (
                    <button key={state.key} onClick={() => toggle(state.key)} title={state.hint}
                        className={`rounded-full border px-3 py-1.5 text-xs ${picked.includes(state.key) ? "border-blue-400 bg-blue-500/20" : "border-white/10 bg-black/20"}`}>
                        <span className={state.className}>{state.label}</span>
                        <span className="ml-2 text-slate-400">{data?.summary?.[state.key] ?? 0}</span>
                    </button>
                ))}
                <label className="ml-auto flex items-center gap-2 text-sm text-slate-300">
                    <input type="checkbox" checked={onlyOverdue} onChange={(event) => setOnlyOverdue(event.target.checked)} />
                    Hanya yang lewat 2 jam (laporan OM)
                </label>
                <button onClick={() => void load()} className="inline-flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-xs">
                    <RefreshCw size={13} /> Muat ulang
                </button>
            </section>

            <div className="overflow-x-auto rounded-lg border border-white/10">
                <table className="w-full text-sm">
                    <thead className="bg-white/5 text-slate-400">
                        <tr>
                            <th className="px-3 py-2 text-left">Faktur / SO</th>
                            <th className="px-3 py-2 text-left">Outlet</th>
                            <th className="px-3 py-2 text-left">Sales</th>
                            <th className="px-3 py-2 text-left">Tanggal</th>
                            <th className="px-3 py-2 text-left">Status</th>
                            <th className="px-3 py-2 text-left">Umur masalah</th>
                            <th className="px-3 py-2 text-right">Coba</th>
                            <th className="px-3 py-2 text-left">Jawaban Accurate</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {data?.rows.map((row) => (
                            <tr key={row.orderId} className={`border-t border-white/5 ${row.overdue ? "bg-red-500/5" : ""}`}>
                                <td className="px-3 py-2">
                                    <div className="font-mono text-xs">{row.soNo ?? row.orderId}</div>
                                    <div className="text-xs text-slate-500">{row.source}{row.accurateNumber ? ` · ${row.accurateNumber}` : ""}</div>
                                </td>
                                <td className="px-3 py-2">
                                    <div className="font-mono text-xs">{row.customerNo}</div>
                                    <div className="text-xs text-slate-500">{row.outlet || "—"}</div>
                                </td>
                                <td className="px-3 py-2 font-mono text-xs">{row.salesman || "—"}</td>
                                <td className="px-3 py-2 text-xs">{row.orderDate}</td>
                                <td className="px-3 py-2 text-xs">
                                    <span className={STATES.find((state) => state.key === row.state)?.className ?? ""}>
                                        {row.state === "posted" && <CheckCircle2 size={13} className="mr-1 inline" />}
                                        {row.state === "unknown" && <HelpCircle size={13} className="mr-1 inline" />}
                                        {STATES.find((state) => state.key === row.state)?.label ?? row.state}
                                    </span>
                                </td>
                                <td className={`px-3 py-2 text-xs ${row.overdue ? "text-red-300" : "text-slate-400"}`}>
                                    {row.state === "posted" ? "—" : (
                                        <>
                                            <Clock size={12} className="mr-1 inline" />{usia(row.ageMinutes)}
                                            {row.attempts > 0 && (
                                                <div className="text-slate-500">coba terakhir {new Date(row.updatedAt).toLocaleString("id-ID")}</div>
                                            )}
                                        </>
                                    )}
                                </td>
                                <td className="px-3 py-2 text-right text-xs">{row.attempts}</td>
                                <td className="px-3 py-2 text-xs max-w-md break-words text-amber-200/90">{row.lastError || "—"}</td>
                                <td className="px-3 py-2 text-right whitespace-nowrap">
                                    {row.state === "rejected" && (
                                        <>
                                            <button onClick={() => void act(row.orderId, "resend")} disabled={busy}
                                                title="Sudah diperbaiki di Accurate; kirim payload yang sama sekali lagi"
                                                className="mr-1 inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs disabled:opacity-40">
                                                <Send size={13} /> Kirim ulang
                                            </button>
                                            <button onClick={() => void act(row.orderId, "discard")} disabled={busy}
                                                title="Angkanya yang salah; buang supaya batch yang diperbaiki bisa diantrekan ulang"
                                                className="px-2 text-red-400 hover:text-red-300 disabled:opacity-40">
                                                <Trash2 size={15} />
                                            </button>
                                        </>
                                    )}
                                    {row.state === "unknown" && (
                                        <span className="text-xs text-red-300/80">cocokkan manual</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                        {!data?.rows.length && (
                            <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">Tidak ada faktur yang menggantung.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            <p className="text-xs text-slate-500">
                <strong className="text-red-300">TIDAK PASTI</strong> berarti Accurate tidak menjawab — fakturnya
                mungkin sudah terbentuk di sana. Baris itu tidak punya tombol dengan sengaja: faktur ganda di
                Accurate tidak bisa dibatalkan. Cocokkan dulu lewat pencarian <span className="font-mono">charField1</span>,
                baru putuskan. Pengirim terjadwal hanya mengambil yang berstatus <em>menunggu kirim</em>.
            </p>
        </div>
    );
}
