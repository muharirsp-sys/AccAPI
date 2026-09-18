"""Tujuan: Bukti ujung-ke-ujung 5 surat Kino September 2026 -> Summary -> gerbang `promo_rule`.
Caller: `python e2e_kino_sept.py` (manual, sebelum meeting/training). Bukan bagian gerbang CI.
Dependensi: routers.summary, summary_rules, master Kino, kunci Mistral (atau cache OCR).
Main Functions: main. Side Effects: menulis draft di `data/e2e_kino.sqlite3`; cache OCR persisten.

APA YANG DIBUKTIKANNYA. Kelima surat dibaca, ditumpuk menjadi SATU Summary (keputusan #74: satu
Summary per principal + bulan), lalu `compile_programs` dijalankan atasnya — gerbang yang sama
persis yang dipakai tombol Muat. Kalau ia menerima, barisnya BISA jadi `promo_rule`.

APA YANG TIDAK DILAKUKANNYA: ia tidak menulis satu baris pun ke `promo_rule`. Gerbang kirim
faktur otomatis tidak disentuh.
"""
import io
import json
import re
import os
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = BASE.parent
SURAT_DIR = Path(os.getenv("SURAT_DIR", r"C:\Users\Muhar\Downloads"))
MASTER = REPO / "master_barang_principle" / "MASTER BARANG KINO NON FOOD.xlsx"
PRINCIPAL = "KINO NON FOOD"
SURAT = [
    "BP2609006016 - HPC_TP NAS_MSG PROGRAM ALL BRAND HPC PERIODE SEPTEMBER 2026.PDF",
    "BP2609007664 - HPC_TP NAS_PROMO BRAND OVALE 2IN1 CLEANSER PERIODE SEPTEMBER 2026.PDF",
    "BP2609007713 - HPC_TP NAS_PROMO BRAND RESIK V KHASIAT MANJAKANI, MANJAKANI WHITENING, KHASIAT RAMUAN MADURA WHITENING & GODOKAN SIRIH.PDF",
    "BP2609007909 - MTI - HPC CONSUMER PROMO ON PO 1 SEPTEMBER 2026 - 30 SEPTEMBER 2026.pdf",
    "BP2609008021 - HPC_TP NAS_PROGRAM SMALL PACKAGE SEPTEMBER 2026.PDF",
]

if not os.getenv("MISTRAL_API_KEY"):
    berkas = REPO / ".env.local"
    if berkas.is_file():
        for baris in berkas.read_text(encoding="utf-8", errors="ignore").splitlines():
            if baris.strip().startswith("MISTRAL_API_KEY="):
                os.environ["MISTRAL_API_KEY"] = baris.split("=", 1)[1].strip()
                break

# Penyimpanan TERPISAH dari produksi dan dari e2e Priskila, tetapi PERSISTEN: cache OCR tinggal
# di sana, jadi menjalankan ulang berkas ini tidak membayar apa pun.
os.environ["SUMMARY_STORE_PATH"] = str(BASE / "data" / "e2e_kino.sqlite3")
sys.path.insert(0, str(BASE))

import asyncio  # noqa: E402
from starlette.datastructures import Headers, UploadFile  # noqa: E402
from routers import summary as backend, summary_library  # noqa: E402
import shared  # noqa: E402
from shared import MANUAL_MASTER_CACHE  # noqa: E402
from summary_rules import compile_programs  # noqa: E402
from summary_store import identity  # noqa: E402

PENGGUNA = "betterauth|admin|e2e@local"
TOKEN = "e2e-kino-tok"


class FakeRequest:
    headers = Headers({})
    cookies = {}


def main():
    kurang = [n for n in SURAT if not (SURAT_DIR / n).is_file()]
    if kurang or not MASTER.is_file():
        print("LEWAT: berkas tidak ada di mesin ini:")
        for n in kurang:
            print(f"  - {SURAT_DIR / n}")
        if not MASTER.is_file():
            print(f"  - {MASTER}")
        return 0
    if not os.getenv("MISTRAL_API_KEY"):
        print("LEWAT: MISTRAL_API_KEY tidak ada, surat tidak bisa dibaca.")
        return 0

    backend.get_current_user = lambda request: PENGGUNA
    backend.user_has_permission = lambda *a, **k: True
    backend.validate_csrf_request = lambda request, token: True
    summary_library.get_current_user = lambda request: PENGGUNA
    summary_library.user_has_permission = lambda *a, **k: True
    summary_library.validate_csrf_request = lambda request, token: True

    kel, vmap, gmap, items = shared._parse_master_barang_xlsx(MASTER.read_bytes())
    MANUAL_MASTER_CACHE[TOKEN] = {"owner": identity(PENGGUNA), "kelompok": kel, "variant_map": vmap,
                                  "gramasi_map": gmap, "items": items, "customers": []}
    print(f"master {PRINCIPAL}: {len(items)} barang, {len(kel)} kelompok\n")

    from summary_store import connect
    with connect() as db:
        db.execute("DELETE FROM summary_draft")

    for nama in SURAT:
        jalur = SURAT_DIR / nama
        nomor = nama.split(" - ")[0].split(" ")[0]
        berkas = UploadFile(filename=jalur.name, file=io.BytesIO(jalur.read_bytes()))
        hasil = asyncio.run(backend.summary_manual_parse_pdf_ai(
            FakeRequest(), token=TOKEN, pdf=berkas, principle_name=PRINCIPAL))
        if not hasil.get("ok"):
            print(f"GAGAL PARSE {nomor}: {hasil}")
            return 1
        print(f"{nomor}: +{len(hasil['rows'])} baris")

    # Draft yang ditumpuk kelima surat. `rows` pada tanggapan parse hanya baris BARU
    # (perbaikan 50569ef), jadi isinya dibaca dari penyimpanan, bukan dari tanggapan.
    from summary_store import connect
    with connect() as db:
        satu = db.execute("SELECT id, title, content FROM summary_draft ORDER BY length(content) DESC LIMIT 1").fetchone()
    draft_id, judul, isi = satu[0], satu[1], json.loads(satu[2])
    rows = isi["rows"]
    import collections
    print(f"\nSATU Summary '{judul}' — {len(rows)} baris:")
    for nomor, n in sorted(collections.Counter(str(r.get("surat_program", "?")) for r in rows).items()):
        print(f"   {nomor}: {n} baris")

    # ---- LANGKAH MANUSIA: memilih Kelompok Barang ----------------------------------------
    # Ekstraksi SENGAJA meninggalkan `kelompok` kosong; operator memilihnya di layar dari
    # daftar kelompok master. Di sini langkah itu ditiru supaya rantainya bisa diuji sampai
    # ujung — dan yang dipilih DICETAK, supaya terlihat mana yang butuh mata orang.
    # KEPUTUSAN OPERATOR, ditulis terbuka. Ini BUKAN tebakan mesin: di layar, operator
    # memilihnya dari dropdown kelompok master. Ditulis di sini supaya rantainya bisa diuji
    # sampai ujung, dan supaya terlihat persis keputusan apa yang diminta dari orang.
    #
    # Kolom kanan = kelompok master; nilai kedua = varian (kosong berarti SEMUA varian kelompok).
    # "RESIK V KHASIAT MANJAKANI" dan "RESIK V MANJAKANI WHITENING" memakai kelompok master yang
    # SAMA dan dibedakan VARIAN — itulah kasus yang melahirkan aturan "All Variant".
    KEPUTUSAN = {
        "OVALE 2IN1 CLEANSER":                      ("OVALE FACIAL", ""),
        "RESIK V KHASIAT MANJAKANI":                ("RESIK V MANJAKANI", ""),
        "RESIK V MANJAKANI WHITENING":              ("RESIK V", "MANJAKANI WHITENING"),
        "RESIK V KHASIAT RAMUAN MADURA WHITENING":  ("RESIK V RAMUAN MADURA", "WHITENING"),
        "RESIK V GODOKAN SIRIH":                    ("RESIK V GODOKAN", "SIRIH"),
    }

    # Keputusan pengguna 17 Sep 2026:
    # - `BP2609006016` (MSG ALL BRAND): SELURUH master Kino adalah Home Personal Care, jadi
    #   programnya berlaku untuk SEMUA barang - kecuali peserta LOYALTY, dan hanya channel
    #   GT/TT. Kelayakan outletnya sudah terbaca sendiri dari surat ("EXCLUDE LOYALTY DAN
    #   CONTRACTUAL"), jadi yang kurang hanya daftar barangnya.
    # - `BP2609008021` (SMALL PACKAGE): program khusus DALAM JAWA, tidak berlaku di sini.
    #   DIABAIKAN dengan sengaja, bukan ditahan karena gagal dibaca.
    SEMUA_BARANG = {"BP2609006016"}
    ABAIKAN = {"BP2609008021"}

    dibuang = [r for r in rows if str(r.get("surat_program", "")).strip().upper() in ABAIKAN]
    rows = [r for r in rows if str(r.get("surat_program", "")).strip().upper() not in ABAIKAN]
    for r in dibuang:
        print("DIABAIKAN %s - program khusus dalam Jawa, tidak berlaku di sini." % r.get("surat_program"))
    for r in rows:
        if str(r.get("surat_program", "")).strip().upper() in SEMUA_BARANG:
            # Di layar: kelompok "Semua barang (seluruh master)". Yang dikirim hanyalah
            # sentinelnya; kode barangnya DITURUNKAN SISTEM dari master, tidak ditempel di sini
            # (dulu ditempel, dan itu menutupi apakah resolvernya benar-benar bekerja).
            r["kelompok"] = "__ALL_MASTER__"
            r["variant"] = "ALL VARIANT"
            r["gramasi"] = "ALL GRAMASI"

    print("\n" + "=" * 78)
    print("LANGKAH MANUSIA — memilih Kelompok Barang (di layar: dropdown)")
    print("=" * 78)
    belum = []
    for r in rows:
        if str(r.get("kelompok", "")).strip():
            continue
        sebut = str(r.get("keterangan", "")).replace("surat menyebut:", "").replace("MIX VARIANT", "").strip()
        pilih = KEPUTUSAN.get(sebut)
        if pilih:
            r["kelompok"], r["variant"] = pilih[0], pilih[1] or "ALL VARIANT"
            print(f"  pilih  baris {str(r.get('no','?')):<3} {str(r.get('surat_program',''))[:13]:<14} "
                  f"{sebut[:42]:<44} -> {pilih[0]} / {pilih[1] or 'ALL VARIANT'}")
        else:
            belum.append((str(r.get("no", "?")), str(r.get("surat_program", "")), sebut, str(r.get("ketentuan", ""))))
    if belum:
        print("\n  BELUM diputuskan — butuh keputusan operator/manajemen:")
        for no, sp, sebut, ket in belum:
            print(f"    baris {no:<3} {sp:<14} '{sebut}' | {ket[:46]}")

    # ---- SIMPAN: sistem menurunkan kode barang dari master --------------------------------
    from routers.summary_library import resolve_kode_barangs
    rows = resolve_kode_barangs(rows, isi)
    print(f"\nSesudah Simpan: {len(rows)} baris (baris boleh terpecah per kelompok)")
    berkode = [r for r in rows if str(r.get("kode_barangs", "")).strip()]
    print(f"  {len(berkode)} baris punya kode barang, {len(rows) - len(berkode)} belum")

    print("\n" + "=" * 78)
    print("GERBANG promo_rule — compile_programs, gerbang yang sama dengan tombol Muat")
    print("=" * 78)
    programs, issues = compile_programs(rows)
    for p in programs:
        t = (p.get("tiers") or [{}])[0]
        print(f"  PROGRAM surat={str(p.get('surat_program','?')):<14} {str(p.get('kelompok',''))[:28]:<30} "
              f"kode={len(p.get('codes') or []):>3}  {p.get('start','?')}..{p.get('end','?')}  "
              f"ch={p.get('channel','') or '(kosong)':<4} min={t.get('minimum','?')}{p.get('unit','')} "
              f"bonus={t.get('bonus_quantity','')}{t.get('bonus_unit','')} outlet={p.get('outlet_mode','')}:{','.join(p.get('outlet_classes') or [])}")
        print(f"          kode: {', '.join((p.get('codes') or [])[:8])}{' ...' if len(p.get('codes') or []) > 8 else ''}")
    if issues:
        print(f"\n  {len(issues)} baris DITAHAN (tidak ditebak):")
        for t in issues[:40]:
            print(f"    - {t}")
    surat_lolos = sorted({str(p.get("surat_program", "")).strip() for p in programs if str(p.get("surat_program", "")).strip()})
    print(f"\n  program terbentuk : {len(programs)}")
    print(f"  baris ditahan     : {len(issues)}")
    print(f"  surat yang tembus : {len(surat_lolos)} -> {surat_lolos}")
    semua = rows

    # ---- FORM SUMMARY + DATASET, lewat jalur yang sama dengan tombol di layar --------------
    hasil_gen = backend.summary_manual_generate(FakeRequest(), token=TOKEN, rows_json=json.dumps(rows))
    if not hasil_gen.get("ok"):
        print("GAGAL membuat Form Summary:", hasil_gen)
        return 1
    from shared import MANUAL_OUTPUTS
    keluaran = MANUAL_OUTPUTS[hasil_gen["file_id"]]
    tujuan = BASE / "data" / "e2e_kino_output"
    tujuan.mkdir(parents=True, exist_ok=True)
    import shutil
    form = tujuan / "Form_Summary_KINO_SEPT2026.pdf"
    dataset = tujuan / "Dataset_Summary_KINO_SEPT2026.xlsx"
    shutil.copy2(keluaran["form"], form)
    shutil.copy2(keluaran["dataset"], dataset)
    print("\nForm Summary : %s" % form)
    print("Dataset      : %s" % dataset)

    keluar = BASE / "data" / "e2e_kino_hasil.json"
    keluar.write_text(json.dumps({"rows": semua, "programs": programs, "issues": issues},
                                 ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nhasil lengkap: {keluar}")
    print("\nTIDAK ADA satu baris pun ditulis ke `promo_rule`. Gerbang faktur tetap tertutup.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
