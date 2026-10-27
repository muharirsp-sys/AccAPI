/*
 * Tujuan: NOO — toko baru dari kunjungan salesman (owner 13 Okt 2026; brief scratch/fiori-redesign/briefs/NOO-brief-toko-baru.md). Salesman
 *   mengajukan toko yang BELUM ada di Accurate (toko + pemilik + KTP + foto + GPS) → kunjungan hari ini bertanda NOO (baris kunjungan_luar_rute
 *   biasa, cust_code = kode NOO) → SPV tim / SM di atasnya / grup Admin setujui | tolak → Admin mendaftarkan di Accurate SECARA MANUAL lalu
 *   menautkan pelanggan hasil sync (cabang sama) → terdaftar. Aplikasi TIDAK menulis ke Accurate.
 * Caller: app/api/form-kontrol/noo/** (route), app/api/form-kontrol/ao-control/route.ts (tolakOrderNoo).
 * Dependensi: db (noo_toko, kunjungan_luar_rute, customer, sales_profile, kontrol_audit_log), ./scope (canAccessSales), ./db (computeGpsFlag),
 *   ./uploads (NOO_DIR, olahFoto, labelWaktu), ./noo-aturan, lib/order-cabang (GalatOrder, polaLike).
 * Main Functions: hakNoo, bolehBacaNoo, tampilanNoo, buatNoo, daftarNoo, ambilNoo, putuskanNoo, tautkanNoo, kunjungiNoo, lihatKtp,
 *   bacaFotoToko, saranPelanggan, tolakOrderNoo.
 * Side Effects: INSERT/UPDATE noo_toko, INSERT kunjungan_luar_rute, INSERT kontrol_audit_log (entity `noo`; `lihat_ktp` tiap KTP dibuka);
 *   tulis/baca/unlink berkas di NOO_DIR (data/private/noo). Tidak pernah DELETE baris.
 *
 * DATA PRIBADI (wajib, brief §Data pribadi): NIK + foto KTP tidak pernah ditulis ke log, pesan galat, payload audit, atau respons daftar/rincian
 * (rincian = NIK tersamar). NIK lengkap + foto KTP HANYA lewat lihatKtp (izin hakNoo().ktp; tercatat audit SEBELUM data dikembalikan).
 * Galat DB/berkas tidak dicatat ke console di modul ini (route menjawab 500 umum).
 */
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { customer, kontrolAuditLog, kunjunganLuarRute, nooToko, salesProfile } from "@/db/schema";
import { polaLike, type GalatOrder } from "@/lib/order-cabang";
import { canAccessSales, resolveScope, type UserScope } from "./scope";
import { computeGpsFlag } from "./db";
import { NOO_DIR, labelWaktu, olahFoto } from "./uploads";
import { isKodeNoo, samarkanNik, type IsianNoo, type StatusNoo } from "./noo-aturan";

export type BarisNoo = typeof nooToko.$inferSelect;
type Hasil<T> = T | { galat: GalatOrder };
const galat = (status: number, kode: string, error: string, lain: Record<string, unknown> = {}): { galat: GalatOrder } =>
    ({ galat: { status, kode, error, ...lain } });

// ---------------------------------------------------------------- hak akses

/** Akses pemanggil: cakupan Form Kontrol (resolveScope), kunci izin, id akun sesi. */
export type AksesNoo = { scope: UserScope; perms: ReadonlySet<string>; userId: string };
const KUNCI = { manage: "form_kontrol.manage", setujui: "form_kontrol.noo_setujui", ktp: "form_kontrol.noo_ktp", tautkan: "form_kontrol.noo_tautkan" } as const;

/** AksesNoo dari sesi + izin gerbang route (requirePermissionH). */
export async function aksesNoo(session: { user: { id: string; name?: string | null; role?: string | null } }, perms: ReadonlySet<string>): Promise<AksesNoo> {
    return { scope: await resolveScope(session), perms, userId: String(session.user.id) };
}

/**
 * Boleh MEMBACA NOO salesman ini (daftar, rincian tanpa NIK, foto toko): salesman = miliknya; SPV/SM = timnya (resolveScope); peran
 * berakses global (admin/manager/admin_sales) HANYA dengan form_kontrol.manage / noo_setujui / noo_ktp / noo_tautkan — form_kontrol.view saja
 * tidak cukup. Owner 13 Okt malam: Manager (preset: view/submit/manage) boleh MELIHAT daftar/rincian, tanpa KTP dan tanpa menautkan.
 */
export function bolehBacaNoo(a: AksesNoo, salesCode: string): boolean {
    if (a.scope.allowedSalesCodes === null) return Object.values(KUNCI).some((k) => a.perms.has(k));
    return canAccessSales(a.scope, salesCode);
}

/**
 * Hak atas SATU NOO (owner 13 Okt P2 + keputusan 13 Okt malam):
 *   putuskan = noo_setujui + dapat membaca + bukan akun salesman (SPV tim, SM atas SPV bawahannya, grup Admin) + bukan pembuatnya + menunggu;
 *   ktp      = noo_ktp (grup Admin) · SPV/SM pemegang noo_setujui untuk timnya (SM = pengganti, atas SPV bawahannya) · salesman pembuat SELAMA
 *              menunggu_spv. Admin Sales dan Manager TIDAK;
 *   tautkan  = form_kontrol.noo_tautkan (HANYA grup Admin — bukan form_kontrol.manage yang juga dipegang Manager/Admin Sales) + bukan akun
 *              salesman + status disetujui;
 *   kunjungi = salesman pemiliknya, selama menunggu_spv/disetujui (sesudah terdaftar: kunjungan luar rute biasa berkode pelanggan Accurate).
 */
export function hakNoo(a: AksesNoo, r: Pick<BarisNoo, "salesCode" | "dibuatOleh" | "status">) {
    const baca = bolehBacaNoo(a, r.salesCode);
    const bukanSalesman = !a.scope.salesCode;
    return {
        baca,
        putuskan: baca && bukanSalesman && a.perms.has(KUNCI.setujui) && r.dibuatOleh !== a.userId && r.status === "menunggu_spv",
        ktp: baca && (a.perms.has(KUNCI.ktp) || ((a.scope.role === "spv" || a.scope.role === "sm") && a.perms.has(KUNCI.setujui))
            || (r.dibuatOleh === a.userId && r.status === "menunggu_spv")),
        tautkan: baca && bukanSalesman && a.perms.has(KUNCI.tautkan) && r.status === "disetujui",
        kunjungi: Boolean(a.scope.salesCode) && a.scope.salesCode === r.salesCode && (r.status === "menunggu_spv" || r.status === "disetujui"),
    };
}

// ---------------------------------------------------------------- tampilan (TANPA NIK)

/**
 * Peninjau A R3 (privasi lintas tim): NOO PEMBANDING duplikat (kode, nama toko, alamat, salesman) hanya terlihat oleh akun non-salesman yang
 * boleh membaca NOO ini (SPV/SM pemutus, Admin, Manager/Admin Sales) atau salesman PEMILIK NOO pembanding itu. Salesman lain hanya tahu
 * "NIK/HP sudah dipakai pengajuan lain" — 409 duplikat dan tanda duplikat tidak menjadi oracle NIK/HP → toko orang lain.
 */
export const lihatPembanding = (a: AksesNoo, salesCodePembanding: string | null | undefined) =>
    !a.scope.salesCode || (Boolean(salesCodePembanding) && a.scope.salesCode === salesCodePembanding);

export type BarisTampil = BarisNoo & { salesName?: string | null; duplikatSalesCode?: string | null };

/** Bentuk respons. Daftar = ringkas; rincian = + pemilik, HP, nama KTP, NIK TERSAMAR, GPS, foto toko (URL berotorisasi). Tidak pernah NIK/KTP. */
export function tampilanNoo(r: BarisTampil, a: AksesNoo, rinci = false) {
    const h = hakNoo(a, r);
    const ringkas = {
        id: r.id, kode: r.kode, salesCode: r.salesCode, salesName: r.salesName ?? null, principle: r.principle, branchId: r.branchId,
        branchName: r.branchName, tanggal: r.tanggal, namaToko: r.namaToko, alamat: r.alamat, status: r.status as StatusNoo, gpsFlag: r.gpsFlag,
        duplikat: r.duplikatDengan !== null, duplikatDengan: lihatPembanding(a, r.duplikatSalesCode) ? r.duplikatDengan : null,
        dibuatOlehNama: r.dibuatOlehNama, dibuatPada: r.dibuatPada,
        diputuskanOlehNama: r.diputuskanOlehNama, diputuskanPada: r.diputuskanPada, alasanTolak: r.alasanTolak,
        customerNo: r.customerNo, ditautkanOlehNama: r.ditautkanOlehNama, ditautkanPada: r.ditautkanPada,
        boleh: { putuskan: h.putuskan, ktp: h.ktp, tautkan: h.tautkan, kunjungi: h.kunjungi },
    };
    if (!rinci) return ringkas;
    return {
        ...ringkas, namaPemilik: r.namaPemilik, noHp: r.noHp, namaKtp: r.namaKtp, nikTersamar: samarkanNik(r.nik),
        lat: r.lat, lng: r.lng, akurasi: r.akurasi, alasanDuplikat: r.alasanDuplikat, duplikatDikonfirmasi: r.duplikatDikonfirmasi,
        fotoToko: `/api/form-kontrol/noo/${encodeURIComponent(r.id)}/foto-toko`,
    };
}

// ---------------------------------------------------------------- berkas privat

const POLA_BERKAS = /^[0-9a-f-]{36}\.jpg$/;
const jalurBerkas = (nama: string) => {
    if (!POLA_BERKAS.test(nama)) throw new Error("nama berkas NOO tidak sah");
    return path.join(NOO_DIR, nama);
};
/**
 * Satu berkas bernama acak; tulis gagal (ENOSPC/EACCES) → sisa setengah-tulis di-unlink lalu galat diteruskan (peninjau A R2).
 * `tulisFile` hanya untuk uji (writeFile yang gagal di tengah jalan, peninjau A R-A2).
 */
export async function tulisBerkas(isi: Buffer, tulisFile: typeof writeFile = writeFile): Promise<string> {
    const nama = `${randomUUID()}.jpg`;
    await mkdir(NOO_DIR, { recursive: true });
    try {
        await tulisFile(jalurBerkas(nama), isi, { flag: "wx" });
    } catch (e) {
        await unlink(jalurBerkas(nama)).catch(() => undefined);
        throw e;
    }
    return nama;
}
// Keputusan owner 14 Okt 2026: foto KTP (dan foto toko) DISIMPAN SELAMANYA — tidak ada penghapusan/retensi otomatis, juga sesudah NOO
// ditautkan/ditolak. buangBerkas HANYA membuang berkas pengajuan yang GAGAL dibuat (belum pernah punya baris noo_toko).
const buangBerkas = (nama: string[]) => Promise.all(nama.map((n) => unlink(jalurBerkas(n)).catch(() => undefined)));

// ---------------------------------------------------------------- buat

const ABJAD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (tanpa I/L/O/U); 256 % 32 = 0 → seragam.
// ponytail: kode acak 32^8 ≈ 1,1 triliun tanpa cek ulang; tabrakan → UNIQUE idx_noo_kode menolak transaksi (500, kirim ulang = kode baru).
export const buatKodeNoo = () => `NOO-${[...randomBytes(8)].map((b) => ABJAD[b % 32]).join("")}`;

type Cocok = ("NIK" | "No. HP")[];
export type Pembanding = { kode: string; namaToko: string; status: StatusNoo; salesCode: string; cocok: Cocok };

/** NOO lain yang BELUM ditolak (menunggu/disetujui/terdaftar) dengan NIK atau No. HP sama. Tanpa NIK/HP di hasil. */
async function cariPembanding(q: Pick<typeof db, "select">, nik: string, noHp: string): Promise<Pembanding[]> {
    const rows = await q.select({ kode: nooToko.kode, namaToko: nooToko.namaToko, status: nooToko.status, salesCode: nooToko.salesCode,
        samaNik: sql<boolean>`${nooToko.nik} = ${nik}`, samaHp: sql<boolean>`${nooToko.noHp} = ${noHp}` })
        .from(nooToko).where(and(ne(nooToko.status, "ditolak"), or(eq(nooToko.nik, nik), eq(nooToko.noHp, noHp))))
        .orderBy(asc(nooToko.dibuatPada), asc(nooToko.kode));
    return rows.map((r) => ({ kode: r.kode, namaToko: r.namaToko, status: r.status as StatusNoo, salesCode: r.salesCode,
        cocok: [...(r.samaNik ? ["NIK" as const] : []), ...(r.samaHp ? ["No. HP" as const] : [])] }));
}
/**
 * 409 NOO_DUPLIKAT untuk salesman `salesCode` (peninjau A R3): NOO pembanding MILIKNYA disebut (kode, toko, status); milik salesman lain hanya
 * "pengajuan lain" + isian yang sama (NIK/HP = ketikan salesman sendiri), tanpa kode/nama/alamat/salesman.
 */
function galatDuplikat(p: Pembanding[], salesCode: string) {
    const milik = p.filter((x) => x.salesCode === salesCode).map((x) => ({ kode: x.kode, namaToko: x.namaToko, status: x.status, cocok: x.cocok }));
    const lain = p.filter((x) => x.salesCode !== salesCode).map((x) => ({ cocok: x.cocok }));
    const bagian = [
        ...milik.map((x) => `${x.kode} ${x.namaToko} (${x.cocok.join(" & ")} sama)`),
        ...(lain.length ? [`${lain.length} pengajuan lain di luar milik Anda (${[...new Set(lain.flatMap((x) => x.cocok))].join(" & ")} sama)`] : []),
    ];
    return galat(409, "NOO_DUPLIKAT", `NIK atau No. HP ini sudah dipakai NOO lain yang belum ditolak: ${bagian.join("; ")}. `
        + "Bila pemiliknya memang sama (toko lain), ajukan ulang sebagai \"minta konfirmasi SPV: pemilik sama\" dengan alasan.", { pembanding: milik, lain });
}

/** Isian yang menentukan isi pengajuan — id sama dengan isian berbeda = pengajuan lain (peninjau B R6), bukan kirim ulang. */
const sidikIsian = (x: { salesCode: string; principle: string; namaToko: string; namaPemilik: string; alamat: string; noHp: string; nik: string; namaKtp: string }) =>
    JSON.stringify([x.salesCode, x.principle, x.namaToko, x.namaPemilik, x.alamat, x.noHp, x.nik, x.namaKtp]);

/**
 * Pengajuan NOO salesman (cakupan + cabang + principal + hari ini SUDAH diperiksa route). Urutan: id sama milik pembuat sama DENGAN isian sama =
 * baris lama (kirim ulang aman, 200), isian berbeda = 409 ID_BEDA_ISI (perubahan tidak terbuang diam-diam); NIK/HP sama dengan NOO belum ditolak → 409 NOO_DUPLIKAT kecuali `duplikat` (pengajuan ulang "pemilik sama" +
 * alasan → tanda duplikat, WAJIB dikonfirmasi pemutus); foto diolah (cap toko + pita KTP) lalu ditulis ke NOO_DIR; satu transaksi
 * (kunci advisory pembuatan NOO) cek ulang ganda → INSERT noo_toko + kunjungan_luar_rute hari ini + audit `noo/buat`. Gagal apa pun →
 * berkas yang baru ditulis di-unlink.
 */
export async function buatNoo(d: {
    id: string; salesCode: string; salesName: string | null; principle: string; tanggal: string; branchId: number; branchName: string | null;
    isian: IsianNoo; fotoToko: Buffer; fotoKtp: Buffer; duplikat: { alasan: string } | null; aktorId: string; aktorNama: string | null;
}, tulis: (isi: Buffer) => Promise<string> = tulisBerkas): Promise<Hasil<{ row: BarisNoo; baru: boolean }>> {
    const sidik = sidikIsian({ salesCode: d.salesCode, principle: d.principle, ...d.isian });
    const lama = (r: BarisNoo | undefined) => {
        if (!r) return null;
        if (r.dibuatOleh !== d.aktorId) return galat(409, "ID_TERPAKAI", "Pengajuan ini sudah dipakai akun lain; muat ulang formulir.");
        if (sidikIsian(r) !== sidik) {
            return galat(409, "ID_BEDA_ISI", `Pengajuan ini sudah tersimpan sebelumnya sebagai ${r.kode} ${r.namaToko} dengan isian berbeda; perubahan sesudahnya tidak dikirim. `
                + "Periksa di tab Toko Baru; bila memang toko lain, mulai pengajuan baru.", { kodeNoo: r.kode });
        }
        return { row: r, baru: false };
    };
    const awal = lama((await db.select().from(nooToko).where(eq(nooToko.id, d.id)).limit(1))[0]);
    if (awal) return awal;
    const banding = await cariPembanding(db, d.isian.nik, d.isian.noHp);
    if (banding.length && !d.duplikat) return galatDuplikat(banding, d.salesCode);

    const kode = buatKodeNoo();
    const waktu = `${labelWaktu("Asia/Makassar")} WITA`;
    let fotoToko: Buffer, fotoKtp: Buffer;
    try {
        fotoToko = await olahFoto(d.fotoToko, [`${d.salesName || d.salesCode} | ${d.isian.namaToko}`, `${waktu} | ${d.isian.lat.toFixed(6)}, ${d.isian.lng.toFixed(6)}`]);
        fotoKtp = await olahFoto(d.fotoKtp, [`KHUSUS PENDAFTARAN PELANGGAN · ${kode}`, waktu]);
    } catch {
        return galat(400, "FOTO_TIDAK_SAH", "Foto toko atau foto KTP tidak terbaca sebagai gambar; ambil ulang fotonya.");
    }
    const berkas: string[] = [];
    let jadi = false;
    try {
        // Berurutan + dicatat SEGERA (peninjau A R2): tulis KTP gagal → foto toko yang sudah tertulis ikut dibuang di finally.
        for (const f of [fotoToko, fotoKtp]) berkas.push(await tulis(f));
        const hasil = await db.transaction(async (tx) => {
            // ponytail: satu kunci untuk SEMUA pembuatan NOO (volume kecil; pengajuan serentak berurutan). Plafon: antrean panjang bila
            //   ratusan pengajuan/detik — ganti dengan kunci per NIK + per HP.
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('noo_toko:buat'))`);
            const ulang = lama((await tx.select().from(nooToko).where(eq(nooToko.id, d.id)).limit(1))[0]);
            if (ulang) return ulang;
            const pembanding = await cariPembanding(tx, d.isian.nik, d.isian.noHp);
            if (pembanding.length && !d.duplikat) return galatDuplikat(pembanding, d.salesCode);
            const now = new Date();
            const [row] = await tx.insert(nooToko).values({
                id: d.id, kode, salesCode: d.salesCode, principle: d.principle, branchId: d.branchId, branchName: d.branchName, tanggal: d.tanggal,
                namaToko: d.isian.namaToko, namaPemilik: d.isian.namaPemilik, alamat: d.isian.alamat, noHp: d.isian.noHp, nik: d.isian.nik,
                namaKtp: d.isian.namaKtp, fotoToko: berkas[0], fotoKtp: berkas[1], lat: d.isian.lat, lng: d.isian.lng, akurasi: d.isian.akurasi,
                gpsFlag: computeGpsFlag(d.isian.lat, d.isian.lng, d.isian.akurasi),
                duplikatDengan: pembanding.length ? pembanding[0].kode : null, alasanDuplikat: pembanding.length ? d.duplikat!.alasan : null,
                dibuatOleh: d.aktorId, dibuatOlehNama: d.aktorNama, dibuatPada: now,
            }).returning();
            await tx.insert(kunjunganLuarRute).values({
                id: randomUUID(), salesCode: d.salesCode, principle: d.principle, tanggal: d.tanggal, custCode: kode, custName: d.isian.namaToko,
                alamat: d.isian.alamat, customerId: null, dibuatOleh: d.aktorId, dibuatOlehNama: d.aktorNama,
            });
            await tx.insert(kontrolAuditLog).values({ id: randomUUID(), entity: "noo", entityId: row.id, action: "buat", actorId: d.aktorId,
                actorName: d.aktorNama, createdAt: now, payload: { kode, salesCode: d.salesCode, principle: d.principle, branchId: d.branchId,
                    tanggal: d.tanggal, duplikatDengan: row.duplikatDengan } });
            return { row, baru: true };
        });
        jadi = "row" in hasil && hasil.baru;
        return hasil;
    } finally {
        if (!jadi) await buangBerkas(berkas);
    }
}

// ---------------------------------------------------------------- baca

const AKTIF: StatusNoo[] = ["menunggu_spv", "disetujui"];
const SELESAI: StatusNoo[] = ["ditolak", "terdaftar"];
export const BATAS_SELESAI = 300;
const pembandingNoo = alias(nooToko, "noo_pembanding");
const kueriNoo = () => db.select({ n: nooToko, salesName: salesProfile.salesName, duplikatSalesCode: pembandingNoo.salesCode }).from(nooToko)
    .leftJoin(salesProfile, eq(salesProfile.salesCode, nooToko.salesCode))
    .leftJoin(pembandingNoo, eq(pembandingNoo.kode, nooToko.duplikatDengan));
const keBaris = (r: { n: BarisNoo; salesName: string | null; duplikatSalesCode: string | null }): BarisTampil =>
    ({ ...r.n, salesName: r.salesName, duplikatSalesCode: r.duplikatSalesCode });

/**
 * NOO dalam cakupan pemanggil (bolehBacaNoo sudah memutuskan global/tim); saring status/salesman opsional. Peninjau A T1: status AKTIF
 * (menunggu_spv, disetujui) SELALU lengkap tanpa batas — antrean SPV/Admin tidak pernah kehilangan pengajuan lama; yang SELESAI (ditolak,
 * terdaftar) hanya BATAS_SELESAI terbaru, `selesaiTerpotong` = ada yang tidak dimuat.
 */
export async function daftarNoo(a: AksesNoo, saring: { status?: StatusNoo[]; salesCode?: string }) {
    if (a.scope.allowedSalesCodes !== null && a.scope.allowedSalesCodes.length === 0) return { rows: [] as BarisTampil[], selesaiTerpotong: false };
    const cakupan = [
        a.scope.allowedSalesCodes === null ? undefined : inArray(nooToko.salesCode, a.scope.allowedSalesCodes),
        saring.salesCode ? eq(nooToko.salesCode, saring.salesCode) : undefined,
    ];
    const pilih = (kelompok: StatusNoo[]) => (saring.status?.length ? kelompok.filter((s) => saring.status!.includes(s)) : kelompok);
    const [aktif, selesai] = [pilih(AKTIF), pilih(SELESAI)];
    const barisAktif = aktif.length
        ? await kueriNoo().where(and(...cakupan, inArray(nooToko.status, aktif))).orderBy(desc(nooToko.dibuatPada), asc(nooToko.kode)) : [];
    const barisSelesai = selesai.length
        ? await kueriNoo().where(and(...cakupan, inArray(nooToko.status, selesai))).orderBy(desc(nooToko.dibuatPada), asc(nooToko.kode)).limit(BATAS_SELESAI + 1)
        : [];
    return { rows: [...barisAktif, ...barisSelesai.slice(0, BATAS_SELESAI)].map(keBaris), selesaiTerpotong: barisSelesai.length > BATAS_SELESAI };
}

/** Satu NOO + nama salesman (+ salesman NOO pembanding), atau null. Pemanggil memeriksa hakNoo (luar cakupan = 404). */
export async function ambilNoo(id: string): Promise<BarisTampil | null> {
    const [r] = await kueriNoo().where(eq(nooToko.id, id)).limit(1);
    return r ? keBaris(r) : null;
}

/** Ringkasan NOO pembanding (pengajuan "pemilik sama") untuk pemutus — tanpa NIK/HP. */
export async function ringkasPembanding(kode: string | null) {
    if (!kode) return null;
    const [r] = await db.select({ kode: nooToko.kode, namaToko: nooToko.namaToko, status: nooToko.status, salesCode: nooToko.salesCode,
        alamat: nooToko.alamat, customerNo: nooToko.customerNo }).from(nooToko).where(eq(nooToko.kode, kode)).limit(1);
    return r ?? null;
}

const TIDAK_ADA = galat(404, "NOO_TIDAK_ADA", "Pengajuan toko baru ini tidak ditemukan dalam cakupan Anda; muat ulang daftarnya.");

// ---------------------------------------------------------------- keputusan SPV/SM/Admin

/**
 * Setujui / tolak (alasan wajib ≥ 5 huruf). Pengajuan bertanda duplikat ("pemilik sama") hanya disetujui dengan `konfirmasiPemilikSama`
 * eksplisit (409 KONFIRMASI_DUPLIKAT_WAJIB; CHECK noo_toko_duplikat menjaga hal yang sama di DB); tolak tetap bisa. FOR UPDATE: dua
 * keputusan serentak = satu 200, satu 409 SUDAH_DIPUTUSKAN yang MENYEBUT pemenangnya (baca ulang sesudah kunci); UPDATE bersyarat status =
 * lapis kedua. Jejak: kolom diputuskan_* + audit `noo/setujui|tolak` (tanpa isi alasan).
 */
export async function putuskanNoo(d: { id: string; keputusan: "setujui" | "tolak"; alasan: string; konfirmasiPemilikSama: boolean;
    a: AksesNoo; aktorNama: string | null }): Promise<Hasil<{ row: BarisNoo }>> {
    return db.transaction(async (tx) => {
        const [r] = await tx.select().from(nooToko).where(eq(nooToko.id, d.id)).for("update").limit(1);
        if (!r || !bolehBacaNoo(d.a, r.salesCode)) return TIDAK_ADA;
        if (r.status !== "menunggu_spv") {
            return galat(409, "SUDAH_DIPUTUSKAN", `${r.kode} ${r.namaToko} sudah ${r.status === "ditolak" ? "ditolak" : "disetujui"}${r.diputuskanOlehNama ? ` oleh ${r.diputuskanOlehNama}` : ""}; muat ulang daftarnya.`);
        }
        if (!hakNoo(d.a, r).putuskan) {
            return galat(403, "BUKAN_PEMUTUS", r.dibuatOleh === d.a.userId ? "Pengaju tidak bisa memutuskan pengajuannya sendiri."
                : "Akun Anda tidak berhak menyetujui/menolak toko baru ini (SPV tim, SM di atasnya, atau Admin).");
        }
        const alasan = d.alasan.replace(/\s+/g, " ").trim();
        if (d.keputusan === "tolak" && alasan.length < 5) return galat(400, "ALASAN_WAJIB", "Alasan penolakan wajib diisi (minimal 5 huruf).");
        if (alasan.length > 500) return galat(400, "ALASAN_TERLALU_PANJANG", "Alasan maksimal 500 karakter.");
        if (d.keputusan === "setujui" && r.duplikatDengan && !d.konfirmasiPemilikSama) {
            return galat(409, "KONFIRMASI_DUPLIKAT_WAJIB", `${r.kode} memakai NIK/No. HP yang sama dengan ${r.duplikatDengan}. Centang konfirmasi "pemilik toko memang sama" untuk menyetujui, atau tolak.`);
        }
        const now = new Date();
        // Peninjau A S1: UPDATE BERSYARAT status (lapis kedua di samping FOR UPDATE) — baris yang sudah diputuskan tidak pernah ditimpa.
        const [row] = await tx.update(nooToko).set({
            status: d.keputusan === "setujui" ? "disetujui" : "ditolak", diputuskanOleh: d.a.userId, diputuskanOlehNama: d.aktorNama, diputuskanPada: now,
            alasanTolak: d.keputusan === "tolak" ? alasan : null, duplikatDikonfirmasi: d.keputusan === "setujui" && Boolean(r.duplikatDengan),
        }).where(and(eq(nooToko.id, r.id), eq(nooToko.status, "menunggu_spv"))).returning();
        if (!row) return galat(409, "SUDAH_DIPUTUSKAN", `${r.kode} ${r.namaToko} baru saja diputuskan pengguna lain; muat ulang daftarnya.`);
        await tx.insert(kontrolAuditLog).values({ id: randomUUID(), entity: "noo", entityId: r.id, action: d.keputusan, actorId: d.a.userId,
            actorName: d.aktorNama, createdAt: now, payload: { kode: r.kode, salesCode: r.salesCode, peran: d.a.scope.role,
                duplikatDengan: r.duplikatDengan, duplikatDikonfirmasi: row.duplikatDikonfirmasi } });
        return { row };
    });
}

// ---------------------------------------------------------------- tautkan (Admin)

/**
 * Admin sudah mendaftarkan toko di Accurate SECARA MANUAL; tautkan pelanggan hasil sync: hanya dari `disetujui`; pelanggan ada, tidak
 * suspended, cabang = cabang NOO, belum tertaut NOO lain (UNIQUE idx_noo_customer juga menjaga serentak) → `terdaftar` + audit.
 */
export async function tautkanNoo(d: { id: string; customerId: number; a: AksesNoo; aktorNama: string | null }): Promise<Hasil<{ row: BarisNoo }>> {
    try {
        return await db.transaction(async (tx) => {
            const [r] = await tx.select().from(nooToko).where(eq(nooToko.id, d.id)).for("update").limit(1);
            if (!r || !bolehBacaNoo(d.a, r.salesCode)) return TIDAK_ADA;
            if (r.status === "terdaftar") return galat(409, "SUDAH_TERDAFTAR", `${r.kode} sudah tertaut ke pelanggan ${r.customerNo}.`);
            if (r.status !== "disetujui") return galat(409, "BELUM_DISETUJUI", `${r.kode} belum disetujui SPV (status: ${r.status}); hanya NOO disetujui yang ditautkan.`);
            if (!hakNoo(d.a, r).tautkan) return galat(403, "BUKAN_ADMIN", "Penautan pelanggan hanya oleh grup Admin (izin tautkan NOO).");
            const [c] = await tx.select({ id: customer.id, customerNo: customer.customerNo, name: customer.name, branchId: customer.branchId,
                suspended: customer.suspended }).from(customer).where(eq(customer.id, d.customerId)).limit(1);
            if (!c) return galat(404, "PELANGGAN_TIDAK_DITEMUKAN", "Pelanggan itu belum ada di data sync; tunggu sync pelanggan berikutnya lalu cari lagi.");
            if (c.suspended) return galat(409, "PELANGGAN_NONAKTIF", `${c.customerNo} ${c.name} nonaktif (suspended) di Accurate.`);
            if (Number(c.branchId) !== Number(r.branchId)) {
                return galat(409, "CABANG_BERBEDA", `${c.customerNo} ${c.name} bukan pelanggan cabang ${r.branchName || r.branchId}; tautkan pelanggan cabang yang sama.`);
            }
            const [lain] = await tx.select({ kode: nooToko.kode }).from(nooToko).where(and(eq(nooToko.customerId, c.id), ne(nooToko.id, r.id))).limit(1);
            if (lain) return galat(409, "PELANGGAN_SUDAH_TERTAUT", `${c.customerNo} sudah tertaut ke ${lain.kode}.`);
            const now = new Date();
            // Peninjau A S1: UPDATE BERSYARAT status (lapis kedua di samping FOR UPDATE).
            const [row] = await tx.update(nooToko).set({ status: "terdaftar", customerId: Number(c.id), customerNo: c.customerNo,
                ditautkanOleh: d.a.userId, ditautkanOlehNama: d.aktorNama, ditautkanPada: now })
                .where(and(eq(nooToko.id, r.id), eq(nooToko.status, "disetujui"))).returning();
            if (!row) return galat(409, "SUDAH_TERDAFTAR", `${r.kode} baru saja ditautkan pengguna lain; muat ulang.`);
            await tx.insert(kontrolAuditLog).values({ id: randomUUID(), entity: "noo", entityId: r.id, action: "tautkan", actorId: d.a.userId,
                actorName: d.aktorNama, createdAt: now, payload: { kode: r.kode, customerId: Number(c.id), customerNo: c.customerNo } });
            return { row };
        });
    } catch (e) {
        // UNIQUE idx_noo_customer: penautan serentak pelanggan yang sama ke NOO lain menang lebih dulu.
        if ((e as { code?: string; cause?: { code?: string } })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505") {
            return galat(409, "PELANGGAN_SUDAH_TERTAUT", "Pelanggan itu baru saja ditautkan ke NOO lain; muat ulang.");
        }
        throw e;
    }
}

/**
 * Saran pelanggan untuk penautan (cabang NOO, tidak suspended, belum tertaut NOO): `cari` = nama/kode berisi teks itu (maks 20);
 * tanpa `cari` = pelanggan yang masuk/berubah di sync sejak NOO diajukan, diurut kemiripan kata nama toko (+ alamat), 5 teratas.
 * ponytail: kemiripan = irisan kata (Jaccard) di JS atas ≤ 500 kandidat terbaru; No. HP tidak dipakai (sync pelanggan tidak memintanya,
 *   keputusan orkestrator P4). Plafon: kandidat lama yang tidak berubah sejak NOO diajukan hanya ketemu lewat `cari`.
 */
export async function saranPelanggan(r: BarisNoo, cari: string) {
    const syarat = [eq(customer.branchId, r.branchId), eq(customer.suspended, false),
        sql`NOT EXISTS (SELECT 1 FROM ${nooToko} n WHERE n.customer_id = ${customer.id})`];
    const kolom = { id: customer.id, customerNo: customer.customerNo, name: customer.name, alamat: customer.alamat };
    const q = cari.trim().slice(0, 80);
    if (q) {
        return (await db.select(kolom).from(customer).where(and(...syarat, or(sql`${customer.name} ILIKE ${polaLike(q)}`,
            sql`${customer.customerNo} ILIKE ${polaLike(q)}`))).orderBy(sql`(upper(${customer.customerNo}) = upper(${q})) desc`, asc(customer.name)).limit(20))
            .map((c) => ({ ...c, id: Number(c.id), skor: null as number | null }));
    }
    const kandidat = await db.select(kolom).from(customer).where(and(...syarat, sql`${customer.syncedAt} >= ${r.dibuatPada}`))
        .orderBy(desc(customer.syncedAt)).limit(500);
    const kata = (s: string | null) => new Set(String(s ?? "").toUpperCase().split(/[^0-9A-Z]+/).filter((w) => w.length > 1));
    const mirip = (a: Set<string>, b: Set<string>) => { const i = [...a].filter((w) => b.has(w)).length; return i ? i / (a.size + b.size - i) : 0; };
    const nama = kata(r.namaToko), alamat = kata(r.alamat);
    return kandidat.map((c) => ({ ...c, id: Number(c.id), skor: Math.round((mirip(nama, kata(c.name)) + 0.5 * mirip(alamat, kata(c.alamat))) * 100) / 100 }))
        .filter((c) => c.skor > 0).sort((x, y) => y.skor - x.skor || x.name.localeCompare(y.name)).slice(0, 5);
}

// ---------------------------------------------------------------- kunjungan ulang (salesman)

/**
 * "Kunjungi lagi hari ini": NOO milik salesman (menunggu/disetujui) masuk kunjungan `tanggal` sebagai baris kunjungan_luar_rute (cust_code =
 * kode NOO). Sudah ada (belum batal) = baris yang sama. Terdaftar → 409 (pakai kunjungan luar rute berkode pelanggan Accurate).
 */
export async function kunjungiNoo(d: { id: string; principle: string; tanggal: string; a: AksesNoo; aktorNama: string | null }):
    Promise<Hasil<{ row: typeof kunjunganLuarRute.$inferSelect; baru: boolean }>> {
    const r = await ambilNoo(d.id);
    if (!r || !bolehBacaNoo(d.a, r.salesCode)) return TIDAK_ADA;
    if (r.status === "terdaftar") {
        return galat(409, "SUDAH_TERDAFTAR", `${r.namaToko} sudah terdaftar sebagai ${r.customerNo}; tambahkan lewat Kunjungan luar rute dengan kode pelanggan itu (order bisa dibuat).`);
    }
    if (r.status === "ditolak") return galat(409, "NOO_DITOLAK", `${r.kode} ${r.namaToko} ditolak; ajukan toko baru bila perlu.`);
    if (!hakNoo(d.a, r).kunjungi) return galat(403, "BUKAN_PEMILIK", "Hanya salesman pengaju yang menambahkan kunjungan toko baru ini.");
    const kunci = and(eq(kunjunganLuarRute.salesCode, r.salesCode), eq(kunjunganLuarRute.custCode, r.kode), eq(kunjunganLuarRute.principle, d.principle),
        eq(kunjunganLuarRute.tanggal, d.tanggal), isNull(kunjunganLuarRute.dibatalkanPada));
    return db.transaction(async (tx) => {
        const masuk = await tx.insert(kunjunganLuarRute).values({ id: randomUUID(), salesCode: r.salesCode, principle: d.principle, tanggal: d.tanggal,
            custCode: r.kode, custName: r.namaToko, alamat: r.alamat, customerId: null, dibuatOleh: d.a.userId, dibuatOlehNama: d.aktorNama })
            .onConflictDoNothing().returning({ id: kunjunganLuarRute.id });
        const [row] = await tx.select().from(kunjunganLuarRute).where(kunci).limit(1);
        if (masuk.length) {
            await tx.insert(kontrolAuditLog).values({ id: randomUUID(), entity: "luar_rute", entityId: row.id, action: "tambah", actorId: d.a.userId,
                actorName: d.aktorNama, createdAt: new Date(), payload: { salesCode: r.salesCode, principle: d.principle, tanggal: d.tanggal, custCode: r.kode, nooId: r.id } });
        }
        return { row, baru: masuk.length > 0 };
    });
}

// ---------------------------------------------------------------- KTP & foto (berkas privat)

/**
 * "Lihat KTP": hanya hakNoo().ktp (luar cakupan = 404; dalam cakupan tanpa hak = 403). Audit `noo/lihat_ktp` (payload: kode saja) DITULIS
 * SEBELUM NIK + foto dikembalikan — gagal mencatat = tidak ada data.
 */
export async function lihatKtp(d: { id: string; a: AksesNoo; aktorNama: string | null }): Promise<Hasil<{ nik: string; namaKtp: string; foto: Buffer; kode: string }>> {
    const r = await ambilNoo(d.id);
    if (!r || !bolehBacaNoo(d.a, r.salesCode)) return TIDAK_ADA;
    if (!hakNoo(d.a, r).ktp) {
        return galat(403, "KTP_TIDAK_BOLEH", r.dibuatOleh === d.a.userId
            ? "KTP hanya bisa dibuka pengaju selama menunggu persetujuan SPV."
            : "KTP lengkap hanya untuk SPV dan SM tim pengaju serta Admin; tampilan NIK tetap tersamar.");
    }
    let foto: Buffer;
    try { foto = await readFile(jalurBerkas(r.fotoKtp)); } catch { return galat(404, "BERKAS_KTP_HILANG", "Berkas foto KTP tidak ditemukan di server; hubungi Admin."); }
    await db.insert(kontrolAuditLog).values({ id: randomUUID(), entity: "noo", entityId: r.id, action: "lihat_ktp", actorId: d.a.userId,
        actorName: d.aktorNama, createdAt: new Date(), payload: { kode: r.kode } });
    return { nik: r.nik, namaKtp: r.namaKtp, foto, kode: r.kode };
}

/** Foto toko (bukan data pribadi KTP): siapa pun yang boleh membaca NOO ini. Luar cakupan = 404. */
export async function bacaFotoToko(d: { id: string; a: AksesNoo }): Promise<Hasil<{ foto: Buffer }>> {
    const r = await ambilNoo(d.id);
    if (!r || !bolehBacaNoo(d.a, r.salesCode)) return TIDAK_ADA;
    try { return { foto: await readFile(jalurBerkas(r.fotoToko)) }; } catch { return galat(404, "BERKAS_HILANG", "Foto toko tidak ditemukan di server."); }
}

// ---------------------------------------------------------------- ORDER ditolak untuk kunjungan NOO

/**
 * Owner 13 Okt (P7): kunjungan NOO memakai alasan tidak-order yang ada; status ORDER/aktif untuk kode NOO DITOLAK (409 NOO_BELUM_TERDAFTAR) —
 * toko belum punya kode pelanggan Accurate. Dipanggil route ao-control POST SEBELUM upsert. Bukan bentuk kode NOO = tanpa kueri.
 */
export async function tolakOrderNoo(custCode: unknown, status: unknown): Promise<NextResponse | null> {
    if ((status !== "ordered" && status !== "active") || !isKodeNoo(custCode)) return null;
    const [r] = await db.select({ namaToko: nooToko.namaToko, status: nooToko.status, customerNo: nooToko.customerNo }).from(nooToko)
        .where(eq(nooToko.kode, custCode as string)).limit(1);
    if (!r) return null;
    const sesudah = r.status === "terdaftar" && r.customerNo
        ? ` Toko ini sudah terdaftar sebagai ${r.customerNo}: kunjungi lewat Kunjungan luar rute dengan kode itu untuk mencatat ORDER.`
        : " ORDER bisa dicatat sesudah toko didaftarkan Admin di Accurate dan tertaut.";
    return NextResponse.json({ ok: false, kode: "NOO_BELUM_TERDAFTAR",
        error: `${r.namaToko} adalah toko baru (NOO) tanpa kode pelanggan Accurate; hasil kunjungan hanya "Tidak order" dengan alasan.${sesudah}` }, { status: 409 });
}
