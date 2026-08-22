// Tujuan: Filter kolom Principle gaya Excel (multi-select, instan) untuk Engine Filter Kolom Data.
// Caller: app/(dashboard)/payments/page.tsx (baris filter kolom Principle).
// Dependensi: React client hooks, react-dom createPortal, lucide-react.
// Main Functions: PrincipleFilterDropdown.
// Side Effects: render panel ke document.body via portal; listener keydown (Esc) saat panel terbuka.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Filter, Search, Check, X } from "lucide-react";

export interface PrincipleOption {
  value: string;
  count: number;
}

interface PrincipleFilterDropdownProps {
  options: PrincipleOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}

export default function PrincipleFilterDropdown({
  options,
  selected,
  onChange,
}: PrincipleFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [query, setQuery] = useState("");
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.value.toLowerCase().includes(q));
  }, [options, query]);

  // Reset transisi & query di handler (bukan di effect) agar tidak memicu
  // setState sinkron di dalam effect.
  const closePanel = () => {
    setOpen(false);
    setShown(false);
    setQuery("");
  };
  const toggleOpen = () => {
    if (open) {
      closePanel();
      return;
    }
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setCoords({ top: r.bottom + 6, left: r.left });
    }
    setOpen(true);
  };

  // Fade-in: set `shown` satu tick setelah panel mount; auto-focus search.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => setShown(true));
    const t = setTimeout(() => searchRef.current?.focus(), 60);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [open]);

  // Esc menutup panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const toggleValue = (val: string) => {
    const next = new Set(selectedSet);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    onChange([...next]);
  };
  const selectAllVisible = () => {
    const next = new Set(selectedSet);
    visible.forEach((o) => next.add(o.value));
    onChange([...next]);
  };
  const clearVisible = () => {
    const next = new Set(selectedSet);
    visible.forEach((o) => next.delete(o.value));
    onChange([...next]);
  };
  const reset = () => onChange([]);

  const count = selected.length;

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={toggleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Filter principle"
        className={`flex w-[150px] items-center gap-1.5 rounded border bg-black/60 px-2 py-1.5 text-[10px] font-medium outline-none transition-colors hover:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/50 ${
          count > 0 ? "border-emerald-500/50 text-emerald-300" : "border-white/10 text-slate-400"
        }`}
      >
        <Filter size={12} className={count > 0 ? "text-emerald-400" : "text-slate-500"} />
        <span className="office-calm-contrast-text">Filter</span>
        {count > 0 && (
          <span className="ml-auto rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] text-emerald-300">
            {count}
          </span>
        )}
      </button>

      {open && coords &&
        createPortal(
          <>
            <div
              className={`fixed inset-0 z-[2147483646] bg-black/55 backdrop-blur-[2px] transition-opacity duration-150 ease-out motion-reduce:transition-none ${
                shown ? "opacity-100" : "opacity-0"
              }`}
              onClick={closePanel}
              aria-hidden="true"
            />
            <div
              role="dialog"
              aria-label="Filter Principle"
              className={`fixed z-[2147483647] w-[280px] overflow-hidden rounded-xl border border-white/10 bg-[#1a1c23] shadow-2xl transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${
                shown ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1.5"
              }`}
              style={{ top: coords.top, left: coords.left }}
            >
              <div className="p-2.5">
                <div className="relative">
                  <Search
                    size={13}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
                  />
                  <input
                    ref={searchRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Cari principle..."
                    className="w-full rounded-md border border-white/10 bg-black/60 py-1.5 pl-8 pr-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-500/50"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3.5 px-3 pb-2 text-[11px]">
                <button
                  type="button"
                  onClick={selectAllVisible}
                  className="text-blue-400 hover:underline"
                >
                  Pilih semua
                </button>
                <button
                  type="button"
                  onClick={clearVisible}
                  className="text-slate-400 hover:underline"
                >
                  Hapus semua
                </button>
                <span className="ml-auto text-slate-600">{visible.length} nilai</span>
              </div>

              <div className="max-h-[210px] overflow-y-auto border-t border-white/5">
                {visible.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs text-slate-500">
                    Principle tidak ditemukan
                  </div>
                ) : (
                  visible.map((o) => {
                    const on = selectedSet.has(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => toggleValue(o.value)}
                        className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
                          on ? "bg-emerald-500/[0.07]" : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 flex-none items-center justify-center rounded ${
                            on ? "bg-emerald-500" : "border border-white/20"
                          }`}
                        >
                          {on && <Check size={11} className="text-[#06281d]" />}
                        </span>
                        <span
                          className={`flex-1 truncate text-xs ${
                            on ? "text-slate-100" : "text-slate-400"
                          }`}
                        >
                          {o.value}
                        </span>
                        <span className="text-[10px] text-slate-600">{o.count}</span>
                      </button>
                    );
                  })
                )}
              </div>

              <div className="flex items-center gap-2 border-t border-white/5 px-3 py-2">
                <span className="text-[10px] text-slate-600">Perubahan langsung diterapkan</span>
                <button
                  type="button"
                  onClick={reset}
                  className="ml-auto flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-white/5"
                >
                  <X size={11} /> Reset
                </button>
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
