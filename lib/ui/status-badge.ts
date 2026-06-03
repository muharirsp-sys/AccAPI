export type StatusBadgeColor =
  | "primary"
  | "success"
  | "error"
  | "warning"
  | "info"
  | "gray";

/** Map workflow status label to TailAdmin badge color (label text unchanged). */
export function statusToBadgeColor(status: string): StatusBadgeColor {
  const s = status || "";
  if (
    s.includes("Completed") ||
    s.includes("Approved") ||
    s.includes("Aman") ||
    (s.includes("Paid") &&
      !s.includes("Partial") &&
      !s.includes("Waiting"))
  ) {
    return "success";
  }
  if (s.includes("Locked")) return "gray";
  if (
    s.includes("Returned") ||
    s.includes("Kurang") ||
    s.includes("Revisi") ||
    s.includes("Cancel") ||
    s.includes("Void") ||
    s.includes("Reject")
  ) {
    return "error";
  }
  if (s.includes("OM") || s.includes("Ready") || s.includes("Claim")) {
    return s.includes("Claim") ? "info" : "primary";
  }
  if (
    s.includes("Waiting") ||
    s.includes("Draft") ||
    s.includes("Submitted") ||
    s.includes("Review") ||
    s.includes("Partial")
  ) {
    return "warning";
  }
  return "warning";
}

export function statusBadgeClass(status: string): string {
  const color = statusToBadgeColor(status);
  const map: Record<StatusBadgeColor, string> = {
    primary:
      "bg-brand-50 text-brand-600 border-brand-200 dark:bg-brand-500/15 dark:text-brand-400 dark:border-brand-500/30",
    success:
      "bg-success-50 text-success-600 border-success-200 dark:bg-success-500/15 dark:text-success-500 dark:border-success-500/30",
    error:
      "bg-error-50 text-error-600 border-error-200 dark:bg-error-500/15 dark:text-error-500 dark:border-error-500/30",
    warning:
      "bg-warning-50 text-warning-600 border-warning-200 dark:bg-warning-500/15 dark:text-warning-400 dark:border-warning-500/30",
    info: "bg-blue-light-50 text-blue-light-600 border-blue-light-200 dark:bg-blue-light-500/15 dark:text-blue-light-400 dark:border-blue-light-500/30",
    gray: "bg-gray-100 text-gray-600 border-gray-200 dark:bg-white/5 dark:text-white/80 dark:border-gray-700",
  };
  return `inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${map[color]}`;
}
