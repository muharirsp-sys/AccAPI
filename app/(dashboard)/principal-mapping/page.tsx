/*
 * Tujuan: Kelola terjemahan kode principal -> kode internal (barang, pelanggan, salesman).
 * Caller: Route dashboard `/principal-mapping`.
 * Dependensi: /api/principal-mapping (+ /import), toast Sonner, lucide-react.
 * Main Functions: PrincipalMappingPage, load, saveRow, removeRow, runImport.
 * Side Effects: HTTP read/write; impor default PRATINJAU, menulis hanya setelah dikonfirmasi.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Upload, Search, Save, Trash2, Plus, AlertTriangle, Check } from "lucide-react";
import { toast } from "sonner";

type Kind = "item" | "customer" | "salesman";

type Row = {
    principal: string; kind: Kind; sourceCode: string; targetCode: string;
    unit: string | null; packSize: string | null; note: string; updatedBy: string; updatedAt: string;
};

type ImportEntry = { kind: Kind; label: string; sheet: string; count: number; issues: string[] };

const KIND_TABS: { kind: Kind; label: string; hint: string }[] = [
    { kind: "item", label: "Barang", hint: "Kode barang principal → kode internal, dengan satuan dan ISI per karton" },
    { kind: "customer", label: "Pelanggan", hint: "Kode outlet principal → kode pelanggan internal (tanpa akhiran cabang)" },
    { kind: "salesman", label: "Salesman", hint: "ID salesman principal → kode internal" },
];

const PAGE = 50;
const empty = (principal: string, kind: Kind): Row => ({
    principal, kind, sourceCode: "", targetCode: "", unit: "", packSize: "", note: "", updatedBy: "", updatedAt: "",
});

export default function PrincipalMappingPage() {
    const [principal, setPrincipal] = useState("KINO NON FOOD");
    const [kind, setKind] = useState<Kind>("item");
    const [query, setQuery] = useState("");
    const [rows, setRows] = useState<Row[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [busy, setBusy] = useState(false);
    const [draft, setDraft] = useState<Row | null>(null);
    const [preview, setPreview] = useState<ImportEntry[] | null>(null);
    const [file, setFile] = useState<File | null>(null);

    const tab = useMemo(() => KIND_TABS.find((entry) => entry.kind === kind)!, [kind]);

    const load = useCallback(async () => {
        setBusy(true);
        try {
            const url = `/api/principal-mapping?principal=${encodeURIComponent(principal)}&kind=${kind}`
                + `&q=${encodeURIComponent(query)}&limit=${PAGE}&offset=${offset}`;
            const res = await fetch(url, { credentials: "include" });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error ?? "Gagal memuat");
            setRows(data.rows);
            setTotal(data.total);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Gagal memuat mapping");
        } finally {
            setBusy(false);
        }
    }, [principal, kind, query, offset]);

    useEffect(() => { void load(); }, [load]);

    async function saveRow(row: Row) {
        const res = await fetch("/api/principal-mapping", {
            method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...row, packSize: row.packSize || null }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) { toast.error(data.error ?? "Gagal menyimpan"); return; }
        toast.success(`${row.sourceCode} tersimpan`);
        setDraft(null);
        void load();
    }

    async function removeRow(row: Row) {
        if (!confirm(`Hapus mapping ${row.sourceCode} → ${row.targetCode}?`)) return;
        const url = `/api/principal-mapping?principal=${encodeURIComponent(row.principal)}&kind=${row.kind}`
            + `&sourceCode=${encodeURIComponent(row.sourceCode)}`;
        const res = await fetch(url, { method: "DELETE", credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) { toast.error(data.error ?? "Gagal menghapus"); return; }
        toast.success("Mapping dihapus");
        void load();
    }

    async function runImport(apply: boolean) {
        if (!file) { toast.error("Pilih berkas xlsx terlebih dahulu"); return; }
        setBusy(true);
        try {
            const form = new FormData();
            form.append("file", file);
            form.append("principal", principal);
            form.append("apply", String(apply));
            const res = await fetch("/api/principal-mapping/import", { method: "POST", credentials: "include", body: form });
            const data = await res.json();
            if (!res.ok || !data.ok) throw new Error(data.error ?? "Impor gagal");
            setPreview(data.result);
            if (apply) {
                toast.success("Mapping dimuat");
                setPreview(null);
                setFile(null);
                void load();
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Impor gagal");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="p-6 space-y-6 text-slate-200">
            <header className="space-y-1">
                <h1 className="text-2xl font-semibold text-white">Mapping Principal</h1>
                <p className="text-sm text-slate-400">
                    Terjemahan kode di sistem principal menjadi kode internal kita. Dipakai saat laporan
                    principal diunggah dan dicocokkan dengan Accurate.
                </p>
            </header>

            <section className="rounded-lg border border-white/10 bg-black/20 p-4 space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm">
                        <span className="block text-slate-400 mb-1">Principal</span>
                        <input value={principal} onChange={(event) => { setPrincipal(event.target.value); setOffset(0); }}
                            className="bg-black/40 border border-white/10 rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500" />
                    </label>
                    <label className="text-sm flex-1 min-w-[220px]">
                        <span className="block text-slate-400 mb-1">Impor berkas (xlsx berisi tiga sheet mapping)</span>
                        <input type="file" accept=".xlsx,.xls" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }}
                            className="block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-slate-200" />
                    </label>
                    <button onClick={() => void runImport(false)} disabled={busy || !file}
                        className="inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-sm disabled:opacity-40">
                        <Search size={16} /> Pratinjau
                    </button>
                    <button onClick={() => void runImport(true)} disabled={busy || !preview}
                        className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm disabled:opacity-40">
                        <Upload size={16} /> Muat
                    </button>
                </div>

                {preview && (
                    <div className="space-y-2 rounded border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                        <p className="flex items-center gap-2 text-amber-300">
                            <AlertTriangle size={16} />
                            Pratinjau. Memuat akan <strong>mengganti</strong> seluruh mapping jenis di bawah ini untuk {principal}.
                        </p>
                        {preview.map((entry) => (
                            <div key={entry.kind} className="border-t border-white/5 pt-2">
                                <p><strong>{entry.label}</strong> (sheet {entry.sheet}): {entry.count} baris siap dimuat</p>
                                {entry.issues.length > 0 && (
                                    <ul className="mt-1 list-disc pl-5 text-amber-200/80">
                                        {entry.issues.slice(0, 5).map((issue) => <li key={issue}>{issue}</li>)}
                                        {entry.issues.length > 5 && <li>… dan {entry.issues.length - 5} temuan lain</li>}
                                    </ul>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <nav className="flex gap-2">
                {KIND_TABS.map((entry) => (
                    <button key={entry.kind} onClick={() => { setKind(entry.kind); setOffset(0); setDraft(null); }}
                        className={`rounded px-3 py-1.5 text-sm ${kind === entry.kind ? "bg-blue-600 text-white" : "bg-white/5 text-slate-300"}`}>
                        {entry.label}
                    </button>
                ))}
            </nav>
            <p className="text-xs text-slate-500 -mt-4">{tab.hint}</p>

            <section className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="relative">
                        <Search size={15} className="absolute left-2.5 top-2.5 text-slate-500" />
                        <input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }}
                            placeholder="Cari kode principal atau kode internal"
                            className="bg-black/40 border border-white/10 rounded pl-8 pr-3 py-2 text-sm w-72 outline-none focus:ring-1 focus:ring-blue-500" />
                    </div>
                    <span className="text-sm text-slate-400">{total} baris</span>
                    <button onClick={() => setDraft(empty(principal, kind))}
                        className="ml-auto inline-flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-sm">
                        <Plus size={16} /> Tambah baris
                    </button>
                </div>

                <div className="overflow-x-auto rounded-lg border border-white/10">
                    <table className="w-full text-sm">
                        <thead className="bg-white/5 text-slate-400">
                            <tr>
                                <th className="px-3 py-2 text-left">Kode principal</th>
                                <th className="px-3 py-2 text-left">Kode internal</th>
                                {kind === "item" && <th className="px-3 py-2 text-left">Satuan</th>}
                                {kind === "item" && <th className="px-3 py-2 text-right">ISI/karton</th>}
                                <th className="px-3 py-2 text-left">Catatan</th>
                                <th className="px-3 py-2 text-left">Diubah</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {draft && <EditRow row={draft} kind={kind} onChange={setDraft} onSave={saveRow} onCancel={() => setDraft(null)} />}
                            {rows.map((row) => (
                                <tr key={row.sourceCode} className="border-t border-white/5">
                                    <td className="px-3 py-2 font-mono">{row.sourceCode}</td>
                                    <td className="px-3 py-2 font-mono">{row.targetCode}</td>
                                    {kind === "item" && <td className="px-3 py-2">{row.unit ?? "—"}</td>}
                                    {kind === "item" && <td className="px-3 py-2 text-right">{row.packSize ?? "—"}</td>}
                                    <td className="px-3 py-2 text-slate-400">{row.note || "—"}</td>
                                    <td className="px-3 py-2 text-slate-500 text-xs">
                                        {row.updatedAt ? new Date(row.updatedAt).toLocaleString("id-ID") : "—"}
                                        {row.updatedBy ? ` · ${row.updatedBy}` : ""}
                                    </td>
                                    <td className="px-3 py-2 text-right whitespace-nowrap">
                                        <button onClick={() => setDraft({ ...row, unit: row.unit ?? "", packSize: row.packSize ?? "" })}
                                            className="px-2 text-slate-400 hover:text-white">Ubah</button>
                                        <button onClick={() => void removeRow(row)} className="px-2 text-red-400 hover:text-red-300">
                                            <Trash2 size={15} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                            {!rows.length && !draft && (
                                <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">
                                    {busy ? "Memuat…" : "Belum ada mapping. Impor berkas principal atau tambah baris."}
                                </td></tr>
                            )}
                        </tbody>
                    </table>
                </div>

                {total > PAGE && (
                    <div className="flex items-center gap-3 text-sm">
                        <button disabled={offset === 0} onClick={() => setOffset(Math.max(offset - PAGE, 0))}
                            className="rounded bg-white/5 px-3 py-1.5 disabled:opacity-40">Sebelumnya</button>
                        <span className="text-slate-400">{offset + 1}–{Math.min(offset + PAGE, total)} dari {total}</span>
                        <button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}
                            className="rounded bg-white/5 px-3 py-1.5 disabled:opacity-40">Berikutnya</button>
                    </div>
                )}
            </section>
        </div>
    );
}

function EditRow({ row, kind, onChange, onSave, onCancel }: {
    row: Row; kind: Kind; onChange: (row: Row) => void; onSave: (row: Row) => void; onCancel: () => void;
}) {
    const field = "w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-blue-500";
    return (
        <tr className="border-t border-blue-500/30 bg-blue-500/5">
            <td className="px-3 py-2">
                <input value={row.sourceCode} onChange={(event) => onChange({ ...row, sourceCode: event.target.value })}
                    placeholder="kode principal" className={`${field} font-mono`} />
            </td>
            <td className="px-3 py-2">
                <input value={row.targetCode} onChange={(event) => onChange({ ...row, targetCode: event.target.value })}
                    placeholder="kode internal" className={`${field} font-mono`} />
            </td>
            {kind === "item" && (
                <td className="px-3 py-2">
                    <input value={row.unit ?? ""} onChange={(event) => onChange({ ...row, unit: event.target.value.toUpperCase() })}
                        placeholder="BTL" className={field} />
                </td>
            )}
            {kind === "item" && (
                <td className="px-3 py-2">
                    <input value={row.packSize ?? ""} onChange={(event) => onChange({ ...row, packSize: event.target.value })}
                        placeholder="36" inputMode="decimal" className={`${field} text-right`} />
                </td>
            )}
            <td className="px-3 py-2">
                <input value={row.note} onChange={(event) => onChange({ ...row, note: event.target.value })} className={field} />
            </td>
            <td className="px-3 py-2 text-xs text-slate-500">baru</td>
            <td className="px-3 py-2 text-right whitespace-nowrap">
                <button onClick={() => onSave(row)} className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs">
                    <Save size={13} /> Simpan
                </button>
                <button onClick={onCancel} className="px-2 text-slate-400 hover:text-white"><Check size={15} className="rotate-45" /></button>
            </td>
        </tr>
    );
}
