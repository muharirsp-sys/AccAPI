/*
 * Tujuan: Resolver principal (S7-2, BL-64): teks bebas -> {principal, varian | utuh} LEWAT ALIAS SAJA. Tak pernah menebak:
 *   nol target = tak_dikenal, lebih dari satu target = ambigu (pencocokan longgar = laporan, bukan resolver).
 * Caller: pemakai tahap S7-2b (principal-mapping, Master Barang, Python lewat /api/principals); uji lib/principal/*.test.ts.
 * Dependensi: lib/principal/normalisasi.ts. Data alias dimuat lib/principal/tulis.ts muatIndeksAlias().
 * Main Functions: JENIS_ALIAS, RUANG, ruangDari, SUMBER_KODE, buatIndeksAlias, resolvePrincipal.
 * Side Effects: tidak ada (murni).
 */
import { normalisasiPrincipal } from "./normalisasi.ts";

/** Sama dengan CHECK principal_alias_jenis (S7-0). */
export const JENIS_ALIAS = ["nama", "kode_master_barang", "label_mapping", "nama_bank", "nama_summary", "nama_surat"] as const;
export type JenisAlias = (typeof JENIS_ALIAS)[number];
/** Dua ruang keunikan alias_norm (indeks unik parsial S7-0): kode Master Barang 2 karakter vs SEMUA jenis lain. Di ruang "nama"
 * satu ejaan hanya punya SATU baris (jenis = asal ejaan, bukan ruang) — karena itu resolver memilih RUANG, bukan jenis. */
export const RUANG = ["nama", "kode_master_barang"] as const;
export type Ruang = (typeof RUANG)[number];
export const ruangDari = (v: unknown): Ruang | null => (RUANG as readonly unknown[]).includes(v) ? (v as Ruang) : null;
export const ruangAlias = (jenis: string): Ruang => (jenis === "kode_master_barang" ? "kode_master_barang" : "nama");

/** sumber alias kode principal: dibuat bersama principal (API & benih), tidak bisa dihapus/dibuat lewat API — menjaga "kode -> principal-nya". */
export const SUMBER_KODE = "kode_principal";
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
 * `ruang` WAJIB: "nama" (nama/label/kode OPC/surat/bank/Summary — semua jenis kecuali kode MB) atau "kode_master_barang" (kode 2
 * karakter Master Barang). Tanpa ruang, kode MB pendek ("GD") ikut cocok di teks bebas — sengaja tidak ada bawaan.
 * `aktif` = principal aktif DAN (utuh, atau varian aktif); keputusan memakai target nonaktif ada di pemakai.
 */
export function resolvePrincipal(teks: unknown, indeks: IndeksAlias, ruang: Ruang): HasilResolve {
    if (!ruangDari(ruang)) throw new Error(`resolvePrincipal: ruang wajib ${RUANG.join(" | ")}`);
    const norm = normalisasiPrincipal(teks);
    if (!norm) return { status: "tak_dikenal", norm };
    const cocok = (indeks.get(norm) ?? []).filter((a) => ruangAlias(a.jenis) === ruang);
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
