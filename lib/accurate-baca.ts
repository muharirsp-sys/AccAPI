/*
 * Tujuan: Pembaca API Accurate untuk laporan principal terjadwal (ABCPI, Enigma/Marketama) — list.do lengkap, detail.do
 *   paralel terbatas di bawah satu jatah laju bersama.
 * Caller: lib/abcpi/jalankan.ts, lib/enigma/jalankan.ts.
 * Dependensi: lib/sync (accurateHeaders), lib/accurate-redact.
 * Main Functions: ambil, daftar, rincian, hariIniWita, keAccurate.
 * Catatan: cache sales_invoice TIDAK dipakai — sync list.do memperbarui last_update tanpa mengganti rincian, dan list.do tidak
 *   memberi optLock/versi (probe 26 Okt 2026), jadi salinan lama tak bisa dibedakan dari yang terbaru.
 * Side Effects: HTTP GET ke Accurate (baca saja).
 */
import { accurateHeaders, type AccurateCredentials } from "@/lib/sync";
import { redactAccurateSecrets } from "@/lib/accurate-redact";

export type Obj = Record<string, unknown>;
export const hariIniWita = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
export const keAccurate = (iso: string) => iso.split("-").reverse().join("/");
const jeda = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Batas Accurate: 8 request/detik dan 8 proses paralel per token — token ini dipakai juga oleh sinkron & webhook, jadi SEMUA
// laporan principal di proses ini berbagi jatah ≤4 request/detik (jarak awal request ≥250 ms; uji 26 Okt: 953 dokumen ±4 menit).
let giliranBerikut = 0;
const giliran = async () => {
    const t = Math.max(Date.now(), giliranBerikut);
    giliranBerikut = t + 250;
    await jeda(t - Date.now());
};

export async function ambil(creds: AccurateCredentials, jalur: string, params: Record<string, string>) {
    const url = new URL(`${creds.sessionHost}/accurate/api${jalur}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
    for (let coba = 1; ; coba++) {
        await giliran();
        const res = await fetch(url, { headers: accurateHeaders(creds), signal: AbortSignal.timeout(60_000) }).catch((e: Error) => e);
        const body = res instanceof Error ? null : await res.json().catch(() => null) as { s?: boolean; d?: unknown; m?: unknown; sp?: Obj } | null;
        const pesan = res instanceof Error ? res.message : `HTTP ${res.status} ${String(body?.m ?? body?.d ?? "")}`;
        if (res instanceof Error || res.status === 429 || res.status >= 500 || /melebihi toleransi|request per detik/i.test(pesan)) {
            if (coba < 6) { await jeda(2000 * coba); continue; }
            throw new Error(redactAccurateSecrets(`Accurate ${jalur}: ${pesan}`).slice(0, 300));
        }
        if (!res.ok || !body?.s) throw new Error(redactAccurateSecrets(`Accurate ${jalur}: ${pesan}`).slice(0, 300));
        return body;
    }
}

/** Semua halaman list.do (urut id naik: baris baru jatuh di halaman akhir); jumlah wajib sama dengan sp.rowCount. */
export async function daftar(creds: AccurateCredentials, jalur: string, params: Record<string, string>): Promise<Obj[]> {
    for (let coba = 1; ; coba++) {
        const rows: Obj[] = [];
        let pageCount = 1, rowCount = 0;
        for (let page = 1; page <= pageCount; page++) {
            const b = await ambil(creds, jalur, { ...params, "sp.page": String(page), "sp.pageSize": "100", "sp.sort": "id|asc" });
            pageCount = Number(b.sp?.pageCount ?? 0);
            rowCount = Number(b.sp?.rowCount ?? 0);
            rows.push(...(b.d as Obj[]));
        }
        if (rows.length === rowCount && new Set(rows.map((r) => r.id)).size === rowCount) return rows;
        if (coba === 3) throw new Error(`Accurate ${jalur}: terbaca ${rows.length} dari ${rowCount} baris (data berubah saat dibaca)`);
    }
}

/** detail.do per dokumen, 4 sekaligus di bawah jatah giliran(); satu gagal = semua berhenti. */
export async function rincian(creds: AccurateCredentials, jalur: string, ids: unknown[]) {
    const hasil: unknown[] = new Array(ids.length);
    let i = 0, berhenti = false;
    await Promise.all(Array.from({ length: 4 }, async () => {
        for (let k = i++; k < ids.length && !berhenti; k = i++) {
            try { hasil[k] = (await ambil(creds, jalur, { id: String(ids[k]) })).d; } catch (e) { berhenti = true; throw e; }
        }
    }));
    return hasil;
}
