/*
 * Tujuan: Pencarian cepat batch OFF Program Control (Fiori S4d) — cari nomor pengajuan, principal, tahap, atau SPV; memilih hasil
 *   membuka batch di kolom kedua (perubahan #2 it03).
 * Caller: app/(dashboard)/off-program-control/OpcApp.tsx.
 * Dependensi: React hooks, lucide-react, lib/fuzzySearch; kelas fi-* (fi-input, fi-sect, fi-menu-item).
 * Main Functions: OffGlobalSearch, pintasan Ctrl/Cmd+K (shell mengalah karena preventDefault), navigasi listbox dengan keyboard;
 *   daftar sumber gagal dimuat tampil sebagai galat, bukan "tidak ditemukan".
 * Side Effects: Listener keydown dokumen; callback onSelect.
 */
"use client";

import { useState, useRef, useEffect, useId, useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { fuzzyMatch } from "@/lib/fuzzySearch";
import type { MuatDaftar } from "./OffNotificationBell";

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
    /** Keadaan daftar sumber: galat tampil sebagai galat, bukan "tidak ditemukan". */
    muat?: MuatDaftar;
}

export default function OffGlobalSearch({ items, onSelect, placeholder = "Cari pengajuan…", muat }: OffGlobalSearchProps) {
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

    const resolvedActiveIndex = filtered.length === 0 ? -1 : Math.min(activeIndex, filtered.length - 1);

    // Ctrl/Cmd+K membuka quick jump tanpa mengambil alih pencarian native browser (Ctrl F).
    // Listener di document berjalan sebelum listener shell di window; preventDefault membuat shell mengalah.
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !e.shiftKey) {
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
        <div style={{ position: "relative", minWidth: 0 }}>
            <input
                ref={inputRef}
                type="search"
                className="fi-input"
                style={{ width: "100%" }}
                aria-label="Cari pengajuan OFF"
                aria-expanded={hasResultsPopup}
                aria-controls={hasResultsPopup ? resultsId : undefined}
                aria-activedescendant={hasResultsPopup && resolvedActiveIndex >= 0 ? `${resultsId}-option-${resolvedActiveIndex}` : undefined}
                aria-autocomplete="list"
                aria-keyshortcuts="Control+K Meta+K"
                role="combobox"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIndex(0); }}
                onFocus={() => { setOpen(true); setActiveIndex(0); }}
                onKeyDown={handleInputKeyDown}
                placeholder={placeholder}
            />
            {hasResultsPopup && (
                <>
                    <div style={{ position: "fixed", inset: 0, zIndex: 30 }} onClick={() => setOpen(false)} aria-hidden="true" />
                    <div id={resultsId} role="listbox" aria-label="Hasil pencarian pengajuan OFF" className="fi-sect"
                        style={{ position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)", zIndex: 40, maxHeight: "18rem", overflowY: "auto", padding: 6 }}>
                        {muat?.status === "galat" && !muat.adaData ? (
                            <p className="fi-small" role="alert" style={{ padding: "12px 10px" }}>Daftar pengajuan gagal dimuat, jadi pencarian belum bisa dipakai. {muat.error}</p>
                        ) : muat?.status === "memuat" && !muat.adaData ? (
                            <p className="fi-small fi-subtle" role="status" style={{ padding: "12px 10px" }}>Memuat daftar pengajuan…</p>
                        ) : filtered.length === 0 ? (
                            <p className="fi-small fi-subtle" style={{ padding: "12px 10px" }}>Tidak ditemukan batch yang cocok.</p>
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
                                    className="fi-menu-item"
                                >
                                    <ArrowRight className="fi-icon" aria-hidden />
                                    <b className="fi-mono">{item.noPengajuan}</b>
                                    <small>{item.principleName} · {item.status}</small>
                                </button>
                            ))
                        )}
                        {muat?.status === "galat" && muat.adaData && (
                            <p className="fi-small fi-subtle" role="alert" style={{ padding: "8px 10px" }}>Daftar terakhir gagal diperbarui; hasil dari data sebelumnya.</p>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
