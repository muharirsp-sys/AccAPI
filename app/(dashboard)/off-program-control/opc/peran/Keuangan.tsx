/*
 * Tujuan: Modul peran Keuangan OFF Program Control (Fiori S4d, tab `finance`, ZONA UANG): antrean "Menunggu Anda" (isFinanceQueueBatch)
 *   + Semua (isFinanceMonitoringBatch), tampilan lokal "Pengembalian selisih", dan Object Page batch dengan pembayaran per item
 *   (pilih item satu cara bayar, form bayar, lampiran bank), Catat pembayaran lewat dialog `bayar`, dan verifikasi pengembalian
 *   selisih (KeuanganRefund.tsx). Pengganti FinanceDashboard + RefundPanel (verifikasi) di old-opc.tsx 7958–9177.
 * Caller: OpcApp.tsx (MODUL.finance).
 * Dependensi: opc/Bersama (KerjaPeran, kontrak), opc/ObjectPageBatch, opc/peran/KeuanganRefund (tulisUang, bagian pengembalian), components/fiori/*,
 *   lib/opc-ui (TAMPILAN, PREDIKAT, tanggalOpc, labelStatus), lib/off-program-control/workflow (canProcessFinancePayment = gerbang server),
 *   lib/promo-ui (rupiah), lucide-react.
 * Main Functions: Keuangan (default), DetailKeuangan, caraBayar, sudahDibayar, galatBukti.
 * Side Effects: POST /api/off-program-control/batches/[id]/finance-payment (FormData: paymentDate, senderBank, note, itemIds JSON,
 *   paymentProof opsional) — MENCATAT UANG DIBAYAR; payload dan validasi sama dengan submitFinancePayment lama 8503–8600.
 *   PATCH/POST /refund lewat KeuanganRefund. Menandai draf halaman (ctx.setDraf) selama ada pilihan/isian yang belum dicatat.
 */
"use client";

import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { Button, KeyValues, ListItem, MessageStrip, ResponsiveTable, StatusBadge, VariantNote, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { canProcessFinancePayment } from "@/lib/off-program-control/workflow";
import type { OffBatchRow } from "@/lib/off-program-control/types";
import { PREDIKAT, TAMPILAN, labelStatus, tanggalOpc, type BatchOpc, type ItemOpc, type PembayaranOpc, type RingkasanBayar, type Tampilan } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KerjaPeran, type DetailProps, type PeranProps } from "../Bersama";
import { ObjectPageBatch, type BagianTambahan } from "../ObjectPageBatch";
import { TidakPasti, bagianAjukan, bagianRefund, tulisUang } from "./KeuanganRefund";

/** Item dari GET /batches/[id] (baris DB utuh): financePaymentId ikut terkirim walau tidak ada di tipe bersama. */
type ItemBayar = ItemOpc & { financePaymentId?: string | null };

type HasilBayar = {
    pesan: string; paymentNo?: number; paymentDate: string; paidAmount: number; paymentMethod: string; senderBank: string;
    paymentProofName: string; paymentProofUrl: string | null; remainingAmount?: number; isFullyPaid?: boolean;
};

const KOSONG: ReadonlySet<string> = new Set();
const enc = encodeURIComponent;
const MIME_BUKTI = ["application/pdf", "image/png", "image/jpeg"];
const MAKS_BUKTI = 5 * 1024 * 1024;
const PUTUS = "Server tidak memberi jawaban yang pasti (koneksi putus atau gateway timeout); pembayaran mungkin sudah tercatat atau belum. Detail batch dimuat ulang — periksa riwayat pembayaran sebelum mencoba lagi.";

/** normalizeUiPaymentMethod lama (363): "transfer"/"tunai" → label baku; nilai lain apa adanya. */
function caraBayar(value: string | null | undefined): string {
    const v = String(value || "");
    const n = v.trim().toLowerCase();
    return n === "transfer" ? "Transfer" : n === "tunai" ? "Tunai" : v;
}

/** isFinanceItemPaid lama (8288): sama dengan cek "alreadyPaid" server. */
const sudahDibayar = (i: ItemBayar) => i.financePaymentStatus === "paid" || Boolean(i.financePaymentId);

/** Validasi lampiran di submitFinancePayment lama (8520–8533), pesan sama; server memeriksa lagi. */
function galatBukti(f: File | null): string | undefined {
    if (!f) return undefined;
    if (!MIME_BUKTI.includes(f.type)) return "File bukti pembayaran harus PDF/PNG/JPG/JPEG.";
    if (f.size > MAKS_BUKTI) return "Ukuran file maksimal 5MB.";
    return undefined;
}

/**
 * Batch boleh dibayar = gerbang server POST finance-payment (canProcessFinancePayment: SM, Klaim, OM disetujui dan Keuangan menunggu/
 * sebagian/perlu koreksi). Lebih ketat dari isFinanceActionableBatch lama (774) — BL-06: tanpa form/aksi untuk batch yang tidak sah.
 * BatchOpc membawa keempat sumbu yang dibaca fungsi itu.
 */
const bolehBayar = (b: BatchOpc) => canProcessFinancePayment(b as unknown as OffBatchRow);

/** splitPeriodDates lama (414): "awal - akhir" → dd/mm/yyyy – dd/mm/yyyy. */
function periodeItem(periode: string | null | undefined) {
    const [awal = "", akhir = ""] = String(periode || "").split(" - ");
    return awal || akhir ? `${tanggalOpc(awal)} – ${tanggalOpc(akhir)}` : "–";
}

/** Kolom kedua Keuangan: Object Page + pilih item, form pembayaran, dialog `bayar`, verifikasi pengembalian. */
function DetailKeuangan(props: DetailProps) {
    const { ctx, daftar, detail, muatUlang } = props;
    const setDraf = ctx.setDraf;
    // Pilihan item = urutan klik (Set menjaga urutan sisip), sama dengan selectedPaymentItemIds lama yang dikirim sebagai itemIds.
    const [pilih, setPilih] = useState<ReadonlySet<string>>(KOSONG);
    const [tanggal, setTanggal] = useState("");
    const [bank, setBank] = useState("");
    const [bukti, setBukti] = useState<File | null>(null);
    const [kunciBukti, setKunciBukti] = useState(0); // ganti key = input berkas kosong lagi setelah dicatat
    // null = belum disentuh → memakai financeNote batch (kode lama mengisi catatan dari batch setiap detail dimuat).
    const [catatan, setCatatan] = useState<string | null>(null);
    const [pesanPilih, setPesanPilih] = useState<string | null>(null);
    const [dialog, setDialog] = useState(false);
    const [hasil, setHasil] = useState<HasilBayar | null>(null);
    const [pesanRefund, setPesanRefund] = useState<string | null>(null);
    const [drafAjukan, setDrafAjukan] = useState(false); // form Ajukan pengembalian (AjukanRefund melapor lewat onDraf)
    const [tidakPasti, setTidakPasti] = useState<string | null>(null);

    const d = detail.data;
    const b = d?.batch;
    const bayarAktif = Boolean(b && bolehBayar(b));
    const catatanAwal = b?.financeNote ?? "";
    // Draf = pilihan/isian pembayaran yang belum dicatat (bukti dipilih, item dicentang, tanggal, catatan diubah). Centang pada item
    // yang ternyata sudah lunas (detail dimuat ulang) tidak dihitung.
    const nPilih = (d?.items ?? []).filter((i) => pilih.has(i.id) && !sudahDibayar(i as ItemBayar)).length;
    const dirty = bayarAktif && (nPilih > 0 || tanggal !== "" || bukti !== null || (catatan !== null && catatan !== catatanAwal));
    useEffect(() => { setDraf(dirty || drafAjukan); return () => setDraf(false); }, [dirty, drafAjukan, setDraf]);

    // Pengembalian: strip sukses dipegang di sini (bagiannya bisa hilang setelah selisih lunas), lalu daftar + detail dimuat ulang.
    const selesaiRefund = (pesan: string) => { setPesanRefund(pesan); daftar.muatUlang(); muatUlang(); };
    const lanjut = { ...props, onSelesai: selesaiRefund, onTidakPasti: setTidakPasti };
    const bagianSelisih = [bagianRefund(lanjut), bagianAjukan({ ...lanjut, onDraf: setDrafAjukan })].filter((x): x is BagianTambahan => x !== null);
    const strip = (
        <>
            {tidakPasti && <MessageStrip tone="warn" title="Hasil aksi terakhir belum pasti." onClose={() => setTidakPasti(null)}>{tidakPasti}</MessageStrip>}
            {hasilStrip(hasil, () => setHasil(null))}
            {pesanRefund && <MessageStrip tone="pos" title={pesanRefund} onClose={() => setPesanRefund(null)} />}
        </>
    );
    if (!d || !b) return <ObjectPageBatch {...props} />;
    if (!bayarAktif) {
        // BL-06: batch yang tidak sedang menunggu pembayaran = baca-saja (kode lama menampilkan tombol nonaktif).
        return <ObjectPageBatch {...props} draf={drafAjukan} bagian={bagianSelisih} strip={strip} />;
    }

    const items = d.items as ItemBayar[];
    const perId = new Map(items.map((i) => [i.id, i]));
    const belum = items.filter((i) => !sudahDibayar(i));
    // Item yang ternyata sudah dibayar (detail dimuat ulang) keluar dari pilihan, tidak ikut terkirim.
    const dipilih = [...pilih].map((id) => perId.get(id)).filter((i): i is ItemBayar => Boolean(i) && !sudahDibayar(i!));
    const metodeDipilih = Array.from(new Set(dipilih.map((i) => caraBayar(i.caraBayar)))).filter(Boolean);
    const metode = metodeDipilih.length === 1 ? metodeDipilih[0] : "";
    const total = dipilih.reduce((t, i) => t + Number(i.nominal || 0), 0);

    // Ringkasan pembayaran disetujui (lama 8253–8293): agregat server, jatuh ke hitungan baris bila kosong.
    const totalNominal = Number(d.summary?.totalNominal || items.reduce((t, i) => t + Number(i.nominal || 0), 0));
    const jumlahCara = (cara: string) => items.filter((i) => caraBayar(i.caraBayar) === cara).reduce((t, i) => t + Number(i.nominal || 0), 0);
    const transfer = Number(d.summary?.transfer || jumlahCara("Transfer"));
    const tunai = Number(d.summary?.tunai || jumlahCara("Tunai"));
    const totalPaid = Number(d.paymentSummary?.totalPaid ?? b.paidAmount ?? d.payments.reduce((t, p) => t + Number(p.paidAmount || 0), 0));
    const sisa = Number(d.paymentSummary?.remainingAmount ?? Math.max(0, totalNominal - totalPaid));

    const izin = ctx.izin("finance_payment");
    // PELAJARAN S4c: status bayar yang usang tidak boleh memungkinkan pembayaran kedua. Selama detail dimuat ulang (termasuk sesudah
    // tolakan server) atau gagal dimuat ulang (yang tampil = hasil sebelumnya), pilih item dan Catat terkunci.
    const terkunci = d.uji ? "Batch data uji (mock) tidak bisa dibayar."
        : detail.status === "memuat" ? "Menunggu detail batch selesai dimuat ulang."
            : detail.status === "galat" ? "Detail batch gagal dimuat ulang; status bayar di layar bisa usang. Muat ulang dulu sebelum mencatat pembayaran."
                : undefined;
    const buktiGalat = galatBukti(bukti);
    const catatanNilai = catatan ?? catatanAwal;
    const alasan = izin ?? terkunci ?? (dipilih.length === 0 ? "Pilih item yang akan dibayar dulu."
        : metodeDipilih.length !== 1 ? "Pilih item dengan cara bayar yang sama."
            : !tanggal ? "Isi tanggal bayar dulu."
                : buktiGalat ? `Lampiran bank: ${buktiGalat}` : undefined);

    // isFinanceItemDisabledForSelection lama (8338): lunas tidak bisa dipilih; setelah satu cara bayar dipilih, cara lain nonaktif.
    const bisaDipilih = (i: ItemBayar) => !izin && !terkunci && !sudahDibayar(i) && (!metode || pilih.has(i.id) || caraBayar(i.caraBayar) === metode);
    const ubahPilih = (next: ReadonlySet<string>) => {
        const cara = new Set([...next].map((id) => perId.get(id)).filter((i) => i && !sudahDibayar(i)).map((i) => caraBayar(i!.caraBayar)).filter(Boolean));
        if (cara.size > 1) { setPesanPilih("Pilih item dengan cara bayar yang sama."); return; } // "Pilih semua" pada batch campuran
        setPesanPilih(null);
        setPilih(next);
    };
    const kosongkan = () => { setPilih(KOSONG); setPesanPilih(null); };
    const adaPilihan = dipilih.length > 0;
    const labelPilih = (i: ItemBayar) => `Pilih item ${i.itemNo} (${i.toko || "tanpa toko"}) untuk dibayar`;
    const kotak = (i: ItemBayar) => (
        <input type="checkbox" aria-label={labelPilih(i)} checked={pilih.has(i.id)} disabled={!bisaDipilih(i)}
            onChange={() => { const next = new Set(pilih); if (next.has(i.id)) next.delete(i.id); else next.add(i.id); ubahPilih(next); }} />
    );
    const statusItem = (i: ItemBayar) => (sudahDibayar(i) ? <StatusBadge tone="pos">Dibayar</StatusBadge>
        : pilih.has(i.id) ? <StatusBadge tone="info">Akan dibayar</StatusBadge>
            : metode && caraBayar(i.caraBayar) !== metode ? <span className="fi-sub">Cara bayar berbeda dari pilihan</span>
                : "Belum dibayar");

    const kolom: Column<ItemBayar>[] = [
        { key: "surat", header: "No Surat · program", cell: (i) => <><span className="fi-mono">{i.noSurat || "–"}</span><span className="fi-sub">{i.namaProgram || "–"}</span></> },
        { key: "toko", header: "Toko", cell: (i) => i.toko || "–" },
        { key: "nominal", header: "Nominal", align: "end", cell: (i) => <span className="fi-tnum">{rupiah(i.nominal)}</span> },
        { key: "cara", header: "Cara bayar", cell: (i) => i.caraBayar || "–" },
        { key: "status", header: "Keuangan", cell: statusItem },
        // No rekening hanya untuk Transfer (kode lama); server menyamarkannya bagi akun tanpa izin bayar.
        { key: "rek", header: "No rekening", secondary: true, cell: (i) => (caraBayar(i.caraBayar) === "Transfer" && i.noRekening ? <span className="fi-mono">{i.noRekening}</span> : "–") },
        { key: "barang", header: "Barang", secondary: true, cell: (i) => i.barang || "–" },
        { key: "periode", header: "Periode", secondary: true, cell: (i) => periodeItem(i.periode) },
        { key: "tipe", header: "Tipe", secondary: true, cell: (i) => i.type || "–" },
        { key: "deadline", header: "Deadline", secondary: true, cell: (i) => tanggalOpc(i.deadline) },
        { key: "no", header: "Item ke", secondary: true, cell: (i) => <span className="fi-tnum">{i.itemNo}</span> },
    ];
    const tabelItem = (
        <>
            <ResponsiveTable title="Item batch" columns={kolom} rows={items} rowKey={(i) => i.id}
                selected={pilih} onSelectedChange={ubahPilih} selectableRow={bisaDipilih} rowLabel={labelPilih}
                actions={adaPilihan ? <Button variant="tertiary" onClick={kosongkan}>Kosongkan pilihan</Button> : undefined}
                empty={{ title: "Batch ini tidak punya item" }}
                mobileItem={(i) => (
                    <div className="fi-wl-row">
                        {kotak(i)}
                        <ListItem doc={i.noSurat || `Item ${i.itemNo}`} amount={rupiah(i.nominal)} title={i.toko || "–"}
                            meta={[i.namaProgram, i.caraBayar, caraBayar(i.caraBayar) === "Transfer" ? i.noRekening : ""].filter(Boolean).join(" · ")}
                            badge={sudahDibayar(i) ? <StatusBadge tone="pos">Dibayar</StatusBadge> : pilih.has(i.id) ? <StatusBadge tone="info">Akan dibayar</StatusBadge> : undefined} />
                    </div>
                )} />
            {pesanPilih && <div className="fi-sect-in"><MessageStrip tone="warn" title={pesanPilih} onClose={() => setPesanPilih(null)}>Satu pencatatan hanya untuk item dengan cara bayar yang sama; catat Transfer dan Tunai terpisah.</MessageStrip></div>}
        </>
    );

    const bagianBayar: BagianTambahan = {
        id: "opc-catat-bayar",
        label: "Catat pembayaran",
        isi: (
            <div className="fi-sect-in" style={{ display: "grid", gap: 12 }}>
                <p className="fi-small fi-subtle">
                    Keuangan menerima batch setelah OM menyetujui. Centang item di bagian Item (satu cara bayar per pencatatan); setelah semua item
                    lunas, batch kembali ke Klaim untuk verifikasi final.
                </p>
                <KeyValues items={[
                    ["Status Keuangan", labelStatus(b.financeStatus)],
                    ["Belum dibayar", <span key="n" className="fi-tnum">{belum.length} dari {items.length} item</span>],
                    ["Sisa pembayaran", <span key="s" className="fi-tnum">{rupiah(sisa)}</span>],
                    ["Total transfer baris", <span key="t" className="fi-tnum">{rupiah(transfer)}</span>],
                    ["Total tunai baris", <span key="u" className="fi-tnum">{rupiah(tunai)}</span>],
                    ["Deadline klaim", tanggalOpc(b.claimDeadline)],
                ]} />
                {transfer > 0 && tunai > 0 && (
                    <MessageStrip tone="warn" title="Batch ini memiliki lebih dari satu cara bayar.">Pastikan pembayaran sesuai rincian baris.</MessageStrip>
                )}
                <div className="fi-formgrid">
                    <FormField label="Tanggal bayar" required>
                        {(a) => <input {...a} className="fi-input" type="date" value={tanggal} disabled={Boolean(izin)} onChange={(e) => setTanggal(e.target.value)} />}
                    </FormField>
                    <FormField label="Bank pengirim">
                        {(a) => <input {...a} className="fi-input" value={bank} disabled={Boolean(izin)} onChange={(e) => setBank(e.target.value)} />}
                    </FormField>
                </div>
                <KeyValues items={[
                    ["Item dipilih", <span key="i" className="fi-tnum">{dipilih.length} item</span>],
                    ["Cara bayar", metode || "Mengikuti item yang dipilih"],
                    ["Jumlah dibayar", <b key="j" className="fi-tnum">{rupiah(total)}</b>],
                ]} />
                <FormField label="Lampiran bank (opsional)" error={buktiGalat}
                    help="PDF bukti pembayaran dibuat otomatis setelah pembayaran dicatat. Lampiran bank opsional: PDF, PNG, JPG, atau JPEG. Maksimal 5MB.">
                    {(a) => <input {...a} key={kunciBukti} className="fi-input" type="file" accept="application/pdf,image/png,image/jpeg" disabled={Boolean(izin)}
                        onChange={(e) => setBukti(e.target.files?.[0] ?? null)} />}
                </FormField>
                <FormField label="Catatan Keuangan">
                    {(a) => <textarea {...a} className="fi-input" rows={3} value={catatanNilai} disabled={Boolean(izin)} onChange={(e) => setCatatan(e.target.value)} />}
                </FormField>
                <VariantNote bl="BL-07">
                    Lampiran bank divalidasi (jenis dan ukuran) lalu tidak disimpan; yang tersimpan dan bisa dibuka dari Riwayat pembayaran adalah PDF
                    ringkasan buatan sistem yang mencatat nama lampiran. Bila BL-07 masuk, lampiran tersimpan dengan hash dan bisa dibuka dari riwayat.
                </VariantNote>
            </div>
        ),
    };

    /** submitFinancePayment lama (8503–8600): validasi, FormData, dan urutan isian sama. */
    async function catat() {
        if (dipilih.length === 0) throw new Error("Pilih minimal satu item yang akan dibayar.");
        if (metodeDipilih.length !== 1) throw new Error("Pilih item dengan cara bayar yang sama.");
        if (buktiGalat) throw new Error(buktiGalat);
        const formData = new FormData();
        formData.append("paymentDate", tanggal);
        formData.append("senderBank", bank);
        formData.append("note", catatanNilai);
        formData.append("itemIds", JSON.stringify(dipilih.map((i) => i.id)));
        if (bukti) formData.append("paymentProof", bukti);
        let data: Record<string, unknown>;
        try {
            data = await tulisUang(`/api/off-program-control/batches/${enc(b!.id)}/finance-payment`, { body: formData, gagal: "Gagal mengirim pembayaran.", putus: PUTUS });
        } catch (e) {
            // Tolakan server (mis. 409 item sudah dibayar orang lain, periode ditutup) atau koneksi putus: status di layar bisa usang.
            // Muat ulang detail; selama memuat tombol Catat terkunci dan item yang ternyata lunas keluar dari pilihan.
            muatUlang();
            if (e instanceof TidakPasti) setTidakPasti(e.message); // tetap tampil walau form hilang (batch ternyata lunas)
            throw e;
        }
        const ringkas = data.paymentSummary as RingkasanBayar | undefined;
        const p = data.payment as PembayaranOpc | undefined;
        const lunas = ringkas?.isFullyPaid === true;
        const pesan = lunas ? "Pembayaran lunas. Batch diteruskan ke verifikasi final Klaim."
            : `Pembayaran ke-${p?.paymentNo ?? "?"} tercatat. Batch tetap di Keuangan sampai semua item dibayar.`;
        setHasil({
            pesan, paymentNo: p?.paymentNo, paymentDate: tanggal, paidAmount: total, paymentMethod: metodeDipilih[0], senderBank: bank,
            paymentProofName: p?.paymentProofName || "", paymentProofUrl: p?.proofUrl || null, remainingAmount: ringkas?.remainingAmount, isFullyPaid: ringkas?.isFullyPaid,
        });
        // Bank pengirim dipertahankan (kode lama juga) untuk pencatatan berikutnya; sisanya dikosongkan.
        setPilih(KOSONG);
        setTanggal("");
        setBukti(null);
        setKunciBukti((k) => k + 1);
        setCatatan(null);
        setPesanPilih(null);
        setDialog(false);
        if (lunas) props.selesai(pesan); // batch pindah ke verifikasi final Klaim
        else { daftar.muatUlang(); muatUlang(); }
    }

    return (
        <ObjectPageBatch
            {...props}
            draf={dirty || drafAjukan}
            gantiItem={tabelItem}
            bagian={[bagianBayar, ...bagianSelisih]}
            strip={strip}
            pesanFooter={dipilih.length > 0
                ? <span className="fi-sum"><b>{dipilih.length} item dipilih</b> · {rupiah(total)}{metode ? ` · ${metode}` : ""}{alasan && <span className="fi-why"> · {alasan}</span>}</span>
                : alasan}
            aksi={
                <>
                    {adaPilihan && <Button variant="tertiary" onClick={kosongkan}>Kosongkan pilihan</Button>}
                    <Button variant="primary" icon={<Wallet className="fi-icon" aria-hidden />} disabled={Boolean(alasan)} disabledReason={alasan} onClick={() => setDialog(true)}>
                        Catat pembayaran…
                    </Button>
                    <ConfirmDialog
                        open={dialog}
                        onClose={() => setDialog(false)}
                        title={`Catat pembayaran ${b.noPengajuan}?`}
                        tag="Pembayaran"
                        confirmLabel={`Catat ${rupiah(total)}`}
                        confirmDisabled={alasan}
                        facts={[
                            ["Principal", b.principleName],
                            ["Item dibayar", `${dipilih.length} dari ${belum.length} item yang belum dibayar`],
                            ["Cara bayar", metode || "–"],
                            ["Nominal", <b key="n" className="fi-tnum">{rupiah(total)}</b>],
                            ["Tanggal bayar", tanggalOpc(tanggal)],
                            ["Bank pengirim", bank || "–"],
                            ["Lampiran bank", bukti ? `${bukti.name} · divalidasi, tidak disimpan` : "Tidak ada"],
                            ["Bukti tersimpan", "PDF ringkasan pembayaran dibuat otomatis"],
                            ["Sisa sebelum dicatat", <span key="s" className="fi-tnum">{rupiah(sisa)}</span>],
                            ["Setelah dicatat", "Bila semua item lunas, batch diteruskan ke verifikasi final Klaim; bila belum, tetap di Keuangan sebagai dibayar sebagian."],
                        ]}
                        onConfirm={catat}
                    >
                        <VariantNote bl="BL-08">
                            Tombol terkunci selama pencatatan berjalan dan klik ganda ditahan. Server hari ini menolak item yang sudah tercatat dibayar, tetapi
                            dua pencatatan yang benar-benar bersamaan belum dicegah (AM-023). Bila BL-08 masuk, server mengunci batch dan menolak yang kedua.
                        </VariantNote>
                    </ConfirmDialog>
                </>
            }
        />
    );
}

/** Hasil pembayaran (paymentResult lama 8242–8250, ditampilkan 9065–9120) di bawah header Object Page. */
function hasilStrip(h: HasilBayar | null, tutup: () => void) {
    if (!h) return null;
    return (
        <MessageStrip tone="pos" title={h.pesan} onClose={tutup}>
            <KeyValues items={[
                ["No pembayaran", h.paymentNo ? `Ke-${h.paymentNo}` : "–"],
                ["Tanggal bayar", tanggalOpc(h.paymentDate)],
                ["Jumlah dibayar", <span key="j" className="fi-tnum">{rupiah(h.paidAmount)}</span>],
                ["Cara bayar", h.paymentMethod],
                ["Bank pengirim", h.senderBank || "–"],
                ["Bukti pembayaran", h.paymentProofUrl ? <a key="b" href={h.paymentProofUrl} target="_blank" rel="noreferrer">{h.paymentProofName || "Buka bukti"}</a> : h.paymentProofName || "–"],
                ["Sisa pembayaran", <span key="s" className="fi-tnum">{rupiah(h.remainingAmount ?? 0)}</span>],
                ["Status", h.isFullyPaid ? "Lunas" : "Belum lunas"],
            ]} />
        </MessageStrip>
    );
}

/** "Menunggu Anda" + Semua dari kerangka; lokal: batch dengan selisih yang belum kembali (kode lama: refund hanya terlihat saat batch dibuka). */
const TAMPILAN_KEUANGAN: Tampilan[] = [
    ...TAMPILAN.finance,
    { kunci: "selisih", label: "Pengembalian selisih", antrean: PREDIKAT.selisihTerbuka, kosong: "Tidak ada batch dengan selisih yang belum kembali." },
];

export default function Keuangan(props: PeranProps) {
    return <KerjaPeran {...props} tampilan={TAMPILAN_KEUANGAN} Detail={DetailKeuangan} />;
}
