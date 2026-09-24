/*
 * Tujuan: Normalisasi diskon pada faktur Accurate yang dibuat DI LUAR web — potongan yang Rekap
 *         Promo sebut "tak bertuan" digolongkan manusia jadi Disc Claim atau Disc Distributor.
 * Caller: Route dashboard `/normalisasi-diskon`.
 * Dependensi: GET /api/promo-recap (baris), /api/promo-recap/normalisasi (simpan/cabut), sonner.
 * Main Functions: NormalisasiDiskonPage, simpan, cabut.
 * Side Effects: HTTP; menulis `discount_normalization`. TIDAK menulis ke Accurate.
 *
 * Faktur yang terbit lewat web tidak ditampilkan: potongannya sudah dinilai gerbang validasi,
 * dan menggolongkannya di sini berarti menimpa putusan gerbang dengan tangan.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Undo2 } from "lucide-react";
import { toast } from "sonner";

type Row = {
    bucket: "principal" | "distributor" | "unowned";
    invoiceNo: string; invoiceId: string; lineKey: string; transDate: string;
    customerNo: string; customerName: string; itemCode: string; itemName: string;
    positions: string; percent: number; amount: number;
    suratProgram: string; promoGroup: string; reason: string;
};

type Data = { principals: string[]; recap: { rows: Row[] }; webInvoiceIds: string[] };

type Grup = { key: string; customerNo: string; customerName: string; positions: string; percent: number;
    bucket: Row["bucket"]; rows: Row[]; amount: number; invoices: number; reason: string };

const rp = (value: number) => `Rp ${Number(value).toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const NORMALISASI = "NORMALISASI";

/** Satu grup = outlet x posisi x persen: satu keputusan biasanya berlaku untuk pola yang sama. */
function kelompokkan(rows: Row[]): Grup[] {
    const map = new Map<string, Grup>();
    for (const row of rows) {
        const key = `${row.bucket}|${row.customerNo}|${row.positions}|${row.percent}`;
        const grup = map.get(key) ?? { key, customerNo: row.customerNo, customerName: row.customerName,
            positions: row.positions, percent: row.percent, bucket: row.bucket, rows: [], amount: 0, invoices: 0, reason: row.reason };
        grup.rows.push(row);
        grup.amount = Math.round((grup.amount + row.amount) * 100) / 100;
        map.set(key, grup);
    }
    for (const grup of map.values()) grup.invoices = new Set(grup.rows.map((row) => row.invoiceNo)).size;
    return [...map.values()].sort((a, b) => b.amount - a.amount);
}

export default function NormalisasiDiskonPage() {
    const now = new Date();
    const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
    const [to, setTo] = useState(ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
    const [principal, setPrincipal] = useState("");
    const [data, setData] = useState<Data | null>(null);
    const [pilih, setPilih] = useState<Set<string>>(new Set());
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        const query = new URLSearchParams({ from, to });
        if (principal) query.set("principal", principal);
        const res = await fetch(`/api/promo-recap?${query.toString()}`, { credentials: "include" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) { toast.error(body.error ?? "Data gagal dimuat"); return; }
        setData(body);
        setPilih(new Set());
    }, [from, to, principal]);

    useEffect(() => { void load(); }, [load]);

    const { calon, sudah } = useMemo(() => {
        const web = new Set(data?.webInvoiceIds ?? []);
        const luarWeb = (data?.recap.rows ?? []).filter((row) => !web.has(row.invoiceId));
        return {
            calon: kelompokkan(luarWeb.filter((row) => row.bucket === "unowned")),
            sudah: kelompokkan(luarWeb.filter((row) => row.suratProgram === NORMALISASI)),
        };
    }, [data]);

    const terpilih = (grup: Grup[]) => grup.filter((entry) => pilih.has(entry.key));
    const toggle = (key: string) => setPilih((lama) => {
        const baru = new Set(lama);
        if (baru.has(key)) baru.delete(key); else baru.add(key);
        return baru;
    });

    async function simpan(bucket: "principal" | "distributor") {
        const grup = terpilih(calon);
        const rows = grup.flatMap((entry) => entry.rows);
        if (!rows.length) { toast.error("Pilih dulu potongan yang akan dinormalisasi"); return; }
        const total = rows.reduce((sum, row) => sum + row.amount, 0);
        const label = bucket === "principal" ? "Disc Claim (ditagihkan ke principal)" : "Disc Distributor (beban sendiri)";
        if (!window.confirm(`${rows.length} potongan senilai ${rp(total)} akan digolongkan sebagai ${label}. Lanjutkan?`)) return;
        setBusy(true);
        try {
            const res = await fetch("/api/promo-recap/normalisasi", {
                method: "POST", credentials: "include", headers: { "content-type": "application/json" },
                body: JSON.stringify({ bucket, note, rows: rows.map((row) => ({
                    lineKey: row.lineKey, positions: row.positions, amount: row.amount, percent: row.percent,
                    invoiceNo: row.invoiceNo, invoiceId: row.invoiceId, transDate: row.transDate,
                    customerNo: row.customerNo, itemCode: row.itemCode })) }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menyimpan");
            toast.success(`${body.disimpan} potongan dinormalisasi`);
            setNote("");
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal menyimpan");
        } finally {
            setBusy(false);
        }
    }

    async function cabut() {
        const rows = terpilih(sudah).flatMap((entry) => entry.rows);
        if (!rows.length) { toast.error("Pilih dulu normalisasi yang akan dibatalkan"); return; }
        if (!window.confirm(`${rows.length} potongan akan kembali tak bertuan. Lanjutkan?`)) return;
        setBusy(true);
        try {
            const res = await fetch("/api/promo-recap/normalisasi", {
                method: "DELETE", credentials: "include", headers: { "content-type": "application/json" },
                body: JSON.stringify({ keys: rows.map((row) => ({ lineKey: row.lineKey, positions: row.positions })) }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal membatalkan");
            toast.success(`${body.dicabut} normalisasi dibatalkan`);
            await load();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal membatalkan");
        } finally {
            setBusy(false);
        }
    }

    const totalCalon = calon.reduce((sum, grup) => sum + grup.amount, 0);
    const totalTerpilih = terpilih(calon).reduce((sum, grup) => sum + grup.amount, 0);

    const tabel = (grup: Grup[], sudahDiputuskan: boolean) => (
        <div className="overflow-x-auto rounded-lg border border-white/10 max-h-[32rem]">
            <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-slate-950/95 text-slate-400 backdrop-blur">
                    <tr>
                        <th className="px-3 py-2 w-8">
                            <input type="checkbox" aria-label="Pilih semua"
                                checked={grup.length > 0 && grup.every((entry) => pilih.has(entry.key))}
                                onChange={(e) => setPilih((lama) => {
                                    const baru = new Set(lama);
                                    for (const entry of grup) { if (e.target.checked) baru.add(entry.key); else baru.delete(entry.key); }
                                    return baru;
                                })} />
                        </th>
                        <th className="px-3 py-2 text-left">Outlet</th>
                        <th className="px-3 py-2 text-left">Posisi</th>
                        <th className="px-3 py-2 text-right">Persen</th>
                        <th className="px-3 py-2 text-right">Baris</th>
                        <th className="px-3 py-2 text-right">Faktur</th>
                        <th className="px-3 py-2 text-right">Nominal</th>
                        <th className="px-3 py-2 text-left">{sudahDiputuskan ? "Digolongkan" : "Sebab"}</th>
                    </tr>
                </thead>
                <tbody>
                    {grup.map((entry) => (
                        <tr key={entry.key} className="border-t border-white/5 align-top">
                            <td className="px-3 py-1.5">
                                <input type="checkbox" aria-label={`Pilih ${entry.customerName}`} checked={pilih.has(entry.key)} onChange={() => toggle(entry.key)} />
                            </td>
                            <td className="px-3 py-1.5">
                                <div className="font-mono text-xs">{entry.customerNo}</div>
                                <div className="text-xs text-slate-500">{entry.customerName}</div>
                            </td>
                            <td className="px-3 py-1.5 font-mono text-xs">{entry.positions === "faktur" ? "tingkat faktur" : `D${entry.positions.replaceAll("+", "+D")}`}</td>
                            <td className="px-3 py-1.5 text-right">{entry.percent ? `${entry.percent}%` : "—"}</td>
                            <td className="px-3 py-1.5 text-right">{entry.rows.length}</td>
                            <td className="px-3 py-1.5 text-right">{entry.invoices}</td>
                            <td className="px-3 py-1.5 text-right">{rp(entry.amount)}</td>
                            <td className="px-3 py-1.5 text-xs max-w-md">
                                {sudahDiputuskan
                                    ? <span className={entry.bucket === "principal" ? "text-blue-300" : "text-slate-300"}>
                                        {entry.bucket === "principal" ? "Disc Claim" : "Disc Distributor"} · {entry.rows[0].reason}
                                    </span>
                                    : <span className="text-amber-200">{entry.reason}</span>}
                            </td>
                        </tr>
                    ))}
                    {!grup.length && (
                        <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">
                            {sudahDiputuskan ? "Belum ada yang dinormalisasi pada periode ini." : "Tidak ada potongan tak bertuan di faktur luar web pada periode ini."}
                        </td></tr>
                    )}
                </tbody>
            </table>
        </div>
    );

    return (
        <div className="p-6 space-y-6 text-slate-200">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold text-white">Normalisasi Diskon</h1>
                <p className="text-sm text-slate-400">
                    Potongan tak bertuan pada faktur yang dibuat langsung di Accurate (bukan lewat web ini).
                    Golongkan jadi <b>Disc Claim</b> atau <b>Disc Distributor</b> supaya keluar dari tak bertuan di
                    Rekap Promo. Faktur di Accurate tidak diubah; bila fakturnya diubah sesudah diputuskan,
                    keputusannya otomatis tidak dipakai.
                </p>
            </header>

            <section className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-black/20 p-4">
                <label className="text-sm">
                    <span className="block text-slate-400 mb-1">Dari</span>
                    <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-black/40 border border-white/10 rounded px-3 py-2" />
                </label>
                <label className="text-sm">
                    <span className="block text-slate-400 mb-1">Sampai</span>
                    <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-black/40 border border-white/10 rounded px-3 py-2" />
                </label>
                <label className="text-sm">
                    <span className="block text-slate-400 mb-1">Principal</span>
                    <select value={principal} onChange={(e) => setPrincipal(e.target.value)} className="bg-black/40 border border-white/10 rounded px-3 py-2">
                        <option value="">Semua principal</option>
                        {(data?.principals ?? []).map((nama) => <option key={nama} value={nama}>{nama}</option>)}
                    </select>
                </label>
                <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-sm">
                    <RefreshCw size={15} /> Muat
                </button>
            </section>

            <section className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                    <div>
                        <h2 className="text-lg font-semibold text-white">Tak bertuan · {rp(totalCalon)}</h2>
                        <p className="text-xs text-slate-500">Dikelompokkan per outlet, posisi, dan persen. Terpilih: {rp(totalTerpilih)}</p>
                    </div>
                    <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Catatan (opsional), mis. dasar keputusannya"
                        className="ml-auto min-w-64 bg-black/40 border border-white/10 rounded px-3 py-2 text-sm" />
                    <button disabled={busy} onClick={() => void simpan("principal")}
                        className="rounded bg-blue-600 px-3 py-2 text-sm disabled:opacity-40">Jadikan Disc Claim</button>
                    <button disabled={busy} onClick={() => void simpan("distributor")}
                        className="rounded bg-white/10 px-3 py-2 text-sm disabled:opacity-40">Jadikan Disc Distributor</button>
                </div>
                {tabel(calon, false)}
            </section>

            <section className="space-y-3">
                <div className="flex items-end gap-3">
                    <h2 className="text-lg font-semibold text-white">Sudah dinormalisasi</h2>
                    <button disabled={busy} onClick={() => void cabut()}
                        className="ml-auto inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-sm disabled:opacity-40">
                        <Undo2 size={15} /> Batalkan yang dipilih
                    </button>
                </div>
                {tabel(sudah, true)}
            </section>
        </div>
    );
}
