# GODREJ Return Final Fix Report

## Status

Both final Important findings are addressed with behavioral TDD coverage.

## TDD RED

### Identifier boundaries

After adding invalid REM cases `XRB/BFG-1` and `RB/BFG-1A`, plus principal and
Accurate customer boundary cases, the first run failed before production was
edited:

```powershell
node --experimental-strip-types lib/off-program-control/godrej-return-validation.test.ts
```

```text
Exit code: 1
AssertionError: Expected values to be strictly equal:
2 !== 4
```

The old REM regex incorrectly treated both substring/truncated values as valid,
so only the two pre-existing invalid REM rows were reported.

### Cleanup order

After the identifier fix was GREEN, the test added
`999 - PRODUCT (1/12).` and expected an exact `PRODUCT` mapping:

```text
Exit code: 1
AssertionError: Expected values to be strictly equal:
0 !== 1
```

The old cleanup required the packaging parenthetical to be the literal final
characters and therefore returned `UNMAPPED`.

## Changes

- Accurate REM and principal return-number extraction now use exactly one
  delimiter-bounded `RB/BFG-<digits>` token.
- Principal embedded customer extraction now uses exactly one
  delimiter-bounded `C-[A-Z0-9]+` token and rejects attached prefixes/suffixes.
- Accurate `KODE PELANGGAN INDUK` is now a full-field
  `C-[A-Z0-9]+` or `C-[A-Z0-9]+-GD`; only the terminal `-GD` is removed.
- Invalid Accurate REM remains a per-row `INVALID_DATA`; invalid required
  customer fields still throw parser errors.
- GODREJ product cleanup strips terminal punctuation before and after only the
  numeric packaging form `(<digits>/<digits>)`. `(LEMON).` remains descriptive.

## Fresh GREEN and Regressions

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

```powershell
npx tsx lib/off-program-control/godrej-return-route.test.ts
```

```text
Exit code: 0
OK - actual POST GODREJ Return mencakup 401/403, XLSX+CSV, master, parser aman, masking, dan tolerance parity.
```

```powershell
node --experimental-strip-types lib/off-program-control/kino-return-validation.test.ts
node --experimental-strip-types lib/off-program-control/shinzui-return-validation.test.ts
npx tsc --noEmit
npx eslint lib/off-program-control/return-reconciliation.ts lib/off-program-control/godrej-return-validation.test.ts
git diff --check
```

```text
Exit code: 0
KINO Return synthetic validation passed.
shinzui return reconciliation: ok
TypeScript: no output (success).
Scoped ESLint: no output (success).
git diff --check: no whitespace errors.
```

## Concern

The direct Node validation scripts retain the repository's pre-existing,
non-fatal `MODULE_TYPELESS_PACKAGE_JSON` performance warning. No push was made.
