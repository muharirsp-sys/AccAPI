import React, { forwardRef } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
    helperText?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
    ({ className, type = "text", label, error, helperText, ...props }, ref) => {
        return (
            <div className="flex flex-col gap-1.5 w-full">
                {label && (
                    <label className="text-sm font-medium text-slate-300">
                        {label} {props.required && <span className="text-red-400">*</span>}
                    </label>
                )}
                <div className="relative">
                    <input
                        type={type}
                        className={cn(
                            "flex h-10 w-full rounded-md border text-sm transition-colors",
                            "bg-black/20 border-white/10 text-slate-100 placeholder:text-slate-500",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:border-indigo-500",
                            "disabled:cursor-not-allowed disabled:opacity-50",
                            error && "border-red-500/50 focus-visible:ring-red-500/50 focus-visible:border-red-500",
                            className
                        )}
                        ref={ref}
                        {...props}
                    />
                </div>
                {error && (
                    <span className="text-xs text-red-400 font-medium animate-in fade-in slide-in-from-top-1">
                        {error}
                    </span>
                )}
                {helperText && !error && (
                    <span className="text-xs text-slate-500">
                        {helperText}
                    </span>
                )}
            </div>
        );
    }
);

Input.displayName = "Input";
