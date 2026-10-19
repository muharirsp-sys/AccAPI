"use client";
/*
 * Tujuan: isi klien halaman uji Peta — mengambil jawaban supervisor-review, pemilih salesman, dan tombol "Render ulang" yang mengirim
 *   ARRAY BARU berisi data sama (uji: peta tidak boleh dibangun ulang).
 * Caller: uji-peta/page.tsx.
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Button, MessageStrip, Skeleton } from "@/components/fiori/core";
import type { JawabanSupervisorReview } from "@/lib/supervisor-review/kontrak";

const Peta = dynamic(() => import("../Peta"), { ssr: false, loading: () => <Skeleton rows={4} label="Memuat peta" /> });
type Data = Pick<JawabanSupervisorReview, "penanda" | "kunjungan" | "salesman">;

export default function UjiPeta() {
    const [data, setData] = useState<Data | null>(null);
    const [galat, setGalat] = useState(false);
    const [sales, setSales] = useState<string | null>(null);
    const [, setTick] = useState(0);

    useEffect(() => {
        fetch("/api/supervisor-review").then((r) => r.json() as Promise<Data>).then(setData).catch(() => setGalat(true));
    }, []);

    if (galat) return <MessageStrip tone="neg" title="Jawaban uji tidak terbaca." />;
    if (!data) return <Skeleton rows={4} label="Memuat data uji" />;
    return (
        <div className="fi-page">
            <h1>Uji Peta</h1>
            <div className="fi-btnrow">
                <label>Salesman{" "}
                    <select className="fi-input" value={sales ?? ""} onChange={(e) => setSales(e.target.value || null)}>
                        <option value="">Semua salesman</option>
                        {data.salesman.map((s) => <option key={s.salesCode} value={s.salesCode}>{s.nama}</option>)}
                    </select>
                </label>
                <Button onClick={() => setTick((t) => t + 1)}>Render ulang</Button>
            </div>
            <Peta penanda={data.penanda.slice()} kunjungan={data.kunjungan.slice()} salesCodeTerpilih={sales} />
        </div>
    );
}
