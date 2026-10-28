/*
 * Tujuan: Input berlabel (label terikat, galat/bantuan lewat aria-describedby) bergaya Fiori.
 * Caller: Belum ada pemakai (per audit desain 001); dipakai di dalam FioriScope. Untuk halaman Fiori baru, utamakan FormField + `input.fi-input`.
 * Dependensi: React, kelas fi-* di app/fiori.css (token hanya berlaku di dalam .fiori).
 * Main Functions: Input.
 * Side Effects: Tidak ada.
 */
import React, { forwardRef, useId } from "react";
import { TriangleAlert } from "lucide-react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
    helperText?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
    ({ className = "", type = "text", label, error, helperText, id, "aria-describedby": ariaDescribedBy, ...props }, ref) => {
        const generatedId = useId();
        const inputId = id || generatedId;
        const errorId = error ? `${inputId}-error` : undefined;
        const helperId = helperText && !error ? `${inputId}-helper` : undefined;
        const describedBy = [ariaDescribedBy, errorId, helperId].filter(Boolean).join(" ") || undefined;

        return (
            <div className="fi-field">
                {label && (
                    <label htmlFor={inputId} className="fi-label">
                        {label}{props.required && <span className="fi-req" aria-hidden>*</span>}
                    </label>
                )}
                <input id={inputId} type={type} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={`fi-input ${className}`} ref={ref} {...props} />
                {error && <p id={errorId} className="fi-msg"><TriangleAlert className="fi-icon" aria-hidden />{error}</p>}
                {helperText && !error && <p id={helperId} className="fi-help">{helperText}</p>}
            </div>
        );
    }
);

Input.displayName = "Input";
