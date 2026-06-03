import { forwardRef, InputHTMLAttributes, ReactNode } from "react";

interface AppInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  icon?: ReactNode;
  error?: string;
}

const AppInput = forwardRef<HTMLInputElement, AppInputProps>(
  ({ label, icon, error, className = "", ...rest }, ref) => (
    <label className="block">
      {label && (
        <span className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400">
          {label}
        </span>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-gray-500 dark:text-gray-400">
            {icon}
          </div>
        )}
        <input
          ref={ref}
          className={`h-11 w-full rounded-lg border ${error ? "border-error-300 focus:border-error-300 focus:ring-3 focus:ring-error-500/10" : "border-gray-300 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10"} bg-transparent px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 shadow-theme-xs outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-white/30 dark:focus:border-brand-300 disabled:bg-gray-100 disabled:text-gray-500 disabled:opacity-60 ${icon ? "pl-11" : ""} ${className}`}
          {...rest}
        />
      </div>
      {error && (
        <p className="mt-1 text-xs text-error-500">{error}</p>
      )}
    </label>
  ),
);

AppInput.displayName = "AppInput";
export default AppInput;
