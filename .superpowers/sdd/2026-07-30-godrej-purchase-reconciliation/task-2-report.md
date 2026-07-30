# Task 2 Report — Authenticated GODREJ Purchase Endpoint

## Status

Selesai. Endpoint `POST /api/reconciliation/godrej/purchases` menggunakan
handler upload bersama, permission `reconciliation.run`, master internal
`data/reconciliation/GODREJ_RETURN.xlsx`, dan engine
`reconcileGodrejPurchases` dengan toleransi DPP 1.

## RED

Command:

```text
npx tsx lib/off-program-control/godrej-purchase-route.test.ts
```

Output relevan (exit 1):

```text
Error: Cannot find module '../../app/api/reconciliation/godrej/purchases/route.ts'
Require stack:
- ...\lib\off-program-control\godrej-purchase-route.test.ts
```

Kegagalan sesuai ekspektasi: route produksi belum tersedia. Sebelum run ini,
kesalahan format top-level await pada test diperbaiki agar RED berasal dari
fitur yang hilang, bukan dari test harness.

## GREEN

Command:

```text
npx tsx lib/off-program-control/godrej-purchase-route.test.ts
```

Output (exit 0):

```text
OK - POST GODREJ Purchase mencakup auth, upload XLSX, master, parser aman, dan respons engine.
```

Tes aktual mencakup auth sebelum parsing multipart, 401/403, tepat dua field
file, extension/MIME/ukuran/signature XLSX, master hilang, whitelist dan
masking pesan parser GRN, serta respons sukses engine.

## Verification

```text
npx tsx lib/off-program-control/godrej-purchase-reconciliation.test.ts
godrej purchase reconciliation: ok
```

```text
npx eslint app/api/reconciliation/godrej/purchases/route.ts lib/off-program-control/godrej-purchase-route.test.ts lib/off-program-control/kino-sales-route.ts
npx tsc --noEmit
LINT_EXIT=0 TSC_EXIT=0
```

`lib/off-program-control/kino-sales-route.test.ts` juga dicoba, tetapi harness
legacy gagal sebelum assertion pada Node v24.15.0 karena top-level await
dikompilasi ke CJS. File tersebut tidak diubah karena berada di luar Task 2;
perilaku whitelist yang disentuh dilindungi langsung oleh test route baru.

## Self-review

- Diff minimum: satu route konfigurasi, satu route test, dan whitelist pesan
  parser pada helper yang sudah dipakai.
- Tidak ada dependency, abstraksi, worktree, push, atau perubahan `.codex`.
- Pesan parser hanya meneruskan header/format GRN yang dikenal; pesan path atau
  header asing tetap menjadi `Rekonsiliasi gagal diproses.`
- Permission dijalankan sebelum `request.formData()`.
- Master hanya dibaca dari path internal setelah upload tervalidasi.
- Concern tersisa hanya incompatibility harness test legacy di Node 24; lint,
  typecheck, test endpoint, dan test engine tetap lulus.
