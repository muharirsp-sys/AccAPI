/*
 * Tujuan: Perhitungan MURNI panel "Kontrol bulan ini" Supervisor Review (owner 13 Nov 2026): per salesman, dari tanggal 1 s.d. tanggal tampilan —
 *   order yang dilaporkan di Form Kontrol vs faktur Accurate (batas berbeda untuk dua tipe sales), toko pindahan / outlet potensi / kelas A yang
 *   sudah order, target toko vs omzet faktur, penawaran item super + alasan, dan toko berlokasi perkiraan.
 *   Owner 14 Nov 2026: analisa kunjungan GPS — titik check-in/check-out vs toko_koordinat (jauh > JARAK_JAUH_M), kunjungan tanpa GPS, lama di
 *   toko (rata-rata + singkat < 5 menit, sama dengan Dashboard SPV) — bahan briefing; kunjungan jauh dirinci.
 * Caller: lib/supervisor-review/kontrol-db.ts (pemuat), uji lib/supervisor-review/kontrol.test.ts.
 * Dependensi: lib/form-kontrol/constants (kodeJksUntuk, lokasiPerkiraan), lib/form-kontrol/item-super (ALASAN_ITEM_SUPER) — semuanya murni.
 * Main Functions: hitungKontrol, BATAS_FAKTUR_HARI. Side Effects: tidak ada.
 */
import { kodeJksUntuk, lokasiPerkiraan } from "../form-kontrol/constants";
import { ALASAN_ITEM_SUPER } from "../form-kontrol/item-super";
import { JARAK_JAUH_M } from "./kontrak";
import { haversineM } from "./ringkasan";

export type SumberOrder = "accapi" | "principal";
/**
 * Hari yang ditunggu sampai ORDER yang dilaporkan dianggap terlambat difakturkan (owner 13 Nov 2026: dua tipe sales). accapi = order di AccAPI,
 * faktur hari itu / besok; principal = order di sistem principal, faktur masuk sesudah admin menarik laporan principal. ponytail: angka awal,
 * setel dari data nyata keterlambatan per principal.
 */
export const BATAS_FAKTUR_HARI: Record<SumberOrder, number> = { accapi: 1, principal: 3 };
const MAKS_DAFTAR = 30;
/** Kunjungan "singkat" (menit) — sama dengan durasi_singkat Dashboard SPV (lib/form-kontrol/db.ts getSpvDashboard). */
export const MENIT_SINGKAT = 5;

export interface MasukanKontrol {
    /** YYYY-MM-DD WITA (≤ hari ini); periode = tanggal 1 bulan itu s.d. tanggal ini. */
    tanggal: string;
    salesman: { salesCode: string; nama: string; cabang: string; sumberOrder: SumberOrder }[];
    jks: { salesCode: string; custCode: string; custName: string; kategori: string | null; kelasA: boolean | null; statusJks: string | null;
        targetToko: number | null; lokasiDari: string | null }[];
    /** ao_control_daily periode itu. Waktu + titik check-in/check-out (0042) untuk analisa kunjungan GPS; tanpa = tidak dianalisa. */
    ao: { salesCode: string; custCode: string; date: string; status: string; nomorOrder: string | null; checkin: boolean;
        checkinAt?: Date | null; checkoutAt?: Date | null; lat?: number | null; lng?: number | null; latKeluar?: number | null; lngKeluar?: number | null }[];
    /** toko_koordinat: kode toko -> titik (kode Accurate berakhiran cabang dicocokkan lewat kodeJksUntuk). */
    koordinat?: ReadonlyMap<string, { lat: number; lng: number }>;
    /**
     * Faktur INV periode itu. salesCode = kode orang hasil peta salesman; "" = tanpa salesman terpetakan (dihitung untuk toko JKS siapa pun);
     * kode salesman lain = bukan milik salesman ini.
     */
    faktur: { salesCode: string; customerNo: string; tanggal: string; total: number }[];
    tawaran: { salesCode: string; ditawarkan: boolean; dipesan: boolean | null; alasan: string | null }[];
    /** pengajuan_lokasi periode itu (owner 14 Nov 2026). */
    ajuan?: { salesCode: string; status: string }[];
}

export interface BarisKontrol {
    salesCode: string; nama: string; cabang: string; sumberOrder: SumberOrder;
    order: { dilaporkan: number; berfaktur: number; menunggu: number; terlambat: number };
    /** ORDER yang lewat batas tanpa faktur (maks. 30, terlama dulu). */
    orderTerlambat: { custCode: string; namaToko: string; tanggal: string; nomorOrder: string | null }[];
    pindahan: { total: number; order: number };
    potensi: { total: number; dikunjungi: number; order: number };
    kelasA: { total: number; order: number };
    target: { target: number; realisasi: number };
    itemSuper: { saran: number; ditawarkan: number; dipesan: number; alasan: { kode: string; label: string; jumlah: number }[] };
    lokasiPerkiraan: number;
    /**
     * Analisa kunjungan GPS (owner 14 Nov 2026). kunjungan = baris ber-check-in; terukur = check-in ber-GPS di toko berkoordinat; masukJauh /
     * keluarJauh = titik check-in / check-out > JARAK_JAUH_M dari toko; rataMenit = rata-rata check-in→check-out (null = belum ada yang selesai).
     */
    gps: { kunjungan: number; tanpaGps: number; terukur: number; masukJauh: number; keluarJauh: number; rataMenit: number | null; singkat: number;
        /** Kunjungan dengan check-in ATAU check-out jauh (jumlah penuh; daftar kunjunganJauh dipotong 30). */
        jauh: number;
        /** Pengajuan lokasi ke IT (check-in/check-out di luar radius titik toko): menunggu / ditolak. */
        ajuanMenunggu: number; ajuanDitolak: number };
    /** Kunjungan dengan check-in atau check-out jauh dari toko (maks. 30, terbaru dulu). */
    kunjunganJauh: { custCode: string; namaToko: string; tanggal: string; masukM: number | null; keluarM: number | null }[];
}

const tambahHari = (ymd: string, n: number) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
};
const ORDER = new Set(["ordered", "active"]);
const LABEL_ALASAN = new Map<string, string>(ALASAN_ITEM_SUPER.map((a) => [a.kode, a.label]));

export function hitungKontrol(m: MasukanKontrol): BarisKontrol[] {
    return m.salesman.map((s) => {
        const jks = m.jks.filter((j) => j.salesCode === s.salesCode);
        const kodeToko = new Map(jks.map((j) => [j.custCode.trim().toUpperCase(), j]));
        const tokoDari = (kode: string) => kodeJksUntuk(kode).find((k) => kodeToko.has(k));
        // Faktur toko JKS salesman ini (atau tanpa salesman terpetakan): toko -> tanggal faktur + total.
        const fak = new Map<string, { tanggal: Set<string>; total: number }>();
        for (const f of m.faktur) {
            if (f.salesCode !== s.salesCode && f.salesCode !== "") continue;
            const t = tokoDari(f.customerNo);
            if (!t) continue;
            const x = fak.get(t) ?? { tanggal: new Set<string>(), total: 0 };
            x.tanggal.add(f.tanggal); x.total += f.total;
            fak.set(t, x);
        }
        const ao = m.ao.filter((a) => a.salesCode === s.salesCode);
        const orderToko = new Set<string>();
        const order = { dilaporkan: 0, berfaktur: 0, menunggu: 0, terlambat: 0 };
        const terlambat: BarisKontrol["orderTerlambat"] = [];
        const batas = BATAS_FAKTUR_HARI[s.sumberOrder];
        for (const a of ao.filter((x) => ORDER.has(x.status)).sort((x, y) => x.date.localeCompare(y.date))) {
            order.dilaporkan++;
            const t = tokoDari(a.custCode) ?? a.custCode.trim().toUpperCase();
            orderToko.add(t);
            const hari = Array.from({ length: batas + 1 }, (_, i) => tambahHari(a.date, i));
            if (hari.some((h) => fak.get(t)?.tanggal.has(h))) order.berfaktur++;
            else if (hari.at(-1)! >= m.tanggal) order.menunggu++;
            else {
                order.terlambat++;
                if (terlambat.length < MAKS_DAFTAR) terlambat.push({ custCode: a.custCode, namaToko: kodeToko.get(t)?.custName ?? a.custCode, tanggal: a.date, nomorOrder: a.nomorOrder });
            }
        }
        const sudahOrder = (j: { custCode: string }) => { const k = j.custCode.trim().toUpperCase(); return fak.has(k) || orderToko.has(k); };
        // Dikunjungi = ada check-in (sama dengan Call Supervisor Review); bintang prioritas / "tidak dikunjungi" tanpa check-in bukan kunjungan.
        const dikunjungi = new Set(ao.filter((a) => a.checkin).map((a) => tokoDari(a.custCode) ?? a.custCode.trim().toUpperCase()));
        const pindahan = jks.filter((j) => j.statusJks === "PINDAH SALES" || j.statusJks === "BARU DITUGASKAN");
        const potensi = jks.filter((j) => j.kategori === "OUTLET POTENSI");
        const kelasA = jks.filter((j) => j.kelasA);
        const tawaran = m.tawaran.filter((t) => t.salesCode === s.salesCode);
        const alasan = new Map<string, number>();
        for (const t of tawaran) if (t.dipesan !== true && t.alasan) alasan.set(t.alasan, (alasan.get(t.alasan) ?? 0) + 1);
        // Analisa kunjungan GPS: satu kunjungan = satu toko per tanggal (baris AO beberapa principal digabung seperti ringkasan harian: mulai =
        // check-in paling awal + titiknya, selesai = check-out paling akhir bila SEMUA baris sudah check-out + titiknya). Titik toko lewat kode
        // lengkap lalu tanpa akhiran cabang.
        type Kunj = { custCode: string; date: string; checkinAt: Date; checkoutAt: Date | null; lat?: number | null; lng?: number | null;
            latKeluar?: number | null; lngKeluar?: number | null };
        const kunj = new Map<string, Kunj>();
        for (const a of ao.filter((x) => x.checkinAt).sort((x, y) => x.checkinAt!.getTime() - y.checkinAt!.getTime())) {
            const kunci = `${a.date}|${tokoDari(a.custCode) ?? a.custCode.trim().toUpperCase()}`;
            const k = kunj.get(kunci);
            if (!k) { kunj.set(kunci, { custCode: a.custCode, date: a.date, checkinAt: a.checkinAt!, checkoutAt: a.checkoutAt ?? null, lat: a.lat, lng: a.lng,
                latKeluar: a.latKeluar, lngKeluar: a.lngKeluar }); continue; }
            if (k.checkoutAt && a.checkoutAt && a.checkoutAt.getTime() >= k.checkoutAt.getTime()) Object.assign(k, { latKeluar: a.latKeluar, lngKeluar: a.lngKeluar });
            k.checkoutAt = k.checkoutAt && a.checkoutAt ? new Date(Math.max(k.checkoutAt.getTime(), a.checkoutAt.getTime())) : null;
        }
        const ajuan = (m.ajuan ?? []).filter((a) => a.salesCode === s.salesCode);
        const gps: BarisKontrol["gps"] = { kunjungan: 0, tanpaGps: 0, terukur: 0, masukJauh: 0, keluarJauh: 0, rataMenit: null, singkat: 0, jauh: 0,
            ajuanMenunggu: ajuan.filter((a) => a.status === "menunggu").length, ajuanDitolak: ajuan.filter((a) => a.status === "ditolak").length };
        const jauh: BarisKontrol["kunjunganJauh"] = [];
        let menit = 0, selesai = 0;
        for (const a of [...kunj.values()].sort((x, y) => y.checkinAt.getTime() - x.checkinAt.getTime())) {
            gps.kunjungan++;
            const toko = kodeJksUntuk(a.custCode).map((k) => m.koordinat?.get(k)).find(Boolean) ?? null;
            const jarak = (lat?: number | null, lng?: number | null) =>
                toko && typeof lat === "number" && typeof lng === "number" ? Math.round(haversineM({ lat, lng }, toko)) : null;
            const masukM = jarak(a.lat, a.lng), keluarM = a.checkoutAt ? jarak(a.latKeluar, a.lngKeluar) : null;
            if (typeof a.lat !== "number") gps.tanpaGps++;
            if (masukM !== null) gps.terukur++;
            const jauhMasuk = masukM !== null && masukM > JARAK_JAUH_M, jauhKeluar = keluarM !== null && keluarM > JARAK_JAUH_M;
            if (jauhMasuk) gps.masukJauh++;
            if (jauhKeluar) gps.keluarJauh++;
            if (jauhMasuk || jauhKeluar) gps.jauh++;
            if ((jauhMasuk || jauhKeluar) && jauh.length < MAKS_DAFTAR) {
                const t = tokoDari(a.custCode);
                jauh.push({ custCode: a.custCode, namaToko: (t && kodeToko.get(t)?.custName) || a.custCode, tanggal: a.date, masukM, keluarM });
            }
            if (a.checkoutAt) {
                const mnt = Math.max(0, (a.checkoutAt.getTime() - a.checkinAt.getTime()) / 60_000);
                menit += mnt; selesai++;
                if (mnt < MENIT_SINGKAT) gps.singkat++;
            }
        }
        gps.rataMenit = selesai ? Math.round(menit / selesai) : null;
        return {
            salesCode: s.salesCode, nama: s.nama, cabang: s.cabang, sumberOrder: s.sumberOrder, order, orderTerlambat: terlambat,
            pindahan: { total: pindahan.length, order: pindahan.filter(sudahOrder).length },
            potensi: { total: potensi.length, dikunjungi: potensi.filter((j) => dikunjungi.has(j.custCode.trim().toUpperCase())).length, order: potensi.filter(sudahOrder).length },
            kelasA: { total: kelasA.length, order: kelasA.filter(sudahOrder).length },
            target: { target: jks.reduce((n, j) => n + (j.targetToko ?? 0), 0), realisasi: [...fak.values()].reduce((n, f) => n + f.total, 0) },
            itemSuper: { saran: tawaran.length, ditawarkan: tawaran.filter((t) => t.ditawarkan).length, dipesan: tawaran.filter((t) => t.dipesan === true).length,
                alasan: [...alasan].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([kode, jumlah]) => ({ kode, label: LABEL_ALASAN.get(kode) ?? kode, jumlah })) },
            lokasiPerkiraan: jks.filter((j) => lokasiPerkiraan(j.lokasiDari)).length,
            gps, kunjunganJauh: jauh,
        };
    }).sort((a, b) => a.cabang.localeCompare(b.cabang, "id") || a.nama.localeCompare(b.nama, "id"));
}
