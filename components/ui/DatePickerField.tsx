"use client";

/*
 * Tujuan: Input tanggal read-only dengan calendar picker dan penanda tanggal merah Indonesia.
 * Caller: Halaman dashboard yang membutuhkan tanggal konsisten tanpa manual typing/paste.
 * Dependensi: date-fns, lucide-react, helper lib/date/indonesiaHolidays.
 * Main Functions: DatePickerField.
 * Side Effects: Render portal dropdown calendar ke document.body saat picker dibuka.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";
import { formatDateForApi, formatDateForDisplay, getHolidayName, isHoliday, isSunday, parseApiDate } from "@/lib/date/indonesiaHolidays";

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

    useEffect(() => {
        if (selectedDate) setMonth(startOfMonth(selectedDate));
    }, [value]);

    const days = useMemo(() => {
        const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
        const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
        return eachDayOfInterval({ start, end });
    }, [month]);

    const updatePanelPosition = () => {
        const rect = anchorRef.current?.getBoundingClientRect();
        if (!rect) return;
        const width = 308;
        const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
        setPanelPosition({
            top: rect.bottom + 8,
            left,
            width,
        });
    };

    const openPicker = () => {
        if (disabled) return;
        setOpen(true);
        window.setTimeout(updatePanelPosition, 0);
    };

    useEffect(() => {
        if (!open) return;
        updatePanelPosition();

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
            document.removeEventListener("mousedown", handlePointerDown);
            window.removeEventListener("resize", handleReposition);
            window.removeEventListener("scroll", handleReposition, true);
        };
    }, [open]);

    const calendar = open && typeof document !== "undefined"
        ? createPortal(
            <div
                ref={panelRef}
                className="fixed z-[9999] rounded-xl border border-white/10 bg-[#11141b] p-3 shadow-2xl shadow-black/40"
                style={{ top: panelPosition.top, left: panelPosition.left, width: panelPosition.width }}
            >
                <div className="mb-3 flex items-center justify-between">
                    <button
                        type="button"
                        aria-label="Bulan sebelumnya"
                        onClick={() => setMonth((current) => subMonths(current, 1))}
                        className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/10"
                    >
                        <ChevronLeft size={16} />
                    </button>
                    <div className="text-sm font-bold text-white">
                        {format(month, "MMMM yyyy", { locale: idLocale })}
                    </div>
                    <button
                        type="button"
                        aria-label="Bulan berikutnya"
                        onClick={() => setMonth((current) => addMonths(current, 1))}
                        className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-slate-300 hover:bg-white/10"
                    >
                        <ChevronRight size={16} />
                    </button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase text-slate-500">
                    {weekdays.map((day) => (
                        <div key={day} className={day === "Min" ? "text-red-300" : ""}>{day}</div>
                    ))}
                </div>
                <div className="mt-1 grid grid-cols-7 gap-1">
                    {days.map((day) => {
                        const dayValue = formatDateForApi(day);
                        const selected = selectedDate ? isSameDay(day, selectedDate) : false;
                        const outside = !isSameMonth(day, month);
                        const redDate = isHoliday(day) || isSunday(day);
                        const holidayName = getHolidayName(day);

                        return (
                            <button
                                key={dayValue}
                                type="button"
                                title={holidayName || formatDateForDisplay(day)}
                                aria-label={`${formatDateForDisplay(day)}${holidayName ? `, ${holidayName}` : ""}`}
                                onClick={() => {
                                    onChange(dayValue);
                                    setOpen(false);
                                }}
                                className={cn(
                                    "relative flex h-9 items-center justify-center rounded-lg border text-sm transition-colors",
                                    outside ? "border-transparent text-slate-700" : "border-white/5 text-slate-200",
                                    redDate && !selected && "border-red-500/20 bg-red-500/10 text-red-300",
                                    isSunday(day) && !selected && "font-bold",
                                    selected && "border-emerald-400 bg-emerald-500 text-white shadow-lg shadow-emerald-500/20",
                                    !selected && "hover:border-white/20 hover:bg-white/10"
                                )}
                            >
                                {format(day, "d")}
                                {isHoliday(day) && (
                                    <span className={cn("absolute bottom-1 h-1 w-1 rounded-full", selected ? "bg-white" : "bg-red-300")} />
                                )}
                            </button>
                        );
                    })}
                </div>
                <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-100">
                    Tanggal merah: libur nasional/cuti bersama Indonesia. Hari Minggu otomatis merah.
                </div>
            </div>,
            document.body
        )
        : null;

    return (
        <div ref={anchorRef} className="relative">
            <Calendar size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
                type="text"
                readOnly
                aria-label={ariaLabel}
                value={formatDateForDisplay(value)}
                placeholder={placeholder}
                disabled={disabled}
                onClick={openPicker}
                onFocus={openPicker}
                onPaste={(event) => event.preventDefault()}
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
