/*
 * Tujuan: Bagian "Laporan ABCPI (FTP + email)" di Laporan Harian — kiriman otomatis 20.00 WITA, closing akhir bulan ditahan dan
 *   dikirim dari sini; unduh pratinjau; riwayat putaran sebagai bukti.
 * Caller: app/(dashboard)/laporan-harian/LaporanHarian.tsx (hanya bila punya laporan_harian.send).
 * Dependensi: GET/POST /api/laporan-harian/abcpi, components/fiori/{core,interactive}.
 * Main Functions: AbcpiKirim.
 * Side Effects: POST mengunggah ke FTP ABC dan mengirim email ke penerima ABCPI.
 */
"use client";

import { useCallback, useState } from "react";
import { Download, Send } from "lucide-react";
import { Button, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad } from "@/components/fiori/interactive";
import { ambil, hariIniWita, jamWita, tanggalPendek } from "@/lib/rekapan-nota/ui";

type Hasil = { waktu?: string; tanggal: string; sumber: string; status: string; baris?: { sales: number; stok: number }; ftp?: string; email?: string; galat: string[]; peringatan: string[] };
const NADA: Record<string, "pos" | "neg" | "warn" | "info"> = { terkirim: "pos", ditahan: "info", sebagian: "warn", gagal: "neg" };

const kolom: Column<Hasil>[] = [
    { key: "waktu", header: "Waktu", cell: (r) => (r.waktu ? jamWita(r.waktu) : "") },
    { key: "tanggal", header: "Tanggal laporan", cell: (r) => tanggalPendek(r.tanggal) },
    { key: "sumber", header: "Sumber", cell: (r) => r.sumber },
    { key: "status", header: "Status", cell: (r) => <StatusBadge tone={NADA[r.status] ?? "neu"}>{r.status}</StatusBadge> },
    { key: "baris", header: "Baris", align: "end", cell: (r) => (r.baris ? `${r.baris.sales} / ${r.baris.stok}` : "–") },
    { key: "ket", header: "Keterangan", secondary: true, cell: (r) => [...r.galat, ...r.peringatan].join(" · ") || `FTP ${r.ftp ?? "–"} · email ${r.email ?? "–"}` },
];

export default function AbcpiKirim() {
    const [tanggal, setTanggal] = useState(hariIniWita());
    const [dialog, setDialog] = useState(false);
    const [hasil, setHasil] = useState<Hasil | null>(null);
    const [riwayat, muat] = useLoad(useCallback(() => ambil<Hasil[]>("/api/laporan-harian/abcpi", (j) => (j as { riwayat: Hasil[] }).riwayat), []));

    async function kirim() {
        const res = await fetch("/api/laporan-harian/abcpi", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tanggal, confirm: true }) });
        const data = await res.json().catch(() => ({ status: "gagal", galat: [`HTTP ${res.status}`] })) as Hasil;
        setHasil(data);
        setDialog(false);
        muat();
    }

    return (
        <Section id="abcpi" title="Laporan ABCPI (FTP + email)" subtitle="otomatis tiap hari 20.00 WITA · akhir bulan ditahan, kirim di sini">
            <div className="fi-sect-in">
                <p className="fi-small fi-subtle">Faktur INV + retur RJN cabang ABC (tanpa RSJ) bulan berjalan sampai tanggal laporan dan stok per tanggal itu, ditarik langsung dari Accurate. FTP ABC menerima CSV; penerima keyword ABCPI menerima Excel (template ABCPI) + CSV.</p>
                <div className="fi-page-bar">
                    <FormField label="Tanggal laporan">{(a11y) => <input {...a11y} type="date" className="fi-input" value={tanggal} max={hariIniWita()} onChange={(e) => setTanggal(e.target.value)} />}</FormField>
                    <a className="fi-btn fi-btn--secondary" href={`/api/laporan-harian/abcpi?pratinjau=${tanggal}`}><Download className="fi-icon" aria-hidden />Unduh pratinjau</a>
                    <Button variant="primary" icon={<Send className="fi-icon" aria-hidden />} disabled={!tanggal} onClick={() => setDialog(true)}>Kirim ke ABCPI…</Button>
                </div>
                {hasil && <MessageStrip tone={NADA[hasil.status] === "pos" ? "pos" : hasil.status === "gagal" ? "neg" : "warn"} title={`Laporan ${tanggalPendek(hasil.tanggal)}: ${hasil.status}.`} onClose={() => setHasil(null)}>
                    {[hasil.ftp && `FTP ${hasil.ftp}`, hasil.email && `Email ${hasil.email}`, ...hasil.galat, ...hasil.peringatan].filter(Boolean).join(" · ")}
                </MessageStrip>}
            </div>
            <ResponsiveTable<Hasil> title="Riwayat ABCPI" columns={kolom} rows={riwayat.data ?? []} rowKey={(r) => `${r.waktu}-${r.tanggal}`}
                status={riwayat.status} error={riwayat.error} onRetry={muat} empty={{ title: "Belum ada kiriman ABCPI", message: "Riwayat terisi setelah kiriman pertama." }}
                mobileItem={(r) => <ListItem doc={tanggalPendek(r.tanggal)} title={`${r.waktu ? jamWita(r.waktu) : ""} · ${r.sumber}`} meta={[...r.galat].join(" · ")} badge={<StatusBadge tone={NADA[r.status] ?? "neu"}>{r.status}</StatusBadge>} />} />
            <ConfirmDialog open={dialog} onClose={() => setDialog(false)} title={`Kirim laporan ABCPI ${tanggalPendek(tanggal)}?`} tag="Kirim" confirmLabel="Kirim ke FTP dan email"
                onConfirm={kirim} facts={[
                    ["Data", `Bulan berjalan s.d. ${tanggalPendek(tanggal)}, ditarik ulang dari Accurate sekarang (±1–3 menit)`],
                    ["Tujuan", "FTP ABC (SP_…_SALES.csv & SP_…_STOCK.csv) dan email penerima keyword ABCPI"],
                    ["Kirim ulang", "Berkas FTP bernama sama ditimpa; email terkirim lagi"],
                ]} />
        </Section>
    );
}
