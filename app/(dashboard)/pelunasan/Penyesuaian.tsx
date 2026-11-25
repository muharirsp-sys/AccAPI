/*
 * Tujuan: Laporan penyesuaian Pelunasan (pemilik 25 Nov 2026): faktur yang cara bayarnya di Accurate berbeda dari berkas Excel
 *   (mis. berkas Tunai, Accurate Transfer Maybank; berkas TF BRI, Accurate 110105), siapa pun yang menginput. Pilih tanggal berkas,
 *   tabel + unduh Excel. Baca-saja.
 * Caller: Pelunasan.tsx (langkah Jenis).
 * Dependensi: GET /api/pelunasan/penyesuaian, ./bersama (unduhExcel, tanggalTampil), principal-order/bersama (baca, waktuWita), components/fiori.
 * Main Functions: LaporanPenyesuaian.
 * Side Effects: fetch (GET); unduh Excel lewat peramban.
 */
"use client";

import { useCallback, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button, ListItem, MessageStrip, ResponsiveTable, Section, StatusBadge, type Column } from "@/components/fiori/core";
import { useLoad, type Load } from "@/components/fiori/interactive";
import { baca, waktuWita } from "@/app/(dashboard)/principal-order/bersama";
import type { BarisPenyesuaian } from "@/lib/pelunasan-wizard";
import { tanggalTampil, unduhExcel } from "./bersama";

type Data = {
    tanggal: string | null; databaseId: string | null;
    tersedia: Array<{ tanggal: string; databaseId: string; berkas: number }>;
    berkas: Array<{ nama: string; dibuatPada: string; baris: number }>;
    cache: { status: string; lengkapPada: string | null } | null;
    rows: BarisPenyesuaian[];
};

const STATUS: Record<string, string> = {
    diproses: "dikirim menu", terposting: "dikirim menu", sudah_di_accurate: "diinput sales/admin", perlu_cek: "perlu cek",
    retur_manual: "retur manual", gagal: "gagal", tidak_pasti: "tidak pasti", ditahan: "ditahan",
};

export function LaporanPenyesuaian() {
    const [tanggal, setTanggal] = useState("");
    const [load, muatUlang] = useLoad(useCallback((): Promise<Load<Data>> => baca(`/api/pelunasan/penyesuaian${tanggal ? `?tanggal=${tanggal}` : ""}`,
        (j) => j as unknown as Data, "Laporan penyesuaian gagal dibaca."), [tanggal]), { pertahankan: true });
    const d = load.data;
    const rows = d?.rows ?? [];
    const kolom: Column<BarisPenyesuaian>[] = [
        { key: "faktur", header: "Faktur / outlet", cell: (r) => <><b className="fi-mono">{r.faktur}</b><span className="fi-codes">{r.pelanggan || r.outlet} · {r.berkas} baris {r.baris}</span></> },
        { key: "berkas", header: "Di berkas Excel", cell: (r) => <span className="fi-small">{r.caraBerkas}</span> },
        { key: "accurate", header: "Di Accurate", cell: (r) => <><span className="fi-small">{r.caraAccurate}</span><span className="fi-codes">{r.nomorAccurate}</span></> },
        { key: "status", header: "Status berkas", secondary: true, cell: (r) => <StatusBadge tone="warn">{STATUS[r.status] ?? r.status}</StatusBadge> },
    ];
    const lengkap = d?.cache?.status === "lengkap";

    return (
        <Section title="Laporan penyesuaian" subtitle="cara bayar di Accurate berbeda dari berkas Excel · siapa pun yang menginput">
            <div className="fi-sect-in">
                <div className="fi-btnrow" style={{ alignItems: "end", flexWrap: "wrap" }}>
                    <label className="fi-small">Tanggal berkas{" "}
                        <select className="fi-input" value={tanggal || d?.tanggal || ""} onChange={(e) => setTanggal(e.target.value)} disabled={!d?.tersedia.length}>
                            {(d?.tersedia ?? []).map((t) => <option key={`${t.databaseId}-${t.tanggal}`} value={t.tanggal}>{tanggalTampil(t.tanggal)} · {t.berkas} berkas</option>)}
                        </select>
                    </label>
                    <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} busy={load.status === "memuat"} onClick={muatUlang}>Muat ulang</Button>
                    <Button icon={<Download className="fi-icon" aria-hidden />} disabled={!rows.length} disabledReason="Tidak ada beda cara bayar."
                        onClick={() => void unduhExcel(rows.map((r) => ({
                            "Berkas": r.berkas, "Baris": r.baris, "Faktur": r.faktur, "Outlet": r.outlet, "Pelanggan": r.pelanggan, "Status berkas": STATUS[r.status] ?? r.status,
                            "Cara bayar di berkas": r.caraBerkas, "Cara bayar di Accurate": r.caraAccurate, "Nomor pelunasan Accurate": r.nomorAccurate,
                        })), "Penyesuaian", `Laporan_Penyesuaian_${d?.tanggal ?? ""}`)}>
                        {rows.length} baris (Excel)
                    </Button>
                </div>
                {load.status === "galat" && <MessageStrip tone="neg" title="Laporan penyesuaian tidak terbaca.">{load.error}</MessageStrip>}
                {d && !d.tersedia.length && <p className="fi-small">Belum ada berkas yang diunggah lewat menu ini; laporan muncul sesudah pratinjau pertama.</p>}
                {d?.tanggal && d.tersedia.length > 0 && (
                    <p className="fi-small">
                        {d.berkas.map((b) => `${b.nama} (${b.baris} baris, unggah ${waktuWita(b.dibuatPada)} WITA)`).join(", ") || "Tidak ada berkas untuk tanggal ini."}
                        {" · "}Salinan Accurate {d.cache ? (lengkap ? `lengkap, dibaca ${waktuWita(d.cache.lengkapPada ?? "")} WITA` : `berstatus ${d.cache.status}`) : "belum dibaca untuk tanggal ini"}
                        {" "}(diperbarui tiap 15 menit, 07.00–21.00 WITA).
                    </p>
                )}
                {d?.tanggal && d.cache && !lengkap && (
                    <MessageStrip tone="warn" title="Salinan Accurate belum lengkap.">Laporan bisa belum memuat semua pelunasan; muat ulang sesudah salinan lengkap.</MessageStrip>
                )}
                {d?.tanggal && (
                    <ResponsiveTable<BarisPenyesuaian> title="Laporan penyesuaian" count={rows.length} columns={kolom} rows={rows} rowKey={(r) => `${r.berkas}-${r.baris}`}
                        empty={{ title: "Tidak ada beda cara bayar", message: "Semua uang yang sudah masuk di Accurate sesuai rekening di berkas." }}
                        mobileItem={(r) => <ListItem doc={r.faktur} title={r.pelanggan || r.outlet} meta={`Berkas: ${r.caraBerkas} · Accurate: ${r.caraAccurate}`}
                            badge={<StatusBadge tone="warn">{STATUS[r.status] ?? r.status}</StatusBadge>} />} />
                )}
            </div>
        </Section>
    );
}
