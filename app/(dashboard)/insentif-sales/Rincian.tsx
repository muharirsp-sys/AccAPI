/*
 * Tujuan: Bagian tampilan bersama Insentif Sales (Fiori S4c): warna laju (warna + ikon + teks + legenda), kolom PPh (bruto → PPh → netto
 *   dari konstanta server), rincian per baris Sales/SPV/SM, status bayar, dan pemuat insentif SPV/SM.
 * Caller: Dashboard.tsx, Saya.tsx, Pembayaran.tsx.
 * Dependensi: components/fiori/{core,interactive}, lib/insentif-ui, lib/insentif-pph, lib/insentif-konstanta (tipe), lib/rekapan-nota/ui (ambil),
 *   ./data (formatRp, paceStatus), ./Rangka (useKonstanta).
 * Main Functions: Laju, LegendaLaju, CatatanTimeGone, KeteranganTimeGone, StatusBayar, labelPph, kolomPph, kakiPph, itemsPph, SalesBreakdown, SpvBreakdown, SmBreakdown, strataSm,
 *   sebabNolSpv, sebabNolSm, useInsentifSpv, useInsentifSm.
 * Side Effects: GET /api/insentif-sales/spv-dashboard dan /sm-dashboard (useInsentifSpv/useInsentifSm); lainnya murni tampilan.
 *
 * Cara memakai: bungkus layar dengan <KonstantaCtx.Provider> (rincian dan PPh membaca konstanta server); kolom PPh = `...kolomPph(k, bruto)`,
 * baris total = `foot={{ label, cells: { total, ...kakiPph(k, grand) } }}`; tabel dengan rincian = <ResponsiveTable rincian={{ isi, nama }} foot={…}/>
 * (audit desain 001 No 135: salinan TabelRincian dihapus). Data SPV/SM lewat useInsentifSpv/useInsentifSm; galat tidak pernah jadi daftar kosong.
 */
"use client";

import { useCallback, type ReactNode } from "react";
import { Check, Clock, TriangleAlert } from "lucide-react";
import { KeyValues, StatusBadge, VariantNote, type Column, type Tone } from "@/components/fiori/core";
import { useLoad, type Load } from "@/components/fiori/interactive";
import { ambil } from "@/lib/rekapan-nota/ui";
import { nettoInsentif, pphInsentif } from "@/lib/insentif-pph";
import type { Konstanta } from "@/lib/insentif-konstanta";
import { formatPctText, formatQty, formatRatio, labelStatus, labelTipe, type ApiRow } from "@/lib/insentif-ui";
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
            <span>Warna = capaian dibanding waktu berjalan (Time Gone) {timeGone}%:</span>
            {(["green", "yellow", "red"] as const).map((lvl) => {
                const l = LAJU[lvl];
                return <span key={lvl} className="fi-badge" data-tone={l.tone}><l.Icon className="fi-icon" aria-hidden />{l.teks} ({l.rentang})</span>;
            })}
        </div>
    );
}

/** Time Gone hari ini = data.getPeriodWorkdayProgress (Senin sampai Jumat, tanpa libur nasional); usulan Senin sampai Sabtu belum masuk. */
export function CatatanTimeGone({ tg, label }: { tg: WorkdayProgress; label: string }) {
    return (
        <VariantNote bl="BL-48">
            Time Gone {label}: {tg.passed} dari {tg.total} hari kerja ({tg.pct}%), dihitung Senin sampai Jumat tanpa libur nasional. Usulan: Sabtu ikut
            dihitung dan libur nasional dikecualikan; persen Time Gone dan warna laju akan bergeser.
        </VariantNote>
    );
}

/** Keterangan Time Gone untuk layar salesman: fakta hari ini saja, tanpa catatan usulan (audit desain 001 No 80). */
export function KeteranganTimeGone({ tg, label }: { tg: WorkdayProgress; label: string }) {
    return <p className="fi-small fi-muted">Time Gone {label}: {tg.passed} dari {tg.total} hari kerja ({tg.pct}%), dihitung Senin sampai Jumat tanpa libur nasional.</p>;
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

/** Dua kolom berpasangan (PPh, Netto dibayar) untuk ResponsiveTable; key "pph" dan "netto". */
export function kolomPph<T>(k: Konstanta, bruto: (row: T) => number): Column<T>[] {
    return [
        {
            key: "pph", header: labelPph(k.pph.rate), align: "end", secondary: true,
            cell: (row) => { const b = bruto(row); return <span className="fi-tnum">{b > 0 ? `-${formatRp(pphInsentif(b, k.pph.rate))}` : formatRp(0)}</span>; },
        },
        { key: "netto", header: "Netto dibayar", align: "end", cell: (row) => <b className="fi-tnum">{formatRp(nettoInsentif(bruto(row), k.pph.rate))}</b> },
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

    // MT membayar 4 KPI bernominal tetap, GT/TT 2 (Value + AO berbobot): komponen harus menjumlah ke total baris itu.
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

    // Sales "mix": Value dinilai dari GABUNGAN principal yang ikut skema lalu dibagi menurut porsi target; angka gabungan menjelaskan nominalnya.
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
            <Grup title="Effective Call (EC) dan Item Aktif per outlet (ISQ)" items={[
                ["Target EC", formatQty(r.target.ec)],
                ["Realisasi EC", formatQty(r.real.ec)],
                ["Pencapaian EC", formatPctText(r.pct.ec)],
                ["Target ISQ", formatRatio(r.target.isq)],
                ["Realisasi ISQ", formatRatio(r.real.isq)],
                ["Pencapaian ISQ", formatPctText(r.pct.isq)],
            ]} />
            <Grup title="Dasar perhitungan" items={[
                ["Tipe sales", redup(labelTipe(r.tipeSales))],
                ["Status insentif", redup(labelStatus(r.statusInsentif))],
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

// ── Pemuat insentif SPV/SM ──────────────────────────────────────────────────
// Dulu galat endpoint ini tampil sebagai "Belum ada data SPV…" (res.ok ? rows : []) — sekarang galat tetap galat (#9).
// Konstanta tersimpan tak terbaca (konstantaSumber "gagal_baca"): angka SPV/SM dihitung dari BAWAAN — diperlakukan galat, bukan
// nominal yang tampil seperti biasa (galat ≠ angka), sehingga Taksiran menyebutnya dan Pembayaran mengunci penandaan.
function muatBaris<T>(url: string, apa: string) {
    return async (): Promise<Load<T[]>> => {
        const r = await ambil(url, (j) => {
            if ((j as { konstantaSumber?: string }).konstantaSumber === "gagal_baca") throw new Error("konstanta insentif tersimpan gagal dibaca; angka bawaan tidak ditampilkan");
            return (j as { rows?: T[] }).rows ?? [];
        });
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
