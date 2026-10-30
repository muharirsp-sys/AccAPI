/*
 * Tujuan: Satu siklus Summary Program On Faktur: master principal → baca surat (Mistral, tiga pembaca + penjaga) → jawab peringatan
 *   per baris di samping kutipan surat → pratinjau Form → Setujui (gerbang 0 peringatan, pemilik 28 Okt 2026) → Form final.
 * Caller: app/(dashboard)/summary/program/page.tsx.
 * Dependensi: FastAPI /summary/program/{ekstrak,form,setujui}, /api/principles, /api/summary/manual/master/load_principle (send/csrfHeader
 *   dari ../Summary); components/fiori/*.
 * Main Functions: SummaryProgram.
 * Side Effects: HTTP ke FastAPI (baca surat = Mistral berbayar; setujui menyimpan ingatan bulan berikutnya); membuka PDF Form di tab baru.
 *   Tidak menulis ke Accurate maupun aturan promo.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Check, FileText, ShieldCheck, Upload } from "lucide-react";
import { Button, EmptyState, MessageStrip, ObjectPageHeader, ResponsiveTable, Section, StatusBadge, type Column } from "@/components/fiori/core";
import { FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { resolveApiBase } from "@/lib/apiBase";
import { hariIniWita } from "@/lib/tampil";
import { csrfHeader, send } from "../Summary";

type Flag = { jenis: string; tingkat: "kritis" | "perlu_cek" | "info"; program_id: string | null; rule_id: string | null; pesan: string };
type Komponen = { nama: string; nilai: number; satuan: string; beban: string };
type Rule = {
    rule_id: string; program_id: string;
    barang: { nama_di_surat: string; kode_barang: string[]; kelompok_barang: string; gramasi: string | null };
    ketentuan: { min: number | null; max: number | null; satuan: string | null };
    benefit: { tipe: string; komponen: Komponen[]; bonus: { qty: number; satuan: string } | null; teks_tampilan: string };
    sumber: { halaman: number | null; kutipan: string };
};
type Doc = { principal: string; programs: { program_id: string; no_surat: string; nama_program: string }[]; item_rules: Rule[]; flags: Flag[] };

const API_BASE = resolveApiBase();
const MENAHAN = (f: Flag) => f.tingkat === "kritis" || f.tingkat === "perlu_cek";
const angka = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));

export default function SummaryProgram({ permKeys }: { permKeys: string[] }) {
    const bolehUbah = useMemo(() => new Set(permKeys).has("summary.edit"), [permKeys]);
    const [principles] = useLoad(useCallback(async (): Promise<Load<Record<string, { name: string }>>> => {
        const r = await send("GET", "/api/principles");
        return r.ok ? { status: "siap", data: r.body.principles ?? {} } : { status: "galat", error: r.error };
    }, []));
    const [principal, setPrincipal] = useState("");
    const nama = principles.data?.[principal]?.name ?? "";
    const [token, setToken] = useState("");
    const [surat, setSurat] = useState<File[]>([]);
    const [tanggal, setTanggal] = useState(hariIniWita());
    const [doc, setDoc] = useState<Doc | null>(null);
    const [disetujui, setDisetujui] = useState(false);
    const [sibuk, setSibuk] = useState<string | null>(null);
    const [pesan, setPesan] = useState<{ tone: "pos" | "neg" | "info"; teks: string } | null>(null);
    useUnsavedGuard(Boolean(doc) && !disetujui);

    const tahan = doc?.flags.filter(MENAHAN) ?? [];
    const info = doc?.flags.filter((f) => !MENAHAN(f)) ?? [];
    const rule = (id: string | null) => doc?.item_rules.find((r) => r.rule_id === id);
    const noSurat = (pid: string | null) => doc?.programs.find((p) => p.program_id === pid)?.no_surat ?? "";

    async function pakaiMaster() {
        setSibuk("master"); setPesan({ tone: "info", teks: "Memuat master barang…" });
        const r = await send("POST", `/api/summary/manual/master/load_principle/${principal}`);
        setSibuk(null);
        if (r.ok) { setToken(r.body.token); setPesan({ tone: "pos", teks: `Master ${nama} dimuat: ${(r.body.kelompok_list || []).length} kelompok.` }); }
        else setPesan({ tone: "neg", teks: `Master gagal dimuat: ${r.error}` });
    }

    async function baca() {
        const fd = new FormData();
        fd.append("token", token); fd.append("principal", nama); fd.append("tanggal", tanggal);
        surat.forEach((f) => fd.append("surat", f));
        setSibuk("baca"); setPesan(null); setDoc(null); setDisetujui(false);
        const r = await send("POST", "/summary/program/ekstrak", fd);
        setSibuk(null);
        if (!r.ok) { setPesan({ tone: "neg", teks: `Surat belum terbaca: ${r.error}` }); return; }
        const d = r.body.doc as Doc;
        setDoc(d);
        setPesan({ tone: "pos", teks: `${surat.length} surat dibaca: ${d.item_rules.length} baris aturan, ${d.flags.filter(MENAHAN).length} peringatan perlu dijawab`
            + (r.body.pembanding ? `; baris yang sama dengan Summary disetujui ${r.body.pembanding.pada.slice(0, 10)} tidak ditanya lagi.` : ".") });
    }

    /** Ubah satu rule (nilai dari surat) tanpa mengubah rule lain; peringatan baru hilang bila pemilik menekan "Sudah benar". */
    function ubah(id: string, f: (r: Rule) => Rule) {
        setDoc((d) => d && { ...d, item_rules: d.item_rules.map((r) => (r.rule_id === id ? f(structuredClone(r)) : r)) });
    }
    const jawab = (target: Flag) => setDoc((d) => d && { ...d, flags: d.flags.filter((f) => f !== target) });

    async function bukaForm() {
        if (!doc) return;
        setSibuk("form");
        try {
            const res = await fetch(`${API_BASE}/summary/program/form`, {
                method: "POST", credentials: "include", headers: { "Content-Type": "application/json", ...(await csrfHeader()) },
                body: JSON.stringify({ docs: [doc], token, dibuat: tanggal }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
            window.open(URL.createObjectURL(await res.blob()), "_blank", "noopener");
        } catch (e) {
            setPesan({ tone: "neg", teks: `Form gagal dibuat: ${e instanceof Error ? e.message : e}` });
        } finally { setSibuk(null); }
    }

    async function setujui() {
        setSibuk("setujui");
        const r = await send("POST", "/summary/program/setujui", { doc, token, principal: nama });
        setSibuk(null);
        if (r.ok) { setDisetujui(true); setPesan({ tone: "pos", teks: "Summary disetujui. Unduh Form final; baris yang sama tidak ditanya lagi bulan depan." }); }
        else setPesan({ tone: "neg", teks: r.error });
    }

    const kolom: Column<Rule>[] = [
        { key: "surat", header: "Surat", secondary: true, cell: (r) => <span className="fi-mono fi-small">{noSurat(r.program_id)}</span> },
        { key: "barang", header: "Barang", cell: (r) => <>{r.barang.nama_di_surat}<div className="fi-small fi-subtle">{r.barang.kode_barang.length} kode · {r.barang.kelompok_barang}</div></> },
        { key: "ketentuan", header: "Ketentuan", cell: (r) => `${r.ketentuan.min ?? "tanpa minimum"}${r.ketentuan.max ? `–${r.ketentuan.max}` : ""} ${r.ketentuan.satuan ?? ""}` },
        { key: "benefit", header: "Benefit", cell: (r) => r.benefit.teks_tampilan },
        { key: "tanda", header: "Peringatan", align: "end", cell: (r) => { const n = tahan.filter((f) => f.rule_id === r.rule_id).length; return n ? <StatusBadge tone="warn">{n}</StatusBadge> : null; } },
    ];
    const status = !doc ? <StatusBadge tone="neu">Belum dibaca</StatusBadge> : disetujui ? <StatusBadge tone="pos">Disetujui</StatusBadge>
        : tahan.length ? <StatusBadge tone="warn">{tahan.length} peringatan</StatusBadge> : <StatusBadge tone="pos">Siap disetujui</StatusBadge>;

    return (
        <div className="fi-page">
            <ObjectPageHeader breadcrumbs={[{ label: "Promo & Klaim" }, { label: "Summary Promo", href: "/summary" }, { label: "Summary Program" }]}
                title={`Summary Program On Faktur${nama ? ` · ${nama}` : ""}`} status={status}
                attributes={doc ? [{ label: "Surat", value: new Set(doc.programs.map((p) => p.no_surat)).size }, { label: "Baris aturan", value: doc.item_rules.length },
                    { label: "Peringatan", value: tahan.length }] : undefined} />
            {sibuk === "baca" && <MessageStrip tone="info" title="Membaca surat…">Tiga pembaca membaca setiap surat; surat besar dibaca per halaman. Bisa beberapa menit; jangan tutup halaman ini.</MessageStrip>}
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}

            <Section title="Principal dan surat" subtitle="master barang principal dipakai memilih kode barang">
                <div className="fi-sect-in">
                    {principles.status === "galat" && <MessageStrip tone="neg" title="Daftar principal tidak bisa dimuat.">{principles.error}</MessageStrip>}
                    <div className="fi-formgrid">
                        <FormField label="Principal">{(a11y) => <select {...a11y} className="fi-input" value={principal} onChange={(e) => { setPrincipal(e.target.value); setToken(""); }}><option value="">Pilih principal</option>{Object.entries(principles.data ?? {}).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}</select>}</FormField>
                        <div style={{ alignSelf: "end" }}><Button busy={sibuk === "master"} disabled={!principal || !bolehUbah} disabledReason={bolehUbah ? "Pilih principal dulu" : "Butuh izin ubah Summary"} onClick={() => void pakaiMaster()}>Pakai master principal ini</Button></div>
                        <FormField label="Surat program (PDF / JPG / PNG, boleh beberapa)">{(a11y) => <input {...a11y} className="fi-input" type="file" multiple accept="application/pdf,image/jpeg,image/png" disabled={!token || sibuk === "baca"} onChange={(e) => setSurat([...(e.target.files ?? [])])} />}</FormField>
                        <FormField label="Tanggal proses" help="Menentukan program yang sudah lewat dan tenggat klaim.">{(a11y) => <input {...a11y} className="fi-input" type="date" value={tanggal} onChange={(e) => setTanggal(e.target.value)} />}</FormField>
                    </div>
                    <div className="fi-btnrow"><Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} busy={sibuk === "baca"} disabled={!token || !surat.length || !bolehUbah}
                        disabledReason={!token ? "Pakai master principal dulu" : "Pilih surat dulu"} onClick={() => void baca()}>Baca surat</Button></div>
                </div>
            </Section>

            {doc && (
                <Section title="Peringatan" subtitle={tahan.length ? "jawab semua sebelum Setujui: betulkan nilainya bila salah, lalu tekan Sudah benar" : "tidak ada yang perlu dijawab"}>
                    <div className="fi-sect-in">
                        {!tahan.length && <EmptyState title="Semua peringatan sudah dijawab" message="Periksa pratinjau Form, lalu Setujui." />}
                        {tahan.map((f, i) => {
                            const r = rule(f.rule_id);
                            return (
                                <article key={i} className="fi-card" style={{ padding: 12, marginBottom: 8 }}>
                                    <p><StatusBadge tone={f.tingkat === "kritis" ? "neg" : "warn"}>{f.tingkat === "kritis" ? "Kritis" : "Perlu cek"}</StatusBadge>{" "}
                                        <span className="fi-mono fi-small">{noSurat(f.program_id)}{f.rule_id ? ` · ${f.rule_id}` : ""}</span> {f.pesan.replace(/^Penjaga: /, "")}</p>
                                    {r && (<>
                                        <p className="fi-small"><b>{r.barang.nama_di_surat}</b> · {r.barang.kode_barang.length} kode · surat hal. {r.sumber.halaman ?? "?"}: <i>“{r.sumber.kutipan}”</i></p>
                                        <div className="fi-formgrid">
                                            <FormField label="Minimum">{(a) => <input {...a} className="fi-input" inputMode="decimal" disabled={!bolehUbah} value={r.ketentuan.min ?? ""} onChange={(e) => ubah(r.rule_id, (x) => ({ ...x, ketentuan: { ...x.ketentuan, min: angka(e.target.value) } }))} />}</FormField>
                                            <FormField label="Maksimum">{(a) => <input {...a} className="fi-input" inputMode="decimal" disabled={!bolehUbah} value={r.ketentuan.max ?? ""} onChange={(e) => ubah(r.rule_id, (x) => ({ ...x, ketentuan: { ...x.ketentuan, max: angka(e.target.value) } }))} />}</FormField>
                                            <FormField label="Satuan">{(a) => <input {...a} className="fi-input" disabled={!bolehUbah} value={r.ketentuan.satuan ?? ""} onChange={(e) => ubah(r.rule_id, (x) => ({ ...x, ketentuan: { ...x.ketentuan, satuan: e.target.value.toUpperCase() || null } }))} />}</FormField>
                                            {r.benefit.komponen.map((k, j) => <FormField key={j} label={`${k.nama} (${k.satuan}, beban ${k.beban})`}>{(a) => <input {...a} className="fi-input" inputMode="decimal" disabled={!bolehUbah} value={k.nilai} onChange={(e) => ubah(r.rule_id, (x) => { x.benefit.komponen[j].nilai = angka(e.target.value) ?? 0; return x; })} />}</FormField>)}
                                            {r.benefit.bonus && <FormField label={`Bonus (${r.benefit.bonus.satuan})`}>{(a) => <input {...a} className="fi-input" inputMode="decimal" disabled={!bolehUbah} value={r.benefit.bonus?.qty ?? ""} onChange={(e) => ubah(r.rule_id, (x) => { if (x.benefit.bonus) x.benefit.bonus.qty = angka(e.target.value) ?? 0; return x; })} />}</FormField>}
                                            {r.benefit.bonus && <FormField label="Satuan bonus">{(a) => <input {...a} className="fi-input" disabled={!bolehUbah} value={r.benefit.bonus?.satuan ?? ""} onChange={(e) => ubah(r.rule_id, (x) => { if (x.benefit.bonus) x.benefit.bonus.satuan = e.target.value.toUpperCase(); return x; })} />}</FormField>}
                                            <FormField label="Teks di Form">{(a) => <input {...a} className="fi-input" disabled={!bolehUbah} value={r.benefit.teks_tampilan} onChange={(e) => ubah(r.rule_id, (x) => ({ ...x, benefit: { ...x.benefit, teks_tampilan: e.target.value } }))} />}</FormField>
                                        </div>
                                    </>)}
                                    {bolehUbah && <div className="fi-btnrow"><Button icon={<Check className="fi-icon" aria-hidden />} onClick={() => jawab(f)}>{r ? "Sudah benar" : "Sudah dicek"}</Button></div>}
                                </article>
                            );
                        })}
                        {info.length > 0 && <details><summary className="fi-small" style={{ cursor: "pointer" }}>{info.length} catatan info (tidak menahan)</summary><ul className="fi-small">{info.map((f, i) => <li key={i}>{f.pesan}</li>)}</ul></details>}
                    </div>
                </Section>
            )}

            {doc && (
                <ResponsiveTable title="Baris aturan" count={doc.item_rules.length} columns={kolom} rows={doc.item_rules} rowKey={(r) => r.rule_id}
                    mobileItem={(r) => <div>{r.barang.nama_di_surat} · {r.benefit.teks_tampilan}</div>} empty={{ title: "Tidak ada baris aturan" }} />
            )}

            {doc && (
                <Section title="Form" subtitle={disetujui ? "sudah disetujui" : tahan.length ? `Setujui terkunci: ${tahan.length} peringatan belum dijawab` : "siap disetujui"}>
                    <div className="fi-sect-in fi-btnrow">
                        <Button icon={<FileText className="fi-icon" aria-hidden />} busy={sibuk === "form"} onClick={() => void bukaForm()}>{disetujui ? "Unduh Form final" : "Pratinjau Form"}</Button>
                        {!disetujui && <Button variant="primary" icon={<ShieldCheck className="fi-icon" aria-hidden />} busy={sibuk === "setujui"} disabled={!bolehUbah || tahan.length > 0}
                            disabledReason={!bolehUbah ? "Butuh izin ubah Summary" : `Jawab ${tahan.length} peringatan dulu`} onClick={() => void setujui()}>Setujui</Button>}
                    </div>
                </Section>
            )}
        </div>
    );
}
