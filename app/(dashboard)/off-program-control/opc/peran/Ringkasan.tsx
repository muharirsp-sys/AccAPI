/*
 * Tujuan: Modul Ringkasan OFF Program Control (Fiori S4d, tab `overview`; admin, OM): Overview Page berurutan ringkasan lalu tindakan:
 *   angka ringkas (admin: kesehatan proses; non-admin: metrik lama) sebagai daftar label-nilai, jumlah batch per tahap (ubin membuka
 *   "Semua pengajuan" tersaring tahap itu), Lewat SLA, untuk admin Butuh perhatian (termasuk tabel Perlu ditinjau admin) / Antrean per
 *   divisi / Aktivitas terakhir, lalu Tutup periode + Diajukan vs diklaim; plus tampilan "Semua pengajuan" (FCL semua batch + Object
 *   Page). `?batch=` selalu membuka "Semua pengajuan" dengan batch itu di kolom kedua (tautan lama lonceng/pencarian).
 * Caller: OpcApp.tsx (MODUL.overview).
 * Dependensi: opc/Bersama (KerjaPeran, kontrak), opc/ObjectPageBatch, opc/peran/{RingkasanPeriode,RingkasanAdmin}, components/fiori/core,
 *   lib/opc-ui (BATAS_DAFTAR untuk keterangan "dari 200 terbaru").
 * Main Functions: Ringkasan, IkhtisarTahap, MetrikUmum.
 * Side Effects: Tulis hanya lewat RingkasanPeriode (POST /periods dari dialog `tutup` / buka kunci).
 *
 * Port dari AdminHealthPanel, PeriodClosurePanel, ClaimComparisonSummary, SummaryStrip, dan OverviewDetailDrawer kode lama (lihat git).
 * Tidak diport: lipatan "Tampilkan kontrol" (bagian kini selalu tampil), WorkflowStepper (diganti Flow 7 tahap), AdminViewSelector
 * (navigasi tab), "Detail akses" (peran tampil di kepala halaman), paidIncompleteCount (dihitung tapi tidak pernah ditampilkan).
 */
"use client";

import { useState } from "react";
import { Button, EmptyState, ErrorState, KeyValues, MessageStrip, Section, Skeleton, StatusBadge, Tile, VariantNote } from "@/components/fiori/core";
import { BATAS_DAFTAR, OPSI_TAHAP, PREDIKAT, TAMPILAN, labelMasalah, tahapBatch, toneMasalah, type BatchOpc, type TahapKey } from "@/lib/opc-ui";
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
                <button type="button" aria-pressed={semua} onClick={() => { setTahapAwal(""); ctx.pilihSub("semua"); }}>
                    Semua pengajuan{daftar.load.data ? ` (${daftar.batches.length})` : ""}
                </button>
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
    // AM-026: Manager (dulu dipetakan ke admin) tetap melihat panel pantau yang sama — panel ini baca-saja.
    const admin = ctx.peran === "admin" || ctx.peran === "manager" ? hitungAdmin(batches) : null;
    // Daftar dari server dibatasi 200 batch terbaru (BL-13): angka di halaman ini bisa tidak lengkap. Rumus tidak berubah.
    const terpotong = batches.length >= BATAS_DAFTAR;
    const grid = { display: "grid", gap: 12, alignItems: "start", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 30rem), 1fr))" } as const;
    return (
        <div style={{ display: "grid", gap: 12 }} aria-busy={load.status === "memuat" || undefined}>
            {load.status === "galat" && (
                <MessageStrip tone="neg" title="Gagal memuat ulang ringkasan.">
                    {load.error} Yang tampil adalah hasil sebelumnya. <Button variant="tertiary" onClick={daftar.muatUlang}>Coba lagi</Button>
                </MessageStrip>
            )}
            {terpotong && (
                <MessageStrip tone="warn" title={`Angka dihitung dari ${BATAS_DAFTAR} batch terbaru.`}>
                    Batch yang lebih lama tidak ikut terhitung, jadi jumlah per tahap, per divisi, dan per periode bisa lebih kecil dari sebenarnya.
                </MessageStrip>
            )}
            {admin ? <AngkaAdmin h={admin} /> : <MetrikUmum batches={batches} terpotong={terpotong} />}
            <Section title="Antrean per tahap" subtitle={terpotong ? `${BATAS_DAFTAR} batch terbaru (batas daftar)` : `${batches.length} batch`}>
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
            <div style={grid}>
                <Section title="Lewat SLA" subtitle={masalah.length > 10 ? `10 teratas dari ${masalah.length} peringatan; semuanya ada di lonceng Lewat SLA` : `${masalah.length} peringatan`}>
                    {masalah.length === 0 ? <EmptyState title="Tidak ada batch yang lewat SLA" /> : (
                        <ul className="fi-hist" aria-label="Batch lewat SLA">
                            {masalah.slice(0, 10).map((m) => (
                                <li key={m.batchId + m.code}>
                                    <span><StatusBadge tone={toneMasalah(m.severity)}>{labelMasalah(m.severity)}</StatusBadge></span>
                                    <span><b className="fi-mono">{m.noPengajuan}</b> · {m.title} · {m.principleName}</span>
                                    <span className="fi-chg">{m.message} <Button variant="tertiary" aria-label={`Buka ${m.noPengajuan}`} onClick={() => ctx.bukaBatch(m.batchId)}>Buka</Button></span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>
                {admin && <ButuhPerhatian ctx={ctx} daftar={daftar} h={admin} />}
                {admin && <BagianAdmin ctx={ctx} daftar={daftar} h={admin} />}
            </div>
            {/* Tindakan sesudah ringkasan: Tutup periode tidak terselip di antara daftar baca. */}
            <div style={grid}>
                <BagianPeriode ctx={ctx} daftar={daftar} periode={periode} />
            </div>
            {/* Satu catatan varian per layar (audit No 80): BL-11 dan BL-13 digabung. */}
            <VariantNote bl="BL-11, BL-13">Lewat SLA (hari kerja, libur nasional) dan angka per tahap, per divisi, dan per periode dihitung di browser dari 200 batch
                terbaru. Usulan: satu ringkasan dan hitungan SLA dari server untuk seluruh periode, dipakai juga lonceng dan Kotak Tugas.</VariantNote>
        </div>
    );
}

/** Metrik non-admin (SummaryStrip kode lama): total, menunggu SM/OM (predikat aksi lama), selesai, dibayar belum lengkap. Daftar label-nilai, bukan kartu KPI. */
function MetrikUmum({ batches, terpotong }: { batches: BatchOpc[]; terpotong: boolean }) {
    const metrik: Array<[string, number, string]> = [
        ["Total pengajuan", batches.length, terpotong ? `batas ${BATAS_DAFTAR} batch terbaru` : "semua yang dimuat"],
        ["Menunggu tinjauan SM", batches.filter(PREDIKAT.smAntrean).length, "dikirim, belum ditinjau"],
        ["Menunggu persetujuan OM", batches.filter(PREDIKAT.omAntrean).length, "disetujui Klaim"],
        ["Selesai", batches.filter((b) => b.status === "Completed" || b.finalStatus === "Completed").length, "verifikasi final selesai"],
        ["Sudah dibayar, belum lengkap", batches.filter((b) => b.status === "Paid" && b.finalStatus !== "Completed").length, "menunggu verifikasi final"],
    ];
    return (
        <Section title="Ringkasan pengajuan">
            <div className="fi-sect-in" role="group" aria-label="Metrik pengajuan" style={{ maxWidth: "36rem" }}>
                <KeyValues items={metrik.map(([label, n, ket]) => [label, <span key={label} className="fi-tnum">{n}<span className="fi-sub">{ket}</span></span>])} />
            </div>
        </Section>
    );
}
