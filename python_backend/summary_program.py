"""Tujuan: Surat program -> summary_program JSON (aturan promo per item + metadata Form ringkas) lewat Mistral, tanpa aturan per principal di kode.
Caller: router Summary (/summary/program/*).
Dependensi: httpx, PyMuPDF, summary_mistral (OCR per halaman, foto -> PDF), summary_store (cache),
            prompts/prompt_summary_program.md, prompts/summary_program.schema.json, prompts/summary_program_referensi.md.
Main Functions: ekstrak (OCR -> tiga pembaca -> aturan umum -> penjaga), umum, jaga, fakta, gabung, rapikan.
Side Effects: HTTPS berbayar ke api.mistral.ai: OCR dua kali per halaman (biasa + tabel 300 dpi) dan chat tiga pembaca
              (surat >= 4 halaman dibaca per halaman). Hasil OCR dan pembaca di-cache di summary_kv "summary-program-v1".
              Tidak menulis ke Accurate; tidak me-log isi surat atau kunci API.

KENAPA SUSUNANNYA BEGINI (diukur 30 Okt 2026 terhadap Form Oktober yang disetujui pemilik, 9 principal, 1.749 fakta;
alat ukur dan laporannya di tmp/ukur_mistral/):
- Model tidak bisa dijamin "persis sama". Satu pembaca terbaik (Large 4 + gambar halaman) mencocokkan 81% fakta;
  versi model lain bisa naik di satu principal dan turun di principal lain.
- Keamanan datang dari PENJAGA: setiap keraguan menjadi flag perlu_cek/kritis yang harus dijawab pemilik sebelum cetak
  (gerbang 0 flag, pemilik 28 Okt). Dengan penjaga + dua pembaca pemeriksa, kesalahan yang lolos tanpa tanda 27/1.749.
- Pemeriksa WAJIB model berbeda: Large 4 dua kali saling mengiyakan kesalahan yang sama (193 lolos).
- Semua aturan di sini lintas principal. Kekhususan principal hidup di referensi (teks) dan master barang (data).
"""
import asyncio
import base64
import hashlib
import json
import os
import re
from datetime import date
from pathlib import Path

import fitz
import httpx

import summary_mistral
from summary_store import JsonStore

PROMPTS = Path(__file__).resolve().parent / "prompts"
API = "https://api.mistral.ai/v1/"
# (model, kirim gambar halaman). Pembaca pertama = utama; dua sisanya pemeriksa dari model lain.
PEMBACA = (("mistral-large-4", True), ("mistral-large-latest", False), ("mistral-large-latest", True))
PER_HALAMAN = 4  # surat >= 4 halaman dibaca per halaman: Priskila 9 halaman sekaligus = 504 / koneksi diputus
LUAR_CAKUPAN = ("voucher", "gimmick", "sewa_display")  # pemilik 19 Jul 2026, L14; hanger permanent dikecualikan (29 Okt)
KOLOM = ("kode_barang", "nama_barang", "kelompok_barang", "variant", "gramasi", "satuan_kecil", "isi_per_karton")
SATUAN = {"RENCENG": "RTG", "RTG": "RTG", "CS": "CTN", "CTN": "CTN", "KARTON": "CTN", "KRT": "CTN", "CASE": "CTN", "DUS": "DUS",
          "PCS": "PCS", "PC": "PCS", "PIECE": "PCS", "PACK": "PAK", "PAK": "PAK", "BOX": "BOX"}
KEMASAN = [{"SACHET", "SCH", "SACH"}, {"BOX", "BX"}, {"BTL", "BOTOL", "BOTTLE"}, {"POUCH", "PCH"}, {"KALENG", "KLG", "CAN"},
           {"POLYBAG"}, {"PAIL"}, {"JAR"}, {"TUBE"}]
_gerbang = None


# ---------------------------------------------------------------- Mistral

async def _post(http, path, payload, coba=4):
    global _gerbang
    _gerbang = _gerbang or asyncio.Semaphore(int(os.getenv("SUMMARY_PROGRAM_CONCURRENCY", "4")))
    kunci = os.getenv("MISTRAL_API_KEY", "").strip()
    if not kunci or any(c.isspace() for c in kunci):
        raise ValueError("MISTRAL_API_KEY belum dikonfigurasi di server")
    for i in range(coba):
        try:
            async with _gerbang:
                r = await http.post(API + path, headers={"Authorization": f"Bearer {kunci}"}, json=payload)
        except httpx.TransportError as e:  # koneksi diputus / SSL EOF pada jawaban panjang
            if i == coba - 1:
                raise ValueError(f"Mistral tidak terjangkau ({type(e).__name__}); coba lagi") from None
        else:
            if r.status_code == 200:
                return r.json()
            if r.status_code not in (429, 500, 502, 503, 504) or i == coba - 1:
                raise ValueError(f"Mistral menolak permintaan (HTTP {r.status_code}); periksa kuota/konfigurasi")
        await asyncio.sleep(10 * (i + 1))


def _kunci(*bagian):
    return hashlib.sha256(json.dumps(bagian, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


async def _simpan(kunci, buat):
    """Cache OCR/pembaca: unggah ulang surat yang sama tidak membayar lagi. Kunci memuat model + isi perintah."""
    store = JsonStore("summary-program-v1")
    if (ada := store.get(kunci)) is not None:
        return ada
    nilai = await buat()
    store[kunci] = nilai
    return nilai


async def ocr(http, raw, tabel=False):
    """Teks per halaman. tabel=True: gambar 300 dpi + tabel HTML (isi tabel padat Vinda terbaca); dipakai penjaga angka."""
    with fitz.open(stream=raw, filetype="pdf") as doc:
        n = doc.page_count

    async def satu(i):
        if tabel:
            with fitz.open(stream=raw, filetype="pdf") as doc:
                png = doc[i].get_pixmap(dpi=300).tobytes("png")
            dok = {"type": "image_url", "image_url": "data:image/png;base64," + base64.b64encode(png).decode()}
        else:
            dok = {"type": "document_url", "document_url": "data:application/pdf;base64," + base64.b64encode(summary_mistral.page_pdf(raw, i)).decode()}
        out = await _post(http, "ocr", {"model": summary_mistral.MODEL, "document": dok, "table_format": "html" if tabel else "markdown"})
        return "\n".join(summary_mistral.page_text(p) for p in out["pages"])

    async def semua():
        return list(await asyncio.gather(*(satu(i) for i in range(n))))
    return await _simpan(_kunci("ocr", summary_mistral.MODEL, tabel, hashlib.sha256(raw).hexdigest()), semua)


# ---------------------------------------------------------------- perintah

def _blok(md, judul):
    return re.search(rf"## {re.escape(judul)}.*?```text\n(.*?)```", md, re.S).group(1)


def referensi(principal):
    """Bagian 'Lintas principal' + bagian principal ini saja (template prompt §2)."""
    t = (PROMPTS / "summary_program_referensi.md").read_text(encoding="utf-8")
    rata = lambda s: re.sub(r"[^A-Z0-9]", "", s.upper())
    bag = next((m.group(0) for m in re.finditer(r"### (.+?)\n.*?(?=\n### |\Z)", t, re.S)
                if rata(principal) and rata(m.group(1)).startswith(rata(principal))), "")
    return t[t.index("## Lintas principal"):t.index("## Per principal")] + bag


FORMAT = {"type": "json_schema", "json_schema": {"name": "summary_program", "strict": True,
          "schema": json.loads((PROMPTS / "summary_program.schema.json").read_text(encoding="utf-8"))}}


def pesan(principal, master, tanggal, surat, gambar=(), halaman=None):
    """surat = [(nama_berkas, [teks per halaman])]; gambar = PNG base64 yang ikut dikirim (kosong = pembaca teks)."""
    md = (PROMPTS / "prompt_summary_program.md").read_text(encoding="utf-8")
    sistem = (_blok(md, "1. SYSTEM PROMPT").replace("{{NAMA_DISTRIBUTOR}}", os.getenv("SUMMARY_NAMA_DISTRIBUTOR", "CV. Surya Perkasa"))
              + "\n\nKeluarkan SATU objek JSON yang lolos JSON Schema berikut (tanpa teks lain):\n"
              + json.dumps(FORMAT["json_schema"]["schema"], ensure_ascii=False))
    csv = "\n".join(";".join(str(x.get(k) or "") for k in KOLOM) for x in master)
    user = (_blok(md, "2. USER MESSAGE TEMPLATE").replace("{{TANGGAL_PROSES}}", tanggal).replace("{{NAMA_PRINCIPAL}}", principal)
            .replace("{{MASTER_BARANG_CSV}}", csv).replace("{{SUMMARY_LAMA_ATAU_KOSONG}}", "(kosong)")
            .replace("{{REFERENSI_KEPUTUSAN}}", referensi(principal)).replace("{{JUMLAH_FILE}}", str(len(surat))))
    user += "\nTeks surat (hasil OCR per halaman):\n" + "".join(
        f"\n=== FILE {i}: {nama} ===\n" + "".join(f"\n--- halaman {n} ---\n{h}" for n, h in enumerate(hal, 1)) for i, (nama, hal) in enumerate(surat, 1))
    if halaman:
        user += (f"\n\nBAGIAN INI HANYA HALAMAN {halaman}: buat item_rules HANYA untuk baris produk/benefit yang tercetak di halaman "
                 f"{halaman}. Halaman lain hanya konteks. Program dan seksi tetap ditulis lengkap untuk rule halaman ini. Bila halaman "
                 f"{halaman} tidak memuat baris program, keluarkan programs, item_rules dan flags kosong.")
    if not gambar:
        return sistem, user
    return sistem, [{"type": "text", "text": user + "\nGambar halaman surat terlampir berurutan; bila teks OCR dan gambar berbeda, ikuti gambar."}] + \
        [{"type": "image_url", "image_url": "data:image/png;base64," + g} for g in gambar]


async def _panggil(http, model, sistem, isi, kode):
    msgs = [{"role": "system", "content": sistem}, {"role": "user", "content": isi}]
    d = None
    for _ in range(2):  # prompt §3: gagal validasi -> kirim ulang sekali dengan errornya
        r = await _post(http, "chat/completions", {"model": model, "messages": msgs, "temperature": 0, "top_p": 1,
                                                   "max_tokens": 120000, "response_format": FORMAT})
        teks = r["choices"][0]["message"]["content"]
        if isinstance(teks, list):  # model penalar: potongan thinking + text
            teks = "".join(c.get("text", "") for c in teks if c.get("type") == "text")
        try:
            d, err = json.loads(teks), None
            err = validasi(d, kode)
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            err = [f"JSON tidak sesuai: {e}"]
        if not err:
            return d
        msgs += [{"role": "assistant", "content": teks},
                 {"role": "user", "content": "Output gagal validasi:\n" + "\n".join(err[:40]) + "\nKirim ulang JSON lengkap yang sudah diperbaiki."}]
    if not isinstance(d, dict) or not isinstance(d.get("item_rules"), list):
        raise ValueError(f"{model} tidak menghasilkan summary yang bisa dibaca")
    return d  # sisa error referensi dibereskan rapikan() dan dilaporkan sebagai flag


async def baca(http, model, gambar, principal, master, tanggal, berkas):
    """Satu pembaca atas semua berkas. Surat kecil sekaligus; surat >= PER_HALAMAN halaman per halaman (surat utuh sebagai konteks)."""
    kode = {x["kode_barang"] for x in master}
    kecil = [b for b in berkas if len(b["teks"]) < PER_HALAMAN]
    tugas = ([(kecil, None)] if kecil else []) + [([b], n) for b in berkas if len(b["teks"]) >= PER_HALAMAN for n in range(1, len(b["teks"]) + 1)]

    async def satu(bs, n):
        gb = [g for b in bs for i, g in enumerate(b["gambar"], 1) if not n or i == n] if gambar else []
        sistem, isi = pesan(principal, master, tanggal, [(b["nama"], b["teks"]) for b in bs], gb, n)
        return await _simpan(_kunci("baca", model, sistem, isi), lambda: _panggil(http, model, sistem, isi, kode))
    return gabung(list(await asyncio.gather(*(satu(bs, n) for bs, n in tugas))))


# ---------------------------------------------------------------- bentuk data

def gabung(ds):
    """Gabung hasil per bagian: program/rule dinomori ulang (P1.., R1..), id seksi/kolom ikut awalan program barunya."""
    if len(ds) == 1:
        return ds[0]
    out, np_, nr = {**ds[0], "programs": [], "item_rules": [], "flags": []}, 0, 0
    for d in ds:
        pm = {x["program_id"]: f"P{np_ + i}" for i, x in enumerate(d["programs"], 1)}
        rm = {x["rule_id"]: f"R{nr + i}" for i, x in enumerate(d["item_rules"], 1)}
        ganti = lambda t: re.sub(r"^P\d+", lambda m: pm.get(m.group(0), m.group(0)), t)
        for pr in d["programs"]:
            pr["program_id"] = pm[pr["program_id"]]
            for sc in pr["sections"]:
                sc["section_id"] = ganti(sc["section_id"])
                for k in sc["kolom"]:
                    k["kolom_id"] = ganti(k["kolom_id"])
        for r in d["item_rules"]:
            r.update(rule_id=rm[r["rule_id"]], program_id=pm.get(r["program_id"], r["program_id"]),
                     section_id=ganti(r["section_id"]), kolom_id=ganti(r["kolom_id"]))
        for f in d["flags"]:
            f.update(program_id=f["program_id"] and pm.get(f["program_id"], f["program_id"]), rule_id=f["rule_id"] and rm.get(f["rule_id"], f["rule_id"]))
        out["programs"] += d["programs"]
        out["item_rules"] += d["item_rules"]
        out["flags"] += d["flags"]
        np_, nr = np_ + len(pm), nr + len(rm)
    out["validasi"] = {k: sum(d["validasi"][k] for d in ds) for k in ds[0]["validasi"]}
    return out


def validasi(d, kode):
    """Referensi antar id + kode di master (schema sendiri sudah ditegakkan Mistral lewat json_schema strict)."""
    err = []
    progs = {p["program_id"] for p in d["programs"]}
    secs = {s["section_id"]: p["program_id"] for p in d["programs"] for s in p["sections"]}
    kols = {k["kolom_id"]: s["section_id"] for p in d["programs"] for s in p["sections"] for k in s["kolom"]}
    ids = [r["rule_id"] for r in d["item_rules"]]
    err += [f"rule_id ganda {i}" for i in {i for i in ids if ids.count(i) > 1}]
    for r in d["item_rules"]:
        rid = r["rule_id"]
        if r["program_id"] not in progs:
            err.append(f"{rid}: program_id {r['program_id']} tidak ada")
        if secs.get(r["section_id"]) != r["program_id"]:
            err.append(f"{rid}: section_id {r['section_id']} bukan milik {r['program_id']}")
        if kols.get(r["kolom_id"]) != r["section_id"]:
            err.append(f"{rid}: kolom_id {r['kolom_id']} bukan milik {r['section_id']}")
        err += [f"{rid}: kode {k} tidak ada di master" for k in r["barang"]["kode_barang"] + ((r["benefit"]["bonus"] or {}).get("kode_barang") or [])
                if k not in kode]
    err += [f"flag: program_id {f['program_id']} tidak ada" for f in d["flags"] if f["program_id"] and f["program_id"] not in progs]
    err += [f"flag: rule_id {f['rule_id']} tidak ada" for f in d["flags"] if f["rule_id"] and f["rule_id"] not in ids]
    return err


def rapikan(d, kode):
    """Sesudah semua langkah: kode di luar master dikosongkan + ditandai, flag yatim dibuang, hitungan validasi dihitung kode."""
    for r in d["item_rules"]:
        for wadah in (r["barang"], r["benefit"]["bonus"] or {}):
            if salah := [k for k in wadah.get("kode_barang") or [] if k not in kode]:
                wadah["kode_barang"] = [k for k in wadah["kode_barang"] if k in kode]
                d["flags"].append(_flag("tidak_ada_di_master", "perlu_cek", r, f"kode {', '.join(salah[:5])} tidak ada di master; dibuang"))
    progs, ids = {p["program_id"] for p in d["programs"]}, {r["rule_id"] for r in d["item_rules"]}
    d["flags"] = [f for f in d["flags"] if (not f["program_id"] or f["program_id"] in progs) and (not f["rule_id"] or f["rule_id"] in ids)]
    d["validasi"].update(jumlah_item_rules=len(d["item_rules"]), jumlah_rule_tanpa_kode=sum(1 for r in d["item_rules"] if not r["barang"]["kode_barang"]))
    return d


def indeks_master(master):
    m = {}
    for x in master:
        m.setdefault(x["kode_barang"], []).append(x)
    return m


# ---------------------------------------------------------------- aturan umum (keputusan pemilik lintas principal)

def _segarkan(barang, buang, m):
    """Teks kelompok/gramasi yang hanya milik kode terbuang ikut dibuang (URC 'PIATTOS, P> PIATTOS' -> 'PIATTOS')."""
    for f in ("kelompok_barang", "gramasi"):
        nilai = lambda ks: {x[f].upper() for k in ks for x in m.get(k, [])}
        basi = nilai(buang) - nilai(barang["kode_barang"])
        tk = (barang[f] or "").split(", ")
        if barang["kode_barang"] and any(t.strip().upper() in basi for t in tk):
            barang[f] = ", ".join(t for t in tk if t.strip().upper() not in basi)


def umum(d, m):
    """L01/L02 kode B/P keluar, L14 luar cakupan (hanger tetap), kolom CR bukan potongan, 'N+M' = beli N gratis M, L08 kelipatan."""
    for r in d["item_rules"]:
        for wadah in (r["barang"], r["benefit"]["bonus"] or {}):
            ks = wadah.get("kode_barang") or []
            sisa = [k for k in ks if not (k.endswith(("B", "P")) or any(x["nama_barang"].upper().startswith(("B>", "P>")) for x in m.get(k, [])))]
            if len(sisa) != len(ks):
                wadah["kode_barang"] = sisa
                if wadah is r["barang"]:
                    _segarkan(wadah, set(ks) - set(sisa), m)
                    if not sisa:
                        d["flags"].append(_flag("tidak_ada_di_master", "perlu_cek", r, f"kode master hanya versi bonus/promo ({', '.join(ks[:5])}); "
                                                "cari kode jual di Accurate (mis. berakhiran N) sebelum rilis (L01)"))
    hanger = lambda r: r["benefit"]["komponen"] and all("HANGER" in k["nama"].upper() for k in r["benefit"]["komponen"])
    if buang := [r for r in d["item_rules"] if r["benefit"]["tipe"] in LUAR_CAKUPAN and not hanger(r)]:
        ids = {r["rule_id"] for r in buang}
        d["item_rules"] = [r for r in d["item_rules"] if r["rule_id"] not in ids]
        sisa = {r["kolom_id"] for r in d["item_rules"]}
        for pr in d["programs"]:
            for s in pr["sections"]:
                s["kolom"] = [k for k in s["kolom"] if k["kolom_id"] in sisa]
            pr["sections"] = [s for s in pr["sections"] if s["kolom"]]
        hilang = [pr["no_surat"] for pr in d["programs"] if not pr["sections"]]
        d["programs"] = [pr for pr in d["programs"] if pr["sections"]]
        isi = "; ".join(f"{t}: {', '.join(dict.fromkeys(r['benefit']['teks_tampilan'] for r in buang if r['benefit']['tipe'] == t))}"
                        for t in dict.fromkeys(r["benefit"]["tipe"] for r in buang))
        d["flags"] = [f for f in d["flags"] if f["rule_id"] not in ids]
        d["flags"].append({"jenis": "di_luar_cakupan", "tingkat": "info", "program_id": None, "rule_id": None,
                           "pesan": f"Di luar cakupan summary on faktur (L14), tidak dicetak & tidak disetting: {len(buang)} rule ({isi})"
                                    + (f"; program {', '.join(hilang)} seluruhnya keluar" if hilang else "") + "."})
    for r in d["item_rules"]:
        b, k = r["benefit"], r["ketentuan"]
        if b["tipe"] == "bonus_barang":  # kolom CR (cost ratio) = persen setara bonus, bukan potongan tambahan (Priskila "3+1 | 25%")
            b["komponen"] = [x for x in b["komponen"] if x["nama"].strip().upper() != "CR"]
        n = re.search(r"(?<![\d.,])(\d+)\s*\+\s*(\d+)(?![\d.,%])", r["sumber"]["kutipan"])  # "28+8" = beli 28 gratis 8
        if b["bonus"] and not k["min"] and n and float(n.group(2)) == b["bonus"]["qty"]:
            k["min"] = int(n.group(1))
        paket = b["tipe"] == "bonus_barang" or b["bonus"] or (b["tipe"] == "potongan_nominal" and b["nominal_per"] == "paket")
        if paket and k["kelipatan"] is None:  # L08: paket tanpa sebutan kelipatan -> berlaku kelipatan
            k["kelipatan"] = True
    return d


# ---------------------------------------------------------------- penjaga

def fakta(d):
    """Fakta per kode untuk dibandingkan antar pembaca/bulan: (kode, min, max, satuan, tipe, komponen(nilai, satuan, beban), bonus)."""
    hasil = []
    for r in d["item_rules"]:
        k, b = r["ketentuan"], r["benefit"]
        kom = tuple(sorted((round(float(x["nilai"]), 4), x["satuan"].upper(), x["beban"].replace("tidak_tercantum", "principal")) for x in b["komponen"]))
        bon = b["bonus"] and (b["bonus"]["qty"], SATUAN.get(b["bonus"]["satuan"].upper(), b["bonus"]["satuan"].upper()))
        mn, sat = k["min"], SATUAN.get(k["satuan"] or "", k["satuan"])
        if (mn or 0) <= 1 and k["max"] is None:  # "min 1 pcs" = tanpa minimum
            mn, sat = None, None
        inti = (mn, k["max"], sat, b["tipe"].replace("sewa_display", "potongan_nominal"), kom, bon)
        hasil += [(kode,) + inti for kode in r["barang"]["kode_barang"]]
    return hasil


def _flag(jenis, tingkat, r, pesan):
    return {"jenis": jenis, "tingkat": tingkat, "program_id": r and r["program_id"], "rule_id": r and r["rule_id"], "pesan": "Penjaga: " + pesan}


def _kata(t, n=3):
    return set(re.findall(rf"[A-Z]{{{n},}}", (t or "").upper()))


def ada_di_teks(x, teks):
    """Angka x tertulis di surat? 3000 -> 3000/3.000/3,000; 2.5 -> 2,5/2.5; 15 -> 15.0%. Batas digit: 30 tidak cocok di 300."""
    n = round(float(x), 4)
    bentuk = {f"{n:,.0f}".replace(",", "."), f"{n:,.0f}", f"{n:.0f}"} if n == int(n) else {f"{n:g}", f"{n:g}".replace(".", ",")}
    return any(re.search(rf"(?<![\d.,]){re.escape(b)}(?:[.,]0+)?(?![\d]|[.,]\d)", teks) for b in bentuk)


def jaga(d, teks, m, tanggal, lain=(), dikonfirmasi=frozenset()):
    """Flag baru untuk keraguan; isi tidak diubah. lain = hasil pembaca pemeriksa; dikonfirmasi = fakta Summary yang sudah disetujui pemilik.
    ponytail: tanpa penjaga 'nama barang tertulis di surat' - surat memakai kode internal (F601), kategori (Beverages), harga (HET 1000)
    yang tak ada di master -> 30% alarm palsu; tebakan barang (Forisa 'DESSERT 1') tertangkap pembaca pemeriksa."""
    out = []
    sah = {r["rule_id"] for r in d["item_rules"] if dikonfirmasi and set(fakta({"item_rules": [r]})) <= dikonfirmasi}
    rules = [r for r in d["item_rules"] if r["rule_id"] not in sah]
    # peringatan model sendiri pada baris yang sudah disetujui pemilik sudah dijawab bulan lalu (uji layar 30 Okt: URC R8)
    d["flags"] = [f for f in d["flags"] if not (f["rule_id"] in sah and f["tingkat"] in ("kritis", "perlu_cek"))]
    for r in rules:
        b, k = r["benefit"], r["ketentuan"]
        # G1 nilai benefit, minimum, qty bonus harus tertulis di surat (tabel rusak di OCR / angka karangan)
        angka = [x["nilai"] for x in b["komponen"]] + [k["min"]] + ([b["bonus"]["qty"]] if b["bonus"] else [])
        if bad := [x for x in angka if x is not None and not ada_di_teks(x, teks)]:
            out.append(_flag("tidak_terbaca", "perlu_cek", r, f"angka {bad} tidak tertulis di teks surat; cocokkan dengan gambar surat"))
        # G2 satuan BONUS harus sama dengan kutipan surat (URC "FREE 1 RENCENG" -> 1 PCS = nilai x12); satuan minimum sah dikonversi
        di_kutipan = {SATUAN[w] for w in _kata(r["sumber"]["kutipan"], 2) if w in SATUAN}
        s = ((b["bonus"] or {}).get("satuan") or "").upper()
        if s in SATUAN.values() and di_kutipan and s not in di_kutipan:
            out.append(_flag("tidak_konsisten", "kritis", r, f"satuan bonus {s} tidak ada di kutipan surat ({', '.join(sorted(di_kutipan))})"))
        # G3 bonus barang tanpa minimum = bonus di setiap pembelian; hampir pasti 'beli N' hilang
        if (b["bonus"] or b["tipe"] == "bonus_barang") and not k["min"]:
            out.append(_flag("anomali_angka", "kritis", r, "bonus barang tanpa minimum pembelian; isi 'beli N' dari surat"))
        # G4 kata kemasan di surat (SACHET/BOX/BTL/...) harus ada di nama master setiap kode terpilih (Fonterra BOX di program sachet)
        nama = r["barang"]["nama_di_surat"]
        for syn in KEMASAN:
            if syn & _kata(nama) and (salah := [kd for kd in r["barang"]["kode_barang"]
                                                if not syn & _kata(" ".join(x["nama_barang"] for x in m.get(kd, [])))]):
                out.append(_flag("tidak_konsisten", "perlu_cek", r, f"surat menyebut {'/'.join(sorted(syn & _kata(nama)))}, "
                                 f"{len(salah)} kode bukan kemasan itu: {', '.join(salah[:5])}"))
    # G8 nama barang yang sama di surat harus memakai kode yang sama di semua barisnya (Priskila Body Mist 100ml: 6 vs 12 kode)
    grup = {}
    for r in d["item_rules"]:
        grup.setdefault(" ".join(r["barang"]["nama_di_surat"].upper().split()), []).append(r)
    for nm, rs in grup.items():
        if len({frozenset(r["barang"]["kode_barang"]) for r in rs if r["barang"]["kode_barang"]}) > 1:
            out += [_flag("tidak_konsisten", "perlu_cek", r, f"'{nm[:40]}' dipetakan ke kode berbeda antar baris") for r in rs if r["rule_id"] not in sah]
    # G6 tenggat klaim dihitung kode, bukan model (model salah hitung hari)
    d["flags"] = [f for f in d["flags"] if f["jenis"] != "tenggat_dekat"]
    for pr in d["programs"]:
        t = pr["syarat_claim"]["batas_klaim_tanggal"]
        if t and (sisa := (date.fromisoformat(t) - date.fromisoformat(tanggal)).days) <= 30:
            out.append({"jenis": "tenggat_dekat", "tingkat": "kritis", "program_id": pr["program_id"], "rule_id": None,
                        "pesan": f"Penjaga: batas klaim {t} tinggal {sisa} hari"})
    # G7 pembaca pemeriksa: fakta yang tidak dibaca sama oleh pemeriksa mana pun -> tanya; kode yang dimasukkan SEMUA pemeriksa
    # tetapi tidak oleh pembaca utama -> tanya (kemungkinan terlewat)
    if lain:
        dukung = set().union(*(fakta(x) for x in lain))
        out += [_flag("tidak_konsisten", "perlu_cek", r, "tidak ada pembaca lain yang membaca sama (nilai/strata/barang)")
                for r in rules if any(f not in dukung for f in fakta({"item_rules": [r]}))]
        semua = set.intersection(*({f[0] for f in fakta(x)} for x in lain))
        if dikonfirmasi:  # kode yang juga tidak ada di Summary yang disetujui = sudah diputuskan keluar; yang dulu ada lalu hilang tetap ditanya
            semua &= {f[0] for f in dikonfirmasi}
        if hilang := sorted(semua - {kd for r in d["item_rules"] for kd in r["barang"]["kode_barang"]}):
            out.append({"jenis": "tidak_konsisten", "tingkat": "perlu_cek", "program_id": None, "rule_id": None,
                        "pesan": f"Penjaga: semua pembaca lain memasukkan {len(hilang)} kode yang tidak ada di hasil ini: {', '.join(hilang[:10])}"})
    return out


# ---------------------------------------------------------------- jalur utuh

async def ekstrak(principal, berkas_raw, master, tanggal, dikonfirmasi=frozenset(), client=None):
    """berkas_raw = [(nama, bytes PDF/JPG/PNG)], master = baris master principal (KOLOM). Hasil: summary_program dari pembaca utama
    dengan aturan umum + flag penjaga; dikonfirmasi = fakta() Summary bulan lalu yang sudah disetujui (baris sama -> tanpa cek)."""
    maks = summary_mistral.status()["max_pages"]
    berkas = []
    for nama, raw in berkas_raw:
        raw = summary_mistral.foto_ke_pdf(raw)
        if len(raw) > 20 * 1024 * 1024:
            raise ValueError(f"{nama}: maksimal 20 MB")
        try:
            with fitz.open(stream=raw, filetype="pdf") as doc:
                if doc.needs_pass:
                    raise ValueError(f"{nama}: PDF terkunci; unggah salinan tanpa kata sandi")
                if not 1 <= doc.page_count <= maks:
                    raise ValueError(f"{nama}: PDF harus berisi 1-{maks} halaman")
                gambar = [base64.b64encode(pg.get_pixmap(dpi=130).tobytes("png")).decode() for pg in doc]
        except ValueError:
            raise
        except Exception:
            raise ValueError(f"{nama}: PDF rusak atau tidak dapat dibaca") from None
        berkas.append({"nama": nama, "raw": raw, "gambar": gambar})
    if not berkas or not master:
        raise ValueError("Unggah surat program dan pilih master principal yang berisi barang")
    http = client or httpx.AsyncClient(timeout=httpx.Timeout(2400, connect=15), follow_redirects=False)
    try:
        for b in berkas:
            b["teks"], b["tabel"] = await asyncio.gather(ocr(http, b["raw"]), ocr(http, b["raw"], tabel=True))
        hasil = await asyncio.gather(*(baca(http, model, g, principal, master, tanggal, berkas) for model, g in PEMBACA))
    finally:
        if client is None:
            await http.aclose()
    m, kode = indeks_master(master), {x["kode_barang"] for x in master}
    hasil = [umum(rapikan(json.loads(json.dumps(d)), kode), m) for d in hasil]  # salinan: hasil cache tidak ikut berubah
    utama = hasil[0]
    teks = "\n".join(h for b in berkas for h in b["teks"] + b["tabel"])  # dua OCR: biasa + tabel 300 dpi
    baru = jaga(utama, teks, m, tanggal, hasil[1:], dikonfirmasi)  # jaga mengganti utama["flags"]; jangan `+=` langsung
    utama["flags"] += baru
    return rapikan(utama, kode)
