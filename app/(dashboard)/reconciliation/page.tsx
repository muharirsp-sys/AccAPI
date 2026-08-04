"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  CheckCircle2,
  CircleAlert,
  FileSpreadsheet,
  GitCompareArrows,
  Loader2,
  Play,
  TriangleAlert,
  X,
} from "lucide-react";
import { DataTable } from "@/components/DataTable";
import type {
  ReconciliationOutput,
  ReconciliationResult,
  ReconciliationStatus,
} from "@/lib/off-program-control/sales-reconciliation";
import type {
  ReturnReconciliationOutput,
  ReturnReconciliationResult,
  ReturnStatus,
} from "@/lib/off-program-control/return-reconciliation";

type Division = "FAKTUR" | "PEMBELIAN" | "RETURN";
type UiStatus = ReconciliationStatus | ReturnStatus;
type Principal = "KINO" | "GODREJ" | "RECKITT" | "SHINZUI" | "MOTASA" | "CUSSONS" | "HEINZ" | "FORISA";
type StatusFilter = "ALL" | "MATCH_ONLY" | "ISSUES_ONLY" | UiStatus;

const salesStatuses: ReconciliationStatus[] = [
  "MATCH",
  "QTY_MISMATCH",
  "VALUE_MISMATCH",
  "QTY_AND_VALUE_MISMATCH",
  "MISSING_INTERNAL",
  "MISSING_PRINCIPAL",
  "UNMAPPED_SKU",
  "UNIT_CONVERSION_ERROR",
  "INVALID_DATA",
];
const returnStatuses: ReturnStatus[] = [
  "MATCH", "QTY_MISMATCH", "VALUE_MISMATCH", "QTY_AND_VALUE_MISMATCH",
  "MISSING_ACCURATE", "MISSING_PRINCIPAL", "UNMAPPED", "INVALID_DATA",
];
const returnPrinciples = ["SHINZUI", "KINO", "GODREJ", "HEINZ", "CUSSONS"] as const;
const purchasePrinciples = ["GODREJ", "RECKITT", "CUSSONS", "KINO", "FORISA"] as const;
const fixedStatusLabels: Partial<Record<UiStatus, string>> = {
  MATCH: "Cocok",
  QTY_MISMATCH: "Selisih jumlah",
  VALUE_MISMATCH: "Selisih nilai",
  QTY_AND_VALUE_MISMATCH: "Selisih jumlah dan nilai",
  MISSING_INTERNAL: "Data Accurate tidak ditemukan",
  INVALID_DATA: "Data tidak valid",
};
const statusClasses: Record<UiStatus, string> = {
  MATCH: "bg-emerald-500/10 text-emerald-300",
  QTY_MISMATCH: "bg-amber-500/10 text-amber-300",
  VALUE_MISMATCH: "bg-amber-500/10 text-amber-300",
  QTY_AND_VALUE_MISMATCH: "bg-amber-500/10 text-amber-300",
  MISSING_INTERNAL: "bg-rose-500/10 text-rose-300",
  MISSING_ACCURATE: "bg-rose-500/10 text-rose-300",
  MISSING_PRINCIPAL: "bg-rose-500/10 text-rose-300",
  UNMAPPED_SKU: "bg-rose-500/10 text-rose-300",
  UNMAPPED: "bg-rose-500/10 text-rose-300",
  UNIT_CONVERSION_ERROR: "bg-rose-500/10 text-rose-300",
  INVALID_DATA: "bg-rose-500/10 text-rose-300",
};
const amountLabels = {
  gross: "Nilai jual",
  discount: "Diskon",
  dpp: "DPP",
  tax: "Pajak",
  net: "Nilai bersih",
} as const;
const currency = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 2,
});
const number = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const money = (value: number) => `Rp${number.format(value)}`;
const direction = (difference: number, formatted: string) =>
  `Accurate ${difference < 0 ? "kurang" : "lebih"} ${formatted}`;

function statusLabel(
  status: UiStatus,
  principal: Principal,
): string {
  if (status === "MISSING_ACCURATE") return "Data Accurate tidak ditemukan";
  if (status === "MISSING_PRINCIPAL")
    return `Data ${principal} tidak ditemukan`;
  if (status === "UNMAPPED_SKU" || status === "UNMAPPED")
    return `SKU ${principal} belum dipetakan`;
  if (status === "UNIT_CONVERSION_ERROR") return "Konversi satuan gagal";
  return fixedStatusLabels[status] ?? status;
}

function causeLines(row: ReconciliationResult, principal: Principal): string[] {
  if (row.status === "MATCH") return ["Tidak ada selisih."];
  if (row.status === "MISSING_INTERNAL")
    return ["Data tidak ditemukan di Accurate."];
  if (row.status === "MISSING_PRINCIPAL")
    return [`Data tidak ditemukan di ${principal}.`];
  if (row.status === "UNMAPPED_SKU")
    return [`SKU ${principal} belum memiliki pasangan produk Accurate.`];
  if (row.status === "UNIT_CONVERSION_ERROR")
    return [
      `Konversi satuan gagal; periksa master ${principal} dan baris sumber.`,
    ];
  if (row.status === "INVALID_DATA")
    return ["Data tidak dapat dibandingkan; periksa format sumber."];
  const causes: string[] = [];
  if (row.quantityDifference !== 0)
    causes.push(
      `Jumlah: Accurate ${number.format(row.accurateQuantity)}, ${principal} ${number.format(row.principalQuantity)} — ${direction(row.quantityDifference, number.format(Math.abs(row.quantityDifference)))}`,
    );
  for (const item of row.amountDifferences)
    causes.push(
      `${amountLabels[item.component]}: Accurate ${money(item.accurate)}, ${principal} ${money(item.kino)} — ${direction(item.difference, money(Math.abs(item.difference)))}`,
    );
  causes.push(
    ...row.warnings.map((warning) =>
      warning === "UNMAPPED_CUSTOMER"
        ? `Pelanggan ${principal} belum dipetakan.`
        : warning === "UNMAPPED_SALESMAN"
          ? `Salesman ${principal} belum dipetakan.`
          : warning,
    ),
  );
  return causes;
}

function excelText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function fileSize(bytes: number): string {
  return bytes < 1_048_576
    ? `${number.format(bytes / 1024)} KB`
    : `${number.format(bytes / 1_048_576)} MB`;
}

function columnsFor(principal: Principal): ColumnDef<ReconciliationResult>[] {
  return [
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => {
        const status = row.original.status;
        const Icon =
          status === "MATCH"
            ? CheckCircle2
            : status === "QTY_MISMATCH" ||
                status === "VALUE_MISMATCH" ||
                status === "QTY_AND_VALUE_MISMATCH"
              ? CircleAlert
              : TriangleAlert;
        return (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses[status]}`}
          >
            <Icon size={14} aria-hidden="true" />
            {statusLabel(status, principal)}
          </span>
        );
      },
    },
    { accessorKey: "orderNumber", header: "Order" },
    { accessorKey: "internalProductCode", header: "Produk internal" },
    {
      id: "causes",
      header: "Penyebab selisih",
      cell: ({ row }) => (
        <ul className="min-w-72 space-y-1">
          {causeLines(row.original, principal).map((cause) => (
            <li key={cause}>{cause}</li>
          ))}
        </ul>
      ),
    },
    { accessorKey: "transactionClass", header: "Kelas transaksi" },
    {
      accessorKey: "accurateQuantity",
      header: "Qty Accurate",
      cell: ({ getValue }) => (
        <span className="block text-right font-mono tabular-nums">
          {number.format(getValue<number>())}
        </span>
      ),
    },
    {
      accessorKey: "principalQuantity",
      header: "Qty prinsipal",
      cell: ({ getValue }) => (
        <span className="block text-right font-mono tabular-nums">
          {number.format(getValue<number>())}
        </span>
      ),
    },
    {
      accessorKey: "quantityDifference",
      header: "Selisih qty",
      cell: ({ getValue }) => (
        <span className="block text-right font-mono tabular-nums">
          {number.format(getValue<number>())}
        </span>
      ),
    },
    {
      accessorKey: "accurateNet",
      header: "Net Accurate",
      cell: ({ getValue }) => (
        <span className="block text-right font-mono tabular-nums">
          {currency.format(getValue<number>())}
        </span>
      ),
    },
    {
      accessorKey: "principalNet",
      header: "Net prinsipal",
      cell: ({ getValue }) => (
        <span className="block text-right font-mono tabular-nums">
          {currency.format(getValue<number>())}
        </span>
      ),
    },
    {
      accessorKey: "valueDifference",
      header: "Selisih net",
      cell: ({ getValue }) => (
        <span className="block text-right font-mono tabular-nums">
          {currency.format(getValue<number>())}
        </span>
      ),
    },
    {
      accessorKey: "warnings",
      header: "Peringatan",
      cell: ({ getValue }) => getValue<string[]>().join(", ") || "-",
    },
    {
      id: "sourceRows",
      header: "Baris sumber",
      cell: ({ row }) =>
        `Accurate: ${row.original.accurateSourceRows.join(", ") || "-"} · ${principal}: ${row.original.principalSourceRows.join(", ") || "-"}`,
    },
  ];
}

function returnCauseLines(row: ReturnReconciliationResult, principal: Principal): string[] {
  if (row.status === "MATCH") return ["Tidak ada selisih."];
  if (row.status === "INVALID_DATA")
    return row.invalidReason
      ? [row.invalidReason]
      : row.warnings.length
        ? row.warnings
        : ["Data tidak valid."];
  const causes: string[] = [];
  if (row.status === "MISSING_ACCURATE") causes.push("Data tidak ditemukan di Accurate.");
  else if (row.status === "MISSING_PRINCIPAL") causes.push(`Data tidak ditemukan di ${principal}.`);
  else if (row.status === "UNMAPPED") {
    if (row.principalProductCode && !row.accurateProductCode)
      causes.push(`Produk ${row.principalProductCode} belum memiliki mapping Accurate.`);
    else if (row.accurateProductCode && !row.principalProductCode)
      causes.push(`Produk ${row.accurateProductCode} belum memiliki mapping ${principal}.`);
    else causes.push(`Produk Accurate belum memiliki mapping ${principal}.`);
    return causes;
  }
  if (row.quantityDifference !== 0)
    causes.push(`Qty: Accurate ${number.format(row.accurateQuantity)}, ${principal} ${number.format(row.principalQuantity)} — ${direction(row.quantityDifference, number.format(Math.abs(row.quantityDifference)))}`);
  if (Math.abs(row.dppDifference) > 1)
    causes.push(`DPP: Accurate ${money(row.accurateDpp)}, ${principal} ${money(row.principalDpp)} — ${direction(row.dppDifference, money(Math.abs(row.dppDifference)))}`);
  return causes.length ? causes : row.warnings;
}

function returnColumns(principal: Principal, division: Exclude<Division, "FAKTUR">): ColumnDef<ReturnReconciliationResult>[] {
  return [
    {
      accessorKey: "status", header: "Status",
      cell: ({ row }) => <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses[row.original.status]}`}>{statusLabel(row.original.status, principal)}</span>,
    },
    { accessorKey: "invoiceNumber", header: division === "PEMBELIAN" ? "Dokumen Pembelian" : "Invoice" },
    { accessorKey: "customerCode", header: division === "PEMBELIAN" ? "Supplier" : "Pelanggan" },
    {
      id: "product",
      accessorFn: (row) => `${row.accurateProductCode ?? "-"} / ${row.principalProductCode ?? "-"}`,
      header: "Produk",
    },
    {
      id: "causes", header: "Penyebab selisih",
      cell: ({ row }) => <ul className="min-w-72 space-y-1">{returnCauseLines(row.original, principal).map((cause) => <li key={cause}>{cause}</li>)}</ul>,
    },
    { accessorKey: "accurateQuantity", header: "Qty Accurate" },
    { accessorKey: "principalQuantity", header: `Qty ${principal}` },
    { accessorKey: "accurateDpp", header: "DPP Accurate" },
    { accessorKey: "principalDpp", header: `DPP ${principal}` },
    { accessorKey: "accurateTax", header: "Pajak Accurate", cell: ({ getValue }) => currency.format(getValue<number>()) },
    { accessorKey: "principalTax", header: `Pajak ${principal}`, cell: ({ getValue }) => currency.format(getValue<number>()) },
    { accessorKey: "accurateTotal", header: "Total Accurate", cell: ({ getValue }) => currency.format(getValue<number>()) },
    { accessorKey: "principalTotal", header: `Total ${principal}`, cell: ({ getValue }) => currency.format(getValue<number>()) },
    {
      id: "sourceRows", header: "Baris sumber",
      cell: ({ row }) => `Accurate: ${row.original.accurateSourceRows.join(", ") || "-"} · ${principal}: ${row.original.principalSourceRows.join(", ") || "-"}`,
    },
  ];
}
export default function ReconciliationPage() {
  const [division, setDivision] = useState<Division>("FAKTUR");
  const [principal, setPrincipal] = useState<Principal>("KINO");
  const [accurateFile, setAccurateFile] = useState<File | null>(null);
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [principalFile, setPrincipalFile] = useState<File | null>(null);
  const [result, setResult] = useState<ReconciliationOutput | ReturnReconciliationOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const salesColumns = useMemo(() => columnsFor(principal), [principal]);
  const returnTableColumns = useMemo(() => returnColumns(principal, division === "PEMBELIAN" ? "PEMBELIAN" : "RETURN"), [division, principal]);
  const currentStatuses = division === "FAKTUR" ? salesStatuses : returnStatuses;

  const filteredResults = useMemo(() => {
    const rows = result?.results ?? [];
    if (statusFilter === "ALL") return rows;
    if (statusFilter === "MATCH_ONLY") return rows.filter((row) => row.status === "MATCH");
    if (statusFilter === "ISSUES_ONLY") return rows.filter((row) => row.status !== "MATCH");
    return rows.filter((row) => row.status === statusFilter);
  }, [result, statusFilter]);

  function resetReconciliation() {
    setAccurateFile(null);
    setHeaderFile(null);
    setPrincipalFile(null);
    setResult(null);
    setStatusFilter("ALL");
    setError(null);
  }

  function changeFile(kind: "accurate" | "header" | "principal", file: File | null) {
    if (kind === "accurate") setAccurateFile(file);
    else if (kind === "header") setHeaderFile(file);
    else setPrincipalFile(file);
    setResult(null);
    setError(null);
  }

  function changePrincipal(next: Principal) {
    resetReconciliation();
    setPrincipal(next);
  }

  function changeDivision(next: Division) {
    if (next === division) return;
    resetReconciliation();
    setDivision(next);
    setPrincipal(next === "RETURN" ? "SHINZUI" : next === "PEMBELIAN" ? "GODREJ" : "KINO");
  }

  async function runReconciliation() {
    if (!accurateFile || !principalFile || (principal === "HEINZ" && !headerFile)) return;
    setIsRunning(true);
    setResult(null);
    setStatusFilter("ALL");
    setError(null);
    try {
      const form = new FormData();
      form.append("accurateFile", accurateFile);
      if (principal === "HEINZ" && headerFile) form.append("headerFile", headerFile);
      form.append("principalFile", principalFile);
      const endpoint = division === "RETURN" ? "returns" : division === "PEMBELIAN" ? "purchases" : "sales";
      const response = await fetch(`/api/reconciliation/${principal.toLowerCase()}/${endpoint}`, { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Rekonsiliasi gagal diproses.");
      const output = payload as ReconciliationOutput | ReturnReconciliationOutput;
      setResult(output);
      setStatusFilter(output.results.some((row) => row.status !== "MATCH") ? "ISSUES_ONLY" : "ALL");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Rekonsiliasi gagal diproses.");
    } finally {
      setIsRunning(false);
    }
  }

  async function exportResult() {
    if (!result) return;
    setError(null);
    try {
      const XLSX = await import("xlsx");
      const summary = currentStatuses.map((status) => ({ Status: excelText(status), Jumlah: (result.summary as Record<string, number>)[status] ?? 0 }));
      const detail = division !== "FAKTUR"
        ? (result.results as ReturnReconciliationResult[]).map((row) => ({
            Status: excelText(row.status),
            [division === "PEMBELIAN" ? "Dokumen Pembelian" : "Invoice"]: excelText(row.invoiceNumber),
            [division === "PEMBELIAN" ? "Supplier" : "Pelanggan"]: excelText(row.customerCode),
            "Produk Accurate": excelText(row.accurateProductCode ?? ""), [`Produk ${principal}`]: excelText(row.principalProductCode ?? ""),
            "Qty Accurate": row.accurateQuantity, [`Qty ${principal}`]: row.principalQuantity, "Selisih Qty": row.quantityDifference,
            "DPP Accurate": row.accurateDpp, [`DPP ${principal}`]: row.principalDpp, "Selisih DPP": row.dppDifference,
            "Pajak Accurate": row.accurateTax, [`Pajak ${principal}`]: row.principalTax,
            "Total Accurate": row.accurateTotal, [`Total ${principal}`]: row.principalTotal,
            "Penyebab selisih": excelText(returnCauseLines(row, principal).join("\n")),
            "Baris Accurate": row.accurateSourceRows.join(", "), [`Baris ${principal}`]: row.principalSourceRows.join(", "),
          }))
        : (result.results as ReconciliationResult[]).map((row) => ({
            Status: excelText(row.status), Order: excelText(row.orderNumber), "Produk Internal": excelText(row.internalProductCode),
            "Kelas Transaksi": excelText(row.transactionClass), "Qty Accurate": row.accurateQuantity, "Qty Prinsipal": row.principalQuantity,
            "Selisih Qty": row.quantityDifference, "Net Accurate": row.accurateNet, "Net Prinsipal": row.principalNet,
            "Selisih Net": row.valueDifference, Peringatan: excelText(row.warnings.join(", ")),
            "Baris Accurate": row.accurateSourceRows.join(", "), [`Baris ${principal}`]: row.principalSourceRows.join(", "),
          }));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summary), "Ringkasan");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detail), "Detail");
      const prefix = division === "RETURN"
        ? principal === "SHINZUI" ? "hasil-rekonsiliasi-return-shinzui" : `rekonsiliasi-return-${principal.toLowerCase()}`
        : division === "PEMBELIAN"
          ? `rekonsiliasi-pembelian-${principal.toLowerCase()}`
          : `hasil-rekonsiliasi-${principal.toLowerCase()}`;
      XLSX.writeFile(workbook, `${prefix}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch {
      setError("File hasil gagal diekspor. Silakan coba lagi.");
    }
  }

  const count = (status: UiStatus) => (result?.summary as Partial<Record<UiStatus, number>> | undefined)?.[status] ?? 0;
  const matched = count("MATCH");
  const total = result?.results.length ?? 0;
  const problematic = total - matched;
  const mismatch = count("QTY_MISMATCH") + count("VALUE_MISMATCH") + count("QTY_AND_VALUE_MISMATCH");
  const missing = count("MISSING_PRINCIPAL") + (division === "FAKTUR" ? count("MISSING_INTERNAL") : count("MISSING_ACCURATE"));

  return (
    <div className="mx-auto max-w-7xl space-y-8 pb-12">
      <header className="space-y-5">
        <div>
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-white">
            <GitCompareArrows className="text-indigo-400" /> Rekonsiliasi {division === "RETURN" ? "Return" : division === "PEMBELIAN" ? "Pembelian" : "Faktur"}
          </h1>
          <p className="mt-2 text-slate-400">
            {division === "PEMBELIAN"
              ? principal === "FORISA"
                ? "Bandingkan faktur pembelian Accurate dengan DO FORISA."
                : `Bandingkan faktur pembelian Accurate dengan ${principal === "RECKITT" || principal === "CUSSONS" ? "TXN_COMPINV_DTL" : principal === "KINO" ? "PO Report" : "GRN Status Report"} ${principal}.`
              : division === "RETURN"
              ? principal === "HEINZ"
                ? "Bandingkan retur Accurate dengan laporan HEADER dan DETAIL HEINZ."
                : `Bandingkan retur Accurate dengan laporan ${principal === "SHINZUI" ? "PenjualanInvoice" : principal === "GODREJ" ? "Sale Returns" : principal === "CUSSONS" ? "TXN_NOTEPRD" : "Sales Detail"} ${principal}.`
              : `Bandingkan faktur Accurate dengan data penjualan prinsipal ${principal}.`}
          </p>
        </div>

        <section
          aria-labelledby="reconciliation-type-heading"
          className="overflow-hidden rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-3 shadow-lg backdrop-blur-xl"
        >
          <h2
            id="reconciliation-type-heading"
            className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400"
          >
            Jenis Rekonsiliasi
          </h2>
          <ul className="grid list-none grid-cols-3 gap-2">
            {(["FAKTUR", "PEMBELIAN", "RETURN"] as const).map((item) => (
              <li key={item} aria-current={division === item ? "page" : undefined} className={division === item ? "min-w-0 rounded-xl border border-indigo-500/30 bg-indigo-500/10 text-center" : "min-w-0 rounded-xl border border-white/10 bg-white/5 text-center"}>
                <button type="button" aria-label={item === "FAKTUR" ? "Faktur" : item === "PEMBELIAN" ? "Pembelian" : "Return"} aria-pressed={division === item} disabled={isRunning} onClick={() => changeDivision(item)} className="min-h-11 w-full rounded-xl px-2 py-3 text-sm font-semibold text-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70">
                  {item === "FAKTUR" ? "Faktur" : item === "PEMBELIAN" ? "Pembelian" : "Return"}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-300">
              {division === "RETURN" ? "Return" : division === "PEMBELIAN" ? "Pembelian" : "Faktur"}
            </span>
            <span className="rounded-full bg-cyan-500/10 px-3 py-1 text-xs font-semibold text-cyan-300">
              {principal}
            </span>
          </div>
          <div>
            <label
              htmlFor="principal-select"
              className="mb-1 block text-xs font-semibold text-slate-300"
            >
              Prinsipal
            </label>
            <select
              id="principal-select"
              value={principal}
              disabled={isRunning}
              onChange={(event) =>
                changePrincipal(event.target.value as Principal)
              }
              className="rounded-lg border border-white/10 bg-[#1a1c23] px-3 py-2 text-sm text-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 disabled:opacity-50"
            >
              {division === "PEMBELIAN" ? (
                purchasePrinciples.map((item) => <option key={item} value={item}>{item}</option>)
              ) : division === "RETURN" ? (
                returnPrinciples.map((item) => <option key={item} value={item}>{item}</option>)
              ) : (
                <>
                  <option value="KINO">KINO</option>
                  <option value="GODREJ">GODREJ</option>
                  <option value="SHINZUI">SHINZUI</option>
                  <option value="MOTASA">MOTASA</option>
                  <option value="CUSSONS">CUSSONS</option>
                </>
              )}
            </select>
          </div>
        </div>
      </header>

      <section className="overflow-hidden rounded-3xl border border-white/10 bg-[#1a1c23]/60 shadow-xl backdrop-blur-xl">
        <div className={`grid gap-6 p-6 md:p-8 ${division === "RETURN" && principal === "HEINZ" ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
          {(division === "RETURN" && principal === "HEINZ"
            ? (["accurate", "header", "principal"] as const)
            : (["accurate", "principal"] as const)
          ).map((kind) => {
            const file = kind === "accurate" ? accurateFile : kind === "header" ? headerFile : principalFile;
            const isCsvPrincipal = kind === "principal" && (
              (division === "RETURN" && (principal === "GODREJ" || principal === "HEINZ" || principal === "CUSSONS")) ||
              (division === "PEMBELIAN" && principal !== "KINO" && principal !== "FORISA") ||
              (division === "FAKTUR" && principal === "CUSSONS")
            );
            const isCsv = kind === "header" || isCsvPrincipal;
            const label = division === "PEMBELIAN"
              ? kind === "accurate"
                ? "Rincian Faktur Pembelian (Accurate)"
                : principal === "FORISA"
                  ? "DO FORISA"
                  : `${principal === "RECKITT" || principal === "CUSSONS" ? "TXN_COMPINV_DTL" : principal === "KINO" ? "PO Report" : "GRN Status Report"} ${principal}`
              : division === "RETURN"
              ? kind === "accurate"
                ? "Retur Penjualan (Accurate)"
                : kind === "header"
                  ? "HEADER HEINZ"
                  : `${principal === "SHINZUI" ? "PenjualanInvoice" : principal === "GODREJ" ? "Sale Returns" : principal === "HEINZ" ? "DETAIL" : principal === "CUSSONS" ? "TXN_NOTEPRD" : "Sales Detail"} ${principal}`
              : kind === "accurate"
                ? "Rincian Faktur Penjualan (Accurate)"
                : `${isCsvPrincipal ? "Detail" : "Sales Detail"} ${principal}`;
            const accept = isCsv
              ? ".csv,text/csv,application/csv"
              : ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            const helpText = `Format ${isCsv ? ".csv" : ".xlsx"}, maksimal 10 MB`;
            const cardClass =
              kind === "accurate"
                ? "border-indigo-500/20 bg-indigo-500/10"
                : "border-cyan-500/20 bg-cyan-500/10";
            return (
              <div key={kind} className={`rounded-2xl border p-5 ${cardClass}`}>
                <label
                  htmlFor={`${kind}-file`}
                  className="block font-bold text-slate-100"
                >
                  {label}
                </label>
                <p className="mb-4 mt-1 text-xs text-slate-400">
                  {helpText}
                </p>
                <input
                  key={`${division}-${kind}-${principal}`}
                  id={`${kind}-file`}
                  type="file"
                  accept={accept}
                  disabled={isRunning}
                  onChange={(event) =>
                    changeFile(kind, event.target.files?.[0] ?? null)
                  }
                  className="block w-full rounded-lg text-sm text-slate-400 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 file:mr-4 file:rounded-full file:border-0 file:bg-white/10 file:px-4 file:py-2 file:text-xs file:font-semibold file:text-slate-200 hover:file:bg-white/20 disabled:opacity-50"
                />
                <div className="mt-4 flex min-h-11 items-center justify-between gap-3 text-sm text-slate-300">
                  <span className="truncate">
                    {file
                      ? `${file.name} (${fileSize(file.size)})`
                      : "Belum ada file dipilih"}
                  </span>
                  {file && (
                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => {
                        const input = document.getElementById(`${kind}-file`);
                        if (input instanceof HTMLInputElement) input.value = "";
                        changeFile(kind, null);
                      }}
                      aria-label={`Hapus ${label}`}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-400 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-400/70 disabled:opacity-50"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-4 border-t border-white/10 bg-black/20 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div aria-live="polite" className="min-h-5 text-sm">
            {error ? (
              <p role="alert" className="text-rose-300">
                {error}
              </p>
            ) : isRunning ? (
              <p className="text-indigo-300">Rekonsiliasi sedang diproses…</p>
            ) : result ? (
              <p className="text-emerald-300">
                Rekonsiliasi selesai. Periksa ringkasan di bawah.
              </p>
            ) : (
              <p className="text-slate-400">
                {division === "RETURN" && principal === "HEINZ"
                  ? "Unggah ketiga file untuk memulai."
                  : "Unggah kedua file untuk memulai."}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={runReconciliation}
            disabled={isRunning || !accurateFile || !principalFile || (principal === "HEINZ" && !headerFile)}
            className="btn-primary flex w-full items-center justify-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 sm:w-auto"
          >
            {isRunning ? (
              <Loader2
                className="animate-spin motion-reduce:animate-none"
                size={18}
              />
            ) : (
              <Play size={18} />
            )}{" "}
            Jalankan rekonsiliasi
          </button>
        </div>
      </section>

      {result && (
        <>
          <section
            className="grid gap-4 sm:grid-cols-3"
            aria-label="Ringkasan hasil"
          >
            {(
              [
                ["Total", total, GitCompareArrows, "text-indigo-300"],
                ["Cocok", matched, CheckCircle2, "text-emerald-300"],
                ["Bermasalah", problematic, TriangleAlert, "text-rose-300"],
              ] as const
            ).map(([label, value, Icon, color]) => (
              <div
                key={String(label)}
                className="rounded-2xl border border-white/10 bg-[#1a1c23]/80 p-5"
              >
                <div className="flex items-center gap-2 text-sm text-slate-300">
                  <Icon
                    className={String(color)}
                    size={18}
                    aria-hidden="true"
                  />
                  {String(label)}
                </div>
                <p className="mt-2 text-3xl font-bold tabular-nums text-white">
                  {number.format(Number(value))}
                </p>
              </div>
            ))}
          </section>

          <section
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
            aria-label="Rincian masalah"
          >
            {(
              [
                ["Selisih jumlah/nilai", mismatch, CircleAlert],
                ["Data tidak ditemukan", missing, TriangleAlert],
                [
                  "SKU belum dipetakan",
                  count(division === "FAKTUR" ? "UNMAPPED_SKU" : "UNMAPPED"),
                  TriangleAlert,
                ],
                [
                  division === "FAKTUR" ? "Konversi satuan gagal" : "Data tidak valid",
                  count(division === "FAKTUR" ? "UNIT_CONVERSION_ERROR" : "INVALID_DATA"),
                  TriangleAlert,
                ],
              ] as const
            ).map(([label, value, Icon]) => (
              <div
                key={String(label)}
                className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-[#1a1c23]/60 p-5"
              >
                <div className="flex min-w-0 items-center gap-2 text-sm text-slate-300">
                  <Icon
                    className="shrink-0 text-amber-300"
                    size={17}
                    aria-hidden="true"
                  />
                  <span>{String(label)}</span>
                </div>
                <p className="font-mono text-xl font-bold tabular-nums text-white">
                  {number.format(Number(value))}
                </p>
              </div>
            ))}
          </section>

          <section className="min-w-0 space-y-4">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-xl font-bold text-white">
                  {problematic > 0
                    ? "Temuan yang perlu diperiksa"
                    : "Semua data cocok"}
                </h2>
                <p className="text-sm text-slate-400">
                  {problematic > 0
                    ? `Menampilkan ${number.format(problematic)} bermasalah dari ${number.format(total)} hasil.`
                    : `Seluruh ${number.format(total)} data cocok.`}
                </p>
              </div>
              <div className="flex w-full min-w-0 flex-col gap-3 sm:w-auto sm:flex-row sm:items-end">
                <div className="min-w-0">
                  <label
                    htmlFor="status-filter"
                    className="mb-1 block text-xs font-semibold text-slate-300"
                  >
                    Filter status
                  </label>
                  <select
                    id="status-filter"
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as StatusFilter)
                    }
                    className="w-full rounded-lg border border-white/10 bg-[#1a1c23] px-3 py-2 text-sm text-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 sm:w-auto"
                  >
                    <option value="ALL">Semua status</option>
                    <option value="MATCH_ONLY">Hanya cocok</option>
                    <option value="ISSUES_ONLY">Hanya bermasalah</option>
                    {currentStatuses.map((status) => (
                      <option key={status} value={status}>
                        {statusLabel(status, principal)}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={exportResult}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-300 outline-none hover:bg-emerald-500/20 focus-visible:ring-2 focus-visible:ring-emerald-400/70 sm:w-auto"
                >
                  <FileSpreadsheet size={17} /> Ekspor XLSX
                </button>
              </div>
            </div>
            {division !== "FAKTUR" ? (
              <DataTable
                columns={returnTableColumns}
                data={filteredResults as ReturnReconciliationResult[]}
                initialColumnVisibility={{ accurateQuantity: false, principalQuantity: false, accurateDpp: false, principalDpp: false }}
                emptyMessage="Tidak ada hasil untuk filter ini."
                searchPlaceholder="Cari invoice, pelanggan, produk, atau status…"
              />
            ) : (
              <DataTable
                columns={salesColumns}
                data={filteredResults as ReconciliationResult[]}
                initialColumnVisibility={{ transactionClass: false, warnings: false, accurateQuantity: false, principalQuantity: false, quantityDifference: false, accurateNet: false, principalNet: false, valueDifference: false }}
                emptyMessage="Tidak ada hasil untuk filter ini."
                searchPlaceholder="Cari order, produk, atau status…"
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
