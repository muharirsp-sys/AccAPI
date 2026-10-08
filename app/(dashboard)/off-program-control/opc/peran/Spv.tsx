/*
 * Tujuan: Modul peran Supervisor OFF Program Control (Fiori S4d, tab `supervisor`, layar spv it03): antrean Draf & dikembalikan
 *   (+ Semua = monitoring semua status batch milik SPV) dan Data selisih; Object Page batch dalam MODE UBAH bila batch boleh diubah
 *   SPV (Draf/Dikembalikan, belum terkunci) — setup batch, daftar item + form berlabel per item, Simpan draf, Kirim ke SM lewat
 *   dialog `kirimsm`; batch baru di kolom kedua (`?view=baru`); ajukan pengembalian selisih; pengingat kelengkapan; PDF surat
 *   hanya setelah Klaim menyetujui (#6); Pengajuan diskon SPV (`?view=diskon`).
 * Caller: OpcApp.tsx (MODUL.supervisor).
 * Dependensi: opc/Bersama (KerjaPeran, kontrak), opc/ObjectPageBatch, opc/peran/SpvForm (form + dialog), opc/peran/SpvLain
 *   (refund, pengingat, diskon), lib/opc-ui (TAMPILAN, PREDIKAT), components/fiori, next/navigation.
 * Main Functions: Spv, DetailSpv, UbahBatch, BatchBaru.
 * Side Effects: Lewat SpvForm (POST/PATCH /batches, POST /batches/[id]/submit, GET next-number) dan SpvLain (POST refund,
 *   GET/POST discount). router.replace ke batch yang baru tersimpan (setelah draf dibersihkan).
 *
 * Catatan pemetaan fitur lama (old-opc.tsx SupervisorDashboard 2911–4454):
 *  - Mode ubah = openReturnedBatch 3153–3215 (baca-saja bila !PREDIKAT.spvBisaUbah); grid 18 kolom → SpvForm.EditorItem.
 *  - Nomor otomatis 2993–3034, saveDraft 3319, handleSubmitBatch 3422, DuplicateNoSuratPrompt 2805 → SpvForm.
 *  - Hasil kirim 4346–4396 → strip Sukses; PDF surat hanya setelah Klaim menyetujui (#6, 4331–4345).
 *  - Status kunci 4403–4423 → strip baca-saja + Flow 7 tahap. Data Selisih 3764–3834 → tampilan lokal `selisih` + AjukanRefund.
 *  - Kwitansi (handlePrintKwitansi 3588–3621): OFF_KWITANSI_DISABLED → tidak ditampilkan.
 */
"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, FileText, Percent, Plus } from "lucide-react";
import { Button, FooterToolbar, KeyValues, MessageStrip, ObjectPageHeader, Section, Skeleton, StatusBadge, VariantNote } from "@/components/fiori/core";
import { PREDIKAT, TAMPILAN, labelStatus, tahapBatch, type Tampilan } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KerjaPeran, type DaftarOpc, type DetailProps, type OpcKonteks, type PeranProps } from "../Bersama";
import { ObjectPageBatch, type BagianTambahan } from "../ObjectPageBatch";
import {
    AksiForm, DialogForm, EditorItem, SetupBatch, StripDraf, barisDariItem, barisKosong, gelombangDariNomor, pesanFooter, useFormSpv,
    type HasilKirim, type Pesan,
} from "./SpvForm";
import { AjukanRefund, DiskonSpv, PengingatKelengkapan } from "./SpvLain";

/** Tampilan lokal Data selisih (menu lama 3640–3679; predikat old 3765). */
const SELISIH: Tampilan = {
    kunci: "selisih", label: "Data selisih", antrean: PREDIKAT.selisihTerbuka,
    kosong: "Tidak ada batch dengan selisih yang perlu dikembalikan.",
};
const TAMPILAN_SPV: Tampilan[] = [...TAMPILAN.supervisor, SELISIH];

/** Pesan yang dibawa dari form batch baru ke Object Page batch yang baru tersimpan (setelah pindah URL). */
type Titipan = { batchId: string; pesan?: Pesan; hasil?: HasilKirim };
const TitipanCtx = createContext<{ titipan: Titipan | null; titip: (t: Titipan | null) => void }>({ titipan: null, titip: () => undefined });

function StripPesan({ pesan, tutup }: { pesan: Pesan; tutup?: () => void }) {
    return <MessageStrip tone={pesan.tone} title={pesan.judul} onClose={tutup}>{pesan.isi}</MessageStrip>;
}

/**
 * Hasil kirim (old 4346–4396): tanpa Batch ID internal dan alamat PDF mentah; PDF baru bisa diunduh setelah Klaim menyetujui (#6).
 * `sudahAda` (ALREADY_SUBMITTED, old 3496–3511): pesan lama + ringkasan + PDF yang ada (form baru: status Klaim kosong → catatan saja).
 */
function StripHasil({ h }: { h: HasilKirim }) {
    return (
        <>
            {h.sudahAda
                ? <MessageStrip tone="warn" title="Pengajuan ini sudah pernah dikirim.">Silakan cek PDF atau lanjutkan alur persetujuan.</MessageStrip>
                : (
                    <MessageStrip tone="pos" title={`Batch ${h.noPengajuan} berhasil dikirim ke Sales Manager.`}>
                        Batch terkunci untuk Supervisor dan pindah ke tahap SM. PDF surat berhasil dibuat; PDF dapat dicetak setelah pengajuan disetujui Klaim.
                    </MessageStrip>
                )}
            <div className="fi-panel">
                <KeyValues items={[
                    ["No pengajuan", <span key="n" className="fi-mono">{h.noPengajuan}</span>],
                    ["Jumlah baris terkirim", <span key="r" className="fi-tnum">{h.rowCount}</span>],
                    ["Total nominal", rupiah(h.total)],
                    ["Transfer", rupiah(h.transfer)],
                    ["Tunai", rupiah(h.tunai)],
                ]} />
            </div>
            {h.sudahAda && <StripPdf pdfUrl={h.pdfUrl} claimStatus="" />}
        </>
    );
}

/** Aturan PDF #6 (old 2944, 4331–4345): SPV hanya bisa mengunduh PDF surat setelah pengajuan disetujui Klaim. */
function StripPdf({ pdfUrl, claimStatus }: { pdfUrl?: string | null; claimStatus: string }) {
    if (!pdfUrl) return null;
    return claimStatus === "Approved"
        ? <MessageStrip tone="info" title="PDF surat pengajuan:"><a href={pdfUrl} target="_blank" rel="noreferrer"><FileText className="fi-icon" aria-hidden /> Unduh PDF surat</a></MessageStrip>
        : <MessageStrip tone="info" title="PDF surat">dapat dicetak setelah pengajuan disetujui Klaim.</MessageStrip>;
}

// ── Kolom kedua: batch ──────────────────────────────────────────────────────────────────────────────────

/** Object Page batch SPV: mode ubah bila boleh diubah; selain itu baca-saja (+ ajukan pengembalian selisih bila ada sisa). */
function DetailSpv(props: DetailProps) {
    const { ctx, daftar, detail, batchId, muatUlang } = props;
    const { titipan, titip } = useContext(TitipanCtx);
    const [pesan, setPesan] = useState<Pesan | null>(() => (titipan?.batchId === batchId ? titipan.pesan ?? null : null));
    const [hasil, setHasil] = useState<HasilKirim | null>(() => (titipan?.batchId === batchId ? titipan.hasil ?? null : null));
    const [konflik, setKonflik] = useState<string | null>(null);
    // Titipan hanya untuk kunjungan pertama ke batch yang baru tersimpan.
    useEffect(() => () => titip(null), [titip]);

    const data = detail.data;
    if (!data) return <ObjectPageBatch {...props} />;
    const b = data.batch;
    const bisaUbah = !data.uji && !hasil && PREDIKAT.spvBisaUbah(b) && !ctx.izin("edit_returned_batch");
    const muatUlangKonflik = () => { setKonflik(null); muatUlang(); daftar.muatUlang(); };
    const stripUmum = (
        <>
            {pesan && <StripPesan pesan={pesan} tutup={() => setPesan(null)} />}
            {konflik && (
                <>
                    <MessageStrip tone="neg" title="Perubahan ditolak server:">
                        {konflik} Status batch di server sudah berubah sejak Anda membukanya, jadi perubahan Anda belum disimpan. Muat ulang untuk melihat versi terbaru, lalu ulangi perubahan.{" "}
                        <Button variant="tertiary" onClick={muatUlangKonflik}>Muat ulang</Button>
                    </MessageStrip>
                    <VariantNote bl="BL-09">Hari ini belum ada kunci versi: perubahan orang lain bisa tertimpa selama batch masih boleh diubah; server hanya menolak batch yang sudah dikirim, terkunci, atau periodenya ditutup. Usulan: tolak bila batch berubah sejak dibuka (versi), simpan dan kirim dalam satu transaksi.</VariantNote>
                </>
            )}
            {hasil && <StripHasil h={hasil} />}
            <StripPdf pdfUrl={b.pdfUrl} claimStatus={String(b.claimStatus || "")} />
        </>
    );

    if (bisaUbah) {
        // Dipasang ulang saat server mengirim versi baru (simpan berhasil / muat ulang setelah konflik): form mengikuti data server.
        return <UbahBatch key={String(b.updatedAt ?? "")} {...props} strip={stripUmum} setPesan={setPesan} setKonflik={setKonflik} setHasil={setHasil} konflik={Boolean(konflik)} />;
    }

    const r = data.refund.data;
    // Batch yang menunggu pengembalian: galat/memuat data refund tampil di tempat form (bukan bagian yang diam-diam hilang).
    const tungguRefund = !data.uji && !r && (PREDIKAT.selisihTerbuka(b) || ctx.sub === "selisih");
    const isiRefund = !data.uji && r?.summary && r.summary.remainingRefund > 0
        ? <AjukanRefund ctx={ctx} batch={b} ringkasan={r.summary} selesai={(p) => { setPesan({ tone: "pos", judul: p }); muatUlang(); daftar.muatUlang(); }} />
        : tungguRefund && data.refund.status === "galat" ? (
            <div className="fi-sect-in">
                <MessageStrip tone="neg" title="Data pengembalian selisih gagal dimuat.">
                    {data.refund.error} Form pengajuan belum bisa ditampilkan; ini bukan berarti tidak ada selisih.{" "}
                    <Button variant="tertiary" onClick={muatUlang}>Coba lagi</Button>
                </MessageStrip>
            </div>
        ) : tungguRefund && data.refund.status === "memuat" ? <div className="fi-sect-in"><Skeleton rows={3} label="Memuat data pengembalian selisih" /></div>
            : null;
    const bagian: BagianTambahan[] = isiRefund ? [{ id: "opc-refund", label: "Ajukan pengembalian", letak: "awal", isi: isiRefund }] : [];
    const berikut = daftar.batches.find((x) => x.id !== batchId && PREDIKAT.spvAntrean(x));
    return (
        <ObjectPageBatch
            {...props}
            bagian={bagian}
            strip={
                <>
                    {stripUmum}
                    {/* Hanya sebelum Klaim (status kunci lama 4403–4423); tahap sesudahnya jelas dari Flow. */}
                    {!data.uji && !hasil && !PREDIKAT.spvBisaUbah(b) && ["draf", "dikembalikan", "sm"].includes(tahapBatch(b)) && (
                        <MessageStrip tone="info" title="Baca-saja:">Batch sudah dikirim/disetujui atau terkunci. Supervisor hanya bisa mengubah batch Draf atau Dikembalikan.</MessageStrip>
                    )}
                    {r?.summary?.isFullyRefunded && <MessageStrip tone="pos" title="Selisih dana telah dikembalikan seluruhnya.">Batch dapat ditutup sebagai Selesai.</MessageStrip>}
                </>
            }
            aksi={hasil ? (
                <Button icon={<ChevronRight className="fi-icon" aria-hidden />} disabled={!berikut} disabledReason="Tidak ada draf atau batch dikembalikan lain."
                    onClick={() => berikut && ctx.bukaBatch(berikut.id)}>Batch berikutnya</Button>
            ) : undefined}
            pesanFooter={hasil ? "Tidak ada aksi lain untuk Anda di tahap ini." : undefined}
        />
    );
}

type Bersama = {
    strip: ReactNode; konflik: boolean;
    setPesan: (p: Pesan | null) => void; setKonflik: (k: string | null) => void; setHasil: (h: HasilKirim | null) => void;
};

/** Mode ubah batch Draf/Dikembalikan di Object Page (slot gantiItem/bagian/aksi). Draf → ctx.setDraf (konfirmasi keluar di OpcApp). */
function UbahBatch(props: DetailProps & Bersama) {
    const { ctx, daftar, detail, batchId, strip, konflik, setPesan, setKonflik, setHasil } = props;
    const data = detail.data!;
    const b = data.batch;
    // openReturnedBatch (old 3153–3215): isian dari detail batch; nilai cadangan sama dengan kode lama.
    const [awal] = useState(() => ({
        setup: {
            supervisorName: b.supervisorName || ctx.pengguna.nama.trim() || "Supervisor",
            principleName: b.principleName || "RECKITT BENCKISER, PT",
            bulan: (b.bulan || "05").padStart(2, "0"),
            tahun: b.tahun || "2026",
        },
        rows: data.items.length ? data.items.map(barisDariItem) : [barisKosong()],
    }));
    const [asli] = useState(() => ({
        noPengajuan: b.noPengajuan || "",
        gelombang: b.gelombang || gelombangDariNomor(b.noPengajuan || "") || "001",
        principleCode: b.principleCode || "",
        bulan: b.bulan || "",
        tahun: b.tahun || "",
    }));
    const f = useFormSpv({
        batchId, awal, asli,
        onPesan: setPesan,
        onKonflik: setKonflik,
        onDrafTersimpan: ({ noPengajuan }) => { setPesan({ tone: "pos", judul: `Draf ${noPengajuan} berhasil disimpan.` }); props.muatUlang(); daftar.muatUlang(); },
        onGagalKirim: (_h, pesan) => {
            daftar.muatUlang();
            throw new Error(`Perubahan sudah tersimpan sebagai draf, tetapi batch belum terkirim ke Sales Manager: ${pesan}`);
        },
        onTerkirim: (h) => { setHasil(h); props.selesai(`Batch ${h.noPengajuan} berhasil dikirim ke Sales Manager.`); },
        // ALREADY_SUBMITTED hanya dijawab POST (batch baru); PATCH tidak. Tetap ditangani supaya tidak diam.
        onSudahDikirim: () => setPesan({ tone: "warn", judul: "Pengajuan ini sudah pernah dikirim.", isi: "Silakan cek PDF atau lanjutkan alur persetujuan." }),
    });
    const { setDraf } = ctx;
    useEffect(() => { setDraf(f.dirty); return () => setDraf(false); }, [f.dirty, setDraf]);
    const dikembalikan = b.status !== "Draft";
    return (
        <>
            <ObjectPageBatch
                {...props}
                draf={f.dirty}
                strip={<>{strip}<StripDraf f={f} /></>}
                bagian={[{
                    id: "opc-setup", label: "Setup batch", letak: "awal",
                    isi: <SetupBatch f={f} catatan={dikembalikan
                        ? "Mode revisi batch yang dikembalikan. Supervisor dapat mengubah data lalu mengirim ulang ke Sales Manager."
                        : "Draf: ubah data lalu simpan, atau kirim ke Sales Manager. Setelah dikirim, batch baca-saja sampai dikembalikan."} />,
                }]}
                gantiItem={<EditorItem f={f} />}
                aksi={<AksiForm f={f} konflik={konflik} izinDraf={ctx.izin("edit_returned_batch")} izinKirim={ctx.izin("submit_batch")} />}
                pesanFooter={pesanFooter(f, konflik)}
            />
            <DialogForm f={f} baru={false} />
        </>
    );
}

// ── Kolom kedua: batch baru ─────────────────────────────────────────────────────────────────────────────

/** Form batch baru (panel Input Batch lama 3977–4401, form kosong). Setelah tersimpan/terkirim, batch dibuka di kolom kedua. */
function BatchBaru({ ctx, daftar }: { ctx: OpcKonteks; daftar: DaftarOpc }) {
    const router = useRouter();
    const sp = useSearchParams();
    const pathname = usePathname();
    const { titip } = useContext(TitipanCtx);
    const [pesan, setPesan] = useState<Pesan | null>(null);
    const [sudahAda, setSudahAda] = useState<HasilKirim | null>(null);
    const [awal] = useState(() => {
        const kini = new Date();
        return {
            setup: {
                supervisorName: ctx.pengguna.nama.trim(), principleName: "RECKITT BENCKISER, PT",
                bulan: String(kini.getMonth() + 1).padStart(2, "0"), tahun: String(kini.getFullYear()),
            },
            rows: [barisKosong()],
        };
    });
    // Sudah tersimpan: draf dibersihkan lalu pindah langsung (bukan ctx.ubahUrl, yang masih memegang status draf render ini).
    const buka = (t: Titipan) => {
        titip(t);
        ctx.setDraf(false);
        daftar.muatUlang();
        const p = new URLSearchParams(sp.toString());
        p.delete("view");
        p.set("batch", t.batchId);
        router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    };
    const f = useFormSpv({
        batchId: null, awal, asli: null,
        onPesan: setPesan,
        onKonflik: () => undefined, // POST tidak punya konflik versi
        onDrafTersimpan: (h) => buka({ batchId: h.batchId, pesan: { tone: "pos", judul: `Draf ${h.noPengajuan} berhasil disimpan.` } }),
        onGagalKirim: (h, p) => buka({ batchId: h.batchId, pesan: { tone: "neg", judul: `Draf ${h.noPengajuan} tersimpan, tetapi belum terkirim ke Sales Manager.`, isi: `${p} Periksa lalu kirim ulang.` } }),
        onTerkirim: (h) => buka({ batchId: h.batchId, pesan: { tone: "pos", judul: "Batch baru terkirim." }, hasil: h }),
        // old 3496–3511: hasil + PDF yang ada; form tetap terbuka. Bila server menyebut batchnya, batch itu dibuka.
        onSudahDikirim: (h) => (h.batchId ? buka({ batchId: h.batchId, hasil: h }) : setSudahAda(h)),
    });
    const { setDraf } = ctx;
    useEffect(() => { setDraf(f.dirty); return () => setDraf(false); }, [f.dirty, setDraf]);
    const izinBaru = ctx.izin("create_batch");
    return (
        <div style={{ display: "grid", gap: 12 }}>
            <ObjectPageHeader
                breadcrumbs={[{ label: "OFF Program Control" }, { label: "Batch baru" }]}
                title="Batch baru"
                status={<StatusBadge tone="neu">Draf</StatusBadge>}
                draft={f.dirty}
                attributes={[
                    { label: "No pengajuan (otomatis)", value: <span className="fi-mono">{f.generatedNo}</span> },
                    { label: "Principal", value: f.setup.principleName },
                    { label: "Item", value: <span className="fi-tnum">{f.rows.length}</span> },
                    { label: "Total", value: <span className="fi-tnum">{rupiah(f.bayar.total)}</span> },
                ]}
            />
            <div style={{ display: "grid", gap: 12, padding: "0 12px 12px" }}>
                {pesan && <StripPesan pesan={pesan} tutup={() => setPesan(null)} />}
                {sudahAda && <StripHasil h={sudahAda} />}
                <StripDraf f={f} />
                <Section id="opc-setup" title="Setup batch">
                    <SetupBatch f={f} catatan="No Pengajuan final diberikan server saat batch pertama kali disimpan." />
                </Section>
                <Section id="opc-item" title="Item" subtitle="isi per item; kelengkapan awal dari SPV">
                    <EditorItem f={f} />
                </Section>
            </div>
            <FooterToolbar message={pesanFooter(f, false)}>
                <AksiForm f={f} konflik={false} izinDraf={izinBaru} izinKirim={izinBaru ?? ctx.izin("submit_batch")} />
            </FooterToolbar>
            <DialogForm f={f} baru />
        </div>
    );
}

// ── Modul ───────────────────────────────────────────────────────────────────────────────────────────────

export default function Spv(props: PeranProps) {
    const { ctx, daftar } = props;
    const [titipan, titip] = useState<Titipan | null>(null);
    const nilai = useMemo(() => ({ titipan, titip }), [titipan]);

    // Batch yang dibuka dari lonceng/Ctrl K saat di Diskon tetap tampil (antrean + kolom kedua); tombol Diskon menutup batch.
    if (ctx.sub === "diskon" && !ctx.batchId) {
        return (
            <div style={{ display: "grid", gap: 12 }}>
                <div className="fi-btnrow">
                    <Button variant="tertiary" icon={<ChevronLeft className="fi-icon" aria-hidden />} onClick={() => ctx.pilihSub(null)}>Kembali ke pengajuan</Button>
                </div>
                <DiskonSpv ctx={ctx} />
            </div>
        );
    }

    const baru = ctx.sub === "baru" && !ctx.batchId;
    // Membuka batch dari antrean saat form baru terbuka sekaligus menutup mode "baru" (satu langkah URL, dijaga dialog draf).
    const ctxKerja: OpcKonteks = { ...ctx, bukaBatch: (id) => ctx.ubahUrl(ctx.sub === "baru" ? { batch: id, view: null } : { batch: id }) };
    const izinBaru = ctx.izin("create_batch");
    const selisih = daftar.batches.filter(PREDIKAT.selisihTerbuka);
    return (
        <TitipanCtx.Provider value={nilai}>
            <KerjaPeran
                ctx={ctxKerja}
                daftar={daftar}
                tampilan={TAMPILAN_SPV}
                Detail={DetailSpv}
                atas={
                    <>
                        <div className="fi-btnrow">
                            <Button icon={<Plus className="fi-icon" aria-hidden />} disabled={Boolean(izinBaru)} disabledReason={izinBaru}
                                onClick={() => ctx.ubahUrl({ view: "baru", batch: null })}>Batch baru</Button>
                            <Button variant="tertiary" icon={<Percent className="fi-icon" aria-hidden />} onClick={() => ctx.ubahUrl({ view: "diskon", batch: null })}>Pengajuan diskon SPV</Button>
                        </div>
                        {ctx.sub === "selisih" && (
                            <MessageStrip tone="info" title="Data selisih:">
                                Batch di bawah ini memiliki selisih antara nilai pembayaran Keuangan dan realisasi klaim. Supervisor wajib mengajukan pengembalian dana agar alur batch dapat ditutup.
                                {/* "Selisih perlu kembali" per batch (old 3786–3807); nominal di baris antrean adalah total batch. */}
                                {selisih.length > 0 && (
                                    <KeyValues items={selisih.map((b) => [b.noPengajuan, `${rupiah(Number(b.refundAmount || 0))} perlu kembali · ${labelStatus(b.refundStatus || b.status)}`])} />
                                )}
                            </MessageStrip>
                        )}
                        <PengingatKelengkapan batches={daftar.batches} buka={ctx.bukaBatch} />
                    </>
                }
                kolomKedua={baru ? { isi: <BatchBaru ctx={ctx} daftar={daftar} />, tutup: () => ctx.ubahUrl({ view: null }) } : undefined}
            />
        </TitipanCtx.Provider>
    );
}
