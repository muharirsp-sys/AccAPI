/*
 * Tujuan: Select berlabel (label terikat, galat/bantuan lewat aria-describedby) bergaya Fiori.
 * Caller: Belum ada pemakai (per audit desain 001); dipakai di dalam FioriScope. Untuk halaman Fiori baru, utamakan FormField + `select.fi-input`.
 * Dependensi: React, kelas fi-* di app/fiori.css (token hanya berlaku di dalam .fiori).
 * Main Functions: Select.
 * Side Effects: Tidak ada.
 */
import React, { forwardRef, useId } from "react";
import { TriangleAlert } from "lucide-react";

interface SelectOption {
    label: string;
    value: string | number;
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
    label?: string;
    error?: string;
    helperText?: string;
    options: SelectOption[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
    ({ className = "", label, error, helperText, options, id, "aria-describedby": ariaDescribedBy, ...props }, ref) => {
        const generatedId = useId();
        const selectId = id || generatedId;
        const errorId = error ? `${selectId}-error` : undefined;
        const helperId = helperText && !error ? `${selectId}-helper` : undefined;
        const describedBy = [ariaDescribedBy, errorId, helperId].filter(Boolean).join(" ") || undefined;

        return (
            <div className="fi-field">
                {label && (
                    <label htmlFor={selectId} className="fi-label">
                        {label}{props.required && <span className="fi-req" aria-hidden>*</span>}
                    </label>
                )}
                <select id={selectId} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={`fi-input ${className}`} ref={ref} {...props}>
                    <option value="" disabled>Pilih salah satu</option>
                    {options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                            {opt.label}
                        </option>
                    ))}
                </select>
                {error && <p id={errorId} className="fi-msg"><TriangleAlert className="fi-icon" aria-hidden />{error}</p>}
                {helperText && !error && <p id={helperId} className="fi-help">{helperText}</p>}
            </div>
        );
    }
);

Select.displayName = "Select";
