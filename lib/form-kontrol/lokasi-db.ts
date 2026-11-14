/*
 * Tujuan: Validasi lokasi toko (owner 14 Nov 2026) — bagian Postgres:
 *   - periksaLokasiKunjungan: radius check-in/check-out (fix 20 m / validasi 100 m); di luar radius tanpa alasan = 409 DI_LUAR_RADIUS berkalimat,
 *     dengan alasan = AjuanLokasi yang ditulis bersama kunjungan (db.ts saveCheckin/saveCheckout).
 *   - Layar Validasi Lokasi (form_kontrol.manage = Admin/IT): daftarPengajuan + putuskanPengajuan (setuju = opsional pindah titik toko ke titik
 *     salesman, status fix; tolak = kunjungan tidak sah), terapkanStatusTitik (unggahan berkas selisih titik), antreanLokasi (toko tanpa titik fix
 *     + titik check-in salesman) + tetapkanTitik.
 * Caller: app/api/form-kontrol/{checkin,checkout}/route.ts, app/api/form-kontrol/lokasi/route.ts, lib/supervisor-review/{db,kontrol-db}.ts.
 * Dependensi: lib/db, db/schema, ./db (cekRadiusKunjungan, AjuanLokasi), ./radius, ./lokasi. Side Effects: baca/tulis toko_koordinat, pengajuan_lokasi.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { aoControlDaily, jksMaster, pengajuanLokasi, tokoKoordinat } from "@/db/schema";
import type { GalatOrder } from "@/lib/order-cabang";
import { cekRadiusKunjungan, type AjuanLokasi } from "./db";
import { kodeJksUntuk } from "./constants";
import { BATAS_LAT, BATAS_LNG } from "../supervisor-review/ringkasan";
import { alasanAjuanSah, kalimatLuarRadius, statusTitik, type StatusTitik } from "./radius";
import { ringkasTitikCheckin, type BarisStatusTitik, type TitikCheckin } from "./lokasi";
import type { TitikGps } from "./gps";

/** Radius kunjungan: dalam = tanpa ajuan; luar + alasan sah = ajuan; luar tanpa alasan = galat 409 DI_LUAR_RADIUS (atau 400 alasan pendek). */
export async function periksaLokasiKunjungan(custCode: string, titik: TitikGps, alasanMentah: unknown, tahap: "checkin" | "checkout", oleh: string | null)
    : Promise<{ ajuan?: AjuanLokasi } | { galat: GalatOrder }> {
    const h = await cekRadiusKunjungan(custCode, titik);
    if (h.dalam) return {};
    const label = tahap === "checkin" ? "check-in" : "check-out";
    const alasan = alasanAjuanSah(alasanMentah);
    if (!alasan) {
        const dikirim = typeof alasanMentah === "string" && alasanMentah.trim() !== "";
        return { galat: dikirim
            ? { status: 400, kode: "ALASAN_AJUAN_PENDEK", error: "Alasan pengajuan ke IT minimal 10 huruf: tulis kenapa lokasi Anda jauh dari titik toko." }
            : { status: 409, kode: "DI_LUAR_RADIUS", error: kalimatLuarRadius(h, titik.accuracy, label), jarakM: h.jarakM, radiusM: h.radiusM, statusTitik: h.statusTitik } };
    }
    return { ajuan: { tahap, lat: titik.lat, lng: titik.lng, akurasi: titik.accuracy, titikLat: h.titik.lat, titikLng: h.titik.lng, statusTitik: h.statusTitik,
        jarakM: h.jarakM, radiusM: h.radiusM, alasan, diajukanOleh: oleh } };
}

export type BarisPengajuan = typeof pengajuanLokasi.$inferSelect & { custName: string | null };

/** Pengajuan untuk layar IT: menunggu = TERLAMA dulu (tidak ada yang tenggelam), sudah diputus = terbaru dulu; maks. 300; nama toko dari JKS. */
export async function daftarPengajuan(status: "menunggu" | "disetujui" | "ditolak" = "menunggu"): Promise<BarisPengajuan[]> {
    const rows = await db.select().from(pengajuanLokasi).where(eq(pengajuanLokasi.status, status))
        .orderBy(status === "menunggu" ? asc(pengajuanLokasi.diajukanPada) : desc(pengajuanLokasi.diajukanPada)).limit(300);
    const kode = [...new Set(rows.map((r) => r.custCode))];
    const nama = kode.length === 0 ? [] : await db.selectDistinctOn([jksMaster.custCode], { custCode: jksMaster.custCode, custName: jksMaster.custName })
        .from(jksMaster).where(inArray(jksMaster.custCode, kode));
    const peta = new Map(nama.map((n) => [n.custCode, n.custName]));
    return rows.map((r) => ({ ...r, custName: peta.get(r.custCode) ?? null }));
}

/**
 * Keputusan IT atas pengajuan yang MASIH menunggu (keputusan ganda / sudah diputus = PENGAJUAN_SUDAH_DIPUTUS); pengaju tidak memutus pengajuannya
 * sendiri (PUTUS_SENDIRI). Setuju + pindahTitik = titik toko (kode kanonik: titik yang ada / kode JKS, tanpa beda huruf) diganti titik salesman
 * berstatus fix; titik di luar wilayah Indonesia ditolak sebelum menulis. Satu transaksi (baris dikunci FOR UPDATE).
 */
export async function putuskanPengajuan(id: string, keputusan: "disetujui" | "ditolak", opsi: { pindahTitik: boolean; catatan: string | null; oleh: string })
    : Promise<{ ok: true; titikDipindah: boolean } | { galat: GalatOrder }> {
    return db.transaction(async (tx) => {
        const pindah = keputusan === "disetujui" && opsi.pindahTitik;
        const [r] = await tx.select().from(pengajuanLokasi).where(and(eq(pengajuanLokasi.id, id), eq(pengajuanLokasi.status, "menunggu"))).for("update");
        if (!r) return { galat: { status: 409, kode: "PENGAJUAN_SUDAH_DIPUTUS", error: "Pengajuan ini sudah diputus atau tidak ada. Muat ulang daftar." } };
        if (r.diajukanOleh && r.diajukanOleh === opsi.oleh) {
            return { galat: { status: 403, kode: "PUTUS_SENDIRI", error: "Pengajuan yang Anda kirim sendiri harus diputus Admin (IT) lain." } };
        }
        if (pindah && !(r.lat >= BATAS_LAT[0] && r.lat <= BATAS_LAT[1] && r.lng >= BATAS_LNG[0] && r.lng <= BATAS_LNG[1])) {
            return { galat: { status: 400, kode: "TITIK_DI_LUAR_WILAYAH", error: "Titik salesman di luar wilayah Indonesia; setujui tanpa memindah titik toko." } };
        }
        await tx.update(pengajuanLokasi).set({ status: keputusan, diputuskanOleh: opsi.oleh, diputuskanPada: sql`now()`, catatanPutusan: opsi.catatan,
            titikDipindah: pindah }).where(eq(pengajuanLokasi.id, id));
        if (pindah) await simpanTitik(tx, (await kodeKanonik(tx, r.custCode)) ?? r.custCode, r.lat, r.lng, opsi.oleh);
        return { ok: true as const, titikDipindah: pindah };
    });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const kodeBesar = (kolom: typeof tokoKoordinat.custCode | typeof jksMaster.custCode) => sql`upper(btrim(${kolom}))`;

/**
 * Kode toko kanonik untuk menulis titik: kode yang SUDAH ada di toko_koordinat (tanpa beda huruf/spasi; kode lengkap dulu lalu tanpa akhiran
 * cabang), selain itu kode JKS; null = tidak dikenal. Mencegah baris kembar "C-gra010" / "C-GRA010" (JKS Web-LL menyimpan huruf apa adanya).
 */
async function kodeKanonik(tx: Tx | typeof db, custCode: string): Promise<string | null> {
    for (const k of kodeJksUntuk(custCode)) {
        const [t] = await tx.select({ c: tokoKoordinat.custCode }).from(tokoKoordinat).where(eq(kodeBesar(tokoKoordinat.custCode), k)).limit(1);
        if (t) return t.c;
        const [j] = await tx.select({ c: jksMaster.custCode }).from(jksMaster).where(eq(kodeBesar(jksMaster.custCode), k)).limit(1);
        if (j) return j.c;
    }
    return null;
}
async function simpanTitik(tx: Tx | typeof db, custCode: string, lat: number, lng: number, oleh: string, status: StatusTitik = "fix") {
    await tx.insert(tokoKoordinat).values({ custCode, lat, lng, status, diperbaruiOleh: oleh })
        .onConflictDoUpdate({ target: tokoKoordinat.custCode, set: { lat, lng, status, diperbaruiPada: sql`now()`, diperbaruiOleh: oleh } });
}

/**
 * Unggahan berkas selisih titik: 'validasi' hanya MENANDAI titik yang sudah ada (toko tanpa titik tetap tanpa radius); 'fix' + titik benar =
 * upsert titik. Satu transaksi. Kembali jumlah per hasil + kode yang tidak punya titik (contoh ≤ 20).
 */
export async function terapkanStatusTitik(baris: BarisStatusTitik[], oleh: string) {
    return db.transaction(async (tx) => {
        // Kode berkas sudah huruf besar (bacaStatusTitik); toko_koordinat menyimpan huruf apa adanya -> bandingkan tanpa beda huruf/spasi.
        const validasi = baris.filter((b) => b.status === "validasi").map((b) => b.custCode);
        const ditandai = validasi.length === 0 ? [] : await tx.update(tokoKoordinat).set({ status: "validasi", diperbaruiPada: sql`now()`, diperbaruiOleh: oleh })
            .where(inArray(kodeBesar(tokoKoordinat.custCode), validasi)).returning({ c: tokoKoordinat.custCode });
        const fix = baris.filter((b): b is Extract<BarisStatusTitik, { status: "fix" }> => b.status === "fix");
        for (const b of fix) await simpanTitik(tx, (await kodeKanonik(tx, b.custCode)) ?? b.custCode, b.lat, b.lng, oleh);
        const kena = new Set(ditandai.map((d) => d.c.trim().toUpperCase()));
        const tanpaTitik = validasi.filter((c) => !kena.has(c));
        return { ditandaiValidasi: kena.size, ditetapkanFix: fix.length, tanpaTitik: tanpaTitik.length, contohTanpaTitik: tanpaTitik.slice(0, 20) };
    });
}

/** Ringkasan status titik toko JKS aktif: fix / validasi / tanpa titik + pengajuan menunggu. */
export async function ringkasanLokasi() {
    const [r] = (await db.execute(sql`SELECT count(DISTINCT j.cust_code)::int AS toko,
            count(DISTINCT j.cust_code) FILTER (WHERE k.status = 'fix')::int AS fix,
            count(DISTINCT j.cust_code) FILTER (WHERE k.status = 'validasi')::int AS validasi,
            (SELECT count(*)::int FROM ${pengajuanLokasi} WHERE status = 'menunggu') AS menunggu
        FROM ${jksMaster} j LEFT JOIN ${tokoKoordinat} k ON upper(btrim(k.cust_code)) = upper(btrim(j.cust_code)) WHERE j.is_active`)).rows as
        { toko: number; fix: number; validasi: number; menunggu: number }[];
    return { tokoJks: r?.toko ?? 0, fix: r?.fix ?? 0, validasi: r?.validasi ?? 0, tanpaTitik: (r?.toko ?? 0) - (r?.fix ?? 0) - (r?.validasi ?? 0),
        pengajuanMenunggu: r?.menunggu ?? 0 };
}

const HARI_ANTREAN = 90;

/**
 * Antrean perbaikan lokasi: toko JKS aktif TANPA titik fix (tanpa titik / validasi) yang punya titik check-in (dan check-out) salesman dalam 90 hari
 * terakhir — owner: "check-in pertama sebagai data, nanti dinilai mana yang paling akurat". Urut: salesman terbanyak, lalu titik terbanyak; maks. 200.
 */
export async function antreanLokasi(hariIni: string) {
    const [y, m, d] = hariIni.split("-").map(Number);
    const dari = new Date(Date.UTC(y, m - 1, d) - HARI_ANTREAN * 86_400_000).toISOString().slice(0, 10);
    const [jks, titik, ao] = await Promise.all([
        db.selectDistinctOn([jksMaster.custCode], { custCode: jksMaster.custCode, custName: jksMaster.custName, alamat: jksMaster.alamat, kota: jksMaster.kota })
            .from(jksMaster).where(eq(jksMaster.isActive, true)),
        db.select({ custCode: tokoKoordinat.custCode, lat: tokoKoordinat.lat, lng: tokoKoordinat.lng, status: tokoKoordinat.status }).from(tokoKoordinat),
        db.select({ salesCode: aoControlDaily.salesCode, custCode: aoControlDaily.custCode, date: aoControlDaily.date, lat: aoControlDaily.checkinLat,
            lng: aoControlDaily.checkinLng, akurasi: aoControlDaily.checkinAccuracy }).from(aoControlDaily)
            .where(and(gte(aoControlDaily.date, dari), isNotNull(aoControlDaily.checkinLat), isNotNull(aoControlDaily.checkinLng))),
    ]);
    const tk = new Map(titik.map((t) => [t.custCode.trim().toUpperCase(), t]));
    const per = new Map<string, TitikCheckin[]>();
    for (const a of ao) {
        const k = a.custCode.trim().toUpperCase();
        const x = per.get(k) ?? [];
        x.push({ salesCode: a.salesCode, tanggal: a.date, lat: a.lat!, lng: a.lng!, akurasi: a.akurasi });
        per.set(k, x);
    }
    return jks.flatMap((j) => {
        const k = j.custCode.trim().toUpperCase();
        const t = tk.get(k);
        if (t && statusTitik(t.status) === "fix") return [];
        const kumpulan = per.get(k) ?? [];
        const tengah = ringkasTitikCheckin(kumpulan);
        if (!tengah) return [];
        return [{ custCode: j.custCode, custName: j.custName, alamat: j.alamat, kota: j.kota,
            titikSekarang: t ? { lat: t.lat, lng: t.lng, status: statusTitik(t.status) } : null, tengah,
            checkin: kumpulan.sort((a, b) => b.tanggal.localeCompare(a.tanggal)).slice(0, 20) }];
    }).sort((a, b) => b.tengah.salesman - a.tengah.salesman || b.tengah.jumlah - a.tengah.jumlah || a.custCode.localeCompare(b.custCode)).slice(0, 200);
}

/** Admin menetapkan titik toko (dari antrean: titik tengah atau satu titik check-in) -> status fix. Kode harus toko JKS. */
export async function tetapkanTitik(custCode: string, lat: number, lng: number, oleh: string): Promise<{ ok: true } | { galat: GalatOrder }> {
    const kode = await kodeKanonik(db, custCode);
    if (!kode) return { galat: { status: 404, kode: "TOKO_TIDAK_DI_JKS", error: "Kode toko tidak ada di JKS." } };
    await simpanTitik(db, kode, lat, lng, oleh);
    return { ok: true };
}
