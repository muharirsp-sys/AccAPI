/*
 * Tujuan: Tabel data TanStack reusable (urut, cari fuzzy, pilih kolom, paginasi) bergaya Fiori dengan tiga keadaan yang selalu berbeda:
 *   memuat, kosong (belum ada data ≠ tidak cocok pencarian), dan galat (sebab + Coba lagi).
 * Caller: Route dashboard yang membutuhkan tabel TanStack generik (belum ada pemakai per audit desain 001; lihat juga ResponsiveTable).
 * Dependensi: TanStack React Table, fuzzySearch internal, components/fiori (Button, EmptyState, ErrorState, Skeleton, token), lucide-react.
 * Main Functions: `DataTable`.
 * Side Effects: Mutasi state UI lokal dan listener sementara untuk Escape/klik-luar pada pemilih kolom.
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
    VisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, SlidersHorizontal, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { fuzzyMatch } from "@/lib/fuzzySearch";
import { fioriClass } from "@/components/fiori/Scope";
import { Button, EmptyState, ErrorState, Skeleton } from "@/components/fiori/core";

interface DataTableProps<TData, TValue> {
    columns: ColumnDef<TData, TValue>[];
    data: TData[];
    searchPlaceholder?: string;
    isLoading?: boolean;
    initialColumnVisibility?: VisibilityState;
    caption?: string;
    /** Judul keadaan kosong saat belum ada data sama sekali (tanpa pencarian). */
    emptyMessage?: string;
    /** Sebab gagal memuat; diisi = keadaan galat, bukan "kosong". */
    error?: string;
    onRetry?: () => void;
}

export function DataTable<TData, TValue>({
    columns,
    data,
    searchPlaceholder = "Cari di semua kolom",
    isLoading = false,
    initialColumnVisibility = {},
    caption = "Tabel data",
    emptyMessage = "Belum ada data",
    error,
    onRetry,
}: DataTableProps<TData, TValue>) {
    const [sorting, setSorting] = useState<SortingState>([]);
    const [globalFilter, setGlobalFilter] = useState("");

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
    const colSpan = table.getVisibleLeafColumns().length || 1;

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

    // Galat tidak pernah tampil sebagai kosong; kosong karena pencarian dibedakan dari belum ada data.
    let keadaan: React.ReactNode = null;
    if (isLoading) keadaan = <Skeleton rows={3} label="Memuat data tabel" />;
    else if (error) keadaan = <ErrorState message={error} onRetry={onRetry} />;
    else if (!table.getRowModel().rows.length) keadaan = globalFilter
        ? <EmptyState title="Tidak ada baris yang cocok" message="Ubah atau hapus kata pencarian." />
        : <EmptyState title={emptyMessage} />;

    return (
        <div className={`${fioriClass} grid gap-3`} style={{ background: "transparent" }}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative w-full sm:w-72">
                    <Search className="fi-icon pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" aria-hidden />
                    <label htmlFor={searchInputId} className="sr-only">Cari tabel</label>
                    <input
                        id={searchInputId}
                        type="search"
                        placeholder={searchPlaceholder}
                        value={globalFilter ?? ""}
                        onChange={(event) => setGlobalFilter(event.target.value)}
                        className="fi-input"
                        style={{ paddingLeft: 32 }}
                    />
                </div>

                <div ref={columnPickerRef} className="relative">
                    <button
                        ref={columnPickerButtonRef}
                        type="button"
                        onClick={() => setIsViewOpen(!isViewOpen)}
                        aria-expanded={isViewOpen}
                        aria-controls={columnMenuId}
                        aria-haspopup="true"
                        className="fi-btn fi-btn--secondary"
                    >
                        <SlidersHorizontal className="fi-icon" aria-hidden />
                        Atur kolom
                    </button>

                    {isViewOpen && (
                        <div id={columnMenuId} role="group" aria-labelledby={`${columnMenuId}-t`} className="fi-panel absolute right-0 top-full z-[var(--z-popover)] mt-2 w-56" style={{ boxShadow: "var(--shadow-2)", gap: 4 }}>
                            <p id={`${columnMenuId}-t`} className="fi-caption">Tampilkan kolom</p>
                            <div className="grid max-h-64 overflow-y-auto">
                                {table.getAllLeafColumns().map(column => {
                                    if (column.id === "select") return null;
                                    return (
                                        <label key={column.id} className="fi-check">
                                            <input type="checkbox" checked={column.getIsVisible()} onChange={column.getToggleVisibilityHandler()} />
                                            <span className="truncate">{typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <p role="status" aria-live="polite" className="sr-only">
                {isLoading ? "Memuat data tabel." : error ? "Data tabel gagal dimuat." : `${filteredRowCount} baris tersedia.`}
            </p>

            <div className="fi-tablebox" style={{ borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-1)", overflow: "clip" }}>
                <div className="fi-tablescroll" tabIndex={0}>
                    <table aria-busy={isLoading} className="fi-table">
                        <caption className="sr-only">{caption}</caption>
                        <thead>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <tr key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => {
                                        const sorted = header.column.getIsSorted();
                                        const canSort = header.column.getCanSort();
                                        const ariaSort = sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : canSort ? "none" : undefined;
                                        const SortIcon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
                                        return (
                                            <th key={header.id} scope="col" aria-sort={ariaSort}>
                                                {header.isPlaceholder ? null : canSort ? (
                                                    <button type="button" onClick={header.column.getToggleSortingHandler()}>
                                                        {flexRender(header.column.columnDef.header, header.getContext())}
                                                        <SortIcon className="fi-icon" aria-hidden />
                                                    </button>
                                                ) : flexRender(header.column.columnDef.header, header.getContext())}
                                            </th>
                                        );
                                    })}
                                </tr>
                            ))}
                        </thead>
                        <tbody>
                            {keadaan ? (
                                <tr>
                                    <td colSpan={colSpan}>{keadaan}</td>
                                </tr>
                            ) : (
                                table.getRowModel().rows.map((row) => (
                                    <tr key={row.id}>
                                        {row.getVisibleCells().map((cell) => (
                                            <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                                        ))}
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {filteredRowCount > 0 && !error && (
                <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-3 fi-small text-ink-muted">
                    <div className="flex items-center gap-2">
                        <label htmlFor={pageSizeId} className="fi-label">Baris per halaman</label>
                        <select
                            id={pageSizeId}
                            value={table.getState().pagination.pageSize}
                            onChange={(e) => {
                                table.setPageSize(Number(e.target.value));
                            }}
                            className="fi-input"
                            style={{ width: "5rem" }}
                        >
                            {[10, 20, 30, 40, 50].map((pageSize) => (
                                <option key={pageSize} value={pageSize}>
                                    {pageSize}
                                </option>
                            ))}
                        </select>
                    </div>
                    <span className="fi-tnum">Halaman {table.getState().pagination.pageIndex + 1} dari {table.getPageCount()}</span>
                    <div className="flex items-center gap-1">
                        <Button variant="icon" aria-label="Ke halaman pertama" onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()}>
                            <ChevronsLeft className="fi-icon" aria-hidden />
                        </Button>
                        <Button variant="icon" aria-label="Ke halaman sebelumnya" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
                            <ChevronLeft className="fi-icon" aria-hidden />
                        </Button>
                        <Button variant="icon" aria-label="Ke halaman berikutnya" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
                            <ChevronRight className="fi-icon" aria-hidden />
                        </Button>
                        <Button variant="icon" aria-label="Ke halaman terakhir" onClick={() => table.setPageIndex(table.getPageCount() - 1)} disabled={!table.getCanNextPage()}>
                            <ChevronsRight className="fi-icon" aria-hidden />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
