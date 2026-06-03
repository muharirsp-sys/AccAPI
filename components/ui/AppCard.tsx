import { ElementType, ReactNode } from "react";

interface AppCardProps {
  title?: string;
  icon?: ElementType;
  children: ReactNode;
  className?: string;
  headerRight?: ReactNode;
}

export default function AppCard({
  title,
  icon: Icon,
  children,
  className = "",
  headerRight,
}: AppCardProps) {
  return (
    <div
      className={`rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-white/[0.03] p-5 shadow-theme-sm ${className}`}
    >
      {(title || headerRight) && (
        <div className="flex items-center justify-between mb-5">
          {title && (
            <h3 className="text-lg font-semibold text-gray-800 dark:text-white/90 flex items-center gap-2">
              {Icon && <Icon className="text-brand-500 dark:text-brand-400" size={20} />}
              {title}
            </h3>
          )}
          {headerRight}
        </div>
      )}
      {children}
    </div>
  );
}
