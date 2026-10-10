/*
 * Tujuan: Object Page "Format SPPD Bank Panin" (Fiori S6a, it08): nomor berikutnya, setelan surat (validasi di layar: nomor tidak turun
 *   dalam setahun D-05, jatuh tempo 1–24, transfer per halaman 1–20, templat bernomor urut), data rekening principal (laporan cocok,
 *   Samakan nama), dan operasi data yang selalu Pratinjau → Terapkan (Excel data SPPD, ganti nama, Auto-Fix, Restore backup).
 *   Pengganti payments/sppd/page.tsx lama (toast, Replace All langsung menulis, Simpan dari nilai bawaan saat gagal muat).
 * Caller: app/(dashboard)/payments/sppd/page.tsx (prop permKeys).
 * Dependensi: ./bersama (baca, tulis, RangkaPembayaran, unduhUrl), ./FormatSppdDialog, components/fiori/*, lib/payments-ui.
 * Main Functions: FormatSppd (default), simpan.
 * Side Effects: GET /payments/sppd/settings, /api/bank-data, /api/bank-data/match-report (sppd.view); POST /payments/sppd/settings
 *   (sppd.edit_settings, CSRF). Dialog operasi data: lihat FormatSppdDialog.
 *
 * AM-019: urutan hanya boleh diubah oleh halaman yang MELIHAT nilai sekarang — Simpan dikunci saat setelan gagal/sedang dimuat, dan
 * `expected_last_sequence` = nilai yang dimuat. Nomor terakhir HANYA dikirim bila diubah (dulu seluruh objek setelan selalu dikirim).
 * D-05/C10: nomor tidak pernah turun dalam satu tahun terbit; layar menolak lebih dulu, server menolak 409 (dialog "turunkan nomor"
 * it08 diganti validasi).
 */
"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Database, Download, History, PencilLine, RefreshCw, RotateCcw, Upload, Wand2 } from "lucide-react";
import {
    AnchorBar, Button, EmptyState, ErrorState, FooterToolbar, KeyValues, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, VariantNote,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard } from "@/components/fiori/interactive";
import { galatTemplat, hariIniWita, izinPembayaran, namaAkun, pratinjauNomor, tanggalTampil } from "@/lib/payments-ui";
import { RangkaPembayaran, baca, tulis, unduhUrl } from "./bersama";
import { DialogAutoFix, DialogExcel, DialogGantiNama, DialogRestore } from "./FormatSppdDialog";

type Setelan = { last_sequence: number; sequence_year?: number | null; number_template: string; fixed_jaminan_date: string; maturity_months: number; items_per_page: number; updated_by?: string };
type DataSetelan = { settings: Setelan; efektif: number; preview: string };
type BarisRekening = { principle: string; bank: string; rekening: string; penerima: string; has_rekening: boolean };
type Laporan = { matched: Array<{ web_name: string; excel_name: string }>; unmatched: string[]; ambiguous: string[]; empty_rekening: Array<{ principle: string; reason: string }> };
type Kunci = "nomor" | "template" | "jaminan" | "jatuhTempo" | "perHalaman";

const LABEL: Record<Kunci, string> = { nomor: "Nomor surat terakhir", template: "Format nomor", jaminan: "Tanggal jaminan", jatuhTempo: "Jatuh tempo bank (bulan)", perHalaman: "Transfer per halaman" };
const bulat = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
/** Lompatan nomor sebesar ini wajib diketik ulang: nomor tidak bisa diturunkan lagi tahun ini (D-05), jadi salah ketik 310 untuk 31 permanen. */
const LOMPAT_KETIK_ULANG = 50;
const KUNCI_OP = "Hasil operasi terakhir belum pasti; tunggu data dimuat ulang sebelum mengulang atau menyimpan.";

export default function FormatSppd({ permKeys }: { permKeys: string[] }) {
    const izin = izinPembayaran(permKeys);
    const [set, muatSet] = useLoad(useCallback(() => baca("/payments/sppd/settings", (d): DataSetelan | undefined => (!d.settings || typeof d.settings !== "object" ? undefined : {
        settings: d.settings as Setelan, efektif: Number(d.effective_last_sequence ?? (d.settings as Setelan | undefined)?.last_sequence ?? 0), preview: String(d.preview_number ?? ""),
    })), []));
    const [bank, muatBank] = useLoad(useCallback(() => baca("/api/bank-data", (d) => (Array.isArray(d.items) ? (d.items as BarisRekening[]) : undefined)), []));
    const [lap, muatLap] = useLoad(useCallback(() => baca("/api/bank-data/match-report", (d) => (d.report && typeof d.report === "object" ? d.report as Laporan : undefined)), []));
    const s = set.data ?? undefined;
    const tahun = hariIniWita().slice(0, 4);

    const awal: Record<Kunci, string> | null = s ? {
        nomor: String(s.efektif), template: s.settings.number_template, jaminan: s.settings.fixed_jaminan_date,
        jatuhTempo: String(s.settings.maturity_months), perHalaman: String(s.settings.items_per_page),
    } : null;
    const [ubah, setUbah] = useState<Partial<Record<Kunci, string>>>({});
    const nilai = (k: Kunci) => ubah[k] ?? awal?.[k] ?? "";
    const berubah = (Object.keys(ubah) as Kunci[]).filter((k) => awal && ubah[k] !== awal[k]);
    useUnsavedGuard(berubah.length > 0);
    const isi = (k: Kunci) => (v: string) => setUbah((p) => { const n = { ...p, [k]: v }; if (awal && v === awal[k]) delete n[k]; return n; });

    const galat: Partial<Record<Kunci, string>> = {};
    if (s) {
        const no = bulat(nilai("nomor"));
        if (Number.isNaN(no)) galat.nomor = "Nomor surat terakhir harus bilangan bulat.";
        else if (no < s.efektif) galat.nomor = `Nomor urut SPPD tidak boleh turun di dalam satu tahun: nomor terakhir ${tahun} adalah ${String(s.efektif).padStart(3, "0")}. Nomor yang sudah terbit tidak boleh terbit ulang (D-05).`;
        galat.template = galatTemplat(nilai("template"));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nilai("jaminan"))) galat.jaminan = "Isi tanggal jaminan yang valid.";
        const jt = bulat(nilai("jatuhTempo"));
        if (!(jt >= 1 && jt <= 24)) galat.jatuhTempo = "Jatuh tempo bank 1–24 bulan.";
        const ph = bulat(nilai("perHalaman"));
        if (!(ph >= 1 && ph <= 20)) galat.perHalaman = "Transfer per halaman 1–20.";
    }
    const adaGalat = (Object.values(galat) as Array<string | undefined>).some(Boolean);
    const nomorBaru = bulat(nilai("nomor"));
    const pratinjau = s && !galat.nomor && !galat.template
        ? (berubah.includes("nomor") || berubah.includes("template") ? pratinjauNomor(nilai("template"), nomorBaru + 1, hariIniWita()) : s.preview) : "";

    // Jawaban tidak pasti: Simpan dikunci sampai setelan terbaca ulang (referensi data berganti).
    const [kunciPada, setKunciPada] = useState<DataSetelan | null | undefined>(undefined);
    const masihTerkunci = kunciPada !== undefined && kunciPada === set.data;
    // Operasi data yang jawabannya tidak pasti: SEMUA tulis di halaman dikunci (bukan hanya dialognya, yang bisa ditutup) sampai data
    // yang mungkin berubah terbaca ulang — referensi data berganti. Galat memuat ulang mempertahankan referensi lama = tetap terkunci.
    const [kunciOp, setKunciOp] = useState<{ lap: Laporan | null | undefined; set?: DataSetelan | null } | null>(null);
    const opTerkunci = kunciOp !== null && (kunciOp.lap === lap.data || ("set" in kunciOp && kunciOp.set === set.data));
    const [pesan, setPesan] = useState<{ tone: "pos" | "warn"; judul: string; isi?: string } | null>(null);
    const [dialog, setDialog] = useState<null | "simpan" | "excel" | "ganti" | "autofix" | "restore">(null);
    const [namaLama, setNamaLama] = useState("");
    const [ketikUlang, setKetikUlang] = useState("");
    const lompat = s && berubah.includes("nomor") && !Number.isNaN(nomorBaru) ? nomorBaru - s.efektif : 0;
    const perluKetik = lompat > LOMPAT_KETIK_ULANG;
    const alasanKetik = perluKetik && ketikUlang.trim() !== String(nomorBaru) ? `Nomor ketikan ulang belum sama dengan ${nomorBaru}.` : undefined;

    const kunciMuat = set.status === "galat" ? "Setelan SPPD belum berhasil dimuat — muat ulang dulu agar urutan nomor tidak mundur."
        : set.status === "memuat" ? "Setelan sedang dimuat." : masihTerkunci ? "Hasil simpan terakhir belum pasti; tunggu setelan dimuat ulang."
            : opTerkunci ? KUNCI_OP : undefined;
    const alasanSimpan = izin.setelan ?? kunciMuat ?? (berubah.length === 0 ? "Belum ada perubahan." : adaGalat ? "Perbaiki isian yang ditandai dulu." : undefined);
    const bisaIsi = Boolean(s) && !izin.setelan && set.status === "siap";

    async function simpan() {
        if (!s) return;
        const body: Record<string, unknown> = {
            number_template: nilai("template").trim(), fixed_jaminan_date: nilai("jaminan"),
            maturity_months: bulat(nilai("jatuhTempo")), items_per_page: bulat(nilai("perHalaman")),
        };
        if (berubah.includes("nomor")) { body.last_sequence = nomorBaru; body.expected_last_sequence = s.settings.last_sequence; }
        const res = await tulis("/payments/sppd/settings", body);
        if (res.ok) {
            // Nomor sesudah simpan = urutan BERLAKU dari jawaban POST, bukan isian: tahun baru, isian sama dengan urutan tersimpan tahun
            // lalu (mis. 46) tidak diubah server — effective tetap 0, jadi "0 → 46" akan bohong.
            const efPost = Number(res.data.effective_last_sequence);
            const nomorBeda = berubah.includes("nomor") && efPost !== nomorBaru;
            const riwayat = berubah.map((k) => `${LABEL[k]} ${awal?.[k]} → ${k === "nomor" ? (Number.isFinite(efPost) ? efPost : "tidak terbaca") : nilai(k)}`).join("; ");
            setUbah({});
            setDialog(null);
            setPesan({
                tone: nomorBeda ? "warn" : "pos", judul: nomorBeda ? "Format SPPD tersimpan, tetapi nomor surat terakhir tidak seperti yang diisi." : "Format SPPD tersimpan.",
                isi: `${riwayat}.${nomorBeda ? ` Server mencatat nomor terakhir ${tahun} = ${Number.isFinite(efPost) ? String(efPost).padStart(3, "0") : "(tidak terbaca)"}, bukan ${String(nomorBaru).padStart(3, "0")}. Periksa nilainya sebelum mengajukan SPPD.` : ""} Nomor berikutnya ${String(res.data.preview_number ?? "")}.`,
            });
            muatSet();
            return;
        }
        if (res.tidakPasti) { setKunciPada(set.data); muatSet(); }
        else if (res.status === 409) muatSet(); // halaman basi / nomor turun: nilai sekarang dimuat ulang, isian tetap.
        throw new Error(res.status === 409 ? `${res.error} Setelan dimuat ulang; periksa nilainya lalu simpan lagi.` : res.error);
    }

    const setelahOperasi = (p: { judul: string; isi?: string; nomor?: boolean }) => {
        setDialog(null);
        setPesan({ tone: "pos", judul: p.judul, isi: p.isi });
        muatLap(); if (p.nomor) muatSet();
    };
    const tidakPasti = (nomor?: boolean) => {
        setKunciOp(nomor ? { lap: lap.data, set: set.data } : { lap: lap.data });
        setPesan({ tone: "warn", judul: "Hasil operasi belum pasti.", isi: "Data dimuat ulang — periksa hasilnya sebelum mengulang. Operasi data dan Simpan dikunci sampai data terbaca ulang." });
        muatLap(); if (nomor) muatSet();
    };

    const namaWeb = useMemo(() => [...new Set([...(lap.data?.matched ?? []).map((m) => m.web_name), ...(lap.data?.unmatched ?? []), ...(lap.data?.ambiguous ?? [])])].sort(), [lap.data]);
    const namaMaster = useMemo(() => [...new Set((bank.data ?? []).map((b) => b.principle))].sort(), [bank.data]);
    const [lihatDaftar, setLihatDaftar] = useState(false);

    const bidang = (k: Kunci, extra: { type?: string; help?: string; mono?: boolean }) => (
        <FormField label={LABEL[k]} required error={galat[k]} help={extra.help}>
            {(a) => <input {...a} className={`fi-input${extra.mono ? " fi-mono" : ""}${extra.type ? "" : " fi-tnum"}`} type={extra.type ?? "text"} inputMode={extra.type ? undefined : "numeric"}
                readOnly={!bisaIsi} aria-readonly={!bisaIsi || undefined} value={nilai(k)} onChange={(e) => isi(k)(e.target.value)} />}
        </FormField>
    );

    let setelan: ReactNode;
    if (set.status === "galat" && !s) setelan = <ErrorState title="Setelan SPPD gagal dimuat" message={`${set.error} Simpan dikunci agar nomor tidak mundur (AM-019); isian tidak ditampilkan karena bukan nilai tersimpan.`} onRetry={muatSet} />;
    else if (!s) setelan = <Skeleton rows={5} label="Memuat setelan" />;
    else setelan = (
        <div className={set.status === "memuat" ? "fi-sect-in fi-busy" : "fi-sect-in"}>
            {set.status === "galat" && <MessageStrip tone="neg" title="Setelan gagal dimuat ulang.">{set.error} Yang tampil hasil sebelumnya; Simpan dikunci. <Button variant="tertiary" onClick={muatSet}>Coba lagi</Button></MessageStrip>}
            <div className="fi-formgrid">
                {bidang("nomor", { help: `Nomor tertinggi yang sudah terbit tahun ${tahun}: ${String(s.efektif).padStart(3, "0")}. Hanya boleh naik; nomor di antaranya tidak akan terbit.${s.settings.sequence_year && String(s.settings.sequence_year) !== tahun ? ` Urutan ${s.settings.sequence_year} berakhir di ${s.settings.last_sequence}; tahun ini mulai 001.` : ""}` })}
                {bidang("template", { mono: true, type: "text", help: "Isian: {seq:03d} nomor urut, {roman_month} bulan Romawi, {year} tahun." })}
                {bidang("jaminan", { type: "date" })}
                {bidang("jatuhTempo", { help: "1–24" })}
                {bidang("perHalaman", { help: "1–20" })}
            </div>
            <KeyValues items={[["Pratinjau nomor berikutnya", <b key="p" className="fi-mono">{pratinjau || "—"}</b>], ["Penandatangan dan kop", "mengikuti templat DOCX Bank Panin; tidak diubah dari sini"]]} />
            {izin.setelan && <MessageStrip tone="info" title="Baca saja.">{izin.setelan}</MessageStrip>}
        </div>
    );

    let rekening: ReactNode;
    // Galat memuat ulang di atas daftar kosong tetap galat — jangan jatuh ke "belum dipasang".
    if (bank.status === "galat" && !bank.data?.length) rekening = <ErrorState title="Data rekening gagal dimuat" message={bank.error} onRetry={muatBank} />;
    else if (!bank.data) rekening = <Skeleton rows={3} label="Memuat data rekening" />;
    else if (bank.data.length === 0) rekening = <EmptyState title="Data rekening tidak ditemukan" message="Master rekening principal belum dipasang di server. Tanpa master, pengajuan rute Bank Panin selalu ditolak. Hubungi admin untuk memasang master rekening." />;
    else rekening = (
        <div className="fi-sect-in">
            {bank.status === "galat" && <MessageStrip tone="neg" title="Data rekening gagal dimuat ulang.">{bank.error} Yang tampil hasil sebelumnya. <Button variant="tertiary" onClick={muatBank}>Coba lagi</Button></MessageStrip>}
            {lap.status === "galat" && lap.data && <MessageStrip tone="neg" title="Laporan kecocokan gagal dimuat ulang.">{lap.error} Yang tampil hasil sebelumnya.</MessageStrip>}
            {lap.status === "galat" && !lap.data ? <MessageStrip tone="neg" title="Laporan kecocokan gagal dimuat.">{lap.error} <Button variant="tertiary" onClick={muatLap}>Coba lagi</Button></MessageStrip>
                : !lap.data ? <Skeleton rows={2} label="Memuat laporan kecocokan" />
                    : (
                        <>
                            <div className="fi-kcards" role="group" aria-label="Kecocokan nama principal">
                                <div className="fi-kc" style={{ cursor: "default" }}><span>Cocok</span><b>{lap.data.matched.length}</b></div>
                                <div className="fi-kc" style={{ cursor: "default" }}><span>Tidak cocok</span><b>{lap.data.unmatched.length}</b></div>
                                <div className="fi-kc" style={{ cursor: "default" }}><span>Ambigu</span><b>{lap.data.ambiguous.length}</b></div>
                                <div className="fi-kc" style={{ cursor: "default" }}><span>Rekening kosong</span><b>{lap.data.empty_rekening.length}</b></div>
                            </div>
                            {[...lap.data.unmatched.map((n) => [n, "tidak cocok dengan master"]), ...lap.data.ambiguous.map((n) => [n, "ambigu · lebih dari satu rekening cocok"])].map(([n, k]) => (
                                <div key={n} className="fi-page-bar">
                                    <span><b>{n}</b> <span className="fi-small fi-subtle">{k}</span></span><span className="fi-spacer" />
                                    <Button disabled={Boolean(izin.gantiNama) || opTerkunci} disabledReason={izin.gantiNama ?? KUNCI_OP} onClick={() => { setNamaLama(n); setDialog("ganti"); }}>Samakan nama…</Button>
                                </div>
                            ))}
                            {lap.data.empty_rekening.map((e) => <p key={e.principle} className="fi-small fi-why">{e.principle}: {e.reason}</p>)}
                        </>
                    )}
            <div><Button variant="tertiary" onClick={() => setLihatDaftar((v) => !v)} aria-expanded={lihatDaftar}>{lihatDaftar ? "Tutup daftar rekening" : `Lihat daftar rekening (${bank.data.length})`}</Button></div>
            {lihatDaftar && (
                <ResponsiveTable<BarisRekening> title="Daftar rekening" columns={[
                    { key: "p", header: "Principal", cell: (r) => r.principle },
                    { key: "b", header: "Bank", cell: (r) => r.bank || "—" },
                    { key: "r", header: "No. rekening", cell: (r) => <span className="fi-mono">{r.rekening || "(kosong)"}</span> },
                    { key: "n", header: "Penerima", secondary: true, cell: (r) => r.penerima || "—" },
                ]} rows={bank.data} rowKey={(r) => `${r.principle}|${r.rekening}`} empty={{ title: "Kosong" }}
                    mobileItem={(r) => <ListItem doc={r.principle} title={`${r.bank} · ${r.rekening || "(kosong)"}`} meta={r.penerima} />} />
            )}
        </div>
    );

    const operasi: Array<{ k: "excel" | "ganti" | "autofix" | "restore"; label: string; ikon: ReactNode; alasan?: string }> = [
        { k: "excel", label: "Unggah Excel data SPPD…", ikon: <Upload className="fi-icon" aria-hidden />, alasan: izin.excelSppd },
        { k: "ganti", label: "Ganti nama principal…", ikon: <PencilLine className="fi-icon" aria-hidden />, alasan: izin.gantiNama },
        { k: "autofix", label: "Auto-Fix nama principal…", ikon: <Wand2 className="fi-icon" aria-hidden />, alasan: izin.lihat },
        { k: "restore", label: "Restore backup…", ikon: <RotateCcw className="fi-icon" aria-hidden />, alasan: izin.restore },
    ];

    return (
        <RangkaPembayaran halaman="format" judul="Format SPPD Bank Panin" permKeys={permKeys}
            deskripsi="Nomor dan setelan Surat Perintah Penarikan Dana (SPPD) Bank Panin, data rekening principal, dan operasi data yang selalu dipratinjau dulu."
            aksi={<>
                {berubah.length > 0 && <span className="fi-draft">Draf belum disimpan</span>}
                <Button variant="icon" aria-label="Muat ulang" icon={<RefreshCw className="fi-icon" aria-hidden />} busy={set.status === "memuat" && Boolean(s)} onClick={() => { muatSet(); muatBank(); muatLap(); }} />
            </>}>
            <dl className="fi-attrs">
                <div><dt>Nomor berikutnya</dt><dd className="fi-mono">{s ? (pratinjau || "—") : "—"}</dd></div>
                <div><dt>Terakhir diubah oleh</dt><dd>{s?.settings.updated_by ? namaAkun(s.settings.updated_by) : "—"}</dd></div>
            </dl>
            <AnchorBar anchors={[{ id: "nomor", label: "Nomor & surat" }, { id: "rekening", label: "Data rekening" }, { id: "operasi", label: "Operasi data" }, { id: "riwayat", label: "Riwayat" }]} />
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.judul} onClose={() => setPesan(null)}>{pesan.isi}</MessageStrip>}

            <Section id="nomor" title="Nomor & surat">{setelan}</Section>
            <Section id="rekening" title="Data rekening principal" subtitle="master Excel “Data No Rekening Principle”" actions={<Database className="fi-icon" aria-hidden />}>{rekening}</Section>
            <Section id="operasi" title="Operasi data" subtitle="selalu Pratinjau → Terapkan">
                <div className="fi-sect-in">
                    <div className="fi-btnrow">
                        {operasi.map((o) => <Button key={o.k} icon={o.ikon} disabled={Boolean(o.alasan) || opTerkunci} disabledReason={o.alasan ?? KUNCI_OP} onClick={() => { setNamaLama(""); setDialog(o.k); }}>{o.label}</Button>)}
                        <a className="fi-btn fi-btn--tertiary" href={unduhUrl("/payments/export")} target="_blank" rel="noopener noreferrer"><Download className="fi-icon" aria-hidden />Unduh backup</a>
                    </div>
                    {operasi.filter((o) => o.alasan).map((o) => <p key={o.k} className="fi-small fi-subtle">{o.label.replace("…", "")}: {o.alasan}</p>)}
                    {opTerkunci && <p className="fi-small fi-why">{KUNCI_OP}</p>}
                    <p className="fi-small fi-subtle">Rekaman yang sudah diajukan, ditransfer, atau terposting tidak ikut diubah (BL-05/BL-49). Restore backup hanya menambah rekaman dan menaikkan nomor SPPD bila perlu — nomor tidak pernah turun.</p>
                </div>
            </Section>
            <Section id="riwayat" title="Riwayat" subtitle="nilai lama → baru (BL-33)" actions={<History className="fi-icon" aria-hidden />}>
                <div className="fi-sect-in">
                    <VariantNote bl="BL-33">Riwayat setelan belum disimpan server (hanya catatan audit internal). Setelah simpan, layar ini menampilkan nilai lama → baru
                        sekali di pesan sukses; bila BL-33 masuk, daftar riwayat dengan nomor lama dan baru tampil di sini.</VariantNote>
                </div>
            </Section>

            <FooterToolbar message={alasanSimpan ? <span className="fi-why">{alasanSimpan}</span> : `${berubah.length} isian berubah: ${berubah.map((k) => LABEL[k]).join(", ")}.`}>
                {berubah.length > 0 && <Button variant="tertiary" onClick={() => setUbah({})}>Batalkan perubahan</Button>}
                <Button variant="primary" disabled={Boolean(alasanSimpan)} disabledReason={alasanSimpan} onClick={() => { setKetikUlang(""); setDialog("simpan"); }}>Simpan…</Button>
            </FooterToolbar>

            <ConfirmDialog alasanTerlihat open={dialog === "simpan"} onClose={() => setDialog(null)} title="Simpan format SPPD?" tag="Setelan" confirmLabel="Simpan" confirmDisabled={alasanSimpan ?? alasanKetik} onConfirm={simpan}
                facts={[
                    ...berubah.map((k): [string, ReactNode] => [LABEL[k], `${k === "jaminan" ? tanggalTampil(awal?.[k]) : awal?.[k]} → ${k === "jaminan" ? tanggalTampil(nilai(k)) : nilai(k)}`]),
                    ["Nomor berikutnya", <span key="n" className="fi-mono">{pratinjau || "—"}</span>],
                ]}>
                {berubah.includes("nomor") && <MessageStrip tone="warn" title={`Nomor ${String((s?.efektif ?? 0) + 1).padStart(3, "0")}–${String(nomorBaru).padStart(3, "0")} tidak akan terbit.`}>Urutan dinaikkan; nomor yang dilewati tidak bisa dipakai lagi tahun ini.</MessageStrip>}
                {perluKetik && (
                    <>
                        <MessageStrip tone="neg" title={`Nomor naik ${lompat} sekaligus (${s?.efektif} → ${nomorBaru}).`}>Nomor tidak bisa diturunkan lagi tahun ini (D-05); pastikan ini bukan salah ketik.</MessageStrip>
                        <FormField label="Ketik ulang nomor surat terakhir" required help={`Ketik ulang nomor ${nomorBaru} untuk melanjutkan.`}>
                            {(a) => <input {...a} className="fi-input fi-tnum" inputMode="numeric" autoComplete="off" value={ketikUlang} onChange={(e) => setKetikUlang(e.target.value)} />}
                        </FormField>
                    </>
                )}
            </ConfirmDialog>
            {/* Dialog operasi dipasang hanya saat dibuka: isian dan pratinjau selalu segar. */}
            {dialog === "excel" && <DialogExcel open onClose={() => setDialog(null)} kunci={izin.excelSppd}
                onSelesai={(p) => setelahOperasi(p)} onTidakPasti={() => tidakPasti()} />}
            {dialog === "ganti" && <DialogGantiNama open onClose={() => setDialog(null)} kunci={izin.gantiNama} awalLama={namaLama} namaWeb={namaWeb} namaMaster={namaMaster}
                onSelesai={(p) => setelahOperasi(p)} onTidakPasti={() => tidakPasti()} />}
            {dialog === "autofix" && <DialogAutoFix open onClose={() => setDialog(null)} izinLihat={izin.lihat} izinTerapkan={izin.gantiNama}
                onSelesai={(p) => setelahOperasi(p)} onTidakPasti={() => tidakPasti()} />}
            {dialog === "restore" && <DialogRestore open onClose={() => setDialog(null)} kunci={izin.restore}
                onSelesai={(p) => setelahOperasi({ ...p, nomor: true })} onTidakPasti={() => tidakPasti(true)} />}
        </RangkaPembayaran>
    );
}
