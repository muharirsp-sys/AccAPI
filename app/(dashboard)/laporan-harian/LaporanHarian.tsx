/*
 * Tujuan: Wizard Laporan Harian (Fiori S3): 1 Unggah export Accurate → 2 Tinjau hasil → 3 Penerima → 4 Kirim (di footer),
 *   plus Riwayat kirim (Kirim ulang untuk run gagal; run macet berlabel BL-29). Dialog Kirim menggantikan window.confirm.
 * Caller: app/(dashboard)/laporan-harian/page.tsx.
 * Dependensi: POST /api/laporan-harian/upload, GET /api/laporan-harian/[runId]/preview, POST /api/laporan-harian/[runId]/send,
 *   GET /api/laporan-harian/runs; components/fiori/{core,interactive}; lib/laporan-harian/ui.
 * Main Functions: LaporanHarian.
 * Side Effects: HTTP unggah/baca/kirim email. Logic BL-29/58 tidak ditulis (varian berlabel).
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Download, FileSearch, FileSpreadsheet, Send, Upload, Users } from "lucide-react";
import {
    Button, ErrorState, Flow, FooterToolbar, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge, VariantNote,
    type Column, type FlowStep,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad } from "@/components/fiori/interactive";
import { ambil, jamWita, tanggalPanjang, tanggalPendek } from "@/lib/rekapan-nota/ui";
import { modeDariNote, rupiah, statusRun } from "@/lib/laporan-harian/ui";

type Summary = { spv: string; rows: number; dpp: number; ao: number; ec: number; ia: number };
type Recipient = { keyword: string; groupType: string; fileName: string; emails: string[] };
type GeneratedFile = { keyword: string; groupType: string; fileName: string; rows: number; stockRows: number };
type ReviewSample = { fileName: string; sheetName: string; columns: string[]; rows: unknown[][] };
type UploadResult = {
    ok: boolean; runId: string; reportDate: string; period: { month: number; year: number };
    dashboardFed: { inserted: number }; incentiveFeed: { progressKeys: number; targetKeys: number; matchedKeys: number; unmatchedKeys: number; ready: boolean };
    salesRows: number; netDpp: number; summary: Summary[]; recipientsPreview: Recipient[]; totalRecipients: number; generatedFiles: GeneratedFile[];
    unmatchedReportKeywords?: string[]; unmappedProgress?: { rows: number; achievedValueDpp: number; branches: string[] };
    toFormatFileName?: string | null; archiveFileName?: string | null;
    manager?: { fileName: string; previewFileName: string; rows: number; missingTargets: boolean } | null;
};
type Run = { id: string; reportDate: string; status: string; fileCount: number; emailCount: number; note: string | null; createdAt: string; uploadedBy: string | null; penerima: Record<string, number> };
type RecipientRow = Recipient & { email: string; key: string };
type SendResult = { status: string; emailsSent?: number; emailsFailed?: number; emailsSkipped?: number };

const recipientKey = (fileName: string, email: string) => `${fileName}\u0000${email.trim().toLowerCase()}`;
const n = (v: number) => v.toLocaleString("id-ID");

async function readJson<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!text) throw new Error(`Server tidak mengirim respons (HTTP ${response.status})`);
    try { return JSON.parse(text) as T; } catch { throw new Error(`Respons server bukan JSON (HTTP ${response.status})`); }
}

function reviewValue(value: unknown, column: string): string {
    if (value === null || value === undefined || value === "") return "–";
    if (column === "DPP" && Number.isFinite(Number(value))) return rupiah(Number(value));
    if (column === "QTY" && Number.isFinite(Number(value))) return n(Number(value));
    return String(value);
}

function FilePick({ id, label, help, required, file, onChange, disabled }: { id: string; label: string; help: string; required?: boolean; file: File | null; onChange: (f: File | null) => void; disabled?: boolean }) {
    return (
        <div className="fi-dropzone" data-ok={file ? "true" : undefined}>
            <label className="fi-label" htmlFor={id}>{label}{required && <span className="fi-req" aria-hidden>*</span>}</label>
            <span>{file ? <><FileSpreadsheet className="fi-icon" aria-hidden style={{ display: "inline", verticalAlign: "-3px" }} /> <b>{file.name}</b></> : help}</span>
            <input id={id} className="fi-input" type="file" accept=".xlsx" disabled={disabled} onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
        </div>
    );
}

export default function LaporanHarian({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehUnggah = keys.has("laporan_harian.upload");
    const bolehKirim = keys.has("laporan_harian.send");
    const bolehKelola = keys.has("laporan_harian.manage");

    const [penjualan, setPenjualan] = useState<File | null>(null);
    const [retur, setRetur] = useState<File | null>(null);
    const [stock, setStock] = useState<File | null>(null);
    const [memproses, setMemproses] = useState(false);
    const [galatProses, setGalatProses] = useState<string | null>(null);
    const [hasil, setHasil] = useState<UploadResult | null>(null);
    const [tinjau, setTinjau] = useState<{ fileName: string; status: "memuat" | "siap" | "galat"; data?: ReviewSample; error?: string } | null>(null);
    const [closing, setClosing] = useState(false);
    const [mode, setMode] = useState<"all" | "selected">("all");
    const [pilih, setPilih] = useState<Set<string>>(new Set());
    const [dialog, setDialog] = useState<"kirim" | "kirimUlang" | null>(null);
    const [runUlang, setRunUlang] = useState<Run | null>(null);
    const [hasilKirim, setHasilKirim] = useState<(SendResult & { runId: string }) | null>(null);
    const [pesanRiwayat, setPesanRiwayat] = useState<string | null>(null);
    const [riwayat, muatRiwayat] = useLoad(useCallback(() => ambil<Run[]>("/api/laporan-harian/runs", (j) => (j as { runs: Run[] }).runs), []));

    const penerimaRows: RecipientRow[] = useMemo(() => (hasil?.recipientsPreview ?? []).flatMap((r) => r.emails.map((email) => ({ ...r, email, key: recipientKey(r.fileName, email) }))), [hasil]);
    const terpilih = mode === "all" ? penerimaRows : penerimaRows.filter((r) => pilih.has(r.key));
    const berkasTerpilih = new Set(terpilih.map((r) => r.fileName)).size;
    const dilewati = penerimaRows.length - terpilih.length;
    const sudahDikirim = hasilKirim?.runId === hasil?.runId && hasilKirim?.status === "sent";
    const langkah: FlowStep[] = [
        { label: "Unggah", state: hasil ? "done" : "current" },
        { label: "Tinjau", state: hasil ? (sudahDikirim ? "done" : "current") : "todo" },
        { label: "Penerima", state: hasil ? (sudahDikirim ? "done" : "current") : "todo" },
        { label: "Kirim", state: sudahDikirim ? "done" : hasilKirim?.runId === hasil?.runId && hasilKirim ? "late" : "todo" },
    ];

    async function proses() {
        if (!penjualan) return;
        setMemproses(true); setGalatProses(null); setHasil(null); setHasilKirim(null); setTinjau(null); setMode("all"); setClosing(false);
        try {
            const form = new FormData();
            form.append("penjualan", penjualan);
            if (retur) form.append("retur", retur);
            if (stock) form.append("stock", stock);
            const res = await fetch("/api/laporan-harian/upload", { method: "POST", body: form });
            const data = await readJson<UploadResult & { error?: string; detail?: string }>(res);
            if (!res.ok || !data.ok) { setGalatProses([data.error, data.detail].filter(Boolean).join(": ") || "Pengolahan gagal."); return; }
            setHasil(data);
            setPilih(new Set(data.recipientsPreview.flatMap((r) => r.emails.map((e) => recipientKey(r.fileName, e)))));
            muatRiwayat();
        } catch (e) {
            setGalatProses(`Pengolahan gagal: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setMemproses(false);
        }
    }

    async function muatTinjau(fileName: string) {
        if (!hasil || !fileName) return;
        setTinjau({ fileName, status: "memuat" });
        try {
            const res = await fetch(`/api/laporan-harian/${hasil.runId}/preview?file=${encodeURIComponent(fileName)}`);
            const data = await readJson<ReviewSample & { error?: string }>(res);
            if (!res.ok) { setTinjau({ fileName, status: "galat", error: data.error || "Tinjauan berkas gagal dimuat." }); return; }
            setTinjau({ fileName, status: "siap", data });
        } catch (e) {
            setTinjau({ fileName, status: "galat", error: e instanceof Error ? e.message : String(e) });
        }
    }

    /** Kirim run yang baru diproses (pilihan penerima dari langkah 3) atau kirim ulang run gagal dari riwayat. */
    async function kirim(runId: string, body: Record<string, unknown>) {
        const res = await fetch(`/api/laporan-harian/${runId}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, ...body }) });
        const data = await readJson<SendResult & { error?: string }>(res);
        if (!res.ok) throw new Error(data.error || `Pengiriman gagal (HTTP ${res.status}).`);
        setDialog(null); setRunUlang(null);
        setHasilKirim({ ...data, runId });
        if (runId !== hasil?.runId) setPesanRiwayat(`Kirim ulang selesai: ${n(data.emailsSent ?? 0)} terkirim${data.emailsFailed ? `, ${n(data.emailsFailed)} gagal` : ""}.`);
        muatRiwayat();
    }

    const unduh = (fileName: string) => `/api/laporan-harian/${hasil?.runId}/preview?file=${encodeURIComponent(fileName)}&download=1`;
    const kolomSpv: Column<Summary>[] = [
        { key: "spv", header: "SPV", cell: (r) => <b>{r.spv}</b> },
        { key: "rows", header: "Baris", align: "end", cell: (r) => <span className="fi-tnum">{n(r.rows)}</span> },
        { key: "dpp", header: "DPP", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(r.dpp)}</span> },
        { key: "ao", header: "AO", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{n(r.ao)}</span> },
        { key: "ec", header: "EC", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{n(r.ec)}</span> },
        { key: "ia", header: "Item aktif", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{n(r.ia)}</span> },
    ];
    const kolomPenerima: Column<RecipientRow>[] = [
        { key: "file", header: "Berkas", cell: (r) => <span className="fi-mono fi-small">{r.fileName}</span> },
        { key: "target", header: "Target", cell: (r) => <b>{r.keyword} · {r.groupType.toUpperCase()}</b> },
        { key: "email", header: "Email", cell: (r) => r.email },
    ];
    const kolomRun: Column<Run>[] = [
        { key: "tgl", header: "Tanggal laporan", cell: (r) => <b>{tanggalPendek(r.reportDate)}</b> },
        { key: "unggah", header: "Diunggah", secondary: true, cell: (r) => `${jamWita(r.createdAt)}${r.uploadedBy ? ` · ${r.uploadedBy}` : ""}` },
        { key: "n", header: "Berkas / email", align: "end", cell: (r) => <span className="fi-tnum">{r.fileCount} / {r.emailCount}</span> },
        { key: "status", header: "Status", cell: (r) => { const s = statusRun(r.status, r.createdAt); return <StatusBadge tone={s.tone}>{s.label}</StatusBadge>; } },
        { key: "cat", header: "Catatan", secondary: true, cell: (r) => <span className="fi-small">{catatanRun(r)}</span> },
        { key: "aksi", header: bolehKirim ? "Tindakan" : "", cell: (r) => bolehKirim && r.status === "failed" ? <Button onClick={() => { setRunUlang(r); setDialog("kirimUlang"); }}>Kirim ulang…</Button> : null },
    ];
    const catatanRun = (r: Run) => {
        const p = r.penerima; const m = modeDariNote(r.note);
        const bagian = [p.sent ? `${p.sent} terkirim` : "", p.failed ? `${p.failed} gagal` : "", p.skipped ? `${p.skipped} dilewati` : "", p.pending && r.status !== "dry_run" ? `${p.pending} tertunda` : "", m === "closing" ? "closing" : ""].filter(Boolean);
        return bagian.join(" · ") || "—";
    };
    const macet = (riwayat.data ?? []).some((r) => statusRun(r.status, r.createdAt).kode === "macet");
    const gagalPenerima = runUlang ? (runUlang.penerima.failed ?? 0) + (runUlang.penerima.pending ?? 0) : 0;

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Operasional Sales</span></li><li><span aria-current="page">Laporan Harian</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>{hasil ? `Laporan harian · data ${tanggalPanjang(hasil.reportDate)}` : "Laporan harian"}</h1>
                    {hasil && (sudahDikirim ? <StatusBadge tone="pos">Terkirim</StatusBadge> : hasilKirim?.runId === hasil.runId && hasilKirim?.emailsFailed ? <StatusBadge tone="neg">{hasilKirim.emailsFailed} email gagal</StatusBadge> : <StatusBadge tone="neu">Belum dikirim</StatusBadge>)}
                    <span className="fi-spacer" />
                    {bolehKelola && <Link href="/laporan-harian/mapping" className="fi-btn fi-btn--secondary"><Users className="fi-icon" aria-hidden />Penerima laporan</Link>}
                </div>
                <p>Unggah export Accurate, tinjau hasilnya, pilih penerima, lalu kirim. Tanggal laporan diambil dari tanggal penjualan terakhir di berkas.</p>
                <Flow steps={langkah} label="Langkah laporan" />
            </header>

            {pesanRiwayat && <MessageStrip tone={pesanRiwayat.includes("gagal") ? "warn" : "pos"} title={pesanRiwayat} onClose={() => setPesanRiwayat(null)} />}
            {galatProses && <MessageStrip tone="neg" title="Pengolahan gagal." onClose={() => setGalatProses(null)}>{galatProses} Dashboard dan progres insentif tidak berubah.</MessageStrip>}
            {memproses && <MessageStrip tone="info" title={`Mengolah ${[penjualan, retur, stock].filter(Boolean).length} berkas…`}>Biasanya 30–60 detik. Setelah selesai, dashboard dan progres insentif langsung diperbarui; email baru terkirim di langkah Kirim.</MessageStrip>}
            {hasilKirim && hasil && hasilKirim.runId === hasil.runId && (
                hasilKirim.emailsFailed
                    ? <MessageStrip tone="warn" title={`${n(hasilKirim.emailsSent ?? 0)} dari ${n((hasilKirim.emailsSent ?? 0) + hasilKirim.emailsFailed)} email terkirim.`}>{hasilKirim.emailsFailed} gagal; periksa SMTP lalu Kirim ulang dari riwayat.</MessageStrip>
                    : <MessageStrip tone="pos" title={`${n(hasilKirim.emailsSent ?? 0)} email terkirim.`}>{hasilKirim.emailsSkipped ? `${hasilKirim.emailsSkipped} penerima dilewati.` : ""}</MessageStrip>
            )}

            <Section title="1 · Unggah export Accurate" subtitle={hasil ? "berkas sudah diproses; unggah lagi untuk run baru" : "Penjualan wajib; retur dan stock opsional"}>
                <div className="fi-sect-in">
                    {memproses ? <Skeleton rows={3} label="Mengolah berkas" /> : (
                        <div className="fi-kcards">
                            <FilePick id="laporan-penjualan" label="Penjualan (INV)" help="Rincian faktur penjualan · .xlsx · wajib" required file={penjualan} onChange={setPenjualan} disabled={!bolehUnggah} />
                            <FilePick id="laporan-retur" label="Retur (RJN)" help="Rincian retur penjualan · .xlsx · opsional" file={retur} onChange={setRetur} disabled={!bolehUnggah} />
                            <FilePick id="laporan-stock" label="Stock" help="Kuantitas barang per gudang · .xlsx · opsional" file={stock} onChange={setStock} disabled={!bolehUnggah} />
                        </div>
                    )}
                    {!hasil && !memproses && <p className="fi-small fi-subtle">Memproses langsung memperbarui dashboard dan progres insentif. Email baru terkirim di langkah terakhir.</p>}
                </div>
            </Section>

            {hasil && (
                <>
                    <Section id="tinjau" title="2 · Tinjau hasil" subtitle="dashboard dan progres insentif sudah diperbarui saat diproses">
                        <div className="fi-sect-in">
                            <div className="fi-kcards">
                                <div className="fi-kc"><span>Periode</span><b>{hasil.period.month}/{hasil.period.year}</b><small>data sampai {tanggalPendek(hasil.reportDate)}</small></div>
                                <div className="fi-kc"><span>Baris penjualan</span><b>{n(hasil.salesRows)}</b><small>baris INV</small></div>
                                <div className="fi-kc"><span>Net DPP</span><b className="fi-tnum" style={{ fontSize: "1.25rem" }}>{rupiah(hasil.netDpp)}</b><small>bulan berjalan</small></div>
                                <div className="fi-kc"><span>Progres tersimpan</span><b>{n(hasil.dashboardFed.inserted)}</b><small>baris ke dashboard insentif</small></div>
                            </div>
                            {hasil.incentiveFeed.ready
                                ? <MessageStrip tone="pos" title="Pencapaian tersambung ke Insentif Sales.">{n(hasil.incentiveFeed.matchedKeys)} dari {n(hasil.incentiveFeed.progressKeys)} kombinasi salesman dan principal cocok dengan target.</MessageStrip>
                                : <MessageStrip tone="warn" title="Pencapaian tersimpan, tetapi target periode belum cocok.">{!hasil.incentiveFeed.targetKeys ? "Target bulan ini masih kosong; unggah target agar pencapaian tampil." : `${n(hasil.incentiveFeed.unmatchedKeys)} kombinasi belum memiliki target.`} <Link href="/insentif-sales">Buka Insentif Sales</Link></MessageStrip>}
                            {!!hasil.unmappedProgress?.rows && <MessageStrip tone="warn" title={`${n(hasil.unmappedProgress.rows)} baris tanpa kode salesman (${rupiah(hasil.unmappedProgress.achievedValueDpp)})`}>tidak ikut progres insentif ({hasil.unmappedProgress.branches.join(", ")}). <Link href="/insentif-sales">Petakan di Insentif Sales</Link></MessageStrip>}
                            {!!hasil.unmatchedReportKeywords?.length && <MessageStrip tone="warn" title={`Berkas ${hasil.unmatchedReportKeywords.join(", ")} tidak punya penerima.`}>Berkas dan emailnya tidak disiapkan. {bolehKelola && <Link href="/laporan-harian/mapping">Tambah di Penerima laporan</Link>}</MessageStrip>}
                        </div>
                        <ResponsiveTable<Summary> title="Ringkasan per SPV" columns={kolomSpv} rows={hasil.summary} rowKey={(r) => r.spv} empty={{ title: "Tidak ada ringkasan SPV" }}
                            mobileItem={(r) => <ListItem doc={r.spv} amount={rupiah(r.dpp)} title={`${n(r.rows)} baris · AO ${n(r.ao)} · EC ${n(r.ec)} · item aktif ${n(r.ia)}`} />} />
                        <div className="fi-sect-in">
                            <div className="fi-page-bar">
                                <FormField label="Tinjau berkas">{(a11y) => <select {...a11y} className="fi-input" value={tinjau?.fileName ?? ""} onChange={(e) => void muatTinjau(e.target.value)}><option value="">Pilih berkas…</option>{hasil.generatedFiles.map((f) => <option key={f.fileName} value={f.fileName}>{f.keyword} · {f.groupType.toUpperCase()} ({n(f.rows)} baris)</option>)}</select>}</FormField>
                                {tinjau?.fileName && <a className="fi-btn fi-btn--secondary" href={unduh(tinjau.fileName)}><Download className="fi-icon" aria-hidden />Unduh Excel</a>}
                                {hasil.manager && <a className="fi-btn fi-btn--secondary" target="_blank" rel="noopener noreferrer" href={`/api/laporan-harian/${hasil.runId}/preview?file=${encodeURIComponent(hasil.manager.previewFileName)}`}><FileSearch className="fi-icon" aria-hidden />Laporan manajer</a>}
                                {hasil.manager && <a className="fi-btn fi-btn--tertiary" href={unduh(hasil.manager.fileName)}><Download className="fi-icon" aria-hidden />Unduh Excel laporan manajer</a>}
                                {hasil.toFormatFileName && <a className="fi-btn fi-btn--tertiary" href={unduh(hasil.toFormatFileName)}><Download className="fi-icon" aria-hidden />Berkas format</a>}
                                {hasil.archiveFileName && <a className="fi-btn fi-btn--tertiary" href={unduh(hasil.archiveFileName)}><Download className="fi-icon" aria-hidden />Unduh semua</a>}
                            </div>
                            {hasil.manager?.missingTargets && <p className="fi-small fi-subtle">Target periode ini belum dimuat; kolom target dan persentase laporan manajer masih kosong.</p>}
                            {tinjau?.status === "memuat" && <Skeleton rows={4} label="Memuat contoh berkas" />}
                            {tinjau?.status === "galat" && <ErrorState title="Tinjauan berkas gagal dimuat" message={tinjau.error} onRetry={() => void muatTinjau(tinjau.fileName)} />}
                            {tinjau?.status === "siap" && tinjau.data && (
                                <div className="fi-tablescroll" style={{ maxHeight: "28rem", overflow: "auto" }}>
                                    <table className="fi-table" style={{ fontSize: "var(--fs-caption)" }}>
                                        <caption className="sr-only">25 baris pertama {tinjau.data.fileName}</caption>
                                        <thead><tr>{tinjau.data.columns.map((c) => <th key={c} scope="col">{c.replaceAll("_", " ")}</th>)}</tr></thead>
                                        <tbody>{tinjau.data.rows.map((row, i) => <tr key={i}>{tinjau.data!.columns.map((c, ci) => <td key={c} title={reviewValue(row[ci], c)}>{reviewValue(row[ci], c)}</td>)}</tr>)}</tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    </Section>

                    <Section id="penerima" title="3 · Penerima" subtitle={`${hasil.generatedFiles.length} berkas · ${n(hasil.totalRecipients)} alamat${mode === "selected" ? ` · ${terpilih.length} dipilih` : ""}`}>
                        <div className="fi-sect-in">
                            <div className="fi-segs" role="group" aria-label="Penerima">
                                <button type="button" aria-pressed={mode === "all"} disabled={sudahDikirim} onClick={() => setMode("all")}>Semua penerima ({n(hasil.totalRecipients)})</button>
                                <button type="button" aria-pressed={mode === "selected"} disabled={sudahDikirim} onClick={() => setMode("selected")}>Pilih tertentu</button>
                            </div>
                            <label className="fi-check"><input type="checkbox" checked={closing} disabled={sudahDikirim} onChange={(e) => setClosing(e.target.checked)} />Laporan closing (mode terkunci setelah kirim pertama)</label>
                            {mode === "selected" && dilewati > 0 && (
                                <>
                                    <MessageStrip tone="warn" title={`${dilewati} penerima yang tidak dipilih akan berstatus dilewati`}>dan tidak bisa dikirim lagi dari run ini.</MessageStrip>
                                    <VariantNote bl="BL-58">Usulan: penerima yang dilewati tetap bisa dikirimi belakangan dari run yang sama, dan kirim kedua untuk tanggal yang sudah terkirim wajib alasan.</VariantNote>
                                </>
                            )}
                        </div>
                        <ResponsiveTable<RecipientRow> title="Penerima email" columns={kolomPenerima} rows={penerimaRows} rowKey={(r) => r.key}
                            selected={mode === "selected" && !sudahDikirim ? pilih : undefined} onSelectedChange={mode === "selected" && !sudahDikirim ? setPilih : undefined}
                            empty={{ title: "Tidak ada penerima yang cocok", message: "Periksa keyword di Penerima laporan." }}
                            mobileItem={(r) => <ListItem doc={mode === "selected" && !sudahDikirim ? <label className="fi-check"><input type="checkbox" aria-label={`Pilih ${r.email}`} checked={pilih.has(r.key)} onChange={() => setPilih((s) => { const x = new Set(s); if (x.has(r.key)) x.delete(r.key); else x.add(r.key); return x; })} />{r.keyword}</label> : r.keyword} title={r.email} meta={r.fileName} />} />
                    </Section>
                </>
            )}

            <Section id="riwayat" title="Riwayat kirim" subtitle={`run per unggahan · run macet lebih dari 10 menit belum bisa dilanjutkan`}>
                <ResponsiveTable<Run> title="Riwayat kirim" columns={kolomRun} rows={riwayat.data ?? []} rowKey={(r) => r.id}
                    status={riwayat.status} error={riwayat.error} onRetry={muatRiwayat}
                    empty={{ title: "Belum ada run laporan", message: "Riwayat terisi setelah berkas pertama diproses." }}
                    mobileItem={(r) => { const s = statusRun(r.status, r.createdAt); return <ListItem doc={tanggalPendek(r.reportDate)} title={`${jamWita(r.createdAt)} · ${r.fileCount} berkas / ${r.emailCount} email`} meta={bolehKirim && r.status === "failed" ? <Button variant="tertiary" onClick={() => { setRunUlang(r); setDialog("kirimUlang"); }}>Kirim ulang…</Button> : catatanRun(r)} badge={<StatusBadge tone={s.tone}>{s.label}</StatusBadge>} />; }} />
                {macet && <div className="fi-sect-in"><VariantNote bl="BL-29">Run berstatus Macet terputus saat mengirim lebih dari 10 menit lalu; hari ini tidak bisa diklaim ulang dari layar. Usulan: tombol Lanjutkan yang mengirim penerima tertunda atau gagal saja.</VariantNote></div>}
            </Section>

            {(bolehUnggah || (hasil && bolehKirim)) && (
                <FooterToolbar message={hasil && bolehKirim && !sudahDikirim ? <span className="fi-sum"><b>{terpilih.length} email</b> · {berkasTerpilih} berkas · {closing ? "Closing" : "Harian"}</span> : penjualan ? undefined : "Pilih berkas penjualan"}>
                    {/* Proses selalu tersedia (run baru dari berkas yang dipilih), seperti halaman lama. */}
                    {bolehUnggah && (
                        <Button variant={hasil && bolehKirim && !sudahDikirim ? "secondary" : "primary"} busy={memproses} disabled={!penjualan} disabledReason="Pilih berkas penjualan dulu" icon={<Upload className="fi-icon" aria-hidden />} onClick={proses}>
                            {memproses ? "Memproses…" : hasil ? "Proses ulang berkas baru" : "Proses dan perbarui dashboard"}
                        </Button>
                    )}
                    {hasil && bolehKirim && !sudahDikirim && (
                        <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={terpilih.length === 0} disabledReason="Pilih minimal satu penerima" onClick={() => setDialog("kirim")}>4 · Kirim {terpilih.length} email…</Button>
                    )}
                </FooterToolbar>
            )}

            {hasil && (
                <ConfirmDialog open={dialog === "kirim"} onClose={() => setDialog(null)} title={`Kirim ${terpilih.length} email laporan ${tanggalPendek(hasil.reportDate)}?`} tag="Kirim" confirmLabel={`Kirim ${terpilih.length} email`}
                    onConfirm={() => kirim(hasil.runId, { isClosing: closing, recipientMode: mode, selectedRecipients: mode === "selected" ? terpilih.map((r) => ({ fileName: r.fileName, email: r.email })) : undefined })}
                    facts={[
                        ["Tanggal laporan", `${tanggalPanjang(hasil.reportDate)} (tanggal penjualan terakhir di berkas)`],
                        ["Mode", `${closing ? "Closing" : "Harian"} · terkunci setelah kirim pertama`],
                        ["Penerima", `${berkasTerpilih} berkas · ${terpilih.length} alamat${dilewati ? `; ${dilewati} dilewati` : ""}${hasil.unmatchedReportKeywords?.length ? `; ${hasil.unmatchedReportKeywords.join(", ")} tidak dikirim` : ""}`],
                        ["Dashboard", "Sudah diperbarui saat diproses; tidak berubah lagi"],
                    ]} />
            )}
            <ConfirmDialog open={dialog === "kirimUlang"} onClose={() => { setDialog(null); setRunUlang(null); }} title={`Kirim ulang ${gagalPenerima} email yang gagal?`} tag="Kirim ulang" confirmLabel={`Kirim ulang ${gagalPenerima} email`}
                onConfirm={() => runUlang ? kirim(runUlang.id, { isClosing: modeDariNote(runUlang.note) === "closing", recipientMode: "all" }) : undefined}
                facts={[
                    ["Run", runUlang ? `Laporan ${tanggalPendek(runUlang.reportDate)} · ${runUlang.penerima.sent ?? 0} terkirim` : ""],
                    ["Dikirim ulang", "Penerima berstatus gagal atau tertunda"],
                    ["Yang sudah terkirim", "Dilewati"],
                ]} />
        </div>
    );
}
