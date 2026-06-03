import { ReactNode } from "react";
import { cn } from "@/lib/ui/cn";
import {
  OFF_TABLE,
  OFF_TABLE_BODY,
  OFF_TABLE_HEAD,
  OFF_TABLE_ROW_HOVER,
  OFF_TABLE_WRAP,
} from "@/lib/ui/off-theme";

interface AppTableProps {
  children: ReactNode;
  className?: string;
  minWidth?: string;
}

export function AppTableWrap({ children, className, minWidth }: AppTableProps) {
  return (
    <div className={cn(OFF_TABLE_WRAP, className)}>
      <table className={cn(OFF_TABLE, minWidth)} style={minWidth ? { minWidth } : undefined}>
        {children}
      </table>
    </div>
  );
}

export function AppTableHead({ children, className }: { children: ReactNode; className?: string }) {
  return <thead className={cn(OFF_TABLE_HEAD, className)}>{children}</thead>;
}

export function AppTableBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={cn(OFF_TABLE_BODY, className)}>{children}</tbody>;
}

export function AppTableRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <tr className={cn(OFF_TABLE_ROW_HOVER, className)}>{children}</tr>;
}

export { OFF_TABLE_WRAP, OFF_TABLE, OFF_TABLE_HEAD, OFF_TABLE_BODY, OFF_TABLE_ROW_HOVER };
