"use client";

import {
    ClipboardList, MapPin, Target, ShoppingBag, FileText,
    Users, BarChart3, RotateCcw, Network,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Scope {
    role: string;
    salesCode?: string;
    salesName?: string;
    principle?: string;
    spvName?: string;
    smName?: string;
    allowedSalesCodes: string[] | null;
    allowedSpvIds?: string[] | null;
}

export interface JksRow {
    id: string;
    salesCode: string;
    salesName: string;
    custCode: string;
    custName: string;
    market: string;
    alamat: string;
    kota: string;
    hariKunjungan: string;
    mingguPattern: "ganjil" | "genap" | "all";
    area: string;
    rayon: string;
    principle: string;
    visitFrequency: 1 | 2 | 4;
    isActive: boolean;
}

export interface AoRow {
    id: string;
    salesCode: string;
    custCode: string;
    custName: string;
    principle: string;
    status: "ordered" | "active" | "not_order" | "not_visited" | "priority";
    orderValueDpp: number;
    isPriority: boolean;
    noOrderReasonCode?: string;
    noOrderNote?: string;
    monthlyOrderCount: number;
    needsAttention: boolean;
    checkinAt?: string | null;   // ISO — null = belum check-in hari ini
    checkoutAt?: string | null;  // ISO — non-null = kunjungan selesai
}

export interface Reason {
    id: string;
    reasonCode: string;
    label: string;
    category: string;
}

export interface MerchItem {
    custCode: string;
    custName: string;
    produkJelas: boolean;
    displayRapi: boolean;
    dibersihkan: boolean;
    ditataulang: boolean;
    posisiMudah: boolean;
    semuaSku: boolean;
    photoUrl?: string;
    catatan: string;
}

export interface FreqRow {
    custCode: string;
    custName: string;
    mingguPattern: string;
    visitFrequency: number;
    actualVisits: number;
    overVisit: boolean;
}

export type TabKey = "jks" | "ao" | "no-order" | "merchandising" | "laporan" | "briefing" | "sm-control" | "frekuensi" | "hierarki";

// ── Constants ──────────────────────────────────────────────────────────────

export const TABS: { key: TabKey; label: string; icon: typeof ClipboardList; roles: string[] }[] = [
    { key: "jks",           label: "Kontrol JKS",        icon: MapPin,      roles: ["admin", "manager", "admin_sales", "sm", "spv"] },
    { key: "ao",            label: "Form AO Harian",      icon: Target,      roles: ["salesman", "spv", "staff", "admin", "manager"] },
    { key: "no-order",      label: "Toko Tidak Order",    icon: RotateCcw,   roles: ["salesman", "spv", "sm", "staff", "admin", "manager"] },
    // ponytail: tab Merchandising disembunyikan — merch kini bagian wizard kunjungan (ber-foto/GPS).
    // SPV tetap lihat hasil merch di dashboard. Render branch di page.tsx jadi dead (tak match).
    { key: "laporan",       label: "Laporan Harian",      icon: FileText,    roles: ["salesman", "spv", "staff", "admin", "manager"] },
    { key: "briefing",      label: "Briefing SPV",        icon: Users,       roles: ["spv", "sm", "admin", "manager"] },
    { key: "sm-control",    label: "Kontrol SM",          icon: BarChart3,   roles: ["sm", "admin", "manager"] },
    { key: "frekuensi",     label: "Frekuensi Kunjungan", icon: RotateCcw,   roles: ["admin", "manager", "admin_sales", "sm"] },
    { key: "hierarki",      label: "Hierarki Sales",      icon: Network,     roles: ["admin", "manager"] },
];

export const PRINCIPLES = ["GODREJ", "MONTISS", "MUSTIKA RATU", "SOFTEX"];
export const HARI = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

export const MERCH_KEYS: { key: keyof MerchItem; label: string }[] = [
    { key: "produkJelas", label: "Produk terlihat jelas" },
    { key: "displayRapi", label: "Display rapi" },
    { key: "dibersihkan", label: "Produk dibersihkan" },
    { key: "ditataulang", label: "Ditata ulang" },
    { key: "posisiMudah", label: "Posisi mudah ditemukan konsumen" },
    { key: "semuaSku",    label: "Seluruh SKU terpajang" },
];

export const BRIEFING_AGENDA: Record<"pagi" | "sore", string[]> = {
    pagi: [
        "JKS layak dijalankan hari ini",
        "Salesman paham area & rute",
        "Seluruh toko valid & terdaftar",
        "Target AO hari ini dikonfirmasi",
        "Kendala kemarin dibahas",
    ],
    sore: [
        "Toko tidak order diidentifikasi",
        "Toko tidak dikunjungi dicatat",
        "Penyebab utama dibahas",
        "Solusi tindak lanjut disepakati",
        "Laporan salesman di-acknowledge",
    ],
};

// ── Shared UI ──────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: AoRow["status"] }) {
    const map: Record<AoRow["status"], { label: string; cls: string }> = {
        ordered:     { label: "Order",            cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
        active:      { label: "Aktif",            cls: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
        not_order:   { label: "Belum Order",      cls: "bg-rose-500/15 text-rose-400 border-rose-500/30" },
        not_visited: { label: "Tidak Dikunjungi", cls: "bg-slate-500/15 text-slate-400 border-slate-500/30" },
        priority:    { label: "Prioritas",        cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
    };
    const { label, cls } = map[status];
    return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border ${cls}`}>{label}</span>;
}

// ── Route card logic (mobile JKS visit list) ────────────────────────────────
// ponytail: state/sort/filter dipisah dari komponen (SRP) — kartu cuma render.

export type RouteState = "belum_order" | "perhatian" | "selesai" | "sudah_order" | "normal";

export function routeState(r: AoRow): RouteState {
    if (r.status === "not_order") return "belum_order";
    if (r.checkoutAt) return "selesai";
    if (r.status === "ordered" || r.status === "active") return "sudah_order";
    if (r.isPriority || r.needsAttention) return "perhatian";
    return "normal";
}

// urgent-first: belum order naik ke atas, selesai turun ke bawah
export function routeRank(r: AoRow): number {
    if (r.checkoutAt) return 4;
    if (r.status === "not_order") return 0;
    if (r.isPriority || r.needsAttention) return 1;
    if (r.status === "ordered" || r.status === "active") return 2;
    return 3;
}

export function compareRoute(a: AoRow, b: AoRow): number {
    return routeRank(a) - routeRank(b) || a.custName.localeCompare(b.custName);
}

export function visitDurationMin(r: AoRow): number | null {
    if (!r.checkinAt || !r.checkoutAt) return null;
    return Math.max(0, Math.round((new Date(r.checkoutAt).getTime() - new Date(r.checkinAt).getTime()) / 60000));
}

export function SectionTitle({ icon: Icon, no, title, desc }: { icon: typeof ClipboardList; no: number; title: string; desc?: string }) {
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

export function SummaryCard({ label, value, sub, color }: { label: string; value: number | string; sub?: string; color?: string }) {
    return (
        <div className="bg-black/30 border border-white/10 rounded-xl p-4 flex flex-col gap-1">
            <span className="text-xs text-slate-400">{label}</span>
            <span className={`text-2xl font-bold ${color ?? "text-white"}`}>{value}</span>
            {sub && <span className="text-xs text-slate-500">{sub}</span>}
        </div>
    );
}
