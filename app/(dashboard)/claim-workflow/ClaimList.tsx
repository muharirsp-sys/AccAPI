/*
 * Tujuan: List Report Claim Workflow (Fiori S4b): kartu tahap sebagai saringan (Draf, Siap dikirim, Menunggu bayar, Dibayar sebagian,
 *   Lunas belum ditutup, Ditutup, Belum lunas per No Claim dari ringkasan server), kolom No Claim, umur sejak dikirim, satu tabel yang
 *   setiap barisnya membuka klaimnya. Galat muat tidak pernah tampil sebagai kosong.
 * Caller: app/(dashboard)/claim-workflow/page.tsx.
 * Dependensi: GET /api/claim-workflow, GET /api/claim-workflow/outstanding; components/fiori/{core,interactive}; lib/claim-workflow-ui,
 *   lib/rekapan-nota/ui (ambil), lib/promo-ui (rupiah).
 * Main Functions: ClaimList.
 * Side Effects: HTTP baca saja. Saringan dan pencarian di klien (BL-13 belum: varian berlabel bila daftar terpotong).
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { FileBarChart } from "lucide-react";
import { ListItem, MessageStrip, ResponsiveTable, Skeleton, StatusBadge, VariantNote, type Column } from "@/components/fiori/core";
import { FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { ambil } from "@/lib/rekapan-nota/ui";
import { rupiah } from "@/lib/promo-ui";
import { pesanGalat, statusKlaim, tahapKlaim, tanggalWita, umurHari, type TahapKey } from "@/lib/claim-workflow-ui";

type Row = {
    id: string; claimWorkflowNo: string; offBatchId: string; offNoPengajuan?: string | null; principleName: string; status: string;
    totalClaim: number; totalPaid: number; remainingAmount: number; noClaim?: string | null; createdAt: string;
    submittedToPrincipalAt?: string | null; offFinanceStatus?: string | null; noClaimList?: string[]; documentStatus?: string | null;
    canGenerateNoClaim?: boolean; noClaimGateReason?: string | null;
};
type OutRow = {
    workflowId: string; submissionId: string; claimWorkflowNo: string; noClaim?: string | null; principleName: string; status: string;
    totalClaim: number; totalPaid: number; remainingAmount: number; daysOutstanding?: number | null; offNoPengajuan?: string | null;
};
type OutSummary = { submissionCount: number; totalClaim: number; totalPaid: number; totalOutstanding: number };
type Daftar = { workflows: Row[]; hasMore: boolean };
type Outstanding = { rows: OutRow[]; summary: OutSummary | null };
type Saring = "semua" | Exclude<TahapKey, "batal" | "lain"> | "belumLunas";
type Tindakan = "" | "ready_no_claim" | "waiting_finance" | "docs_incomplete";

const KARTU: Array<{ key: Saring; label: string }> = [
    { key: "semua", label: "Semua klaim" }, { key: "draf", label: "Draf" }, { key: "siap", label: "Siap dikirim" },
    { key: "dikirim", label: "Menunggu bayar" }, { key: "sebagian", label: "Dibayar sebagian" }, { key: "lunas", label: "Lunas, belum ditutup" },
    { key: "ditutup", label: "Ditutup" }, { key: "belumLunas", label: "Belum lunas" },
];
const TINDAKAN: Record<Exclude<Tindakan, "">, string> = { ready_no_claim: "Siap isi No Claim", waiting_finance: "Menunggu Finance OFF", docs_incomplete: "Dokumen belum lengkap" };
const FINANCE_OFF: Record<string, string> = { "Not Started": "Belum mulai", "Waiting Payment": "Menunggu bayar", "Partial Paid": "Dibayar sebagian", Paid: "Lunas", "Need Correction": "Perlu koreksi" };

const noClaimDari = (r: Row) => {
    const daftar = r.noClaimList?.length ? r.noClaimList : r.noClaim ? [r.noClaim] : [];
    return daftar.length === 0 ? "" : daftar.length === 1 ? daftar[0] : `${daftar[0]} +${daftar.length - 1} lainnya`;
};
const umurTeks = (hari: number | null | undefined) => (hari == null ? "–" : `${hari} hari`);
const umurBaris = (r: Row) => (["dikirim", "sebagian", "lunas"].includes(tahapKlaim(r.status)) ? umurHari(r.submittedToPrincipalAt) : null);
const cocokTindakan = (r: Row, t: Tindakan) =>
    !t || (t === "ready_no_claim" ? r.canGenerateNoClaim === true : t === "waiting_finance" ? r.offFinanceStatus !== "Paid" : r.documentStatus === "none" || r.documentStatus === "partial");
const berisi = (q: string, nilai: Array<string | null | undefined>) => !q || nilai.some((v) => v && v.toLowerCase().includes(q));

export default function ClaimList({ permKeys, ditutup }: { permKeys: string[]; ditutup?: string }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const [saring, setSaring] = useState<Saring>("semua");
    const [cari, setCari] = useState("");
    const [principal, setPrincipal] = useState("");
    const [tindakan, setTindakan] = useState<Tindakan>("");
    const [pesanTutup, setPesanTutup] = useState(ditutup);

    const [daftar, muatDaftar] = useLoad(useCallback(async (): Promise<Load<Daftar>> => {
        const r = await ambil<Daftar>("/api/claim-workflow", (j) => {
            const d = j as { ok?: boolean; error?: string; workflows?: Row[]; pagination?: { hasMore?: boolean } } | null;
            if (!d?.ok) throw new Error(d?.error || "Gagal memuat Claim Workflow.");
            return { workflows: d.workflows ?? [], hasMore: Boolean(d.pagination?.hasMore) };
        });
        return r.status === "galat" ? { ...r, error: pesanGalat("Gagal memuat Claim Workflow.", r.error) } : r;
    }, []));
    const [out, muatOut] = useLoad(useCallback(async (): Promise<Load<Outstanding>> => {
        const r = await ambil<Outstanding>("/api/claim-workflow/outstanding", (j) => {
            const d = j as { ok?: boolean; error?: string; outstanding?: OutRow[]; summary?: OutSummary } | null;
            if (!d?.ok) throw new Error(d?.error || "Gagal memuat Outstanding.");
            return { rows: d.outstanding ?? [], summary: d.summary ?? null };
        });
        return r.status === "galat" ? { ...r, error: pesanGalat("Gagal memuat Outstanding.", r.error) } : r;
    }, []));

    const semua = useMemo(() => daftar.data?.workflows ?? [], [daftar.data]);
    const jumlah = useMemo(() => {
        const n: Record<string, number> = { semua: semua.length };
        const sisa: Record<string, number> = {};
        for (const r of semua) {
            const t = tahapKlaim(r.status);
            n[t] = (n[t] ?? 0) + 1;
            sisa[t] = (sisa[t] ?? 0) + Number(r.remainingAmount || 0);
        }
        return { n, sisa, perluNoClaim: semua.filter((r) => r.canGenerateNoClaim).length };
    }, [semua]);
    const ringkas = out.data?.summary ?? null;
    const belumLunas = out.data ? ringkas?.submissionCount ?? out.data.rows.length : null;

    const q = cari.trim().toLowerCase();
    const isOut = saring === "belumLunas";
    const principals = useMemo(() => [...new Set([...semua.map((r) => r.principleName), ...(out.data?.rows ?? []).map((r) => r.principleName)].filter(Boolean))].sort(), [semua, out.data]);
    const barisKlaim = useMemo(() => semua.filter((r) =>
        (saring === "semua" || tahapKlaim(r.status) === saring)
        && (!principal || r.principleName === principal)
        && cocokTindakan(r, tindakan)
        && berisi(q, [r.claimWorkflowNo, r.noClaim, r.principleName, r.offNoPengajuan, statusKlaim(r.status).label, ...(r.noClaimList ?? [])])), [semua, saring, principal, tindakan, q]);
    const barisOut = useMemo(() => (out.data?.rows ?? []).filter((r) =>
        (!principal || r.principleName === principal) && berisi(q, [r.claimWorkflowNo, r.noClaim, r.principleName, r.offNoPengajuan])), [out.data, principal, q]);
    const saringAktif = Number(Boolean(principal)) + Number(Boolean(tindakan) && !isOut);
    const labelKartu = KARTU.find((k) => k.key === saring)?.label ?? "";

    const kolomKlaim: Column<Row>[] = [
        { key: "klaim", header: "Klaim", cell: (r) => <><Link className="fi-mono" href={`/claim-workflow/${r.id}`}>{r.claimWorkflowNo}</Link><span className="fi-sub">{r.principleName}</span></> },
        { key: "noclaim", header: "No Claim", cell: (r) => noClaimDari(r) ? <span className="fi-mono">{noClaimDari(r)}</span> : <span className="fi-subtle">Belum ada</span> },
        { key: "off", header: "OFF / No Pengajuan", secondary: true, cell: (r) => r.offNoPengajuan || "–" },
        { key: "total", header: "Total", align: "end", cell: (r) => rupiah(r.totalClaim) },
        { key: "dibayar", header: "Dibayar", align: "end", secondary: true, cell: (r) => rupiah(r.totalPaid) },
        { key: "sisa", header: "Sisa", align: "end", cell: (r) => rupiah(r.remainingAmount) },
        { key: "status", header: "Status", cell: (r) => <StatusBadge tone={statusKlaim(r.status).tone}>{statusKlaim(r.status).label}</StatusBadge> },
        { key: "finance", header: "Finance OFF", secondary: true, cell: (r) => r.offFinanceStatus === "Paid" ? "Lunas" : <span className="fi-why" title={r.noClaimGateReason ?? undefined}>{FINANCE_OFF[r.offFinanceStatus ?? ""] ?? "Menunggu"}</span> },
        { key: "umur", header: "Umur", secondary: true, cell: (r) => { const u = umurBaris(r); return <span className={u != null && u > 30 ? "fi-why fi-tnum" : "fi-tnum"}>{umurTeks(u)}</span>; } },
        { key: "dibuat", header: "Dibuat", secondary: true, cell: (r) => tanggalWita(r.createdAt) },
        { key: "aksi", header: "Tindakan", cell: (r) => r.canGenerateNoClaim ? <Link className="fi-btn fi-btn--tertiary" href={`/claim-workflow/${r.id}?focus=no-claim`}>Isi No Claim</Link> : null },
    ];
    const kolomOut: Column<OutRow>[] = [
        { key: "klaim", header: "Klaim", cell: (r) => <><Link className="fi-mono" href={`/claim-workflow/${r.workflowId}`}>{r.claimWorkflowNo}</Link><span className="fi-sub">{r.principleName}</span></> },
        { key: "noclaim", header: "No Claim", cell: (r) => r.noClaim ? <span className="fi-mono">{r.noClaim}</span> : <span className="fi-subtle">Belum ada</span> },
        { key: "total", header: "Total", align: "end", cell: (r) => rupiah(r.totalClaim) },
        { key: "dibayar", header: "Dibayar", align: "end", secondary: true, cell: (r) => rupiah(r.totalPaid) },
        { key: "sisa", header: "Sisa", align: "end", cell: (r) => rupiah(r.remainingAmount) },
        { key: "status", header: "Status", cell: (r) => <StatusBadge tone={statusKlaim(r.status).tone}>{statusKlaim(r.status).label}</StatusBadge> },
        { key: "umur", header: "Umur", cell: (r) => <span className={(r.daysOutstanding ?? 0) > 30 ? "fi-why fi-tnum" : "fi-tnum"}>{umurTeks(r.daysOutstanding)}</span> },
    ];

    const kosongKlaim = semua.length === 0
        ? { title: "Belum ada klaim", message: "Klaim dibuat dari OFF Program Control setelah batch disetujui OM." }
        : q || principal || tindakan
            ? { title: "Tidak ada klaim yang sesuai saringan", message: "Ubah kata kunci atau hapus saringan." }
            : { title: `Tidak ada klaim dengan tahap ${labelKartu}`, message: "Pilih kartu lain untuk melihat tahap lain." };

    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Promo &amp; Klaim</span></li><li><span aria-current="page">Claim Workflow</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>Claim Workflow</h1>
                    <span className="fi-spacer" />
                    {keys.has("claim_workflow.export") && <Link className="fi-btn fi-btn--secondary" href="/claim-workflow/reports"><FileBarChart className="fi-icon" aria-hidden />Laporan klaim</Link>}
                </div>
                <p>Pengajuan klaim ke principal setelah OFF Program Control: isi No Claim dan buat dokumen, kirim, catat pembayaran, lalu tutup. Pilih kartu untuk menyaring tahap.</p>
            </header>

            {pesanTutup && <MessageStrip tone="pos" title={`${pesanTutup} ditutup.`} onClose={() => setPesanTutup(undefined)}>Angka kartu sudah memakai data terbaru.</MessageStrip>}
            {out.status === "galat" && !out.data && !isOut && <MessageStrip tone="neg" title={out.error}>Angka Belum lunas tidak tampil; ini bukan nol. <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatOut}>Coba lagi</button></MessageStrip>}

            {daftar.status === "memuat" && !daftar.data ? <div className="fi-panel"><Skeleton rows={2} label="Memuat ringkasan klaim" /></div> : (
                <div className="fi-kcards" role="group" aria-label="Saring menurut tahap">
                    {KARTU.map((k) => {
                        const nilai = k.key === "belumLunas" ? belumLunas : daftar.data ? jumlah.n[k.key] ?? 0 : null;
                        const kecil = k.key === "belumLunas"
                            ? out.status === "galat" && !out.data ? "gagal dimuat" : ringkas ? `per No Claim · ${rupiah(ringkas.totalOutstanding)}` : "memuat…"
                            : k.key === "draf" ? (jumlah.perluNoClaim ? `${jumlah.perluNoClaim} siap isi No Claim` : "No Claim & dokumen")
                            : k.key === "dikirim" || k.key === "sebagian" ? `sisa ${rupiah(jumlah.sisa[k.key] ?? 0)}` : undefined;
                        const waspada = (k.key === "dikirim" || k.key === "sebagian" || k.key === "belumLunas") && (nilai ?? 0) > 0;
                        return (
                            <button key={k.key} type="button" className="fi-kc" aria-pressed={saring === k.key} data-tone={waspada ? "warn" : undefined} onClick={() => setSaring(k.key)}>
                                <span>{k.label}</span>
                                <b>{nilai ?? "–"}</b>
                                {kecil && <small>{kecil}</small>}
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar title="Saringan" activeCount={saringAktif} onReset={() => { setPrincipal(""); setTindakan(""); setCari(""); }}
                    search={<FormField label="Cari">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="CLM, No Claim, principal, No Pengajuan" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>}
                    fields={<>
                        <FormField label="Principal">{(a11y) => <select {...a11y} className="fi-input" value={principal} onChange={(e) => setPrincipal(e.target.value)}><option value="">Semua principal</option>{principals.map((p) => <option key={p}>{p}</option>)}</select>}</FormField>
                        {!isOut && <FormField label="Perlu tindakan">{(a11y) => <select {...a11y} className="fi-input" value={tindakan} onChange={(e) => setTindakan(e.target.value as Tindakan)}><option value="">Semua</option>{Object.entries(TINDAKAN).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}</FormField>}
                    </>}
                    chips={[
                        ...(principal ? [{ label: `Principal: ${principal}`, onRemove: () => setPrincipal("") }] : []),
                        ...(tindakan && !isOut ? [{ label: TINDAKAN[tindakan], onRemove: () => setTindakan("") }] : []),
                    ]} />
            </div>

            {isOut ? (
                <ResponsiveTable<OutRow> title="Belum lunas per No Claim" count={barisOut.length} columns={kolomOut} rows={barisOut} rowKey={(r) => r.submissionId}
                    status={out.status} error={out.error} onRetry={muatOut}
                    empty={(out.data?.rows.length ?? 0) === 0 ? { title: "Tidak ada klaim belum lunas", message: "Semua klaim yang sudah dikirim ke principal sudah lunas atau ditutup." } : { title: "Tidak ada klaim yang sesuai saringan", message: "Ubah kata kunci atau hapus saringan." }}
                    mobileItem={(r) => <ListItem href={`/claim-workflow/${r.workflowId}`} doc={r.claimWorkflowNo} amount={rupiah(r.remainingAmount)}
                        title={`${r.principleName} · No Claim ${r.noClaim || "belum ada"}`} meta={`dikirim ${umurTeks(r.daysOutstanding)} lalu`}
                        badge={<StatusBadge tone={statusKlaim(r.status).tone}>{statusKlaim(r.status).label}</StatusBadge>} />} />
            ) : (
                <ResponsiveTable<Row> title={saring === "semua" ? "Klaim" : `Klaim · ${labelKartu}`} count={barisKlaim.length} columns={kolomKlaim} rows={barisKlaim} rowKey={(r) => r.id}
                    status={daftar.status} error={daftar.error} onRetry={muatDaftar} empty={kosongKlaim}
                    mobileItem={(r) => <ListItem href={`/claim-workflow/${r.id}`} doc={r.claimWorkflowNo} amount={rupiah(r.remainingAmount)}
                        title={`${r.principleName} · No Claim ${noClaimDari(r) || "belum ada"}`}
                        meta={umurBaris(r) != null ? `dikirim ${umurTeks(umurBaris(r))} lalu` : "sisa tagihan"}
                        badge={<StatusBadge tone={statusKlaim(r.status).tone}>{statusKlaim(r.status).label}</StatusBadge>} />} />
            )}
            <p className="fi-small fi-subtle">Umur = hari sejak dikirim ke principal. Setiap baris membuka klaimnya. Belum lunas dihitung per No Claim dari ringkasan server.</p>
            {daftar.data?.hasMore && (
                <VariantNote bl="BL-13">Yang tampil adalah {semua.length} klaim terbaru; kartu (selain Belum lunas) dan pencarian hanya menghitung klaim yang tampil. Usulan: saring, cari, dan halaman di database.</VariantNote>
            )}
        </div>
    );
}
