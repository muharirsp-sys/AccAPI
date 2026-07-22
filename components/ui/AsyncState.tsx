/*
 * Tujuan: Primitive feedback async bersama untuk loading skeleton, error yang dapat dipulihkan, dan empty state operasional.
 * Caller: Page shell dashboard dan komponen tabel yang membaca data asynchronous.
 * Dependensi: React.
 * Main Functions: `LoadingState`, `ErrorState`, `EmptyState`.
 * Side Effects: Menjalankan callback aksi/retry dari caller; tidak melakukan HTTP atau persistence sendiri.
 */

"use client";

type LoadingStateProps = {
  label?: string;
  rows?: number;
  embedded?: boolean;
};

type ActionStateProps = {
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  embedded?: boolean;
};

const stateClassName = (embedded: boolean) =>
  embedded ? "ui-state-panel ui-state-panel--embedded" : "ui-state-panel";

export function LoadingState({
  label = "Memuat data",
  rows = 4,
  embedded = false,
}: LoadingStateProps) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={stateClassName(embedded)}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="ui-skeleton-stack">
        <span className="ui-skeleton ui-skeleton--title" />
        {Array.from({ length: rows }, (_, index) => (
          <span
            key={index}
            className="ui-skeleton"
            style={{ width: `${Math.max(52, 94 - index * 9)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({
  title,
  message,
  actionLabel = "Coba Lagi",
  onAction,
  embedded = false,
}: ActionStateProps) {
  return (
    <div role="alert" className={`${stateClassName(embedded)} ui-state-panel--error`}>
      <h2 className="ui-state-title">{title}</h2>
      {message && <p className="ui-state-message">{message}</p>}
      {onAction && (
        <button type="button" onClick={onAction} className="ui-button-primary mt-4">
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  actionLabel,
  onAction,
  embedded = false,
}: ActionStateProps) {
  return (
    <div role="status" className={`${stateClassName(embedded)} ui-state-panel--empty`}>
      <h2 className="ui-state-title">{title}</h2>
      {message && <p className="ui-state-message">{message}</p>}
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} className="ui-button-secondary mt-4">
          {actionLabel}
        </button>
      )}
    </div>
  );
}
