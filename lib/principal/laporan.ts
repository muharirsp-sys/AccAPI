/*
 * Tujuan: Laporan kandidat principal + usulan benih SQL (S7-2, BL-64) — logika MURNI (tanpa DB). Registri usulan dibangun dari
 *   konstanta OPC (25 kode+nama = principal), No Claim (label + varian HEINZ), keputusan owner varian (KINO NON FOOD, FORISA
 *   MT/GT), lalu digabung isi tabel principal* yang sudah ada. Nilai dari sumber lain (master_barang, principal_mapping,
 *   no_claim_template, off_batch, claim_workflow, hard-code TS) diklasifikasi matched / ambiguous / unmatched.
 *   Tak pernah menebak: hanya kecocokan PERSIS (normalizer baku) yang masuk SQL aktif; kecocokan longgar ditulis sebagai blok
 *   SQL ber-komentar untuk ditinjau owner; ambiguous/unmatched hanya dicantumkan.
 * Caller: scripts/principal-laporan.mjs (baca DB baca-saja lalu memanggil ini); uji lib/principal/laporan.test.ts, principal-pg.test.ts.
 * Dependensi: lib/principal/normalisasi.ts, resolver.ts (JenisAlias, SUMBER_KODE), penjaga.ts, lib/off-program-control/constants.ts,
 *   lib/claim-workflow/no-claim-rules.ts. TANPA @/ alias & tanpa DB agar bisa diimpor skrip .mjs lewat tsx.
 * Main Functions: tokenLonggar, susunRegistri, susunLaporan, laporanMarkdown, benihSql.
 * Side Effects: tidak ada.
 * Tahap 2 (TIDAK di sini): Python principles.sqlite3, payments.json, Excel rekening, Finance/SPPD.
 */
import { offPrinciples } from "../off-program-control/constants.ts";
import { noClaimRuleConfigs } from "../claim-workflow/no-claim-rules.ts";
import { normalisasiPrincipal, rapikanTeks } from "./normalisasi.ts";
import { SUMBER_KODE, type JenisAlias } from "./resolver.ts";
import { PENJAGA, sqlPenjagaSah } from "./penjaga.ts";

export const AKTOR_BENIH = "benih:S7-2";

/** Keputusan owner 11 Okt (K9): varian satu principal. HEINZ HZ/BS diambil dari No Claim. Kode varian = usulan, ditinjau owner. */
export const VARIAN_OWNER = [
    { code: "KINO", variantKey: "NON_FOOD", name: "KINO NON FOOD", dasar: "owner 11 Okt K9; hard-code principal-order/bersama.ts:53" },
    { code: "FRS", variantKey: "MT", name: "FORISA MT", dasar: "owner 11 Okt K9" },
    { code: "FRS", variantKey: "GT", name: "FORISA GT", dasar: "owner 11 Okt K9" },
] as const;

/** Ejaan principal yang di-hard-code di kode TS (di luar konstanta OPC). Insentif (MIX NON FOOD, dst.) = di luar S7. */
export const TS_LAIN = [
    { nilai: "KINO NON FOOD", rujukan: "app/(dashboard)/principal-order/bersama.ts:53; app/api/principal-order/validate/route.ts:35; app/api/promo-outlet/route.ts; app/api/promo-recap/route.ts; app/api/promo-rule/from-summary/route.ts:108" },
] as const;

export type Target = { code: string; variantKey: string | null };
export type UsulanAlias = Target & { aliasNorm: string; aliasAsli: string; jenis: JenisAlias; sumber: string; adaDiDb?: boolean };
type UsulanPrincipal = { code: string; name: string; sumber: string; adaDiDb: boolean; namaDb?: string };
type UsulanVarian = { code: string; variantKey: string; name: string | null; sumber: string; adaDiDb: boolean };

/** Hasil baca satu sumber DB: baris atau galat (galat ≠ kosong). */
export type Bacaan<T> = { ok: true; rows: T[] } | { ok: false; galat: string };
export type DataDb = {
    masterBarang: Bacaan<{ principleCode: string; principleName: string; n: number }>;
    principalMapping: Bacaan<{ principal: string; kind: string; n: number }>;
    noClaimTemplate: Bacaan<{ principleCode: string; variantKey: string }>;
    offBatch: Bacaan<{ principleCode: string; principleName: string; n: number }>;
    claimWorkflow: Bacaan<{ principleCode: string; principleName: string; n: number }>;
    principal: Bacaan<{ code: string; name: string; isActive: boolean }>;
    principalVariant: Bacaan<{ code: string; variantKey: string; name: string | null; isActive: boolean }>;
    principalAlias: Bacaan<{ code: string; variantKey: string | null; aliasNorm: string; aliasAsli: string; jenis: string; sumber: string }>;
};

const kunciTarget = (t: Target) => `${t.code}:${t.variantKey ?? "*"}`;
const ruang = (jenis: string) => (jenis === "kode_master_barang" ? "MB" : "NAMA");
const tampilTarget = (t: Target) => (t.variantKey === null ? t.code : `${t.code}/${t.variantKey || "(dasar)"}`);

// --------------------------------------------------------------------------- pencocokan longgar (laporan saja)

const BADAN_HUKUM = new Set(["PT", "CV", "TBK", "PERSERO", "INDONESIA", "INDO"]);
/** Token longgar: bentuk normal, tanda baca -> spasi, buang badan hukum/negara. HANYA untuk usulan laporan, tak pernah ke DB. */
export const tokenLonggar = (s: string) => normalisasiPrincipal(s).replace(/[^A-Z0-9]+/g, " ").split(" ").filter((t) => t && !BADAN_HUKUM.has(t));

function cocokLonggar(a: string[], b: string[]) {
    if (!a.length || !b.length) return false;
    const A = new Set(a), B = new Set(b);
    const bagian = (x: Set<string>, y: Set<string>) => [...x].every((t) => y.has(t)) && [...x].some((t) => t.length >= 3);
    return (A.size === B.size && [...A].every((t) => B.has(t))) || bagian(B, A) || bagian(A, B);
}

// --------------------------------------------------------------------------- registri usulan

export type Registri = {
    principal: Map<string, UsulanPrincipal>;
    varian: Map<string, UsulanVarian>;
    /** ruang|norm -> usulan per target (lebih dari satu target = konflik). */
    alias: Map<string, UsulanAlias[]>;
    konflik: { ruang: string; aliasNorm: string; target: string[] }[];
};

export function susunRegistri(data: Pick<DataDb, "principal" | "principalVariant" | "principalAlias">): Registri {
    const reg: Registri = { principal: new Map(), varian: new Map(), alias: new Map(), konflik: [] };
    const tambahAlias = (a: UsulanAlias) => {
        if (!a.aliasNorm) return;
        const k = `${ruang(a.jenis)}|${a.aliasNorm}`;
        const daftar = reg.alias.get(k) ?? [];
        const sama = daftar.find((x) => kunciTarget(x) === kunciTarget(a));
        if (sama) { sama.adaDiDb ||= !!a.adaDiDb; return; }
        reg.alias.set(k, [...daftar, a]);
    };
    for (const p of offPrinciples) {
        reg.principal.set(p.code, { code: p.code, name: p.name, sumber: "lib/off-program-control/constants.ts", adaDiDb: false });
        tambahAlias({ code: p.code, variantKey: null, aliasNorm: p.code, aliasAsli: p.code, jenis: "nama", sumber: SUMBER_KODE });
        tambahAlias({ code: p.code, variantKey: null, aliasNorm: normalisasiPrincipal(p.name), aliasAsli: p.name, jenis: "nama", sumber: "nama_resmi" });
    }
    const tambahVarian = (v: UsulanVarian) => {
        reg.varian.set(`${v.code}:${v.variantKey}`, v);
        if (v.name) tambahAlias({ code: v.code, variantKey: v.variantKey, aliasNorm: normalisasiPrincipal(v.name), aliasAsli: v.name, jenis: "nama", sumber: "nama_varian" });
    };
    for (const v of VARIAN_OWNER) tambahVarian({ code: v.code, variantKey: v.variantKey, name: v.name, sumber: v.dasar, adaDiDb: false });
    for (const c of noClaimRuleConfigs) {
        if (!reg.principal.has(c.principleCode)) continue; // kode No Claim tanpa principal OPC -> dilaporkan di sumber no_claim, bukan diusulkan
        tambahAlias({ code: c.principleCode, variantKey: null, aliasNorm: normalisasiPrincipal(c.label), aliasAsli: c.label, jenis: "nama", sumber: "label_no_claim" });
        if ("variants" in c) {
            for (const v of c.variants) tambahVarian({ code: c.principleCode, variantKey: v.variantKey, name: v.label, sumber: "lib/claim-workflow/no-claim-rules.ts", adaDiDb: false });
        }
    }
    // Isi DB yang sudah ada ikut registri (hasil API/benih sebelumnya); beda dengan usulan = konflik, bukan ditimpa.
    for (const p of data.principal.ok ? data.principal.rows : []) {
        const u = reg.principal.get(p.code);
        if (u) Object.assign(u, { adaDiDb: true, namaDb: p.name });
        else reg.principal.set(p.code, { code: p.code, name: p.name, sumber: "db", adaDiDb: true, namaDb: p.name });
    }
    for (const v of data.principalVariant.ok ? data.principalVariant.rows : []) {
        const u = reg.varian.get(`${v.code}:${v.variantKey}`);
        if (u) u.adaDiDb = true;
        else reg.varian.set(`${v.code}:${v.variantKey}`, { code: v.code, variantKey: v.variantKey, name: v.name, sumber: "db", adaDiDb: true });
    }
    for (const a of data.principalAlias.ok ? data.principalAlias.rows : []) {
        tambahAlias({ ...a, jenis: a.jenis as JenisAlias, adaDiDb: true });
    }
    for (const [k, daftar] of reg.alias) {
        if (daftar.length > 1) reg.konflik.push({ ruang: k.split("|")[0], aliasNorm: daftar[0].aliasNorm, target: daftar.map(tampilTarget) });
    }
    return reg;
}

// --------------------------------------------------------------------------- klasifikasi

export type Status = "matched" | "ambiguous" | "unmatched";
export type BarisLaporan = {
    nilai: string; norm: string; status: Status; cara?: "persis" | "longgar"; target?: Target; kandidat?: Target[];
    jumlah?: number; konteks?: string; catatan?: string; usulan?: UsulanAlias;
};

const unik = (ts: Target[]) => [...new Map(ts.map((t) => [kunciTarget(t), t])).values()].sort((a, b) => kunciTarget(a).localeCompare(kunciTarget(b)));

/** Satu nilai teks nama -> matched (persis/longgar satu target) / ambiguous / unmatched terhadap registri (ruang NAMA). */
export function klasifikasiNama(nilai: string, reg: Registri): Pick<BarisLaporan, "norm" | "status" | "cara" | "target" | "kandidat"> {
    const norm = normalisasiPrincipal(nilai);
    if (!norm) return { norm, status: "unmatched" };
    const persis = unik((reg.alias.get(`NAMA|${norm}`) ?? []).map(({ code, variantKey }) => ({ code, variantKey })));
    if (persis.length === 1) return { norm, status: "matched", cara: "persis", target: persis[0] };
    if (persis.length > 1) return { norm, status: "ambiguous", cara: "persis", kandidat: persis };
    const tok = tokenLonggar(norm);
    const longgar = unik([...reg.alias.entries()].filter(([k]) => k.startsWith("NAMA|"))
        .flatMap(([, daftar]) => daftar.filter((a) => cocokLonggar(tok, tokenLonggar(a.aliasNorm))))
        .map(({ code, variantKey }) => ({ code, variantKey })));
    if (longgar.length === 1) return { norm, status: "matched", cara: "longgar", target: longgar[0] };
    if (longgar.length > 1) return { norm, status: "ambiguous", cara: "longgar", kandidat: longgar };
    return { norm, status: "unmatched" };
}

export type BagianSumber = { judul: string; asal: string; galat?: string; baris: BarisLaporan[] };
export type Laporan = { dibuat: string; registri: Registri; sumber: BagianSumber[] };

const KODE_MB = /^[A-Z0-9]{2}$/;

/** Klasifikasi semua sumber. `dibuat` = ISO waktu laporan (disuntik agar uji deterministik). */
export function susunLaporan(data: DataDb, dibuat: string): Laporan {
    const reg = susunRegistri(data);
    const sumber: BagianSumber[] = [];
    const bagian = <T>(judul: string, asal: string, b: Bacaan<T>, ubah: (rows: T[]) => BarisLaporan[]) =>
        sumber.push(b.ok ? { judul, asal, baris: ubah(b.rows) } : { judul, asal, galat: b.galat, baris: [] });
    const usulNama = (nilai: string, jenis: JenisAlias, sumberAlias: string, extra: Partial<BarisLaporan> = {}): BarisLaporan => {
        const k = klasifikasiNama(nilai, reg);
        const usulan = k.status === "matched" && k.cara === "longgar" && k.target
            ? { ...k.target, aliasNorm: k.norm, aliasAsli: rapikanTeks(nilai), jenis, sumber: sumberAlias } : undefined;
        return { nilai, ...k, usulan, ...extra };
    };

    bagian("master_barang — nama principal", "Postgres master_barang.principle_name", data.masterBarang, (rows) => {
        const per = new Map<string, number>();
        for (const r of rows) per.set(r.principleName, (per.get(r.principleName) ?? 0) + r.n);
        return [...per].map(([nama, n]) => usulNama(nama, "nama", "master_barang", { jumlah: n }));
    });
    bagian("master_barang — kode 2 karakter", "Postgres master_barang.principle_code (alias jenis kode_master_barang)", data.masterBarang, (rows) => {
        const per = new Map<string, { nama: Set<string>; n: number }>();
        for (const r of rows) {
            const e = per.get(r.principleCode) ?? { nama: new Set<string>(), n: 0 };
            e.nama.add(r.principleName); e.n += r.n; per.set(r.principleCode, e);
        }
        return [...per].map(([kode, e]): BarisLaporan => {
            const norm = normalisasiPrincipal(kode);
            const konteks = `nama: ${[...e.nama].join(" | ")}`;
            if (!KODE_MB.test(norm)) return { nilai: kode, norm, status: "unmatched", jumlah: e.n, konteks, catatan: "bukan kode 2 huruf/angka" };
            const hasil = [...e.nama].map((nama) => klasifikasiNama(nama, reg));
            const target = unik(hasil.flatMap((h) => (h.target ? [h.target] : h.kandidat ?? [])));
            const ada = reg.alias.get(`MB|${norm}`) ?? [];
            if (target.length > 1 || ada.some((a) => target[0] && kunciTarget(a) !== kunciTarget(target[0]))) {
                return { nilai: kode, norm, status: "ambiguous", kandidat: unik([...target, ...ada]), jumlah: e.n, konteks };
            }
            if (!target.length || hasil.some((h) => h.status === "unmatched")) {
                return { nilai: kode, norm, status: target.length ? "ambiguous" : "unmatched", kandidat: target, jumlah: e.n, konteks,
                    catatan: target.length ? "sebagian nama tak dikenal" : undefined };
            }
            const cara = hasil.every((h) => h.cara === "persis") ? "persis" : "longgar";
            return { nilai: kode, norm, status: "matched", cara, target: target[0], jumlah: e.n, konteks,
                usulan: { ...target[0], aliasNorm: norm, aliasAsli: kode, jenis: "kode_master_barang", sumber: "master_barang" } };
        });
    });
    bagian("principal_mapping — principal", "Postgres principal_mapping.principal (distinct)", data.principalMapping, (rows) => {
        const per = new Map<string, { n: number; kind: string[] }>();
        for (const r of rows) {
            const e = per.get(r.principal) ?? { n: 0, kind: [] };
            e.n += r.n; e.kind.push(`${r.kind} ${r.n}`); per.set(r.principal, e);
        }
        return [...per].map(([nilai, e]) => usulNama(nilai, "label_mapping", "principal_mapping", { jumlah: e.n, konteks: e.kind.join(", ") }));
    });
    const kodeOpc = (judul: string, asal: string, b: DataDb["offBatch"]) => bagian(judul, asal, b, (rows) => rows.map((r): BarisLaporan => {
        const norm = normalisasiPrincipal(r.principleCode);
        if (!reg.principal.has(norm)) return { nilai: r.principleCode, norm, status: "unmatched", jumlah: r.n, konteks: r.principleName, catatan: "kode tidak ada di registri" };
        const nama = klasifikasiNama(r.principleName, reg);
        const beda = nama.target ? nama.target.code !== norm : true;
        return { nilai: r.principleCode, norm, status: "matched", cara: "persis", target: { code: norm, variantKey: null }, jumlah: r.n, konteks: r.principleName,
            catatan: beda ? `nama baris ${nama.status === "unmatched" ? "tidak dikenal" : `menunjuk ${(nama.target ? [nama.target] : nama.kandidat ?? []).map(tampilTarget).join("/")}`}` : undefined };
    }));
    bagian("no_claim_template — kode/varian", "Postgres no_claim_template (principle_code, variant_key; '' = utuh)", data.noClaimTemplate, (rows) => rows.map((r): BarisLaporan => {
        const code = normalisasiPrincipal(r.principleCode);
        const ok = reg.principal.has(code) && (r.variantKey === "" || reg.varian.has(`${code}:${r.variantKey}`));
        return { nilai: `${r.principleCode}${r.variantKey ? `/${r.variantKey}` : ""}`, norm: code, status: ok ? "matched" : "unmatched",
            cara: ok ? "persis" : undefined, target: ok ? { code, variantKey: r.variantKey || null } : undefined,
            catatan: ok ? undefined : "kode/varian tidak ada di registri" };
    }));
    kodeOpc("off_batch — kode OPC", "Postgres off_batch (principle_code, principle_name)", data.offBatch);
    kodeOpc("claim_workflow — kode Klaim", "Postgres claim_workflow (principle_code, principle_name)", data.claimWorkflow);
    bagian("kode TS lain — hard-code", "lihat kolom konteks", { ok: true, rows: [...TS_LAIN] }, (rows) =>
        rows.map((r) => usulNama(r.nilai, "nama", "kode_ts", { konteks: r.rujukan })));
    return { dibuat, registri: reg, sumber };
}

// --------------------------------------------------------------------------- keluaran

const lit = (s: string | null) => (s === null ? "NULL::text" : `'${s.replace(/'/g, "''")}'`);
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
export const ringkas = (b: BagianSumber) => ({
    matched: b.baris.filter((x) => x.status === "matched").length,
    ambiguous: b.baris.filter((x) => x.status === "ambiguous").length,
    unmatched: b.baris.filter((x) => x.status === "unmatched").length,
});

/** Alias registri yang boleh diusulkan: satu target, belum ada di DB. Konflik tidak pernah diusulkan. */
function aliasRegistriBaru(reg: Registri) {
    return [...reg.alias.values()].filter((d) => d.length === 1 && !d[0].adaDiDb).map((d) => d[0]);
}

/** Usulan alias dari sumber: persis (aktif) vs longgar (ber-komentar); duplikat ruang|norm dibuang; yang sudah di registri dibuang. */
function usulanSumber(lap: Laporan) {
    const terpakai = new Set(lap.registri.alias.keys());
    const persis: UsulanAlias[] = [], longgar: UsulanAlias[] = [];
    for (const b of lap.sumber) {
        for (const x of b.baris) {
            if (!x.usulan) continue;
            const k = `${ruang(x.usulan.jenis)}|${x.usulan.aliasNorm}`;
            if (terpakai.has(k)) continue;
            terpakai.add(k);
            (x.cara === "persis" ? persis : longgar).push(x.usulan);
        }
    }
    return { persis, longgar };
}

export function laporanMarkdown(lap: Laporan): string {
    const reg = lap.registri;
    const l: string[] = [
        `# Laporan principal S7-2 (BL-64) — ${lap.dibuat}`, "",
        "BACA-SAJA. Registri usulan = konstanta OPC (25) + keputusan owner varian + No Claim + isi tabel principal yang sudah ada.",
        "`matched` persis = sudah tercakup alias registri (atau usulan kode Master Barang di `benih.sql`); `matched` longgar = usulan",
        "ber-komentar di `benih.sql` (tinjau dulu); `ambiguous` / `unmatched` = keputusan owner, tidak diusulkan. Sumber yang GAGAL dibaca",
        "ditandai GAGAL (bukan kosong). Tahap 2 (belum dibaca): Python `principles.sqlite3`, `payments.json`, Excel rekening, Finance/SPPD.", "",
        "## Ringkasan", "", "| Sumber | matched | ambiguous | unmatched |", "|---|---:|---:|---:|",
    ];
    for (const b of lap.sumber) {
        const r = ringkas(b);
        l.push(b.galat ? `| ${md(b.judul)} | GAGAL | GAGAL | GAGAL |` : `| ${md(b.judul)} | ${r.matched} | ${r.ambiguous} | ${r.unmatched} |`);
    }
    l.push("", `## Registri usulan`, "", `Principal: ${reg.principal.size} (${[...reg.principal.values()].filter((p) => p.adaDiDb).length} sudah di DB) · varian: ${reg.varian.size} · alias: ${reg.alias.size} · konflik: ${reg.konflik.length}`, "",
        "| Kode | Nama | Asal | Di DB |", "|---|---|---|---|");
    for (const p of reg.principal.values()) {
        l.push(`| ${p.code} | ${md(p.name)} | ${md(p.sumber)} | ${p.adaDiDb ? (p.namaDb === p.name ? "ya" : `ya — nama DB: ${md(p.namaDb ?? "")}`) : "belum"} |`);
    }
    l.push("", "| Varian | Nama | Asal | Di DB |", "|---|---|---|---|");
    for (const v of reg.varian.values()) l.push(`| ${v.code}/${v.variantKey} | ${md(v.name ?? "")} | ${md(v.sumber)} | ${v.adaDiDb ? "ya" : "belum"} |`);
    if (reg.konflik.length) {
        l.push("", "### KONFLIK registri (satu ejaan, beberapa target — tidak diusulkan)", "", "| Ruang | Ejaan | Target |", "|---|---|---|");
        for (const k of reg.konflik) l.push(`| ${k.ruang} | ${md(k.aliasNorm)} | ${k.target.join(", ")} |`);
    }
    for (const b of lap.sumber) {
        l.push("", `## ${md(b.judul)}`, "", `Asal: ${md(b.asal)}`, "");
        if (b.galat) { l.push(`**GAGAL DIBACA:** ${md(b.galat)}`); continue; }
        if (!b.baris.length) { l.push("_(tidak ada baris)_"); continue; }
        l.push("| Nilai | Norm | Status | Target / kandidat | Jumlah | Konteks / catatan |", "|---|---|---|---|---:|---|");
        for (const x of b.baris) {
            const t = x.target ? tampilTarget(x.target) : (x.kandidat ?? []).map(tampilTarget).join(", ");
            l.push(`| ${md(x.nilai)} | ${md(x.norm)} | ${x.status}${x.cara ? ` (${x.cara})` : ""} | ${t} | ${x.jumlah ?? ""} | ${md([x.konteks, x.catatan].filter(Boolean).join(" — "))} |`);
        }
    }
    return `${l.join("\n")}\n`;
}

/**
 * Bentuk JSON riwayat (principal_log.before/after) = baris Drizzle yang ditulis API (lib/principal/tulis.ts): kunci camelCase =
 * nama properti db/schema.ts, waktu = ISO UTC milidetik ("2026-10-11T07:05:41.123Z", seperti JSON Date). Benih memakai
 * jsonb_build_object dari peta ini (bukan to_jsonb yang berkunci snake_case) — laporan.test.ts mencocokkannya dengan kolom Drizzle.
 */
export const KOLOM_LOG = {
    principal: { id: "id", code: "code", name: "name", isActive: "is_active", createdBy: "created_by", createdAt: "created_at", updatedBy: "updated_by", updatedAt: "updated_at" },
    varian: { principalId: "principal_id", variantKey: "variant_key", createdBy: "created_by", createdAt: "created_at", name: "name", isActive: "is_active" },
    alias: { id: "id", aliasNorm: "alias_norm", principalId: "principal_id", variantKey: "variant_key", aliasAsli: "alias_asli", jenis: "jenis", sumber: "sumber", createdBy: "created_by", createdAt: "created_at" },
} as const;
const KOLOM_WAKTU = new Set(["created_at", "updated_at"]);
export const jsonLog = (entitas: keyof typeof KOLOM_LOG) => `jsonb_build_object(${Object.entries(KOLOM_LOG[entitas])
    .map(([k, c]) => `'${k}', ${KOLOM_WAKTU.has(c) ? `to_char(b.${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` : `b.${c}`}`).join(", ")})`;

const nilaiAlias = (a: UsulanAlias) => `(${[a.code, a.variantKey, a.aliasNorm, a.aliasAsli, a.jenis, a.sumber].map(lit).join(", ")})`;
const SISIP_ALIAS = (baris: string[]) => [
    "WITH v(code, variant_key, alias_norm, alias_asli, jenis, sumber) AS (VALUES",
    `    ${baris.join(",\n    ")}`,
    "), baru AS (",
    "    INSERT INTO principal_alias (alias_norm, principal_id, variant_key, alias_asli, jenis, sumber, created_by)",
    `    SELECT v.alias_norm, p.id, v.variant_key, v.alias_asli, v.jenis, v.sumber, ${lit(AKTOR_BENIH)} FROM v JOIN principal p ON p.code = v.code`,
    "    ON CONFLICT DO NOTHING RETURNING *",
    ")",
    "INSERT INTO principal_log (entitas, kunci, principal_id, aksi, after, aktor)",
    `SELECT 'alias', b.id, b.principal_id, 'buat', ${jsonLog("alias")}, ${lit(AKTOR_BENIH)} FROM baru b;`,
];

/** Benih SQL idempoten untuk DITINJAU owner: hanya INSERT ... ON CONFLICT DO NOTHING (tanpa UPDATE), + principal_log, + VERIFIKASI. */
export function benihSql(lap: Laporan): string {
    const reg = lap.registri;
    const ps = [...reg.principal.values()].filter((p) => !p.adaDiDb);
    const vs = [...reg.varian.values()].filter((v) => !v.adaDiDb);
    const asReg = aliasRegistriBaru(reg);
    const { persis, longgar } = usulanSumber(lap);
    const aktif = [...asReg, ...persis];
    const tolakan = lap.sumber.flatMap((b) => b.baris.filter((x) => x.status !== "matched").map((x) => `--   [${b.judul}] ${rapikanTeks(x.nilai)} -> ${x.status}${x.kandidat?.length ? ` (${x.kandidat.map(tampilTarget).join(", ")})` : ""}`));
    const galat = lap.sumber.filter((b) => b.galat).map((b) => `--   GAGAL DIBACA [${b.judul}]: ${rapikanTeks(b.galat)}`);
    const s: string[] = [
        `-- BENIH principal S7-2 (BL-64) — DIHASILKAN scripts/principal-laporan.mjs pada ${lap.dibuat}. DITINJAU OWNER sebelum dijalankan.`,
        "-- Dijalankan IT Support (role accapi), SESUDAH DDL_S7_0.sql + DDL_S7_2.sql:",
        "--   docker exec -i accapi-postgres psql -U accapi -d accapi -v ON_ERROR_STOP=1 < benih.sql",
        "-- Idempoten: hanya INSERT ... ON CONFLICT DO NOTHING (TIDAK PERNAH UPDATE / DO UPDATE) + principal_log untuk baris yang benar-benar",
        "-- tersisip. Ejaan yang sudah dipakai principal LAIN dilewati DB lalu ditandai ok=false di VERIFIKASI (tidak diam-diam).",
        "-- Alias principal utuh = variant_key NULL; varian '' (dasar) tidak pernah diusulkan. alias_norm = normalizer baku lib/principal.",
        ...(galat.length ? ["-- PERHATIAN: sumber berikut GAGAL dibaca saat laporan dibuat — usulan dari sumber itu TIDAK ada di berkas ini:", ...galat] : []),
        "",
        "BEGIN;",
        "SET LOCAL lock_timeout = '5s';",
        "SET LOCAL statement_timeout = '120s';",
        "SET LOCAL standard_conforming_strings = on;",
        "DO $$",
        "BEGIN",
        ...PENJAGA.flatMap((p) => [
            `    IF NOT ${sqlPenjagaSah(p).replace(/\n/g, "\n    ")} THEN`,
            `        RAISE EXCEPTION 'benih S7-2: trigger ${p.nama} tidak terpasang persis (jenis/fungsi) — jalankan docs/handover/${p.ddl} dulu';`,
            "    END IF;",
        ]),
        "END $$;",
        "",
        `-- 1. Principal (${ps.length} baru).`,
    ];
    if (ps.length) s.push(
        "WITH baru AS (",
        "    INSERT INTO principal (code, name, created_by, updated_by) VALUES",
        `    ${ps.map((p) => `(${lit(p.code)}, ${lit(p.name)}, ${lit(AKTOR_BENIH)}, ${lit(AKTOR_BENIH)})`).join(",\n    ")}`,
        "    ON CONFLICT DO NOTHING RETURNING *",
        ")",
        "INSERT INTO principal_log (entitas, kunci, principal_id, aksi, after, aktor)",
        `SELECT 'principal', b.id, b.id, 'buat', ${jsonLog("principal")}, ${lit(AKTOR_BENIH)} FROM baru b;`,
    );
    s.push("", `-- 2. Varian (${vs.length} baru; keputusan owner K9 + No Claim HEINZ).`);
    if (vs.length) s.push(
        "WITH v(code, variant_key, name) AS (VALUES",
        `    ${vs.map((v) => `(${lit(v.code)}, ${lit(v.variantKey)}, ${lit(v.name)})`).join(",\n    ")}`,
        "), baru AS (",
        "    INSERT INTO principal_variant (principal_id, variant_key, name, created_by)",
        `    SELECT p.id, v.variant_key, v.name, ${lit(AKTOR_BENIH)} FROM v JOIN principal p ON p.code = v.code`,
        "    ON CONFLICT DO NOTHING RETURNING *",
        ")",
        "INSERT INTO principal_log (entitas, kunci, principal_id, aksi, after, aktor)",
        `SELECT 'varian', b.principal_id || ':' || b.variant_key, b.principal_id, 'buat', ${jsonLog("varian")}, ${lit(AKTOR_BENIH)} FROM baru b;`,
    );
    s.push("", `-- 3. Alias (${asReg.length} registri: kode, nama resmi, label No Claim, nama varian; ${persis.length} kecocokan PERSIS dari sumber).`);
    if (aktif.length) s.push(...SISIP_ALIAS(aktif.map(nilaiAlias)));
    s.push("", "COMMIT;", "");
    s.push(`-- 4. PERIKSA — ${longgar.length} kecocokan LONGGAR (satu kandidat, tidak persis). TIDAK dijalankan: hapus baris yang salah,`,
        "--    lalu buang tanda komentar seluruh blok (sebagai transaksi sendiri). Tidak ada UPDATE.");
    if (longgar.length) s.push(...["BEGIN;", "SET LOCAL standard_conforming_strings = on;", ...SISIP_ALIAS(longgar.map(nilaiAlias)), "COMMIT;"]
        .join("\n").split("\n").map((x) => `-- ${x}`));
    s.push("", `-- 5. TIDAK diusulkan (${tolakan.length}; keputusan owner — ambiguous / unmatched):`, ...(tolakan.length ? tolakan : ["--   (tidak ada)"]));
    const cek = [
        ...ps.map((p) => `('principal ${p.code}', EXISTS (SELECT 1 FROM principal WHERE code = ${lit(p.code)} AND name = ${lit(p.name)}))`),
        ...vs.map((v) => `('varian ${v.code}/${v.variantKey}', EXISTS (SELECT 1 FROM principal_variant x JOIN principal p ON p.id = x.principal_id WHERE p.code = ${lit(v.code)} AND x.variant_key = ${lit(v.variantKey)}))`),
        ...aktif.map((a) => `(${lit(`alias ${ruang(a.jenis)} ${a.aliasNorm} -> ${tampilTarget(a)}`)}, EXISTS (SELECT 1 FROM principal_alias x JOIN principal p ON p.id = x.principal_id WHERE x.alias_norm = ${lit(a.aliasNorm)} AND (x.jenis = 'kode_master_barang') = ${a.jenis === "kode_master_barang"} AND p.code = ${lit(a.code)} AND x.variant_key IS NOT DISTINCT FROM ${lit(a.variantKey)}))`),
    ];
    s.push("", "-- 6. VERIFIKASI (baca-saja) — semua ok harus true; baris false (bila ada) tampil paling atas.");
    if (cek.length) s.push("SELECT cek, ok FROM (VALUES", `    ${cek.join(",\n    ")}`, ") AS v(cek, ok) ORDER BY ok, cek;");
    else s.push("SELECT 'tidak ada usulan baru' AS cek, true AS ok;");
    return `${s.join("\n")}\n`;
}
