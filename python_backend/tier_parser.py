# ======================================================================================
# Tujuan: Parser tabel POSISIONAL murni (tanpa LLM sama sekali) atas teks OCR yang SUDAH
#         BEKU (dari ocr_cache.py). Membaca TRIGGER_QTY/benefit langsung dari STRUKTUR
#         tabel (kolom BRAND/GROUP ITEM/PAKET atau CUT PRICE/HET/CR) berdasarkan POSISI
#         baris, bukan tebakan semantik LLM -- sumber non-determinisme #2 (tier bergeser
#         antar run) dihilangkan di sini.
# Caller: python_backend/main.py (rencana integrasi FASE 2b, override field
#         ketentuan/benefit_type/benefit hasil LLM dengan hasil parser ini).
# Dependensi: re, dataclasses (stdlib saja).
# Main Functions:
#   - parse_positional_tables(ocr_text) -> List[TableRow]
#       Deteksi semua tabel channel (header "N. Program ... CHANNEL ...") dalam satu teks
#       OCR gabungan, parse tiap tabel jadi baris terstruktur.
#   - parse_one_table(table_text, channel_name) -> List[TableRow]
#       Parse SATU tabel markdown (dipanggil oleh parse_positional_tables per channel).
# Side Effects: Tidak ada (pure function, tidak baca/tulis file).
# ======================================================================================

import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple


@dataclass
class TableRow:
    channel: str
    brand: str
    group_item: str
    paket_raw: str          # "7+1" atau "4,700" (mentah, sebelum diinterpretasi)
    cr_raw: str
    trigger_qty: int
    trigger_unit: str
    benefit_type: str       # BONUS_QTY | DISC_RP
    benefit_value: str
    row_index: int          # posisi baris dlm tabel (0-based) -- utk audit/debug, BUKAN key


_CHANNEL_HDR_RE = re.compile(r'^\s*\d+\.\s*.{0,80}?channel', re.IGNORECASE | re.MULTILINE)
_PIPE_ROW_RE = re.compile(r'^\s*\|(.+)\|\s*$')
_SEPARATOR_RE = re.compile(r'^[\s|:\-]+$')  # baris "|---|---|" atau "| :--- | :--- |"
_PAKET_RE = re.compile(r'^\s*(\d+)\s*\+\s*(\d+)\s*$')
_NUMBER_RE = re.compile(r'[\d.,]+')


def _split_row(line: str) -> Optional[List[str]]:
    m = _PIPE_ROW_RE.match(line)
    if not m:
        return None
    if _SEPARATOR_RE.match(m.group(1)):
        return None  # baris pemisah markdown, bukan data
    return [c.strip() for c in m.group(1).split("|")]


def _clean_number(raw: str) -> str:
    """'4,700' -> '4700'. Tidak mengubah nilai, cuma buang pemisah ribuan."""
    m = _NUMBER_RE.search(raw or "")
    if not m:
        return ""
    return m.group(0).replace(",", "").replace(".", "")


def _propagate_brand(raw_brands: List[str]) -> List[str]:
    """Merged-cell brand di tabel markdown OCR (blank di baris lanjutan) di-forward-fill
    dari kemunculan non-blank TERAKHIR (verified pada data nyata: brand muncul di baris
    PERTAMA blok-nya, baris berikutnya blank sampai brand baru). Blank yg terjadi SEBELUM
    brand pertama kali muncul di seluruh tabel (jarang, edge case) di-back-fill dgn brand
    pertama itu -- bukan brand BERIKUTNYA (bug lama: back-fill salah arah)."""
    n = len(raw_brands)
    forward = [""] * n
    last = ""
    for i, b in enumerate(raw_brands):
        if b:
            last = b
        forward[i] = last
    first_brand = next((b for b in raw_brands if b), "")
    return [f or first_brand for f in forward]


def parse_one_table(table_text: str, channel_name: str) -> List[TableRow]:
    lines = table_text.split("\n")
    rows_raw = []
    header_cols = None
    for line in lines:
        cols = _split_row(line)
        if cols is None:
            continue
        upper = [c.upper() for c in cols]
        if header_cols is None and any("GROUP ITEM" in c for c in upper):
            header_cols = upper
            continue
        if header_cols is None:
            continue
        rows_raw.append(cols)

    if header_cols is None or not rows_raw:
        return []

    def _col_idx(*names):
        for i, h in enumerate(header_cols):
            if any(n in h for n in names):
                return i
        return None

    i_brand = _col_idx("BRAND")
    i_item = _col_idx("GROUP ITEM")
    i_paket = _col_idx("PAKET")
    i_cutprice = _col_idx("CUT PRICE")
    i_cr = _col_idx("CR")

    def _get(cols, idx):
        return cols[idx].strip() if idx is not None and idx < len(cols) else ""

    raw_brands = [_get(r, i_brand) for r in rows_raw]
    brands = _propagate_brand(raw_brands)

    out: List[TableRow] = []
    for idx, cols in enumerate(rows_raw):
        group_item = _get(cols, i_item)
        if not group_item:
            continue
        cr_raw = _get(cols, i_cr)

        if i_paket is not None and _get(cols, i_paket):
            paket_raw = _get(cols, i_paket)
            m = _PAKET_RE.match(paket_raw)
            if m:
                trigger_qty = int(m.group(1))
                benefit_type = "BONUS_QTY"
                benefit_value = f"{m.group(2)} PCS"
            else:
                trigger_qty = 0
                benefit_type = "UNKNOWN"
                benefit_value = paket_raw
        elif i_cutprice is not None and _get(cols, i_cutprice):
            paket_raw = _get(cols, i_cutprice)
            trigger_qty = 1
            benefit_type = "DISC_RP"
            benefit_value = _clean_number(paket_raw)
        else:
            paket_raw = ""
            trigger_qty = 0
            benefit_type = "UNKNOWN"
            benefit_value = ""

        out.append(TableRow(
            channel=channel_name,
            brand=brands[idx],
            group_item=group_item,
            paket_raw=paket_raw,
            cr_raw=cr_raw,
            trigger_qty=trigger_qty,
            trigger_unit="PCS",
            benefit_type=benefit_type,
            benefit_value=benefit_value,
            row_index=idx,
        ))
    return out


def parse_positional_tables(ocr_text: str) -> List[TableRow]:
    headers = list(_CHANNEL_HDR_RE.finditer(ocr_text))
    if not headers:
        return []
    all_rows: List[TableRow] = []
    for i, h in enumerate(headers):
        start = h.start()
        end = headers[i + 1].start() if i + 1 < len(headers) else len(ocr_text)
        chunk = ocr_text[start:end]
        # ponytail: header match ('^\s*\d+\.') bisa ikut menelan newline KOSONG sebelumnya
        # (MULTILINE + \s* rakus) -> baris pertama chunk bisa jadi string kosong. Ambil baris
        # non-kosong PERTAMA, bukan asumsi baris pertama chunk.
        channel_line = next((ln for ln in chunk.split("\n") if ln.strip()), "")
        channel_name = re.sub(r'^\s*\d+\.\s*.*?channel\s*:?\s*', '', channel_line, flags=re.IGNORECASE).strip() or channel_line.strip()
        all_rows.extend(parse_one_table(chunk, channel_name))
    return all_rows


# ======================================================================================
# FASE 2b: jembatan deterministik dari tabel OCR (tier_parser) ke rows hasil LLM +
# _apply_native_kelompok (sudah py kode_barang per baris). Override ketentuan/benefit_type/
# benefit dengan nilai tier_parser HANYA kalau item ter-cocok TINGGI KEYAKINAN (overlap
# token signifikan + gramasi identik) -- kalau ragu, kode_barang itu TIDAK disentuh (no
# silent guess, akurasi finansial wajib). Baris yg kode-nya py tier sama tapi ke-split
# LLM ke >1 baris (bug nyata: Bellagio EDT & EDP Prestige) di-REGROUP jadi 1 baris.
# ======================================================================================

_SYNONYMS = {
    "EDT": "EAU DE TOILETTE", "EDP": "EAU DE PARFUM", "PMD": "POMADE",
    "WTR": "WATER", "BAS": "BASED", "COL": "COLOGNE", "COLG": "COLOGNE", "SR": "SERIES",
    # Brand-alias: surat pakai ejaan panjang, master pakai singkatan -> normalisasi ke
    # token kanonik master supaya overlap tak jeblok (dulu 'CASABLANCA' != 'CSBNCA' bikin
    # match gagal -> tier tak terkoreksi, terbukti 2026-07-15). Ejaan surat -> master:
    "BELLAGIO": "BLAGIO", "CASABLANCA": "CSBNCA", "REGGAZZA": "REGAZZA", "REGZZA": "REGAZZA",
    "EXCELLO": "EXCELO", "PARFUME": "PARFUM",
}
_STOPWORDS = {"DAN", "THE", "OF", "DE"}


def _sig_tokens(text: str) -> set:
    words = re.findall(r"[A-Z0-9]+", str(text or "").upper())
    out = set()
    for w in words:
        for sub in _SYNONYMS.get(w, w).split():
            if sub not in _STOPWORDS and len(sub) > 1:
                out.add(sub)
    return out


def _gramasi_token(text: str) -> str:
    m = re.search(r'(\d+)\s*(ML|GR|GRAM|KG|L)\b', str(text or "").upper())
    return f"{m.group(1)}{m.group(2)}" if m else ""


def match_item_to_tablerow(item: dict, table_rows: List[TableRow]) -> Optional[TableRow]:
    """Cocokkan 1 item master ke 1 TableRow. Aturan:
    - GRAMASI = filter KERAS: kalau dua-duanya punya gramasi & beda -> pasti bukan barang
      sama (mis. Body Spray 65ml vs 100ml, walau teks lain identik). Ini yg memisahkan tier
      antar-gramasi (bug #1: 65ml=Beli7 vs 100/200ml=Beli14).
    - SKOR = COVERAGE token identitas TABLEROW (teks surat, ringkas) oleh token item master.
      Directional -> TIDAK dihukum token noise nama master (BLANC/144/BTL/X) yg tak ada di
      surat (dulu Jaccard simetris bikin overlap ~0.33 <0.5 -> semua gagal match). Brand-alias
      (CASABLANCA->CSBNCA dll) via _SYNONYMS.
    - Tiebreak: overlap ABSOLUT lebih besar menang (tablerow lebih spesifik, mis. '... Prestige'
      unggul atas '... Parfume' utk item Prestige), lalu coverage.
    - Ambiguitas tier: kalau >1 tablerow skor puncak IDENTIK (overlap & coverage sama) tapi
      trigger/benefit BEDA -> None (no silent guess; akurasi finansial wajib). Caller WAJIB
      skip override saat None."""
    item_tokens = _sig_tokens(f"{item.get('principle','')} {item.get('nama_barang','')}")
    item_gram = _gramasi_token(item.get("gramasi", "")) or _gramasi_token(item.get("nama_barang", ""))
    if not item_tokens:
        return None
    scored = []
    for tr in table_rows:
        tr_tokens = _sig_tokens(tr.group_item)
        if not tr_tokens:
            continue
        tr_gram = _gramasi_token(tr.group_item)
        if item_gram and tr_gram and item_gram != tr_gram:
            continue  # gramasi beda -> bukan barang yg sama
        overlap = len(item_tokens & tr_tokens)
        coverage = overlap / len(tr_tokens)
        scored.append((overlap, coverage, tr))
    if not scored:
        return None
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    best_overlap, best_cov, best = scored[0]
    if best_cov < 0.6:
        return None  # tak cukup yakin -> jangan tebak
    # guard ambiguitas: kandidat lain skor puncak PERSIS sama tapi tier beda -> ragu -> None
    top = [tr for ov, cov, tr in scored if ov == best_overlap and cov == best_cov]
    tiers = {(tr.trigger_qty, tr.benefit_type, tr.benefit_value) for tr in top}
    if len(tiers) > 1:
        return None
    return best


def _item_in_surat(item: dict, table_rows: List[TableRow]) -> bool:
    """True kalau item punya tablerow (di channel ini) dgn coverage >=0.6 -- artinya barang
    ini MEMANG disebut surat. Beda dari match_item_to_tablerow: fungsi ini TIDAK peduli
    ambiguitas tier (item in-surat tapi tier ambigu tetap True -> jangan di-drop, cukup tier
    tak dikoreksi). Dipakai regroup utk membuang kode halusinasi/tak-disebut-surat (#3)."""
    item_tokens = _sig_tokens(f"{item.get('principle','')} {item.get('nama_barang','')}")
    if not item_tokens:
        return True  # tak bisa dinilai -> jangan buang (konservatif)
    item_gram = _gramasi_token(item.get("gramasi", "")) or _gramasi_token(item.get("nama_barang", ""))
    for tr in table_rows:
        tr_tokens = _sig_tokens(tr.group_item)
        if not tr_tokens:
            continue
        tr_gram = _gramasi_token(tr.group_item)
        if item_gram and tr_gram and item_gram != tr_gram:
            continue
        if len(item_tokens & tr_tokens) / len(tr_tokens) >= 0.6:
            return True
    return False


def regroup_rows_by_tier(rows: List[dict], items: List[dict], ocr_text: str) -> Tuple[List[dict], List[dict]]:
    """Regroup baris hasil LLM berdasarkan tier OTORITATIF dari tabel OCR (bukan LLM).
    Kode_barang yg tak ter-bridge dgn keyakinan tinggi TETAP di baris asalnya apa adanya
    (aman -- fungsi ini hanya MEMPERBAIKI yg terbukti, tidak pernah menebak yg baru)."""
    table_rows = parse_positional_tables(ocr_text)
    if not table_rows:
        return rows, []  # format tabel OCR tak dikenali parser posisional -> jalur lama penuh dipakai

    by_kode = {str(it.get("kode_barang", "")).strip(): it for it in items if it.get("kode_barang")}

    def _norm_channel(c):
        return re.sub(r'[^A-Z]', '', str(c or "").upper())

    tr_by_channel: Dict[str, List[TableRow]] = defaultdict(list)
    for tr in table_rows:
        tr_by_channel[_norm_channel(tr.channel)].append(tr)

    # NON-DESTRUKTIF: proses baris-per-baris, PERTAHANKAN urutan & pengelompokan per-brand
    # (hasil _apply_native_kelompok). TIDAK menggabung antar-baris/antar-brand & TIDAK
    # mengurut ulang -- versi lama melakukannya & merusak struktur surat (Camellia+Marie Jose
    # kegabung, urutan channel teracak). Fungsi ini HANYA: (a) koreksi ketentuan/benefit tiap
    # baris dari tier OTORITATIF tabel posisional; (b) kalau 1 baris berisi kode ber-tier BEDA
    # (mis. Casablanca Body Spray 65ml=Beli7 vs 100/200ml=Beli14), PECAH jadi sub-baris di
    # posisi yg sama (kelompok tetap). Kode tak ter-bridge -> ketentuan asli dipertahankan.
    import uuid as _uuid

    def _tiers_for_row(r):
        chan = _norm_channel(r.get("channel_gtmt", ""))
        cand_trs = next((v for k, v in tr_by_channel.items() if chan and (chan in k or k in chan)), None)
        tmap = {}
        for kb in [k.strip() for k in str(r.get("kode_barangs", "")).split(",") if k.strip()]:
            it = by_kode.get(kb)
            tr = match_item_to_tablerow(it, cand_trs) if (it and cand_trs) else None
            tmap[kb] = (tr.trigger_qty, tr.benefit_type, tr.benefit_value) if tr is not None else None
        return tmap, chan, cand_trs

    def _apply_tier(r2, kodes, tier, chan, log):
        r2["kode_barangs"] = ", ".join(kodes)
        if tier is not None:
            tq, bt, bv = tier
            mix = " Boleh Mix Kelompok dan Gramasi Barang Sama" if len(kodes) > 1 else ""
            r2["ketentuan"] = f"Beli {tq}{mix}"
            r2["benefit_type"] = bt
            r2["benefit"] = bv
            log.append({"channel": chan, "trigger_qty": tq, "benefit_type": bt, "benefit_value": bv, "kode_barangs": r2["kode_barangs"]})
        return r2

    log: List[dict] = []
    new_rows: List[dict] = []
    for r in rows:
        kbs = [k.strip() for k in str(r.get("kode_barangs", "")).split(",") if k.strip()]
        tmap, chan, cand_trs = _tiers_for_row(r)
        # #3 over-inclusion: kalau channel PUNYA tabel posisional (cand_trs), buang kode yg
        # TAK disebut surat channel ini (mis. "SPRAY COL GLASS", "EDP DE LUXE" yg dihalusinasi
        # LLM / ditarik ekspansi tapi bukan bagian program). Channel tanpa tabel -> jangan
        # buang (tak ada ground-truth posisional). Kode in-surat tapi tier ambigu TETAP disimpan.
        if cand_trs:
            _drop = [kb for kb in kbs if by_kode.get(kb) and not _item_in_surat(by_kode[kb], cand_trs)]
            if _drop:
                kbs = [kb for kb in kbs if kb not in _drop]
                for kb in _drop:
                    tmap.pop(kb, None)
                log.append({"channel": chan, "dropped_not_in_surat": _drop})
        by_tier: Dict[object, List[str]] = defaultdict(list)
        for kb in kbs:
            by_tier[tmap.get(kb)].append(kb)
        if len(by_tier) <= 1:  # semua kode se-tier (atau tak ada kbs) -> koreksi di tempat
            tier = next(iter(by_tier)) if by_tier else None
            new_rows.append(_apply_tier(dict(r), kbs, tier, chan, log))
            continue
        # baris berisi tier campur -> pecah, urutan sub-baris = urutan kemunculan tier
        first = True
        for tier, gkodes in by_tier.items():
            r2 = dict(r)
            if not first:
                r2["id"] = str(_uuid.uuid4())
            first = False
            new_rows.append(_apply_tier(r2, gkodes, tier, chan, log))
    return new_rows, log


if __name__ == "__main__":
    sample = """
1. Program Bulan MARET 2026, CHANNEL : RETAIL

| BRAND     | GROUP ITEM                       | PAKET | CR   |
|-----------|----------------------------------|-------|------|
|           | Bellagio Eau De Toilette 100ml   | 7+1   | 13%  |
|           | Bellagio Eau De Parfume Prestige 50ml | 7+1   | 13%  |
|           | Bellagio Roll On 50ml            | 4+1   | 20%  |
| BELLAGIO  | Bellagio Eau De Parfume 50ml     | 4+1   | 20%  |
|           | Bellagio Pomade 80gr             | 4+1   | 20%  |
|           | Bellagio Clay 90gr               | 4+1   | 20%  |
|           | Bellagio Body Spray 80ml         | 4+1   | 20%  |

2. Program Bulan MARET 2026, CHANNEL MODERN TRADE INDEPENDENT LOKAL (MTI)

| BRAND     | GROUP ITEM                     | CUT PRICE | HET    | CR  |
|-----------|--------------------------------|-----------|--------|-----|
| BELLAGIO  | Bellagio Eau de Toilette 100ml | 4,700     | 31,628 | 13% |
|           | Bellagio Pomade Kidz 40gr      | 1,400     | 12,600 | 10% |
"""
    for _run in range(10):
        rows = parse_positional_tables(sample)
        by_item = {r.group_item: r.trigger_qty for r in rows if r.channel.upper().startswith("RETAIL")}
        assert by_item["Bellagio Eau De Toilette 100ml"] == 7, by_item
        assert by_item["Bellagio Eau De Parfume Prestige 50ml"] == 7, by_item
        assert by_item["Bellagio Roll On 50ml"] == 4, by_item
        assert by_item["Bellagio Eau De Parfume 50ml"] == 4, by_item
        assert by_item["Bellagio Pomade 80gr"] == 4, by_item
        assert by_item["Bellagio Clay 90gr"] == 4, by_item
        assert by_item["Bellagio Body Spray 80ml"] == 4, by_item
        assert all(r.brand == "BELLAGIO" for r in rows if r.channel.upper().startswith("RETAIL")), rows
        mti_rows = {r.group_item: (r.trigger_qty, r.benefit_value) for r in rows if "MODERN TRADE" in r.channel.upper()}
        assert mti_rows["Bellagio Eau de Toilette 100ml"] == (1, "4700")
        assert mti_rows["Bellagio Pomade Kidz 40gr"] == (1, "1400")
    print("tier_parser self-check PASSED (10x run, TRIGGER_QTY 100% identik)")

    # FASE 2b self-check: reproduksi bug nyata -- LLM split Bellagio EDT & EDP Prestige
    # jadi 2 baris (EDP Prestige py ketentuan SALAH "Beli 4") padahal tabel OCR sama2 7+1.
    master_items = [
        {"kode_barang": "P1", "principle": "Bellagio Eau De Toilette 100ml", "nama_barang": "BLAGIO HM EDT 100ML", "gramasi": "100ML"},
        {"kode_barang": "P2", "principle": "Bellagio Eau De Parfume Prestige 50ml", "nama_barang": "BLAGIO HM EDP PRESTIGE 50ML", "gramasi": "50ML"},
        {"kode_barang": "P3", "principle": "Bellagio Roll On 50ml", "nama_barang": "BLAGIO HM ROLL ON 50ML", "gramasi": "50ML"},
    ]
    llm_rows = [
        {"id": "r1", "channel_gtmt": "RETAIL", "kode_barangs": "P1", "ketentuan": "Beli 7", "benefit_type": "BONUS_QTY", "benefit": "1 PCS"},
        {"id": "r2", "channel_gtmt": "RETAIL", "kode_barangs": "P2", "ketentuan": "Beli 4", "benefit_type": "BONUS_QTY", "benefit": "1 PCS"},
        {"id": "r3", "channel_gtmt": "RETAIL", "kode_barangs": "P3", "ketentuan": "Beli 4", "benefit_type": "BONUS_QTY", "benefit": "1 PCS"},
    ]
    for _run in range(10):
        regrouped, log = regroup_rows_by_tier(llm_rows, master_items, sample)
        # NON-DESTRUKTIF: tiap baris LLM tetap baris sendiri (TIDAK di-merge antar-baris) ->
        # 3 baris masuk, 3 baris keluar, urutan terjaga. Yg dikoreksi: ketentuan tier.
        assert len(regrouped) == 3, regrouped
        assert [r["id"] for r in regrouped] == ["r1", "r2", "r3"], "urutan & identitas baris harus utuh"
        by_kode = {r["kode_barangs"]: r for r in regrouped}
        assert by_kode["P1"]["ketentuan"] == "Beli 7", by_kode["P1"]           # EDT 7+1, sudah benar
        assert by_kode["P2"]["ketentuan"] == "Beli 7", by_kode["P2"]           # EDP Prestige: SALAH "Beli 4" -> DIKOREKSI ke 7
        assert by_kode["P3"]["ketentuan"] == "Beli 4", by_kode["P3"]           # Roll On 4+1, tetap
    print("regroup_rows_by_tier self-check PASSED (10x run, non-destruktif: baris tak di-merge, tier salah dikoreksi di tempat)")

    # self-check PECAH: 1 baris berisi kode ber-tier BEDA harus dipecah (bukan di-lump ke 1 tier)
    split_rows = [{"id": "s1", "channel_gtmt": "RETAIL", "kode_barangs": "P1,P3", "ketentuan": "Beli 4", "benefit_type": "BONUS_QTY", "benefit": "1 PCS"}]
    out, _ = regroup_rows_by_tier(split_rows, master_items, sample)
    assert len(out) == 2, out                                                  # P1(Beli7) & P3(Beli4) dipecah
    kmap = {r["kode_barangs"]: r["ketentuan"] for r in out}
    assert kmap["P1"] == "Beli 7" and kmap["P3"] == "Beli 4", kmap
    print("regroup_rows_by_tier self-check PASSED (baris tier-campur dipecah tepat per tier)")
