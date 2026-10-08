/*
 * Tujuan: Tab Kontrol Wajib SM (Fiori S5, it05 #18): memuat SPV di bawah SM + briefing mereka (GET sm-briefings) DAN isian yang
 *   sudah tersimpan hari ini (GET sm-control, sebelumnya tidak dipakai); galat keduanya tampil (tidak ditelan) dan mengunci Simpan.
 *   Simpan lewat dialog; payload sama dengan hari ini (tanggal = hari ini WITA).
 * Caller: form-kontrol/FormKontrol.tsx (tab "sm-control").
 * Dependensi: ../shared (Scope, hariIniWita, jamWita, ambilFk, tulisFk, useIzinFk), components/fiori/{core,interactive},
 *   lib/rekapan-nota/ui (tanggalPendek).
 * Main Functions: TabSmControl (default), dariServer.
 * Side Effects: GET /api/form-kontrol/sm-briefings, GET /api/form-kontrol/sm-control; POST /api/form-kontrol/sm-control (dialog).
 */
"use client";

import { useCallback, useState } from "react";
import { Pencil, Plus, Save, Trash2 } from "lucide-react";
import { Button, EmptyState, ErrorState, MessageStrip, Section, Skeleton, StatusBadge, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { ambilFk, hariIniWita, jamWita, tulisFk, useIzinFk, type Scope } from "../shared";

interface SpvBriefing { session: string; penyebab: string | null; solusi: string | null }
interface SpvBriefingRow { spvName: string; briefings: SpvBriefing[] }
interface SmTersimpan {
    spvChecked?: unknown; jksChecked?: boolean; fotoChecked?: boolean;
    deviations?: unknown; followUp?: string | null; createdAt?: string | null;
}
type Form = { spvList: { name: string; note: string }[]; jksChecked: boolean; fotoChecked: boolean; deviasi: { spv: string; catatan: string }[]; followUp: string };
type Data = { briefings: SpvBriefingRow[]; tersimpan: SmTersimpan | null };

/** Isian dari server: daftar SPV hari ini + catatan tersimpan (SPV tersimpan yang tidak lagi di bawah SM ini tetap dibawa). */
function dariServer(d: Data): Form {
    const t = d.tersimpan;
    const lama = Array.isArray(t?.spvChecked) ? (t.spvChecked as Array<{ name?: unknown; note?: unknown }>) : [];
    const catatan = new Map(lama.map((s) => [String(s.name ?? ""), String(s.note ?? "")]));
    const nama = [...d.briefings.map((b) => b.spvName), ...[...catatan.keys()].filter((n) => n && !d.briefings.some((b) => b.spvName === n))];
    const dev = Array.isArray(t?.deviations) ? (t.deviations as Array<{ spv?: unknown; catatan?: unknown }>) : [];
    return {
        spvList: nama.map((name) => ({ name, note: catatan.get(name) ?? "" })),
        jksChecked: Boolean(t?.jksChecked),
        fotoChecked: Boolean(t?.fotoChecked),
        deviasi: dev.map((x) => ({ spv: String(x.spv ?? ""), catatan: String(x.catatan ?? "") })),
        followUp: t?.followUp ?? "",
    };
}

const GAGAL = "Kontrol SM belum berhasil dimuat.";

export default function TabSmControl({ scope }: { scope: Scope }) {
    const izin = useIzinFk("submit");
    const [date] = useState(hariIniWita);
    // Nama yang sama dipakai untuk membaca dan menulis (POST hari ini: smName ?? spvName ?? salesName).
    const smName = scope.smName ?? scope.spvName ?? scope.salesName ?? "";

    const [load, muatUlang] = useLoad(useCallback(async (): Promise<Load<Data>> => {
        if (!smName) return { status: "siap", data: { briefings: [], tersimpan: null } };
        const q = new URLSearchParams({ date, smName });
        const [b, t] = await Promise.all([
            ambilFk(`/api/form-kontrol/sm-briefings?${q}`, (j) => (j.rows ?? []) as SpvBriefingRow[], "Daftar SPV dan briefing belum berhasil dimuat."),
            ambilFk(`/api/form-kontrol/sm-control?${q}`, (j) => ((j.rows ?? []) as SmTersimpan[])[0] ?? null, "Isian Kontrol SM yang tersimpan belum berhasil dimuat."),
        ]);
        if (b.status !== "siap" || t.status !== "siap") return { status: "galat", error: [b.error, t.error].filter(Boolean).join(" ") };
        return { status: "siap", data: { briefings: b.data!, tersimpan: t.data! } };
    }, [smName, date]));

    // null = belum disunting → tampil isian dari server; sesudah simpan, isian yang baru disimpan tetap tampil
    // (server membaca satu catatan tanpa urutan, jadi memuat ulang bisa memunculkan catatan lama).
    const [ubah, setUbah] = useState<Form | null>(null);
    const [dasar, setDasar] = useState<Form | null>(null);
    const [disimpan, setDisimpan] = useState<string | null>(null);
    const [dialog, setDialog] = useState(false);
    const [sukses, setSukses] = useState("");

    const server = load.data ? dariServer(load.data) : null;
    const form = ubah ?? server;
    const pembanding = dasar ?? server;
    const dirty = Boolean(form && pembanding && JSON.stringify(form) !== JSON.stringify(pembanding));
    useUnsavedGuard(dirty);
    const set = (f: (v: Form) => Form) => { if (form) { setUbah(f(form)); setSukses(""); } };

    const blokir = izin
        ?? (!smName ? "Akun ini tidak tertaut ke nama SM; Kontrol SM diisi oleh akun SM." : undefined)
        ?? (load.status !== "siap" ? "Isian tersimpan belum berhasil dimuat; simpan dikunci agar tidak menimpa catatan." : undefined);

    if (!smName) {
        return <EmptyState title="Kontrol SM diisi oleh akun SM" message="Akun ini tidak tertaut ke nama SM di Hierarki Sales, jadi tidak ada SPV yang bisa dikontrol." />;
    }
    if (!form) {
        return load.status === "galat"
            ? <ErrorState title={GAGAL} message={`${load.error ?? ""} Isian tidak ditampilkan agar catatan tersimpan tidak tertimpa isian kosong.`} onRetry={muatUlang} />
            : <Skeleton rows={6} label="Memuat Kontrol SM" />;
    }
    const tersimpanJam = disimpan ?? load.data?.tersimpan?.createdAt ?? null;

    return (
        <>
            {load.status === "galat" && (
                <MessageStrip tone="neg" title="Gagal memuat ulang.">
                    {load.error} Yang tampil adalah hasil sebelumnya; simpan dikunci.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatUlang}>Coba lagi</button>
                </MessageStrip>
            )}
            {sukses && <MessageStrip tone="pos" title={sukses} onClose={() => setSukses("")} />}
            <div className="fi-page-bar">
                <h2 className="fi-title-2">Kontrol Wajib SM</h2>
                {dirty && <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />Draf belum disimpan</span>}
                <span className="fi-spacer" />
                <span className="fi-small fi-subtle">
                    {smName} · {tanggalPendek(date)} · {tersimpanJam ? `tersimpan ${jamWita(tersimpanJam)} WITA` : "belum disimpan hari ini"}
                </span>
            </div>
            <p className="fi-small fi-muted">Tugas SM bukan mengontrol salesman langsung, tetapi memastikan SPV benar-benar mengontrol salesmannya.</p>

            <Section title="Kontrol harian">
                <div className="fi-sect-in">
                    {([["jksChecked", "JKS sudah dicek hari ini"], ["fotoChecked", "Foto kunjungan sudah dimonitor"]] as const).map(([k, label]) => (
                        <label key={k} className="fi-check" style={{ minHeight: 44 }}>
                            <input type="checkbox" checked={form[k]} style={{ width: 20, height: 20 }} onChange={() => set((v) => ({ ...v, [k]: !v[k] }))} />
                            {label}
                        </label>
                    ))}
                </div>
            </Section>

            <Section title="Catatan coaching per SPV" subtitle={`${form.spvList.length} SPV`}>
                <div className="fi-sect-in">
                    {form.spvList.length === 0 && (
                        <p className="fi-small fi-subtle">Belum ada SPV terhubung ke SM ini. Isi SM pada SPV di Hierarki Sales.</p>
                    )}
                    {form.spvList.map((spv, i) => {
                        const br = load.data?.briefings.find((b) => b.spvName === spv.name);
                        const pagi = br?.briefings.find((x) => x.session === "pagi");
                        const sore = br?.briefings.find((x) => x.session === "sore");
                        const penyebab = sore?.penyebab || pagi?.penyebab;
                        const solusi = sore?.solusi || pagi?.solusi;
                        return (
                            <div key={spv.name} className="grid gap-1.5">
                                <div className="flex flex-wrap items-center gap-2">
                                    <b className="fi-small">{spv.name}</b>
                                    <StatusBadge tone={pagi ? "pos" : "neu"}>{pagi ? "Briefing pagi" : "Pagi belum"}</StatusBadge>
                                    <StatusBadge tone={sore ? "pos" : "neu"}>{sore ? "Briefing sore" : "Sore belum"}</StatusBadge>
                                    {!br && <StatusBadge tone="warn">Tidak lagi di bawah SM ini</StatusBadge>}
                                </div>
                                {(penyebab || solusi) && (
                                    <p className="fi-small fi-muted">
                                        {penyebab && <>Penyebab: {penyebab}. </>}
                                        {solusi && <>Solusi: {solusi}.</>}
                                    </p>
                                )}
                                <FormField label={`Catatan coaching ${spv.name}`}>{(a) => (
                                    <input {...a} className="fi-input" style={{ minHeight: 44 }} value={spv.note} placeholder="Kosongkan bila tidak ada"
                                        onChange={(e) => set((v) => ({ ...v, spvList: v.spvList.map((s, j) => (j === i ? { ...s, note: e.target.value } : s)) }))} />
                                )}</FormField>
                            </div>
                        );
                    })}
                </div>
            </Section>

            <Section title="Penyimpangan & keterlambatan" subtitle={`${form.deviasi.length} catatan`}
                actions={<Button icon={<Plus className="fi-icon" aria-hidden />} style={{ minHeight: 44 }} onClick={() => set((v) => ({ ...v, deviasi: [...v.deviasi, { spv: "", catatan: "" }] }))}>Tambah</Button>}>
                <div className="fi-sect-in">
                    {form.deviasi.length === 0 && <p className="fi-small fi-subtle">Belum ada penyimpangan dicatat.</p>}
                    {form.deviasi.map((d, i) => (
                        <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
                            <FormField label={`SPV (baris ${i + 1})`}>{(a) => (
                                <input {...a} className="fi-input" style={{ minHeight: 44 }} value={d.spv}
                                    onChange={(e) => set((v) => ({ ...v, deviasi: v.deviasi.map((x, j) => (j === i ? { ...x, spv: e.target.value } : x)) }))} />
                            )}</FormField>
                            <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto">
                                <FormField label={`Catatan (baris ${i + 1})`}>{(a) => (
                                    <input {...a} className="fi-input" style={{ minHeight: 44 }} value={d.catatan} placeholder="Penyimpangan / keterlambatan"
                                        onChange={(e) => set((v) => ({ ...v, deviasi: v.deviasi.map((x, j) => (j === i ? { ...x, catatan: e.target.value } : x)) }))} />
                                )}</FormField>
                            </div>
                            <Button variant="icon" aria-label={`Hapus penyimpangan baris ${i + 1}`} style={{ width: 44, height: 44 }}
                                className="col-start-2 row-start-1 sm:col-start-auto sm:row-start-auto"
                                onClick={() => set((v) => ({ ...v, deviasi: v.deviasi.filter((_, j) => j !== i) }))}>
                                <Trash2 className="fi-icon" aria-hidden />
                            </Button>
                        </div>
                    ))}
                </div>
            </Section>

            <Section title="Follow-up SM">
                <div className="fi-sect-in">
                    <FormField label="Tindak lanjut SM hari ini">{(a) => (
                        <textarea {...a} className="fi-input" rows={3} value={form.followUp} placeholder="Tindak lanjut SM terhadap kondisi lapangan hari ini"
                            onChange={(e) => set((v) => ({ ...v, followUp: e.target.value }))} />
                    )}</FormField>
                    <div className="fi-btnrow">
                        {blokir && <span className="fi-small fi-subtle">{blokir}</span>}
                        <span style={{ flex: 1 }} />
                        <Button variant="primary" style={{ minHeight: 44 }} icon={<Save className="fi-icon" aria-hidden />} disabled={Boolean(blokir)} disabledReason={blokir}
                            onClick={() => { setSukses(""); setDialog(true); }}>
                            Simpan Kontrol SM
                        </Button>
                    </div>
                </div>
            </Section>
            <VariantNote bl="BL-32">
                Kontrol SM dibaca dan ditulis per nama SM tanpa cek cakupan di server. Setiap simpan menambah catatan baru; bila disimpan lebih
                dari sekali sehari, yang dimuat saat halaman dibuka bisa catatan pertama — lihat jam &quot;tersimpan&quot; di atas.
            </VariantNote>
            <ConfirmDialog
                open={dialog}
                onClose={() => setDialog(false)}
                title="Simpan Kontrol SM hari ini?"
                facts={[
                    ["SM", smName],
                    ["Tanggal", tanggalPendek(date)],
                    ["JKS dicek", form.jksChecked ? "Ya" : "Belum"],
                    ["Foto dimonitor", form.fotoChecked ? "Ya" : "Belum"],
                    ["Catatan coaching", `${form.spvList.filter((s) => s.note.trim()).length} dari ${form.spvList.length} SPV`],
                    ["Penyimpangan", `${form.deviasi.length} catatan`],
                    ...(tersimpanJam ? [["Sudah tersimpan", `${jamWita(tersimpanJam)} WITA — menyimpan lagi menambah catatan baru`] as [string, string]] : []),
                ]}
                confirmLabel="Simpan"
                confirmDisabled={blokir}
                onConfirm={async () => {
                    const isi = form;
                    const coachingNote = isi.spvList.filter((s) => s.note.trim()).map((s) => `${s.name}: ${s.note}`).join("\n");
                    await tulisFk("/api/form-kontrol/sm-control", {
                        body: {
                            smName, date,
                            spvChecked: isi.spvList,
                            jksChecked: isi.jksChecked,
                            fotoChecked: isi.fotoChecked,
                            coachingNote,
                            deviations: isi.deviasi,
                            followUp: isi.followUp,
                        },
                        gagal: "Kontrol SM belum tersimpan.",
                    });
                    setDialog(false);
                    setUbah(isi);
                    setDasar(isi);
                    setDisimpan(new Date().toISOString());
                    setSukses("Kontrol SM tersimpan.");
                }}
            />
        </>
    );
}
