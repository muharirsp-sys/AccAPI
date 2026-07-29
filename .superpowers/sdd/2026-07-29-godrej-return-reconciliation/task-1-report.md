# Task 1 Report: GODREJ Return Engine and Internal Master

## Status

Complete. `reconcileGodrejReturns` parses the Accurate XLSX, approved GODREJ
CSV rows, and the internal master, then reuses `reconcileParsedReturns`.

## TDD RED

Command:

```powershell
node --experimental-strip-types lib/off-program-control/godrej-return-validation.test.ts
```

Observed before editing production:

```text
Exit code: 1
SyntaxError: The requested module './return-reconciliation.ts' does not provide an export named 'reconcileGodrejReturns'
```

The failure was the expected missing-feature failure.

## Changes

- Added `reconcileGodrejReturns` with the existing `xlsx` dependency and shared
  reconciliation core.
- Added exact GODREJ headers, approved-only filtering, deterministic product
  cleanup, direct `Pvt Map 1` code mapping, and exact-unique `Form Fix` name
  fallback.
- Added strict single-token validation for customer/return identifiers,
  per-line invalid Accurate REM handling, required non-negative finite GODREJ
  numbers, 11% tax decomposition, unmapped handling, aggregation, and DPP
  tolerance.
- Added synthetic coverage for all Task 1 cases and real three-file acceptance.
- Copied the source master byte-for-byte to
  `data/reconciliation/GODREJ_RETURN.xlsx`.
- KINO and SHINZUI paths were not changed.

## GREEN and Regressions

```powershell
node --experimental-strip-types lib/off-program-control/godrej-return-validation.test.ts
```

```text
Exit code: 0
GODREJ Return synthetic validation passed.
```

```powershell
node --experimental-strip-types lib/off-program-control/godrej-return-validation.test.ts "C:\Users\Fiqhi Fauzan\Downloads\godrej\rincian_faktur_penjualan_cvsuryaperkasa_260729083809.xlsx" "C:\Users\Fiqhi Fauzan\Downloads\godrej\Salereturns18.csv" "C:\Users\Fiqhi Fauzan\Downloads\godrej\FIX FORM MASTER BARANG - GDI.xlsx"
```

```text
Exit code: 0
GODREJ Return synthetic validation passed.
GODREJ Return real-workbook validation passed.
```

The real assertions verify Accurate lines `33`, approved principal lines `6`,
summary `MATCH=6`, `MISSING_PRINCIPAL=27`, every other status `0`, matched qty
`42`, Accurate DPP `483275.675670`, GODREJ DPP `483275.675676`, GODREJ tax
`53160.324324`, and GODREJ total `536436`.

```powershell
node --experimental-strip-types lib/off-program-control/kino-return-validation.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-return-validation.test.ts
npx tsc --noEmit
git diff --check
```

```text
Exit code: 0
KINO Return synthetic validation passed.
shinzui return reconciliation: ok
TypeScript: no output (success).
git diff --check: no whitespace errors.
```

## Master Integrity

Source and internal SHA-256:

```text
CEBA9AD8349B9D51235515DF00F596D7EE6CBB564C9E61E3A955E7578928682F
```

PowerShell comparison returned `Equal: True`.

## Self-review and Concerns

- Mapping ambiguity errors expose only safe internal product codes; an extra
  synthetic `DATABASE PASSWORD`/secret column is never included in the error.
- The implementation intentionally performs no fuzzy matching and has no
  hardcoded product aliases.
- Existing validation scripts emit Node's pre-existing
  `MODULE_TYPELESS_PACKAGE_JSON` performance warning. It is non-fatal and was
  not addressed because changing package module mode is outside Task 1.
