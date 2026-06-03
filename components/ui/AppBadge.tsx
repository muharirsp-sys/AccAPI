import { ReactNode } from "react";

type BadgeColor = "primary" | "success" | "error" | "warning" | "info" | "gray" | "dark";
type BadgeVariant = "light" | "solid";

interface AppBadgeProps {
  color?: BadgeColor;
  variant?: BadgeVariant;
  size?: "sm" | "md";
  children: ReactNode;
  className?: string;
}

const lightColors: Record<BadgeColor, string> = {
  primary: "bg-brand-50 text-brand-500 dark:bg-brand-500/15 dark:text-brand-400",
  success: "bg-success-50 text-success-600 dark:bg-success-500/15 dark:text-success-500",
  error: "bg-error-50 text-error-600 dark:bg-error-500/15 dark:text-error-500",
  warning: "bg-warning-50 text-warning-600 dark:bg-warning-500/15 dark:text-warning-400",
  info: "bg-blue-light-50 text-blue-light-600 dark:bg-blue-light-500/15 dark:text-blue-light-400",
  gray: "bg-gray-100 text-gray-700 dark:bg-white/5 dark:text-white/80",
  dark: "bg-gray-500 text-white dark:bg-white/5 dark:text-white",
};

const solidColors: Record<BadgeColor, string> = {
  primary: "bg-brand-500 text-white",
  success: "bg-success-500 text-white",
  error: "bg-error-500 text-white",
  warning: "bg-warning-400 text-gray-900",
  info: "bg-blue-light-500 text-white",
  gray: "bg-gray-500 text-white",
  dark: "bg-gray-900 text-white",
};

const sizeMap = {
  sm: "px-2 py-0.5 text-[10px]",
  md: "px-2.5 py-0.5 text-xs",
};

export default function AppBadge({
  color = "primary",
  variant = "light",
  size = "md",
  children,
  className = "",
}: AppBadgeProps) {
  const colors = variant === "solid" ? solidColors : lightColors;
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-semibold ${sizeMap[size]} ${colors[color]} ${className}`}
    >
      {children}
    </span>
  );
}
