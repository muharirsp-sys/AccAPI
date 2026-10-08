/*
 * Tujuan: Kerangka klien bersama enam halaman Insentif Sales (Fiori S4c): kepala halaman, navigasi antarhalaman sesuai izin,
 *   saringan periode/principal/cabang di URL (satu periode untuk semua halaman, BL-36 tanpa simpan per pengguna),
 *   pemuat GET dashboard, dan konstanta server lewat context.
 * Caller: Dashboard.tsx, Saya.tsx, Pembayaran.tsx, DataPeriode.tsx, Support.tsx, Pengaturan.tsx.
 * Dependensi: components/fiori/{core,interactive}, lib/insentif-ui, lib/insentif-konstanta, lib/rekapan-nota/ui (ambil).
 * Main Functions: InsentifRangka, usePeriode, useDashboard, KonstantaCtx/useKonstanta.
 * Side Effects: router.replace saat saringan berubah; GET /api/insentif-sales/dashboard.
 */
"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EmptyState } from "@/components/fiori/core";
import { FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { ambil } from "@/lib/rekapan-nota/ui";
import { DEFAULT_KONSTANTA, parseKonstanta, type Konstanta } from "@/lib/insentif-konstanta";
import { HALAMAN, halamanTerlihat, type ApiRow, type Cakupan, type HalamanKey, type PeranHierarki, type ProgressFeedStatus } from "@/lib/insentif-ui";
import { MONTH_LABELS } from "./data";

/** Kunci URL yang dibawa antarhalaman; `sm` hanya bermakna di Dashboard. */
const DIBAWA = ["month", "year", "principle", "branch"] as const;
type Ubah = Partial<Record<(typeof DIBAWA)[number] | "sm", string>>;

/** Periode + saringan dari URL. Bulan/tahun tidak valid jatuh ke bulan berjalan. */
export function usePeriode() {
    const sp = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const now = new Date();
    const m = Number(sp.get("month"));
    const y = Number(sp.get("year"));
    const month = Number.isInteger(m) && m >= 1 && m <= 12 ? m : now.getMonth() + 1;
    const year = Number.isInteger(y) && y >= 2020 && y <= 2100 ? y : now.getFullYear();
    const principle = sp.get("principle") || "ALL";
    const branch = sp.get("branch") || "ALL";
    const sm = sp.get("sm") || "ALL";
    const ubah = useCallback((u: Ubah) => {
        const p = new URLSearchParams(sp.toString());
        for (const [k, v] of Object.entries(u)) {
            if (!v || v === "ALL") p.delete(k);
            else p.set(k, v);
        }
        const q = p.toString();
        router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    }, [pathname, router, sp]);
    /** Query yang dibawa ke halaman insentif lain (periode, principal, cabang). */
    const bawa = useMemo(() => {
        const p = new URLSearchParams();
        for (const k of DIBAWA) { const v = sp.get(k); if (v) p.set(k, v); }
        const q = p.toString();
        return q ? `?${q}` : "";
    }, [sp]);
    return { month, year, principle, branch, sm, ubah, bawa, label: `${MONTH_LABELS[month - 1]} ${year}` };
}

export interface DashboardData {
    rows: ApiRow[];
    progressFeed: ProgressFeedStatus | null;
    konstanta: Konstanta;
    cakupan: Cakupan;
    opsiFilter: { principles: string[]; branches: string[]; sm: string[] };
}

/** GET dashboard untuk periode + principal + cabang. Galat tidak pernah jadi kosong; muat ulang menyimpan data lama. */
export function useDashboard({ month, year, principle, branch }: { month: number; year: number; principle: string; branch: string }): [Load<DashboardData>, () => void] {
    return useLoad(useCallback(async (): Promise<Load<DashboardData>> => {
        const p = new URLSearchParams({ month: String(month), year: String(year) });
        if (principle !== "ALL") p.set("principle", principle);
        if (branch !== "ALL") p.set("branch", branch);
        const r = await ambil(`/api/insentif-sales/dashboard?${p}`, (j) => {
            const d = j as Partial<DashboardData> & { rows?: ApiRow[]; konstanta?: unknown };
            return {
                rows: d.rows ?? [],
                progressFeed: d.progressFeed ?? null,
                konstanta: parseKonstanta(d.konstanta),
                cakupan: d.cakupan ?? { dibatasi: false },
                opsiFilter: d.opsiFilter ?? { principles: [], branches: [], sm: [] },
            };
        });
        // Pesan server ditampilkan; "HTTP 500" mentah tidak (aturan 5 brief) — cukup kalimat umumnya.
        const sebab = r.error && !/^HTTP \d+$/.test(r.error) ? ` ${r.error}` : "";
        return r.status === "galat" ? { ...r, error: `Data insentif belum berhasil dimuat.${sebab}` } : r;
    // Tanpa `pertahankan`: data periode/saringan lain tidak pernah dipinjam (angka September di bawah label Oktober).
    // Muat ulang periode yang sama tetap menyimpan data lama + status galat (useLoad).
    }, [month, year, principle, branch]));
}

/**
 * Konstanta yang dipakai SERVER saat menghitung baris yang tampil (dikirim bersama data dashboard). Semua penjelasan —
 * ambang AO, ambang 90%, strata SM, tarif PPh — dibaca dari sini, bukan salinan angka di klien.
 */
export const KonstantaCtx = createContext<Konstanta>(DEFAULT_KONSTANTA);
export const useKonstanta = () => useContext(KonstantaCtx);

/** Identitas hierarki akun dari server (lib/insentif-akses); menentukan halaman yang tampil bersama izin. */
const PeranCtx = createContext<PeranHierarki>(null);
export function PeranInsentif({ peran, children }: { peran: PeranHierarki; children: ReactNode }) {
    return <PeranCtx.Provider value={peran}>{children}</PeranCtx.Provider>;
}

type RangkaProps = {
    halaman: HalamanKey;
    permKeys: string[];
    /** Kalimat di bawah judul. */
    deskripsi?: string;
    /** Opsi principal/cabang (dari dashboard). Tanpa ini hanya periode yang tampil; `false` = tanpa saringan sama sekali. */
    saringan?: { principals: string[]; branches: string[] } | false;
    /** Isian saringan tambahan (mis. SM di Dashboard). */
    saringanLain?: ReactNode;
    aksi?: ReactNode;
    children: ReactNode;
};

/** Kepala + navigasi antarhalaman + saringan + penjaga izin. Isi halaman tidak dirender bila halaman tidak boleh dibuka. */
export function InsentifRangka({ halaman, permKeys, deskripsi, saringan, saringanLain, aksi, children }: RangkaProps) {
    const perms = useMemo(() => new Set(permKeys), [permKeys]);
    const peran = useContext(PeranCtx);
    const terlihat = useMemo(() => halamanTerlihat(perms, peran), [perms, peran]);
    // "Insentif saya" boleh dibuka langsung oleh semua akun insentif (isinya sendiri tertutup tanpa identitas sales);
    // di navigasi hanya muncul bila akun tidak punya halaman lain.
    const ini = terlihat.find((h) => h.key === halaman) ?? HALAMAN.find((h) => h.key === halaman && h.key === "saya");
    const { month, year, principle, branch, sm, ubah, bawa } = usePeriode();
    const judul = ini?.label ?? "Insentif Sales";
    const smAktif = Boolean(saringan && saringanLain) && sm !== "ALL";
    const aktif = saringan ? Number(principle !== "ALL") + Number(branch !== "ALL") + Number(smAktif) : 0;
    const chips = saringan ? [
        ...(principle !== "ALL" ? [{ label: `Principal: ${principle}`, onRemove: () => ubah({ principle: "ALL" }) }] : []),
        ...(branch !== "ALL" ? [{ label: `Cabang: ${branch}`, onRemove: () => ubah({ branch: "ALL" }) }] : []),
        ...(smAktif ? [{ label: `SM: ${sm}`, onRemove: () => ubah({ sm: "ALL" }) }] : []),
    ] : [];

    const periode = (
        <FormField label="Periode">{(a) => (
            <input {...a} className="fi-input" type="month" value={`${year}-${String(month).padStart(2, "0")}`}
                onChange={(e) => { const [y, m] = e.target.value.split("-"); if (y && m) ubah({ year: y, month: String(Number(m)) }); }} />
        )}</FormField>
    );

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Operasional Sales</span></li><li><span>Insentif Sales</span></li><li><span aria-current="page">{judul}</span></li></ol></nav>
                <div className="fi-page-bar"><h1>{judul}</h1><span className="fi-spacer" />{ini && aksi}</div>
                {ini && deskripsi && <p>{deskripsi}</p>}
            </header>
            {terlihat.length > 1 && (
                <nav className="fi-subnav" aria-label="Halaman Insentif Sales">
                    {terlihat.map((h) => <Link key={h.key} href={`${h.href}${bawa}`} aria-current={h.key === halaman ? "page" : undefined}>{h.label}</Link>)}
                </nav>
            )}
            {!ini ? (
                <EmptyState
                    title="Halaman ini tidak tersedia untuk akun Anda"
                    message="Izin insentif akun Anda tidak mencakup halaman ini. Minta admin menambahkan izinnya bila Anda memang mengerjakannya."
                    action={<Link className="fi-btn fi-btn--primary" href={`${terlihat[0].href}${bawa}`}>Buka {terlihat[0].label}</Link>}
                />
            ) : (
                <>
                    {saringan ? (
                        <FilterBar
                            title="Periode dan saringan"
                            activeCount={aktif}
                            chips={chips}
                            onReset={() => ubah({ principle: "ALL", branch: "ALL", sm: "ALL" })}
                            search={periode}
                            fields={
                                <>
                                    <FormField label="Principal">{(a) => (
                                        <select {...a} className="fi-input" value={principle} onChange={(e) => ubah({ principle: e.target.value })}>
                                            <option value="ALL">Semua principal</option>
                                            {saringan.principals.map((p) => <option key={p} value={p}>{p}</option>)}
                                        </select>
                                    )}</FormField>
                                    <FormField label="Cabang">{(a) => (
                                        <select {...a} className="fi-input" value={branch} onChange={(e) => ubah({ branch: e.target.value })}>
                                            <option value="ALL">Semua cabang</option>
                                            {saringan.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                                        </select>
                                    )}</FormField>
                                    {saringanLain}
                                </>
                            }
                        />
                    ) : saringan === undefined ? (
                        // Hanya periode: tanpa tombol "Saringan" ponsel yang akan membuka lembar kosong.
                        <div className="fi-fbar"><div style={{ maxWidth: "16rem" }}>{periode}</div></div>
                    ) : null}
                    {children}
                </>
            )}
        </div>
    );
}
