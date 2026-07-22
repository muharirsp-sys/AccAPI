// Tujuan: Quick-jump search di halaman OFF Program Control — cari batch berdasarkan nomor pengajuan, principle, atau status.
// Caller: app/(dashboard)/off-program-control/page.tsx.
// Dependensi: React hooks, lucide-react, fuzzySearch.
// Main Functions: OffGlobalSearch, shortcut Ctrl/Cmd+K, navigasi listbox dengan keyboard.
// Side Effects: Listener keydown dokumen; callback onSelect untuk navigasi/filter.
"use client";

import { useState, useRef, useEffect, useId, useMemo } from "react";
import { Search, X, ArrowRight } from "lucide-react";
import { fuzzyMatch } from "@/lib/fuzzySearch";

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

export default function OffGlobalSearch({ items, onSelect, placeholder = "Cari pengajuan..." }: OffGlobalSearchProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const resultsId = useId();
    const hasResultsPopup = open && Boolean(query.trim());

    const filtered = useMemo(() => {
        if (!query.trim()) return items.slice(0, 8);
        return items.filter(
            (item) =>
                fuzzyMatch(item.noPengajuan, query) ||
                fuzzyMatch(item.principleName, query) ||
                fuzzyMatch(item.status, query) ||
                fuzzyMatch(item.supervisorName, query)
        ).slice(0, 10);
    }, [items, query]);

    const resolvedActiveIndex = filtered.length === 0
        ? -1
        : Math.min(activeIndex, filtered.length - 1);

    // Ctrl/Cmd+K membuka quick jump tanpa mengambil alih pencarian native browser.
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !e.shiftKey) {
                // Only intercept if this component is visible
                if (inputRef.current) {
                    e.preventDefault();
                    setOpen(true);
                    setActiveIndex(0);
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

    const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (!hasResultsPopup || filtered.length === 0) return;
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((current) => (current + 1) % filtered.length);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => (current - 1 + filtered.length) % filtered.length);
        } else if (event.key === "Home") {
            event.preventDefault();
            setActiveIndex(0);
        } else if (event.key === "End") {
            event.preventDefault();
            setActiveIndex(filtered.length - 1);
        } else if (event.key === "Enter" && resolvedActiveIndex >= 0) {
            event.preventDefault();
            handleSelect(filtered[resolvedActiveIndex].id);
        }
    };

    return (
        <div className="relative">
            {/* Search trigger / input */}
            <div className="flex items-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 transition-all focus-within:border-[var(--luxury-gold)]/50 focus-within:ring-2 focus-within:ring-[var(--luxury-gold)]/20">
                <Search size={15} className="text-[var(--luxury-subtle)] shrink-0" />
                <input
                    ref={inputRef}
                    type="text"
                    aria-label="Cari pengajuan OFF"
                    aria-expanded={hasResultsPopup}
                    aria-controls={hasResultsPopup ? resultsId : undefined}
                    aria-activedescendant={resolvedActiveIndex >= 0 ? `${resultsId}-option-${resolvedActiveIndex}` : undefined}
                    aria-autocomplete="list"
                    aria-keyshortcuts="Control+K Meta+K"
                    role="combobox"
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIndex(0); }}
                    onFocus={() => { setOpen(true); setActiveIndex(0); }}
                    onKeyDown={handleInputKeyDown}
                    placeholder={placeholder}
                    className="flex-1 bg-transparent text-sm text-[var(--luxury-text)] placeholder:text-[var(--luxury-subtle)] outline-none min-w-0"
                />
                {query && (
                    <button
                        type="button"
                        onClick={() => { setQuery(""); inputRef.current?.focus(); }}
                        aria-label="Kosongkan pencarian"
                        className="shrink-0 rounded p-0.5 text-[var(--luxury-subtle)] hover:text-[var(--luxury-text)]"
                    >
                        <X size={14} />
                    </button>
                )}
            </div>

            {/* Dropdown results */}
            {hasResultsPopup && (
                <>
                    <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
                    <div
                        id={resultsId}
                        role="listbox"
                        aria-label="Hasil pencarian pengajuan OFF"
                        className="absolute left-0 right-0 z-40 mt-2 max-h-72 overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] shadow-2xl backdrop-blur-xl"
                    >
                        {filtered.length === 0 ? (
                            <div className="py-6 text-center text-sm text-[var(--luxury-subtle)]">
                                Tidak ditemukan batch yang cocok
                            </div>
                        ) : (
                            filtered.map((item, index) => (
                                <button
                                    key={item.id}
                                    id={`${resultsId}-option-${index}`}
                                    type="button"
                                    tabIndex={-1}
                                    role="option"
                                    aria-selected={index === resolvedActiveIndex}
                                    onClick={() => handleSelect(item.id)}
                                    onMouseEnter={() => setActiveIndex(index)}
                                    className={`flex w-full items-center gap-3 border-b border-[var(--border-soft)] px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[var(--luxury-gold-2)]/10 ${index === resolvedActiveIndex ? "bg-[var(--luxury-gold-2)]/10" : ""}`}
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
