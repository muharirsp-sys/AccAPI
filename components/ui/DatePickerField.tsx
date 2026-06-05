"use client";

/*
 * Tujuan: Input tanggal read-only dengan calendar picker dan custom day renderer penanda tanggal merah Indonesia.
 * Caller: Halaman dashboard yang membutuhkan tanggal konsisten tanpa manual typing/paste.
 * Dependensi: date-fns, lucide-react, helper lib/date/indonesiaHolidays.
 * Main Functions: DatePickerField.
 * Side Effects: Render portal dropdown calendar ke document.body saat picker dibuka.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";
import { formatDateForApi, formatDateForDisplay, getHolidayName, isHoliday, isRedDate, isSunday, parseApiDate } from "@/lib/date/indonesiaHolidays";

type DatePickerFieldProps = {
    value?: string;
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    disabled?: boolean;
    clearable?: boolean;
    ariaLabel?: string;
};

const weekdays = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

function cn(...classes: Array<string | false | null | undefined>) {
    return classes.filter(Boolean).join(" ");
}

export default function DatePickerField({
    value,
    onChange,
    placeholder = "Pilih tanggal",
    className,
    disabled = false,
    clearable = true,
    ariaLabel = "Pilih tanggal",
}: DatePickerFieldProps) {
    const anchorRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const selectedDate = parseApiDate(value);
    const [open, setOpen] = useState(false);
    const [month, setMonth] = useState(() => startOfMonth(selectedDate || new Date()));
    const [panelPosition, setPanelPosition] = useState({ top: 0, left: 0, width: 308 });

    const days = useMemo(() => {
        const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
        const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
        return eachDayOfInterval({ start, end });
    }, [month]);

    const updatePanelPosition = useCallback(() => {
        const rect = anchorRef.current?.getBoundingClientRect();
        if (!rect) return;
        const width = 308;
        const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
        setPanelPosition({
            top: rect.bottom + 8,
            left,
            width,
        });
    }, []);

    const openPicker = () => {
        if (disabled) return;
        setMonth(startOfMonth(selectedDate || new Date()));
        setOpen(true);
        window.setTimeout(updatePanelPosition, 0);
    };

    useEffect(() => {
        if (!open) return;
        const initialFrame = window.requestAnimationFrame(updatePanelPosition);

        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };
        const handleReposition = () => updatePanelPosition();

        document.addEventListener("mousedown", handlePointerDown);
        window.addEventListener("resize", handleReposition);
        window.addEventListener("scroll", handleReposition, true);
        return () => {
            window.cancelAnimationFrame(initialFrame);
            document.removeEventListener("mousedown", handlePointerDown);
            window.removeEventListener("resize", handleReposition);
            window.removeEventListener("scroll", handleReposition, true);
        };
    }, [open, updatePanelPosition]);

    const calendar = open && typeof document !== "undefined"
        ? createPortal(
            <div
                ref={panelRef}
                data-accapi-date-picker-calendar="true"
                className="fixed z-[9999] rounded-xl border p-3 shadow-2xl"
                style={{ top: panelPosition.top, left: panelPosition.left, width: panelPosition.width, background: 'var(--surface)', borderColor: 'var(--border-strong)', boxShadow: 'var(--luxury-shadow)' }}
            >
                <div className="mb-3 flex items-center justify-between">
                    <button
                        type="button"
                        aria-label="Bulan sebelumnya"
                        onClick={() => setMonth((current) => subMonths(current, 1))}
                        className="rounded-lg p-1.5 transition-colors"
                        style={{ border: '1px solid var(--border-strong)', color: 'var(--luxury-muted)', background: 'var(--surface-2)' }}
                    >
                        <ChevronLeft size={16} />
                    </button>
                    <div className="text-sm font-bold" style={{ color: 'var(--luxury-text)' }}>
                        {format(month, "MMMM yyyy", { locale: idLocale })}
                    </div>
                    <button
                        type="button"
                        aria-label="Bulan berikutnya"
                        onClick={() => setMonth((current) => addMonths(current, 1))}
                        className="rounded-lg p-1.5 transition-colors"
                        style={{ border: '1px solid var(--border-strong)', color: 'var(--luxury-muted)', background: 'var(--surface-2)' }}
                    >
                        <ChevronRight size={16} />
                    </button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase" style={{ color: 'var(--luxury-muted)' }}>
                    {weekdays.map((day) => (
                        <div key={day} style={day === "Min" ? { color: '#dc2626' } : undefined}>{day}</div>
                    ))}
                </div>
                <div className="mt-1 grid grid-cols-7 gap-1">
                    {days.map((day) => {
                        const dayValue = formatDateForApi(day);
                        const selected = selectedDate ? isSameDay(day, selectedDate) : false;
                        const outside = !isSameMonth(day, month);
                        const today = isSameDay(day, new Date());
                        const holiday = isHoliday(day);
                        const sunday = isSunday(day);
                        const redDate = isRedDate(day);
                        const holidayName = getHolidayName(day);

                        // Build inline styles for proper theme-aware contrast
                        let btnStyle: React.CSSProperties = {};
                        let btnClass = "relative flex h-9 items-center justify-center rounded-lg border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45";

                        if (selected && redDate) {
                            btnStyle = { background: '#dc2626', borderColor: '#fca5a5', color: '#ffffff', boxShadow: '0 4px 12px rgba(220, 38, 38, 0.3)' };
                            btnClass += " ring-2 ring-red-300/80";
                        } else if (selected && !redDate) {
                            btnStyle = { background: 'var(--luxury-gold)', borderColor: 'var(--luxury-gold-2)', color: '#ffffff', boxShadow: '0 4px 12px rgba(199, 154, 63, 0.35)' };
                        } else if (outside && redDate) {
                            btnStyle = { borderColor: 'rgba(220, 38, 38, 0.25)', background: 'rgba(220, 38, 38, 0.06)', color: 'rgba(220, 38, 38, 0.55)' };
                            btnClass += " font-bold";
                        } else if (outside && !redDate) {
                            btnStyle = { borderColor: 'var(--border-soft)', color: 'var(--luxury-subtle)' };
                        } else if (redDate && !selected) {
                            btnStyle = { borderColor: 'rgba(220, 38, 38, 0.5)', background: 'rgba(220, 38, 38, 0.08)', color: '#dc2626' };
                            btnClass += " font-bold hover:opacity-80";
                        } else {
                            btnStyle = { borderColor: 'var(--border-soft)', color: 'var(--luxury-text)' };
                            btnClass += " hover:opacity-75";
                        }

                        if (today && !selected && !redDate) {
                            btnClass += " ring-2";
                            btnStyle = { ...btnStyle, outlineColor: 'var(--luxury-gold)', boxShadow: `0 0 0 2px var(--luxury-gold)` };
                        } else if (today && !selected && redDate) {
                            btnClass += " ring-2";
                            btnStyle = { ...btnStyle, boxShadow: '0 0 0 2px rgba(220, 38, 38, 0.5)' };
                        }

                        if (redDate) btnClass += " font-bold";

                        return (
                            <button
                                key={dayValue}
                                type="button"
                                data-date={dayValue}
                                data-red-date={redDate ? "true" : "false"}
                                data-holiday={holiday ? "true" : "false"}
                                data-sunday={sunday ? "true" : "false"}
                                data-today={today ? "true" : "false"}
                                data-selected={selected ? "true" : "false"}
                                title={holidayName || formatDateForDisplay(day)}
                                aria-label={`${formatDateForDisplay(day)}${holidayName ? `, ${holidayName}` : ""}`}
                                onClick={() => {
                                    onChange(dayValue);
                                    setOpen(false);
                                }}
                                className={btnClass}
                                style={btnStyle}
                            >
                                {format(day, "d")}
                                {redDate && (
                                    <span
                                        aria-hidden="true"
                                        className="absolute bottom-1 h-1.5 w-1.5 rounded-full"
                                        style={{ background: selected ? '#ffffff' : '#dc2626' }}
                                    />
                                )}
                                {holiday && (
                                    <span
                                        aria-hidden="true"
                                        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full"
                                        style={{ background: selected ? '#fecaca' : '#ef4444' }}
                                    />
                                )}
                            </button>
                        );
                    })}
                </div>
                <div className="mt-3 rounded-lg px-3 py-2 text-[11px] font-medium" style={{ border: '1px solid rgba(220, 38, 38, 0.3)', background: 'rgba(220, 38, 38, 0.06)', color: '#dc2626' }}>
                    Tanggal merah: libur nasional/cuti bersama Indonesia. Hari Minggu otomatis merah.
                </div>
            </div>,
            document.body
        )
        : null;

    return (
        <div ref={anchorRef} data-accapi-date-picker="true" className="relative">
            <Calendar size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
                type="text"
                readOnly
                inputMode="none"
                aria-label={ariaLabel}
                value={formatDateForDisplay(value)}
                placeholder={placeholder}
                disabled={disabled}
                onClick={openPicker}
                onFocus={openPicker}
                onBeforeInput={(event) => event.preventDefault()}
                onPaste={(event) => event.preventDefault()}
                onDrop={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                    if (["Tab", "Shift", "Escape"].includes(event.key)) {
                        if (event.key === "Escape") setOpen(false);
                        return;
                    }
                    event.preventDefault();
                    if (["Enter", " ", "ArrowDown"].includes(event.key)) openPicker();
                }}
                className={cn(
                    "w-full cursor-pointer rounded-lg border border-white/10 bg-black/40 py-2 pl-8 pr-8 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-emerald-500/60 disabled:cursor-not-allowed disabled:opacity-50",
                    className
                )}
            />
            {clearable && value && !disabled && (
                <button
                    type="button"
                    aria-label="Kosongkan tanggal"
                    onClick={() => onChange("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 hover:bg-white/10 hover:text-slate-200"
                >
                    <X size={14} />
                </button>
            )}
            {calendar}
        </div>
    );
}
