# CUSSONS Sales Reconciliation Design

## Scope

Add CUSSONS to the local sales-invoice reconciliation flow. The user uploads two files:

1. Accurate `Rincian Faktur Penjualan` as `.xlsx`.
2. CUSSONS `detail.csv` as `.csv`.

The application reads the local mapping workbook `data/reconciliation/CUSSONS.xlsx`. This work remains on the existing local worktree and must not merge to `main`, push, or deploy unless the user explicitly requests it later.

Purchasing and Return remain separate future divisions. This design covers sales invoices only.

## Approved Data Contract

### Accurate

Use the existing Accurate parser and canonical fields:

- Invoice key source: `REM`.
- Product key source: `KODE_BARANG`.
- Quantity: `QTY_SATUANKECIL`.
- Gross: `NILAI JUAL`.
- Discount: `POTONGAN`.
- DPP: `DPP`.
- Tax: `NILAI_PAJAK`.
- Net: `JUMLAH`.

For CUSSONS, `REM` must contain exactly one standalone token matching `(?<![A-Z0-9])TI\d{6}(?![A-Z0-9])`. The Accurate parser must accept a CUSSONS-specific extractor option; its default extractor and all existing-principal behavior must remain identical.

### CUSSONS detail.csv

The CSV is the only principal upload required. No separate invoice-header file is needed.

Required fields include:

- `Invoice No`
- `Product Code`
- `Product Description`
- `UOM Code`
- `Selling Type`
- `Product Quantity`
- `UOM List Price`
- `Gross Amount`
- `Discount Amount`
- `Amount After SKU Disc`
- `Customer Discount`
- `Total Tax Amount`
- `Total Net Amount`
- `Tax Code`
- `Tax Percentage 1`

Only `Selling Type = S` is valid for this sales-invoice flow. Any other selling type becomes `INVALID_DATA` for the affected key because Return is handled separately.

### Mapping workbook

The authoritative mapping source is sheet `Form Fix`, not `Pvt Map 1` or another derived sheet.

- Physical header row: 5.
- Data begins at physical row 6.
- Principal SKU: `Kode Pcpl`.
- Accurate SKU: `Kode BARANG Win2`.
- Pack size: `ISI/CTN`.
- Accurate unit: `SATUAN Fix Win`.

Blank principal-code rows are skipped. Identical duplicate mappings are accepted. Conflicting mappings become `INVALID_DATA` only when the affected SKU is used; unrelated conflicts must not reject the entire workbook.

An unmapped or conflicting principal SKU cannot safely use an Accurate SKU as its canonical key. Represent it as one deterministic invalid key derived from the normalized principal SKU, such as `CUSSONS_INVALID:<principal SKU>`. It must not join to an Accurate row or produce multiple issue rows for the same invoice and principal SKU.

## Reconciliation Key and Quantity

The canonical comparison key is:

`normalized TI invoice number + mapped Accurate SKU`

Rows sharing the same key are aggregated before comparison.

Quantity rules:

- `EA`: `Product Quantity` is already the smallest-unit quantity.
- `CS`: `Product Quantity × ISI/CTN`.
- A `CS` row requires a finite positive `ISI/CTN`; otherwise it becomes `UNIT_CONVERSION_ERROR`.
- An `EA` row does not require pack size.
- An unsupported UOM becomes `UNIT_CONVERSION_ERROR`.

## Principal Amounts

Use the principal's authoritative result columns and validate their internal consistency:

- Gross: `Gross Amount`.
- Discount: `Discount Amount + Customer Discount`.
- DPP: `Amount After SKU Disc - Customer Discount`.
- Tax: `Total Tax Amount`.
- Net: `Total Net Amount`.

Validation rules:

- `Gross Amount = Product Quantity × UOM List Price`.
- `Amount After SKU Disc = Gross Amount - Discount Amount`.
- `DPP = Amount After SKU Disc - Customer Discount`.
- `Total Tax Amount = DPP × Tax Percentage 1 / 100`.
- `Total Net Amount = DPP + Total Tax Amount`.
- `Tax Code` must be `PPN_Output` and `Tax Percentage 1` must be 11 for the supplied sales flow.

Required numeric cells must not be blank, non-finite, or negative. Missing or invalid required numerics reject the whole upload with HTTP 422. Valid numeric rows whose formulas, tax contract, or selling type are inconsistent become `INVALID_DATA` for the affected key rather than silently recalculating different values.

Normalize input money values to four decimal places and validate row formulas after rounding to four decimal places, with a maximum validation difference of 0.0001. Do not compare raw JavaScript floating-point values exactly. The shared Rp1 tolerance applies only when comparing aggregated Accurate and principal results, not when validating the internal CSV formula contract.

The shared money tolerance remains Rp1 per aggregated key. Quantity must match exactly.

## Statuses

Reuse the existing result contract and status meanings:

- `MATCH`
- `MISSING_PRINCIPAL`
- `MISSING_INTERNAL` (principal-only; existing output-contract name)
- `QTY_MISMATCH`
- `VALUE_MISMATCH`
- `QTY_AND_VALUE_MISMATCH`
- `UNMAPPED_SKU`
- `UNIT_CONVERSION_ERROR`
- `INVALID_DATA`

Strict union is required: all Accurate-only and principal-only keys remain visible.

When multiple rows aggregate into one key, status resolution must be deterministic and independent of CSV row order. Use this precedence: `INVALID_DATA > UNIT_CONVERSION_ERROR > UNMAPPED_SKU > OK`.

## API and Upload Validation

Add `POST /api/reconciliation/cussons/sales` by reusing the existing authenticated reconciliation handler.

Extend the shared handler narrowly so its defaults remain the current two-XLSX behavior for KINO, GODREJ, SHINZUI, and MOTASA. Only the CUSSONS route configures:

- Accurate upload: `.xlsx`, existing spreadsheet MIME/magic validation.
- Principal upload: `.csv`, accepting browser MIME values `text/csv`, `application/csv`, `application/vnd.ms-excel`, `text/plain`, `application/octet-stream`, or an empty MIME value.

CSV has no ZIP magic. Validate it as nonempty text with no NUL byte, then enforce the parser and required-header contract. Do not apply the XLSX ZIP check to the principal CSV.

Keep existing authorization, upload-size limit, safe error masking, response shape, and local master handling. HTTP status behavior is:

- 400: malformed multipart form, missing/duplicate/unknown fields, wrong extension, or rejected MIME.
- 413: upload exceeds the existing 10 MB per-file limit.
- 422: invalid XLSX/CSV content, missing required headers, invalid required numerics, or parser contract failure.
- 500: missing or unreadable local master.

No response may leak internal paths, stack traces, or raw parser errors.

No new dependency is needed; reuse the installed spreadsheet parser for CSV ingestion.

## UI

Add `CUSSONS` to the existing principal selector. Reuse the existing page, themes, result table, status filters, issue-first behavior, cause explanations, and full-result export.

For CUSSONS:

- Accurate label remains `Rincian Faktur Accurate` and accepts `.xlsx`.
- Principal label becomes `Detail CUSSONS` and accepts `.csv`.
- The reconcile button activates only after both required files are selected.
- Switching principals clears incompatible selected files.
- Requests go to `/api/reconciliation/cussons/sales`.
- Export filename uses the existing dynamic-principal naming convention with CUSSONS as the selected principal.

If differences exist, the default result filter remains issue-only and each row displays the immediate cause. Export continues to include all reconciliation results, not only the visible filtered rows.

## Real-File Acceptance

Using the supplied three files, the expected result is exact:

- Accurate data rows: 52.
- Principal data rows: 39.
- Total union results: 52.
- `MATCH`: 39.
- `MISSING_PRINCIPAL`: 13, all from invoice `TI125941`.
- Every other status: 0.
- Every matched key has quantity difference 0.
- Every matched key has no amount differences.

Matched totals on both sides:

- Smallest-unit quantity: 537.
- Gross/DPP: Rp6,194,190.
- Discount: Rp0.
- Tax: Rp681,360.90.
- Net: Rp6,875,550.90.

The 13 Accurate-only rows total:

- Smallest-unit quantity: 57.
- Gross/DPP: Rp841,200.
- Tax: Rp92,532.
- Net: Rp933,732.

## Testing

Implementation must follow TDD and leave focused runnable checks for:

1. TI token extraction without changing existing principal token rules.
2. `Form Fix` physical header and mapping behavior.
3. Identical versus conflicting duplicate mappings.
4. `EA` direct quantity and `CS × ISI/CTN` conversion.
5. Missing SKU, invalid pack, unsupported UOM, and invalid selling type statuses.
6. CSV required headers, numeric validation, amount formulas, tax, and quoted fields.
7. Exact real-file acceptance result `52 / 39 / 13`.
8. Route authorization, `.xlsx` plus `.csv` validation, master errors, parser errors, safe masking, and success response.
9. UI option, dynamic labels/accept types, endpoint, default issue filter, causes, and export filename/all-results behavior.
10. Regression checks for KINO, GODREJ, SHINZUI, and MOTASA.

## Out of Scope

- CUSSONS Return transactions.
- Purchasing reconciliation.
- Uploading the master mapping through the UI.
- Creating a generic upload framework or redesigning the reconciliation page.
- New dependencies.
- Main-branch integration, push, or deployment.
