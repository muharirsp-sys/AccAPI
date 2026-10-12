/* S7-2: definisi trigger penjaga = SATU sumber — DDL_S7_2.sql (prasyarat + VERIFIKASI) memuat ekspresi pemeriksa yang SAMA dengan
 * cekDdl/benih; bit tgtype sesuai pg_trigger. Perilaku nyata (trigger bernama sama tapi jenis/fungsi lain) diuji di principal-pg.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PENJAGA, SQL_PENJAGA_HILANG, sqlPenjagaSah } from "./penjaga.ts";

const rapat = (s: string) => s.replace(/\s+/g, " ").trim();

test("tgtype = bit pg_trigger (ROW 1, BEFORE 2, DELETE 8, UPDATE 16, TRUNCATE 32)", () => {
    const t = new Map(PENJAGA.map((p) => [p.nama, p.tgtype]));
    assert.equal(t.get("trg_principal_code_tetap"), 1 | 2 | 16);
    assert.equal(t.get("trg_principal_log_append_only"), 1 | 2 | 8 | 16);
    assert.equal(t.get("trg_principal_log_no_truncate"), 2 | 32);
});

test("DDL_S7_2.sql memuat ekspresi pemeriksa yang SAMA (prasyarat S7-0 + VERIFIKASI tiga trigger) — tidak bisa melenceng", async () => {
    const ddl = rapat(await readFile(new URL("../../docs/handover/DDL_S7_2.sql", import.meta.url), "utf8"));
    for (const p of PENJAGA) assert.ok(ddl.includes(rapat(sqlPenjagaSah(p))), `DDL_S7_2.sql tidak memuat ekspresi ${p.nama}`);
    for (const p of PENJAGA) assert.ok(SQL_PENJAGA_HILANG.includes(`'${p.nama}'`));
});

test("isi fungsi penjaga = isi di berkas DDL (spasi dirapatkan)", async () => {
    const s70 = rapat(await readFile(new URL("../../docs/handover/DDL_S7_0.sql", import.meta.url), "utf8"));
    const s72 = rapat(await readFile(new URL("../../docs/handover/DDL_S7_2.sql", import.meta.url), "utf8"));
    for (const p of PENJAGA) {
        const ddl = p.ddl === "DDL_S7_0.sql" ? s70 : s72;
        assert.ok(ddl.includes(`$fn$ ${p.isi} $fn$`), `${p.fungsi}: isi fungsi di ${p.ddl} berbeda dari penjaga.ts`);
    }
});
