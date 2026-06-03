import React, { forwardRef } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/ui/cn";

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
  ({ className, label, error, helperText, options, ...props }, ref) => (
    <div className="flex w-full flex-col gap-1.5">
      {label && (
        <label className="text-sm font-medium text-gray-700 dark:text-gray-400">
          {label}{" "}
          {props.required && <span className="text-error-500">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          className={cn(
            "h-11 w-full appearance-none rounded-lg border bg-transparent px-4 py-2.5 pr-10 text-sm text-gray-800 shadow-theme-xs outline-none dark:bg-gray-900 dark:text-white/90",
            error
              ? "border-error-300 focus:border-error-300 focus:ring-3 focus:ring-error-500/10"
              : "border-gray-300 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 dark:border-gray-700",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          ref={ref}
          {...props}
        >
          <option value="" disabled>
            Pilih opsi...
          </option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
          <ChevronDown className="h-4 w-4 text-gray-500 dark:text-gray-400" />
        </div>
      </div>
      {error && (
        <span className="text-xs font-medium text-error-500">{error}</span>
      )}
      {helperText && !error && (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {helperText}
        </span>
      )}
    </div>
  ),
);

Select.displayName = "Select";
