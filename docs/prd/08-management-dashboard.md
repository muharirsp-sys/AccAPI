# PRD 08 — Management Dashboard (Ops Control Tower)

| Doc | Nilai |
|---|---|
| Sumber | poster `10.37.46.png` |
| Status | DRAFT Fase A · angka poster FIKTIF |
| Tanggal | 2026-07-12 |

## Tujuan
Satu layar untuk OM/Direktur: **traffic light semua divisi** (Sales, Fakturist, Gudang, Delivery,
Incaso, Kasir, Retur & Claim, Control Center), **daily closing board** (divisi mana sudah closing),
total pending & selisih, nota belum kembali, claim deadline dekat, alert kritikal, drill-down ke
modul terkait. Closing harian ter-lock otomatis (poster: lock 20:00).

## Aktor
- **OM / Direktur / Manajemen** — read-only + drill-down.
- Semua divisi — sumber status (pasif).

## Fitur inti
1. Traffic light per divisi (hijau/kuning/merah) + % closing OK per divisi.
2. Daily closing board: N/8 divisi closing, status DALAM PROSES/LOCKED, lock otomatis jam tertentu.
3. Agregat kritikal: total pending (Rp), total selisih (Rp), nota belum kembali, claim deadline dekat.
4. Alert kritikal per divisi (contoh poster: retur & claim deadline hari ini, setoran overdue, nota belum kembali > 7 hari).
5. Drill-down klik divisi → modul terkait.

## Alur teknis (poster)
Data dari semua modul → hitung pending & selisih → tampilkan traffic light → review closing per divisi → alert kritikal → daily closing locked.

## Data yang dibutuhkan
| Data | Sumber | Catatan |
|---|---|---|
| Status closing per divisi | Modul divisi masing-masing (PRD 01–07, 09, 10) — tabel closing harian bersama | **Murni derivatif** — dashboard ini tidak punya data sendiri |
| Ambang traffic light | Konfigurasi (rule per divisi) — **TBD definisi hijau/kuning/merah per divisi** | Paling kritis untuk disepakati |
| Total pending/selisih | Agregasi query dari tabel modul | |
| Alert kritikal | Rule dari modul (deadline claim ≤ hari ini, aging > N hari, dst.) | |

## Dependensi
- **Semua PRD lain** — ini modul paling hilir. Nilai muncul bertahap: bisa mulai hanya dgn divisi yang sudah punya modul (Claim/OPC existing) lalu bertambah.
- Definisi closing per divisi (kontrak data: `divisi, tanggal, status, locked_at, oleh`).

## Status vs sistem sekarang
Belum ada dashboard gabungan. Home dashboard existing ≠ lintas divisi. dashboard-generator
desktop = analisis file offline, bukan operasional. Modul existing yang siap menyetor status:
Claim Workflow (outstanding/deadline), OPC (progress batch).

## Asumsi & TBD
- A: refresh berkala (polling) memadai; tidak perlu push.
- TBD: jam lock closing & siapa boleh unlock.
- TBD: definisi resmi traffic light per divisi (perlu keputusan manajemen, bukan teknis).
- TBD: "Kasir" muncul sebagai divisi di traffic light tapi tidak punya poster/modul sendiri.
