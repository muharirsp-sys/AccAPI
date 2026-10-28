/*
 * Tujuan: Form batch CLM baru oleh Klaim (Fiori S4d, kolom kedua tampilan "Batch Claim (CLM)", URL `clm=baru`): principal (wajib dipilih,
 *   tanpa nilai bawaan), periode, nomor otomatis CLM, item berlabel, Hapus item lewat dialog bila terisi, Simpan sebagai draf lewat dialog.
 *   Pengganti Panel Data Klaim kode lama.
 * Caller: opc/peran/Klaim.tsx (kolomKedua KerjaPeran).
 * Dependensi: opc/Bersama (ambilOpc, tulisOpc, tanganiTulis, kontrak), components/fiori/{core,interactive}, lib/off-program-control/{constants,
 *   program-type,helpers} (daftar principal, tipe CLM, parseCurrency untuk total tampilan), lib/opc-ui, lib/promo-ui, lib/tampil (KOSONG).
 * Main Functions: FormClm.
 * Side Effects: GET /api/off-program-control/batches/next-number?source=claim; POST /api/off-program-control/batches (payload SAMA
 *   dengan submitClmBatch kode lama), lalu muat ulang daftar. Jawaban tidak pasti: strip peringatan + muat ulang daftar.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Plus, Save, Trash2 } from "lucide-react";
import { Button, FooterToolbar, KeyValues, MessageStrip, ObjectPageHeader, Section } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad } from "@/components/fiori/interactive";
import { offPaymentMethods, offPrinciples } from "@/lib/off-program-control/constants";
import { parseCurrency } from "@/lib/off-program-control/helpers";
import { OFF_CLM_PROGRAM_TYPES } from "@/lib/off-program-control/program-type";
import { periodeBatch } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { KOSONG } from "@/lib/tampil";
import { ambilOpc, pesanTidakPasti, tanganiTulis, tulisOpc, type DaftarOpc, type OpcKonteks } from "../Bersama";

/** Baris form = SupervisorBulkRow kode lama (149) tanpa kolom yang tidak dipakai CLM. */
type BarisClm = {
    id: string; noSurat: string; namaProgram: string; periodeAwal: string; periodeAkhir: string; toko: string; barang: string; nominal: string;
    caraBayar: string; noRekening: string; type: string; deadline: string;
};
const barisKosong = (id: string): BarisClm => ({
    id, noSurat: "", namaProgram: "", periodeAwal: "", periodeAkhir: "", toko: "", barang: "", nominal: "", caraBayar: "Transfer", noRekening: "", type: "", deadline: "",
});
const NAMA_BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const terisi = (r: BarisClm) => Object.entries(r).some(([k, v]) => k !== "id" && v !== "" && !(k === "caraBayar" && v === "Transfer"));
const transfer = (r: BarisClm) => r.caraBayar.trim().toLowerCase() === "transfer";

/**
 * Syarat simpan: urutan cek kode lama (server memeriksa ulang). Principal kosong ditolak server ("Principal tidak valid."), jadi
 * form tidak lagi memilihkan principal bawaan yang bisa terkirim tanpa disadari (audit desain No 73).
 */
function syaratSimpan(rows: BarisClm[], tahun: string, principal: string): string | undefined {
    if (!principal) return "Pilih principal dulu.";
    if (rows.length === 0) return "Minimal satu item wajib diisi.";
    const tanpaTipe = rows.findIndex((r) => !(OFF_CLM_PROGRAM_TYPES as readonly string[]).includes(r.type));
    if (tanpaTipe >= 0) return `Tipe program item ${tanpaTipe + 1} belum dipilih.`;
    const tanpaRekening = rows.findIndex((r) => transfer(r) && !r.noRekening.trim());
    if (tanpaRekening >= 0) return `No Rekening item ${tanpaRekening + 1} wajib diisi untuk Transfer.`;
    if (!/^\d{4}$/.test(tahun)) return "Tahun harus 4 angka.";
    return undefined;
}

export function FormClm({ ctx, daftar, tutup }: { ctx: OpcKonteks; daftar: DaftarOpc; tutup: () => void }) {
    const izinBuat = ctx.izin("create_batch");
    const [principal, setPrincipal] = useState("");
    const [bulan, setBulan] = useState(() => String(new Date().getMonth() + 1).padStart(2, "0"));
    const [tahun, setTahun] = useState(() => String(new Date().getFullYear()));
    const [rows, setRows] = useState<BarisClm[]>(() => [barisKosong("baris-1")]);
    const [segar, setSegar] = useState(0);
    const [dialog, setDialog] = useState(false);
    const [tersimpan, setTersimpan] = useState<{ id: string; no: string } | null>(null);
    const [tidakPasti, setTidakPasti] = useState<string | null>(null);
    const [hapusIdx, setHapusIdx] = useState<number | null>(null);
    const kode = offPrinciples.find((p) => p.name === principal)?.code ?? "";

    // Nomor otomatis CLM (kode lama): dimuat ulang saat principal/bulan/tahun berubah dan setelah simpan (segar).
    const [nomor] = useLoad(useCallback(async () => {
        void segar;
        if (!kode || !/^\d{4}$/.test(tahun)) return { status: "galat" as const, error: "Pilih principal dan isi tahun 4 angka untuk nomor otomatis." };
        const q = new URLSearchParams({ principleCode: kode, bulan, tahun, source: "claim" });
        return ambilOpc(`/api/off-program-control/batches/next-number?${q}`,
            (j) => ({ gelombang: String(j.gelombang || "001"), noPengajuan: String(j.noPengajuan || "") }), "Gagal memuat No Pengajuan CLM otomatis.");
    }, [kode, bulan, tahun, segar]));
    const gelombang = (nomor.data?.gelombang ?? "001").padStart(3, "0");
    const noPratinjau = nomor.data?.noPengajuan || `${gelombang}/CLM/${kode}/${bulan}/${tahun}`;
    // Nomor rakitan lokal hanya tampil sebagai perkiraan bila server sudah menjawab; selama memuat/gagal tidak dipajang seolah sah.
    const noTampil = nomor.status === "siap" ? noPratinjau : nomor.status === "memuat" ? "Menunggu nomor dari server" : "Belum tersedia";

    const dirty = rows.length !== 1 || rows.some(terisi);
    const { setDraf } = ctx;
    useEffect(() => { setDraf(dirty); }, [dirty, setDraf]);
    useEffect(() => () => setDraf(false), [setDraf]);

    const ubahBaris = (idx: number, patch: Partial<BarisClm>) => setRows((xs) => xs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    const total = rows.reduce((t, r) => t + parseCurrency(r.nominal), 0);
    const syarat = izinBuat ?? syaratSimpan(rows, tahun, principal);
    const hapusItem = (idx: number) => setRows((xs) => xs.filter((_, i) => i !== idx));

    const simpan = async () => {
        const data = await tulisOpc("/api/off-program-control/batches", {
            gagal: "Gagal membuat batch CLM.",
            body: {
                principleName: principal,
                principleCode: kode,
                bulan,
                tahun,
                supervisorName: "Divisi Claim",
                items: rows.map((r) => ({
                    noSurat: r.noSurat,
                    namaProgram: r.namaProgram,
                    periodeAwal: r.periodeAwal,
                    periodeAkhir: r.periodeAkhir,
                    toko: r.toko,
                    barang: r.barang,
                    nominal: r.nominal,
                    caraBayar: r.caraBayar || "Transfer",
                    noRekening: transfer(r) ? r.noRekening : "",
                    type: r.type,
                    originalType: r.type,
                    deadline: r.deadline,
                    kwt: false, skp: false, fp: false, pc: false, foto: false, rekap: false, others: false,
                    othersText: "",
                })),
            },
            putus: pesanTidakPasti("batch CLM ini", "daftar Batch Claim (CLM)"),
        }).catch(tanganiTulis((pesan) => { setTidakPasti(pesan); daftar.muatUlang(); }));
        setDialog(false);
        setTidakPasti(null);
        setTersimpan({ id: String(data.batchId || ""), no: String(data.noPengajuan || noPratinjau) });
        setRows([barisKosong(`baris-${Date.now()}`)]);
        setSegar((v) => v + 1);
        daftar.muatUlang();
    };

    return (
        <div style={{ display: "grid", gap: 12 }}>
            <ObjectPageHeader title="Batch CLM baru" draft={dirty}
                attributes={[
                    { label: "No Pengajuan (perkiraan)", value: <span className="fi-mono">{noTampil}</span> },
                    { label: "Item", value: <span className="fi-tnum">{rows.length}</span> },
                    { label: "Total", value: <span className="fi-tnum">{rupiah(total)}</span> },
                ]} />
            <div style={{ display: "grid", gap: 12, padding: "0 12px 12px" }}>
                {tersimpan && (
                    <MessageStrip tone="pos" title={`Batch CLM ${tersimpan.no} tersimpan sebagai draf.`} onClose={() => setTersimpan(null)}>
                        Kirim ke SM dari halaman batchnya. Form dikosongkan untuk batch berikutnya.{" "}
                        {tersimpan.id && <Button variant="tertiary" icon={<FolderOpen className="fi-icon" aria-hidden />} onClick={() => ctx.ubahUrl({ clm: null, batch: tersimpan.id })}>Buka batch</Button>}
                    </MessageStrip>
                )}
                {tidakPasti && <MessageStrip tone="warn" title="Hasil simpan terakhir belum pasti." onClose={() => setTidakPasti(null)}>{tidakPasti}</MessageStrip>}
                {izinBuat && <MessageStrip tone="warn" title="Baca-saja:">{izinBuat}</MessageStrip>}
                <Section title="Pengajuan" subtitle="data dari direksi untuk divisi Klaim">
                    <div className="fi-sect-in">
                        <div className="fi-formgrid">
                            <FormField label="Principal" required>{(a) => (
                                <select {...a} className="fi-input" value={principal} onChange={(e) => setPrincipal(e.target.value)}>
                                    <option value="">Pilih principal…</option>
                                    {offPrinciples.map((p) => <option key={p.code} value={p.name}>{p.name} ({p.code})</option>)}
                                </select>
                            )}</FormField>
                            <FormField label="Bulan" required>{(a) => (
                                <select {...a} className="fi-input" value={bulan} onChange={(e) => setBulan(e.target.value)}>
                                    {NAMA_BULAN.map((nama, i) => { const m = String(i + 1).padStart(2, "0"); return <option key={m} value={m}>{nama} ({m})</option>; })}
                                </select>
                            )}</FormField>
                            <FormField label="Tahun" required>{(a) => (
                                <input {...a} className="fi-input fi-tnum" inputMode="numeric" maxLength={4} value={tahun} onChange={(e) => setTahun(e.target.value.replace(/\D/g, ""))} />
                            )}</FormField>
                        </div>
                        <KeyValues items={[
                            ["Gelombang otomatis", <span key="g" className="fi-mono">{gelombang}</span>],
                            ["No Pengajuan CLM (perkiraan)", <span key="n" className="fi-mono">{noTampil}</span>],
                        ]} />
                        {nomor.status === "memuat" && <p className="fi-small fi-subtle" role="status">Memuat No Pengajuan CLM otomatis…</p>}
                        {nomor.status === "galat" && (kode
                            ? <p className="fi-msg" role="alert">{nomor.error}</p>
                            : <p className="fi-help">Pilih principal untuk melihat nomor otomatis.</p>)}
                        <p className="fi-small fi-subtle">
                            Nomor final diberikan server saat disimpan (format <span className="fi-mono">xxx/CLM/KODE/MM/YYYY</span>). Tipe program: Insentif, Diskon Reguler,
                            Insentif Distributor, Retur.
                        </p>
                    </div>
                </Section>
                <Section title="Item" subtitle={`${rows.length} item · ${rupiah(total)}`}
                    actions={<Button icon={<Plus className="fi-icon" aria-hidden />} onClick={() => setRows((xs) => [...xs, barisKosong(`baris-${Date.now()}-${xs.length + 1}`)])}>Tambah item</Button>}>
                    {rows.length === 0 && <div className="fi-sect-in"><p className="fi-small fi-subtle">Belum ada item. Tambah minimal satu item.</p></div>}
                    <ol aria-label="Item batch CLM" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {rows.map((r, idx) => (
                            <li key={r.id} className="fi-sect-in" style={{ borderTop: idx ? "1px solid var(--line)" : undefined }}>
                                <div role="group" aria-label={`Item ${idx + 1}`} style={{ display: "grid", gap: 10 }}>
                                    <div className="fi-btnrow">
                                        <b className="fi-small">Item {idx + 1}</b>
                                        {/* Item berisi ditanya dulu; item terakhir tidak bisa dihapus (simpan butuh minimal satu item). */}
                                        <Button variant="negative" style={{ marginLeft: "auto" }} icon={<Trash2 className="fi-icon" aria-hidden />}
                                            disabled={rows.length <= 1} disabledReason="Batch minimal punya satu item."
                                            onClick={() => (terisi(r) ? setHapusIdx(idx) : hapusItem(idx))}>Hapus item</Button>
                                    </div>
                                    <div className="fi-formgrid">
                                        <FormField label="No Surat">{(a) => <input {...a} className="fi-input fi-mono" value={r.noSurat} onChange={(e) => ubahBaris(idx, { noSurat: e.target.value })} />}</FormField>
                                        <FormField label="Nama program">{(a) => <input {...a} className="fi-input" value={r.namaProgram} onChange={(e) => ubahBaris(idx, { namaProgram: e.target.value })} />}</FormField>
                                        <FormField label="Tipe program (CLM)" required>{(a) => (
                                            <select {...a} className="fi-input" value={r.type} onChange={(e) => ubahBaris(idx, { type: e.target.value })}>
                                                <option value="">Pilih tipe…</option>
                                                {OFF_CLM_PROGRAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                                            </select>
                                        )}</FormField>
                                        <FormField label="Periode awal">{(a) => <input {...a} className="fi-input" type="date" value={r.periodeAwal} onChange={(e) => ubahBaris(idx, { periodeAwal: e.target.value })} />}</FormField>
                                        <FormField label="Periode akhir">{(a) => <input {...a} className="fi-input" type="date" value={r.periodeAkhir} min={r.periodeAwal || undefined} onChange={(e) => ubahBaris(idx, { periodeAkhir: e.target.value })} />}</FormField>
                                        <FormField label="Deadline">{(a) => <input {...a} className="fi-input" type="date" value={r.deadline} onChange={(e) => ubahBaris(idx, { deadline: e.target.value })} />}</FormField>
                                        <FormField label="Toko">{(a) => <input {...a} className="fi-input" value={r.toko} onChange={(e) => ubahBaris(idx, { toko: e.target.value })} />}</FormField>
                                        <FormField label="Barang">{(a) => <input {...a} className="fi-input" value={r.barang} onChange={(e) => ubahBaris(idx, { barang: e.target.value })} />}</FormField>
                                        <FormField label="Nominal">{(a) => <input {...a} className="fi-input fi-tnum" inputMode="numeric" placeholder="0" value={r.nominal} onChange={(e) => ubahBaris(idx, { nominal: e.target.value })} />}</FormField>
                                        <FormField label="Cara bayar">{(a) => (
                                            <select {...a} className="fi-input" value={r.caraBayar}
                                                onChange={(e) => ubahBaris(idx, { caraBayar: e.target.value, noRekening: e.target.value === "Tunai" ? "" : r.noRekening })}>
                                                {offPaymentMethods.map((m) => <option key={m} value={m}>{m}</option>)}
                                            </select>
                                        )}</FormField>
                                        <FormField label="No rekening" required={transfer(r)}>{(a) => (
                                            <input {...a} className="fi-input fi-mono" value={r.noRekening} readOnly={!transfer(r)} placeholder={transfer(r) ? "No rekening" : KOSONG}
                                                onChange={(e) => ubahBaris(idx, { noRekening: e.target.value })} />
                                        )}</FormField>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ol>
                </Section>
            </div>
            <FooterToolbar message={dirty && syarat ? `Simpan nonaktif: ${syarat}` : dirty ? "Isian belum disimpan." : undefined}>
                <Button variant="tertiary" onClick={tutup}>Tutup form</Button>
                <Button variant="primary" icon={<Save className="fi-icon" aria-hidden />} disabled={Boolean(syarat)} disabledReason={syarat} onClick={() => setDialog(true)}>Simpan sebagai draf…</Button>
            </FooterToolbar>
            <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title="Simpan batch CLM sebagai draf?" tag="Draf" confirmLabel="Simpan draf"
                description="Batch tersimpan sebagai Draf milik divisi Klaim. Kirim ke SM dilakukan terpisah dari halaman batch."
                facts={[
                    ["Principal", `${principal} (${kode})`],
                    ["Periode", periodeBatch({ bulan, tahun })],
                    ["No Pengajuan (perkiraan)", nomor.status === "siap" ? <span key="n" className="fi-mono">{noPratinjau}</span> : "Diberikan server saat disimpan"],
                    ["Item", <span key="i" className="fi-tnum">{rows.length} · {rupiah(total)}</span>],
                ]}
                onConfirm={simpan} />
            <ConfirmDialog open={hapusIdx !== null} onClose={() => setHapusIdx(null)} tone="negative" tag="Hapus item"
                title={`Hapus item ${(hapusIdx ?? 0) + 1}?`} confirmLabel="Hapus item"
                description="Isian item ini hilang dari form. Belum ada yang dikirim ke server."
                facts={hapusIdx !== null && rows[hapusIdx] ? [
                    ["No Surat", rows[hapusIdx].noSurat || KOSONG],
                    ["Toko", rows[hapusIdx].toko || KOSONG],
                    ["Nominal", rupiah(parseCurrency(rows[hapusIdx].nominal))],
                ] : []}
                onConfirm={() => { if (hapusIdx !== null) hapusItem(hapusIdx); setHapusIdx(null); }} />
        </div>
    );
}
