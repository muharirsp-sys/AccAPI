/*
 * Tujuan: Bagian tampilan bersama Insentif Sales (Fiori S4c): warna laju (warna + ikon + teks + legenda), kolom PPh (bruto → PPh → netto
 *   dari konstanta server), rincian per baris Sales/SPV/SM, tabel dengan baris yang bisa dibuka, status bayar, dan pemuat insentif SPV/SM.
 * Caller: Dashboard.tsx, Saya.tsx, Pembayaran.tsx.
 * Dependensi: components/fiori/{core,interactive}, lib/insentif-ui, lib/insentif-pph, lib/insentif-konstanta (tipe), lib/rekapan-nota/ui (ambil),
 *   ./data (formatRp, paceStatus), ./Rangka (useKonstanta).
 * Main Functions: Laju, LegendaLaju, CatatanTimeGone, StatusBayar, labelPph, kolomPph, kakiPph, itemsPph, SalesBreakdown, SpvBreakdown, SmBreakdown, strataSm,
 *   sebabNolSpv, sebabNolSm, useExpandableRows, TabelRincian, useInsentifSpv, useInsentifSm.
 * Side Effects: GET /api/insentif-sales/spv-dashboard dan /sm-dashboard (useInsentifSpv/useInsentifSm); lainnya murni tampilan.
 *
 * Cara memakai (mis. Pembayaran, pengganti FinanceView lama):
 *  - Bungkus layar dengan <KonstantaCtx.Provider value={konstanta dari useDashboard}>: rincian dan PPh membaca konstanta yang dipakai server.
 *  - `<PphHeads/>` + `<PphCells bruto={x}/>` lama → kolom `...kolomPph(k, (row) => row.total)` (dua kolom: PPh, Netto dibayar);
 *    baris total → `foot={{ label: "Total", cells: { total: …, ...kakiPph(k, grand) } }}`.
 *  - `useExpandableRows()` + `<tr {...rowProps(key)}>` + `<ExpandCell/>` lama → `<TabelRincian rincian={(row) => …} rowLabel={(row) => nama} …/>`.
 *    Props sama dengan ResponsiveTable (title, columns, rows, rowKey, mobileItem, status, error, onRetry, empty, selected/onSelectedChange/
 *    selectableRow) + `rincian`, `rowLabel`, `foot`. Tombol Rincian terpisah dari kotak pilih: satu klik di kotak pilih hanya memilih.
 *    `useExpandableRows()` tetap diekspor ({ open, toggle }) bila butuh tata letak sendiri.
 *  - Isi rincian: <SalesBreakdown r={apiRow} semuaBaris={apiRows}/>, <SpvBreakdown rincian={spvRow.rincian}/>, <SmBreakdown r={smRow}/>.
 *  - Data SPV/SM: `const [spv, muatSpv] = useInsentifSpv(month, year)` → Load<SpvIncentiveRow[]>; galat TIDAK pernah jadi daftar kosong.
 */
"use client";

import { Fragment, useCallback, useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, Clock, TriangleAlert } from "lucide-react";
import { Button, EmptyState, ErrorState, KeyValues, MessageStrip, Skeleton, StatusBadge, VariantNote, type Column, type Tone } from "@/components/fiori/core";
import { useLoad, type Load } from "@/components/fiori/interactive";
import { ambil } from "@/lib/rekapan-nota/ui";
import { nettoInsentif, pphInsentif } from "@/lib/insentif-pph";
import type { Konstanta } from "@/lib/insentif-konstanta";
import { LABEL_STATUS, formatPctText, formatQty, formatRatio, type ApiRow } from "@/lib/insentif-ui";
import { formatRp, paceStatus, type PaceLevel, type WorkdayProgress } from "./data";
import { useKonstanta } from "./Rangka";

// ── Warna laju (#7) ─────────────────────────────────────────────────────────
const LAJU: Record<PaceLevel, { tone: "pos" | "warn" | "neg"; Icon: typeof Check; teks: string; rentang: string }> = {
    green: { tone: "pos", Icon: Check, teks: "di atas laju", rentang: "≥ 100%" },
    yellow: { tone: "warn", Icon: Clock, teks: "mendekati laju", rentang: "80–99%" },
    red: { tone: "neg", Icon: TriangleAlert, teks: "tertinggal", rentang: "< 80%" },
};

/**
 * Capaian dibanding Time Gone (data.paceStatus): warna + ikon + teks, bukan warna latar saja (WCAG 1.4.1).
 * `teks` = tampilkan kalimat lajunya ("di atas laju") sebagai label, bukan angkanya.
 */
export function Laju({ nilai, timeGone, teks }: { nilai: number; timeGone: number; teks?: boolean }) {
    const l = LAJU[paceStatus(nilai, timeGone)];
    return (
        <span className="fi-badge fi-tnum" data-tone={l.tone} title={teks ? undefined : l.teks}>
            <l.Icon className="fi-icon" aria-hidden />
            {teks ? l.teks : <>{formatPctText(nilai)}<span className="sr-only"> · {l.teks}</span></>}
        </span>
    );
}

export function LegendaLaju({ timeGone }: { timeGone: number }) {
    return (
        <div className="fi-small fi-muted flex flex-wrap items-center gap-2">
            <span>Warna = capaian dibanding Time Gone {timeGone}%:</span>
            {(["green", "yellow", "red"] as const).map((lvl) => {
                const l = LAJU[lvl];
                return <span key={lvl} className="fi-badge" data-tone={l.tone}><l.Icon className="fi-icon" aria-hidden />{l.teks} ({l.rentang})</span>;
            })}
        </div>
    );
}

/** Time Gone hari ini = data.getPeriodWorkdayProgress (Senin–Jumat tanpa libur nasional); usulan BL-48 belum masuk. */
export function CatatanTimeGone({ tg, label }: { tg: WorkdayProgress; label: string }) {
    return (
        <VariantNote bl="BL-48">
            Time Gone {label}: {tg.passed} dari {tg.total} hari kerja ({tg.pct}%), dihitung Senin–Jumat tanpa libur nasional. Bila BL-48 masuk
            (jawaban owner 7 Okt: Senin–Sabtu), Sabtu ikut dihitung dan libur nasional dikecualikan — persen Time Gone dan warna laju ikut bergeser.
        </VariantNote>
    );
}

const STATUS_BAYAR: Record<string, { tone: Tone; label: string }> = {
    lunas: { tone: "pos", label: "Lunas" },
    tunggakan: { tone: "neg", label: "Tunggakan" },
    belum: { tone: "neu", label: "Belum dibayar" },
};
/** Status pembayaran baris (belum | lunas | tunggakan). Tunggakan tampil apa adanya — belum ada aksinya dari layar. */
export function StatusBayar({ status }: { status: string }) {
    const s = STATUS_BAYAR[status] ?? STATUS_BAYAR.belum;
    return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
}

// ── PPh ─────────────────────────────────────────────────────────────────────
// Kolom insentif tetap BRUTO, PPh dan Netto ditambahkan di sebelahnya: bruto adalah angka yang bisa dicocokkan dengan hitungan
// manual & file target, netto adalah yang dibayar. Tarif selalu dari konstanta server (KonstantaCtx), bukan salinan di klien.
export const labelPph = (rate: number) => `PPh ${(rate * 100).toLocaleString("id-ID")}%`;

/** Dua kolom berpasangan (PPh, Netto dibayar) untuk ResponsiveTable/TabelRincian; key "pph" dan "netto". */
export function kolomPph<T>(k: Konstanta, bruto: (row: T) => number): Column<T>[] {
    return [
        {
            key: "pph", header: labelPph(k.pph.rate), align: "end", secondary: true,
            cell: (row) => { const b = bruto(row); return b > 0 ? `-${formatRp(pphInsentif(b, k.pph.rate))}` : formatRp(0); },
        },
        { key: "netto", header: "Netto dibayar", align: "end", cell: (row) => <b>{formatRp(nettoInsentif(bruto(row), k.pph.rate))}</b> },
    ];
}

/** Sel baris total untuk dua kolom kolomPph. */
export function kakiPph(k: Konstanta, bruto: number): Record<"pph" | "netto", ReactNode> {
    return {
        pph: <b>{bruto > 0 ? `-${formatRp(pphInsentif(bruto, k.pph.rate))}` : formatRp(0)}</b>,
        netto: <b>{formatRp(nettoInsentif(bruto, k.pph.rate))}</b>,
    };
}

/** Dua baris terakhir grup "Hasil" di rincian, supaya bruto/netto tidak pernah beda tempat. */
export function itemsPph(bruto: number, k: Konstanta): Array<[string, ReactNode]> {
    return [
        [labelPph(k.pph.rate), <span key="pph" className="fi-muted">-{formatRp(pphInsentif(bruto, k.pph.rate))}</span>],
        ["Netto dibayar", formatRp(nettoInsentif(bruto, k.pph.rate))],
    ];
}

// ── Tipe SPV/SM (respons spv-dashboard / sm-dashboard) ─────────────────────
export interface SpvIncentiveDetail {
    principle: string;
    targetValue: number;
    realisasiValue: number;
    pctValue: number;
    rate: number;
    /** Support principle utk SPV pada principal ini. */
    support: number;
    /** rate − support (floor 0). Ini yang benar-benar dibayar distributor. */
    porsiDistributor: number;
    insentif: number;
}
export interface SpvIncentiveRow {
    spvName: string;
    jumlahValid: number;
    ratePerPrincipal: number;
    rincian: SpvIncentiveDetail[];
    total: number;
}
export interface SmIncentiveRow {
    smName: string;
    jumlahBaris: number;
    targetValue: number;
    realisasiValue: number;
    pctValue: number;
    berhak: boolean;
    total: number;
}

/**
 * Strata FLAT insentif SM, DITURUNKAN dari konstanta aktif (lib/insentif-sm-calc memakai angka yang sama). Label batas atas memakai
 * ambang strata berikutnya supaya tetap benar kalau ambangnya diubah dari Pengaturan.
 */
export function strataSm(k: Konstanta): Array<{ min: number; label: string; nominal: number }> {
    const p = (v: number) => formatPctText(v * 100);
    return [
        { min: k.sm.ambang3 * 100, label: `≥ ${p(k.sm.ambang3)}`, nominal: k.sm.nominal3 },
        { min: k.sm.ambang2 * 100, label: `${p(k.sm.ambang2)} - <${p(k.sm.ambang3)}`, nominal: k.sm.nominal2 },
        { min: k.sm.ambang1 * 100, label: `${p(k.sm.ambang1)} - <${p(k.sm.ambang2)}`, nominal: k.sm.nominal1 },
        { min: 0, label: `< ${p(k.sm.ambang1)}`, nominal: 0 },
    ];
}

/**
 * Capaian SM sebagai persen. Rasio dibulatkan sama persis seperti rateSm (roundRatio 1e-6) sebelum dicocokkan ke strata. Tanpa itu
 * 0,8999999997 di layar jatuh ke "< 90%" padahal yang dibayar server Rp 1,5jt: rincian yang membantah nominalnya sendiri.
 */
export const capaianSm = (r: SmIncentiveRow) => (Math.round(r.pctValue * 1e6) / 1e6) * 100;

/** Kenapa baris SPV Rp 0 (#6). Urutan mengikuti calculateInsentifSPV: tanpa principal valid → ditanggung penuh → di bawah ambang. */
export function sebabNolSpv(r: SpvIncentiveRow, k: Konstanta): string | null {
    if (r.total > 0) return null;
    if (r.rincian.length === 0) return "tidak ada principal valid";
    if (r.rincian.every((d) => (d.porsiDistributor ?? d.rate) <= 0)) return "ditanggung principle";
    return `belum ${formatPctText(k.spv.ambang * 100)} per principal`;
}

/** Kenapa baris SM Rp 0 (#6): di luar daftar SM yang ikut skema, atau capaian di bawah strata terendah. */
export function sebabNolSm(r: SmIncentiveRow, k: Konstanta): string | null {
    if (r.total > 0) return null;
    if (!r.berhak) return "tidak ikut skema insentif SM";
    if (!(r.targetValue > 0)) return "target belum diisi";
    return `belum ${formatPctText(k.sm.ambang1 * 100)}`;
}

// ── Rincian per baris ───────────────────────────────────────────────────────
/** Kelompok rincian: judul kecil + daftar label–nilai. Dipakai rincian Sales, SPV, dan SM. */
function Grup({ title, items }: { title: string; items: Array<[string, ReactNode]> }) {
    return (
        <div className="grid content-start gap-2">
            <h3 className="fi-caption">{title}</h3>
            <KeyValues items={items} />
        </div>
    );
}
const redup = (v: ReactNode) => <span className="fi-muted">{v}</span>;

/**
 * Rincian satu baris salesman. SATU definisi dipakai Dashboard dan Pembayaran: kalau keduanya punya salinan sendiri, cepat atau lambat
 * yang satu menampilkan dasar perhitungan yang berbeda dari yang lain untuk baris yang sama.
 */
export function SalesBreakdown({ r, semuaBaris }: { r: ApiRow; semuaBaris?: ApiRow[] }) {
    const k = useKonstanta();
    const isMt = r.channel === "MT";
    // Ambang AO yang dipakai membayar, dari server (setelan global + tombol per baris).
    // Menebaknya ulang di sini dari setelan global membuat layar membantah nominalnya sendiri.
    const ambangAo = r.ambangAo;

    // MT membayar 4 KPI (Value, EC, OA, IA, nominal tetap); GT/TT hanya 2 (Value + AO berbobot). Menampilkan dua komponen untuk semua
    // channel membuat baris MT memperlihatkan Rp 500.000 di bawah total Rp 986.403 — rincian yang tidak menjumlah ke totalnya sendiri
    // (dilaporkan user 2026-08-26).
    const komponen: Array<[string, ReactNode]> = isMt
        ? [
            [`Value (bobot ${formatRp(k.mt.bobotValue)})`, formatRp(r.incentive.value)],
            [`EC (bobot ${formatRp(k.mt.bobotEc)})`, formatRp(r.incentive.ec)],
            [`Aktif Outlet (bobot ${formatRp(k.mt.bobotAo)})`, formatRp(r.incentive.ao)],
            [`Item Aktif (bobot ${formatRp(k.mt.bobotIa)})`, formatRp(r.incentive.isq)],
            ["Total", <b key="t">{formatRp(r.incentive.total)}</b>],
            ...itemsPph(r.incentive.total, k),
        ]
        : [
            [`Value (${formatPctText(k.gt.bobotValue * 100)})`, formatRp(r.incentive.value)],
            [`AO (${formatPctText(k.gt.bobotAo * 100)})`, formatRp(r.incentive.ao)],
            ["Total", <b key="t">{formatRp(r.incentive.total)}</b>],
            ...itemsPph(r.incentive.total, k),
        ];

    // Sales "mix": komponen Value dinilai dari GABUNGAN seluruh principal yang ikut skema, lalu dibagi ke tiap principal menurut porsi
    // targetnya. Tanpa angka gabungan ini, baris dengan pencapaian 55% terlihat dibayar tanpa sebab (dilaporkan user 2026-08-26).
    const gabungan = (() => {
        if (r.tipeSales !== "mix" || !semuaBaris) return null;
        const anggota = semuaBaris.filter((x) => x.salesCode === r.salesCode && x.statusInsentif !== "principle");
        if (anggota.length <= 1) return null;
        const target = anggota.reduce((a, x) => a + x.target.value, 0);
        const real = anggota.reduce((a, x) => a + x.real.value, 0);
        return { jumlah: anggota.length, target, real, pct: target > 0 ? (real / target) * 100 : 0 };
    })();

    return (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Grup title="Value" items={[
                ["Target", formatRp(r.target.value)],
                ["Realisasi", formatRp(r.real.value)],
                ["Pencapaian", formatPctText(r.pct.value)],
            ]} />
            <Grup title="Aktif Outlet (AO)" items={[
                [isMt ? "Target" : "Target (file)", formatQty(r.target.ao)],
                ["Realisasi", formatQty(r.real.ao)],
                ["Pencapaian", formatPctText(r.pct.ao)],
                // GT/TT membayar AO terhadap ambang skema (240), BUKAN target di file target — kecuali baris ini dipindah ke target
                // file (tombol per baris / setelan global). Tanpa baris ini, pencapaian 18% di layar tidak akan pernah cocok dengan
                // nominal yang dibayar.
                ...(isMt || ambangAo === r.target.ao ? [] : [
                    ["Ambang skema", redup(formatQty(ambangAo))] as [string, ReactNode],
                    ["Pencapaian dibayar", formatPctText(ambangAo > 0 ? (r.real.ao / ambangAo) * 100 : 0)] as [string, ReactNode],
                ]),
            ]} />
            <Grup title="EC & ISQ" items={[
                ["Target EC", formatQty(r.target.ec)],
                ["Realisasi EC", formatQty(r.real.ec)],
                ["Pencapaian EC", formatPctText(r.pct.ec)],
                ["Target ISQ", formatRatio(r.target.isq)],
                ["Realisasi ISQ", formatRatio(r.real.isq)],
                ["Pencapaian ISQ", formatPctText(r.pct.isq)],
            ]} />
            <Grup title="Dasar perhitungan" items={[
                ["Tipe sales", redup(r.tipeSales ?? "-")],
                ["Status insentif", redup(LABEL_STATUS[r.statusInsentif ?? ""] ?? r.statusInsentif ?? "-")],
                ["Support principle", formatRp(r.support ?? 0)],
            ]} />
            <Grup title={isMt ? "Komponen insentif (MT)" : "Komponen insentif"} items={komponen} />
            {gabungan && (
                <Grup title={`Dasar Value gabungan (${gabungan.jumlah} principal)`} items={[
                    ["Target gabungan", formatRp(gabungan.target)],
                    ["Realisasi gabungan", formatRp(gabungan.real)],
                    ["Pencapaian dipakai", formatPctText(gabungan.pct)],
                ]} />
            )}
            <Grup title="Wilayah" items={[
                ["Cabang", redup(r.branch)],
                ["Channel", redup(r.channel)],
                ["SPV / SM", redup(`${r.spvName ?? "-"} / ${r.smName ?? "-"}`)],
            ]} />
        </div>
    );
}

/** Rincian per principal untuk satu SPV. Target & realisasi ikut, tanpa itu persentasenya tak bisa ditelusuri. */
export function SpvBreakdown({ rincian }: { rincian: SpvIncentiveDetail[] }) {
    const k = useKonstanta();
    // pctValue SPV adalah PENGALI (0 atau 1 sejak ambang 100% berlaku), bukan pencapaian. Menampilkannya apa adanya membuat setiap baris
    // terbaca 0% atau 100% dan pencapaian sebenarnya hilang, justru di tempat orang mencarinya.
    const pencapaian = (d: SpvIncentiveDetail) => (d.targetValue > 0 ? (d.realisasiValue / d.targetValue) * 100 : 0);
    if (rincian.length === 0) return <p className="fi-small fi-muted">Tidak ada principal valid untuk SPV ini.</p>;
    return (
        <div className="overflow-x-auto">
            <table className="fi-table">
                <caption className="sr-only">Rincian per principal</caption>
                <thead>
                    <tr>
                        <th scope="col">Principal</th>
                        <th scope="col" className="fi-end">Target</th>
                        <th scope="col" className="fi-end">Realisasi</th>
                        <th scope="col" className="fi-end">Pencapaian</th>
                        <th scope="col" className="fi-end">Rate</th>
                        <th scope="col" className="fi-end">Support</th>
                        <th scope="col" className="fi-end">Insentif</th>
                    </tr>
                </thead>
                <tbody>
                    {rincian.map((d) => (
                        <tr key={d.principle}>
                            <td>{d.principle}</td>
                            <td className="fi-end">{formatRp(d.targetValue)}</td>
                            <td className="fi-end">{formatRp(d.realisasiValue)}</td>
                            <td className="fi-end">{formatPctText(pencapaian(d))}</td>
                            <td className="fi-end">{formatRp(d.rate)}</td>
                            <td className="fi-end">{(d.support ?? 0) > 0 ? formatRp(d.support) : "-"}</td>
                            <td className="fi-end">
                                {d.insentif > 0
                                    ? <b>{formatRp(d.insentif)}</b>
                                    // Label lama selalu berbunyi "belum 100%" — termasuk untuk baris berpencapaian 130% yang nol karena support
                                    // menutup penuh rate.
                                    : <span className="fi-muted">{(d.porsiDistributor ?? d.rate) <= 0
                                        ? "Rp 0 · ditanggung principle"
                                        : `Rp 0 · belum ${formatPctText(k.spv.ambang * 100)}`}</span>}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Rincian satu SM: strata FLAT, jadi yang perlu dijelaskan adalah strata mana yang kena dan kenapa. */
export function SmBreakdown({ r }: { r: SmIncentiveRow }) {
    const k = useKonstanta();
    const strata = strataSm(k);
    const capaian = capaianSm(r);
    const kena = strata.find((t) => capaian >= t.min) ?? strata[strata.length - 1];
    const selisih = r.realisasiValue - r.targetValue;
    return (
        <div className="grid gap-4">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                <Grup title="Value wilayah" items={[
                    ["Target", formatRp(r.targetValue)],
                    ["Realisasi", formatRp(r.realisasiValue)],
                    [selisih >= 0 ? "Surplus" : "Kurang", formatRp(Math.abs(selisih))],
                ]} />
                <Grup title="Dasar perhitungan" items={[
                    ["Pencapaian", formatPctText(capaian)],
                    ["Strata", kena.label],
                    ["Baris sales dihitung", formatQty(r.jumlahBaris)],
                ]} />
                <Grup title="Hasil" items={[
                    ["Nominal strata", formatRp(kena.nominal)],
                    ["Ikut skema", redup(r.berhak ? "Ya" : "Tidak")],
                    ["Bruto", <b key="b">{formatRp(r.total)}</b>],
                    ...itemsPph(r.total, k),
                ]} />
            </div>
            <p className="fi-small fi-muted">Strata FLAT: nominal tidak dikali persentase. Semua status principal ikut dihitung, termasuk principle. Baris _OFFICE dibuang.</p>
        </div>
    );
}

// ── Tabel dengan baris yang bisa dibuka ─────────────────────────────────────
/**
 * State buka/tutup rincian per kunci baris. Pembukanya selalu tombol (bisa dicapai keyboard), bukan baris ber-onClick: di layar yang
 * dipakai Finance memverifikasi nominal, baris yang hanya bisa diklik berarti sebagian orang tidak bisa melihat dasar perhitungannya.
 */
export function useExpandableRows() {
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const toggle = useCallback((key: string) => setOpen((p) => ({ ...p, [key]: !p[key] })), []);
    return { open, toggle };
}

type TabelRincianProps<T> = {
    title: string; count?: number; actions?: ReactNode;
    columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string;
    /** Isi satu baris di ponsel (< 600 px lebar wadah), biasanya <ListItem>; tombol Rincian ditambahkan di bawahnya. */
    mobileItem: (row: T) => ReactNode;
    status?: "memuat" | "siap" | "galat"; error?: string; onRetry?: () => void;
    /** Kalimat berbeda untuk "belum ada data" dan "tidak ada yang sesuai saringan" — pemanggil yang memilih. */
    empty: { title: string; message?: string; action?: ReactNode };
    /** Isi baris rincian (SalesBreakdown/SpvBreakdown/SmBreakdown). Dirender hanya saat dibuka. */
    rincian: (row: T) => ReactNode;
    /** Nama baris untuk pembaca layar: tombol "Rincian <nama>", kotak "Pilih <nama>". */
    rowLabel: (row: T) => string;
    /** Baris total: isi per key kolom (kolom tanpa isi dibiarkan kosong; kolom pertama memakai `label`). Di ponsel jadi daftar label–nilai. */
    foot?: { label: string; cells: Partial<Record<string, ReactNode>> };
    selected?: ReadonlySet<string>; onSelectedChange?: (next: Set<string>) => void;
    /** Baris yang boleh dipilih; lainnya kotaknya nonaktif dan tidak ikut "Pilih semua". Bawaan: semua. */
    selectableRow?: (row: T) => boolean;
};

// ponytail: salinan pola ResponsiveTable (keadaan, pop-in, daftar ponsel, pilih massal) + baris rincian, karena ResponsiveTable tidak
// punya baris sisipan. DOM ganda tabel + daftar sama seperti ResponsiveTable; pindahkan `rincian` ke ResponsiveTable bila slice lain butuh.
export function TabelRincian<T>(props: TabelRincianProps<T>) {
    const { title, count, actions, columns, rows, rowKey, mobileItem, status = "siap", error, onRetry, empty, rincian, rowLabel, foot, selected, onSelectedChange, selectableRow } = props;
    const id = useId();
    const { open, toggle } = useExpandableRows();
    const selectable = Boolean(selected && onSelectedChange);
    const keys = rows.map(rowKey);
    const pickable = rows.map((row) => !selectableRow || selectableRow(row));
    const pickableKeys = keys.filter((_, i) => pickable[i]);
    const nSelected = selectable ? pickableKeys.filter((key) => selected!.has(key)).length : 0;
    const secondaryCols = columns.filter((c) => c.secondary);
    const nCol = columns.length + 1 + (selectable ? 1 : 0);
    const cls = (c: Column<T>) => `${c.align === "end" ? "fi-end" : ""} ${c.secondary ? "fi-secondary" : ""}`;
    const pilih = (key: string) => {
        const next = new Set(selected);
        if (next.has(key)) next.delete(key); else next.add(key);
        onSelectedChange!(next);
    };
    const tombol = (row: T, key: string, target: string) => (
        <Button variant="tertiary" aria-expanded={Boolean(open[key])} aria-controls={open[key] ? target : undefined} aria-label={`Rincian ${rowLabel(row)}`}
            icon={open[key] ? <ChevronUp className="fi-icon" aria-hidden /> : <ChevronDown className="fi-icon" aria-hidden />} onClick={() => toggle(key)}>
            Rincian
        </Button>
    );

    let body: ReactNode;
    if (rows.length === 0 && status === "memuat") body = <Skeleton />;
    else if (rows.length === 0 && status === "galat") body = <ErrorState message={error} onRetry={onRetry} />;
    else if (rows.length === 0) body = <EmptyState {...empty} />;
    else body = (
        <div className={status === "memuat" ? "fi-busy" : undefined}>
            <div className="fi-tablescroll">
                <table className="fi-table">
                    <caption className="sr-only">{title}</caption>
                    <thead>
                        <tr>
                            {selectable && (
                                <th className="fi-sel">
                                    <input type="checkbox" aria-label="Pilih semua baris" disabled={pickableKeys.length === 0}
                                        checked={pickableKeys.length > 0 && nSelected === pickableKeys.length}
                                        ref={(el) => { if (el) el.indeterminate = nSelected > 0 && nSelected < pickableKeys.length; }}
                                        onChange={() => {
                                            // Hanya baris yang terlihat; pilihan di luar saringan tidak ikut berubah.
                                            const next = new Set(selected);
                                            for (const key of pickableKeys) { if (nSelected === pickableKeys.length) next.delete(key); else next.add(key); }
                                            onSelectedChange!(next);
                                        }} />
                                </th>
                            )}
                            {columns.map((c) => <th key={c.key} scope="col" className={cls(c)}>{c.header}</th>)}
                            <th scope="col" className="fi-end"><span className="sr-only">Rincian</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, i) => {
                            const key = keys[i];
                            const isSel = selectable && selected!.has(key);
                            const target = `${id}-t${i}`;
                            return (
                                <Fragment key={key}>
                                    <tr data-selected={isSel || undefined}>
                                        {/* Kotak pilih TIDAK ikut membuka rincian: satu klik di kolom ini harus berarti satu hal saja. */}
                                        {selectable && <td className="fi-sel"><input type="checkbox" aria-label={`Pilih ${rowLabel(row)}`} checked={isSel} disabled={!pickable[i]} onChange={() => pilih(key)} /></td>}
                                        {columns.map((c, ci) => (
                                            <td key={c.key} className={cls(c)}>
                                                {c.cell(row)}
                                                {ci === 0 && secondaryCols.length > 0 && (
                                                    <span className="fi-popin">{secondaryCols.map((s) => <span key={s.key}>{s.header}: {s.cell(row)} · </span>)}</span>
                                                )}
                                            </td>
                                        ))}
                                        <td className="fi-end">{tombol(row, key, target)}</td>
                                    </tr>
                                    {open[key] && <tr id={target}><td colSpan={nCol}>{rincian(row)}</td></tr>}
                                </Fragment>
                            );
                        })}
                    </tbody>
                    {foot && (
                        <tfoot>
                            <tr>
                                {selectable && <td />}
                                {columns.map((c, ci) => <td key={c.key} className={cls(c)}>{foot.cells[c.key] ?? (ci === 0 ? <b>{foot.label}</b> : null)}</td>)}
                                <td />
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
            <ul className="fi-list" aria-label={title}>
                {rows.map((row, i) => {
                    const target = `${id}-m${i}`;
                    return (
                        <li key={keys[i]}>
                            {mobileItem(row)}
                            <div className="px-2 pb-2">
                                {tombol(row, keys[i], target)}
                                {open[keys[i]] && <div id={target} className="px-2 pt-2">{rincian(row)}</div>}
                            </div>
                        </li>
                    );
                })}
                {foot && (
                    <li className="grid gap-2 px-4 py-3">
                        <b>{foot.label}</b>
                        <KeyValues items={columns.filter((c) => foot.cells[c.key] != null).map((c) => [c.header, foot.cells[c.key]])} />
                    </li>
                )}
            </ul>
        </div>
    );

    return (
        <section className="fi-tablebox" aria-busy={(status === "memuat" && rows.length > 0) || undefined}>
            <div className="fi-tbar">
                <h2>{title}{count != null && <span> ({count})</span>}</h2>
                {actions}
            </div>
            {status === "galat" && rows.length > 0 && (
                <div style={{ padding: "12px 16px 0" }}>
                    <MessageStrip tone="neg" title="Gagal memuat ulang.">
                        {error} Yang tampil adalah hasil sebelumnya.{" "}
                        {onRetry && <button type="button" className="fi-btn fi-btn--tertiary" onClick={onRetry}>Coba lagi</button>}
                    </MessageStrip>
                </div>
            )}
            {body}
        </section>
    );
}

// ── Pemuat insentif SPV/SM ──────────────────────────────────────────────────
// Dulu galat endpoint ini tampil sebagai "Belum ada data SPV…" (res.ok ? rows : []) — sekarang galat tetap galat (#9).
function muatBaris<T>(url: string, apa: string) {
    return async (): Promise<Load<T[]>> => {
        const r = await ambil(url, (j) => ((j as { rows?: T[] }).rows ?? []));
        return r.status === "galat" ? { ...r, error: `Insentif ${apa} belum berhasil dimuat${r.error && !/^HTTP \d+$/.test(r.error) ? ` (${r.error})` : ""}.` } : r;
    };
}

// Tanpa `pertahankan`: ganti periode TIDAK pernah meminjam angka periode lama (galat periode baru = galat, bukan nominal bulan lalu).
// Muat ulang periode yang sama tetap menyimpan data lama + status galat (useLoad).

/** GET spv-dashboard periode ini. Tidak ikut saringan principal/cabang: rate per principal bergantung pada SEMUA principal valid SPV itu. */
export function useInsentifSpv(month: number, year: number): [Load<SpvIncentiveRow[]>, () => void] {
    return useLoad(useCallback(() => muatBaris<SpvIncentiveRow>(`/api/insentif-sales/spv-dashboard?month=${month}&year=${year}`, "SPV")(), [month, year]));
}

/** GET sm-dashboard periode ini. Tidak ikut saringan: strata SM dihitung dari seluruh principal SM itu. */
export function useInsentifSm(month: number, year: number): [Load<SmIncentiveRow[]>, () => void] {
    return useLoad(useCallback(() => muatBaris<SmIncentiveRow>(`/api/insentif-sales/sm-dashboard?month=${month}&year=${year}`, "SM")(), [month, year]));
}
