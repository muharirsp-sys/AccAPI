import React, { forwardRef } from "react";
import AppInput from "@/components/ui/AppInput";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helperText, ...props }, ref) => (
    <div className="w-full">
      <AppInput ref={ref} label={label} error={error} {...props} />
      {helperText && !error && (
        <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
          {helperText}
        </span>
      )}
    </div>
  ),
);

Input.displayName = "Input";
