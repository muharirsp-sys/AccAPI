/*
 * Tujuan: Layar "Dashboard" Insentif Sales (Fiori S4c, Overview Page it07): Time Gone, kartu ringkasan (Taksiran = sales + SPV + SM),
 *   capaian per SPV (bullet capaian vs Time Gone, diurut dari yang paling tertinggal, selisih dari laju) dengan warna laju, dan insentif
 *   tim (sales, SPV, SM) dengan alasan Rp 0 dan rincian per baris. Hanya memantau: input support pindah ke halaman Support principal.
 * Caller: app/(dashboard)/insentif-sales/page.tsx (default export, prop permKeys).
 * Dependensi: ./Rangka (InsentifRangka, usePeriode, useDashboard, KonstantaCtx), ./Rincian (laju, bullet laju, PPh, rincian, pemuat SPV/SM),
 *   ./data (Time Gone, format), components/fiori/* (chart: skalaBullet), lib/insentif-ui.
 * Main Functions: Dashboard, Ringkasan, CapaianSpv, InsentifSales, InsentifSpv, InsentifSm.
 * Side Effects: GET /api/insentif-sales/dashboard, /spv-dashboard, /sm-dashboard; router.replace saat saringan SM berubah.
 */
"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { skalaBullet } from "@/components/fiori/chart";
import { Button, EmptyState, ErrorState, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, type Column } from "@/components/fiori/core";
import { FormField, type Load } from "@/components/fiori/interactive";
import { DEFAULT_KONSTANTA, type Konstanta } from "@/lib/insentif-konstanta";
import { HALAMAN, halamanTerlihat, sebabNol, formatPctText, formatQty, formatRatio, type ApiRow } from "@/lib/insentif-ui";
import { bulanIniWita, formatRp, formatShortRp, getPeriodWorkdayProgress, itemSuper, pct, type WorkdayProgress } from "./data";
import { KOSONG } from "@/lib/tampil";
import { InsentifRangka, KonstantaCtx, useDashboard, useKonstanta, usePeriode, type DashboardData } from "./Rangka";
import {
    CatatanTimeGone, Laju, LajuBatang, LegendaLaju, SalesBreakdown, SmBreakdown, SpvBreakdown, StatusBayar, capaianSm, kakiPph, kolomPph,
    sebabNolSm, sebabNolSpv, strataSm, useInsentifSm, useInsentifSpv, type SmIncentiveRow, type SpvIncentiveRow,
} from "./Rincian";

const jumlah = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);

export default function Dashboard({ permKeys }: { permKeys: string[] }) {
    const { month, year, principle, branch, sm, ubah, bawa, label } = usePeriode();
    const [dash, muatDash] = useDashboard({ month, year, principle, branch });
    // SPV & SM ikut dibayar dari periode yang sama, jadi tampil di sini — dimuat sendiri dan TIDAK ikut saringan (lihat InsentifSpv/Sm).
    const [spv, muatSpv] = useInsentifSpv(month, year);
    const [smLoad, muatSm] = useInsentifSm(month, year);
    const perms = useMemo(() => new Set(permKeys), [permKeys]);
    // Target belum diunggah → aksi kosong menautkan ke Data periode, hanya bila akun boleh membukanya.
    const hrefData = halamanTerlihat(perms).some((h) => h.key === "data") ? `${HALAMAN.find((h) => h.key === "data")!.href}${bawa}` : undefined;
    const d = dash.data;
    const rows = useMemo(() => d?.rows ?? [], [d]);
    // Filter SM disaring di klien, bukan lewat server seperti principle/cabang: nominal tiap baris sudah dihitung server dengan konteks
    // grup penuh, jadi menyaring daftarnya tidak menggeser angka siapa pun (bandingkan `groupTargets` di route dashboard).
    const rowsSm = useMemo(() => (sm === "ALL" ? rows : rows.filter((r) => (r.smName ?? "") === sm)), [rows, sm]);
    const tg = getPeriodWorkdayProgress(year, month);
    const opsi = d?.opsiFilter ?? { principles: [], branches: [], sm: [] };
    // Pilihan dari URL tetap ada di daftar walau data belum datang, supaya select tidak diam-diam menampilkan "Semua".
    const dengan = (xs: string[], v: string) => (v === "ALL" || xs.includes(v) ? xs : [...xs, v]);
    // Muat ulang dashboard = muat ulang tabel SPV/SM juga: tanpa ini tabel itu menampilkan nominal lama sampai halaman di-refresh.
    const muatSemua = () => { muatDash(); muatSpv(); muatSm(); };
    const cakupan = d?.cakupan;
    const deskripsi = cakupan?.dibatasi
        ? `Hanya tim Anda yang terlihat: ${cakupan.identitas?.role?.toUpperCase() ?? "-"} "${cakupan.identitas?.name ?? "belum diisi"}" · ${cakupan.jumlahKode ?? 0} kode sales.`
        : "Capaian dan insentif tim per periode, dihitung server.";

    // Galat diperiksa SEBELUM kosong: periode kosong yang gagal dimuat ulang tidak boleh terbaca "belum ada data" tanpa tanda.
    // `d` selalu milik periode/saringan yang sedang dibuka (useDashboard tidak meminjam data kueri lain); galat muat ulang kueri yang
    // sama = data lama + strip yang menyebut periodenya.
    const stripGalat = d && dash.status === "galat" && (
        <MessageStrip tone="neg" title="Gagal memuat ulang.">
            {dash.error} Yang tampil adalah hasil sebelumnya untuk {label}.{" "}
            <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatDash}>Coba lagi</button>
        </MessageStrip>
    );
    // Konstanta tersimpan tak terbaca: server menghitung dengan BAWAAN (konstantaSumber "gagal_baca") — angka tampil, berlabel sementara.
    const stripSementara = d?.konstantaSumber === "gagal_baca" && (
        <MessageStrip tone="neg" title="Angka sementara.">
            Konstanta insentif tersimpan gagal dibaca; nominal di halaman ini dihitung dengan angka bawaan dan bisa berubah setelah Pengaturan
            terbaca. Jangan dipakai untuk membayar.
        </MessageStrip>
    );
    let isi: ReactNode;
    if (!d && dash.status === "galat") {
        isi = <ErrorState title={dash.error} message="Data kosong tidak ditampilkan karena server belum memberikan hasil yang valid." onRetry={muatDash} />;
    } else if (!d) {
        isi = (
            <>
                <div className="fi-kcards">{[0, 1, 2, 3].map((i) => <div key={i} className="fi-kc"><Skeleton rows={2} label="Memuat data insentif" /></div>)}</div>
                <Skeleton rows={6} label="Memuat data insentif" />
            </>
        );
    } else if (rows.length === 0) {
        isi = (
            <>
                {stripGalat}
                {stripSementara}
                <Kosong d={d} label={label} saringanAktif={principle !== "ALL" || branch !== "ALL"} hrefData={hrefData} reset={() => ubah({ principle: "ALL", branch: "ALL", sm: "ALL" })} />
            </>
        );
    } else {
        isi = (
            <div className={dash.status === "memuat" ? "fi-busy grid gap-4" : "grid gap-4"} aria-busy={dash.status === "memuat" || undefined}>
                {stripGalat}
                {stripSementara}
                <Ringkasan rows={rowsSm} tg={tg} label={label} spv={spv} sm={smLoad} month={month} year={year} saringanAktif={principle !== "ALL" || branch !== "ALL" || sm !== "ALL"} />
                <CapaianSpv rows={rowsSm} tg={tg} />
                <InsentifSales rows={rowsSm} total={rows.length} smAktif={sm} hapusSm={() => ubah({ sm: "ALL" })} />
                {/* SPV: rate per principal bergantung pada jumlah principal valid yang ia tangani, jadi tabel ini tidak ikut disaring. */}
                <InsentifSpv load={spv} onRetry={muatSpv} label={label} />
                {/* SM: stratanya dihitung dari seluruh principal SM itu, menyaringnya akan memajang nominal yang tidak dibayar. */}
                <InsentifSm load={smLoad} onRetry={muatSm} label={label} />
            </div>
        );
    }

    return (
        // Konstanta bawaan hanya berlaku sebelum data pertama datang; rincian tidak dirender sebelum itu.
        <KonstantaCtx.Provider value={d?.konstanta ?? DEFAULT_KONSTANTA}>
            <InsentifRangka
                halaman="dashboard"
                permKeys={permKeys}
                deskripsi={deskripsi}
                saringan={{ principals: dengan(opsi.principles, principle), branches: dengan(opsi.branches, branch) }}
                saringanLain={
                    <FormField label="SM">{(a) => (
                        <select {...a} className="fi-input" value={sm} onChange={(e) => ubah({ sm: e.target.value })}>
                            <option value="ALL">Semua SM ({opsi.sm.length})</option>
                            {dengan(opsi.sm, sm).map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                    )}</FormField>
                }
                aksi={<Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={dash.status === "memuat" && Boolean(d)} onClick={muatSemua}>Muat ulang</Button>}
            >
                {isi}
            </InsentifRangka>
        </KonstantaCtx.Provider>
    );
}


/** Kenapa tidak ada baris: bukan cakupan Anda ≠ target belum diunggah ≠ tidak cocok saringan ≠ belum ada data. */
function Kosong({ d, label, saringanAktif, hrefData, reset }: { d: DashboardData; label: string; saringanAktif: boolean; hrefData?: string; reset: () => void }) {
    const { cakupan, progressFeed } = d;
    // Tabel kosong karena "bukan cakupan Anda" dulu terlihat persis sama dengan "target belum diunggah". Nama identitas disebutkan karena
    // penyebab paling sering adalah bedanya penulisan nama ("Marten" vs "MARTEN").
    if (cakupan.dibatasi && !cakupan.identitas) {
        // BL-26: tanpa tautan hierarki server memberi cakupan kosong (dulu: seluruh perusahaan).
        return <EmptyState title="Akun Anda belum ditautkan ke hierarki insentif"
            message="Minta Admin menautkan akun Anda di Kelola Hierarki. Sampai itu, data insentif siapa pun tidak ditampilkan." />;
    }
    if (cakupan.dibatasi && !cakupan.jumlahKode) {
        return <EmptyState title="Belum ada salesman dalam cakupan Anda"
            message={`Identitas hierarki Anda: ${cakupan.identitas?.role?.toUpperCase() ?? "-"} "${cakupan.identitas?.name ?? "belum diisi"}". Tidak ada kode sales yang cocok untuk periode ini. Pastikan penulisannya sama persis dengan kolom SPV/SM di file target.`} />;
    }
    const keData = hrefData ? <Link className="fi-btn fi-btn--primary" href={hrefData}>Buka Data periode</Link> : undefined;
    if (progressFeed?.progressKeys && !progressFeed.targetKeys) {
        return <EmptyState title="Target periode ini belum diunggah"
            message={`${progressFeed.progressKeys.toLocaleString("id-ID")} kombinasi pencapaian sudah diterima. Unggah target agar performa dan insentif dapat dihitung.`}
            action={keData} />;
    }
    if (saringanAktif) {
        return <EmptyState title="Tidak ada data untuk saringan ini" message="Ubah principal atau cabang, lalu periksa kembali hasilnya."
            action={<Button onClick={reset}>Hapus saringan</Button>} />;
    }
    return <EmptyState title={`Belum ada data insentif ${label}`} message="Target periode ini belum diunggah atau belum ada penjualan yang cocok dengan target." action={keData} />;
}

function Ringkasan({ rows, tg, label, spv, sm, month, year, saringanAktif }: {
    rows: ApiRow[]; tg: WorkdayProgress; label: string; spv: Load<SpvIncentiveRow[]>; sm: Load<SmIncentiveRow[]>; month: number; year: number; saringanAktif: boolean;
}) {
    const k = useKonstanta();
    const totalReal = jumlah(rows, (r) => r.real.value);
    const totalTarget = jumlah(rows, (r) => r.target.value);
    const capaian = pct(totalReal, totalTarget);
    const kini = bulanIniWita();
    const berjalan = year * 12 + month >= kini.year * 12 + kini.month;
    // Taksiran = sales + SPV + SM (#5). Setiap sumber milik periode yang sama (pemuat tidak meminjam data periode lain). Sumber yang
    // galat — juga bila tabelnya masih menampilkan hasil sebelumnya — TIDAK dijumlah dan disebut, tidak pernah diam-diam jadi Rp 0.
    const sumber = (nama: string, load: Load<Array<{ total: number }>>) => ({
        nama, keadaan: load.status, nilai: load.status !== "galat" && load.data ? jumlah(load.data, (r) => r.total) : undefined,
    });
    const bagian = [{ nama: "Sales", keadaan: "siap", nilai: jumlah(rows, (r) => r.incentive.total) as number | undefined }, sumber("SPV", spv), sumber("SM", sm)];
    const taksiran = jumlah(bagian, (b) => b.nilai ?? 0);
    const gagal = bagian.filter((b) => b.keadaan === "galat").map((b) => b.nama);
    const memuat = bagian.filter((b) => b.nilai === undefined && b.keadaan !== "galat").map((b) => b.nama);
    const rincianTaksiran = [
        ...bagian.filter((b) => b.nilai !== undefined).map((b) => `${b.nama} ${formatShortRp(b.nilai!)}`),
        ...(memuat.length ? [`${memuat.join("/")} memuat…`] : []),
        ...(gagal.length ? [`${gagal.join("/")} gagal dimuat; angka tidak lengkap`] : []),
    ].join(" · ");
    return (
        <>
            <div className="fi-kcards">
                <div className="fi-kc"><span>Waktu berjalan (Time Gone)</span><b>{tg.pct}%</b><small>{tg.passed} dari {tg.total} hari kerja</small></div>
                <div className="fi-kc"><span>Realisasi</span><b>{formatShortRp(totalReal)}</b><small>dari target {formatShortRp(totalTarget)} · {rows.length} baris</small></div>
                <div className="fi-kc"><span>Capaian</span><b>{formatPctText(capaian)}</b><small><Laju nilai={capaian} timeGone={tg.pct} teks /></small></div>
                <div className="fi-kc" data-tone={gagal.length ? "warn" : undefined}>
                    <span>{berjalan ? "Taksiran bila ditutup hari ini" : "Taksiran insentif"}</span>
                    <b>{formatShortRp(taksiran)}</b>
                    <small>
                        {rincianTaksiran}
                        {saringanAktif && " · SPV dan SM tanpa saringan"}
                    </small>
                </div>
            </div>
            <CatatanTimeGone tg={tg} label={label} />
            {berjalan && (
                <MessageStrip tone="info" title="Periode berjalan: nilai sementara.">
                    Insentif sudah dihitung bagi yang mencapai ambang (sales minimal {formatPctText(k.gt.ambangBayar * 100)} per komponen, SPV{" "}
                    {formatPctText(k.spv.ambang * 100)} per principal, SM {formatPctText(k.sm.ambang1 * 100)} total); nilainya bisa berubah setiap hari
                    sampai akhir bulan.
                </MessageStrip>
            )}
        </>
    );
}

type GrupSpv = { spv: string; n: number; rv: number; tv: number; cap: number; aoTtReal: number; aoTtTarget: number; avgAo: number; iaTt: number; iaMt: number };

/** Selisih capaian dari Time Gone dalam poin persen, satu desimal ("+5,0 poin", "−21,5 poin"). */
const poinLaju = (d: number) => {
    const r = Math.round(d * 10) / 10;
    return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} poin`;
};

/** Agregat per SPV, diurut dari capaian Value terendah (= paling tertinggal dari Time Gone yang sama untuk semua baris). */
function grupSpv(rows: ApiRow[]): GrupSpv[] {
    const map = new Map<string, ApiRow[]>();
    for (const r of rows) { const key = r.spvName ?? ""; map.set(key, [...(map.get(key) ?? []), r]); }
    return [...map.entries()].map(([spv, list]) => {
        const tt = list.filter((r) => r.channel === "TT" || r.channel === "GT");
        const mt = list.filter((r) => r.channel === "MT");
        // 1 salesman bisa banyak baris (per principle) → hitung salesCode unik untuk angka per-sales; membagi dengan jumlah baris
        // memberi angka 3x lebih kecil untuk populasi yang sama, di bawah label yang sama (M12).
        const n = new Set(list.map((r) => r.salesCode)).size;
        const rv = jumlah(list, (r) => r.real.value), tv = jumlah(list, (r) => r.target.value);
        return {
            spv, n, rv, tv, cap: pct(rv, tv),
            aoTtReal: jumlah(tt, (r) => r.real.ao), aoTtTarget: jumlah(tt, (r) => r.target.ao),
            avgAo: n ? Math.round(jumlah(list, (r) => r.real.ao) / n) : 0,
            // IA per OUTLET (itemSuper), bukan total dibagi jumlah baris. Kolom lama menampilkan ~1.200 sementara angka yang dipakai
            // membayar 10,4 — pola yang sama dengan ISQ 6.103% (audit 2026-08-28, M12).
            iaTt: itemSuper(jumlah(tt, (r) => r.real.ia), jumlah(tt, (r) => r.real.ao)),
            iaMt: itemSuper(jumlah(mt, (r) => r.real.ia), jumlah(mt, (r) => r.real.ao)),
        };
    }).sort((a, b) => a.cap - b.cap);
}

/** Capaian per SPV dari baris dashboard (ikut saringan), warna laju terhadap Time Gone. */
function CapaianSpv({ rows, tg }: { rows: ApiRow[]; tg: WorkdayProgress }) {
    const grup = useMemo(() => grupSpv(rows), [rows]);
    // Satu skala untuk semua baris: penanda Time Gone harus sejajar supaya jarak tiap SPV darinya bisa dibandingkan.
    const skala = skalaBullet([...grup.map((g) => g.cap), tg.pct]);
    const nama = (g: GrupSpv) => g.spv || "(tanpa SPV)";
    const kolom: Column<GrupSpv>[] = [
        { key: "spv", header: "SPV", cell: (g) => <><b>{nama(g)}</b><span className="fi-sub">{g.n} salesman</span></> },
        { key: "target", header: "Target", align: "end", secondary: true, cell: (g) => <span className="fi-tnum">{formatShortRp(g.tv)}</span> },
        { key: "real", header: "Realisasi", align: "end", cell: (g) => <span className="fi-tnum">{formatShortRp(g.rv)}</span> },
        { key: "capaian", header: "Capaian", cell: (g) => <LajuBatang nilai={g.cap} timeGone={tg.pct} skala={skala} /> },
        { key: "selisih", header: "Selisih dari laju", align: "end", secondary: true, cell: (g) => <span className="fi-tnum">{poinLaju(g.cap - tg.pct)}</span> },
        { key: "aott", header: "Aktif Outlet TT", cell: (g) => <Laju nilai={pct(g.aoTtReal, g.aoTtTarget)} timeGone={tg.pct} /> },
        { key: "avgao", header: "Rata-rata Aktif Outlet per sales", align: "end", secondary: true, cell: (g) => <span className="fi-tnum">{formatQty(g.avgAo)}</span> },
        { key: "iatt", header: "Item Aktif per toko TT", align: "end", secondary: true, cell: (g) => <span className="fi-tnum">{formatRatio(g.iaTt)}</span> },
        { key: "iamt", header: "Item Aktif per toko MT", align: "end", secondary: true, cell: (g) => <span className="fi-tnum">{formatRatio(g.iaMt)}</span> },
    ];
    return (
        <Section title="Capaian per SPV" subtitle={`${grup.length} SPV · agregat tim per supervisor · diurut dari yang paling tertinggal`}>
            <div className="fi-sect-in">
                <LegendaLaju timeGone={tg.pct} />
                <p className="fi-small fi-muted">Batang = capaian Value; garis tebal = Time Gone {tg.pct}%; garis tipis = 100% target.</p>
            </div>
            <ResponsiveTable<GrupSpv> title="Capaian per SPV" columns={kolom} rows={grup} rowKey={(g) => g.spv}
                empty={{ title: "Tidak ada baris untuk SM ini", message: "Pilih SM lain atau hapus saringan SM." }}
                mobileItem={(g) => <ListItem doc={nama(g)} amount={<Laju nilai={g.cap} timeGone={tg.pct} />}
                    title={<>{formatShortRp(g.rv)} dari {formatShortRp(g.tv)}<LajuBatang nilai={g.cap} timeGone={tg.pct} skala={skala} badge={false} /></>}
                    meta={`${g.n} salesman · ${poinLaju(g.cap - tg.pct)} dari laju · Aktif Outlet TT ${formatPctText(pct(g.aoTtReal, g.aoTtTarget))}`} />} />
        </Section>
    );
}

function skemaSales(k: Konstanta) {
    return `GT/TT: Value ${formatPctText(k.gt.bobotValue * 100)} + Aktif Outlet ${formatPctText(k.gt.bobotAo * 100)} dari jatah. `
        + `MT: Value ${formatShortRp(k.mt.bobotValue)}, EC ${formatShortRp(k.mt.bobotEc)}, Aktif Outlet ${formatShortRp(k.mt.bobotAo)}, Item Aktif ${formatShortRp(k.mt.bobotIa)}. `
        + `Setiap Rp 0 menyebut sebabnya; buka Rincian untuk komponennya.`;
}

function InsentifSales({ rows, total, smAktif, hapusSm }: { rows: ApiRow[]; total: number; smAktif: string; hapusSm: () => void }) {
    const k = useKonstanta();
    const grand = jumlah(rows, (r) => r.incentive.total);
    const kolom: Column<ApiRow>[] = [
        { key: "nama", header: "Penerima", cell: (r) => <><b>{r.salesName}</b><span className="fi-sub"><span className="fi-mono">{r.salesCode}</span> · {r.principle}</span></> },
        { key: "channel", header: "Channel", secondary: true, cell: (r) => r.channel },
        { key: "capaian", header: "Capaian", align: "end", cell: (r) => <span className="fi-tnum">{formatPctText(r.pct.value)}</span> },
        {
            key: "total", header: "Insentif", align: "end", cell: (r) => {
                const sebab = sebabNol(r, k);
                return <><b className="fi-tnum">{formatRp(r.incentive.total)}</b>{sebab && <span className="fi-sub">{sebab}</span>}</>;
            },
        },
        ...kolomPph<ApiRow>(k, (r) => r.incentive.total),
        { key: "status", header: "Status", cell: (r) => (r.incentive.total > 0 || r.paymentStatus !== "belum" ? <StatusBayar status={r.paymentStatus} /> : <span className="fi-subtle">{KOSONG}</span>) },
    ];
    return (
        <Section title="Insentif sales" subtitle={skemaSales(k)}>
            <ResponsiveTable<ApiRow> title="Insentif sales" columns={kolom} rows={rows}
                rowKey={(r) => `${r.salesCode}|${r.principle}`}
                rincian={{ isi: (r) => <SalesBreakdown r={r} semuaBaris={rows} />, nama: (r) => `${r.salesName} ${r.principle}` }}
                empty={{ title: "Tidak ada baris untuk SM ini", message: `${total} baris lain tersembunyi oleh saringan SM.`, action: <Button onClick={hapusSm}>Hapus saringan SM</Button> }}
                foot={{ label: smAktif === "ALL" ? "Total" : `Total ${rows.length} dari ${total} baris`, cells: { total: <b>{formatRp(grand)}</b>, ...kakiPph(k, grand) } }}
                mobileItem={(r) => <ListItem doc={r.salesCode} amount={formatRp(r.incentive.total)} title={`${r.salesName} · ${r.principle}`}
                    meta={sebabNol(r, k) ?? `Capaian ${formatPctText(r.pct.value)} · ${r.channel}`}
                    badge={r.incentive.total > 0 || r.paymentStatus !== "belum" ? <StatusBayar status={r.paymentStatus} /> : undefined} />} />
        </Section>
    );
}

function InsentifSpv({ load, onRetry, label }: { load: Load<SpvIncentiveRow[]>; onRetry: () => void; label: string }) {
    const k = useKonstanta();
    const rows = load.data ?? [];
    const grand = jumlah(rows, (r) => r.total);
    const kolom: Column<SpvIncentiveRow>[] = [
        { key: "nama", header: "SPV", cell: (r) => <b>{r.spvName}</b> },
        { key: "jumlah", header: "Principal valid", align: "end", secondary: true, cell: (r) => r.jumlahValid },
        { key: "rate", header: "Rate/principal", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{formatRp(r.ratePerPrincipal)}</span> },
        {
            key: "total", header: "Insentif", align: "end", cell: (r) => {
                const sebab = sebabNolSpv(r, k);
                return <><b>{formatRp(r.total)}</b>{sebab && <span className="fi-sub">{sebab}</span>}</>;
            },
        },
        ...kolomPph<SpvIncentiveRow>(k, (r) => r.total),
    ];
    return (
        <Section title="Insentif SPV" subtitle={`Berbasis Value, tanpa saringan; principal dibayar bila pencapaiannya ${formatPctText(k.spv.ambang * 100)} atau lebih.`}>
            <div className="fi-sect-in"><p className="fi-small fi-muted">Di bawah ambang Rp 0. Rate per principal mengikuti jumlah principal valid yang ditangani SPV.</p></div>
            <ResponsiveTable<SpvIncentiveRow> title="Insentif SPV" columns={kolom} rows={rows} rowKey={(r) => r.spvName}
                status={load.status} error={load.error} onRetry={onRetry}
                rincian={{ isi: (r) => <SpvBreakdown rincian={r.rincian} />, nama: (r) => r.spvName }}
                empty={{ title: `Belum ada insentif SPV ${label}`, message: "Belum ada baris target dengan SPV di periode ini." }}
                foot={{ label: "Total", cells: { total: <b>{formatRp(grand)}</b>, ...kakiPph(k, grand) } }}
                mobileItem={(r) => <ListItem doc={r.spvName} amount={formatRp(r.total)} title={`${r.jumlahValid} principal valid · rate ${formatRp(r.ratePerPrincipal)}`}
                    meta={sebabNolSpv(r, k) ?? undefined} />} />
        </Section>
    );
}

function InsentifSm({ load, onRetry, label }: { load: Load<SmIncentiveRow[]>; onRetry: () => void; label: string }) {
    const k = useKonstanta();
    const rows = load.data ?? [];
    const grand = jumlah(rows, (r) => r.total);
    const strata = strataSm(k).filter((s) => s.nominal > 0).reverse().map((s) => `${s.label} ${formatShortRp(s.nominal)}`).join(" · ");
    const kolom: Column<SmIncentiveRow>[] = [
        { key: "nama", header: "SM", cell: (r) => <><b>{r.smName}</b><span className="fi-sub">{r.jumlahBaris} baris sales{!r.berhak && " · tidak ikut skema insentif SM"}</span></> },
        { key: "target", header: "Target Value", align: "end", secondary: true, cell: (r) => formatRp(r.targetValue) },
        { key: "real", header: "Realisasi Value", align: "end", secondary: true, cell: (r) => formatRp(r.realisasiValue) },
        { key: "capaian", header: "Capaian", align: "end", cell: (r) => formatPctText(capaianSm(r)) },
        {
            key: "total", header: "Insentif", align: "end", cell: (r) => {
                const sebab = sebabNolSm(r, k);
                return <><b>{formatRp(r.total)}</b>{sebab && <span className="fi-sub">{sebab}</span>}</>;
            },
        },
        ...kolomPph<SmIncentiveRow>(k, (r) => r.total),
    ];
    return (
        <Section title="Insentif SM" subtitle={`Strata flat berbasis Value, tanpa saringan: ${strata}.`}>
            <div className="fi-sect-in"><p className="fi-small fi-muted">Di bawah strata terendah Rp 0. Hanya SM yang terdaftar di Pengaturan yang ikut skema.</p></div>
            <ResponsiveTable<SmIncentiveRow> title="Insentif SM" columns={kolom} rows={rows} rowKey={(r) => r.smName}
                status={load.status} error={load.error} onRetry={onRetry}
                rincian={{ isi: (r) => <SmBreakdown r={r} />, nama: (r) => r.smName }}
                empty={{ title: `Belum ada insentif SM ${label}`, message: "Belum ada baris target dengan SM di periode ini." }}
                foot={{ label: "Total", cells: { total: <b>{formatRp(grand)}</b>, ...kakiPph(k, grand) } }}
                mobileItem={(r) => <ListItem doc={r.smName} amount={formatRp(r.total)} title={`Capaian ${formatPctText(capaianSm(r))} · ${r.jumlahBaris} baris sales`}
                    meta={sebabNolSm(r, k) ?? undefined} />} />
        </Section>
    );
}
