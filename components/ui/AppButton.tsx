"use client";

import { ReactNode, forwardRef, type ButtonHTMLAttributes } from "react";

interface AppButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "primary" | "outline" | "success" | "error" | "ghost" | "link";
  size?: "sm" | "md";
  startIcon?: ReactNode;
  endIcon?: ReactNode;
  className?: string;
}

const variantClasses = {
  primary:
    "bg-brand-500 text-white shadow-theme-xs hover:bg-brand-600 active:bg-brand-700 disabled:bg-brand-300",
  outline:
    "bg-white text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-400 dark:ring-gray-700 dark:hover:bg-white/[0.03] dark:hover:text-gray-300",
  success:
    "bg-success-500 text-white shadow-theme-xs hover:bg-success-600 active:bg-success-700 disabled:bg-success-300",
  error:
    "bg-error-500 text-white shadow-theme-xs hover:bg-error-600 active:bg-error-700 disabled:bg-error-300",
  ghost:
    "bg-transparent text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-300",
  link: "bg-transparent text-brand-500 hover:underline p-0 shadow-none",
};

const sizeClasses = {
  sm: "px-4 py-2 text-xs",
  md: "px-5 py-2.5 text-sm",
};

const AppButton = forwardRef<HTMLButtonElement, AppButtonProps>(
  (
    {
      children,
      variant = "primary",
      size = "md",
      startIcon,
      endIcon,
      disabled = false,
      className = "",
      ...rest
    },
    ref,
  ) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center gap-2 font-semibold rounded-lg transition-colors ${variantClasses[variant]} ${variant !== "link" ? sizeClasses[size] : ""} ${disabled ? "cursor-not-allowed opacity-50" : ""} ${className}`}
      disabled={disabled}
      {...rest}
    >
      {startIcon && <span className="flex items-center">{startIcon}</span>}
      {children}
      {endIcon && <span className="flex items-center">{endIcon}</span>}
    </button>
  ),
);

AppButton.displayName = "AppButton";
export default AppButton;
