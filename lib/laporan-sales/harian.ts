/*
 * Tujuan: Tab "Monitoring Harian" Laporan Sales (padanan EskaLink "Daily Monitoring Sales/Customer"): per (pelanggan, salesman) nilai DPP
 *   faktur INV tiap tanggal sebulan (D1…Dn) + MTD. Kontrak jawaban: lib/laporan-sales/kontrak.ts (JawabanHarian).
 * Caller: app/api/laporan-sales/harian/route.ts.
 * Dependensi: lib/db, db/schema (sales_invoice, customer, sales_profile), lib/kasir/hari muatPetaOrang + lib/kasir/rekonsiliasi
 *   orangDariSalesmanId (faktur -> salesman, SAMA dengan lib/supervisor-review/db.ts: accurate_employee + sales_code_merge bulan itu),
 *   lib/form-kontrol/scope (UserScope), ./kontrak.
 * Main Functions: hitungHarian (murni, tanpa DB), muatHarian.
 * Side Effects: SELECT saja (tanpa tulisan, tanpa raw_data).
 */
import { and, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { customer, salesInvoiceCache, salesProfile } from "@/db/schema";
import { muatPetaOrang } from "@/lib/kasir/hari";
import { orangDariSalesmanId, type PetaOrang } from "@/lib/kasir/rekonsiliasi";
import type { UserScope } from "@/lib/form-kontrol/scope";
import { rentangBulan, type BarisHarian, type JawabanHarian } from "./kontrak";

export const TANPA_CABANG = "Tanpa cabang";

/** Satu faktur INV mentah: `dpp` null = rincian belum terbaca (tidak dijumlah); `cabang` sudah dipetakan dari customer.branch_name. */
export type FakturHarian = { transDate: string | null; customerNo: string | null; customerName: string | null; salesmanId: number | null; dpp: number | null; cabang: string };
export type ProfilSales = { kode: string; nama: string };

const besar = (v: string) => v.trim().toUpperCase();
const urut = (a: string, b: string) => a.localeCompare(b, "id");

/**
 * Agregasi murni. `profil` = sales_profile dalam cakupan (kunci = kode huruf besar); non-global HANYA baris salesman berprofil itu (faktur
 * tanpa salesman terpetakan / salesman di luar cakupan tidak tampil), global = semua + baris "tanpa salesman" (salesCode null). Satu baris
 * per (pelanggan, salesman). Nilai dijumlah dalam sen bulat (tanpa drift floating). Faktur dpp null tidak dijumlah, dihitung terpisah:
 * global = semuanya; non-global (salesman faktur itu memang tak terbaca) = yang cabangnya muncul di baris cakupan, seperti Supervisor Review.
 * `cabang` menyaring baris & hitungan, TIDAK pilihanCabang (agar pilihan tidak menyusut sendiri).
 * ponytail: tanggal di luar bulan / tak sah (hari 31 di bulan 30 hari) dibuang diam-diam; SQL sudah menyaring bulan, ini hanya penjaga.
 */
export function hitungHarian(m: {
    bulan: string; faktur: readonly FakturHarian[]; peta: PetaOrang; profil: ReadonlyMap<string, ProfilSales>; namaKode: ReadonlyMap<string, string>;
    global: boolean; cabang?: string | null;
}): JawabanHarian {
    const { hari } = rentangBulan(m.bulan);
    const tanggal = `${m.bulan}-01`; // gabungan kode dipetakan per BULAN: tanggal mana pun di bulan itu sama
    const pilihan = new Set<string>();
    const kosong: string[] = []; // cabang tiap faktur dpp null yang berpotensi dalam cakupan
    const baris = new Map<string, { b: BarisHarian; sen: number[] }>();
    for (const f of m.faktur) {
        if (f.dpp === null || !Number.isFinite(f.dpp)) {
            kosong.push(f.cabang);
            if (m.global) pilihan.add(f.cabang);
            continue;
        }
        const { orang } = orangDariSalesmanId(f.salesmanId, tanggal, m.peta);
        const p = orang ? m.profil.get(besar(orang)) : undefined;
        if (!m.global && !p) continue;
        const t = /^(\d{1,2})\/(\d{2})\/(\d{4})$/.exec(f.transDate ?? "");
        const hr = t ? Number(t[1]) : 0;
        if (!t || `${t[3]}-${t[2]}` !== m.bulan || hr < 1 || hr > hari) continue;
        pilihan.add(f.cabang);
        if (m.cabang && f.cabang !== m.cabang) continue;
        const salesCode = orang ? p?.kode ?? orang : null;
        const kunci = `${f.customerNo ?? ""}\u0000${salesCode ?? ""}`;
        let r = baris.get(kunci);
        if (!r) {
            r = { b: { custNo: f.customerNo ?? "", custNama: f.customerName ?? f.customerNo ?? "", salesCode, salesNama: orang ? p?.nama ?? m.namaKode.get(orang) ?? orang : null,
                cabang: f.cabang, mtd: 0, perHari: [] }, sen: new Array<number>(hari).fill(0) };
            baris.set(kunci, r);
        }
        r.sen[hr - 1] += Math.round(f.dpp * 100);
    }
    const hasil = [...baris.values()].map(({ b, sen }) => ({ ...b, perHari: sen.map((s) => s / 100), mtd: sen.reduce((a, s) => a + s, 0) / 100 }))
        .sort((a, b) => b.mtd - a.mtd || urut(a.custNama, b.custNama) || urut(a.salesCode ?? "", b.salesCode ?? ""));
    const fakturTanpaDpp = kosong.filter((c) => (m.global || pilihan.has(c)) && (!m.cabang || c === m.cabang)).length;
    return { bulan: m.bulan, hari, pilihanCabang: [...pilihan].sort(urut), baris: hasil, fakturTanpaDpp };
}

/**
 * Muat faktur INV bulan itu (±12 rb baris, kolom perlu saja) + profil cakupan + peta orang, lalu hitungHarian. `scope.allowedSalesCodes` kosong
 * (non-global) harus ditolak pemanggil (route 403) — inArray([]) tidak bermakna.
 */
export async function muatHarian(scope: UserScope, opsi: { bulan: string; cabang?: string | null }): Promise<JawabanHarian> {
    const global = scope.allowedSalesCodes === null;
    const [profilDb, { peta, namaKode }, fakturDb] = await Promise.all([
        db.select({ kode: salesProfile.salesCode, nama: salesProfile.salesName }).from(salesProfile)
            .where(global ? undefined : inArray(salesProfile.salesCode, scope.allowedSalesCodes!)),
        muatPetaOrang(db, `${opsi.bulan}-01`),
        db.select({ transDate: salesInvoiceCache.transDate, customerNo: salesInvoiceCache.customerNo, customerName: salesInvoiceCache.customerName,
            salesmanId: salesInvoiceCache.salesmanId, dpp: salesInvoiceCache.dpp }).from(salesInvoiceCache)
            .where(and(like(salesInvoiceCache.number, "INV%"), like(salesInvoiceCache.transDate, rentangBulan(opsi.bulan).polaTransDate))),
    ]);
    const nomor = [...new Set(fakturDb.map((f) => f.customerNo).filter((n): n is string => Boolean(n)))];
    const cabangPelanggan = new Map<string, string>();
    if (nomor.length) {
        for (const c of await db.select({ no: customer.customerNo, cabang: customer.branchName }).from(customer).where(inArray(customer.customerNo, nomor))) {
            if (c.cabang && !cabangPelanggan.has(c.no)) cabangPelanggan.set(c.no, c.cabang);
        }
    }
    return hitungHarian({
        bulan: opsi.bulan, peta, namaKode, global, cabang: opsi.cabang,
        profil: new Map(profilDb.map((p) => [besar(p.kode), { kode: p.kode, nama: p.nama }])),
        faktur: fakturDb.map((f) => ({ ...f, cabang: cabangPelanggan.get(f.customerNo ?? "") ?? TANPA_CABANG })),
    });
}
