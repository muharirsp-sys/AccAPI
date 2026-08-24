/*
 * Self-check kode penerima insentif. Jalankan: node --experimental-strip-types lib/insentif-payee.test.ts
 */
import assert from "node:assert";
import { payeeCode, parsePayee, PAYEE_PRINCIPLE_ALL } from "./insentif-payee.ts";

assert.strictEqual(payeeCode("spv", "ANI"), "SPV:ANI");
assert.strictEqual(payeeCode("sm", "HENDRIK"), "SM:HENDRIK");
assert.strictEqual(payeeCode("sales", "M-SP10"), "M-SP10", "sales tidak diberi prefiks");
assert.strictEqual(payeeCode("spv", "  MARTEN "), "SPV:MARTEN", "nama di-trim");

// Round-trip: apa pun yang dibikin harus bisa dibaca balik utuh.
for (const [role, name] of [["spv", "ANTHONIUS DENNY NAHA"], ["sm", "HENDRIK"], ["sales", "M-BSR2"]] as const) {
    const p = parsePayee(payeeCode(role, name));
    assert.strictEqual(p.role, role, `role ${role}`);
    assert.strictEqual(p.name, name, `name ${name}`);
}

// Kode sales asli tidak boleh salah dikenali sebagai SPV/SM.
for (const code of ["M-SP10", "FS1_GITO", "SM10", "SPV_SUMARTONO", "KN2_IRDAWATI"]) {
    assert.strictEqual(parsePayee(code).role, "sales", `${code} harus dibaca sales`);
    assert.strictEqual(parsePayee(code).name, code);
}
// "SPV_SUMARTONO" (underscore, kode sales nyata di file target) beda dari "SPV:" — jangan tertukar.
assert.strictEqual(parsePayee("SPV:SUMARTONO").role, "spv");

assert.strictEqual(PAYEE_PRINCIPLE_ALL, "-");

console.log("OK — all insentif-payee checks passed");
