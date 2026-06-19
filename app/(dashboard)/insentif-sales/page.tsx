"use client";

/*
 * Tujuan: Halaman Insentif Sales — dashboard performa & insentif strata.
 * Caller: Next.js App Router route /insentif-sales.
 * Dependensi: lucide-react, sonner, ./data (helpers + constants), API routes /api/insentif-sales/*.
 * Main Functions: InsentifSalesPage + sub-view Sales/SPV/SM/Admin/Finance.
 * Side Effects: Fetch /api/insentif-sales/dashboard, /payments, POST /progress, PATCH /payments/[id].
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    Trophy, Filter, Clock, TrendingUp, BarChart3, ListChecks,
    Wallet, Upload, Target, Users, UserCog, DollarSign, CheckCircle2,
    AlertTriangle, FileUp, Save, Search, Loader2, RefreshCw, Download,
} from "lucide-react";
import { toast } from "sonner";
import {
    PRINCIPLES, BRANCHES, KPI_LABELS, MONTH_LABELS,
    getWorkdayProgress, paceStatus, pct, itemSuper, formatRp, formatShortRp,
    type Salesman, type PaceLevel, type ChannelType,
} from "./data";

// ── API types ──────────────────────────────────────────────────────────────
interface ApiRow {
    salesCode: string;
    salesName: string;
    principle: string;
    branch: string;
    channel: string;
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

function PaceCell({ value, real, target, suffix = "%" }: { value: number; real?: number; target?: number; suffix?: string }) {
    const tg = getWorkdayProgress(new Date()).pct;
    const level = paceStatus(value, tg);
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
function PerformanceBlock({ rows, apiRows }: { rows: Salesman[]; apiRows: ApiRow[] }) {
    const tg = getWorkdayProgress(new Date());
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
function AchievementTable({ rows }: { rows: Salesman[] }) {
    const tg = getWorkdayProgress(new Date());
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
            <SectionTitle icon={ListChecks} no={2} title="Tabel Pencapaian" desc="Target / Realisasi / % per KPI — color tagging + insight pace vs Time Gone" />
            <div className="overflow-x-auto">
                <table className="w-full min-w-[1300px] text-xs text-left border-collapse">
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
                            <td className="px-2 py-3 text-center border-r border-white/[0.06]"><PaceCell value={pct(totals.realValue, totals.targetValue)} /></td>
                            <td className={tdNum + " text-slate-400"}>{totals.targetEc}</td>
                            <td className={tdNum + " text-slate-200"}>{totals.realEc}</td>
                            <td className="px-2 py-3 text-center border-r border-white/[0.06]"><PaceCell value={pct(totals.realEc, totals.targetEc)} /></td>
                            <td className={tdNum + " text-slate-400"}>{totals.targetAo}</td>
                            <td className={tdNum + " text-slate-200"}>{totals.realAo}</td>
                            <td className="px-2 py-3 text-center border-r border-white/[0.06]"><PaceCell value={pct(totals.realAo, totals.targetAo)} /></td>
                            <td className={tdNum + " text-slate-400"}>{totalIsqTgt.toFixed(2)}</td>
                            <td className={tdNum + " text-slate-200"}>{totalIsqReal.toFixed(2)}</td>
                            <td className="px-2 py-3 text-center border-r border-white/[0.06]"><PaceCell value={totalIsqPct} /></td>
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
            acc.ec += r.incentive.ec;
            acc.ao += r.incentive.ao;
            acc.ia += r.incentive.isq;
            acc.total += r.incentive.total;
            return acc;
        },
        { value: 0, ec: 0, ao: 0, ia: 0, total: 0 },
    );

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={Wallet} no={3} title="Tabel Insentif" desc="Nominal rupiah per KPI dari strata DB — nilai real berdasarkan tier terkonfigurasi" />
            <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-xs text-left">
                    <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                        <tr className="whitespace-nowrap">
                            <th className="px-3 py-3">Salesman</th>
                            <th className="px-3 py-3 text-right">{KPI_LABELS.value}</th>
                            <th className="px-3 py-3 text-right">{KPI_LABELS.ec}</th>
                            <th className="px-3 py-3 text-right">{KPI_LABELS.ao}</th>
                            <th className="px-3 py-3 text-right">{KPI_LABELS.ia}</th>
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
                                    <td className="px-3 py-3 text-right font-mono text-slate-300">{formatRp(r.incentive.ec)}</td>
                                    <td className="px-3 py-3 text-right font-mono text-slate-300">{formatRp(r.incentive.ao)}</td>
                                    <td className="px-3 py-3 text-right font-mono text-slate-300">{formatRp(r.incentive.isq)}</td>
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
                            <td className="px-3 py-3 text-right font-mono text-slate-200">{formatRp(grand.ec)}</td>
                            <td className="px-3 py-3 text-right font-mono text-slate-200">{formatRp(grand.ao)}</td>
                            <td className="px-3 py-3 text-right font-mono text-slate-200">{formatRp(grand.ia)}</td>
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
function SpvView({ rows }: { rows: Salesman[] }) {
    const tg = getWorkdayProgress(new Date());
    const groups = useMemo(() => {
        const map = new Map<string, Salesman[]>();
        rows.forEach((r) => { const k = r.spv; if (!map.has(k)) map.set(k, []); map.get(k)!.push(r); });
        return [...map.entries()];
    }, [rows]);

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={ListChecks} no={2} title="Tabel Pencapaian SPV" desc="Agregat tim per Supervisor" />
            <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] text-xs text-left">
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
                            const avgAo = list.length ? Math.round(list.reduce((a, r) => a + r.realAo, 0) / list.length) : 0;
                            const aveIaTt = ttList.length ? Math.round(ttList.reduce((a, r) => a + r.realIa, 0) / ttList.length) : 0;
                            const aveIaMt = mtList.length ? Math.round(mtList.reduce((a, r) => a + r.realIa, 0) / mtList.length) : 0;
                            return (
                                <tr key={spv} className="even:bg-white/[0.025] hover:bg-white/[0.05] transition-colors">
                                    <td className="px-3 py-3">
                                        <div className="font-semibold text-slate-200">{spv}</div>
                                        <div className="text-[10px] text-slate-500">{list.length} salesman</div>
                                    </td>
                                    <td className="px-3 py-3 text-center"><PaceCell value={pct(rv, tv)} real={rv} target={tv} /></td>
                                    <td className="px-3 py-3 text-center"><PaceCell value={pct(aoTtReal, aoTtTarget)} /></td>
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
                            <td className="px-3 py-3 text-center"><PaceCell value={pct(rows.reduce((a, r) => a + r.realValue, 0), rows.reduce((a, r) => a + r.targetValue, 0))} /></td>
                            <td className="px-3 py-3 text-center text-slate-400" colSpan={4}>—</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
}

// ── SM View ────────────────────────────────────────────────────────────────
function SmView({ rows }: { rows: Salesman[] }) {
    const groups = useMemo(() => {
        const map = new Map<string, Salesman[]>();
        rows.forEach((r) => { const k = `${r.sm}__${r.principle}`; if (!map.has(k)) map.set(k, []); map.get(k)!.push(r); });
        return [...map.entries()];
    }, [rows]);

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={ListChecks} no={2} title="Tabel Pencapaian SM" desc="Performa gabungan SPV per Principle" />
            <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-xs text-left">
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
                                    <td className="px-3 py-3 text-center"><PaceCell value={pct(rv, tv)} real={rv} target={tv} /></td>
                                    <td className="px-3 py-3 text-center"><PaceCell value={pct(aoTtReal, aoTtTarget)} /></td>
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
                        <table className="w-full min-w-[1200px] text-xs border-collapse">
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

// ── Admin: upload CSV → POST /api/insentif-sales/progress ─────────────────
function AdminView({ rows }: { rows: Salesman[] }) {
    const now = new Date();
    const [period, setPeriod] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
    const [principle, setPrinciple] = useState<string>(PRINCIPLES[0]);
    const [branch, setBranch] = useState<string>(BRANCHES[0]);
    const [uploading, setUploading] = useState(false);

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
            const payload = lines.slice(1).map((line) => {
                const cols = line.split(/[,;]/);
                const get = (name: string) => cols[idx(name)]?.trim() ?? "";
                return {
                    salesCode: get("KODE_SALESMAN"),
                    principle,
                    branch,
                    date: `${year}-${String(month).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
                    periodMonth: month,
                    periodYear: year,
                    invoiceNumber: get("NO_INVOICE") || undefined,
                    achievedValueDpp: parseFloat(get("DPP").replace(/\D/g, "")) || 0,
                    achievedEc: parseInt(get("EC")) || 0,
                    achievedAo: parseInt(get("AO")) || 0,
                    achievedIa: parseInt(get("IA")) || 0,
                };
            }).filter((r) => r.salesCode);

            if (payload.length === 0) { toast.error("Tidak ada baris valid dalam CSV."); return; }

            const res = await fetch("/api/insentif-sales/progress", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Server error");
            toast.success(`${data.inserted} baris diproses ke database.`);
        } catch (err) {
            toast.error(`Gagal upload: ${err instanceof Error ? err.message : "Error tidak dikenal"}`);
        } finally {
            setUploading(false);
            e.target.value = "";
        }
    }

    return (
        <div className="space-y-5">
            <TargetInputSection />
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <SectionTitle icon={Upload} no={2} title="Input Progress Harian (CSV)" desc="Mapping: DPP (Value), AO, EC, IA, KODE_SALESMAN — POST ke /api/insentif-sales/progress" />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <Field label="Periode">
                        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500" />
                    </Field>
                    <Field label="Principal">
                        <select value={principle} onChange={(e) => setPrinciple(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500">
                            {PRINCIPLES.map((p) => <option key={p}>{p}</option>)}
                        </select>
                    </Field>
                    <Field label="Cabang">
                        <select value={branch} onChange={(e) => setBranch(e.target.value)} className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500">
                            {BRANCHES.map((b) => <option key={b}>{b}</option>)}
                        </select>
                    </Field>
                </div>
                <label className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl py-10 cursor-pointer transition-colors ${uploading ? "border-indigo-500/60 bg-indigo-500/[0.04]" : "border-white/15 hover:border-indigo-500/40 hover:bg-white/[0.02]"}`}>
                    {uploading ? <Loader2 className="text-indigo-400 animate-spin" size={28} /> : <FileUp className="text-indigo-400" size={28} />}
                    <span className="text-sm font-semibold text-slate-200">{uploading ? "Memproses…" : "Unggah CSV Laporan Penjualan Harian"}</span>
                    <span className="text-[11px] text-slate-500">Kolom: KODE_SALESMAN, DPP, AO, EC, IA (+ NO_INVOICE opsional)</span>
                    <input type="file" accept=".csv" className="hidden" disabled={uploading} onChange={handleUpload} />
                </label>
            </div>
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <SectionTitle icon={Target} no={3} title="Preview Salesman Terdaftar" desc="Data dari DB — periode saat ini" />
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-xs text-left">
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
function FinanceView({ apiRows, month, year }: { apiRows: ApiRow[]; month: number; year: number }) {
    const [payments, setPayments] = useState<PaymentRow[]>([]);
    const [selectedMonth, setSelectedMonth] = useState(month);
    const [saving, setSaving] = useState(false);
    const [checked, setChecked] = useState<Record<string, boolean>>({});

    // Fetch 12-month payment summary
    const fetchPayments = useCallback(async () => {
        try {
            const res = await fetch(`/api/insentif-sales/payments?year=${year}`);
            if (!res.ok) return;
            const data = await res.json();
            setPayments(data.rows ?? []);
        } catch { /* silent — fallback ke empty */ }
    }, [year]);

    useEffect(() => { fetchPayments(); }, [fetchPayments]);

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
                const pay = payments.find((p) => p.salesCode === r.salesCode && p.periodMonth === selectedMonth);
                return { salesCode: r.salesCode, salesName: r.salesName, principle: r.principle, total: r.incentive.total, paymentId: pay?.id ?? null, status: (pay?.paymentStatus ?? r.paymentStatus) as string };
            });
        }
        return payments
            .filter((p) => p.periodMonth === selectedMonth)
            .map((p) => ({ salesCode: p.salesCode, salesName: p.salesName, principle: p.principle, total: p.totalIncentive, paymentId: p.id, status: p.paymentStatus }));
    }, [selectedMonth, month, apiRows, payments]);

    const toggle = (code: string) => setChecked((p) => ({ ...p, [code]: !p[code] }));
    const checkedList = detailRows.filter((r) => checked[r.salesCode]);

    async function handleMarkLunas() {
        if (checkedList.length === 0) return;
        setSaving(true);
        let ok = 0;
        for (const row of checkedList) {
            try {
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
                    if (upsertRes.ok) ok++;
                } else {
                    const patchRes = await fetch(`/api/insentif-sales/payments/${row.paymentId}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ paymentStatus: "lunas" }),
                    });
                    if (patchRes.ok) ok++;
                }
            } catch { /* skip individual failure */ }
        }
        toast.success(`${ok} dari ${checkedList.length} pembayaran ditandai lunas.`);
        setChecked({});
        fetchPayments();
        setSaving(false);
    }

    const statusClasses = { lunas: "border-emerald-500/30 text-emerald-400", tunggakan: "border-rose-500/40 text-rose-400", belum: "border-white/10 text-slate-500" };

    return (
        <div className="space-y-5">
            {/* 12-month strip */}
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <SectionTitle icon={DollarSign} no={1} title="Rekap Pembayaran Tahunan" desc="12 bulan dari DB — indikator tunggakan real-time" />
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
                                <div className="text-[11px] font-mono mt-1 text-slate-400">{m.total ? formatShortRp(m.total) : "—"}</div>
                                <div className="text-[9px] uppercase tracking-wider mt-0.5 font-bold">{m.status}</div>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Detail per-salesman */}
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <div className="flex items-center justify-between mb-4">
                    <SectionTitle icon={Wallet} no={2} title={`Tabel Insentif — ${MONTH_LABELS[selectedMonth - 1]} ${year}`} desc="Centang → Simpan Lunas — real-time ke DB" />
                    <button onClick={fetchPayments} className="text-slate-500 hover:text-slate-300 transition-colors p-1.5 rounded-lg hover:bg-white/5">
                        <RefreshCw size={14} />
                    </button>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[820px] text-xs text-left">
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
                                const isChecked = !!checked[r.salesCode];
                                const sc = r.status === "lunas" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                    : r.status === "tunggakan" ? "bg-rose-500/10 text-rose-400 border-rose-500/30"
                                        : "bg-white/5 text-slate-500 border-white/10";
                                const slabel = r.status === "lunas" ? "Lunas" : r.status === "tunggakan" ? "Tunggakan" : "Belum";
                                return (
                                    <tr key={r.salesCode} className={`transition-colors hover:bg-white/[0.05] ${isChecked ? "bg-emerald-500/[0.07]" : "even:bg-white/[0.025]"}`}>
                                        <td className="px-3 py-3">
                                            <input type="checkbox" checked={isChecked} onChange={() => toggle(r.salesCode)} className="w-4 h-4 accent-emerald-500 cursor-pointer" />
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
                                                    onChange={() => toast.info("Fitur upload bukti akan tersedia — hubungkan ke storage provider.")} />
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
    const [view, setView] = useState<ViewKey>("sales");
    const [principle, setPrinciple] = useState("ALL");
    const [branch, setBranch] = useState("ALL");
    const [apiRows, setApiRows] = useState<ApiRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [month] = useState(now.getMonth() + 1);
    const [year] = useState(now.getFullYear());

    const tg = getWorkdayProgress(now);

    const fetchDashboard = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (principle !== "ALL") params.set("principle", principle);
            if (branch !== "ALL") params.set("branch", branch);
            params.set("month", String(month));
            params.set("year", String(year));
            const res = await fetch(`/api/insentif-sales/dashboard?${params}`);
            if (!res.ok) throw new Error("API error");
            const data = await res.json();
            setApiRows(data.rows as ApiRow[]);
        } catch {
            toast.error("Gagal memuat data dari server.");
            setApiRows([]);
        } finally {
            setLoading(false);
        }
    }, [principle, branch, month, year]);

    useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

    const salesmen = useMemo(() => apiRows.map(apiRowToSalesman), [apiRows]);
    const showFilters = view !== "admin";

    return (
        <div className="max-w-[1800px] mx-auto pb-12">
            {/* Header */}
            <div className="mb-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
                        <Trophy className="text-amber-400" />
                        Insentif Sales
                    </h1>
                    <p className="text-slate-400 mt-1 text-sm">Tracking performa, color tagging Time Gone, & insentif strata — data real dari DB.</p>
                </div>
                <div className="flex items-center gap-3 bg-[#1a1c23]/60 border border-white/10 rounded-xl px-4 py-3 min-w-[260px]">
                    <Clock className="text-indigo-400 shrink-0" size={22} />
                    <div className="flex-1">
                        <div className="flex items-center justify-between text-[11px] text-slate-400 font-semibold uppercase tracking-wider">
                            <span>Time Gone</span><span className="text-indigo-300">{tg.pct}%</span>
                        </div>
                        <div className="h-2 mt-1.5 bg-black/40 rounded-full overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-indigo-500 to-amber-400 rounded-full" style={{ width: `${tg.pct}%` }} />
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1">{tg.passed} / {tg.total} hari kerja · {MONTH_LABELS[now.getMonth()]} {year}</div>
                    </div>
                </div>
            </div>

            {/* View tabs */}
            <div className="flex items-center gap-2 mb-5 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
                {VIEWS.map((v) => {
                    const Icon = v.icon;
                    const active = view === v.key;
                    return (
                        <button key={v.key} onClick={() => setView(v.key)}
                            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold whitespace-nowrap border transition-all shrink-0 ${active
                                ? "bg-indigo-500/20 text-indigo-300 border-indigo-500/40"
                                : "bg-white/5 text-slate-400 border-white/10 hover:bg-white/10 hover:text-slate-200"}`}>
                            <Icon size={16} /> {v.label}
                        </button>
                    );
                })}
            </div>

            {/* Filters */}
            {showFilters && (
                <div className="flex flex-wrap items-center gap-3 mb-5 bg-[#1a1c23]/40 border border-white/10 rounded-xl px-4 py-3">
                    <span className="flex items-center gap-2 text-xs font-semibold text-slate-400 uppercase tracking-wider"><Filter size={14} /> Filter</span>
                    <select value={principle} onChange={(e) => setPrinciple(e.target.value)} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500">
                        <option value="ALL">Semua Principle</option>
                        {PRINCIPLES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <select value={branch} onChange={(e) => setBranch(e.target.value)} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500">
                        <option value="ALL">Semua Cabang</option>
                        {BRANCHES.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                    <button onClick={fetchDashboard} className="ml-1 text-slate-500 hover:text-indigo-400 transition-colors p-1.5 rounded-lg hover:bg-white/5" title="Refresh data">
                        <RefreshCw size={14} />
                    </button>
                    <span className="text-[11px] text-slate-500 ml-auto">{salesmen.length} salesman</span>
                </div>
            )}

            {/* Body */}
            {loading && view !== "admin" ? (
                <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-12 text-center text-slate-500 flex flex-col items-center gap-3">
                    <Loader2 size={28} className="animate-spin text-indigo-400" />
                    <span className="text-sm">Memuat data dari server…</span>
                </div>
            ) : salesmen.length === 0 && view !== "admin" && view !== "finance" ? (
                <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-12 text-center text-slate-500 italic flex flex-col items-center gap-2">
                    <Search size={28} /> Tidak ada data untuk filter ini.
                </div>
            ) : (
                <div className="space-y-5">
                    {view === "sales" && (
                        <>
                            <PerformanceBlock rows={salesmen} apiRows={apiRows} />
                            <AchievementTable rows={salesmen} />
                            <IncentiveTable apiRows={apiRows} />
                        </>
                    )}
                    {view === "spv" && (
                        <>
                            <PerformanceBlock rows={salesmen} apiRows={apiRows} />
                            <SpvView rows={salesmen} />
                            <IncentiveTable apiRows={apiRows} />
                        </>
                    )}
                    {view === "sm" && (
                        <>
                            <PerformanceBlock rows={salesmen} apiRows={apiRows} />
                            <SmView rows={salesmen} />
                            <IncentiveTable apiRows={apiRows} />
                        </>
                    )}
                    {view === "admin" && <AdminView rows={salesmen} />}
                    {view === "finance" && <FinanceView apiRows={apiRows} month={month} year={year} />}
                </div>
            )}
        </div>
    );
}
