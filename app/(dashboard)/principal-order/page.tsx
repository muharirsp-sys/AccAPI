/*
 * Tujuan: Unggah laporan integrasi principal (Order Detail) dan lihat batch yang sudah masuk.
 * Caller: Route dashboard `/principal-order`.
 * Dependensi: /api/principal-order, /api/principal-order/validate, /api/principal-order/queue,
 *             toast Sonner, lucide-react.
 * Main Functions: PrincipalOrderPage, upload, openBatch, validate, prepareInvoices, queueInvoices, removeBatch.
 * Side Effects: HTTP read/write; unggah default PRATINJAU, menyimpan hanya setelah dikonfirmasi.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Upload, Search, Trash2, AlertTriangle, FileSpreadsheet, ShieldCheck, CheckCircle2, Receipt, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type Batch = {
    id: string; principal: string; fileName: string; branch: string; period: string;
    lineCount: number; skipped: number; issues: string[]; status: string;
    uploadedBy: string; uploadedAt: string;
    validatedAt: string | null; okCount: number; reviewCount: number;
};

type Line = {
    rowNumber: number; soNo: string; soDate: string | null; customerCode: string; customerName: string;
    customerType: string; productCode: string; productName: string;
    reportQty: string; reportGross: string; qty: string; unit: string; price: string;
    discounts: { position: number; percent: number }[]; bonus: boolean;
    itemCode: string | null; customerNo: string | null; expectedPrice: string | null;
    discDistributor: string; discPrincipal: string; discUnowned: string;
    status: "pending" | "ok" | "review"; findings: string[];
};

type Plan = {
    batchId: string;
    ready: {
        key: string; soNo: string; customerNo: string; orderDate: string; lineCount: number;
        gross: number; net: number; branch: string;
    }[];
    skipped: { soNo: string; reason: string }[];
};

type Preview = {
    fileName: string; branch: string; period: string; lineCount: number; skipped: number;
    issues: string[]; unmappedProducts: string[];
    duplicateOf: { id: string; fileName: string; uploadedAt: string } | null;
};

const money = (value: string | number) => Number(value).toLocaleString("id-ID", { maximumFractionDigits: 2 });

export default function PrincipalOrderPage() {
    const [principal, setPrincipal] = useState("KINO NON FOOD");
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [replace, setReplace] = useState(false);
    const [batches, setBatches] = useState<Batch[]>([]);
    const [open, setOpen] = useState<{ batch: Batch; lines: Line[] } | null>(null);
    const [busy, setBusy] = useState(false);
    const [onlyReview, setOnlyReview] = useState(false);
    const [plan, setPlan] = useState<Plan | null>(null);

    const loadBatches = useCallback(async () => {
        const res = await fetch("/api/principal-order", { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) setBatches(data.batches);
    }, []);

    useEffect(() => { void loadBatches(); }, [loadBatches]);

    async function upload(apply: boolean) {
        if (!file) { toast.error("Pilih berkas Order Detail terlebih dahulu"); return; }
        setBusy(true);
        try {
            const form = new FormData();
            form.append("file", file);
            form.append("principal", principal);
            form.append("apply", String(apply));
            form.append("replace", String(replace));
            const res = await fetch("/api/principal-order", { method: "POST", credentials: "include", body: form });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error ?? "Unggah gagal");
            setPreview(data);
            if (apply) {
                toast.success(`${data.lineCount} baris tersimpan`);
                setPreview(null); setFile(null); setReplace(false);
                await loadBatches();
                await openBatch(data.id);
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unggah gagal");
        } finally {
            setBusy(false);
        }
    }

    async function openBatch(id: string) {
        const res = await fetch(`/api/principal-order?id=${encodeURIComponent(id)}`, { credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) { toast.error(data.error ?? "Gagal memuat batch"); return; }
        setOpen({ batch: data.batch, lines: data.lines });
    }

    /**
     * `refreshPrices` menyegarkan daftar harga Accurate untuk barang pada batch INI lebih dulu.
     * Dipakai setelah harga diperbaiki di Accurate: cache harga jual tidak pernah masuk cron,
     * jadi tanpa ini baris tetap tertahan dengan harga lama dan tidak ada cara menjalankan
     * sync-nya dari layar. Bertarget, jadi hitungan detik — bukan 21 menit sync penuh.
     */
    async function validate(id: string, refreshPrices = false) {
        setBusy(true);
        try {
            const query = `id=${encodeURIComponent(id)}${refreshPrices ? "&prices=1" : ""}`;
            const res = await fetch(`/api/principal-order/validate?${query}`, { method: "POST", credentials: "include" });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error ?? "Validasi gagal");
            if (data.priceRefresh && !data.priceRefresh.ok) {
                // Harga lama tetap dipakai dan barisnya tetap tertahan; jangan diam-diam.
                toast.warning(`Harga gagal disegarkan: ${data.priceRefresh.error ?? "tidak diketahui"}`);
            } else if (data.priceRefresh) {
                toast.info(`Harga disegarkan: ${data.priceRefresh.processed} barang, ${data.priceRefresh.priceRows} baris harga`);
            }
            toast[data.reviewCount > 0 ? "warning" : "success"](
                `${data.okCount} baris cocok, ${data.reviewCount} perlu ditinjau`);
            await loadBatches();
            await openBatch(id);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Validasi gagal");
        } finally {
            setBusy(false);
        }
    }

    /** Pratinjau dulu: tidak ada satu pun baris antrean ditulis sebelum daftarnya dilihat. */
    async function prepareInvoices(id: string) {
        setBusy(true);
        try {
            const res = await fetch(`/api/principal-order/queue?id=${encodeURIComponent(id)}`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queue: false }),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
                // Alasan penolakan per SO tetap ditampilkan, bukan cuma pesan galatnya.
                setPlan(data?.skipped ? { batchId: id, ready: [], skipped: data.skipped } : null);
                throw new Error(data.error ?? "Faktur gagal disiapkan");
            }
            setPlan({ batchId: id, ready: data.ready, skipped: data.skipped });
            toast[data.ready.length ? "success" : "warning"](`${data.ready.length} faktur siap diantrekan`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Faktur gagal disiapkan");
        } finally {
            setBusy(false);
        }
    }

    async function queueInvoices(id: string) {
        setBusy(true);
        try {
            const res = await fetch(`/api/principal-order/queue?id=${encodeURIComponent(id)}`, {
                method: "POST", credentials: "include",
                headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queue: true }),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error ?? "Gagal memasukkan ke antrean");
            toast.success(`${data.queued} faktur masuk antrean`);
            setPlan(null);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal memasukkan ke antrean");
        } finally {
            setBusy(false);
        }
    }

    async function removeBatch(id: string) {
        if (!confirm("Hapus batch ini beserta seluruh barisnya?")) return;
        const res = await fetch(`/api/principal-order?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) { toast.error(data.error ?? "Gagal menghapus"); return; }
        toast.success("Batch dihapus");
        if (open?.batch.id === id) setOpen(null);
        await loadBatches();
    }

    return (
        <div className="p-6 space-y-6 text-slate-200">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold text-white">Order Principal</h1>
                <p className="text-sm text-slate-400">
                    Unggah laporan integrasi dari sistem principal (Order Detail). Satuan, harga, dan
                    posisi diskon dinormalkan mengikuti aturan yang selama ini dipakai.
                </p>
            </header>

            <section className="rounded-lg border border-white/10 bg-black/20 p-4 space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm">
                        <span className="block text-slate-400 mb-1">Principal</span>
                        <input value={principal} onChange={(event) => setPrincipal(event.target.value)}
                            className="bg-black/40 border border-white/10 rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500" />
                    </label>
                    <label className="text-sm flex-1 min-w-[240px]">
                        <span className="block text-slate-400 mb-1">Berkas Order Detail (xlsx)</span>
                        <input type="file" accept=".xlsx,.xls" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }}
                            className="block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-slate-200" />
                    </label>
                    <button onClick={() => void upload(false)} disabled={busy || !file}
                        className="inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-sm disabled:opacity-40">
                        <Search size={16} /> Pratinjau
                    </button>
                    <button onClick={() => void upload(true)} disabled={busy || !preview}
                        className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm disabled:opacity-40">
                        <Upload size={16} /> Simpan batch
                    </button>
                </div>

                {preview && (
                    <div className="space-y-2 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                        <p className="text-slate-200">
                            <strong>{preview.fileName}</strong> · {preview.branch || "cabang tidak terbaca"} · {preview.period || "periode tidak terbaca"}
                        </p>
                        <p><strong className="text-emerald-300">{preview.lineCount}</strong> baris siap disimpan
                            {preview.skipped > 0 && <> · <strong className="text-amber-300">{preview.skipped}</strong> baris dilewati</>}</p>
                        {preview.unmappedProducts.length > 0 && (
                            <p className="text-amber-200">
                                Kode produk belum ada di mapping: {preview.unmappedProducts.slice(0, 12).join(", ")}
                                {preview.unmappedProducts.length > 12 && ` … (+${preview.unmappedProducts.length - 12})`}.
                                Perbaiki di halaman Mapping Principal, lalu unggah ulang.
                            </p>
                        )}
                        {preview.issues.length > 0 && (
                            <ul className="list-disc pl-5 text-amber-200/80">
                                {preview.issues.slice(0, 6).map((issue) => <li key={issue}>{issue}</li>)}
                                {preview.issues.length > 6 && <li>… dan {preview.issues.length - 6} temuan lain</li>}
                            </ul>
                        )}
                        {preview.duplicateOf && (
                            <label className="flex items-center gap-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-200">
                                <AlertTriangle size={16} />
                                <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
                                <span>
                                    Berkas ini sudah pernah diunggah ({preview.duplicateOf.fileName},{" "}
                                    {new Date(preview.duplicateOf.uploadedAt).toLocaleString("id-ID")}). Centang untuk mengganti batch lama.
                                </span>
                            </label>
                        )}
                    </div>
                )}
            </section>

            <section className="space-y-3">
                <h2 className="text-lg font-medium text-white">Batch terakhir</h2>
                <div className="overflow-x-auto rounded-lg border border-white/10">
                    <table className="w-full text-sm">
                        <thead className="bg-white/5 text-slate-400">
                            <tr>
                                <th className="px-3 py-2 text-left">Berkas</th>
                                <th className="px-3 py-2 text-left">Periode</th>
                                <th className="px-3 py-2 text-right">Baris</th>
                                <th className="px-3 py-2 text-right">Dilewati</th>
                                <th className="px-3 py-2 text-left">Validasi</th>
                                <th className="px-3 py-2 text-left">Diunggah</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {batches.map((batch) => (
                                <tr key={batch.id} className={`border-t border-white/5 ${open?.batch.id === batch.id ? "bg-blue-500/10" : ""}`}>
                                    <td className="px-3 py-2">
                                        <button onClick={() => void openBatch(batch.id)} className="inline-flex items-center gap-2 text-blue-300 hover:underline">
                                            <FileSpreadsheet size={15} /> {batch.fileName}
                                        </button>
                                        <div className="text-xs text-slate-500">{batch.principal}</div>
                                    </td>
                                    <td className="px-3 py-2 text-slate-300">{batch.period || "—"}</td>
                                    <td className="px-3 py-2 text-right">{batch.lineCount}</td>
                                    <td className="px-3 py-2 text-right">{batch.skipped > 0 ? <span className="text-amber-300">{batch.skipped}</span> : "—"}</td>
                                    <td className="px-3 py-2">
                                        {batch.validatedAt
                                            ? <span className={batch.reviewCount > 0 ? "text-amber-300" : "text-emerald-300"}>
                                                {batch.okCount} cocok · {batch.reviewCount} ditinjau
                                            </span>
                                            : <span className="text-slate-500">belum divalidasi</span>}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-slate-500">
                                        {new Date(batch.uploadedAt).toLocaleString("id-ID")}{batch.uploadedBy ? ` · ${batch.uploadedBy}` : ""}
                                    </td>
                                    <td className="px-3 py-2 text-right whitespace-nowrap">
                                        <button onClick={() => void validate(batch.id)} disabled={busy}
                                            className="mr-1 inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs disabled:opacity-40">
                                            <ShieldCheck size={13} /> Validasi
                                        </button>
                                        <button onClick={() => void validate(batch.id, true)} disabled={busy}
                                            title="Tarik ulang daftar harga Accurate untuk barang pada batch ini, lalu validasi. Pakai setelah harga diperbaiki di Accurate."
                                            className="mr-1 inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs disabled:opacity-40">
                                            <RefreshCw size={13} /> Segarkan harga
                                        </button>
                                        <button onClick={() => void prepareInvoices(batch.id)} disabled={busy || !batch.validatedAt || batch.okCount === 0}
                                            title={batch.validatedAt ? "Siapkan faktur dari SO yang seluruh barisnya lolos" : "Validasi batch ini dulu"}
                                            className="mr-1 inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs disabled:opacity-40">
                                            <Receipt size={13} /> Faktur
                                        </button>
                                        <button onClick={() => void removeBatch(batch.id)} className="px-2 text-red-400 hover:text-red-300"><Trash2 size={15} /></button>
                                    </td>
                                </tr>
                            ))}
                            {!batches.length && (
                                <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">Belum ada batch. Unggah berkas Order Detail di atas.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>

            {plan && (
                <section className="space-y-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <h2 className="text-lg font-medium text-white">Calon faktur</h2>
                        <span className="text-sm text-slate-400">
                            satu SO = satu faktur; SO yang punya satu saja baris perlu ditinjau tidak ikut
                        </span>
                        <button onClick={() => setPlan(null)} className="ml-auto text-xs text-slate-400 hover:text-slate-200">Tutup</button>
                    </div>
                    {plan.ready.length > 0 && (
                        <div className="overflow-x-auto rounded border border-white/10">
                            <table className="w-full text-sm">
                                <thead className="bg-white/5 text-slate-400">
                                    <tr>
                                        <th className="px-3 py-2 text-left">SO</th>
                                        <th className="px-3 py-2 text-left">Pelanggan</th>
                                        <th className="px-3 py-2 text-left">Cabang</th>
                                        <th className="px-3 py-2 text-left">Tanggal</th>
                                        <th className="px-3 py-2 text-right">Baris</th>
                                        <th className="px-3 py-2 text-right">Bruto</th>
                                        <th className="px-3 py-2 text-right">Netto</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {plan.ready.map((entry) => (
                                        <tr key={entry.key} className="border-t border-white/5">
                                            <td className="px-3 py-1.5 font-mono text-xs">{entry.soNo}</td>
                                            <td className="px-3 py-1.5 font-mono text-xs">{entry.customerNo}</td>
                                            <td className="px-3 py-1.5 text-xs text-slate-400">{entry.branch}</td>
                                            <td className="px-3 py-1.5 text-xs">{entry.orderDate}</td>
                                            <td className="px-3 py-1.5 text-right">{entry.lineCount}</td>
                                            <td className="px-3 py-1.5 text-right">{money(entry.gross)}</td>
                                            <td className="px-3 py-1.5 text-right text-emerald-300">{money(entry.net)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {plan.skipped.length > 0 && (
                        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-200">
                            {plan.skipped.map((entry) => (
                                <li key={`${entry.soNo}-${entry.reason}`}><span className="font-mono">{entry.soNo}</span> — {entry.reason}</li>
                            ))}
                        </ul>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                        <button onClick={() => void queueInvoices(plan.batchId)} disabled={busy || plan.ready.length === 0}
                            className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm disabled:opacity-40">
                            <Receipt size={16} /> Antrekan {plan.ready.length} faktur
                        </button>
                        <p className="text-xs text-slate-400">
                            Masuk antrean saja — pengiriman ke Accurate lewat pengirim terjadwal, dan gerbangnya
                            masih tertutup sampai satu faktur uji diperiksa manual.
                        </p>
                    </div>
                </section>
            )}

            {open && (
                <section className="space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                        <h2 className="text-lg font-medium text-white">
                            {open.batch.fileName}
                            <span className="ml-2 text-sm font-normal text-slate-400">{open.lines.length} baris · {open.batch.branch}</span>
                        </h2>
                        {open.batch.validatedAt && (
                            <label className="ml-auto flex items-center gap-2 text-sm text-slate-300">
                                <input type="checkbox" checked={onlyReview} onChange={(event) => setOnlyReview(event.target.checked)} />
                                Tampilkan hanya yang perlu ditinjau ({open.batch.reviewCount})
                            </label>
                        )}
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-white/10 max-h-[28rem]">
                        <table className="w-full text-sm">
                            <thead className="bg-white/5 text-slate-400 sticky top-0">
                                <tr>
                                    <th className="px-3 py-2 text-left">SO</th>
                                    <th className="px-3 py-2 text-left">Outlet</th>
                                    <th className="px-3 py-2 text-left">Produk</th>
                                    <th className="px-3 py-2 text-right">Qty laporan</th>
                                    <th className="px-3 py-2 text-right">Qty faktur</th>
                                    <th className="px-3 py-2 text-right">Harga</th>
                                    <th className="px-3 py-2 text-left">Diskon</th>
                                    <th className="px-3 py-2 text-right">Bruto</th>
                                    <th className="px-3 py-2 text-left">Hasil validasi</th>
                                </tr>
                            </thead>
                            <tbody>
                                {open.lines.filter((line) => !onlyReview || line.status === "review").map((line) => (
                                    <tr key={line.rowNumber} className="border-t border-white/5">
                                        <td className="px-3 py-1.5 font-mono text-xs">{line.soNo}</td>
                                        <td className="px-3 py-1.5">
                                            <div className="font-mono text-xs">{line.customerCode}</div>
                                            <div className="text-xs text-slate-500">{line.customerName}</div>
                                        </td>
                                        <td className="px-3 py-1.5">
                                            <div className="font-mono text-xs">{line.productCode}</div>
                                            <div className="text-xs text-slate-500">{line.productName}</div>
                                        </td>
                                        <td className="px-3 py-1.5 text-right text-slate-400">{money(line.reportQty)}</td>
                                        <td className="px-3 py-1.5 text-right">
                                            {money(line.qty)} <span className={line.unit === "KRT" ? "text-emerald-300" : "text-slate-400"}>{line.unit}</span>
                                        </td>
                                        <td className="px-3 py-1.5 text-right">{money(line.price)}</td>
                                        <td className="px-3 py-1.5 text-xs">
                                            {line.bonus && <span className="mr-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-300">BONUS</span>}
                                            {line.discounts.map((entry) => (
                                                <span key={entry.position} className={`mr-1 rounded px-1.5 py-0.5 ${entry.position <= 3 ? "bg-white/10" : entry.position <= 5 ? "bg-blue-500/20 text-blue-200" : "bg-red-500/20 text-red-200"}`}>
                                                    D{entry.position} {entry.percent}%
                                                </span>
                                            ))}
                                            {!line.discounts.length && <span className="text-slate-600">—</span>}
                                        </td>
                                        <td className="px-3 py-1.5 text-right">{money(line.reportGross)}</td>
                                        <td className="px-3 py-1.5 text-xs max-w-md">
                                            {line.status === "pending" && <span className="text-slate-600">belum divalidasi</span>}
                                            {line.status === "ok" && (
                                                <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 size={13} /> cocok</span>
                                            )}
                                            {line.status === "review" && (
                                                <ul className="list-disc pl-4 text-amber-200">
                                                    {line.findings.map((finding) => <li key={finding}>{finding}</li>)}
                                                </ul>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-xs text-slate-500">
                        Posisi diskon menentukan siapa menanggung: D1–D3 distributor, D4–D5 klaim principal,
                        D6–D8 tidak punya pemilik (merah) dan wajib ditinjau. Selisih harga sampai Rp 1 dianggap
                        pembulatan; di atas itu baris ditahan, baik lebih tinggi maupun lebih rendah.
                    </p>
                </section>
            )}
        </div>
    );
}
