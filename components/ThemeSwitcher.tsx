// Tujuan: Switch tema calming (revisi G) yang disimpan di localStorage, bukan database.
// Caller: components/SidebarLayout.tsx (navbar atas).
// Dependensi: React client hooks, lucide-react.
// Main Functions: ThemeSwitcher, OFF_THEMES, applyStoredThemeScript.
// Side Effects: Set atribut data-theme pada <html> dan tulis localStorage.
"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Palette, Check } from "lucide-react";

export const OFF_THEME_STORAGE_KEY = "off-theme";

export type OffThemeKey = "office-calm" | "neon" | "ios";

export const OFF_THEMES: Array<{ key: OffThemeKey; label: string; hint: string; swatch: string }> = [
  { key: "office-calm", label: "Office Calm", hint: "Cream hangat dan emas (default)", swatch: "#c89432" },
  { key: "neon", label: "Neon HUD", hint: "Sci-fi control tower", swatch: "#03060d" },
  { key: "ios", label: "iOS Liquid Glass", hint: "Frosted glass terang ala iOS terbaru", swatch: "#007AFF" },
];

const DEFAULT_THEME: OffThemeKey = "office-calm";

function isOffThemeKey(value: string | null): value is OffThemeKey {
  return value === "office-calm" || value === "neon" || value === "ios";
}

// Script inline untuk apply tema sebelum paint agar tidak ada flash.
export const applyStoredThemeScript = `(function(){try{var t=localStorage.getItem('${OFF_THEME_STORAGE_KEY}');if(t!=='office-calm'&&t!=='neon'&&t!=='ios'){t='${DEFAULT_THEME}';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','${DEFAULT_THEME}');}})();`;

export default function ThemeSwitcher() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const menuId = "theme-switcher-menu";
  const toggleOpen = () => {
    setOpen((v) => {
      const next = !v;
      if (next && btnRef.current) {
        const r = btnRef.current.getBoundingClientRect();
        setCoords({ top: r.bottom + 8, right: window.innerWidth - r.right });
      }
      return next;
    });
  };
  const [theme, setTheme] = useState<OffThemeKey>(() => {
    if (typeof window === "undefined") return DEFAULT_THEME;
    try {
      const stored = window.localStorage.getItem(OFF_THEME_STORAGE_KEY);
      return isOffThemeKey(stored) ? stored : DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = OFF_THEMES.findIndex((option) => option.key === theme);
    window.setTimeout(() => optionRefs.current[Math.max(selectedIndex, 0)]?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, theme]);

  const closeMenu = () => {
    setOpen(false);
    window.setTimeout(() => btnRef.current?.focus(), 0);
  };

  const selectTheme = (next: OffThemeKey) => {
    setTheme(next);
    try {
      localStorage.setItem(OFF_THEME_STORAGE_KEY, next);
    } catch {
      // localStorage tidak tersedia; tema tetap berlaku untuk sesi ini.
    }
    closeMenu();
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={toggleOpen}
        className="flex items-center gap-2 rounded-lg bg-black/30 px-2.5 py-1.5 text-xs font-medium text-slate-300 shadow-sm transition-colors hover:bg-white/10"
        title="Ganti tema"
        aria-label="Ganti tema"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <Palette size={16} />
        <span className="hidden sm:inline">Tema</span>
      </button>

      {open && coords &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[2147483646]" onClick={closeMenu} aria-hidden="true" />
            <div
              id={menuId}
              className="fixed z-[2147483647] w-60 overflow-hidden rounded-xl border border-white/5 bg-[#1a1c23] shadow-2xl"
              style={{ top: coords.top, right: coords.right }}
              role="group"
              aria-label="Tema tampilan"
            >
            <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Tema Tampilan
            </div>
            {OFF_THEMES.map((option, index) => (
              <button
                key={option.key}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                aria-pressed={theme === option.key}
                onClick={() => selectTheme(option.key)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/5"
              >
                <span
                  className="h-6 w-6 shrink-0 rounded-md shadow-sm"
                  style={{ backgroundColor: option.swatch }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-200">{option.label}</span>
                  <span className="block truncate text-xs text-slate-500">{option.hint}</span>
                </span>
                {theme === option.key && <Check size={16} className="text-teal-400" />}
              </button>
            ))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
