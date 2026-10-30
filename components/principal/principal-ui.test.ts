/* S7b: uji logika murni layar Data Principal — saringan daftar (termasuk lewat ejaan alias), ringkasan riwayat (isi baris + kunci
 * varian), dan tulis (401/403 diberi petunjuk, jawaban hilang/502 = belum pasti, 409 membawa kalimat + kode server). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aktorTeks, GalatTulis, ringkasLog, saring, tulis, type Log, type Principal } from "./principal-ui.ts";

const P = (code: string, name: string, isActive: boolean, aliases: string[] = [], variants: string[] = []): Principal => ({
    id: code, code, name, isActive, createdBy: null, createdAt: "2026-10-01T00:00:00.000Z", updatedBy: null, updatedAt: "2026-10-01T00:00:00.000Z",
    variants: variants.map((v) => ({ principalId: code, variantKey: v, name: null, isActive: true, createdBy: null, createdAt: "" })),
    aliases: aliases.map((a) => ({ id: a, aliasNorm: a.toUpperCase(), principalId: code, variantKey: null, aliasAsli: a, jenis: "nama", sumber: "manual", createdBy: null, createdAt: "" })),
});
const DAFTAR = [P("PA", "PRINCIPLE A", true, ["Prinsip Ay"]), P("PB", "PRINCIPLE B", false, [], ["VARIAN_A"])];

test("saringan: kode, nama, ejaan alias, kode varian, dan status", () => {
    assert.deepEqual(saring(DAFTAR, "pa", "semua").map((p) => p.code), ["PA"]);
    assert.deepEqual(saring(DAFTAR, "prinsip ay", "semua").map((p) => p.code), ["PA"]); // lewat alias
    assert.deepEqual(saring(DAFTAR, "varian_a", "semua").map((p) => p.code), ["PB"]);
    assert.deepEqual(saring(DAFTAR, "principle", "nonaktif").map((p) => p.code), ["PB"]);
    assert.deepEqual(saring(DAFTAR, "  ", "aktif").map((p) => p.code), ["PA"]);
    assert.deepEqual(saring(DAFTAR, "tidak ada", "semua"), []);
});

const L = (o: Partial<Log>): Log => ({ id: 1, entitas: "alias", kunci: "x", principalId: "PA", aksi: "buat", before: null, after: null, aktor: "u1", waktu: "2026-10-01T00:00:00.000Z", ...o });

test("ringkasan riwayat: isi baris menang, kunci varian jadi cadangan, varian dasar berlabel Dasar", () => {
    assert.deepEqual(ringkasLog(L({ entitas: "principal", aksi: "nonaktif", before: { code: "PA", name: "PRINCIPLE A" }, after: { code: "PA", name: "PRINCIPLE A" } })), { apa: "Principal dinonaktifkan", rinci: "PA · PRINCIPLE A" });
    assert.equal(ringkasLog(L({ entitas: "varian", kunci: "PA:VARIAN_A", aksi: "buat", after: null, before: null })).apa, "Varian VARIAN_A dibuat");
    assert.equal(ringkasLog(L({ entitas: "varian", kunci: "PA:", aksi: "aktif", after: { variantKey: "", name: "Dasar A" } })).apa, "Varian Dasar diaktifkan");
    assert.deepEqual(ringkasLog(L({ aksi: "hapus", before: { aliasAsli: "Prinsip Ay", jenis: "nama_surat", variantKey: "VARIAN_A" } })), { apa: "Alias dihapus", rinci: "“Prinsip Ay” · Nama di surat · varian VARIAN_A" });
    assert.equal(aktorTeks("benih:S7-2"), "benih S7-2");
    // No 87: nama akun dari API menang; tanpa nama, id akun hanya cadangan berlabel.
    assert.equal(aktorTeks("u-123", "USER A"), "USER A");
    assert.equal(aktorTeks("u-123", null), "akun u-123");
    assert.equal(aktorTeks("benih:S7-2", null), "benih S7-2");
});

function jawab(status: number, body: unknown) {
    globalThis.fetch = (async () => ({ status, json: async () => { if (body === undefined) throw new Error("bukan JSON"); return body; } })) as unknown as typeof fetch;
}

test("tulis: sukses; 403 + petunjuk izin; 409 berkode; 502 / bukan JSON / putus = belum pasti", async () => {
    jawab(201, { ok: true, principal: { id: "PA" } });
    assert.deepEqual((await tulis("/x", "POST", {})).principal, { id: "PA" });

    jawab(403, { error: "Forbidden" });
    await assert.rejects(tulis("/x", "POST", {}), (e: unknown) => e instanceof GalatTulis && !e.belumPasti && /^Forbidden\. Akun Anda belum berhak/.test(e.message));

    jawab(401, { error: "Unauthorized" });
    await assert.rejects(tulis("/x", "POST", {}), (e: unknown) => e instanceof GalatTulis && e.message === "Unauthorized. Sesi login berakhir; masuk ulang lalu coba lagi.");

    jawab(409, { ok: false, code: "ALIAS_TABRAKAN", error: "Ejaan \"X\" sudah dipakai principal PB — tidak ditimpa." });
    await assert.rejects(tulis("/x", "POST", {}), (e: unknown) => e instanceof GalatTulis && e.status === 409 && e.code === "ALIAS_TABRAKAN" && /sudah dipakai principal PB/.test(e.message));

    jawab(503, { ok: false, code: "PRINCIPAL_DDL_BELUM", error: "Hubungi IT Support — perubahan tidak disimpan." }); // pasti: server menolak, tak menulis
    await assert.rejects(tulis("/x", "POST", {}), (e: unknown) => e instanceof GalatTulis && !e.belumPasti && /IT Support/.test(e.message));

    jawab(502, { ok: false });
    await assert.rejects(tulis("/x", "POST", {}), (e: unknown) => e instanceof GalatTulis && e.belumPasti);
    jawab(500, undefined);
    await assert.rejects(tulis("/x", "POST", {}), (e: unknown) => e instanceof GalatTulis && e.belumPasti);
    globalThis.fetch = (async () => { throw new Error("putus"); }) as unknown as typeof fetch;
    await assert.rejects(tulis("/x", "DELETE"), (e: unknown) => e instanceof GalatTulis && e.belumPasti);
});
