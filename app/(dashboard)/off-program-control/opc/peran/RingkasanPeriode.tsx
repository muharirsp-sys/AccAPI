/*
 * Tujuan: Bagian periode di Ringkasan OFF Program Control (Fiori S4d): "Tutup periode" (port PeriodClosurePanel old-opc.tsx 1908–2210:
 *   principal/bulan/tahun, angka diajukan vs diklaim, detail rekonsiliasi per batch, unduh PDF rekonsiliasi, dialog `tutup` dan
 *   dialog buka kunci menggantikan confirm peramban) dan "Diajukan vs diklaim" per principal untuk bulan terpilih
 *   (computeClaimComparison 697–732, dulu ClaimComparisonSummary non-admin).
 * Caller: opc/peran/Ringkasan.tsx (IkhtisarTahap); computeClaimComparison juga dipakai opc/peran/RingkasanAdmin.tsx.
 * Dependensi: opc/Bersama (tulisOpc, kontrak), components/fiori/{core,interactive}, lib/opc-ui, lib/promo-ui (rupiah), sonner.
 * Main Functions: BagianPeriode, computeClaimComparison, usePeriode.
 * Side Effects: POST /api/off-program-control/periods {action close|unlock, principleCode, bulan, tahun} — satu principal = satu
 *   panggilan; "Semua principal" = satu panggilan per principal paralel (payload dan urutan sama dengan kode lama). Tautan unduh
 *   GET /periods/reconciliation (tab baru). Muat ulang daftar batch setelah ada yang berhasil.
 */
"use client";

import { useState, type ReactNode } from "react";
import { Download, Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";
import { Button, KeyValues, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, VariantNote, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { OPSI_TAHAP, PREDIKAT, opsiPrincipal, tahapBatch, type BatchOpc } from "@/lib/opc-ui";
import { alasanTutupPeriode } from "@/lib/off-program-control/access";
import { rupiah } from "@/lib/promo-ui";
import { tulisOpc, type PeranProps } from "../Bersama";

// ── Logic lama (salinan apa adanya) ─────────────────────────────────────────────────────────────────────

/** computeClaimComparison old-opc.tsx 697: diajukan = summary.totalNominal; diklaim = totalPaid || verifiedAmount || paidAmount. */
export function computeClaimComparison(batches: BatchOpc[]) {
    const totalSubmitted = batches.reduce((total, b) => total + Number(b.summary?.totalNominal || 0), 0);
    const totalClaimed = batches.reduce((total, b) => total + Number(b.paymentSummary?.totalPaid || b.verifiedAmount || b.paidAmount || 0), 0);
    const submittedCount = batches.length;
    const claimedCount = batches.filter((b) => String(b.noClaim || "").trim().length > 0 || Number(b.paymentSummary?.totalPaid || b.paidAmount || 0) > 0).length;
    const difference = totalSubmitted - totalClaimed;
    const isMatched = submittedCount > 0 && Math.round(totalSubmitted) === Math.round(totalClaimed);
    return {
        totalSubmitted, totalClaimed, difference, submittedCount, claimedCount, isMatched,
        status: submittedCount === 0 ? "Belum ada pengajuan" : isMatched ? "Data sudah sesuai" : "Data belum sesuai",
    };
}

const nilaiKlaim = (b: BatchOpc) => Number(b.paymentSummary?.totalPaid || b.verifiedAmount || b.paidAmount || 0);
const nilaiAju = (b: BatchOpc) => Number(b.summary?.totalNominal || 0);

// ── Keadaan periode (dipegang Ringkasan supaya tidak hilang saat pindah ke "Semua pengajuan") ───────────

/** `null` = belum diisi; diisi SEKALI dari batch terbaru pertama yang tersedia, lalu beku (kode lama 1924–1938). */
type Pilihan = { principal: string; bulan: string | null; tahun: string | null };
/** Status periode yang diketahui DI SESI INI (tidak ada endpoint baca status periode; kode lama juga hanya state lokal). */
type StatusSesi = Record<string, { status: string; jam: string }>;
export type PeriodeState = { pilihan: Pilihan; setPilihan: (p: Pilihan) => void; sesi: StatusSesi; catat: (kunci: string[], status: string) => void };

export function usePeriode(batches: BatchOpc[]): PeriodeState {
    const [pilihan, setPilihan] = useState<Pilihan>({ principal: "", bulan: null, tahun: null });
    // Bulan/tahun bawaan dibekukan pada batch terbaru PERTAMA yang tersedia, seperti kode lama: polling 45 dtk yang membawa batch
    // periode lain tidak boleh menggeser periode yang sedang dilihat atau akan ditutup. (Pembaruan saat render milik komponen ini
    // sendiri, berpenjaga: React langsung merender ulang tanpa efek.)
    const awal = batches[0];
    if (pilihan.bulan === null && awal) setPilihan({ principal: pilihan.principal, bulan: awal.bulan || "", tahun: awal.tahun || "" });
    const [sesi, setSesi] = useState<StatusSesi>({});
    const catat = (kunci: string[], status: string) => {
        const jam = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Makassar" }).format(new Date());
        setSesi((s) => ({ ...s, ...Object.fromEntries(kunci.map((k) => [k, { status, jam }])) }));
    };
    return { pilihan, setPilihan, sesi, catat };
}

const BULAN = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
const namaBulan = (m: string) => new Intl.DateTimeFormat("id-ID", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, Number(m) - 1, 1)));
const kunciPeriode = (principal: string, bulan: string, tahun: string) => `${principal || "*"}|${bulan}|${tahun}`;
const URL_PERIODE = "/api/off-program-control/periods";

/** "40 Selesai, 1 Verifikasi final" — tahap dari lib/opc-ui, urut alur. */
function rincianTahap(rows: BatchOpc[]) {
    const n = new Map<string, number>();
    for (const b of rows) n.set(tahapBatch(b), (n.get(tahapBatch(b)) ?? 0) + 1);
    return OPSI_TAHAP.filter((o) => n.has(o.kunci)).map((o) => `${n.get(o.kunci)} ${o.label}`).join(", ");
}

/** Angka satu pilihan periode (principal kosong = semua principal). Dipotret saat dialog dibuka supaya fakta dan POST tidak bergeser. */
function ringkasPeriode(batches: BatchOpc[], principal: string, bulan: string, tahun: string) {
    const opsi = opsiPrincipal(batches);
    const namaPrincipal = principal ? opsi.find((o) => o.value === principal)?.label ?? principal : "Semua principal";
    const labelPeriode = bulan && tahun ? `${namaBulan(bulan)} ${tahun}` : "";
    const target = batches.filter((b) => (!principal || b.principleCode === principal) && (!bulan || b.bulan === bulan) && (!tahun || b.tahun === tahun));
    const banding = computeClaimComparison(target);
    // Mode massal ("Semua principal"): satu POST per principal yang punya batch di periode ini (kode lama 1976).
    const principals = [...new Set(target.map((b) => b.principleCode).filter(Boolean))];
    // Syarat kode lama (canClosePeriod 1957): bulan+tahun, ada batch, diajukan = diklaim. Peran tidak dicek di klien (sama dengan kode
    // lama); izin grup akses `period_close` ditegakkan server dan galatnya tampil di dialog.
    const alasanTutup = !bulan || !tahun ? "Pilih bulan dan tahun dulu."
        : target.length === 0 ? "Tidak ada batch pada principal dan periode ini."
            : !banding.isMatched ? "Total pengajuan dan total klaim belum sesuai."
                : principals.length === 0 ? "Tidak ada principal yang ditemukan untuk periode ini." : undefined;
    return {
        opsi, principal, bulan, tahun, namaPrincipal, labelPeriode, target, banding, principals, alasanTutup,
        refundTertunda: target.filter(PREDIKAT.selisihTerbuka), kunci: kunciPeriode(principal, bulan, tahun),
    };
}
type RingkasPeriode = ReturnType<typeof ringkasPeriode>;

const faktaUmum = (r: RingkasPeriode): Array<[string, ReactNode]> => [
    ["Principal", r.principal ? r.namaPrincipal : `Semua principal (${r.principals.length}): ${r.principals.join(", ") || "–"}`],
    ["Periode", r.labelPeriode || "–"],
    ["Batch", r.target.length ? `${r.target.length} · ${rincianTahap(r.target)}` : "0"],
];

// ── Bagian ──────────────────────────────────────────────────────────────────────────────────────────────

export function BagianPeriode({ ctx, daftar, periode }: PeranProps & { periode: PeriodeState }) {
    const { batches } = daftar;
    const { pilihan, setPilihan, sesi, catat } = periode;
    // Dialog membawa potret angka saat dibuka: muat ulang daftar di latar tidak mengubah fakta yang dikonfirmasi maupun isi POST.
    const [dialog, setDialog] = useState<{ jenis: "close" | "unlock"; r: RingkasPeriode } | null>(null);
    const [pesan, setPesan] = useState<{ judul: string; isi: string } | null>(null);

    const kini = ringkasPeriode(batches, pilihan.principal, pilihan.bulan ?? "", pilihan.tahun ?? "");
    const { opsi, principal, bulan, tahun, namaPrincipal, labelPeriode, target, banding, refundTertunda } = kini;
    // Izin grup lebih dulu (owner 8 Okt: bukan untuk OM), lalu syarat data kode lama.
    const alasanTutup = alasanTutupPeriode(ctx.perms) ?? kini.alasanTutup;
    const status = sesi[kini.kunci];
    const ditutup = status?.status === "Ditutup" || status?.status === "Dikunci";
    // Buka kunci hanya admin (canUnlock kode lama 1953) dan hanya setelah periode ditutup di sesi ini (isPeriodClosed 1962).
    const alasanBuka = ctx.izin("period_unlock");

    async function jalankan(action: "close" | "unlock", r: RingkasPeriode) {
        const kata = action === "close" ? "ditutup" : "dibuka kuncinya";
        const judul = action === "close" ? `Periode ${r.labelPeriode} berhasil ditutup.` : `Kunci periode ${r.labelPeriode} dibuka.`;
        const body = (principleCode: string) => ({ action, principleCode, bulan: r.bulan, tahun: r.tahun });
        let isi: string;
        let statusBaru = action === "close" ? "Ditutup" : "Terbuka";
        if (r.principal) {
            const data = await tulisOpc(URL_PERIODE, { body: body(r.principal), gagal: "Periode belum berhasil diproses." });
            statusBaru = String(data.status || statusBaru);
            catat([r.kunci], statusBaru);
            isi = `${r.namaPrincipal}. ${String(data.message || "Periode berhasil diproses.")}`;
        } else {
            const hasil = await Promise.all(r.principals.map((pc) => tulisOpc(URL_PERIODE, { body: body(pc), gagal: "Periode belum berhasil diproses." })
                .then(() => ({ pc, galat: "" }), (e: unknown) => ({ pc, galat: e instanceof Error ? e.message : String(e) }))));
            const berhasil = hasil.filter((h) => !h.galat).map((h) => h.pc);
            const gagal = hasil.filter((h) => h.galat);
            // Principal yang berhasil sudah berubah di server walau yang lain gagal: catat per principal dan muat ulang daftar.
            catat([...berhasil.map((pc) => kunciPeriode(pc, r.bulan, r.tahun)), ...(gagal.length ? [] : [r.kunci])], statusBaru);
            if (gagal.length) {
                if (berhasil.length) daftar.muatUlang();
                throw new Error(`${gagal.length} principal gagal diproses: ${gagal.map((g) => `${g.pc} (${g.galat})`).join("; ")}.`
                    + (berhasil.length ? ` ${berhasil.length} principal lain sudah ${kata}: ${berhasil.join(", ")}.` : ""));
            }
            isi = `Semua ${r.principals.length} principal berhasil ${kata} untuk periode ${r.labelPeriode}.`;
        }
        setDialog(null);
        setPesan({ judul, isi });
        toast.success(judul);
        daftar.muatUlang();
    }

    const d = dialog?.r ?? kini;
    const kolom: Column<BatchOpc>[] = [
        { key: "no", header: "No pengajuan", cell: (b) => <span className="fi-mono">{b.noPengajuan}</span> },
        { key: "principal", header: "Principal", secondary: true, cell: (b) => b.principleName },
        { key: "aju", header: "Nilai pengajuan", align: "end", cell: (b) => <span className="fi-tnum">{rupiah(nilaiAju(b))}</span> },
        { key: "noklaim", header: "No klaim", secondary: true, cell: (b) => (b.noClaim ? <span className="fi-mono">{b.noClaim}</span> : "–") },
        { key: "klaim", header: "Nilai klaim", align: "end", cell: (b) => <span className="fi-tnum">{rupiah(nilaiKlaim(b))}</span> },
        { key: "selisih", header: "Selisih", align: "end", cell: (b) => <Selisih nilai={nilaiAju(b) - nilaiKlaim(b)} /> },
    ];

    return (
        <>
            <Section id="periode" title="Tutup periode" subtitle={labelPeriode ? `${namaPrincipal} · ${labelPeriode}` : "Pilih principal dan periode"}
                actions={ditutup ? <StatusBadge tone="neu">{`Ditutup ${status?.jam}`}</StatusBadge> : status ? <StatusBadge tone="info">{`Dibuka ${status.jam}`}</StatusBadge> : undefined}>
                <div className="fi-sect-in">
                    {pesan && <MessageStrip tone="pos" title={pesan.judul} onClose={() => setPesan(null)}>{pesan.isi}</MessageStrip>}
                    <div className="fi-formgrid">
                        <FormField label="Principal">{(a) => (
                            <select {...a} className="fi-input" value={principal} onChange={(e) => setPilihan({ principal: e.target.value, bulan, tahun })}>
                                <option value="">Semua principal</option>
                                {opsi.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                        )}</FormField>
                        <FormField label="Bulan">{(a) => (
                            <select {...a} className="fi-input" value={bulan} onChange={(e) => setPilihan({ principal, bulan: e.target.value, tahun })}>
                                <option value="">Pilih bulan</option>
                                {BULAN.map((m) => <option key={m} value={m}>{namaBulan(m)}</option>)}
                            </select>
                        )}</FormField>
                        <FormField label="Tahun">{(a) => (
                            <input {...a} className="fi-input fi-tnum" inputMode="numeric" value={tahun}
                                onChange={(e) => setPilihan({ principal, bulan, tahun: e.target.value.replace(/[^\d]/g, "").slice(0, 4) })} />
                        )}</FormField>
                    </div>
                    <div role="group" aria-label="Angka periode terpilih">
                        <KeyValues items={[
                            ["Batch", target.length ? `${target.length} · ${rincianTahap(target)}` : "0"],
                            ["Total diajukan", rupiah(banding.totalSubmitted)],
                            ["Total diklaim", `${rupiah(banding.totalClaimed)} · ${banding.claimedCount} diklaim`],
                            ["Selisih", rupiah(Math.abs(banding.difference))],
                            ["Kesesuaian data", <StatusBadge key="k" tone={banding.isMatched ? "pos" : banding.submittedCount ? "warn" : "neu"}>{banding.status}</StatusBadge>],
                            ["Refund tertunda", refundTertunda.length ? `${refundTertunda.length} · ${refundTertunda.slice(0, 3).map((b) => b.noPengajuan).join(", ")}` : "0"],
                        ]} />
                    </div>
                    {!banding.isMatched && target.length > 0 && (
                        <MessageStrip tone="warn" title="Periode belum dapat ditutup">karena total pengajuan dan total klaim belum sesuai.</MessageStrip>
                    )}
                    <div className="fi-btnrow">
                        <Button variant="primary" icon={<Lock className="fi-icon" aria-hidden />} disabled={Boolean(alasanTutup)} disabledReason={alasanTutup} onClick={() => setDialog({ jenis: "close", r: kini })}>
                            Tutup periode…
                        </Button>
                        {principal && bulan && tahun && target.length > 0 && (
                            <a className="fi-btn fi-btn--secondary" target="_blank" rel="noopener noreferrer"
                                href={`/api/off-program-control/periods/reconciliation?${new URLSearchParams({ principleCode: principal, bulan, tahun })}`}>
                                <Download className="fi-icon" aria-hidden />Unduh rekonsiliasi
                            </a>
                        )}
                        {ditutup && (
                            <Button variant="tertiary" icon={<LockOpen className="fi-icon" aria-hidden />} disabled={Boolean(alasanBuka)} disabledReason={alasanBuka} onClick={() => setDialog({ jenis: "unlock", r: kini })}>
                                Buka kunci periode…
                            </Button>
                        )}
                    </div>
                    {alasanTutup && target.length > 0 && <p className="fi-small fi-subtle">Tutup periode nonaktif: {alasanTutup}</p>}
                    {target.length > 0 && (
                        <details>
                            <summary className="fi-small" style={{ cursor: "pointer" }}>Lihat detail rekonsiliasi ({target.length} pengajuan)</summary>
                            <ResponsiveTable title="Detail rekonsiliasi" count={target.length} columns={kolom} rows={target} rowKey={(b) => b.id}
                                empty={{ title: "Belum ada pengajuan pada periode ini" }}
                                mobileItem={(b) => <ListItem doc={b.noPengajuan} amount={rupiah(nilaiAju(b))} title={b.principleName}
                                    meta={`Klaim ${rupiah(nilaiKlaim(b))}${b.noClaim ? ` · ${b.noClaim}` : ""}`} badge={<Selisih nilai={nilaiAju(b) - nilaiKlaim(b)} />} />} />
                        </details>
                    )}
                    <VariantNote bl="BL-12">
                        Refund tertunda belum menahan penutupan: server menutup periode selama total pengajuan sama dengan total klaim. Status periode
                        tidak dibaca dari server, jadi Buka kunci hanya muncul setelah Anda menutup periode di sesi ini, dan alasannya belum bisa
                        disimpan. Usulan: refund tertunda menahan penutupan, status periode dari server, buka kunci dengan alasan wajib.
                    </VariantNote>
                </div>
            </Section>

            <PerPrincipal batches={batches} bulan={bulan} tahun={tahun} labelPeriode={labelPeriode} />

            <ConfirmDialog open={dialog?.jenis === "close"} onClose={() => setDialog(null)} tag="Tutup periode"
                title={`Tutup periode ${d.labelPeriode}${d.principal ? ` untuk ${d.namaPrincipal}` : ""}?`}
                description="Setelah dikunci, data periode ini tidak bisa diubah lagi."
                facts={[
                    ...faktaUmum(d),
                    ["Total diajukan", rupiah(d.banding.totalSubmitted)],
                    ["Total diklaim", rupiah(d.banding.totalClaimed)],
                    ["Selisih", rupiah(Math.abs(d.banding.difference))],
                    ["Refund tertunda", d.refundTertunda.length
                        ? <StatusBadge tone="warn">{`${d.refundTertunda.length} · ${d.refundTertunda.slice(0, 5).map((b) => b.noPengajuan).join(", ")}`}</StatusBadge>
                        : "Tidak ada"],
                    ...(d.principal ? [] : [["Cara tutup", "Satu permintaan per principal. Principal yang ditolak server (mis. total belum sesuai) tetap terbuka; yang lain tetap ditutup."] as [string, string]]),
                    ["Setelah ditutup", "Selain admin, tidak ada yang bisa mengubah, mengirim, menyetujui, membayar, atau memproses refund batch periode ini."],
                ]}
                confirmLabel="Tutup periode" confirmDisabled={d.alasanTutup} onConfirm={() => jalankan("close", d)}>
                {d.refundTertunda.length > 0 && (
                    <VariantNote bl="BL-12">
                        Ada {d.refundTertunda.length} refund tertunda. Hari ini penutupan tetap diteruskan dan refund itu hanya bisa diselesaikan admin.
                        Bila BL-12 masuk, server menolak penutupan sampai refund selesai atau ditolak.
                    </VariantNote>
                )}
            </ConfirmDialog>
            <ConfirmDialog open={dialog?.jenis === "unlock"} onClose={() => setDialog(null)} tag="Buka kunci" tone="negative"
                title={`Buka kunci periode ${d.labelPeriode}${d.principal ? ` untuk ${d.namaPrincipal}` : ""}?`}
                description="Batch periode ini bisa diubah lagi oleh peran terkait; pembukaan tercatat di log audit tiap batch."
                facts={faktaUmum(d)} confirmLabel="Buka kunci" confirmDisabled={alasanBuka} onConfirm={() => jalankan("unlock", d)}>
                <VariantNote bl="BL-12">Server belum menyimpan alasan buka kunci. Bila BL-12 masuk, alasan wajib diisi di dialog ini dan tercatat di log audit.</VariantNote>
            </ConfirmDialog>
        </>
    );
}

function Selisih({ nilai }: { nilai: number }) {
    return Math.round(nilai) === 0 ? <StatusBadge tone="pos">Cocok</StatusBadge> : <StatusBadge tone="warn">{rupiah(Math.abs(nilai))}</StatusBadge>;
}

type BarisPrincipal = { kode: string; nama: string } & ReturnType<typeof computeClaimComparison>;

/** Diajukan vs diklaim per principal pada bulan/tahun terpilih (tanpa saringan principal, supaya terlihat principal mana yang belum cocok). */
function PerPrincipal({ batches, bulan, tahun, labelPeriode }: { batches: BatchOpc[]; bulan: string; tahun: string; labelPeriode: string }) {
    const diPeriode = batches.filter((b) => (!bulan || b.bulan === bulan) && (!tahun || b.tahun === tahun));
    const grup = new Map<string, BatchOpc[]>();
    for (const b of diPeriode) {
        const k = b.principleCode || b.principleName;
        grup.set(k, [...(grup.get(k) ?? []), b]);
    }
    // Belum sesuai di atas supaya principal yang menahan penutupan langsung terlihat.
    const rows: BarisPrincipal[] = [...grup.entries()].map(([kode, bs]) => ({ kode, nama: bs[0].principleName || kode, ...computeClaimComparison(bs) }))
        .sort((a, b) => Number(a.isMatched) - Number(b.isMatched) || a.nama.localeCompare(b.nama));
    const semua = computeClaimComparison(diPeriode);
    const status = (r: BarisPrincipal) => <StatusBadge tone={r.isMatched ? "pos" : "warn"}>{r.isMatched ? "Sesuai" : "Belum sesuai"}</StatusBadge>;
    const kolom: Column<BarisPrincipal>[] = [
        { key: "nama", header: "Principal", cell: (r) => r.nama },
        { key: "n", header: "Diajukan / diklaim", secondary: true, cell: (r) => <span className="fi-tnum">{r.submittedCount} / {r.claimedCount}</span> },
        { key: "aju", header: "Diajukan", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(r.totalSubmitted)}</span> },
        { key: "klaim", header: "Diklaim", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(r.totalClaimed)}</span> },
        { key: "selisih", header: "Selisih", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(Math.abs(r.difference))}</span> },
        { key: "status", header: "Kesesuaian", cell: status },
    ];
    return (
        <Section title="Diajukan vs diklaim" subtitle={labelPeriode ? `${labelPeriode} · ${semua.status}` : "Pilih bulan dan tahun"}>
            <ResponsiveTable title="Diajukan vs diklaim per principal" count={rows.length} columns={kolom} rows={rows} rowKey={(r) => r.kode}
                empty={{ title: labelPeriode ? `Belum ada pengajuan pada ${labelPeriode}` : "Pilih bulan dan tahun di Tutup periode" }}
                mobileItem={(r) => <ListItem doc={r.kode} amount={`Selisih ${rupiah(Math.abs(r.difference))}`} title={r.nama}
                    meta={`Diajukan ${rupiah(r.totalSubmitted)} · diklaim ${rupiah(r.totalClaimed)} · ${r.submittedCount}/${r.claimedCount} batch`} badge={status(r)} />} />
        </Section>
    );
}
