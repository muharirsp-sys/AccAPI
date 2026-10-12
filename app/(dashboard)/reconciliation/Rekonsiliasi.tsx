/*
 * Tujuan: Wizard Rekonsiliasi (Fiori S3): 1 Jenis dan principal → 2 Mapping SKU (aktifkan lewat dialog) → 3 Berkas → 4 Hasil (List Report
 *   dengan saringan status + ekspor XLSX), plus Riwayat run berhalaman. Mapping/riwayat yang gagal dimuat tampil sebagai galat, bukan kosong.
 * Caller: app/(dashboard)/reconciliation/page.tsx.
 * Dependensi: GET|POST /api/reconciliation/mappings, GET /api/reconciliation/history, POST /{config.endpoint} per kontrak;
 *   lib/off-program-control/{reconciliation-config,reconciliation-ui}; components/fiori/{core,interactive}.
 * Main Functions: Rekonsiliasi.
 * Side Effects: HTTP baca/tulis mapping; menjalankan rekonsiliasi (tidak menulis ke Accurate); ekspor XLSX di peramban.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronDown, Download, GitCompareArrows, Upload } from "lucide-react";
import {
    Button, EmptyState, ErrorState, Flow, FooterToolbar, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge, type Column, type FlowStep,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad } from "@/components/fiori/interactive";
import { ambil, jamWita } from "@/lib/rekapan-nota/ui";
import { RECONCILIATION_CONFIG, getReconciliationConfig, type ReconciliationInputConfig } from "@/lib/off-program-control/reconciliation-config";
import type { ReconciliationOutput, ReconciliationResult } from "@/lib/off-program-control/sales-reconciliation";
import type { ReturnReconciliationOutput, ReturnReconciliationResult } from "@/lib/off-program-control/return-reconciliation";
import {
    RETURN_STATUSES, SALES_STATUSES, causeLines, currency, exportSheets, fileSize, number, returnCauseLines, statusLabel, statusTone,
    type Division, type UiStatus,
} from "@/lib/off-program-control/reconciliation-ui";

type MappingVersion = { id: string; version: number; originalName: string; uploadedByName: string; createdAt: string; isActive?: boolean };
type MappingResponse = { active: MappingVersion | null; versions: MappingVersion[]; canManage: boolean };
type HistoryRun = {
    id: string; mappingVersionId: string; status: "processing" | "success" | "failed"; uploadedByName: string;
    inputFiles: { role: string; name: string }[]; summary: Record<string, number> | null;
    issues: (ReconciliationResult | ReturnReconciliationResult)[] | null; error: string | null; durationMs: number | null; startedAt: string;
};
type Output = ReconciliationOutput | ReturnReconciliationOutput;
type Row = ReconciliationResult | ReturnReconciliationResult;
type Saring = "ISSUES_ONLY" | "ALL" | "MATCH_ONLY" | UiStatus;

const DIVISI: Array<[Division, string, "sales" | "purchases" | "returns"]> = [["FAKTUR", "Faktur", "sales"], ["PEMBELIAN", "Pembelian", "purchases"], ["RETURN", "Return", "returns"]];
const apiDivision = (d: Division) => DIVISI.find((x) => x[0] === d)![2];
const principalsFor = (d: Division) => Object.values(RECONCILIATION_CONFIG).filter((c) => c.division === apiDivision(d)).map((c) => c.principal);
const HIST_STATUS = { processing: ["Diproses", "info"], success: ["Berhasil", "pos"], failed: ["Gagal", "neg"] } as const;

export default function Rekonsiliasi({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehJalankan = keys.has("reconciliation.run") || keys.has("reconciliation.manage");
    const [division, setDivision] = useState<Division>("FAKTUR");
    const [principal, setPrincipal] = useState<string>(principalsFor("FAKTUR")[0]);
    const [files, setFiles] = useState<Partial<Record<ReconciliationInputConfig["role"], File | null>>>({});
    const [hasil, setHasil] = useState<(Output & { versi?: number; jam: string }) | null>(null);
    const [berjalan, setBerjalan] = useState(false);
    const [galat, setGalat] = useState<string | null>(null);
    const [pesan, setPesan] = useState<string | null>(null);
    const [saring, setSaring] = useState<Saring>("ISSUES_ONLY");
    const [mappingFile, setMappingFile] = useState<File | null>(null);
    const [dialog, setDialog] = useState(false);
    const [histPage, setHistPage] = useState(1);

    const divApi = apiDivision(division);
    const config = getReconciliationConfig(divApi, principal);
    const query = `division=${divApi}&principal=${principal}`;
    const [mapping, muatMapping] = useLoad(useCallback(() => ambil<MappingResponse>(`/api/reconciliation/mappings?${query}`), [query]));
    const [riwayat, muatRiwayat] = useLoad(useCallback(() => ambil<HistoryRun[]>(`/api/reconciliation/history?${query}&page=${histPage}&pageSize=20`, (j) => (j as { items: HistoryRun[] }).items), [query, histPage]));
    const canManage = mapping.data?.canManage === true;
    const fileFor = (role: ReconciliationInputConfig["role"]) => files[role] ?? null;
    const siap = config.inputs.every((i) => fileFor(i.role));
    const nBerkas = config.inputs.filter((i) => fileFor(i.role)).length;

    function gantiKontrak(d: Division, p: string) {
        setDivision(d); setPrincipal(p); setFiles({}); setHasil(null); setGalat(null); setPesan(null); setMappingFile(null); setHistPage(1); setSaring("ISSUES_ONLY");
    }

    async function jalankan() {
        if (!siap) return;
        setBerjalan(true); setHasil(null); setGalat(null); setPesan(null);
        try {
            const form = new FormData();
            for (const input of config.inputs) form.append(input.role, fileFor(input.role)!);
            const res = await fetch(`/${config.endpoint}`, { method: "POST", body: form });
            const payload = (await res.json().catch(() => ({}))) as Output & { error?: string };
            if (!res.ok) throw new Error(payload.error || "Rekonsiliasi gagal diproses.");
            setHasil({ ...payload, versi: mapping.data?.active?.version, jam: jamWita(new Date()) });
            setSaring(payload.results.some((r) => r.status !== "MATCH") ? "ISSUES_ONLY" : "ALL");
            setHistPage(1); muatRiwayat();
        } catch (e) {
            setGalat(e instanceof Error ? e.message : "Rekonsiliasi gagal diproses.");
        } finally {
            setBerjalan(false);
        }
    }

    async function aktifkanMapping() {
        if (!mappingFile) return;
        const form = new FormData();
        form.append("division", divApi); form.append("principal", principal); form.append("mappingFile", mappingFile);
        const res = await fetch("/api/reconciliation/mappings", { method: "POST", body: form });
        const payload = (await res.json().catch(() => ({}))) as MappingVersion & { error?: string };
        if (!res.ok) throw new Error(payload.error || "Mapping gagal diaktifkan.");
        setDialog(false); setMappingFile(null);
        setPesan(`Mapping v${payload.version} aktif ${jamWita(new Date())} untuk semua pengguna ${DIVISI.find((x) => x[0] === division)![1]} ${principal}. Jalankan ulang untuk memakainya; riwayat sebelumnya tetap tercatat dengan versi lama.`);
        muatMapping(); muatRiwayat();
    }

    async function ekspor() {
        if (!hasil) return;
        setGalat(null);
        try {
            const XLSX = await import("xlsx");
            const { ringkasan, detail, fileName } = exportSheets(division, principal, hasil.summary as Record<string, number>, hasil.results);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ringkasan), "Ringkasan");
            XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), "Detail");
            XLSX.writeFile(wb, fileName);
        } catch {
            setGalat("File hasil gagal diekspor. Coba lagi.");
        }
    }

    const statuses: UiStatus[] = division === "FAKTUR" ? SALES_STATUSES : RETURN_STATUSES;
    const summary = (hasil?.summary ?? {}) as Partial<Record<UiStatus, number>>;
    const count = (s: UiStatus) => summary[s] ?? 0;
    const total = hasil?.results.length ?? 0;
    const cocok = count("MATCH");
    const masalah = total - cocok;
    const selisih = count("QTY_MISMATCH") + count("VALUE_MISMATCH") + count("QTY_AND_VALUE_MISMATCH");
    const hilang = count("MISSING_PRINCIPAL") + (division === "FAKTUR" ? count("MISSING_INTERNAL") : count("MISSING_ACCURATE"));
    const rows: Row[] = useMemo(() => {
        const all = hasil?.results ?? [];
        if (saring === "ALL") return all;
        if (saring === "MATCH_ONLY") return all.filter((r) => r.status === "MATCH");
        if (saring === "ISSUES_ONLY") return all.filter((r) => r.status !== "MATCH");
        return all.filter((r) => r.status === saring);
    }, [hasil, saring]);
    const penyebab = (r: Row) => division === "FAKTUR" ? causeLines(r as ReconciliationResult, principal) : returnCauseLines(r as ReturnReconciliationResult, principal);
    const dokumen = (r: Row) => "orderNumber" in r ? r.orderNumber : r.invoiceNumber;
    const produk = (r: Row) => "internalProductCode" in r ? r.internalProductCode : `${r.accurateProductCode ?? "–"} / ${r.principalProductCode ?? "–"}`;
    const kolom: Column<Row>[] = [
        { key: "status", header: "Status", cell: (r) => <StatusBadge tone={statusTone(r.status)}>{statusLabel(r.status, principal)}</StatusBadge> },
        { key: "dok", header: division === "FAKTUR" ? "Order" : division === "PEMBELIAN" ? "Dokumen Pembelian" : "Invoice", cell: (r) => <span className="fi-mono">{dokumen(r)}</span> },
        ...(division !== "FAKTUR" ? [{ key: "cust", header: division === "PEMBELIAN" ? "Supplier" : "Pelanggan", cell: (r: Row) => (r as ReturnReconciliationResult).customerCode } as Column<Row>] : []),
        { key: "produk", header: "Produk", cell: (r) => <span className="fi-mono fi-small">{produk(r)}</span> },
        { key: "sebab", header: "Penyebab selisih", cell: (r) => <ul className="fi-small" style={{ margin: 0, paddingLeft: "1rem", minWidth: "16rem" }}>{penyebab(r).map((c) => <li key={c}>{c}</li>)}</ul> },
        { key: "qty", header: `Qty Accurate / ${principal}`, align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{number.format(r.accurateQuantity)} / {number.format(r.principalQuantity)}</span> },
        { key: "nilai", header: division === "FAKTUR" ? `Net Accurate / ${principal}` : `DPP Accurate / ${principal}`, align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{"accurateNet" in r ? `${currency.format(r.accurateNet)} / ${currency.format(r.principalNet)}` : `${currency.format(r.accurateDpp)} / ${currency.format(r.principalDpp)}`}</span> },
        { key: "selisih", header: division === "FAKTUR" ? "Selisih net" : "Selisih DPP", align: "end", cell: (r) => { const v = "valueDifference" in r ? r.valueDifference : r.dppDifference; return <span className={`fi-tnum${v < 0 ? " fi-why" : ""}`}>{currency.format(v)}</span>; } },
    ];
    const langkah: FlowStep[] = [
        { label: "Jenis", state: "done" },
        { label: "Mapping", state: mapping.data?.active ? "done" : mapping.status === "galat" ? "stop" : "current" },
        { label: "Berkas", state: siap ? "done" : mapping.data?.active ? "current" : "todo" },
        { label: "Hasil", state: hasil ? "done" : berjalan ? "current" : "todo" },
    ];
    const labelJenis = DIVISI.find((x) => x[0] === division)![1];
    const versiDari = (id: string) => mapping.data?.versions.find((v) => v.id === id)?.version;

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Keuangan</span></li><li><span aria-current="page">Rekonsiliasi</span></li></ol></nav>
                <h1>Rekonsiliasi {labelJenis} {principal}</h1>
                <p>{config.description} Tidak menulis ke Accurate.</p>
                <Flow steps={langkah} label="Langkah rekonsiliasi" />
            </header>

            {galat && <MessageStrip tone="neg" title={galat} onClose={() => setGalat(null)} />}
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {berjalan && <MessageStrip tone="info" title={`Membandingkan ${config.inputs.map((i) => fileFor(i.role)?.name).filter(Boolean).join(" dengan ")}…`}>Hasil tampil di langkah 4.</MessageStrip>}

            <Section title="1 · Jenis dan principal">
                <div className="fi-sect-in">
                    <div className="fi-page-bar">
                        <div className="fi-segs" role="group" aria-label="Jenis Rekonsiliasi">
                            {DIVISI.map(([d, label]) => <button key={d} type="button" aria-pressed={division === d} disabled={berjalan} onClick={() => { if (d !== division) gantiKontrak(d, principalsFor(d)[0]); }}>{label}</button>)}
                        </div>
                        <FormField label="Prinsipal">{(a11y) => <select {...a11y} className="fi-input" value={principal} disabled={berjalan} onChange={(e) => gantiKontrak(division, e.target.value)}>{principalsFor(division).map((p) => <option key={p} value={p}>{p}</option>)}</select>}</FormField>
                    </div>
                </div>
            </Section>

            <Section title="2 · Mapping SKU" subtitle="berlaku untuk semua pengguna jenis dan principal ini" className="fi-region-mapping">
                <div className="fi-sect-in" role="region" aria-label="Mapping aktif">
                    {mapping.status === "memuat" && !mapping.data ? <Skeleton rows={2} label="Memuat mapping" />
                        : mapping.status === "galat" && !mapping.data ? <ErrorState title={`Mapping ${labelJenis} ${principal} gagal dimuat`} message={`${mapping.error}. Rekonsiliasi belum bisa dijalankan tanpa mapping.`} onRetry={muatMapping} />
                        : mapping.data?.active ? (
                            <p className="fi-small" aria-label="Stempel versi mapping">Mapping aktif <b>Versi {mapping.data.active.version}</b> · <span>{mapping.data.active.originalName}</span> · <span>{mapping.data.active.uploadedByName}</span> · <span className="fi-subtle">{jamWita(mapping.data.active.createdAt)}</span></p>
                        ) : <p className="fi-small fi-subtle">Belum ada mapping aktif.</p>}
                    {mapping.data && mapping.data.versions.length > 1 && (
                        <details className="fi-small" role="region" aria-label="Riwayat versi mapping">
                            <summary style={{ cursor: "pointer" }}>Riwayat versi ({mapping.data.versions.length}) <ChevronDown className="fi-icon" aria-hidden style={{ display: "inline", verticalAlign: "-3px" }} /></summary>
                            <ul className="fi-hist" style={{ marginTop: 6 }}>{mapping.data.versions.map((v) => <li key={v.id}><time dateTime={v.createdAt}>{jamWita(v.createdAt)}</time><span><b>Versi {v.version}</b> · {v.originalName} · {v.uploadedByName}{v.isActive ? " · aktif" : ""}</span></li>)}</ul>
                        </details>
                    )}
                    {canManage && (
                        <div className="fi-page-bar">
                            <FormField label="Ganti mapping" help="Workbook .xlsx, maksimal 10 MB.">{(a11y) => <input {...a11y} key={`map-${query}-${mapping.data?.versions.length ?? 0}`} className="fi-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setMappingFile(e.target.files?.[0] ?? null)} />}</FormField>
                            {mappingFile && <Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} onClick={() => setDialog(true)} style={{ alignSelf: "end" }}>Aktifkan v{(mapping.data?.versions.reduce((m, v) => Math.max(m, v.version), 0) ?? 0) + 1}…</Button>}
                        </div>
                    )}
                    {mappingFile && <div className="fi-dropzone"><b>{mappingFile.name}</b><span>{fileSize(mappingFile.size)} · dipilih, belum diaktifkan</span></div>}
                </div>
            </Section>

            <Section title="3 · Berkas" subtitle={`${config.inputs.length} berkas wajib · format ${[...new Set(config.inputs.map((i) => i.extension))].join(" / ")}, maksimal 10 MB`}>
                <div className="fi-sect-in">
                    <div className="fi-kcards">
                        {config.inputs.map((input) => { const f = fileFor(input.role); return (
                            <div key={input.role} className="fi-dropzone" data-ok={f ? "true" : undefined}>
                                <label className="fi-label" htmlFor={`rek-${input.role}`}>{input.label}</label>
                                <span>{f ? <><b>{f.name}</b> ({fileSize(f.size)})</> : "Belum ada file dipilih"}</span>
                                <input key={`${divApi}-${principal}-${input.role}`} id={`rek-${input.role}`} className="fi-input" type="file" accept={input.accept} disabled={berjalan || !bolehJalankan} onChange={(e) => { setFiles((s) => ({ ...s, [input.role]: e.target.files?.[0] ?? null })); setHasil(null); setGalat(null); }} />
                            </div>
                        ); })}
                    </div>
                </div>
            </Section>

            {berjalan && <div className="fi-panel"><Skeleton rows={5} label="Rekonsiliasi berjalan" /></div>}
            {hasil && !berjalan && (
                <Section id="hasil" title="4 · Hasil" subtitle={`${labelJenis} ${principal} · mapping v${hasil.versi ?? "?"} · ${hasil.jam}`}
                    actions={<Button variant="tertiary" icon={<Download className="fi-icon" aria-hidden />} onClick={ekspor}>Ekspor XLSX</Button>}>
                    <div className="fi-sect-in" aria-label="Ringkasan hasil">
                        <div className="fi-kcards">
                            <div className="fi-kc"><span>Baris</span><b>{number.format(total)}</b><small>dibandingkan</small></div>
                            <div className="fi-kc" data-tone="pos"><span>Cocok</span><b>{number.format(cocok)}</b><small>{total ? `${number.format((cocok / total) * 100)}%` : "–"}</small></div>
                            <div className="fi-kc" data-tone={selisih ? "warn" : undefined}><span>Selisih</span><b>{number.format(selisih)}</b><small>jumlah atau nilai</small></div>
                            <div className="fi-kc" data-tone={hilang ? "neg" : undefined}><span>Tidak ditemukan</span><b>{number.format(hilang)}</b><small>di salah satu sisi</small></div>
                        </div>
                        <div className="fi-page-bar">
                            <div className="fi-segs" role="group" aria-label="Saring hasil">
                                <button type="button" aria-pressed={saring === "ISSUES_ONLY"} onClick={() => setSaring("ISSUES_ONLY")}>Masalah saja {number.format(masalah)}</button>
                                <button type="button" aria-pressed={saring === "ALL"} onClick={() => setSaring("ALL")}>Semua {number.format(total)}</button>
                                <button type="button" aria-pressed={saring === "MATCH_ONLY"} onClick={() => setSaring("MATCH_ONLY")}>Cocok {number.format(cocok)}</button>
                            </div>
                            <FormField label="Filter status">{(a11y) => <select {...a11y} className="fi-input" value={saring} onChange={(e) => setSaring(e.target.value as Saring)}>
                                <option value="ISSUES_ONLY">Hanya bermasalah</option><option value="ALL">Semua status</option><option value="MATCH_ONLY">Hanya cocok</option>
                                {statuses.filter((s) => s !== "MATCH").map((s) => <option key={s} value={s}>{statusLabel(s, principal)} ({number.format(count(s))})</option>)}
                            </select>}</FormField>
                        </div>
                    </div>
                    <ResponsiveTable<Row> title="Hasil rekonsiliasi" count={rows.length} columns={kolom} rows={rows} rowKey={(r) => `${dokumen(r)}|${produk(r)}|${"transactionClass" in r ? r.transactionClass : r.customerCode}|${r.status}`}
                        empty={{ title: masalah === 0 && saring === "ISSUES_ONLY" ? "Semua data cocok" : "Tidak ada hasil untuk saringan ini", message: masalah === 0 && saring === "ISSUES_ONLY" ? `Seluruh ${number.format(total)} baris cocok.` : "Ubah saringan status." }}
                        mobileItem={(r) => <ListItem doc={dokumen(r)} title={produk(r)} meta={penyebab(r).join(" · ")} badge={<StatusBadge tone={statusTone(r.status)}>{statusLabel(r.status, principal)}</StatusBadge>} />} />
                    <div className="fi-sect-in"><p className="fi-small fi-subtle">Kolom kelas transaksi, peringatan, pajak/total, dan baris sumber ikut di Ekspor XLSX.</p></div>
                </Section>
            )}

            <Section id="riwayat" title="Riwayat run" subtitle="20 per halaman" className="fi-region-riwayat">
                <div role="region" aria-label="Riwayat rekonsiliasi">
                    {riwayat.status === "memuat" && !riwayat.data ? <div className="fi-sect-in"><Skeleton rows={3} label="Memuat riwayat" /></div>
                        : riwayat.status === "galat" && !riwayat.data ? <div className="fi-sect-in"><ErrorState title="Riwayat belum termuat" message={riwayat.error} onRetry={muatRiwayat} /></div>
                        : !riwayat.data?.length ? <EmptyState title={`Belum pernah dijalankan untuk ${labelJenis} ${principal}`} message={`Pilih ${config.inputs.length} berkas di atas. Hasil dan riwayat run muncul di sini.`} />
                        : (
                            <>
                                {riwayat.status === "galat" && <div className="fi-sect-in"><MessageStrip tone="neg" title="Gagal memuat ulang riwayat.">{riwayat.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={muatRiwayat}>Coba lagi</Button></MessageStrip></div>}
                                <ul className="fi-hist">
                                    {riwayat.data.map((run) => {
                                        const tot = Object.values(run.summary ?? {}).reduce((a, b) => a + b, 0); const match = run.summary?.MATCH ?? 0;
                                        const v = versiDari(run.mappingVersionId); const [label, tone] = HIST_STATUS[run.status];
                                        return (
                                            <li key={run.id}>
                                                <time dateTime={run.startedAt}>{jamWita(run.startedAt)}</time>
                                                <span><b>{run.uploadedByName}</b> · <span>{v ? `Versi ${v}` : "Versi tidak tersedia"}</span> · <StatusBadge tone={tone}>{label}</StatusBadge></span>
                                                <span className="fi-chg">{run.inputFiles.map((f) => f.name).join(", ")} · {run.durationMs === null ? "Durasi -" : `${number.format(run.durationMs / 1000)} detik`} · <span>Total {tot}</span> · <span>Cocok {match}</span> · <span>Masalah {tot - match}</span></span>
                                                {(run.error || run.issues?.length) ? (
                                                    <details className="fi-chg"><summary aria-label={`Lihat rincian ${run.id}`} style={{ cursor: "pointer" }}>Lihat penyebab</summary>
                                                        {run.error && <p>{run.error}</p>}
                                                        {run.issues?.map((issue, i) => <div key={`${run.id}-${i}`}><b>{statusLabel(issue.status as UiStatus, principal)}</b><ul style={{ paddingLeft: "1rem" }}>{penyebab(issue).map((c) => <li key={c}>{c}</li>)}</ul></div>)}
                                                    </details>
                                                ) : null}
                                            </li>
                                        );
                                    })}
                                </ul>
                                <div className="fi-sect-in fi-page-bar">
                                    <Button aria-label="Halaman sebelumnya" disabled={histPage === 1} onClick={() => setHistPage((p) => Math.max(1, p - 1))}>Sebelumnya</Button>
                                    <span className="fi-small fi-subtle">Halaman {histPage}</span>
                                    <Button aria-label="Halaman berikutnya" disabled={(riwayat.data?.length ?? 0) < 20} onClick={() => setHistPage((p) => p + 1)}>Berikutnya</Button>
                                </div>
                            </>
                        )}
                </div>
            </Section>

            {bolehJalankan && (
                <FooterToolbar message={siap ? (mappingFile ? <span className="fi-sum"><b>{nBerkas} berkas siap</b> · mapping baru belum aktif</span> : undefined) : `Pilih ${config.inputs.length - nBerkas} berkas lagi`}>
                    <Button variant="primary" icon={<GitCompareArrows className="fi-icon" aria-hidden />} busy={berjalan} disabled={!siap} disabledReason={`Pilih ${config.inputs.length} berkas dulu`} onClick={jalankan}>{berjalan ? "Berjalan…" : hasil ? "Jalankan ulang" : "Jalankan rekonsiliasi"}</Button>
                </FooterToolbar>
            )}

            <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title={`Aktifkan mapping baru untuk ${labelJenis} ${principal}?`} tag="Semua pengguna" confirmLabel="Aktifkan mapping" onConfirm={aktifkanMapping}
                description={<MessageStrip tone="warn" title="Berlaku untuk semua pengguna">yang merekonsiliasi {labelJenis} {principal}, bukan hanya Anda.</MessageStrip>}
                facts={[
                    ["Sekarang", mapping.data?.active ? `v${mapping.data.active.version} · ${mapping.data.active.originalName} · ${mapping.data.active.uploadedByName}` : "Belum ada mapping aktif"],
                    ["Menjadi", mappingFile ? `${mappingFile.name} · ${fileSize(mappingFile.size)}` : ""],
                    ["Riwayat run", "Tetap tercatat dengan versi mapping saat dijalankan"],
                ]} />
        </div>
    );
}
