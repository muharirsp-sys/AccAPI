/*
 * Tujuan: Dashboard SPV (Fiori S5, it05 — Overview Page): total tim, laporan + tanda per salesman, detail kunjungan, bahan
 *   briefing sore, "Tandai sudah dibaca" (#17) dan "Batalkan tanda dibaca" (S5-4a, kontrak #132) lewat dialog. Admin/manager/admin_sales
 *   memilih SPV (#16): route spv-dashboard
 *   hanya menerima `spvName` untuk peran itu; daftar SPV dari GET sales-profiles (bila gagal: isian teks + VariantNote).
 *   Tanggal "hari ini" = WITA (hariIniWita, dikirim ke server); jam tampil WITA.
 * Caller: app/(dashboard)/form-kontrol/spv-dashboard/page.tsx.
 * Dependensi: ../shared (Scope, hariIniWita, jamWita, ambilFk, tulisFk), components/fiori/{core,interactive},
 *   lib/rekapan-nota/ui (tanggalPanjang, tanggalPendek).
 * Main Functions: DashboardSpv (default), KartuSalesman.
 * Side Effects: GET my-scope, GET sales-profiles (pemilih SPV), GET spv-dashboard; POST reports/ack (dialog; batal = `ack: false`,
 *   siapa/kapan dicatat server di kontrol_audit_log); router.replace
 *   untuk `?date=` dan `?spv=`.
 */
"use client";

import { useCallback, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CheckCheck, RefreshCw, Undo2 } from "lucide-react";
import { Button, EmptyState, ErrorState, KeyValues, MessageStrip, Section, Skeleton, StatusBadge, VariantNote, type Tone } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { tanggalPanjang, tanggalPendek } from "@/lib/rekapan-nota/ui";
import { alasanIzinFk, ambilFk, hariIniWita, jamWita, tulisFk, type Scope } from "../shared";

interface VisitRow {
    custCode: string; custName: string; status: string;
    checkinAt: string | null; checkoutAt: string | null;
    durationMinutes: number | null;
    gpsFlag: string | null; durFlag: string | null;
    checkinPhotoUrl: string | null; checkoutPhotoUrl: string | null;
    merchDone: number; merchTotal: number;
}
interface SalesmanRow {
    salesCode: string; salesName: string;
    totalRoute: number; ordered: number; notOrder: number; notVisited: number;
    checkedIn: number; checkedOut: number;
    submittedAt: string | null; tindakLanjut: string | null;
    spvAck?: boolean; spvAckAt?: string | null;
    visits?: VisitRow[]; totalFieldMinutes?: number;
}
type DataDashboard = { rows: SalesmanRow[]; spvName: string; diperbarui: string };

/** Route spv-dashboard menerima `spvName` hanya untuk peran ini (route:16-17); peran lain memakai profilnya sendiri. */
const PERAN_PILIH_SPV = ["admin", "manager", "admin_sales"];
const GAGAL_DASHBOARD = "Dashboard gagal dimuat.";
const FLAG_LABEL: Record<string, string> = {
    akurasi_rendah: "Akurasi GPS rendah",
    tanpa_lokasi: "Tanpa lokasi",
    durasi_singkat: "Kunjungan < 5 menit",
    durasi_lama: "Kunjungan > 2 jam",
};

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
function lamaLapangan(min?: number) {
    if (!min) return "0 mnt";
    const h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? `${h} j ${m} mnt` : `${m} mnt`;
}
/** gpsFlag/durFlag bisa berisi beberapa kode dipisah koma. */
const flagsOf = (v: VisitRow) => [v.gpsFlag, v.durFlag].filter(Boolean).join(",").split(",").filter(Boolean);

function statusLaporan(r: SalesmanRow): { tone: Tone; label: string } {
    if (!r.submittedAt) return { tone: "neg", label: "Belum kirim laporan" };
    if (r.spvAck) return { tone: "pos", label: r.spvAckAt ? `Dibaca ${jamWita(r.spvAckAt)}` : "Sudah dibaca" };
    return { tone: "warn", label: "Menunggu dibaca" };
}

export default function DashboardSpv({ permKeys }: { permKeys: string[] }) {
    const izinAck = alasanIzinFk(useMemo(() => new Set(permKeys), [permKeys]), "submit");
    const sp = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const qDate = sp.get("date");
    const date = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : hariIniWita();
    const spvDipilih = (sp.get("spv") ?? "").trim();
    const ubah = useCallback((u: { date?: string; spv?: string }) => {
        const p = new URLSearchParams(sp.toString());
        for (const [k, v] of Object.entries(u)) { if (v) p.set(k, v); else p.delete(k); }
        router.replace(p.size ? `${pathname}?${p}` : pathname, { scroll: false });
    }, [pathname, router, sp]);

    const [scopeLoad, muatScope] = useLoad(useCallback(
        () => ambilFk("/api/form-kontrol/my-scope", (j) => j as unknown as Scope, "Akses Form Kontrol belum dapat diverifikasi."), []));
    const peran = scopeLoad.status === "siap" ? scopeLoad.data?.role ?? "" : null;
    const pemilih = peran !== null && PERAN_PILIH_SPV.includes(peran);

    // Daftar SPV untuk admin = nama SPV unik di Hierarki Sales (endpoint yang sudah ada; butuh form_kontrol.manage).
    const [spvLoad] = useLoad(useCallback(async (): Promise<Load<string[]>> => {
        if (!pemilih) return { status: "siap", data: [] };
        return ambilFk("/api/form-kontrol/sales-profiles", (j) => {
            const rows = (j.rows ?? []) as Array<{ spvName?: string | null }>;
            return [...new Set(rows.map((r) => r.spvName ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
        }, "Daftar SPV belum berhasil dimuat.");
    }, [pemilih]));

    const [dash, muatDash] = useLoad(useCallback(async (): Promise<Load<DataDashboard | null>> => {
        if (peran === null) return { status: "memuat" };
        if (pemilih && !spvDipilih) return { status: "siap", data: null };
        const p = new URLSearchParams({ date });
        if (pemilih) p.set("spvName", spvDipilih);
        // 400 "SPV name not found" (akun belum tertaut ke profil sales) diterjemahkan ambilFk.
        return ambilFk(`/api/form-kontrol/spv-dashboard?${p}`, (j) => ({
            rows: (j.rows ?? []) as SalesmanRow[],
            spvName: typeof j.spvName === "string" ? j.spvName : spvDipilih,
            diperbarui: new Date().toISOString(),
        }), GAGAL_DASHBOARD);
    }, [peran, pemilih, spvDipilih, date]));

    const [ack, setAck] = useState<SalesmanRow | null>(null);
    const [batal, setBatal] = useState<SalesmanRow | null>(null);
    const [sukses, setSukses] = useState("");
    const data = dash.data ?? null;
    const rows = data?.rows ?? [];
    // Data usang (muat ulang gagal/berjalan) tidak boleh dipakai untuk aksi tulis.
    const usang = dash.status !== "siap" ? "Tunggu dashboard selesai dimuat ulang." : undefined;

    const totals = {
        route: rows.reduce((a, r) => a + r.totalRoute, 0),
        checkin: rows.reduce((a, r) => a + r.checkedIn, 0),
        ordered: rows.reduce((a, r) => a + r.ordered, 0),
        notOrder: rows.reduce((a, r) => a + r.notOrder, 0),
        submitted: rows.filter((r) => r.submittedAt).length,
    };
    const belumKirim = rows.filter((r) => !r.submittedAt);

    const kepala = (
        <header className="fi-page-head">
            <nav aria-label="Jejak halaman">
                <ol className="fi-crumb"><li><span>Operasional Sales</span></li><li><Link href="/form-kontrol">Form Kontrol</Link></li><li><span aria-current="page">Dashboard SPV</span></li></ol>
            </nav>
            <div className="fi-page-bar"><h1>Dashboard SPV</h1></div>
            <p>
                {data?.spvName ? <>Tim {data.spvName} · </> : null}
                {rows.length > 0 ? <>{rows.length} salesman · </> : null}
                {tanggalPanjang(date)} · WITA
            </p>
        </header>
    );

    if (scopeLoad.status !== "siap") {
        return (
            <div className="fi-page">
                {kepala}
                {scopeLoad.status === "galat"
                    ? <ErrorState title="Akses Form Kontrol belum dapat diverifikasi" message={`${scopeLoad.error ?? ""} Dashboard tidak dibuka sampai akses berhasil diverifikasi.`} onRetry={muatScope} />
                    : <Skeleton rows={4} label="Memuat Dashboard SPV" />}
            </div>
        );
    }

    const pilihSpv = pemilih && (
        spvLoad.status === "siap" && (spvLoad.data?.length ?? 0) > 0 ? (
            <FormField label="SPV">{(a) => (
                <select {...a} className="fi-input" value={spvDipilih} onChange={(e) => { setSukses(""); ubah({ spv: e.target.value }); }}>
                    <option value="">Pilih SPV…</option>
                    {spvLoad.data!.map((n) => <option key={n} value={n}>{n}</option>)}
                    {spvDipilih && !spvLoad.data!.includes(spvDipilih) && <option value={spvDipilih}>{spvDipilih}</option>}
                </select>
            )}</FormField>
        ) : spvLoad.status === "memuat" ? (
            <FormField label="SPV">{(a) => <select {...a} className="fi-input" disabled><option>Memuat daftar SPV…</option></select>}</FormField>
        ) : (
            <IsianSpv key={spvDipilih} awal={spvDipilih} onPilih={(v) => { setSukses(""); ubah({ spv: v }); }} />
        )
    );

    let isi;
    if (pemilih && !spvDipilih) {
        isi = <EmptyState title="Pilih SPV untuk melihat timnya" message="Admin dan manager melihat satu tim SPV sekaligus." />;
    } else if (!data && dash.status === "galat") {
        isi = <ErrorState title={GAGAL_DASHBOARD} message={`${(dash.error ?? "").replace(GAGAL_DASHBOARD, "").trim()} Angka tidak ditampilkan agar tidak terbaca sebagai nol.`.trim()} onRetry={muatDash} />;
    } else if (!data) {
        isi = (
            <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="fi-kc"><Skeleton rows={2} label="Memuat angka tim" /></div>)}</div>
                <Skeleton rows={6} label="Memuat salesman" />
            </>
        );
    } else if (rows.length === 0) {
        isi = <EmptyState title={data.spvName ? `Belum ada salesman di tim ${data.spvName}` : "Belum ada salesman di tim ini"} message="Salesman muncul setelah admin mengisi SPV mereka di Hierarki Sales." />;
    } else {
        isi = (
            <div className={dash.status === "memuat" ? "fi-busy grid gap-4" : "grid gap-4"} aria-busy={dash.status === "memuat" || undefined}>
                {dash.status === "galat" && (
                    <MessageStrip tone="neg" title="Gagal memuat ulang.">
                        {(dash.error ?? "").replace(GAGAL_DASHBOARD, "").trim()} Yang tampil adalah hasil sebelumnya; tanda dibaca dikunci sampai berhasil dimuat ulang.{" "}
                        <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatDash}>Coba lagi</button>
                    </MessageStrip>
                )}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    <div className="fi-kc"><span>Rute tercatat</span><b>{totals.route}</b><small>baris status rute</small></div>
                    <div className="fi-kc"><span>Check-in</span><b>{totals.checkin}</b><small>{pct(totals.checkin, totals.route)}% rute</small></div>
                    <div className="fi-kc" data-tone="pos"><span>Order</span><b>{totals.ordered}</b><small>{pct(totals.ordered, totals.route)}% rute</small></div>
                    <div className="fi-kc" data-tone={totals.notOrder ? "neg" : undefined}><span>Tidak order</span><b>{totals.notOrder}</b></div>
                    <div className="fi-kc" data-tone={totals.submitted === rows.length ? "pos" : "warn"}><span>Laporan masuk</span><b>{totals.submitted}/{rows.length}</b></div>
                </div>
                <p className="fi-small fi-subtle">
                    Diperbarui {jamWita(data.diperbarui)} WITA ·{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => { setSukses(""); muatDash(); }}>
                        <RefreshCw className="fi-icon" aria-hidden />Muat ulang
                    </button>
                </p>
                <VariantNote bl="it05 #15">
                    Persentase dihitung dari baris status rute yang tercatat hari itu (dari kunjungan dan &quot;Kirim status rute hari ini&quot;), belum
                    dari rute JKS yang direncanakan. Toko yang tidak pernah disentuh dan belum dikirim statusnya tidak ikut terhitung.
                </VariantNote>
                {belumKirim.length === 0
                    ? <MessageStrip tone="pos" title="Semua salesman sudah mengirim laporan.">Data siap untuk briefing sore.</MessageStrip>
                    : <MessageStrip tone="warn" title={`${belumKirim.length} salesman belum mengirim laporan:`}>{belumKirim.map((r) => r.salesName).join(", ")}</MessageStrip>}
                <div className="grid gap-3 md:grid-cols-2">
                    {rows.map((r) => <KartuSalesman key={r.salesCode} r={r} kunci={izinAck ?? usang} onTandai={() => setAck(r)} onBatal={() => setBatal(r)} />)}
                </div>
                {rows.some((r) => r.notOrder > 0) && (
                    <Section title="Bahan briefing sore" subtitle="toko tidak order hari ini">
                        <div className="fi-sect-in">
                            <KeyValues items={rows.filter((r) => r.notOrder > 0).map((r) => [`${r.salesName} · ${r.salesCode}`, `${r.notOrder} toko`])} />
                            <p className="fi-small fi-subtle">Total {totals.notOrder} toko tidak order — wajib dibahas saat briefing.</p>
                        </div>
                    </Section>
                )}
            </div>
        );
    }

    return (
        <div className="fi-page">
            {kepala}
            <div className="fi-fbar">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,18rem)]">
                    <FormField label="Tanggal">{(a) => (
                        <input {...a} className="fi-input" type="date" value={date} onChange={(e) => { setSukses(""); ubah({ date: e.target.value === hariIniWita() ? "" : e.target.value }); }} />
                    )}</FormField>
                    {pilihSpv}
                </div>
                {pemilih && spvLoad.status === "galat" && (
                    <VariantNote bl="it05 #16">
                        Daftar SPV diambil dari Hierarki Sales dan belum bisa dibaca akun ini ({(spvLoad.error ?? "").replace("Daftar SPV belum berhasil dimuat.", "").trim() || "galat server"}).
                        Ketik nama SPV persis seperti di Hierarki Sales.
                    </VariantNote>
                )}
            </div>
            {sukses && <MessageStrip tone="pos" title={sukses} onClose={() => setSukses("")} />}
            {isi}
            <VariantNote bl="BL-28">
                Tanggal &quot;hari ini&quot; dihitung di perangkat dalam WITA; penetapan tanggal oleh server menunggu BL-28. Cap waktu yang tercetak
                di foto kunjungan masih memakai WIB.
            </VariantNote>
            <ConfirmDialog
                open={ack !== null}
                onClose={() => setAck(null)}
                title={`Tandai laporan ${ack?.salesName ?? ""} sudah dibaca?`}
                description="Salesman dan SM melihat bahwa laporan ini sudah Anda baca. Bila keliru, tanda ini bisa dibatalkan dari kartu salesman; keduanya tercatat atas nama Anda."
                facts={ack ? [
                    ["Salesman", <span key="s">{ack.salesName} · <span className="fi-mono">{ack.salesCode}</span></span>],
                    ["Tanggal laporan", tanggalPendek(date)],
                    ["Dikirim", `${jamWita(ack.submittedAt)} WITA`],
                    ["Tindak lanjut", ack.tindakLanjut || "—"],
                ] : []}
                confirmLabel="Tandai sudah dibaca"
                confirmDisabled={izinAck ?? usang}
                onConfirm={async () => {
                    const r = ack!;
                    await tulisFk("/api/form-kontrol/reports/ack", { body: { salesCode: r.salesCode, date }, gagal: "Laporan belum ditandai dibaca." });
                    setAck(null);
                    setSukses(`Laporan ${r.salesName} ditandai sudah dibaca.`);
                    muatDash();
                }}
            />
            <ConfirmDialog
                open={batal !== null}
                onClose={() => setBatal(null)}
                tone="negative"
                tag="Batalkan"
                title={`Batalkan tanda dibaca laporan ${batal?.salesName ?? ""}?`}
                description="Laporan kembali berstatus Menunggu dibaca untuk salesman dan SM. Pembatalan tercatat atas nama Anda, bersama tanda dibaca sebelumnya."
                facts={batal ? [
                    ["Salesman", <span key="s">{batal.salesName} · <span className="fi-mono">{batal.salesCode}</span></span>],
                    ["Tanggal laporan", tanggalPendek(date)],
                    ["Ditandai dibaca", batal.spvAckAt ? `${jamWita(batal.spvAckAt)} WITA` : "—"],
                    ["Sesudahnya", "Menunggu dibaca; bisa ditandai lagi"],
                ] : []}
                confirmLabel="Batalkan tanda dibaca"
                cancelLabel="Kembali"
                confirmDisabled={izinAck ?? usang}
                onConfirm={async () => {
                    const r = batal!;
                    await tulisFk("/api/form-kontrol/reports/ack", { body: { salesCode: r.salesCode, date, ack: false }, gagal: "Tanda dibaca belum dibatalkan." });
                    setBatal(null);
                    setSukses(`Tanda dibaca laporan ${r.salesName} dibatalkan.`);
                    muatDash();
                }}
            />
        </div>
    );
}

/** Isian nama SPV bila daftar tidak bisa dimuat; diterapkan lewat tombol supaya tidak memuat per ketukan. */
function IsianSpv({ awal, onPilih }: { awal: string; onPilih: (v: string) => void }) {
    const [nilai, setNilai] = useState(awal);
    const kirim = (e: FormEvent) => { e.preventDefault(); onPilih(nilai.trim()); };
    return (
        <form onSubmit={kirim} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <FormField label="Nama SPV">{(a) => <input {...a} className="fi-input" value={nilai} onChange={(e) => setNilai(e.target.value)} placeholder="Nama SPV di Hierarki Sales" />}</FormField>
            <Button type="submit" disabled={!nilai.trim()} disabledReason="Isi nama SPV dulu">Tampilkan</Button>
        </form>
    );
}

function KartuSalesman({ r, kunci, onTandai, onBatal }: { r: SalesmanRow; kunci?: string; onTandai: () => void; onBatal: () => void }) {
    const st = statusLaporan(r);
    const ao = pct(r.ordered, r.totalRoute);
    const cakupan = pct(r.ordered + r.notOrder, r.totalRoute);
    const visits = r.visits ?? [];
    const hitungFlag = new Map<string, number>();
    for (const v of visits) for (const f of flagsOf(v)) hitungFlag.set(f, (hitungFlag.get(f) ?? 0) + 1);
    return (
        <article className="fi-panel content-start" aria-label={r.salesName}>
            <header className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                    <h3 className="fi-title-3">{r.salesName}</h3>
                    <span className="fi-mono fi-subtle">{r.salesCode}</span>
                </div>
                <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
            </header>
            <dl className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {([["Rute", r.totalRoute], ["Check-in", r.checkedIn], ["Order", r.ordered], ["Tidak order", r.notOrder], ["Tidak dikunjungi", r.notVisited]] as const).map(([l, v]) => (
                    <div key={l} className="grid gap-0.5"><dt className="fi-caption">{l}</dt><dd className="fi-title-3 fi-tnum">{v}</dd></div>
                ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={ao >= 70 ? "pos" : ao >= 50 ? "warn" : "neg"}>AO {ao}%</StatusBadge>
                <span className="fi-small fi-subtle">Cakupan {cakupan}% · check-out {r.checkedOut}</span>
                {[...hitungFlag].map(([f, n]) => <StatusBadge key={f} tone="warn">{FLAG_LABEL[f] ?? f} {n}</StatusBadge>)}
            </div>
            {r.tindakLanjut && <p className="fi-small"><b>Tindak lanjut:</b> {r.tindakLanjut}</p>}
            {visits.length > 0 && (
                <details>
                    <summary className="fi-small" style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}>
                        Detail kunjungan ({visits.length}) · lapangan {lamaLapangan(r.totalFieldMinutes)}
                    </summary>
                    <ul className="fi-hist">
                        {visits.map((v) => {
                            const flags = flagsOf(v);
                            return (
                                <li key={v.custCode} style={{ gridTemplateColumns: "auto minmax(0,1fr)" }}>
                                    <span className="flex gap-1">
                                        {[["check-in", v.checkinPhotoUrl], ["check-out", v.checkoutPhotoUrl]].filter(([, u]) => u).map(([k, u]) => (
                                            <a key={k} href={u!} target="_blank" rel="noreferrer">
                                                {/* eslint-disable-next-line @next/next/no-img-element -- foto unggahan dinamis, ukuran kecil */}
                                                <img src={u!} alt={`Foto ${k} ${v.custName}`} width={40} height={40} style={{ width: 40, height: 40, objectFit: "cover", borderRadius: "var(--r-xs)" }} />
                                            </a>
                                        ))}
                                    </span>
                                    <span className="min-w-0">
                                        <b>{v.custName}</b>
                                        <span className="fi-sub">
                                            {jamWita(v.checkinAt)}–{jamWita(v.checkoutAt)} WITA · {v.durationMinutes !== null ? `${v.durationMinutes} mnt` : "—"} · Merch {v.merchDone}/{v.merchTotal}
                                            {" · "}{flags.length === 0 ? "tanpa tanda" : flags.map((f) => FLAG_LABEL[f] ?? f).join(", ")}
                                        </span>
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </details>
            )}
            {r.submittedAt && !r.spvAck && (
                <div>
                    <Button variant="primary" style={{ minHeight: 44 }} icon={<CheckCheck className="fi-icon" aria-hidden />}
                        disabled={Boolean(kunci)} disabledReason={kunci} onClick={onTandai}>
                        Tandai sudah dibaca
                    </Button>
                </div>
            )}
            {r.spvAck && (
                <div>
                    <Button variant="tertiary" style={{ minHeight: 44 }} icon={<Undo2 className="fi-icon" aria-hidden />}
                        disabled={Boolean(kunci)} disabledReason={kunci} onClick={onBatal}>
                        Batalkan tanda dibaca…
                    </Button>
                </div>
            )}
        </article>
    );
}
