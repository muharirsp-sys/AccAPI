/*
 * Tujuan: Bagian bersama wizard Kunjungan dan halaman order kunjungan (owner 14 Nov 2026): lima langkah kunjungan (Order di antara Status dan
 *   Merchandising), alamat kedua layar, dan teks limit kredit toko.
 * Caller: ./Kunjungan.tsx, ./order/OrderKunjungan.tsx.
 * Dependensi: lib/form-kontrol/order-kunjungan (sisaLimit, LimitToko), lib/promo-ui (rupiah).
 * Main Functions: LANGKAH, urlKunjungan, urlOrderKunjungan, TeksLimit, bacaLimit.
 * Side Effects: Tidak ada.
 */
import { rupiah } from "@/lib/promo-ui";
import { sisaLimit, type LimitToko } from "@/lib/form-kontrol/order-kunjungan";

/** Langkah kunjungan. Order hanya untuk hasil ORDER; TIDAK ORDER melewatinya (toko tutup juga melewati Merchandising). */
export const LANGKAH = ["Check-in", "Status", "Order", "Merchandising", "Check-out"] as const;
export const L = { checkin: 0, status: 1, order: 2, merch: 3, checkout: 4, selesai: 5 } as const;

type Kunci = { custCode: string; salesCode: string; principle: string; date: string };
const q = (k: Kunci) => new URLSearchParams({ salesCode: k.salesCode, principle: k.principle, date: k.date });
export const urlKunjungan = (k: Kunci) => `/form-kontrol/visit/${encodeURIComponent(k.custCode)}?${q(k)}`;
export const urlOrderKunjungan = (k: Kunci) => `/form-kontrol/visit/${encodeURIComponent(k.custCode)}/order?${q(k)}`;

/** `limit` GET visit -> LimitToko; bentuk lain / null = tidak diketahui. */
export function bacaLimit(v: unknown): LimitToko | null {
    const o = v as { limit?: unknown; piutang?: unknown } | null;
    if (!o || typeof o !== "object") return null;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() && Number.isFinite(Number(x)) ? Number(x) : null);
    return { limit: n(o.limit), piutang: n(o.piutang) };
}

/** "Rp 5.000.000 · sisa Rp 900.000" (sisa negatif = "lewat"), atau "Tidak diatur di Accurate". Warna peringatan hanya bila lewat limit. */
export function TeksLimit({ l }: { l: LimitToko }) {
    const sisa = sisaLimit(l);
    if (l.limit === null || sisa === null) return <span>Tidak diatur di Accurate</span>;
    return (
        <span className="fi-tnum">
            {rupiah(l.limit)} · {sisa < 0 ? <b style={{ color: "var(--neg)" }}>lewat {rupiah(-sisa)}</b> : <>sisa <b>{rupiah(sisa)}</b></>}
        </span>
    );
}
