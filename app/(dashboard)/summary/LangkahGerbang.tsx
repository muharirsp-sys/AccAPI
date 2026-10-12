/*
 * Tujuan: Langkah berikutnya setelah Summary terbit (Fiori S4a): daftar SEMUA publikasi Summary, simulasi atas faktur nyata (tidak menulis),
 *   bukti tanda tangan, pernyataan program benar (dialog), dan Muat ke gerbang faktur (dialog). Dipindah dari Aturan Promo › Tarik dari Summary.
 * Caller: app/(dashboard)/summary/Summary.tsx.
 * Dependensi: GET|POST /api/promo-rule/from-summary, GET|POST /api/promo-rule/approval; components/fiori/*; lib/promo-ui.
 * Main Functions: LangkahGerbang, Terbit (tipe).
 * Side Effects: HTTP; Muat menulis `promo_rule` irisan surat itu; persetujuan menulis promo_letter_approval. Simulasi tidak menulis apa pun.
 *
 * Hanya publikasi yang muncul: menerbitkan adalah satu-satunya tempat seseorang menyatakan sudah memeriksa surat, dan gerbang yang menahan
 * faktur tidak boleh menerima yang belum diperiksa. Program yang tidak bisa dinyatakan utuh ditolak beserta sebabnya, bukan dimuat separuh.
 */

import { useState } from "react";
import { FlaskConical, ShieldCheck, Upload } from "lucide-react";
import { Button, KeyValues, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge, VariantNote, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, type Load } from "@/components/fiori/interactive";
import { jamWita } from "@/lib/rekapan-nota/ui";
import { BEBAN, bebanDari, manfaat, tgl } from "@/lib/promo-ui";

export type Terbit = {
    draft_id: string; title: string; published_at: string; surat_program: string; principal: string; nama_program: string; kelompok: string;
    period: { start?: string; end?: string }; programs: number; codes: string[]; sudahDimuat: boolean;
};
type Simulasi = {
    ok: boolean; suratProgram: string; ruleCount: number;
    groups: { promoGroup: string; benefitType: string; benefitValue: string; benefitBeban: string; tierNo: number; triggerQty: string; triggerUnit: string;
        periodStart: string; periodEnd: string; channel: string; outletList: string; outletListMode: string; itemCodes: string[] }[];
    refused: string[]; notes: string[]; warnings: string[];
    trial: { lines: number; explained: number; noDiscount: number; unexplained: { soNo: string; itemCode: string; percent: number; reason: string }[] };
};
type Persetujuan = { dicentang: boolean; dicentangOleh: string; dicentangPada: string | null; catatan: string; buktiNama: string; buktiUkuran: number; buktiOleh: string; buktiPada: string | null };
type Laporan = { tone: "pos" | "warn" | "neg"; judul: string; rincian: string[] };

export default function LangkahGerbang({ publikasi, muatUlang, draftAktif, bolehUbah }: { publikasi: Load<Terbit[]>; muatUlang: () => void; draftAktif?: string; bolehUbah: boolean }) {
    const [buka, setBuka] = useState<{ entry: Terbit; sim: Simulasi; setuju: Persetujuan } | null>(null);
    const [catatan, setCatatan] = useState("");
    const [sibuk, setSibuk] = useState<string | null>(null);
    const [dialog, setDialog] = useState<"nyatakan" | "muat" | null>(null);
    const [laporan, setLaporan] = useState<Laporan | null>(null);
    const daftar = publikasi.data ?? [];
    const urut = draftAktif ? [...daftar].sort((a, b) => Number(b.draft_id === draftAktif) - Number(a.draft_id === draftAktif)) : daftar;

    /** `jagaLaporan`: dipanggil sesudah aksi tulis — pesan hasil aksi itu tidak boleh terhapus. */
    async function simulasikan(entry: Terbit, jagaLaporan = false) {
        setSibuk(`sim-${entry.draft_id}`); if (!jagaLaporan) setLaporan(null);
        try {
            const res = await fetch(`/api/promo-rule/from-summary?simulate=${encodeURIComponent(entry.draft_id)}`);
            const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; simulasi: Simulasi; persetujuan: Persetujuan };
            if (!res.ok || !body.ok) throw new Error(body.error ?? "Simulasi gagal");
            setBuka({ entry, sim: body.simulasi, setuju: body.persetujuan });
            setCatatan(body.persetujuan?.catatan ?? "");
        } catch (e) {
            setLaporan({ tone: "neg", judul: e instanceof Error ? e.message : "Simulasi gagal", rincian: [] });
        } finally {
            setSibuk(null);
        }
    }

    /** Centang dan/atau unggah bukti; satu pintu karena dikerjakan dalam satu duduk. */
    async function setujui(entry: Terbit, opsi: { centang?: boolean; file?: File | null }) {
        const form = new FormData();
        form.append("draftId", entry.draft_id); form.append("suratProgram", entry.surat_program); form.append("principal", entry.principal); form.append("note", catatan);
        if (opsi.centang !== undefined) form.append("confirmed", String(opsi.centang));
        if (opsi.file) form.append("file", opsi.file);
        const res = await fetch("/api/promo-rule/approval", { method: "POST", body: form });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !body.ok) throw new Error(body.error ?? "Gagal menyimpan persetujuan");
        setLaporan({ tone: "pos", judul: opsi.file ? `Bukti “${opsi.file.name}” tersimpan.` : opsi.centang ? "Program dinyatakan benar." : "Pernyataan dicabut.", rincian: [] });
        setDialog(null);
        await simulasikan(entry, true);
    }

    async function unggahBukti(entry: Terbit, file: File) {
        setSibuk("bukti");
        try { await setujui(entry, { file }); } catch (e) { setLaporan({ tone: "neg", judul: e instanceof Error ? e.message : String(e), rincian: [] }); } finally { setSibuk(null); }
    }

    async function muat(entry: Terbit) {
        const res = await fetch("/api/promo-rule/from-summary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draftId: entry.draft_id }) });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ditolak?: string[]; catatan?: string[]; aturan?: number; suratProgram?: string; outlet?: number };
        // Yang DITOLAK tetap diperlihatkan meski pemuatannya gagal: sebabnya itulah yang harus diperbaiki.
        const rincian = [...(body.ditolak ?? []), ...(body.catatan ?? [])];
        if (!res.ok || !body.ok) { setDialog(null); setLaporan({ tone: "neg", judul: body.error ?? "Gagal memuat", rincian }); return; }
        setDialog(null);
        setLaporan({ tone: rincian.length ? "warn" : "pos", judul: `${body.aturan} aturan surat ${body.suratProgram} dimuat ke gerbang faktur${body.outlet ? `; ${body.outlet} outlet peserta ikut dimuat` : ""}.`, rincian });
        muatUlang();
        await simulasikan(entry, true);
    }

    const kolom: Column<Terbit>[] = [
        { key: "surat", header: "Surat", cell: (e) => <><span className="fi-mono">{e.surat_program || "tanpa nomor"}</span><span className="fi-sub">{e.principal}</span></> },
        { key: "program", header: "Program", cell: (e) => <>{e.nama_program || e.title}<span className="fi-sub">{e.kelompok}</span></> },
        { key: "periode", header: "Periode", secondary: true, cell: (e) => <span className="fi-small">{tgl(e.period?.start) || "—"} – {tgl(e.period?.end) || "—"}</span> },
        { key: "isi", header: "Isi", secondary: true, cell: (e) => <span className="fi-small">{e.programs} program · {e.codes.length} barang</span> },
        { key: "status", header: "Gerbang faktur", cell: (e) => e.sudahDimuat ? <StatusBadge tone="pos">Dimuat</StatusBadge> : <StatusBadge tone="neu">Belum dimuat</StatusBadge> },
        { key: "aksi", header: "", cell: (e) => <Button variant="tertiary" icon={<FlaskConical className="fi-icon" aria-hidden />} busy={sibuk === `sim-${e.draft_id}`} onClick={() => void simulasikan(e)}>{buka?.entry.draft_id === e.draft_id ? "Muat ulang simulasi" : "Simulasikan"}</Button> },
    ];

    const s = buka?.sim; const st = buka?.setuju;
    // Status dimuat dibaca dari daftar publikasi terbaru, bukan dari salinan saat simulasi dibuka.
    const entri = buka ? daftar.find((p) => p.draft_id === buka.entry.draft_id) ?? buka.entry : undefined;
    const siapMuat = Boolean(st?.dicentang && st?.buktiNama);

    return (
        <Section id="gerbang" title="Langkah berikutnya: masuk gerbang faktur" subtitle="terbit dipakai order; gerbang faktur dan Rekap baru berubah setelah disetujui dan dimuat">
            {laporan && <div className="fi-sect-in"><MessageStrip tone={laporan.tone} title={laporan.judul} onClose={() => setLaporan(null)}>{laporan.rincian.length ? <ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>{laporan.rincian.slice(0, 20).map((x) => <li key={x}>{x}</li>)}</ul> : null}</MessageStrip></div>}
            {publikasi.status === "memuat" && !publikasi.data ? <div className="fi-sect-in"><Skeleton rows={3} label="Memuat publikasi" /></div> : (
                <ResponsiveTable<Terbit> title="Publikasi Summary" count={daftar.length} columns={kolom} rows={urut} rowKey={(e) => e.draft_id} status={publikasi.status} error={publikasi.error} onRetry={muatUlang}
                    empty={{ title: "Belum ada publikasi Summary", message: "Terbitkan draf di atas; setelah itu ia muncul di sini untuk disetujui dan dimuat." }}
                    mobileItem={(e) => <ListItem doc={e.surat_program || "tanpa nomor"} title={e.nama_program || e.title} meta={`${e.programs} program · ${e.codes.length} barang`} badge={e.sudahDimuat ? <StatusBadge tone="pos">Dimuat</StatusBadge> : undefined} onClick={() => void simulasikan(e)} />} />
            )}
            {buka && s && st && (
                <div className="fi-sect-in" style={{ borderTop: "1px solid var(--line)" }}>
                    <h3 className="fi-title-3">Simulasi {buka.entry.surat_program || buka.entry.title} <span className="fi-small fi-subtle">· tidak menulis apa pun</span></h3>
                    {s.warnings.map((w) => <MessageStrip key={w} tone="warn">{w}</MessageStrip>)}
                    {s.notes.length > 0 && <MessageStrip tone="info" title="Catatan:"><ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>{s.notes.map((n) => <li key={n}>{n}</li>)}</ul></MessageStrip>}
                    <div className="fi-kcards">
                        <div className="fi-kc"><span>Akan jadi aturan</span><b>{s.ruleCount}</b><small>{s.groups.length} bentuk berbeda</small></div>
                        <div className="fi-kc"><span>Diuji atas faktur nyata</span><b>{s.trial.lines}</b><small>{s.trial.explained} potongan dijelaskan</small></div>
                        <div className="fi-kc" data-tone={s.trial.unexplained.length ? "warn" : undefined}><span>Potongan tidak dijelaskan</span><b>{s.trial.unexplained.length}</b><small>{s.trial.noDiscount} baris memang tanpa potongan</small></div>
                    </div>
                    {s.groups.length > 0 && (
                        <div className="fi-tablescroll"><table className="fi-table"><caption className="sr-only">Aturan hasil simulasi</caption>
                            <thead><tr>{["Kelompok", "Potongan", "Beban", "Ambang", "Berlaku", "Batasan", "Barang"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
                            <tbody>{s.groups.map((g, i) => (
                                <tr key={i}>
                                    <td>{g.promoGroup}</td>
                                    <td className="fi-tnum">{manfaat(g.benefitType, g.benefitValue)}<span className="fi-sub">tingkat {g.tierNo}</span></td>
                                    <td><StatusBadge tone={BEBAN[bebanDari(g.benefitBeban)].tone}>{BEBAN[bebanDari(g.benefitBeban)].label}</StatusBadge></td>
                                    <td className="fi-tnum">{Number(g.triggerQty) > 0 ? `${Number(g.triggerQty).toLocaleString("id-ID")} ${g.triggerUnit}` : "tanpa syarat"}</td>
                                    <td className="fi-small">{tgl(g.periodStart)} – {tgl(g.periodEnd)}</td>
                                    <td className="fi-small">{g.channel || "semua channel"}{g.outletList && <span className="fi-sub">{g.outletListMode === "EXCLUDE" ? "kecuali" : "hanya"} {g.outletList}</span>}</td>
                                    <td className="fi-tnum">{g.itemCodes.length || "—"}</td>
                                </tr>))}</tbody>
                        </table></div>
                    )}
                    {s.refused.length > 0 && <MessageStrip tone="warn" title={`${s.refused.length} program ditolak:`}><ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>{s.refused.map((r) => <li key={r}>{r}</li>)}</ul></MessageStrip>}
                    {s.trial.unexplained.length > 0 && (
                        <details className="fi-small"><summary style={{ cursor: "pointer" }}>{s.trial.unexplained.length} baris nyata berpotongan yang tidak dijelaskan aturan ini</summary>
                            <ul style={{ paddingLeft: "1rem" }}>{s.trial.unexplained.slice(0, 30).map((u, i) => <li key={i}><span className="fi-mono">{u.soNo}</span> {u.itemCode} — {u.reason}</li>)}</ul>
                        </details>
                    )}
                    <KeyValues items={[
                        ["Simulasi atas faktur nyata", "Sudah dilihat di atas"],
                        ["Bukti tanda tangan OM dan tim (PDF)", st.buktiNama ? <a href={`/api/promo-rule/approval?draftId=${encodeURIComponent(buka.entry.draft_id)}&file=1`}>{st.buktiNama} ({Math.round(st.buktiUkuran / 1024)} KB) · {st.buktiOleh}</a> : <span className="fi-why">belum ada</span>],
                        ["Pernyataan program benar", st.dicentang ? `dinyatakan ${st.dicentangOleh}${st.dicentangPada ? ` · ${jamWita(st.dicentangPada)}` : ""}` : <span className="fi-why">belum</span>],
                    ]} />
                    {bolehUbah && (
                        <div className="fi-btnrow">
                            <label className={`fi-btn fi-btn--secondary${sibuk === "bukti" ? " fi-busy" : ""}`}><Upload className="fi-icon" aria-hidden />{st.buktiNama ? "Ganti bukti bertanda tangan" : "Unggah bukti bertanda tangan (PDF)"}<input type="file" accept=".pdf" className="sr-only" disabled={sibuk === "bukti"} onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ""; if (f) void unggahBukti(buka.entry, f); }} /></label>
                            <Button icon={<ShieldCheck className="fi-icon" aria-hidden />} onClick={() => setDialog("nyatakan")}>{st.dicentang ? "Cabut pernyataan…" : "Nyatakan program benar…"}</Button>
                            <Button variant="primary" disabled={!siapMuat} disabledReason="Lengkapi bukti tanda tangan dan pernyataan" onClick={() => setDialog("muat")}>{entri?.sudahDimuat ? "Muat ulang ke gerbang faktur…" : "Muat ke gerbang faktur…"}</Button>
                        </div>
                    )}
                    <VariantNote bl="BL-53">Hari ini pernyataan boleh dibuat siapa pun yang berizin ubah Summary, termasuk penerbitnya sendiri. Usulan: maker-checker lunak — oleh orang lain, atau oleh penerbit dengan alasan tercatat.</VariantNote>
                </div>
            )}

            {buka && st && (
                <ConfirmDialog open={dialog === "nyatakan"} onClose={() => setDialog(null)} tag={st.dicentang ? "Cabut" : "Pernyataan"}
                    title={st.dicentang ? `Cabut pernyataan program ${buka.entry.surat_program}?` : `Nyatakan program ${buka.entry.surat_program} sudah benar?`}
                    confirmLabel={st.dicentang ? "Cabut pernyataan" : "Nyatakan benar"} onConfirm={() => setujui(buka.entry, { centang: !st.dicentang })}
                    facts={st.dicentang ? [["Akibat", "Muat ke gerbang faktur terkunci lagi sampai dinyatakan ulang"]] : [["Aturan", `${s?.ruleCount ?? 0} aturan · ${s?.trial.unexplained.length ?? 0} potongan tidak dijelaskan`], ["Tercatat", "Nama Anda dan jam saat ini"]]}>
                    {!st.dicentang && <FormField label="Catatan" help="Opsional, mis. siapa yang memeriksa atau apa yang dikonfirmasi ke principal.">{(a11y) => <input {...a11y} className="fi-input" value={catatan} onChange={(e) => setCatatan(e.target.value)} />}</FormField>}
                </ConfirmDialog>
            )}
            {buka && (
                <ConfirmDialog open={dialog === "muat"} onClose={() => setDialog(null)} tag="Gerbang faktur" title={`Muat ${s?.ruleCount ?? 0} aturan ${buka.entry.surat_program} ke gerbang faktur?`}
                    confirmLabel={entri?.sudahDimuat ? "Muat ulang" : "Muat aturan"} onConfirm={() => muat(buka.entry)}
                    description={entri?.sudahDimuat ? <MessageStrip tone="warn" title="Surat ini sudah pernah dimuat.">Muat ulang MENGGANTI aturan dari surat ini; aturan dari Excel, tarif outlet, dan yang diketik tangan tidak tersentuh. Aturan surat yang diubah manual membuat muat ulang gagal.</MessageStrip> : undefined}
                    facts={[["Aturan", String(s?.ruleCount ?? 0)], ["Ditolak", s?.refused.length ? `${s.refused.length} program (tidak dimuat)` : "Tidak ada"], ["Berlaku", "Gerbang faktur, Rekap promo, dan Normalisasi diskon memakainya mulai sekarang"]]} />
            )}
        </Section>
    );
}
