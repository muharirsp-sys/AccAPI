"use client";

import React, { useState } from "react";
import {
    ColumnDef,
    flexRender,
    getCoreRowModel,
    getPaginationRowModel,
    getFilteredRowModel,
    getSortedRowModel,
    useReactTable,
    SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Search, SlidersHorizontal, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

interface DataTableProps<TData, TValue> {
    columns: ColumnDef<TData, TValue>[];
    data: TData[];
    searchKey?: string; 
    searchPlaceholder?: string;
    isLoading?: boolean;
}

export function DataTable<TData, TValue>({
    columns,
    data,
    searchKey,
    searchPlaceholder = "Search all columns...",
    isLoading = false
}: DataTableProps<TData, TValue>) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [globalFilter, setGlobalFilter] = useState("");
    const [rowSelection, setRowSelection] = useState({});

    const [isViewOpen, setIsViewOpen] = useState(false);

    const fuzzyOrWildcardFilter = (row: any, columnId: string, filterValue: string) => {
        const value = row.getValue(columnId);
        if (value == null) return false;
        
        const stringValue = String(value).toLowerCase();
        const searchValue = String(filterValue).toLowerCase();

        // If search contains % wildcard
        if (searchValue.includes('%')) {
            const escaped = searchValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regexStr = escaped.replace(/%/g, '.*');
            try {
                const regex = new RegExp(regexStr, 'i');
                return regex.test(stringValue);
            } catch(e) {
                return false;
            }
        }

        return stringValue.includes(searchValue);
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

    return (
        <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2 w-72 focus-within:ring-2 focus-within:ring-indigo-500/50 focus-within:border-indigo-500 transition-all">
                    <Search className="h-4 w-4 text-slate-400" />
                    <input
                        placeholder={searchPlaceholder}
                        value={globalFilter ?? ""}
                        onChange={(event) => setGlobalFilter(event.target.value)}
                        className="bg-transparent border-none outline-none text-sm text-slate-200 w-full placeholder:text-slate-500"
                    />
                </div>
                
                <div className="flex items-center gap-2 relative">
                    <button 
                        onClick={() => setIsViewOpen(!isViewOpen)}
                        className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-300 transition-colors"
                    >
                        <SlidersHorizontal className="h-4 w-4" />
                        Kolom
                    </button>

                    {isViewOpen && (
                        <div className="absolute right-0 top-full mt-2 w-48 bg-[#1a1c23] border border-white/10 rounded-lg shadow-xl shadow-black/50 z-50 p-2 py-3 backdrop-blur-xl">
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
            <div className="rounded-xl border border-white/10 bg-[#16181d]/80 overflow-hidden backdrop-blur-md shadow-xl">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left relative">
                        <thead className="text-xs text-slate-400 uppercase bg-black/20 border-b border-white/10">
                            {table.getHeaderGroups().map((headerGroup) => (
                                <tr key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => {
                                        return (
                                            <th key={header.id} className="px-4 py-3 font-medium whitespace-nowrap">
                                                {header.isPlaceholder ? null : (
                                                    <div
                                                        className={
                                                            header.column.getCanSort()
                                                                ? "cursor-pointer select-none flex items-center gap-1 group"
                                                                : "flex items-center gap-1"
                                                        }
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
                                                            }[header.column.getIsSorted() as string] ?? null}
                                                        </span>
                                                    </div>
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
                                    <td colSpan={columns.length} className="h-24 text-center">
                                        <div className="flex items-center justify-center gap-2 text-slate-400">
                                            <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                                            Loading data...
                                        </div>
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
                                    <td colSpan={columns.length} className="h-24 text-center text-slate-500">
                                        No results found.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Pagination Controls */}
            <div className="flex items-center justify-between text-sm text-slate-400">
                <div className="flex-1 text-xs">
                    {Object.keys(rowSelection).length} of{" "}
                    {table.getFilteredRowModel().rows.length} row(s) selected.
                </div>
                
                <div className="flex items-center space-x-6 lg:space-x-8">
                    <div className="flex items-center space-x-2">
                        <p className="text-xs font-medium">Rows per page</p>
                        <select
                            value={table.getState().pagination.pageSize}
                            onChange={(e) => {
                                table.setPageSize(Number(e.target.value));
                            }}
                            className="bg-white/5 border border-white/10 rounded-md py-1 px-2 focus:ring-1 focus:ring-indigo-500 outline-none text-xs"
                        >
                            {[10, 20, 30, 40, 50].map((pageSize) => (
                                <option key={pageSize} value={pageSize} className="bg-[#1a1c23]">
                                    {pageSize}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex w-[100px] items-center justify-center text-xs font-medium">
                        Page {table.getState().pagination.pageIndex + 1} of{" "}
                        {table.getPageCount()}
                    </div>
                    <div className="flex items-center space-x-2">
                        <button
                            onClick={() => table.setPageIndex(0)}
                            disabled={!table.getCanPreviousPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors border border-white/5"
                        >
                            <span className="sr-only">Go to first page</span>
                            <ChevronsLeft className="h-4 w-4" />
                        </button>
                        <button
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors border border-white/5"
                        >
                            <span className="sr-only">Go to previous page</span>
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <button
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors border border-white/5"
                        >
                            <span className="sr-only">Go to next page</span>
                            <ChevronRight className="h-4 w-4" />
                        </button>
                        <button
                            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                            disabled={!table.getCanNextPage()}
                            className="p-1 rounded bg-white/5 hover:bg-white/10 disabled:opacity-50 transition-colors border border-white/5"
                        >
                            <span className="sr-only">Go to last page</span>
                            <ChevronsRight className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
