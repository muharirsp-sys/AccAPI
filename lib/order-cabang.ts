/*
 * Tujuan: Order per cabang Accurate (O1, owner 12 Okt 2026). Pelanggan cabang X hanya boleh dipesankan barang bercabang X; cabang
 *   salesman = cabang karyawannya di Accurate; harga = cabang pelanggan. SATU pemeriksa untuk pratinjau dan simpan order.
 * Caller: lib/sync (tag barang -> cabang), app/api/orders/{preview,harga}, app/api/customers/search, app/api/items/search.
 * Dependensi: db (customer, item, branch, accurate_employee, sales_profile), lib/item-price (resolvePrices).
 * Main Functions: cabangDariTag, petaCabang (murni); cakupanCabang, periksaOrder (DB baca-saja).
 * Side Effects: DB read-only.
 * Kontrak: docs/handover/O1-KONTRAK-ORDER-CABANG.md.
 */
import { NextResponse } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { branch, customer, item } from "@/db/schema";
import { resolvePrices, type PriceResult } from "@/lib/item-price";

// ---------------------------------------------------------------- tag divisi barang -> cabang (murni)

// ponytail: pemetaan tag divisi Accurate (`item.charField2`) -> cabang = SATU konstanta (keputusan owner 12 Okt 2026). Tag yang sama
//   dengan nama cabang tidak ditulis di sini (dicocokkan langsung ke tabel `branch`). Batas: tag baru di Accurate = ubah berkas ini +
//   deploy; sampai saat itu barangnya tak bisa diorder dan terhitung di `tagTakDikenal` hasil sync. Jalan naik bila tag sering berubah:
//   tabel pemetaan + layar admin.
export const TAG_KE_CABANG: Readonly<Record<string, string>> = {
    "24MNF1": "MIX NON FOOD",
    "21MNF2": "MIX NON FOOD",
    FRN: "SHINZUI",
    "HEINZ ABC": "HEINZ",
    MIX2: "DOLPHIN",
    FKS: "MIX FOOD",
};

/** Barang non-jual (aset, ATK, perlengkapan gudang) — tidak pernah bisa diorder. */
export const TAG_NON_JUAL: ReadonlySet<string> = new Set([
    "ALAT TULIS KANTOR", "ASSET", "AMARON", "LAKBAN BENING", "PEMBELIAN ASET", "PRINTER",
]);

/** Huruf besar, trim, spasi ganda dirapatkan. Tanda baca TIDAK diubah ("FORISA - MT" tetap begitu) — mengubahnya = menebak. */
export const normalNama = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ").toUpperCase();

export type JenisTag = "cabang" | "peta" | "non_jual" | "kosong" | "tak_dikenal";

/** Nama cabang ternormal -> id cabang Accurate (dari tabel `branch`). */
export function petaCabang(rows: readonly { id: number; name: string }[]): Map<string, number> {
    return new Map(rows.map((r) => [normalNama(r.name), Number(r.id)]));
}

/** Tag divisi -> cabang. null = tidak bisa diorder (non-jual, kosong, atau tak dikenal — yang terakhir WAJIB tercatat pemanggil). */
export function cabangDariTag(tag: unknown, peta: ReadonlyMap<string, number>): { branchId: number | null; jenis: JenisTag } {
    const t = normalNama(tag);
    if (!t) return { branchId: null, jenis: "kosong" };
    if (TAG_NON_JUAL.has(t)) return { branchId: null, jenis: "non_jual" };
    const nama = TAG_KE_CABANG[t] ?? t;
    const id = peta.get(nama);
    if (id === undefined) return { branchId: null, jenis: "tak_dikenal" };
    return { branchId: id, jenis: nama === t ? "cabang" : "peta" };
}

// ---------------------------------------------------------------- cakupan cabang pemakai

export type Cakupan = { semua: true } | { semua: false; branchId: number; branchName: string; salesCode: string };
export type GalatOrder = { status: number; kode: string; error: string; [k: string]: unknown };

/**
 * Petugas internal (punya `order.view` — admin/fakturist/Order Masuk) = semua cabang. Selain itu (akun sales: hanya `websales.*`) =
 * cabang karyawan Accurate yang ditautkan admin lewat `sales_profile.sales_code` = `accurate_employee.number` (owner 12 Okt: cabang
 * salesman = `accurate_employee.branch_id`). `sales_profile.accurate_branch_id` SENGAJA tidak dibaca: salinan cabang akan basi diam-diam
 * begitu karyawan dipindah cabang di Accurate; cabang karyawan ikut sync employee/list.do.
 */
export async function cakupanCabang(userId: string, perms: ReadonlySet<string>): Promise<{ cakupan: Cakupan } | { galat: GalatOrder }> {
    if (perms.has("order.view")) return { cakupan: { semua: true } };
    const res = await db.execute(sql`
        SELECT sp.sales_code, e.id AS employee_id, e.branch_id, e.salesman, e.suspended, b.name AS branch_name
        FROM sales_profile sp
        LEFT JOIN accurate_employee e ON upper(trim(e.number)) = upper(trim(sp.sales_code))
        LEFT JOIN branch b ON b.id = e.branch_id
        WHERE sp.user_id = ${userId}`);
    const rows = res.rows as Array<{ sales_code: string; employee_id: number | null; branch_id: number | string | null;
        salesman: boolean | null; suspended: boolean | null; branch_name: string | null }>;
    const belum = (alasan: string): { galat: GalatOrder } => ({ galat: { status: 403, kode: "SALESMAN_BELUM_TERHUBUNG",
        error: `Akun Anda belum terhubung ke karyawan salesman Accurate${alasan}. Minta admin menautkannya di menu User; sampai itu order tidak bisa dibuat.` } });
    const kode = [...new Set(rows.map((r) => r.sales_code))];
    if (kode.length === 0) return belum("");
    if (kode.length > 1) return belum(` (akun punya ${kode.length} profil sales: ${kode.join(", ")})`);
    if (!rows.some((r) => r.employee_id !== null)) return belum(` (kode ${kode[0]} tidak ada di karyawan Accurate)`);
    const aktif = rows.filter((r) => r.salesman === true && r.suspended !== true && r.branch_id !== null);
    if (aktif.length !== 1) {
        const sebab = aktif.length > 1 ? "lebih dari satu karyawan aktif bernomor itu"
            : rows.some((r) => r.suspended) ? "karyawan nonaktif (suspended) di Accurate"
            : rows.some((r) => r.salesman !== true) ? "karyawan bukan salesman di Accurate" : "karyawan belum punya cabang di Accurate";
        return { galat: { status: 403, kode: "SALESMAN_TIDAK_AKTIF",
            error: `Karyawan Accurate ${kode[0]} yang tertaut ke akun Anda tidak bisa dipakai untuk order: ${sebab}. Hubungi admin.` } };
    }
    const r = aktif[0];
    return { cakupan: { semua: false, branchId: Number(r.branch_id), branchName: r.branch_name ?? "", salesCode: kode[0] } };
}

/** Galat berkode -> jawaban `{ ok:false, kode, error, ... }` dengan status HTTP-nya. */
export function jawabGalat(g: GalatOrder & { ok?: boolean }): NextResponse {
    const isi: Record<string, unknown> = { ...g };
    delete isi.status;
    delete isi.ok;
    return NextResponse.json({ ok: false, ...isi }, { status: g.status });
}

/** Salesman hanya cabangnya; `branchId` lain DITOLAK (bukan diabaikan diam-diam). */
export function tolakCabangLain(cakupan: Cakupan, branchId: number | null, apa: string): GalatOrder | null {
    if (cakupan.semua || branchId === null || branchId === cakupan.branchId) return null;
    return { status: 403, kode: "CABANG_DI_LUAR_CAKUPAN",
        error: `${apa} di luar cabang Anda (${cakupan.branchName || cakupan.branchId}). Salesman hanya bisa order untuk cabangnya sendiri.` };
}

/** `%`, `_`, dan `\` dari ketikan pemakai diperlakukan sebagai huruf biasa, bukan pola LIKE (ILIKE memakai `\` sebagai escape). */
export const polaLike = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Bilangan bulat non-negatif dari query; kosong -> null; selain itu undefined (= tidak valid). */
export function angkaQuery(v: string | null): number | null | undefined {
    if (v === null || v.trim() === "") return null;
    return /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : undefined;
}

// ---------------------------------------------------------------- pemeriksa order (pratinjau = simpan)

export type BarisOrder = { code: string; unit: string };
export type PelangganOrder = { id: number; customerNo: string; name: string; branchId: number; branchName: string; categoryName: string | null };
export type HasilPeriksa = { ok: true; pelanggan: PelangganOrder; harga: PriceResult[] } | ({ ok: false } & GalatOrder);

const tolak = (status: number, kode: string, error: string, extra: Record<string, unknown> = {}): HasilPeriksa =>
    ({ ok: false, status, kode, error, ...extra });

/**
 * Satu pemeriksa untuk pratinjau (`/api/orders/preview`) dan simpan (`/api/orders/harga`, dipanggil FastAPI saat Order Sales disimpan
 * dan saat order ditarik/disimpan internal): pelanggan ada, tidak suspended, bercabang, di cakupan pemakai; barang ada, tidak
 * suspended, cabangnya = cabang pelanggan; lalu (bila `harga`) satuan sah dan harga per CABANG PELANGGAN (dibaca server, bukan dari
 * badan permintaan). `harga: false` = hanya aturan cabang — input internal Order Baru membawa harga petugas sendiri.
 */
export async function periksaOrder(input: { customerNo: string; orderDate: string; lines: BarisOrder[]; cakupan: Cakupan; harga?: boolean }): Promise<HasilPeriksa> {
    const customerNo = input.customerNo.trim();
    if (!customerNo) return tolak(400, "PELANGGAN_WAJIB", "Kode pelanggan Accurate wajib diisi.");
    const [p] = await db.select({
        id: customer.id, customerNo: customer.customerNo, name: customer.name, branchId: customer.branchId,
        branchName: sql<string | null>`coalesce(${branch.name}, ${customer.branchName})`, suspended: customer.suspended,
        categoryName: customer.categoryName,
    }).from(customer).leftJoin(branch, eq(branch.id, customer.branchId)).where(eq(customer.customerNo, customerNo)).limit(1);
    if (!p) return tolak(409, "PELANGGAN_TIDAK_ADA", `Pelanggan ${customerNo} tidak ada di master Accurate hasil sync.`);
    if (p.suspended) return tolak(409, "PELANGGAN_SUSPENDED", `Pelanggan ${customerNo} (${p.name}) nonaktif (suspended) di Accurate; tidak bisa diorder.`);
    if (p.branchId === null) return tolak(409, "PELANGGAN_TANPA_CABANG", `Pelanggan ${customerNo} belum punya cabang di Accurate; cabang order tidak bisa ditentukan.`);
    const luar = tolakCabangLain(input.cakupan, p.branchId, `Pelanggan ${customerNo}`);
    if (luar) return { ok: false, ...luar };
    const pelanggan: PelangganOrder = { id: p.id, customerNo: p.customerNo, name: p.name, branchId: p.branchId,
        branchName: p.branchName ?? "", categoryName: p.categoryName };

    const codes = [...new Set(input.lines.map((l) => l.code.trim()).filter(Boolean))];
    const rows = codes.length ? await db.select({
        no: item.no, name: item.name, branchId: item.branchId, suspended: item.suspended, tag: item.charField2, branchName: branch.name,
    }).from(item).leftJoin(branch, eq(branch.id, item.branchId)).where(inArray(item.no, codes)) : [];
    const barang = new Map(rows.map((r) => [r.no, r]));
    const tidakAda = codes.filter((c) => !barang.has(c));
    if (tidakAda.length) return tolak(409, "BARANG_TIDAK_ADA", `Barang tidak ada di master Accurate: ${tidakAda.slice(0, 5).join(", ")}`, { barang: tidakAda });
    const nonaktif = codes.filter((c) => barang.get(c)!.suspended);
    if (nonaktif.length) return tolak(409, "BARANG_SUSPENDED", `Barang nonaktif (suspended) di Accurate: ${nonaktif.slice(0, 5).join(", ")}`, { barang: nonaktif });
    const beda = codes.map((c) => barang.get(c)!).filter((b) => b.branchId !== p.branchId);
    if (beda.length) {
        const ket = (b: (typeof beda)[number]) => b.branchId === null
            ? `${b.no} (tanpa cabang${b.tag ? `, tag "${b.tag}" tidak bisa diorder` : ""})`
            : `${b.no} (cabang ${b.branchName ?? b.branchId})`;
        return tolak(409, "BARANG_BEDA_CABANG",
            `Barang bukan barang cabang ${pelanggan.branchName || p.branchId} milik pelanggan ini: ${beda.slice(0, 5).map(ket).join("; ")}`,
            { barang: beda.map((b) => ({ code: b.no, name: b.name, branchId: b.branchId, branchName: b.branchName ?? null, tag: b.tag })) });
    }
    if (input.harga === false) return { ok: true, pelanggan, harga: [] };

    const harga = await resolvePrices(input.lines.map((l) => ({ code: l.code.trim(), unit: l.unit.trim().toUpperCase() })), {
        orderDate: input.orderDate, customerNo, branchId: p.branchId,
    });
    // Satuan di luar master DITOLAK, bukan dihitung dengan harga standar: selisih satuan pada satu item bisa 72x.
    const wrongUnit = harga.filter((row) => row.knownUnits?.length);
    if (wrongUnit.length) {
        return tolak(409, "SATUAN_SALAH", wrongUnit.slice(0, 3)
            .map((row) => `Satuan ${row.unit} tidak ada di master untuk ${row.code} (tersedia: ${row.knownUnits!.join(", ")})`).join("; "),
        { wrong_unit: wrongUnit.map((row) => ({ code: row.code, unit: row.unit, known_units: row.knownUnits })) });
    }
    const missing = harga.filter((row) => row.price === null).map((row) => row.code);
    if (missing.length) {
        return tolak(409, "HARGA_BELUM_ADA", `Harga belum tersedia dari Accurate untuk: ${[...new Set(missing)].slice(0, 5).join(", ")}`, { missing });
    }
    return { ok: true, pelanggan, harga };
}
