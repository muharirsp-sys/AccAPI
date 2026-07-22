/*
 * Tujuan: Halaman Insentif Sales untuk performa, kalkulasi insentif, dan verifikasi pembayaran dengan hasil batch yang eksplisit.
 * Caller: Next.js App Router route /insentif-sales.
 * Dependensi: lucide-react, sonner, Next navigation, `AsyncState`, ./data (helpers + constants), API routes /api/insentif-sales/*.
 * Main Functions: InsentifSalesPage + sub-view Sales/SPV/SM/Admin/Finance, pemilih periode URL,
 *   `paymentSelectionKey`, `updateContext`, keyboard tab navigation, dan feedback async.
 * Side Effects: Fetch /api/insentif-sales/dashboard dan /payments, POST /progress, PATCH /payments/[id], sinkronisasi view/filter ke query URL; error dan partial failure dipertahankan di UI.
 */

"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
    Trophy, Filter, Clock, TrendingUp, BarChart3, ListChecks,
    Wallet, Upload, Target, Users, UserCog, DollarSign, CheckCircle2,
    AlertTriangle, FileUp, Save, Loader2, RefreshCw, Download,
} from "lucide-react";
import { toast } from "sonner";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/AsyncState";
import {
    PRINCIPLES, BRANCHES, KPI_LABELS, MONTH_LABELS,
    getPeriodWorkdayProgress, paceStatus, pct, itemSuper, formatRp, formatShortRp,
    type Salesman, type PaceLevel, type ChannelType, type WorkdayProgress,
} from "./data";

// ── API types ──────────────────────────────────────────────────────────────
interface ApiRow {
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    channel: string;
    tipeSales?: string;
    statusInsentif?: string;
    support?: number;
    spvName: string | null;
    smName: string | null;
    target: { value: number; ec: number; ao: number; ia: number; isq: number; splm: number };
    real: { value: number; ec: number; ao: number; ia: number; isq: number };
    pct: { value: number; ec: number; ao: number; isq: number; total: number };
    incentive: { value: number; ec: number; ao: number; isq: number; total: number };
    paymentStatus: string;
}

interface PaymentRow {
    id: string;
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    periodMonth: number;
    periodYear: number;
    totalIncentive: number;
    paymentStatus: "belum" | "lunas" | "tunggakan";
    paymentProofUrl: string | null;
    paymentDate: number | null;
}

function paymentSelectionKey(row: { salesCode: string; principle: string }) {
    return `${row.salesCode}::${row.principle}`;
}

function apiRowToSalesman(row: ApiRow): Salesman {
    return {
        code: row.salesCode,
        name: row.salesName,
        principle: row.principle,
        branch: row.branch,
        channel: row.channel as ChannelType,
        spv: row.spvName ?? "",
        sm: row.smName ?? "",
        targetValue: row.target.value,
        targetEc: row.target.ec,
        targetAo: row.target.ao,
        targetIa: row.target.ia,
        realValue: row.real.value,
        realEc: row.real.ec,
        realAo: row.real.ao,
        realIa: row.real.ia,
        splmValue: row.target.splm,
    };
}

type ViewKey = "sales" | "spv" | "sm" | "admin" | "finance";

const VIEWS: { key: ViewKey; label: string; icon: typeof Trophy }[] = [
    { key: "sales", label: "Dashboard Sales", icon: Trophy },
    { key: "spv", label: "Dashboard SPV", icon: Users },
    { key: "sm", label: "Dashboard SM", icon: UserCog },
    { key: "admin", label: "Input Penjualan", icon: Upload },
    { key: "finance", label: "Verifikasi Finance", icon: Wallet },
];

// ── Reusable bits ──────────────────────────────────────────────────────────
function paceClasses(level: PaceLevel) {
    if (level === "green") return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 neon-text-success";
    if (level === "yellow") return "bg-amber-500/10 text-amber-400 border-amber-500/30 neon-text-warn";
    return "bg-rose-500/10 text-rose-400 border-rose-500/30 neon-text-danger";
}

function SectionTitle({ icon: Icon, no, title, desc }: { icon: typeof Trophy; no: number; title: string; desc?: string }) {
    return (
        <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg bg-black/40 border border-white/10 flex items-center justify-center shrink-0">
                <Icon className="text-indigo-400" size={18} />
            </div>
            <div>
                <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                    <span className="text-indigo-400 font-mono">{no}.</span> {title}
                </h2>
                {desc && <p className="text-xs text-slate-400 mt-0.5">{desc}</p>}
            </div>
        </div>
    );
}

function PaceCell({ value, timeGonePct, real, target, suffix = "%" }: { value: number; timeGonePct: number; real?: number; target?: number; suffix?: string }) {
    const level = paceStatus(value, timeGonePct);
    return (
        <span className={`inline-flex flex-col items-center min-w-[78px] px-2 py-1 rounded border font-bold text-xs ${paceClasses(level)}`}>
            <span>{value}{suffix}</span>
            {real !== undefined && target !== undefined && (
                <span className="text-[9px] font-mono opacity-70 font-normal">{real.toLocaleString("id-ID")}/{target.toLocaleString("id-ID")}</span>
            )}
        </span>
    );
}

function PctInsightCell({ value, delta, level }: { value: number; delta: number; level: PaceLevel }) {
    return (
        <div className="flex flex-col items-center gap-0.5 min-w-[58px]">
            <span className={`inline-block px-2 py-0.5 rounded border font-bold text-xs ${paceClasses(level)}`}>{value}%</span>
            <span className={`text-[9px] font-semibold leading-tight ${delta >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {delta >= 0 ? "▲" : "▼"} {delta >= 0 ? "+" : ""}{delta}%
            </span>
        </div>
    );
}

function SummaryBlock({ label, value, icon: Icon, tone }: { label: string; value: string; icon: typeof Trophy; tone: "emerald" | "indigo" | "amber" }) {
    const toneMap = {
        emerald: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
        indigo: "text-indigo-400 bg-indigo-500/10 border-indigo-500/30",
        amber: "text-amber-400 bg-amber-500/10 border-amber-500/30",
    };
    return (
        <div className="rounded-xl bg-black/30 border border-white/10 p-4">
            <div className={`w-8 h-8 rounded-lg border flex items-center justify-center mb-3 ${toneMap[tone]}`}>
                <Icon size={16} />
            </div>
            <div className="text-[11px] text-slate-400 font-medium">{label}</div>
            <div className="text-lg font-extrabold text-white tracking-tight mt-0.5">{value}</div>
        </div>
    );
}

// ── Performance Block (grouped bar chart) ─────────────────────────────────
function PerformanceBlock({ rows, apiRows, progress: tg }: { rows: Salesman[]; apiRows: ApiRow[]; progress: WorkdayProgress }) {
    const totalReal = rows.reduce((a, r) => a + r.realValue, 0);
    const totalTarget = rows.reduce((a, r) => a + r.targetValue, 0);
    const totalPct = pct(totalReal, totalTarget);
    const totalIncentive = apiRows.reduce((a, r) => a + r.incentive.total, 0);

    const chartData = rows.map((r) => ({
        name: r.name.split(" ")[0],
        code: r.code,
        value: pct(r.realValue, r.targetValue),
        ec: pct(r.realEc, r.targetEc),
        ao: pct(r.realAo, r.targetAo),
    }));

    const allPcts = chartData.flatMap((d) => [d.value, d.ec, d.ao]);
    const maxPct = Math.max(...allPcts, tg.pct, 100);
    const yMax = Math.ceil(maxPct / 20) * 20 + 20;
    const yTicks = Array.from({ length: yMax / 20 + 1 }, (_, i) => i * 20);

    const avgValue = chartData.reduce((a, d) => a + d.value, 0) / (chartData.length || 1);
    const avgEc = chartData.reduce((a, d) => a + d.ec, 0) / (chartData.length || 1);
    const avgAo = chartData.reduce((a, d) => a + d.ao, 0) / (chartData.length || 1);
    const avgAll = Math.round((avgValue + avgEc + avgAo) / 3);

    const CHART_H = 200;
    const toYPct = (val: number) => `${100 - (val / yMax) * 100}%`;

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={BarChart3} no={1} title="Grafik Blok Performa" desc="% Pencapaian Value (orange), EC (kuning), AO (biru) vs Time Gone" />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                <SummaryBlock label="Total Realisasi" value={formatShortRp(totalReal)} icon={TrendingUp} tone="emerald" />
                <SummaryBlock label="Total Target" value={formatShortRp(totalTarget)} icon={Target} tone="indigo" />
                <SummaryBlock label="Capaian Tim" value={`${totalPct}%`} icon={BarChart3} tone={totalPct >= tg.pct ? "emerald" : "amber"} />
                <SummaryBlock label="Taksiran Insentif" value={formatShortRp(totalIncentive)} icon={Wallet} tone="amber" />
            </div>
            <div className="overflow-x-auto">
                <div className="min-w-[480px]">
                    <div className="flex gap-2 items-start">
                        <div className="shrink-0 w-9 flex flex-col justify-between text-right" style={{ height: CHART_H }}>
                            {[...yTicks].reverse().map((t) => (
                                <span key={t} className="text-[9px] text-slate-500 font-mono leading-none">{t}%</span>
                            ))}
                        </div>
                        <div className="flex-1 relative border-l border-b border-white/20" style={{ height: CHART_H }}>
                            {yTicks.map((t) => (
                                <div key={t} className="absolute left-0 right-0 border-t border-white/[0.06]" style={{ top: toYPct(t) }} />
                            ))}
                            <div className="absolute left-0 right-0 z-10" style={{ top: toYPct(tg.pct) }}>
                                <div className="border-t-2 border-dashed border-emerald-400/90 w-full" />
                                <span className="absolute -top-4 right-1 text-[9px] text-emerald-400 font-bold bg-[#1a1c23]/80 px-1 rounded">
                                    Time Gone {tg.pct}%
                                </span>
                            </div>
                            <div className="absolute left-0 right-0 z-10" style={{ top: toYPct(avgAll) }}>
                                <div className="border-t border-dashed border-violet-400/80 w-full" />
                                <span className="absolute -top-4 left-1 text-[9px] text-violet-400 font-bold bg-[#1a1c23]/80 px-1 rounded">
                                    Avg {avgAll}%
                                </span>
                            </div>
                            <div className="absolute inset-0 flex items-end px-2">
                                {chartData.map((d) => (
                                    <div key={d.code} className="flex-1 h-full flex items-end justify-center gap-0.5">
                                        <div className="w-3.5 bg-orange-400/90 rounded-t-[2px]" style={{ height: `${(d.value / yMax) * CHART_H}px` }} title={`Value: ${d.value}%`} />
                                        <div className="w-3.5 bg-yellow-300/90 rounded-t-[2px]" style={{ height: `${(d.ec / yMax) * CHART_H}px` }} title={`EC: ${d.ec}%`} />
                                        <div className="w-3.5 bg-blue-400/90 rounded-t-[2px]" style={{ height: `${(d.ao / yMax) * CHART_H}px` }} title={`AO: ${d.ao}%`} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                    <div className="flex mt-1.5" style={{ paddingLeft: "2.75rem" }}>
                        {chartData.map((d) => (
                            <div key={d.code} className="flex-1 text-center text-[9px] text-slate-400 truncate px-0.5">{d.name}</div>
                        ))}
                    </div>
                </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-4 text-[10px] text-slate-400 border-t border-white/5 pt-3">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-orange-400 inline-block" /> Value</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-yellow-300 inline-block" /> Effective Call (EC)</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-blue-400 inline-block" /> Aktif Outlet (AO)</span>
                <span className="flex items-center gap-1.5 ml-2">
                    <span className="inline-block w-5 border-t-2 border-dashed border-emerald-400" />
                    <span className="text-emerald-400">Time Gone</span>
                </span>
                <span className="flex items-center gap-1.5">
                    <span className="inline-block w-5 border-t border-dashed border-violet-400" />
                    <span className="text-violet-400">Average Value,EC,AO</span>
                </span>
            </div>
        </div>
    );
}

// ── Achievement Table ──────────────────────────────────────────────────────
function AchievementTable({ rows, progress: tg }: { rows: Salesman[]; progress: WorkdayProgress }) {
    const totals = useMemo(() => ({
        realValue: rows.reduce((a, r) => a + r.realValue, 0),
        targetValue: rows.reduce((a, r) => a + r.targetValue, 0),
        realEc: rows.reduce((a, r) => a + r.realEc, 0),
        targetEc: rows.reduce((a, r) => a + r.targetEc, 0),
        realAo: rows.reduce((a, r) => a + r.realAo, 0),
        targetAo: rows.reduce((a, r) => a + r.targetAo, 0),
        realIa: rows.reduce((a, r) => a + r.realIa, 0),
        targetIa: rows.reduce((a, r) => a + r.targetIa, 0),
    }), [rows]);

    const pace = (achievePct: number) => Math.round((achievePct - tg.pct) * 10) / 10;
    const totalIsqReal = itemSuper(totals.realIa, totals.realAo);
    const totalIsqTgt = itemSuper(totals.targetIa, totals.targetAo);
    const totalIsqPct = totalIsqTgt > 0 ? pct(totalIsqReal, totalIsqTgt) : 0;
    const grandTotal = Math.round(((pct(totals.realValue, totals.targetValue) + pct(totals.realEc, totals.targetEc) + pct(totals.realAo, totals.targetAo) + totalIsqPct) / 4) * 10) / 10;

    const thSub = "px-2 py-1.5 text-center border-b border-white/[0.06] font-semibold text-slate-500 text-[10px]";
    const tdNum = "px-2 py-3 text-center font-mono text-[11px]";

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={ListChecks} no={2} title="Tabel Pencapaian" desc="Target, realisasi, persentase KPI, dan posisi terhadap progres waktu kerja" />
            <div className="overflow-x-auto">
                <table className="ui-data-table min-w-[1300px]">
                    <thead>
                        <tr className="bg-black/60 text-[11px] font-bold uppercase tracking-wider">
                            <th className="px-3 py-2.5 text-slate-400 border-b border-r border-white/10" rowSpan={2}>Salesman</th>
                            <th className="px-3 py-2 text-center text-orange-300 border-b border-r border-white/10" colSpan={3}>Value (Rp.)</th>
                            <th className="px-3 py-2 text-center text-yellow-300 border-b border-r border-white/10" colSpan={3}>Effective Call</th>
                            <th className="px-3 py-2 text-center text-blue-300 border-b border-r border-white/10" colSpan={3}>Aktif Outlet</th>
                            <th className="px-3 py-2 text-center text-violet-300 border-b border-r border-white/10" colSpan={3}>Item Super / Toko</th>
                            <th className="px-3 py-2.5 text-center text-indigo-300 bg-indigo-500/10 border-b border-white/10" rowSpan={2}>Total<br />Achievement</th>
                        </tr>
                        <tr className="bg-black/40">
                            <th className={thSub + " border-r border-white/[0.04]"}>Target</th>
                            <th className={thSub + " border-r border-white/[0.04]"}>Realisasi</th>
                            <th className={thSub + " border-r border-white/10"}>%</th>
                            <th className={thSub + " border-r border-white/[0.04]"}>Target</th>
                            <th className={thSub + " border-r border-white/[0.04]"}>Realisasi</th>
                            <th className={thSub + " border-r border-white/10"}>%</th>
                            <th className={thSub + " border-r border-white/[0.04]"}>Target</th>
                            <th className={thSub + " border-r border-white/[0.04]"}>Realisasi</th>
                            <th className={thSub + " border-r border-white/10"}>%</th>
                            <th className={thSub + " border-r border-white/[0.04]"}>Target</th>
                            <th className={thSub + " border-r border-white/[0.04]"}>Realisasi</th>
                            <th className={thSub + " border-r border-white/10"}>%</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.1]">
                        {rows.map((r) => {
                            const pVal = pct(r.realValue, r.targetValue);
                            const pEc = pct(r.realEc, r.targetEc);
                            const pAo = pct(r.realAo, r.targetAo);
                            const isqReal = itemSuper(r.realIa, r.realAo);
                            const isqTgt = itemSuper(r.targetIa, r.targetAo);
                            const pIsq = isqTgt > 0 ? pct(isqReal, isqTgt) : 0;
                            const totalAch = Math.round(((pVal + pEc + pAo + pIsq) / 4) * 10) / 10;
                            const totalLevel = paceStatus(totalAch, tg.pct);
                            return (
                                <tr key={r.code} className="even:bg-white/[0.025] hover:bg-white/[0.05] transition-colors align-top">
                                    <td className="px-3 py-3 border-r border-white/[0.06]">
                                        <div className="font-semibold text-slate-200">{r.name}</div>
                                        <div className="text-[10px] text-slate-500 font-mono">{r.code} · {r.channel}</div>
                                        <div className="text-[10px] text-slate-600 font-mono">{r.principle} · {r.branch}</div>
                                    </td>
                                    <td className={tdNum + " text-slate-400"}>{formatShortRp(r.targetValue)}</td>
                                    <td className={tdNum + " text-slate-200 font-semibold"}>{formatShortRp(r.realValue)}</td>
                                    <td className="px-2 py-3 text-center border-r border-white/[0.06]">
                                        <PctInsightCell value={pVal} delta={pace(pVal)} level={paceStatus(pVal, tg.pct)} />
                                    </td>
                                    <td className={tdNum + " text-slate-400"}>{r.targetEc}</td>
                                    <td className={tdNum + " text-slate-200 font-semibold"}>{r.realEc}</td>
                                    <td className="px-2 py-3 text-center border-r border-white/[0.06]">
                                        <PctInsightCell value={pEc} delta={pace(pEc)} level={paceStatus(pEc, tg.pct)} />
                                    </td>
                                    <td className={tdNum + " text-slate-400"}>{r.targetAo}</td>
                                    <td className={tdNum + " text-slate-200 font-semibold"}>{r.realAo}</td>
                                    <td className="px-2 py-3 text-center border-r border-white/[0.06]">
                                        <PctInsightCell value={pAo} delta={pace(pAo)} level={paceStatus(pAo, tg.pct)} />
                                    </td>
                                    <td className={tdNum + " text-slate-400"}>{isqTgt.toFixed(2)}</td>
                                    <td className={tdNum + " text-slate-200 font-semibold"}>{isqReal.toFixed(2)}</td>
                                    <td className="px-2 py-3 text-center border-r border-white/[0.06]">
                                        <PctInsightCell value={pIsq} delta={pace(pIsq)} level={paceStatus(pIsq, tg.pct)} />
                                    </td>
                                    <td className="px-3 py-3 text-center bg-indigo-500/5">
                                        <span className={`inline-block px-3 py-1.5 rounded-lg border font-extrabold text-sm ${paceClasses(totalLevel)}`}>{totalAch}%</span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                    <tfoot>
                        <tr className="bg-black/50 border-t-2 border-indigo-500/30 font-bold text-slate-100 text-[11px]">
                            <td className="px-3 py-3 uppercase tracking-wider text-indigo-300 border-r border-white/[0.06]">Grand Total / Tim</td>
                            <td className={tdNum + " text-slate-400"}>{formatShortRp(totals.targetValue)}</td>
                            <td className={tdNum + " text-slate-200"}>{formatShortRp(totals.realValue)}</td>
                        <td className="px-2 py-3 text-center border-r border-white/[0.06]"><PaceCell value={pct(totals.realValue, totals.targetValue)} timeGonePct={tg.pct} /></td>
                            <td className={tdNum + " text-slate-400"}>{totals.targetEc}</td>
                            <td className={tdNum + " text-slate-200"}>{totals.realEc}</td>
                        <td className="px-2 py-3 text-center border-r border-white/[0.06]"><PaceCell value={pct(totals.realEc, totals.targetEc)} timeGonePct={tg.pct} /></td>
                            <td className={tdNum + " text-slate-400"}>{totals.targetAo}</td>
                            <td className={tdNum + " text-slate-200"}>{totals.realAo}</td>
                        <td className="px-2 py-3 text-center border-r border-white/[0.06]"><PaceCell value={pct(totals.realAo, totals.targetAo)} timeGonePct={tg.pct} /></td>
                            <td className={tdNum + " text-slate-400"}>{totalIsqTgt.toFixed(2)}</td>
                            <td className={tdNum + " text-slate-200"}>{totalIsqReal.toFixed(2)}</td>
                        <td className="px-2 py-3 text-center border-r border-white/[0.06]"><PaceCell value={totalIsqPct} timeGonePct={tg.pct} /></td>
                            <td className="px-3 py-3 text-center bg-indigo-500/10">
                                <span className="text-sm font-extrabold text-indigo-300">{grandTotal}%</span>
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}

// ── Incentive Table — pakai data incentive dari API ────────────────────────
function IncentiveTable({ apiRows }: { apiRows: ApiRow[] }) {
    const grand = apiRows.reduce(
        (acc, r) => {
            acc.value += r.incentive.value;
            acc.ao += r.incentive.ao;
            acc.total += r.incentive.total;
            return acc;
        },
        { value: 0, ao: 0, total: 0 },
    );

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={Wallet} no={3} title="Tabel Insentif" desc="Skema GT/TT: Value (30%) + Aktif Outlet (70%). MT belum ada aturan." />
            <div className="overflow-x-auto">
                <table className="ui-data-table min-w-[640px]">
                    <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                        <tr className="whitespace-nowrap">
                            <th className="px-3 py-3">Salesman</th>
                            <th className="px-3 py-3 text-right">{KPI_LABELS.value}</th>
                            <th className="px-3 py-3 text-right">{KPI_LABELS.ao}</th>
                            <th className="px-3 py-3 text-right bg-amber-500/10">Total Insentif</th>
                            <th className="px-3 py-3 text-center">Status</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.1]">
                        {apiRows.map((r) => {
                            const statusMap: Record<string, string> = {
                                lunas: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
                                tunggakan: "bg-rose-500/10 text-rose-400 border-rose-500/30",
                                belum: "bg-white/5 text-slate-500 border-white/10",
                            };
                            const statusLabel: Record<string, string> = { lunas: "Lunas", tunggakan: "Tunggakan", belum: "Belum" };
                            const sc = statusMap[r.paymentStatus] ?? statusMap.belum;
                            return (
                                <tr key={r.salesCode} className="even:bg-white/[0.025] hover:bg-white/[0.05] transition-colors">
                                    <td className="px-3 py-3">
                                        <div className="font-semibold text-slate-200">{r.salesName}</div>
                                        <div className="text-[10px] text-slate-500 font-mono">{r.salesCode}</div>
                                    </td>
                                    <td className="px-3 py-3 text-right font-mono text-slate-300">{formatRp(r.incentive.value)}</td>
                                    <td className="px-3 py-3 text-right font-mono text-slate-300">{formatRp(r.incentive.ao)}</td>
                                    <td className="px-3 py-3 text-right bg-amber-500/5 font-mono font-bold text-amber-400">{formatRp(r.incentive.total)}</td>
                                    <td className="px-3 py-3 text-center">
                                        <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${sc}`}>
                                            {statusLabel[r.paymentStatus] ?? "Belum"}
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                    <tfoot>
                        <tr className="bg-black/50 border-t-2 border-amber-500/30 font-bold">
                            <td className="px-3 py-3 uppercase text-[11px] tracking-wider text-amber-300">Grand Total</td>
                            <td className="px-3 py-3 text-right font-mono text-slate-200">{formatRp(grand.value)}</td>
                            <td className="px-3 py-3 text-right font-mono text-slate-200">{formatRp(grand.ao)}</td>
                            <td className="px-3 py-3 text-right bg-amber-500/10 font-mono text-amber-300 text-sm">{formatRp(grand.total)}</td>
                            <td />
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}

// ── SPV View ───────────────────────────────────────────────────────────────
function SpvView({ rows, progress: tg }: { rows: Salesman[]; progress: WorkdayProgress }) {
    const groups = useMemo(() => {
        const map = new Map<string, Salesman[]>();
        rows.forEach((r) => { const k = r.spv; if (!map.has(k)) map.set(k, []); map.get(k)!.push(r); });
        return [...map.entries()];
    }, [rows]);

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={ListChecks} no={2} title="Tabel Pencapaian SPV" desc="Agregat tim per Supervisor" />
            <div className="overflow-x-auto">
                <table className="ui-data-table min-w-[920px]">
                    <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                        <tr className="whitespace-nowrap">
                            <th className="px-3 py-3">Nama SPV</th>
                            <th className="px-3 py-3 text-center">Value (T/R/%)</th>
                            <th className="px-3 py-3 text-center">AO TT (%)</th>
                            <th className="px-3 py-3 text-center">Avg AO/Sales</th>
                            <th className="px-3 py-3 text-center">Ave IA TT</th>
                            <th className="px-3 py-3 text-center">Ave IA MT</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.1]">
                        {groups.map(([spv, list]) => {
                            const rv = list.reduce((a, r) => a + r.realValue, 0);
                            const tv = list.reduce((a, r) => a + r.targetValue, 0);
                            const ttList = list.filter((r) => r.channel === "TT");
                            const mtList = list.filter((r) => r.channel === "MT");
                            const aoTtReal = ttList.reduce((a, r) => a + r.realAo, 0);
                            const aoTtTarget = ttList.reduce((a, r) => a + r.targetAo, 0);
                            // 1 salesman bisa banyak baris (per principle) → count distinct salesCode untuk per-sales.
                            const salesmanCount = new Set(list.map((r) => r.code)).size;
                            const avgAo = salesmanCount ? Math.round(list.reduce((a, r) => a + r.realAo, 0) / salesmanCount) : 0;
                            const aveIaTt = ttList.length ? Math.round(ttList.reduce((a, r) => a + r.realIa, 0) / ttList.length) : 0;
                            const aveIaMt = mtList.length ? Math.round(mtList.reduce((a, r) => a + r.realIa, 0) / mtList.length) : 0;
                            return (
                                <tr key={spv} className="even:bg-white/[0.025] hover:bg-white/[0.05] transition-colors">
                                    <td className="px-3 py-3">
                                        <div className="font-semibold text-slate-200">{spv}</div>
                                        <div className="text-[10px] text-slate-500">{salesmanCount} salesman</div>
                                    </td>
                                <td className="px-3 py-3 text-center"><PaceCell value={pct(rv, tv)} timeGonePct={tg.pct} real={rv} target={tv} /></td>
                                <td className="px-3 py-3 text-center"><PaceCell value={pct(aoTtReal, aoTtTarget)} timeGonePct={tg.pct} /></td>
                                    <td className="px-3 py-3 text-center text-slate-200 font-bold">{avgAo}</td>
                                    <td className="px-3 py-3 text-center text-slate-200 font-bold">{aveIaTt}</td>
                                    <td className="px-3 py-3 text-center text-slate-200 font-bold">{aveIaMt}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                    <tfoot>
                        <tr className="bg-black/50 border-t-2 border-indigo-500/30 font-bold">
                            <td className="px-3 py-3 uppercase text-[11px] tracking-wider text-indigo-300">Total ({tg.pct}% Time Gone)</td>
                            <td className="px-3 py-3 text-center"><PaceCell value={pct(rows.reduce((a, r) => a + r.realValue, 0), rows.reduce((a, r) => a + r.targetValue, 0))} timeGonePct={tg.pct} /></td>
                            <td className="px-3 py-3 text-center text-slate-400" colSpan={4}>-</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}

// ── SM View ────────────────────────────────────────────────────────────────
function SmView({ rows, progress }: { rows: Salesman[]; progress: WorkdayProgress }) {
    const groups = useMemo(() => {
        const map = new Map<string, Salesman[]>();
        rows.forEach((r) => { const k = `${r.sm}__${r.principle}`; if (!map.has(k)) map.set(k, []); map.get(k)!.push(r); });
        return [...map.entries()];
    }, [rows]);

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={ListChecks} no={2} title="Tabel Pencapaian SM" desc="Performa gabungan SPV per Principle" />
            <div className="overflow-x-auto">
                <table className="ui-data-table min-w-[980px]">
                    <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                        <tr className="whitespace-nowrap">
                            <th className="px-3 py-3">Nama SM</th>
                            <th className="px-3 py-3">Principle</th>
                            <th className="px-3 py-3 text-center">Value (T/R/%)</th>
                            <th className="px-3 py-3 text-center">AO TT (%)</th>
                            <th className="px-3 py-3 text-center">Avg AO/Sales</th>
                            <th className="px-3 py-3 text-center">Ave IA TT</th>
                            <th className="px-3 py-3 text-center">Ave IA MT</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.1]">
                        {groups.map(([key, list]) => {
                            const [sm, principle] = key.split("__");
                            const rv = list.reduce((a, r) => a + r.realValue, 0);
                            const tv = list.reduce((a, r) => a + r.targetValue, 0);
                            const ttList = list.filter((r) => r.channel === "TT");
                            const mtList = list.filter((r) => r.channel === "MT");
                            const aoTtReal = ttList.reduce((a, r) => a + r.realAo, 0);
                            const aoTtTarget = ttList.reduce((a, r) => a + r.targetAo, 0);
                            const avgAo = list.length ? Math.round(list.reduce((a, r) => a + r.realAo, 0) / list.length) : 0;
                            const aveIaTt = ttList.length ? Math.round(ttList.reduce((a, r) => a + r.realIa, 0) / ttList.length) : 0;
                            const aveIaMt = mtList.length ? Math.round(mtList.reduce((a, r) => a + r.realIa, 0) / mtList.length) : 0;
                            return (
                                <tr key={key} className="even:bg-white/[0.025] hover:bg-white/[0.05] transition-colors">
                                    <td className="px-3 py-3 font-semibold text-slate-200">{sm}</td>
                                    <td className="px-3 py-3"><span className="px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 text-[11px] font-bold">{principle}</span></td>
                                <td className="px-3 py-3 text-center"><PaceCell value={pct(rv, tv)} timeGonePct={progress.pct} real={rv} target={tv} /></td>
                                <td className="px-3 py-3 text-center"><PaceCell value={pct(aoTtReal, aoTtTarget)} timeGonePct={progress.pct} /></td>
                                    <td className="px-3 py-3 text-center text-slate-200 font-bold">{avgAo}</td>
                                    <td className="px-3 py-3 text-center text-slate-200 font-bold">{aveIaTt}</td>
                                    <td className="px-3 py-3 text-center text-slate-200 font-bold">{aveIaMt}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ── Tabel Insentif SPV — strata Value (lib/insentif-spv-calc), fetch mandiri ──
interface SpvIncentiveDetail {
    principle: string;
    targetValue: number;
    realisasiValue: number;
    pctValue: number;
    rate: number;
    insentif: number;
}
interface SpvIncentiveRow {
    spvName: string;
    jumlahValid: number;
    ratePerPrincipal: number;
    rincian: SpvIncentiveDetail[];
    total: number;
}

function SpvIncentiveTable({ month, year }: { month: number; year: number }) {
    const [rows, setRows] = useState<SpvIncentiveRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const res = await fetch(`/api/insentif-sales/spv-dashboard?month=${month}&year=${year}`);
                const data = await res.json();
                if (!cancelled) setRows(res.ok ? (data.rows ?? []) : []);
            } catch {
                if (!cancelled) { toast.error("Gagal memuat insentif SPV."); setRows([]); }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [month, year]);

    const grandTotal = rows.reduce((a, r) => a + r.total, 0);

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={Wallet} no={3} title="Tabel Insentif SPV" desc="Strata berbasis Value. Rate principal mengikuti jumlah principal valid yang ditangani." />
            {loading ? (
                <div className="flex items-center justify-center py-8 gap-2 text-slate-500 text-sm">
                    <Loader2 size={18} className="animate-spin text-indigo-400" /> Memuat…
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="ui-data-table min-w-[700px]">
                        <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                            <tr>
                                <th className="px-3 py-3">Nama SPV</th>
                                <th className="px-3 py-3 text-center">Jumlah Principal</th>
                                <th className="px-3 py-3 text-right">Rate/Principal</th>
                                <th className="px-3 py-3 text-right bg-amber-500/10">Total Insentif</th>
                                <th className="px-3 py-3 w-8"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.1]">
                            {rows.map((r) => (
                                <Fragment key={r.spvName}>
                                    <tr
                                        className="even:bg-white/[0.025] hover:bg-white/[0.05] transition-colors cursor-pointer"
                                        onClick={() => setExpanded((p) => ({ ...p, [r.spvName]: !p[r.spvName] }))}>
                                        <td className="px-3 py-3 font-semibold text-slate-200">{r.spvName}</td>
                                        <td className="px-3 py-3 text-center text-slate-300">{r.jumlahValid}</td>
                                        <td className="px-3 py-3 text-right font-mono text-slate-300">{formatRp(r.ratePerPrincipal)}</td>
                                        <td className="px-3 py-3 text-right bg-amber-500/5 font-mono font-bold text-amber-400">{formatRp(r.total)}</td>
                                        <td className="px-3 py-3 text-center text-slate-500">{expanded[r.spvName] ? "▲" : "▼"}</td>
                                    </tr>
                                    {expanded[r.spvName] && r.rincian.map((d) => (
                                        <tr key={`${r.spvName}-${d.principle}`} className="bg-black/20 text-[11px]">
                                            <td className="px-3 py-2 pl-8 text-slate-400">{d.principle}</td>
                                            <td className="px-3 py-2 text-center text-slate-500">{Math.round(d.pctValue * 100)}%</td>
                                            <td className="px-3 py-2 text-right font-mono text-slate-500">{formatRp(d.rate)}</td>
                                            <td className="px-3 py-2 text-right font-mono text-slate-400">{formatRp(d.insentif)}</td>
                                            <td />
                                        </tr>
                                    ))}
                                </Fragment>
                            ))}
                            {rows.length === 0 && (
                                <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-500 italic">Belum ada data SPV untuk periode ini.</td></tr>
                            )}
                        </tbody>
                        <tfoot>
                            <tr className="bg-black/50 border-t-2 border-amber-500/30 font-bold">
                                <td className="px-3 py-3 uppercase text-[11px] tracking-wider text-amber-300" colSpan={3}>Grand Total</td>
                                <td className="px-3 py-3 text-right bg-amber-500/10 font-mono text-amber-300 text-sm">{formatRp(grandTotal)}</td>
                                <td />
                            </tr>
                        </tfoot>
                    </table>
                </div>
            )}
        </div>
    );
}

// ── Target Input Section ───────────────────────────────────────────────────
interface TargetRow {
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    channel: string;
    spvName: string;
    smName: string;
    targetValue: number;
    targetEc: number;
    targetAo: number;
    targetIa: number;
    splmValue: number;
}

const EMPTY_ROW: TargetRow = {
    salesCode: "", salesName: "", principle: PRINCIPLES[0], branch: BRANCHES[0],
    channel: "TT", spvName: "", smName: "",
    targetValue: 0, targetEc: 0, targetAo: 0, targetIa: 0, splmValue: 0,
};

function TargetInputSection() {
    const now = new Date();
    const [month, setMonth] = useState(now.getMonth() + 1);
    const [year, setYear] = useState(now.getFullYear());
    const [rows, setRows] = useState<TargetRow[]>([{ ...EMPTY_ROW }]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [inputMethod, setInputMethod] = useState<"manual" | "excel">("manual");
    const [excelUploading, setExcelUploading] = useState(false);

    const fetchTargets = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/insentif-sales/targets?month=${month}&year=${year}`);
            const data = await res.json();
            if (data.rows?.length) {
                setRows(data.rows.map((r: TargetRow & { periodMonth?: number; periodYear?: number }) => ({
                    salesCode: r.salesCode, salesName: r.salesName,
                    principle: r.principle, branch: r.branch, channel: r.channel,
                    spvName: r.spvName ?? "", smName: r.smName ?? "",
                    targetValue: r.targetValue, targetEc: r.targetEc,
                    targetAo: r.targetAo, targetIa: r.targetIa, splmValue: r.splmValue ?? 0,
                })));
            } else {
                setRows([{ ...EMPTY_ROW }]);
            }
        } catch {
            toast.error("Gagal memuat target.");
        } finally {
            setLoading(false);
        }
    }, [month, year]);

    useEffect(() => { fetchTargets(); }, [fetchTargets]);

    function setCell<K extends keyof TargetRow>(idx: number, key: K, val: TargetRow[K]) {
        setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [key]: val } : r));
    }

    function addRow() { setRows((prev) => [...prev, { ...EMPTY_ROW }]); }
    function removeRow(idx: number) { setRows((prev) => prev.filter((_, i) => i !== idx)); }

    async function handleSave() {
        const invalid = rows.filter((r) => !r.salesCode.trim() || !r.salesName.trim());
        if (invalid.length) { toast.error("Kode & nama salesman wajib diisi di semua baris."); return; }
        setSaving(true);
        try {
            const payload = rows.map((r) => ({ ...r, periodMonth: month, periodYear: year }));
            const res = await fetch("/api/insentif-sales/targets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Server error");
            toast.success(`${data.upserted} target berhasil disimpan.`);
            fetchTargets();
        } catch (err) {
            toast.error(`Gagal simpan: ${err instanceof Error ? err.message : "Error"}`);
        } finally {
            setSaving(false);
        }
    }

    async function downloadTemplate() {
        try {
            const res = await fetch("/api/insentif-sales/targets/template");
            if (!res.ok) throw new Error("Gagal download template");
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `target_template_${month}_${year}.xlsx`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("Template downloaded");
        } catch (err) {
            toast.error(`Gagal: ${err instanceof Error ? err.message : "Error"}`);
        }
    }

    async function handleExcelUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setExcelUploading(true);
        try {
            const { parseTargetExcel } = await import("@/lib/insentif-sales-excel");
            const arrayBuffer = await file.arrayBuffer();
            const parsed = parseTargetExcel(arrayBuffer).map((r: Record<string, unknown>) => ({
                salesCode: String(r.salesCode || ""),
                salesName: String(r.salesName || ""),
                principle: String(r.principle || "NESTLE"),
                branch: String(r.branch || "BANDUNG"),
                channel: String(r.channel || "TT"),
                spvName: String(r.spvName || ""),
                smName: String(r.smName || ""),
                targetValue: Number(r.targetValue || 0),
                targetEc: Number(r.targetEc || 0),
                targetAo: Number(r.targetAo || 0),
                targetIa: Number(r.targetIa || 0),
                splmValue: Number(r.splmValue || 0),
            })) as TargetRow[];

            const invalid = parsed.filter((r) => !r.salesCode?.trim() || !r.salesName?.trim());
            if (invalid.length) {
                toast.error(`${invalid.length} baris tidak punya kode/nama salesman`);
                setExcelUploading(false);
                return;
            }

            const payload = parsed.map((r) => ({ ...r, periodMonth: month, periodYear: year }));
            const res = await fetch("/api/insentif-sales/targets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Server error");
            toast.success(`${data.upserted} target dari Excel berhasil disimpan.`);
            setInputMethod("manual");
            fetchTargets();
        } catch (err) {
            toast.error(`Gagal upload Excel: ${err instanceof Error ? err.message : "Error"}`);
        } finally {
            setExcelUploading(false);
            e.target.value = "";
        }
    }

    const inp = "w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500 min-w-0";
    const numInp = inp + " text-right font-mono";

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={Target} no={1} title="Input Target Bulanan" desc="Isi & simpan target KPI per salesman untuk periode terpilih" />

            {/* Period selector */}
            <div className="flex flex-wrap items-center gap-3 mb-4">
                <div className="flex items-center gap-2">
                    <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Bulan</label>
                    <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
                        className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500">
                        {MONTH_LABELS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                    </select>
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Tahun</label>
                    <select value={year} onChange={(e) => setYear(Number(e.target.value))}
                        className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500">
                        {[2025, 2026, 2027].map((y) => <option key={y}>{y}</option>)}
                    </select>
                </div>
                <button onClick={fetchTargets} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 hover:bg-white/10 transition-colors">
                    <RefreshCw size={13} /> Muat
                </button>
                <span className="text-[11px] text-slate-500 ml-auto">{rows.length} salesman</span>
            </div>

            {/* Input method tabs */}
            <div className="flex gap-2 mb-4 border-b border-white/10 pb-3">
                <button
                    onClick={() => setInputMethod("manual")}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                        inputMethod === "manual"
                            ? "bg-indigo-600/40 text-indigo-200 border-b-2 border-indigo-500"
                            : "text-slate-400 hover:text-slate-300"
                    }`}>
                    📋 Input Manual
                </button>
                <button
                    onClick={() => setInputMethod("excel")}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                        inputMethod === "excel"
                            ? "bg-indigo-600/40 text-indigo-200 border-b-2 border-indigo-500"
                            : "text-slate-400 hover:text-slate-300"
                    }`}>
                    📊 Upload Excel
                </button>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-8 gap-2 text-slate-500 text-sm">
                    <Loader2 size={18} className="animate-spin text-indigo-400" /> Memuat…
                </div>
            ) : inputMethod === "manual" ? (
                <>
                    <div className="overflow-x-auto">
                        <table className="ui-data-table min-w-[1200px]">
                            <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                                <tr>
                                    <th className="px-2 py-2.5 text-left">Kode</th>
                                    <th className="px-2 py-2.5 text-left">Nama Salesman</th>
                                    <th className="px-2 py-2.5 text-left">Principal</th>
                                    <th className="px-2 py-2.5 text-left">Cabang</th>
                                    <th className="px-2 py-2.5 text-center">Ch</th>
                                    <th className="px-2 py-2.5 text-left">SPV</th>
                                    <th className="px-2 py-2.5 text-left">SM</th>
                                    <th className="px-2 py-2.5 text-right text-orange-300">Target Value (Rp)</th>
                                    <th className="px-2 py-2.5 text-right text-yellow-300">Target EC</th>
                                    <th className="px-2 py-2.5 text-right text-blue-300">Target AO</th>
                                    <th className="px-2 py-2.5 text-right text-violet-300">Target IA</th>
                                    <th className="px-2 py-2.5 text-right text-slate-400">SPLM Value</th>
                                    <th className="px-2 py-2.5 w-8"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/[0.07]">
                                {rows.map((r, i) => (
                                    <tr key={i} className="even:bg-white/[0.015] hover:bg-white/[0.04] transition-colors">
                                        <td className="px-2 py-2"><input className={inp} value={r.salesCode} onChange={(e) => setCell(i, "salesCode", e.target.value)} placeholder="SLS-001" /></td>
                                        <td className="px-2 py-2"><input className={inp + " min-w-[120px]"} value={r.salesName} onChange={(e) => setCell(i, "salesName", e.target.value)} placeholder="Nama Salesman" /></td>
                                        <td className="px-2 py-2">
                                            <select className={inp} value={r.principle} onChange={(e) => setCell(i, "principle", e.target.value)}>
                                                {PRINCIPLES.map((p) => <option key={p}>{p}</option>)}
                                            </select>
                                        </td>
                                        <td className="px-2 py-2">
                                            <select className={inp} value={r.branch} onChange={(e) => setCell(i, "branch", e.target.value)}>
                                                {BRANCHES.map((b) => <option key={b}>{b}</option>)}
                                            </select>
                                        </td>
                                        <td className="px-2 py-2 text-center">
                                            <select className={inp + " w-14 text-center"} value={r.channel} onChange={(e) => setCell(i, "channel", e.target.value)}>
                                                <option>TT</option><option>MT</option>
                                            </select>
                                        </td>
                                        <td className="px-2 py-2"><input className={inp} value={r.spvName} onChange={(e) => setCell(i, "spvName", e.target.value)} placeholder="Nama SPV" /></td>
                                        <td className="px-2 py-2"><input className={inp} value={r.smName} onChange={(e) => setCell(i, "smName", e.target.value)} placeholder="Nama SM" /></td>
                                        <td className="px-2 py-2"><input type="number" className={numInp} value={r.targetValue || ""} onChange={(e) => setCell(i, "targetValue", Number(e.target.value))} placeholder="0" /></td>
                                        <td className="px-2 py-2"><input type="number" className={numInp + " w-20"} value={r.targetEc || ""} onChange={(e) => setCell(i, "targetEc", Number(e.target.value))} placeholder="0" /></td>
                                        <td className="px-2 py-2"><input type="number" className={numInp + " w-20"} value={r.targetAo || ""} onChange={(e) => setCell(i, "targetAo", Number(e.target.value))} placeholder="0" /></td>
                                        <td className="px-2 py-2"><input type="number" className={numInp + " w-20"} value={r.targetIa || ""} onChange={(e) => setCell(i, "targetIa", Number(e.target.value))} placeholder="0" /></td>
                                        <td className="px-2 py-2"><input type="number" className={numInp} value={r.splmValue || ""} onChange={(e) => setCell(i, "splmValue", Number(e.target.value))} placeholder="0" /></td>
                                        <td className="px-2 py-2 text-center">
                                            <button onClick={() => removeRow(i)} className="text-slate-600 hover:text-rose-400 transition-colors p-1 rounded" title="Hapus baris">×</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="mt-3 flex items-center justify-between flex-wrap gap-3 border-t border-white/5 pt-3">
                        <button onClick={addRow} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 hover:bg-white/10 transition-colors">
                            + Tambah Baris
                        </button>
                        <button onClick={handleSave} disabled={saving || rows.length === 0}
                            className="btn-primary disabled:opacity-50 flex items-center gap-2">
                            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                            Simpan Semua Target
                        </button>
                    </div>
                </>
            ) : (
                <>
                    <div className="space-y-4">
                        <div className="bg-black/40 rounded-lg border border-white/10 p-6 text-center">
                            <p className="text-sm text-slate-400 mb-4">
                                Upload file Excel dengan format kolom sesuai template. Sistem akan validasi dan menyimpan ke database.
                            </p>
                            <div className="flex flex-col sm:flex-row items-center gap-3 justify-center">
                                <button
                                    onClick={downloadTemplate}
                                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:bg-white/10 transition-colors">
                                    <Download size={16} /> Download Template
                                </button>
                                <label className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600/40 border border-indigo-500/40 text-sm text-indigo-200 hover:bg-indigo-600/50 transition-colors cursor-pointer">
                                    {excelUploading ? (
                                        <>
                                            <Loader2 size={16} className="animate-spin" /> Uploading…
                                        </>
                                    ) : (
                                        <>
                                            <Upload size={16} /> Pilih File Excel
                                        </>
                                    )}
                                    <input
                                        type="file"
                                        accept=".xlsx,.xls"
                                        onChange={handleExcelUpload}
                                        disabled={excelUploading}
                                        className="hidden"
                                    />
                                </label>
                            </div>
                        </div>
                        <div className="bg-blue-900/20 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300">
                            <p className="font-semibold mb-1">📌 Panduan Format Excel:</p>
                            <ul className="list-disc list-inside space-y-0.5 text-blue-200/80">
                                <li>Header: Kode Salesman, Nama Salesman, Principal, Cabang, Channel, SPV, SM, Target Value (Rp), Target EC, Target AO, Target IA, SPLM Value</li>
                                <li>Principal: NESTLE, UNILEVER, INDOFOOD</li>
                                <li>Channel: TT atau MT</li>
                                <li>Nilai target harus angka (tanpa format Rp atau ribuan)</li>
                                <li>Baris pertama adalah header, data mulai dari baris kedua</li>
                            </ul>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

// ── Admin: input progress harian (manual atau upload CSV) ─────────────────
interface ManualProgressRow {
    salesCode: string;
    principle: string;
    branch: string;
    invoiceNumber: string;
    achievedValueDpp: number;
    achievedEc: number;
    achievedAo: number;
    achievedIa: number;
}
const EMPTY_PROGRESS_ROW: ManualProgressRow = {
    salesCode: "", principle: PRINCIPLES[0], branch: BRANCHES[0], invoiceNumber: "",
    achievedValueDpp: 0, achievedEc: 0, achievedAo: 0, achievedIa: 0,
};

function AdminView({ rows }: { rows: Salesman[] }) {
    const now = new Date();
    const [period, setPeriod] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
    const [progressMethod, setProgressMethod] = useState<"manual" | "excel">("manual");
    const [manualRows, setManualRows] = useState<ManualProgressRow[]>([{ ...EMPTY_PROGRESS_ROW }]);
    const [uploading, setUploading] = useState(false);
    const [savingManual, setSavingManual] = useState(false);

    function setManualCell<K extends keyof ManualProgressRow>(idx: number, key: K, val: ManualProgressRow[K]) {
        setManualRows((prev) => prev.map((r, i) => i === idx ? { ...r, [key]: val } : r));
    }
    function addManualRow() { setManualRows((prev) => [...prev, { ...EMPTY_PROGRESS_ROW }]); }
    function removeManualRow(idx: number) { setManualRows((prev) => prev.filter((_, i) => i !== idx)); }

    async function submitProgress(payload: unknown[]) {
        const res = await fetch("/api/insentif-sales/progress", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Server error");
        return data as { inserted: number };
    }

    async function handleSaveManual() {
        const valid = manualRows.filter((r) => r.salesCode.trim());
        if (valid.length === 0) { toast.error("Isi minimal 1 baris dengan Kode Salesman."); return; }
        setSavingManual(true);
        try {
            const [year, month] = period.split("-").map(Number);
            const payload = valid.map((r) => ({
                salesCode: r.salesCode.trim(),
                principle: r.principle,
                branch: r.branch,
                date: `${year}-${String(month).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
                periodMonth: month,
                periodYear: year,
                invoiceNumber: r.invoiceNumber.trim() || undefined,
                achievedValueDpp: r.achievedValueDpp,
                achievedEc: r.achievedEc,
                achievedAo: r.achievedAo,
                achievedIa: r.achievedIa,
            }));
            const data = await submitProgress(payload);
            toast.success(`${data.inserted} baris progress berhasil disimpan.`);
            setManualRows([{ ...EMPTY_PROGRESS_ROW }]);
        } catch (err) {
            toast.error(`Gagal simpan: ${err instanceof Error ? err.message : "Error"}`);
        } finally {
            setSavingManual(false);
        }
    }

    // Principal & Cabang dibaca PER BARIS dari kolom PRINCIPAL/JENISPRODUK di file —
    // bukan dipilih global, karena 1 file laporan penjualan bisa berisi banyak principal.
    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true);
        try {
            // Parse CSV client-side (comma or semicolon separated)
            const text = await file.text();
            const lines = text.trim().split(/\r?\n/);
            const headers = lines[0].split(/[,;]/).map((h) => h.trim().toUpperCase());
            const idx = (name: string) => headers.indexOf(name);

            const [year, month] = period.split("-").map(Number);
            const parsed = lines.slice(1).map((line) => {
                const cols = line.split(/[,;]/);
                const get = (name: string) => cols[idx(name)]?.trim() ?? "";
                return {
                    salesCode: get("KODE_SALESMAN"),
                    principle: get("PRINCIPAL"),
                    branch: get("JENISPRODUK"),
                    date: `${year}-${String(month).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
                    periodMonth: month,
                    periodYear: year,
                    invoiceNumber: get("NO_INVOICE") || undefined,
                    achievedValueDpp: parseFloat(get("DPP").replace(/\D/g, "")) || 0,
                    achievedEc: parseInt(get("EC")) || 0,
                    achievedAo: parseInt(get("AO")) || 0,
                    achievedIa: parseInt(get("IA")) || 0,
                };
            });
            const payload = parsed.filter((r) => r.salesCode && r.principle && r.branch);
            const skipped = parsed.length - payload.length;

            if (payload.length === 0) { toast.error("Tidak ada baris valid. Pastikan kolom KODE_SALESMAN, PRINCIPAL, dan JENISPRODUK terisi."); return; }

            const data = await submitProgress(payload);
            toast.success(`${data.inserted} baris diproses ke database.${skipped ? ` (${skipped} baris dilewati karena kolom wajib kosong)` : ""}`);
        } catch (err) {
            toast.error(`Gagal upload: ${err instanceof Error ? err.message : "Error tidak dikenal"}`);
        } finally {
            setUploading(false);
            e.target.value = "";
        }
    }

    const inp = "w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500 min-w-0";
    const numInp = inp + " text-right font-mono";

    return (
        <div className="space-y-5">
            <TargetInputSection />
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <SectionTitle icon={Upload} no={2} title="Input Progress Harian" desc="Principal dan cabang dibaca per baris. Satu file dapat berisi beberapa principal." />

                <div className="flex flex-wrap items-center gap-3 mb-4">
                    <Field label="Periode">
                        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500" />
                    </Field>
                </div>

                <div className="flex gap-2 mb-4 border-b border-white/10 pb-3">
                    <button
                        onClick={() => setProgressMethod("manual")}
                        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                            progressMethod === "manual"
                                ? "bg-indigo-600/40 text-indigo-200 border-b-2 border-indigo-500"
                                : "text-slate-400 hover:text-slate-300"
                        }`}>
                        📋 Input Manual
                    </button>
                    <button
                        onClick={() => setProgressMethod("excel")}
                        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
                            progressMethod === "excel"
                                ? "bg-indigo-600/40 text-indigo-200 border-b-2 border-indigo-500"
                                : "text-slate-400 hover:text-slate-300"
                        }`}>
                        📊 Upload Excel/CSV
                    </button>
                </div>

                {progressMethod === "manual" ? (
                    <>
                        <div className="overflow-x-auto">
                            <table className="ui-data-table min-w-[900px]">
                                <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                                    <tr>
                                        <th className="px-2 py-2.5 text-left">Kode Salesman</th>
                                        <th className="px-2 py-2.5 text-left">Principal</th>
                                        <th className="px-2 py-2.5 text-left">Cabang</th>
                                        <th className="px-2 py-2.5 text-left">No Invoice</th>
                                        <th className="px-2 py-2.5 text-right text-orange-300">DPP (Value)</th>
                                        <th className="px-2 py-2.5 text-right text-yellow-300">EC</th>
                                        <th className="px-2 py-2.5 text-right text-blue-300">AO</th>
                                        <th className="px-2 py-2.5 text-right text-violet-300">IA</th>
                                        <th className="px-2 py-2.5 w-8"></th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/[0.07]">
                                    {manualRows.map((r, i) => (
                                        <tr key={i} className="even:bg-white/[0.015] hover:bg-white/[0.04] transition-colors">
                                            <td className="px-2 py-2"><input className={inp} value={r.salesCode} onChange={(e) => setManualCell(i, "salesCode", e.target.value)} placeholder="SLS-001" /></td>
                                            <td className="px-2 py-2">
                                                <select className={inp} value={r.principle} onChange={(e) => setManualCell(i, "principle", e.target.value)}>
                                                    {PRINCIPLES.map((p) => <option key={p}>{p}</option>)}
                                                </select>
                                            </td>
                                            <td className="px-2 py-2">
                                                <select className={inp} value={r.branch} onChange={(e) => setManualCell(i, "branch", e.target.value)}>
                                                    {BRANCHES.map((b) => <option key={b}>{b}</option>)}
                                                </select>
                                            </td>
                                            <td className="px-2 py-2"><input className={inp} value={r.invoiceNumber} onChange={(e) => setManualCell(i, "invoiceNumber", e.target.value)} placeholder="opsional" /></td>
                                            <td className="px-2 py-2"><input type="number" className={numInp} value={r.achievedValueDpp || ""} onChange={(e) => setManualCell(i, "achievedValueDpp", Number(e.target.value))} placeholder="0" /></td>
                                            <td className="px-2 py-2"><input type="number" className={numInp + " w-16"} value={r.achievedEc || ""} onChange={(e) => setManualCell(i, "achievedEc", Number(e.target.value))} placeholder="0" /></td>
                                            <td className="px-2 py-2"><input type="number" className={numInp + " w-16"} value={r.achievedAo || ""} onChange={(e) => setManualCell(i, "achievedAo", Number(e.target.value))} placeholder="0" /></td>
                                            <td className="px-2 py-2"><input type="number" className={numInp + " w-16"} value={r.achievedIa || ""} onChange={(e) => setManualCell(i, "achievedIa", Number(e.target.value))} placeholder="0" /></td>
                                            <td className="px-2 py-2 text-center">
                                                <button onClick={() => removeManualRow(i)} className="text-slate-600 hover:text-rose-400 transition-colors p-1 rounded" title="Hapus baris">×</button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="mt-3 flex items-center justify-between flex-wrap gap-3 border-t border-white/5 pt-3">
                            <button onClick={addManualRow} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 hover:bg-white/10 transition-colors">
                                + Tambah Baris
                            </button>
                            <button onClick={handleSaveManual} disabled={savingManual || manualRows.length === 0}
                                className="btn-primary disabled:opacity-50 flex items-center gap-2">
                                {savingManual ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                                Simpan Progress
                            </button>
                        </div>
                    </>
                ) : (
                    <label className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-10 cursor-pointer transition-colors ${uploading ? "border-indigo-500/60 bg-indigo-500/[0.04]" : "border-white/15 hover:border-indigo-500/40 hover:bg-white/[0.02]"}`}>
                        {uploading ? <Loader2 className="text-indigo-400 animate-spin" size={28} /> : <FileUp className="text-indigo-400" size={28} />}
                        <span className="text-sm font-semibold text-slate-200">{uploading ? "Memproses…" : "Unggah CSV Laporan Penjualan Harian"}</span>
                        <span className="text-[11px] text-slate-500 text-center px-4">Kolom: KODE_SALESMAN, PRINCIPAL, JENISPRODUK, DPP, AO, EC, IA (+ NO_INVOICE opsional)</span>
                        <input type="file" accept=".csv" className="hidden" disabled={uploading} onChange={handleUpload} />
                    </label>
                )}
            </div>
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <SectionTitle icon={Target} no={3} title="Preview Salesman Terdaftar" desc="Data database untuk periode saat ini" />
                <div className="overflow-x-auto">
                    <table className="ui-data-table min-w-[760px]">
                        <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                            <tr>
                                <th className="px-3 py-3">KODE_SALESMAN</th>
                                <th className="px-3 py-3">PRINCIPAL</th>
                                <th className="px-3 py-3">CABANG</th>
                                <th className="px-3 py-3 text-right">Target Value</th>
                                <th className="px-3 py-3 text-right">Real Value</th>
                                <th className="px-3 py-3 text-right">AO</th>
                                <th className="px-3 py-3 text-right">EC</th>
                                <th className="px-3 py-3 text-right">IA</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.1]">
                            {rows.map((r) => (
                                <tr key={r.code} className="even:bg-white/[0.025] hover:bg-white/[0.05] transition-colors">
                                    <td className="px-3 py-3 font-mono text-slate-300">{r.code}</td>
                                    <td className="px-3 py-3 text-slate-300">{r.principle}</td>
                                    <td className="px-3 py-3 text-slate-300">{r.branch}</td>
                                    <td className="px-3 py-3 text-right font-mono text-slate-400">{formatShortRp(r.targetValue)}</td>
                                    <td className="px-3 py-3 text-right font-mono text-slate-200">{formatShortRp(r.realValue)}</td>
                                    <td className="px-3 py-3 text-right font-mono text-slate-300">{r.realAo}</td>
                                    <td className="px-3 py-3 text-right font-mono text-slate-300">{r.realEc}</td>
                                    <td className="px-3 py-3 text-right font-mono text-slate-300">{r.realIa}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
            <HierarchyAssignmentSection />
        </div>
    );
}

// ── Kelola Hierarki (Bagian C) — assignment additive; blok Link Akun mengaktifkan
// scoping "SPV/SM cuma lihat bawahan sendiri" secara opt-in per user ──────────────
interface SpvSalesAssignmentRow { id: string; salesCode: string; spvName: string; }
interface SmSpvAssignmentRow { id: string; spvName: string; smName: string; }
interface UserIdentityRow { id: string; name: string; email: string; hierarchyRole: "spv" | "sm" | null; hierarchyName: string | null; }
interface MyIdentity { identity: { role: "spv" | "sm"; name: string } | null; isAdmin: boolean; }
interface ClaimRequestRow { id: string; salesCode: string; requestedBySpvName: string; previousSpvName: string | null; }

function HierarchyAssignmentSection() {
    const [spvSales, setSpvSales] = useState<SpvSalesAssignmentRow[]>([]);
    const [smSpv, setSmSpv] = useState<SmSpvAssignmentRow[]>([]);
    const [users, setUsers] = useState<UserIdentityRow[]>([]);
    const [myIdentity, setMyIdentity] = useState<MyIdentity | null>(null);
    const [pendingRequests, setPendingRequests] = useState<ClaimRequestRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [newSalesCode, setNewSalesCode] = useState("");
    const [newSpvName, setNewSpvName] = useState("");
    const [newSpvName2, setNewSpvName2] = useState("");
    const [newSmName, setNewSmName] = useState("");
    const [selUserId, setSelUserId] = useState("");
    const [selRole, setSelRole] = useState<"spv" | "sm">("spv");
    const [selName, setSelName] = useState("");
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [r1, r2, r3, r4] = await Promise.all([
                fetch("/api/insentif-sales/hierarchy/spv-sales"),
                fetch("/api/insentif-sales/hierarchy/sm-spv"),
                fetch("/api/insentif-sales/hierarchy/user-identity"),
                fetch("/api/insentif-sales/hierarchy/my-identity"),
            ]);
            setSpvSales(r1.ok ? ((await r1.json()).rows ?? []) : []);
            setSmSpv(r2.ok ? ((await r2.json()).rows ?? []) : []);
            setUsers(r3.ok ? ((await r3.json()).users ?? []) : []);
            const mine: MyIdentity = r4.ok ? await r4.json() : { identity: null, isAdmin: false };
            setMyIdentity(mine);
            if (mine.isAdmin) {
                const r5 = await fetch("/api/insentif-sales/hierarchy/spv-sales/requests");
                setPendingRequests(r5.ok ? ((await r5.json()).rows ?? []) : []);
            }
        } catch {
            toast.error("Gagal memuat data hierarki.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    async function decideRequest(id: string, decision: "approve" | "reject") {
        try {
            const res = await fetch("/api/insentif-sales/hierarchy/spv-sales/requests", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requestId: id, decision }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal proses");
            toast.success(decision === "approve" ? "Klaim disetujui." : "Klaim ditolak.");
            load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Gagal proses");
        }
    }

    async function linkIdentity() {
        if (!selUserId || !selName.trim()) { toast.error("Pilih user & isi nama identitas."); return; }
        setSaving(true);
        try {
            const res = await fetch("/api/insentif-sales/hierarchy/user-identity", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: selUserId, hierarchyRole: selRole, hierarchyName: selName.trim() }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal simpan");
            toast.success("Identitas tersimpan. Pembatasan akses aktif untuk pengguna ini.");
            setSelUserId(""); setSelName("");
            load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Gagal simpan");
        } finally {
            setSaving(false);
        }
    }

    async function unlinkIdentity(userId: string) {
        try {
            const res = await fetch("/api/insentif-sales/hierarchy/user-identity", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId, hierarchyRole: null, hierarchyName: null }),
            });
            if (!res.ok) throw new Error();
            toast.success("Pembatasan akses dicabut. Pengguna kembali melihat semua data.");
            load();
        } catch {
            toast.error("Gagal cabut identitas.");
        }
    }

    async function addSpvSales() {
        const isSelfService = !myIdentity?.isAdmin;
        if (!newSalesCode.trim() || (!isSelfService && !newSpvName.trim())) {
            toast.error(isSelfService ? "Kode Sales wajib diisi." : "Kode Sales & Nama SPV wajib diisi.");
            return;
        }
        setSaving(true);
        try {
            const res = await fetch("/api/insentif-sales/hierarchy/spv-sales", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ salesCode: newSalesCode.trim(), spvName: newSpvName.trim() }),
            });
            const data = await res.json();
            if (res.status === 202) {
                toast.info(`Salesman ${newSalesCode.trim()} sudah ditangani SPV lain. Permintaan klaim dikirim untuk persetujuan admin.`);
                setNewSalesCode(""); setNewSpvName("");
                return;
            }
            if (!res.ok) throw new Error(data.error ?? "Gagal simpan");
            toast.success(isSelfService ? "Salesman berhasil ditambahkan ke tim Anda." : "Assignment Sales → SPV tersimpan.");
            setNewSalesCode(""); setNewSpvName("");
            load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Gagal simpan");
        } finally {
            setSaving(false);
        }
    }

    async function removeSpvSales(id: string) {
        try {
            const res = await fetch(`/api/insentif-sales/hierarchy/spv-sales?id=${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error();
            load();
        } catch {
            toast.error("Gagal hapus assignment.");
        }
    }

    async function addSmSpv() {
        if (!newSpvName2.trim() || !newSmName.trim()) { toast.error("Nama SPV & Nama SM wajib diisi."); return; }
        setSaving(true);
        try {
            const res = await fetch("/api/insentif-sales/hierarchy/sm-spv", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ spvName: newSpvName2.trim(), smName: newSmName.trim() }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal simpan");
            toast.success("Assignment SPV → SM tersimpan.");
            setNewSpvName2(""); setNewSmName("");
            load();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Gagal simpan");
        } finally {
            setSaving(false);
        }
    }

    async function removeSmSpv(id: string) {
        try {
            const res = await fetch(`/api/insentif-sales/hierarchy/sm-spv?id=${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error();
            load();
        } catch {
            toast.error("Gagal hapus assignment.");
        }
    }

    const inputCls = "flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500";
    const isAdmin = !!myIdentity?.isAdmin;
    const isSpvSelf = !isAdmin && myIdentity?.identity?.role === "spv";

    if (!loading && !isAdmin && !isSpvSelf) return null; // tidak relevan utk role ini (mis. SM, viewer)

    if (isSpvSelf) {
        return (
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <SectionTitle icon={Users} no={4} title="Tambahkan Salesman ke Tim Saya" desc={`Sebagai SPV "${myIdentity?.identity?.name}", salesman baru langsung masuk tim Anda. Jika sudah ditangani SPV lain, permintaan klaim dikirim ke admin.`} />
                <div className="flex gap-2 mb-3 max-w-md">
                    <input className={inputCls} placeholder="Kode Sales" value={newSalesCode} onChange={(e) => setNewSalesCode(e.target.value)} />
                    <button onClick={addSpvSales} disabled={saving} className="px-3 py-1.5 rounded bg-indigo-600/40 border border-indigo-500/40 text-indigo-200 text-xs disabled:opacity-50 shrink-0">+ Tambah</button>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={Users} no={4} title="Kelola Hierarki" desc="Assignment Sales → SPV → SM dipakai untuk pengelompokan insentif. Pembatasan akses hanya aktif untuk akun yang ditautkan." />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-3">
                <div>
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Sales → SPV</div>
                    <div className="flex gap-2 mb-3">
                        <input className={inputCls} placeholder="Kode Sales" value={newSalesCode} onChange={(e) => setNewSalesCode(e.target.value)} />
                        <input className={inputCls} placeholder="Nama SPV" value={newSpvName} onChange={(e) => setNewSpvName(e.target.value)} />
                        <button onClick={addSpvSales} disabled={saving} className="px-3 py-1.5 rounded bg-indigo-600/40 border border-indigo-500/40 text-indigo-200 text-xs disabled:opacity-50 shrink-0">+ Tambah</button>
                    </div>
                    <div className="max-h-60 overflow-y-auto border border-white/10 rounded-lg divide-y divide-white/5">
                        {loading ? <div className="p-3 text-xs text-slate-500">Memuat…</div> : spvSales.length === 0 ? (
                            <div className="p-3 text-xs text-slate-500 italic">Belum ada assignment.</div>
                        ) : spvSales.map((r) => (
                            <div key={r.id} className="flex items-center justify-between px-3 py-2 text-xs">
                                <span className="text-slate-300">{r.salesCode} → <span className="text-indigo-300">{r.spvName}</span></span>
                                <button onClick={() => removeSpvSales(r.id)} className="text-slate-600 hover:text-rose-400" title="Hapus">×</button>
                            </div>
                        ))}
                    </div>
                </div>
                <div>
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">SPV → SM</div>
                    <div className="flex gap-2 mb-3">
                        <input className={inputCls} placeholder="Nama SPV" value={newSpvName2} onChange={(e) => setNewSpvName2(e.target.value)} />
                        <input className={inputCls} placeholder="Nama SM" value={newSmName} onChange={(e) => setNewSmName(e.target.value)} />
                        <button onClick={addSmSpv} disabled={saving} className="px-3 py-1.5 rounded bg-indigo-600/40 border border-indigo-500/40 text-indigo-200 text-xs disabled:opacity-50 shrink-0">+ Tambah</button>
                    </div>
                    <div className="max-h-60 overflow-y-auto border border-white/10 rounded-lg divide-y divide-white/5">
                        {loading ? <div className="p-3 text-xs text-slate-500">Memuat…</div> : smSpv.length === 0 ? (
                            <div className="p-3 text-xs text-slate-500 italic">Belum ada assignment.</div>
                        ) : smSpv.map((r) => (
                            <div key={r.id} className="flex items-center justify-between px-3 py-2 text-xs">
                                <span className="text-slate-300">{r.spvName} → <span className="text-indigo-300">{r.smName}</span></span>
                                <button onClick={() => removeSmSpv(r.id)} className="text-slate-600 hover:text-rose-400" title="Hapus">×</button>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            <div className="mt-6 pt-6 border-t border-white/10">
                <div className="text-xs font-semibold text-orange-400 uppercase tracking-wider mb-2">Permintaan Klaim Tertunda (Rolling)</div>
                <div className="max-h-48 overflow-y-auto border border-white/10 rounded-lg divide-y divide-white/5">
                    {pendingRequests.length === 0 ? (
                        <div className="p-3 text-xs text-slate-500 italic">Tidak ada permintaan tertunda.</div>
                    ) : pendingRequests.map((r) => (
                        <div key={r.id} className="flex items-center justify-between px-3 py-2 text-xs gap-2">
                            <span className="text-slate-300">
                                <span className="font-mono">{r.salesCode}</span>: <span className="text-slate-500">{r.previousSpvName}</span> → <span className="text-indigo-300">{r.requestedBySpvName}</span>
                            </span>
                            <div className="flex gap-1 shrink-0">
                                <button onClick={() => decideRequest(r.id, "approve")} className="px-2 py-1 rounded bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-[11px]">Setuju</button>
                                <button onClick={() => decideRequest(r.id, "reject")} className="px-2 py-1 rounded bg-rose-600/30 border border-rose-500/40 text-rose-300 text-[11px]">Tolak</button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
            <div className="mt-6 pt-6 border-t border-white/10">
                <div className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-1">⚠ Link Akun Login → Identitas SPV/SM (Scoping Akses)</div>
                <p className="text-[11px] text-slate-500 mb-3">Setelah di-link, user ini HANYA lihat data timnya sendiri di Dashboard Sales/SPV/SM. Cabut untuk kembalikan ke lihat-semua (default).</p>
                <div className="flex flex-wrap gap-2 mb-3">
                    <select className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-500 w-56" value={selUserId} onChange={(e) => setSelUserId(e.target.value)}>
                        <option value="">Pilih pengguna</option>
                        {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                    </select>
                    <select className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-500 w-24" value={selRole} onChange={(e) => setSelRole(e.target.value as "spv" | "sm")}>
                        <option value="spv">SPV</option>
                        <option value="sm">SM</option>
                    </select>
                    <input className={inputCls} placeholder="Nama identitas (persis spv_name/sm_name)" value={selName} onChange={(e) => setSelName(e.target.value)} />
                    <button onClick={linkIdentity} disabled={saving} className="px-3 py-1.5 rounded bg-amber-600/40 border border-amber-500/40 text-amber-200 text-xs disabled:opacity-50 shrink-0">+ Link</button>
                </div>
                <div className="max-h-48 overflow-y-auto border border-white/10 rounded-lg divide-y divide-white/5">
                    {loading ? <div className="p-3 text-xs text-slate-500">Memuat…</div> : users.filter((u) => u.hierarchyRole).length === 0 ? (
                        <div className="p-3 text-xs text-slate-500 italic">Belum ada pengguna yang dibatasi. Secara default semua pengguna melihat semua data.</div>
                    ) : users.filter((u) => u.hierarchyRole).map((u) => (
                        <div key={u.id} className="flex items-center justify-between px-3 py-2 text-xs">
                            <span className="text-slate-300">{u.name}: <span className="text-amber-300 uppercase">{u.hierarchyRole}</span> <span className="text-indigo-300">{u.hierarchyName}</span></span>
                            <button onClick={() => unlinkIdentity(u.id)} className="text-slate-600 hover:text-rose-400" title="Cabut scoping">×</button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <label className="block text-[11px] font-semibold text-slate-400 mb-1.5 uppercase tracking-wider">{label}</label>
            {children}
        </div>
    );
}

// ── Finance View — fetch payments API + PATCH mark lunas ──────────────────
// ── Finance: input support principle per salesman (channel GT) ────────────────
function SupportInputSection({ apiRows, month, year, onSaved }: { apiRows: ApiRow[]; month: number; year: number; onSaved?: () => void }) {
    const gtRows = useMemo(() => apiRows.filter((r) => r.channel === "GT"), [apiRows]);
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);

    const keyOf = (r: ApiRow) => `${r.salesCode}|${r.principle}`;
    const valueOf = (r: ApiRow) => draft[keyOf(r)] ?? String(r.support ?? 0);

    async function save() {
        setSaving(true);
        try {
            const payload = gtRows.map((r) => ({
                salesCode: r.salesCode, principle: r.principle,
                periodMonth: month, periodYear: year,
                supportAmount: Number(valueOf(r)) || 0,
            }));
            const res = await fetch("/api/insentif-sales/support", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal simpan support");
            toast.success(`Support tersimpan (${data.upserted} baris). Insentif dihitung ulang.`);
            setDraft({});
            onSaved?.();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal simpan support");
        }
        setSaving(false);
    }

    if (gtRows.length === 0) return null;

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={DollarSign} no={0} title="Input Support Principle (GT)" desc="Support principal per salesman mengurangi konstanta insentif." />
            <div className="overflow-x-auto mt-3">
                <table className="ui-data-table">
                    <thead>
                        <tr className="text-left text-slate-400 border-b border-white/10">
                            <th className="px-3 py-2">Kode</th>
                            <th className="px-3 py-2">Nama</th>
                            <th className="px-3 py-2">Principal</th>
                            <th className="px-3 py-2">Tipe / Status</th>
                            <th className="px-3 py-2 text-right">Support (Rp)</th>
                            <th className="px-3 py-2 text-right">Insentif</th>
                        </tr>
                    </thead>
                    <tbody>
                        {gtRows.map((r) => (
                            <tr key={keyOf(r)} className="border-b border-white/5">
                                <td className="px-3 py-2 font-mono text-slate-300">{r.salesCode}</td>
                                <td className="px-3 py-2 text-slate-300">{r.salesName}</td>
                                <td className="px-3 py-2 text-slate-300">{r.principle}</td>
                                <td className="px-3 py-2 text-xs text-slate-500">{r.tipeSales ?? "-"} / {r.statusInsentif ?? "-"}</td>
                                <td className="px-3 py-2 text-right">
                                    <input
                                        type="number" min={0}
                                        value={valueOf(r)}
                                        onChange={(e) => setDraft((p) => ({ ...p, [keyOf(r)]: e.target.value }))}
                                        className="w-32 bg-[#11131a] border border-white/10 rounded px-2 py-1 text-right font-mono text-slate-200"
                                    />
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-amber-400">{formatRp(r.incentive.total)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="flex justify-end mt-3">
                <button onClick={save} disabled={saving}
                    className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium">
                    {saving ? "Menyimpan…" : "Simpan Support & Hitung Ulang"}
                </button>
            </div>
        </div>
    );
}

function FinanceView({ apiRows, month, year, onSaved }: { apiRows: ApiRow[]; month: number; year: number; onSaved?: () => void }) {
    const [payments, setPayments] = useState<PaymentRow[]>([]);
    const [selectedMonth, setSelectedMonth] = useState(month);
    const [saving, setSaving] = useState(false);
    const [checked, setChecked] = useState<Record<string, boolean>>({});
    const [paymentsLoading, setPaymentsLoading] = useState(true);
    const [paymentsError, setPaymentsError] = useState("");

    // Fetch 12-month payment summary. Manual callback for refresh button + post-save reload.
    const fetchPayments = useCallback(async () => {
        setPaymentsLoading(true);
        setPaymentsError("");
        try {
            const res = await fetch(`/api/insentif-sales/payments?year=${year}`);
            if (!res.ok) throw new Error("Data pembayaran belum berhasil dimuat.");
            const data = await res.json();
            setPayments(data.rows ?? []);
        } catch (error) {
            setPaymentsError(
                error instanceof Error
                    ? error.message
                    : "Data pembayaran belum berhasil dimuat.",
            );
        } finally {
            setPaymentsLoading(false);
        }
    }, [year]);

    // Inline fetch on year change — kept separate from fetchPayments to avoid
    // the set-state-in-effect lint rule that fires when an effect calls a setState-bearing callback.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setPaymentsLoading(true);
            setPaymentsError("");
            try {
                const res = await fetch(`/api/insentif-sales/payments?year=${year}`);
                if (!res.ok) throw new Error("Data pembayaran belum berhasil dimuat.");
                const data = await res.json();
                if (!cancelled) setPayments(data.rows ?? []);
            } catch (error) {
                if (!cancelled) {
                    setPaymentsError(
                        error instanceof Error
                            ? error.message
                            : "Data pembayaran belum berhasil dimuat.",
                    );
                }
            } finally {
                if (!cancelled) setPaymentsLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [year]);

    // Build monthly summary from payments rows
    const monthlySummary = useMemo(() => {
        return Array.from({ length: 12 }, (_, i) => {
            const m = i + 1;
            const monthPayments = payments.filter((p) => p.periodMonth === m);
            const total = monthPayments.reduce((a, p) => a + p.totalIncentive, 0);
            const hasLunas = monthPayments.some((p) => p.paymentStatus === "lunas");
            const hasTunggakan = monthPayments.some((p) => p.paymentStatus === "tunggakan");
            const status: "lunas" | "tunggakan" | "belum" =
                monthPayments.length === 0 ? "belum"
                    : hasTunggakan ? "tunggakan"
                        : hasLunas ? "lunas"
                            : "belum";
            return { month: m, label: MONTH_LABELS[i], total, status };
        });
    }, [payments]);

    // Per-salesman table for selected month — merge apiRows (current month) with payments
    const detailRows = useMemo(() => {
        if (selectedMonth === month) {
            return apiRows.map((r) => {
                const pay = payments.find((p) => p.salesCode === r.salesCode && p.principle === r.principle && p.periodMonth === selectedMonth);
                return { salesCode: r.salesCode, salesName: r.salesName, principle: r.principle, total: r.incentive.total, paymentId: pay?.id ?? null, status: (pay?.paymentStatus ?? r.paymentStatus) as string };
            });
        }
        return payments
            .filter((p) => p.periodMonth === selectedMonth)
            .map((p) => ({ salesCode: p.salesCode, salesName: p.salesName, principle: p.principle, total: p.totalIncentive, paymentId: p.id, status: p.paymentStatus }));
    }, [selectedMonth, month, apiRows, payments]);

    const toggle = (row: { salesCode: string; principle: string }) => {
        const key = paymentSelectionKey(row);
        setChecked((current) => ({ ...current, [key]: !current[key] }));
    };
    const checkedList = detailRows.filter((row) => checked[paymentSelectionKey(row)]);

    async function handleMarkLunas() {
        if (checkedList.length === 0) return;
        setSaving(true);
        try {
            const results = await Promise.allSettled(
                checkedList.map(async (row) => {
                // Upsert payment record dulu jika belum ada
                if (!row.paymentId) {
                    const upsertRes = await fetch("/api/insentif-sales/payments", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            salesCode: row.salesCode,
                            salesName: row.salesName,
                            principle: row.principle,
                            branch: "",
                            periodMonth: selectedMonth,
                            periodYear: year,
                            totalIncentive: row.total,
                            paymentStatus: "lunas",
                        }),
                    });
                    if (!upsertRes.ok) throw new Error("Gagal membuat status pembayaran.");
                } else {
                    const patchRes = await fetch(`/api/insentif-sales/payments/${row.paymentId}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ paymentStatus: "lunas" }),
                    });
                    if (!patchRes.ok) throw new Error("Gagal memperbarui status pembayaran.");
                }
                return paymentSelectionKey(row);
            }),
            );
            const succeededKeys = new Set(
                results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
            );
            const failedCount = results.length - succeededKeys.size;
            setChecked((current) => {
                const next = { ...current };
                succeededKeys.forEach((key) => delete next[key]);
                return next;
            });

            if (failedCount === 0) {
                toast.success(`${succeededKeys.size} pembayaran ditandai lunas.`);
            } else if (succeededKeys.size === 0) {
                toast.error(`Semua ${failedCount} pembayaran gagal diperbarui. Pilihan tetap dipertahankan.`);
            } else {
                toast.warning(`${succeededKeys.size} pembayaran berhasil, ${failedCount} gagal. Pilihan yang gagal tetap dipertahankan.`);
            }
            await fetchPayments();
        } finally {
            setSaving(false);
        }
    }

    const statusClasses = { lunas: "border-emerald-500/30 text-emerald-400", tunggakan: "border-rose-500/40 text-rose-400", belum: "border-white/10 text-slate-500" };

    if (paymentsLoading) {
        return (
            <div className="space-y-5">
                <SupportInputSection apiRows={apiRows} month={month} year={year} onSaved={onSaved} />
                <LoadingState label="Memuat status pembayaran" rows={3} />
            </div>
        );
    }

    if (paymentsError) {
        return (
            <div className="space-y-5">
                <SupportInputSection apiRows={apiRows} month={month} year={year} onSaved={onSaved} />
                <ErrorState
                    title={paymentsError}
                    message="Status belum ditampilkan agar kegagalan tidak terlihat sebagai belum dibayar."
                    onAction={() => void fetchPayments()}
                />
            </div>
        );
    }

    return (
        <div className="space-y-5">
            {/* Support principle GT — diisi Finance saat payout */}
            <SupportInputSection apiRows={apiRows} month={month} year={year} onSaved={onSaved} />
            {/* 12-month strip */}
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <SectionTitle icon={DollarSign} no={1} title="Rekap Pembayaran Tahunan" desc="Data 12 bulan dari database dengan indikator tunggakan aktual" />
                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                    {monthlySummary.map((m) => {
                        const active = m.month === selectedMonth;
                        const tone = statusClasses[m.status];
                        return (
                            <button key={m.month} onClick={() => setSelectedMonth(m.month)}
                                className={`rounded-lg border p-3 text-left transition-all ${tone} ${active ? "bg-indigo-500/10 ring-1 ring-indigo-500/40" : "bg-black/30 hover:bg-white/[0.03]"}`}>
                                <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-bold text-slate-300">{m.label.slice(0, 3)}</span>
                                    {m.status === "tunggakan" && <AlertTriangle size={13} className="text-rose-400" />}
                                    {m.status === "lunas" && <CheckCircle2 size={13} className="text-emerald-400" />}
                                </div>
                                <div className="text-[11px] font-mono mt-1 text-slate-400">{m.total ? formatShortRp(m.total) : "-"}</div>
                                <div className="text-[9px] uppercase tracking-wider mt-0.5 font-bold">{m.status}</div>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Detail per-salesman */}
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <div className="flex items-center justify-between mb-4">
                    <SectionTitle icon={Wallet} no={2} title={`Tabel Insentif: ${MONTH_LABELS[selectedMonth - 1]} ${year}`} desc="Centang lalu simpan sebagai lunas. Perubahan langsung dicatat ke database." />
                    <button onClick={fetchPayments} className="text-slate-500 hover:text-slate-300 transition-colors p-1.5 rounded-lg hover:bg-white/5">
                        <RefreshCw size={14} />
                    </button>
                </div>
                <div className="overflow-x-auto">
                    <table className="ui-data-table min-w-[820px]">
                        <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                            <tr>
                                <th className="px-3 py-3 w-10"></th>
                                <th className="px-3 py-3">Salesman</th>
                                <th className="px-3 py-3">Principle</th>
                                <th className="px-3 py-3 text-right">Total Insentif</th>
                                <th className="px-3 py-3">Bukti Bayar</th>
                                <th className="px-3 py-3 text-center">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.1]">
                            {detailRows.map((r) => {
                                const selectionKey = paymentSelectionKey(r);
                                const isChecked = !!checked[selectionKey];
                                const sc = r.status === "lunas" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                    : r.status === "tunggakan" ? "bg-rose-500/10 text-rose-400 border-rose-500/30"
                                        : "bg-white/5 text-slate-500 border-white/10";
                                const slabel = r.status === "lunas" ? "Lunas" : r.status === "tunggakan" ? "Tunggakan" : "Belum";
                                return (
                                    <tr key={selectionKey} className={`transition-colors hover:bg-white/[0.05] ${isChecked ? "bg-emerald-500/[0.07]" : "even:bg-white/[0.025]"}`}>
                                        <td className="px-3 py-3">
                                            <input type="checkbox" checked={isChecked} onChange={() => toggle(r)} className="w-4 h-4 accent-emerald-500 cursor-pointer" />
                                        </td>
                                        <td className="px-3 py-3">
                                            <div className="font-semibold text-slate-200">{r.salesName}</div>
                                            <div className="text-[10px] text-slate-500 font-mono">{r.salesCode}</div>
                                        </td>
                                        <td className="px-3 py-3 text-slate-300">{r.principle}</td>
                                        <td className="px-3 py-3 text-right font-mono font-bold text-amber-400">{formatRp(r.total)}</td>
                                        <td className="px-3 py-3">
                                            <label className="inline-flex items-center gap-2 bg-white/5 border border-white/10 rounded px-2 py-1.5 text-slate-300 cursor-pointer hover:bg-white/10 text-[11px]">
                                                <FileUp size={13} /> Upload
                                                <input type="file" className="hidden" accept=".pdf,.jpg,.png"
                                                    onChange={() => toast.info("Fitur upload bukti belum tersedia. Hubungkan aplikasi ke penyimpanan berkas.")} />
                                            </label>
                                        </td>
                                        <td className="px-3 py-3 text-center">
                                            <span className={`inline-flex items-center gap-1 px-2 py-1 rounded border font-bold text-[10px] ${isChecked ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : sc}`}>
                                                {isChecked ? "Akan Dibayar" : slabel}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                            {detailRows.length === 0 && (
                                <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500 italic">Belum ada data untuk bulan ini.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
                <div className="mt-4 flex items-center justify-between flex-wrap gap-3 border-t border-white/5 pt-4">
                    <span className="text-xs text-slate-400">
                        {checkedList.length} salesman dipilih · Total: <span className="font-mono font-bold text-amber-400">{formatRp(checkedList.reduce((a, r) => a + r.total, 0))}</span>
                    </span>
                    <button disabled={checkedList.length === 0 || saving} onClick={handleMarkLunas}
                        className="btn-primary disabled:opacity-50 flex items-center gap-2">
                        {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                        Simpan Status Lunas
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── Page shell ─────────────────────────────────────────────────────────────
export default function InsentifSalesPage() {
    const now = new Date();
    const [apiRows, setApiRows] = useState<ApiRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [dashboardError, setDashboardError] = useState("");
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const requestedMonth = Number(searchParams.get("month"));
    const requestedYear = Number(searchParams.get("year"));
    const month = Number.isInteger(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12
        ? requestedMonth : now.getMonth() + 1;
    const year = Number.isInteger(requestedYear) && requestedYear >= 2020 && requestedYear <= 2100
        ? requestedYear : now.getFullYear();
    const requestedView = searchParams.get("view") as ViewKey | null;
    const view = VIEWS.some((item) => item.key === requestedView) ? requestedView! : "sales";
    const principle = searchParams.get("principle") || "ALL";
    const branch = searchParams.get("branch") || "ALL";

    const updateContext = useCallback((updates: Partial<{ view: ViewKey; principle: string; branch: string; month: string; year: string }>) => {
        const params = new URLSearchParams(searchParams.toString());
        for (const [key, value] of Object.entries(updates)) {
            if (!value || value === "ALL") params.delete(key);
            else params.set(key, value);
        }
        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }, [pathname, router, searchParams]);

    const tg = getPeriodWorkdayProgress(year, month, now);

    const fetchDashboard = useCallback(async () => {
        setLoading(true);
        setDashboardError("");
        try {
            const params = new URLSearchParams();
            if (principle !== "ALL") params.set("principle", principle);
            if (branch !== "ALL") params.set("branch", branch);
            params.set("month", String(month));
            params.set("year", String(year));
            const res = await fetch(`/api/insentif-sales/dashboard?${params}`);
            if (!res.ok) throw new Error("Data insentif belum berhasil dimuat.");
            const data = await res.json();
            setApiRows(data.rows as ApiRow[]);
        } catch (error) {
            setApiRows([]);
            setDashboardError(
                error instanceof Error
                    ? error.message
                    : "Data insentif belum berhasil dimuat.",
            );
        } finally {
            setLoading(false);
        }
    }, [principle, branch, month, year]);

    useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

    const salesmen = useMemo(() => apiRows.map(apiRowToSalesman), [apiRows]);
    const showFilters = view !== "admin";

    const handleViewKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex = index;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % VIEWS.length;
        else if (event.key === "ArrowLeft") nextIndex = (index - 1 + VIEWS.length) % VIEWS.length;
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = VIEWS.length - 1;
        else return;

        event.preventDefault();
        const nextView = VIEWS[nextIndex];
        updateContext({ view: nextView.key });
        requestAnimationFrame(() => document.getElementById(`insentif-tab-${nextView.key}`)?.focus());
    };

    return (
        <div className="ui-page-shell ui-page-shell--wide">
            {/* Header */}
            <div className="ui-page-header">
                <div className="ui-page-heading">
                    <h1 className="ui-page-title">
                        <Trophy className="text-amber-400" />
                        Insentif Sales
                    </h1>
                    <p className="ui-page-description">Pantau performa, progres waktu kerja, dan insentif berdasarkan data server.</p>
                </div>
                <div className="ui-context-card">
                    <Clock className="text-indigo-400 shrink-0" size={22} />
                    <div className="flex-1">
                        <div className="flex items-center justify-between text-[11px] text-slate-400 font-semibold uppercase tracking-wider">
                            <span>Time Gone</span><span className="text-indigo-300">{tg.pct}%</span>
                        </div>
                        <div className="h-2 mt-1.5 bg-black/40 rounded-full overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-indigo-500 to-amber-400 rounded-full" style={{ width: `${tg.pct}%` }} />
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1">{tg.passed} / {tg.total} hari kerja · {MONTH_LABELS[month - 1]} {year}</div>
                    </div>
                </div>
            </div>

            {/* View tabs */}
            <div className="ui-tab-scroll">
            <div role="tablist" aria-label="Tampilan Insentif Sales" className="ui-tab-strip">
                {VIEWS.map((v, index) => {
                    const Icon = v.icon;
                    const active = view === v.key;
                    return (
                        <button key={v.key} id={`insentif-tab-${v.key}`} type="button" role="tab"
                            aria-selected={active}
                            aria-controls="insentif-view-panel"
                            tabIndex={active ? 0 : -1}
                            data-state={active ? "active" : "inactive"}
                            onKeyDown={(event) => handleViewKeyDown(event, index)}
                            onClick={() => updateContext({ view: v.key })}
                            className="ui-tab-button">
                            <Icon size={16} /> {v.label}
                        </button>
                    );
                })}
            </div>
            </div>

            {/* Filters */}
            {showFilters && (
                <div className="ui-toolbar">
                    <span className="flex items-center gap-2 text-xs font-semibold text-slate-400 uppercase tracking-wider"><Filter size={14} /> Filter</span>
                    <input
                        type="month"
                        aria-label="Periode insentif"
                        value={`${year}-${String(month).padStart(2, "0")}`}
                        onChange={(event) => {
                            const [nextYear, nextMonth] = event.target.value.split("-");
                            if (nextYear && nextMonth) updateContext({ year: nextYear, month: String(Number(nextMonth)) });
                        }}
                        className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500"
                    />
                    <select aria-label="Filter principle" value={principle} onChange={(e) => updateContext({ principle: e.target.value })} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500">
                        <option value="ALL">Semua Principle</option>
                        {PRINCIPLES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <select aria-label="Filter cabang" value={branch} onChange={(e) => updateContext({ branch: e.target.value })} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500">
                        <option value="ALL">Semua Cabang</option>
                        {BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                    <button type="button" onClick={fetchDashboard} className="ui-icon-button" title="Refresh data" aria-label="Refresh data insentif">
                        <RefreshCw size={14} />
                    </button>
                    {(principle !== "ALL" || branch !== "ALL") && (
                        <button type="button" onClick={() => updateContext({ principle: "ALL", branch: "ALL" })} className="ui-button-ghost">
                            Reset filter
                        </button>
                    )}
                    <span className="text-[11px] text-slate-500 ml-auto">{salesmen.length} salesman</span>
                </div>
            )}

            {/* Body */}
            <div id="insentif-view-panel" role="tabpanel" aria-labelledby={`insentif-tab-${view}`} tabIndex={0}>
            {loading && view !== "admin" ? (
                <LoadingState label="Memuat data insentif" rows={6} />
            ) : dashboardError && view !== "admin" ? (
                <ErrorState
                    title={dashboardError}
                    message="Data kosong tidak ditampilkan karena server belum memberikan hasil yang valid."
                    onAction={() => void fetchDashboard()}
                />
            ) : salesmen.length === 0 && view !== "admin" && view !== "finance" ? (
                <EmptyState
                    title="Tidak ada data untuk filter ini"
                    message="Ubah principle atau cabang, lalu periksa kembali hasilnya."
                    actionLabel="Reset Filter"
                    onAction={() => updateContext({ principle: "ALL", branch: "ALL" })}
                />
            ) : (
                <div className="space-y-5">
                    {view === "sales" && (
                        <>
                            <PerformanceBlock rows={salesmen} apiRows={apiRows} progress={tg} />
                            <AchievementTable rows={salesmen} progress={tg} />
                            <IncentiveTable apiRows={apiRows} />
                        </>
                    )}
                    {view === "spv" && (
                        <>
                            <PerformanceBlock rows={salesmen} apiRows={apiRows} progress={tg} />
                            <SpvView rows={salesmen} progress={tg} />
                            <SpvIncentiveTable month={month} year={year} />
                            <IncentiveTable apiRows={apiRows} />
                        </>
                    )}
                    {view === "sm" && (
                        <>
                            <PerformanceBlock rows={salesmen} apiRows={apiRows} progress={tg} />
                            <SmView rows={salesmen} progress={tg} />
                            <IncentiveTable apiRows={apiRows} />
                        </>
                    )}
                    {view === "admin" && <AdminView rows={salesmen} />}
                    {view === "finance" && <FinanceView apiRows={apiRows} month={month} year={year} onSaved={fetchDashboard} />}
                </div>
            )}
            </div>
        </div>
    );
}
