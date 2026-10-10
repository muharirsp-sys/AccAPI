/*
 * Tujuan: Dialog operasi data Format SPPD (Fiori S6a, it08) — semuanya Pratinjau → Terapkan dengan laporan yang SAMA dari server:
 *   `excel` (Unggah Excel data SPPD: berubah/tak berubah/diblok/tidak ditemukan/ditolak terkunci), `replace` (ganti nama principal:
 *   diubah, terkunci dilewati, mapping Finance yang perlu diatur ulang), Auto-Fix nama (pratinjau confirm:false), Restore backup
 *   (rekaman, pengajuan, nomor SPPD sebelum → sesudah; hanya pemegang setelan SPPD).
 * Caller: app/(dashboard)/payments/FormatSppd.tsx.
 * Dependensi: ./bersama (tulis, daftarKunci), components/fiori/*, lib/promo-ui (rupiah).
 * Main Functions: DialogExcel, DialogGantiNama, DialogAutoFix, DialogRestore.
 * Side Effects: POST /payments/sppd/upload?dry_run (sppd.upload_excel), /api/bank-data/replace-principle-name {dry_run} (payments.edit),
 *   /api/bank-data/auto-fix-names {confirm} (pratinjau payments.view, terapkan payments.edit), /payments/sppd/restore-backup?dry_run
 *   (sppd.edit_settings) — semua dengan CSRF.
 *
 * Pemanggil MEMASANG dialog hanya saat dibuka (`{dialog === "x" && <DialogX open … />}`), jadi isian dan pratinjau selalu segar.
 * Bendera pratinjau/eksekusi selalu dikirim sebagai 1/0 (kontrak S6-0e putaran 3: nilai lain = 400 tanpa tulis).
 * Pratinjau tidak pernah menulis. Jawaban tidak pasti saat TERAPKAN: "belum pasti", halaman memuat ulang, tombol dialog dikunci sampai
 * dialog ditutup. Pratinjau yang gagal terbaca cukup diulang (tidak ada yang ditulis).
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { KeyValues, MessageStrip } from "@/components/fiori/core";
import { ConfirmDialog, FormField } from "@/components/fiori/interactive";
import { rupiah } from "@/lib/promo-ui";
import { daftarKunci, tulis, type HasilTulis } from "./bersama";

type Selesai = (p: { judul: string; isi?: string }) => void;
type Props = { open: boolean; onClose: () => void; onSelesai: Selesai; onTidakPasti: () => void };
type Pratinjau<T> = { status: "memuat" } | { status: "siap"; data: T } | { status: "galat"; error: string } | null;

const KUNCI_PASTI = "Hasil sebelumnya belum pasti — tutup dialog dan periksa data dulu sebelum mengulang.";
const PRATINJAU_PUTUS = "Pratinjau tidak terbaca (koneksi atau server). Coba lagi; belum ada yang ditulis.";
const daftar = (xs: string[] | undefined, n = 5) => (xs?.length ? `${xs.slice(0, n).join(", ")}${xs.length > n ? ` dan ${xs.length - n} lainnya` : ""}` : "—");
const keP = <T,>(res: HasilTulis): Pratinjau<T> => (res.ok ? { status: "siap", data: res.data as T } : { status: "galat", error: res.tidakPasti ? PRATINJAU_PUTUS : res.error });
/** Nilai lama/baru Excel SPPD: uang rupiah, selain itu teks. */
const nilaiTampil = (field: string, v: unknown) => (typeof v === "number" && /nilai|potongan|gap/.test(field) ? rupiah(v) : String(v ?? "") || "(kosong)");

/**
 * Pola bersama dialog berkas: pilih → pratinjau `?dry_run=1` → terapkan `?dry_run=0`. Pratinjau TERIKAT ke berkasnya (`untuk`) dan
 * jawaban usang (berkas sudah diganti / dialog direset) diabaikan lewat urutan permintaan — pilih A lalu B tidak pernah memasangkan
 * laporan A dengan unggahan B.
 */
function useBerkas<T>(path: string) {
    const [berkas, setBerkas] = useState<File | null>(null);
    const [p, setPAsli] = useState<{ untuk: File; isi: Pratinjau<T> } | null>(null);
    const [kunciInput, setKunciInput] = useState(0);
    const urut = useRef(0);
    const reset = () => { urut.current += 1; setBerkas(null); setPAsli(null); setKunciInput((k) => k + 1); };
    async function pilih(file: File | null) {
        const ke = ++urut.current;
        setBerkas(file);
        setPAsli(file ? { untuk: file, isi: { status: "memuat" } } : null);
        if (!file) return;
        const fd = new FormData();
        fd.append("file", file);
        const res = await tulis(`${path}?dry_run=1`, fd);
        if (ke === urut.current) setPAsli({ untuk: file, isi: keP<T>(res) });
    }
    async function terapkan(): Promise<HasilTulis> {
        const fd = new FormData();
        fd.append("file", berkas!);
        return tulis(`${path}?dry_run=0`, fd);
    }
    /** Laporan dari jawaban terapkan yang ditolak (untuk berkas yang sama). */
    const setP = (isi: Pratinjau<T>) => { if (berkas) setPAsli({ untuk: berkas, isi }); };
    return { berkas, p: p && p.untuk === berkas ? p.isi : null, setP, kunciInput, reset, pilih, terapkan };
}

type LaporanExcel = {
    can_apply?: boolean; updated?: number; unchanged?: number; not_found?: string[]; errors?: string[]; blocked_columns?: string[]; ignored_columns?: string[];
    changes?: Array<{ record_id: string; no_lpb: string; principle: string; fields: Array<{ field: string; old: unknown; new: unknown }> }>;
    locked?: Array<{ record_id: string; no_lpb: string; reason: string }>; error?: string;
};

export function DialogExcel({ open, onClose, onSelesai, onTidakPasti, kunci }: Props & { kunci?: string }) {
    const b = useBerkas<LaporanExcel>("/payments/sppd/upload");
    const [belumPasti, setBelumPasti] = useState(false);
    const tutup = () => { b.reset(); setBelumPasti(false); onClose(); };
    const lap = b.p?.status === "siap" ? b.p.data : null;
    const alasan = kunci ?? (belumPasti ? KUNCI_PASTI : !b.berkas ? "Pilih berkas Excel data SPPD dulu."
        : b.p?.status === "memuat" ? "Pratinjau sedang dibuat." : !lap ? "Pratinjau gagal; berkas ini belum bisa diterapkan."
            : lap.locked?.length ? "Ada baris rekaman terkunci yang mengubah nilai — seluruh unggahan akan ditolak. Hapus baris itu dari berkas."
                : lap.errors?.length ? "Perbaiki galat di pratinjau dulu." : !lap.can_apply ? "Tidak ada rekaman yang cocok untuk diperbarui."
                    : !lap.updated ? "Tidak ada nilai yang berubah." : undefined);
    async function terapkan() {
        const res = await b.terapkan();
        if (res.ok) {
            const n = Number(res.data.updated ?? 0);
            const nama = b.berkas?.name;
            tutup();
            onSelesai({ judul: `${n} rekaman diperbarui dari ${nama}.`, isi: `${Number(res.data.unchanged ?? 0)} rekaman cocok tanpa perubahan.` });
            return;
        }
        if (res.tidakPasti) { setBelumPasti(true); onTidakPasti(); }
        else if (res.data) b.setP({ status: "siap", data: { ...(res.data as LaporanExcel), can_apply: false } });
        const kunciList = daftarKunci(res.data);
        throw new Error(kunciList.length ? `${res.error} Terkunci: ${kunciList.join(", ")}.` : res.error);
    }
    const contoh = (lap?.changes ?? []).slice(0, 4).map((c) => `${c.no_lpb || c.record_id}: ${c.fields.map((f) => `${f.field} ${nilaiTampil(f.field, f.old)} → ${nilaiTampil(f.field, f.new)}`).join(", ")}`);
    return (
        <ConfirmDialog alasanTerlihat open={open} onClose={tutup} title={b.berkas ? `Terapkan ${b.berkas.name}?` : "Unggah Excel data SPPD"} tag="Pratinjau"
            confirmLabel={lap?.updated ? `Terapkan ${lap.updated} perubahan` : "Terapkan"} confirmDisabled={alasan} onConfirm={terapkan}
            facts={lap ? [
                ["Cocok", `${(lap.updated ?? 0) + (lap.unchanged ?? 0)} rekaman · ${lap.updated ?? 0} berubah`],
                ["Kolom diblok", `${daftar(lap.blocked_columns)} — ajukan, gap, status, draf/pengajuan, dan nomor SPPD tidak pernah ditulis dari Excel`],
                ["Tidak ditemukan", daftar(lap.not_found)],
                ["Ditolak (terkunci)", lap.locked?.length ? daftar(lap.locked.map((x) => `${x.no_lpb || x.record_id} (${x.reason})`), 3) : "0"],
                ...(lap.errors?.length ? [["Galat", daftar(lap.errors, 3)] as [string, string]] : []),
            ] : undefined}>
            <FormField label="Berkas Excel data SPPD (.xlsx/.xls)" required help="Pratinjau dibuat otomatis tanpa menulis apa pun.">
                {(a) => <input key={b.kunciInput} {...a} className="fi-input" type="file" accept=".xlsx,.xls" onChange={(e) => void b.pilih(e.target.files?.[0] ?? null)} />}
            </FormField>
            {b.p?.status === "memuat" && <MessageStrip tone="info" title="Membuat pratinjau…" />}
            {b.p?.status === "galat" && <MessageStrip tone="neg" title="Pratinjau gagal.">{b.p.error}</MessageStrip>}
            {contoh.length > 0 && <MessageStrip tone="info" title="Contoh perubahan:">{contoh.join(" · ")}</MessageStrip>}
        </ConfirmDialog>
    );
}

type LaporanGanti = {
    matched?: number; replaced?: number; locked_skipped?: number; per_status?: Record<string, number>; samples?: string[];
    finance_mapping?: { old_name_has_mapping?: boolean; new_name_has_mapping?: boolean; needs_remap?: boolean };
};

export function DialogGantiNama({ open, onClose, onSelesai, onTidakPasti, kunci, awalLama, namaWeb, namaMaster }: Props & { kunci?: string; awalLama: string; namaWeb: string[]; namaMaster: string[] }) {
    // Dibuka dari "Samakan nama…": nama lama terisi dari baris yang diklik. Komponen dipasang saat dialog dibuka (isian segar).
    const [lama, setLama] = useState(awalLama);
    const [baru, setBaru] = useState("");
    const [p, setP] = useState<Pratinjau<LaporanGanti> & { kunci?: string } | null>(null);
    const [belumPasti, setBelumPasti] = useState(false);
    const kunciNama = `${lama.trim()}\u0000${baru.trim()}`;
    const segar = p && p.kunci === kunciNama ? p : null; // pratinjau hanya berlaku untuk pasangan nama yang sama
    const lap = segar?.status === "siap" ? segar.data : null;
    async function pratinjau() {
        setP({ status: "memuat", kunci: kunciNama });
        const res = await tulis("/api/bank-data/replace-principle-name", { old_name: lama.trim(), new_name: baru.trim(), dry_run: 1 });
        setP({ ...keP<LaporanGanti>(res)!, kunci: kunciNama });
    }
    const alasan = kunci ?? (belumPasti ? KUNCI_PASTI : !lama.trim() || !baru.trim() ? "Isi nama lama dan nama baru dulu."
        : lama.trim() === baru.trim() ? "Nama baru sama dengan nama lama." : !lap ? "Buat pratinjau untuk pasangan nama ini dulu."
            : !lap.replaced ? "Tidak ada rekaman yang bisa diganti." : undefined);
    async function terapkan() {
        const res = await tulis("/api/bank-data/replace-principle-name", { old_name: lama.trim(), new_name: baru.trim(), dry_run: 0 });
        if (res.ok) {
            const remap = (res.data.finance_mapping as LaporanGanti["finance_mapping"])?.needs_remap;
            onSelesai({ judul: `${Number(res.data.replaced ?? 0)} rekaman diganti dari “${lama.trim()}” menjadi “${baru.trim()}”.`,
                isi: `${Number(res.data.locked_skipped ?? 0)} rekaman terkunci tidak diubah.${remap ? " Mapping Accurate di Finance masih memakai nama lama — atur ulang di Finance." : ""}` });
            return;
        }
        if (res.tidakPasti) { setBelumPasti(true); onTidakPasti(); }
        throw new Error(res.error);
    }
    const fm = lap?.finance_mapping;
    return (
        <ConfirmDialog alasanTerlihat open={open} onClose={onClose} title={lama.trim() && baru.trim() ? `Ganti “${lama.trim()}” menjadi “${baru.trim()}”?` : "Ganti nama principal"} tag="Pratinjau"
            confirmLabel={lap?.replaced ? `Terapkan ke ${lap.replaced} rekaman` : "Terapkan"} confirmDisabled={alasan} onConfirm={terapkan}
            facts={lap ? [
                ["Diubah", `${lap.replaced ?? 0} rekaman${lap.per_status ? ` (${Object.entries(lap.per_status).map(([k, v]) => `${k} ${v}`).join(", ")} sebelum dikurangi yang terkunci)` : ""}`],
                ["Tidak diubah", `${lap.locked_skipped ?? 0} rekaman terkunci (diajukan/ditransfer/terposting)`],
                ["Mapping Accurate di Finance", fm?.needs_remap ? "tersimpan dengan nama lama; atur ulang di Finance setelah ini"
                    : fm?.old_name_has_mapping ? "nama baru sudah punya mapping" : "tidak ada mapping untuk nama lama"],
            ] : undefined}>
            <div className="fi-formgrid">
                <FormField label="Nama lama (di rekaman)" required>{(a) => <input {...a} className="fi-input" list="ganti-nama-web" value={lama} onChange={(e) => setLama(e.target.value)} />}</FormField>
                <FormField label="Nama baru (sesuai master rekening)" required>{(a) => <input {...a} className="fi-input" list="ganti-nama-master" value={baru} onChange={(e) => setBaru(e.target.value)} />}</FormField>
            </div>
            <datalist id="ganti-nama-web">{namaWeb.map((n) => <option key={n} value={n} />)}</datalist>
            <datalist id="ganti-nama-master">{namaMaster.map((n) => <option key={n} value={n} />)}</datalist>
            <div><button type="button" className="fi-btn fi-btn--secondary" disabled={!lama.trim() || !baru.trim() || lama.trim() === baru.trim() || segar?.status === "memuat"} onClick={pratinjau}>Pratinjau</button></div>
            {segar?.status === "galat" && <MessageStrip tone="neg" title="Pratinjau gagal.">{segar.error}</MessageStrip>}
            {p && !segar && <MessageStrip tone="info" title="Nama berubah sejak pratinjau.">Buat pratinjau lagi sebelum menerapkan.</MessageStrip>}
        </ConfirmDialog>
    );
}

type LaporanAutoFix = { changes?: Array<{ old: string; new: string; count: number; locked?: number }>; skipped?: Array<{ name: string; reason: string; count: string }>; total_records_affected?: number; executed?: boolean };

export function DialogAutoFix({ open, onClose, onSelesai, onTidakPasti, izinLihat, izinTerapkan }: Props & { izinLihat?: string; izinTerapkan?: string }) {
    const [p, setP] = useState<Pratinjau<LaporanAutoFix>>(null);
    const [belumPasti, setBelumPasti] = useState(false);
    useEffect(() => {
        if (izinLihat) return;
        let hidup = true;
        // Pratinjau = confirm 0 (tanpa tulis); tidak memakai dry_run (kontrak endpoint lama). Dipasang saat dialog dibuka.
        void tulis("/api/bank-data/auto-fix-names", { confirm: 0 }).then((res) => { if (hidup) setP(keP<LaporanAutoFix>(res)); });
        return () => { hidup = false; };
    }, [izinLihat]);
    const lap = p?.status === "siap" ? p.data : null;
    const n = lap?.total_records_affected ?? 0;
    const alasan = izinLihat ?? izinTerapkan ?? (belumPasti ? KUNCI_PASTI : !lap ? (p?.status === "galat" ? "Pratinjau gagal." : "Pratinjau sedang dibuat.") : n === 0 ? "Tidak ada nama yang perlu diubah." : undefined);
    async function terapkan() {
        const res = await tulis("/api/bank-data/auto-fix-names", { confirm: 1 });
        if (res.ok) {
            const ch = (res.data.changes as LaporanAutoFix["changes"]) ?? [];
            onSelesai({ judul: `${Number(res.data.total_records_affected ?? 0)} rekaman diganti namanya (${ch.length} nama principal).`, isi: ch.slice(0, 5).map((c) => `${c.old} → ${c.new}`).join(" · ") });
            return;
        }
        if (res.tidakPasti) { setBelumPasti(true); onTidakPasti(); }
        throw new Error(res.error);
    }
    return (
        <ConfirmDialog alasanTerlihat open={open} onClose={onClose} title={n ? `Samakan ${lap?.changes?.length ?? 0} nama principal dengan master rekening?` : "Auto-Fix nama principal"} tag="Pratinjau"
            confirmLabel={n ? `Terapkan ke ${n} rekaman` : "Terapkan"} confirmDisabled={alasan} onConfirm={terapkan}>
            {!p && !izinLihat ? <MessageStrip tone="info" title="Membuat pratinjau…" /> : null}
            {p?.status === "galat" && <MessageStrip tone="neg" title="Pratinjau gagal.">{p.error}</MessageStrip>}
            {lap && (lap.changes?.length
                ? <KeyValues items={lap.changes.slice(0, 12).map((c): [string, string] => [c.old, `→ ${c.new} · ${c.count} rekaman${c.locked ? ` (${c.locked} terkunci tidak diubah)` : ""}`])} />
                : <p className="fi-small fi-subtle">Semua nama principal sudah sama dengan master, atau tidak ada yang cocok.</p>)}
            {lap?.skipped?.length ? <p className="fi-small fi-subtle">Dilewati: {daftar(lap.skipped.map((x) => `${x.name} (${x.reason === "ambiguous" ? "ambigu" : "tidak cocok"})`))}</p> : null}
        </ConfirmDialog>
    );
}

type LaporanRestore = {
    can_apply?: boolean; records?: number; submissions?: number; new_submissions?: number; draft_records?: number; conflicts?: string[];
    sppd?: { year?: number; last_sequence_before?: number; max_restored?: number; last_sequence_after?: number; next_number?: string };
};

export function DialogRestore({ open, onClose, onSelesai, onTidakPasti, kunci }: Props & { kunci?: string }) {
    const b = useBerkas<LaporanRestore>("/payments/sppd/restore-backup");
    const [belumPasti, setBelumPasti] = useState(false);
    const tutup = () => { b.reset(); setBelumPasti(false); onClose(); };
    const lap = b.p?.status === "siap" ? b.p.data : null;
    const alasan = kunci ?? (belumPasti ? KUNCI_PASTI : !b.berkas ? "Pilih berkas backup PAYMENTS dulu."
        : b.p?.status === "memuat" ? "Pratinjau sedang dibuat." : !lap ? "Pratinjau gagal; berkas ini belum bisa dipulihkan."
            : lap.conflicts?.length ? "Ada konflik — tidak ada yang dipulihkan. Perbaiki berkasnya dulu." : !lap.can_apply ? "Berkas ini belum bisa dipulihkan." : undefined);
    async function terapkan() {
        const res = await b.terapkan();
        if (res.ok) {
            const sp = res.data.sppd as LaporanRestore["sppd"];
            tutup();
            onSelesai({ judul: `Restore backup berhasil: ${Number(res.data.added ?? 0)} rekaman ditambahkan.`, isi: sp ? `Nomor SPPD terakhir ${sp.last_sequence_before} → ${sp.last_sequence_after}; berikutnya ${sp.next_number}.` : undefined });
            return;
        }
        if (res.tidakPasti) { setBelumPasti(true); onTidakPasti(); }
        else if (res.data) b.setP({ status: "siap", data: { ...(res.data as LaporanRestore), can_apply: false } });
        throw new Error(res.error);
    }
    const sp = lap?.sppd;
    return (
        <ConfirmDialog alasanTerlihat open={open} onClose={tutup} title={b.berkas ? `Pulihkan ${b.berkas.name}?` : "Restore backup"} tag="Pratinjau"
            confirmLabel={lap?.records ? `Pulihkan ${lap.records} rekaman` : "Pulihkan"} confirmDisabled={alasan} onConfirm={terapkan}
            facts={lap ? [
                ["Rekaman", `${lap.records ?? 0} ditambahkan · ${lap.draft_records ?? 0} rekaman draf (belum diajukan)`],
                ["Pengajuan", `${lap.submissions ?? 0} di berkas · ${lap.new_submissions ?? 0} baru`],
                ["Nomor SPPD", sp ? `terakhir ${sp.last_sequence_before} → ${sp.last_sequence_after} (tertinggi di berkas ${sp.max_restored}); berikutnya ${sp.next_number} — tidak pernah turun` : "—"],
                ["Konflik", daftar(lap.conflicts, 3)],
            ] : undefined}>
            <FormField label="Berkas backup PAYMENTS (.xlsx)" required help="Berkas dari Unduh backup. Restore hanya MENAMBAH rekaman; Record ID atau No. LPB yang sudah ada = seluruh berkas ditolak. Keranjang (draf) tidak ada di backup.">
                {(a) => <input key={b.kunciInput} {...a} className="fi-input" type="file" accept=".xlsx,.xls" onChange={(e) => void b.pilih(e.target.files?.[0] ?? null)} />}
            </FormField>
            {b.p?.status === "memuat" && <MessageStrip tone="info" title="Membuat pratinjau…" />}
            {b.p?.status === "galat" && <MessageStrip tone="neg" title="Pratinjau gagal.">{b.p.error}</MessageStrip>}
        </ConfirmDialog>
    );
}
