/*
 * Tujuan: Baca/tulis principal resmi (S7-2, BL-64): daftar, riwayat, indeks alias untuk resolver, dan SEMUA jalur tulis (buat
 *   principal, tambah varian, aktif/nonaktif principal/varian, tambah/hapus alias). Satu transaksi per aksi + baris principal_log.
 *   Tak pernah menimpa: tabrakan = 409 berkode; code TIDAK punya jalur ubah (trigger S7-0 menjaga di DB).
 * Caller: app/api/principals/** ; uji lib/principals-route.test.ts dan lib/principal-pg.test.ts.
 * Dependensi: lib/db (Drizzle), db/schema principal*, lib/principal/normalisasi.ts, lib/principal/resolver.ts.
 * Main Functions: GalatPrincipal, jawabGalat, cekDdl, daftarPrincipal, riwayatPrincipal, muatIndeksAlias, resolveTeks, buatPrincipal,
 *   tambahVarian, ubahAktifPrincipal, ubahAktifVarian, tambahAlias, hapusAlias.
 * Side Effects: DB read/write principal, principal_variant, principal_alias, principal_log.
 */
import { NextResponse } from "next/server";
import { and, asc, desc, eq, lt, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { principal, principalAlias, principalLog, principalVariant } from "@/db/schema";
import { normalisasiPrincipal, rapikanTeks } from "./normalisasi.ts";
import { buatIndeksAlias, JENIS_ALIAS, resolvePrincipal, RUANG, ruangDari, SUMBER_KODE, type AliasTerindeks, type IndeksAlias, type JenisAlias } from "./resolver.ts";
import { SQL_PENJAGA_HILANG } from "./penjaga.ts";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Baris = Record<string, unknown>;

export class GalatPrincipal extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly detail: Baris = {}) {
        super(message);
    }
}

const BATAS_TEKS = 200;
const KODE = /^[A-Z0-9_-]{1,20}$/;
const VARIAN = /^[A-Z0-9_-]{0,20}$/;
const KODE_MB = /^[A-Z0-9]{2}$/;

/** 503 PRINCIPAL_DDL_BELUM bila salah satu trigger penjaga (lib/principal/penjaga.ts) tidak terpasang PERSIS — tidak ada, nonaktif,
 * atau bernama sama tetapi jenis event/kolom/WHEN/fungsi/isi fungsi lain. Dipanggil di DALAM transaksi tulis. */
export async function cekDdl(q: Pick<Tx, "execute">) {
    const { rows } = await q.execute(sql.raw(SQL_PENJAGA_HILANG));
    if (rows.length) {
        throw new GalatPrincipal(503, "PRINCIPAL_DDL_BELUM",
            "Penjaga database principal belum terpasang persis (DDL_S7_0/DDL_S7_2). Hubungi IT Support — perubahan tidak disimpan.",
            { kurang: rows.map((r) => (r as { nama: string }).nama) });
    }
}

const galatPg = (e: unknown) => {
    for (const x of [e, (e as { cause?: unknown } | null)?.cause]) {
        const { code, constraint } = (x ?? {}) as { code?: unknown; constraint?: unknown };
        if (typeof code === "string") return { code, constraint: typeof constraint === "string" ? constraint : "" };
    }
    return null;
};

/** Galat -> JSON berkode. Galat tak dikenal = 500 (tak pernah dijawab sebagai daftar kosong). */
export function jawabGalat(e: unknown, label: string) {
    if (e instanceof GalatPrincipal) return NextResponse.json({ ok: false, code: e.code, error: e.message, ...e.detail }, { status: e.status });
    const pg = galatPg(e);
    if (pg?.code === "23505") {
        const code = pg.constraint === "uq_principal_code" ? "KODE_SUDAH_ADA"
            : pg.constraint.startsWith("uq_principal_alias") ? "ALIAS_TABRAKAN"
                : pg.constraint === "principal_variant_pkey" ? "VARIAN_SUDAH_ADA" : "BENTROK";
        return NextResponse.json({ ok: false, code, error: "Data bentrok dengan yang sudah ada (tidak ditimpa). Muat ulang." }, { status: 409 });
    }
    if (pg?.code === "23514") return NextResponse.json({ ok: false, code: "TIDAK_SAH", error: "Isian ditolak aturan database (bentuk teks/kode)." }, { status: 400 });
    if (pg?.code === "42P01") return NextResponse.json({ ok: false, code: "PRINCIPAL_SKEMA_BELUM", error: "Tabel principal belum ada (DDL_S7_0/DDL_S7_2)." }, { status: 503 });
    console.error(`[PRINCIPAL ${label}]`, e);
    return NextResponse.json({ ok: false, code: "GAGAL", error: "Gagal memproses data principal." }, { status: 500 });
}

const tolak = (status: number, code: string, message: string, detail: Baris = {}) => new GalatPrincipal(status, code, message, detail);

/** Isi JSON objek; selain itu GalatPrincipal 400 (dijawab jawabGalat). */
export async function bacaBody(request: Request): Promise<Baris> {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw tolak(400, "BODY_TIDAK_SAH", "Isi permintaan harus objek JSON.");
    return body as Baris;
}

/** PATCH hanya menerima kunci `boleh`; `code` = 400 KODE_TETAP (tidak ada jalur ubah kode), kunci lain = 400. */
export function hanyaKunci(body: Baris, boleh: readonly string[]) {
    if ("code" in body) throw tolak(400, "KODE_TETAP", "Kode principal tidak bisa diubah. Kode salah = buat principal baru lalu nonaktifkan yang lama.");
    const lain = Object.keys(body).filter((k) => !boleh.includes(k));
    if (lain.length) throw tolak(400, "FIELD_TIDAK_DIDUKUNG", `Field tidak bisa diubah di sini: ${lain.join(", ")}. Yang diterima: ${boleh.join(", ")}.`);
}

function teks(v: unknown, field: string, wajib: boolean): string {
    if (v !== undefined && v !== null && typeof v !== "string") throw tolak(400, "TIDAK_SAH", `${field} harus teks.`);
    const t = rapikanTeks(v);
    if (wajib && !t) throw tolak(400, "TIDAK_SAH", `${field} wajib diisi.`);
    if (t.length > BATAS_TEKS) throw tolak(400, "TIDAK_SAH", `${field} maksimal ${BATAS_TEKS} karakter.`);
    return t;
}
const kodeDari = (v: unknown) => {
    const k = teks(v, "Kode", true).toUpperCase();
    if (!KODE.test(k)) throw tolak(400, "KODE_TIDAK_SAH", "Kode 1–20 karakter: huruf besar, angka, _ atau - (mis. KINO, GDI).");
    return k;
};
/** null/tidak dikirim = utuh (tanpa varian); "" PERSIS = varian dasar; teks yang kosong SESUDAH dirapikan (spasi, lebar-nol) = 400
 * — tidak pernah diam-diam jadi varian dasar. */
export function varianDari(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw tolak(400, "VARIAN_TIDAK_SAH", "Kode varian harus teks.");
    if (v === "") return "";
    const k = rapikanTeks(v).toUpperCase();
    if (!k || !VARIAN.test(k)) {
        throw tolak(400, "VARIAN_TIDAK_SAH", "Kode varian 1–20 karakter: huruf besar, angka, _ atau - (mis. NON_FOOD, HZ); varian dasar = \"\" persis.");
    }
    return k;
}

// --------------------------------------------------------------------------- baca

export type PrincipalDaftar = typeof principal.$inferSelect & {
    variants: (typeof principalVariant.$inferSelect)[];
    aliases: (typeof principalAlias.$inferSelect)[];
};

/** Principal + varian + alias dalam SATU snapshot baca-saja (urut kode, varian, alias_norm). */
export async function daftarPrincipal(): Promise<PrincipalDaftar[]> {
    return db.transaction(async (tx) => {
        const ps = await tx.select().from(principal).orderBy(asc(principal.code));
        const vs = await tx.select().from(principalVariant).orderBy(asc(principalVariant.principalId), asc(principalVariant.variantKey));
        const as = await tx.select().from(principalAlias).orderBy(asc(principalAlias.aliasNorm), asc(principalAlias.jenis));
        return ps.map((p) => ({
            ...p,
            variants: vs.filter((v) => v.principalId === p.id),
            aliases: as.filter((a) => a.principalId === p.id),
        }));
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Riwayat terbaru dulu, keyset `sebelum` (id). 404 bila principal tidak ada. */
export async function riwayatPrincipal(principalId: string, opsi: { sebelum?: number; batas?: number } = {}) {
    const batas = Math.min(Math.max(Math.trunc(opsi.batas ?? 50), 1), 200);
    const [p] = await db.select({ id: principal.id }).from(principal).where(eq(principal.id, principalId)).limit(1);
    if (!p) throw tolak(404, "PRINCIPAL_TIDAK_ADA", "Principal tidak ditemukan.");
    const baris = await db.select().from(principalLog)
        .where(opsi.sebelum ? and(eq(principalLog.principalId, principalId), lt(principalLog.id, opsi.sebelum)) : eq(principalLog.principalId, principalId))
        .orderBy(desc(principalLog.id)).limit(batas + 1);
    return { riwayat: baris.slice(0, batas), sebelum: baris.length > batas ? baris[batas - 1].id : null };
}

/** Indeks alias untuk resolvePrincipal (semua alias, termasuk yang menunjuk principal/varian nonaktif — ditandai `aktif`). */
export async function muatIndeksAlias(): Promise<IndeksAlias> {
    const rows = await db.select({
        id: principalAlias.id, aliasNorm: principalAlias.aliasNorm, jenis: principalAlias.jenis, principalId: principalAlias.principalId,
        code: principal.code, variantKey: principalAlias.variantKey, principalAktif: principal.isActive, varianAktif: principalVariant.isActive,
    }).from(principalAlias)
        .innerJoin(principal, eq(principal.id, principalAlias.principalId))
        .leftJoin(principalVariant, and(eq(principalVariant.principalId, principalAlias.principalId), eq(principalVariant.variantKey, principalAlias.variantKey)));
    return buatIndeksAlias(rows as AliasTerindeks[]);
}

/** Satu teks -> hasil resolver pada ruang yang WAJIB disebut (untuk pemakai luar, mis. Python tahap 2: satu normalizer). */
export async function resolveTeks(teks: unknown, ruang: unknown) {
    const r = ruangDari(ruang);
    if (!r) throw tolak(400, "RUANG_TIDAK_SAH", `ruang wajib: ${RUANG.join(" | ")}.`);
    if (typeof teks !== "string" || !normalisasiPrincipal(teks)) throw tolak(400, "TEKS_KOSONG", "teks wajib diisi.");
    if (teks.length > BATAS_TEKS) throw tolak(400, "TIDAK_SAH", `teks maksimal ${BATAS_TEKS} karakter.`);
    return resolvePrincipal(teks, await muatIndeksAlias(), r);
}

// --------------------------------------------------------------------------- tulis (satu transaksi + principal_log)

type Log = { entitas: "principal" | "varian" | "alias"; kunci: string; principalId: string; aksi: "buat" | "aktif" | "nonaktif" | "hapus"; before?: unknown; after?: unknown };
const tulisLog = (tx: Tx, aktor: string, logs: Log[]) =>
    tx.insert(principalLog).values(logs.map((l) => ({ ...l, before: l.before ?? null, after: l.after ?? null, aktor })));

async function kunciPrincipal(tx: Tx, id: string, wajibAktif: boolean) {
    const [p] = await tx.select().from(principal).where(eq(principal.id, id)).limit(1).for("update");
    if (!p) throw tolak(404, "PRINCIPAL_TIDAK_ADA", "Principal tidak ditemukan.");
    if (wajibAktif && !p.isActive) throw tolak(409, "PRINCIPAL_NONAKTIF", `Principal ${p.code} nonaktif — aktifkan dulu.`);
    return p;
}

type AliasBaru = { aliasNorm: string; aliasAsli: string; jenis: JenisAlias; sumber: string; variantKey: string | null };

/** Tolak 409 bila ejaan sudah dipakai di ruang yang sama (kode Master Barang | selain itu). Tak pernah menimpa. */
async function pastikanAliasBebas(tx: Tx, principalId: string, a: AliasBaru) {
    const ruang = a.jenis === "kode_master_barang" ? eq(principalAlias.jenis, "kode_master_barang") : ne(principalAlias.jenis, "kode_master_barang");
    const [ada] = await tx.select({ principalId: principalAlias.principalId, code: principal.code, variantKey: principalAlias.variantKey,
        jenis: principalAlias.jenis, aliasAsli: principalAlias.aliasAsli })
        .from(principalAlias).innerJoin(principal, eq(principal.id, principalAlias.principalId))
        .where(and(eq(principalAlias.aliasNorm, a.aliasNorm), ruang)).limit(1);
    if (!ada) return;
    if (ada.principalId === principalId && ada.variantKey === a.variantKey) {
        throw tolak(409, "ALIAS_SUDAH_ADA", `Ejaan "${a.aliasNorm}" sudah menjadi alias principal ini.`, { pemilik: ada });
    }
    throw tolak(409, "ALIAS_TABRAKAN", `Ejaan "${a.aliasNorm}" sudah dipakai principal ${ada.code}${ada.variantKey === null ? "" : ` varian "${ada.variantKey}"`} — tidak ditimpa.`, { pemilik: ada });
}

async function sisipAlias(tx: Tx, aktor: string, principalId: string, list: AliasBaru[]) {
    for (const a of list) await pastikanAliasBebas(tx, principalId, a);
    const rows = await tx.insert(principalAlias).values(list.map((a) => ({ ...a, principalId, createdBy: aktor }))).returning();
    return { rows, logs: rows.map((r): Log => ({ entitas: "alias", kunci: r.id, principalId, aksi: "buat", after: r })) };
}

/** Principal baru + alias kodenya (tak terhapus) + alias nama resminya, satu transaksi. */
export async function buatPrincipal(input: Baris, aktor: string) {
    const code = kodeDari(input.code);
    const name = teks(input.name, "Nama", true);
    const aliasList: AliasBaru[] = [{ aliasNorm: code, aliasAsli: code, jenis: "nama", sumber: SUMBER_KODE, variantKey: null }];
    const namaNorm = normalisasiPrincipal(name);
    if (namaNorm !== code) aliasList.push({ aliasNorm: namaNorm, aliasAsli: name, jenis: "nama", sumber: "nama_resmi", variantKey: null });
    return db.transaction(async (tx) => {
        await cekDdl(tx);
        const [lama] = await tx.select({ id: principal.id }).from(principal).where(eq(principal.code, code)).limit(1);
        if (lama) throw tolak(409, "KODE_SUDAH_ADA", `Kode ${code} sudah dipakai (kode tidak bisa diubah; kode salah = principal baru).`, { principalId: lama.id });
        const [p] = await tx.insert(principal).values({ code, name, createdBy: aktor, updatedBy: aktor }).returning();
        const alias = await sisipAlias(tx, aktor, p.id, aliasList);
        await tulisLog(tx, aktor, [{ entitas: "principal", kunci: p.id, principalId: p.id, aksi: "buat", after: p }, ...alias.logs]);
        return { principal: p, aliases: alias.rows };
    });
}

/** Varian baru (+ alias nama varian bila diisi). Varian dasar "" hanya pada principal yang sudah punya varian lain. */
export async function tambahVarian(principalId: string, input: Baris, aktor: string) {
    const variantKey = varianDari(input.variantKey);
    if (variantKey === null) throw tolak(400, "VARIAN_TIDAK_SAH", "variantKey wajib diisi (\"\" = varian dasar).");
    const name = teks(input.name, "Nama varian", false) || null;
    return db.transaction(async (tx) => {
        await cekDdl(tx);
        const p = await kunciPrincipal(tx, principalId, true);
        const ada = await tx.select({ variantKey: principalVariant.variantKey }).from(principalVariant).where(eq(principalVariant.principalId, p.id));
        if (ada.some((v) => v.variantKey === variantKey)) throw tolak(409, "VARIAN_SUDAH_ADA", `Varian "${variantKey}" sudah ada pada ${p.code}.`);
        if (variantKey === "" && !ada.some((v) => v.variantKey !== "")) {
            throw tolak(409, "VARIAN_DASAR_TANPA_LAIN", `Varian dasar ("") hanya untuk principal yang juga punya varian lain; ${p.code} utuh dirujuk tanpa varian.`);
        }
        const [v] = await tx.insert(principalVariant).values({ principalId: p.id, variantKey, name, createdBy: aktor }).returning();
        const logs: Log[] = [{ entitas: "varian", kunci: `${p.id}:${variantKey}`, principalId: p.id, aksi: "buat", after: v }];
        let aliases: (typeof principalAlias.$inferSelect)[] = [];
        if (name) {
            const alias = await sisipAlias(tx, aktor, p.id, [{ aliasNorm: normalisasiPrincipal(name), aliasAsli: name, jenis: "nama", sumber: "nama_varian", variantKey }]);
            aliases = alias.rows;
            logs.push(...alias.logs);
        }
        await tulisLog(tx, aktor, logs);
        return { variant: v, aliases };
    });
}

const aktifDari = (v: unknown) => {
    if (typeof v !== "boolean") throw tolak(400, "TIDAK_SAH", "isActive wajib true/false.");
    return v;
};

/** Aktif/nonaktif principal. Status sama = tanpa perubahan & tanpa riwayat (berubah:false). */
export async function ubahAktifPrincipal(principalId: string, isActive: unknown, aktor: string) {
    const aktif = aktifDari(isActive);
    return db.transaction(async (tx) => {
        await cekDdl(tx);
        const p = await kunciPrincipal(tx, principalId, false);
        if (p.isActive === aktif) return { principal: p, berubah: false };
        const [baru] = await tx.update(principal).set({ isActive: aktif, updatedBy: aktor, updatedAt: new Date() }).where(eq(principal.id, p.id)).returning();
        await tulisLog(tx, aktor, [{ entitas: "principal", kunci: p.id, principalId: p.id, aksi: aktif ? "aktif" : "nonaktif", before: p, after: baru }]);
        return { principal: baru, berubah: true };
    });
}

export async function ubahAktifVarian(principalId: string, input: Baris, aktor: string) {
    const variantKey = varianDari(input.variantKey);
    if (variantKey === null) throw tolak(400, "VARIAN_TIDAK_SAH", "variantKey wajib diisi (\"\" = varian dasar).");
    const aktif = aktifDari(input.isActive);
    return db.transaction(async (tx) => {
        await cekDdl(tx);
        const p = await kunciPrincipal(tx, principalId, false);
        const kunci = and(eq(principalVariant.principalId, p.id), eq(principalVariant.variantKey, variantKey));
        const [v] = await tx.select().from(principalVariant).where(kunci).limit(1).for("update");
        if (!v) throw tolak(404, "VARIAN_TIDAK_ADA", `Varian "${variantKey}" tidak ada pada ${p.code}.`);
        if (v.isActive === aktif) return { variant: v, berubah: false };
        const [baru] = await tx.update(principalVariant).set({ isActive: aktif }).where(kunci).returning();
        await tulisLog(tx, aktor, [{ entitas: "varian", kunci: `${p.id}:${variantKey}`, principalId: p.id, aksi: aktif ? "aktif" : "nonaktif", before: v, after: baru }]);
        return { variant: baru, berubah: true };
    });
}

/** Alias baru: alias_norm SELALU dihitung server (normalizer baku). Tabrakan = 409, tak pernah menimpa. */
export async function tambahAlias(principalId: string, input: Baris, aktor: string) {
    const aliasAsli = teks(input.alias, "Alias", true);
    const aliasNorm = normalisasiPrincipal(aliasAsli);
    const jenis = input.jenis as JenisAlias;
    if (typeof jenis !== "string" || !JENIS_ALIAS.includes(jenis)) throw tolak(400, "JENIS_TIDAK_SAH", `Jenis alias: ${JENIS_ALIAS.join(", ")}.`);
    if (jenis === "kode_master_barang" && !KODE_MB.test(aliasNorm)) throw tolak(400, "KODE_MB_TIDAK_SAH", "Kode Master Barang = tepat 2 huruf/angka (mis. K1).");
    const sumber = teks(input.sumber, "Sumber", false) || "manual";
    if (sumber === SUMBER_KODE) throw tolak(400, "SUMBER_KHUSUS", `Sumber "${SUMBER_KODE}" hanya dibuat bersama principal.`);
    const variantKey = varianDari(input.variantKey);
    return db.transaction(async (tx) => {
        await cekDdl(tx);
        const p = await kunciPrincipal(tx, principalId, true);
        if (variantKey !== null) {
            const [v] = await tx.select().from(principalVariant)
                .where(and(eq(principalVariant.principalId, p.id), eq(principalVariant.variantKey, variantKey))).limit(1);
            if (!v) throw tolak(404, "VARIAN_TIDAK_ADA", `Varian "${variantKey}" tidak ada pada ${p.code}.`);
            if (!v.isActive) throw tolak(409, "VARIAN_NONAKTIF", `Varian "${variantKey}" nonaktif — aktifkan dulu.`);
        }
        const alias = await sisipAlias(tx, aktor, p.id, [{ aliasNorm, aliasAsli, jenis, sumber, variantKey }]);
        await tulisLog(tx, aktor, alias.logs);
        return { alias: alias.rows[0] };
    });
}

/** Hapus alias (bukan alias kode principal). Isi lama tersimpan di principal_log. */
export async function hapusAlias(principalId: string, aliasId: string, aktor: string) {
    return db.transaction(async (tx) => {
        await cekDdl(tx);
        const kunci = and(eq(principalAlias.id, aliasId), eq(principalAlias.principalId, principalId));
        const [a] = await tx.select().from(principalAlias).where(kunci).limit(1).for("update");
        if (!a) throw tolak(404, "ALIAS_TIDAK_ADA", "Alias tidak ditemukan pada principal ini.");
        if (a.sumber === SUMBER_KODE) throw tolak(409, "ALIAS_KODE_TETAP", "Alias kode principal tidak bisa dihapus (kode tetap).");
        await tx.delete(principalAlias).where(kunci);
        await tulisLog(tx, aktor, [{ entitas: "alias", kunci: a.id, principalId, aksi: "hapus", before: a }]);
        return { alias: a };
    });
}
