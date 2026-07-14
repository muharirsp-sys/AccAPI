/*
 * Tujuan: Menjaga target sentuh login, semantik keyboard kalender, dan shell Laporan Harian.
 * Caller: Developer/CI setelah perubahan primitive input atau layar Laporan Harian.
 * Dependensi: node:assert, node:fs, tiga source UI terkait.
 * Main Functions: main.
 * Side Effects: Membaca file source; tidak menulis file atau memanggil jaringan.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function main() {
  const login = readFileSync("app/(auth)/login/page.tsx", "utf8");
  const datePicker = readFileSync("components/ui/DatePickerField.tsx", "utf8");
  const report = readFileSync("app/(dashboard)/laporan-harian/page.tsx", "utf8");

  assert.match(login, /login-portal-forgot[^"\n]*min-h-11/);
  assert.match(datePicker, /role="dialog"/);
  assert.match(datePicker, /ArrowLeft: -1/);
  assert.match(datePicker, /aria-haspopup="dialog"/);
  assert.match(report, /ui-page-shell/);
  assert.match(report, /<caption className="sr-only">/);
  console.log("Phase 7 interaction guards passed.");
}

main();
