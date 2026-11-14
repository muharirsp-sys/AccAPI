/*
 * Tujuan: Validasi lokasi toko (owner 14 Nov 2026) — bagian MURNI:
 *   1) bacaStatusTitik: berkas audit "selisih titik vs alamat" Web-LL (sheet 1_SANGAT_BERBEDA, 2_BERBEDA, 3_ALAMAT_KELIRU) -> toko yang titiknya
 *      perlu VALIDASI (radius 100 m); baris yang LATITUDE BENAR + LONGITUDE BENAR-nya sudah diisi pemeriksa -> titik baru berstatus FIX (20 m).
 *   2) ringkasTitikCheckin: toko tanpa titik fix -> kumpulan titik check-in salesman (owner: "check-in pertama sebagai data, nanti dinilai mana
 *      yang paling akurat") -> titik tengah (median) + sebaran, bahan Admin menetapkan titik toko.
 * Caller: lib/form-kontrol/lokasi-db.ts, app/api/form-kontrol/lokasi/route.ts, layar tabs/TabLokasi.tsx; uji ./peta.test.ts.
 * Main Functions: SHEET_STATUS_TITIK, bacaStatusTitik, ringkasTitikCheckin. Side Effects: tidak ada.
 */
import { BATAS_LAT, BATAS_LNG, haversineM } from "../supervisor-review/ringkasan";

/** Sheet berkas selisih titik yang menandai titik toko perlu validasi (urut = prioritas tampil). */
export const SHEET_STATUS_TITIK = ["1_SANGAT_BERBEDA", "2_BERBEDA", "3_ALAMAT_KELIRU"] as const;
const LABEL_SHEET: Record<(typeof SHEET_STATUS_TITIK)[number], string> = {
    "1_SANGAT_BERBEDA": "Sangat berbeda", "2_BERBEDA": "Berbeda", "3_ALAMAT_KELIRU": "Alamat keliru",
};

export type BarisStatusTitik = { custCode: string; sheet: string; status: "validasi" } | { custCode: string; sheet: string; status: "fix"; lat: number; lng: number };
export type HasilStatusTitik = { baris: BarisStatusTitik[]; galat: { sheet: string; baris: number; pesan: string }[]; sheetDibaca: string[] };

const kunci = (v: unknown) => String(v ?? "").trim().toUpperCase();
const angka = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = String(v ?? "").trim().replace(",", ".");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};
const dalamIndonesia = (lat: number, lng: number) => lat >= BATAS_LAT[0] && lat <= BATAS_LAT[1] && lng >= BATAS_LNG[0] && lng <= BATAS_LNG[1];

/**
 * `sheets` = nama sheet -> baris objek (header baris 1: KODE0, LATITUDE BENAR, LONGITUDE BENAR, …). Kode ganda antar sheet: yang pertama
 * (prioritas sheet) menang, kecuali baris lain membawa titik benar (fix menang). Titik benar setengah / bukan angka / di luar Indonesia = galat
 * per baris dan toko itu tetap 'validasi'.
 */
export function bacaStatusTitik(sheets: Record<string, Record<string, unknown>[]>): HasilStatusTitik {
    const per = new Map<string, BarisStatusTitik>();
    const galat: HasilStatusTitik["galat"] = [];
    const sheetDibaca: string[] = [];
    for (const nama of SHEET_STATUS_TITIK) {
        const asli = Object.keys(sheets).find((k) => k.trim().toUpperCase() === nama);
        if (!asli) continue;
        sheetDibaca.push(asli);
        sheets[asli].forEach((r, i) => {
            const custCode = kunci(r["KODE0"] ?? r["KODE TOKO"] ?? r["KODE"]);
            if (!custCode) return;
            const lat = angka(r["LATITUDE BENAR"]), lng = angka(r["LONGITUDE BENAR"]);
            const adaIsian = String(r["LATITUDE BENAR"] ?? "").trim() !== "" || String(r["LONGITUDE BENAR"] ?? "").trim() !== "";
            let baris: BarisStatusTitik = { custCode, sheet: LABEL_SHEET[nama], status: "validasi" };
            if (adaIsian) {
                if (lat === null || lng === null || !dalamIndonesia(lat, lng)) {
                    galat.push({ sheet: asli, baris: i + 2, pesan: `${custCode}: LATITUDE/LONGITUDE BENAR harus dua angka di wilayah Indonesia; titik toko tetap perlu validasi.` });
                } else baris = { custCode, sheet: LABEL_SHEET[nama], status: "fix", lat, lng };
            }
            const lama = per.get(custCode);
            if (!lama || (lama.status === "validasi" && baris.status === "fix")) per.set(custCode, baris);
        });
    }
    return { baris: [...per.values()], galat, sheetDibaca };
}

export type TitikCheckin = { salesCode: string; tanggal: string; lat: number; lng: number; akurasi: number | null };

/**
 * Titik tengah kumpulan check-in = median lintang & bujur terpisah (tahan pencilan, mis. satu check-in dari rumah); sebaran = jarak terjauh
 * titik ke tengah (m); salesman = jumlah salesman berbeda. Kosong = null.
 */
export function ringkasTitikCheckin(titik: TitikCheckin[]): { lat: number; lng: number; sebaranM: number; jumlah: number; salesman: number } | null {
    if (titik.length === 0) return null;
    const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const tengah = { lat: median(titik.map((t) => t.lat)), lng: median(titik.map((t) => t.lng)) };
    return { ...tengah, sebaranM: Math.round(Math.max(...titik.map((t) => haversineM(t, tengah)))), jumlah: titik.length,
        salesman: new Set(titik.map((t) => t.salesCode)).size };
}
