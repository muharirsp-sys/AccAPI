// Tujuan: Switch tema calming (revisi G) yang disimpan di localStorage, bukan database.
// Caller: components/SidebarLayout.tsx (navbar atas).
// Dependensi: React client hooks, lucide-react.
// Main Functions: ThemeSwitcher, OFF_THEMES, applyStoredThemeScript.
// Side Effects: Set atribut data-theme pada <html> dan tulis localStorage.
"use client";

import { useEffect, useState } from "react";
import { Palette, Check } from "lucide-react";

export const OFF_THEME_STORAGE_KEY = "off-theme";

export type OffThemeKey = "office-calm" | "neon";

export const OFF_THEMES: Array<{ key: OffThemeKey; label: string; hint: string; swatch: string }> = [
  { key: "office-calm", label: "Office Calm", hint: "Hijau teduh untuk kerja lama (default)", swatch: "#232c2a" },
  { key: "neon", label: "Neon HUD", hint: "Sci-fi control tower", swatch: "#03060d" },
];

const DEFAULT_THEME: OffThemeKey = "office-calm";

function isOffThemeKey(value: string | null): value is OffThemeKey {
  return value === "office-calm" || value === "neon";
}

// Script inline untuk apply tema sebelum paint agar tidak ada flash.
export const applyStoredThemeScript = `(function(){try{var t=localStorage.getItem('${OFF_THEME_STORAGE_KEY}');if(t!=='office-calm'&&t!=='neon'){t='${DEFAULT_THEME}';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','${DEFAULT_THEME}');}})();`;

export default function ThemeSwitcher() {
  const [open, setOpen] = useState(false);
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

  const selectTheme = (next: OffThemeKey) => {
    setTheme(next);
    try {
      localStorage.setItem(OFF_THEME_STORAGE_KEY, next);
    } catch {
      // localStorage tidak tersedia; tema tetap berlaku untuk sesi ini.
    }
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/10"
        title="Ganti tema"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Palette size={16} />
        <span className="hidden sm:inline">Tema</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            className="absolute right-0 z-40 mt-2 w-60 overflow-hidden rounded-xl border border-white/10 bg-[#1a1c23] shadow-2xl"
            role="menu"
          >
            <div className="border-b border-white/5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Tema Tampilan
            </div>
            {OFF_THEMES.map((option) => (
              <button
                key={option.key}
                type="button"
                role="menuitemradio"
                aria-checked={theme === option.key}
                onClick={() => selectTheme(option.key)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/5"
              >
                <span
                  className="h-6 w-6 shrink-0 rounded-md border border-white/20"
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
        </>
      )}
    </div>
  );
}
