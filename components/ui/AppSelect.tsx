import { forwardRef, SelectHTMLAttributes, ReactNode } from "react";

interface AppSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  children: ReactNode;
  error?: string;
}

const AppSelect = forwardRef<HTMLSelectElement, AppSelectProps>(
  ({ label, children, error, className = "", ...rest }, ref) => (
    <label className="block">
      {label && (
        <span className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400">
          {label}
        </span>
      )}
      <select
        ref={ref}
        className={`h-11 w-full rounded-lg border ${error ? "border-error-300 focus:border-error-300 focus:ring-3 focus:ring-error-500/10" : "border-gray-300 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10"} bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 disabled:bg-gray-100 disabled:text-gray-500 disabled:opacity-60 ${className}`}
        {...rest}
      >
        {children}
      </select>
      {error && (
        <p className="mt-1 text-xs text-error-500">{error}</p>
      )}
    </label>
  ),
);

AppSelect.displayName = "AppSelect";
export default AppSelect;
