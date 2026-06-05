// Tujuan: Quick-jump search di halaman OFF Program Control — cari batch berdasarkan nomor pengajuan, principle, atau status.
// Caller: app/(dashboard)/off-program-control/page.tsx.
// Dependensi: React hooks, lucide-react.
// Main Functions: OffGlobalSearch.
// Side Effects: Tidak ada — callback onSelect untuk navigasi/filter.
"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Search, X, ArrowRight } from "lucide-react";

export interface OffSearchableItem {
    id: string;
    noPengajuan: string;
    principleName: string;
    status: string;
    supervisorName?: string;
}

interface OffGlobalSearchProps {
    items: OffSearchableItem[];
    onSelect: (id: string) => void;
    placeholder?: string;
}

export default function OffGlobalSearch({ items, onSelect, placeholder = "Cari batch..." }: OffGlobalSearchProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    const filtered = useMemo(() => {
        if (!query.trim()) return items.slice(0, 8);
        const q = query.toLowerCase();
        return items.filter(
            (item) =>
                item.noPengajuan.toLowerCase().includes(q) ||
                item.principleName.toLowerCase().includes(q) ||
                item.status.toLowerCase().includes(q) ||
                (item.supervisorName || "").toLowerCase().includes(q)
        ).slice(0, 10);
    }, [items, query]);

    // Keyboard shortcut: Ctrl+F focuses search when on OFF page
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "f" && !e.shiftKey) {
                // Only intercept if this component is visible
                if (inputRef.current) {
                    e.preventDefault();
                    setOpen(true);
                    inputRef.current.focus();
                }
            }
            if (e.key === "Escape") {
                setOpen(false);
                setQuery("");
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, []);

    const handleSelect = (id: string) => {
        onSelect(id);
        setOpen(false);
        setQuery("");
    };

    return (
        <div className="relative">
            {/* Search trigger / input */}
            <div className="flex items-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 transition-all focus-within:border-[var(--luxury-gold)]/50 focus-within:ring-2 focus-within:ring-[var(--luxury-gold)]/20">
                <Search size={15} className="text-[var(--luxury-subtle)] shrink-0" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
                    onFocus={() => setOpen(true)}
                    placeholder={placeholder}
                    className="flex-1 bg-transparent text-sm text-[var(--luxury-text)] placeholder:text-[var(--luxury-subtle)] outline-none min-w-0"
                />
                {query && (
                    <button
                        type="button"
                        onClick={() => { setQuery(""); inputRef.current?.focus(); }}
                        className="shrink-0 rounded p-0.5 text-[var(--luxury-subtle)] hover:text-[var(--luxury-text)]"
                    >
                        <X size={14} />
                    </button>
                )}
                <kbd className="hidden sm:inline rounded border border-[var(--border-soft)] bg-black/5 px-1.5 py-0.5 text-[9px] font-mono text-[var(--luxury-subtle)]">
                    Ctrl+F
                </kbd>
            </div>

            {/* Dropdown results */}
            {open && query.trim() && (
                <>
                    <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
                    <div className="absolute left-0 right-0 z-40 mt-2 max-h-72 overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] shadow-2xl backdrop-blur-xl">
                        {filtered.length === 0 ? (
                            <div className="py-6 text-center text-sm text-[var(--luxury-subtle)]">
                                Tidak ditemukan batch yang cocok
                            </div>
                        ) : (
                            filtered.map((item) => (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => handleSelect(item.id)}
                                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--luxury-gold-2)]/10 border-b border-[var(--border-soft)] last:border-b-0"
                                >
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-[var(--luxury-text)] truncate">
                                            {item.noPengajuan}
                                        </p>
                                        <p className="text-xs text-[var(--luxury-muted)] truncate">
                                            {item.principleName} • {item.status}
                                        </p>
                                    </div>
                                    <ArrowRight size={12} className="shrink-0 text-[var(--luxury-gold)] opacity-50" />
                                </button>
                            ))
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
