/*
 * Tujuan: Modul Ringkasan OFF Program Control (Fiori S4d, tab `overview`; admin, OM): Overview Page — angka utama (admin: kesehatan
 *   proses; non-admin: metrik lama), jumlah batch per tahap (ubin membuka "Semua pengajuan" tersaring tahap itu), lewat SLA,
 *   Tutup periode + Diajukan vs diklaim, dan untuk admin Butuh perhatian / Antrean per divisi / Pengajuan bermasalah / Aktivitas
 *   terakhir — plus tampilan "Semua pengajuan" (FCL semua batch + Object Page). `?batch=` selalu membuka "Semua pengajuan" dengan
 *   batch itu di kolom kedua (tautan lama lonceng/pencarian).
 * Caller: OpcApp.tsx (MODUL.overview).
 * Dependensi: opc/Bersama (KerjaPeran, kontrak), opc/ObjectPageBatch, opc/peran/{RingkasanPeriode,RingkasanAdmin}, components/fiori/core,
 *   lib/opc-ui.
 * Main Functions: Ringkasan, IkhtisarTahap, MetrikUmum.
 * Side Effects: Tulis hanya lewat RingkasanPeriode (POST /periods dari dialog `tutup` / buka kunci).
 *
 * Asal fitur (old-opc.tsx): AdminHealthPanel 2363 + buildAdminQueueStats 848 → RingkasanAdmin; PeriodClosurePanel 1908 (confirm
 *  peramban 1987/2032 → dialog) + ClaimComparisonSummary 1868 / computeClaimComparison 697 → RingkasanPeriode; metrik non-admin
 *  10387–10428 (SummaryStrip 2254) → MetrikUmum; spanduk `?mock=` 10451; daftar Semua Status + saringan 10482–10535 dan
 *  OverviewDetailDrawer 9919–10215 → "Semua pengajuan" (KerjaPeran + Object Page); pendingBatchId 10313 → `?batch=`.
 *  Tidak diport: SupportTogglePanel 2212 (lipatan "Tampilkan kontrol" — bagian kini selalu tampil), WorkflowStepper 2668 (Flow 7
 *  tahap), AdminViewSelector 2301 (navigasi tab), "Detail akses" 10809 (peran tampil di kepala halaman), paidIncompleteCount 10575
 *  (dihitung tapi tidak pernah ditampilkan).
 */
"use client";

import { useState } from "react";
import { Button, EmptyState, ErrorState, MessageStrip, Section, Skeleton, StatusBadge, Tile, VariantNote } from "@/components/fiori/core";
import { OPSI_TAHAP, PREDIKAT, TAMPILAN, labelMasalah, tahapBatch, toneMasalah, type BatchOpc, type TahapKey } from "@/lib/opc-ui";
import { KerjaPeran, type DetailProps, type PeranProps } from "../Bersama";
import { ObjectPageBatch } from "../ObjectPageBatch";
import { AngkaAdmin, BagianAdmin, ButuhPerhatian, hitungAdmin } from "./RingkasanAdmin";
import { BagianPeriode, usePeriode, type PeriodeState } from "./RingkasanPeriode";

/** Kolom kedua Ringkasan: baca-saja (admin melihat semua batch). */
function DetailRingkasan(props: DetailProps) {
    return <ObjectPageBatch {...props} />;
}

export default function Ringkasan(props: PeranProps) {
    const { ctx, daftar } = props;
    const [tahapAwal, setTahapAwal] = useState<TahapKey | "">("");
    // Pilihan periode dan status periode yang diketahui di sesi ini bertahan saat pindah ke "Semua pengajuan" dan kembali.
    const periode = usePeriode(daftar.batches);
    const semua = ctx.sub === "semua" || Boolean(ctx.batchId);
    return (
        <div style={{ display: "grid", gap: 12 }}>
            {ctx.devBatchCount > 0 && (
                <MessageStrip tone="warn" title={`Mode data uji aktif: ${ctx.devBatchCount.toLocaleString("id-ID")} pengajuan sintetis.`}>
                    Data ini hanya ada di memori peramban dan tidak tersimpan ke database.
                </MessageStrip>
            )}
            <div className="fi-segs" role="group" aria-label="Tampilan ringkasan">
                <button type="button" aria-pressed={!semua} onClick={() => ctx.ubahUrl({ view: null, batch: null })}>Ringkasan</button>
                <button type="button" aria-pressed={semua} onClick={() => { setTahapAwal(""); ctx.pilihSub("semua"); }}>Semua pengajuan ({daftar.batches.length})</button>
            </div>
            {semua
                ? <KerjaPeran key={tahapAwal} {...props} tampilan={TAMPILAN.overview} saringanAwal={{ tahap: tahapAwal }} Detail={DetailRingkasan} />
                : <IkhtisarTahap {...props} periode={periode} buka={(t) => { setTahapAwal(t); ctx.pilihSub("semua"); }} />}
        </div>
    );
}

/** Overview Page. Galat tidak tampil sebagai nol; kosong = periode baru tanpa batch. */
function IkhtisarTahap({ ctx, daftar, buka, periode }: PeranProps & { buka: (t: TahapKey) => void; periode: PeriodeState }) {
    const { load, batches, masalah, masalahPer } = daftar;
    if (load.status === "memuat" && !load.data) return <Skeleton rows={6} label="Memuat ringkasan" />;
    if (load.status === "galat" && !load.data) {
        return <ErrorState title="Ringkasan gagal dimuat" message={`${load.error ?? ""} Angka tidak ditampilkan agar tidak terbaca sebagai nol.`} onRetry={daftar.muatUlang} />;
    }
    if (batches.length === 0) return <EmptyState title="Belum ada batch" message="Batch muncul setelah Supervisor menyimpan draf pertama." />;
    const perTahap = new Map<TahapKey, { n: number; telat: number }>();
    for (const b of batches) {
        const t = tahapBatch(b);
        const x = perTahap.get(t) ?? { n: 0, telat: 0 };
        perTahap.set(t, { n: x.n + 1, telat: x.telat + (masalahPer.has(b.id) ? 1 : 0) });
    }
    // Peran OFF admin = AdminHealthPanel lama; peran lain (OM) = SummaryStrip lama. Sama dengan isAdminOverview kode lama.
    const admin = ctx.peran === "admin" ? hitungAdmin(batches) : null;
    return (
        <div style={{ display: "grid", gap: 12 }} aria-busy={load.status === "memuat" || undefined}>
            {load.status === "galat" && (
                <MessageStrip tone="neg" title="Gagal memuat ulang ringkasan.">
                    {load.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={daftar.muatUlang}>Coba lagi</Button>
                </MessageStrip>
            )}
            {admin ? <AngkaAdmin h={admin} /> : <MetrikUmum batches={batches} />}
            <Section title="Antrean per tahap" subtitle={`${batches.length} batch terbaru`}>
                <div className="fi-sect-in">
                    <div className="fi-tiles" role="group" aria-label="Batch per tahap">
                        {OPSI_TAHAP.map((o) => {
                            const x = perTahap.get(o.kunci) ?? { n: 0, telat: 0 };
                            return <Tile key={o.kunci} title={o.label} value={x.n} tone={x.telat ? "warn" : undefined} onClick={() => buka(o.kunci)}
                                footer={x.telat ? `${x.telat} lewat SLA` : "Buka daftar"} />;
                        })}
                    </div>
                </div>
            </Section>
            <div style={{ display: "grid", gap: 12, alignItems: "start", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 30rem), 1fr))" }}>
                <Section title="Lewat SLA" subtitle={`${masalah.length} peringatan`}>
                    {masalah.length === 0 ? <EmptyState title="Tidak ada batch yang lewat SLA" /> : (
                        <ul className="fi-hist" aria-label="Batch lewat SLA">
                            {masalah.slice(0, 10).map((m) => (
                                <li key={m.batchId + m.code}>
                                    <time><StatusBadge tone={toneMasalah(m.severity)}>{labelMasalah(m.severity)}</StatusBadge></time>
                                    <span><b className="fi-mono">{m.noPengajuan}</b> · {m.title} · {m.principleName}</span>
                                    <span className="fi-chg">{m.message} <Button variant="tertiary" onClick={() => ctx.bukaBatch(m.batchId)}>Buka</Button></span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>
                {admin && <ButuhPerhatian h={admin} />}
                <BagianPeriode ctx={ctx} daftar={daftar} periode={periode} />
                {admin && <BagianAdmin ctx={ctx} daftar={daftar} h={admin} />}
            </div>
            <VariantNote bl="BL-11">Lewat SLA dihitung di browser dari 200 batch terbaru (hari kerja, libur nasional). Usulan: dihitung server, dipakai lonceng dan Kotak Tugas.</VariantNote>
            <VariantNote bl="BL-13">Angka per tahap, per divisi, dan per periode hanya dari 200 batch terbaru. Usulan: satu ringkasan dari server untuk seluruh periode.</VariantNote>
        </div>
    );
}

/** Metrik non-admin (old-opc.tsx 10387–10428): total, menunggu SM/OM (predikat aksi lama), selesai, dibayar belum lengkap. */
function MetrikUmum({ batches }: { batches: BatchOpc[] }) {
    const metrik: Array<[string, number, string]> = [
        ["Total pengajuan", batches.length, "200 batch terbaru"],
        ["Menunggu tinjauan SM", batches.filter(PREDIKAT.smAntrean).length, "dikirim, belum ditinjau"],
        ["Menunggu persetujuan OM", batches.filter(PREDIKAT.omAntrean).length, "disetujui Klaim"],
        ["Selesai", batches.filter((b) => b.status === "Completed" || b.finalStatus === "Completed").length, "verifikasi final selesai"],
        ["Sudah dibayar, belum lengkap", batches.filter((b) => b.status === "Paid" && b.finalStatus !== "Completed").length, "menunggu verifikasi final"],
    ];
    return (
        <div className="fi-kcards" role="group" aria-label="Metrik pengajuan">
            {metrik.map(([label, n, ket]) => <div key={label} className="fi-kc"><span>{label}</span><b>{n}</b><small>{ket}</small></div>)}
        </div>
    );
}
