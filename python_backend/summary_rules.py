"""Tujuan: Kontrak promo terbit dan kalkulator deterministik untuk order.
Caller: Summary library, simulator, integrasi order berikutnya.
Dependensi: Pydantic, Decimal stdlib. Main Functions: Program, validate_programs, outlet_allows, calculate, compile_programs, suggestions.
Side Effects: Tidak ada I/O; uang dibulatkan dua desimal, tidak memakai float untuk aritmetika.
"""
import re
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def number(value):
    try:
        result = Decimal(str(value))
    except Exception:
        raise ValueError("Angka tidak valid") from None
    if not result.is_finite() or result < 0 or result > Decimal("1000000000000"):
        raise ValueError("Angka harus terbatas, positif, dan maksimal satu triliun")
    return result


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# Kelas keikutsertaan outlet menurut principal (Kino: "PESERTA LOYALTY", "EXCLUDE LOYALTY /
# HYBRID / CONTRACTUAL & MSG"). Sengaja daftar tertutup: satu salah ketik pada mode "except"
# berarti potongan jatuh ke outlet yang justru harus dikecualikan. Principal menambah kelas
# baru -> tambahkan di sini, jangan longgarkan validasinya.
OUTLET_CLASSES = ("LOYALTY", "HYBRID", "CONTRACTUAL", "MSG")


def outlet_allows(program, outlet_classes, known_classes):
    """Gerbang kelayakan outlet. Tidak tahu = tidak berlaku.

    `known_classes` adalah kelas yang daftar outletnya SUDAH dimuat. Kelas yang daftarnya
    belum ada membuat program ditahan, bukan berlaku untuk semua: potongan yang kurang bisa
    dibayar susulan, potongan yang terlanjur masuk faktur outlet yang salah tidak bisa ditarik.
    """
    if program.outlet_mode == "all":
        return True, ""
    missing = [c for c in program.outlet_classes if c not in set(known_classes)]
    if missing:
        return False, "daftar outlet " + ", ".join(missing) + " belum dimuat"
    listed = set(program.outlet_classes) & set(outlet_classes)
    if program.outlet_mode == "only":
        return bool(listed), "" if listed else "outlet bukan peserta " + ", ".join(program.outlet_classes)
    return not listed, "outlet termasuk " + ", ".join(sorted(listed)) if listed else ""


class Tier(StrictModel):
    minimum: str
    percentages: list[str] = Field(default_factory=list, max_length=10)
    rupiah: str = "0"
    rupiah_mode: Literal["once", "per_unit"] = "once"
    bonus_code: str = ""
    bonus_quantity: str = "0"
    bonus_unit: str = "PCS"
    bonus_scope: Literal["code", "purchased"] = "code"
    repeat: bool = False

    @model_validator(mode="after")
    def valid(self):
        if number(self.minimum) <= 0:
            raise ValueError("Minimum tier harus lebih dari nol")
        for value in self.percentages:
            if number(value) <= 0 or number(value) > 100:
                raise ValueError("Diskon persen harus > 0 dan <= 100")
        amount, bonus = number(self.rupiah), number(self.bonus_quantity)
        if not self.percentages and not amount and not bonus:
            raise ValueError("Tier belum memiliki benefit")
        if self.bonus_scope == "purchased":
            if not bonus or self.bonus_code:
                raise ValueError("Bonus barang yang dibeli butuh jumlah bonus dan tanpa kode tunggal")
        elif bool(self.bonus_code) != bool(bonus):
            raise ValueError("Kode dan jumlah bonus wajib diisi bersama")
        if bonus and (bonus != bonus.to_integral_value() or not self.bonus_unit.strip()):
            raise ValueError("Jumlah bonus harus bulat dan satuannya wajib diisi")
        if self.repeat and self.percentages:
            raise ValueError("Pengulangan paket tidak berlaku untuk persen; pisahkan program")
        if self.repeat and self.rupiah_mode == "per_unit":
            raise ValueError("Potongan per satuan tidak boleh diulang lagi per paket")
        return self


class Program(StrictModel):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=160)
    start: date
    end: date
    codes: list[str] = Field(min_length=1, max_length=2000)
    channel: str = Field(min_length=1, max_length=80, description="ALL means all channels, otherwise exact channel code")
    outlet_mode: Literal["all", "only", "except"] = "all"
    outlet_classes: list[str] = Field(default_factory=list, max_length=8)
    unit: str = Field(min_length=1, max_length=30)
    mix: bool = False
    threshold: Literal["quantity", "value"] = "quantity"
    value_scope: Literal["eligible", "order"] = "eligible"
    basis: Literal["gross", "net"] = "gross"
    stacking: bool = False
    priority: int = Field(ge=0, le=10000)
    tiers: list[Tier] = Field(min_length=1, max_length=30)
    source_page: int = Field(ge=1, le=1000)
    source_quote: str = Field(min_length=1, max_length=4000)

    @field_validator("codes")
    @classmethod
    def unique_codes(cls, value):
        if any(not v.strip() for v in value) or len(value) != len(set(value)):
            raise ValueError("Kode barang kosong atau duplikat")
        return value

    @model_validator(mode="after")
    def valid(self):
        if self.end < self.start:
            raise ValueError("Periode akhir mendahului awal")
        minima = [number(t.minimum) for t in self.tiers]
        if minima != sorted(set(minima)):
            raise ValueError("Tier harus unik dan diurutkan dari minimum terkecil")
        if self.threshold == "quantity" and self.value_scope == "order":
            raise ValueError("Batas kuantitas hanya menghitung barang yang memenuhi syarat")
        if self.outlet_mode == "all" and self.outlet_classes:
            raise ValueError("Kelas outlet hanya dipakai bila modenya 'only' atau 'except'")
        if self.outlet_mode != "all":
            if not self.outlet_classes or len(self.outlet_classes) != len(set(self.outlet_classes)):
                raise ValueError("Sebutkan kelas outlet, tanpa duplikat")
            unknown = [c for c in self.outlet_classes if c not in OUTLET_CLASSES]
            if unknown:
                raise ValueError("Kelas outlet tidak dikenal: " + ", ".join(unknown) + "; pilihan: " + ", ".join(OUTLET_CLASSES))
        return self


def validate_programs(raw, master_codes, page_count):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 100:
        raise ValueError("Isi 1–100 program sebelum diterbitkan")
    programs = [Program.model_validate(p) for p in raw]
    if len({p.id for p in programs}) != len(programs) or len({p.priority for p in programs}) != len(programs):
        raise ValueError("ID dan urutan program harus unik")
    for p in programs:
        if p.source_page > page_count:
            raise ValueError("Halaman sumber tidak tersedia")
        if not set(p.codes).issubset(master_codes) or any(t.bonus_code and t.bonus_code not in master_codes for t in p.tiers):
            raise ValueError("Kode barang atau bonus tidak terdapat pada master draft")
    return programs


def calculate(programs, raw_lines, order_date, channel, outlet_classes=(), known_classes=()):
    """Highest qualifying tier per program; explicit priority and all-party stacking.
    Quantities require exact units; no inferred conversion. Value = before tax.
    Each percentage compounds on remaining eligible value; rupiah follows percentages.
    """
    when = date.fromisoformat(order_date)
    if not isinstance(raw_lines, list) or not 1 <= len(raw_lines) <= 500:
        raise ValueError("Order harus memiliki 1–500 baris")
    lines = []
    seen = set()
    money = lambda value: value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    for line in raw_lines:
        code, unit = str(line["code"]), str(line["unit"])
        if (code, unit) in seen:
            raise ValueError("Gabungkan baris dengan kode dan satuan yang sama")
        seen.add((code, unit))
        qty, price = number(line["quantity"]), number(line["price"])
        if qty <= 0:
            raise ValueError("Jumlah barang harus lebih dari nol")
        gross = money(qty * price)
        lines.append(dict(code=code, unit=unit, quantity=qty, gross=gross, net=gross, applied=[],
                          percents=[], cash=Decimal(0)))
    applications, bonuses, blocked = [], [], []
    for program in sorted(programs, key=lambda p: (p.priority, p.id)):
        if not program.start <= when <= program.end or program.channel not in ("ALL", channel):
            continue
        # Batas nilai adalah soal uang, bukan satuan: program "minimal transaksi Rp X" harus
        # menghitung semua satuan barangnya, kalau tidak satu order BTL+PCS terpecah dua.
        eligible = [line for line in lines if line["code"] in program.codes
                    and (program.threshold == "value" or line["unit"] == program.unit)
                    and (not line["applied"] or (program.stacking and all(line["applied"]))) ]
        if not eligible:
            continue
        # Kelayakan outlet diperiksa setelah barangnya cocok supaya yang dilaporkan hanya
        # program yang benar-benar hampir berlaku, bukan seluruh isi pustaka aturan.
        allowed, reason = outlet_allows(program, outlet_classes, known_classes)
        if not allowed:
            blocked.append(dict(program_id=program.id, program_name=program.name, reason=reason))
            continue
        # Batas nilai selalu dihitung sekeranjang. "Minimal transaksi Rp 1 juta" adalah syarat
        # belanja, bukan syarat per baris; menghitungnya per baris membuat order Rp 9 juta
        # jatuh ke tier Rp 1 juta berkali-kali.
        groups = [eligible] if (program.mix or program.threshold == "value") else [[line] for line in eligible]
        for group in groups:
            if not group:
                continue
            metric = sum((line["quantity"] for line in group), Decimal(0)) if program.threshold == "quantity" else sum((line[program.basis] for line in (lines if program.value_scope == "order" else group)), Decimal(0))
            tier = next((tier for tier in reversed(program.tiers) if metric >= number(tier.minimum)), None)
            if tier is None:
                continue
            factor = int(metric // number(tier.minimum)) if tier.repeat else 1
            before = sum((line["net"] for line in group), Decimal(0))
            after = before
            for percentage in tier.percentages:
                after = money(after * (1 - number(percentage) / 100))
            units = sum((line["quantity"] for line in group), Decimal(0)) if tier.rupiah_mode == "per_unit" else Decimal(1)
            # Bagian persen dan bagian rupiah dicatat terpisah karena faktur Accurate harus
            # MENAMPILKAN keduanya: `itemDiscPercent` untuk rantai persennya, `itemCashDiscount`
            # untuk potongan rupiahnya. Totalnya tetap satu angka yang sama seperti sebelumnya.
            percent_total = before - after
            discount = min(before, money(percent_total + number(tier.rupiah) * factor * units))
            remaining, percent_left = discount, min(discount, percent_total)
            # Allocate cents deterministically; never exceed an individual line's net.
            for index, line in enumerate(group):
                share = remaining if index == len(group) - 1 else min(remaining, money(discount * line["net"] / before)) if before else Decimal(0)
                share = min(line["net"], share)
                percent_share = min(percent_left, share if index == len(group) - 1 else
                                    (money(percent_total * share / discount) if discount else Decimal(0)))
                percent_left -= percent_share
                line["cash"] += share - percent_share
                line["net"] -= share
                remaining -= share
                line["applied"].append(program.stacking)
                line["percents"].extend(tier.percentages)
            for line in group:
                extra = min(line["net"], remaining)
                line["net"] -= extra
                line["cash"] += extra
                remaining -= extra
            if tier.bonus_scope == "purchased":
                bonuses.append(dict(program_id=program.id, code="", unit=tier.bonus_unit, quantity=str(number(tier.bonus_quantity) * factor),
                                    eligible_codes=sorted({line["code"] for line in group})))
            elif tier.bonus_code:
                bonuses.append(dict(program_id=program.id, code=tier.bonus_code, unit=tier.bonus_unit, quantity=str(number(tier.bonus_quantity) * factor)))
            applications.append(dict(program_id=program.id, minimum=tier.minimum, discount=str(discount)))
    gross = sum((line["gross"] for line in lines), Decimal(0))
    net = sum((line["net"] for line in lines), Decimal(0))
    return dict(gross=str(gross), discount=str(gross-net), net=str(net), bonuses=bonuses, applications=applications, blocked=blocked,
                lines=[{k: str(v) if isinstance(v, Decimal) else v for k, v in line.items() if k != "applied"} for line in lines])


UNITS = {"PCS", "PC", "CTN", "DUS", "BOX", "PAK", "PACK", "RTG", "KRT", "LSN", "BAL", "SET", "KG", "GR", "LTR", "ML", "BTL", "SCH", "REN"}
DATE_TEXT = re.compile(r"\d{4}-\d{2}-\d{2}")
MIX_MARKS = ("mix", "campur")
STACK_MARKS = ("stack", "digabung", "digabungkan", "berlaku bersama")


def clean_number(raw):
    """Angka surat: ribuan boleh titik/koma, desimal maksimal dua digit. Ambigu -> kosong."""
    text = str(raw).strip().replace(" ", "").replace("%", "")
    if re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", text):
        return text.replace(".", "").replace(",", "")
    if re.fullmatch(r"\d+[.,]\d{1,2}", text):
        return text.replace(",", ".")
    return text if re.fullmatch(r"\d+", text) else ""


# Trigger kuantitas diperiksa lebih dulu: "Beli 1 ... potongan Rp 4.700" adalah trigger 1 PCS,
# bukan belanja Rp 4.700. Nilai rupiah hanya menjadi batas bila frasanya memang frasa pembelian.
QUANTITY_TRIGGER = re.compile(r"(?:beli|pembelian|kelipatan|setiap)\s*([\d.,]+)\s*([A-Za-z]*)", re.I)
VALUE_TRIGGER = re.compile(r"(?:pembelian|belanja|minimal|minimum|min\.?|nilai|senilai|omz?et)\s*(?:sebesar\s*)?rp\.?\s*([\d.,]+)", re.I)
PER_UNIT_MARKS = ("per satuan", "per unit", "per pcs", "/pcs", "per pc", "masing-masing")
NO_MINIMUM_MARKS = ("tidak ada minimum", "tanpa minimum", "tidak ada pembatasan", "tanpa pembatasan",
                    "tidak ada minimal", "tanpa minimal", "setiap pembelian", "tiap pembelian", "semua pembelian")


PACKAGE_CELL = re.compile(r"^\s*(\d{1,5})\s*\+\s*(\d{1,5})\s*([A-Za-z]*)\s*$")


def package_of(ketentuan):
    """Sel PAKET mentah "22+2" berarti beli 22 gratis 2, bukan beli 24."""
    found = PACKAGE_CELL.match(ketentuan)
    return (found.group(1), found.group(2), (found.group(3) or "").upper()) if found else None


def threshold_of(ketentuan):
    package = package_of(ketentuan)
    if package:
        return "quantity", package[0], package[2] if package[2] in UNITS else "PCS"
    # Trigger berangka diperiksa lebih dulu: "Setiap pembelian 30 PCS" adalah minimum 30,
    # bukan "tanpa minimum" hanya karena kalimatnya diawali "setiap pembelian".
    quantity = QUANTITY_TRIGGER.search(ketentuan)
    if quantity:
        unit = quantity.group(2).upper()
        return "quantity", clean_number(quantity.group(1)), unit if unit in UNITS else "PCS"
    lowered = ketentuan.lower()
    if any(mark in lowered for mark in NO_MINIMUM_MARKS):
        return "quantity", "1", "PCS"
    money = VALUE_TRIGGER.search(ketentuan)
    if money:
        return "value", clean_number(money.group(1)), "PCS"
    return "", "", ""


def per_unit(row, unit):
    """Potongan per satuan hanya bila suratnya menyebut per satuan secara eksplisit."""
    blob = " ".join(str(row.get(field, "")) for field in ("ketentuan", "benefit", "keterangan")).lower()
    return any(mark in blob for mark in PER_UNIT_MARKS) or f"per {unit.lower()}" in blob or f"/{unit.lower()}" in blob


def bonus_target(codes):
    """Satu kode = bonus SKU pasti. Beberapa kode = bonus dari barang yang dibeli; SKU dipilih saat order."""
    return dict(bonus_code=codes[0], bonus_scope="code") if len(codes) == 1 else dict(bonus_code="", bonus_scope="purchased")


def tier_of(row, codes, minimum, unit="PCS"):
    kind = str(row.get("benefit_type", "")).strip().upper()
    benefit = str(row.get("benefit", "")).strip()
    tier = dict(minimum=minimum, percentages=[], rupiah="0", rupiah_mode="once", bonus_code="", bonus_quantity="0", bonus_unit="PCS", bonus_scope="code", repeat=False)
    # Sel PAKET menentukan bonusnya sendiri; kolom CR/cost ratio pada baris itu diabaikan.
    package = package_of(str(row.get("ketentuan", "")))
    if package:
        tier.update(bonus_quantity=package[1], bonus_unit=unit, **bonus_target(codes))
        return tier, ""
    if kind == "CR" or "cost ratio" in str(row.get("benefit_type", "")).lower():
        return None, "CR / cost ratio bukan benefit; kosongkan atau pilih DISC_PCT, DISC_RP, BONUS_QTY"
    if kind == "DISC_PCT":
        parts = [clean_number(part) for part in re.split(r"[+&]", benefit) if part.strip()]
        if not parts or not all(parts):
            return None, "diskon persen tidak terbaca; tulis angka saja, mis. 5 atau 5+3"
        tier["percentages"] = parts
    elif kind == "DISC_RP":
        amount = clean_number(benefit)
        if not amount:
            return None, "potongan rupiah tidak terbaca; tulis angka polos tanpa teks"
        tier["rupiah"] = amount
        tier["rupiah_mode"] = "per_unit" if per_unit(row, unit) else "once"
    elif kind == "BONUS_QTY":
        found = re.match(r"([\d.,]+)\s*([A-Za-z]*)", benefit)
        quantity = clean_number(found.group(1)) if found else ""
        if not quantity:
            return None, "jumlah bonus tidak terbaca"
        found_unit = (found.group(2) or "").upper()
        tier.update(bonus_quantity=quantity, bonus_unit=found_unit if found_unit in UNITS else "PCS", **bonus_target(codes))
    else:
        return None, "benefit_type harus DISC_PCT, DISC_RP, atau BONUS_QTY"
    # "berlaku kelipatan" pada surat = tier berulang. Persen dan potongan per satuan sudah
    # naik sendiri mengikuti belanja, jadi mengulangnya lagi akan menghitung ganda.
    if "kelipatan" in str(row.get("ketentuan", "")).lower() and not tier["percentages"] and tier["rupiah_mode"] != "per_unit":
        tier["repeat"] = True
    return tier, ""


def outlet_rule_of(row):
    """Kolom kelayakan outlet pada baris draft: `outlet_mode` + `outlet_classes` (dipisah koma)."""
    mode = str(row.get("outlet_mode", "")).strip().lower() or "all"
    classes = tuple(sorted({c.strip().upper() for c in re.split(r"[,;]", str(row.get("outlet_classes", ""))) if c.strip()}))
    if mode not in ("all", "only", "except"):
        return (), "outlet_mode harus all, only, atau except"
    if (mode == "all") != (not classes):
        return (), "isi outlet_mode 'only'/'except' bersama kelas outletnya, atau kosongkan keduanya"
    unknown = [c for c in classes if c not in OUTLET_CLASSES]
    if unknown:
        return (), "kelas outlet tidak dikenal: " + ", ".join(unknown) + "; pilihan: " + ", ".join(OUTLET_CLASSES)
    return (mode, classes), ""


def merge_tier(target, extra):
    if extra["rupiah"] != "0" and target["rupiah"] != "0" and target["rupiah_mode"] != extra["rupiah_mode"]:
        return "potongan sekali dan potongan per satuan pada trigger yang sama; pisahkan program"
    if extra["rupiah"] != "0" and target["rupiah"] == "0":
        target["rupiah_mode"] = extra["rupiah_mode"]
    target["percentages"] = target["percentages"] + extra["percentages"]
    target["rupiah"] = str(number(target["rupiah"]) + number(extra["rupiah"]))
    if number(extra["bonus_quantity"]):
        if number(target["bonus_quantity"]) and (target["bonus_code"], target["bonus_scope"]) != (extra["bonus_code"], extra["bonus_scope"]):
            return "dua bonus berbeda pada trigger yang sama; pisahkan program"
        target.update(bonus_code=extra["bonus_code"], bonus_quantity=extra["bonus_quantity"],
                      bonus_unit=extra["bonus_unit"], bonus_scope=extra["bonus_scope"])
    return ""


def compile_programs(rows, period=None):
    """Baris draft -> kontrak program. Baris tak lengkap dilaporkan, tidak ditebak.
    Baris dengan barang/periode/channel/satuan sama menjadi satu program bertingkat.
    `period` adalah (start, end) tingkat draft yang diisi peninjau bila surat hanya
    mencetak periode di kepala; periode pada baris selalu menang.
    """
    fallback_start, fallback_end = (str(period[0]).strip(), str(period[1]).strip()) if period else ("", "")
    groups, issues = {}, []
    for index, row in enumerate(rows):
        label = f"Baris {str(row.get('no') or index + 1)}"
        ketentuan = str(row.get("ketentuan", ""))
        codes = [code.strip() for code in str(row.get("kode_barangs", "")).split(",") if code.strip()]
        start = str(row.get("periode_start", "")).strip() or fallback_start
        end = str(row.get("periode_end", "")).strip() or fallback_end
        kind, minimum, unit = threshold_of(ketentuan)
        if not codes:
            issues.append(f"{label}: kode barang belum dipilih.")
            continue
        if not (DATE_TEXT.fullmatch(start) and DATE_TEXT.fullmatch(end)):
            issues.append(f"{label}: periode harus lengkap dalam format YYYY-MM-DD, di baris atau pada periode draft.")
            continue
        if not minimum:
            issues.append(f"{label}: ketentuan belum menyebut 'Beli N' atau nilai rupiah minimum.")
            continue
        tier, problem = tier_of(row, codes, minimum, unit)
        if problem:
            issues.append(f"{label}: {problem}")
            continue
        outlet, problem = outlet_rule_of(row)
        if problem:
            issues.append(f"{label}: {problem}")
            continue
        blob = (ketentuan + " " + str(row.get("keterangan", ""))).lower()
        key = (str(row.get("channel_gtmt", "")).strip().upper() or "ALL", start, end, unit, kind,
               any(mark in ketentuan.lower() for mark in MIX_MARKS), any(mark in blob for mark in STACK_MARKS), tuple(sorted(codes)), outlet)
        group = groups.setdefault(key, {"rows": [], "tiers": {}})
        group["rows"].append(row)
        if minimum in group["tiers"]:
            conflict = merge_tier(group["tiers"][minimum], tier)
            if conflict:
                issues.append(f"{label}: {conflict}")
        else:
            group["tiers"][minimum] = tier
    programs, used = [], set()
    for index, (key, group) in enumerate(groups.items()):
        channel, start, end, unit, kind, mix, stacking, codes, outlet = key
        first = group["rows"][0]
        identifier = str(first.get("promo_group_id", "")).strip() or f"P{index + 1}"
        if identifier in used:
            identifier = f"{identifier}-{index + 1}"
        used.add(identifier)
        page = first.get("source_page")
        programs.append(dict(
            id=identifier[:80], name=(str(first.get("nama_program", "")).strip() or str(first.get("kelompok", "")).strip() or identifier)[:160],
            start=start, end=end, codes=list(codes), channel=channel, unit=unit, mix=mix, threshold=kind,
            outlet_mode=outlet[0], outlet_classes=list(outlet[1]),
            value_scope="eligible", basis="gross", stacking=stacking, priority=index + 1,
            tiers=[group["tiers"][minimum] for minimum in sorted(group["tiers"], key=number)],
            source_page=page if isinstance(page, int) and page >= 1 else 1,
            source_quote=(str(first.get("source_quote", "")).strip() or str(first.get("ketentuan", "")).strip() or "-")[:4000]))
    return programs, issues

def rupiah(value):
    """Rp dengan pemisah ribuan titik; dibulatkan ke rupiah utuh untuk pesan ke sales."""
    whole = value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return "Rp " + f"{int(whole):,}".replace(",", ".")


def benefit_text(tier):
    parts = []
    if tier.percentages:
        parts.append("diskon " + " + ".join(f"{p}%" for p in tier.percentages))
    if number(tier.rupiah):
        parts.append("potongan " + rupiah(number(tier.rupiah)) + ("/satuan" if tier.rupiah_mode == "per_unit" else ""))
    if number(tier.bonus_quantity):
        target = tier.bonus_code if tier.bonus_scope == "code" else "barang yang dibeli"
        parts.append(f"bonus {tier.bonus_quantity} {tier.bonus_unit} {target}")
    return " dan ".join(parts) or "benefit program"


def suggestions(programs, raw_lines, order_date, channel, limit=20, outlet_classes=(), known_classes=()):
    """Selisih menuju tier berikutnya, untuk ditampilkan ke sales sebelum order dikirim.

    Hanya program yang benar-benar berlaku pada tanggal dan channel order. Selisih
    dihitung dari metrik yang sama dengan kalkulator, jadi angka yang dijanjikan pada
    sales sama dengan yang nanti dihitung. Tidak menyarankan apa pun bila tier
    tertinggi sudah tercapai.
    """
    when = date.fromisoformat(order_date)
    money = lambda value: value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    lines = []
    for line in raw_lines:
        quantity, price = number(line["quantity"]), number(line["price"])
        lines.append(dict(code=str(line["code"]), unit=str(line["unit"]), quantity=quantity,
                          gross=money(quantity * price), price=price))
    found = []
    for program in sorted(programs, key=lambda item: (item.priority, item.id)):
        if not program.start <= when <= program.end or program.channel not in ("ALL", channel):
            continue
        # Jangan menjanjikan potongan yang tidak akan dihitung kalkulator untuk outlet ini.
        if not outlet_allows(program, outlet_classes, known_classes)[0]:
            continue
        eligible = [line for line in lines if line["code"] in program.codes
                    and (program.threshold == "value" or line["unit"] == program.unit)]
        for group in ([eligible] if (program.mix or program.threshold == "value") else [[line] for line in eligible]):
            if not group:
                continue
            counted = lines if (program.threshold == "value" and program.value_scope == "order") else group
            metric = (sum((line["quantity"] for line in group), Decimal(0)) if program.threshold == "quantity"
                      else sum((line["gross"] for line in counted), Decimal(0)))
            nearest = next((tier for tier in program.tiers if number(tier.minimum) > metric), None)
            if nearest is None:
                continue
            gap = number(nearest.minimum) - metric
            if program.threshold == "quantity":
                message = f"Tambah {gap.quantize(Decimal('1'))} {program.unit} lagi untuk {benefit_text(nearest)}"
            else:
                message = f"Tambah {rupiah(gap)} lagi untuk {benefit_text(nearest)}"
            found.append(dict(program_id=program.id, program_name=program.name, threshold=program.threshold,
                              codes=sorted({line["code"] for line in group}), minimum=nearest.minimum,
                              current=str(metric), gap=str(gap), message=message))
    # Yang paling mudah dicapai lebih dulu supaya tampilan tidak penuh saran mustahil.
    found.sort(key=lambda item: (Decimal(item["gap"]), item["program_id"]))
    return found[:limit]
