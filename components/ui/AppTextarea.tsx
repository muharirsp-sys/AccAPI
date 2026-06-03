import { forwardRef, TextareaHTMLAttributes } from "react";

interface AppTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

const AppTextarea = forwardRef<HTMLTextAreaElement, AppTextareaProps>(
  ({ label, error, className = "", ...rest }, ref) => (
    <label className="block">
      {label && (
        <span className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400">
          {label}
        </span>
      )}
      <textarea
        ref={ref}
        className={`w-full resize-none rounded-lg border ${error ? "border-error-300 focus:border-error-300 focus:ring-3 focus:ring-error-500/10" : "border-gray-300 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10"} bg-transparent px-4 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 shadow-theme-xs outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-white/30 disabled:bg-gray-100 disabled:text-gray-500 disabled:opacity-60 ${className}`}
        {...rest}
      />
      {error && (
        <p className="mt-1 text-xs text-error-500">{error}</p>
      )}
    </label>
  ),
);

AppTextarea.displayName = "AppTextarea";
export default AppTextarea;
