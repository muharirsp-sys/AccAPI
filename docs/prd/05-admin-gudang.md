# PRD 05 — Administrasi Gudang (Ops Control Tower)

| Doc | Nilai |
|---|---|
| Sumber | poster `10.36.45.png` |
| Status | DRAFT Fase A · angka poster FIKTIF |
| Tanggal | 2026-07-12 |

## Tujuan
Pusat kontrol dokumen & data area gudang, penghubung Fakturist–Gudang–Delivery–Incaso–Claim.
Tiga bagian: (A) Admin Gudang: rekapan gudang, nota keluar/kembali, stok & retur;
(B) Admin Kontrol Incaso: kontrol nota terantar, aging nota H+1/H+3, serah dokumen ke Incaso;
(C) Admin Kontrol Claim: kontrol retur rusak/expired, dokumen claim principal, follow-up data claim.
Mengganti pencatatan manual nota keluar/kembali dan tracking umur nota.

## Aktor
- **Admin Gudang** (bagian A), **Admin Kontrol Incaso** (B), **Admin Kontrol Claim** (C).
- Terhubung: Fakturist (hulu), Delivery, Incaso, Claim (hilir).

## Fitur inti
1. Dashboard nota terantar & nota kembali (status per nota, real-time).
2. Tracking umur nota **H+1 / H+3** otomatis (aging sejak nota keluar; alert lewat batas).
3. Riwayat & input retur/barang rusak/expired terstruktur (tanpa cek history manual).
4. Tracking pergerakan stock (stock movement) & dokumen mana sudah/belum ke Incaso.
5. Dashboard gabungan Admin Gudang / Incaso / Claim + audit trail.

## Data yang dibutuhkan
| Data | Sumber | Catatan |
|---|---|---|
| Nota keluar (terantar) | Status dari PRD 06 Delivery + PRD 07 Gudang (siap delivery) | Satu entitas **status-nota** bersama |
| Nota kembali | Update Delivery (nota kembali ke gudang) → serah ke Incaso | |
| Aging H+1/H+3 | Derivasi: tanggal nota keluar vs hari ini (kalender `holidays.ts` existing bisa dipakai) | Bukan data baru — kalkulasi |
| Retur / barang rusak / expired | Input aplikasi ini + Accurate `sales-return` (sync terjadwal) utk cross-check | |
| Stock movement | Accurate: mutasi stok/`item-transfer`/`item-adjustment` via sync — **TBD endpoint pasti** | Bisa v1 tanpa ini (fokus nota) |
| Dokumen claim principal | Existing claim_workflow documents | Link, bukan duplikat |

## Dependensi
- **Bergantung berat pada PRD 06 (Delivery) & 07 (Gudang)** — tanpa status nota dari mereka, modul ini tak punya data. Urutan build: 07 → 06 → 05.
- Tabel status-nota bersama (lihat 00-overview: entitas sentral NOTA).
- RBAC modul `admin_gudang.*`.

## Status vs sistem sekarang
Belum ada. Tidak ada tabel nota keluar/kembali, aging, maupun retur internal.

## Asumsi & TBD
- A: H+1/H+3 = hari kerja (pakai kalender libur existing) — TBD konfirmasi hari kalender vs hari kerja.
- TBD: apakah bagian B (Kontrol Incaso) beda orang dari Divisi Incaso (PRD 02) atau peran yang sama di sisi gudang — memengaruhi RBAC.
- TBD: definisi "dokumen sudah ke Incaso" (serah fisik dicatat digital?).
