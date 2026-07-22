// Tujuan: Notification panel inline untuk OFF Program Control — menampilkan alert pengajuan bermasalah berdasarkan SLA.
// Caller: app/(dashboard)/off-program-control/page.tsx.
// Dependensi: lucide-react, helper problematic.
// Main Functions: OffNotificationBell, aksi langsung membuka batch bermasalah.
// Side Effects: Mutasi state dismiss/expand lokal dan callback onSelectBatch ke parent.
"use client";

import { useState } from "react";
import { Bell, X, AlertTriangle, Clock, AlertOctagon, ChevronDown } from "lucide-react";
import type { ProblematicBatch, ProblemSeverity } from "@/lib/off-program-control/problematic";

const severityConfig: Record<ProblemSeverity, { icon: typeof Clock; color: string; bg: string }> = {
    warning: { icon: Clock, color: "text-amber-600", bg: "bg-amber-500/10 border-amber-500/20" },
    danger: { icon: AlertTriangle, color: "text-rose-600", bg: "bg-rose-500/10 border-rose-500/20" },
    critical: { icon: AlertOctagon, color: "text-red-700", bg: "bg-red-500/15 border-red-500/30" },
};

interface OffNotificationBellProps {
    problems: ProblematicBatch[];
    onSelectBatch?: (batchId: string) => void;
}

export default function OffNotificationBell({ problems, onSelectBatch }: OffNotificationBellProps) {
    const [expanded, setExpanded] = useState(false);
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());

    const visible = problems.filter((p) => !dismissed.has(p.batchId + p.code));
    if (visible.length === 0) return null;

    const dismiss = (problem: ProblematicBatch) => {
        setDismissed((prev) => new Set([...prev, problem.batchId + problem.code]));
    };

    const preview = expanded ? visible : visible.slice(0, 3);
    const criticalCount = visible.filter((p) => p.severity === "critical").length;
    const dangerCount = visible.filter((p) => p.severity === "danger").length;

    return (
        <div className="mb-6 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-bold text-[var(--luxury-text)]">
                    <Bell size={16} className="text-[var(--luxury-gold)]" />
                    <span>Pengajuan Bermasalah ({visible.length})</span>
                    {criticalCount > 0 && (
                        <span className="rounded-full bg-red-500/20 border border-red-500/30 px-2 py-0.5 text-[10px] font-bold text-red-700">
                            {criticalCount} kritis
                        </span>
                    )}
                    {dangerCount > 0 && (
                        <span className="rounded-full bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 text-[10px] font-bold text-rose-600">
                            {dangerCount} serius
                        </span>
                    )}
                </div>
                {visible.length > 3 && (
                    <button
                        type="button"
                        onClick={() => setExpanded(!expanded)}
                        className="flex items-center gap-1 text-xs font-semibold text-[var(--luxury-gold)] hover:text-[var(--luxury-bronze)] transition-colors"
                    >
                        {expanded ? "Sembunyikan" : `Lihat semua (${visible.length})`}
                        <ChevronDown size={12} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
                    </button>
                )}
            </div>

            {/* Notification items */}
            {preview.map((problem) => {
                const config = severityConfig[problem.severity];
                const Icon = config.icon;
                return (
                    <div
                        key={problem.batchId + problem.code}
                        className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${config.bg} transition-all`}
                    >
                        <Icon size={16} className={`mt-0.5 shrink-0 ${config.color}`} />
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-semibold text-[var(--luxury-text)]">{problem.title}</p>
                                <span className="rounded-md bg-black/5 border border-[var(--border-soft)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--luxury-muted)]">
                                    {problem.noPengajuan}
                                </span>
                            </div>
                            <p className="text-xs text-[var(--luxury-muted)] mt-0.5">{problem.message}</p>
                            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                <span className="text-[10px] text-[var(--luxury-subtle)]">
                                    {problem.principleName}
                                </span>
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            {onSelectBatch && (
                                <button
                                    type="button"
                                    onClick={() => onSelectBatch(problem.batchId)}
                                    className="ui-button-secondary"
                                >
                                    Buka pengajuan
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => dismiss(problem)}
                                className="rounded-lg p-1 text-[var(--luxury-subtle)] hover:text-[var(--luxury-text)] hover:bg-black/10 transition-colors"
                                aria-label={`Hapus notifikasi ${problem.noPengajuan}`}
                            >
                                <X size={14} />
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
