/*
 * Tujuan: Bagian periode di Ringkasan OFF Program Control (Fiori S4d): "Tutup periode" (port PeriodClosurePanel kode lama:
 *   principal/bulan/tahun, angka diajukan vs diklaim, status penutupan dari server (siapa, kapan, WITA; audit No 27), detail rekonsiliasi
 *   per batch, unduh PDF rekonsiliasi, dialog tutup dan buka kunci menggantikan confirm peramban) dan "Diajukan vs diklaim" per principal untuk bulan
 *   terpilih (computeClaimComparison kode lama). Bila daftar mencapai 200 batch, kedua bagian memberi peringatan bahwa angkanya dari
 *   200 batch terbaru (rumus tidak berubah).
 * Caller: opc/peran/Ringkasan.tsx (IkhtisarTahap); computeClaimComparison juga dipakai opc/peran/RingkasanAdmin.tsx.
 * Dependensi: opc/Bersama (ambilOpc, tulisOpc, TulisTidakPasti, pesanTidakPasti, kontrak), components/fiori/{core,interactive}, lib/opc-ui,
 *   lib/promo-ui (rupiah), lib/tampil (KOSONG, waktuWita), sonner.
 * Main Functions: BagianPeriode, computeClaimComparison, usePeriode.
 * Side Effects: GET /api/off-program-control/periods?bulan=&tahun= (status penutupan, baca-saja). POST /periods {action close|unlock,
 *   principleCode, bulan, tahun}: satu principal = satu panggilan; "Semua principal" = satu panggilan per principal paralel (payload dan
 *   urutan sama dengan kode lama). Tautan unduh GET /periods/reconciliation (tab baru). Sesudah tulis berhasil ATAU hasilnya tidak pasti,
 *   daftar batch dan status penutupan dibaca ulang; hasil tidak pasti menutup dialog dan meninggalkan strip peringatan (No 22).
 */
"use client";

import { useCallback, useState, type ReactNode } from "react";
import { Download, Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";
import { Button, KeyValues, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { BATAS_DAFTAR, OPSI_TAHAP, PREDIKAT, opsiPrincipal, tahapBatch, type BatchOpc } from "@/lib/opc-ui";
import { alasanTutupPeriode } from "@/lib/off-program-control/access";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG, waktuWita } from "@/lib/tampil";
import { TulisTidakPasti, ambilOpc, pesanTidakPasti, tulisOpc, type PeranProps } from "../Bersama";

// Logic kode lama (salinan apa adanya).

/** computeClaimComparison kode lama: diajukan = summary.totalNominal; diklaim = totalPaid || verifiedAmount || paidAmount. */
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

// Keadaan periode (dipegang Ringkasan supaya tidak hilang saat pindah ke "Semua pengajuan").

/** `null` = belum diisi; diisi SEKALI dari batch terbaru pertama yang tersedia, lalu beku (kode lama). */
type Pilihan = { principal: string; bulan: string | null; tahun: string | null };
export type PeriodeState = { pilihan: Pilihan; setPilihan: (p: Pilihan) => void };
/** Satu baris GET /periods (off_period_closure). Principal tanpa baris = belum pernah ditutup. Nama null = id akun tidak ada di tabel user. */
type StatusPeriode = {
    principleCode: string; principleName: string; status: string; closedBy: string | null; closedByName: string | null; closedAt: string | null;
    unlockedBy: string | null; unlockedByName: string | null; unlockedAt: string | null;
};
const tertutup = (s?: StatusPeriode) => s?.status === "Ditutup" || s?.status === "Dikunci";
const siapa = (nama: string | null, id: string | null) => nama || id || "akun tidak dikenal";
/** "Ditutup oleh A · 06/10/2026 09.40 WITA" / "Terbuka · kunci dibuka oleh B · …" / "Terbuka (belum pernah ditutup)". */
function teksStatus(s?: StatusPeriode) {
    if (tertutup(s)) return `Ditutup oleh ${siapa(s!.closedByName, s!.closedBy)} · ${waktuWita(s!.closedAt)} WITA`;
    if (s?.unlockedAt) return `Terbuka · kunci dibuka oleh ${siapa(s.unlockedByName, s.unlockedBy)} · ${waktuWita(s.unlockedAt)} WITA`;
    return "Terbuka (belum pernah ditutup)";
}

export function usePeriode(batches: BatchOpc[]): PeriodeState {
    const [pilihan, setPilihan] = useState<Pilihan>({ principal: "", bulan: null, tahun: null });
    // Bulan/tahun bawaan dibekukan pada batch terbaru PERTAMA yang tersedia, seperti kode lama: polling 45 dtk yang membawa batch
    // periode lain tidak boleh menggeser periode yang sedang dilihat atau akan ditutup. (Pembaruan saat render milik komponen ini
    // sendiri, berpenjaga: React langsung merender ulang tanpa efek.)
    const awal = batches[0];
    if (pilihan.bulan === null && awal) setPilihan({ principal: pilihan.principal, bulan: awal.bulan || "", tahun: awal.tahun || "" });
    return { pilihan, setPilihan };
}

const BULAN = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
const namaBulan = (m: string) => new Intl.DateTimeFormat("id-ID", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, Number(m) - 1, 1)));
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
    // Mode massal ("Semua principal"): satu POST per principal yang punya batch di periode ini (kode lama).
    const principals = [...new Set(target.map((b) => b.principleCode).filter(Boolean))];
    // Syarat kode lama (canClosePeriod): bulan+tahun, ada batch, diajukan = diklaim. Peran tidak dicek di klien (sama dengan kode
    // lama); izin grup akses `period_close` ditegakkan server dan galatnya tampil di dialog.
    const alasanTutup = !bulan || !tahun ? "Pilih bulan dan tahun dulu."
        : target.length === 0 ? "Tidak ada batch pada principal dan periode ini."
            : !banding.isMatched ? "Total pengajuan dan total klaim belum sesuai."
                : principals.length === 0 ? "Tidak ada principal yang ditemukan untuk periode ini." : undefined;
    return {
        opsi, principal, bulan, tahun, namaPrincipal, labelPeriode, target, banding, principals, alasanTutup,
        refundTertunda: target.filter(PREDIKAT.selisihTerbuka),
    };
}
type RingkasPeriode = ReturnType<typeof ringkasPeriode>;

const faktaUmum = (r: RingkasPeriode): Array<[string, ReactNode]> => [
    ["Principal", r.principal ? r.namaPrincipal : `Semua principal (${r.principals.length}): ${r.principals.join(", ") || KOSONG}`],
    ["Periode", r.labelPeriode || KOSONG],
    ["Batch", r.target.length ? `${r.target.length} · ${rincianTahap(r.target)}` : "0"],
];


export function BagianPeriode({ ctx, daftar, periode }: PeranProps & { periode: PeriodeState }) {
    const { batches } = daftar;
    const { pilihan, setPilihan } = periode;
    // Dialog membawa potret angka saat dibuka: muat ulang daftar di latar tidak mengubah fakta yang dikonfirmasi maupun isi POST.
    const [dialog, setDialog] = useState<{ jenis: "close" | "unlock"; r: RingkasPeriode } | null>(null);
    const [pesan, setPesan] = useState<{ judul: string; isi: string } | null>(null);
    const [tidakPasti, setTidakPasti] = useState<string | null>(null);
    // Daftar dari server dibatasi 200 batch terbaru (BL-13): total periode bisa tidak lengkap. Hanya keterangan; rumus tidak berubah.
    const terpotong = batches.length >= BATAS_DAFTAR;

    const kini = ringkasPeriode(batches, pilihan.principal, pilihan.bulan ?? "", pilihan.tahun ?? "");
    const { opsi, principal, bulan, tahun, namaPrincipal, labelPeriode, target, banding, refundTertunda } = kini;
    // Izin grup lebih dulu (owner 8 Okt: bukan untuk OM), lalu syarat data kode lama.
    const alasanTutup = alasanTutupPeriode(ctx.perms) ?? kini.alasanTutup;
    // Status penutupan dari server (audit No 27): semua principal pada bulan/tahun terpilih, apa pun sesi yang menutupnya.
    const bulanP = pilihan.bulan ?? "", tahunP = pilihan.tahun ?? "";
    const periodeSah = Boolean(bulanP) && /^\d{4}$/.test(tahunP);
    const [statusLoad, muatStatus] = useLoad(useCallback((): Promise<Load<StatusPeriode[]>> => (periodeSah
        ? ambilOpc(`${URL_PERIODE}?${new URLSearchParams({ bulan: bulanP, tahun: tahunP })}`, (j) => (j.periods ?? []) as StatusPeriode[], "Status penutupan periode belum terbaca.")
        : Promise.resolve({ status: "siap", data: [] })), [periodeSah, bulanP, tahunP]));
    // Hanya status SEGAR yang dipakai (tinjauan K3 R-1): useLoad menyimpan data lama saat muat ulang berjalan atau gagal; dari data basi itu
    // Buka kunci bisa tampil (dan mengirim unlock kedua) padahal strip galat berkata tidak ditampilkan.
    const st = statusLoad.status === "siap" ? statusLoad.data : undefined;
    const statusOf = (pc: string) => st?.find((x) => x.principleCode === pc);
    // Satu principal: barisnya. Semua principal: principal yang punya batch di periode ini (yang akan dikirimi POST).
    const ditutupList = st ? kini.principals.filter((pc) => tertutup(statusOf(pc))) : [];
    const ditutup = Boolean(st) && (principal ? tertutup(statusOf(principal)) : kini.principals.length > 0 && ditutupList.length === kini.principals.length);
    const sebagian = Boolean(st) && !principal && ditutupList.length > 0 && !ditutup;
    // Buka kunci: periode tertutup menurut server (siapa pun penutupnya); tetap hanya izin unlock (canUnlock kode lama).
    const alasanBuka = ctx.izin("period_unlock");
    const statusPenutupan = !periodeSah ? "Pilih bulan dan tahun"
        : !st ? (statusLoad.status === "galat" ? "Belum terbaca dari server" : "Memuat status dari server")
            : principal ? teksStatus(statusOf(principal))
                : ditutup ? `Ditutup untuk semua ${kini.principals.length} principal`
                    : sebagian ? `${ditutupList.length} dari ${kini.principals.length} principal ditutup: ${ditutupList.join(", ")}. Pilih principal untuk melihat atau membuka kuncinya.`
                        : kini.principals.length ? "Terbuka" : "Tidak ada batch pada periode ini";
    const badgeStatus = !periodeSah ? null
        : !st ? <StatusBadge tone={statusLoad.status === "galat" ? "warn" : "neu"}>{statusLoad.status === "galat" ? "Status penutupan belum terbaca" : "Memuat status penutupan"}</StatusBadge>
            : ditutup ? <StatusBadge tone="neu">Ditutup</StatusBadge>
                : sebagian ? <StatusBadge tone="warn">Sebagian ditutup</StatusBadge>
                    : <StatusBadge tone="info">Terbuka</StatusBadge>;
    /** Status untuk fakta dialog (potret pilihan dialog): satu principal = barisnya; semua = yang ditutup dari yang akan dikirimi POST. */
    const statusDialog = (r: RingkasPeriode) => !st ? "Belum terbaca dari server"
        : r.principal ? teksStatus(statusOf(r.principal))
            : `${r.principals.filter((pc) => tertutup(statusOf(pc))).length} dari ${r.principals.length} principal sudah ditutup`;

    async function jalankan(action: "close" | "unlock", r: RingkasPeriode) {
        const kata = action === "close" ? "ditutup" : "dibuka kuncinya";
        const judul = action === "close" ? `Periode ${r.labelPeriode} berhasil ditutup.` : `Kunci periode ${r.labelPeriode} dibuka.`;
        const body = (principleCode: string) => ({ action, principleCode, bulan: r.bulan, tahun: r.tahun });
        let isi: string;
        const putus = pesanTidakPasti(action === "close" ? "penutupan periode ini" : "pembukaan kunci periode ini", "status penutupan dan Riwayat batch");
        // Hasil tidak pasti (No 22): dialog ditutup, daftar dan status dibaca ulang, strip peringatan bertahan sampai ditutup.
        const tidakPastiTutup = (teks: string) => { setDialog(null); setPesan(null); setTidakPasti(teks); daftar.muatUlang(); muatStatus(); };
        if (r.principal) {
            let data: Record<string, unknown>;
            try {
                data = await tulisOpc(URL_PERIODE, { body: body(r.principal), gagal: "Periode belum berhasil diproses.", putus });
            } catch (e) {
                if (e instanceof TulisTidakPasti) { tidakPastiTutup(e.message); return; }
                throw e;
            }
            isi = `${r.namaPrincipal}. ${String(data.message || "Periode berhasil diproses.")}`;
        } else {
            const hasil = await Promise.all(r.principals.map((pc) => tulisOpc(URL_PERIODE, { body: body(pc), gagal: "Periode belum berhasil diproses.", putus })
                .then(() => ({ pc, galat: "", pasti: true }), (e: unknown) => ({ pc, galat: e instanceof Error ? e.message : String(e), pasti: !(e instanceof TulisTidakPasti) }))));
            const berhasil = hasil.filter((h) => !h.galat).map((h) => h.pc);
            const gagal = hasil.filter((h) => h.galat && h.pasti);
            // Jawaban tidak pasti bukan "gagal": principal itu mungkin sudah berubah di server.
            const belumPasti = hasil.filter((h) => h.galat && !h.pasti).map((h) => h.pc);
            if (gagal.length || belumPasti.length) {
                const ringkas = [
                    gagal.length ? `${gagal.length} principal gagal diproses: ${gagal.map((g) => `${g.pc} (${g.galat})`).join("; ")}.` : "",
                    belumPasti.length ? `Hasil ${belumPasti.length} principal belum pasti: ${belumPasti.join(", ")}.` : "",
                    berhasil.length ? `${berhasil.length} principal lain sudah ${kata}: ${berhasil.join(", ")}.` : "",
                ].filter(Boolean).join(" ");
                if (belumPasti.length) { tidakPastiTutup(`${ringkas} ${putus}`); return; }
                // Gagal pasti: dialog tetap terbuka dengan pesannya; yang sudah berhasil berubah di server, jadi daftar dan status dibaca ulang.
                if (berhasil.length) { daftar.muatUlang(); muatStatus(); }
                throw new Error(ringkas);
            }
            isi = `Semua ${r.principals.length} principal berhasil ${kata} untuk periode ${r.labelPeriode}.`;
        }
        setDialog(null);
        setTidakPasti(null);
        setPesan({ judul, isi });
        toast.success(judul);
        daftar.muatUlang();
        muatStatus();
    }

    const d = dialog?.r ?? kini;
    const kolom: Column<BatchOpc>[] = [
        { key: "no", header: "No pengajuan", cell: (b) => <span className="fi-mono">{b.noPengajuan}</span> },
        { key: "principal", header: "Principal", secondary: true, cell: (b) => b.principleName },
        { key: "aju", header: "Nilai pengajuan", align: "end", cell: (b) => <span className="fi-tnum">{rupiah(nilaiAju(b))}</span> },
        { key: "noklaim", header: "No klaim", secondary: true, cell: (b) => (b.noClaim ? <span className="fi-mono">{b.noClaim}</span> : KOSONG) },
        { key: "klaim", header: "Nilai klaim", align: "end", cell: (b) => <span className="fi-tnum">{rupiah(nilaiKlaim(b))}</span> },
        { key: "selisih", header: "Selisih", align: "end", cell: (b) => <Selisih nilai={nilaiAju(b) - nilaiKlaim(b)} /> },
    ];

    return (
        <>
            <Section id="periode" title="Tutup periode"
                subtitle={labelPeriode ? `${namaPrincipal} · ${labelPeriode}${terpotong ? ` · dari ${BATAS_DAFTAR} batch terbaru` : ""}` : "Pilih principal dan periode"}
                actions={badgeStatus}>
                <div className="fi-sect-in">
                    {pesan && <MessageStrip tone="pos" title={pesan.judul} onClose={() => setPesan(null)}>{pesan.isi}</MessageStrip>}
                    {tidakPasti && <MessageStrip tone="warn" title="Hasil aksi periode terakhir belum pasti." onClose={() => setTidakPasti(null)}>{tidakPasti}</MessageStrip>}
                    {statusLoad.status === "galat" && periodeSah && (
                        <MessageStrip tone="neg" title="Status penutupan belum terbaca.">
                            {statusLoad.error} Buka kunci tidak ditampilkan sampai status terbaca.{" "}
                            <Button variant="tertiary" onClick={muatStatus}>Coba lagi</Button>
                        </MessageStrip>
                    )}
                    {terpotong && (
                        <MessageStrip tone="warn" title={`Dihitung dari ${BATAS_DAFTAR} batch terbaru.`}>
                            Batch lama di periode ini tidak ikut terhitung, jadi total pengajuan, total klaim, dan syarat Tutup periode bisa keliru.
                        </MessageStrip>
                    )}
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
                            ["Status penutupan", statusPenutupan],
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
                    {/* Dulu VariantNote BL-12; catatan varian layar ini milik Ringkasan (No 80). */}
                    <p className="fi-small fi-subtle">
                        Refund tertunda belum menahan penutupan: server menutup periode selama total pengajuan sama dengan total klaim.
                        Alasan buka kunci belum disimpan server; pembukaan tercatat di log audit tiap batch dan di status penutupan.
                    </p>
                </div>
            </Section>

            <PerPrincipal batches={batches} bulan={bulan} tahun={tahun} labelPeriode={labelPeriode} terpotong={terpotong} />

            <ConfirmDialog open={dialog?.jenis === "close"} onClose={() => setDialog(null)} tag="Tutup periode"
                title={`Tutup periode ${d.labelPeriode}${d.principal ? ` untuk ${d.namaPrincipal}` : ""}?`}
                description="Setelah ditutup, data periode ini terkunci. Hanya admin yang dapat membuka kuncinya lagi."
                facts={[
                    ...faktaUmum(d),
                    ["Total diajukan", rupiah(d.banding.totalSubmitted)],
                    ["Total diklaim", rupiah(d.banding.totalClaimed)],
                    ["Selisih", rupiah(Math.abs(d.banding.difference))],
                    ["Refund tertunda", d.refundTertunda.length
                        ? <StatusBadge tone="warn">{`${d.refundTertunda.length} · ${d.refundTertunda.slice(0, 5).map((b) => b.noPengajuan).join(", ")}`}</StatusBadge>
                        : "Tidak ada"],
                    ...(d.principal ? [] : [["Cara tutup", "Satu permintaan per principal. Principal yang ditolak server (mis. total belum sesuai) tetap terbuka; yang lain tetap ditutup."] as [string, string]]),
                    ["Status sekarang", statusDialog(d)],
                    ["Setelah ditutup", "Selain admin, tidak ada yang bisa mengubah, mengirim, menyetujui, membayar, atau memproses refund batch periode ini."],
                ]}
                confirmLabel="Tutup periode" confirmDisabled={d.alasanTutup} onConfirm={() => jalankan("close", d)}>
                {d.refundTertunda.length > 0 && (
                    <p className="fi-small fi-why">
                        Ada {d.refundTertunda.length} refund tertunda. Penutupan tetap diteruskan, dan sesudahnya refund itu hanya bisa diselesaikan admin.
                    </p>
                )}
            </ConfirmDialog>
            <ConfirmDialog open={dialog?.jenis === "unlock"} onClose={() => setDialog(null)} tag="Buka kunci" tone="negative"
                title={`Buka kunci periode ${d.labelPeriode}${d.principal ? ` untuk ${d.namaPrincipal}` : ""}?`}
                description="Batch periode ini bisa diubah lagi oleh peran terkait. Pembukaan tercatat di log audit tiap batch dan di status penutupan (siapa, kapan); alasannya belum bisa disimpan server."
                facts={[...faktaUmum(d), ["Status sekarang", statusDialog(d)]]} confirmLabel="Buka kunci" confirmDisabled={alasanBuka} onConfirm={() => jalankan("unlock", d)} />
        </>
    );
}

function Selisih({ nilai }: { nilai: number }) {
    return Math.round(nilai) === 0 ? <StatusBadge tone="pos">Cocok</StatusBadge> : <StatusBadge tone="warn">{rupiah(Math.abs(nilai))}</StatusBadge>;
}

type BarisPrincipal = { kode: string; nama: string } & ReturnType<typeof computeClaimComparison>;

/** Diajukan vs diklaim per principal pada bulan/tahun terpilih (tanpa saringan principal, supaya terlihat principal mana yang belum cocok). */
function PerPrincipal({ batches, bulan, tahun, labelPeriode, terpotong }: { batches: BatchOpc[]; bulan: string; tahun: string; labelPeriode: string; terpotong: boolean }) {
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
        <Section title="Diajukan vs diklaim"
            subtitle={labelPeriode ? `${labelPeriode} · ${semua.status}${terpotong ? ` · dari ${BATAS_DAFTAR} batch terbaru` : ""}` : "Pilih bulan dan tahun"}>
            {terpotong && (
                <div className="fi-sect-in">
                    <MessageStrip tone="warn" title={`Dihitung dari ${BATAS_DAFTAR} batch terbaru.`}>
                        Batch lama tidak ikut terhitung; principal yang tampil sesuai bisa saja belum sesuai di data lengkap.
                    </MessageStrip>
                </div>
            )}
            <ResponsiveTable title="Diajukan vs diklaim per principal" count={rows.length} columns={kolom} rows={rows} rowKey={(r) => r.kode}
                empty={{ title: labelPeriode ? `Belum ada pengajuan pada ${labelPeriode}` : "Pilih bulan dan tahun di Tutup periode" }}
                mobileItem={(r) => <ListItem doc={r.kode} amount={`Selisih ${rupiah(Math.abs(r.difference))}`} title={r.nama}
                    meta={`Diajukan ${rupiah(r.totalSubmitted)} · diklaim ${rupiah(r.totalClaimed)} · ${r.submittedCount}/${r.claimedCount} batch`} badge={status(r)} />} />
        </Section>
    );
}
