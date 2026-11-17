/*
 * Tujuan: Nota belum lunas toko untuk Form Kontrol (owner 16 Nov 2026): "umur nota, ada berapa nota, umurnya masing-masing, pembayaran, berapa
 *   yang keluar, berapa yang tertagih, real time berdasarkan data dari Incaso". Kunjungan membaca LANGSUNG dari Accurate (sisa piutang sesudah
 *   pelunasan yang diinput Incaso), cadangan cache sales_invoice bila Accurate tidak terbaca; Rute hari ini meringkas dari cache (satu kueri).
 * Caller: app/api/form-kontrol/nota (kunjungan), lib/form-kontrol/db.ts getTodayRoute (ringkasNotaRute), app/api/form-kontrol/tagihan (Incaso).
 * Dependensi: lib/accurate-session (resolveSyncCredentials — identitas sinkron, sama dengan cron/Kasir), lib/sync (accurateHeaders),
 *   ./db (pelangganCabang), ./nota (murni), db sales_invoice + kasir_pelunasan(_faktur).
 * Main Functions: bacaNotaToko, ringkasNotaRute, daftarTagihanKunjungan.
 * Side Effects: GET Accurate sales-invoice/list.do (BACA-SAJA, ≤ 3 halaman, 8 dtk per panggilan); SELECT cache + ao_control_daily. Tidak
 *   menulis apa pun.
 *
 * Bukti bentuk kueri (lib/invoice-search.ts, produksi Okt 2026): `filter.customerId` EQUAL TERBUKTI menyempitkan; `filter.customerNo` ditolak.
 * `outstandingFilter=true` = filter siap pakai Accurate untuk faktur belum lunas (docs/prd/ACCURATE_API_REFERENCE.md §5). Pagar: baris pelanggan
 * lain dibuang, sisa ≤ Rp 0,50 dibuang (notaDariBaris) — filter yang kelak diabaikan diam-diam tidak menghasilkan angka salah, hanya daftar
 * lebih panjang (lebih dari 3 halaman = `terpotong`, tampil di layar).
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { aoControlDaily, kasirPelunasan, kasirPelunasanFaktur, salesInvoiceCache, salesProfile } from "@/db/schema";
import { resolveSyncCredentials } from "@/lib/accurate-session";
import { accurateHeaders } from "@/lib/sync";
import { pelangganCabang } from "./db";
import { notaDariBaris, ringkasNota, type BayarNota, type Nota, type NotaToko, type RingkasanNota } from "./nota";

const HALAMAN_MAKS = 3;
const PER_PANGGILAN_MS = 8_000;

type BarisAccurate = Record<string, unknown> & { customer?: { id?: unknown } | null };

/** list.do faktur belum lunas satu pelanggan. Melempar bila tidak terbaca (sesi, HTTP, s:false, bentuk asing). */
async function bacaAccurate(customerId: number): Promise<{ rows: BarisAccurate[]; terpotong: boolean; databaseId: string }> {
    const sesi = await resolveSyncCredentials();
    if (!sesi.creds) throw new Error(sesi.error);
    const rows: BarisAccurate[] = [];
    let halaman = 1, jumlahHalaman = 1;
    do {
        const q = new URLSearchParams({
            fields: "id,number,transDate,dueDate,totalAmount,primeOwing,customer",
            "filter.customerId.op": "EQUAL", "filter.customerId.val": String(customerId),
            outstandingFilter: "true", "sp.pageSize": "100", "sp.page": String(halaman),
        });
        const r = await fetch(`${sesi.creds.sessionHost}/accurate/api/sales-invoice/list.do?${q}`, {
            headers: accurateHeaders(sesi.creds), cache: "no-store", signal: AbortSignal.timeout(PER_PANGGILAN_MS) });
        const j = r.ok ? await r.json().catch(() => null) as { s?: unknown; d?: unknown; sp?: { pageCount?: unknown } } | null : null;
        if (!j || j.s !== true || !Array.isArray(j.d)) throw new Error(`Accurate tidak menjawab daftar faktur (HTTP ${r.status}).`);
        rows.push(...(j.d as BarisAccurate[]));
        const pc = Number(j.sp?.pageCount);
        jumlahHalaman = Number.isFinite(pc) && pc >= 1 ? pc : 1;
        halaman++;
    } while (halaman <= Math.min(jumlahHalaman, HALAMAN_MAKS));
    // Pagar filter pelanggan: baris yang MEMBAWA id pelanggan lain dibuang.
    const milik = rows.filter((x) => x.customer?.id == null || Number(x.customer.id) === customerId);
    return { rows: milik, terpotong: jumlahHalaman > HALAMAN_MAKS, databaseId: sesi.creds.databaseId ?? "" };
}

/** Cache sales_invoice (cron :15 + webhook): sisa > 0 untuk nomor pelanggan itu. */
async function bacaCache(customerNo: string): Promise<Record<string, unknown>[]> {
    const rows = await db.select({ id: salesInvoiceCache.id, number: salesInvoiceCache.number, transDate: salesInvoiceCache.transDate,
        dueDate: salesInvoiceCache.dueDate, totalAmount: salesInvoiceCache.totalAmount, primeOwing: salesInvoiceCache.outstanding })
        .from(salesInvoiceCache).where(and(eq(salesInvoiceCache.customerNo, customerNo), gt(salesInvoiceCache.outstanding, 0.5)));
    return rows;
}

/** Pembayaran nota yang tercatat Incaso (cache pelunasan Kasir ↔ Incaso; dibaca cron tiap 15 menit jam kerja), terbaru dulu. */
async function bacaBayar(nota: readonly Nota[], databaseId: string): Promise<BayarNota[]> {
    if (nota.length === 0) return [];
    const rows = await db.select({ fakturId: kasirPelunasanFaktur.fakturId, tanggal: kasirPelunasan.tanggal, nomor: kasirPelunasan.nomor,
        metode: kasirPelunasan.metode, nominal: kasirPelunasanFaktur.invoicePayment })
        .from(kasirPelunasanFaktur)
        .innerJoin(kasirPelunasan, and(eq(kasirPelunasan.databaseId, kasirPelunasanFaktur.databaseId), eq(kasirPelunasan.pelunasanId, kasirPelunasanFaktur.pelunasanId)))
        .where(and(inArray(kasirPelunasanFaktur.fakturId, nota.map((n) => n.id)), databaseId ? eq(kasirPelunasanFaktur.databaseId, databaseId) : undefined))
        .orderBy(desc(kasirPelunasan.tanggal)).limit(200);
    return rows.map((r) => ({ fakturId: Number(r.fakturId), tanggal: String(r.tanggal), nomor: r.nomor, metode: r.metode, nominal: Number(r.nominal) }));
}

/**
 * Nota belum lunas satu toko kunjungan: pelanggan cabang principal (kode persis / + akhiran) -> Accurate langsung; gagal -> cache (sumber
 * "sinkron"). null = toko tanpa pelanggan di cabang principal (mis. NOO, principal bukan nama cabang Accurate) — layar tidak menampilkan panel.
 * Melempar hanya bila cache juga tidak terbaca.
 */
export async function bacaNotaToko(custCode: string, principle: string, hariIni: string): Promise<NotaToko | null> {
    const pel = (await pelangganCabang([custCode], principle))(custCode);
    if (!pel) return null;
    let sumber: NotaToko["sumber"] = "accurate", terpotong = false, databaseId = "", rows: Record<string, unknown>[];
    try {
        ({ rows, terpotong, databaseId } = await bacaAccurate(pel.id));
    } catch {
        sumber = "sinkron";
        rows = await bacaCache(pel.customerNo);
    }
    const nota = notaDariBaris(rows, hariIni);
    // Pembayaran = tambahan; gagal dibaca tidak menggagalkan daftar nota.
    const bayar = await bacaBayar(nota, databaseId).catch(() => []);
    return { sumber, dibacaPada: new Date().toISOString(), nota, ringkas: ringkasNota(nota), bayar, terpotong };
}

/**
 * Layar Incaso "Tagihan kunjungan" (owner 16 Nov 2026: "munculkan ke Incaso bahwa toko sudah dikunjungi, tapi tidak tertagih dan tidak order"):
 * semua kunjungan bertanggal `tanggal` yang mencatat hasil tagih (toko bernota), dengan nama salesman/toko dan nota belum lunas SAAT INI (cache;
 * berubah sesudah Incaso menginput pelunasan). Penyaringan (tidak tertagih + tidak order, dst.) di layar.
 */
export async function daftarTagihanKunjungan(tanggal: string, hariIni: string) {
    const rows = await db.select({
        salesCode: aoControlDaily.salesCode, custCode: aoControlDaily.custCode, principle: aoControlDaily.principle,
        status: aoControlDaily.status, noOrderReasonCode: aoControlDaily.noOrderReasonCode, checkinAt: aoControlDaily.checkinAt,
        checkoutAt: aoControlDaily.checkoutAt, tagihStatus: aoControlDaily.tagihStatus, tagihNominal: aoControlDaily.tagihNominal,
        tagihAlasan: aoControlDaily.tagihAlasan, tagihCatatan: aoControlDaily.tagihCatatan, salesName: salesProfile.salesName,
        namaJks: sql<string | null>`(SELECT j.cust_name FROM jks_master j WHERE j.sales_code = ${aoControlDaily.salesCode}
            AND j.cust_code = ${aoControlDaily.custCode} AND j.principle = ${aoControlDaily.principle} ORDER BY j.is_active DESC LIMIT 1)`,
        namaLuar: sql<string | null>`(SELECT l.cust_name FROM kunjungan_luar_rute l WHERE l.sales_code = ${aoControlDaily.salesCode}
            AND l.cust_code = ${aoControlDaily.custCode} AND l.principle = ${aoControlDaily.principle} AND l.tanggal = ${aoControlDaily.date} LIMIT 1)`,
    }).from(aoControlDaily).leftJoin(salesProfile, eq(salesProfile.salesCode, aoControlDaily.salesCode))
        .where(and(eq(aoControlDaily.date, tanggal), isNotNull(aoControlDaily.tagihStatus)))
        .orderBy(asc(aoControlDaily.salesCode), asc(aoControlDaily.checkinAt));
    // Nota saat ini per principal (satu kueri cache per principal; principal per hari sedikit).
    const perPrincipal = new Map<string, (c: string) => RingkasanNota | null>();
    for (const p of new Set(rows.map((r) => r.principle))) {
        perPrincipal.set(p, await ringkasNotaRute(rows.filter((r) => r.principle === p).map((r) => r.custCode), p, hariIni));
    }
    return rows.map(({ namaJks, namaLuar, ...r }) => ({
        ...r, custName: namaJks ?? namaLuar ?? r.custCode, salesName: r.salesName ?? r.salesCode,
        tagihNominal: r.tagihNominal == null ? null : Number(r.tagihNominal),
        checkinAt: r.checkinAt?.toISOString() ?? null, checkoutAt: r.checkoutAt?.toISOString() ?? null,
        nota: perPrincipal.get(r.principle)?.(r.custCode) ?? null,
    }));
}
export type BarisTagihan = Awaited<ReturnType<typeof daftarTagihanKunjungan>>[number];

/**
 * Ringkasan nota belum lunas per toko Rute hari ini dari CACHE (satu kueri; rute bisa puluhan toko — Accurate langsung hanya di kunjungan).
 * Kembali = pencari kode -> RingkasanNota | null (null = toko tanpa pelanggan cabang / kueri gagal: tidak tampil, bukan nol palsu).
 */
export async function ringkasNotaRute(kode: string[], principle: string, hariIni: string): Promise<(c: string) => RingkasanNota | null> {
    try {
        const cari = await pelangganCabang(kode, principle);
        const pel = new Map(kode.map((c) => [c, cari(c)]));
        const nomor = [...new Set([...pel.values()].flatMap((p) => (p ? [p.customerNo] : [])))];
        const rows = nomor.length === 0 ? [] : await db.select({ customerNo: salesInvoiceCache.customerNo, id: salesInvoiceCache.id,
            number: salesInvoiceCache.number, transDate: salesInvoiceCache.transDate, dueDate: salesInvoiceCache.dueDate,
            totalAmount: salesInvoiceCache.totalAmount, primeOwing: salesInvoiceCache.outstanding })
            .from(salesInvoiceCache).where(and(inArray(salesInvoiceCache.customerNo, nomor), gt(salesInvoiceCache.outstanding, 0.5)));
        const per = new Map<string, Record<string, unknown>[]>();
        for (const r of rows) per.set(r.customerNo ?? "", [...(per.get(r.customerNo ?? "") ?? []), r]);
        return (c: string) => {
            const p = pel.get(c) ?? cari(c);
            return p ? ringkasNota(notaDariBaris(per.get(p.customerNo) ?? [], hariIni)) : null;
        };
    } catch {
        return () => null;
    }
}
