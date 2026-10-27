/*
 * Tujuan: Pemuat Postgres Supervisor Review (spec docs/superpowers/specs/2026-10-16-supervisor-review-design.md §2, §3.3, §5) — satu tanggal
 *   WITA, satu cakupan hierarki -> JawabanSupervisorReview; ringkasan + simpan koordinat toko.
 * Caller: app/api/supervisor-review/route.ts (GET), app/api/supervisor-review/koordinat/route.ts (GET/POST).
 * Dependensi: lib/db, db/schema, lib/supervisor-review/ringkasan.ts (hitung murni), lib/kasir/hari.ts muatPetaOrang +
 *   lib/kasir/rekonsiliasi.ts orangDariSalesmanId (faktur -> salesman lewat accurate_employee + sales_code_merge bulan itu), lib/form-kontrol
 *   (UserScope, kodeJksUntuk).
 * Main Functions: muatSupervisorReview, ringkasanKoordinat, simpanKoordinat. Side Effects: simpanKoordinat menulis toko_koordinat (upsert).
 */
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accurateEmployee, aoControlDaily, branch, customer, jksMaster, kunjunganLuarRute, nooToko, salesInvoiceCache, salesProfile,
    tokoKoordinat } from "@/db/schema";
import { muatPetaOrang } from "@/lib/kasir/hari";
import { orangDariSalesmanId } from "@/lib/kasir/rekonsiliasi";
import type { UserScope } from "@/lib/form-kontrol/scope";
import type { JawabanSupervisorReview, JawabanUnggahKoordinat, RingkasanKoordinat } from "./kontrak";
import { hitungRingkasan, periksaKoordinat, type MasukanRingkasan } from "./ringkasan";

const TANPA_CABANG = "(tanpa cabang)";
const besar = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
const unik = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort((a, b) => a.localeCompare(b, "id"));

/**
 * Cakupan dari resolveScope (lib/form-kontrol/scope.ts): null = global (admin/manager/admin_sales); SPV = timnya; SM = semua SPV + salesman
 * bawahannya; salesman = dirinya. Cakupan non-global KOSONG = akun belum tertaut Hierarki -> pesan, bukan tabel kosong yang menyesatkan.
 * Filter `principle` = sales_profile.principle salesman (EC/Call tidak dipecah per principal, spec §2); `cabang` = cabang Accurate karyawan
 * (accurate_employee.branch_id), cadangan sales_profile.branch. Faktur "tanpa salesman terpetakan" hanya untuk cakupan global.
 */
export async function muatSupervisorReview(scope: UserScope, opsi: { tanggal: string; cabang?: string | null; principle?: string | null }):
    Promise<JawabanSupervisorReview> {
    const { tanggal } = opsi;
    const global = scope.allowedSalesCodes === null;
    const cakupan = global ? "global" : scope.role === "sm" ? "sm" : scope.role === "spv" ? "spv" : "salesman";
    const dasar: JawabanSupervisorReview = { tanggal, diperbaruiPada: new Date().toISOString(), cakupan, pilihanCabang: [], pilihanPrinciple: [],
        salesman: [], totalCabang: [], kunjungan: [], penanda: [], tokoTanpaKoordinat: 0, fakturBelumTerbaca: [] };
    if (!global && scope.allowedSalesCodes!.length === 0) {
        return { ...dasar, pesan: { kode: "HIERARKI_BELUM_TERTAUT", teks: "Akun belum tertaut ke hierarki. Hubungi Admin." } };
    }

    const [y, m, d] = tanggal.split("-");
    const [profil, pegawai, { peta, namaKode }, fakturDb] = await Promise.all([
        db.select({ salesCode: salesProfile.salesCode, nama: salesProfile.salesName, principle: salesProfile.principle, branch: salesProfile.branch,
            noHp: salesProfile.noHp }).from(salesProfile).where(global ? undefined : inArray(salesProfile.salesCode, scope.allowedSalesCodes!)),
        db.select({ number: accurateEmployee.number, cabang: branch.name }).from(accurateEmployee).leftJoin(branch, eq(branch.id, accurateEmployee.branchId)),
        muatPetaOrang(db, tanggal),
        // Faktur dihitung: nomor INV… dan trans_date (teks dd/MM/yyyy, berindeks) = tanggal tampilan (spec §2).
        db.select({ customerNo: salesInvoiceCache.customerNo, customerName: salesInvoiceCache.customerName, salesmanId: salesInvoiceCache.salesmanId,
            qty: salesInvoiceCache.qtyTotal, item: salesInvoiceCache.jumlahItem, dpp: salesInvoiceCache.dpp }).from(salesInvoiceCache)
            .where(and(eq(salesInvoiceCache.transDate, `${d}/${m}/${y}`), like(salesInvoiceCache.number, "INV%"))),
    ]);
    const nomorPelanggan = unik(fakturDb.map((f) => f.customerNo));
    const cabangPelanggan = new Map((nomorPelanggan.length ? await db.select({ no: customer.customerNo, cabang: customer.branchName }).from(customer)
        .where(inArray(customer.customerNo, nomorPelanggan)) : []).map((c) => [c.no, c.cabang]));
    const cabangPegawai = new Map<string, string>();
    for (const p of pegawai) if (p.cabang && !cabangPegawai.has(besar(p.number))) cabangPegawai.set(besar(p.number), p.cabang);

    // Satu salesman per kode: profil Hierarki dulu; cakupan global juga salesman berfaktur hari itu yang belum punya profil.
    const kodeProfil = new Map(profil.map((p) => [besar(p.salesCode), p.salesCode]));
    const faktur: MasukanRingkasan["faktur"] = fakturDb.map((f) => {
        const { orang } = orangDariSalesmanId(f.salesmanId, tanggal, peta);
        return { salesCode: f.qty === null ? null : kodeProfil.get(besar(orang)) ?? orang, cabang: cabangPelanggan.get(f.customerNo ?? "") || TANPA_CABANG,
            customerNo: f.customerNo ?? "", customerName: f.customerName ?? "", qty: f.qty ?? 0, item: f.item ?? 0, dpp: f.dpp ?? 0 };
    });
    const semua = [
        ...profil.map((p) => ({ salesCode: p.salesCode, nama: p.nama, cabang: cabangPegawai.get(besar(p.salesCode)) || p.branch || TANPA_CABANG,
            noHp: p.noHp, principle: p.principle as string | null })),
        ...(global ? unik(faktur.map((f) => f.salesCode).filter((k) => k && !kodeProfil.has(besar(k))))
            .map((k) => ({ salesCode: k, nama: namaKode.get(k) ?? k, cabang: cabangPegawai.get(besar(k)) || TANPA_CABANG, noHp: null, principle: null })) : []),
    ];
    const terpilih = semua.filter((s) => (!opsi.cabang || s.cabang === opsi.cabang) && (!opsi.principle || s.principle === opsi.principle));
    const kode = new Set(terpilih.map((s) => s.salesCode));
    const cabangTerpilih = new Set(terpilih.map((s) => s.cabang));
    // ponytail: faktur tanpa salesman / belum terbaca tak punya principal -> disembunyikan saat filter principle aktif.
    const lainBoleh = (f: { cabang: string }) => !opsi.principle && (!opsi.cabang || f.cabang === opsi.cabang);
    const fakturTampil = faktur.filter((f) => f.salesCode === null ? lainBoleh(f) && (global || cabangTerpilih.has(f.cabang))
        : f.salesCode === "" ? global && lainBoleh(f) : kode.has(f.salesCode));

    const daftarKode = [...kode];
    const ada = daftarKode.length > 0;
    const [jks, ao, luarRute, noo, koordinat] = await Promise.all([
        ada ? db.select({ salesCode: jksMaster.salesCode, custCode: jksMaster.custCode, custName: jksMaster.custName, hariKunjungan: jksMaster.hariKunjungan,
            mingguPattern: jksMaster.mingguPattern }).from(jksMaster).where(and(eq(jksMaster.isActive, true), inArray(jksMaster.salesCode, daftarKode))) : [],
        ada ? db.select({ salesCode: aoControlDaily.salesCode, custCode: aoControlDaily.custCode, status: aoControlDaily.status,
            checkinAt: aoControlDaily.checkinAt, checkoutAt: aoControlDaily.checkoutAt, lat: aoControlDaily.checkinLat, lng: aoControlDaily.checkinLng })
            .from(aoControlDaily).where(and(eq(aoControlDaily.date, tanggal), inArray(aoControlDaily.salesCode, daftarKode))) : [],
        ada ? db.select({ salesCode: kunjunganLuarRute.salesCode, custCode: kunjunganLuarRute.custCode, custName: kunjunganLuarRute.custName })
            .from(kunjunganLuarRute).where(and(eq(kunjunganLuarRute.tanggal, tanggal), isNull(kunjunganLuarRute.dibatalkanPada),
                inArray(kunjunganLuarRute.salesCode, daftarKode))) : [],
        ada ? db.select({ salesCode: nooToko.salesCode }).from(nooToko).where(and(eq(nooToko.tanggal, tanggal), inArray(nooToko.salesCode, daftarKode))) : [],
        // ponytail: seluruh toko_koordinat (≤ jumlah toko JKS, 3 kolom) — lebih murah daripada ribuan parameter kode; saring bila tabel membengkak.
        db.select({ custCode: tokoKoordinat.custCode, lat: tokoKoordinat.lat, lng: tokoKoordinat.lng }).from(tokoKoordinat),
    ]);

    const hasil = hitungRingkasan({ tanggal, salesman: terpilih, jks, ao, luarRute, noo, faktur: fakturTampil,
        koordinat: new Map(koordinat.map((k) => [k.custCode, { lat: k.lat, lng: k.lng }])) });
    return {
        ...dasar, ...hasil,
        pilihanCabang: unik([...semua.map((s) => s.cabang), ...(global ? faktur.filter((f) => !f.salesCode).map((f) => f.cabang) : [])]),
        pilihanPrinciple: unik(semua.map((s) => s.principle)),
    };
}

/** Tab Koordinat Toko: toko JKS aktif, yang sudah berkoordinat, dan ≤ 200 contoh yang belum (bahan templat unduh). */
export async function ringkasanKoordinat(): Promise<RingkasanKoordinat> {
    const [jumlah] = (await db.execute(sql`SELECT count(DISTINCT j.cust_code)::int AS toko,
            count(DISTINCT j.cust_code) FILTER (WHERE k.cust_code IS NOT NULL)::int AS ber
        FROM ${jksMaster} j LEFT JOIN ${tokoKoordinat} k ON k.cust_code = j.cust_code WHERE j.is_active`)).rows as { toko: number; ber: number }[];
    const contoh = (await db.execute(sql`SELECT j.cust_code AS "custCode", min(j.cust_name) AS "namaToko" FROM ${jksMaster} j
        WHERE j.is_active AND NOT EXISTS (SELECT 1 FROM ${tokoKoordinat} k WHERE k.cust_code = j.cust_code)
        GROUP BY j.cust_code ORDER BY j.cust_code LIMIT 200`)).rows as { custCode: string; namaToko: string }[];
    return { tokoJks: jumlah?.toko ?? 0, berKoordinat: jumlah?.ber ?? 0, contohTanpaKoordinat: contoh };
}

/** Unggah koordinat: baris ditolak dilaporkan per nomor baris Excel, baris sah tetap di-upsert (satu transaksi). */
export async function simpanKoordinat(baris: { baris: number; kode: unknown; lat: unknown; lng: unknown }[], oleh: string): Promise<JawabanUnggahKoordinat> {
    const kodeJks = new Map((await db.selectDistinct({ c: jksMaster.custCode }).from(jksMaster)).map((r) => [besar(r.c), r.c.trim()]));
    const { sah, ditolak } = periksaKoordinat(baris, kodeJks);
    if (sah.length) {
        await db.transaction(async (tx) => {
            for (let i = 0; i < sah.length; i += 500) {
                await tx.insert(tokoKoordinat).values(sah.slice(i, i + 500).map((s) => ({ ...s, diperbaruiOleh: oleh })))
                    .onConflictDoUpdate({ target: tokoKoordinat.custCode, set: { lat: sql`excluded.lat`, lng: sql`excluded.lng`,
                        diperbaruiPada: sql`now()`, diperbaruiOleh: sql`excluded.diperbarui_oleh` } });
            }
        });
    }
    return { disimpan: sah.length, ditolak };
}
