/*
 * Tujuan: Dialog layar Rekaman pembayaran (Fiori S6a, it08): `unggah` (pratinjau dry_run → Simpan), `manual` (CBD/NON_LPB dengan Jenis
 *   dan Nomor dokumen), `keranjang` (rute + tanggal bayar Finance WITA → cart/create), rincian rekaman (isian draf, kunci dari server),
 *   `hapus` (satu rekaman tanpa kunci). Pengganti form unggah/manual, window.confirm/prompt, dan Hapus Ceklis di page.tsx lama.
 * Caller: app/(dashboard)/payments/Rekaman.tsx.
 * Dependensi: ./bersama (tulis, unduhUrl), components/fiori/*, components/ui/Dialog, lib/payments-ui (ISIAN, nilaiAwal, galatIsian, …),
 *   lib/promo-ui (rupiah).
 * Main Functions: DialogUnggah, DialogManual, DialogKeranjang, RincianRekaman, DialogHapus.
 * Side Effects: POST /payments/upload?dry_run=1|0 (payments.edit), /payments/manual/add (payments.edit), /payments/cart/create
 *   (payments.edit), /payments/delete (payments.delete) — semua dengan CSRF lewat ./bersama.
 *
 * Jawaban tidak pasti di dialog mana pun: pesan "belum pasti", halaman memuat ulang, dan tombol konfirmasi dialog itu dikunci sampai
 * dialog ditutup — pengguna memeriksa daftar dulu sebelum mengulang (unggah/manual tidak idempoten di server).
 */
"use client";

import { useId, useState } from "react";
import { Lock, Trash2, X } from "lucide-react";
import { Button, KeyValues, MessageStrip, StatusBadge, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import Dialog from "@/components/ui/Dialog";
import {
    ISIAN, STATUS_REKAMAN, angka, besokWita, galatIsian, hariIniWita, nilaiAwal, statusRekaman, tanggalTampil, tipeRekaman,
    type Isian, type Rekaman as Baris,
} from "@/lib/payments-ui";
import { rupiah } from "@/lib/promo-ui";
import { tulis, unduhUrl } from "./bersama";

type Selesai = (p: { pesan: string }) => void;
const nama = (r: Baris) => r.no_lpb || r.record_id;
const KUNCI_PASTI = "Hasil sebelumnya belum pasti — tutup dialog dan periksa daftar dulu sebelum mengulang.";

type LaporanLpb = { rows?: number; total_nilai_win?: number; total_nilai_invoice?: number; duplicates?: string[]; duplicates_in_file?: string[]; invalid?: string[]; error?: string; can_apply?: boolean; added?: number };
type Pratinjau = { status: "memuat" } | { status: "siap"; data: LaporanLpb } | { status: "galat"; error: string };

const daftar = (xs: string[] | undefined, n = 5) => (xs?.length ? `${xs.slice(0, n).join(", ")}${xs.length > n ? ` dan ${xs.length - n} lainnya` : ""}` : "0");

/** Unggah LPB: pilih berkas → pratinjau server (`?dry_run=1`, tanpa tulis) → Simpan (`?dry_run=0`). Satu masalah = tidak ada yang ditulis. */
export function DialogUnggah({ open, onClose, izin, kunci, onSelesai, onTidakPasti }: {
    open: boolean; onClose: () => void; izin?: string; kunci?: string; onSelesai: Selesai; onTidakPasti: () => void;
}) {
    const [berkas, setBerkas] = useState<File | null>(null);
    const [pratinjau, setPratinjau] = useState<Pratinjau | null>(null);
    const [belumPasti, setBelumPasti] = useState(false);
    const [kunciInput, setKunciInput] = useState(0);
    const tutup = () => { setBerkas(null); setPratinjau(null); setBelumPasti(false); setKunciInput((k) => k + 1); onClose(); };

    async function pilih(file: File | null) {
        setBerkas(file);
        setPratinjau(null);
        if (!file) return;
        setPratinjau({ status: "memuat" });
        const fd = new FormData();
        fd.append("file", file);
        const res = await tulis("/payments/upload?dry_run=1", fd);
        if (res.ok) setPratinjau({ status: "siap", data: res.data as LaporanLpb });
        else setPratinjau({ status: "galat", error: res.tidakPasti ? "Pratinjau tidak terbaca (koneksi atau server). Pilih berkasnya lagi untuk mencoba; belum ada yang ditulis." : res.error });
    }

    const lap = pratinjau?.status === "siap" ? pratinjau.data : null;
    const alasan = izin ?? kunci ?? (belumPasti ? KUNCI_PASTI : !berkas ? "Pilih berkas LPB dulu."
        : pratinjau?.status === "memuat" ? "Pratinjau sedang dibuat."
            : !lap ? "Pratinjau gagal; berkas ini belum bisa disimpan."
                : !lap.can_apply ? "Perbaiki masalah di pratinjau dulu — satu masalah membatalkan seluruh berkas." : undefined);

    async function simpan() {
        if (!berkas) return;
        const fd = new FormData();
        fd.append("file", berkas);
        const res = await tulis("/payments/upload?dry_run=0", fd);
        if (res.ok) {
            const n = Number(res.data.added ?? 0);
            const nama = berkas.name;
            tutup();
            onSelesai({ pesan: `${n} LPB dari ${nama} tersimpan. Baris baru ditandai “Baru”: yang invoicenya lengkap ada di tile Siap diajukan, selebihnya di Draf.` });
            return;
        }
        if (res.tidakPasti) { setBelumPasti(true); onTidakPasti(); }
        else if (res.data) setPratinjau({ status: "siap", data: { ...(res.data as LaporanLpb), can_apply: false } });
        throw new Error(res.tidakPasti ? res.error : `${res.error} Tidak ada yang disimpan.`);
    }

    return (
        <ConfirmDialog open={open} onClose={tutup} title={berkas ? `Unggah ${berkas.name}?` : "Unggah LPB"} tag="Pratinjau"
            confirmLabel={lap?.rows ? `Simpan ${lap.rows} LPB` : "Simpan"} confirmDisabled={alasan} onConfirm={simpan}
            facts={lap ? [
                ["Baris", `${lap.rows ?? 0} LPB`],
                ["Total nilai WIN", rupiah(lap.total_nilai_win ?? 0)],
                ["Total nilai invoice", rupiah(lap.total_nilai_invoice ?? 0)],
                ["No. LPB sudah ada di sistem", daftar(lap.duplicates)],
                ["Ganda di berkas", daftar(lap.duplicates_in_file)],
                ["Baris tidak valid", daftar(lap.invalid, 3)],
            ] : undefined}
        >
            <FormField label="Berkas LPB (.xlsx/.xls)" required help="Pratinjau dibuat otomatis tanpa menulis apa pun. Berkas backup pembayaran tidak diunggah dari sini — pemulihan backup ada di Format SPPD.">
                {(a) => <input key={kunciInput} {...a} className="fi-input" type="file" accept=".xlsx,.xls" onChange={(e) => void pilih(e.target.files?.[0] ?? null)} />}
            </FormField>
            <p className="fi-small"><a href={unduhUrl("/payments/template")} target="_blank" rel="noopener noreferrer">Unduh templat LPB</a></p>
            {pratinjau?.status === "memuat" && <MessageStrip tone="info" title="Membuat pratinjau…" />}
            {pratinjau?.status === "galat" && <MessageStrip tone="neg" title="Pratinjau gagal.">{pratinjau.error}</MessageStrip>}
            {lap?.error && <MessageStrip tone="neg" title="Berkas ini belum bisa disimpan.">{lap.error}</MessageStrip>}
            {lap && lap.can_apply && <MessageStrip tone="pos" title="Pratinjau bersih.">Semua baris akan disimpan sebagai rekaman baru; belum ada yang ditulis.</MessageStrip>}
        </ConfirmDialog>
    );
}

/** Tambah manual CBD / NON_LPB. NON_LPB WAJIB Jenis dan Nomor dokumen (dulu isiannya tidak ada → selalu gagal, it08 #5). */
export function DialogManual({ open, onClose, izin, kunci, onSelesai, onTidakPasti }: {
    open: boolean; onClose: () => void; izin?: string; kunci?: string; onSelesai: Selesai; onTidakPasti: () => void;
}) {
    const awal = { tipe: "CBD" as "CBD" | "NON_LPB", principle: "", invoice_no: "", no_lpb: "", jenis_dokumen: "", nomor_dokumen: "", nilai: "" };
    const [f, setF] = useState(awal);
    const [belumPasti, setBelumPasti] = useState(false);
    const tutup = () => { setF(awal); setBelumPasti(false); onClose(); };
    const set = (k: keyof typeof awal) => (v: string) => setF((p) => ({ ...p, [k]: v }));
    const nilai = angka(f.nilai);
    const galatNilai = !f.nilai.trim() ? undefined : Number.isNaN(nilai) ? `“${f.nilai}” bukan angka rupiah. Contoh: 3.250.000` : nilai <= 0 ? "Nilai invoice wajib lebih dari 0." : undefined;
    const alasan = izin ?? kunci ?? (belumPasti ? KUNCI_PASTI : !f.principle.trim() ? "Isi principal dulu."
        : !f.nilai.trim() ? "Isi nilai invoice dulu." : galatNilai ?? (f.tipe === "NON_LPB" && (!f.jenis_dokumen.trim() || !f.nomor_dokumen.trim()) ? "NON_LPB wajib Jenis dokumen dan Nomor dokumen." : undefined));

    async function simpan() {
        const body = {
            tipe_pengajuan: f.tipe, no_lpb: f.tipe === "NON_LPB" ? f.no_lpb.trim() : "", principle: f.principle.trim(), invoice_no: f.invoice_no.trim(),
            nilai_invoice: nilai, jenis_dokumen: f.tipe === "NON_LPB" ? f.jenis_dokumen.trim() : "", nomor_dokumen: f.tipe === "NON_LPB" ? f.nomor_dokumen.trim() : "",
        };
        const res = await tulis("/payments/manual/add", body);
        if (res.ok) {
            const pesan = `Pengajuan ${f.tipe} ${body.principle} ${rupiah(nilai)} ditambahkan.`;
            tutup();
            onSelesai({ pesan });
            return;
        }
        if (res.tidakPasti) { setBelumPasti(true); onTidakPasti(); }
        throw new Error(res.error);
    }

    return (
        <ConfirmDialog open={open} onClose={tutup} title="Tambah pengajuan manual" tag="CBD / NON_LPB" confirmLabel="Simpan" confirmDisabled={alasan} onConfirm={simpan}>
            <div className="fi-segs" role="group" aria-label="Tipe">
                {(["CBD", "NON_LPB"] as const).map((x) => <button key={x} type="button" aria-pressed={f.tipe === x} onClick={() => set("tipe")(x)}>{x}</button>)}
            </div>
            <div className="fi-formgrid">
                <FormField label="Principal" required>{(a) => <input {...a} className="fi-input" value={f.principle} onChange={(e) => set("principle")(e.target.value)} />}</FormField>
                {f.tipe === "NON_LPB" && <>
                    <FormField label="Jenis dokumen" required>{(a) => <input {...a} className="fi-input" placeholder="mis. Nota Debet" value={f.jenis_dokumen} onChange={(e) => set("jenis_dokumen")(e.target.value)} />}</FormField>
                    <FormField label="Nomor dokumen" required>{(a) => <input {...a} className="fi-input" value={f.nomor_dokumen} onChange={(e) => set("nomor_dokumen")(e.target.value)} />}</FormField>
                    <FormField label="No. referensi" help="Opsional.">{(a) => <input {...a} className="fi-input" value={f.no_lpb} onChange={(e) => set("no_lpb")(e.target.value)} />}</FormField>
                </>}
                <FormField label="No. invoice" help={f.tipe === "CBD" ? "Wajib sebelum diajukan ke keranjang." : undefined}>{(a) => <input {...a} className="fi-input" value={f.invoice_no} onChange={(e) => set("invoice_no")(e.target.value)} />}</FormField>
                <FormField label="Nilai invoice" required error={galatNilai}>{(a) => <input {...a} className="fi-input fi-tnum" inputMode="decimal" placeholder="0" value={f.nilai} onChange={(e) => set("nilai")(e.target.value)} />}</FormField>
            </div>
        </ConfirmDialog>
    );
}

/** Langkah 1 → 2: rute + tanggal bayar Finance (bawaan besok WITA, dikirim eksplisit) → draf keranjang. Draf tidak me-reserve rekaman. */
export function DialogKeranjang({ open, onClose, dipilih, total, alasan, onSelesai, onTidakPasti }: {
    open: boolean; onClose: () => void; dipilih: Baris[]; total: number; alasan?: string; onSelesai: (draftId: string) => void; onTidakPasti: () => void;
}) {
    const [rute, setRute] = useState<"" | "BANK_PANIN" | "NON_PANIN">("");
    const [tanggal, setTanggal] = useState(() => besokWita());
    const [belumPasti, setBelumPasti] = useState(false);
    // Setelah draf dibuat, halaman berpindah ke keranjang (bisa lama saat kompilasi/jaringan lambat): tombol dikunci, tanpa draf kedua.
    const [dibuat, setDibuat] = useState(false);
    const idRute = useId();
    const tutup = () => { if (dibuat) return; setRute(""); setTanggal(besokWita()); setBelumPasti(false); onClose(); };
    const principals = new Set(dipilih.map((r) => r.principle));
    const galatTanggal = !/^\d{4}-\d{2}-\d{2}$/.test(tanggal) ? "Isi tanggal bayar Finance." : undefined;
    const blok = dibuat ? "Keranjang dibuat; membuka langkah Tinjau…" : alasan ?? (belumPasti ? KUNCI_PASTI : !rute ? "Pilih rute pembayaran dulu." : galatTanggal);

    async function buat() {
        const res = await tulis("/payments/cart/create", { method: rute, record_ids: dipilih.map((r) => r.record_id), target_payment_date: tanggal });
        if (res.ok && res.data.draft_id) { setDibuat(true); onSelesai(String(res.data.draft_id)); return; }
        if (!res.ok && res.tidakPasti) { setBelumPasti(true); onTidakPasti(); }
        throw new Error(res.ok ? "Server tidak mengirim nomor draf." : res.error);
    }

    return (
        <ConfirmDialog open={open} onClose={tutup} title={`Buat keranjang ${dipilih.length} rekaman?`} tag="Langkah 1 dari 3" confirmLabel="Buat keranjang" confirmDisabled={blok} onConfirm={buat}
            facts={[["Rekaman", `${dipilih.length} rekaman · ${principals.size} principal`], ["Nilai invoice", rupiah(total)], ["Berikutnya", "Tinjau potongan, jenis pembayaran, dan rekening; belum ada yang diajukan."]]}>
            <div className="fi-field" role="radiogroup" aria-labelledby={idRute} aria-required>
                <span id={idRute} className="fi-label">Rute pembayaran<span className="fi-req" aria-hidden>*</span></span>
                <label className="fi-check"><input type="radio" name={idRute} checked={rute === "BANK_PANIN"} onChange={() => setRute("BANK_PANIN")} />
                    <span><b>Bank Panin (SPPD)</b> — dana ditarik dari fasilitas Bank Panin; satu SPPD untuk semua principal di keranjang.</span></label>
                <label className="fi-check"><input type="radio" name={idRute} checked={rute === "NON_PANIN"} onChange={() => setRute("NON_PANIN")} />
                    <span><b>Non Panin</b> — tanpa SPPD; hanya berkas invoice per principal.</span></label>
            </div>
            <FormField label="Tanggal bayar Finance" required error={tanggal ? galatTanggal : undefined}
                help={`Finance melihat pengajuan ini di halaman Finance pada tanggal ini (bawaan besok WITA; Finance membuka tanggal hari ini ${tanggalTampil(hariIniWita())}). Bisa diubah lagi di langkah Tinjau.`}>
                {(a) => <input {...a} className="fi-input" type="date" value={tanggal} onChange={(e) => setTanggal(e.target.value)} />}
            </FormField>
        </ConfirmDialog>
    );
}

/** Rincian satu rekaman: kolom yang tidak muat di tabel + isian draf. Rekaman terkunci server = baca-saja dengan alasannya. */
export function RincianRekaman({ baris, onClose, draf, galat, izinUbah, izinHapus, onUbah, onHapus }: {
    baris: Baris | null; onClose: () => void; draf: Partial<Record<Isian, string>>; galat?: string;
    izinUbah?: string; izinHapus?: string; onUbah: (k: Isian, v: string) => void; onHapus: () => void;
}) {
    const titleId = useId();
    const r = baris;
    const st = r ? STATUS_REKAMAN[statusRekaman(r)] : null;
    const terkunci = r?.locked_reason ? `Terkunci: ${r.locked_reason}.` : undefined;
    const bisaUbah = r ? !terkunci && !izinUbah : false;
    const alasanHapus = terkunci ?? izinHapus;
    const tipe = r ? tipeRekaman(r) : "LPB";
    return (
        <Dialog open={Boolean(r)} onClose={onClose} labelledBy={titleId} className="fi-dialog" closeOnBackdrop>
            {r && st && (
                <>
                    <header>
                        <div>
                            <span className="fi-tag" data-tone="info">{tipe}</span>
                            <h2 id={titleId} className="fi-mono">{nama(r)}</h2>
                        </div>
                        <button type="button" className="fi-btn fi-btn--icon" aria-label="Tutup" onClick={onClose}><X className="fi-icon" aria-hidden /></button>
                    </header>
                    <div className="fi-dialog-body">
                        <span><StatusBadge tone={st.tone}>{st.label}</StatusBadge></span>
                        {terkunci && <MessageStrip tone="warn" title={terkunci}>Isian tidak bisa diubah atau dihapus dari Pembayaran. Status, bukti, dan tanggal transfer milik Finance.</MessageStrip>}
                        {!terkunci && izinUbah && <MessageStrip tone="info" title="Baca saja.">{izinUbah}</MessageStrip>}
                        {galat && <MessageStrip tone="neg" title="Simpan terakhir ditolak.">{galat}</MessageStrip>}
                        <KeyValues items={[
                            ["Tanggal setor", tanggalTampil(r.tgl_setor)],
                            ["Tanggal WIN · JT", `${tanggalTampil(r.tgl_win)} · ${tanggalTampil(r.tgl_jtempo_win || r.jt_win)}`],
                            ["Nilai WIN", r.nilai_win_display ? `Rp ${r.nilai_win_display}` : "—"],
                            ["Terima barang", tanggalTampil(r.tgl_terima_barang)],
                            ["Pengajuan · SPPD", [r.submission_id, r.sppd_no].filter(Boolean).join(" · ") || "—"],
                            ["Purchase Payment", r.accurate_purchase_payment_number || "—"],
                        ]} />
                        <div className="fi-formgrid">
                            {ISIAN.filter((i) => tipe === "NON_LPB" || (i.key !== "jenis_dokumen" && i.key !== "nomor_dokumen") || nilaiAwal(r, i.key)).map((i) => {
                                const v = draf[i.key] ?? nilaiAwal(r, i.key);
                                const berubah = draf[i.key] !== undefined;
                                return (
                                    <FormField key={i.key} label={i.label} error={galatIsian(i.key, v)} help={berubah ? `Sebelumnya: ${(i.jenis === "tanggal" ? tanggalTampil(nilaiAwal(r, i.key)) : nilaiAwal(r, i.key)) || "(kosong)"}` : undefined}>
                                        {(a) => <input {...a} className="fi-input" type={i.jenis === "tanggal" ? "date" : "text"} inputMode={i.jenis === "angka" ? "decimal" : undefined}
                                            readOnly={!bisaUbah} aria-readonly={!bisaUbah || undefined} value={v} onChange={(e) => onUbah(i.key, e.target.value)} />}
                                    </FormField>
                                );
                            })}
                        </div>
                        {bisaUbah && <p className="fi-small fi-subtle">Perubahan menjadi draf di halaman ini; simpan lewat tombol Simpan perubahan di bawah daftar.</p>}
                    </div>
                    <footer>
                        <Button variant="negative" icon={terkunci ? <Lock className="fi-icon" aria-hidden /> : <Trash2 className="fi-icon" aria-hidden />}
                            disabled={Boolean(alasanHapus)} disabledReason={alasanHapus} onClick={onHapus}>Hapus rekaman…</Button>
                        <Button variant="primary" onClick={onClose}>Selesai</Button>
                    </footer>
                    {alasanHapus && <p className="fi-small fi-subtle" style={{ padding: "0 20px 12px" }}>Hapus nonaktif: {alasanHapus}</p>}
                </>
            )}
        </Dialog>
    );
}

/** Hapus satu rekaman tanpa kunci (rekaman draf = belum diajukan). Server menolak 409 bila sementara itu terkunci. */
export function DialogHapus({ baris, onClose, kunci, onSelesai, onTidakPasti }: {
    baris: Baris | null; onClose: () => void; kunci?: string; onSelesai: Selesai; onTidakPasti: () => void;
}) {
    const [belumPasti, setBelumPasti] = useState(false);
    const tutup = () => { setBelumPasti(false); onClose(); };
    const r = baris;
    async function hapus() {
        if (!r) return;
        const res = await tulis("/payments/delete", { record_ids: [r.record_id] });
        if (res.ok) {
            const n = Number(res.data.deleted ?? 0);
            setBelumPasti(false);
            onSelesai({ pesan: n ? `${nama(r)} dihapus.` : `${nama(r)} sudah tidak ada di server.` });
            return;
        }
        if (res.tidakPasti) { setBelumPasti(true); onTidakPasti(); }
        throw new Error(res.error);
    }
    return (
        <ConfirmDialog open={Boolean(r)} onClose={tutup} title="Hapus 1 rekaman draf?" tag="BL-05" tone="negative" confirmLabel="Hapus"
            confirmDisabled={kunci ?? (belumPasti ? KUNCI_PASTI : r?.locked_reason ? `Terkunci: ${r.locked_reason}` : undefined)} onConfirm={hapus}
            facts={r ? [
                ["Dihapus", `${nama(r)} · ${r.principle || "—"} · ${Number.isNaN(angka(r.nilai_invoice)) ? String(r.nilai_invoice) : rupiah(angka(r.nilai_invoice))} · ${STATUS_REKAMAN[statusRekaman(r)].label}`],
                ["Tidak bisa dihapus", "Rekaman yang sudah diajukan, ditransfer, atau terposting (dikunci server)."],
                ["Akibat", "Permanen; rekaman hilang dari daftar dan tidak bisa diajukan."],
            ] : undefined}>
            <VariantNote bl="BL-33">Server belum menyimpan alasan penghapusan, jadi dialog ini tidak memintanya. Bila riwayat bersama (nilai lama → baru) masuk, alasan wajib dan tercatat.</VariantNote>
        </ConfirmDialog>
    );
}
