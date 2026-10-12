/*
 * Tujuan: Layar "Insentif saya" (Fiori S4c, salesman, ponsel dulu): capaian periode berjalan dibanding Time Gone, cara insentif dihitung
 *   (ambang dan bobot dari konstanta server), dan insentif bulan lalu dengan bruto/PPh/netto + status bayar.
 * Caller: app/(dashboard)/insentif-sales/saya/page.tsx (default export, prop permKeys).
 * Dependensi: ./Rangka (InsentifRangka, usePeriode, useDashboard, KonstantaCtx), ./Rincian (Laju, LegendaLaju, CatatanTimeGone, StatusBayar,
 *   itemsPph), ./data (Time Gone, format, MONTH_LABELS), components/fiori/*, lib/insentif-ui.
 * Main Functions: Saya, CapaianBaris, CaraDihitung, BulanLalu.
 * Side Effects: GET /api/insentif-sales/dashboard dua kali (periode berjalan dan bulan sebelumnya).
 *
 * Tertutup secara default (BL-26 untuk layar ini): baris HANYA tampil bila server menautkan akun ke identitas hierarki peran "sales"
 * (cakupan.identitas.role). Akun tanpa tautan — termasuk admin yang hari ini melihat seluruh perusahaan di Dashboard — mendapat pesan
 * "belum ditautkan", tidak pernah data orang lain.
 */
"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { EmptyState, ErrorState, KeyValues, MessageStrip, Section, Skeleton } from "@/components/fiori/core";
import type { Load } from "@/components/fiori/interactive";
import { DEFAULT_KONSTANTA } from "@/lib/insentif-konstanta";
import { halamanTerlihat, sebabNol, formatPctText, formatQty, formatRatio, type ApiRow } from "@/lib/insentif-ui";
import { MONTH_LABELS, formatRp, getPeriodWorkdayProgress, type WorkdayProgress } from "./data";
import { InsentifRangka, KonstantaCtx, useDashboard, useKonstanta, usePeriode, type DashboardData } from "./Rangka";
import { CatatanTimeGone, Laju, LegendaLaju, StatusBayar, itemsPph, labelPph } from "./Rincian";

const SEMUA = { principle: "ALL", branch: "ALL" } as const;

export default function Saya({ permKeys }: { permKeys: string[] }) {
    const { month, year, label, bawa } = usePeriode();
    const lalu = month === 1 ? { month: 12, year: year - 1 } : { month: month - 1, year };
    const labelLalu = `${MONTH_LABELS[lalu.month - 1]} ${lalu.year}`;
    // Seluruh principal/cabang: cakupan baris sudah dibatasi server ke kode sales akun ini.
    const [kini, muatKini] = useDashboard({ month, year, ...SEMUA });
    const [dulu, muatDulu] = useDashboard({ ...lalu, ...SEMUA });
    const perms = useMemo(() => new Set(permKeys), [permKeys]);
    const terlihat = halamanTerlihat(perms);
    const tg = getPeriodWorkdayProgress(year, month);
    const now = new Date();
    const berjalan = year * 12 + month >= now.getFullYear() * 12 + now.getMonth() + 1;
    const d = kini.data;
    const identitas = d?.cakupan.identitas ?? null;
    const sales = identitas?.role === "sales";
    const rows = sales ? d!.rows : [];

    // Hanya bagian periode berjalan yang diganti Kosong/Galat; insentif bulan lalu tetap tampil — justru dibuka saat dibayar, ketika
    // target bulan baru sering belum diunggah. Bulan lalu disembunyikan hanya bila server memastikan akun ini bukan identitas sales.
    let kiniBagian: ReactNode;
    let tampilLalu = true;
    if (!d && kini.status === "galat") {
        kiniBagian = <ErrorState title={kini.error} message="Angka tidak ditampilkan agar tidak terbaca sebagai Rp 0." onRetry={muatKini} />;
    } else if (!d) {
        kiniBagian = <><div className="fi-kc"><Skeleton rows={2} label="Memuat insentif Anda" /></div><Skeleton rows={6} label="Memuat insentif Anda" /></>;
    } else if (!identitas) {
        tampilLalu = false;
        const atur = terlihat.find((h) => h.key === "pengaturan");
        kiniBagian = <EmptyState title="Akun Anda belum ditautkan ke hierarki insentif"
            message="Tidak ada data yang ditampilkan sampai Admin Sales menautkan akun ini ke identitas Sales Anda. Hubungi Admin Sales bila Anda seharusnya melihat insentif."
            action={atur ? <Link className="fi-btn fi-btn--primary" href={`${atur.href}${bawa}`}>Buka Pengaturan</Link> : undefined} />;
    } else if (!sales) {
        tampilLalu = false;
        const dash = terlihat.find((h) => h.key === "dashboard");
        kiniBagian = <EmptyState title="Insentif saya hanya untuk salesman"
            message={`Akun Anda tertaut sebagai ${identitas.role.toUpperCase()} "${identitas.name}". Capaian dan insentif tim Anda ada di Dashboard.`}
            action={dash ? <Link className="fi-btn fi-btn--primary" href={`${dash.href}${bawa}`}>Buka Dashboard</Link> : undefined} />;
    } else if (rows.length === 0) {
        kiniBagian = <EmptyState title={`Belum ada target untuk kode ${identitas.name} di ${label}`} message="Capaian dan insentif tampil setelah target periode ini diunggah." />;
    } else {
        kiniBagian = (
            <>
                <div className="fi-kcards">
                    <div className="fi-kc"><span>Time Gone</span><b>{tg.pct}%</b><small>{tg.passed} dari {tg.total} hari kerja</small></div>
                    {/* Owner 8 Okt: yang sudah mencapai ambang langsung terhitung walau nilainya masih bisa berubah. */}
                    <div className="fi-kc"><span>{berjalan ? "Insentif sementara" : "Insentif"}</span><b>{formatRp(rows.reduce((a, r) => a + r.incentive.total, 0))}</b>
                        <small>{berjalan ? "bila ditutup hari ini · bisa berubah setiap hari sampai akhir bulan" : "bruto, sebelum PPh"}</small></div>
                </div>
                <CatatanTimeGone tg={tg} label={label} />
                <Section title={`Capaian ${label}`} subtitle="dihitung untuk insentif">
                    <div className="fi-sect-in">
                        <LegendaLaju timeGone={tg.pct} />
                        {rows.map((r) => <CapaianBaris key={r.principle} r={r} tg={tg} banyak={rows.length > 1} />)}
                    </div>
                </Section>
                <CaraDihitung rows={rows} />
            </>
        );
    }
    const isi = (
        <div className={d && kini.status === "memuat" ? "fi-busy grid gap-4" : "grid gap-4"} aria-busy={(d && kini.status === "memuat") || undefined}>
            {d && kini.status === "galat" && (
                <MessageStrip tone="neg" title="Gagal memuat ulang.">
                    {kini.error} Yang tampil adalah hasil sebelumnya untuk {label}.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatKini}>Coba lagi</button>
                </MessageStrip>
            )}
            {d?.konstantaSumber === "gagal_baca" && (
                <MessageStrip tone="neg" title="Angka sementara.">
                    Konstanta insentif tersimpan gagal dibaca; nominal di bawah dihitung dengan angka bawaan dan bisa berubah.
                </MessageStrip>
            )}
            {kiniBagian}
            {tampilLalu && <BulanLalu load={dulu} onRetry={muatDulu} label={labelLalu} />}
        </div>
    );

    const deskripsi = sales && rows.length > 0
        ? `${rows[0].salesName} · ${rows[0].salesCode} · ${rows.map((r) => r.principle).join(", ")} · ${label}`
        : `Periode ${label}`;
    return (
        // Konstanta bawaan hanya berlaku sebelum data pertama datang; isi tidak dirender sebelum itu.
        <KonstantaCtx.Provider value={d?.konstanta ?? DEFAULT_KONSTANTA}>
            <InsentifRangka halaman="saya" permKeys={permKeys} saringan={false} deskripsi={deskripsi}>{isi}</InsentifRangka>
        </KonstantaCtx.Provider>
    );
}

/** KPI satu baris (principal): persen yang dinilai untuk insentif + angka asalnya, berwarna laju terhadap Time Gone. */
function CapaianBaris({ r, tg, banyak }: { r: ApiRow; tg: WorkdayProgress; banyak: boolean }) {
    const k = useKonstanta();
    const isMt = r.channel === "MT";
    // AO dinilai terhadap penyebut yang DIPAKAI MEMBAYAR (ambangAo dari server: 240 atau Target AO file), bukan target di file.
    const pctAo = r.ambangAo > 0 ? (r.real.ao / r.ambangAo) * 100 : 0;
    const kpi = (nilai: number, asal: string): ReactNode => <span className="grid justify-items-end gap-1"><Laju nilai={nilai} timeGone={tg.pct} /><span className="fi-sub">{asal}</span></span>;
    const items: Array<[string, ReactNode]> = isMt
        ? [
            [`Value · bobot ${formatRp(k.mt.bobotValue)}`, kpi(r.pct.value, `${formatRp(r.real.value)} dari ${formatRp(r.target.value)}`)],
            [`Effective Call · bobot ${formatRp(k.mt.bobotEc)}`, kpi(r.pct.ec, `${formatQty(r.real.ec)} dari ${formatQty(r.target.ec)}`)],
            [`Aktif Outlet · bobot ${formatRp(k.mt.bobotAo)}`, kpi(pctAo, `${formatQty(r.real.ao)} dari ${formatQty(r.ambangAo)} outlet`)],
            [`Item Aktif per outlet · bobot ${formatRp(k.mt.bobotIa)}`, kpi(r.pct.isq, `${formatRatio(r.real.isq)} dari ${formatRatio(r.target.isq)}`)],
        ]
        : [
            [`Value · bobot ${formatPctText(k.gt.bobotValue * 100)}`, kpi(r.pct.value, `${formatRp(r.real.value)} dari ${formatRp(r.target.value)}`)],
            [`Aktif Outlet · bobot ${formatPctText(k.gt.bobotAo * 100)}`, kpi(pctAo, `${formatQty(r.real.ao)} dari ${formatQty(r.ambangAo)} outlet`)],
            ["Effective Call · dipantau", kpi(r.pct.ec, `${formatQty(r.real.ec)} dari ${formatQty(r.target.ec)}`)],
        ];
    return (
        <div className="grid gap-2">
            {banyak && <h3 className="fi-title-3">{r.principle} · {r.channel}</h3>}
            <KeyValues items={items} />
        </div>
    );
}

/** Syarat insentif dari konstanta yang dipakai server (bukan angka salinan di klien), hanya untuk channel yang dipegang akun ini. */
function CaraDihitung({ rows }: { rows: ApiRow[] }) {
    const k = useKonstanta();
    const p = (v: number) => formatPctText(v * 100);
    const gt = rows.some((r) => r.channel !== "MT");
    const mt = rows.some((r) => r.channel === "MT");
    const butir = [
        ...(gt ? [
            `Jatah ${formatRp(k.gt.pool1)} untuk satu principal; sales mix ${formatRp(k.gt.mix2)}–${formatRp(k.gt.mix5)} menurut jumlah principal. `
            + `Aktif Outlet ${p(k.gt.bobotAo)} + Value ${p(k.gt.bobotValue)}.`,
            `Masing-masing minimal ${p(k.gt.ambangBayar)}: ${p(k.gt.ambangBayar)}–100% dibayar sesuai capaian; di atas 100% dibayar penuh.`,
        ] : []),
        ...(mt ? [
            `MT: Value ${formatRp(k.mt.bobotValue)}, Effective Call ${formatRp(k.mt.bobotEc)}, Aktif Outlet ${formatRp(k.mt.bobotAo)}, Item Aktif ${formatRp(k.mt.bobotIa)}.`,
            `MT: tiap komponen minimal ${p(k.gt.ambangBayar)} (Item Aktif ${p(k.mt.ambangIa)}); di atas 100% dibayar penuh.`,
        ] : []),
        "Support dari principal mengurangi jatah yang dibayar distributor.",
        `Dipotong ${labelPph(k.pph.rate)} sebelum dibayar.`,
    ];
    return (
        <Section title="Cara insentif Anda dihitung">
            <div className="fi-sect-in">
                <ul className="fi-chkl">{butir.map((t) => <li key={t} data-ok="true"><Check className="fi-icon" aria-hidden /><span>{t}</span></li>)}</ul>
            </div>
        </Section>
    );
}

/** Insentif bulan sebelumnya per principal: bruto → PPh → netto + status bayar. Galat tidak pernah tampil sebagai Rp 0. */
function BulanLalu({ load, onRetry, label }: { load: Load<DashboardData>; onRetry: () => void; label: string }) {
    const kKini = useKonstanta();
    const d = load.data;
    const k = d?.konstanta ?? kKini; // konstanta yang dipakai server saat menghitung periode itu
    if (d && d.cakupan.identitas?.role !== "sales") return null; // bukan identitas sales: tidak ada data siapa pun
    const rows = d?.rows ?? [];
    const dibayar = rows.filter((r) => r.incentive.total > 0);
    const lunas = dibayar.length > 0 && dibayar.every((r) => r.paymentStatus === "lunas");
    let isi: ReactNode;
    if (!d && load.status !== "galat") isi = <Skeleton rows={4} label={`Memuat insentif ${label}`} />;
    else if (!d) isi = <ErrorState title={`Insentif ${label} belum berhasil dimuat`} message="Angka tidak ditampilkan agar tidak terbaca sebagai Rp 0." onRetry={onRetry} />;
    else if (rows.length === 0) isi = <EmptyState title={`Tidak ada insentif tercatat untuk ${label}`} message="Periode itu tidak punya target untuk kode Anda." />;
    else isi = (
        <div className="fi-sect-in">
            {lunas && <MessageStrip tone="pos" title={`Insentif ${label} sudah dibayar.`}>Status di bawah dicatat Finance.</MessageStrip>}
            {rows.map((r) => {
                const sebab = sebabNol(r, k);
                return (
                    <div key={r.principle} className="grid gap-2">
                        {rows.length > 1 && <h3 className="fi-title-3">{r.principle}</h3>}
                        <KeyValues items={[
                            ["Bruto", <span key="b">{formatRp(r.incentive.total)}{sebab && <span className="fi-sub">{sebab}</span>}</span>],
                            ...itemsPph(r.incentive.total, k),
                            ["Status", r.incentive.total > 0 || r.paymentStatus !== "belum" ? <StatusBayar status={r.paymentStatus} /> : <span className="fi-subtle">—</span>],
                        ]} />
                    </div>
                );
            })}
        </div>
    );
    return <Section title={`Insentif ${label}`} subtitle={!d ? undefined : lunas ? "dibayar" : dibayar.length ? "menunggu Finance" : undefined}>{isi}</Section>;
}
