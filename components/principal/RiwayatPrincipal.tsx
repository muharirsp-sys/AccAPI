/*
 * Tujuan: Bagian Riwayat Object Page Data Principal: principal_log terbaru dulu, paginasi kursor `sebelum` (kontrak S7-2).
 * Caller: components/principal/DataPrincipal.tsx (dipasang ulang lewat `key` baru sesudah tulis supaya memuat ulang).
 * Dependensi: GET /api/principals/{id}/history, components/fiori/*, ./principal-ui.
 * Main Functions: RiwayatPrincipal.
 * Side Effects: fetch baca-saja.
 */
"use client";

import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, MessageStrip, Skeleton } from "@/components/fiori/core";
import { useLoad } from "@/components/fiori/interactive";
import { aktorTeks, baca, ringkasLog, waktuWita, type HalamanRiwayat, type Log } from "./principal-ui";

const BATAS = 20;
const muat = (id: string, sebelum: number | null) =>
    baca<HalamanRiwayat>(`/api/principals/${id}/history?batas=${BATAS}${sebelum === null ? "" : `&sebelum=${sebelum}`}`,
        (j) => ({ riwayat: j.riwayat as Log[], sebelum: typeof j.sebelum === "number" ? j.sebelum : null }), "Riwayat gagal dimuat.");

export function RiwayatPrincipal({ id }: { id: string }) {
    const [awal, muatUlang] = useLoad(useCallback(() => muat(id, null), [id]));
    const [lanjut, setLanjut] = useState<{ dasar: HalamanRiwayat; baris: Log[]; sebelum: number | null } | null>(null);
    const [lagi, setLagi] = useState<{ status: "memuat" | "galat"; error?: string } | null>(null);
    const dasar = awal.data;
    const ext = dasar && lanjut?.dasar === dasar ? lanjut : null;
    const baris = [...(dasar?.riwayat ?? []), ...(ext?.baris ?? [])];
    const sebelum = ext ? ext.sebelum : dasar?.sebelum ?? null;

    async function muatLagi() {
        if (sebelum === null || !dasar) return;
        setLagi({ status: "memuat" });
        const h = await muat(id, sebelum);
        if (h.status !== "siap" || !h.data) { setLagi({ status: "galat", error: h.error }); return; }
        setLanjut({ dasar, baris: [...(ext?.baris ?? []), ...h.data.riwayat], sebelum: h.data.sebelum });
        setLagi(null);
    }

    if (awal.status === "memuat" && !dasar) return <div className="fi-sect-in"><Skeleton rows={3} label="Memuat riwayat" /></div>;
    if (awal.status === "galat" && !dasar) return <ErrorState title="Riwayat gagal dimuat" message={awal.error} onRetry={muatUlang} />;
    if (baris.length === 0) return <EmptyState title="Belum ada riwayat" message="Pembuatan, aktif/nonaktif, dan penghapusan alias tercatat di sini." />;
    return (
        <div>
            <ol className="fi-hist" aria-label="Riwayat principal">
                {baris.map((l) => {
                    const r = ringkasLog(l);
                    return (
                        <li key={l.id}>
                            <time dateTime={l.waktu}>{waktuWita(l.waktu)}</time>
                            <span><b>{r.apa}</b> · oleh {aktorTeks(l.aktor)}</span>
                            {r.rinci && <span className="fi-chg">{r.rinci}</span>}
                        </li>
                    );
                })}
            </ol>
            {lagi?.status === "galat" && <div className="fi-sect-in"><MessageStrip tone="neg" title="Riwayat lebih lama gagal dimuat.">{lagi.error}</MessageStrip></div>}
            {sebelum !== null && (
                <div className="fi-sect-in">
                    <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={lagi?.status === "memuat"} onClick={muatLagi}>
                        {lagi?.status === "galat" ? "Coba lagi" : "Muat riwayat lebih lama"}
                    </Button>
                </div>
            )}
        </div>
    );
}
