/*
 * Tujuan: Resolver principal (S7-2, BL-64): teks bebas -> {principal, varian | utuh} LEWAT ALIAS SAJA. Tak pernah menebak:
 *   nol target = tak_dikenal, lebih dari satu target = ambigu (pencocokan longgar = laporan, bukan resolver).
 * Caller: pemakai tahap S7-2b (principal-mapping, Master Barang, Python lewat /api/principals); uji lib/principal/*.test.ts.
 * Dependensi: lib/principal/normalisasi.ts. Data alias dimuat lib/principal/tulis.ts muatIndeksAlias().
 * Main Functions: JENIS_ALIAS, JENIS_NAMA, SUMBER_KODE, TRIGGER_WAJIB, buatIndeksAlias, resolvePrincipal.
 * Side Effects: tidak ada (murni).
 */
import { normalisasiPrincipal } from "./normalisasi.ts";

/** Sama dengan CHECK principal_alias_jenis (S7-0). */
export const JENIS_ALIAS = ["nama", "kode_master_barang", "label_mapping", "nama_bank", "nama_summary", "nama_surat"] as const;
export type JenisAlias = (typeof JENIS_ALIAS)[number];
/** Ruang nama (indeks unik uq_principal_alias_nama): semua jenis KECUALI kode Master Barang 2 karakter. Satu ejaan di ruang ini
 * hanya punya SATU jenis (jenis = asal ejaan, bukan ruang terpisah) -> saring nama memakai seluruh JENIS_NAMA, bukan satu jenis. */
export const JENIS_NAMA: readonly JenisAlias[] = JENIS_ALIAS.filter((j) => j !== "kode_master_barang");

/** sumber alias kode principal: dibuat bersama principal (API & benih), tidak bisa dihapus/dibuat lewat API — menjaga "kode -> principal-nya". */
export const SUMBER_KODE = "kode_principal";
/** Trigger yang WAJIB aktif sebelum jalur tulis / benih berjalan (migrate-pg saja tidak memasangnya). [nama, tabel, berkas DDL] */
export const TRIGGER_WAJIB = [
    ["trg_principal_code_tetap", "principal", "DDL_S7_0.sql"],
    ["trg_principal_log_append_only", "principal_log", "DDL_S7_2.sql"],
    ["trg_principal_log_no_truncate", "principal_log", "DDL_S7_2.sql"],
] as const;

export type AliasTerindeks = {
    id: string;
    aliasNorm: string;
    jenis: JenisAlias;
    principalId: string;
    code: string;
    variantKey: string | null;
    principalAktif: boolean;
    /** null = alias menunjuk principal utuh. */
    varianAktif: boolean | null;
};

export type TargetPrincipal = { principalId: string; code: string; variantKey: string | null; aktif: boolean };

export type HasilResolve =
    | ({ status: "cocok"; norm: string; alias: { id: string; jenis: JenisAlias }[] } & TargetPrincipal)
    | { status: "tak_dikenal"; norm: string }
    | { status: "ambigu"; norm: string; kandidat: TargetPrincipal[] };

export type IndeksAlias = ReadonlyMap<string, readonly AliasTerindeks[]>;

export function buatIndeksAlias(baris: readonly AliasTerindeks[]): IndeksAlias {
    const peta = new Map<string, AliasTerindeks[]>();
    for (const a of baris) peta.set(a.aliasNorm, [...(peta.get(a.aliasNorm) ?? []), a]);
    return peta;
}

/**
 * `jenis` (opsional) menyaring alias yang boleh dipakai: satu jenis, daftar, atau JENIS_NAMA. Tanpa saringan, ejaan yang sama
 * sah ada di DUA ruang (kode Master Barang "MI" vs nama "MI") — bila menunjuk target berbeda hasilnya `ambigu`.
 * `aktif` = principal aktif DAN (utuh, atau varian aktif); keputusan memakai target nonaktif ada di pemakai.
 */
export function resolvePrincipal(teks: unknown, indeks: IndeksAlias, opsi: { jenis?: JenisAlias | readonly JenisAlias[] } = {}): HasilResolve {
    const norm = normalisasiPrincipal(teks);
    if (!norm) return { status: "tak_dikenal", norm };
    const saring = opsi.jenis === undefined ? null : new Set<string>(typeof opsi.jenis === "string" ? [opsi.jenis] : opsi.jenis);
    const cocok = (indeks.get(norm) ?? []).filter((a) => !saring || saring.has(a.jenis));
    const target = new Map<string, TargetPrincipal & { alias: { id: string; jenis: JenisAlias }[] }>();
    for (const a of cocok) {
        const kunci = `${a.principalId}\u0000${a.variantKey ?? "\u0001"}`;
        const t = target.get(kunci) ?? {
            principalId: a.principalId, code: a.code, variantKey: a.variantKey,
            aktif: a.principalAktif && (a.variantKey === null || a.varianAktif === true), alias: [],
        };
        t.alias.push({ id: a.id, jenis: a.jenis });
        target.set(kunci, t);
    }
    if (target.size === 0) return { status: "tak_dikenal", norm };
    if (target.size > 1) {
        return { status: "ambigu", norm, kandidat: [...target.values()].map((t) => ({ principalId: t.principalId, code: t.code, variantKey: t.variantKey, aktif: t.aktif })) };
    }
    const [t] = target.values();
    return { status: "cocok", norm, ...t };
}
