/*
 * Tujuan: Pemakai S7-2b — teks principal WAJIB dikenal tabel resmi lewat alias (ruang nama); selain itu galat berkode, tak pernah
 *   menebak. Kode Master Barang 2 karakter = alias kode_master_barang principal itu (bukan dibuat otomatis).
 *   Kontrak galat: docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md "Pemakai S7-2b".
 * Caller: app/api/principal-mapping/** (simpan/impor/baca), lib/master-barang/service.ts (createMaster), lib/master-barang/legacy.ts.
 * Dependensi: lib/principal/{resolver,tulis,laporan(tokenLonggar)}, db/schema principal + principal_variant.
 * Main Functions: periksaPrincipal, wajibPrincipal, kodeMasterBarang (murni); muatDataResmi (DB).
 * Side Effects: muatDataResmi = DB read; lainnya murni.
 */
import { db } from "@/lib/db";
import { principal, principalVariant } from "@/db/schema";
import { resolvePrincipal, ruangAlias, type IndeksAlias } from "./resolver.ts";
import { GalatPrincipal, muatIndeksAlias } from "./tulis.ts";
import { tokenLonggar } from "./laporan.ts";

export type DataResmi = {
    indeks: IndeksAlias;
    principal: ReadonlyMap<string, { code: string; name: string }>;
    /** `${principalId}:${variantKey}` -> nama varian (null = tanpa nama). */
    varian: ReadonlyMap<string, string | null>;
};
export type PrincipalResmi = { principalId: string; code: string; variantKey: string | null; nama: string };
export type Saran = { code: string; variantKey: string | null; nama: string };

export async function muatDataResmi(): Promise<DataResmi> {
    const [indeks, ps, vs] = await Promise.all([
        muatIndeksAlias(),
        db.select({ id: principal.id, code: principal.code, name: principal.name }).from(principal),
        db.select({ principalId: principalVariant.principalId, variantKey: principalVariant.variantKey, name: principalVariant.name }).from(principalVariant),
    ]);
    return {
        indeks,
        principal: new Map(ps.map((p) => [p.id, { code: p.code, name: p.name }])),
        varian: new Map(vs.map((v) => [`${v.principalId}:${v.variantKey}`, v.name])),
    };
}

/** Nama tampil/simpan: nama varian, atau nama resmi principal (utuh).
 * ponytail: varian tanpa nama -> "KODE/VARIAN" (tak pernah sama dengan nama principal utuh); belum ada jalur ganti nama varian. */
function namaTarget(principalId: string, code: string, variantKey: string | null, data: DataResmi): string {
    if (variantKey === null) return data.principal.get(principalId)?.name ?? code;
    return data.varian.get(`${principalId}:${variantKey}`) || `${code}/${variantKey || "DASAR"}`;
}

/** Saran = target AKTIF yang aliasnya berbagi token (>= 3 huruf, tanpa tanda baca/badan hukum) dengan teks; terbanyak dulu, maks 5.
 * Hanya petunjuk untuk manusia — tidak pernah dipakai otomatis. */
function saranUntuk(teks: unknown, data: DataResmi): Saran[] {
    const tok = new Set(tokenLonggar(String(teks ?? "")).filter((t) => t.length >= 3));
    const skor = new Map<string, Saran & { skor: number }>();
    for (const a of [...data.indeks.values()].flat()) {
        if (ruangAlias(a.jenis) !== "nama" || !a.principalAktif || a.varianAktif === false) continue;
        const n = tokenLonggar(a.aliasNorm).filter((t) => tok.has(t)).length;
        const kunci = `${a.principalId}:${a.variantKey ?? ""}:${a.variantKey === null}`;
        if (n > (skor.get(kunci)?.skor ?? 0)) skor.set(kunci, { code: a.code, variantKey: a.variantKey, nama: namaTarget(a.principalId, a.code, a.variantKey, data), skor: n });
    }
    return [...skor.values()]
        .sort((x, y) => y.skor - x.skor || x.code.localeCompare(y.code) || (x.variantKey ?? "").localeCompare(y.variantKey ?? "") || Number(x.variantKey !== null) - Number(y.variantKey !== null))
        .slice(0, 5).map(({ code, variantKey, nama }) => ({ code, variantKey, nama }));
}

export function periksaPrincipal(teks: unknown, data: DataResmi):
    | { status: "cocok" | "nonaktif"; principal: PrincipalResmi }
    | { status: "tak_dikenal"; saran: Saran[] } {
    const r = resolvePrincipal(teks, data.indeks, "nama");
    // "ambigu" tak terjadi di DB (alias_norm unik per ruang); bila terjadi tetap ditolak, kandidatnya jadi saran.
    if (r.status !== "cocok") {
        const saran = r.status === "ambigu"
            ? r.kandidat.map((k) => ({ code: k.code, variantKey: k.variantKey, nama: namaTarget(k.principalId, k.code, k.variantKey, data) }))
            : saranUntuk(teks, data);
        return { status: "tak_dikenal", saran };
    }
    const p = { principalId: r.principalId, code: r.code, variantKey: r.variantKey, nama: namaTarget(r.principalId, r.code, r.variantKey, data) };
    return { status: r.aktif ? "cocok" : "nonaktif", principal: p };
}

/** Principal resmi untuk `teks`, atau GalatPrincipal 400 PRINCIPAL_TIDAK_DIKENAL / 409 PRINCIPAL_NONAKTIF. */
export function wajibPrincipal(teks: string, data: DataResmi): PrincipalResmi {
    const h = periksaPrincipal(teks, data);
    if (h.status === "tak_dikenal") {
        const petunjuk = h.saran.length ? ` Mungkin maksudnya: ${h.saran.map((s) => s.nama).join("; ")}.` : "";
        throw new GalatPrincipal(400, "PRINCIPAL_TIDAK_DIKENAL",
            `Principal "${teks}" tidak dikenal di Data Principal.${petunjuk} Tambahkan ejaan ini sebagai alias di Data Principal bila memang sama.`,
            { ditolak: [{ nilai: teks, saran: h.saran }] });
    }
    if (h.status === "nonaktif") {
        throw new GalatPrincipal(409, "PRINCIPAL_NONAKTIF", `Principal "${h.principal.nama}" nonaktif di Data Principal, jadi tidak bisa dipakai.`,
            { nilai: teks, principal: { code: h.principal.code, variantKey: h.principal.variantKey } });
    }
    return h.principal;
}

/** Kode Master Barang 2 karakter milik `p` (alias kode_master_barang principal utuh atau varian yang sama). `diminta` kosong =
 * satu-satunya kode; selain itu wajib salah satu kode milik `p`. Lainnya 400 KODE_MB_TIDAK_COCOK { kodeMb, principal, pilihan }. */
export function kodeMasterBarang(p: PrincipalResmi, diminta: string, data: DataResmi): string {
    const pilihan = [...new Set([...data.indeks.values()].flat()
        .filter((a) => a.jenis === "kode_master_barang" && a.principalId === p.principalId && (a.variantKey === null || a.variantKey === p.variantKey))
        .map((a) => a.aliasNorm))].sort();
    const kode = String(diminta ?? "").trim().toUpperCase();
    if (kode ? pilihan.includes(kode) : pilihan.length === 1) return kode || pilihan[0];
    const pesan = !pilihan.length ? `Principal "${p.nama}" belum punya kode Master Barang (2 karakter). Tambahkan alias jenis kode_master_barang di Data Principal.`
        : kode ? `Kode Master Barang "${kode}" bukan milik principal "${p.nama}". Pilihan: ${pilihan.join(", ")}.`
            : `Principal "${p.nama}" punya beberapa kode Master Barang; pilih salah satu: ${pilihan.join(", ")}.`;
    throw new GalatPrincipal(400, "KODE_MB_TIDAK_COCOK", pesan, { kodeMb: kode || null, principal: { code: p.code, variantKey: p.variantKey }, pilihan });
}
