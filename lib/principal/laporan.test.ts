/* S7-2: laporan kandidat principal + benih SQL (murni) pada data sintetis berejaan nyata (S7-EKSPLORASI §6.2). Benih dijalankan
 * sungguhan di Postgres oleh lib/principal-pg.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
import { principal, principalAlias, principalVariant } from "../../db/schema.ts";
import { readFile } from "node:fs/promises";
import { benihSql, FORMAT_EKSPOR, jsonLog, klasifikasiNama, KOLOM_LOG, laporanMarkdown, ringkas, SUMBER_EKSPOR, susunLaporan, susunRegistri, tokenLonggar,
    uraiEkspor, type DataDb } from "./laporan.ts";
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
            { principleCode: "HB", principleName: "HEINZ HZ/BS", n: 1 },
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
    assert.deepEqual([nama.get("ABC INDONESIA")?.cara, nama.get("ABC INDONESIA")?.target?.code, nama.get("ABC INDONESIA")?.dikesampingkan],
        ["longgar", "ABC", [{ code: "HEINZ", variantKey: null }]], "token sama persis dengan kode ABC; Heinz ABC dikesampingkan & dicatat");
    assert.deepEqual(nama.get("HEINZ HZ/BS")?.kandidat, [{ code: "HEINZ", variantKey: "BS" }, { code: "HEINZ", variantKey: "HZ" }], "seri = ambiguous");
    assert.equal(nama.get("PT MAJU JAYA")?.status, "unmatched");

    const kode = baris(lap, "master_barang — kode");
    assert.deepEqual([kode.get("K1")?.status, kode.get("K1")?.cara, kode.get("K1")?.usulan?.jenis], ["matched", "persis", "kode_master_barang"]);
    assert.deepEqual(kode.get("KN")?.target, { code: "KINO", variantKey: "NON_FOOD" });
    assert.equal(kode.get("UR")?.cara, "longgar");
    assert.deepEqual([kode.get("AC")?.cara, kode.get("AC")?.dikesampingkan], ["longgar", [{ code: "HEINZ", variantKey: null }]]);
    assert.equal(kode.get("HB")?.status, "ambiguous");
    assert.equal(kode.get("XX")?.status, "unmatched");

    const map = baris(lap, "principal_mapping");
    assert.deepEqual([map.get("KINO NON FOOD")?.status, map.get("KINO NON FOOD")?.jumlah], ["matched", 160]);
    assert.deepEqual([map.get("KINO NON FOOD-KN")?.cara, map.get("KINO NON FOOD-KN")?.target, map.get("KINO NON FOOD-KN")?.dikesampingkan],
        ["longgar", { code: "KINO", variantKey: "NON_FOOD" }, [{ code: "KINO", variantKey: null }]], "akhiran cabang -KN: paling spesifik = NON_FOOD");
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
    assert.deepEqual(ringkas(lap.sumber[0]), { matched: 6, ambiguous: 1, unmatched: 1 });
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
    assert.match(sql, /\[master_barang — nama principal\] HEINZ HZ\/BS -> ambiguous \(HEINZ\/BS, HEINZ\/HZ\)/);
    assert.match(sql, /^-- +\/\* dikesampingkan: HEINZ \*\/ \('ABC', NULL::text, 'ABC INDONESIA'/m, "longgar yang menyisihkan target lain diberi penanda");
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

test("klasifikasi longgar: token SAMA PERSIS didahulukan, lalu PALING SPESIFIK; seri = ambiguous; yang disisihkan dicatat", () => {
    const reg = susunRegistri({ principal: kosong, principalVariant: kosong, principalAlias: kosong });
    const k = (s: string) => {
        const h = klasifikasiNama(s, reg);
        const t = (x?: { code: string; variantKey: string | null }) => (x ? `${x.code}/${x.variantKey ?? "*"}` : undefined);
        return [h.status, h.cara, t(h.target), (h.kandidat ?? []).map(t), (h.dikesampingkan ?? []).map(t)];
    };
    assert.deepEqual(k("HEINZ ABC INDONESIA"), ["matched", "longgar", "HEINZ/*", [], ["ABC/*"]], "token = nama resmi HEINZ, bukan kode ABC");
    assert.deepEqual(k("KINO"), ["matched", "persis", "KINO/*", [], []]);
    assert.deepEqual(k("PT KINO"), ["matched", "longgar", "KINO/*", [], ["KINO/NON_FOOD"]], "token sama persis = KINO utuh");
    assert.deepEqual(k("PT"), ["unmatched", undefined, undefined, [], []], "badan hukum saja tidak cocok apa pun");
    assert.deepEqual(k("PT."), ["unmatched", undefined, undefined, [], []]);
    assert.deepEqual(k("KINO NON FOOD-KN"), ["matched", "longgar", "KINO/NON_FOOD", [], ["KINO/*"]], "paling spesifik");
    assert.deepEqual(k("HEINZ HZ/BS"), ["ambiguous", "longgar", undefined, ["HEINZ/BS", "HEINZ/HZ"], []], "seri antar-varian = ambiguous");
    assert.deepEqual(k("ABC INDONESIA"), ["matched", "longgar", "ABC/*", [], ["HEINZ/*"]]);
});

test("berkas ekspor (PRINCIPAL_EKSPOR.sql, psql -qAt) -> DataDb: baris JSON terakhir; sumber absen/galat = GAGAL, bukan kosong; format salah = dilempar", async () => {
    assert.deepEqual([...SUMBER_EKSPOR].sort(), Object.keys(dataSintetis()).sort(), "SUMBER_EKSPOR = semua kunci DataDb");
    const sql = await readFile(new URL("../../docs/handover/PRINCIPAL_EKSPOR.sql", import.meta.url), "utf8");
    for (const k of SUMBER_EKSPOR) assert.ok(sql.includes(`('${k}', $q$`), `PRINCIPAL_EKSPOR.sql membaca ${k}`);
    assert.ok(sql.includes(`'${FORMAT_EKSPOR}'`));

    const isi = { format: FORMAT_EKSPOR, dibaca: "2026-10-11T07:00:00.000Z", data: {
        masterBarang: { ok: true, rows: [{ principleCode: "K1", principleName: "KINO INDONESIA. TBK, PT", n: 2 }] },
        claimWorkflow: { ok: false, galat: "42P01 relation \"claim_workflow\" does not exist" },
    } };
    const { dibaca, data } = uraiEkspor(`SET\nBEGIN\n${JSON.stringify({ ...isi, dibaca: "lama" })}\n${JSON.stringify(isi)}\r\nROLLBACK\n`);
    assert.equal(dibaca, "2026-10-11T07:00:00.000Z", "baris JSON TERAKHIR");
    assert.deepEqual(data.masterBarang, isi.data.masterBarang);
    assert.deepEqual(data.claimWorkflow, isi.data.claimWorkflow, "galat dibawa");
    assert.deepEqual(data.offBatch, { ok: false, galat: "tidak ada di berkas ekspor" }, "absen = GAGAL, bukan kosong");
    const lap = susunLaporan(data, dibaca);
    assert.deepEqual(lap.sumber.filter((b) => b.galat).map((b) => b.judul.split(" ")[0]), ["principal_mapping", "no_claim_template", "off_batch", "claim_workflow"]);
    assert.throws(() => uraiEkspor("SET\nROLLBACK\n"), /tanpa baris JSON/);
    assert.throws(() => uraiEkspor(JSON.stringify({ ...isi, format: "lain" })), /bukan principal-ekspor-v1/);
    assert.throws(() => uraiEkspor("{rusak"), SyntaxError);
});
