# PRD 09 — Sekretaris OM / Control Center (Ops Control Tower)

| Doc | Nilai |
|---|---|
| Sumber | poster `10.37.54.png` |
| Status | DRAFT Fase A · angka poster FIKTIF |
| Tanggal | 2026-07-12 |

## Tujuan
Pusat kendali operasional lintas divisi: setiap isu (dari divisi mana pun) jadi **ticket** tercatat,
punya timer (SLA 2 jam), traffic light umur pending, di-follow-up, dieskalasi ke OM bila perlu,
keputusan OM tercatat, ditutup dengan status jelas + summary harian otomatis. Mengganti
laporan via WA, rekap manual, dan keputusan OM yang tidak terdokumentasi.

## Aktor
- **Sekretaris OM** — kelola ticket, follow-up, eskalasi, catat keputusan.
- **Divisi pelapor** — sumber issue (Finance, HRGA, Procurement, IT, dst.).
- **OM** — penerima eskalasi, pemberi keputusan.

## Fitur inti
1. Issue ticket per divisi: judul, divisi, prioritas, PIC, timestamps.
2. Pending board + **timer 2 jam** per ticket; traffic light umur: <1 jam hijau, 1–2 jam kuning, >2 jam merah (perlu segera ditindaklanjuti).
3. History follow-up per ticket; eskalasi ke OM (manual tetap tersedia); **keputusan OM log**.
4. Dashboard KPI: pending per divisi, masalah baru, sedang proses, >2 jam, selesai, eskalasi ke OM, divisi lambat respon, summary harian otomatis.

## Alur teknis (poster)
Issue masuk → follow-up divisi → timer berjalan → status pending/proses/selesai → eskalasi ke OM → catat keputusan → close.

## Data yang dibutuhkan
| Data | Sumber | Catatan |
|---|---|---|
| Ticket + follow-up + keputusan | **Aplikasi ini** (tabel baru `ops_ticket`, `ops_ticket_event`) | Tidak ada ketergantungan Accurate sama sekali |
| Master divisi pelapor | Enum kecil (termasuk divisi non-sistem: HRGA, IT, Procurement) | |
| Summary harian | Derivasi query + (opsional) kirim email | |

## Dependensi
- Hampir tidak ada — modul paling mandiri, kandidat quick-win.
- RBAC modul `control_center.*`.
- Timer: cukup hitung umur dari `created_at` saat render (tidak perlu job scheduler untuk v1; alert email butuh cron — TBD).

## Status vs sistem sekarang
Belum ada. `off_notification` existing = notifikasi OPC internal, bukan ticket lintas divisi.

## Asumsi & TBD
- A: SLA 2 jam berlaku umum semua jenis issue (poster tidak membedakan).
- TBD: apakah divisi lain input ticket sendiri atau semua via Sekretaris OM (memengaruhi jumlah user & RBAC).
- TBD: jam kerja utk timer (2 jam kalender vs 2 jam kerja).
