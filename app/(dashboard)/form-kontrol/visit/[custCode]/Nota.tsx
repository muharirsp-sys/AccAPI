/*
 * Tujuan: Nota belum lunas toko di wizard Kunjungan (owner 16 Nov 2026): ringkasan (jumlah nota, keluar, tertagih, sisa, umur tertua) yang selalu
 *   terlihat + rincian per nota (tanggal, umur, jatuh tempo, nilai, tertagih, sisa, pembayaran yang tercatat Incaso) yang bisa dibuka; pertanyaan
 *   hasil tagih di langkah Status (tertagih + nominal / tidak tertagih + alasan) memakai ringkasan yang sama.
 * Caller: ./Kunjungan.tsx.
 * Dependensi: GET /api/form-kontrol/nota, lib/form-kontrol/nota (tipe), lib/form-kontrol/constants (ALASAN_TIDAK_TERTAGIH), components/fiori/*,
 *   lib/promo-ui (rupiah), lib/tampil (tanggalWita, waktuWita), ../../lapangan (ambilJson, sebabGagal, PESAN_SINYAL).
 * Main Functions: useNota, PanelNota, IsianTagihan, tagihanDariIsian.
 * Side Effects: HTTP baca saja.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { ReceiptText, RefreshCw } from "lucide-react";
import { Button, MessageStrip, StatusBadge } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";
import { ALASAN_TIDAK_TERTAGIH } from "@/lib/form-kontrol/constants";
import type { BayarNota, NotaToko, Tagihan } from "@/lib/form-kontrol/nota";
import { rupiah } from "@/lib/promo-ui";
import { tanggalWita, waktuWita } from "@/lib/tampil";
import { PESAN_SINYAL, ambilJson, sebabGagal } from "../../lapangan";

export type MuatNota = { status: "memuat" } | { status: "galat"; error: string } | { status: "siap"; nota: NotaToko | null };

/** Nota toko kunjungan; dimuat terpisah dari data kunjungan supaya wizard tetap terbuka cepat bila Accurate lambat. */
export function useNota(k: { salesCode: string; custCode: string; principle: string }): [MuatNota, () => void] {
    const [m, setM] = useState<MuatNota>({ status: "memuat" });
    const [ke, setKe] = useState(0);
    useEffect(() => {
        let batal = false;
        void ambilJson(`/api/form-kontrol/nota?${new URLSearchParams(k)}`).then((r) => {
            if (batal) return;
            if (r.status >= 200 && r.status < 300 && r.data) setM({ status: "siap", nota: (r.data.nota as NotaToko | null) ?? null });
            else setM({ status: "galat", error: r.status === 0 ? PESAN_SINYAL : (typeof r.data?.error === "string" ? r.data.error : sebabGagal(r.status)) });
        });
        return () => { batal = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kunci = tiga teks; objek k baru tiap render
    }, [k.salesCode, k.custCode, k.principle, ke]);
    const ulang = useCallback(() => { setM({ status: "memuat" }); setKe((x) => x + 1); }, []);
    return [m, ulang];
}

const METODE: Record<string, string> = { CASH_OTHER: "Tunai", BANK_TRANSFER: "Transfer", BANK_CHEQUE: "Giro/cek", OTHERS: "Lainnya" };

export function PanelNota({ m, onUlang }: { m: MuatNota; onUlang: () => void }) {
    if (m.status === "memuat") return <p className="fi-small fi-subtle" role="status">Memuat nota belum lunas dari Accurate…</p>;
    if (m.status === "galat") {
        return (
            <MessageStrip tone="warn" title="Nota belum lunas tidak terbaca.">
                {m.error} <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={onUlang}>Coba lagi</Button>
            </MessageStrip>
        );
    }
    const n = m.nota;
    if (!n) return null; // toko tanpa pelanggan cabang principal (NOO / principal gabungan): tidak ada nota yang bisa dibaca
    const sumber = n.sumber === "accurate" ? `Langsung dari Accurate, ${waktuWita(n.dibacaPada)} WITA.`
        : "Accurate tidak terbaca; ini data sinkron terakhir (bisa tertinggal ± 1 jam).";
    if (n.ringkas.jumlah === 0) {
        return <p className="fi-small"><ReceiptText className="fi-icon" aria-hidden style={{ verticalAlign: "-3px" }} /> Tidak ada nota belum lunas. <span className="fi-subtle">{sumber}</span></p>;
    }
    const r = n.ringkas;
    const bayarPer = new Map<number, BayarNota[]>();
    for (const b of n.bayar) bayarPer.set(b.fakturId, [...(bayarPer.get(b.fakturId) ?? []), b]);
    return (
        <details className="fi-panel" style={{ gap: 8 }}>
            <summary style={{ cursor: "pointer", listStyle: "revert" }}>
                <b>{r.jumlah} nota belum lunas · sisa {rupiah(r.sisa)}</b>
                <span className="fi-small"> · tertua {r.umurMaks} hari</span>
                {r.lewatTempo > 0 && <> <StatusBadge tone="neg">{r.lewatTempo} lewat jatuh tempo</StatusBadge></>}
            </summary>
            <p className="fi-small fi-tnum" style={{ marginTop: 8 }}>
                Keluar {rupiah(r.nilai)} · tertagih {rupiah(r.tertagih)} · sisa <b>{rupiah(r.sisa)}</b>
            </p>
            <ul aria-label="Nota belum lunas" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {n.nota.map((x) => (
                    <li key={x.id} style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="fi-mono">{x.nomor}</span>
                            <StatusBadge tone={x.lewatTempo ? "neg" : x.umur > 30 ? "warn" : "neu"}>{x.umur} hari{x.lewatTempo ? ` · lewat tempo ${x.lewatTempo} hari` : ""}</StatusBadge>
                        </div>
                        <div className="fi-small fi-tnum">
                            {tanggalWita(x.tanggal)}{x.jatuhTempo ? ` · jatuh tempo ${tanggalWita(x.jatuhTempo)}` : ""}
                            <br />Nilai {rupiah(x.nilai)} · tertagih {rupiah(x.tertagih)} · sisa <b>{rupiah(x.sisa)}</b>
                        </div>
                        {(bayarPer.get(x.id) ?? []).map((b) => (
                            <div key={`${b.nomor}-${b.tanggal}`} className="fi-small fi-subtle fi-tnum">
                                Dibayar {tanggalWita(b.tanggal)} · {rupiah(b.nominal)} · {METODE[b.metode] ?? b.metode} · {b.nomor}
                            </div>
                        ))}
                    </li>
                ))}
            </ul>
            <p className="fi-small fi-subtle">{sumber}{n.terpotong ? " Daftar dari Accurate terpotong (lebih dari 300 nota); angka bisa kurang." : ""} Pembayaran = pelunasan yang sudah diinput Incaso.</p>
        </details>
    );
}

/** Isian hasil tagih di layar (teks mentah) -> Tagihan yang dikirim ke server; null = belum lengkap. */
export type IsiTagih = { status: "tertagih" | "tidak_tertagih" | null; nominal: string; alasan: string; catatan: string };
export function tagihanDariIsian(t: IsiTagih): Tagihan | null {
    const catatan = t.catatan.trim() || null;
    if (t.status === "tertagih") {
        const n = Number(t.nominal.replace(/[^\d]/g, ""));
        return n > 0 ? { status: "tertagih", nominal: n, catatan } : null;
    }
    if (t.status === "tidak_tertagih") return t.alasan && (t.alasan !== "LAINNYA" || catatan) ? { status: "tidak_tertagih", alasan: t.alasan, catatan } : null;
    return null;
}
export function kurangTagih(t: IsiTagih): string | undefined {
    if (!t.status) return "Pilih hasil tagih nota";
    if (t.status === "tertagih" && !tagihanDariIsian(t)) return "Isi nominal tertagih";
    if (t.status === "tidak_tertagih" && !t.alasan) return "Pilih alasan tidak tertagih";
    if (t.status === "tidak_tertagih" && !tagihanDariIsian(t)) return "Tulis catatan untuk alasan Lainnya";
    return undefined;
}

/** Pertanyaan hasil tagih (langkah Status). `wajib` false = Accurate tidak terbaca: boleh dilewati. */
export function IsianTagihan({ t, ubah, sisa, wajib }: { t: IsiTagih; ubah: (p: Partial<IsiTagih>) => void; sisa: number | null; wajib: boolean }) {
    return (
        <div className="fi-panel">
            <h2 className="fi-title-3">Tagihan nota</h2>
            <p className="fi-small fi-muted">
                {sisa !== null ? `Toko ini punya nota belum lunas, sisa ${rupiah(sisa)}. ` : "Nota toko ini tidak terbaca; isi bila Anda menagih. "}
                Hasilnya langsung terlihat oleh Incaso.
            </p>
            <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Hasil tagih nota">
                {(["tertagih", "tidak_tertagih"] as const).map((s) => (
                    <label key={s} className="fi-btn fi-btn--secondary" style={{ height: "auto", minHeight: 52, gap: 8, whiteSpace: "normal",
                        ...(t.status === s ? { background: s === "tertagih" ? "var(--pos-bg)" : "var(--neg-bg)", borderColor: s === "tertagih" ? "var(--pos)" : "var(--neg)", color: s === "tertagih" ? "var(--pos)" : "var(--neg)" } : {}) }}>
                        <input type="radio" name="hasil-tagih" value={s} checked={t.status === s} onChange={() => ubah({ status: s })}
                            style={{ width: 20, height: 20, minHeight: 0, minWidth: 0, margin: 0, accentColor: "var(--primary)" }} />
                        {s === "tertagih" ? "Tertagih" : "Tidak tertagih"}
                    </label>
                ))}
            </div>
            {t.status === "tertagih" && (
                <FormField label="Nominal tertagih (Rp)" required={wajib}>
                    {(a) => <input {...a} className="fi-input fi-tnum" inputMode="numeric" value={t.nominal} placeholder="Contoh: 1500000"
                        onChange={(e) => ubah({ nominal: e.target.value.replace(/[^\d]/g, "") })} />}
                </FormField>
            )}
            {t.status === "tidak_tertagih" && (
                <FormField label="Alasan tidak tertagih" required={wajib}>
                    {(a) => (
                        <select {...a} className="fi-input" value={t.alasan} onChange={(e) => ubah({ alasan: e.target.value })}>
                            <option value="">Pilih alasan</option>
                            {ALASAN_TIDAK_TERTAGIH.filter((x) => x.kode !== "TOKO_TUTUP").map((x) => <option key={x.kode} value={x.kode}>{x.label}</option>)}
                        </select>
                    )}
                </FormField>
            )}
            {t.status && (
                <FormField label="Catatan tagih" required={t.status === "tidak_tertagih" && t.alasan === "LAINNYA"}>
                    {(a) => <input {...a} className="fi-input" value={t.catatan} maxLength={300} placeholder={t.status === "tertagih" ? "Mis. tunai, transfer, giro" : "Mis. janji bayar Kamis"}
                        onChange={(e) => ubah({ catatan: e.target.value })} />}
                </FormField>
            )}
            {!wajib && t.status && <Button variant="tertiary" onClick={() => ubah({ status: null, nominal: "", alasan: "", catatan: "" })}>Kosongkan</Button>}
        </div>
    );
}
