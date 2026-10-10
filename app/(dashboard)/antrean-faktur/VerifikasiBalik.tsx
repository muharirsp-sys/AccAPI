/*
 * Tujuan: Bagian "Verifikasi balik" layar Antrean Faktur (Fiori S6c, it02 #6): faktur yang sudah ada di salinan Accurate
 *   disandingkan dengan payload yang dikirim; selisih terbuka langsung terlihat (tidak terlipat); "Terima sales / Cabut" dari main
 *   dipertahankan (C6); penjelasan selisih isi ditulis di baris (Draf = sudah diketik, belum disimpan).
 * Caller: app/(dashboard)/antrean-faktur/AntreanFaktur.tsx.
 * Dependensi: GET/POST/DELETE /api/invoice-verify (baca salinan lokal; tulis hanya invoice_verify_note), components/fiori/*,
 *   ./bersama (tulis), lib/rekapan-nota/ui (ambil, jamWita).
 * Main Functions: VerifikasiBalik.
 * Side Effects: POST/DELETE penjelasan selisih (tidak menyentuh Accurate, tidak mengubah antrean).
 *
 * Dimuat TERPISAH dari antrean (useLoad sendiri di AntreanFaktur): galat antrean tidak membuat bagian ini menunggu, dan sebaliknya
 * (celah main #12).
 */
"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, MessageStrip, Section, Skeleton, StatusBadge } from "@/components/fiori/core";
import { useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { ambil, jamWita } from "@/lib/rekapan-nota/ui";
import { TidakPasti, pesanGagal, tulis } from "./bersama";

type Jenis = "sales" | "isi";
type Temuan = { line: number | null; field: string; expected: string; actual: string; jenis: Jenis | null; dijelaskan: boolean };
type Baris = {
    orderId: string; soNo: string | null; state: string; customerNo: string; matchedBy: string; foundWhileUnknown: boolean;
    status: "cocok" | "selisih" | "tak-terperiksa"; reason: string; findings: Temuan[]; invoiceNumber: string; linesChecked: number;
    salesman: string; invoiceDate: string; terbuka: number; sidik: Record<Jenis, string>;
    penjelasan: Partial<Record<Jenis, { note: string; by: string; at: string }>>;
};
export type Verif = { checked: number; summary: Record<string, number>; cacheTerpotong?: boolean; rows: Baris[] };

export const muatVerifikasi = (): Promise<Load<Verif>> => ambil<Verif>("/api/invoice-verify", (j) => j as Verif);

const JENIS: Jenis[] = ["sales", "isi"];

export default function VerifikasiBalik({ bolehUbah, load, muatUlang }: { bolehUbah: boolean; load: Load<Verif>; muatUlang: () => void }) {
    const [semua, setSemua] = useState(false);
    const [catatan, setCatatan] = useState<Record<string, string>>({});
    const [sibuk, setSibuk] = useState("");
    const [pesan, setPesan] = useState<{ tone: "pos" | "neg" | "warn"; teks: string } | null>(null);
    const draf = Object.values(catatan).some((v) => v.trim());
    useUnsavedGuard(draf);

    const v = load.data;
    const baris = (v?.rows ?? []).filter((r) => semua || (r.status === "selisih" && r.terbuka > 0) || r.foundWhileUnknown);
    const segar = load.status === "siap";
    const tolak = !bolehUbah ? "Hanya petugas berizin ubah order yang boleh menjelaskan selisih" : !segar ? "Tunggu verifikasi selesai dimuat" : "";

    async function jelaskan(r: Baris, jenis: Jenis, cabut = false) {
        const note = jenis === "isi" ? (catatan[r.orderId] ?? "").trim() : "";
        setSibuk(`${r.orderId}:${jenis}`);
        setPesan(null);
        try {
            const { status, data } = await tulis("/api/invoice-verify", { orderId: r.orderId, jenis, sidik: r.sidik[jenis], note }, { method: cabut ? "DELETE" : "POST" });
            if (status !== 200 || !data.ok) { setPesan({ tone: "neg", teks: pesanGagal(status, data, "Penjelasan gagal disimpan.") }); return; }
            if (jenis === "isi" && !cabut) setCatatan((c) => ({ ...c, [r.orderId]: "" }));
            setPesan({ tone: "pos", teks: cabut ? `Penjelasan SO ${r.soNo ?? r.orderId} dicabut; selisihnya terbuka lagi.`
                : jenis === "sales" ? `Sales di Accurate diterima untuk SO ${r.soNo ?? r.orderId}.` : `Selisih isi SO ${r.soNo ?? r.orderId} dijelaskan.` });
            muatUlang();
        } catch (e) {
            setPesan({ tone: "warn", teks: e instanceof TidakPasti ? e.message : "Penjelasan gagal disimpan." });
            muatUlang();
        } finally {
            setSibuk("");
        }
    }

    const ringkas = v ? `${v.checked} diperiksa · ${v.summary.cocok ?? 0} cocok · ${v.summary.dijelaskan ?? 0} dijelaskan · ${v.summary["tak-terperiksa"] ?? 0} belum bisa diperiksa` : "";
    return (
        <Section id="verifikasi" title="Verifikasi balik"
            subtitle={<>Dibandingkan dengan salinan faktur Accurate di aplikasi (diisi webhook dan sinkron), bukan Accurate langsung{ringkas ? ` · ${ringkas}` : ""}
                {(v?.summary.selisih ?? 0) > 0 && <> <StatusBadge tone="neg">{v!.summary.selisih} selisih belum dijelaskan</StatusBadge></>}
                {draf && <> <StatusBadge tone="warn">Penjelasan belum disimpan</StatusBadge></>}</>}
            actions={<>
                <label className="fi-check fi-small"><input type="checkbox" checked={semua} onChange={(e) => setSemua(e.target.checked)} />Tampilkan semua</label>
                <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={load.status === "memuat" && Boolean(v)} onClick={muatUlang}>Muat ulang</Button>
            </>}>
            <div className="fi-sect-in">
                {pesan && <MessageStrip tone={pesan.tone} onClose={() => setPesan(null)}>{pesan.teks}</MessageStrip>}
                {load.status === "galat" && v && <MessageStrip tone="neg" title="Verifikasi balik gagal dimuat ulang.">{load.error} Yang tampil hasil sebelumnya.</MessageStrip>}
                {v?.cacheTerpotong && <MessageStrip tone="warn">Calon faktur di salinan melewati batas baca; faktur tertua mungkin belum terperiksa.</MessageStrip>}
                {!v && load.status === "memuat" && <Skeleton rows={2} label="Membandingkan dengan salinan faktur Accurate" />}
                {!v && load.status === "galat" && <ErrorState title="Verifikasi balik gagal dimuat" message={`${load.error ?? ""} Antrean di atas tetap bisa dipakai.`} onRetry={muatUlang} />}
                {v && baris.length === 0 && (
                    <EmptyState title={v.rows.length ? "Tidak ada selisih yang belum dijelaskan" : "Belum ada faktur terkirim untuk diperiksa"}
                        message={v.rows.length ? "Centang Tampilkan semua untuk melihat yang cocok dan yang sudah dijelaskan." : undefined} />
                )}
                {baris.map((r) => {
                    const ketik = catatan[r.orderId] ?? "";
                    return (
                        <article key={r.orderId} className="fi-sect-in" style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }} aria-label={`Verifikasi SO ${r.soNo ?? r.orderId}`}>
                            <div className="fi-btnrow">
                                <b className="fi-mono">{r.invoiceNumber || "Faktur belum ketemu"}</b>
                                <span className="fi-mono fi-subtle">SO {r.soNo ?? r.orderId}</span>
                                {r.status === "cocok" && <StatusBadge tone="pos">Cocok ({r.linesChecked} baris)</StatusBadge>}
                                {r.status === "selisih" && r.terbuka > 0 && <StatusBadge tone="neg">{r.terbuka} selisih belum dijelaskan</StatusBadge>}
                                {r.status === "selisih" && r.terbuka === 0 && <StatusBadge tone="neu">Selisih dijelaskan</StatusBadge>}
                                {r.status === "tak-terperiksa" && <StatusBadge tone="warn">Belum bisa diperiksa</StatusBadge>}
                                {r.foundWhileUnknown && <StatusBadge tone="neg">Ada di salinan Accurate padahal Tidak pasti</StatusBadge>}
                                {ketik.trim() && <StatusBadge tone="warn">Belum disimpan</StatusBadge>}
                            </div>
                            <span className="fi-sub">
                                {r.matchedBy ? `dicocokkan lewat ${r.matchedBy === "charField1" ? "kunci antrean" : "id faktur"}` : "belum ketemu di salinan"}
                                {r.invoiceDate ? ` · tgl ${r.invoiceDate}` : ""}{r.salesman ? ` · sales ${r.salesman}` : " · tanpa sales"} · {r.customerNo}
                            </span>
                            {r.status === "tak-terperiksa" && <span className="fi-small fi-why">{r.reason}</span>}
                            {r.foundWhileUnknown && <span className="fi-small fi-why">Fakturnya ada — selesaikan baris Tidak pasti di antrean (Selesaikan…).</span>}
                            {r.findings.length > 0 && (
                                <ul className="fi-small" style={{ margin: 0, paddingLeft: 18 }}>
                                    {r.findings.map((f, i) => (
                                        <li key={i} className={f.dijelaskan ? "fi-subtle" : undefined}>
                                            {f.line ? `baris ${f.line} · ` : ""}{f.field}: dikirim <span className="fi-mono">{f.expected}</span>, di Accurate <span className="fi-mono">{f.actual}</span>
                                            {f.jenis === null && <b className="fi-why"> — bereskan di Accurate, tidak bisa dijelaskan</b>}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {JENIS.filter((j) => r.findings.some((f) => f.jenis === j)).map((j) => {
                                const sudah = r.penjelasan[j];
                                const id = `${r.orderId}:${j}`;
                                return (
                                    <div key={j} className="fi-btnrow">
                                        {sudah ? (
                                            <>
                                                <StatusBadge tone="pos">{j === "sales" ? "Sales di Accurate diterima" : "Isi dijelaskan"}</StatusBadge>
                                                <span className="fi-small">{j === "isi" ? `${sudah.note} · ` : ""}{sudah.by} · {jamWita(sudah.at)}</span>
                                                <Button variant="tertiary" busy={sibuk === id} disabled={Boolean(tolak) || Boolean(sibuk)} disabledReason={tolak || undefined}
                                                    onClick={() => void jelaskan(r, j, true)}>Cabut</Button>
                                            </>
                                        ) : j === "sales" ? (
                                            <Button busy={sibuk === id} disabled={Boolean(tolak) || Boolean(sibuk)} disabledReason={tolak || undefined}
                                                title="Sales sudah diganti di Accurate (mis. sales lama pindah divisi). Selisih isi, bila ada, tetap terbuka."
                                                onClick={() => void jelaskan(r, "sales")}>Terima sales di Accurate</Button>
                                        ) : (
                                            <>
                                                <input className="fi-input" style={{ flex: "1 1 14rem", width: "auto" }} value={ketik} maxLength={500}
                                                    aria-label={`Penjelasan selisih isi SO ${r.soNo ?? r.orderId}`} placeholder="Penjelasan, mis. koreksi qty saat pengiriman"
                                                    onChange={(e) => setCatatan((c) => ({ ...c, [r.orderId]: e.target.value }))} />
                                                <Button busy={sibuk === id} disabled={Boolean(tolak) || Boolean(sibuk) || !ketik.trim()}
                                                    disabledReason={tolak || (!ketik.trim() ? "Tulis penjelasannya dulu" : undefined)}
                                                    onClick={() => void jelaskan(r, "isi")}>Jelaskan selisih isi</Button>
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                        </article>
                    );
                })}
            </div>
        </Section>
    );
}
