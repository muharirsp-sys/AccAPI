/*
 * Tujuan: Summary promo bulanan (Fiori S4a) sebagai Object Page satu siklus surat: Dibaca → Ditinjau → Terbit (order) → Disetujui → Dimuat (gerbang).
 *   Principal + master barang, syarat klaim, baca surat (PDF), baris Summary, aturan tersusun, simulasi, Terbitkan/Cabut publikasi (dialog;
 *   cabut = alasan wajib ≥ 5 karakter),
 *   Laporkan salah baca dan hapus baris (dialog), langkah gerbang faktur (LangkahGerbang), Summary final + email.
 * Caller: app/(dashboard)/summary/page.tsx.
 * Dependensi: FastAPI /summary/* dan /api/principles (lib/apiBase, CSRF), /api/promo-rule/from-summary; components/fiori/*; LangkahGerbang.
 * Main Functions: Summary, PilihBanyak.
 * Side Effects: HTTP ke FastAPI (draf, terbit, cabut, master, koreksi, Summary final, email); unduh berkas. Logic BL-51/52/53 tidak ditulis.
 */
"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Download, FileText, Flag, Play, Plus, Send, Trash2, Undo2, Upload } from "lucide-react";
import {
    AnchorBar, Button, EmptyState, Flow, FooterToolbar, ListItem, MessageStrip, ObjectPageHeader, ResponsiveTable, Section, StatusBadge, VariantNote,
    type Column, type FlowStep, type Tone,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { resolveApiBase } from "@/lib/apiBase";
import { ambil, jamWita } from "@/lib/rekapan-nota/ui";
import { persen } from "@/lib/promo-ui";
import LangkahGerbang, { type Terbit } from "./LangkahGerbang";

type Principles = Record<string, { name: string; filename: string }>;
type RowData = {
    id: string; no: string; principle: string; surat_program: string; nama_program: string; promo_group_id: string; channel_gtmt: string; channel_list: string;
    periode_start: string; periode_end: string; kelompok: string; variant: string; gramasi: string; kemasan: string; ketentuan: string; benefit_type: string;
    benefit: string; syarat_claim: string; update: string; keterangan: string; kode_barangs?: string; periode?: string; _original?: Record<string, unknown>;
};
type Opsi = { value: string; text: string };
type Tier = { minimum: string; percentages: string[]; rupiah: string; rupiah_mode?: string; bonus_code?: string; bonus_quantity?: string; bonus_unit?: string };
type RuleTersusun = { id: string; name: string; channel: string; start: string; end: string; unit: string; codes: string[]; mix: boolean; stacking: boolean; threshold: string; tiers: Tier[] };
type Draft = { id: string; revision: number; status: string; title: string };
type DraftItem = { id: string; title: string; status: string; revision: number; updated_at: string };
type SimResult = { gross: string; discount: string; net: string; applications?: { program_id: string; minimum: string; discount: string }[]; bonuses?: { program_id: string; quantity: string; unit: string; code: string }[] };
type Dialog = "terbit" | "cabut" | "koreksi" | "hapusBaris" | null;

const API_BASE = resolveApiBase();
const ALL_MASTER_SCOPE = "__ALL_MASTER__";
// Sesudah disimpan, backend mengembalikan NILAI KANONIK ini, bukan sentinelnya; grid mengenali keduanya.
const ALL_MASTER_LABEL = "ALL KELOMPOK BARANG";
const isAllMaster = (v: string) => v === ALL_MASTER_SCOPE || v === ALL_MASTER_LABEL;
const STATUS_DRAF: Record<string, { label: string; tone: Tone }> = { draft: { label: "Draf", tone: "neu" }, published: { label: "Terbit", tone: "pos" }, withdrawn: { label: "Dicabut", tone: "neg" } };
const JENIS_PROGRAM: { kunci: string; label: string }[] = [
    { kunci: "", label: "Baku (semua jenis)" }, { kunci: "DISC_PCT", label: "Diskon persen" }, { kunci: "DISC_RP", label: "Potongan rupiah" }, { kunci: "BONUS_QTY", label: "Bonus barang" },
];
const ymdLokal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let cachedCsrf = "";
async function csrfHeader(): Promise<Record<string, string>> {
    if (!cachedCsrf) {
        try {
            const res = await fetch(`${API_BASE}/api/me`, { credentials: "include", signal: AbortSignal.timeout(15_000) });
            const data = (await res.json().catch(() => ({}))) as { csrf_token?: string };
            if (res.ok && data.csrf_token) cachedCsrf = String(data.csrf_token);
        } catch { /* backend tetap memeriksa same-origin bila token tidak tersedia */ }
    }
    return cachedCsrf ? { "X-CSRF-Token": cachedCsrf } : {};
}

/** Satu pintu HTTP ke FastAPI Summary: pesan galat backend dipertahankan, tidak pernah "Fetch failed". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function send(method: string, url: string, data?: unknown): Promise<{ ok: boolean; body: any; error: string }> {
    const isForm = data instanceof FormData;
    try {
        const res = await fetch(`${API_BASE}${url}`, {
            method, credentials: "include",
            body: data === undefined ? undefined : isForm ? data : JSON.stringify(data),
            headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), ...(method === "GET" ? {} : await csrfHeader()) },
        });
        const body = await res.json().catch(() => ({}));
        const ok = res.ok && body?.ok !== false;
        return { ok, body, error: String(body?.detail || body?.error || `HTTP ${res.status}`) };
    } catch {
        return { ok: false, body: {}, error: "Server Summary tidak terhubung. Coba lagi sebentar lagi." };
    }
}
const pakaiId = (rows: Record<string, unknown>[] = []) => rows.map((r) => ({ ...r, id: String(r.id || crypto.randomUUID()), _original: r._original ?? { ...r } })) as RowData[];

/** Pilihan banyak (kelompok/varian/gramasi/kemasan) sebagai popover <details> bawaan. */
function PilihBanyak({ label, baris, options, value, onChange, kunci }: { label: string; baris: number; options: Opsi[]; value: string; onChange: (v: string) => void; kunci: boolean }) {
    const terpilih = value ? value.split(/[,&]/).map((v) => v.trim()).filter(Boolean) : [];
    const toggle = (v: string) => {
        if (v === ALL_MASTER_SCOPE) { onChange(terpilih.includes(ALL_MASTER_SCOPE) ? "" : ALL_MASTER_SCOPE); return; }
        let baru = terpilih.filter((x) => x !== ALL_MASTER_SCOPE);
        baru = baru.includes(v) ? baru.filter((x) => x !== v) : [...baru, v];
        const semua = options.filter((o) => o.value !== ALL_MASTER_SCOPE).length;
        if (baru.length === semua && semua > 0 && (label === "Varian" || label === "Gramasi")) onChange(label === "Varian" ? "All Variant" : "All Gramasi");
        else onChange(baru.join(" & "));
    };
    const teks = isAllMaster(value) ? "Semua barang (seluruh master)" : /all (variant|gramasi)/i.test(value) ? value
        : terpilih.length ? (terpilih.length <= 2 ? terpilih.map((v) => options.find((o) => o.value === v)?.text ?? v).join(", ") : `${terpilih.length} dipilih`) : `– ${label} –`;
    return (
        // name = satu popover terbuka sekaligus (details eksklusif bawaan peramban).
        <details className="fi-msel" name="fi-msel">
            <summary className="fi-input" aria-label={`${label} baris ${baris}: ${teks}`}>{teks}</summary>
            {!kunci && (
                <div className="fi-msel-pop" role="group" aria-label={label}>
                    {/* Nilai dari pembacaan surat sering BUKAN pilihan master; tanpa tombol ini ia menempel selamanya. */}
                    {value.trim() && <Button variant="tertiary" onClick={() => onChange("")}>Bersihkan pilihan</Button>}
                    {options.length === 0 ? <p className="fi-small fi-subtle">Pilih kelompok dulu</p> : options.map((o) => {
                        const on = o.value === ALL_MASTER_SCOPE ? isAllMaster(value) : terpilih.includes(o.value) || value === "All Variant" || value === "All Gramasi";
                        return <label key={o.value} className="fi-check"><input type="checkbox" checked={on} onChange={() => toggle(o.value)} />{o.text}</label>;
                    })}
                </div>
            )}
        </details>
    );
}

export default function Summary({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehUbah = keys.has("summary.edit");
    // FastAPI menuntut summary.edit untuk baca surat, master, Summary final, email, simulasi, dan koreksi.
    const bolehUnggah = bolehUbah;
    const bolehBuat = bolehUbah;

    const [principles] = useLoad(useCallback(async (): Promise<Load<Principles>> => {
        const r = await send("GET", "/api/principles");
        return r.ok ? { status: "siap", data: r.body.principles ?? {} } : { status: "galat", error: r.error };
    }, []));
    const [draftList, muatDraftList] = useLoad(useCallback(async (): Promise<Load<DraftItem[]>> => {
        const r = await send("GET", "/summary/library");
        return r.ok ? { status: "siap", data: r.body.drafts ?? [] } : { status: "galat", error: r.error };
    }, []));
    const [publikasi, muatPublikasi] = useLoad(useCallback(() => ambil<Terbit[]>("/api/promo-rule/from-summary", (j) => {
        const d = j as { ok?: boolean; error?: string; published?: Terbit[] };
        if (d.ok === false) throw new Error(d.error ?? "Gagal membaca publikasi Summary");
        return d.published ?? [];
    }), []));

    const [selectedPrinciple, setSelectedPrinciple] = useState("");
    const principleName = principles.data?.[selectedPrinciple]?.name ?? "";
    const [syaratClaim, setSyaratClaim] = useState<Record<string, string>>({});
    const [syaratStatus, setSyaratStatus] = useState<{ tone: "pos" | "neg" | "info"; teks: string } | null>(null);
    const [masterToken, setMasterToken] = useState("");
    const [kelompokList, setKelompokList] = useState<string[]>([]);
    const [masterStatus, setMasterStatus] = useState<{ tone: "pos" | "neg" | "info"; teks: string } | null>(null);
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [membaca, setMembaca] = useState(false);
    const [galatBaca, setGalatBaca] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [rules, setRules] = useState<RuleTersusun[]>([]);
    const [issues, setIssues] = useState<string[]>([]);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [sibuk, setSibuk] = useState<string | null>(null);
    const [pesan, setPesan] = useState<{ tone: "pos" | "neg" | "info" | "warn"; teks: string; rincian?: string } | null>(null);
    const [dirty, setDirty] = useState(false);
    const [reviewed, setReviewed] = useState(false);
    const [simChannel, setSimChannel] = useState("");
    const [simDate, setSimDate] = useState(ymdLokal());
    const [simLines, setSimLines] = useState([{ code: "", unit: "PCS", quantity: "1", price: "0" }]);
    const [simResult, setSimResult] = useState<SimResult | null>(null);
    const [draftPeriod, setDraftPeriod] = useState<[string, string]>(["", ""]);
    const [rows, setRows] = useState<RowData[]>([]);
    const [variantOptions, setVariantOptions] = useState<Record<string, Opsi[]>>({});
    const [gramasiOptions, setGramasiOptions] = useState<Record<string, Opsi[]>>({});
    const [kemasanOptions, setKemasanOptions] = useState<Record<string, Opsi[]>>({});
    const [bulanSummary, setBulanSummary] = useState("");
    const [hasilFinal, setHasilFinal] = useState<{ fid: string } | null>(null);
    const [membuat, setMembuat] = useState<string | null>(null);
    const [emailTarget, setEmailTarget] = useState("");
    const [dialog, setDialog] = useState<Dialog>(null);
    const [barisDialog, setBarisDialog] = useState<RowData | null>(null);
    const [catatanKoreksi, setCatatanKoreksi] = useState("");
    useUnsavedGuard(dirty);

    const principalTerakhir = useRef("");
    async function pilihPrinciple(id: string) {
        setSelectedPrinciple(id); setSyaratClaim({}); setSyaratStatus(null);
        principalTerakhir.current = id;
        const nama = principles.data?.[id]?.name;
        if (!nama) return;
        const r = await send("GET", `/summary/syarat-claim?principle=${encodeURIComponent(nama)}`);
        if (principalTerakhir.current !== id) return; // jawaban principal sebelumnya datang terlambat
        if (r.ok) setSyaratClaim(r.body?.syarat || {}); else setSyaratStatus({ tone: "neg", teks: `Syarat klaim gagal dimuat: ${r.error}` });
    }

    async function simpanSyaratClaim() {
        setSibuk("syarat");
        const r = await send("POST", "/summary/syarat-claim", { principle: principleName, syarat: syaratClaim });
        setSibuk(null);
        if (r.ok) { setSyaratClaim(r.body.syarat || {}); setSyaratStatus({ tone: "pos", teks: `Syarat klaim ${principleName} tersimpan.` }); }
        else setSyaratStatus({ tone: "neg", teks: `Gagal menyimpan syarat klaim: ${r.error}` });
    }

    function terimaMaster(body: { token: string; kelompok_list?: string[] }, asal: string) {
        setMasterToken(body.token); setKelompokList(body.kelompok_list || []);
        setMasterStatus({ tone: "pos", teks: `Master barang ${asal} dimuat: ${(body.kelompok_list || []).length} kelompok.` });
    }
    async function pakaiPrinciple() {
        if (!selectedPrinciple) return;
        setSibuk("master"); setMasterStatus({ tone: "info", teks: "Memuat master barang…" });
        const r = await send("POST", `/api/summary/manual/master/load_principle/${selectedPrinciple}`);
        setSibuk(null);
        if (r.ok) terimaMaster(r.body, principleName); else setMasterStatus({ tone: "neg", teks: `Master gagal dimuat: ${r.error}` });
    }
    async function unggahMaster(file: File) {
        setSibuk("master"); setMasterStatus({ tone: "info", teks: "Mengunggah master…" });
        const fd = new FormData(); fd.append("master", file);
        const r = await send("POST", "/summary/manual/master/upload", fd);
        setSibuk(null);
        if (r.ok) terimaMaster(r.body, `dari ${file.name}`); else setMasterStatus({ tone: "neg", teks: `Master gagal diunggah: ${r.error}` });
    }

    async function fetchOptions(rowId: string, kel: string, currentVariant?: string, currentGramasi?: string) {
        if (!masterToken || !kel || isAllMaster(kel)) return;
        const r = await send("GET", `/summary/manual/master/options?token=${masterToken}&group=${encodeURIComponent(kel)}`);
        if (!r.ok) return;
        const variants: Opsi[] = r.body.variants || [], gramasis: Opsi[] = r.body.gramasis || [], kemasans: Opsi[] = r.body.kemasans || [];
        setVariantOptions((p) => ({ ...p, [rowId]: variants })); setGramasiOptions((p) => ({ ...p, [rowId]: gramasis })); setKemasanOptions((p) => ({ ...p, [rowId]: kemasans }));
        if (currentVariant || currentGramasi) {
            setRows((prev) => prev.map((row) => {
                if (row.id !== rowId) return row;
                let v = row.variant, g = row.gramasi;
                if (currentVariant && currentVariant !== "...") {
                    const ada = currentVariant.split(",").map((x) => x.trim().toLowerCase());
                    const cocok = variants.filter((o) => ada.includes(o.text.toLowerCase())).map((o) => o.value);
                    if (cocok.length) v = cocok.join(", ");
                }
                if (currentGramasi && currentGramasi !== "...") {
                    const ada = currentGramasi.split(",").map((x) => x.trim().toLowerCase());
                    const cocok = gramasis.filter((o) => ada.includes(o.text.toLowerCase())).map((o) => o.value);
                    if (cocok.length) g = cocok.join(", ");
                }
                return { ...row, variant: v, gramasi: g };
            }));
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function terapkanDraf(body: any) {
        if (body.draft) setDraft({ id: body.draft.id, revision: body.draft.revision, status: body.draft.status, title: body.draft.title });
        setRules(body.programs || []); setIssues(body.issues || []);
    }

    async function bacaSurat() {
        if (!pdfFile || !masterToken) return;
        setMembaca(true); setGalatBaca(null); setPesan(null);
        const fd = new FormData();
        fd.append("pdf", pdfFile); fd.append("token", masterToken); fd.append("principle_name", principleName);
        const r = await send("POST", "/summary/manual/parse_pdf_ai", fd);
        setMembaca(false);
        if (!r.ok) { setGalatBaca(r.error); return; }
        const data = r.body;
        const parsed = pakaiId(data.rows);
        // Grid = SATU draf. Surat yang masuk ke draf LAIN mengganti isi grid dengan draf itu; kalau ditumpuk, Simpan menulis baris draf lama ke draf baru.
        const draftLain = Boolean(data.draft) && data.draft.id !== draft?.id;
        const isiGrid = draftLain ? pakaiId(data.draft.content?.rows) : parsed;
        setRows((prev) => (draftLain ? isiGrid : [...prev, ...parsed]));
        setDraft(data.draft ? { id: data.draft.id, revision: data.draft.revision, status: data.draft.status, title: data.draft.title } : null);
        setWarnings(data.draft?.content?.extraction?.warnings || []);
        setRules([]); setIssues([]); setReviewed(false); setSimResult(null); setDirty(false); setPdfFile(null);
        setPesan({ tone: "pos", teks: `${pdfFile.name} dibaca: ${parsed.length} baris dari ${data.draft?.content?.extraction?.page_count ?? "?"} halaman.`, rincian: "Simpan draf untuk menyusun aturan, lalu bandingkan dengan PDF sumber sebelum terbit." });
        muatDraftList();
        for (const row of isiGrid) if (row.kelompok) void fetchOptions(row.id, row.kelompok, row.variant, row.gramasi);
    }

    async function bukaDraf(id: string) {
        if (!id) return;
        setSibuk("buka"); setPesan(null);
        const r = await send("GET", `/summary/library/${id}`);
        setSibuk(null);
        if (!r.ok) { setPesan({ tone: "neg", teks: `Draf gagal dibuka: ${r.error}` }); return; }
        const content = r.body.draft?.content || {};
        setRows(pakaiId(content.rows));
        setWarnings(content.extraction?.warnings || []);
        setDraftPeriod(Array.isArray(content.period) ? [content.period[0] || "", content.period[1] || ""] : ["", ""]);
        setReviewed(false); setSimResult(null); setDirty(false);
        terapkanDraf(r.body);
    }

    async function simpanDraf() {
        if (!draft) return;
        setSibuk("simpan"); setPesan(null);
        const r = await send("PUT", `/summary/library/${draft.id}`, { title: draft.title, rows, revision: draft.revision, period: draftPeriod });
        setSibuk(null);
        if (!r.ok) { setPesan({ tone: "neg", teks: `Draf tidak tersimpan: ${r.error}` }); return; }
        terapkanDraf(r.body);
        const resolved = r.body.draft?.content?.rows;
        if (Array.isArray(resolved)) setRows(pakaiId(resolved));
        setDirty(false);
        setPesan(r.body.issues?.length ? { tone: "warn", teks: `Tersimpan dengan ${r.body.issues.length} catatan yang harus diperbaiki sebelum terbit.` } : { tone: "pos", teks: `Tersimpan; ${r.body.programs?.length || 0} aturan siap ditinjau.` });
    }

    async function terbitkan() {
        if (!draft) return;
        const r = await send("POST", `/summary/library/${draft.id}/publish`, { reviewed: true, revision: draft.revision });
        if (!r.ok) throw new Error(r.error);
        terapkanDraf(r.body); setDialog(null); muatPublikasi(); muatDraftList();
        setPesan({ tone: "pos", teks: `Versi ${r.body.draft?.revision ?? ""} terbit ${jamWita(new Date())} dan langsung dipakai mesin order.`, rincian: "Gerbang faktur dan Rekap masih memakai aturan lama sampai versi ini disetujui dan dimuat (langkah berikutnya di bawah)." });
    }

    /** Owner 8 Okt (S4a): `alasan` wajib (≥ 5 karakter); FastAPI menyimpannya di draf bersama pelaku dan waktunya. */
    async function cabut(alasan: string) {
        if (!draft) return;
        const r = await send("POST", `/summary/library/${draft.id}/withdraw`, { revision: draft.revision, alasan });
        if (!r.ok) throw new Error(r.error);
        terapkanDraf(r.body); setDialog(null); muatPublikasi(); muatDraftList();
        setPesan({ tone: "info", teks: "Publikasi dicabut: mesin order berhenti memakai versi ini.", rincian: "Aturan yang sudah dimuat ke gerbang faktur tidak ikut terhapus; hapus atau nonaktifkan di Aturan Promo bila perlu." });
    }

    async function simulasikan() {
        if (!draft) return;
        setSibuk("sim");
        const r = await send("POST", `/summary/library/${draft.id}/simulate`, { date: simDate, channel: simChannel, lines: simLines });
        setSibuk(null);
        if (!r.ok) { setSimResult(null); setPesan({ tone: "neg", teks: `Simulasi gagal: ${r.error}` }); return; }
        setSimResult(r.body.result);
    }

    function barisKosong(): RowData {
        const today = ymdLokal(); const now = new Date();
        return { id: crypto.randomUUID(), no: "", principle: principleName, surat_program: "", nama_program: "", promo_group_id: "", channel_gtmt: "", channel_list: "",
            periode_start: ymdLokal(new Date(now.getFullYear(), now.getMonth(), 1)), periode_end: today, kelompok: "", variant: "", gramasi: "", kemasan: "",
            ketentuan: "", benefit_type: "DISC_PCT", benefit: "", syarat_claim: "", update: today, keterangan: "Manual" };
    }
    function ubahBaris(id: string, field: keyof RowData, val: string) {
        setDirty(true);
        setRows((p) => p.map((row) => {
            if (row.id !== id) return row;
            const baru = { ...row, [field]: val };
            if (field === "kelompok") {
                if (isAllMaster(val)) {
                    baru.variant = "ALL VARIANT"; baru.gramasi = "ALL GRAMASI";
                    setVariantOptions((x) => ({ ...x, [id]: [] })); setGramasiOptions((x) => ({ ...x, [id]: [] })); setKemasanOptions((x) => ({ ...x, [id]: [] }));
                } else void fetchOptions(id, val, baru.variant, baru.gramasi);
            }
            return baru;
        }));
    }

    async function kirimKoreksi() {
        if (!barisDialog) return;
        const { id: _id, _original, ...after } = barisDialog;
        void _id;
        const r = await send("POST", "/summary/manual/report_correction", { principle_name: principleName || "Priskila (Default)", before: _original || {}, after, note: catatanKoreksi });
        if (!r.ok) throw new Error(r.error);
        setDialog(null); setBarisDialog(null); setCatatanKoreksi("");
        setPesan({ tone: "pos", teks: "Koreksi baca tersimpan.", rincian: "Menjadi petunjuk di pembacaan surat berikutnya dan penimpa pasti saat Summary final dibuat (kode barang sama)." });
    }

    const bulanAktif = bulanSummary || String(rows.find((r) => r.periode_start)?.periode_start ?? "").slice(0, 7) || ymdLokal().slice(0, 7);
    const unduhUrl = (fid: string, jenis: "form" | "dataset") => `${API_BASE}/summary/manual/download/${fid}/${jenis}/file.${jenis === "form" ? "pdf" : "xlsx"}`;

    async function tungguJob(jobId: string) {
        const r = await send("GET", `/api/job_status/${jobId}`);
        if (!r.ok) { setMembuat(null); setPesan({ tone: "neg", teks: `Status pembuatan tidak terbaca: ${r.error}` }); return; }
        const st = r.body;
        if (st.status === "done" && st.result?.file_id) { setHasilFinal({ fid: st.result.file_id }); setMembuat(null); setPesan({ tone: "pos", teks: "Summary final selesai dibuat." }); }
        else if (st.status === "error") { setMembuat(null); setPesan({ tone: "neg", teks: `Summary final gagal dibuat: ${st.error}` }); }
        else { setMembuat("Menyusun berkas Excel…"); setTimeout(() => void tungguJob(jobId), 1500); }
    }
    // SATU Summary per principal per bulan: yang sudah terbit di bulan itu, lalu baris grid di BAWAHNYA (keputusan 2 Okt 2026).
    async function buatFinal() {
        if (!masterToken) return;
        setMembuat("Memulai…"); setHasilFinal(null); setPesan(null);
        const cleanRows = rows.map(({ id: _id, ...rest }) => { void _id; return rest; });
        const r = await send("POST", "/summary/library/bulanan", { token: masterToken, principal: principleName, bulan: bulanAktif, rows: cleanRows });
        if (!r.ok) { setMembuat(null); setPesan({ tone: "neg", teks: `Summary final gagal: ${r.error}` }); return; }
        if (r.body.file_id) { setHasilFinal({ fid: r.body.file_id }); setMembuat(null); setPesan({ tone: "pos", teks: `Summary ${bulanAktif}: ${r.body.baris} baris dari ${r.body.surat?.length ?? 0} surat.` }); }
        else if (r.body.job_id) void tungguJob(r.body.job_id);
        else setMembuat(null);
    }
    async function unduh(url: string, nama: string) {
        try {
            const res = await fetch(url, { credentials: "include" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blobUrl = URL.createObjectURL(await res.blob());
            const a = document.createElement("a"); a.href = blobUrl; a.download = nama; document.body.appendChild(a); a.click();
            setTimeout(() => { a.remove(); URL.revokeObjectURL(blobUrl); }, 1000);
        } catch (e) { setPesan({ tone: "neg", teks: `Unduhan gagal: ${e instanceof Error ? e.message : String(e)}` }); }
    }
    async function kirimEmail() {
        if (!emailTarget || !hasilFinal) return;
        setSibuk("email");
        const r = await send("POST", "/summary/manual/email", { email: emailTarget, file_id: hasilFinal.fid });
        setSibuk(null);
        setPesan(r.ok ? { tone: "pos", teks: `Email ke ${emailTarget} dijadwalkan; cek kotak masuk beberapa menit lagi.` } : { tone: "neg", teks: `Email gagal: ${r.error}` });
    }

    // Siklus surat dan "dipakai di mana" dari keadaan yang ada hari ini (tanpa logic baru).
    const terbitEntry = draft ? publikasi.data?.find((p) => p.draft_id === draft.id) : undefined;
    const gerbangTerbaca = publikasi.data !== undefined;
    const gerbangTeks = !gerbangTerbaca ? (publikasi.status === "galat" ? "Tidak terbaca" : "Memeriksa…") : terbitEntry?.sudahDimuat ? "Ya, dimuat" : "Belum";
    const st = draft?.status ?? "";
    const ditinjau = st === "published" || (rules.length > 0 && issues.length === 0 && !dirty);
    const langkah: FlowStep[] = [
        { label: "Dibaca", state: draft ? "done" : "current" },
        { label: "Ditinjau", state: !draft ? "todo" : ditinjau ? "done" : "current" },
        { label: "Terbit · order", state: st === "published" ? "done" : st === "withdrawn" ? "stop" : ditinjau ? "current" : "todo" },
        { label: "Disetujui", state: terbitEntry?.sudahDimuat ? "done" : st === "published" ? "current" : "todo" },
        { label: "Dimuat · gerbang", state: terbitEntry?.sudahDimuat ? "done" : "todo" },
    ];
    const alasanTerbit = !bolehUbah ? "Butuh izin ubah Summary" : dirty ? "Simpan perubahan dulu" : rules.length === 0 ? "Simpan draf untuk menyusun aturan dulu" : issues.length ? `Perbaiki ${issues.length} catatan dulu` : undefined;
    const suratUnik = [...new Set(rows.map((r) => r.surat_program).filter(Boolean))];

    const kolomAturan: Column<RuleTersusun>[] = [
        { key: "program", header: "Program", cell: (r) => r.name },
        { key: "channel", header: "Channel", secondary: true, cell: (r) => r.channel || "semua" },
        { key: "periode", header: "Periode", secondary: true, cell: (r) => <span className="fi-small">{r.start} – {r.end}</span> },
        { key: "barang", header: "Barang", align: "end", cell: (r) => <span className="fi-tnum">{r.codes.length}</span> },
        { key: "tier", header: "Ketentuan · manfaat", cell: (r) => <span className="fi-small">{r.tiers.map((t, i) => <span key={i} style={{ display: "block" }}>{r.threshold === "value" ? "Nilai" : "Beli"} {t.minimum} {r.unit}{t.percentages.length > 0 && ` · diskon ${t.percentages.map(persen).join(" + ")}`}{t.rupiah !== "0" && ` · Rp ${t.rupiah}${t.rupiah_mode === "per_unit" ? "/satuan" : ""}`}{t.bonus_code && ` · bonus ${t.bonus_quantity} ${t.bonus_unit} ${t.bonus_code}`}</span>)}{r.mix ? " · campur varian" : ""}{r.stacking ? " · bertumpuk" : ""}</span> },
    ];
    const kunciGrid = !bolehUbah || (draft !== null && draft.status !== "draft");
    const LABEL_KOLOM: Partial<Record<keyof RowData, string>> = { no: "No", principle: "Principal", surat_program: "Surat", nama_program: "Program", ketentuan: "Ketentuan", benefit: "Nilai manfaat" };
    const inp = (r: RowData, i: number, f: keyof RowData, w: string) => <input className="fi-input" aria-label={`${LABEL_KOLOM[f] ?? f} baris ${i + 1}`} disabled={kunciGrid} style={{ minWidth: w }} value={String(r[f] ?? "")} onChange={(e) => ubahBaris(r.id, f, e.target.value)} />;

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <ObjectPageHeader
                breadcrumbs={[{ label: "Promo & Klaim" }, { label: "Summary Promo" }]}
                title={draft ? draft.title || `Summary ${principleName}` : `Summary promo${principleName ? ` · ${principleName}` : ""}`}
                status={draft ? <StatusBadge tone={STATUS_DRAF[st]?.tone ?? "neu"}>{STATUS_DRAF[st]?.label ?? st}{st === "draft" ? ` · revisi ${draft.revision}` : ` versi ${draft.revision}`}</StatusBadge> : <StatusBadge tone="neu">Belum ada draf</StatusBadge>}
                draft={dirty}
                attributes={draft ? [{ label: "Surat", value: suratUnik.length }, { label: "Aturan tersusun", value: rules.length }, { label: "Periode", value: draftPeriod[0] ? `${draftPeriod[0]} – ${draftPeriod[1]}` : "dari baris" }, { label: "Draf", value: <span className="fi-mono">{draft.id.slice(0, 8)}</span> }] : undefined}
                flow={<Flow steps={langkah} label="Siklus Summary" />}
                actions={<Link href="/summary/settings" className="fi-btn fi-btn--tertiary">Pengaturan Summary</Link>} />
            <AnchorBar anchors={[
                ...(draft ? [{ id: "dipakai", label: "Dipakai di mana" }] : []), { id: "gerbang", label: "Gerbang faktur" }, { id: "surat", label: "Surat" },
                ...(draft ? [{ id: "aturan", label: "Aturan" }] : []), ...(masterToken || rows.length ? [{ id: "baris", label: "Baris" }] : []),
                ...(draft && bolehUbah ? [{ id: "simulasi", label: "Simulasi" }] : []), ...(masterToken && bolehBuat ? [{ id: "final", label: "Summary final" }] : []),
            ]} />

            {membaca && <MessageStrip tone="info" title={`Membaca ${pdfFile?.name ?? "surat"}…`}>Semua halaman dibaca otomatis menjadi draf yang wajib ditinjau; isi draf yang ada tidak berubah sampai selesai.</MessageStrip>}
            {galatBaca && <MessageStrip tone="neg" title="Surat belum terbaca." onClose={() => setGalatBaca(null)}>{galatBaca} Draf ini tidak berubah; coba lagi atau ketik barisnya manual.</MessageStrip>}
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)}>{pesan.rincian}</MessageStrip>}
            {dirty && draft && <MessageStrip tone="info" title="Ada isian yang diubah, belum disimpan.">Simpan menyusun ulang aturan dan kode barang dari master. Membuka draf lain dan membaca surat menunggu sampai perubahan disimpan atau dibuang.</MessageStrip>}

            <Section title="Principal dan master barang" subtitle="master dipakai membaca surat dan menyusun kode barang">
                <div className="fi-sect-in">
                    {principles.status === "galat" && <MessageStrip tone="neg" title="Daftar principal tidak bisa dimuat.">{principles.error}</MessageStrip>}
                    <div className="fi-formgrid">
                        <FormField label="Principal tersimpan">{(a11y) => <select {...a11y} className="fi-input" value={selectedPrinciple} onChange={(e) => void pilihPrinciple(e.target.value)}><option value="">— pilih principal —</option>{Object.entries(principles.data ?? {}).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}</select>}</FormField>
                        {bolehUbah && <div style={{ alignSelf: "end" }}><Button variant="primary" busy={sibuk === "master"} disabled={!selectedPrinciple} disabledReason="Pilih principal dulu" onClick={() => void pakaiPrinciple()}>Pakai master principal ini</Button></div>}
                        {bolehUnggah && <FormField label="Atau unggah Excel master baru">{(a11y) => <input {...a11y} className="fi-input" type="file" accept=".xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) void unggahMaster(f); }} />}</FormField>}
                        <FormField label="Buka draf tersimpan" help={draftList.status === "galat" ? `Daftar draf gagal dimuat: ${draftList.error}` : dirty ? "Simpan atau buang perubahan dulu." : undefined}>{(a11y) => <select {...a11y} className="fi-input" value="" disabled={sibuk === "buka" || dirty} onChange={(e) => void bukaDraf(e.target.value)}><option value="">{draftList.status === "memuat" ? "Memuat…" : `— ${draftList.data?.length ?? 0} draf —`}</option>{(draftList.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.title} ({STATUS_DRAF[d.status]?.label ?? d.status}, revisi {d.revision}, {jamWita(d.updated_at)})</option>)}</select>}</FormField>
                    </div>
                    {masterStatus && <MessageStrip tone={masterStatus.tone}>{masterStatus.teks}</MessageStrip>}
                    {principleName && (
                        <details>
                            <summary style={{ cursor: "pointer" }} className="fi-small"><b>Syarat klaim {principleName}</b> · dipakai baris yang tidak menyebut syaratnya sendiri</summary>
                            <div className="fi-formgrid" style={{ marginTop: 8 }}>
                                {JENIS_PROGRAM.map(({ kunci, label }) => <FormField key={kunci || "baku"} label={label}>{(a11y) => <input {...a11y} className="fi-input" maxLength={400} disabled={!bolehUbah} placeholder={kunci ? "(pakai baku)" : "mis. Klaim on faktur, lampirkan copy faktur"} value={syaratClaim[kunci] ?? ""} onChange={(e) => setSyaratClaim({ ...syaratClaim, [kunci]: e.target.value })} />}</FormField>)}
                            </div>
                            {bolehUbah && <div className="fi-btnrow" style={{ marginTop: 8 }}><Button busy={sibuk === "syarat"} onClick={() => void simpanSyaratClaim()}>Simpan syarat klaim</Button></div>}
                            {syaratStatus && <MessageStrip tone={syaratStatus.tone}>{syaratStatus.teks}</MessageStrip>}
                        </details>
                    )}
                </div>
            </Section>

            {draft && (
                <Section id="dipakai" title="Dipakai di mana">
                    <div className="fi-sect-in">
                        <div className="fi-kcards">
                            <div className="fi-kc" data-tone={st === "published" ? "pos" : undefined}><span>Mesin order</span><b style={{ fontSize: "1.125rem" }}>{st === "published" ? `Ya, versi ${draft.revision}` : "Belum"}</b><small>{st === "published" ? "Order sales dan order masuk memakainya" : "Order memakai Summary yang sudah terbit saja"}</small></div>
                            <div className="fi-kc" data-tone={terbitEntry?.sudahDimuat ? "pos" : undefined}><span>Gerbang faktur</span><b style={{ fontSize: "1.125rem" }}>{gerbangTeks}</b><small>{!gerbangTerbaca && publikasi.status === "galat" ? publikasi.error : st === "published" ? "Menunggu persetujuan dan muat" : "Setelah terbit, disetujui, dan dimuat"}</small></div>
                            <div className="fi-kc" data-tone={terbitEntry?.sudahDimuat ? "pos" : undefined}><span>Rekap &amp; Normalisasi</span><b style={{ fontSize: "1.125rem" }}>{gerbangTerbaca ? (terbitEntry?.sudahDimuat ? "Ya" : "Belum") : gerbangTeks}</b><small>Membaca aturan yang sama dengan gerbang faktur</small></div>
                        </div>
                        <VariantNote bl="BL-51">Pengaturan Summary punya jalur terbitnya sendiri yang hanya dipakai order dan tidak masuk Summary final. Usulan: satu jalur terbit yang terbaca semua pemakai.</VariantNote>
                    </div>
                </Section>
            )}

            <LangkahGerbang publikasi={publikasi} muatUlang={muatPublikasi} draftAktif={draft?.id} bolehUbah={bolehUbah} />

            <Section id="surat" title="Surat" subtitle={draft ? `${suratUnik.length} surat · disusulkan ke draf ini selama belum terbit` : "surat pertama membuat draf baru"}>
                <div className="fi-sect-in">
                    {!draft && !rows.length && <EmptyState title={`Belum ada draf Summary${principleName ? ` ${principleName}` : ""}`} message="Pilih principal dan pakai master barangnya, lalu pilih surat promo (PDF). Surat berikutnya di bulan yang sama disusulkan ke Summary yang sama selama belum terbit." />}
                    {suratUnik.length > 0 && <ul className="fi-chips" aria-label="Surat di draf">{suratUnik.map((s) => <li key={s} className="fi-chip fi-mono">{s}</li>)}</ul>}
                    {bolehUnggah && (masterToken ? (
                        <div className="fi-page-bar">
                            <FormField label="Surat promo (PDF)" help="Semua halaman dibaca otomatis menjadi draf yang wajib ditinjau. Nilai transaksi dihitung aturan terbit, bukan pembaca surat.">{(a11y) => <input {...a11y} className="fi-input" type="file" accept="application/pdf" disabled={membaca || st === "published"} onChange={(e) => setPdfFile(e.target.files?.[0] || null)} />}</FormField>
                            <Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} busy={membaca} disabled={!pdfFile || st === "published" || (dirty && Boolean(draft))} disabledReason={st === "published" ? "Draf sudah terbit" : dirty && draft ? "Simpan atau buang perubahan dulu" : "Pilih surat dulu"} onClick={() => void bacaSurat()} style={{ alignSelf: "end" }}>{draft ? "Susulkan surat" : "Baca surat"}</Button>
                        </div>
                    ) : <p className="fi-small fi-subtle">Pakai master barang principal dulu untuk membaca surat.</p>)}
                    {draft && <a className="fi-btn fi-btn--tertiary" href={`${API_BASE}/summary/library/${draft.id}/source`}><FileText className="fi-icon" aria-hidden />PDF sumber</a>}
                </div>
            </Section>

            {draft && (warnings.length > 0 || issues.length > 0) && (
                <Section title="Catatan baca" subtitle="bandingkan dengan PDF sumber">
                    <div className="fi-sect-in">
                        {issues.length > 0 && <MessageStrip tone="neg" title={`Perbaiki ${issues.length} hal sebelum terbit:`}><ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>{issues.slice(0, 20).map((n, i) => <li key={i}>{n}</li>)}</ul></MessageStrip>}
                        {warnings.length > 0 && <MessageStrip tone="warn" title={`${warnings.length} catatan pembacaan:`}><ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>{warnings.slice(0, 20).map((n, i) => <li key={i}>{n}</li>)}</ul></MessageStrip>}
                    </div>
                </Section>
            )}

            {draft && (
                <Section id="aturan" title="Aturan tersusun" subtitle="dari baris dan master barang; ALL VARIANT = semua varian kecuali yang dipegang baris lain di surat yang sama">
                    <ResponsiveTable<RuleTersusun> title="Aturan tersusun" count={rules.length} columns={kolomAturan} rows={rules} rowKey={(r) => r.id}
                        empty={{ title: "Belum ada aturan tersusun", message: "Simpan draf untuk menyusun aturan dari baris di bawah." }}
                        mobileItem={(r) => <ListItem doc={r.name} title={`${r.codes.length} barang · ${r.channel || "semua channel"}`} meta={`${r.start} – ${r.end}`} />} />
                </Section>
            )}

            {(masterToken || rows.length > 0) && (
                <Section id="baris" title="Baris Summary" subtitle={`${rows.length} baris${kunciGrid && draft ? " · terkunci setelah terbit" : ""}`}
                    actions={!kunciGrid ? <Button icon={<Plus className="fi-icon" aria-hidden />} onClick={() => { setRows((p) => [...p, barisKosong()]); setDirty(true); }}>Tambah baris</Button> : undefined}>
                    {rows.length === 0 ? <EmptyState title="Belum ada baris" message="Tambahkan baris kosong atau baca surat (PDF)." /> : (
                        <div className="fi-tablescroll" style={{ display: "block" }}>
                            <table className="fi-table"><caption className="sr-only">Baris Summary</caption>
                                <thead><tr>{["No", "Principal", "Surat", "Program", "Channel", "Kelompok", "Varian", "Gramasi", "Kemasan", "Ketentuan", "Bentuk manfaat", "Nilai", ""].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
                                <tbody>{rows.map((r, i) => (
                                    <tr key={r.id}>
                                        <td>{inp(r, i, "no", "3rem")}</td><td>{inp(r, i, "principle", "7rem")}</td><td>{inp(r, i, "surat_program", "8rem")}</td><td>{inp(r, i, "nama_program", "9rem")}</td>
                                        <td><select className="fi-input" aria-label={`Channel baris ${i + 1}`} disabled={kunciGrid} value={r.channel_gtmt} onChange={(e) => ubahBaris(r.id, "channel_gtmt", e.target.value)}><option value="">–</option><option>GT</option><option>MT</option><option>NKA</option></select></td>
                                        <td><PilihBanyak label="Kelompok" baris={i + 1} kunci={kunciGrid} options={[{ value: ALL_MASTER_SCOPE, text: "Semua barang (seluruh master)" }, ...kelompokList.map((k) => ({ value: k, text: k }))]} value={r.kelompok} onChange={(v) => ubahBaris(r.id, "kelompok", v)} /></td>
                                        <td><PilihBanyak label="Varian" baris={i + 1} kunci={kunciGrid} options={variantOptions[r.id] || []} value={r.variant} onChange={(v) => ubahBaris(r.id, "variant", v)} /></td>
                                        <td><PilihBanyak label="Gramasi" baris={i + 1} kunci={kunciGrid} options={gramasiOptions[r.id] || []} value={r.gramasi} onChange={(v) => ubahBaris(r.id, "gramasi", v)} /></td>
                                        <td><PilihBanyak label="Kemasan" baris={i + 1} kunci={kunciGrid} options={kemasanOptions[r.id] || []} value={r.kemasan || ""} onChange={(v) => ubahBaris(r.id, "kemasan", v)} /></td>
                                        <td>{inp(r, i, "ketentuan", "6rem")}</td>
                                        <td><select className="fi-input" aria-label={`Bentuk manfaat baris ${i + 1}`} disabled={kunciGrid} value={r.benefit_type} onChange={(e) => ubahBaris(r.id, "benefit_type", e.target.value)}><option value="DISC_PCT">Diskon persen</option><option value="DISC_RP">Potongan rupiah</option><option value="BONUS_QTY">Bonus barang</option></select></td>
                                        <td>{inp(r, i, "benefit", "5rem")}</td>
                                        <td><span className="fi-btnrow" style={{ flexWrap: "nowrap" }}>
                                            {bolehUbah && <Button variant="icon" aria-label={`Laporkan salah baca baris ${i + 1}`} title="Laporkan salah baca" onClick={() => { setBarisDialog(r); setCatatanKoreksi(""); setDialog("koreksi"); }}><Flag className="fi-icon" aria-hidden /></Button>}
                                            {!kunciGrid && <Button variant="icon" aria-label={`Hapus baris ${i + 1}`} title="Hapus baris" onClick={() => { setBarisDialog(r); setDialog("hapusBaris"); }}><Trash2 className="fi-icon" aria-hidden /></Button>}
                                        </span></td>
                                    </tr>))}</tbody>
                            </table>
                        </div>
                    )}
                    {draft && (
                        <div className="fi-sect-in">
                            <div className="fi-page-bar">
                                <FormField label="Periode draf mulai" help="Dipakai baris tanpa tanggal sendiri.">{(a11y) => <input {...a11y} className="fi-input" type="date" disabled={kunciGrid} value={draftPeriod[0]} onChange={(e) => { setDraftPeriod([e.target.value, draftPeriod[1]]); setDirty(true); }} />}</FormField>
                                <FormField label="Periode draf selesai">{(a11y) => <input {...a11y} className="fi-input" type="date" disabled={kunciGrid} value={draftPeriod[1]} onChange={(e) => { setDraftPeriod([draftPeriod[0], e.target.value]); setDirty(true); }} />}</FormField>
                            </div>
                        </div>
                    )}
                </Section>
            )}

            {draft && bolehUbah && (
                <Section id="simulasi" title="Simulasi" subtitle="uji aturan sebelum terbit; tidak menulis apa pun">
                    <div className="fi-sect-in">
                        <div className="fi-page-bar">
                            <FormField label="Tanggal">{(a11y) => <input {...a11y} className="fi-input" type="date" value={simDate} onChange={(e) => setSimDate(e.target.value)} />}</FormField>
                            <FormField label="Channel">{(a11y) => <input {...a11y} className="fi-input" placeholder="GT" value={simChannel} onChange={(e) => setSimChannel(e.target.value.toUpperCase())} style={{ width: "6rem" }} />}</FormField>
                            <Button style={{ alignSelf: "end" }} icon={<Plus className="fi-icon" aria-hidden />} onClick={() => setSimLines((p) => [...p, { code: "", unit: "PCS", quantity: "1", price: "0" }])}>Tambah baris uji</Button>
                            <Button style={{ alignSelf: "end" }} variant="primary" icon={<Play className="fi-icon" aria-hidden />} busy={sibuk === "sim"} onClick={() => void simulasikan()}>Hitung</Button>
                        </div>
                        {simLines.map((line, i) => (
                            <div key={i} className="fi-page-bar">
                                {(["code", "unit", "quantity", "price"] as const).map((f) => <input key={f} className="fi-input" aria-label={`${{ code: "Kode barang", unit: "Satuan", quantity: "Jumlah", price: "Harga" }[f]} baris uji ${i + 1}`} placeholder={{ code: "Kode barang", unit: "Satuan", quantity: "Jumlah", price: "Harga" }[f]} value={line[f]} onChange={(e) => setSimLines((p) => p.map((x, j) => (j === i ? { ...x, [f]: e.target.value } : x)))} style={{ width: "8rem" }} />)}
                                {simLines.length > 1 && <Button variant="icon" aria-label={`Hapus baris uji ${i + 1}`} onClick={() => setSimLines((p) => p.filter((_, j) => j !== i))}><Trash2 className="fi-icon" aria-hidden /></Button>}
                            </div>
                        ))}
                        {simResult && (
                            <MessageStrip tone="info" title={`Bruto ${simResult.gross} · diskon ${simResult.discount} · netto ${simResult.net}`}>
                                <ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>
                                    {simResult.applications?.map((a, i) => <li key={`a${i}`}>{a.program_id}: minimum {a.minimum} · potongan {a.discount}</li>)}
                                    {simResult.bonuses?.map((b, i) => <li key={`b${i}`}>Bonus {b.quantity} {b.unit} {b.code} ({b.program_id})</li>)}
                                </ul>
                            </MessageStrip>
                        )}
                    </div>
                </Section>
            )}

            {masterToken && bolehBuat && (
                <Section id="final" title={`Summary final ${bulanAktif}`} subtitle="semua surat principal ini yang terbit dan berlaku di bulan ini; baris grid ditambahkan di bawahnya">
                    <div className="fi-sect-in">
                        <div className="fi-page-bar">
                            <FormField label="Bulan Summary">{(a11y) => <input {...a11y} className="fi-input" type="month" value={bulanAktif} onChange={(e) => { setBulanSummary(e.target.value); setHasilFinal(null); }} />}</FormField>
                            <Button style={{ alignSelf: "end" }} variant={hasilFinal ? "secondary" : "primary"} icon={<FileText className="fi-icon" aria-hidden />} busy={Boolean(membuat)} onClick={() => void buatFinal()}>{membuat ?? "Buat Summary final"}</Button>
                        </div>
                        {hasilFinal && (
                            <>
                                <div className="fi-btnrow">
                                    <Button icon={<Download className="fi-icon" aria-hidden />} onClick={() => void unduh(unduhUrl(hasilFinal.fid, "form"), "Form_Summary_Program.pdf")}>Form PDF</Button>
                                    <Button icon={<Download className="fi-icon" aria-hidden />} onClick={() => void unduh(unduhUrl(hasilFinal.fid, "dataset"), "Dataset_Diskon_With_Channel.xlsx")}>Excel untuk impor</Button>
                                </div>
                                <div className="fi-page-bar">
                                    <FormField label="Kirim lewat email">{(a11y) => <input {...a11y} className="fi-input" type="email" placeholder="email divisi" value={emailTarget} onChange={(e) => setEmailTarget(e.target.value)} />}</FormField>
                                    <Button style={{ alignSelf: "end" }} icon={<Send className="fi-icon" aria-hidden />} busy={sibuk === "email"} disabled={!emailTarget} disabledReason="Isi alamat email dulu" onClick={() => void kirimEmail()}>Kirim</Button>
                                </div>
                            </>
                        )}
                    </div>
                </Section>
            )}

            {draft && bolehUbah && (
                <FooterToolbar message={dirty ? "Perubahan belum disimpan" : st === "draft" ? alasanTerbit : st === "published" ? `Versi ${draft.revision} terbit · dipakai order` : "Publikasi dicabut"}>
                    {dirty && <Button variant="tertiary" onClick={() => void bukaDraf(draft.id)}>Buang perubahan</Button>}
                    {st === "draft" && <Button busy={sibuk === "simpan"} disabled={!dirty && rules.length > 0} disabledReason="Belum ada perubahan" onClick={() => void simpanDraf()}>Simpan draf</Button>}
                    {st === "draft" && <Button variant="primary" disabled={Boolean(alasanTerbit)} disabledReason={alasanTerbit} onClick={() => { setReviewed(false); setDialog("terbit"); }}>Terbitkan…</Button>}
                    {st === "published" && <Button variant="negative" icon={<Undo2 className="fi-icon" aria-hidden />} onClick={() => setDialog("cabut")}>Cabut publikasi…</Button>}
                </FooterToolbar>
            )}

            {draft && (
                <ConfirmDialog open={dialog === "terbit"} onClose={() => setDialog(null)} tag="Terbit" title={`Terbitkan ${draft.title || `Summary ${principleName}`}?`} confirmLabel="Terbitkan"
                    confirmDisabled={reviewed ? undefined : "Centang dulu bahwa draf sudah dibandingkan dengan PDF sumber"} onConfirm={terbitkan}
                    facts={[["Aturan", `${rules.length} aturan dari ${suratUnik.length} surat`], ["Dipakai", "Mesin order langsung memakainya"], ["Belum dipakai", "Gerbang faktur dan Rekap — sampai disetujui dan dimuat"], ["Setelah terbit", "Baris dan aturan terkunci pada versi ini; cabut publikasi untuk menghentikannya"]]}>
                    <label className="fi-check"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />Saya sudah membandingkan draf dengan PDF sumber</label>
                </ConfirmDialog>
            )}
            {draft && (
                <ConfirmDialog open={dialog === "cabut"} onClose={() => setDialog(null)} tag="Cabut" tone="negative" title={`Cabut publikasi versi ${draft.revision}?`} confirmLabel="Cabut publikasi" onConfirm={cabut}
                    reason={{ label: "Alasan cabut publikasi", placeholder: "Mis. principal merevisi surat; periode program berubah", min: 5 }}
                    facts={[["Mesin order", "Berhenti memakai versi ini"], ["Gerbang faktur", terbitEntry?.sudahDimuat ? "Aturan yang sudah dimuat TIDAK ikut terhapus; hapus atau nonaktifkan di Aturan Promo" : "Belum dimuat; tidak terpengaruh"], ["Status", "Dicabut; tidak bisa diterbitkan ulang dari versi ini"], ["Jejak", "Alasan, nama Anda, dan waktunya tersimpan di draf"]]} />
            )}
            <ConfirmDialog open={dialog === "koreksi"} onClose={() => { setDialog(null); setBarisDialog(null); }} tag="Koreksi baca" title="Laporkan salah baca surat" confirmLabel="Kirim koreksi" onConfirm={kirimKoreksi}
                facts={[["Baris", barisDialog ? `${barisDialog.surat_program || "–"} · ${barisDialog.kelompok || "–"} · ${barisDialog.benefit || "–"}` : ""], ["Dipakai", "Petunjuk pembacaan surat berikutnya dan penimpa pasti di Summary final (kode barang sama)"]]}>
                <FormField label="Catatan koreksi" help="Opsional, mis. “Camellia 22ml seharusnya Beli 7 bukan Beli 4”.">{(a11y) => <textarea {...a11y} className="fi-input" rows={3} value={catatanKoreksi} onChange={(e) => setCatatanKoreksi(e.target.value)} />}</FormField>
            </ConfirmDialog>
            <ConfirmDialog open={dialog === "hapusBaris"} onClose={() => { setDialog(null); setBarisDialog(null); }} tag="Hapus" tone="negative" title="Hapus baris ini dari draf?" confirmLabel="Hapus baris"
                onConfirm={() => { if (barisDialog) { setRows((p) => p.filter((x) => x.id !== barisDialog.id)); setDirty(true); } setDialog(null); setBarisDialog(null); }}
                facts={[["Baris", barisDialog ? `${barisDialog.surat_program || "–"} · ${barisDialog.nama_program || barisDialog.kelompok || "–"}` : ""], ["Berlaku", "Setelah Simpan draf"]]} />
        </div>
    );
}
