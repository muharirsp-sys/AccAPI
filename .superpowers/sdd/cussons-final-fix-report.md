# CUSSONS Final Fix Report

Status: DONE_WITH_CONCERNS

## Scope completed

- Malformed multipart and non-form upload envelopes now return sanitized HTTP 400 responses from the shared reconciliation handler.
- CUSSONS `UOM List Price` is normalized to four decimal places before gross-formula validation.
- The malformed EA pack test is now isolated from duplicate-mapping conflict behavior.
- No dependencies, route redesign, main merge, push, or deployment were added.

## TDD evidence

### RED

1. `node --experimental-strip-types lib/off-program-control/cussons-sales-route.test.ts`
   - Exit 1.
   - New malformed request assertion failed with `500 !== 400` at `cussons-sales-route.test.ts:65`.
2. `node --experimental-strip-types lib/off-program-control/cussons-sales-validation.test.ts`
   - Exit 1.
   - New high-precision price assertion failed with `INVALID_DATA !== OK` at `cussons-sales-validation.test.ts:277`.

The failures were specific to the two final-review findings. The independent malformed EA pack assertion passed before execution reached the price RED assertion.

### Minimal fixes

- Wrapped only `request.formData()` rejection in `UploadError("Form upload tidak valid.", 400)`. Existing `UploadError` handling continues to own 400/413/422 responses; mapping/parser behavior continues to own 422/500 behavior.
- Converted `UOM List Price` through the existing `money()` round-four normalizer and rounded the scaled quantity multiplication before applying the existing one-unit scaled tolerance (`0.0001`).

### GREEN

1. `node --experimental-strip-types lib/off-program-control/cussons-sales-route.test.ts`
   - Exit 0: `OK - route CUSSONS memvalidasi XLSX + CSV dan menutup detail internal.`
2. `node --experimental-strip-types lib/off-program-control/cussons-sales-validation.test.ts`
   - Exit 0: `OK - parser dan rekonsiliasi CUSSONS tervalidasi.`

## Acceptance and regressions

- Exact CUSSONS real-file acceptance:
  - Command: `node --experimental-strip-types lib/off-program-control/cussons-sales-validation.test.ts <Accurate.xlsx> <detail.csv> data/reconciliation/CUSSONS.xlsx`
  - Exit 0. The embedded assertions verified 52 union rows, 39 MATCH, 13 MISSING_PRINCIPAL for TI125941, zero other statuses, exact quantities, and specified monetary totals.
- Shared reconciliation: exit 0, `OK ? parser KINO, tolerance, file nyata opsional, dan Godrej tervalidasi.`
- Godrej validation: exit 0.
- Shinzui validation: exit 0.
- Motasa validation: exit 0.
- KINO route: exit 0.
- Godrej route: exit 0.
- Shinzui route: exit 0.
- CUSSONS route: exit 0.

## Static verification

- `npm run lint`: exit 0; 0 errors and 268 pre-existing repository warnings.
- `npm run build -- --webpack`: exit 0; compiled, typechecked, generated 99 static pages, and listed `/api/reconciliation/cussons/sales`.
- `git diff --check`: exit 0; only line-ending conversion notices.

## Self-review

- Malformed form parsing is converted at the narrow trust boundary and cannot expose the platform parser error.
- Authorization still runs before body parsing.
- 413 file-size, 422 upload/parser, and 500 master/internal paths are unchanged and covered by the route regressions.
- All CUSSONS money inputs used by formulas are now scaled consistently; the real acceptance remains exact.
- No unrelated tracked files changed. Pre-existing untracked artifacts were preserved and excluded from the commit.

## Concerns

- Node emits the existing `MODULE_TYPELESS_PACKAGE_JSON` warning for direct TypeScript test execution.
- The full lint run reports 268 unrelated warnings.
- The successful build logs Better Auth default-secret warnings during page-data collection; production configuration should provide `BETTER_AUTH_SECRET`.
