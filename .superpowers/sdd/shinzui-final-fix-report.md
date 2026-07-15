# SHINZUI Final Fix Report

Status: DONE

## Findings fixed

1. `safeParserMessage` now accepts ordinary SHINZUI validation errors only when the label is one of the existing escaped fixed SHINZUI headers and the suffix is one of `kosong`, `negatif`, `tidak valid`, or `terlalu besar`. The anchored allowlist remains closed to arbitrary labels, paths, stacks, and unexpected text.
2. Invalid SHINZUI `INV NUM` now says `nomor invoice`; KINO/GODREJ retain the default `nomor order` wording.
3. `app/api/reconciliation/shinzui/sales/route.ts` now ends with LF.
4. The Playwright workflow title is principal-neutral. Browser rerun was intentionally skipped because only the test title changed.

## RED evidence

Command:

```text
node --experimental-strip-types lib/off-program-control/shinzui-sales-route.test.ts
```

Exit code: `1`

Output:

```text
(node:6076) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///D:/MAGANG/OFF%20PROGRAM%20CONTROL%20AFTER%20REVISI/.worktrees/shinzui-reconciliation/lib/off-program-control/shinzui-sales-route.test.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation\package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

500 !== 422

    at file:///D:/MAGANG/OFF%20PROGRAM%20CONTROL%20AFTER%20REVISI/.worktrees/shinzui-reconciliation/lib/off-program-control/shinzui-sales-route.test.ts:119:10
Node.js v24.15.0
```

The first new representative fixed-label assertion (`QTY TRX-INV tidak valid pada baris 5`) correctly exposed the generic 500 response.

Command:

```text
node --experimental-strip-types lib/off-program-control/shinzui-sales-validation.test.ts
```

Exit code: `1`

Output:

```text
(node:24864) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///D:/MAGANG/OFF%20PROGRAM%20CONTROL%20AFTER%20REVISI/.worktrees/shinzui-reconciliation/lib/off-program-control/shinzui-sales-validation.test.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation\package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /INV NUM harus memuat tepat satu nomor invoice pada baris 5/. Input:

'Error: INV NUM harus memuat tepat satu nomor order pada baris 5'

    at file:///D:/MAGANG/OFF%20PROGRAM%20CONTROL%20AFTER%20REVISI/.worktrees/shinzui-reconciliation/lib/off-program-control/shinzui-sales-validation.test.ts:299:8
Node.js v24.15.0
```

## GREEN evidence

Command:

```text
node --experimental-strip-types lib/off-program-control/shinzui-sales-route.test.ts
```

Exit code: `0`

Output:

```text
(node:17588) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///D:/MAGANG/OFF%20PROGRAM%20CONTROL%20AFTER%20REVISI/.worktrees/shinzui-reconciliation/lib/off-program-control/shinzui-sales-route.test.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation\package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
OK - route SHINZUI mencakup izin, master, parser aman, masking, dan sukses.
```

Command:

```text
node --experimental-strip-types lib/off-program-control/shinzui-sales-validation.test.ts
```

Exit code: `0`

Output:

```text
(node:7888) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///D:/MAGANG/OFF%20PROGRAM%20CONTROL%20AFTER%20REVISI/.worktrees/shinzui-reconciliation/lib/off-program-control/shinzui-sales-validation.test.ts is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to D:\MAGANG\OFF PROGRAM CONTROL AFTER REVISI\.worktrees\shinzui-reconciliation\package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
OK - parser dan rekonsiliasi SHINZUI tervalidasi.
```

## Regression and static verification

Command:

```text
node --experimental-strip-types lib/off-program-control/kino-sales-route.test.ts
```

Exit code: `0`

Output:

```text
(node:24704) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type is not specified; Node reparsed the TypeScript test as an ES module.
OK ? actual KINO POST handler covers auth, multipart, size, ZIP, master, masking, parser, and success parity.
```

Command:

```text
node --experimental-strip-types lib/off-program-control/godrej-sales-route.test.ts
```

Exit code: `0`

Output:

```text
(node:19284) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type is not specified; Node reparsed the TypeScript test as an ES module.
OK ? handler Godrej memakai validasi upload bersama dan pesan master yang tepat.
```

Command:

```text
npx tsc --noEmit
```

Exit code: `0`; output: empty.

Command:

```text
npx eslint lib/off-program-control/kino-sales-route.ts lib/off-program-control/kino-sales-route.test.ts lib/off-program-control/sales-reconciliation.ts lib/off-program-control/shinzui-sales-route.test.ts lib/off-program-control/shinzui-sales-validation.test.ts app/api/reconciliation/shinzui/sales/route.ts tests/reconciliation-ui.spec.ts
```

Exit code: `0`; output: empty.

Command:

```text
git diff --check
```

Exit code: `0`; output contained only repository CRLF conversion warnings for four working-copy files. A byte check reported `route-final-byte=10` for the SHINZUI route.

## Files changed

- `lib/off-program-control/kino-sales-route.ts`
- `lib/off-program-control/sales-reconciliation.ts`
- `lib/off-program-control/shinzui-sales-route.test.ts`
- `lib/off-program-control/shinzui-sales-validation.test.ts`
- `app/api/reconciliation/shinzui/sales/route.ts`
- `tests/reconciliation-ui.spec.ts`
- `.superpowers/sdd/shinzui-final-fix-report.md`

## Self-review

- The new safe-message branch is anchored and composes only escaped fixed SHINZUI labels with known validation suffixes; it does not introduce a broad permissive regex.
- The `orderNumber` helper defaults to `order`, so existing KINO/GODREJ callers and messages are unchanged; only the SHINZUI call supplies `invoice`.
- Focused route assertions cover punctuated (`QTY TRX-INV`), spaced (`VALUE EXCL DISC`, `INV DATE`, `ID PRODUK`), and representative suffixes (`tidak valid`, `terlalu besar`, `kosong`).
- No dependency, main-branch, push, deploy, database, or user-data changes were made.

## Intentionally remaining minor item

The SHINZUI route self-check still invokes the shared handler factory rather than importing the Next route module. No import-based harness was added: importing the real route pulls alias/RBAC application setup into this no-framework test, while the existing real endpoint acceptance already covers module wiring. Add such a harness only if endpoint acceptance is removed or route wiring begins regressing independently.
