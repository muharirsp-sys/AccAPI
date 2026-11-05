/*
 * Tujuan: Mode latihan OFF Program Control (owner 3 Nov 2026): satu pengajuan contoh dijalankan dari Supervisor → Sales Manager →
 *   Klaim → OM → Keuangan → verifikasi final, dengan pengguna memerankan semua meja bergantian. Dipandu tur (halaman + per tahap),
 *   memakai pemilih tipe, bantuan kolom, beban CL/DM, dan Potong Tagihan yang sama dengan form nyata.
 * Caller: app/(dashboard)/off-program-control/latihan/page.tsx.
 * Dependensi: components/fiori/{core,interactive,Tur}, opc/PemilihTipe (BantuanTipe), lib/off-program-control/{constants,program-type},
 *   lib/opc-ui (BANTUAN_KOLOM, ALUR_TAHAP), lib/promo-ui (rupiah).
 * Main Functions: Latihan, Tahap* (satu komponen per meja), langkahTurLatihan.
 * Side Effects: TIDAK ADA panggilan API; semua di state React. localStorage `opc-tur-latihan-v1` (tur pertama sudah dilihat).
 */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Compass, PartyPopper, RotateCcw } from "lucide-react";
import { Button, Flow, KeyValues, MessageStrip, Section, StatusBadge, type FlowStep } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";
import { Tur, type LangkahTur } from "@/components/fiori/Tur";
import { OFF_BEBAN, offPaymentMethods } from "@/lib/off-program-control/constants";
import { INFO_TIPE, OFF_PROGRAM_TYPES, TIPE_LAINNYA, labelTipe } from "@/lib/off-program-control/program-type";
import { ALUR_TAHAP, BANTUAN_KOLOM } from "@/lib/opc-ui";
import { rupiah } from "@/lib/promo-ui";
import { BantuanTipe } from "../opc/PemilihTipe";

/** 0 Supervisor · 1 Sales Manager · 2 Klaim · 3 OM · 4 Keuangan · 5 Verifikasi final · 6 Selesai · -1 Dibatalkan. */
type Tahap = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6;

type Isi = {
    noSurat: string; namaProgram: string; toko: string; nominal: string; caraBayar: string; rekening: string; tipe: string; alasan: string; beban: string;
    kwt: boolean; skp: boolean; foto: boolean;
    catatanKembali: string; tglAju: string; deadline: string; berkasLengkap: boolean; tglBayar: string; noFaktur: string; noClaim: string; ceklisFinal: boolean;
};

// Data contoh generik (aturan owner 8 Okt: PRINCIPLE A, TOKO A; tanpa nama principal/orang nyata).
const AWAL: Isi = {
    noSurat: "001/PRINCIPLE A/XI/2026", namaProgram: "Cashback loyalty kuartal 4", toko: "TOKO A (C-TA0001)", nominal: "1500000", caraBayar: "Transfer",
    rekening: "", tipe: "", alasan: "", beban: "CL", kwt: true, skp: false, foto: true,
    catatanKembali: "", tglAju: "", deadline: "", berkasLengkap: false, tglBayar: "", noFaktur: "", noClaim: "", ceklisFinal: false,
};

const PERAN: Record<Exclude<Tahap, -1 | 6>, { peran: string; misi: string }> = {
    0: { peran: "Supervisor", misi: "Lengkapi satu item pengajuan, pilih tipe program dan beban, lalu kirim ke Sales Manager." },
    1: { peran: "Sales Manager", misi: "Periksa pengajuan dari Supervisor, lalu setujui atau kembalikan dengan catatan." },
    2: { peran: "Klaim", misi: "Periksa kelengkapan berkas, isi tanggal pengajuan klaim dan deadline, lalu setujui." },
    3: { peran: "Operational Manager", misi: "Putuskan: setujui supaya Keuangan bisa membayar, atau batalkan." },
    4: { peran: "Keuangan", misi: "Catat pembayaran ke toko sesuai cara bayarnya." },
    5: { peran: "Klaim (verifikasi final)", misi: "Cocokkan yang dibayar dengan yang diklaim, isi No Claim, lalu selesaikan." },
};
// Owner 3 Nov 2026: item Potong Tagihan dicatat Incaso (nomor faktur yang dipotong), bukan Keuangan.
const PERAN_INCASO = { peran: "Incaso", misi: "Catat potong tagihan: isi nomor faktur toko yang dipotong dan tanggal potongnya." };
const potongTagihan = (isi: Isi) => isi.caraBayar === "Potong Tagihan";

const KUNCI_TUR = "opc-tur-latihan-v1";
const jam = () => new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

/** Langkah Flow 7 tahap dari posisi latihan (sama bentuknya dengan alur pengajuan nyata). */
function alurLatihan(t: Tahap): FlowStep[] {
    if (t === -1) return [...ALUR_TAHAP.slice(0, 3).map((label) => ({ label, state: "done" as const })), { label: "Dibatalkan", state: "stop" }];
    return ALUR_TAHAP.map((label, i) => ({ label, state: i < t || t === 6 ? "done" : i === t ? "current" : "todo" }));
}

/** Tur halaman latihan (umum) + tur singkat per tahap ("Tunjukkan caranya"). */
function langkahTurLatihan(t: Tahap): LangkahTur[] {
    const perTahap: Record<number, LangkahTur[]> = {
        0: [
            { target: "lat-nama", judul: "Nama program", isi: "Tulis nama program seperti di surat. Di bawah kolom Tipe muncul saran tipe dari nama ini." },
            { target: "lat-tipe", judul: "Pilih tipe program", isi: "Tekan Pakai saran, atau Bantu saya memilih tipe untuk menjawab satu pertanyaan: uang ini dipakai untuk apa." },
            { target: "lat-beban", judul: "Beban CL atau DM", isi: "CL bila biaya ditagih balik ke principal. DM bila memakai dana principal yang sudah disimpan di distributor, jadi tidak perlu diklaim." },
            { target: "lat-bayar", judul: "Cara bayar", isi: "Transfer butuh nomor rekening. Tunai dan Potong Tagihan tidak." },
            { target: "lat-aksi", judul: "Kirim", isi: "Tombol ini aktif setelah semua isian wajib lengkap. Bila belum, alasannya tertulis di sampingnya." },
        ],
        1: [{ target: "lat-aksi", judul: "Setujui atau kembalikan", isi: "Coba Kembalikan sekali untuk melihat apa yang terjadi: pengajuan kembali ke Supervisor bersama catatan Anda." }],
        2: [{ target: "lat-kartu", judul: "Pemeriksaan berkas", isi: "Klaim memastikan berkas lengkap dan mencatat deadline klaim ke principal. Alarm keterlambatan dihitung dari deadline ini." }],
        3: [{ target: "lat-aksi", judul: "Keputusan OM", isi: "Setelah disetujui, pengajuan pindah ke Keuangan untuk dibayar." }],
        4: [{ target: "lat-kartu", judul: "Catat pembayaran", isi: "Transfer dan Tunai dicatat Keuangan. Potong Tagihan dicatat Incaso: isi nomor faktur toko yang dipotong; satu item boleh dari beberapa faktur." }],
        5: [{ target: "lat-kartu", judul: "Verifikasi final", isi: "No Claim wajib untuk item CL. Item DM tidak diklaim karena dananya sudah ada di distributor, jadi No Claim tidak wajib." }],
    };
    return [
        { judul: "Selamat datang di mode latihan", isi: "Anda akan menjalankan satu pengajuan contoh dari awal sampai selesai, memerankan semua meja secara bergantian. Tidak ada data yang tersimpan atau terkirim, jadi bebas mencoba." },
        { target: "lat-alur", judul: "Alur pengajuan", isi: "Pengajuan berjalan dari kiri ke kanan. Langkah biru adalah meja yang sedang memegang pengajuan." },
        { target: "lat-misi", judul: "Misi saat ini", isi: "Kotak ini memberi tahu peran Anda sekarang dan apa yang harus dikerjakan." },
        ...(perTahap[t] ?? []),
        { target: "lat-log", judul: "Jejak aktivitas", isi: "Setiap aksi tercatat di sini, sama seperti riwayat pengajuan di sistem nyata." },
        { target: "lat-ulang", judul: "Ulangi kapan saja", isi: "Mulai ulang untuk mencoba jalur lain, misalnya beban DM atau cara bayar Potong Tagihan." },
    ];
}

export default function Latihan() {
    const [t, setT] = useState<Tahap>(0);
    const [isi, setIsi] = useState<Isi>(AWAL);
    const [log, setLog] = useState<Array<{ jam: string; peran: string; aksi: string }>>([]);
    const [tur, setTur] = useState<"semua" | "tahap" | null>(null);
    const ubah = (u: Partial<Isi>) => setIsi((x) => ({ ...x, ...u }));
    const catat = (peran: string, aksi: string) => setLog((xs) => [{ jam: jam(), peran, aksi }, ...xs]);
    const lanjut = (ke: Tahap, peran: string, aksi: string) => { catat(peran, aksi); setT(ke); window.scrollTo({ top: 0, behavior: "smooth" }); };
    const ulang = () => { setT(0); setIsi(AWAL); setLog([]); };

    // Tur pertama kali: terbuka sendiri sekali (ditunda supaya halaman sudah tergambar; setState di dalam timer, bukan di effect).
    useEffect(() => {
        let sudah = false;
        try { sudah = Boolean(window.localStorage.getItem(KUNCI_TUR)); } catch { /* mode privat */ }
        if (sudah) return;
        const id = window.setTimeout(() => { if (!document.querySelector("dialog[open]")) setTur("semua"); }, 500);
        return () => window.clearTimeout(id);
    }, []);
    const tutupTur = () => { setTur(null); try { window.localStorage.setItem(KUNCI_TUR, "1"); } catch { /* mode privat */ } };

    const info = t === 4 && potongTagihan(isi) ? PERAN_INCASO : t >= 0 && t <= 5 ? PERAN[t as Exclude<Tahap, -1 | 6>] : null;
    return (
        <div className="fi-page">
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman">
                    <ol className="fi-crumb">
                        <li><span>Promo &amp; Klaim</span></li>
                        <li><Link href="/off-program-control">OFF Program Control</Link></li>
                        <li><span aria-current="page">Mode latihan</span></li>
                    </ol>
                </nav>
                <div className="fi-page-bar">
                    <h1>Mode latihan</h1>
                    <span className="fi-spacer" />
                    <Button icon={<Compass className="fi-icon" aria-hidden />} onClick={() => setTur("semua")}>Panduan</Button>
                    <Button variant="tertiary" icon={<RotateCcw className="fi-icon" aria-hidden />} onClick={ulang} data-tur="lat-ulang">Mulai ulang</Button>
                    <Link href="/off-program-control" className="fi-btn fi-btn--tertiary"><ArrowLeft className="fi-icon" aria-hidden /> Kembali ke OPC</Link>
                </div>
                <p>Latihan ini berjalan di browser Anda saja. Tidak ada pengajuan yang dibuat, tidak ada data yang tersimpan, dan tidak ada yang terkirim ke siapa pun.</p>
            </header>

            <div className="fi-panel" data-tur="lat-alur"><Flow steps={alurLatihan(t)} label="Tahap pengajuan latihan" /></div>

            {info && (
                <div className="fi-panel" data-tur="lat-misi">
                    <div className="fi-btnrow">
                        <StatusBadge tone="info">Misi {t + 1} dari 6</StatusBadge>
                        <b>Peran Anda sekarang: {info.peran}</b>
                        <span style={{ flex: 1 }} />
                        <Button variant="tertiary" icon={<Compass className="fi-icon" aria-hidden />} onClick={() => setTur("tahap")}>Tunjukkan caranya</Button>
                    </div>
                    <p className="fi-small">{info.misi}</p>
                </div>
            )}

            <div data-tur="lat-kartu">
                {t === 0 && <TahapSpv isi={isi} ubah={ubah} kirim={() => { lanjut(1, "Supervisor", `Kirim ke Sales Manager (${labelTipe(isi.tipe)}, beban ${isi.beban}, ${isi.caraBayar})`); ubah({ catatanKembali: "" }); }} />}
                {t === 1 && <TahapSm isi={isi} ubah={ubah}
                    setuju={() => lanjut(2, "Sales Manager", "Setujui")}
                    kembali={() => lanjut(0, "Sales Manager", `Kembalikan ke Supervisor: ${isi.catatanKembali.trim()}`)} />}
                {t === 2 && <TahapKlaim isi={isi} ubah={ubah} setuju={() => lanjut(3, "Klaim", `Setujui klaim, deadline ${isi.deadline}`)} />}
                {t === 3 && <TahapOm isi={isi} setuju={() => lanjut(4, "Operational Manager", "Setujui")} batal={() => lanjut(-1, "Operational Manager", "Batalkan")} />}
                {t === 4 && <TahapKeuangan isi={isi} ubah={ubah} bayar={() => lanjut(5, potongTagihan(isi) ? "Incaso" : "Keuangan", potongTagihan(isi)
                    ? `Catat potong tagihan faktur ${isi.noFaktur.trim()} tanggal ${isi.tglBayar}` : `Catat pembayaran ${isi.caraBayar} tanggal ${isi.tglBayar}`)} />}
                {t === 5 && <TahapFinal isi={isi} ubah={ubah} selesai={() => lanjut(6, "Klaim", isi.beban === "DM" ? "Selesaikan (DM, tanpa No Claim)" : `Selesaikan dengan No Claim ${isi.noClaim.trim()}`)} />}
                {t === 6 && <Akhir judul="Selamat, latihan selesai!" ikon ulang={ulang}>
                    Anda sudah menjalankan satu pengajuan dari Supervisor sampai verifikasi final. Di sistem nyata, setiap langkah ini dikerjakan orang
                    yang berbeda dan pengajuan baru selesai setelah No Claim tercatat.{isi.beban === "DM" ? " Karena bebannya DM, pengajuan ini tidak ditagih ke principal." : ""}
                </Akhir>}
                {t === -1 && <Akhir judul="Pengajuan dibatalkan" ulang={ulang}>
                    Operational Manager membatalkan pengajuan. Di sistem nyata alasannya wajib ditulis dan pengajuan berhenti di sini. Mulai ulang untuk mencoba jalur sampai selesai.
                </Akhir>}
            </div>

            <Section title="Jejak aktivitas" subtitle="dicatat seperti riwayat pengajuan">
                <div className="fi-sect-in" data-tur="lat-log">
                    {log.length === 0 ? <p className="fi-small fi-subtle">Belum ada aksi. Mulai dari misi Supervisor di atas.</p> : (
                        <ol style={{ margin: 0, paddingLeft: "1.2em", display: "grid", gap: 4 }}>
                            {log.map((x, i) => <li key={i} className="fi-small"><span className="fi-mono">{x.jam}</span> · <b>{x.peran}</b> · {x.aksi}</li>)}
                        </ol>
                    )}
                </div>
            </Section>

            {tur && <Tur langkah={tur === "semua" ? langkahTurLatihan(t) : langkahTurLatihan(t).filter((l) => l.target && !["lat-alur", "lat-log", "lat-ulang"].includes(l.target))}
                onTutup={tutupTur} label="Panduan latihan" />}
        </div>
    );
}

type PropsTahap = { isi: Isi; ubah: (u: Partial<Isi>) => void };

/** Kartu satu tahap: judul, isi, dan baris aksi (alasan nonaktif tertulis, sama dengan FooterToolbar halaman nyata). */
function Kartu({ judul, children, aksi, alasan }: { judul: string; children: ReactNode; aksi: ReactNode; alasan?: string }) {
    return (
        <Section title={judul}>
            <div className="fi-sect-in" style={{ display: "grid", gap: 12 }}>
                {children}
                <div className="fi-btnrow" data-tur="lat-aksi">
                    {alasan && <span className="fi-small fi-why">{alasan}</span>}
                    <span style={{ flex: 1 }} />
                    {aksi}
                </div>
            </div>
        </Section>
    );
}

function TahapSpv({ isi, ubah, kirim }: PropsTahap & { kirim: () => void }) {
    const transfer = isi.caraBayar === "Transfer";
    const alasan = !isi.tipe ? "Pilih tipe program dulu."
        : isi.tipe === TIPE_LAINNYA && !isi.alasan.trim() ? "Tulis alasan tipe Lainnya dulu."
        : transfer && !isi.rekening.trim() ? "Isi nomor rekening untuk Transfer."
        : !Number(isi.nominal) ? "Isi nominal dulu." : undefined;
    return (
        <Kartu judul="Pengajuan baru · PRINCIPLE A" alasan={alasan}
            aksi={<Button variant="primary" disabled={Boolean(alasan)} disabledReason={alasan} onClick={kirim}>Kirim ke Sales Manager</Button>}>
            {isi.catatanKembali && <MessageStrip tone="neg" title="Dikembalikan Sales Manager:">{isi.catatanKembali} Perbaiki lalu kirim ulang.</MessageStrip>}
            <div className="fi-formgrid">
                <FormField label="No Surat" help={BANTUAN_KOLOM.noSurat}>{(a) => <input {...a} className="fi-input fi-mono" value={isi.noSurat} onChange={(e) => ubah({ noSurat: e.target.value })} />}</FormField>
                <FormField label="Nama program" help={BANTUAN_KOLOM.namaProgram}>{(a) => <input {...a} className="fi-input" value={isi.namaProgram} onChange={(e) => ubah({ namaProgram: e.target.value })} data-tur="lat-nama" />}</FormField>
                <FormField label="Toko" help={BANTUAN_KOLOM.toko}>{(a) => <input {...a} className="fi-input" value={isi.toko} onChange={(e) => ubah({ toko: e.target.value })} />}</FormField>
                <FormField label="Nominal" required help={BANTUAN_KOLOM.nominal}>{(a) => <input {...a} className="fi-input fi-tnum" inputMode="numeric" value={isi.nominal} onChange={(e) => ubah({ nominal: e.target.value.replace(/\D/g, "") })} />}</FormField>
                <FormField label="Cara bayar" help={BANTUAN_KOLOM.caraBayar}>{(a) => (
                    <select {...a} className="fi-input" value={isi.caraBayar} data-tur="lat-bayar"
                        onChange={(e) => ubah({ caraBayar: e.target.value, rekening: e.target.value === "Transfer" ? isi.rekening : "" })}>
                        {offPaymentMethods.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                )}</FormField>
                <FormField label="No rekening" required={transfer} help={transfer ? BANTUAN_KOLOM.noRekening : `Tidak dipakai untuk ${isi.caraBayar}.`}>{(a) => (
                    <input {...a} className="fi-input fi-mono" readOnly={!transfer} placeholder={transfer ? "Contoh: 1234567890 · BANK A · TOKO A" : "-"} value={isi.rekening} onChange={(e) => ubah({ rekening: e.target.value })} />
                )}</FormField>
                <FormField label="Beban" help={BANTUAN_KOLOM.beban}>{(a) => (
                    <select {...a} className="fi-input" value={isi.beban} onChange={(e) => ubah({ beban: e.target.value })} data-tur="lat-beban">
                        {Object.entries(OFF_BEBAN).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                )}</FormField>
            </div>
            <div className="fi-formgrid" data-tur="lat-tipe">
                <FormField label="Tipe program" required>{(a) => (
                    <select {...a} className="fi-input" value={isi.tipe} onChange={(e) => ubah({ tipe: e.target.value })}>
                        <option value="">Pilih tipe…</option>
                        {OFF_PROGRAM_TYPES.map((x) => <option key={x} value={x}>{INFO_TIPE[x].label}</option>)}
                    </select>
                )}</FormField>
                {isi.tipe === TIPE_LAINNYA && (
                    <FormField label="Alasan tipe Lainnya" required help={BANTUAN_KOLOM.typeNote}>{(a) => <input {...a} className="fi-input" value={isi.alasan} onChange={(e) => ubah({ alasan: e.target.value })} />}</FormField>
                )}
            </div>
            <BantuanTipe tipe={isi.tipe} namaProgram={isi.namaProgram} onPilih={(x) => ubah({ tipe: x })} />
            <fieldset className="fi-field" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                <legend className="fi-label">Kelengkapan awal</legend>
                <div className="fi-btnrow">
                    <label className="fi-check"><input type="checkbox" checked={isi.kwt} onChange={(e) => ubah({ kwt: e.target.checked })} />KWT</label>
                    <label className="fi-check"><input type="checkbox" checked={isi.skp} onChange={(e) => ubah({ skp: e.target.checked })} />SKP</label>
                    <label className="fi-check"><input type="checkbox" checked={isi.foto} onChange={(e) => ubah({ foto: e.target.checked })} />Foto</label>
                </div>
                <p className="fi-help">{BANTUAN_KOLOM.kelengkapan}</p>
            </fieldset>
        </Kartu>
    );
}

/** Ringkasan pengajuan latihan yang dibaca meja berikutnya. */
function Ringkas({ isi }: { isi: Isi }) {
    return (
        <KeyValues align="start" items={[
            ["No Surat", isi.noSurat], ["Program", isi.namaProgram], ["Tipe", isi.tipe === TIPE_LAINNYA ? `Lainnya: ${isi.alasan}` : labelTipe(isi.tipe)],
            ["Toko", isi.toko], ["Nominal", rupiah(Number(isi.nominal || 0))], ["Cara bayar", isi.caraBayar],
            ["Beban", OFF_BEBAN[isi.beban === "DM" ? "DM" : "CL"].label],
            ["Kelengkapan awal", [isi.kwt && "KWT", isi.skp && "SKP", isi.foto && "Foto"].filter(Boolean).join(", ") || "Belum ada"],
        ]} />
    );
}

function TahapSm({ isi, ubah, setuju, kembali }: PropsTahap & { setuju: () => void; kembali: () => void }) {
    return (
        <Kartu judul="Tinjauan Sales Manager"
            aksi={<>
                <Button variant="negative" disabled={!isi.catatanKembali.trim()} disabledReason="Tulis catatan untuk Supervisor dulu." onClick={kembali}>Kembalikan</Button>
                <Button variant="primary" onClick={() => { ubah({ catatanKembali: "" }); setuju(); }}>Setujui</Button>
            </>}>
            <Ringkas isi={isi} />
            <FormField label="Catatan untuk Supervisor" help="Wajib bila dikembalikan. Contoh: lampirkan foto display.">{(a) => (
                <textarea {...a} className="fi-input" rows={2} value={isi.catatanKembali} onChange={(e) => ubah({ catatanKembali: e.target.value })} />
            )}</FormField>
        </Kartu>
    );
}

function TahapKlaim({ isi, ubah, setuju }: PropsTahap & { setuju: () => void }) {
    const alasan = !isi.berkasLengkap ? "Centang Berkas lengkap dulu." : !isi.tglAju || !isi.deadline ? "Isi tanggal pengajuan klaim dan deadline." : undefined;
    return (
        <Kartu judul="Validasi Klaim" alasan={alasan} aksi={<Button variant="primary" disabled={Boolean(alasan)} disabledReason={alasan} onClick={setuju}>Setujui klaim</Button>}>
            <Ringkas isi={isi} />
            <label className="fi-check"><input type="checkbox" checked={isi.berkasLengkap} onChange={(e) => ubah({ berkasLengkap: e.target.checked })} />Berkas lengkap</label>
            <div className="fi-formgrid">
                <FormField label="Tanggal diajukan ke principal" required help="Tanggal berkas klaim dikirim ke principal.">{(a) => <input {...a} className="fi-input" type="date" value={isi.tglAju} onChange={(e) => ubah({ tglAju: e.target.value })} />}</FormField>
                <FormField label="Deadline klaim" required help={BANTUAN_KOLOM.deadline}>{(a) => <input {...a} className="fi-input" type="date" value={isi.deadline} onChange={(e) => ubah({ deadline: e.target.value })} />}</FormField>
            </div>
        </Kartu>
    );
}

function TahapOm({ isi, setuju, batal }: { isi: Isi; setuju: () => void; batal: () => void }) {
    return (
        <Kartu judul="Persetujuan Operational Manager"
            aksi={<><Button variant="negative" onClick={batal}>Batalkan</Button><Button variant="primary" onClick={setuju}>Setujui</Button></>}>
            <Ringkas isi={isi} />
            <p className="fi-small fi-subtle">Deadline klaim {isi.deadline || "-"}. Setelah disetujui, Keuangan membayar paling lambat 7 hari kerja sesudah deadline.</p>
        </Kartu>
    );
}

function TahapKeuangan({ isi, ubah, bayar }: PropsTahap & { bayar: () => void }) {
    const potong = potongTagihan(isi);
    const alasan = potong && !isi.noFaktur.trim() ? "Isi nomor faktur dulu." : !isi.tglBayar ? (potong ? "Isi tanggal potong dulu." : "Isi tanggal bayar dulu.") : undefined;
    return (
        <Kartu judul={potong ? "Potong Tagihan oleh Incaso" : "Pembayaran Keuangan"} alasan={alasan}
            aksi={<Button variant="primary" disabled={Boolean(alasan)} disabledReason={alasan} onClick={bayar}>{potong ? "Catat potong tagihan" : "Catat pembayaran"}</Button>}>
            <KeyValues items={[["Toko", isi.toko], ["Cara bayar", isi.caraBayar], ["Nominal", rupiah(Number(isi.nominal || 0))], ...(isi.rekening ? [["Rekening tujuan", isi.rekening] as [string, string]] : [])]} />
            {potong && <MessageStrip tone="info" title="Potong Tagihan:">uang tidak keluar; nilainya dipotongkan dari tagihan toko. Di sistem nyata, faktur dicek: harus milik toko yang sama dan sisa tagihannya cukup.</MessageStrip>}
            {potong && <FormField label="No faktur yang dipotong" required help="Faktur penjualan toko ini. Di sistem nyata, satu item boleh dipotong dari beberapa faktur.">{(a) => <input {...a} className="fi-input fi-mono" placeholder="mis. INV/2026/0001" value={isi.noFaktur} onChange={(e) => ubah({ noFaktur: e.target.value })} />}</FormField>}
            <FormField label={potong ? "Tanggal potong" : "Tanggal bayar"} required help={potong ? "Tanggal tagihan toko dipotong." : "Tanggal uang keluar."}>{(a) => <input {...a} className="fi-input" type="date" value={isi.tglBayar} onChange={(e) => ubah({ tglBayar: e.target.value })} />}</FormField>
        </Kartu>
    );
}

function TahapFinal({ isi, ubah, selesai }: PropsTahap & { selesai: () => void }) {
    const dm = isi.beban === "DM";
    const alasan = !dm && !isi.noClaim.trim() ? "Isi No Claim dulu." : !isi.ceklisFinal ? "Centang kelengkapan final dulu." : undefined;
    return (
        <Kartu judul="Verifikasi final Klaim" alasan={alasan} aksi={<Button variant="primary" disabled={Boolean(alasan)} disabledReason={alasan} onClick={selesai}>Selesaikan</Button>}>
            <KeyValues items={[["Dibayar Keuangan", rupiah(Number(isi.nominal || 0))], ["Tanggal bayar", isi.tglBayar], ["Beban", OFF_BEBAN[dm ? "DM" : "CL"].label]]} />
            <div className="fi-formgrid">
                <FormField label="No Claim" required={!dm} help={dm ? "DM: dananya sudah ada di distributor, tidak diklaim; No Claim tidak wajib." : "Nomor klaim dari Claim Workflow. Contoh: CLM/001/PRINCIPLE A/XI/2026."}>{(a) => (
                    <input {...a} className="fi-input fi-mono" value={isi.noClaim} placeholder={dm ? "Tidak wajib" : "Isi No Claim"} onChange={(e) => ubah({ noClaim: e.target.value })} />
                )}</FormField>
            </div>
            <label className="fi-check"><input type="checkbox" checked={isi.ceklisFinal} onChange={(e) => ubah({ ceklisFinal: e.target.checked })} />Kelengkapan final sudah diperiksa</label>
        </Kartu>
    );
}

function Akhir({ judul, ikon, ulang, children }: { judul: string; ikon?: boolean; ulang: () => void; children: ReactNode }) {
    return (
        <Section title={judul}>
            <div className="fi-sect-in" style={{ display: "grid", gap: 12 }}>
                {ikon && <PartyPopper className="fi-icon" aria-hidden style={{ width: 32, height: 32, color: "var(--pos)" }} />}
                <p>{children}</p>
                <div className="fi-btnrow">
                    <Button icon={<RotateCcw className="fi-icon" aria-hidden />} onClick={ulang}>Ulangi latihan</Button>
                    <Link href="/off-program-control" className="fi-btn fi-btn--primary">Ke OFF Program Control</Link>
                </div>
            </div>
        </Section>
    );
}
