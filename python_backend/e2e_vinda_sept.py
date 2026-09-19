"""Tujuan: Bukti ujung-ke-ujung parser BARU `vinda_letter.py` atas 2 surat SKP Vinda asli
September 2026 -> Summary -> gerbang `promo_rule` (simulasi).
Caller: `python e2e_vinda_sept.py` (manual, audit inventarisasi sept26). Bukan gerbang CI.
Dependensi: vinda_letter (baru), summary_rules.compile_programs, master VINDA asli,
routers.summary_library.resolve_kode_barangs (dipakai READ-ONLY, tidak diubah).

CATATAN: `vinda_letter.py` BELUM dipasang sebagai jalur otomatis di
`routers/summary.py::summary_manual_parse_pdf_ai` (tidak seperti kino_extraction) -- pemasangan
itu sengaja tidak dilakukan di sini karena user secara eksplisit sedang mengubah
`routers/summary_library.py` sendiri di worktree utama saat ini (potensi tabrakan). Skrip ini
memanggil `vinda_letter.parse_pdf` + `match_items` langsung, lalu menyambung ke
`resolve_kode_barangs`/`compile_programs` yang sama persis dengan yang dipakai tombol Muat, jadi
bukti kelulusannya tetap sah -- yang belum terjadi hanyalah pemasangan router satu baris itu.

APA YANG TIDAK DILAKUKANNYA: TIDAK menulis satu baris pun ke `promo_rule`, TIDAK memanggil
endpoint publish apa pun.
"""
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = BASE.parent
SEPT = REPO / "reference_surat_program" / "sept26"
MASTER = REPO / "master_barang_principle" / "MASTER BARANG VINDA.xlsx"
SURAT = [
    "13. SKP Strata disc GT  LKA  Jul-Sep'26.pdf",
    "08 2026_SKP On Faktur Channel GT-Addendum CV. Surya Perkasa.pdf",
]

sys.path.insert(0, str(BASE))

import shared  # noqa: E402
from vinda_letter import parse_pdf, match_items  # noqa: E402
from summary_rules import compile_programs  # noqa: E402


def main():
    if not MASTER.is_file():
        print(f"LEWAT: master tidak ada: {MASTER}")
        return 0
    kel, vmap, gmap, items = shared._parse_master_barang_xlsx(MASTER.read_bytes())
    print(f"master VINDA: {len(items)} barang, {len(kel)} kelompok\n")

    all_rows = []
    for nama in SURAT:
        jalur = SEPT / nama
        if not jalur.is_file():
            print(f"LEWAT (tidak ada di mesin ini): {jalur}")
            continue
        try:
            hasil = parse_pdf(jalur.read_bytes())
        except Exception as e:
            print(f"GAGAL PARSE {nama}: {e!r}")
            continue
        print(f"{nama}")
        print(f"  on_faktur={hasil['on_faktur']}  baris={len(hasil['rows'])}  ditahan={len(hasil.get('held_rows') or [])}")
        for w in hasil["warnings"]:
            print(f"  PERINGATAN: {w}")
        rows = match_items([dict(r) for r in hasil["rows"]], items)
        for r in rows:
            print(f"    baris {r['no']}: {r['kelompok']} / {r['variant']} / {r['gramasi']} "
                  f"-> kode={r['kode_barangs'] or '(TIDAK COCOK)'}  {r['ketentuan']} -> {r['benefit']}")
        all_rows.extend(rows)
        print()

    if not all_rows:
        print("Tidak ada baris untuk disimulasikan lebih lanjut (semua surat ditahan/gagal).")
        return 0

    for i, r in enumerate(all_rows, start=1):
        r.setdefault("id", f"vinda-{i}")
        r.setdefault("nama_program", "SKP VINDA")
        r.setdefault("channel_gtmt", "GT")
        r.setdefault("unit", "CTN")

    print("=" * 78)
    print("GERBANG promo_rule -- compile_programs (simulasi, TIDAK menulis DB)")
    print("=" * 78)
    programs, issues = compile_programs(all_rows)
    for p in programs:
        t = (p.get("tiers") or [{}])[0]
        print(f"  PROGRAM surat={p.get('surat_program','?'):<50} {str(p.get('kelompok',''))[:34]:<36} "
              f"kode={len(p.get('codes') or [])}  {p.get('start','?')}..{p.get('end','?')}  "
              f"min={t.get('minimum','?')}{p.get('unit','')} bonus={t.get('bonus_quantity','')}{t.get('bonus_unit','')}")
    print(f"\n  program terbentuk : {len(programs)}")
    print(f"  baris ditahan     : {len(issues)}")
    for t in issues[:15]:
        print(f"    - {str(t)[:160]}")
    print("\nTIDAK ADA satu baris pun ditulis ke `promo_rule`. Endpoint publish tidak disentuh.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
