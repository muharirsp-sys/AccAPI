/*
 * Tujuan: Bagian laporan principal otomatis di Laporan Harian (ABCPI: FTP + email 20.00 WITA, closing ditahan; Enigma: unggah portal
 *   Enesis 20.30 WITA, closing ditahan) — kirim/unggah manual per tanggal, unduh pratinjau, riwayat putaran sebagai bukti.
 * Caller: app/(dashboard)/laporan-harian/LaporanHarian.tsx (hanya bila punya laporan_harian.send).
 * Dependensi: GET/POST /api/laporan-harian/{abcpi,enigma}, components/fiori/{core,interactive}.
 * Main Functions: KirimPrincipal.
 * Side Effects: POST mengirim laporan ke principal (FTP/email ABCPI atau portal Enigma).
 */
"use client";

import { useCallback, useState } from "react";
import { Download, Send } from "lucide-react";
import { Button, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad } from "@/components/fiori/interactive";
import { ambil, hariIniWita, tanggalPendek } from "@/lib/rekapan-nota/ui";
import { waktuWita } from "@/lib/tampil";

type Hasil = {
    waktu?: string; tanggal: string; sumber: string; status: string; baris?: { sales: number; stok?: number };
    ftp?: string; email?: string; portal?: string; galat: string[]; peringatan: string[];
};
const NADA: Record<string, "pos" | "neg" | "warn" | "info"> = { terkirim: "pos", ditahan: "info", sebagian: "warn", gagal: "neg", validation_error: "neg" };
const ringkas = (r: Hasil) => [r.portal, r.ftp && `FTP ${r.ftp}`, r.email && `email ${r.email}`, ...r.galat, ...r.peringatan].filter(Boolean).join(" · ");

const kolom: Column<Hasil>[] = [
    { key: "waktu", header: "Waktu", cell: (r) => (r.waktu ? waktuWita(r.waktu) : "") },
    { key: "tanggal", header: "Tanggal laporan", cell: (r) => tanggalPendek(r.tanggal) },
    { key: "sumber", header: "Sumber", cell: (r) => r.sumber },
    { key: "status", header: "Status", cell: (r) => <StatusBadge tone={NADA[r.status] ?? "neu"}>{r.status}</StatusBadge> },
    { key: "baris", header: "Baris", align: "end", cell: (r) => (r.baris ? [r.baris.sales, r.baris.stok].filter((x) => x !== undefined).join(" / ") : "–") },
    { key: "ket", header: "Keterangan", secondary: true, cell: ringkas },
];

type Props = { kode: "abcpi" | "enigma"; judul: string; subjudul: string; keterangan: string; tombol: string; konfirmasi: string; fakta: Array<[string, string]> };

export default function KirimPrincipal({ kode, judul, subjudul, keterangan, tombol, konfirmasi, fakta }: Props) {
    const api = `/api/laporan-harian/${kode}`;
    const [tanggal, setTanggal] = useState(hariIniWita());
    const [dialog, setDialog] = useState(false);
    const [hasil, setHasil] = useState<Hasil | null>(null);
    const [riwayat, muat] = useLoad(useCallback(() => ambil<Hasil[]>(api, (j) => (j as { riwayat: Hasil[] }).riwayat), [api]));

    async function kirim() {
        const res = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tanggal, confirm: true }) });
        const data = await res.json().catch(() => ({ status: "gagal", galat: [`HTTP ${res.status}`], peringatan: [] })) as Hasil;
        setHasil(data);
        setDialog(false);
        muat();
    }

    return (
        <Section id={kode} title={judul} subtitle={subjudul}>
            <div className="fi-sect-in">
                <p className="fi-small fi-subtle">{keterangan}</p>
                <div className="fi-page-bar">
                    <FormField label="Tanggal laporan">{(a11y) => <input {...a11y} type="date" className="fi-input" value={tanggal} max={hariIniWita()} onChange={(e) => setTanggal(e.target.value)} />}</FormField>
                    <a className="fi-btn fi-btn--secondary" href={`${api}?pratinjau=${tanggal}`}><Download className="fi-icon" aria-hidden />Unduh pratinjau</a>
                    <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={!tanggal} onClick={() => setDialog(true)}>{tombol}…</Button>
                </div>
                {hasil && <MessageStrip tone={NADA[hasil.status] === "pos" ? "pos" : NADA[hasil.status] === "neg" ? "neg" : "warn"} title={`Laporan ${tanggalPendek(hasil.tanggal)}: ${hasil.status}.`} onClose={() => setHasil(null)}>
                    {ringkas(hasil)}
                </MessageStrip>}
            </div>
            <ResponsiveTable<Hasil> title={`Riwayat ${judul}`} columns={kolom} rows={riwayat.data ?? []} rowKey={(r) => `${r.waktu}-${r.tanggal}`}
                status={riwayat.status} error={riwayat.error} onRetry={muat} empty={{ title: "Belum ada kiriman", message: "Riwayat terisi setelah kiriman pertama." }}
                mobileItem={(r) => <ListItem doc={tanggalPendek(r.tanggal)} title={`${r.waktu ? waktuWita(r.waktu) : ""} · ${r.sumber}`} meta={r.galat.join(" · ")} badge={<StatusBadge tone={NADA[r.status] ?? "neu"}>{r.status}</StatusBadge>} />} />
            <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title={`${konfirmasi} ${tanggalPendek(tanggal)}?`} tag="Kirim" confirmLabel={tombol}
                onConfirm={kirim} facts={[["Data", `Bulan berjalan s.d. ${tanggalPendek(tanggal)}, ditarik ulang dari Accurate sekarang (±1–5 menit)`], ...fakta]} />
        </Section>
    );
}
