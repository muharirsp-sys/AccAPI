/*
 * Tujuan: Tabel data reusable dengan sorting, pencarian fuzzy, visibility kolom, pagination, dan feedback aksesibel.
 * Caller: Route dashboard yang membutuhkan tabel TanStack generik.
 * Dependensi: TanStack React Table, fuzzySearch internal, `AsyncState`, lucide-react.
 * Main Functions: `DataTable`, semantic compact table layout dan feedback async.
 * Side Effects: Mutasi state UI lokal dan listener sementara untuk Escape/outside click pada pemilih kolom.
 */

"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import {
    ColumnDef,
    flexRender,
    getCoreRowModel,
    getPaginationRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    useReactTable,
    SortingState,
    FilterFn,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Search, SlidersHorizontal, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { fuzzyMatch } from "@/lib/fuzzySearch";
import { EmptyState, LoadingState } from "@/components/ui/AsyncState";

interface DataTableProps<TData, TValue> {
    columns: ColumnDef<TData, TValue>[];
    data: TData[];
    searchKey?: string; 
    searchPlaceholder?: string;
    isLoading?: boolean;
    caption?: string;
    emptyMessage?: string;
}

export function DataTable<TData, TValue>({
    columns,
    data,
    searchPlaceholder = "Cari semua kolom...",
    isLoading = false,
    caption = "Tabel data",
    emptyMessage = "Tidak ada hasil.",
}: DataTableProps<TData, TValue>) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [globalFilter, setGlobalFilter] = useState("");
    const [rowSelection, setRowSelection] = useState({});

    const [isViewOpen, setIsViewOpen] = useState(false);
    const columnPickerRef = useRef<HTMLDivElement>(null);
    const columnPickerButtonRef = useRef<HTMLButtonElement>(null);
    const tableId = useId();
    const searchInputId = `${tableId}-search`;
    const columnMenuId = `${tableId}-column-menu`;
    const pageSizeId = `${tableId}-page-size`;

    const fuzzyOrWildcardFilter: FilterFn<TData> = (row, columnId, filterValue) => {
        const value = row.getValue(columnId);
        return fuzzyMatch(value, String(filterValue || ""));
    };

    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        onSortingChange: setSorting,
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        onGlobalFilterChange: setGlobalFilter,
        onRowSelectionChange: setRowSelection,
        globalFilterFn: fuzzyOrWildcardFilter,
        state: {
            sorting,
            globalFilter,
            rowSelection,
        },
    });

    useEffect(() => {
        if (!isViewOpen) return;

        const handlePointerDown = (event: PointerEvent) => {
            if (!columnPickerRef.current?.contains(event.target as Node)) {
                setIsViewOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setIsViewOpen(false);
            columnPickerButtonRef.current?.focus();
        };

        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [isViewOpen]);

    return (
        <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex w-full items-center gap-2 bg-white/5 border border-white/5 rounded-lg px-3 py-2 shadow-sm focus-within:ring-2 focus-within:ring-indigo-500/50 focus-within:border-indigo-500 transition-all sm:w-72">
                    <Search className="h-4 w-4 text-slate-400" />
                    <label htmlFor={searchInputId} className="sr-only">Cari tabel</label>
                    <input
                        id={searchInputId}
                        placeholder={searchPlaceholder}
                        value={globalFilter ?? ""}
                        onChange={(event) => setGlobalFilter(event.target.value)}
                        className="bg-transparent border-none outline-none text-sm text-slate-200 w-full placeholder:text-slate-500"
                    />
                </div>
                
                <div ref={columnPickerRef} className="flex items-center gap-2 relative">
                    <button
                        ref={columnPickerButtonRef}
                        type="button"
                        onClick={() => setIsViewOpen(!isViewOpen)}
                        aria-expanded={isViewOpen}
                        aria-controls={columnMenuId}
                        aria-haspopup="true"
                        className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/5 rounded-lg px-3 py-2 text-sm text-slate-300 transition-colors shadow-sm"
                    >
                        <SlidersHorizontal className="h-4 w-4" />
                        Kolom
                    </button>

                    {isViewOpen && (
                        <div id={columnMenuId} role="group" aria-label="Tampilkan kolom" className="absolute right-0 top-full mt-2 w-48 bg-[#1a1c23] border border-white/5 rounded-lg shadow-xl shadow-black/50 z-50 p-2 py-3 backdrop-blur-xl">
                            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-2 mb-2">Tampilkan Kolom</div>
                            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
                                {table.getAllLeafColumns().map(column => {
                                    if (column.id === "select") return null;
                                    return (
                                        <label key={column.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/5 rounded-md cursor-pointer transition-colors">
                                            <input
                                                type="checkbox"
                                                className="w-4 h-4 rounded border-white/20 bg-black/20 text-indigo-500 focus:ring-indigo-500/50"
                                                {...{
                                                    checked: column.getIsVisible(),
                                                    onChange: column.getToggleVisibilityHandler(),
                                                }}
                                            />
                                            <span className="text-sm text-slate-300 truncate">{typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}</span>
                                        </label>
                                    )
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <p role="status" aria-live="polite" className="sr-only">
                {isLoading
                    ? "Memuat data tabel."
                    : `${table.getFilteredRowModel().rows.length} baris tersedia.`}
            </p>

            {/* Table */}
            <div className="ui-table-frame">
                <div className="overflow-x-auto">
                    <table aria-busy={isLoading} className="ui-data-table relative">
                        <caption className="sr-only">{caption}</caption>
                        <thead className="text-xs text-slate-400 uppercase bg-black/20 border-b border-white/5">
                            {table.getHeaderGroups().map((headerGroup) => (
                                <tr key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => {
                                        const sorted = header.column.getIsSorted();
                                        const canSort = header.column.getCanSort();
                                        const ariaSort = sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : canSort ? "none" : undefined;
                                        return (
                                            <th key={header.id} scope="col" aria-sort={ariaSort} className="px-4 py-3 font-medium whitespace-nowrap">
                                                {header.isPlaceholder ? null : (
                                                    canSort ? (
                                                        <button
                                                            type="button"
                                                            className="flex items-center gap-1 text-left select-none group"
                                                            onClick={header.column.getToggleSortingHandler()}
                                                        >
                                                            {flexRender(
                                                                header.column.columnDef.header,
                                                                header.getContext()
                                                            )}
                                                            <span className="text-slate-500 group-hover:text-slate-300 transition-colors">
                                                                {{
                                                                    asc: <ChevronUp className="h-3 w-3" />,
                                                                    desc: <ChevronDown className="h-3 w-3" />,
                                                                }[sorted as string] ?? null}
                                                            </span>
                                                        </button>
                                                    ) : (
                                                        <div className="flex items-center gap-1">
                                                            {flexRender(
                                                                header.column.columnDef.header,
                                                                header.getContext()
                                                            )}
                                                        </div>
                                                    )
                                                )}
                                            </th>
                                        );
                                    })}
                                </tr>
                            ))}
                        </thead>
                        <tbody className="divide-y divide-white/5">
                            {isLoading ? (
                                <tr>
                                    <td colSpan={table.getVisibleLeafColumns().length || 1} className="h-24 text-center">
                                        <LoadingState label="Memuat data tabel" rows={3} embedded />
                                    </td>
                                </tr>
                            ) : table.getRowModel().rows?.length ? (
                                table.getRowModel().rows.map((row) => (
                                    <tr
                                        key={row.id}
                                        data-state={row.getIsSelected() && "selected"}
                                        className={`hover:bg-white/5 transition-colors ${row.getIsSelected() ? 'bg-indigo-500/10' : ''}`}
                                    >
                                        {row.getVisibleCells().map((cell) => (
                                            <td key={cell.id} className="px-4 py-3 text-slate-300">
                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                            </td>
                                        ))}
                                    </tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={table.getVisibleLeafColumns().length || 1} className="h-24 text-center text-slate-500">
                                        <EmptyState title={emptyMessage} embedded />
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Pagination Controls */}
            <div className="flex flex-col gap-3 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs">
                    {Object.keys(rowSelection).length} dari{" "}
                    {table.getFilteredRowModel().rows.length} baris dipilih.
                </div>
                
                <div className="flex flex-wrap items-center gap-4 sm:gap-6 lg:gap-8">
                    <div className="flex items-center space-x-2">
                        <label htmlFor={pageSizeId} className="text-xs font-medium">Baris per halaman</label>
                        <select
                            id={pageSizeId}
                            value={table.getState().pagination.pageSize}
                            onChange={(e) => {
                                table.setPageSize(Number(e.target.value));
                            }}
                            className="bg-white/5 border border-white/5 rounded-md py-1 px-2 focus:ring-1 focus:ring-indigo-500 outline-none text-xs"
                        >
                            {[10, 20, 30, 40, 50].map((pageSize) => (
                                <option key={pageSize} value={pageSize} className="bg-[#1a1c23]">
                                    {pageSize}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex w-[100px] items-center justify-center text-xs font-medium">
                        Halaman {table.getState().pagination.pageIndex + 1} dari{" "}
                        {table.getPageCount()}
                    </div>
                    <div className="flex items-center space-x-2">
                        <button
                            type="button"
                            onClick={() => table.setPageIndex(0)}
                            disabled={!table.getCanPreviousPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors"
                        >
                            <span className="sr-only">Ke halaman pertama</span>
                            <ChevronsLeft className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors"
                        >
                            <span className="sr-only">Ke halaman sebelumnya</span>
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors"
                        >
                            <span className="sr-only">Ke halaman berikutnya</span>
                            <ChevronRight className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                            disabled={!table.getCanNextPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors"
                        >
                            <span className="sr-only">Ke halaman terakhir</span>
                            <ChevronsRight className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
