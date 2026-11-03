/*
 * Simulasi data tipe program OFF setelah badge "Data Lama" dihapus dari UI.
 * Tujuan: membuktikan logika normalisasi + audit (originalType / typeIsLegacy)
 * TIDAK terpengaruh oleh penghapusan badge. Hanya membaca fungsi lib, tidak
 * menyentuh DB / schema / API.
 */
import {
  resolveProgramType,
  resolveLegacyProgramType,
  resolveProgramTypeForSave,
  normalizeProgramType,
  OFF_PROGRAM_TYPES,
} from "../lib/off-program-control/program-type";

let pass = 0;
let fail = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log(`PASS :: ${label} :: ${a}`);
  } else {
    fail += 1;
    console.log(`FAIL :: ${label} :: got ${a} expected ${e}`);
  }
}

console.log("=== Dropdown final ===");
console.log(OFF_PROGRAM_TYPES.join(", "));

console.log("\n=== A. Legacy read (resolveLegacyProgramType) ===");
// Data lama dari DB. Badge UI sudah dihapus, tapi metadata harus tetap utuh.
const sampling = resolveLegacyProgramType("Sampling");
check("Sampling -> normalized Sample", sampling.normalizedType, "Sample");
check("Sampling -> originalType preserved", sampling.originalType, "Sampling");
check("Sampling -> typeIsLegacy true", sampling.typeIsLegacy, true);
check("Sampling -> not forced fallback", sampling.forcedToFallback, false);

const samplingArea = resolveLegacyProgramType("Sampling Area");
check("Sampling Area -> Sample", samplingArea.normalizedType, "Sample");
check("Sampling Area -> original kept", samplingArea.originalType, "Sampling Area");
check("Sampling Area -> legacy true", samplingArea.typeIsLegacy, true);

const visibilty = resolveLegacyProgramType("Visibilty");
check("Visibilty(typo) -> Visibility", visibilty.normalizedType, "Visibility");
check("Visibilty -> original kept", visibilty.originalType, "Visibilty");
check("Visibilty -> legacy true", visibilty.typeIsLegacy, true);

const unknownType = resolveLegacyProgramType("Kategori Asing XYZ");
check("Unknown -> fallback Lainnya (3 Nov 2026)", unknownType.normalizedType, "Lainnya");
check("Unknown -> forcedToFallback true", unknownType.forcedToFallback, true);
check("Unknown -> original kept", unknownType.originalType, "Kategori Asing XYZ");

const exactLegacy = resolveLegacyProgramType("Display");
check("Display(legacy read) -> Display", exactLegacy.normalizedType, "Display");
check("Display(legacy read) -> legacy true (forced)", exactLegacy.typeIsLegacy, true);

console.log("\n=== B. Input baru dari form (resolveProgramType) ===");
const newDisplay = resolveProgramType("Display");
check("New Display -> not legacy", newDisplay.typeIsLegacy, false);
check("New Display -> isExactNewType", newDisplay.isExactNewType, true);

const newSampling = resolveProgramType("Sampling");
check("New Sampling -> Sample", newSampling.normalizedType, "Sample");
check("New Sampling -> legacy true", newSampling.typeIsLegacy, true);

console.log("\n=== C. Simpan menghormati originalType (resolveProgramTypeForSave) ===");
// Supervisor mengoreksi data lama "Sampling" -> memilih "Event" di dropdown.
const corrected = resolveProgramTypeForSave("Event", "Sampling");
check("Save Event w/ original Sampling -> normalized Event", corrected.normalizedType, "Event");
check("Save -> originalType kept = Sampling", corrected.originalType, "Sampling");
check("Save -> typeIsLegacy true (original != normalized)", corrected.typeIsLegacy, true);

// Supervisor input baru murni "Display" tanpa original.
const freshSave = resolveProgramTypeForSave("Display", "");
check("Save fresh Display -> normalized Display", freshSave.normalizedType, "Display");
check("Save fresh Display -> not legacy", freshSave.typeIsLegacy, false);

// Supervisor membiarkan data lama "Sampling" (dropdown ter-set Sample otomatis).
const keepLegacy = resolveProgramTypeForSave("Sample", "Sampling");
check("Save Sample w/ original Sampling -> Sample", keepLegacy.normalizedType, "Sample");
check("Save -> original Sampling kept", keepLegacy.originalType, "Sampling");
check("Save -> typeIsLegacy true (Sampling!=Sample)", keepLegacy.typeIsLegacy, true);

console.log("\n=== D. normalizeProgramType sanity ===");
check("normalize sampling -> Sample", normalizeProgramType("sampling"), "Sample");
check("normalize visibilityy -> Visibility", normalizeProgramType("visibilityy"), "Visibility");
check("normalize empty -> null", normalizeProgramType(""), null);

console.log(`\n==== PROGRAM TYPE SIMULATION: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail === 0 ? 0 : 1);
