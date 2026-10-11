/* S7-2: laporan kandidat principal + benih SQL (murni) pada data sintetis berejaan nyata (S7-EKSPLORASI §6.2). Benih dijalankan
 * sungguhan di Postgres oleh lib/principal-pg.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
import { principal, principalAlias, principalVariant } from "../../db/schema.ts";
import { benihSql, jsonLog, KOLOM_LOG, laporanMarkdown, ringkas, susunLaporan, tokenLonggar, type DataDb } from "./laporan.ts";
import { PENJAGA, sqlPenjagaSah } from "./penjaga.ts";

const kosong = { ok: true as const, rows: [] };
export function dataSintetis(over: Partial<DataDb> = {}): DataDb {
    return {
        masterBarang: { ok: true, rows: [
            { principleCode: "K1", principleName: "KINO INDONESIA. TBK, PT", n: 10 },
            { principleCode: "KN", principleName: "KINO NON FOOD", n: 4 },
            { principleCode: "GD", principleName: "GODREJ", n: 7 },
            { principleCode: "P1", principleName: "PT. PRISKILA PRIMA MAKMUR", n: 3 },
            { principleCode: "UR", principleName: "URC INDONESIA, PTMIX FOOD", n: 2 },
            { principleCode: "AC", principleName: "ABC INDONESIA", n: 1 },
            { principleCode: "XX", principleName: "PT MAJU JAYA", n: 1 },
        ] },
        principalMapping: { ok: true, rows: [
            { principal: "KINO NON FOOD", kind: "item", n: 120 }, { principal: "KINO NON FOOD", kind: "customer", n: 40 },
            { principal: "KINO NON FOOD-KN", kind: "item", n: 2 },
            { principal: "Forisa\u00A0MT", kind: "item", n: 9 },
            { principal: "PRISKILA'S PRIMA MAKMUR", kind: "brand", n: 1 },
        ] },
        noClaimTemplate: { ok: true, rows: [{ principleCode: "HEINZ", variantKey: "HZ" }, { principleCode: "KINO", variantKey: "" }, { principleCode: "ZZZ", variantKey: "" }] },
        offBatch: { ok: true, rows: [{ principleCode: "KINO", principleName: "KINO INDONESIA. TBK, PT", n: 5 }, { principleCode: "XYZ", principleName: "XYZ, PT", n: 1 }] },
        claimWorkflow: { ok: false, galat: "42P01 relation \"claim_workflow\" does not exist" },
        principal: kosong, principalVariant: kosong, principalAlias: kosong,
        ...over,
    };
}

const baris = (lap: ReturnType<typeof susunLaporan>, judul: string) => {
    const b = lap.sumber.find((x) => x.judul.startsWith(judul));
    assert.ok(b, judul);
    return new Map(b.baris.map((x) => [x.nilai, x]));
};

test("token longgar membuang tanda baca + badan hukum (hanya laporan)", () => {
    assert.deepEqual(tokenLonggar("**PT.PRISKILA PRIMA MAKMUR**"), ["PRISKILA", "PRIMA", "MAKMUR"]);
    assert.deepEqual(tokenLonggar("KINO INDONESIA. TBK, PT"), ["KINO"]);
});

test("klasifikasi per sumber: persis / longgar / ambiguous / unmatched; sumber gagal = GAGAL, bukan kosong", () => {
    const lap = susunLaporan(dataSintetis(), "2026-10-11T00:00:00.000Z");
    const nama = baris(lap, "master_barang — nama");
    assert.deepEqual([nama.get("KINO INDONESIA. TBK, PT")?.status, nama.get("KINO INDONESIA. TBK, PT")?.cara], ["matched", "persis"]);
    assert.deepEqual(nama.get("KINO NON FOOD")?.target, { code: "KINO", variantKey: "NON_FOOD" });
    assert.deepEqual([nama.get("GODREJ")?.cara, nama.get("GODREJ")?.target?.code], ["persis", "GDI"], "label No Claim 'Godrej'");
    assert.deepEqual([nama.get("PT. PRISKILA PRIMA MAKMUR")?.cara, nama.get("PT. PRISKILA PRIMA MAKMUR")?.target?.code], ["longgar", "PRISKILA"]);
    assert.deepEqual([nama.get("URC INDONESIA, PTMIX FOOD")?.cara, nama.get("URC INDONESIA, PTMIX FOOD")?.target?.code], ["longgar", "URC"]);
    assert.equal(nama.get("ABC INDONESIA")?.status, "ambiguous", "ABC President vs Heinz ABC");
    assert.equal(nama.get("PT MAJU JAYA")?.status, "unmatched");

    const kode = baris(lap, "master_barang — kode");
    assert.deepEqual([kode.get("K1")?.status, kode.get("K1")?.cara, kode.get("K1")?.usulan?.jenis], ["matched", "persis", "kode_master_barang"]);
    assert.deepEqual(kode.get("KN")?.target, { code: "KINO", variantKey: "NON_FOOD" });
    assert.equal(kode.get("UR")?.cara, "longgar");
    assert.equal(kode.get("AC")?.status, "ambiguous");
    assert.equal(kode.get("XX")?.status, "unmatched");

    const map = baris(lap, "principal_mapping");
    assert.deepEqual([map.get("KINO NON FOOD")?.status, map.get("KINO NON FOOD")?.jumlah], ["matched", 160]);
    assert.equal(map.get("KINO NON FOOD-KN")?.status, "ambiguous", "akhiran cabang -KN: KINO utuh vs NON_FOOD — tidak ditebak");
    assert.deepEqual(map.get("Forisa\u00A0MT")?.target, { code: "FRS", variantKey: "MT" });

    const nc = baris(lap, "no_claim_template");
    assert.deepEqual([nc.get("HEINZ/HZ")?.status, nc.get("KINO")?.status, nc.get("ZZZ")?.status], ["matched", "matched", "unmatched"]);
    const opc = baris(lap, "off_batch");
    assert.deepEqual([opc.get("KINO")?.status, opc.get("KINO")?.catatan, opc.get("XYZ")?.status], ["matched", undefined, "unmatched"]);
    const cw = lap.sumber.find((b) => b.judul.startsWith("claim_workflow"));
    assert.ok(cw?.galat?.includes("42P01"));
    assert.equal(baris(lap, "kode TS lain").get("KINO NON FOOD")?.status, "matched");

    const mdx = laporanMarkdown(lap);
    assert.match(mdx, /\| claim_workflow — kode Klaim \| GAGAL \| GAGAL \| GAGAL \|/);
    assert.match(mdx, /\*\*GAGAL DIBACA:\*\* 42P01/);
    assert.deepEqual(ringkas(lap.sumber[0]), { matched: 5, ambiguous: 1, unmatched: 1 });
});

test("benih SQL: hanya INSERT ... ON CONFLICT DO NOTHING (tanpa UPDATE), penjaga trigger, persis aktif, longgar ber-komentar", () => {
    const sql = benihSql(susunLaporan(dataSintetis(), "2026-10-11T00:00:00.000Z"));
    const aktif = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    assert.doesNotMatch(aktif, /\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/);
    assert.equal((aktif.match(/ON CONFLICT DO NOTHING/g) ?? []).length, 3, "principal, varian, alias");
    const rapat = (x: string) => x.replace(/\s+/g, " ");
    for (const p of PENJAGA) assert.ok(rapat(aktif).includes(rapat(`IF NOT ${sqlPenjagaSah(p)} THEN`)), `penjaga benih ketat: ${p.nama}`);
    assert.match(aktif, /\('KINO', NULL::text, 'K1', 'K1', 'kode_master_barang', 'master_barang'\)/, "kode MB persis = aktif");
    assert.match(aktif, /\('GDI', NULL::text, 'GD', 'GD', 'kode_master_barang', 'master_barang'\)/);
    assert.doesNotMatch(aktif, /'UR'|'P1'|PTMIX/, "longgar tidak aktif");
    assert.match(sql, /^-- +\('URC', NULL::text, 'URC INDONESIA, PTMIX FOOD'/m, "longgar = baris komentar");
    assert.match(sql, /^-- +\('URC', NULL::text, 'UR', 'UR', 'kode_master_barang'/m, "kode MB dari nama longgar = komentar juga");
    assert.match(sql, /^-- .*'PRISKILA''S PRIMA MAKMUR'.*'label_mapping', 'principal_mapping'\)/m, "kutip di-escape");
    assert.doesNotMatch(aktif, /\('[A-Z0-9_-]+', '', /, "varian dasar '' tidak pernah diusulkan (varian maupun alias)");
    assert.match(sql, /PERHATIAN: sumber berikut GAGAL dibaca/);
    assert.match(sql, /\[master_barang — nama principal\] ABC INDONESIA -> ambiguous \(ABC, HEINZ\)/);
    assert.match(aktif, /\('KINO', 'NON_FOOD', 'KINO NON FOOD', 'KINO NON FOOD', 'nama', 'nama_varian'\)/);
});

test("isi DB yang sudah ada: tidak diusulkan ulang; ejaan menunjuk target lain = KONFLIK, tidak diusulkan", () => {
    const lap = susunLaporan(dataSintetis({
        principal: { ok: true, rows: [{ code: "KINO", name: "KINO INDONESIA. TBK, PT", isActive: true }] },
        principalAlias: { ok: true, rows: [
            { code: "KINO", variantKey: null, aliasNorm: "KINO", aliasAsli: "KINO", jenis: "nama", sumber: "kode_principal" },
            { code: "KINO", variantKey: null, aliasNorm: "KINO NON FOOD", aliasAsli: "KINO NON FOOD", jenis: "label_mapping", sumber: "manual" },
        ] },
    }), "2026-10-11T00:00:00.000Z");
    assert.deepEqual(lap.registri.konflik, [{ ruang: "NAMA", aliasNorm: "KINO NON FOOD", target: ["KINO/NON_FOOD", "KINO"] }]);
    assert.equal(baris(lap, "principal_mapping").get("KINO NON FOOD")?.status, "ambiguous");
    const sql = benihSql(lap);
    assert.doesNotMatch(sql, /\('KINO', 'KINO INDONESIA\. TBK, PT'/, "principal yang sudah ada tidak diusulkan ulang");
    assert.doesNotMatch(sql, /^ {4}\('KINO', NULL::text, 'KINO', 'KINO'/m, "alias yang sudah ada tidak diusulkan ulang");
    assert.doesNotMatch(sql, /^ {4}\('KINO', 'NON_FOOD', 'KINO NON FOOD', 'KINO NON FOOD', 'nama'/m, "alias konflik tidak diusulkan");
    assert.match(laporanMarkdown(lap), /KONFLIK registri/);
});

test("bentuk JSON riwayat benih = baris Drizzle API: kunci camelCase = properti db/schema, kolom = kolom tabel; waktu ISO UTC", () => {
    const tabel = { principal, varian: principalVariant, alias: principalAlias } as const;
    for (const [entitas, t] of Object.entries(tabel) as [keyof typeof KOLOM_LOG, typeof principal][]) {
        const kolom = Object.fromEntries(Object.entries(getTableColumns(t)).map(([k, c]) => [k, c.name]));
        assert.deepEqual(KOLOM_LOG[entitas], kolom, `KOLOM_LOG.${entitas} = kolom Drizzle (urutan & nama)`);
        assert.doesNotMatch(jsonLog(entitas), /to_jsonb/);
    }
    assert.match(jsonLog("alias"), /'aliasNorm', b\.alias_norm/);
    assert.match(jsonLog("principal"), /'createdAt', to_char\(b\.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/);
    const sql = benihSql(susunLaporan(dataSintetis(), "2026-10-11T00:00:00.000Z"));
    assert.doesNotMatch(sql, /to_jsonb/, "benih tidak memakai to_jsonb (snake_case)");
    for (const e of ["principal", "varian", "alias"] as const) assert.ok(sql.includes(jsonLog(e)), `benih ${e} memakai jsonLog`);
});

test("benih tidak menambah varian/alias ke principal/varian NONAKTIF (= API PRINCIPAL_NONAKTIF / VARIAN_NONAKTIF); SQL juga menjaga", () => {
    const lap = susunLaporan(dataSintetis({
        principal: { ok: true, rows: [
            { code: "GDI", name: "GODREJ DISTRIBUSI INDONESIA, PT", isActive: false },
            { code: "FRS", name: "FORISA NUSAPERSADA, PT", isActive: false },
            { code: "KINO", name: "KINO INDONESIA. TBK, PT", isActive: true },
        ] },
        principalVariant: { ok: true, rows: [{ code: "KINO", variantKey: "NON_FOOD", name: "KINO NON FOOD", isActive: false }] },
    }), "2026-10-11T00:00:00.000Z");
    const sql = benihSql(lap);
    const aktif = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    assert.doesNotMatch(aktif, /\('GDI', /, "alias ke principal nonaktif tidak diusulkan");
    assert.doesNotMatch(aktif, /\('FRS', /, "varian/alias ke principal nonaktif tidak diusulkan");
    assert.doesNotMatch(aktif, /\('KINO', 'NON_FOOD'/, "alias ke varian nonaktif tidak diusulkan");
    assert.match(aktif, /\('KINO', NULL::text, 'K1', 'K1', 'kode_master_barang', 'master_barang'\)/, "principal aktif tetap diusulkan");
    assert.match(sql, /^-- {3}\[nonaktif\] alias MB GD -> GDI: principal GDI nonaktif$/m);
    assert.match(sql, /^-- {3}\[nonaktif\] varian FRS\/MT: principal FRS nonaktif$/m);
    assert.match(sql, /^-- {3}\[nonaktif\] alias MB KN -> KINO\/NON_FOOD: varian KINO\/NON_FOOD nonaktif$/m);
    assert.match(aktif, /JOIN principal p ON p\.code = v\.code AND p\.is_active\n\s+LEFT JOIN principal_variant x ON x\.principal_id = p\.id AND x\.variant_key = v\.variant_key\n\s+WHERE v\.variant_key IS NULL OR x\.is_active/);
    assert.match(laporanMarkdown(lap), /^\| GDI \| .* \| ya \(NONAKTIF\) \|$/m);
});
