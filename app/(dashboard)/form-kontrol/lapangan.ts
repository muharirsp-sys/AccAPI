/*
 * Tujuan: Helper bersama layar lapangan salesman (Fiori S5, it05): baca/tulis endpoint Form Kontrol dengan pesan yang membedakan
 *   tanpa sinyal, jawaban tidak pasti, dan penolakan server; normalisasi baris rute; daftar toko rute untuk Order Sales.
 * Caller: tabs/TabAo.tsx, tabs/TabNoOrder.tsx, tabs/TabLaporan.tsx, visit/[custCode]/Kunjungan.tsx, visit/[custCode]/FotoBukti.tsx,
 *   app/(dashboard)/sales/OrderSales.tsx (hanya RUTE_TERSIMPAN + bacaRuteTersimpan).
 * Dependensi: components/fiori/interactive (tipe Load), ./shared (AoRow).
 * Main Functions: ambilJson, bacaFk, kirimFk, GagalKirim, keBarisRute, useHariBeku, kemarinDari, simpanRute, bacaRuteTersimpan.
 * Side Effects: fetch (ambilJson/bacaFk/kirimFk); sessionStorage (simpanRute/bacaRuteTersimpan) — hanya tab peramban ini; interval 30 dtk
 *   + pendengar focus/visibilitychange (useHariBeku) untuk mendeteksi pergantian hari.
 *
 * Endpoint dan payload TIDAK berubah; yang baru hanya kalimat galat. Tulis yang dipakai layar salesman — ao-control, checkin,
 * merchandising, checkout, reports — adalah upsert/UPDATE per (salesman, toko, principal, tanggal), jadi mengulang setelah jawaban tidak
 * pasti tidak membuat baris dobel (pemanggil menandainya dengan `ulangAman`). Itu TIDAK berlaku untuk semua tulis Form Kontrol
 * (briefing, sm-control menambah baris) dan tidak untuk unggah foto (berkas baru tiap kirim).
 */
import { useEffect, useState } from "react";
import type { Load } from "@/components/fiori/interactive";
import { hariIniWita, type AoRow } from "./shared";

export const PESAN_SINYAL = "Ponsel tidak tersambung ke server (tanpa sinyal).";

/** status 0 = permintaan tidak sampai/tidak berjawab (tanpa sinyal); data null = badan bukan JSON (mis. halaman galat proxy). */
export type Jawaban = { status: number; data: Record<string, unknown> | null };

export async function ambilJson(url: string, init?: RequestInit): Promise<Jawaban> {
    try {
        const res = await fetch(url, { cache: "no-store", ...init });
        const text = await res.text();
        let data: Record<string, unknown> | null = null;
        try {
            const j: unknown = text ? JSON.parse(text) : {};
            data = j && typeof j === "object" ? (j as Record<string, unknown>) : null;
        } catch { /* bukan JSON → data null */ }
        return { status: res.status, data };
    } catch {
        return { status: 0, data: null };
    }
}

/** Kalimat untuk status gagal — tanpa kode status mentah, tanpa nama endpoint. */
export function sebabGagal(status: number): string {
    if (status === 0) return PESAN_SINYAL;
    if (status === 401) return "Sesi login berakhir; masuk ulang lalu coba lagi.";
    if (status === 403) return "Akun Anda tidak berhak atas data salesman ini.";
    if (status === 404) return "Data tidak ditemukan.";
    if (status === 400) return "Isian belum lengkap menurut server.";
    return "Server gagal memproses permintaan.";
}

const sukses = (j: Jawaban): j is { status: number; data: Record<string, unknown> } => j.status >= 200 && j.status < 300 && j.data !== null;

/** GET → Load. Galat TIDAK PERNAH jadi data kosong; tanpa sinyal disebut sinyal. */
export async function bacaFk<T>(url: string, pick: (data: Record<string, unknown>) => T): Promise<Load<T>> {
    const j = await ambilJson(url);
    if (sukses(j)) return { status: "siap", data: pick(j.data) };
    if (j.status === 0) return { status: "galat", error: `${PESAN_SINYAL} Coba lagi saat ada sinyal.` };
    return { status: "galat", error: j.status >= 200 && j.status < 300 ? "Jawaban server tidak terbaca." : sebabGagal(j.status) };
}

/** Galat tulis. `tidakPasti` = koneksi putus / status ≥ 502 / badan bukan JSON: mungkin sudah tersimpan, mungkin belum. */
export class GagalKirim extends Error {
    constructor(message: string, readonly tidakPasti: boolean, readonly status = 0) { super(message); }
}

/**
 * POST JSON (objek) atau FormData apa adanya. Berhasil → data JSON; gagal → GagalKirim berkalimat Indonesia.
 * `ulangAman` = endpoint upsert: kalimat galat tidak pasti boleh menyebut bahwa mengulang aman.
 */
export async function kirimFk(url: string, body: Record<string, unknown> | FormData, opsi: { ulangAman?: boolean } = {}): Promise<Record<string, unknown>> {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const j = await ambilJson(url, {
        method: "POST",
        headers: isForm ? undefined : { "Content-Type": "application/json" },
        body: isForm ? body : JSON.stringify(body),
    });
    if (sukses(j)) return j.data;
    const ulang = opsi.ulangAman ? " — mengulang aman, isian yang sama ditimpa" : "";
    if (j.status === 0) throw new GagalKirim(`${PESAN_SINYAL} Belum dipastikan tersimpan; tekan Coba lagi saat ada sinyal${ulang}.`, true);
    if (j.status >= 502 || j.data === null) throw new GagalKirim(`Server tidak memberi jawaban yang pasti; belum dipastikan tersimpan. Coba lagi${ulang}.`, true, j.status);
    throw new GagalKirim(sebabGagal(j.status), false, j.status);
}

/** Baris GET ao-control → AoRow (pemetaan sama dengan kode lama TabAo). */
export function keBarisRute(rows: unknown, principle: string): AoRow[] {
    return (Array.isArray(rows) ? rows as Record<string, unknown>[] : []).map((r) => ({
        id: r.id as string,
        salesCode: r.salesCode as string,
        custCode: r.custCode as string,
        custName: r.custName as string,
        principle: (r.principle as string) ?? principle,
        status: ((r.aoStatus ?? "not_visited") as AoRow["status"]),
        orderValueDpp: 0,
        isPriority: r.aoStatus === "priority",
        noOrderReasonCode: r.noOrderReasonCode as string | undefined,
        noOrderNote: r.noOrderNote as string | undefined,
        monthlyOrderCount: (r.monthlyOrderCount as number) ?? 0,
        needsAttention: (r.needsAttention as boolean) ?? false,
        checkinAt: (r.checkinAt as string) ?? null,
        checkoutAt: (r.checkoutAt as string) ?? null,
    }));
}

/**
 * "Hari ini" WITA DIBEKUKAN saat layar dibuka: lewat 00.00 layar tidak diam-diam memuat tanggal baru (isian tidak hilang).
 * `berganti` = jam sudah masuk hari lain; layar menawarkan `pakaiHariBaru` (pengguna yang memilih).
 * ponytail: deteksi lewat interval 30 dtk + fokus/visibilitas; penetapan tanggal oleh server = BL-28.
 */
export function useHariBeku() {
    const [hari, setHari] = useState(() => hariIniWita());
    const [kini, setKini] = useState(hari);
    useEffect(() => {
        // Diperiksa berkala dan saat ponsel kembali ke layar ini (fokus/terlihat lagi) — saat paling mungkin hari sudah berganti.
        const cek = () => setKini(hariIniWita());
        const t = setInterval(cek, 30_000);
        window.addEventListener("focus", cek);
        document.addEventListener("visibilitychange", cek);
        return () => { clearInterval(t); window.removeEventListener("focus", cek); document.removeEventListener("visibilitychange", cek); };
    }, []);
    return { hari, berganti: kini !== hari, hariBaru: kini, pakaiHariBaru: () => setHari(kini) };
}

/** YYYY-MM-DD sehari sebelum `ymd` (aritmetika tanggal kalender, tanpa zona). */
export function kemarinDari(ymd: string): string {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

// ── Toko rute untuk pemilih pelanggan Order Sales ──────────────────────────────────────────────────────
// ponytail: daftar toko rute yang SUDAH dimuat Rute hari ini disimpan di sessionStorage tab ini (tanpa API baru); Order Sales
// menawarkannya sebagai pilihan. Batasnya: hanya rute terakhir yang dibuka di tab ini. Usulan pembatasan pelanggan ke JKS = BL-32.

export const RUTE_TERSIMPAN = "fk-rute-hari-ini";
export type TokoRute = { kode: string; nama: string };

export function simpanRute(tanggal: string, salesCode: string, toko: TokoRute[]) {
    try { sessionStorage.setItem(RUTE_TERSIMPAN, JSON.stringify({ tanggal, salesCode, toko })); } catch { /* penyimpanan tidak tersedia: pemilih tidak muncul */ }
}

export function bacaRuteTersimpan(raw: string | null, tanggal: string): TokoRute[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw) as { tanggal?: string; toko?: TokoRute[] };
        return v.tanggal === tanggal && Array.isArray(v.toko) ? v.toko.filter((t) => t && typeof t.kode === "string" && t.kode) : [];
    } catch { return []; }
}
