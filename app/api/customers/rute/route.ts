/*
 * Tujuan: Cocokkan kode toko "Toko di rute hari ini" (kode JKS TANPA akhiran cabang, mis. C-100001) dengan pelanggan Accurate di CABANG
 *   pemakai (C-100001-<akhiran>) untuk pemilih toko rute Order Sales (FK-MSM butir 6, 12 Okt 2026). Data JKS tidak diubah.
 * Caller: app/(dashboard)/sales/OrderSales.tsx lewat components/order/order-cabang-api.ts (cocokkanTokoRute).
 * Dependensi: db customer/branch (hasil sync), lib/order-cabang (cakupanCabang, pilihPelangganRute), lib/principal-validation (channelOutlet),
 *   lib/rbac/resolve.
 * Main Functions: GET ?kode=&kode=… (1–200 kode unik per permintaan; pemilih memecah rute lebih panjang per 200 — order-cabang-api).
 * Side Effects: DB read-only.
 *
 * Izin & cakupan = /api/customers/search: `websales.create` ATAU `order.create`; salesman HANYA cabang karyawan Accurate-nya (kode yang
 * hanya ada di cabang lain = TIDAK_ADA, tidak pernah ditawarkan); petugas internal (`order.view`) semua cabang (kode di dua cabang = GANDA,
 * tidak menebak). Per kode: tepat satu pelanggan aktif = `pelanggan` (bentuk item pencarian); selain itu `masalah` + `alasan` (kalimat).
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNotNull, like, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { branch, customer } from "@/db/schema";
import { cakupanCabang, jawabGalat, pilihPelangganRute } from "@/lib/order-cabang";
import { channelOutlet } from "@/lib/principal-validation";
import { resolveRequestPermissions } from "@/lib/rbac/resolve";

export const runtime = "nodejs";

const BATAS_KODE_RUTE = 200;
const PANJANG_KODE_MAKS = 80;

export async function GET(request: NextRequest) {
    const gate = await resolveRequestPermissions(request);
    if (gate.response) return gate.response;
    if (!gate.perms?.has("websales.create") && !gate.perms?.has("order.create")) {
        return NextResponse.json({ ok: false, kode: "TIDAK_DIIZINKAN", error: "Akses master pelanggan tidak diizinkan" }, { status: 403 });
    }
    const kode = [...new Set(request.nextUrl.searchParams.getAll("kode").map((k) => k.trim()).filter(Boolean))];
    // ponytail: BATAS_KODE_RUTE = 200 kode per permintaan (panjang URL); pemilih Order Sales memecah rute yang lebih panjang (KC3), jadi
    // > 200 di sini = pemanggil lain, dijawab dengan kalimat. Kode > 80 huruf = alasan untuk toko itu saja, bukan menggagalkan semuanya.
    if (kode.length === 0 || kode.length > BATAS_KODE_RUTE) {
        return NextResponse.json({ ok: false, kode: "INPUT_TIDAK_VALID",
            error: `kode wajib: 1–${BATAS_KODE_RUTE} kode toko per permintaan (diterima ${kode.length}); pecah daftar yang lebih panjang.` }, { status: 400 });
    }
    const sah = kode.filter((k) => k.length <= PANJANG_KODE_MAKS);

    const scope = await cakupanCabang(String(gate.session?.user?.id ?? ""), gate.perms);
    if ("galat" in scope) return jawabGalat(scope.galat);
    const cakupan = scope.cakupan;

    // Kandidat = kode persis ATAU berawalan kode + "-" (huruf besar, ter-trim); aturan "satu akhiran" diputuskan pilihPelangganRute.
    // `%`/`_`/`\` dari kode JKS diperlakukan sebagai huruf biasa. Tanpa saring suspended: pelanggan nonaktif dilaporkan, bukan disembunyikan.
    const no = sql`upper(trim(${customer.customerNo}))`;
    const besar = sah.map((k) => k.toUpperCase());
    const syarat: SQL[] = [isNotNull(customer.branchId),
        or(inArray(no, besar), ...besar.map((k) => like(no, `${k.replace(/[\\%_]/g, (c) => `\\${c}`)}-%`)))!];
    if (!cakupan.semua) syarat.push(eq(customer.branchId, cakupan.branchId));
    const rows = besar.length === 0 ? [] : await db.select({
        id: customer.id, customerNo: customer.customerNo, name: customer.name, branchId: customer.branchId,
        branchName: sql<string | null>`coalesce(${branch.name}, ${customer.branchName})`,
        categoryName: customer.categoryName, priceCategoryName: customer.priceCategoryName, alamat: customer.alamat,
        suspended: customer.suspended,
    }).from(customer).leftJoin(branch, eq(branch.id, customer.branchId)).where(and(...syarat));

    const cabangAnda = cakupan.semua ? "" : ` (${cakupan.branchName || cakupan.branchId})`;
    return NextResponse.json({
        ok: true,
        cakupan: cakupan.semua ? { semua: true, branchId: null, branchName: null }
            : { semua: false, branchId: cakupan.branchId, branchName: cakupan.branchName },
        rute: kode.map((k) => {
            if (k.length > PANJANG_KODE_MAKS) {
                return { kode: k, pelanggan: null, masalah: "KODE_TIDAK_SAH", kandidat: [],
                    alasan: `Kode toko lebih dari ${PANJANG_KODE_MAKS} huruf; periksa kode toko di JKS.` };
            }
            const h = pilihPelangganRute(k, rows);
            const alasan = h.masalah === "GANDA"
                ? `Lebih dari satu pelanggan${cakupan.semua ? "" : " cabang Anda"} cocok (${h.kandidat.join(", ")}); pilih lewat Cari pelanggan.`
                : h.masalah === "NONAKTIF" ? `Pelanggan ${h.kandidat.join(", ")} nonaktif (suspended) di Accurate; tidak bisa diorder.`
                : h.masalah === "TIDAK_ADA" ? (cakupan.semua ? "Belum terdaftar sebagai pelanggan di Accurate."
                    : `Belum terdaftar sebagai pelanggan cabang Anda${cabangAnda} di Accurate.`)
                : "";
            const p = h.pelanggan;
            if (!p) return { kode: k, pelanggan: null, masalah: h.masalah, kandidat: h.kandidat, alasan };
            // Bentuk item /api/customers/search (tanpa `suspended`: yang terpilih selalu aktif).
            return { kode: k, masalah: null, kandidat: h.kandidat, alasan, pelanggan: { id: p.id, customerNo: p.customerNo, name: p.name,
                branchId: p.branchId, branchName: p.branchName, categoryName: p.categoryName, priceCategoryName: p.priceCategoryName,
                alamat: p.alamat, channel: channelOutlet(p.categoryName) } };
        }),
    });
}
