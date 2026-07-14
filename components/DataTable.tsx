"use client";

import React, { useId, useState } from "react";
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
    VisibilityState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Search, SlidersHorizontal, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { fuzzyMatch } from "@/lib/fuzzySearch";

interface DataTableProps<TData, TValue> {
    columns: ColumnDef<TData, TValue>[];
    data: TData[];
    searchPlaceholder?: string;
    isLoading?: boolean;
    initialColumnVisibility?: VisibilityState;
    emptyMessage?: string;
}

export function DataTable<TData, TValue>({
    columns,
    data,
    searchPlaceholder = "Cari semua kolom...",
    isLoading = false,
    initialColumnVisibility = {},
    emptyMessage = "Tidak ada hasil."
}: DataTableProps<TData, TValue>) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [globalFilter, setGlobalFilter] = useState("");

    const [isViewOpen, setIsViewOpen] = useState(false);
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
        initialState: { columnVisibility: initialColumnVisibility },
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        onSortingChange: setSorting,
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        onGlobalFilterChange: setGlobalFilter,
        globalFilterFn: fuzzyOrWildcardFilter,
        state: { sorting, globalFilter },
    });
    const filteredRowCount = table.getFilteredRowModel().rows.length;

    return (
        <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex w-full items-center gap-2 bg-white/5 border border-white/5 rounded-lg px-3 py-2 shadow-sm focus-within:ring-2 focus-within:ring-indigo-500/50 focus-within:border-indigo-500 focus-within:outline focus-within:outline-2 focus-within:outline-indigo-500 focus-within:outline-offset-2 transition-all sm:w-72">
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
                
                <div className="flex items-center gap-2 relative">
                    <button
                        type="button"
                        onClick={() => setIsViewOpen(!isViewOpen)}
                        aria-expanded={isViewOpen}
                        aria-controls={columnMenuId}
                        aria-label="Atur visibilitas kolom"
                        className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/5 rounded-lg px-3 py-2 text-sm text-slate-300 transition-colors shadow-sm focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                    >
                        <SlidersHorizontal className="h-4 w-4" />
                        Kolom
                    </button>

                    {isViewOpen && (
                        <div id={columnMenuId} className="absolute right-0 top-full mt-2 w-48 bg-[#1a1c23] border border-white/5 rounded-lg shadow-xl shadow-black/50 z-50 p-2 py-3 backdrop-blur-xl">
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

            {/* Table */}
            <div className="rounded-xl border border-white/5 bg-[#1a1c23]/80 overflow-hidden backdrop-blur-md shadow-xl">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left relative">
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
                                    <td colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center">
                                        <div className="flex items-center justify-center gap-2 text-slate-400">
                                            <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                                            Memuat data...
                                        </div>
                                    </td>
                                </tr>
                            ) : table.getRowModel().rows?.length ? (
                                table.getRowModel().rows.map((row) => (
                                    <tr
                                        key={row.id}
                                        className="hover:bg-white/5 transition-colors"
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
                                    <td colSpan={table.getVisibleLeafColumns().length} className="h-24 text-center text-slate-500">
                                        {emptyMessage}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Pagination Controls */}
            {filteredRowCount > 0 && <div className="flex flex-col gap-3 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-end">
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
                            aria-label="Ke halaman pertama"
                            onClick={() => table.setPageIndex(0)}
                            disabled={!table.getCanPreviousPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                        >
                            <ChevronsLeft className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            aria-label="Ke halaman sebelumnya"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            aria-label="Ke halaman berikutnya"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            aria-label="Ke halaman terakhir"
                            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                            disabled={!table.getCanNextPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                        >
                            <ChevronsRight className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>}
        </div>
    );
}
