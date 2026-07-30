# CUSSONS Purchase Reconciliation Design

## Scope

Add CUSSONS to the existing Pembelian reconciliation flow on local `main`.
Users upload one Accurate purchase-detail XLSX and one CUSSONS
`TXN_COMPINV_DTL.csv`; the application uses the committed internal mapping
and immediately shows issue-first reconciliation results.

## Reuse

- Extend `lib/off-program-control/purchase-reconciliation.ts`; do not add a
  second reconciliation framework.
- Reuse the existing result/status/aggregation logic and the RECKITT purchase
  formula checks.
- Reuse `parseCussonsMappings()` from `sales-reconciliation.ts`; `Form Fix` is
  the authoritative CUSSONS mapping source.
- Reuse `data/reconciliation/CUSSONS_RETURN.xlsx`. It is byte-identical to the
  supplied purchase master, SHA-256
  `2A04ED6E039D0A7BFF5A9D0F13990A06F0E8D255C88D6766EA245A8B91F48CBF`.
  Do not create a duplicate master.

## Parsing and matching

- Accurate sheet: `Rincian Faktur Pembelian`.
- Accurate key: exactly one nine-digit invoice matching `\b1\d{8}\b` from
  `REM`, plus exact internal `KODE BARANG`.
- Accurate `SATUAN` must be `KRT`. `QTY` is already the canonical quantity and
  must not be multiplied by `ISI/CTN`.
- Accurate `PPN` is repeated at document level and is allocated proportionally
  by line DPP within `NO. PEMBELIAN`.
- Principal input is comma-delimited CSV with the same monetary headers used by
  RECKITT.
- Principal key: exact `Invoice No` plus `Product Code` mapped through
  `Form Fix`; no name/fuzzy fallback.
- Principal invoice is exactly nine digits matching `^1\d{8}$`.
- `UOM Code` must be `CS`; `Default UOM` must be `EA`.
- Canonical quantity is `Received Product Quantity`, which must equal
  `Invoice Quantity UOM`.
- `Net Amount = Product List Price × Received Product Quantity - Customer
  Discount Amount - Purchase Discount Amount - No Return Discount Amount -
  Discount Allowance Amount`, tolerance Rp1.
- `Total Tax Amount = Net Amount × Tax Percentage / 100`, tolerance Rp1.
- Blank discount/tax inputs are zero.
- Mapping conflicts are row-level `INVALID_DATA`; never guess and never abort
  the entire file.
- DPP reconciliation tolerance is Rp1.

## Real-data acceptance

The supplied files must produce:

- 249 Accurate rows and 1,070 principal rows.
- 7 Accurate invoices and 54 principal invoices.
- 246 `MATCH`.
- 812 `MISSING_ACCURATE`.
- 3 `MISSING_PRINCIPAL`.
- 12 `INVALID_DATA` caused by used ambiguous mappings.
- All other statuses zero.
- 1,073 total results.

## API and UI

- Endpoint: `/api/reconciliation/cussons/purchases`.
- Authenticate `reconciliation.run` before multipart parsing.
- Accept one Accurate XLSX and one principal CSV, maximum 10 MiB each, using
  the existing shared upload handler.
- User-input errors return the existing safe 400/413/422 responses.
- Missing or corrupt internal mapping returns a masked 500 response without
  path, stack, or parser detail.
- Add `CUSSONS` to the Pembelian principal selector; `GODREJ` remains default.
- Principal upload label: `TXN_COMPINV_DTL CUSSONS`.
- Switching principal clears files, result, filters, and upload errors.
- Export name: `rekonsiliasi-pembelian-cussons-YYYY-MM-DD.xlsx`.
- Preserve issue-first output and all three existing themes.

## Non-goals

No database schema, dependency, GitHub, remote `main`, or other division is
changed.
