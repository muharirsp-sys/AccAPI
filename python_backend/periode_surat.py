"""Tujuan: Menerjemahkan kolom "Periode" surat (apa adanya) menjadi rentang tanggal YYYY-MM-DD.
Caller: priskila_pipeline dan jalur struktur lain yang barisnya harus bisa jadi `promo_rule`.
Dependensi: pustaka standar. Murni — tidak membaca berkas, tidak memanggil apa pun.
Main Functions: rentang. Side Effects: tidak ada.

KENAPA INI KODE, BUKAN PERTANYAAN UNTUK MODEL.
Perintah "salin saja" sengaja tidak meminta model menafsirkan apa pun; ia menyalin sel surat
verbatim dan matcher deterministik yang memutuskan. Tanggal tidak boleh jadi pengecualian:
`compile_programs` MENOLAK baris tanpa `periode_start`/`periode_end`, jadi kalau modelnya yang
menebak tanggal, satu tebakan meleset berarti satu program diam-diam tidak pernah jadi aturan.

Kode ini menerjemahkan teks yang SUDAH disalin. Ia sengaja mengembalikan ("", "") daripada
menebak ketika teksnya tidak dikenali — baris tanpa tanggal ditahan dengan sebabnya di gerbang
`compile_programs`, dan itu jauh lebih baik daripada aturan promo yang berlaku di bulan yang salah.

YANG DITOLAKNYA DENGAN SENGAJA. Kalimat batas klaim ("paling lambat tanggal 31 September 2026")
bukan periode program, dan OCR sempat memotongnya menjadi `31 Juni 2026` dan `September` —
tanggal yang bahkan tidak ada di kalender. Tanggal yang tidak sah (31 Juni, 31 September) ditolak,
bukan digeser diam-diam ke tanggal terdekat yang sah.
"""
import calendar
import re
from datetime import date

BULAN = {
    "JANUARI": 1, "JAN": 1, "FEBRUARI": 2, "FEB": 2, "PEBRUARI": 2, "MARET": 3, "MAR": 3,
    "APRIL": 4, "APR": 4, "MEI": 5, "JUNI": 6, "JUN": 6, "JULI": 7, "JUL": 7,
    "AGUSTUS": 8, "AGS": 8, "AGT": 8, "AUG": 8, "SEPTEMBER": 9, "SEP": 9, "SEPT": 9,
    "OKTOBER": 10, "OKT": 10, "OCT": 10, "NOVEMBER": 11, "NOV": 11, "DESEMBER": 12, "DES": 12, "DEC": 12,
}
_NAMA = "|".join(sorted(BULAN, key=len, reverse=True))


def _tgl(tahun, bulan, hari):
    """Tanggal yang BENAR-BENAR ada, atau None. 31 Juni bukan tanggal dan tidak digeser."""
    try:
        return date(tahun, bulan, hari)
    except ValueError:
        return None


def _akhir(tahun, bulan):
    return date(tahun, bulan, calendar.monthrange(tahun, bulan)[1])


def rentang(teks, tahun_bawaan=None):
    """("1 - 30 September 2026") -> ("2026-09-01", "2026-09-30"). Tidak dikenali -> ("", "").

    Bentuk yang dikenali, berurut dari yang paling spesifik:
      "01 Maret 2026 s/d 31 Maret 2026" / "1 Sep 2026 - 30 Sep 2026"  (dua tanggal penuh)
      "1 - 30 September 2026"                                          (satu bulan, dua hari)
      "Maret - April 2026"                                             (rentang bulan)
      "MARET 2026" / "Periode September 2026"                          (satu bulan penuh)
    """
    t = " ".join(str(teks or "").upper().split())
    if not t:
        return "", ""

    # "01 MARET 2026 s/d 31 MARET 2026" -- dua tanggal lengkap.
    m = re.search(rf"(\d{{1,2}})\s+({_NAMA})\.?\s+(\d{{4}})\s*(?:S/D|SD|SAMPAI|HINGGA|-|–|—)\s*"
                  rf"(\d{{1,2}})\s+({_NAMA})\.?\s+(\d{{4}})", t)
    if m:
        a = _tgl(int(m[3]), BULAN[m[2]], int(m[1]))
        b = _tgl(int(m[6]), BULAN[m[5]], int(m[4]))
        return (a.isoformat(), b.isoformat()) if a and b and a <= b else ("", "")

    # "1 - 30 SEPTEMBER 2026" -- dua hari, satu bulan, satu tahun.
    m = re.search(rf"(\d{{1,2}})\s*(?:S/D|SD|SAMPAI|HINGGA|-|–|—)\s*(\d{{1,2}})\s+({_NAMA})\.?\s+(\d{{4}})", t)
    if m:
        th, bl = int(m[4]), BULAN[m[3]]
        a, b = _tgl(th, bl, int(m[1])), _tgl(th, bl, int(m[2]))
        return (a.isoformat(), b.isoformat()) if a and b and a <= b else ("", "")

    # "MARET - APRIL 2026" -- rentang bulan penuh.
    m = re.search(rf"\b({_NAMA})\.?\s*(?:S/D|SD|SAMPAI|HINGGA|-|–|—)\s*({_NAMA})\.?\s+(\d{{4}})", t)
    if m:
        th = int(m[3])
        return date(th, BULAN[m[1]], 1).isoformat(), _akhir(th, BULAN[m[2]]).isoformat()

    # "MARET 2026" / "PERIODE SEPTEMBER 2026" -- satu bulan penuh.
    #
    # ANGKA HARI DI DEPAN NAMA BULAN MEMBATALKAN PEMBACAAN INI, dan itu inti berkas ini.
    # "31 JUNI 2026" dan "PALING LAMBAT TANGGAL 31 SEPTEMBER 2026" adalah potongan kalimat
    # BATAS KLAIM, bukan periode program. Tanpa penjagaan ini keduanya lolos sebagai "bulan
    # penuh" -- Juni utuh dan September utuh -- dan sebuah aturan promo berlaku sebulan penuh
    # atas dasar kalimat yang tidak pernah menyebut periode. Satu tanggal tunggal juga bukan
    # rentang: dua ujungnya harus disebut surat, atau tidak sama sekali.
    m = re.search(rf"\b({_NAMA})\.?\s+(\d{{4}})\b", t)
    if m and not re.search(rf"\d\s*({_NAMA})\.?\s+\d{{4}}", t):
        th, bl = int(m[2]), BULAN[m[1]]
        return date(th, bl, 1).isoformat(), _akhir(th, bl).isoformat()

    # "SEPTEMBER" tanpa tahun -- HANYA dipakai bila pemanggil menyediakan tahun, dan tetap
    # berupa bulan PENUH. Sendirian ia justru bentuk yang dihasilkan potongan kalimat klaim,
    # jadi tanpa tahun dari surat ia ditolak, bukan ditebak dengan tahun berjalan.
    m = re.fullmatch(rf"(?:PERIODE\s+)?({_NAMA})\.?", t)
    if m and tahun_bawaan:
        bl = BULAN[m[1]]
        return date(int(tahun_bawaan), bl, 1).isoformat(), _akhir(int(tahun_bawaan), bl).isoformat()

    return "", ""


if __name__ == "__main__":
    kasus = [
        ("MARET 2026", ("2026-03-01", "2026-03-31")),
        ("JUNI 2026", ("2026-06-01", "2026-06-30")),
        ("Periode September 2026", ("2026-09-01", "2026-09-30")),
        ("1 - 30 September 2026", ("2026-09-01", "2026-09-30")),
        ("01 Maret 2026 s/d 31 Maret 2026", ("2026-03-01", "2026-03-31")),
        ("1 Sep 2026 - 30 Sep 2026", ("2026-09-01", "2026-09-30")),
        ("Maret - April 2026", ("2026-03-01", "2026-04-30")),
        ("Februari 2024", ("2024-02-01", "2024-02-29")),      # kabisat
        ("Februari 2026", ("2026-02-01", "2026-02-28")),
        # Yang HARUS ditolak -- inilah sebab berkas ini ada.
        ("31 Juni 2026", ("", "")),                            # 31 Juni bukan tanggal
        ("September", ("", "")),                               # tanpa tahun: potongan kalimat klaim
        ("", ("", "")),
        ("paling lambat tanggal 31 September 2026", ("", "")),  # 31 Sep bukan tanggal
        ("30 - 1 September 2026", ("", "")),                    # mundur
    ]
    gagal = 0
    for teks, harap in kasus:
        dapat = rentang(teks)
        tanda = "OK " if dapat == harap else "GAGAL"
        if dapat != harap:
            gagal += 1
        print(f"{tanda} {teks!r:<42} -> {dapat}")
    # Tahun dari surat membuat "September" sendirian bisa dipakai -- tapi hanya bila DIBERI.
    if rentang("September", 2026) != ("2026-09-01", "2026-09-30"):
        gagal += 1
        print("GAGAL tahun_bawaan tidak dipakai")
    # Kalimat klaim yang memuat bulan sah TIDAK boleh lolos jadi periode program: ia dikenali
    # sebagai "bulan penuh" kalau kita tidak hati-hati. Dipastikan di sini.
    if rentang("klaim paling lambat 31 Oktober 2026") == ("", ""):
        print("OK  kalimat klaim dengan tanggal tak sah ditolak")
    print("\nSEMUA LULUS" if not gagal else f"\n{gagal} GAGAL")
    raise SystemExit(1 if gagal else 0)
