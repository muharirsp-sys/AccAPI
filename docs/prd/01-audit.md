# PRD 01 — Divisi Audit (Ops Control Tower)

| Doc | Nilai |
|---|---|
| Sumber | poster `10.36.17.png` |
| Status | DRAFT Fase A · angka poster FIKTIF |
| Tanggal | 2026-07-12 |

## Tujuan
Audit sebagai sensor independen: semua temuan (stok, nota, setoran, claim, closing) tercatat
terpusat dengan PIC + deadline + bukti, ter-follow-up sampai closing, dan pola masalah
berulang terlihat. Mengganti temuan yang tersebar di nota fisik/Excel/WA/laporan manual.

## Aktor
- **Auditor** — input temuan, validasi, monitoring, closing.
- **Kepala Divisi (semua divisi)** — menerima assignment temuan, follow-up.
- **OM / Direktur** — eskalasi + tracking follow-up.

## Fitur inti
1. Register temuan: divisi, kategori (stok/nota/setoran/claim/closing/follow-up), tingkat risiko, potensi kerugian (Rp), PIC, deadline, status (open/overdue/selesai), bukti digital (file).
2. Alur: data masuk → monitoring bukti → deteksi temuan → validasi → assign ke Kepala Divisi → follow-up OM/Direktur (jika perlu) → tindakan perbaikan → closing.
3. Dashboard: temuan hari ini/open/selesai/overdue, temuan berulang, SOP compliance %, potensi kerugian, divisi belum closing.
4. Audit trail perubahan data (siapa/kapan/apa) lintas divisi.
5. Checklist kepatuhan SOP per divisi (SOP sales/gudang/delivery/admin gudang/incaso/kasir/claim).

## Data yang dibutuhkan
| Data | Sumber | Catatan |
|---|---|---|
| Temuan, PIC, deadline, status, bukti | **Aplikasi ini** (tabel baru, mis. `audit_finding`) | Data lahir di sini, bukan Accurate |
| Audit trail per modul | Existing: `off_audit_log`, `claim_audit_log`, `permission_audit_log` | Perlu dashboard gabungan; TBD: modul lain belum punya log |
| Data pembanding stok/nota/setoran | Accurate: `item` (stok), `sales-invoice` (nota), `sales-receipt` (setoran) via **sync terjadwal** | Untuk deteksi selisih; TBD endpoint stok per gudang |
| SOP checklist master | **TBD** — belum ada sumber; kemungkinan input manual admin | |
| Potensi kerugian (Rp) | Input auditor per temuan | Angka poster fiktif |

## Dependensi
- RBAC: modul baru `audit.*` di registry.
- Notifikasi assignment/deadline (email existing `lib/email.ts` cukup untuk v1).
- Upload bukti: pola `runtime/` existing.
- Deteksi "berulang": butuh kategorisasi konsisten (master kategori temuan).

## Status vs sistem sekarang
Belum ada modul temuan. Yang ada hanya audit log per modul (OPC/Claim/RBAC) = jejak
perubahan, bukan manajemen temuan. Gap: register temuan, assignment, deadline,
SOP checklist, dashboard lintas divisi.

## Asumsi & TBD
- A: "Radar risiko real-time" = agregasi berkala, bukan stream.
- TBD: definisi SOP compliance % (dari checklist apa, dinilai siapa, periode apa).
- TBD: apakah temuan bisa dibuat otomatis dari rule (mis. selisih setoran) atau manual dulu (v1 manual).
