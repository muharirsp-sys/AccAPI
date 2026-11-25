"""Penjaga pelunasan (cron Hermes, TANPA AI, 0 token) — dipasang di ~/.hermes/scripts/jaga-pelunasan.py (VPS AccAPI).

Mencocokkan jejak unggahan menu Pelunasan (tabel pelunasan_unggah, baris per baris berkas Form Kerja Inc) dengan cache pelunasan
Accurate (kasir_pelunasan + kasir_pelunasan_faktur, dibaca pembaca Kasir). Pelunasan diinput sebagian oleh sales, sebagian oleh
admin/menu; penjaga ini menilai HASILNYA di Accurate, siapa pun yang menginput. Semua lewat role hanya-baca hermes_ro.

Masalah yang dilaporkan (per berkas terakhir per tanggal, 7 hari terakhir):
- KURANG   faktur belum terlunasi sebesar berkas di Accurate (tanggal berkas s.d. +7 hari): perlu cek, retur manual, gagal,
           tidak pasti, atau belum dikirim. Pembanding = uang + retur + PPN (invoicePayment Accurate), potongan tidak dihitung.
- LEBIH    terlunasi lebih besar dari berkas (dugaan input dobel sales + admin).
- REKENING pelunasan faktur pada tanggal berkas masuk rekening di luar yang sesuai berkas (mis. Ket. Trf "TF BRI" tapi 110105).
Hanya tanggal yang cache Accurate-nya LENGKAP (kasir_pelunasan_baca) yang dinilai; selain itu dilaporkan 'menunggu'.
Diam bila aman. Mengirim pesan hanya saat daftar masalah BERUBAH (baru muncul / ada yang beres). Toleransi Rp100 (selisih pembulatan).

Uji tanpa tabel: `python3 jaga-pelunasan.py --uji berkas.json` (berkas = [{database_id, tanggal, nama_berkas, baris:[…]}]) memakai
data itu sebagai pengganti pelunasan_unggah dan TIDAK menyentuh state.
"""
import csv
import io
import json
import pathlib
import subprocess
import sys

STATE = pathlib.Path.home() / ".hermes/scripts/state/jaga-pelunasan.json"
TOLERANSI = 100
MAKS_BARIS = 12
SQL = """
with u as (
  select distinct on (database_id, tanggal, nama_berkas) database_id, tanggal, nama_berkas, dibuat_pada, baris
  from {sumber}
  where tanggal >= (now() at time zone 'Asia/Makassar')::date - 7
  order by database_id, tanggal, nama_berkas, dibuat_pada desc
),
b as (
  select u.database_id, u.tanggal, u.nama_berkas, e->>'faktur' as faktur, e->>'outlet' as outlet, e->>'status' as status,
         coalesce((e->>'total')::numeric, 0) - coalesce((e->>'potongan')::numeric, 0) as harap,
         array(select jsonb_array_elements_text(coalesce(e->'rekening', '[]'::jsonb))) as rekening
  from u cross join lateral jsonb_array_elements(u.baris) e
  where coalesce(e->>'faktur', '') <> '' and e->>'status' <> 'dilewati'
),
lengkap as (select database_id, tanggal from kasir_pelunasan_baca where status = 'lengkap'),
fk as (
  select p.database_id, f.nomor_faktur, p.tanggal, split_part(p.nomor, '.', 1) as rek, p.nomor, f.invoice_payment as ip
  from kasir_pelunasan p
  join kasir_pelunasan_faktur f on f.database_id = p.database_id and f.pelunasan_id = p.pelunasan_id
),
nilai as (
  select b.*, coalesce((select sum(fk.ip) from fk where fk.database_id = b.database_id and fk.nomor_faktur = b.faktur
                        and fk.tanggal between b.tanggal and b.tanggal + 7), 0) as masuk
  from b
  where b.status <> 'sudah_di_accurate'
    and exists (select 1 from lengkap l where l.database_id = b.database_id and l.tanggal = b.tanggal)
)
select 'kurang' as jenis, 'kurang:' || database_id || ':' || tanggal || ':' || faktur as kunci,
       nama_berkas || ' ' || to_char(tanggal, 'DD/MM') as berkas,
       faktur || ' (' || outlet || ', ' || replace(status, '_', ' ') || '): berkas Rp' || replace(to_char(harap, 'FM999G999G999G990'), ',', '.')
         || ', Accurate Rp' || replace(to_char(masuk, 'FM999G999G999G990'), ',', '.') as pesan
from nilai where masuk < harap - {tol}
union all
select 'lebih', 'lebih:' || database_id || ':' || tanggal || ':' || faktur, nama_berkas || ' ' || to_char(tanggal, 'DD/MM'),
       faktur || ' (' || outlet || '): berkas Rp' || replace(to_char(harap, 'FM999G999G999G990'), ',', '.') || ', Accurate Rp'
         || replace(to_char(masuk, 'FM999G999G999G990'), ',', '.') || ' (cek input dobel)'
from nilai where masuk > harap + {tol}
union all
select distinct 'rekening', 'rekening:' || b.database_id || ':' || b.tanggal || ':' || b.faktur || ':' || fk.nomor,
       b.nama_berkas || ' ' || to_char(b.tanggal, 'DD/MM'),
       b.faktur || ' (' || b.outlet || '): ' || fk.nomor || ' masuk rekening ' || fk.rek || ', berkas: '
         || array_to_string(b.rekening, '/')
from b join fk on fk.database_id = b.database_id and fk.nomor_faktur = b.faktur and fk.tanggal = b.tanggal and fk.ip > 0
where cardinality(b.rekening) > 0 and not (fk.rek = any(b.rekening))
union all
select 'menunggu', 'menunggu:' || u.database_id || ':' || u.tanggal || ':' || u.nama_berkas,
       u.nama_berkas || ' ' || to_char(u.tanggal, 'DD/MM'),
       'cache pelunasan Accurate tanggal ' || to_char(u.tanggal, 'DD/MM') || ' belum lengkap; berkas belum bisa dicek'
from u where not exists (select 1 from lengkap l where l.database_id = u.database_id and l.tanggal = u.tanggal)
order by 1, 3, 2
"""
JUDUL = {"kurang": "Belum lunas sesuai berkas", "lebih": "Lebih dari berkas", "rekening": "Rekening tidak sesuai berkas",
         "menunggu": "Menunggu cache Accurate"}


def sumber_uji(path):
    data = json.loads(pathlib.Path(path).read_text())
    nilai = ", ".join(
        "('{}', '{}'::date, '{}', now(), '{}'::jsonb)".format(
            str(d["database_id"]).replace("'", "''"), d["tanggal"], str(d["nama_berkas"]).replace("'", "''"),
            json.dumps(d["baris"], ensure_ascii=False).replace("'", "''"))
        for d in data)
    return f"(values {nilai}) as t(database_id, tanggal, nama_berkas, dibuat_pada, baris)"


def baca(sumber):
    sql = SQL.format(sumber=sumber, tol=TOLERANSI)
    run = subprocess.run(["sudo", "-n", "/usr/local/sbin/accapi-sql", "-"], input=sql, capture_output=True, text=True, timeout=120)
    if run.returncode != 0:
        return None, (run.stdout + run.stderr).strip()[:300]
    return list(csv.DictReader(io.StringIO(run.stdout))), None


def tulis(baris, sebelum):
    per = {}
    for r in baris:
        per.setdefault(r["jenis"], []).append(r)
    print("PELUNASAN — cek berkas vs Accurate:")
    for jenis in ("kurang", "lebih", "rekening", "menunggu"):
        isi = per.get(jenis, [])
        if not isi:
            continue
        print(f"\n{JUDUL[jenis]}: {len(isi)}")
        for r in isi[:MAKS_BARIS]:
            print(("- BARU " if r["kunci"] not in sebelum else "- ") + f"[{r['berkas']}] {r['pesan']}")
        if len(isi) > MAKS_BARIS:
            print(f"- … dan {len(isi) - MAKS_BARIS} lagi")
    beres = [k for k in sebelum if k not in {r["kunci"] for r in baris}]
    if beres:
        print(f"\nSudah beres sejak cek sebelumnya: {len(beres)}")


def main():
    uji = sys.argv[1:2] == ["--uji"]
    baris, galat = baca(sumber_uji(sys.argv[2]) if uji else "pelunasan_unggah")
    if galat is not None:
        if "pelunasan_unggah" in galat and "does not exist" in galat:
            return  # tabel belum ada (aplikasi belum terpasang versi ini): diam
        print("Penjaga pelunasan gagal membaca database: " + galat)
        return
    if uji:
        tulis(baris, {})
        return
    try:
        sebelum = json.loads(STATE.read_text())
    except (OSError, ValueError):
        sebelum = {}
    kini = {r["kunci"]: r["pesan"] for r in baris}
    if set(kini) == set(sebelum):
        return
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(kini, ensure_ascii=False))
    if not kini:
        print(f"PELUNASAN beres: semua berkas 7 hari terakhir cocok dengan Accurate ({len(sebelum)} catatan selesai).")
        return
    tulis(baris, sebelum)


if __name__ == "__main__":
    main()
