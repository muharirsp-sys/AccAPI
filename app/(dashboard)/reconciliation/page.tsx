"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { FileSpreadsheet, GitCompareArrows, Loader2, Play, X } from "lucide-react";
import { DataTable } from "@/components/DataTable";
import type { ReconciliationOutput, ReconciliationResult, ReconciliationStatus } from "@/lib/off-program-control/sales-reconciliation";

type StatusFilter = "ALL" | "MATCH_ONLY" | "ISSUES_ONLY" | ReconciliationStatus;

const statuses: ReconciliationStatus[] = ["MATCH", "QTY_MISMATCH", "VALUE_MISMATCH", "QTY_AND_VALUE_MISMATCH", "MISSING_INTERNAL", "MISSING_PRINCIPAL", "UNMAPPED_SKU", "UNIT_CONVERSION_ERROR", "INVALID_DATA"];
const currency = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 2 });
const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

function excelText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function fileSize(bytes: number): string {
  return bytes < 1_048_576 ? `${number.format(bytes / 1024)} KB` : `${number.format(bytes / 1_048_576)} MB`;
}

const columns: ColumnDef<ReconciliationResult>[] = [
  { accessorKey: "status", header: "Status", cell: ({ row }) => <span className={row.original.status === "MATCH" ? "font-semibold text-emerald-300" : "font-semibold text-amber-300"}>{row.original.status}</span> },
  { accessorKey: "orderNumber", header: "Order" },
  { accessorKey: "internalProductCode", header: "Produk internal" },
  { accessorKey: "transactionClass", header: "Kelas transaksi" },
  { accessorKey: "accurateQuantity", header: "Qty Accurate", cell: ({ getValue }) => number.format(getValue<number>()) },
  { accessorKey: "principalQuantity", header: "Qty prinsipal", cell: ({ getValue }) => number.format(getValue<number>()) },
  { accessorKey: "quantityDifference", header: "Selisih qty", cell: ({ getValue }) => number.format(getValue<number>()) },
  { accessorKey: "accurateNet", header: "Net Accurate", cell: ({ getValue }) => currency.format(getValue<number>()) },
  { accessorKey: "principalNet", header: "Net prinsipal", cell: ({ getValue }) => currency.format(getValue<number>()) },
  { accessorKey: "valueDifference", header: "Selisih net", cell: ({ getValue }) => currency.format(getValue<number>()) },
  { accessorKey: "warnings", header: "Peringatan", cell: ({ getValue }) => getValue<string[]>().join(", ") || "-" },
  { id: "sourceRows", header: "Baris sumber", cell: ({ row }) => `Accurate: ${row.original.accurateSourceRows.join(", ") || "-"}; KINO: ${row.original.principalSourceRows.join(", ") || "-"}` },
];

export default function ReconciliationPage() {
  const [accurateFile, setAccurateFile] = useState<File | null>(null);
  const [principalFile, setPrincipalFile] = useState<File | null>(null);
  const [result, setResult] = useState<ReconciliationOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");

  const filteredResults = useMemo(() => {
    const rows = result?.results ?? [];
    if (statusFilter === "ALL") return rows;
    if (statusFilter === "MATCH_ONLY") return rows.filter((row) => row.status === "MATCH");
    if (statusFilter === "ISSUES_ONLY") return rows.filter((row) => row.status !== "MATCH");
    return rows.filter((row) => row.status === statusFilter);
  }, [result, statusFilter]);

  function changeFile(kind: "accurate" | "principal", file: File | null) {
    if (kind === "accurate") setAccurateFile(file);
    else setPrincipalFile(file);
    setResult(null);
    setError(null);
  }

  async function runReconciliation() {
    if (!accurateFile || !principalFile) {
      setError("File Accurate dan KINO wajib diunggah.");
      return;
    }
    setIsRunning(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("accurateFile", accurateFile);
      form.append("principalFile", principalFile);
      const response = await fetch("/api/reconciliation/kino/sales", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Rekonsiliasi gagal diproses.");
      setResult(payload as ReconciliationOutput);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Rekonsiliasi gagal diproses.");
    } finally {
      setIsRunning(false);
    }
  }

  async function exportResult() {
    if (!result) return;
    const XLSX = await import("xlsx");
    const summary = statuses.map((status) => ({ Status: excelText(status), Jumlah: result.summary[status] }));
    const detail = result.results.map((row) => ({
      Status: excelText(row.status), Order: excelText(row.orderNumber), "Produk Internal": excelText(row.internalProductCode),
      "Kelas Transaksi": excelText(row.transactionClass), "Qty Accurate": row.accurateQuantity, "Qty Prinsipal": row.principalQuantity,
      "Selisih Qty": row.quantityDifference, "Net Accurate": row.accurateNet, "Net Prinsipal": row.principalNet,
      "Selisih Net": row.valueDifference, Peringatan: excelText(row.warnings.join(", ")), "Baris Accurate": row.accurateSourceRows.join(", "),
      "Baris KINO": row.principalSourceRows.join(", "),
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summary), "Ringkasan");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detail), "Detail");
    XLSX.writeFile(workbook, `hasil-rekonsiliasi-kino-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const matched = result?.summary.MATCH ?? 0;
  const total = result?.results.length ?? 0;

  return (
    <div className="mx-auto max-w-7xl space-y-8 pb-12">
      <header>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-indigo-500/15 px-3 py-1 text-xs font-semibold text-indigo-300">Faktur</span>
          <span className="rounded-full bg-cyan-500/15 px-3 py-1 text-xs font-semibold text-cyan-300">KINO</span>
        </div>
        <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-white"><GitCompareArrows className="text-indigo-400" /> Rekonsiliasi Faktur</h1>
        <p className="mt-2 text-slate-400">Bandingkan faktur Accurate dengan data penjualan prinsipal KINO.</p>
      </header>

      <section className="overflow-hidden rounded-3xl border border-white/10 bg-[#1a1c23]/60 shadow-xl backdrop-blur-xl">
        <div className="grid gap-6 p-6 md:grid-cols-2 md:p-8">
          {(["accurate", "principal"] as const).map((kind) => {
            const file = kind === "accurate" ? accurateFile : principalFile;
            const label = kind === "accurate" ? "File Accurate" : "File KINO";
            const cardClass = kind === "accurate" ? "border-indigo-500/20 bg-indigo-500/5" : "border-cyan-500/20 bg-cyan-500/5";
            return (
              <div key={kind} className={`rounded-2xl border p-5 ${cardClass}`}>
                <label htmlFor={`${kind}-file`} className="block font-bold text-slate-100">{label}</label>
                <p className="mb-4 mt-1 text-xs text-slate-400">Format yang diterima: .xlsx</p>
                <input id={`${kind}-file`} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={isRunning} onChange={(event) => changeFile(kind, event.target.files?.[0] ?? null)} className="block w-full text-sm text-slate-400 file:mr-4 file:rounded-full file:border-0 file:bg-white/10 file:px-4 file:py-2 file:text-xs file:font-semibold file:text-slate-200 hover:file:bg-white/15 disabled:opacity-50" />
                <div className="mt-4 flex min-h-8 items-center justify-between gap-3 text-sm text-slate-300">
                  <span className="truncate">{file ? `${file.name} (${fileSize(file.size)})` : "Belum ada file dipilih"}</span>
                  {file && <button type="button" disabled={isRunning} onClick={() => { const input = document.getElementById(`${kind}-file`); if (input instanceof HTMLInputElement) input.value = ""; changeFile(kind, null); }} aria-label={`Hapus ${label}`} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white disabled:opacity-50"><X size={16} /></button>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-4 border-t border-white/5 bg-black/30 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div aria-live="polite" className="min-h-5 text-sm">
            {error ? <p className="text-red-300">{error}</p> : isRunning ? <p className="text-indigo-300">Rekonsiliasi sedang diproses…</p> : result ? <p className="text-emerald-300">Rekonsiliasi selesai.</p> : <p className="text-slate-500">Unggah kedua file untuk memulai.</p>}
          </div>
          <button type="button" onClick={runReconciliation} disabled={isRunning || !accurateFile || !principalFile} className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-7 py-3 font-bold text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
            {isRunning ? <Loader2 className="animate-spin" size={18} /> : <Play size={18} />} Jalankan rekonsiliasi
          </button>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Ringkasan hasil">
        {[["Total perbandingan", total], ["Cocok", matched], ["Bermasalah", total - matched], ["Baris sumber", (result?.accurateLines.length ?? 0) + (result?.kinoLines.length ?? 0)]].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-white/5 bg-[#16181d]/80 p-5"><p className="text-sm text-slate-400">{label}</p><p className="mt-2 text-3xl font-bold text-white">{number.format(Number(value))}</p></div>
        ))}
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><h2 className="text-xl font-bold text-white">Hasil rekonsiliasi</h2><p className="text-sm text-slate-400">Filter hanya memengaruhi tabel, bukan file ekspor.</p></div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div><label htmlFor="status-filter" className="mb-1 block text-xs font-semibold text-slate-300">Filter status</label><select id="status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} className="rounded-lg border border-white/10 bg-[#1a1c23] px-3 py-2 text-sm text-slate-200"><option value="ALL">Semua</option><option value="MATCH_ONLY">Hanya cocok</option><option value="ISSUES_ONLY">Hanya bermasalah</option>{statuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></div>
            <button type="button" onClick={exportResult} disabled={!result} className="flex items-center justify-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"><FileSpreadsheet size={17} /> Ekspor XLSX</button>
          </div>
        </div>
        <DataTable columns={columns} data={filteredResults} searchPlaceholder="Cari order, produk, atau status…" />
      </section>
    </div>
  );
}
