/*
 * Tujuan: Hook pencarian untuk pemilih pelanggan/barang: jeda ketik 300 ms, minimal 2 huruf, permintaan lama dibatalkan
 *   (AbortController), dan empat keadaan yang tidak tercampur (diam / memuat / siap / galat) — galat tidak pernah tampil sebagai kosong.
 * Caller: components/order/PemilihPelanggan.tsx, components/order/PemilihBarang.tsx.
 * Dependensi: ./order-cabang (JEDA_CARI_MS, cukupHuruf), ./order-cabang-api (tipe Hasil).
 * Main Functions: useCari.
 * Side Effects: timer + permintaan HTTP lewat `cari`; setState hanya dari callback timer/promise (bukan sinkron di effect).
 */
"use client";

import { useEffect, useState } from "react";
import { JEDA_CARI_MS, cukupHuruf, type Galat } from "./order-cabang";
import type { Hasil } from "./order-cabang-api";

export type StatusCari<T> = { jenis: "diam" } | { jenis: "memuat" } | { jenis: "siap"; data: T } | { jenis: "galat"; galat: Galat };

/**
 * `kunciCari` = string yang berubah bila syarat pencarian berubah (saringan cabang, pelanggan, tanggal): hasil kunci lama tidak dipinjam.
 * `cari` harus stabil selama `kunciCari` sama (useCallback). Mengembalikan [status, cobaLagi].
 */
export function useCari<T>(q: string, aktif: boolean, kunciCari: string, cari: (q: string, signal: AbortSignal) => Promise<Hasil<T>>): [StatusCari<T>, () => void] {
    const [versi, setVersi] = useState(0);
    const [hasil, setHasil] = useState<{ kunci: string; s: StatusCari<T> } | null>(null);
    const cukup = aktif && cukupHuruf(q);
    const kunci = `${versi}|${kunciCari}|${q.trim()}`;
    useEffect(() => {
        if (!cukup) return;
        const ac = new AbortController();
        const timer = setTimeout(async () => {
            const h = await cari(q.trim(), ac.signal);
            if (ac.signal.aborted) return;
            if (!h.ok && "batal" in h) return;
            setHasil({ kunci, s: h.ok ? { jenis: "siap", data: h.data } : { jenis: "galat", galat: h.galat } });
        }, JEDA_CARI_MS);
        return () => { clearTimeout(timer); ac.abort(); };
    }, [cukup, q, kunci, cari]);
    const status: StatusCari<T> = !cukup ? { jenis: "diam" } : hasil?.kunci === kunci ? hasil.s : { jenis: "memuat" };
    return [status, () => setVersi((v) => v + 1)];
}
