"""Tujuan: Bukti ujung-ke-ujung untuk principal yang SUDAH punya jalur deterministik
(generic_promo_pipeline / priskila_pipeline / urc_pipeline lewat surat_struktur.jalur),
dijalankan atas surat asli September 2026 di reference_surat_program/sept26/.
Caller: manual (audit inventarisasi sept26), BUKAN bagian gerbang CI.
Dependensi: sama seperti e2e_kino_sept.py (routers.summary, summary_rules, master principal,
kunci Mistral atau cache OCR) -- principal di sini semua lewat jalur OCR "salin saja"
(surat_struktur.jalur), bukan parser berlapis-teks murni seperti KINO.

APA YANG DIBUKTIKANNYA: tiap surat asli principal ini dibaca lewat endpoint yang sama
persis dengan tombol Muat di layar (`summary_manual_parse_pdf_ai`), lalu `compile_programs`
dijalankan atas hasilnya -- gerbang yang sama dengan tombol Muat.

APA YANG TIDAK DILAKUKANNYA: TIDAK menulis satu baris pun ke `promo_rule`, TIDAK memanggil
endpoint publish apa pun. File ini TIDAK mengubah kino_letter.py / e2e_kino_sept.py /
summary_library.py (dipakai read-only sebagai referensi pola saja).
"""
import io
import json
import os
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPO = BASE.parent
SEPT = REPO / "reference_surat_program" / "sept26"

if not os.getenv("MISTRAL_API_KEY"):
    berkas = REPO / ".env.local"
    if berkas.is_file():
        for baris in berkas.read_text(encoding="utf-8", errors="ignore").splitlines():
            if baris.strip().startswith("MISTRAL_API_KEY="):
                os.environ["MISTRAL_API_KEY"] = baris.split("=", 1)[1].strip()
                break

sys.path.insert(0, str(BASE))

# ---- Skenario per principal: (nama_principal_untuk_jalur, file_master, [surat...]) ----------
SCENARIOS = {
    "NATUR": {
        "principal": "GONDOWANGI",
        "master": REPO / "master_barang_principle" / "MASTER BARANG GONDOWANGI.xlsx",
        "surat": [
            "GTK.CHANDEV.26.09.004-Sales Brief Volume Drive - September 2026 GT Subchannel Cosmetic, Wholesaler, Pharmacy & Drug Store, Provision (Regional 2,3,4).pdf",
            "GTK.CHANDEV.26.09.006-Sales Brief Trade Promo Juli - September 2026 Channel Online Reg-2, Reg-3, Reg-4docx.pdf",
            "GTK.CHANDEV.26.09.007-Sales Brief Volume Drive - September 2026 MTI Silver Class.pdf",
        ],
    },
    "FORISA": {
        "principal": "FORISA",
        "master": REPO / "master_barang_principle" / "MASTER BARANG FORISA.xlsx",
        "surat": ["192. Pemberitahuan Tambahan Diskon Dessert Indogrosir.pdf"],
    },
    "PRISKILA": {
        "principal": "PRISKILA",
        "master": REPO / "master_barang_principle" / "MASTER BARANG PRISKILA.xlsx",
        "surat": ["PROGRAM GT BULAN SEPTEMBER 2026.pdf"],
    },
}

SCENARIO_NAME = sys.argv[1] if len(sys.argv) > 1 else "NATUR"
SC = SCENARIOS[SCENARIO_NAME]
PRINCIPAL, MASTER, SURAT = SC["principal"], SC["master"], SC["surat"]

os.environ["SUMMARY_STORE_PATH"] = str(BASE / "data" / f"e2e_sept26_{SCENARIO_NAME.lower()}.sqlite3")

import asyncio  # noqa: E402
from starlette.datastructures import Headers, UploadFile  # noqa: E402
from routers import summary as backend, summary_library  # noqa: E402
import shared  # noqa: E402
from shared import MANUAL_MASTER_CACHE  # noqa: E402
from summary_rules import compile_programs  # noqa: E402
from summary_store import identity  # noqa: E402

PENGGUNA = "betterauth|admin|e2e@local"
TOKEN = f"e2e-sept26-{SCENARIO_NAME.lower()}-tok"


class FakeRequest:
    headers = Headers({})
    cookies = {}


def main():
    kurang = [n for n in SURAT if not (SEPT / n).is_file()]
    if kurang or not MASTER.is_file():
        print("LEWAT: berkas tidak ada:")
        for n in kurang:
            print(f"  - {SEPT / n}")
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
    print(f"=== {SCENARIO_NAME} (principal jalur={PRINCIPAL!r}) ===")
    print(f"master: {len(items)} barang, {len(kel)} kelompok\n")

    from summary_store import connect
    with connect() as db:
        db.execute("DELETE FROM summary_draft")

    for nama in SURAT:
        jalur = SEPT / nama
        berkas = UploadFile(filename=jalur.name, file=io.BytesIO(jalur.read_bytes()))
        try:
            hasil = asyncio.run(backend.summary_manual_parse_pdf_ai(
                FakeRequest(), token=TOKEN, pdf=berkas, principle_name=PRINCIPAL))
        except Exception as e:
            print(f"GAGAL PARSE (exception) {nama[:60]}: {e!r}")
            continue
        if not hasil.get("ok"):
            print(f"GAGAL PARSE {nama[:60]}: {hasil}")
            continue
        print(f"{nama[:70]}: +{len(hasil['rows'])} baris")

    with connect() as db:
        rows_db = db.execute("SELECT id, title, content FROM summary_draft ORDER BY length(content) DESC LIMIT 1").fetchone()
    if not rows_db:
        print("\nTIDAK ADA draft tersimpan -- semua surat gagal parse.")
        return 1
    draft_id, judul, isi = rows_db[0], rows_db[1], json.loads(rows_db[2])
    rows = isi["rows"]
    import collections
    print(f"\nSATU Summary '{judul}' -- {len(rows)} baris:")
    for nomor, n in sorted(collections.Counter(str(r.get("surat_program", "?")) for r in rows).items()):
        print(f"   {nomor}: {n} baris")

    unmatched = [r for r in rows if r.get("_urc_unmatched") or r.get("_priskila_unmatched")]
    print(f"\nbaris UNMATCHED (tidak ketemu di master): {len(unmatched)}")
    for r in unmatched[:15]:
        print(f"   surat={r.get('surat_program','?')} kelompok/text={str(r.get('kelompok') or r.get('group_item_text') or r.get('product_line_text') or '')[:70]}")

    from routers.summary_library import resolve_kode_barangs
    rows2 = resolve_kode_barangs(rows, isi)
    berkode = [r for r in rows2 if str(r.get("kode_barangs", "")).strip()]
    print(f"\nSesudah Simpan: {len(rows2)} baris ({len(berkode)} punya kode_barangs)")

    print("\n" + "=" * 78)
    print("GERBANG promo_rule -- compile_programs (simulasi, TIDAK menulis DB)")
    print("=" * 78)
    programs, issues = compile_programs(rows2)
    for p in programs[:30]:
        t = (p.get("tiers") or [{}])[0]
        print(f"  PROGRAM surat={str(p.get('surat_program','?')):<16} {str(p.get('kelompok',''))[:26]:<28} "
              f"kode={len(p.get('codes') or []):>3}  {p.get('start','?')}..{p.get('end','?')}  "
              f"ch={p.get('channel','') or '(kosong)':<6} min={t.get('minimum','?')}{p.get('unit','')} "
              f"benefit={t.get('bonus_quantity','') or ''}{t.get('bonus_unit','') or ''}")
    print(f"\n  program terbentuk : {len(programs)}")
    print(f"  baris ditahan     : {len(issues)}")
    if issues:
        print("  contoh ditahan (maks 15):")
        for t in issues[:15]:
            print(f"    - {str(t)[:160]}")

    try:
        hasil_gen = backend.summary_manual_generate(FakeRequest(), token=TOKEN, rows_json=json.dumps(rows2))
        if hasil_gen.get("ok"):
            from shared import MANUAL_OUTPUTS
            keluaran = MANUAL_OUTPUTS[hasil_gen["file_id"]]
            tujuan = BASE / "data" / f"e2e_sept26_{SCENARIO_NAME.lower()}_output"
            tujuan.mkdir(parents=True, exist_ok=True)
            import shutil
            shutil.copy2(keluaran["form"], tujuan / "Form_Summary.pdf")
            shutil.copy2(keluaran["dataset"], tujuan / "Dataset_Summary.xlsx")
            print(f"\nForm Summary + Dataset ditulis di: {tujuan}")
        else:
            print("\nGAGAL membuat Form Summary:", hasil_gen)
    except Exception as e:
        print(f"\nGAGAL membuat Form Summary (exception): {e!r}")

    print("\nTIDAK ADA satu baris pun ditulis ke `promo_rule`. Endpoint publish tidak disentuh.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
