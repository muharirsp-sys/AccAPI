/*
 * Tujuan: Order per cabang Accurate (O1, owner 12 Okt 2026). Pelanggan cabang X hanya boleh dipesankan barang bercabang X; cabang
 *   salesman = cabang karyawannya di Accurate; harga = cabang pelanggan. SATU pemeriksa untuk pratinjau dan simpan order.
 * Caller: lib/sync (tag barang -> cabang), app/api/orders/{preview,harga}, app/api/customers/{search,rute}, app/api/items/search.
 * Dependensi: db (customer, item, branch, accurate_employee, sales_profile), lib/item-price (resolvePrices).
 * Main Functions: cabangDariTag, petaCabang, hargaSah, hargaPetugasSah, putusanHarga, alasanBonus, tripwireIzin, cocokKodeRute,
 *   pilihPelangganRute (murni); cakupanCabang,
 *   periksaOrder, periksaBonus (DB baca-saja).
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
    const tripwire = tripwireIzin(perms);
    if (tripwire) return { galat: tripwire };
    if (perms.has("order.view")) return { cakupan: { semua: true } };
    // Hanya profil yang DITAUTKAN admin (`accurate_linked`); profil Form Kontrol yang tautannya dilepas tetap ada tetapi tidak membuka order.
    const res = await db.execute(sql`
        SELECT sp.sales_code, e.id AS employee_id, e.branch_id, e.salesman, e.suspended, b.name AS branch_name
        FROM sales_profile sp
        LEFT JOIN accurate_employee e ON upper(trim(e.number)) = upper(trim(sp.sales_code))
        LEFT JOIN branch b ON b.id = e.branch_id
        WHERE sp.user_id = ${userId} AND sp.accurate_linked`);
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

/**
 * Tripwire izin (butir 11): akun ber-`websales.create` (sales) yang juga punya `order.view` tetapi TANPA `order.create` akan diam-diam
 * mendapat cakupan SEMUA cabang (penanda petugas internal = `order.view`). Itu salah konfigurasi grup, bukan izin: ditolak berkode
 * sampai admin membetulkan grupnya (DDL_O1 VERIFIKASI memeriksa hal yang sama per grup). Murni — diuji tanpa DB.
 */
export function tripwireIzin(perms: ReadonlySet<string>): GalatOrder | null {
    if (!perms.has("websales.create") || !perms.has("order.view") || perms.has("order.create")) return null;
    return { status: 403, kode: "IZIN_TIDAK_KONSISTEN",
        error: "Akun Anda punya izin Order Sales sekaligus lihat Order Masuk tanpa izin membuat order, jadi cakupan cabang tidak bisa dipastikan. "
            + "Minta admin membetulkan grup akses (sales: hanya websales.*; petugas: order.create)." };
}

// ---------------------------------------------------------------- toko rute JKS -> pelanggan cabang (FK-MSM butir 6, murni)

/**
 * Kode toko JKS (tanpa akhiran cabang, mis. C-100001) cocok dengan `customerNo` Accurate bila sama persis ATAU kode + "-" + SATU akhiran
 * (C-100001-MSM; master Accurate memberi satu customerNo per cabang). Tak peka huruf; spasi di dalam kode TIDAK ditebak ("C- FA0164").
 * ponytail: akhiran tidak dicocokkan ke nama cabang (tak ada pemetaan akhiran -> cabang); pembatas cabangnya = kueri pemanggil.
 */
export function cocokKodeRute(kode: string, customerNo: string): boolean {
    const k = kode.trim().toUpperCase(), c = customerNo.trim().toUpperCase();
    if (!k) return false;
    if (c === k) return true;
    const akhiran = c.startsWith(`${k}-`) ? c.slice(k.length + 1) : "";
    return akhiran !== "" && !akhiran.includes("-");
}

export type MasalahRute = "TIDAK_ADA" | "GANDA" | "NONAKTIF";
/** Satu kode toko JKS -> tepat SATU pelanggan aktif di antara `kandidat` (sudah dibatasi cabang pemakai); selain itu masalahnya. */
export function pilihPelangganRute<T extends { customerNo: string; suspended: boolean }>(kode: string, kandidat: readonly T[]):
    { pelanggan: T; masalah: null; kandidat: string[] } | { pelanggan: null; masalah: MasalahRute; kandidat: string[] } {
    const cocok = kandidat.filter((c) => cocokKodeRute(kode, c.customerNo));
    const aktif = cocok.filter((c) => !c.suspended);
    if (aktif.length === 1) return { pelanggan: aktif[0], masalah: null, kandidat: [aktif[0].customerNo] };
    if (aktif.length > 1) return { pelanggan: null, masalah: "GANDA", kandidat: aktif.map((c) => c.customerNo) };
    return { pelanggan: null, masalah: cocok.length ? "NONAKTIF" : "TIDAK_ADA", kandidat: cocok.map((c) => c.customerNo) };
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

// ---------------------------------------------------------------- harga order (murni)

/**
 * Harga master yang SAH untuk order (O1 putaran 1, butir 3): baris daftar harga Accurate (`tier`; BUKAN `item.unitPrice` — satu angka
 * untuk semua satuan, terbukti KRT dibekukan 6306 = harga PCS), > 0 (tanggal mundur pernah menghasilkan 0 -> faktur 0), dan dari cabang
 * PELANGGAN — atau cabang DEFAULT bila cabang pelanggan tak punya baris yang berlaku pada tanggal order. Default = daftar harga pusat
 * yang memang dipakai Accurate untuk cabang tanpa harga sendiri (aturan fallback lib/item-price, 2026-09-08). Cabang LAIN (urutan
 * terakhir resolvePrices: id terkecil) TIDAK pernah sah: harga cabang lain = salah harga diam-diam.
 */
export function hargaSah(row: PriceResult, branchId: number): boolean {
    return row.source === "tier" && typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0
        && row.branchId !== undefined && (row.branchId === branchId || row.defaultBranch === true);
}

/** Kenapa harga master tidak sah — untuk kalimat galat `HARGA_BELUM_ADA`. */
export function alasanHarga(row: PriceResult, branchId: number): string {
    if (row.source === "missing" || row.price === null) return "belum ada";
    if (row.source === "standard") return "hanya harga standar barang (bukan daftar harga Accurate per satuan)";
    if (!(row.price > 0)) return `harga ${row.price}`;
    if (row.branchId !== branchId && row.defaultBranch !== true) return `harga cabang lain (${row.branchName || row.branchId})`;
    return "tidak sah";
}

// ponytail: bentuk SAMA dengan Python (order_cabang.HARGA_PETUGAS) — angka biasa, maks 4 desimal, tanpa tanda/eksponen/pemisah ribuan.
export const HARGA_PETUGAS = /^\d{1,12}(\.\d{1,4})?$/;
/** Harga ketikan petugas (Order Baru): teks angka > 0, atau null. */
export const hargaPetugasSah = (teks: string) => HARGA_PETUGAS.test(teks) && Number(teks) > 0 ? Number(teks) : null;

export type PutusanHarga =
    | { jenis: "master"; price: number }
    | { jenis: "petugas"; price: number }
    | { jenis: "petugas_ditolak"; hargaMaster: number }
    | { jenis: "petugas_tidak_valid" }
    | { jenis: "belum_ada" };

/**
 * Harga SATU baris order (owner sesi 13, 12 Okt 2026 — menggantikan "harga petugas selalu menang"): harga master SAH (`hargaSah`) SELALU
 * dipakai bila ada; harga PETUGAS (Order Baru) HANYA untuk baris TANPA harga master sah, wajib > 0. Harga petugas pada baris berharga
 * master = `petugas_ditolak` (pemanggil menolak berkode, TIDAK diabaikan diam-diam). Murni — satu-satunya keputusan, diuji tanpa DB.
 */
export function putusanHarga(petugasTeks: string, row: PriceResult, branchId: number): PutusanHarga {
    const master = hargaSah(row, branchId) ? (row.price as number) : null;
    const teks = petugasTeks.trim();
    if (teks === "") return master === null ? { jenis: "belum_ada" } : { jenis: "master", price: master };
    if (master !== null) return { jenis: "petugas_ditolak", hargaMaster: master };
    const nilai = hargaPetugasSah(teks);
    return nilai === null ? { jenis: "petugas_tidak_valid" } : { jenis: "petugas", price: nilai };
}

// ---------------------------------------------------------------- pemeriksa order (pratinjau = simpan)

/** `price` = harga PETUGAS (Order Baru) — pemanggil yang memastikan izinnya (`order.create`/layanan); kosong = harga master. */
export type BarisOrder = { code: string; unit: string; price?: string };
export type PelangganOrder = { id: number; customerNo: string; name: string; branchId: number; branchName: string; categoryName: string | null };
/** Harga terpakai per baris: master sah (`tier`) atau petugas (`petugas` — hanya baris tanpa harga master sah, jadi `hargaMaster` selalu null).
 * `hargaDefault` = harga master dari cabang DEFAULT karena cabang pelanggan tak punya baris berlaku (fallback; putaran 2 butir 9). */
export type HargaBaris = Omit<PriceResult, "price" | "source"> & { price: number; source: "tier" | "petugas"; hargaMaster?: number | null; hargaDefault?: boolean;
    /** Isi tiap satuan barang dalam satuan dasar (master Accurate), mis. { PCS: 1, KRT: 120 }: mesin promo menghitung ambang lintas satuan. */
    rasio?: Record<string, number> };

type SatuanBarang = { unit1Name: string | null; unit2Name: string | null; unit3Name: string | null; unit4Name: string | null; unit5Name: string | null;
    ratio2: number | null; ratio3: number | null; ratio4: number | null; ratio5: number | null };
/** unit1 = satuan dasar (isi 1); unit2..5 = kelipatannya lewat ratio. Satuan tanpa nama/rasio sah dilewati — mesin promo menahan
 * order yang butuh rasio itu (owner 16 Okt 2026), jadi yang tak pasti tidak pernah ditebak. */
export function rasioSatuan(b: SatuanBarang): Record<string, number> {
    const pasang: Array<[string | null, number | null]> = [[b.unit1Name, 1], [b.unit2Name, b.ratio2], [b.unit3Name, b.ratio3], [b.unit4Name, b.ratio4], [b.unit5Name, b.ratio5]];
    const hasil: Record<string, number> = {};
    for (const [nama, isi] of pasang) {
        const kunci = String(nama ?? "").trim().toUpperCase();
        if (kunci && typeof isi === "number" && Number.isFinite(isi) && isi > 0) hasil[kunci] = isi;
    }
    return hasil;
}
/** `sumber_harga` jawaban pratinjau/harga + baris beku: "master" | "master_default" (fallback cabang default) | "petugas". */
export const sumberHarga = (h: HargaBaris) => (h.source === "petugas" ? "petugas" : h.hargaDefault ? "master_default" : "master");

// ---------------------------------------------------------------- barang bonus promo (O1 putaran 2, butir 7)

type BarisBarang = { no: string; name: string; branchId: number | null; suspended: boolean; tag: string | null; branchName: string | null };

/**
 * Barang BONUS promo wajib memenuhi syarat yang SAMA dengan barang order (keputusan orkestrator mengikuti owner "pelanggan cabang X hanya
 * barang cabang X"): ada di master, tidak suspended, cabang = cabang pelanggan (barang tanpa cabang = non-jual/tag tak dikenal = tidak
 * bisa diorder). null = boleh. Murni — satu keputusan untuk pratinjau dan simpan/tarik.
 */
export function alasanBonus(row: BarisBarang | undefined, branchId: number): string | null {
    if (!row) return "tidak ada di master Accurate";
    if (row.suspended) return "nonaktif (suspended) di Accurate";
    if (row.branchId === null) return `tanpa cabang${row.tag ? ` (tag "${row.tag}" tidak bisa diorder)` : ""}`;
    if (row.branchId !== branchId) return `barang cabang ${row.branchName ?? row.branchId}`;
    return null;
}

/** Bonus yang tidak bisa diorder -> galat 409 `BONUS_TIDAK_BISA_DIORDER` (`bonus: [{code, name, alasan}]`); semua boleh -> null. */
export async function periksaBonus(pelanggan: { branchId: number; branchName: string }, codes: readonly string[]): Promise<GalatOrder | null> {
    const kode = [...new Set(codes.map((c) => String(c ?? "").trim()).filter(Boolean))];
    if (!kode.length) return null;
    const rows = await db.select({
        no: item.no, name: item.name, branchId: item.branchId, suspended: item.suspended, tag: item.charField2, branchName: branch.name,
    }).from(item).leftJoin(branch, eq(branch.id, item.branchId)).where(inArray(item.no, kode));
    const ada = new Map(rows.map((r) => [r.no, r]));
    const buruk = kode.flatMap((c) => {
        const alasan = alasanBonus(ada.get(c), pelanggan.branchId);
        return alasan ? [{ code: c, name: ada.get(c)?.name ?? null, alasan }] : [];
    });
    if (!buruk.length) return null;
    return { status: 409, kode: "BONUS_TIDAK_BISA_DIORDER",
        error: `Barang bonus promo tidak bisa diorder untuk pelanggan cabang ${pelanggan.branchName || pelanggan.branchId}: `
            + `${buruk.slice(0, 5).map((b) => `${b.code} (${b.alasan})`).join("; ")}. Perbaiki aturan promo (Summary) atau master barang; `
            + "order tidak disimpan tanpa bonusnya.", bonus: buruk };
}
export type HasilPeriksa = { ok: true; pelanggan: PelangganOrder; harga: HargaBaris[] } | ({ ok: false } & GalatOrder);

const tolak = (status: number, kode: string, error: string, extra: Record<string, unknown> = {}): HasilPeriksa =>
    ({ ok: false, status, kode, error, ...extra });

/**
 * Satu pemeriksa untuk pratinjau (`/api/orders/preview`) dan simpan (`/api/orders/harga`, dipanggil FastAPI saat Order Sales/Order Baru
 * disimpan dan saat order ditarik): pelanggan ada, tidak suspended, bercabang, di cakupan pemakai; barang ada, tidak suspended,
 * cabangnya = cabang pelanggan; satuan sah; lalu harga PER BARIS (`putusanHarga`): harga master SAH per CABANG PELANGGAN (`hargaSah`;
 * dibaca server, bukan dari badan permintaan) bila ada — harga petugas di baris itu DITOLAK `HARGA_PETUGAS_TIDAK_DIIZINKAN`; baris tanpa
 * harga master sah memakai `price` petugas (> 0, tidak ditimpa) atau ditolak `HARGA_BELUM_ADA`. Hasil yang sama dipakai pratinjau dan
 * simpan, jadi promo dihitung atas angka yang sama (kontrak §4).
 */
export async function periksaOrder(input: { customerNo: string; orderDate: string; lines: BarisOrder[]; cakupan: Cakupan; bonus?: readonly string[] }): Promise<HasilPeriksa> {
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
    // Barang bonus (dikirim FastAPI sesudah promo dihitung; boleh tanpa baris = mode bonus saja) — butir 7.
    const bonusBuruk = await periksaBonus(pelanggan, input.bonus ?? []);
    if (bonusBuruk) return { ok: false, ...bonusBuruk };

    const codes = [...new Set(input.lines.map((l) => l.code.trim()).filter(Boolean))];
    const rows = codes.length ? await db.select({
        no: item.no, name: item.name, branchId: item.branchId, suspended: item.suspended, tag: item.charField2, branchName: branch.name,
        unit1Name: item.unit1Name, unit2Name: item.unit2Name, unit3Name: item.unit3Name, unit4Name: item.unit4Name, unit5Name: item.unit5Name,
        ratio2: item.ratio2, ratio3: item.ratio3, ratio4: item.ratio4, ratio5: item.ratio5,
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
    const petugas = input.lines.map((l) => (l.price ?? "").trim());
    const hargaBuruk = input.lines.filter((l, i) => petugas[i] !== "" && hargaPetugasSah(petugas[i]) === null);
    if (hargaBuruk.length) {
        return tolak(400, "HARGA_TIDAK_VALID", `Harga ${hargaBuruk.slice(0, 5).map((l) => l.code).join(", ")} harus angka lebih dari 0 `
            + "(maks 4 desimal, tanpa titik ribuan). Kosongkan untuk memakai harga master.", { barang: hargaBuruk.map((l) => l.code) });
    }

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
    const putusan = harga.map((row, i) => putusanHarga(petugas[i], row, pelanggan.branchId));
    // Owner sesi 13: harga master sah ada = harga master yang dipakai; harga petugas di baris itu ditolak berkode, per baris.
    const ditimpa = harga.flatMap((row, i) => { const x = putusan[i]; return x.jenis === "petugas_ditolak" ? [{ row, hargaMaster: x.hargaMaster }] : []; });
    if (ditimpa.length) {
        return tolak(409, "HARGA_PETUGAS_TIDAK_DIIZINKAN", `Harga master cabang ${pelanggan.branchName || p.branchId} sudah ada untuk: `
            + ditimpa.slice(0, 5).map(({ row, hargaMaster }) => `${row.code} ${row.unit} (Rp ${hargaMaster})`).join("; ")
            + ". Harga petugas hanya untuk barang TANPA harga master; kosongkan harganya.",
        { barang: ditimpa.map(({ row, hargaMaster }) => ({ code: row.code, unit: row.unit, hargaMaster })) });
    }
    const tanpaHarga = harga.filter((_, i) => putusan[i].jenis === "belum_ada" || putusan[i].jenis === "petugas_tidak_valid");
    if (tanpaHarga.length) {
        const ket = tanpaHarga.slice(0, 5).map((row) => `${row.code} ${row.unit}: ${alasanHarga(row, pelanggan.branchId)}`).join("; ");
        return tolak(409, "HARGA_BELUM_ADA", `Harga master cabang ${pelanggan.branchName || p.branchId} belum sah untuk: ${ket}`,
            { missing: tanpaHarga.map((row) => row.code) });
    }
    return {
        ok: true, pelanggan,
        harga: harga.map((row, i): HargaBaris => {
            const x = putusan[i];
            const rasio = rasioSatuan(barang.get(row.code)!);
            return x.jenis === "petugas"
                ? { code: row.code, unit: row.unit, price: x.price, source: "petugas", hargaMaster: null, rasio }
                : { ...row, price: (x as { price: number }).price, source: "tier", hargaDefault: row.branchId !== pelanggan.branchId, rasio };
        }),
    };
}
