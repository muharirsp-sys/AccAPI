/**
 * Tujuan: menjalankan `bridgeRows` atas keluaran `python_backend/e2e_kino_sept.py`.
 * Caller: `npx tsx lib/e2e-kino-bridge.check.ts` (manual, sesudah e2e Python). Bukan gerbang CI.
 *
 * KENAPA ADA. `e2e_kino_sept.py` berhenti di `compile_programs` dan melaporkan "N surat tembus".
 * Tombol Muat menjalankan SATU gerbang lagi sesudah itu — `bridgeRows` — dan gerbang kedua itu
 * bisa MENOLAK program yang gerbang pertama terima (terbukti 17 Sep 2026: `BP2609006016` lolos
 * `compile_programs` lalu ditolak karena `except:{CONTRACTUAL,LOYALTY}` menunjuk DUA daftar
 * peserta, sedangkan satu aturan `promo_rule` hanya punya satu). Tanpa berkas ini, "tembus"
 * berarti setengah jalan.
 */
import { readFileSync } from "node:fs";
import { bridgeRows, type SummaryProgram } from "./summary-bridge.ts";

const hasil = JSON.parse(readFileSync("python_backend/data/e2e_kino_hasil.json", "utf8")) as {
    programs: SummaryProgram[];
};
const res = bridgeRows({
    draftId: "e2e-kino-sept2026-0000", principal: "KINO NON FOOD",
    suratProgram: "", promoLabel: "KINO NON FOOD - SEPTEMBER 2026", promoGroup: "",
    programs: hasil.programs, itemNames: {}, settlement: "on_invoice", beban: "PRINCIPAL",
    outletCodes: [],
});

const per = new Map<string, number>();
for (const row of res.rows) {
    const kunci = `${row.suratProgram} | ${row.promoGroup || "(tingkat nota)"}`;
    per.set(kunci, (per.get(kunci) ?? 0) + 1);
}
for (const [kunci, n] of [...per].sort()) console.log(String(n).padStart(4), kunci);
console.log(`\nbaris siap tulis : ${res.rows.length}`);
console.log(`program DITOLAK  : ${res.refused.length}`);
for (const alasan of res.refused) console.log(`  - ${alasan}`);

// Daftar outlet peserta per surat: aturan ON PO harus TERMUAT dengan menunjuk daftar bernama
// nomor suratnya sendiri, supaya ia tidak berlaku sampai daftar itu diunggah.
const daftar = new Map<string, string>();
for (const r of res.rows) if (r.outletList) daftar.set(`${r.suratProgram} -> ${r.outletList}`, r.outletListMode);
console.log("\ndaftar outlet yang ditunjuk:");
for (const [k, v] of [...daftar].sort()) console.log(`  ${k} (${v})`);
