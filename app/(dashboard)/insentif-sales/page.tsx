/*
 * Tujuan: Halaman Insentif Sales untuk performa, status feed pencapaian, kalkulasi insentif, dan verifikasi pembayaran.
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
    AlertTriangle, FileUp, Save, Loader2, RefreshCw, Download, ChevronDown,
} from "lucide-react";
import { realisasiValue } from "@/lib/insentif-value-source";
import { payeeCode, parsePayee, PAYEE_PRINCIPLE_ALL, type PayeeRole } from "@/lib/insentif-payee";
import { toast } from "sonner";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { SupportTemplateRow } from "@/lib/insentif-sales-excel";
import { excelDateToIso } from "@/lib/excel-date";
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

interface ProgressFeedStatus {
    progressKeys: number;
    targetKeys: number;
    matchedKeys: number;
    unmatchedKeys: number;
    /** Kombinasi yang punya baris target tapi nilainya 0 — tidak dibayar sama sekali. */
    zeroTargetKeys: number;
    ready: boolean;
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

/**
 * Baca respons API dengan aman. `res.json()` langsung akan meledak jadi
 * "Unexpected token 'B', \"Bad Gateway\" is not valid JSON" ketika yang balik BUKAN dari
 * aplikasi kita — 502/504 dari proxy, halaman login, atau HTML error Next. Pesan itu
 * menyembunyikan status HTTP yang sebenarnya, yaitu satu-satunya petunjuk yang berguna.
 */
async function readApi(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new Error(`HTTP ${res.status} ${res.statusText} — ${text.slice(0, 120).trim() || "respons kosong"}`);
    }
}

function payeeRoleBadge(role: PayeeRole) {
    if (role === "spv") return { label: "SPV", cls: "bg-sky-500/10 text-sky-300 border-sky-500/30" };
    if (role === "sm") return { label: "SM", cls: "bg-violet-500/10 text-violet-300 border-violet-500/30" };
    return { label: "Sales", cls: "bg-white/5 text-slate-400 border-white/10" };
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

// `hidden` menyembunyikan tombol tab-nya saja, bukan menghapus view-nya: kodenya tetap
// hidup dan masih bisa dibuka lewat ?view=sales / ?view=spv. User minta keduanya
// disembunyikan "dulu" (2026-08-29), jadi ini sengaja bukan penghapusan.
//
// `izin` = salah satu key ini cukup untuk melihat tabnya. `manage` selalu ikut disertakan
// supaya Admin yang sudah punya izin itu tidak kehilangan tab saat key baru diperkenalkan.
// INI UX, BUKAN KEAMANAN — endpoint di baliknya tetap memeriksa izinnya sendiri.
const VIEWS: { key: ViewKey; label: string; icon: typeof Trophy; hidden?: boolean; izin: string[] }[] = [
    { key: "sales", label: "Dashboard Sales", icon: Trophy, hidden: true, izin: ["view_dashboard", "manage"] },
    { key: "spv", label: "Dashboard SPV", icon: Users, hidden: true, izin: ["view_dashboard", "manage"] },
    { key: "sm", label: "Dashboard SM", icon: UserCog, izin: ["view_dashboard", "manage"] },
    { key: "admin", label: "Input Penjualan", icon: Upload, izin: ["upload_progress", "upload_target", "manage"] },
    { key: "finance", label: "Verifikasi Finance", icon: Wallet, izin: ["manage_payment", "manage"] },
];

/**
 * Tab yang boleh dilihat user ini. Sebelum izin selesai dimuat (`izin` kosong) seluruh tab
 * non-hidden ditampilkan: menyembunyikan dulu lalu memunculkan bikin tab berkedip tiap
 * halaman dibuka, dan datanya toh tetap 403 kalau memang tidak berhak.
 */
function viewsTerlihat(izin: ReadonlySet<string>): typeof VIEWS {
    const semua = VIEWS.filter((v) => !v.hidden);
    if (izin.size === 0) return semua;
    return semua.filter((v) => v.izin.some((k) => izin.has(`insentif_sales.${k}`)));
}

// Spanduk status pencocokan Laporan Harian (berapa kombinasi cocok/tanpa target).
// Disembunyikan atas permintaan user 2026-08-29 — "dulu", jadi saklarnya dibiarkan di sini
// alih-alih kodenya dibuang. Angkanya tetap dihitung server (progressFeed), jadi
// menyalakannya lagi cukup mengubah baris ini jadi true.
const TAMPILKAN_SPANDUK_PROGRES = false;

// ── Reusable bits ──────────────────────────────────────────────────────────
function paceClasses(level: PaceLevel) {
    if (level === "green") return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 neon-text-success";
    if (level === "yellow") return "bg-amber-500/10 text-amber-400 border-amber-500/30 neon-text-warn";
    return "bg-rose-500/10 text-rose-400 border-rose-500/30 neon-text-danger";
}

/**
 * Panel yang terlipat, pakai <details> native: keyboard, screen reader, dan tombol
 * Cari-di-halaman browser bekerja tanpa satu baris JS pun. Panel input support memakai ini
 * karena ia berisi ratusan baris form yang hanya dipakai SM saat menyiapkan payout — terbuka
 * permanen, ia mendorong tabel yang dibaca setiap hari keluar layar.
 */
function CollapsiblePanel({ icon: Icon, no, title, desc, badge, children }: {
    icon: typeof Trophy;
    /** Nomor langkah, kalau panel ini bagian dari alur bernomor. */
    no?: number;
    title: string;
    desc?: string;
    badge?: string;
    children: React.ReactNode;
}) {
    return (
        <details className="group bg-[#1a1c23]/60 rounded-xl border border-white/10">
            <summary className="flex items-center gap-3 p-5 cursor-pointer list-none [&::-webkit-details-marker]:hidden rounded-xl hover:bg-white/[0.02] focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
                <div className="w-9 h-9 rounded-lg bg-black/40 border border-white/10 flex items-center justify-center shrink-0">
                    <Icon className="text-indigo-400" size={18} />
                </div>
                <div className="min-w-0 flex-1">
                    <h2 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                        {no !== undefined && <span className="text-indigo-400 font-mono">{no}.</span>} {title}
                        {badge && (
                            <span className="text-[10px] font-mono font-normal text-slate-400 bg-white/5 border border-white/10 rounded px-1.5 py-0.5">
                                {badge}
                            </span>
                        )}
                    </h2>
                    {desc && <p className="text-xs text-slate-400 mt-0.5">{desc}</p>}
                </div>
                <ChevronDown
                    size={18}
                    aria-hidden
                    className="text-slate-500 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                />
            </summary>
            <div className="px-5 pb-5">{children}</div>
        </details>
    );
}

/**
 * Kenapa baris ini Rp 0. Pertanyaan yang paling sering diajukan ke layar ini adalah "kenapa
 * dapat / tidak dapat", dan angka nol sendirian tidak pernah menjawabnya — orang lalu menebak
 * bahwa sistemnya salah. Urutannya mengikuti urutan penolakan di kalkulasi.
 */
function sebabNol(r: ApiRow, gtAoMode?: "fixed240" | "file"): string | null {
    if (r.incentive.total > 0) return null;
    if (r.statusInsentif === "principle") return "tidak ikut skema";
    if (!(r.target.value > 0)) return "target belum diisi";
    if (!(r.real.value > 0)) return "penjualan bersih ≤ 0";
    if (r.channel !== "GT" && r.channel !== "TT" && r.channel !== "MT") return `channel "${r.channel}" tak dikenal`;
    if ((r.support ?? 0) >= 1_000_000) return "ditanggung principle";
    const ambangAo = r.channel === "MT" || gtAoMode === "file" ? r.target.ao : 240;
    const pctAoDibayar = ambangAo > 0 ? (r.real.ao / ambangAo) * 100 : 0;
    if (r.pct.value < 90 && pctAoDibayar < 90) return "belum 90%";
    return null;
}

/** Persentase dari API sudah berskala 0-100 (lib/insentif-sales.pct), bukan rasio. */
function formatPctText(v: number) {
    return `${v.toFixed(1)}%`;
}

/** Cacahan EC/AO/IA. Target boleh pecahan (mis. IA 204,8), realisasi selalu bulat. */
function formatQty(n: number) {
    return n.toLocaleString("id-ID", { maximumFractionDigits: 1 });
}

/**
 * ISQ = item per outlet (itemSuper), rasio kecil, BUKAN cacahan. Dengan 1 desimal, target
 * 0,04 tampil "0" lalu pencapaian 11.450% terbaca sebagai kesalahan hitung padahal cuma
 * pembulatan tampilan: angka yang membantah angka di sebelahnya.
 */
function formatRatio(n: number) {
    return n.toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

/** Satu angka + labelnya di dalam baris rincian. Angka selalu mono supaya kolom sejajar. */
function BreakdownItem({ label, value, tone }: { label: string; value: string; tone?: "amber" | "muted" }) {
    return (
        <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
            <div className={`text-xs font-mono mt-0.5 ${tone === "amber" ? "text-amber-400 font-bold" : tone === "muted" ? "text-slate-400" : "text-slate-200"}`}>
                {value}
            </div>
        </div>
    );
}

/** Kelompok rincian: judul kecil + grid angka. Dipakai baris rincian Sales, SPV, dan SM. */
function BreakdownGroup({ title, items }: { title: string; items: Array<{ label: string; value: string; tone?: "amber" | "muted" }> }) {
    return (
        <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-300/70 mb-2">{title}</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-5 gap-y-3">
                {items.map((it) => <BreakdownItem key={it.label} {...it} />)}
            </div>
        </div>
    );
}

/**
 * State buka/tutup baris rincian + prop baris yang aksesibilitasnya sudah lengkap.
 * Baris tabel yang hanya punya onClick tidak bisa dicapai keyboard sama sekali; di layar
 * yang dipakai Finance untuk memverifikasi nominal, itu berarti sebagian orang tidak bisa
 * melihat dasar perhitungannya.
 */
function useExpandableRows() {
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const toggle = (key: string) => setOpen((p) => ({ ...p, [key]: !p[key] }));
    const rowProps = (key: string) => ({
        role: "button" as const,
        tabIndex: 0,
        "aria-expanded": !!open[key],
        onClick: () => toggle(key),
        onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(key); }
        },
        className: "even:bg-white/[0.025] hover:bg-white/[0.05] transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400",
    });
    return { open, toggle, rowProps };
}

/**
 * Rincian satu baris salesman. SATU definisi dipakai tabel Insentif dan tabel pembayaran
 * Finance: kalau keduanya punya salinan sendiri, cepat atau lambat yang satu menampilkan
 * dasar perhitungan yang berbeda dari yang lain untuk baris yang sama.
 */
function SalesBreakdown({ r, semuaBaris, gtAoMode }: { r: ApiRow; semuaBaris?: ApiRow[]; gtAoMode?: "fixed240" | "file" }) {
    const isMt = r.channel === "MT";
    // Ambang AO yang dipakai membayar. Menuliskan 240 mati di sini berbahaya: setelah toggle
    // dimatikan, layar akan mengklaim angka yang tidak lagi dipakai menghitung.
    const ambangAo = isMt || gtAoMode === "file" ? r.target.ao : 240;

    // MT membayar 4 KPI (Value 350rb, EC 150rb, OA 150rb, IA 350rb); GT/TT hanya 2 (Value 30%,
    // AO 70%). Menampilkan dua komponen untuk semua channel membuat baris MT memperlihatkan
    // Rp 500.000 di bawah total Rp 986.403 — rincian yang tidak menjumlah ke totalnya sendiri
    // (dilaporkan user 2026-08-26).
    const komponen = isMt
        ? [
            { label: "Value", value: formatRp(r.incentive.value) },
            { label: "EC", value: formatRp(r.incentive.ec) },
            { label: "Aktif Outlet", value: formatRp(r.incentive.ao) },
            { label: "Item Aktif", value: formatRp(r.incentive.isq) },
            { label: "Total", value: formatRp(r.incentive.total), tone: "amber" as const },
        ]
        : [
            { label: "Value (30%)", value: formatRp(r.incentive.value) },
            { label: "AO (70%)", value: formatRp(r.incentive.ao) },
            { label: "Total", value: formatRp(r.incentive.total), tone: "amber" as const },
        ];

    // Sales "mix": komponen Value dinilai dari GABUNGAN seluruh principal yang ikut skema,
    // lalu dibagi ke tiap principal menurut porsi targetnya. Tanpa angka gabungan ini, baris
    // dengan pencapaian 55% terlihat dibayar tanpa sebab (dilaporkan user 2026-08-26).
    const gabungan = (() => {
        if (r.tipeSales !== "mix" || !semuaBaris) return null;
        const anggota = semuaBaris.filter((x) =>
            x.salesCode === r.salesCode && x.statusInsentif !== "principle");
        if (anggota.length <= 1) return null;
        const target = anggota.reduce((a, x) => a + x.target.value, 0);
        const real = anggota.reduce((a, x) => a + x.real.value, 0);
        return { jumlah: anggota.length, target, real, pct: target > 0 ? (real / target) * 100 : 0 };
    })();

    return (
        <div className="grid gap-5 md:grid-cols-3">
            <BreakdownGroup title="Value" items={[
                { label: "Target", value: formatRp(r.target.value) },
                { label: "Realisasi", value: formatRp(r.real.value) },
                { label: "Pencapaian", value: formatPctText(r.pct.value) },
            ]} />
            <BreakdownGroup title="Aktif Outlet (AO)" items={[
                { label: isMt ? "Target" : "Target (file)", value: formatQty(r.target.ao) },
                { label: "Realisasi", value: formatQty(r.real.ao) },
                { label: "Pencapaian", value: formatPctText(r.pct.ao) },
                // GT/TT membayar AO terhadap ambang tetap 240 (TARGET_AO_MIN), BUKAN target di
                // file target. Tanpa baris ini, pencapaian 18% di layar tidak akan pernah cocok
                // dengan nominal yang dibayar.
                ...(isMt || gtAoMode === "file" ? [] : [
                    { label: "Ambang skema", value: formatQty(ambangAo), tone: "muted" as const },
                    { label: "Pencapaian dibayar", value: formatPctText(ambangAo > 0 ? (r.real.ao / ambangAo) * 100 : 0) },
                ]),
            ]} />
            <BreakdownGroup title="EC & ISQ" items={[
                { label: "Target EC", value: formatQty(r.target.ec) },
                { label: "Realisasi EC", value: formatQty(r.real.ec) },
                { label: "Pencapaian EC", value: formatPctText(r.pct.ec) },
                { label: "Target ISQ", value: formatRatio(r.target.isq) },
                { label: "Realisasi ISQ", value: formatRatio(r.real.isq) },
                { label: "Pencapaian ISQ", value: formatPctText(r.pct.isq) },
            ]} />
            <BreakdownGroup title="Dasar perhitungan" items={[
                { label: "Tipe sales", value: r.tipeSales ?? "-", tone: "muted" },
                { label: "Status insentif", value: r.statusInsentif ?? "-", tone: "muted" },
                { label: "Support principle", value: formatRp(r.support ?? 0) },
            ]} />
            <BreakdownGroup title={isMt ? "Komponen insentif (MT)" : "Komponen insentif"} items={komponen} />
            {gabungan && (
                <BreakdownGroup title={`Dasar Value gabungan (${gabungan.jumlah} principal)`} items={[
                    { label: "Target gabungan", value: formatRp(gabungan.target) },
                    { label: "Realisasi gabungan", value: formatRp(gabungan.real) },
                    { label: "Pencapaian dipakai", value: formatPctText(gabungan.pct) },
                ]} />
            )}
            <BreakdownGroup title="Wilayah" items={[
                { label: "Cabang", value: r.branch, tone: "muted" },
                { label: "Channel", value: r.channel, tone: "muted" },
                { label: "SPV / SM", value: `${r.spvName ?? "-"} / ${r.smName ?? "-"}`, tone: "muted" },
            ]} />
        </div>
    );
}

/** Rincian per principal untuk satu SPV. Target & realisasi ikut, tanpa itu persentasenya tak bisa ditelusuri. */
function SpvBreakdown({ rincian }: { rincian: SpvIncentiveDetail[] }) {
    // pctValue SPV adalah PENGALI (0 atau 1 sejak ambang 100% berlaku), bukan pencapaian.
    // Menampilkannya apa adanya membuat setiap baris terbaca 0% atau 100% dan pencapaian
    // sebenarnya hilang, justru di tempat orang mencarinya.
    const pencapaian = (d: SpvIncentiveDetail) =>
        d.targetValue > 0 ? (d.realisasiValue / d.targetValue) * 100 : 0;
    return (
        <table className="w-full text-[11px]">
            <thead className="text-slate-500 uppercase tracking-wider">
                <tr>
                    <th className="text-left font-semibold pb-2">Principal</th>
                    <th className="text-right font-semibold pb-2">Target</th>
                    <th className="text-right font-semibold pb-2">Realisasi</th>
                    <th className="text-right font-semibold pb-2">Pencapaian</th>
                    <th className="text-right font-semibold pb-2">Rate</th>
                    <th className="text-right font-semibold pb-2">Support</th>
                    <th className="text-right font-semibold pb-2">Insentif</th>
                </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
                {rincian.map((d) => (
                    <tr key={d.principle}>
                        <td className="py-2 text-slate-300">{d.principle}</td>
                        <td className="py-2 text-right font-mono text-slate-400">{formatRp(d.targetValue)}</td>
                        <td className="py-2 text-right font-mono text-slate-300">{formatRp(d.realisasiValue)}</td>
                        <td className="py-2 text-right font-mono text-slate-300">{formatPctText(pencapaian(d))}</td>
                        <td className="py-2 text-right font-mono text-slate-400">{formatRp(d.rate)}</td>
                        <td className="py-2 text-right font-mono text-slate-400">{(d.support ?? 0) > 0 ? formatRp(d.support) : "-"}</td>
                        <td className={`py-2 text-right font-mono ${d.insentif > 0 ? "text-amber-400/90" : "text-slate-500"}`}>
                            {d.insentif > 0
                                ? formatRp(d.insentif)
                                // Label lama selalu berbunyi "belum 100%" — termasuk untuk baris
                                // berpencapaian 130% yang nol karena support menutup penuh rate.
                                : (d.porsiDistributor ?? d.rate) <= 0
                                    ? "Rp 0 · ditanggung principle"
                                    : "Rp 0 · belum 100%"}
                        </td>
                    </tr>
                ))}
                {rincian.length === 0 && (
                    <tr><td colSpan={7} className="py-3 text-slate-500 italic">Tidak ada principal valid untuk SPV ini.</td></tr>
                )}
            </tbody>
        </table>
    );
}

/** Rincian satu SM: strata FLAT, jadi yang perlu dijelaskan adalah strata mana yang kena dan kenapa. */
function SmBreakdown({ r }: { r: SmIncentiveRow }) {
    // Rasio dibulatkan sama persis seperti rateSm (roundRatio 1e-6) sebelum dicocokkan ke
    // strata. Tanpa itu 0,8999999997 di layar jatuh ke "< 90%" padahal yang dibayar server
    // Rp 1,5jt: rincian yang membantah nominalnya sendiri.
    const capaian = (Math.round(r.pctValue * 1e6) / 1e6) * 100;
    const strata = SM_STRATA.find((t) => capaian >= t.min) ?? SM_STRATA[SM_STRATA.length - 1];
    const selisih = r.realisasiValue - r.targetValue;
    return (
        <>
            <div className="grid gap-5 md:grid-cols-3">
                <BreakdownGroup title="Value wilayah" items={[
                    { label: "Target", value: formatRp(r.targetValue) },
                    { label: "Realisasi", value: formatRp(r.realisasiValue) },
                    { label: selisih >= 0 ? "Surplus" : "Kurang", value: formatRp(Math.abs(selisih)) },
                ]} />
                <BreakdownGroup title="Dasar perhitungan" items={[
                    { label: "Pencapaian", value: `${capaian.toFixed(1)}%` },
                    { label: "Strata", value: strata.label },
                    { label: "Baris sales dihitung", value: formatQty(r.jumlahBaris) },
                ]} />
                <BreakdownGroup title="Hasil" items={[
                    { label: "Nominal strata", value: formatRp(strata.nominal) },
                    { label: "Ikut skema", value: r.berhak ? "Ya" : "Tidak", tone: "muted" },
                    { label: "Dibayar", value: formatRp(r.total), tone: "amber" },
                ]} />
            </div>
            <p className="text-[11px] text-slate-500 mt-4">
                Strata FLAT: nominal tidak dikali persentase. Semua status principal ikut
                dihitung, termasuk principle. Baris _OFFICE dibuang.
            </p>
        </>
    );
}

/** Penanda baris bisa diklik. Chevron ikut berputar saat terbuka. */
function ExpandCell({ open }: { open: boolean }) {
    return (
        <td className="px-3 py-3 text-center whitespace-nowrap">
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {open ? "Tutup" : "Rincian"}
                <ChevronDown
                    size={12}
                    aria-hidden
                    className={`transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
                />
            </span>
        </td>
    );
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

// ── Performance Block ───────────────────────────────────────
// Grafik blok batang dibuang (permintaan user 2026-08-29): dengan ~100 salesman × 3 batang
// ia tidak terbaca di layar mana pun, dan angka yang sama sudah ada di Tabel Pencapaian
// per baris. Yang tersisa empat kartu ringkasan. Riwayat grafiknya ada di git kalau
// suatu saat mau dihidupkan lagi dalam bentuk lain.
function PerformanceBlock({ rows, apiRows, progress: tg }: { rows: Salesman[]; apiRows: ApiRow[]; progress: WorkdayProgress }) {
    const totalReal = rows.reduce((a, r) => a + r.realValue, 0);
    const totalTarget = rows.reduce((a, r) => a + r.targetValue, 0);
    const totalPct = pct(totalReal, totalTarget);
    const totalIncentive = apiRows.reduce((a, r) => a + r.incentive.total, 0);

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={BarChart3} no={1} title="Ringkasan Performa" desc={`Total periode berjalan · ${rows.length} baris · Time Gone ${tg.pct}%`} />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <SummaryBlock label="Total Realisasi" value={formatShortRp(totalReal)} icon={TrendingUp} tone="emerald" />
                <SummaryBlock label="Total Target" value={formatShortRp(totalTarget)} icon={Target} tone="indigo" />
                <SummaryBlock label="Capaian Tim" value={`${totalPct}%`} icon={BarChart3} tone={totalPct >= tg.pct ? "emerald" : "amber"} />
                <SummaryBlock label="Taksiran Insentif" value={formatShortRp(totalIncentive)} icon={Wallet} tone="amber" />
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
    // Target IA per baris SUDAH rata-rata per outlet, jadi menjumlahkannya lalu membagi AO
    // (cara lama) menghasilkan angka yang bukan apa-apa. Gabungannya adalah rata-rata
    // tertimbang terhadap target AO: outlet yang lebih banyak menyumbang lebih besar.
    const totalIsqTgt = totals.targetAo > 0
        ? Math.round((rows.reduce((a, r) => a + r.targetIa * r.targetAo, 0) / totals.targetAo) * 100) / 100
        : 0;
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
                            const isqTgt = r.targetIa; // sudah per outlet, lihat catatan di totalIsqTgt
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
function IncentiveTable({ apiRows, gtAoMode }: { apiRows: ApiRow[]; gtAoMode?: "fixed240" | "file" }) {
    const { open, rowProps } = useExpandableRows();
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
                            <th className="px-3 py-3 text-center">Rincian</th>
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
                            const key = `${r.salesCode}|${r.principle}`;
                            const sebab = sebabNol(r, gtAoMode);
                            return (
                                <Fragment key={key}>
                                    <tr {...rowProps(key)}>
                                        <td className="px-3 py-3">
                                            <div className="font-semibold text-slate-200">{r.salesName}</div>
                                            <div className="text-[10px] text-slate-500 font-mono">{r.salesCode} · {r.principle}</div>
                                        </td>
                                        <td className="px-3 py-3 text-right font-mono text-slate-300">{formatRp(r.incentive.value)}</td>
                                        <td className="px-3 py-3 text-right font-mono text-slate-300">{formatRp(r.incentive.ao)}</td>
                                        <td className="px-3 py-3 text-right bg-amber-500/5">
                                            <div className="font-mono font-bold text-amber-400">{formatRp(r.incentive.total)}</div>
                                            {sebab && <div className="text-[10px] font-normal text-slate-500 mt-0.5">{sebab}</div>}
                                        </td>
                                        <td className="px-3 py-3 text-center">
                                            <span className={`inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${sc}`}>
                                                {statusLabel[r.paymentStatus] ?? "Belum"}
                                            </span>
                                        </td>
                                        <ExpandCell open={!!open[key]} />
                                    </tr>
                                    {open[key] && (
                                        <tr className="bg-black/30">
                                            <td colSpan={6} className="px-4 py-4">
                                                <SalesBreakdown r={r} semuaBaris={apiRows} gtAoMode={gtAoMode} />
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
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
                            <th className="px-3 py-3 text-center">IA/Toko TT</th>
                            <th className="px-3 py-3 text-center">IA/Toko MT</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.1]">
                        {groups.map(([spv, list]) => {
                            const rv = list.reduce((a, r) => a + r.realValue, 0);
                            const tv = list.reduce((a, r) => a + r.targetValue, 0);
                            const ttList = list.filter((r) => r.channel === "TT" || r.channel === "GT");
                            const mtList = list.filter((r) => r.channel === "MT");
                            const aoTtReal = ttList.reduce((a, r) => a + r.realAo, 0);
                            const aoTtTarget = ttList.reduce((a, r) => a + r.targetAo, 0);
                            // 1 salesman bisa banyak baris (per principle) → count distinct salesCode untuk per-sales.
                            const salesmanCount = new Set(list.map((r) => r.code)).size;
                            const avgAo = salesmanCount ? Math.round(list.reduce((a, r) => a + r.realAo, 0) / salesmanCount) : 0;
                            // IA per OUTLET (itemSuper), bukan total dibagi jumlah baris. Kolom lama menampilkan
                            // ~1.200 sementara angka yang dipakai membayar 10,4 — pola yang sama dengan
                            // ISQ 6.103% (audit 2026-08-28, M12).
                            const aveIaTt = itemSuper(ttList.reduce((a, r) => a + r.realIa, 0), ttList.reduce((a, r) => a + r.realAo, 0));
                            const aveIaMt = itemSuper(mtList.reduce((a, r) => a + r.realIa, 0), mtList.reduce((a, r) => a + r.realAo, 0));
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
                            <th className="px-3 py-3 text-center">IA/Toko TT</th>
                            <th className="px-3 py-3 text-center">IA/Toko MT</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.1]">
                        {groups.map(([key, list]) => {
                            const [sm, principle] = key.split("__");
                            const rv = list.reduce((a, r) => a + r.realValue, 0);
                            const tv = list.reduce((a, r) => a + r.targetValue, 0);
                            const ttList = list.filter((r) => r.channel === "TT" || r.channel === "GT");
                            const mtList = list.filter((r) => r.channel === "MT");
                            const aoTtReal = ttList.reduce((a, r) => a + r.realAo, 0);
                            const aoTtTarget = ttList.reduce((a, r) => a + r.targetAo, 0);
                            // Per SALESMAN, sama seperti SpvView: satu salesman bisa punya banyak baris
                            // (per principle), jadi membaginya dengan jumlah baris memberi angka 3x
                            // lebih kecil untuk populasi yang sama, di bawah label yang sama (M12).
                            const salesmanCount = new Set(list.map((r) => r.code)).size;
                            const avgAo = salesmanCount ? Math.round(list.reduce((a, r) => a + r.realAo, 0) / salesmanCount) : 0;
                            // IA per OUTLET (itemSuper), bukan total dibagi jumlah baris. Kolom lama menampilkan
                            // ~1.200 sementara angka yang dipakai membayar 10,4 — pola yang sama dengan
                            // ISQ 6.103% (audit 2026-08-28, M12).
                            const aveIaTt = itemSuper(ttList.reduce((a, r) => a + r.realIa, 0), ttList.reduce((a, r) => a + r.realAo, 0));
                            const aveIaMt = itemSuper(mtList.reduce((a, r) => a + r.realIa, 0), mtList.reduce((a, r) => a + r.realAo, 0));
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
                        {groups.length === 0 && (
                            <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500 italic">Tidak ada baris SM untuk filter ini.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ── Tab SM ─────────────────────────────────────────────────────
// Filternya ada di toolbar atas bersama periode/principle/cabang, BUKAN toolbar sendiri di
// dalam tab: dua baris filter mirip yang bertumpuk membuat yang kedua tidak terlihat.
// Panel support sengaja menerima apiRows PENUH, bukan yang tersaring — pasangan yang sedang
// disembunyikan filter tetap harus bisa diisi nominal support-nya.
function SmDashboard({ rows, rowsApi, apiRows, progress, month, year, onSaved, gtAoMode }: {
    rows: Salesman[];
    rowsApi: ApiRow[];
    apiRows: ApiRow[];
    progress: WorkdayProgress;
    month: number;
    year: number;
    onSaved: () => void;
    gtAoMode?: "fixed240" | "file";
}) {
    return (
        <>
            <SupportInputSection apiRows={apiRows} month={month} year={year} onSaved={onSaved} />
            <SpvSupportInputSection apiRows={apiRows} month={month} year={year} onSaved={onSaved} />
            <PerformanceBlock rows={rows} apiRows={rowsApi} progress={progress} />
            <SmView rows={rows} progress={progress} />
            {/* Tabel Insentif SM sengaja TIDAK ikut disaring: stratanya dihitung dari seluruh
                principal SM itu, menyaringnya akan memajang nominal yang tidak dibayar. */}
            <SmIncentiveTable month={month} year={year} />
            {/* SPV ikut dibayar dari periode yang sama, jadi SM perlu melihatnya di sini —
                sama seperti tab Finance. Rate per principal SPV bergantung pada jumlah
                principal valid yang ia tangani, jadi tabel ini juga tidak ikut disaring. */}
            <SpvIncentiveTable month={month} year={year} />
            <IncentiveTable apiRows={rowsApi} gtAoMode={gtAoMode} />
        </>
    );
}

// ── Tabel Insentif SM — strata flat Value (lib/insentif-sm-calc), fetch mandiri ──
interface SmIncentiveRow {
    smName: string;
    jumlahBaris: number;
    targetValue: number;
    realisasiValue: number;
    pctValue: number;
    berhak: boolean;
    total: number;
}

/** Strata FLAT insentif SM (lib/insentif-sm-calc). Ditampilkan supaya angka Rp punya alasan. */
const SM_STRATA: Array<{ min: number; label: string; nominal: number }> = [
    { min: 110, label: "≥ 110%", nominal: 3_500_000 },
    { min: 100, label: "100 - 109,99%", nominal: 2_500_000 },
    { min: 90, label: "90 - 99,99%", nominal: 1_500_000 },
    { min: 0, label: "< 90%", nominal: 0 },
];

function SmIncentiveTable({ month, year }: { month: number; year: number }) {
    const [rows, setRows] = useState<SmIncentiveRow[]>([]);
    const [loading, setLoading] = useState(true);
    const { open, rowProps } = useExpandableRows();

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const res = await fetch(`/api/insentif-sales/sm-dashboard?month=${month}&year=${year}`);
                const data = await res.json();
                if (!cancelled) setRows(res.ok ? (data.rows ?? []) : []);
            } catch {
                if (!cancelled) { toast.error("Gagal memuat insentif SM."); setRows([]); }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [month, year]);

    const grandTotal = rows.reduce((a, r) => a + r.total, 0);

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={Wallet} no={3} title="Tabel Insentif SM" desc="Strata flat berbasis Value: <90% Rp 0 · 90–99,99% Rp 1,5jt · 100–109,99% Rp 2,5jt · ≥110% Rp 3,5jt. Hanya SM tertentu yang ikut skema." />
            {loading ? (
                <div className="flex items-center justify-center py-8 gap-2 text-slate-500 text-sm">
                    <Loader2 size={18} className="animate-spin text-indigo-400" /> Memuat…
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="ui-data-table min-w-[760px]">
                        <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                            <tr>
                                <th className="px-3 py-3">Nama SM</th>
                                <th className="px-3 py-3 text-right">Target Value</th>
                                <th className="px-3 py-3 text-right">Realisasi Value</th>
                                <th className="px-3 py-3 text-center">Pencapaian</th>
                                <th className="px-3 py-3 text-right bg-amber-500/10">Total Insentif</th>
                                <th className="px-3 py-3 text-center">Rincian</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.1]">
                            {rows.map((r) => {
                                const capaian = (Math.round(r.pctValue * 1e6) / 1e6) * 100;
                                return (
                                    <Fragment key={r.smName}>
                                        <tr {...rowProps(r.smName)}>
                                            <td className="px-3 py-3">
                                                <div className="font-semibold text-slate-200">{r.smName}</div>
                                                <div className="text-[10px] text-slate-500">
                                                    {r.jumlahBaris} baris sales{!r.berhak && " · tidak ikut skema insentif SM"}
                                                </div>
                                            </td>
                                            <td className="px-3 py-3 text-right font-mono text-slate-400">{formatRp(r.targetValue)}</td>
                                            <td className="px-3 py-3 text-right font-mono text-slate-300">{formatRp(r.realisasiValue)}</td>
                                            <td className="px-3 py-3 text-center font-bold text-slate-200">{capaian.toFixed(1)}%</td>
                                            <td className="px-3 py-3 text-right bg-amber-500/5 font-mono font-bold text-amber-400">{formatRp(r.total)}</td>
                                            <ExpandCell open={!!open[r.smName]} />
                                        </tr>
                                        {open[r.smName] && (
                                            <tr className="bg-black/30">
                                                <td colSpan={6} className="px-4 py-4">
                                                    <SmBreakdown r={r} />
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                );
                            })}
                            {rows.length === 0 && (
                                <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-500 italic">Belum ada data SM untuk periode ini.</td></tr>
                            )}
                        </tbody>
                        <tfoot>
                            <tr className="bg-black/50 border-t-2 border-amber-500/30 font-bold">
                                <td className="px-3 py-3 uppercase text-[11px] tracking-wider text-amber-300" colSpan={4}>Grand Total</td>
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

// ── Tabel Insentif SPV — strata Value (lib/insentif-spv-calc), fetch mandiri ──
interface SpvIncentiveDetail {
    principle: string;
    targetValue: number;
    realisasiValue: number;
    pctValue: number;
    rate: number;
    /** Support principle utk SPV pada principal ini — dikirim API, dulu tidak dideklarasikan. */
    support: number;
    /** rate − support (floor 0). Ini yang benar-benar dibayar distributor. */
    porsiDistributor: number;
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
    const { open, rowProps } = useExpandableRows();

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
            <SectionTitle icon={Wallet} no={3} title="Tabel Insentif SPV" desc="Berbasis Value. Principal dibayar penuh hanya bila pencapaiannya 100% atau lebih; di bawah itu Rp 0. Rate per principal mengikuti jumlah principal valid yang ditangani." />
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
                                <th className="px-3 py-3 text-center">Rincian</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.1]">
                            {rows.map((r) => (
                                <Fragment key={r.spvName}>
                                    <tr {...rowProps(r.spvName)}>
                                        <td className="px-3 py-3 font-semibold text-slate-200">{r.spvName}</td>
                                        <td className="px-3 py-3 text-center text-slate-300">{r.jumlahValid}</td>
                                        <td className="px-3 py-3 text-right font-mono text-slate-300">{formatRp(r.ratePerPrincipal)}</td>
                                        <td className="px-3 py-3 text-right bg-amber-500/5 font-mono font-bold text-amber-400">{formatRp(r.total)}</td>
                                        <ExpandCell open={!!open[r.spvName]} />
                                    </tr>
                                    {open[r.spvName] && (
                                        <tr className="bg-black/30">
                                            <td colSpan={5} className="px-4 py-4">
                                                <SpvBreakdown rincian={r.rincian} />
                                            </td>
                                        </tr>
                                    )}
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
    /* Diisi hanya lewat upload Excel (kolom "Tipe Sales" / "Status Insentif"). Baris manual
     * membiarkannya undefined supaya server memakai default lamanya. */
    tipeSales?: string;
    statusInsentif?: string;
}

// principle/branch dibiarkan KOSONG, bukan PRINCIPLES[0]/BRANCHES[0] — konstanta itu data demo
// (NESTLE/BANDUNG), dan mengisinya sebagai default membuat baris baru tampak sudah valid padahal
// principal-nya salah. Kosong akan ditolak validator sebelum simpan.
const EMPTY_ROW: TargetRow = {
    salesCode: "", salesName: "", principle: "", branch: "",
    channel: "GT", spvName: "", smName: "",
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
                    // Dibawa balik supaya Save manual tidak mereset status yang sudah benar
                    // (mis. ENERGIZER = principle) ke default server.
                    tipeSales: r.tipeSales, statusInsentif: r.statusInsentif,
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

    // Saran untuk input Principal/Cabang: nilai yang benar-benar ada di periode ini, ditambah
    // konstanta demo sebagai cadangan saat periode masih kosong. PRINCIPLES/BRANCHES sendiri
    // TIDAK cukup — isinya data dummy (NESTLE/BANDUNG), bukan principal produksi.
    const principleOptions = useMemo(
        () => [...new Set([...rows.map((r) => r.principle), ...PRINCIPLES])].filter(Boolean).sort(),
        [rows],
    );
    const branchOptions = useMemo(
        () => [...new Set([...rows.map((r) => r.branch), ...BRANCHES])].filter(Boolean).sort(),
        [rows],
    );

    function setCell<K extends keyof TargetRow>(idx: number, key: K, val: TargetRow[K]) {
        setRows((prev) => prev.map((r, i) => i === idx ? { ...r, [key]: val } : r));
    }

    function addRow() { setRows((prev) => [...prev, { ...EMPTY_ROW }]); }
    function removeRow(idx: number) { setRows((prev) => prev.filter((_, i) => i !== idx)); }

    async function handleSave() {
        const invalid = rows.filter((r) => !r.salesCode.trim() || !r.salesName.trim());
        if (invalid.length) { toast.error("Kode & nama salesman wajib diisi di semua baris."); return; }
        // principle ikut kunci upsert (salesCode+principle+periode) — kosong berarti baris ini
        // menimpa baris lain yang principle-nya juga kosong, bukan menyimpan data baru.
        const noPrinciple = rows.filter((r) => !r.principle.trim() || !r.branch.trim());
        if (noPrinciple.length) { toast.error(`${noPrinciple.length} baris belum punya Principal/Cabang.`); return; }
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
                // TANPA default. "NESTLE"/"BANDUNG" adalah data demo, dan memasangnya di sini
                // membuat tiga lapis validasi di bawah memeriksa nilai yang sudah dipalsukan:
                // baris pemisah/subtotal Excel lolos jadi target hantu, menaikkan `n` mix dan
                // memunculkan penerima yang bisa ditandai Lunas (audit 2026-08-28, C2 — M10
                // ternyata hanya tertutup di parser, tidak di jalur upload).
                principle: String(r.principle || ""),
                branch: String(r.branch || ""),
                channel: String(r.channel || "TT"),
                spvName: String(r.spvName || ""),
                smName: String(r.smName || ""),
                targetValue: Number(r.targetValue || 0),
                targetEc: Number(r.targetEc || 0),
                targetAo: Number(r.targetAo || 0),
                targetIa: Number(r.targetIa || 0),
                splmValue: Number(r.splmValue || 0),
                // Dulu dua kolom ini di-parse lalu dibuang di sini, jadi ENERGIZER tidak pernah
                // bisa di-set "principle" lewat upload — server selalu jatuh ke default.
                tipeSales: String(r.tipeSales || "exclusive"),
                statusInsentif: String(r.statusInsentif || "distributor_principle"),
            })) as TargetRow[];

            const invalid = parsed.filter((r) => !r.salesCode?.trim() || !r.salesName?.trim());
            if (invalid.length) {
                toast.error(`${invalid.length} baris tidak punya kode/nama salesman`);
                setExcelUploading(false);
                return;
            }
            // Principal ikut kunci upsert (salesCode+principle+periode) dan Cabang menentukan
            // acuan Value (DPP vs NILAI_JUAL, lib/insentif-value-source). Keduanya tidak boleh
            // ditebak — baris tanpa Principal biasanya baris pemisah/subtotal di Excel.
            const noPrinciple = parsed.filter((r) => !r.principle?.trim() || !r.branch?.trim());
            if (noPrinciple.length) {
                const contoh = noPrinciple.slice(0, 3).map((r) => r.salesCode).join(", ");
                toast.error(
                    `${noPrinciple.length} baris tidak punya Principal/Cabang (${contoh}${noPrinciple.length > 3 ? ", …" : ""}). Upload dibatalkan.`,
                );
                setExcelUploading(false);
                return;
            }
            // Kalau SEMUA baris bertarget 0, hampir pasti header kolomnya tidak terbaca —
            // bukan target yang benar-benar nol. Tolak daripada menimpa target lama dengan nol.
            if (parsed.length > 0 && parsed.every((r) => !r.targetValue)) {
                toast.error("Semua baris bertarget 0 — cek nama kolom 'Target Value (Rp)' di file. Upload dibatalkan.");
                setExcelUploading(false);
                return;
            }

            const payload = parsed.map((r) => ({ ...r, periodMonth: month, periodYear: year }));
            const res = await fetch("/api/insentif-sales/targets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await readApi(res);
            if (!res.ok) throw new Error(String(data.error ?? "Server error"));
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
                                        {/* Input bebas + datalist, BUKAN select: principal/cabang nyata
                                            ("ABC PRESIDENT INDONESIA, PT") tidak ada di konstanta demo
                                            PRINCIPLES/BRANCHES, dan select akan menampilkan opsi pertama
                                            (NESTLE/BANDUNG) lalu menimpa nilai asli begitu disentuh. */}
                                        <td className="px-2 py-2">
                                            <input className={inp + " min-w-[140px]"} list="target-principle-options" value={r.principle} onChange={(e) => setCell(i, "principle", e.target.value)} placeholder="Principal" />
                                        </td>
                                        <td className="px-2 py-2">
                                            <input className={inp} list="target-branch-options" value={r.branch} onChange={(e) => setCell(i, "branch", e.target.value)} placeholder="Cabang" />
                                        </td>
                                        <td className="px-2 py-2 text-center">
                                            <select className={inp + " w-16 text-center"} value={r.channel} onChange={(e) => setCell(i, "channel", e.target.value)}>
                                                <option>GT</option><option>TT</option><option>MT</option>
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
                        {/* Saran diambil dari data periode yang sedang dimuat, bukan konstanta demo. */}
                        <datalist id="target-principle-options">
                            {principleOptions.map((p) => <option key={p} value={p} />)}
                        </datalist>
                        <datalist id="target-branch-options">
                            {branchOptions.map((b) => <option key={b} value={b} />)}
                        </datalist>
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

/**
 * Ambang Target AO untuk skema GT/TT. Ini SATU-SATUNYA kontrol di halaman ini yang mengubah
 * nominal yang dibayar, jadi ia tidak disembunyikan di balik ikon: statusnya tertulis, sebabnya
 * tertulis, dan penggantiannya minta konfirmasi. Default "fixed240" = perilaku sejak awal.
 */
/**
 * Setelan berbentuk DAFTAR (cabang beracuan NILAI_JUAL, SM yang ikut skema insentif).
 * Keduanya dulu konstanta di kode: menambah satu principal berarti satu deploy.
 *
 * Editor sengaja textarea satu-baris-satu-nilai, bukan tabel dengan tombol tambah/hapus —
 * isinya belasan nama, dan menempel dari Excel harus bekerja apa adanya.
 */
function DaftarSetelan({ judul, desc, field, contoh, catatan }: {
    judul: string;
    desc: string;
    field: "branchNilaiJual" | "smBerhak";
    contoh: string;
    catatan: string;
}) {
    const [teks, setTeks] = useState<string | null>(null);
    const [tersimpan, setTersimpan] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);

    const muat = useCallback(async () => {
        try {
            const res = await fetch("/api/insentif-sales/settings");
            const data = await readApi(res);
            if (!res.ok) throw new Error(String(data.error ?? "Gagal memuat setelan."));
            const daftar = (Array.isArray(data[field]) ? data[field] : []) as string[];
            setTersimpan(daftar);
            setTeks(daftar.join("\n"));
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal memuat setelan.");
        }
    }, [field]);
    useEffect(() => { void muat(); }, [muat]);

    const nilai = useMemo(
        () => (teks ?? "").split("\n").map((v) => v.trim().toUpperCase().replace(/\s+/g, " ")).filter(Boolean),
        [teks],
    );
    const berubah = teks !== null && nilai.join("|") !== tersimpan.join("|");

    async function simpan() {
        // Mengubah daftar ini menggeser nominal, jadi perubahannya dieja dulu — satu baris
        // terhapus tanpa sadar saat menempel dari Excel tidak boleh lolos diam-diam.
        const hilang = tersimpan.filter((v) => !nilai.includes(v));
        const tambah = nilai.filter((v) => !tersimpan.includes(v));
        const rincian = [
            tambah.length ? `+ ${tambah.join(", ")}` : "",
            hilang.length ? `− ${hilang.join(", ")}` : "",
        ].filter(Boolean).join("\n");
        if (!window.confirm(`Simpan perubahan ${judul}?

${rincian || "(tidak ada perubahan)"}

${catatan}`)) return;
        setSaving(true);
        try {
            const res = await fetch("/api/insentif-sales/settings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ [field]: nilai }),
            });
            const data = await readApi(res);
            if (!res.ok) throw new Error(String(data.error ?? "Gagal menyimpan setelan."));
            const baru = (Array.isArray(data[field]) ? data[field] : []) as string[];
            setTersimpan(baru);
            setTeks(baru.join("\n"));
            toast.success(`${judul} tersimpan (${baru.length} entri).`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal menyimpan setelan.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={Filter} no={0} title={judul} desc={desc} />
            <div className="flex flex-col gap-2">
                <textarea
                    aria-label={judul}
                    value={teks ?? ""}
                    disabled={teks === null || saving}
                    onChange={(e) => setTeks(e.target.value)}
                    rows={5}
                    spellCheck={false}
                    placeholder={teks === null ? "Memuat…" : contoh}
                    className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 outline-none focus:border-indigo-500"
                />
                <div className="flex items-center gap-3 flex-wrap">
                    <button type="button" onClick={simpan} disabled={!berubah || saving}
                        className="px-4 py-2 rounded-lg bg-indigo-600/80 hover:bg-indigo-600 text-white text-sm font-medium disabled:opacity-40">
                        {saving ? "Menyimpan…" : "Simpan"}
                    </button>
                    <span className="text-[11px] text-slate-500">
                        {nilai.length} entri · satu per baris · huruf besar/kecil dan spasi ganda diabaikan
                    </span>
                </div>
                <p className="text-[11px] text-amber-400/80">{catatan}</p>
            </div>
        </div>
    );
}

function GtAoTargetToggle() {
    const [mode, setMode] = useState<"fixed240" | "file" | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch("/api/insentif-sales/settings");
                const data = await res.json();
                if (!cancelled && res.ok) setMode(data.gtAoMode);
            } catch {
                if (!cancelled) toast.error("Gagal memuat setelan ambang AO.");
            }
        })();
        return () => { cancelled = true; };
    }, []);

    async function ganti(next: "fixed240" | "file") {
        if (next === mode) return;
        const pesan = next === "fixed240"
            ? "Ubah ambang AO GT/TT ke 240 untuk SEMUA sales? Nominal insentif AO akan dihitung ulang."
            : "Ubah ambang AO GT/TT ke Target AO di file target? Nominal insentif AO akan dihitung ulang.";
        if (!window.confirm(pesan)) return;
        setSaving(true);
        try {
            const res = await fetch("/api/insentif-sales/settings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ gtAoMode: next }),
            });
            const data = await readApi(res);
            if (!res.ok) throw new Error(String(data.error ?? "Gagal menyimpan setelan"));
            setMode(next);
            toast.success("Ambang AO diperbarui. Muat ulang dashboard untuk melihat nominal baru.");
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal menyimpan setelan");
        }
        setSaving(false);
    }

    const aktif = mode === "fixed240";
    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
            <SectionTitle icon={Target} no={0} title="Ambang Target AO (GT/TT)" desc="Menentukan pembagi pencapaian AO pada skema GT/TT. Mengubahnya mengubah nominal yang dibayar." />
            <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="text-xs text-slate-400 max-w-xl">
                    {mode === null ? "Memuat setelan…" : aktif ? (
                        <>
                            <span className="text-emerald-400 font-semibold">ON</span> — semua sales GT/TT dinilai
                            terhadap <span className="font-mono text-slate-200">240</span>. Target AO di file target
                            diabaikan untuk perhitungan (tetap tampil sebagai pembanding).
                        </>
                    ) : (
                        <>
                            <span className="text-amber-400 font-semibold">OFF</span> — tiap sales dinilai terhadap
                            Target AO barisnya sendiri di file target.
                        </>
                    )}
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={aktif}
                    aria-label="Ambang AO tetap 240"
                    disabled={mode === null || saving}
                    onClick={() => ganti(aktif ? "file" : "fixed240")}
                    className={`relative inline-flex h-7 w-14 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 ${aktif ? "bg-emerald-500/30 border-emerald-500/50" : "bg-white/5 border-white/15"}`}
                >
                    <span className={`inline-block h-5 w-5 rounded-full bg-slate-200 transition-transform motion-reduce:transition-none ${aktif ? "translate-x-8" : "translate-x-1"}`} />
                </button>
            </div>
        </div>
    );
}

interface UnmatchedRow {
    salesCode: string;
    principle: string;
    branch: string;
    baris: number;
    dpp: number;
    tanggalAwal: string;
    tanggalAkhir: string;
    contohNota: string[];
    sebab: "tanpa baris target" | "target 0";
}

/**
 * Kombinasi kode sales x principal yang punya penjualan tapi tidak punya target. Nomor nota
 * ikut ditampilkan karena tanpa itu "22 kombinasi tanpa target" tidak bisa ditindaklanjuti:
 * yang dibutuhkan orang untuk memetakan adalah nota yang bisa dibuka di Accurate.
 * Diambil hanya saat daftar dibuka — query agregasi nota tidak perlu dibayar setiap
 * pemuatan dashboard.
 */
function UnmatchedProgressList({ month, year }: { month: number; year: number }) {
    const [rows, setRows] = useState<UnmatchedRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    async function muat() {
        if (rows || loading) return;
        setLoading(true);
        setError("");
        try {
            const res = await fetch(`/api/insentif-sales/unmatched?month=${month}&year=${year}`);
            const data = await readApi(res);
            if (!res.ok) throw new Error(String(data.error ?? "Gagal memuat daftar"));
            setRows((data.rows ?? []) as UnmatchedRow[]);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Gagal memuat daftar");
        }
        setLoading(false);
    }

    function salin() {
        if (!rows?.length) return;
        const teks = ["Kode\tPrincipal\tCabang\tSebab\tBaris\tDPP\tContoh Nota"]
            .concat(rows.map((r) => [r.salesCode, r.principle, r.branch, r.sebab, r.baris, Math.round(r.dpp), r.contohNota.join(" ")].join("\t")))
            .join("\n");
        navigator.clipboard.writeText(teks)
            .then(() => toast.success(`${rows.length} baris disalin, siap ditempel ke Excel.`))
            .catch(() => toast.error("Gagal menyalin ke clipboard."));
    }

    return (
        <details className="mt-2 group" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void muat(); }}>
            <summary className="cursor-pointer text-xs font-semibold underline underline-offset-2 list-none [&::-webkit-details-marker]:hidden inline-flex items-center gap-1">
                Lihat kombinasi tanpa target
                <ChevronDown size={12} className="transition-transform group-open:rotate-180 motion-reduce:transition-none" />
            </summary>
            <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3">
                {loading && <p className="text-xs opacity-80">Memuat daftar…</p>}
                {error && <p className="text-xs text-rose-300">{error}</p>}
                {rows && rows.length === 0 && (
                    <p className="text-xs opacity-80">Semua kombinasi sudah punya target.</p>
                )}
                {rows && rows.length > 0 && (
                    <>
                        <div className="flex items-center justify-between gap-2 mb-2">
                            <span className="text-[11px] opacity-80">
                                Diurut dari nilai terbesar. Nota di kolom terakhir bisa dibuka di Accurate untuk
                                memastikan salesman sebenarnya.
                            </span>
                            <button onClick={salin} className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border border-white/15 hover:bg-white/10">
                                Salin
                            </button>
                        </div>
                        <div className="overflow-x-auto max-h-80">
                            <table className="w-full text-[11px]">
                                <thead className="text-slate-400 uppercase tracking-wider sticky top-0 bg-[#151820]">
                                    <tr>
                                        <th className="text-left font-semibold py-1.5 px-2">Kode</th>
                                        <th className="text-left font-semibold py-1.5 px-2">Principal</th>
                                        <th className="text-left font-semibold py-1.5 px-2">Cabang</th>
                                        <th className="text-left font-semibold py-1.5 px-2">Sebab</th>
                                        <th className="text-right font-semibold py-1.5 px-2">Nilai (DPP)</th>
                                        <th className="text-right font-semibold py-1.5 px-2">Baris</th>
                                        <th className="text-left font-semibold py-1.5 px-2">Periode</th>
                                        <th className="text-left font-semibold py-1.5 px-2">Contoh nota</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5">
                                    {rows.map((r) => (
                                        <tr key={`${r.salesCode}|${r.principle}`}>
                                            <td className="py-1.5 px-2 font-mono text-slate-200">{r.salesCode}</td>
                                            <td className="py-1.5 px-2 text-slate-300">{r.principle}</td>
                                            <td className="py-1.5 px-2 text-slate-400">{r.branch}</td>
                                            <td className="py-1.5 px-2">
                                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${r.sebab === "target 0" ? "border-amber-500/40 text-amber-300" : "border-white/15 text-slate-400"}`}>
                                                    {r.sebab}
                                                </span>
                                            </td>
                                            <td className="py-1.5 px-2 text-right font-mono text-slate-200">{formatRp(Math.round(r.dpp))}</td>
                                            <td className="py-1.5 px-2 text-right font-mono text-slate-400">{formatQty(r.baris)}</td>
                                            <td className="py-1.5 px-2 font-mono text-slate-500">{r.tanggalAwal} s/d {r.tanggalAkhir}</td>
                                            <td className="py-1.5 px-2 font-mono text-slate-400">{r.contohNota.join(", ") || "-"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>
        </details>
    );
}

// ── Admin: input progress harian (manual atau upload XLSX/CSV) ─────────────────
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
    const [menghapus, setMenghapus] = useState(false);
    // Daftar cabang beracuan NILAI_JUAL diambil dari setelan, bukan konstanta di kode.
    // null = belum termuat → upload ditahan. Memakai bawaan diam-diam saat setelan gagal
    // dimuat berarti file diproses dengan aturan yang BUKAN aturan yang sedang berlaku,
    // dan hasilnya tersimpan sebagai realisasi tanpa ada yang tahu.
    const [branchNilaiJual, setBranchNilaiJual] = useState<string[] | null>(null);
    useEffect(() => {
        let batal = false;
        (async () => {
            try {
                const res = await fetch("/api/insentif-sales/settings");
                const data = await readApi(res);
                if (!res.ok) throw new Error(String(data.error ?? "Gagal memuat setelan."));
                if (!batal) setBranchNilaiJual(Array.isArray(data.branchNilaiJual) ? data.branchNilaiJual as string[] : []);
            } catch {
                if (!batal) toast.error("Setelan cabang NILAI_JUAL gagal dimuat. Muat ulang halaman sebelum mengunggah closing.");
            }
        })();
        return () => { batal = true; };
    }, []);

    /**
     * Hapus seluruh realisasi closing periode terpilih. Wajib sebelum unggah ulang kalau
     * tanggal barisnya bisa bergeser dari unggahan sebelumnya: POST hanya menimpa kombinasi
     * (kode, principal, periode, TANGGAL) yang ada di file baru, jadi baris lama bertanggal
     * lain tetap tinggal dan ikut terhitung. Dulu ini DELETE manual lewat psql di VPS.
     */
    async function handleHapusPeriode() {
        const [tahun, bulan] = period.split("-").map(Number);
        if (!tahun || !bulan) { toast.error("Periode belum dipilih."); return; }
        const label = `${MONTH_LABELS[bulan - 1]} ${tahun}`;
        // confirm() native: memblokir, bisa dipakai keyboard, dan tidak perlu komponen modal
        // sendiri untuk satu tombol. Periodenya dieja supaya tidak ada yang menghapus
        // bulan yang salah karena pemilih periode masih menunjuk bulan lain.
        if (!window.confirm(
            `Hapus SELURUH realisasi closing ${label}?

`
            + `Target dan catatan pembayaran tidak ikut terhapus. Setelah ini closing `
            + `${label} harus diunggah ulang, kalau tidak pencapaiannya kosong.`,
        )) return;
        setMenghapus(true);
        try {
            const res = await fetch(`/api/insentif-sales/progress?month=${bulan}&year=${tahun}`, { method: "DELETE" });
            const data = await readApi(res);
            if (!res.ok) throw new Error(String(data.error ?? "Gagal menghapus periode."));
            const n = Number(data.deleted ?? 0);
            if (n === 0) toast.info(`Tidak ada realisasi ${label} untuk dihapus.`);
            else toast.success(`${n.toLocaleString("id-ID")} baris realisasi ${label} dihapus. Unggah ulang closing-nya sekarang.`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal menghapus periode.");
        } finally {
            setMenghapus(false);
        }
    }

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
        // replaced/skipped hanya dikirim jalur upload (mode ganti); input manual tidak memakainya.
        return data as { inserted: number; replaced?: number; skipped?: number };
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
        // Tanpa setelan, tiap baris akan dinilai dengan daftar bawaan — hasilnya tersimpan
        // sebagai realisasi dan tidak ada yang tahu aturannya bukan yang sedang berlaku.
        if (branchNilaiJual === null) {
            toast.error("Setelan cabang NILAI_JUAL belum termuat. Muat ulang halaman lalu ulangi.");
            e.target.value = "";
            return;
        }
        setUploading(true);
        try {
            // Baca via XLSX — menangani .xlsx maupun .csv, termasuk field ber-koma di dalam
            // tanda kutip ("ABC PRESIDENT INDONESIA, PT" / alamat) yang bikin split manual geser kolom.
            // ponytail: dimuat saat dipakai. Import statis menyeret ~900 KB xlsx ke bundle route
            // ini untuk semua user, padahal cuma handler upload yang membutuhkannya.
            const XLSX = await import("xlsx");
            const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
            // Nama kolom file closing tidak seragam antar export — terima alias, case-insensitive.
            const norm = (k: string) => k.trim().toUpperCase();

            const [year, month] = period.split("-").map(Number);
            const parsed = rawRows.map((rowObj) => {
                const byKey = new Map(Object.entries(rowObj).map(([k, v]) => [norm(k), v]));
                const get = (...names: string[]) => {
                    for (const n of names) {
                        const v = byKey.get(norm(n));
                        if (v !== undefined && v !== "") return String(v).trim();
                    }
                    return "";
                };
                // Buang pemisah ribuan tapi PERTAHANKAN tanda minus & desimal —
                // baris retur bernilai negatif, kalau tandanya hilang retur malah menambah realisasi.
                // Dua format ribuan beredar di file closing: Inggris (1,234,567.89) dan
                // Indonesia (1.234.567,89). Deteksi dari polanya — kalau dipaksa satu format,
                // "-533.000.000" terbaca -533 dan realisasi satu principal menguap.
                const num = (val: string) => {
                    const cleaned = val.replace(/[^\d.,-]/g, "");
                    if (!cleaned) return 0;
                    // Format Indonesia: titik sebagai pemisah ribuan (selalu 3 digit), koma desimal.
                    const idFormat = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned);
                    const normalized = idFormat
                        ? cleaned.replace(/\./g, "").replace(",", ".")
                        : cleaned.replace(/,/g, "");
                    const n = parseFloat(normalized);
                    return Number.isFinite(n) ? n : 0;
                };
                return {
                    salesCode: get("KODE_SALESMAN"),
                    salesName: get("SALESMAN"),
                    principle: get("PRINCIPAL"),
                    branch: get("JENISPRODUK"),
                    tanggal: get("TANGGAL"),
                    invoiceNumber: get("NO_INVOICE", "NO_NOTA") || undefined,
                    spvName: get("GOLONGAN") || undefined,
                    dpp: num(get("DPP")),
                    nilaiJual: num(get("NILAI_JUAL")),
                    ec: num(get("EC")),
                    ao: num(get("AO")),
                    ia: num(get("IA", "ITEM AKTIF")),
                };
            });

            // Cabang kadang kosong (retur di file ADNAN: 2.508 baris, -533 jt). Kalau dibuang,
            // retur hilang dan realisasi jadi lebih tinggi dari seharusnya. Jadi cabang
            // diturunkan dari PRINCIPAL memakai baris LAIN di file yang sama yang cabangnya terisi.
            const branchByPrincipal = new Map<string, Map<string, number>>();
            for (const r of parsed) {
                if (!r.principle || !r.branch) continue;
                const inner = branchByPrincipal.get(r.principle) ?? new Map<string, number>();
                inner.set(r.branch, (inner.get(r.branch) ?? 0) + 1);
                branchByPrincipal.set(r.principle, inner);
            }
            const ambigu = new Set<string>();
            const branchOf = (principle: string, branch: string) => {
                if (branch) return branch;
                const inner = branchByPrincipal.get(principle);
                if (!inner || inner.size === 0) return "";
                if (inner.size > 1) ambigu.add(principle);
                // terbanyak menang — deterministik, dan principal ambigu dilaporkan ke user
                return [...inner.entries()].sort((a, b) => b[1] - a[1])[0][0];
            };

            // Tanggal transaksi asli dari file. XLSX dibaca dgn cellDates sehingga TANGGAL
            // berupa Date; kalau gagal dibaca, jatuh ke tanggal 1 periode itu (bukan hari ini,
            // supaya upload ulang di hari berbeda tetap menghasilkan baris yang sama).
            const isoDate = (raw: string) => {
                const d = excelDateToIso(raw);
                return d ?? `${year}-${String(month).padStart(2, "0")}-01`;
            };

            // AGREGASI sebelum kirim. File closing berada di level baris barang (135 ribu baris
            // untuk 2 SM); sistem hanya memakai jumlah per periode, jadi menjumlahkan per
            // (sales, principal, cabang, tanggal) memberi angka identik dengan payload jauh
            // lebih kecil — sekaligus menghapus kebutuhan dedup per nota yang dulu salah.
            const bucket = new Map<string, {
                salesCode: string; salesName?: string; principle: string; branch: string; date: string;
                periodMonth: number; periodYear: number; spvName?: string; invoiceNumber?: string;
                achievedValueDpp: number; achievedEc: number; achievedAo: number; achievedIa: number;
            }>();
            let dibuang = 0;
            let nilaiDibuang = 0;
            for (const r of parsed) {
                const branch = branchOf(r.principle, r.branch);
                if (!r.salesCode || !r.principle || !branch) {
                    dibuang++;
                    nilaiDibuang += r.dpp;
                    continue;
                }
                const date = isoDate(r.tanggal);
                const k = `${r.salesCode}|${r.principle}|${branch}|${date}`;
                const cur = bucket.get(k) ?? {
                    // Nama ikut dikirim supaya kode yang belum punya target tetap bisa
                    // dikenali orangnya oleh deteksi kandidat Gabung Kode Sales.
                    salesCode: r.salesCode, salesName: r.salesName, principle: r.principle, branch, date,
                    periodMonth: month, periodYear: year, spvName: r.spvName,
                    // Satu nota PERWAKILAN per ember (sales x principal x cabang x tanggal).
                    // Peringkasan lama membuang nomor nota sama sekali, sehingga baris yang
                    // kode sales-nya tidak dikenali tidak bisa ditelusuri ke Accurate — daftar
                    // "kombinasi tanpa target" cuma bisa bilang ada masalah, tidak menunjukkan
                    // di mana. Satu nota per tanggal sudah cukup untuk membuka jejaknya.
                    invoiceNumber: r.invoiceNumber,
                    achievedValueDpp: 0, achievedEc: 0, achievedAo: 0, achievedIa: 0,
                };
                // Cabang mana yang memakai NILAI_JUAL diatur di panel setelan, bukan di kode.
                cur.achievedValueDpp += realisasiValue(branch, r.dpp, r.nilaiJual, branchNilaiJual ?? undefined);
                cur.achievedEc += r.ec;
                cur.achievedAo += r.ao;
                cur.achievedIa += r.ia;
                if (!cur.salesName && r.salesName) cur.salesName = r.salesName;
                if (!cur.spvName && r.spvName) cur.spvName = r.spvName;
                if (!cur.invoiceNumber && r.invoiceNumber) cur.invoiceNumber = r.invoiceNumber;
                bucket.set(k, cur);
            }
            const payload = [...bucket.values()];

            if (payload.length === 0) { toast.error("Tidak ada baris valid. Pastikan kolom KODE_SALESMAN dan PRINCIPAL terisi."); return; }

            const data = await submitProgress(payload);
            toast.success(
                `${parsed.length.toLocaleString("id-ID")} baris file diringkas jadi ${data.inserted.toLocaleString("id-ID")} baris harian` +
                (data.replaced ? `, mengganti ${data.replaced.toLocaleString("id-ID")} baris lama` : "") + ".",
            );
            if (dibuang > 0) {
                toast.warning(`${dibuang.toLocaleString("id-ID")} baris dilewati (kode sales/principal kosong), total nilai Rp ${Math.round(nilaiDibuang).toLocaleString("id-ID")}.`);
            }
            if (ambigu.size > 0) {
                toast.warning(`Cabang diturunkan dari principal yang punya lebih dari satu cabang: ${[...ambigu].join(", ")}. Periksa hasilnya.`);
            }
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
            <GtAoTargetToggle />
            <DaftarSetelan
                judul="Cabang beracuan NILAI_JUAL"
                desc="Cabang (kolom JENISPRODUK di file closing) yang realisasi Value-nya diambil dari NILAI_JUAL. Cabang di luar daftar ini memakai DPP."
                field="branchNilaiJual"
                contoh={`VINDA\nKINO NON FOOD\nMIX NON FOOD\nABC`}
                catatan="Berlaku untuk unggahan closing BERIKUTNYA. Periode yang sudah masuk harus dihapus lalu diunggah ulang agar angkanya ikut berubah."
            />
            <DaftarSetelan
                judul="SM yang ikut skema insentif"
                desc="Nama SM yang berhak atas insentif SM (strata flat berbasis Value). Dicocokkan sebagai kata utuh, jadi HENDRIK tidak akan cocok dengan HENDRIKUS."
                field="smBerhak"
                contoh={"HENDRIK"}
                catatan="Langsung mengubah nominal insentif SM periode mana pun yang dihitung setelah ini."
            />
            <TargetInputSection />
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <SectionTitle icon={Upload} no={2} title="Input Progress Harian" desc="Principal dan cabang dibaca per baris. Satu file dapat berisi beberapa principal." />

                <div className="flex flex-wrap items-end gap-3 mb-4">
                    <Field label="Periode">
                        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500" />
                    </Field>
                    <button
                        type="button"
                        onClick={handleHapusPeriode}
                        disabled={menghapus}
                        className="px-3 py-2.5 rounded-lg border border-rose-500/40 text-rose-300 text-sm hover:bg-rose-500/10 disabled:opacity-50 transition-colors"
                    >
                        {menghapus ? "Menghapus…" : "Hapus realisasi periode ini"}
                    </button>
                    <p className="text-[11px] text-slate-500 basis-full">
                        Hapus dulu kalau closing periode ini pernah diunggah dengan aturan yang berbeda —
                        unggah ulang saja hanya menimpa baris bertanggal sama, sisanya ikut terhitung dua kali.
                        Target dan catatan pembayaran tidak ikut terhapus.
                    </p>
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
                        <span className="text-sm font-semibold text-slate-200">{uploading ? "Memproses…" : "Unggah Laporan Penjualan (XLSX/CSV)"}</span>
                        <span className="text-[11px] text-slate-500 text-center px-4">Kolom: KODE_SALESMAN, PRINCIPAL, JENISPRODUK, DPP, AO, EC, IA/Item Aktif (+ NO_NOTA & GOLONGAN opsional)</span>
                        <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={uploading} onChange={handleUpload} />
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
            <CodeMergeSection period={period} />
            <SpvMismatchSection period={period} />
            <HierarchyAssignmentSection />
        </div>
    );
}

// ── Kelola Hierarki (Bagian C) — assignment additive; blok Link Akun mengaktifkan
// scoping "SPV/SM cuma lihat bawahan sendiri" secara opt-in per user ──────────────
interface SpvSalesAssignmentRow { id: string; salesCode: string; spvName: string; }
interface SmSpvAssignmentRow { id: string; spvName: string; smName: string; }
interface UserIdentityRow { id: string; name: string; email: string; hierarchyRole: "spv" | "sm" | "sales" | null; hierarchyName: string | null; }
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
    const [selRole, setSelRole] = useState<"spv" | "sm" | "sales">("spv");
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
                    <select className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-500 w-24" value={selRole} onChange={(e) => setSelRole(e.target.value as "spv" | "sm" | "sales")}>
                        <option value="spv">SPV</option>
                        <option value="sm">SM</option>
                        <option value="sales">Sales</option>
                    </select>
                    <input
                        className={inputCls}
                        placeholder={selRole === "sales" ? "KODE SALES (mis. M-FS)" : "Nama identitas (persis spv_name/sm_name)"}
                        value={selName}
                        onChange={(e) => setSelName(e.target.value)}
                    />
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

// ── Sinkronisasi SPV: target vs closing (kolom GOLONGAN) ──────────────────────
// Sistem tidak menebak mana yang benar — semua kandidat ditampilkan, user memilih.
interface SpvMismatchRow {
    salesCode: string;
    salesName: string;
    principle: string;
    spvTarget: string | null;
    spvClosing: string[];
}

function SpvMismatchSection({ period }: { period: string }) {
    const [rows, setRows] = useState<SpvMismatchRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState<string | null>(null);
    const [year, month] = useMemo(() => period.split("-").map(Number), [period]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/insentif-sales/spv-mismatch?month=${month}&year=${year}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal memuat data SPV");
            setRows(data.rows ?? []);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal memuat data SPV");
        }
        setLoading(false);
    }, [month, year]);

    useEffect(() => { load(); }, [load]);

    async function sync(r: SpvMismatchRow, spvName: string) {
        const k = `${r.salesCode}|${r.principle}`;
        setSyncing(k);
        try {
            const res = await fetch("/api/insentif-sales/spv-mismatch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ salesCode: r.salesCode, principle: r.principle, periodMonth: month, periodYear: year, spvName }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal sinkronkan SPV");
            toast.success(`${r.salesCode} / ${r.principle} → SPV ${spvName}`);
            await load();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal sinkronkan SPV");
        }
        setSyncing(null);
    }

    if (!loading && rows.length === 0) return null;

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-rose-500/25 p-5">
            <div className="flex items-center justify-between mb-3">
                <div>
                    <h3 className="text-sm font-semibold text-rose-200">SPV Tidak Sinkron ({rows.length})</h3>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                        SPV di file target berbeda dengan kolom GOLONGAN di file closing. Pilih mana yang benar —
                        pilihan ikut memperbarui mapping hierarki.
                    </p>
                </div>
                <button onClick={load} disabled={loading} className="px-3 py-1.5 rounded bg-white/5 border border-white/10 text-xs text-slate-300 disabled:opacity-50">
                    {loading ? "Memuat…" : "Muat ulang"}
                </button>
            </div>
            <div className="max-h-72 overflow-y-auto border border-white/10 rounded-lg divide-y divide-white/5">
                {loading && rows.length === 0 ? (
                    <div className="p-3 text-xs text-slate-500">Memuat…</div>
                ) : rows.map((r) => {
                    const k = `${r.salesCode}|${r.principle}`;
                    const busy = syncing === k;
                    return (
                        <div key={k} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-xs">
                            <span className="font-mono text-slate-400 w-20 shrink-0">{r.salesCode}</span>
                            <span className="text-slate-300 flex-1 min-w-[10rem] truncate" title={`${r.salesName} — ${r.principle}`}>
                                {r.salesName} <span className="text-slate-600">·</span> <span className="text-slate-500">{r.principle}</span>
                            </span>
                            <span className="text-slate-500 shrink-0">
                                target: <span className={r.spvTarget ? "text-amber-300" : "text-rose-400 italic"}>{r.spvTarget ?? "kosong"}</span>
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0">
                                {r.spvTarget && (
                                    <button onClick={() => sync(r, r.spvTarget!)} disabled={busy}
                                        className="px-2 py-1 rounded bg-amber-600/30 border border-amber-500/40 text-amber-200 disabled:opacity-50">
                                        pakai {r.spvTarget}
                                    </button>
                                )}
                                {r.spvClosing.map((spv) => (
                                    <button key={spv} onClick={() => sync(r, spv)} disabled={busy}
                                        className="px-2 py-1 rounded bg-indigo-600/30 border border-indigo-500/40 text-indigo-200 disabled:opacity-50">
                                        pakai {spv} <span className="text-indigo-400/70">(closing)</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ── Konfirmasi penggabungan kode sales (pergantian orang di tengah bulan) ─────
// Prefiks rute sama + kode beda. TIDAK otomatis: FS1_GITO (GT) vs FS1_MT_SYAHRUL (MT)
// prefiksnya sama tapi orang & channel beda — user yang memutuskan.
interface MergeMember { salesCode: string; salesName: string }
interface MergeGroup { prefix: string; members: MergeMember[] }

function CodeMergeSection({ period }: { period: string }) {
    const [groups, setGroups] = useState<MergeGroup[]>([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [target, setTarget] = useState<Record<string, string>>({});
    const [year, month] = useMemo(() => period.split("-").map(Number), [period]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/insentif-sales/code-merge?month=${month}&year=${year}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal memuat kandidat merge");
            setGroups(data.groups ?? []);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal memuat kandidat merge");
        }
        setLoading(false);
    }, [month, year]);

    useEffect(() => { load(); }, [load]);

    async function decide(g: MergeGroup, payload: { fromSalesCode: string; toSalesCode?: string; decision: "merge" | "separate" }[]) {
        setBusy(g.prefix);
        try {
            const res = await fetch("/api/insentif-sales/code-merge", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload.map((p) => ({ ...p, prefix: g.prefix, periodMonth: month, periodYear: year }))),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal simpan keputusan");
            toast.success(`${g.prefix}: ${data.saved} keputusan tersimpan.`);
            await load();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal simpan keputusan");
        }
        setBusy(null);
    }

    if (!loading && groups.length === 0) return null;

    return (
        <div className="bg-[#1a1c23]/60 rounded-xl border border-amber-500/25 p-5">
            <div className="flex items-center justify-between mb-3">
                <div>
                    <h3 className="text-sm font-semibold text-amber-200">Konfirmasi Penggabungan Sales ({groups.length})</h3>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                        Beberapa kode sales memakai nomor rute yang sama (tanda pergantian orang di tengah
                        bulan) atau nama orang yang sama dengan rute berbeda (satu orang, dua kode). Pilih
                        kode tujuan kalau pencapaiannya harus digabung, atau tandai Pisah kalau memang dua
                        orang berbeda.
                    </p>
                </div>
                <button onClick={load} disabled={loading} className="px-3 py-1.5 rounded bg-white/5 border border-white/10 text-xs text-slate-300 disabled:opacity-50 shrink-0">
                    {loading ? "Memuat…" : "Muat ulang"}
                </button>
            </div>
            <div className="space-y-2.5 max-h-96 overflow-y-auto">
                {loading && groups.length === 0 ? (
                    <div className="p-3 text-xs text-slate-500">Memuat…</div>
                ) : groups.map((g) => {
                    const to = target[g.prefix] ?? "";
                    const working = busy === g.prefix;
                    return (
                        <div key={g.prefix} className="border border-white/10 rounded-lg p-3">
                            <div className="flex items-center gap-2 mb-2">
                                <span className="font-mono text-amber-300 text-xs font-semibold">{g.prefix}</span>
                                <span className="text-[11px] text-slate-500">{g.members.length} kode</span>
                            </div>
                            <div className="space-y-1 mb-2.5">
                                {g.members.map((m) => (
                                    <div key={m.salesCode} className="flex items-center gap-2 text-xs">
                                        <span className="font-mono text-slate-400 w-20 shrink-0">{m.salesCode}</span>
                                        <span className="text-slate-300 truncate">{m.salesName}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-2.5">
                                <span className="text-[11px] text-slate-500">Gabung semua ke:</span>
                                <select
                                    className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs text-slate-200 outline-none focus:border-amber-500"
                                    value={to}
                                    onChange={(e) => setTarget((prev) => ({ ...prev, [g.prefix]: e.target.value }))}
                                >
                                    <option value="">pilih kode tujuan</option>
                                    {g.members.map((m) => (
                                        <option key={m.salesCode} value={m.salesCode}>{m.salesCode} — {m.salesName}</option>
                                    ))}
                                </select>
                                <button
                                    disabled={working || !to}
                                    onClick={() => decide(g, g.members.filter((m) => m.salesCode !== to)
                                        .map((m) => ({ fromSalesCode: m.salesCode, toSalesCode: to, decision: "merge" as const })))}
                                    className="px-2.5 py-1 rounded bg-emerald-600/30 border border-emerald-500/40 text-emerald-200 text-xs disabled:opacity-40">
                                    Gabung
                                </button>
                                <button
                                    disabled={working}
                                    onClick={() => decide(g, g.members.map((m) => ({ fromSalesCode: m.salesCode, decision: "separate" as const })))}
                                    className="px-2.5 py-1 rounded bg-white/5 border border-white/10 text-slate-300 text-xs disabled:opacity-40">
                                    Pisah (orang berbeda)
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ── SM: input support principle untuk SPV (per SPV per principal) ───────────
// Support yang menutup penuh rate mengeluarkan principal itu dari hitungan jumlah
// principal SPV (lib/insentif-spv-calc), jadi angkanya berpengaruh besar.
// ── Support principle: unduh template terisi + unggah Excel ──────────────────
// SM mengisi support untuk ratusan pasangan sales/SPV x principal. Mengetiknya satu per
// satu di layar itu sumber salah ketik, dan support memotong pool insentif — salah angka =
// salah bayar. Template sengaja SUDAH berisi pasangan periode itu beserta nilai tersimpan,
// jadi yang diketik hanya kolom nominal. Hasil unggah masuk ke draft, BUKAN langsung ditulis:
// Finance tetap melihat angkanya di tabel lalu menekan Simpan, memakai jalur validasi yang sama.
function SupportExcelBar({ kind, templateRows, fileName, knownKeys, onLoaded }: {
    kind: "sales" | "spv";
    templateRows: SupportTemplateRow[];
    fileName: string;
    knownKeys: Set<string>;
    onLoaded: (values: Record<string, string>) => void;
}) {
    const [busy, setBusy] = useState(false);

    async function download() {
        setBusy(true);
        try {
            const { generateSupportTemplate } = await import("@/lib/insentif-sales-excel");
            const data = generateSupportTemplate(kind, templateRows);
            const url = URL.createObjectURL(new Blob([new Uint8Array(data)], {
                type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            }));
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal membuat template");
        }
        setBusy(false);
    }

    async function upload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setBusy(true);
        try {
            const { parseSupportExcel } = await import("@/lib/insentif-sales-excel");
            const parsed = parseSupportExcel(await file.arrayBuffer(), kind);

            // Nominal tidak masuk akal ditolak SEBELUM apa pun terisi. Nol itu sah (mencabut
            // support), negatif tidak — dan diam-diam membulatkannya ke 0 akan membayar lebih.
            const bad = parsed.filter((r) => !Number.isFinite(r.supportAmount) || r.supportAmount < 0);
            if (bad.length) {
                toast.error(`${bad.length} baris bernilai support tidak valid (mis. ${bad[0].key}/${bad[0].principle}). Tidak ada yang diubah.`);
                return;
            }

            const values: Record<string, string> = {};
            const unknown: string[] = [];
            for (const r of parsed) {
                const k = `${r.key}|${r.principle}`;
                if (knownKeys.has(k)) values[k] = String(r.supportAmount);
                else unknown.push(k);
            }
            if (Object.keys(values).length === 0) {
                toast.error("Tidak ada baris yang cocok dengan periode ini. Cek kolom kunci & Principal, atau unduh templatenya dulu.");
                return;
            }
            onLoaded(values);
            toast.success(
                `${Object.keys(values).length} baris terisi dari Excel — periksa lalu tekan Simpan.`
                + (unknown.length ? ` ${unknown.length} baris dilewati (tidak ada di periode ini).` : ""),
            );
        } catch (err) {
            toast.error(`Gagal baca Excel: ${err instanceof Error ? err.message : "Error"}`);
        } finally {
            setBusy(false);
            e.target.value = "";
        }
    }

    return (
        <div className="flex items-center gap-2">
            <button onClick={download} disabled={busy}
                className="text-xs px-3 py-1.5 rounded-lg border border-white/15 text-slate-300 hover:bg-white/5 disabled:opacity-50">
                Unduh Template
            </button>
            <label className={`text-xs px-3 py-1.5 rounded-lg border border-white/15 text-slate-300 hover:bg-white/5 cursor-pointer ${busy ? "opacity-50 pointer-events-none" : ""}`}>
                Upload Excel
                <input type="file" accept=".xlsx,.xls" onChange={upload} className="hidden" />
            </label>
        </div>
    );
}

function SpvSupportInputSection({ apiRows, month, year, onSaved }: { apiRows: ApiRow[]; month: number; year: number; onSaved?: () => void }) {
    const pairs = useMemo(() => {
        const seen = new Map<string, { spvName: string; principle: string }>();
        for (const r of apiRows) {
            if (!r.spvName) continue;
            const k = `${r.spvName}|${r.principle}`;
            if (!seen.has(k)) seen.set(k, { spvName: r.spvName, principle: r.principle });
        }
        return [...seen.values()].sort((a, b) =>
            a.spvName.localeCompare(b.spvName) || a.principle.localeCompare(b.principle));
    }, [apiRows]);

    const [saved, setSaved] = useState<Record<string, number>>({});
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);

    const keyOf = (p: { spvName: string; principle: string }) => `${p.spvName}|${p.principle}`;

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/insentif-sales/spv-support?month=${month}&year=${year}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal memuat support SPV");
            const map: Record<string, number> = {};
            for (const r of data.rows ?? []) map[`${r.spvName}|${r.principle}`] = r.supportAmount;
            setSaved(map);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal memuat support SPV");
        }
    }, [month, year]);

    useEffect(() => { load(); }, [load]);

    async function save() {
        setSaving(true);
        try {
            const payload = pairs.map((p) => ({
                spvName: p.spvName, principle: p.principle,
                periodMonth: month, periodYear: year,
                supportAmount: Number(draft[keyOf(p)] ?? saved[keyOf(p)] ?? 0) || 0,
            }));
            const res = await fetch("/api/insentif-sales/spv-support", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Gagal simpan support SPV");
            toast.success(`Support SPV tersimpan (${data.upserted} baris). Insentif SPV dihitung ulang.`);
            setDraft({});
            await load();
            onSaved?.();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Gagal simpan support SPV");
        }
        setSaving(false);
    }

    if (pairs.length === 0) return null;

    const terisi = pairs.filter((p) => Number(draft[keyOf(p)] ?? saved[keyOf(p)] ?? 0) > 0).length;

    return (
        <CollapsiblePanel
            icon={DollarSign}
            title="Input Support Principle - SPV"
            desc="Support yang menutup penuh rate mengeluarkan principal itu dari hitungan jumlah principal SPV: rate per principal naik dan principal tersebut tidak dibayar distributor."
            badge={`${pairs.length} pasangan · ${terisi} bersupport`}
        >
            <div className="flex items-center justify-end gap-2 mb-3 flex-wrap">
                <div className="flex items-center gap-2">
                    <SupportExcelBar
                        kind="spv"
                        fileName={`support_spv_${month}_${year}.xlsx`}
                        templateRows={pairs.map((p) => ({
                            key: p.spvName, principle: p.principle,
                            supportAmount: Number(draft[keyOf(p)] ?? saved[keyOf(p)] ?? 0) || 0,
                        }))}
                        knownKeys={new Set(pairs.map(keyOf))}
                        onLoaded={(values) => setDraft((prev) => ({ ...prev, ...values }))}
                    />
                    <button onClick={save} disabled={saving} className="btn-primary disabled:opacity-50 text-xs px-3 py-1.5">
                        {saving ? "Menyimpan…" : "Simpan Support SPV"}
                    </button>
                </div>
            </div>
            <div className="max-h-72 overflow-y-auto border border-white/10 rounded-lg divide-y divide-white/5">
                {pairs.map((p) => {
                    const k = keyOf(p);
                    return (
                        <div key={k} className="flex items-center gap-2 px-3 py-2 text-xs">
                            <span className="text-amber-300 w-28 shrink-0 truncate" title={p.spvName}>{p.spvName}</span>
                            <span className="text-slate-400 flex-1 truncate" title={p.principle}>{p.principle}</span>
                            <input
                                type="number" min={0}
                                className="bg-black/40 border border-white/10 rounded px-2 py-1 text-xs text-slate-200 outline-none focus:border-amber-500 w-32 text-right font-mono"
                                value={draft[k] ?? String(saved[k] ?? 0)}
                                onChange={(e) => setDraft((prev) => ({ ...prev, [k]: e.target.value }))}
                            />
                        </div>
                    );
                })}
            </div>
        </CollapsiblePanel>
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
// ── SM: input support principle per salesman (channel GT/TT & MT) ───────────
// MT juga perlu: computeMt mengurangi support dari pool 1jt sama seperti GT, jadi
// baris MT harus bisa diisi — kalau tidak, support principle utk sales MT tak pernah masuk.
function SupportInputSection({ apiRows, month, year, onSaved }: { apiRows: ApiRow[]; month: number; year: number; onSaved?: () => void }) {
    const gtRows = useMemo(
        () => apiRows.filter((r) => r.channel === "GT" || r.channel === "TT" || r.channel === "MT"),
        [apiRows],
    );
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

    const terisi = gtRows.filter((r) => Number(valueOf(r)) > 0).length;

    return (
        <CollapsiblePanel
            icon={DollarSign}
            no={0}
            title="Input Support Principle"
            desc="Support principal per salesman memotong pool insentif sebelum persentase pencapaian dikalikan."
            badge={`${gtRows.length} baris · ${terisi} bersupport`}
        >
            <div className="flex items-start justify-end gap-2 flex-wrap">
                <SupportExcelBar
                    kind="sales"
                    fileName={`support_sales_${month}_${year}.xlsx`}
                    templateRows={gtRows.map((r) => ({
                        key: r.salesCode, label: r.salesName, principle: r.principle,
                        supportAmount: Number(valueOf(r)) || 0,
                    }))}
                    knownKeys={new Set(gtRows.map(keyOf))}
                    onLoaded={(values) => setDraft((prev) => ({ ...prev, ...values }))}
                />
            </div>
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
        </CollapsiblePanel>
    );
}

function FinanceView({ apiRows, month, year, gtAoMode, onPilihBulan }: {
    apiRows: ApiRow[]; month: number; year: number;
    gtAoMode?: "fixed240" | "file";
    /** Ganti periode yang sedang dimuat. Strip 12 bulan adalah SATU-SATUNYA pemilih di tab ini. */
    onPilihBulan: (bulan: number) => void;
}) {
    const [payments, setPayments] = useState<PaymentRow[]>([]);
    // Dulu ada `selectedMonth` lokal yang terpisah dari periode yang benar-benar dimuat.
    // Akibatnya strip menampilkan bulan A sementara angkanya dihitung dari bulan B, dan bulan
    // yang tidak sedang dimuat selalu jatuh ke catatan pembayaran — Juli yang insentifnya
    // Rp 30,8 jt belum dibayar tampil "-" begitu periode digeser ke Agustus. Sekarang klik
    // di strip mengganti periode sungguhan, jadi bulan terpilih SELALU dihitung ulang.
    const [saving, setSaving] = useState(false);
    const [checked, setChecked] = useState<Record<string, boolean>>({});
    const [paymentsLoading, setPaymentsLoading] = useState(true);
    const [paymentsError, setPaymentsError] = useState("");
    // Insentif SPV & SM ikut dibayar dari tabel yang sama — diambil dari endpoint hitungannya
    // masing-masing, karena apiRows hanya berisi baris per-sales.
    // Baris SPV/SM disimpan UTUH, bukan diringkas jadi nama+total: rincian pencapaiannya
    // dipakai baris rincian di tabel pembayaran, dan meringkasnya di sini berarti Finance
    // melihat nominal tanpa dasar perhitungannya.
    const [spvPayees, setSpvPayees] = useState<SpvIncentiveRow[]>([]);
    const [smPayees, setSmPayees] = useState<SmIncentiveRow[]>([]);
    const [principleFilter, setPrincipleFilter] = useState("ALL");
    // `toggle` di komponen ini sudah dipakai untuk centang pembayaran; rincian pakai nama lain
    // supaya satu klik tidak pernah bisa salah jatuh ke penandaan uang.
    const { open, toggle: toggleRincian } = useExpandableRows();

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [spvRes, smRes] = await Promise.all([
                    fetch(`/api/insentif-sales/spv-dashboard?month=${month}&year=${year}`),
                    fetch(`/api/insentif-sales/sm-dashboard?month=${month}&year=${year}`),
                ]);
                const spv = spvRes.ok ? await spvRes.json() : { rows: [] };
                const sm = smRes.ok ? await smRes.json() : { rows: [] };
                if (cancelled) return;
                setSpvPayees((spv.rows ?? []) as SpvIncentiveRow[]);
                // SM di luar whitelist total-nya 0 — jangan bikin baris pembayaran kosong.
                setSmPayees(((sm.rows ?? []) as SmIncentiveRow[]).filter((r) => r.total > 0));
            } catch {
                if (!cancelled) { setSpvPayees([]); setSmPayees([]); }
            }
        })();
        return () => { cancelled = true; };
    }, [month, year]);

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

    // Baris pembayaran untuk bulan terpilih. Bulan berjalan dihitung ulang dari dashboard
    // (Sales + SPV + SM); bulan lain dibaca dari incentive_payments — di sana baris SPV/SM
    // sudah ikut tersimpan dengan sales_code berprefiks, jadi tidak butuh cabang tambahan.
    const rowsForMonth = useCallback((bulan: number) => {
        const findPay = (salesCode: string, principle: string) =>
            payments.find((p) => p.salesCode === salesCode && p.principle === principle && p.periodMonth === bulan);
        if (bulan === month) {
            // Baris LUNAS menampilkan angka yang BENAR-BENAR dibayar (snapshot di
            // incentive_payments), bukan hasil hitung-ulang. Kalau support/target diubah
            // setelah pembayaran, keduanya berbeda — selisihnya ditandai supaya Finance tahu
            // ada kelebihan/kekurangan bayar, bukan diam-diam menampilkan angka baru dengan
            // badge "lunas" (audit temuan M9).
            const settle = (live: number, pay: PaymentRow | undefined) => {
                const isLunas = pay?.paymentStatus === "lunas";
                const paid = pay?.totalIncentive ?? 0;
                return {
                    total: isLunas ? paid : live,
                    drift: isLunas && Math.abs(paid - live) >= 1 ? live - paid : 0,
                };
            };
            const sales = apiRows.map((r) => {
                const pay = findPay(r.salesCode, r.principle);
                const { total, drift } = settle(r.incentive.total, pay);
                return { role: "sales" as PayeeRole, salesCode: r.salesCode, salesName: r.salesName, principle: r.principle, branch: r.branch, total, drift, paymentId: pay?.id ?? null, status: (pay?.paymentStatus ?? r.paymentStatus) as string };
            });
            const extra = [
                ...spvPayees.map((r) => ({ role: "spv" as PayeeRole, name: r.spvName, total: r.total })),
                ...smPayees.map((r) => ({ role: "sm" as PayeeRole, name: r.smName, total: r.total })),
            ].map((r) => {
                const salesCode = payeeCode(r.role, r.name);
                const pay = findPay(salesCode, PAYEE_PRINCIPLE_ALL);
                const { total, drift } = settle(r.total, pay);
                return { role: r.role, salesCode, salesName: r.name, principle: PAYEE_PRINCIPLE_ALL, branch: PAYEE_PRINCIPLE_ALL, total, drift, paymentId: pay?.id ?? null, status: (pay?.paymentStatus ?? "belum") as string };
            });
            return [...sales, ...extra];
        }
        return payments
            .filter((p) => p.periodMonth === bulan)
            .map((p) => ({ role: parsePayee(p.salesCode).role, salesCode: p.salesCode, salesName: p.salesName, principle: p.principle, branch: p.branch, total: p.totalIncentive, drift: 0, paymentId: p.id, status: p.paymentStatus }));
    }, [month, apiRows, payments, spvPayees, smPayees]);

    const detailRows = useMemo(() => rowsForMonth(month), [rowsForMonth, month]);

    // Periode berjalan dihitung ULANG dari dashboard, bukan dibaca dari incentive_payments.
    // Baris di tabel itu baru ada setelah seseorang menandai lunas, jadi bulan yang insentifnya
    // sudah dihitung tapi belum dibayar sepeser pun tampil "-" — persis kebalikan dari yang
    // dicari Finance di strip ini, yaitu berapa yang MASIH HARUS dibayar (dilaporkan user
    // 2026-08-26). Bulan lain tetap dari catatan pembayaran: hitungan hidup untuk bulan lampau
    // tidak tersedia (target/realisasinya bukan periode yang sedang dimuat).
    const monthlySummary = useMemo(() => {
        return Array.from({ length: 12 }, (_, i) => {
            const m = i + 1;
            const monthPayments = payments.filter((p) => p.periodMonth === m);
            const rows = m === month ? rowsForMonth(m) : [];
            const total = m === month
                ? rows.reduce((a, r) => a + r.total, 0)
                : monthPayments.reduce((a, p) => a + p.totalIncentive, 0);
            const belumDibayar = m === month
                ? rows.filter((r) => r.status !== "lunas").reduce((a, r) => a + r.total, 0)
                : monthPayments.filter((p) => p.paymentStatus !== "lunas").reduce((a, p) => a + p.totalIncentive, 0);
            const hasLunas = monthPayments.some((p) => p.paymentStatus === "lunas");
            const hasTunggakan = monthPayments.some((p) => p.paymentStatus === "tunggakan");
            const status: "lunas" | "tunggakan" | "belum" =
                hasTunggakan ? "tunggakan"
                    : hasLunas && belumDibayar === 0 ? "lunas"
                        : "belum";
            // Bulan yang bukan periode terpilih DAN belum punya satu pun catatan pembayaran
            // tidak diketahui nilainya — bukan nol. Menampilkannya sebagai "-" / BELUM
            // terbaca "tidak ada yang harus dibayar", padahal artinya "belum dihitung".
            const belumDihitung = m !== month && monthPayments.length === 0;
            return { month: m, label: MONTH_LABELS[i], total, belumDibayar, status, belumDihitung };
        });
    }, [payments, month, rowsForMonth]);

    // Pilihan filter dibangun dari principal yang BENAR-BENAR ada di bulan terpilih, bukan dari
    // konstanta master: bulan lama bisa memuat principal yang sudah tidak dipakai lagi.
    const principleOptions = useMemo(
        () => [...new Set(detailRows.map((r) => r.principle))].filter((v) => v && v !== PAYEE_PRINCIPLE_ALL).sort(),
        [detailRows],
    );
    const visibleRows = useMemo(
        () => principleFilter === "ALL" ? detailRows : detailRows.filter((r) => r.principle === principleFilter),
        [detailRows, principleFilter],
    );

    // Rincian hanya ada untuk periode berjalan, karena bulan lain dibaca dari snapshot
    // incentive_payments yang menyimpan nominal saja, bukan target/realisasinya.
    const salesByKey = useMemo(() => {
        const m = new Map<string, ApiRow>();
        for (const r of apiRows) m.set(`${r.salesCode}|${r.principle}`, r);
        return m;
    }, [apiRows]);
    const spvByName = useMemo(() => new Map(spvPayees.map((r) => [r.spvName, r])), [spvPayees]);
    const smByName = useMemo(() => new Map(smPayees.map((r) => [r.smName, r])), [smPayees]);

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
                            branch: row.branch || PAYEE_PRINCIPLE_ALL,
                            periodMonth: month,
                            periodYear: year,
                            totalIncentive: Math.round(row.total),
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
                <LoadingState label="Memuat status pembayaran" rows={3} />
            </div>
        );
    }

    if (paymentsError) {
        return (
            <div className="space-y-5">
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
            {/* 12-month strip */}
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <SectionTitle icon={DollarSign} no={1} title="Rekap Pembayaran Tahunan" desc={`Klik bulan untuk memuat periodenya — bulan terpilih selalu dihitung ulang dari dashboard. Bulan lain hanya menampilkan catatan pembayaran yang sudah ada; yang bertanda "?" belum pernah dihitung, bukan berarti nol.`} />
                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                    {monthlySummary.map((m) => {
                        const active = m.month === month;
                        const tone = statusClasses[m.status];
                        return (
                            <button key={m.month} onClick={() => onPilihBulan(m.month)}
                                className={`rounded-lg border p-3 text-left transition-all ${tone} ${active ? "bg-indigo-500/10 ring-1 ring-indigo-500/40" : "bg-black/30 hover:bg-white/[0.03]"}`}>
                                <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-bold text-slate-300">{m.label.slice(0, 3)}</span>
                                    {m.status === "tunggakan" && <AlertTriangle size={13} className="text-rose-400" />}
                                    {m.status === "lunas" && <CheckCircle2 size={13} className="text-emerald-400" />}
                                </div>
                                {m.belumDihitung ? (
                                    <>
                                        <div className="text-[11px] font-mono mt-1 text-slate-600">?</div>
                                        <div className="text-[9px] uppercase tracking-wider mt-0.5 font-bold text-slate-600">belum dihitung</div>
                                    </>
                                ) : (
                                    <>
                                        <div className="text-[11px] font-mono mt-1 text-slate-300">{m.total ? formatShortRp(m.total) : "-"}</div>
                                        {m.belumDibayar > 0 && (
                                            <div className="text-[10px] font-mono text-amber-400/90">belum: {formatShortRp(m.belumDibayar)}</div>
                                        )}
                                        <div className="text-[9px] uppercase tracking-wider mt-0.5 font-bold">{m.status}</div>
                                    </>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Detail per-salesman */}
            <div className="bg-[#1a1c23]/60 rounded-xl border border-white/10 p-5">
                <div className="flex items-center justify-between mb-4">
                    <SectionTitle icon={Wallet} no={2} title={`Tabel Insentif: ${MONTH_LABELS[month - 1]} ${year}`} desc="Centang lalu simpan sebagai lunas. Perubahan langsung dicatat ke database." />
                    <div className="flex items-center gap-2">
                        <select
                            aria-label="Filter principle pembayaran"
                            value={principleFilter}
                            onChange={(e) => setPrincipleFilter(e.target.value)}
                            className="bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500"
                        >
                            <option value="ALL">Semua principle ({detailRows.length})</option>
                            {principleOptions.map((pr) => (
                                <option key={pr} value={pr}>{pr} ({detailRows.filter((r) => r.principle === pr).length})</option>
                            ))}
                            {detailRows.some((r) => r.principle === PAYEE_PRINCIPLE_ALL) && (
                                <option value={PAYEE_PRINCIPLE_ALL}>
                                    SPV & SM ({detailRows.filter((r) => r.principle === PAYEE_PRINCIPLE_ALL).length})
                                </option>
                            )}
                        </select>
                        <button onClick={fetchPayments} aria-label="Muat ulang status pembayaran" className="text-slate-500 hover:text-slate-300 transition-colors p-1.5 rounded-lg hover:bg-white/5">
                            <RefreshCw size={14} />
                        </button>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="ui-data-table min-w-[900px]">
                        <thead className="bg-black/50 text-slate-400 font-bold uppercase tracking-wider border-b border-white/10">
                            <tr>
                                <th className="px-3 py-3 w-10"></th>
                                <th className="px-3 py-3">Penerima</th>
                                <th className="px-3 py-3 text-center">Peran</th>
                                <th className="px-3 py-3">Principle</th>
                                <th className="px-3 py-3 text-right">Total Insentif</th>
                                <th className="px-3 py-3">Bukti Bayar</th>
                                <th className="px-3 py-3 text-center">Status</th>
                                <th className="px-3 py-3 text-center">Rincian</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.1]">
                            {visibleRows.map((r) => {
                                const selectionKey = paymentSelectionKey(r);
                                const sales = r.role === "sales" ? salesByKey.get(`${r.salesCode}|${r.principle}`) : undefined;
                                const spv = r.role === "spv" ? spvByName.get(r.salesName) : undefined;
                                const sm = r.role === "sm" ? smByName.get(r.salesName) : undefined;
                                const isChecked = !!checked[selectionKey];
                                const sc = r.status === "lunas" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                    : r.status === "tunggakan" ? "bg-rose-500/10 text-rose-400 border-rose-500/30"
                                        : "bg-white/5 text-slate-500 border-white/10";
                                const slabel = r.status === "lunas" ? "Lunas" : r.status === "tunggakan" ? "Tunggakan" : "Belum";
                                return (
                                    <Fragment key={selectionKey}>
                                    <tr className={`transition-colors hover:bg-white/[0.05] ${isChecked ? "bg-emerald-500/[0.07]" : "even:bg-white/[0.025]"}`}>
                                        {/* Checkbox TIDAK ikut membuka rincian: satu klik di kolom ini harus
                                            berarti satu hal saja, karena hal itu adalah menandai uang dibayar. */}
                                        <td className="px-3 py-3">
                                            <input type="checkbox" checked={isChecked} onChange={() => toggle(r)} className="w-4 h-4 accent-emerald-500 cursor-pointer" />
                                        </td>
                                        <td className="px-3 py-3">
                                            <div className="font-semibold text-slate-200">{r.salesName}</div>
                                            <div className="text-[10px] text-slate-500 font-mono">{r.salesCode}</div>
                                        </td>
                                        <td className="px-3 py-3 text-center">
                                            <span className={`inline-flex px-2 py-0.5 rounded border font-bold text-[10px] ${payeeRoleBadge(r.role).cls}`}>{payeeRoleBadge(r.role).label}</span>
                                        </td>
                                        <td className="px-3 py-3 text-slate-300">{r.principle}</td>
                                        <td className="px-3 py-3 text-right font-mono font-bold text-amber-400">
                                            {formatRp(r.total)}
                                            {r.drift !== 0 && (
                                                <div className="text-[10px] font-normal text-rose-400" title="Angka dibayar berbeda dari hasil hitung ulang — support/target berubah setelah pembayaran.">
                                                    hitung ulang: {formatRp(r.total + r.drift)}
                                                </div>
                                            )}
                                        </td>
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
                                        <td className="px-3 py-3 text-center">
                                            <button
                                                type="button"
                                                aria-expanded={!!open[selectionKey]}
                                                aria-label={`Rincian ${r.salesName}`}
                                                onClick={() => toggleRincian(selectionKey)}
                                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-white/5 text-[10px] font-bold uppercase tracking-wider text-slate-300 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
                                            >
                                                {open[selectionKey] ? "Tutup" : "Rincian"}
                                                <ChevronDown
                                                    size={12}
                                                    className={`transition-transform duration-200 motion-reduce:transition-none ${open[selectionKey] ? "rotate-180" : ""}`}
                                                />
                                            </button>
                                        </td>
                                    </tr>
                                    {open[selectionKey] && (
                                        <tr className="bg-black/30">
                                            <td colSpan={8} className="px-4 py-4">
                                                {sales ? <SalesBreakdown r={sales} semuaBaris={apiRows} gtAoMode={gtAoMode} />
                                                    : spv ? <SpvBreakdown rincian={spv.rincian} />
                                                        : sm ? <SmBreakdown r={sm} />
                                                            : (
                                                                <p className="text-[11px] text-slate-500">
                                                                    Rincian hanya tersedia untuk periode yang dihitung ulang
                                                                    ({MONTH_LABELS[month - 1]} {year}). Bulan lain dibaca dari
                                                                    catatan pembayaran yang menyimpan nominalnya saja, bukan
                                                                    target dan realisasinya.
                                                                </p>
                                                            )}
                                            </td>
                                        </tr>
                                    )}
                                    </Fragment>
                                );
                            })}
                            {visibleRows.length === 0 && (
                                <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500 italic">
                                    {detailRows.length === 0
                                        ? "Belum ada data untuk bulan ini."
                                        : `Tidak ada penerima untuk principle "${principleFilter}" di bulan ini.`}
                                </td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
                <div className="mt-4 flex items-center justify-between flex-wrap gap-3 border-t border-white/5 pt-4">
                    {/* Centang di luar filter TETAP ikut dibayar — menyembunyikannya tanpa
                        memberi tahu berarti Finance menekan Simpan untuk uang yang tidak
                        dilihatnya. Jumlahnya disebutkan, bukan dibuang diam-diam. */}
                    <span className="text-xs text-slate-400">
                        {checkedList.length} penerima dipilih · Total: <span className="font-mono font-bold text-amber-400">{formatRp(checkedList.reduce((a, r) => a + r.total, 0))}</span>
                        {(() => {
                            const hidden = checkedList.filter((row) => !visibleRows.includes(row)).length;
                            return hidden > 0 ? (
                                <span className="text-amber-400/80"> ({hidden} di luar filter, tetap ikut disimpan)</span>
                            ) : null;
                        })()}
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
    const [progressFeed, setProgressFeed] = useState<ProgressFeedStatus | null>(null);
    // Ambang AO yang dipakai server menghitung baris-baris ini. Diteruskan ke rincian supaya
    // layar tidak pernah mengklaim ambang yang berbeda dari yang dipakai membayar.
    const [gtAoMode, setGtAoMode] = useState<"fixed240" | "file">("fixed240");
    const [cakupan, setCakupan] = useState<{
        dibatasi: boolean;
        jumlahKode?: number;
        identitas?: { role: string; name: string } | null;
    }>({ dibatasi: false });
    const [loading, setLoading] = useState(true);
    const [dashboardError, setDashboardError] = useState("");
    // Opsi datang dari server (dibangun sebelum filter tampilan) supaya memilih satu principle
    // tidak menyusutkan daftarnya jadi satu pilihan tanpa jalan kembali.
    const [opsiFilter, setOpsiFilter] = useState<{ principles: string[]; branches: string[]; sm: string[] }>(
        { principles: [], branches: [], sm: [] },
    );
    const [izin, setIzin] = useState<ReadonlySet<string>>(new Set());
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
    const view = VIEWS.some((item) => item.key === requestedView) ? requestedView! : "sm";
    const principle = searchParams.get("principle") || "ALL";
    const branch = searchParams.get("branch") || "ALL";
    const smFilter = searchParams.get("sm") || "ALL";

    const updateContext = useCallback((updates: Partial<{ view: ViewKey; principle: string; branch: string; sm: string; month: string; year: string }>) => {
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
            setProgressFeed(data.progressFeed as ProgressFeedStatus);
            setGtAoMode(data.gtAoMode === "file" ? "file" : "fixed240");
            setCakupan(data.cakupan ?? { dibatasi: false });
            setOpsiFilter(data.opsiFilter ?? { principles: [], branches: [], sm: [] });
            setIzin(new Set(Array.isArray(data.izin) ? (data.izin as string[]) : []));
        } catch (error) {
            setApiRows([]);
            setProgressFeed(null);
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

    const tabs = useMemo(() => viewsTerlihat(izin), [izin]);
    // View dari URL yang tidak boleh dibuka jatuh ke tab pertama yang boleh. Tanpa ini,
    // Finance yang membuka tautan lama ?view=sm melihat layar kosong tanpa penjelasan.
    const viewBoleh = tabs.some((t) => t.key === view) || tabs.length === 0 ? view : tabs[0].key;

    const salesmen = useMemo(() => apiRows.map(apiRowToSalesman), [apiRows]);
    // Filter SM disaring di klien, bukan lewat server seperti principle/cabang: nominal tiap
    // baris sudah dihitung server dengan konteks grup penuh, jadi menyaring daftarnya tidak
    // menggeser angka siapa pun (bandingkan `groupTargets` di route dashboard).
    const apiRowsSm = useMemo(
        () => smFilter === "ALL" ? apiRows : apiRows.filter((r) => (r.smName ?? "") === smFilter),
        [apiRows, smFilter],
    );
    const salesmenSm = useMemo(() => apiRowsSm.map(apiRowToSalesman), [apiRowsSm]);
    // Finance tidak ikut: strip 12 bulan di dalamnya SUDAH pemilih periode, dan dua pemilih
    // bulan di satu layar yang tidak sinkron adalah cara paling mudah salah baca angka
    // (dilaporkan user 2026-08-29). Admin memang punya pemilih periodenya sendiri.
    const showFilters = viewBoleh !== "admin" && viewBoleh !== "finance";
    const filterAktif = principle !== "ALL" || branch !== "ALL" || smFilter !== "ALL";

    const handleViewKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex = index;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = tabs.length - 1;
        else return;

        event.preventDefault();
        const nextView = tabs[nextIndex];
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
                {tabs.map((v, index) => {
                    const Icon = v.icon;
                    const active = viewBoleh === v.key;
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
                    {viewBoleh === "sm" && (
                        <select aria-label="Filter SM" value={smFilter} onChange={(e) => updateContext({ sm: e.target.value })} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500">
                            <option value="ALL">Semua SM ({opsiFilter.sm.length})</option>
                            {opsiFilter.sm.map((sm) => <option key={sm} value={sm}>{sm}</option>)}
                        </select>
                    )}
                    <select aria-label="Filter principle" value={principle} onChange={(e) => updateContext({ principle: e.target.value })} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500">
                        <option value="ALL">Semua Principle</option>
                        {opsiFilter.principles.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <select aria-label="Filter cabang" value={branch} onChange={(e) => updateContext({ branch: e.target.value })} className="bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500">
                        <option value="ALL">Semua Cabang</option>
                        {opsiFilter.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                    <button type="button" onClick={fetchDashboard} className="ui-icon-button" title="Refresh data" aria-label="Refresh data insentif">
                        <RefreshCw size={14} />
                    </button>
                    {filterAktif && (
                        <button type="button" onClick={() => updateContext({ principle: "ALL", branch: "ALL", sm: "ALL" })} className="ui-button-ghost">
                            Reset filter
                        </button>
                    )}
                    <span className="text-[11px] text-slate-500 ml-auto">
                        {viewBoleh === "sm" && smFilter !== "ALL"
                            ? `${salesmenSm.length} dari ${salesmen.length} baris`
                            : `${salesmen.length} salesman`}
                    </span>
                </div>
            )}

            {TAMPILKAN_SPANDUK_PROGRES && !loading && !dashboardError && progressFeed && progressFeed.progressKeys > 0 && (
                <div
                    className={`mb-5 flex items-start gap-3 rounded-xl border p-4 ${
                        progressFeed.ready && progressFeed.zeroTargetKeys === 0 && progressFeed.unmatchedKeys === 0
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                            : "border-amber-500/30 bg-amber-500/10 text-amber-100"
                    }`}
                    role="status"
                >
                    {progressFeed.ready && progressFeed.zeroTargetKeys === 0 && progressFeed.unmatchedKeys === 0
                        ? <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-400" size={18} />
                        : <AlertTriangle className="mt-0.5 shrink-0 text-amber-400" size={18} />}
                    <div className="text-sm leading-6">
                        <p className="font-bold">
                            {progressFeed.ready
                                ? "Pencapaian Laporan Harian sudah masuk"
                                : "Pencapaian sudah diterima, target periode belum tersedia"}
                        </p>
                        <p className="text-xs opacity-80">
                            {progressFeed.matchedKeys.toLocaleString("id-ID")} dari {progressFeed.progressKeys.toLocaleString("id-ID")} kombinasi salesman dan principal telah cocok dengan target.
                            {!progressFeed.targetKeys
                                ? " Unggah target periode ini agar dashboard dan perhitungan insentif dapat ditampilkan."
                                : progressFeed.unmatchedKeys
                                    ? ` Masih ada ${progressFeed.unmatchedKeys.toLocaleString("id-ID")} kombinasi tanpa target yang cocok.`
                                    : ""}
                            {/* Target 0 = tidak dibayar sama sekali sejak 2026-08-29. Tanpa baris ini,
                                Finance melihat "semua cocok" untuk data yang justru tidak menghasilkan
                                insentif apa pun. */}
                            {progressFeed.zeroTargetKeys > 0 && (
                                <> <span className="font-semibold">
                                    {progressFeed.zeroTargetKeys.toLocaleString("id-ID")} kombinasi punya penjualan
                                    tapi targetnya Rp 0 — tidak menghasilkan insentif sampai targetnya diisi.
                                </span></>
                            )}
                        </p>
                        {(progressFeed.unmatchedKeys > 0 || progressFeed.zeroTargetKeys > 0) && <UnmatchedProgressList month={month} year={year} />}
                    </div>
                </div>
            )}

            {/* Body */}
            {/* Gate-nya pakai `viewBoleh`, BUKAN `view`: Finance membuka halaman tanpa ?view
                sehingga `view` jatuh ke "sm" dan layar menampilkan EmptyState "tidak ada data"
                padahal tab yang aktif Finance — strip 12 bulan di dalamnya jadi tak pernah
                dirender, dan periode tidak bisa dipilih (dilaporkan user 2026-08-31). */}
            <div id="insentif-view-panel" role="tabpanel" aria-labelledby={`insentif-tab-${viewBoleh}`} tabIndex={0}>
            {loading && viewBoleh !== "admin" ? (
                <LoadingState label="Memuat data insentif" rows={6} />
            ) : dashboardError && viewBoleh !== "admin" ? (
                <ErrorState
                    title={dashboardError}
                    message="Data kosong tidak ditampilkan karena server belum memberikan hasil yang valid."
                    onAction={() => void fetchDashboard()}
                />
            ) : salesmen.length === 0 && viewBoleh !== "admin" && viewBoleh !== "finance" ? (
                <EmptyState
                    title={cakupan.dibatasi && !cakupan.jumlahKode
                        ? "Belum ada salesman dalam cakupan Anda"
                        : progressFeed?.progressKeys && !progressFeed.targetKeys
                            ? "Target periode ini belum diunggah"
                            : "Tidak ada data untuk filter ini"}
                    // Tabel kosong karena "bukan cakupan Anda" dulu terlihat persis sama dengan
                    // "target belum diunggah". Nama identitas disebutkan karena penyebab paling
                    // sering adalah bedanya penulisan nama ("Marten" vs "MARTEN").
                    message={cakupan.dibatasi && !cakupan.jumlahKode
                        ? `Identitas hierarki Anda: ${cakupan.identitas?.role?.toUpperCase() ?? "-"} `
                          + `"${cakupan.identitas?.name ?? "belum diisi"}". Tidak ada kode sales yang cocok untuk periode ini — `
                          + `pastikan penulisannya sama persis dengan kolom SPV/SM di file target.`
                        : progressFeed?.progressKeys && !progressFeed.targetKeys
                            ? `${progressFeed.progressKeys.toLocaleString("id-ID")} kombinasi pencapaian sudah diterima. Unggah target agar performa dan insentif dapat dihitung.`
                            : "Ubah principle atau cabang, lalu periksa kembali hasilnya."}
                    actionLabel={progressFeed?.progressKeys && !progressFeed.targetKeys ? "Buka Input Penjualan" : "Reset Filter"}
                    onAction={() => progressFeed?.progressKeys && !progressFeed.targetKeys
                        ? updateContext({ view: "admin" })
                        : updateContext({ principle: "ALL", branch: "ALL", sm: "ALL" })}
                />
            ) : (
                <div className="space-y-5">
                    {viewBoleh === "sales" && (
                        <>
                            <PerformanceBlock rows={salesmen} apiRows={apiRows} progress={tg} />
                            <AchievementTable rows={salesmen} progress={tg} />
                            <IncentiveTable apiRows={apiRows} gtAoMode={gtAoMode} />
                        </>
                    )}
                    {viewBoleh === "spv" && (
                        <>
                            <PerformanceBlock rows={salesmen} apiRows={apiRows} progress={tg} />
                            <SpvView rows={salesmen} progress={tg} />
                            <SpvIncentiveTable month={month} year={year} />
                            <IncentiveTable apiRows={apiRows} gtAoMode={gtAoMode} />
                        </>
                    )}
                    {viewBoleh === "sm" && (
                        <SmDashboard rows={salesmenSm} rowsApi={apiRowsSm} apiRows={apiRows} progress={tg}
                            month={month} year={year} onSaved={fetchDashboard} gtAoMode={gtAoMode} />
                    )}
                    {viewBoleh === "admin" && <AdminView rows={salesmen} />}
                    {viewBoleh === "finance" && <FinanceView apiRows={apiRows} month={month} year={year} gtAoMode={gtAoMode}
                            onPilihBulan={(bulan) => updateContext({ month: String(bulan) })} />}
                </div>
            )}
            </div>
        </div>
    );
}
