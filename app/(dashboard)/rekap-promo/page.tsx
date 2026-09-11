/*
 * Tujuan: Rekap promo akhir bulan — diskon yang BENAR-BENAR keluar dari Accurate, siapa
 *         menanggungnya, dan apakah sesuai mekanisme surat.
 * Caller: Route dashboard `/rekap-promo`.
 * Dependensi: /api/promo-recap, toast Sonner, lucide-react.
 * Main Functions: RekapPromoPage, load, importRules.
 * Side Effects: HTTP; impor aturan default PRATINJAU, menulis hanya setelah dikonfirmasi.
 *
 * Angka di layar ini milik Accurate, bukan hitungan kita. Aturan promo hanya dipakai untuk
 * menjelaskan angka itu — selisihnya justru temuan yang dicari, bukan galat yang disembunyikan.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Upload, RefreshCw, CheckCircle2, FileWarning } from "lucide-react";
import { toast } from "sonner";

type Program = {
    key: string; suratProgram: string; promoLabel: string; promoGroup: string;
    principalAmount: number; lines: number; invoices: number;
    mismatched: { invoiceNo: string; itemCode: string; expected: number; actual: number }[];
};

type Data = {
    from: string; to: string; invoicesInRange: number; invoicesWithoutDetail: number; rules: number;
    recap: {
        invoices: number; lines: number; gross: number; distributor: number; principal: number;
        unowned: number; principalWithoutRule: number; cashDiscount: number; programs: Program[];
        unownedLines: { invoiceNo: string; itemCode: string; amount: number; positions: number[] }[];
        unexplained: { invoiceNo: string; itemCode: string; amount: number }[];
    };
};

const rp = (value: number) => `Rp ${Number(value).toLocaleString("id-ID", { maximumFractionDigits: 0 })}`;
// toISOString() memakai UTC, jadi tanggal 1 di WITA berubah jadi tanggal 31 bulan sebelumnya.
// Periode rekap harus mengikuti tanggal SETEMPAT, bukan tanggal server.
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const bulanIni = () => {
    const now = new Date();
    return {
        from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    };
};

export default function RekapPromoPage() {
    const awal = bulanIni();
    const [from, setFrom] = useState(awal.from);
    const [to, setTo] = useState(awal.to);
    const [data, setData] = useState<Data | null>(null);
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<{ rows: number; programs: number; tingkatFaktur: number; issues: string[] } | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        const res = await fetch(`/api/promo-recap?from=${from}&to=${to}`, { credentials: "include" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) { toast.error(body.error ?? "Rekap gagal dimuat"); return; }
        setData(body);
    }, [from, to]);

    useEffect(() => { void load(); }, [load]);

    async function importRules(apply: boolean) {
        if (!file) { toast.error("Pilih berkas Summary (xlsx) dulu"); return; }
        setBusy(true);
        try {
            const form = new FormData();
            form.append("file", file);
            form.append("apply", String(apply));
            const res = await fetch("/api/promo-recap", { method: "POST", credentials: "include", body: form });
            const body = await res.json();
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Impor aturan gagal");
            setPreview(body);
            if (apply) {
                toast.success(`${body.rows} aturan dimuat (${body.programs} program)`);
                setPreview(null); setFile(null);
                await load();
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Impor aturan gagal");
        } finally {
            setBusy(false);
        }
    }

    const r = data?.recap;
    const bersih = r && r.unowned === 0 && r.principalWithoutRule === 0;

    return (
        <div className="p-6 space-y-6 text-slate-200">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold text-white">Rekap Promo</h1>
                <p className="text-sm text-slate-400">
                    Diskon yang benar-benar keluar dari Accurate pada periode ini — dibaca dari faktur
                    yang dikirim webhook, bukan dari hitungan kita — lalu dipilah siapa menanggungnya.
                </p>
            </header>

            <section className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-black/20 p-4">
                <label className="text-sm">
                    <span className="block text-slate-400 mb-1">Dari</span>
                    <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                        className="bg-black/40 border border-white/10 rounded px-3 py-2" />
                </label>
                <label className="text-sm">
                    <span className="block text-slate-400 mb-1">Sampai</span>
                    <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                        className="bg-black/40 border border-white/10 rounded px-3 py-2" />
                </label>
                <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-sm">
                    <RefreshCw size={15} /> Muat rekap
                </button>
                <label className="text-sm ml-auto">
                    <span className="block text-slate-400 mb-1">Muat aturan promo (sheet Detail)</span>
                    <input type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }}
                        className="block text-sm file:mr-3 file:rounded file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-slate-200" />
                </label>
                <button onClick={() => void importRules(false)} disabled={busy || !file}
                    className="rounded bg-white/10 px-3 py-2 text-sm disabled:opacity-40">Pratinjau</button>
                <button onClick={() => void importRules(true)} disabled={busy || !preview}
                    className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm disabled:opacity-40">
                    <Upload size={15} /> Muat aturan
                </button>
            </section>

            {preview && (
                <p className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
                    {preview.rows} baris aturan · {preview.programs} program · {preview.tingkatFaktur} baris tingkat faktur.
                    {preview.issues.length > 0 && <> Temuan: {preview.issues.slice(0, 3).join("; ")}</>}
                    {" "}Tekan <strong>Muat aturan</strong> untuk mengganti aturan principal ini.
                </p>
            )}

            {r && (
                <>
                    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {[
                            { label: "Bruto faktur", value: rp(r.gross), note: `${r.invoices} faktur · ${r.lines} baris` },
                            { label: "Klaim principal", value: rp(r.principal), note: "posisi 4–5, bisa ditagihkan" },
                            { label: "Tanggungan distributor", value: rp(r.distributor), note: "posisi 1–3, beban sendiri" },
                            { label: "Diskon tak bertuan", value: rp(r.unowned), note: "posisi 6+, seharusnya nol" },
                        ].map((kartu) => (
                            <div key={kartu.label} className="rounded-lg border border-white/10 bg-black/20 p-4">
                                <p className="text-xs text-slate-400">{kartu.label}</p>
                                <p className={`text-xl font-semibold ${kartu.label.includes("tak bertuan") && r.unowned > 0 ? "text-red-300" : "text-white"}`}>{kartu.value}</p>
                                <p className="text-xs text-slate-500">{kartu.note}</p>
                            </div>
                        ))}
                    </section>

                    <div className={`flex items-start gap-3 rounded-lg border p-4 ${bersih ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/40 bg-red-500/10"}`}>
                        {bersih ? <CheckCircle2 className="text-emerald-300" size={20} /> : <AlertTriangle className="text-red-300" size={20} />}
                        <div className="text-sm">
                            {bersih ? (
                                <p className="text-emerald-200">
                                    Periode ini bersih: tidak ada diskon tak bertuan, dan seluruh klaim principal punya aturan terbit.
                                </p>
                            ) : (
                                <>
                                    <p className="font-medium text-red-200">
                                        {rp(r.unowned)} diskon tak bertuan dan {rp(r.principalWithoutRule)} klaim principal tanpa aturan terbit.
                                    </p>
                                    <p className="text-xs text-red-200/80">
                                        Daily closing seharusnya membuat keduanya nol saat faktur masuk Accurate. Angka di atas
                                        berarti ada faktur yang lewat di luar gerbang, atau aturannya belum dimuat.
                                    </p>
                                </>
                            )}
                            {data.invoicesWithoutDetail > 0 && (
                                <p className="mt-1 text-xs text-amber-200">
                                    <FileWarning size={12} className="mr-1 inline" />
                                    {data.invoicesWithoutDetail} dari {data.invoicesInRange} faktur belum punya rincian baris
                                    (hanya jalur webhook yang membawanya). Angka di atas belum memuat faktur itu.
                                </p>
                            )}
                        </div>
                    </div>

                    <section className="space-y-2">
                        <h2 className="text-lg font-medium text-white">Per program ({data.rules} aturan terbit)</h2>
                        <div className="overflow-x-auto rounded-lg border border-white/10">
                            <table className="w-full text-sm">
                                <thead className="bg-white/5 text-slate-400">
                                    <tr>
                                        <th className="px-3 py-2 text-left">Surat</th>
                                        <th className="px-3 py-2 text-left">Program</th>
                                        <th className="px-3 py-2 text-left">Kelompok</th>
                                        <th className="px-3 py-2 text-right">Faktur</th>
                                        <th className="px-3 py-2 text-right">Baris</th>
                                        <th className="px-3 py-2 text-right">Klaim principal</th>
                                        <th className="px-3 py-2 text-left">Sesuai mekanisme</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {r.programs.map((program) => (
                                        <tr key={program.key} className="border-t border-white/5">
                                            <td className="px-3 py-2 font-mono text-xs">{program.suratProgram}</td>
                                            <td className="px-3 py-2 text-xs">{program.promoLabel}</td>
                                            <td className="px-3 py-2">{program.promoGroup}</td>
                                            <td className="px-3 py-2 text-right">{program.invoices}</td>
                                            <td className="px-3 py-2 text-right">{program.lines}</td>
                                            <td className="px-3 py-2 text-right text-emerald-300">{rp(program.principalAmount)}</td>
                                            <td className="px-3 py-2 text-xs">
                                                {program.mismatched.length === 0
                                                    ? <span className="text-emerald-300">sesuai</span>
                                                    : <span className="text-amber-300">
                                                        {program.mismatched.length} baris menyimpang (mis. {program.mismatched[0].invoiceNo}:
                                                        surat {program.mismatched[0].expected}% vs faktur {program.mismatched[0].actual}%)
                                                    </span>}
                                            </td>
                                        </tr>
                                    ))}
                                    {!r.programs.length && (
                                        <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">
                                            Belum ada klaim principal yang cocok dengan aturan terbit pada periode ini.
                                        </td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    {(r.unownedLines.length > 0 || r.unexplained.length > 0) && (
                        <section className="grid gap-4 lg:grid-cols-2">
                            {[
                                { judul: "Diskon tak bertuan", isi: r.unownedLines.map((x) => `${x.invoiceNo} · ${x.itemCode} · ${rp(x.amount)} (posisi ${x.positions.join(", ")})`) },
                                { judul: "Klaim principal tanpa aturan terbit", isi: r.unexplained.map((x) => `${x.invoiceNo} · ${x.itemCode} · ${rp(x.amount)}`) },
                            ].filter((blok) => blok.isi.length > 0).map((blok) => (
                                <div key={blok.judul} className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
                                    <p className="mb-2 font-medium text-red-200">{blok.judul} ({blok.isi.length})</p>
                                    <ul className="max-h-64 space-y-0.5 overflow-y-auto text-xs text-red-100/90">
                                        {blok.isi.slice(0, 100).map((teks) => <li key={teks}>{teks}</li>)}
                                    </ul>
                                </div>
                            ))}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
