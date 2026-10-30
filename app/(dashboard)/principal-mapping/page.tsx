/*
 * Tujuan: Mapping Principal (Fiori): terjemahan kode di sistem principal menjadi kode internal (barang, pelanggan, salesman, merek surat).
 *   Impor Excel selalu pratinjau dulu; Muat (mengganti seluruh mapping jenis itu), tambah/ubah, dan hapus lewat dialog konfirmasi.
 * Caller: Route dashboard `/principal-mapping`.
 * Dependensi: /api/principal-mapping (GET, PUT, DELETE) dan /api/principal-mapping/import (POST), komponen Fiori, lib/tampil,
 *   principal-order/bersama (PRINCIPAL_DIDUKUNG = nilai awal principal).
 * Main Functions: PrincipalMappingPage, load, saveRow, removeRow, runImport.
 * Side Effects: HTTP baca/tulis; impor default PRATINJAU, menulis hanya setelah dikonfirmasi.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search, Upload } from "lucide-react";
import { FioriScope } from "@/components/fiori/Scope";
import { Button, ListItem, MessageStrip, ResponsiveTable, Section, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { KOSONG, sebabHttp, waktuWita } from "@/lib/tampil";
import { PRINCIPAL_DIDUKUNG } from "../principal-order/bersama";

type Kind = "item" | "customer" | "salesman" | "brand";

type Row = {
    principal: string; kind: Kind; sourceCode: string; targetCode: string;
    unit: string | null; packSize: string | null; note: string; updatedBy: string; updatedAt: string;
};

type ImportEntry = { kind: Kind; label: string; sheet: string; count: number; issues: string[] };

const KIND_TABS: { kind: Kind; label: string; hint: string }[] = [
    { kind: "item", label: "Barang", hint: "Kode barang principal → kode internal, dengan satuan dan ISI per karton" },
    { kind: "customer", label: "Pelanggan", hint: "Kode outlet principal → kode pelanggan internal (tanpa akhiran cabang)" },
    { kind: "salesman", label: "Salesman", hint: "ID salesman principal → kode internal" },
    { kind: "brand", label: "Merek surat", hint: "Nama merek seperti tertulis di surat promo → pola nama pada master barang, mis. MEREK A 2IN1 → MEREK A LOTION" },
];

const PAGE = 50;
const empty = (principal: string, kind: Kind): Row => ({
    principal, kind, sourceCode: "", targetCode: "", unit: "", packSize: "", note: "", updatedBy: "", updatedAt: "",
});

// ponytail: salinan kecil useDebounced milik AturanPromo; modul bersama promo-ui diimpor helper server, jadi tidak diberi hook React.
function useDebounced(value: string, ms: number) {
    const [v, setV] = useState(value);
    useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
    return v;
}

/** Jaringan putus menjadi kalimat sebab, bukan "Failed to fetch". */
const kirim = (url: string, init: RequestInit) => fetch(url, init).catch(() => { throw new Error(sebabHttp(0)); });

export default function PrincipalMappingPage() {
    // Nilai awal = principal yang didukung Order Principal (satu konstanta, bukan literal di sini; audit No 79).
    const [principal, setPrincipal] = useState(PRINCIPAL_DIDUKUNG);
    const [kind, setKind] = useState<Kind>("item");
    const [query, setQuery] = useState("");
    const [rows, setRows] = useState<Row[]>([]);
    const [muatKunci, setMuatKunci] = useState("");
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [busy, setBusy] = useState(false);
    const [gagalMuat, setGagalMuat] = useState<string | null>(null);
    const [draft, setDraft] = useState<Row | null>(null);
    const [hapus, setHapus] = useState<Row | null>(null);
    const [dialogMuat, setDialogMuat] = useState(false);
    const [preview, setPreview] = useState<ImportEntry[] | null>(null);
    const [file, setFile] = useState<File | null>(null);
    const [inputKe, setInputKe] = useState(0);
    const [galatImpor, setGalatImpor] = useState<string | null>(null);
    const [pesan, setPesan] = useState<string | null>(null);

    const tab = KIND_TABS.find((entry) => entry.kind === kind)!;
    // Ketikan dijeda: satu permintaan per jeda ketik, dan jawaban lama yang datang terlambat tidak menimpa yang terbaru.
    const principalTunda = useDebounced(principal, 300);
    const queryTunda = useDebounced(query, 300);
    const kunci = `${principalTunda}|${kind}|${queryTunda}|${offset}`;
    const terakhir = useRef(0);

    const load = useCallback(async () => {
        const nomor = ++terakhir.current;
        setBusy(true);
        setGagalMuat(null);
        try {
            const url = `/api/principal-mapping?principal=${encodeURIComponent(principalTunda)}&kind=${kind}`
                + `&q=${encodeURIComponent(queryTunda)}&limit=${PAGE}&offset=${offset}`;
            const res = await fetch(url, { credentials: "include" }).catch(() => null);
            const data = res ? await res.json().catch(() => null) : null;
            if (nomor !== terakhir.current) return;
            if (!res || !res.ok || !data?.ok) { setGagalMuat(String(data?.error ?? sebabHttp(res?.status ?? 0))); return; }
            setRows(data.rows);
            setTotal(data.total);
            setMuatKunci(`${principalTunda}|${kind}|${queryTunda}|${offset}`);
        } finally {
            if (nomor === terakhir.current) setBusy(false);
        }
    }, [principalTunda, kind, queryTunda, offset]);

    useEffect(() => { void load(); }, [load]);

    async function saveRow(row: Row) {
        const res = await kirim("/api/principal-mapping", {
            method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...row, packSize: row.packSize || null }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(String(data.error ?? sebabHttp(res.status)));
        setPesan(`Mapping ${row.sourceCode} tersimpan.`);
        setDraft(null);
        void load();
    }

    async function removeRow(row: Row) {
        const url = `/api/principal-mapping?principal=${encodeURIComponent(row.principal)}&kind=${row.kind}`
            + `&sourceCode=${encodeURIComponent(row.sourceCode)}`;
        const res = await kirim(url, { method: "DELETE", credentials: "include" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(String(data.error ?? sebabHttp(res.status)));
        setPesan("Mapping dihapus.");
        setHapus(null);
        void load();
    }

    async function runImport(apply: boolean) {
        if (!file) { setGalatImpor("Pilih berkas xlsx dulu."); return; }
        setBusy(true);
        setGalatImpor(null);
        try {
            const form = new FormData();
            form.append("file", file);
            form.append("principal", principal);
            form.append("apply", String(apply));
            const res = await kirim("/api/principal-mapping/import", { method: "POST", credentials: "include", body: form });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) throw new Error(String(data.error ?? sebabHttp(res.status)));
            setPreview(data.result);
            if (apply) {
                setDialogMuat(false);
                setPesan(`Mapping ${principal} dimuat.`);
                setPreview(null);
                setFile(null);
                setInputKe((k) => k + 1);
                void load();
            }
        } catch (error) {
            const teks = error instanceof Error ? error.message : sebabHttp(0);
            if (apply) throw new Error(teks); // dialog Muat menampilkannya
            setGalatImpor(teks);
        } finally {
            setBusy(false);
        }
    }

    const tampilRows = muatKunci === kunci ? rows : [];
    const status = gagalMuat ? "galat" : busy ? "memuat" : "siap";
    const aksiBaris = (row: Row) => (
        <span className="fi-btnrow">
            <Button variant="tertiary" onClick={() => setDraft({ ...row, unit: row.unit ?? "", packSize: row.packSize ?? "" })}>Ubah…</Button>
            <Button variant="tertiary" aria-label={`Hapus mapping ${row.sourceCode}`} onClick={() => setHapus(row)}>Hapus…</Button>
        </span>
    );
    const kolom: Column<Row>[] = [
        { key: "sumber", header: "Kode principal", cell: (row) => <span className="fi-mono">{row.sourceCode}</span> },
        { key: "target", header: "Kode internal", cell: (row) => <span className="fi-mono">{row.targetCode}</span> },
        ...(kind === "item" ? [
            { key: "satuan", header: "Satuan", cell: (row: Row) => row.unit ?? KOSONG },
            { key: "isi", header: "ISI per karton", align: "end", cell: (row: Row) => <span className="fi-tnum">{row.packSize ?? KOSONG}</span> },
        ] satisfies Column<Row>[] : []),
        { key: "catatan", header: "Catatan", secondary: true, cell: (row) => row.note || KOSONG },
        { key: "diubah", header: "Diubah", secondary: true, cell: (row) => <>{waktuWita(row.updatedAt)}{row.updatedBy && <span className="fi-sub">{row.updatedBy}</span>}</> },
        { key: "aksi", header: "Tindakan", cell: aksiBaris },
    ];
    const adaCari = queryTunda.trim() !== "";

    return (
        <FioriScope>
            <div className="fi-page">
                <header className="fi-page-head">
                    <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Pengaturan</span></li><li><span aria-current="page">Mapping Principal</span></li></ol></nav>
                    <h1>Mapping Principal</h1>
                    <p>Terjemahan kode di sistem principal menjadi kode internal kita. Dipakai saat laporan principal diunggah dan dicocokkan dengan Accurate.</p>
                </header>

                {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}

                <Section title="Impor dari berkas" subtitle="pratinjau dulu, baru muat">
                    <div className="fi-sect-in">
                        {galatImpor && <MessageStrip tone="neg" title="Berkas belum bisa diproses." onClose={() => setGalatImpor(null)}>{galatImpor}</MessageStrip>}
                        <div className="fi-formgrid">
                            <FormField label="Principal" help="Nama principal seperti di Data Principal.">
                                {(a11y) => <input {...a11y} className="fi-input" value={principal} placeholder="mis. PRINCIPLE A" onChange={(event) => { setPrincipal(event.target.value); setOffset(0); }} />}
                            </FormField>
                            <FormField label="Berkas Excel (tiga sheet mapping)">
                                {(a11y) => <input {...a11y} key={inputKe} className="fi-input" type="file" accept=".xlsx,.xls" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} />}
                            </FormField>
                        </div>
                        <div className="fi-btnrow">
                            <Button icon={<Search className="fi-icon" aria-hidden />} disabled={busy || !file} disabledReason="Pilih berkas dulu" onClick={() => void runImport(false)}>Pratinjau</Button>
                            <Button variant="primary" icon={<Upload className="fi-icon" aria-hidden />} disabled={busy || !preview} disabledReason="Pratinjau berkas dulu" onClick={() => setDialogMuat(true)}>Muat…</Button>
                        </div>
                        {preview && (
                            <MessageStrip tone="warn" title={`Pratinjau. Memuat akan mengganti seluruh mapping jenis di bawah ini untuk ${principal}.`}>
                                <ul style={{ margin: "4px 0 0", paddingLeft: "1rem" }}>
                                    {preview.map((entry) => (
                                        <li key={entry.kind}>
                                            <b>{entry.label}</b> (sheet {entry.sheet}): {entry.count} baris siap dimuat
                                            {entry.issues.length > 0 && (
                                                <ul style={{ paddingLeft: "1rem" }}>
                                                    {entry.issues.slice(0, 5).map((issue, i) => <li key={`${i}-${issue}`}>{issue}</li>)}
                                                    {entry.issues.length > 5 && <li>dan {entry.issues.length - 5} temuan lain</li>}
                                                </ul>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </MessageStrip>
                        )}
                    </div>
                </Section>

                <div className="fi-segs" role="group" aria-label="Jenis mapping">
                    {KIND_TABS.map((entry) => (
                        <button key={entry.kind} type="button" aria-pressed={kind === entry.kind} onClick={() => { setKind(entry.kind); setOffset(0); setDraft(null); }}>{entry.label}</button>
                    ))}
                </div>
                <p className="fi-small fi-muted">{tab.hint}</p>

                <Section title={`Mapping ${tab.label.toLowerCase()}`} subtitle={muatKunci === kunci && !gagalMuat ? `${total} baris` : undefined}
                    actions={<Button icon={<Plus className="fi-icon" aria-hidden />} onClick={() => setDraft(empty(principal, kind))}>Tambah baris</Button>}>
                    <div className="fi-sect-in">
                        <FormField label="Cari">
                            {(a11y) => <input {...a11y} className="fi-input" type="search" value={query} placeholder="Kode principal atau kode internal" onChange={(event) => { setQuery(event.target.value); setOffset(0); }} />}
                        </FormField>
                    </div>
                    <ResponsiveTable<Row> title={`Mapping ${tab.label.toLowerCase()}`} columns={kolom} rows={tampilRows} rowKey={(row) => row.sourceCode} status={status} error={gagalMuat ?? undefined} onRetry={() => void load()}
                        empty={adaCari ? { title: "Tidak ada mapping yang cocok", message: "Ubah kata kunci pencarian." } : { title: "Belum ada mapping", message: "Impor berkas principal atau tambah baris." }}
                        mobileItem={(row) => <ListItem doc={row.sourceCode} title={row.targetCode} meta={kind === "item" ? `${row.unit ?? KOSONG} · ISI ${row.packSize ?? KOSONG}` : row.note || undefined} badge={aksiBaris(row)} />} />
                    {total > PAGE && muatKunci === kunci && (
                        <div className="fi-sect-in">
                            <div className="fi-btnrow">
                                <Button disabled={offset === 0} onClick={() => setOffset(Math.max(offset - PAGE, 0))}>Sebelumnya</Button>
                                <span className="fi-small fi-muted fi-tnum">{offset + 1}–{Math.min(offset + PAGE, total)} dari {total}</span>
                                <Button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Berikutnya</Button>
                            </div>
                        </div>
                    )}
                </Section>

                <ConfirmDialog open={draft !== null} onClose={() => setDraft(null)} tag="Mapping" title={`Simpan mapping ${tab.label.toLowerCase()}?`} confirmLabel="Simpan mapping"
                    facts={[["Principal", draft?.principal ?? ""], ["Jenis", tab.label], ["Dipakai", "Saat laporan principal diunggah dan dicocokkan dengan Accurate"], ["Akibat", draft?.updatedAt ? "Mengubah baris yang sudah ada" : "Menambah baris; kode principal yang sama menimpa baris lama"]]}
                    factsAlign="start" onConfirm={() => saveRow(draft!)}>
                    {draft && (
                        <div className="fi-formgrid">
                            <FormField label="Kode principal" required>{(a11y) => <input {...a11y} className="fi-input fi-mono" value={draft.sourceCode} onChange={(event) => setDraft({ ...draft, sourceCode: event.target.value })} />}</FormField>
                            <FormField label="Kode internal" required>{(a11y) => <input {...a11y} className="fi-input fi-mono" value={draft.targetCode} onChange={(event) => setDraft({ ...draft, targetCode: event.target.value })} />}</FormField>
                            {draft.kind === "item" && <FormField label="Satuan" required help="mis. BTL">{(a11y) => <input {...a11y} className="fi-input" value={draft.unit ?? ""} onChange={(event) => setDraft({ ...draft, unit: event.target.value.toUpperCase() })} />}</FormField>}
                            {draft.kind === "item" && <FormField label="ISI per karton" required help="mis. 36">{(a11y) => <input {...a11y} className="fi-input" inputMode="decimal" value={draft.packSize ?? ""} onChange={(event) => setDraft({ ...draft, packSize: event.target.value })} />}</FormField>}
                            <FormField label="Catatan">{(a11y) => <input {...a11y} className="fi-input" value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />}</FormField>
                        </div>
                    )}
                </ConfirmDialog>

                <ConfirmDialog open={hapus !== null} onClose={() => setHapus(null)} tag="Hapus" tone="negative" title={`Hapus mapping ${hapus?.sourceCode ?? ""}?`} confirmLabel="Hapus mapping"
                    facts={[["Principal", hapus?.principal ?? ""], ["Jenis", tab.label], ["Kode principal", hapus?.sourceCode ?? ""], ["Kode internal", hapus?.targetCode ?? ""], ["Akibat", "Kode ini tidak lagi diterjemahkan saat laporan principal diunggah"]]}
                    factsAlign="start" onConfirm={() => removeRow(hapus!)} />

                <ConfirmDialog open={dialogMuat} onClose={() => setDialogMuat(false)} tag="Muat" tone="negative" title={`Muat mapping ke ${principal}?`} confirmLabel="Muat mapping"
                    facts={[["Principal", principal], ...(preview ?? []).map((entry): [string, string] => [entry.label, `${entry.count} baris`]), ["Akibat", "Mengganti seluruh mapping jenis di atas untuk principal ini, bukan menambah"]]}
                    factsAlign="start" onConfirm={() => runImport(true)} />
            </div>
        </FioriScope>
    );
}
