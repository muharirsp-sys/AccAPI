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
import { AlertTriangle, Upload, RefreshCw, CheckCircle2, FileWarning, Download } from "lucide-react";
import { toast } from "sonner";

type Program = {
    key: string; suratProgram: string; promoLabel: string; promoGroup: string;
    amount: number; lines: number; invoices: number;
};

type DetailRow = {
    bucket: "principal" | "distributor" | "unowned";
    invoiceNo: string; transDate: string; branchName: string;
    customerNo: string; customerName: string;
    itemCode: string; itemName: string;
    positions: string; percent: number; amount: number;
    suratProgram: string; promoGroup: string; reason: string;
};

type Data = {
    from: string; to: string; principal: string; principals: string[];
    invoicesInRange: number; invoicesWithoutDetail: number; rules: number;
    recap: {
        invoices: number; lines: number; gross: number;
        distributor: number; principal: number; unowned: number;
        programs: Program[]; rows: DetailRow[];
    };
};

/** Kartu ringkas; `key` menentukan angka mana yang dibaca dan rincian mana yang dibuka. */
const KARTU = [
    { key: "gross", label: "Bruto faktur", note: "" },
    { key: "principal", label: "Klaim principal", note: "cocok aturan principal, bisa ditagihkan" },
    { key: "distributor", label: "Tanggungan distributor", note: "cocok aturan distributor, beban sendiri" },
    { key: "unowned", label: "Tak bertuan", note: "tidak sesuai promo yang berlaku — wajib divalidasi" },
] as const;

// BOM supaya nama outlet ber-aksen tidak jadi mojibake di Excel; CRLF karena Excel Windows
// memperlakukan LF saja sebagai satu baris panjang.
const BOM = String.fromCharCode(0xFEFF);
const CRLF = String.fromCharCode(13, 10);

type Buka = { jenis: "none" | "bucket" | "program"; nilai: string };
const kosong: Buka = { jenis: "none", nilai: "" };

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
    const [principal, setPrincipal] = useState("");
    const [buka, setBuka] = useState<Buka>(kosong);

    const load = useCallback(async () => {
        const query = new URLSearchParams({ from, to });
        if (principal) query.set("principal", principal);
        const res = await fetch(`/api/promo-recap?${query.toString()}`, { credentials: "include" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) { toast.error(body.error ?? "Rekap gagal dimuat"); return; }
        setData(body);
    }, [from, to, principal]);

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
    const bersih = r && r.unowned === 0;

    // Satu daftar rincian melayani kartu, tabel layar, DAN unduhan CSV. Kalau ketiganya
    // dihitung sendiri-sendiri, angka di kartu bisa berbeda dari isi unduhannya — dan yang
    // dipegang orang saat menagih adalah unduhannya.
    const rincian = !r ? [] : buka.jenis === "bucket"
        ? r.rows.filter((row) => row.bucket === buka.nilai)
        : buka.jenis === "program"
            ? r.rows.filter((row) => `${row.suratProgram}|${row.promoGroup}` === buka.nilai)
            : [];
    const totalRincian = rincian.reduce((total, row) => total + row.amount, 0);
    const judulRincian = buka.jenis === "program"
        ? `Rincian program ${buka.nilai.split("|")[0]} · ${buka.nilai.split("|")[1]}`
        : `Rincian ${KARTU.find((kartu) => kartu.key === buka.nilai)?.label ?? ""}`;

    /** CSV, bukan xlsx: dibuka Excel apa adanya dan tidak menambah satu pun dependensi. */
    function unduh() {
        const judul = ["Faktur", "Tanggal", "Principal", "Kode Outlet", "Outlet", "Kode Barang",
            "Nama Barang", "Posisi", "Persen", "Rupiah", "Surat", "Kelompok", "Keterangan"];
        // Titik koma: Excel Indonesia memakai koma sebagai desimal, jadi pemisah koma
        // memecah angka jadi dua kolom. BOM supaya nama outlet ber-aksen tidak jadi mojibake.
        const escape = (value: string | number) => `"${String(value ?? "").replace(/"/g, '""')}"`;
        const isi = rincian.map((row) => [row.invoiceNo, row.transDate, row.branchName, row.customerNo,
            row.customerName, row.itemCode, row.itemName, row.positions, row.percent, row.amount,
            row.suratProgram, row.promoGroup, row.reason].map(escape).join(";"));
        const teks = BOM + [judul.map(escape).join(";"), ...isi].join(CRLF);
        const url = URL.createObjectURL(new Blob([teks], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `rekap-promo-${buka.nilai.replace(/[^A-Za-z0-9]+/g, "-")}-${from}-sd-${to}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

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
                <label className="text-sm">
                    <span className="block text-slate-400 mb-1">Principal</span>
                    <select value={principal} onChange={(e) => { setPrincipal(e.target.value); setBuka(kosong); }}
                        className="bg-black/40 border border-white/10 rounded px-3 py-2">
                        <option value="">Semua principal</option>
                        {(data?.principals ?? []).map((nama) => <option key={nama} value={nama}>{nama}</option>)}
                    </select>
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
                        {KARTU.map((kartu) => {
                            const nilai = kartu.key === "gross" ? r.gross
                                : kartu.key === "principal" ? r.principal
                                : kartu.key === "distributor" ? r.distributor : r.unowned;
                            const aktif = buka.jenis === "bucket" && buka.nilai === kartu.key;
                            const bisaDibuka = kartu.key !== "gross";
                            return (
                                <button key={kartu.key} type="button" disabled={!bisaDibuka}
                                    onClick={() => setBuka(aktif ? kosong : { jenis: "bucket", nilai: kartu.key })}
                                    className={`rounded-lg border p-4 text-left transition ${aktif ? "border-blue-400 bg-blue-500/10" : "border-white/10 bg-black/20"} ${bisaDibuka ? "hover:border-blue-400/60" : "cursor-default"}`}>
                                    <p className="text-xs text-slate-400">{kartu.label}</p>
                                    <p className={`text-xl font-semibold ${kartu.key === "unowned" && r.unowned > 0 ? "text-red-300" : "text-white"}`}>
                                        {rp(nilai)}
                                    </p>
                                    <p className="text-xs text-slate-500">
                                        {kartu.key === "gross" ? `${r.invoices} faktur · ${r.lines} baris` : kartu.note}
                                    </p>
                                    {bisaDibuka && (
                                        <p className="mt-1 text-[11px] text-blue-300">
                                            {aktif ? "tutup rincian" : "lihat rincian"}
                                        </p>
                                    )}
                                </button>
                            );
                        })}
                    </section>

                    <div className={`flex items-start gap-3 rounded-lg border p-4 ${bersih ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/40 bg-red-500/10"}`}>
                        {bersih ? <CheckCircle2 className="text-emerald-300" size={20} /> : <AlertTriangle className="text-red-300" size={20} />}
                        <div className="text-sm">
                            {bersih ? (
                                <p className="text-emerald-200">
                                    Periode ini bersih: setiap potongan cocok dengan aturan promo yang berlaku.
                                </p>
                            ) : (
                                <>
                                    <p className="font-medium text-red-200">
                                        {rp(r.unowned)} potongan belum bisa dipertanggungjawabkan.
                                    </p>
                                    <p className="text-xs text-red-200/80">
                                        Tak bertuan berarti potongannya <strong>tidak sesuai promo yang berlaku</strong> — di posisi
                                        mana pun, bukan hanya posisi 6 ke atas. Termasuk potongan posisi 1–3 yang belum punya
                                        aturan berbeban DISTRIBUTOR: selama aturannya belum dimuat, uang itu belum boleh diakui
                                        sebagai beban sendiri maupun ditagihkan. Buka kartunya untuk melihat sebabnya per baris.
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
                                        <th className="px-3 py-2" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {r.programs.map((program) => (
                                        <tr key={program.key}
                                            className={`border-t border-white/5 ${buka.jenis === "program" && buka.nilai === program.key ? "bg-blue-500/10" : ""}`}>
                                            <td className="px-3 py-2 font-mono text-xs">{program.suratProgram}</td>
                                            <td className="px-3 py-2 text-xs">{program.promoLabel}</td>
                                            <td className="px-3 py-2">{program.promoGroup}</td>
                                            <td className="px-3 py-2 text-right">{program.invoices}</td>
                                            <td className="px-3 py-2 text-right">{program.lines}</td>
                                            <td className="px-3 py-2 text-right text-emerald-300">{rp(program.amount)}</td>
                                            <td className="px-3 py-2 text-right">
                                                <button type="button" className="text-xs text-blue-300 hover:underline"
                                                    onClick={() => setBuka(buka.jenis === "program" && buka.nilai === program.key
                                                        ? kosong : { jenis: "program", nilai: program.key })}>
                                                    {buka.jenis === "program" && buka.nilai === program.key ? "tutup" : "rincian"}
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {!r.programs.length && (
                                        <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">
                                            Belum ada potongan yang cocok dengan aturan terbit pada periode ini.
                                            {!data.principal && " Coba saring per principal — aturan hanya termuat untuk sebagian principal."}
                                        </td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    {buka.jenis !== "none" && (
                        <section className="space-y-2">
                            <div className="flex flex-wrap items-center gap-3">
                                <h2 className="text-lg font-medium text-white">{judulRincian}</h2>
                                <span className="text-xs text-slate-400">{rincian.length} baris · {rp(totalRincian)}</span>
                                <button onClick={unduh} disabled={!rincian.length}
                                    className="ml-auto inline-flex items-center gap-1 rounded bg-white/10 px-3 py-1.5 text-xs disabled:opacity-40">
                                    <Download size={13} /> Unduh CSV
                                </button>
                            </div>
                            <div className="max-h-[28rem] overflow-auto rounded-lg border border-white/10">
                                <table className="w-full text-sm">
                                    <thead className="sticky top-0 bg-slate-900 text-slate-400">
                                        <tr>
                                            <th className="px-3 py-2 text-left">Faktur</th>
                                            <th className="px-3 py-2 text-left">Tanggal</th>
                                            <th className="px-3 py-2 text-left">Outlet</th>
                                            <th className="px-3 py-2 text-left">Barang</th>
                                            <th className="px-3 py-2 text-left">Posisi</th>
                                            <th className="px-3 py-2 text-right">%</th>
                                            <th className="px-3 py-2 text-right">Rupiah</th>
                                            <th className="px-3 py-2 text-left">Keterangan</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rincian.slice(0, 500).map((row, index) => (
                                            <tr key={`${row.invoiceNo}-${row.itemCode}-${row.positions}-${index}`} className="border-t border-white/5">
                                                <td className="px-3 py-2 font-mono text-xs">{row.invoiceNo}</td>
                                                <td className="px-3 py-2 text-xs">{row.transDate}</td>
                                                <td className="px-3 py-2 text-xs">
                                                    <div className="font-mono">{row.customerNo}</div>
                                                    <div className="text-slate-500">{row.customerName}</div>
                                                </td>
                                                <td className="px-3 py-2 text-xs">
                                                    <div className="font-mono">{row.itemCode || "—"}</div>
                                                    <div className="text-slate-500">{row.itemName}</div>
                                                </td>
                                                <td className="px-3 py-2 text-xs">{row.positions}</td>
                                                <td className="px-3 py-2 text-right text-xs">{row.percent || "—"}</td>
                                                <td className="px-3 py-2 text-right">{rp(row.amount)}</td>
                                                <td className="px-3 py-2 text-xs">
                                                    {row.reason
                                                        ? <span className="text-red-200/90">{row.reason}</span>
                                                        : <span className="text-slate-500">{row.suratProgram} · {row.promoGroup}</span>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {rincian.length > 500 && (
                                <p className="text-xs text-slate-500">
                                    Ditampilkan 500 baris teratas. Unduhan CSV memuat seluruh {rincian.length} baris.
                                </p>
                            )}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
