/*
 * Tujuan: Tab Briefing Wajib SPV (Fiori S5, it05): sesi pagi/sore, agenda (checkbox asli dalam baris 44 px), toko dibahas,
 *   penyebab, solusi; simpan lewat dialog. Menampilkan briefing yang sudah tersimpan hari ini (GET briefing) supaya simpan ulang
 *   tidak diam-diam menambah catatan ganda. Tanggal = hari ini WITA.
 * Caller: form-kontrol/FormKontrol.tsx (tab "briefing").
 * Dependensi: ../shared (Scope, BRIEFING_AGENDA, hariIniWita, jamWita, ambilFk, tulisFk, useIzinFk), components/fiori/{core,interactive},
 *   lib/rekapan-nota/ui (tanggalPendek).
 * Main Functions: TabBriefing (default).
 * Side Effects: GET /api/form-kontrol/briefing?spvName&date; POST /api/form-kontrol/briefing (payload sama dengan hari ini).
 */
"use client";

import { useCallback, useState } from "react";
import { Pencil, Save } from "lucide-react";
import { Button, MessageStrip, Section, Skeleton } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { tanggalPendek } from "@/lib/rekapan-nota/ui";
import { BRIEFING_AGENDA, TulisTidakPasti, ambilFk, hariIniWita, jamWita, tulisFk, useIzinFk, type Scope } from "../shared";

type Sesi = "pagi" | "sore";
type Tersimpan = { session: string; createdAt: string | null };
const KOSONG = { agenda: [false, false, false, false, false], toko: "", penyebab: "", solusi: "" };
const LABEL: Record<Sesi, string> = { pagi: "Pagi", sore: "Sore" };

export default function TabBriefing({ scope }: { scope: Scope }) {
    const izin = useIzinFk("submit");
    const [date] = useState(hariIniWita);
    const spvName = scope.spvName ?? scope.salesName ?? "";
    const [sesi, setSesi] = useState<Sesi>("pagi");
    const [isi, setIsi] = useState(KOSONG);
    const [dasar, setDasar] = useState(KOSONG); // isian terakhir yang tersimpan (atau kosong) — pembanding draf
    const [dialog, setDialog] = useState(false);
    const [sukses, setSukses] = useState("");
    // Endpoint briefing selalu INSERT: setelah jawaban tidak pasti, simpan dikunci sampai daftar tersimpan dimuat ulang.
    const [tidakPasti, setTidakPasti] = useState(false);

    const [load, muatUlang] = useLoad(useCallback(async (): Promise<Load<Tersimpan[]>> => {
        if (!spvName) return { status: "siap", data: [] };
        return ambilFk(`/api/form-kontrol/briefing?${new URLSearchParams({ spvName, date })}`,
            (j) => (j.rows ?? []) as Tersimpan[], "Briefing tersimpan hari ini belum berhasil dimuat.");
    }, [spvName, date]));

    const dirty = JSON.stringify(isi) !== JSON.stringify(dasar);
    useUnsavedGuard(dirty);
    const items = BRIEFING_AGENDA[sesi];
    const selesai = isi.agenda.filter(Boolean).length;
    const sesiIni = (load.data ?? []).filter((b) => b.session === sesi);
    const terakhir = sesiIni.map((b) => b.createdAt).filter(Boolean).sort().at(-1) ?? null;
    const blokir = izin
        ?? (!spvName ? "Akun ini tidak tertaut ke nama SPV; briefing diisi oleh akun SPV." : undefined)
        ?? (tidakPasti ? "Hasil simpan terakhir belum pasti; muat ulang untuk memeriksa sebelum menyimpan lagi." : undefined)
        ?? (load.status !== "siap" ? "Briefing tersimpan belum termuat; simpan dikunci agar tidak tercatat ganda." : undefined);
    const muatPeriksa = () => { setTidakPasti(false); muatUlang(); };

    const gantiSesi = (s: Sesi) => {
        // Seperti hari ini: ganti sesi mengosongkan centang agenda (agenda pagi ≠ sore); teks tetap.
        setSesi(s);
        setIsi((v) => ({ ...v, agenda: [...KOSONG.agenda] }));
        setDasar((v) => ({ ...v, agenda: [...KOSONG.agenda] }));
        setSukses("");
    };

    return (
        <>
            {!spvName && (
                <MessageStrip tone="info" title="Briefing diisi oleh akun SPV.">Akun ini tidak tertaut ke nama SPV, jadi tidak bisa menyimpan briefing.</MessageStrip>
            )}
            {sukses && <MessageStrip tone="pos" title={sukses} onClose={() => setSukses("")} />}
            {tidakPasti && (
                <MessageStrip tone="warn" title="Hasil simpan terakhir belum pasti.">
                    Briefing mungkin sudah tersimpan. Muat ulang untuk melihat jumlah yang tersimpan sebelum menyimpan lagi.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatPeriksa}>Muat ulang</button>
                </MessageStrip>
            )}
            <Section
                title="Briefing Wajib SPV"
                subtitle={`Tugas SPV bukan menerima laporan, tetapi mengendalikan lapangan · ${tanggalPendek(date)}`}
                actions={dirty ? <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />Draf belum disimpan</span> : undefined}
            >
                <div className="fi-sect-in">
                    <div className="fi-segs" role="group" aria-label="Sesi briefing">
                        {(["pagi", "sore"] as const).map((s) => (
                            <button key={s} type="button" aria-pressed={sesi === s} style={{ height: 44, paddingInline: 20 }} onClick={() => gantiSesi(s)}>{LABEL[s]}</button>
                        ))}
                    </div>
                    {load.status === "memuat" && !load.data ? <Skeleton rows={1} label="Memuat briefing tersimpan" />
                        : load.status === "galat" ? (
                            <MessageStrip tone="neg" title="Briefing tersimpan belum berhasil dimuat.">
                                {(load.error ?? "").replace("Briefing tersimpan hari ini belum berhasil dimuat.", "").trim()} Belum diketahui apakah sesi ini sudah disimpan.{" "}
                                <button type="button" className="fi-btn fi-btn--tertiary" onClick={muatPeriksa}>Coba lagi</button>
                            </MessageStrip>
                        ) : spvName ? (
                            <p className="fi-small fi-subtle">
                                {(["pagi", "sore"] as const).map((s) => {
                                    const n = (load.data ?? []).filter((b) => b.session === s).length;
                                    return <span key={s}>{s === "sore" ? " · " : ""}{LABEL[s]}: {n ? `tersimpan ${n}×` : "belum disimpan"}</span>;
                                })}
                            </p>
                        ) : null}

                    <fieldset className="grid gap-1">
                        <legend className="fi-label">Agenda briefing {LABEL[sesi].toLowerCase()} ({selesai} dari {items.length})</legend>
                        {items.map((item, i) => (
                            <label key={item} className="fi-check" style={{ minHeight: 44 }}>
                                <input type="checkbox" checked={isi.agenda[i]} style={{ width: 20, height: 20 }}
                                    onChange={() => setIsi((v) => ({ ...v, agenda: v.agenda.map((x, j) => (j === i ? !x : x)) }))} />
                                {item}
                            </label>
                        ))}
                    </fieldset>

                    <FormField label="Toko yang dibahas">{(a) => <input {...a} className="fi-input" value={isi.toko} onChange={(e) => setIsi((v) => ({ ...v, toko: e.target.value }))} placeholder="Nama/kode toko yang dibahas" />}</FormField>
                    <FormField label="Penyebab">{(a) => <textarea {...a} className="fi-input" rows={2} value={isi.penyebab} onChange={(e) => setIsi((v) => ({ ...v, penyebab: e.target.value }))} placeholder="Penyebab utama toko tidak order / tidak dikunjungi" />}</FormField>
                    <FormField label="Solusi & tindak lanjut">{(a) => <textarea {...a} className="fi-input" rows={2} value={isi.solusi} onChange={(e) => setIsi((v) => ({ ...v, solusi: e.target.value }))} placeholder="Solusi yang disepakati dan tindak lanjut konkret" />}</FormField>

                    <div className="fi-btnrow">
                        {blokir && <span className="fi-small fi-subtle">{blokir}</span>}
                        <span className="fi-spacer" style={{ flex: 1 }} />
                        <Button variant="primary" style={{ minHeight: 44 }} icon={<Save className="fi-icon" aria-hidden />} disabled={Boolean(blokir)} disabledReason={blokir}
                            onClick={() => { setSukses(""); setDialog(true); }}>
                            Simpan briefing {LABEL[sesi].toLowerCase()}
                        </Button>
                    </div>
                </div>
            </Section>
            <ConfirmDialog
                open={dialog}
                onClose={() => setDialog(false)}
                title={`Simpan briefing ${LABEL[sesi].toLowerCase()}?`}
                facts={[
                    ["SPV", spvName],
                    ["Tanggal", tanggalPendek(date)],
                    ["Agenda selesai", `${selesai} dari ${items.length}`],
                    ["Toko dibahas", isi.toko || "—"],
                    ...(sesiIni.length ? [["Sudah tersimpan", `${sesiIni.length}× (terakhir ${jamWita(terakhir)} WITA) — menyimpan lagi menambah catatan baru`] as [string, string]] : []),
                ]}
                confirmLabel="Simpan briefing"
                confirmDisabled={blokir}
                onConfirm={async () => {
                    try {
                        await tulisFk("/api/form-kontrol/briefing", {
                            body: {
                                spvName, date, session: sesi,
                                agenda: items.filter((_, i) => isi.agenda[i]),
                                tokoDialas: isi.toko, penyebab: isi.penyebab, solusi: isi.solusi,
                            },
                            gagal: "Briefing belum tersimpan.",
                        });
                    } catch (e) {
                        if (e instanceof TulisTidakPasti) setTidakPasti(true);
                        throw e;
                    }
                    setDialog(false);
                    setDasar(isi);
                    setSukses(`Briefing ${LABEL[sesi].toLowerCase()} tersimpan.`);
                    muatUlang();
                }}
            />
        </>
    );
}
