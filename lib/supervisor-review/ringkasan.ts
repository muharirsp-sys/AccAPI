/*
 * Tujuan: Perhitungan MURNI Supervisor Review (spec docs/superpowers/specs/2026-10-16-supervisor-review-design.md §2, §4, §5):
 *   baris per salesman + TOTAL per cabang, rincian kunjungan, penanda peta, tautan WhatsApp, validasi unggah koordinat.
 * Caller: lib/supervisor-review/db.ts (pemuat Postgres), app/api/supervisor-review/** (route).
 * Dependensi: lib/form-kontrol/constants.ts (jadwal JKS + kunci toko), lib/form-kontrol/noo-aturan.ts (normalHp) — keduanya murni.
 * Main Functions: hitungRingkasan, waUrl, haversineM, periksaKoordinat. Side Effects: tidak ada.
 * Kontrak keluaran: lib/supervisor-review/kontrak.ts (JANGAN diubah tanpa orkestrator).
 */
import type { Angka, BarisSalesman, JawabanSupervisorReview, Kunjungan, PenandaToko, StatusSalesman, TotalCabang } from "./kontrak";
import { DAY_TO_HARI, kodeJksUntuk, kunciHari, paritasMinggu } from "../form-kontrol/constants";
import { normalHp } from "../form-kontrol/noo-aturan";

export interface MasukanRingkasan {
    /** YYYY-MM-DD WITA. */
    tanggal: string;
    /** Baris salesman yang tampil (sudah tersaring cakupan + cabang + principle oleh pemuat). */
    salesman: { salesCode: string; nama: string; cabang: string; noHp: string | null }[];
    /** jks_master AKTIF milik salesman di atas (semua hari). */
    jks: { salesCode: string; custCode: string; custName: string; hariKunjungan: string | null; mingguPattern: string }[];
    /** ao_control_daily tanggal itu. checkinAt/checkoutAt = Date (kolom tanpa zona berisi UTC, dibaca Drizzle sebagai UTC). */
    ao: { salesCode: string; custCode: string; status: string; checkinAt: Date | null; checkoutAt: Date | null; lat: number | null; lng: number | null }[];
    /** kunjungan_luar_rute tanggal itu, belum dibatalkan. */
    luarRute: { salesCode: string; custCode: string; custName: string }[];
    /** noo_toko tanggal itu (satu entri per baris). */
    noo: { salesCode: string }[];
    /**
     * Faktur INV tanggal itu. salesCode = kode ORANG (rantai gabungan bulan itu); "" = tanpa salesman terpetakan; null = rincian belum
     * terbaca (qty_total NULL). Pemuat sudah menyaring: kode di luar `salesman` dibuang, "" / null hanya bila cakupannya boleh melihat.
     */
    faktur: { salesCode: string | null; cabang: string; customerNo: string; customerName: string; qty: number; item: number; dpp: number }[];
    /** toko_koordinat: kode JKS -> titik. */
    koordinat: ReadonlyMap<string, { lat: number; lng: number }>;
}

export type HasilRingkasan = Pick<JawabanSupervisorReview, "salesman" | "totalCabang" | "kunjungan" | "penanda" | "tokoTanpaKoordinat" | "fakturBelumTerbaca">;

export const NAMA_TANPA_SALESMAN = "Tanpa salesman terpetakan";
const STATUS_ORDER = new Set(["ordered", "active"]);
const MAKS_DAFTAR_WA = 15;
const JAM = 3_600_000;
const bulat = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const rupiah = (n: number) => `Rp ${new Intl.NumberFormat("id-ID").format(Math.round(n))}`;
/** Date (instan UTC) -> ISO WITA "YYYY-MM-DDTHH:mm:ss+08:00". */
const isoWita = (d: Date) => `${new Date(d.getTime() + 8 * JAM).toISOString().slice(0, 19)}+08:00`;

/** Jarak dua titik (meter), haversine R = 6 371 km. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const r = (x: number) => (x * Math.PI) / 180;
    const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** https://wa.me/628…?text=… ; nomor tidak sah / kosong = null (tombol nonaktif). */
export function waUrl(noHp: string | null | undefined, teks: string): string | null {
    const hp = normalHp(noHp);
    return hp ? `https://wa.me/62${hp.slice(1)}?text=${encodeURIComponent(teks)}` : null;
}

/** Jadwal JKS hari itu — filter SAMA dengan getTodayRoute (lib/form-kontrol/db.ts): kunci hari + pola minggu ∈ {all, paritas}. */
function terjadwal(tanggal: string) {
    const [y, m, d] = tanggal.split("-").map(Number);
    const hari = DAY_TO_HARI[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    const pola = new Set(["all", paritasMinggu(tanggal)]);
    return (j: { hariKunjungan: string | null; mingguPattern: string }) =>
        Boolean(hari) && kunciHari(j.hariKunjungan) === kunciHari(hari) && pola.has(String(j.mingguPattern ?? "").trim().toLowerCase());
}

function koordinatToko(kode: string, koordinat: MasukanRingkasan["koordinat"]) {
    for (const k of [kode, ...kodeJksUntuk(kode)]) { const t = koordinat.get(k); if (t) return t; }
    return null;
}

type Kunj = { custCode: string; mulai: Date; selesai: Date | null; lat: number | null; lng: number | null };
type Fak = { qty: number; item: number; dpp: number; nama: string };
type Hitung = Angka & { jumlahItem: number };

function angkaKosong(): Hitung {
    return { registeredOutlet: 0, callPlan: 0, callRute: 0, callNonRute: 0, ec: 0, noo: 0, quantity: 0, itemPerEc: 0, nilaiOrder: 0,
        omzetPerEc: 0, jamDiToko: 0, jamPerjalanan: 0, jumlahItem: 0 };
}
/** Rasio dari jumlah (juga untuk TOTAL cabang: Σitem ÷ ΣEC, bukan rata-rata rasio). */
function rapikan(h: Hitung): Angka {
    const { jumlahItem, ...a } = h;
    return { ...a, quantity: bulat(a.quantity), nilaiOrder: bulat(a.nilaiOrder), jamDiToko: bulat(a.jamDiToko), jamPerjalanan: bulat(a.jamPerjalanan),
        itemPerEc: a.ec ? bulat(jumlahItem / a.ec) : 0, omzetPerEc: a.ec ? bulat(a.nilaiOrder / a.ec) : 0 };
}

export function hitungRingkasan(m: MasukanRingkasan): HasilRingkasan {
    const hariIni = terjadwal(m.tanggal);
    const per = <T extends { salesCode: string | null }>(xs: T[]) => {
        const p = new Map<string, T[]>();
        for (const x of xs) if (x.salesCode !== null) p.set(x.salesCode, [...(p.get(x.salesCode) ?? []), x]);
        return p;
    };
    const jksPer = per(m.jks), aoPer = per(m.ao), luarPer = per(m.luarRute), nooPer = per(m.noo), fakPer = per(m.faktur);

    // Baris "Tanpa salesman terpetakan" per cabang yang punya faktur seperti itu.
    const daftar = [...m.salesman.map((s) => ({ ...s, tanpa: false })),
        ...[...new Set(m.faktur.filter((f) => f.salesCode === "").map((f) => f.cabang))]
            .map((cabang) => ({ salesCode: "", nama: NAMA_TANPA_SALESMAN, cabang, noHp: null, tanpa: true }))];

    const salesman: BarisSalesman[] = [], kunjungan: Kunjungan[] = [], penanda: PenandaToko[] = [];
    const total = new Map<string, Hitung>();
    for (const s of daftar) {
        const jks = s.tanpa ? [] : jksPer.get(s.salesCode) ?? [];
        const ao = s.tanpa ? [] : aoPer.get(s.salesCode) ?? [];
        const luar = s.tanpa ? [] : luarPer.get(s.salesCode) ?? [];
        const fakS = (fakPer.get(s.salesCode) ?? []).filter((f) => !s.tanpa || f.cabang === s.cabang);
        const nama = new Map<string, string>([...jks.map((j) => [j.custCode, j.custName] as const), ...luar.map((l) => [l.custCode, l.custName] as const)]);
        const rencana = new Set(jks.filter(hariIni).map((j) => j.custCode));

        // Satu toko satu kunjungan (baris ao per principal digabung): mulai = check-in paling awal, selesai = check-out paling akhir bila
        // SEMUA baris ber-check-in sudah check-out (selain itu masih di toko). GPS = titik check-in paling awal.
        const kunj = new Map<string, Kunj>();
        for (const a of [...ao].filter((x) => x.checkinAt).sort((x, y) => x.checkinAt!.getTime() - y.checkinAt!.getTime())) {
            const k = kunj.get(a.custCode);
            if (!k) kunj.set(a.custCode, { custCode: a.custCode, mulai: a.checkinAt!, selesai: a.checkoutAt, lat: a.lat, lng: a.lng });
            else k.selesai = k.selesai && a.checkoutAt ? new Date(Math.max(k.selesai.getTime(), a.checkoutAt.getTime())) : null;
        }
        const urutKunj = [...kunj.values()].sort((x, y) => x.mulai.getTime() - y.mulai.getTime());

        // Toko faktur -> kode toko yang sudah dikenal salesman (JKS / kunjungan / luar rute; kode lengkap dulu, lalu tanpa akhiran cabang),
        // selain itu kode lengkap pelanggan Accurate (kodeJksUntuk, lib/form-kontrol/constants.ts).
        const dikenal = new Set([...jks.map((j) => j.custCode), ...ao.map((a) => a.custCode), ...luar.map((l) => l.custCode)]);
        const fak = new Map<string, Fak>();
        for (const f of fakS) {
            const calon = kodeJksUntuk(f.customerNo);
            const kode = calon.find((c) => dikenal.has(c)) ?? calon[0] ?? f.customerNo;
            const x = fak.get(kode) ?? { qty: 0, item: 0, dpp: 0, nama: f.customerName };
            fak.set(kode, { ...x, qty: x.qty + f.qty, item: x.item + f.item, dpp: x.dpp + f.dpp });
        }
        const order = new Set(ao.filter((a) => STATUS_ORDER.has(a.status)).map((a) => a.custCode));
        const ec = new Set([...order, ...fak.keys()]);

        // ponytail: Call Non Rute (a) = toko di-check-in di LUAR rencana hari itu. Di alur getTodayRoute itu hanya kunjungan_luar_rute; bila
        //   JKS diubah sesudah kunjungan, kunjungannya tetap terhitung di sini (tidak hilang) alih-alih lenyap dari tabel.
        const h = angkaKosong();
        h.registeredOutlet = new Set(jks.map((j) => j.custCode)).size;
        h.callPlan = rencana.size;
        h.callRute = urutKunj.filter((k) => rencana.has(k.custCode)).length;
        h.callNonRute = urutKunj.filter((k) => !rencana.has(k.custCode)).length + [...fak.keys()].filter((c) => !kunj.has(c)).length;
        h.ec = ec.size;
        h.noo = (nooPer.get(s.salesCode) ?? []).length * (s.tanpa ? 0 : 1);
        for (const f of fak.values()) { h.quantity += f.qty; h.jumlahItem += f.item; h.nilaiOrder += f.dpp; }
        let sebelum: Kunj | null = null;
        for (const k of urutKunj) {
            if (k.selesai) h.jamDiToko += (k.selesai.getTime() - k.mulai.getTime()) / JAM;
            const tempuh = sebelum?.selesai ? Math.max(0, k.mulai.getTime() - sebelum.selesai.getTime()) : null;
            if (tempuh !== null) h.jamPerjalanan += tempuh / JAM;
            const f = fak.get(k.custCode), toko = koordinatToko(k.custCode, m.koordinat);
            kunjungan.push({ salesCode: s.salesCode, custCode: k.custCode, namaToko: nama.get(k.custCode) ?? f?.nama ?? k.custCode,
                jenis: rencana.has(k.custCode) ? "rute" : "luar_rute", mulai: isoWita(k.mulai), selesai: k.selesai ? isoWita(k.selesai) : null,
                menitDiToko: k.selesai ? Math.round((k.selesai.getTime() - k.mulai.getTime()) / 60_000) : null,
                menitTempuh: tempuh === null ? null : Math.round(tempuh / 60_000),
                qty: f ? bulat(f.qty) : null, item: f ? f.item : null, nilai: f ? bulat(f.dpp) : null,
                ec: ec.has(k.custCode), belumDifakturkan: order.has(k.custCode) && !f, lat: k.lat, lng: k.lng,
                jarakKeTokoM: toko && k.lat !== null && k.lng !== null ? Math.round(haversineM({ lat: k.lat, lng: k.lng }, toko)) : null });
            sebelum = k;
        }
        for (const [kode, f] of [...fak].filter(([c]) => !kunj.has(c)).sort(([a], [b]) => a.localeCompare(b))) {
            kunjungan.push({ salesCode: s.salesCode, custCode: kode, namaToko: nama.get(kode) ?? f.nama, jenis: "tanpa_checkin", mulai: null, selesai: null,
                menitDiToko: null, menitTempuh: null, qty: bulat(f.qty), item: f.item, nilai: bulat(f.dpp), ec: true, belumDifakturkan: false,
                lat: null, lng: null, jarakKeTokoM: null });
        }
        for (const kode of new Set([...rencana, ...kunj.keys(), ...fak.keys()])) {
            const toko = koordinatToko(kode, m.koordinat);
            if (!toko) continue;
            penanda.push({ custCode: kode, namaToko: nama.get(kode) ?? fak.get(kode)?.nama ?? kode, salesCode: s.salesCode, lat: toko.lat, lng: toko.lng,
                status: kunj.has(kode) ? (ec.has(kode) ? "ec" : "tanpa_ec") : fak.has(kode) ? "faktur_tanpa_checkin" : "belum" });
        }

        const status: StatusSalesman = urutKunj.length === 0 ? "belum" : urutKunj.some((k) => !k.selesai) ? "di_toko" : "sudah";
        const belum = jks.filter((j) => rencana.has(j.custCode) && !kunj.has(j.custCode));
        const angka = rapikan(h);
        const [y, mo, d] = m.tanggal.split("-");
        const teks = [`Ringkasan kunjungan ${d}/${mo}/${y} — ${s.nama}`, `Call Plan: ${angka.callPlan}`,
            `Call Rute: ${angka.callRute} · Call Non Rute: ${angka.callNonRute}`, `EC: ${angka.ec}`, `Nilai Order: ${rupiah(angka.nilaiOrder)}`,
            ...(belum.length ? [`Toko terjadwal belum dikunjungi (${belum.length}):`,
                ...belum.slice(0, MAKS_DAFTAR_WA).map((j) => `- ${j.custCode} ${j.custName}`),
                ...(belum.length > MAKS_DAFTAR_WA ? [`dan ${belum.length - MAKS_DAFTAR_WA} lainnya`] : [])] : [])].join("\n");
        salesman.push({ cabang: s.cabang, salesCode: s.salesCode, nama: s.nama, status, waUrl: s.tanpa ? null : waUrl(s.noHp, teks), ...angka });

        const t = total.get(s.cabang) ?? angkaKosong();
        for (const k of Object.keys(t) as (keyof Hitung)[]) t[k] += h[k];
        total.set(s.cabang, t);
    }

    const tanpaKoordinat = new Set(m.jks.map((j) => j.custCode).filter((c) => !koordinatToko(c, m.koordinat)));
    const belumTerbaca = new Map<string, number>();
    for (const f of m.faktur) if (f.salesCode === null) belumTerbaca.set(f.cabang, (belumTerbaca.get(f.cabang) ?? 0) + 1);
    const urutCabang = (a: string, b: string) => a.localeCompare(b, "id");
    return {
        salesman: salesman.sort((a, b) => urutCabang(a.cabang, b.cabang) || Number(a.salesCode === "") - Number(b.salesCode === "")
            || a.nama.localeCompare(b.nama, "id") || a.salesCode.localeCompare(b.salesCode)),
        totalCabang: [...total].map(([cabang, h]): TotalCabang => ({ cabang, ...rapikan(h) })).sort((a, b) => urutCabang(a.cabang, b.cabang)),
        kunjungan: kunjungan.sort((a, b) => a.salesCode.localeCompare(b.salesCode)
            || Number(a.mulai === null) - Number(b.mulai === null) || (a.mulai ?? "").localeCompare(b.mulai ?? "")),
        penanda,
        tokoTanpaKoordinat: tanpaKoordinat.size,
        fakturBelumTerbaca: [...belumTerbaca].map(([cabang, jumlah]) => ({ cabang, jumlah })).sort((a, b) => urutCabang(a.cabang, b.cabang)),
    };
}

/** Wilayah Indonesia (sama dengan CHECK toko_koordinat_wilayah). */
export const BATAS_LAT = [-11, 6] as const, BATAS_LNG = [95, 141] as const;
const angkaSel = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = String(v ?? "").trim().replace(/^(-?\d+),(\d+)$/, "$1.$2");
    return s && Number.isFinite(Number(s)) ? Number(s) : null;
};

/**
 * Unggah koordinat (spec §3.3): satu baris Excel -> sah atau ditolak (nomor baris Excel). `kodeJks` = kode jks_master huruf besar -> ejaan
 * tersimpan. Baris kosong total dilewati diam-diam; kode ganda di berkas = baris sah pertama yang dipakai, berikutnya ditolak.
 */
export function periksaKoordinat(baris: { baris: number; kode: unknown; lat: unknown; lng: unknown }[], kodeJks: ReadonlyMap<string, string>) {
    const sah: { custCode: string; lat: number; lng: number }[] = [];
    const ditolak: { baris: number; kode: string; pesan: string }[] = [];
    const dipakai = new Map<string, number>();
    for (const b of baris) {
        const kode = String(b.kode ?? "").trim();
        if (!kode && String(b.lat ?? "").trim() === "" && String(b.lng ?? "").trim() === "") continue;
        const custCode = kodeJks.get(kode.toUpperCase());
        const lat = angkaSel(b.lat), lng = angkaSel(b.lng);
        const pesan = !kode ? "Kode toko kosong."
            : !custCode ? `Kode toko ${kode} tidak ada di JKS.`
            : lat === null || lng === null ? "Latitude/longitude bukan angka."
            : lat < BATAS_LAT[0] || lat > BATAS_LAT[1] || lng < BATAS_LNG[0] || lng > BATAS_LNG[1]
                ? `Titik di luar wilayah Indonesia (lat ${BATAS_LAT.join("…")}, lng ${BATAS_LNG.join("…")}).`
            : dipakai.has(custCode) ? `Kode ganda di berkas; baris ${dipakai.get(custCode)} yang dipakai.` : null;
        if (pesan) { ditolak.push({ baris: b.baris, kode, pesan }); continue; }
        dipakai.set(custCode!, b.baris);
        sah.push({ custCode: custCode!, lat: lat!, lng: lng! });
    }
    return { sah, ditolak };
}
