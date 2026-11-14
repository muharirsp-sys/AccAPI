/*
 * Tujuan: Pemuat Postgres panel "Kontrol bulan ini" Supervisor Review (owner 13 Nov 2026) — cakupan hierarki + saringan cabang/principal, periode
 *   tanggal 1 s.d. tanggal tampilan -> BarisKontrol per salesman (hitung murni di ./kontrol.ts).
 * Caller: app/api/supervisor-review/kontrol/route.ts (GET).
 * Dependensi: lib/db, db/schema, lib/kasir/hari muatPetaOrang + lib/kasir/rekonsiliasi orangDariSalesmanId (faktur -> salesman, sama dengan
 *   ./db.ts), lib/form-kontrol/item-super-db tawaranBulan, ./kontrol hitungKontrol.
 * Main Functions: muatKontrol. Side Effects: tidak ada (baca saja).
 */
import { and, eq, gte, inArray, like, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { accurateEmployee, aoControlDaily, branch, jksMaster, pengajuanLokasi, salesInvoiceCache, salesProfile, tokoKoordinat } from "@/db/schema";
import { muatPetaOrang } from "@/lib/kasir/hari";
import { orangDariSalesmanId } from "@/lib/kasir/rekonsiliasi";
import type { UserScope } from "@/lib/form-kontrol/scope";
import { tawaranBulan } from "@/lib/form-kontrol/item-super-db";
import { hitungKontrol, type BarisKontrol } from "./kontrol";

const TANPA_CABANG = "(tanpa cabang)";
const besar = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();

export type JawabanKontrol = { tanggal: string; dari: string; salesman: BarisKontrol[]; pesan?: { kode: string; teks: string } };

/**
 * Salesman = profil Hierarki dalam cakupan (cabang = cabang karyawan Accurate, cadangan sales_profile.branch; saringan sama dengan
 * muatSupervisorReview). ponytail: faktur sebulan dibaca lewat IN daftar tanggal dd/MM/yyyy (indeks idx_sales_invoice_trans_date) lalu disaring
 * ke toko JKS di JS; plafon = ribuan faktur/bulan. Jalan naik: saring customer_no di SQL bila bulan membengkak.
 */
export async function muatKontrol(scope: UserScope, opsi: { tanggal: string; cabang?: string | null; principle?: string | null }): Promise<JawabanKontrol> {
    const { tanggal } = opsi;
    const dari = `${tanggal.slice(0, 8)}01`;
    const global = scope.allowedSalesCodes === null;
    if (!global && scope.allowedSalesCodes!.length === 0) {
        return { tanggal, dari, salesman: [], pesan: { kode: "HIERARKI_BELUM_TERTAUT", teks: "Akun belum tertaut ke hierarki. Hubungi Admin." } };
    }
    const [profil, pegawai] = await Promise.all([
        db.select({ salesCode: salesProfile.salesCode, nama: salesProfile.salesName, principle: salesProfile.principle, branch: salesProfile.branch,
            sumberOrder: salesProfile.sumberOrder }).from(salesProfile).where(global ? undefined : inArray(salesProfile.salesCode, scope.allowedSalesCodes!)),
        db.select({ number: accurateEmployee.number, cabang: branch.name }).from(accurateEmployee).leftJoin(branch, eq(branch.id, accurateEmployee.branchId)),
    ]);
    const cabangPegawai = new Map<string, string>();
    for (const p of pegawai) if (p.cabang && !cabangPegawai.has(besar(p.number))) cabangPegawai.set(besar(p.number), p.cabang);
    const salesman = profil.map((p) => ({ salesCode: p.salesCode, nama: p.nama, principle: p.principle,
        cabang: cabangPegawai.get(besar(p.salesCode)) || p.branch || TANPA_CABANG, sumberOrder: p.sumberOrder === "principal" ? "principal" as const : "accapi" as const }))
        .filter((s) => (!opsi.cabang || s.cabang === opsi.cabang) && (!opsi.principle || s.principle === opsi.principle));
    const kode = salesman.map((s) => s.salesCode);
    if (kode.length === 0) return { tanggal, dari, salesman: [] };

    const [y, m, d] = tanggal.split("-");
    const hariFaktur = Array.from({ length: Number(d) }, (_, i) => `${String(i + 1).padStart(2, "0")}/${m}/${y}`);
    const [jks, ao, fakturDb, tawaran, { peta }, koordinat, ajuan] = await Promise.all([
        db.select({ salesCode: jksMaster.salesCode, custCode: jksMaster.custCode, custName: jksMaster.custName, kategori: jksMaster.kategori,
            kelasA: jksMaster.kelasA, statusJks: jksMaster.statusJks, targetToko: jksMaster.targetToko, lokasiDari: jksMaster.lokasiDari })
            .from(jksMaster).where(and(eq(jksMaster.isActive, true), inArray(jksMaster.salesCode, kode))),
        db.select({ salesCode: aoControlDaily.salesCode, custCode: aoControlDaily.custCode, date: aoControlDaily.date, status: aoControlDaily.status,
            nomorOrder: aoControlDaily.invoiceNumber, checkinAt: aoControlDaily.checkinAt, checkoutAt: aoControlDaily.checkoutAt,
            lat: aoControlDaily.checkinLat, lng: aoControlDaily.checkinLng, latKeluar: aoControlDaily.checkoutLat, lngKeluar: aoControlDaily.checkoutLng }).from(aoControlDaily)
            .where(and(inArray(aoControlDaily.salesCode, kode), gte(aoControlDaily.date, dari), lte(aoControlDaily.date, tanggal))),
        db.select({ customerNo: salesInvoiceCache.customerNo, transDate: salesInvoiceCache.transDate, salesmanId: salesInvoiceCache.salesmanId,
            total: salesInvoiceCache.totalAmount }).from(salesInvoiceCache)
            .where(and(inArray(salesInvoiceCache.transDate, hariFaktur), like(salesInvoiceCache.number, "INV%"))),
        tawaranBulan(kode, dari, tanggal),
        muatPetaOrang(db, tanggal),
        // Analisa kunjungan GPS (owner 14 Nov 2026): seluruh toko_koordinat, pola sama dengan ./db.ts muatSupervisorReview.
        db.select({ custCode: tokoKoordinat.custCode, lat: tokoKoordinat.lat, lng: tokoKoordinat.lng }).from(tokoKoordinat),
        db.select({ salesCode: pengajuanLokasi.salesCode, status: pengajuanLokasi.status }).from(pengajuanLokasi)
            .where(and(inArray(pengajuanLokasi.salesCode, kode), gte(pengajuanLokasi.tanggal, dari), lte(pengajuanLokasi.tanggal, tanggal))),
    ]);
    const kodeProfil = new Map(profil.map((p) => [besar(p.salesCode), p.salesCode]));
    const faktur = fakturDb.map((f) => {
        const [dd, mm, yy] = (f.transDate ?? "").split("/");
        const tgl = `${yy}-${mm}-${dd}`;
        const { orang } = orangDariSalesmanId(f.salesmanId, tgl, peta);
        return { salesCode: kodeProfil.get(besar(orang)) ?? orang, customerNo: f.customerNo ?? "", tanggal: tgl, total: f.total ?? 0 };
    });
    return {
        tanggal, dari,
        salesman: hitungKontrol({ tanggal, salesman, jks, faktur, tawaran, ajuan,
            koordinat: new Map(koordinat.map((k) => [k.custCode.trim().toUpperCase(), { lat: k.lat, lng: k.lng }])),
            ao: ao.map((a) => ({ ...a, checkin: a.checkinAt !== null })) }),
    };
}
