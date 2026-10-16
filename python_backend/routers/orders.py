"""Tujuan: Order masuk dengan aturan promo terbit yang dibekukan pada saat pengiriman.
Caller: halaman order internal; routers/websales (simpan Order Sales memakai `hitung_order` + `cocokkan` yang sama).
Dependensi: shared auth/RBAC, summary_store, summary_rules (Program, calculate), websales_store, order_cabang, outlet_channel, outlet_class.
Main Functions: published_rules, hitung_promo, hitung_order, cocokkan, preview_order, create_order, pull_once, list_orders, order_detail.
Side Effects: SQLite read/write; HTTP baca ke Next (outlet_channel, order_cabang); tidak menulis faktur Accurate dan tidak memanggil AI.

PRATINJAU = TERSIMPAN (owner 12 Okt 2026, O1 putaran 1; kontrak docs/handover/O1-KONTRAK-ORDER-CABANG.md §4). SATU hitungan promo
(`hitung_promo`) untuk pratinjau, simpan Order Baru, simpan Order Sales, dan tarik; masukannya sama (pelanggan -> cabang/harga/kelas
outlet, channel master, tanggal order, baris berharga dari Next `periksaOrder`). Pratinjau mengembalikan `sidik` angka yang dilihat
pemakai; simpan menghitung ulang dan MENOLAK bila sidiknya beda (`PRATINJAU_BERUBAH`) — tidak pernah menyimpan angka lain diam-diam.
"""
import hashlib
import hmac
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from order_duplicate import duplicate_message, find_duplicate
from pydantic import ValidationError
from shared import get_current_user, user_has_permission, validate_csrf_request
from summary_store import JsonStore, connect, identity
from summary_rules import Program, RasioKosong, calculate, suggestions
import order_cabang
import outlet_class
import outlet_channel
import websales_store

router = APIRouter(prefix="/orders")

Ditolak = order_cabang.OrderCabangDitolak
TidakPasti = order_cabang.OrderCabangTidakPasti


def require_user(request, create=False):
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Silakan login")
    if not user_has_permission(user, "order", "create" if create else "view"):
        raise HTTPException(403, "Akses order tidak diizinkan")
    if create and not validate_csrf_request(request, request.headers.get("X-CSRF-Token", "")):
        raise HTTPException(403, "Permintaan lintas situs ditolak")
    return user


def published_rules():
    """Aturan dari semua draft berstatus published.

    Urutan penerapan adalah urutan publikasi (surat yang lebih dulu terbit menang bila
    keduanya tidak boleh digabung), lalu urutan program di dalam suratnya. Prioritas
    ditulis ulang berurutan di sini supaya hasil tidak bergantung pada ID acak, dan
    urutan itu ikut dibekukan pada order. ID diberi awalan draft agar unik dan terlacak.
    """
    with connect() as db:
        rows = db.execute("SELECT id,revision,content FROM summary_draft WHERE status='published' ORDER BY updated_at,id").fetchall()
    programs, sources = [], []
    for row in rows:
        stored = json.loads(row["content"]).get("programs") or []
        if not stored:
            continue
        sources.append({"draft_id": row["id"], "revision": row["revision"]})
        for program in sorted(stored, key=lambda item: (item["priority"], item["id"])):
            try:
                programs.append(Program.model_validate({**program, "priority": len(programs) + 1,
                                                        "id": f"{row['id'][:8]}:{program['id']}"[:80]}))
            except (ValidationError, KeyError, TypeError) as error:
                # Keadaan SERVER (aturan terbit rusak), bukan kesalahan order: galat berkode GLOBAL — tarikan berhenti dan permintaan
                # tetap pending, bukan ditolak permanen satu per satu sebagai DATA_TIDAK_VALID (putaran 2, butir 6).
                raise Ditolak(409, "ATURAN_TERBIT_RUSAK", f"Aturan terbit {row['id'][:8]} program {program.get('id', '?')} tidak lolos "
                              f"validasi: {public_error(error)[:300]}. Tarik/perbaiki publikasinya di Summary.") from None
    return programs, sources


def duplicate_check(owner, outlet, channel, order_date, lines):
    """Order lain milik outlet dan tanggal yang sama yang isinya MIRIP, atau None.

    Dijalankan sebelum order disimpan, dan menahan DUA jalur sekaligus karena keduanya lewat
    `store_order`: Order Sales (diketik) dan Order Masuk (tarikan Web Sales).

    Yang dibandingkan kode barangnya saja, bukan jumlah maupun harganya: ketikan ulang hampir
    selalu mengubah jumlah, dan justru itu yang membuatnya lolos kalau yang dibandingkan angka.
    """
    codes = [str(line.get("code", "")).strip() for line in lines]
    candidate = {"key": "", "outlet": outlet, "order_date": order_date, "item_codes": codes}
    # Jendela bandingnya dipersempit di SINI, bukan di dalam pemeta: channel yang berbeda
    # adalah jalur order yang berbeda, dan ketikan ulang hampir selalu mengulang channel yang
    # sama. Menyertakannya berarti menahan order MT hanya karena outletnya juga order GT hari itu.
    with connect() as db:
        rows = db.execute(
            "SELECT id,outlet,order_date,lines FROM sales_order WHERE owner=? AND outlet=? AND channel=? "
            "AND order_date=? AND status<>'cancelled' ORDER BY rowid DESC LIMIT 200",
            (owner, outlet[:160], channel[:80], order_date)).fetchall()
    existing = []
    for row in rows:
        try:
            isi = json.loads(row[3]) or []
        except (ValueError, TypeError):
            continue
        existing.append({"key": row[0], "outlet": row[1], "order_date": row[2],
                         "item_codes": [str(line.get("code", "")).strip() for line in isi]})
    return find_duplicate(candidate, existing)


def _angka(nilai):
    """Angka dinormalkan untuk sidik: "1000" == "1000.00" == "1000.0"."""
    return format(Decimal(str(nilai).strip()).normalize(), "f")


def sidik_order(customer_no, channel, order_date, lines, result):
    """Sidik angka yang DILIHAT pemakai: baris berharga + hasil promo (per baris, bonus, program tertahan).

    Bukan rahasia dan bukan tanda tangan: yang disimpan selalu hitungan server; sidik hanya membuktikan hitungan itu SAMA dengan yang
    sudah diperlihatkan. Aturan yang tidak menyentuh order ini boleh berubah tanpa membatalkan pratinjau (aturannya tidak ikut disidik).
    """
    isi = {"customer_no": str(customer_no or "").strip(), "channel": str(channel or "").strip().upper(), "order_date": str(order_date),
           "lines": [[str(line["code"]).strip(), str(line["unit"]).strip().upper(), _angka(line["quantity"]), _angka(line["price"])]
                     for line in lines],
           "result": result}
    return hashlib.sha256(json.dumps(isi, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def hitung_promo(customer_no, channel, order_date, lines, saran=False):
    """SATU-SATUNYA hitungan promo order: aturan terbit + kelas outlet pelanggan + channel + tanggal, atas baris BERHARGA.

    Dipakai pratinjau dan setiap jalur simpan/tarik, jadi angka pratinjau = angka beku. Program principal lain tidak bisa kena:
    semua baris = barang cabang pelanggan (Next `BARANG_BEDA_CABANG`), dan program hanya berlaku pada kode di `codes`-nya.
    """
    programs, sources = published_rules()
    if not programs:
        raise Ditolak(409, "ATURAN_BELUM_TERBIT", "Belum ada aturan promo terbit; terbitkan Summary sebelum order dihitung")
    kelas, tahu = outlet_class.classes_of(customer_no), outlet_class.known()
    try:
        result = calculate(programs, lines, order_date, channel, outlet_classes=kelas, known_classes=tahu)
    except RasioKosong as error:
        # Owner 16 Okt 2026: rasio satuan yang dibutuhkan program tidak ada -> order DITAHAN, bukan baris diam-diam tak dihitung.
        raise Ditolak(409, "RASIO_SATUAN_KOSONG", str(error)) from None
    hasil = {"rules": [program.model_dump(mode="json") for program in programs], "sources": sources, "result": result,
             "sidik": sidik_order(customer_no, channel, order_date, lines, result)}
    if saran:
        hasil["suggestions"] = suggestions(programs, lines, order_date, channel, outlet_classes=kelas, known_classes=tahu)
    return hasil


def hitung_order(customer_no, channel, order_date, lines, cookie=None):
    """Hitungan SIMPAN (Order Baru, Order Sales, tarik): channel = master, cabang + harga dari Next, lalu `hitung_promo`.

    CHANNEL DIPASTIKAN KE MASTER, bukan dipercaya dari yang mengirim: surat "KHUSUS CHANNEL GT" tidak boleh jatuh ke outlet yang master
    kita sebut MT (HINDA MART C-HIL009, jalur principal). Ditanyakan ke Next (`outlet_channel`), gagal tertutup, diperiksa SEBELUM apa
    pun dihitung. Jawaban pasti master -> `CHANNEL_BEDA_MASTER` (422, order itu saja); jaringan -> tidak pasti (503, ditahan).
    ATURAN CABANG + HARGA (O1; BL-18): `order_cabang.periksa` — baris tanpa harga diberi harga master server per cabang pelanggan
    (sumber yang sama dengan pratinjau), baris berharga petugas tidak ditimpa. `cookie` = sesi sales (cakupan cabangnya); None = layanan.
    """
    try:
        outlet_channel.verify(customer_no, channel)
    except outlet_channel.ChannelBedaMaster as error:
        raise Ditolak(422, "CHANNEL_BEDA_MASTER", str(error)) from None
    except outlet_channel.ChannelTidakPasti as error:
        # Konfigurasi (CRON_SECRET kosong/ditolak) = KONFIGURASI_SERVER, sama dengan jembatan harga (putaran 2, butir 8).
        kode = "KONFIGURASI_SERVER" if isinstance(error, outlet_channel.ChannelKonfigurasi) else "LAYANAN_TIDAK_PASTI"
        raise TidakPasti(str(error), kode=kode) from None
    berharga = order_cabang.periksa(customer_no, order_date, lines, cookie=cookie)
    hasil = {"lines": berharga, **hitung_promo(customer_no, channel, order_date, berharga)}
    # Barang BONUS wajib bisa diorder untuk pelanggan ini (cabang, suspended, non-jual) — keputusan Next yang sama dengan pratinjau
    # (putaran 2, butir 7). Gagal = order DITOLAK berkode, bonus tidak dibuang diam-diam.
    order_cabang.periksa_bonus(customer_no, order_date, [bonus.get("code", "") for bonus in hasil["result"].get("bonuses", [])], cookie=cookie)
    return hasil


def cocokkan(hasil, sidik):
    """Pratinjau = tersimpan: sidik pratinjau WAJIB sama dengan hitungan simpan. Beda -> ditolak, pratinjau baru ikut dikirim."""
    sidik = str(sidik or "").strip()
    if not sidik:
        raise Ditolak(400, "SIDIK_WAJIB", "Hitung pratinjau order dulu; order disimpan hanya bila angkanya sama dengan pratinjau.")
    if not hmac.compare_digest(sidik.encode("utf-8"), hasil["sidik"].encode("utf-8")):
        raise Ditolak(409, "PRATINJAU_BERUBAH",
                      "Harga atau promo berubah sejak pratinjau (aturan terbit, harga master, atau kelas outlet). Periksa angka baru lalu simpan ulang.",
                      {"pratinjau": {key: hasil[key] for key in ("lines", "result", "sources", "sidik")}})


def store_order(owner, outlet, channel, order_date, note, lines, request_id=None, customer_no="",
                confirm_duplicate=False, sidik=""):
    """Hitung (`hitung_order`), cocokkan dengan pratinjau (`sidik`), lalu bekukan aturan, sumber, baris berharga, dan hasilnya.

    Ditolak -> `OrderCabangDitolak` berkode (pemanggil melaporkannya); Next tak pasti -> `OrderCabangTidakPasti` (503, tidak disimpan).

    GERBANG ORDER GANDA: order yang outletnya sama dan barangnya MIRIP dengan order lain pada
    tanggal yang sama DITOLAK (`ORDER_GANDA`), sampai ada manusia yang menyatakan sudah memeriksanya
    lewat `confirm_duplicate`. Ditolak, bukan disimpan dengan tanda — order yang tersimpan akan
    terlihat seperti order biasa oleh setiap layar yang membacanya, dan tandanya akan terlewat.
    Yang datang dari Web Sales tidak hilang: permintaannya tetap `pending` dan dilaporkan sebagai
    `failed`, jadi ia menunggu keputusan manusia alih-alih ikut terproses.
    """
    hasil = hitung_order(customer_no, channel, order_date, lines)
    cocokkan(hasil, sidik)
    # Gerbang ganda diperiksa SETELAH ordernya terbukti sah, bukan sebelum: order yang isinya
    # tidak valid harus ditolak karena tidak valid, bukan karena mirip. Meminta manusia
    # mengonfirmasi order yang toh tidak bisa disimpan hanya melatihnya menekan tombol.
    if not confirm_duplicate:
        hit = duplicate_check(owner, outlet, channel, order_date, hasil["lines"])
        if hit:
            raise Ditolak(409, "ORDER_GANDA", duplicate_message(hit))

    order_id = str(uuid.uuid4())
    # Jejak konfirmasi ikut pada catatan ordernya: siapa pun yang membuka order ini nanti harus
    # bisa tahu bahwa ia pernah ditahan sebagai dugaan ganda, dan sengaja diloloskan.
    if confirm_duplicate:
        note = (note + " | dikonfirmasi BUKAN order ganda").strip()[:500]
    with connect() as db:
        db.execute("INSERT INTO sales_order(id,owner,outlet,channel,order_date,status,note,lines,rules,sources,"
                   "result,request_id,customer_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (order_id, owner, outlet[:160], channel[:80], order_date, "draft", note,
                    json.dumps(hasil["lines"], ensure_ascii=False), json.dumps(hasil["rules"], ensure_ascii=False),
                    json.dumps(hasil["sources"], ensure_ascii=False), json.dumps(hasil["result"], ensure_ascii=False), request_id,
                    customer_no[:80]))
    return order_id


def public_error(error):
    if isinstance(error, ValidationError):
        return "; ".join(".".join(map(str, entry["loc"])) + ": " + entry["msg"] for entry in error.errors()[:8])
    return str(error)


def jawab(error):
    """Galat berkode -> jawaban JSON `{ ok:false, detail, kode, ... }`; tidak pasti = 503 (TIDAK tersimpan, bukan "sesi berakhir")."""
    return JSONResponse(status_code=503 if isinstance(error, TidakPasti) else error.status, content=error.isi())


def baris_bersih(line):
    """Baris masukan pratinjau/Order Baru dalam bentuk SAMA dengan yang diperiksa Next (satuan huruf besar): `calculate` mencocokkan
    satuan program apa adanya, jadi "pcs" vs "PCS" antara pratinjau dan simpan akan membuat angka (dan sidik) berbeda."""
    clean = {key: str(line.get(key, "") or "").strip() for key in ("code", "unit", "quantity", "price")}
    clean["unit"] = clean["unit"].upper()
    # Rasio satuan pratinjau datang dari Next (`periksaOrder`); simpan memakai rasio jawaban Next lagi (order_cabang.periksa),
    # jadi rasio karangan pemanggil langsung hanya mengubah pratinjaunya sendiri dan sidiknya tidak akan cocok.
    if isinstance(line.get("rasio"), dict):
        clean["rasio"] = {str(unit)[:20]: nilai for unit, nilai in list(line["rasio"].items())[:10]}
    return clean


async def read_order_body(request, limit):
    raw = await request.body()
    if len(raw) > limit:
        raise HTTPException(413, "Permintaan terlalu besar")
    try:
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(400, "Format permintaan tidak valid") from None
    channel = str(body.get("channel", "")).strip().upper()
    order_date = str(body.get("order_date", "")).strip()
    lines = body.get("lines")
    if not channel or not order_date:
        raise HTTPException(400, "Channel dan tanggal order wajib diisi")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 500:
        raise HTTPException(400, "Order harus memiliki 1–500 baris")
    clean = []
    for line in lines:
        if not isinstance(line, dict):
            raise HTTPException(400, "Baris order tidak valid")
        clean.append(baris_bersih(line))
    return body, channel, order_date, clean


@router.post("/preview")
async def preview_order(request: Request):
    """Nilai transaksi, promo, saran "kurang berapa lagi", dan `sidik` sebelum order disimpan. Tidak menyimpan apa pun.

    Harga datang dari Next (`/api/orders/preview` -> `periksaOrder`, harga master per cabang pelanggan atau harga petugas Order Baru),
    bukan dari perangkat sales. Pemanggil langsung yang mengirim harga karangan hanya mendapat pratinjau atas angka karangannya:
    simpan menghitung ulang dari server dan sidiknya tidak akan cocok.

    Boleh dipakai petugas internal (`order.create`) maupun sales (`websales.create`):
    sales HARUS melihat nilai transaksi dan promo yang berlaku; yang tidak boleh adalah
    klien MENENTUKAN harga.
    """
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Silakan login")
    if not (user_has_permission(user, "order", "create") or user_has_permission(user, "websales", "create")):
        raise HTTPException(403, "Akses pratinjau order tidak diizinkan")
    if not validate_csrf_request(request, request.headers.get("X-CSRF-Token", "")):
        raise HTTPException(403, "Permintaan lintas situs ditolak")
    body, channel, order_date, clean = await read_order_body(request, 512 * 1024)
    if any(not line["price"] for line in clean):
        raise HTTPException(400, "Setiap baris pratinjau butuh harga dari server")
    # Kelayakan outlet ikut dihitung di pratinjau (customer_no diteruskan Next): sales harus melihat angka yang sama
    # dengan yang nanti dibekukan pada order, termasuk promo yang TIDAK berlaku untuknya.
    customer_no = str(body.get("customer_no", "")).strip()
    # Channel dilaporkan, TIDAK dilemparkan sebagai galat, di pratinjau: sales sedang mengetik,
    # dan angka harganya tetap berguna sambil ia membetulkan channelnya. Yang tidak boleh adalah
    # ia baru tahu ordernya akan ditolak setelah seluruh baris diketik — jadi sebabnya muncul
    # sekarang, dengan kalimat yang sama persis dengan yang nanti menolaknya.
    channel_masalah = ""
    try:
        outlet_channel.verify(customer_no, channel)
    except outlet_channel.ChannelTidakPasti as error:
        channel_masalah = str(error)
    try:
        hasil = hitung_promo(customer_no, channel, order_date, clean, saran=True)
    except Ditolak as error:
        return jawab(error)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(400, public_error(error)) from None
    return {"ok": True, "result": hasil["result"], "suggestions": hasil["suggestions"], "sources": hasil["sources"],
            "sidik": hasil["sidik"], "channel_masalah": channel_masalah}


@router.post("")
async def create_order(request: Request):
    """Order Baru (petugas internal, `order.create`). Baris boleh membawa harga PETUGAS (menang, > 0); kosong = harga master server.
    WAJIB `sidik` pratinjau (kontrak §4.3)."""
    user = require_user(request, True)
    raw = await request.body()
    if len(raw) > 512 * 1024:
        raise HTTPException(413, "Order maksimal 512 KB")
    try:
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(400, "Format permintaan tidak valid") from None
    outlet, channel = str(body.get("outlet", "")).strip(), str(body.get("channel", "")).strip().upper()
    order_date, note = str(body.get("order_date", "")).strip(), str(body.get("note", ""))[:500]
    customer_no = str(body.get("customer_no", "")).strip()
    lines = body.get("lines")
    if not outlet or not channel or not order_date:
        raise HTTPException(400, "Outlet, channel, dan tanggal order wajib diisi")
    # `customerNo` adalah field WAJIB sales-invoice/save.do dan nomor faktur milik Accurate;
    # order tanpa pelanggan tidak akan pernah bisa menjadi faktur, jadi ditolak di sini.
    if not customer_no:
        raise HTTPException(400, "Kode pelanggan Accurate wajib diisi")
    if not isinstance(lines, list) or not 1 <= len(lines) <= 500:
        raise HTTPException(400, "Order harus memiliki 1–500 baris")
    clean = []
    for line in lines:
        if not isinstance(line, dict):
            raise HTTPException(400, "Baris order tidak valid")
        clean.append(baris_bersih(line))
    try:
        order_id = store_order(identity(user), outlet, channel, order_date, note, clean,
                               customer_no=customer_no, sidik=body.get("sidik"),
                               confirm_duplicate=body.get("confirm_duplicate") is True)
    except (Ditolak, TidakPasti) as error:
        return jawab(error)
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(400, public_error(error)) from None
    return {"ok": True, "order": order_detail_row(order_id, user)}


# Galat yang BUKAN soal satu permintaan: menghentikan seluruh tarikan (tidak ada yang ditolak), bukan menolak permintaan satu per satu.
GLOBAL = {"ATURAN_BELUM_TERBIT", "ATURAN_TERBIT_RUSAK"}
# Satu tarikan memproses paling banyak BATAS_HALAMAN x HALAMAN permintaan.
# ponytail: halaman keyset, bukan antrean berprioritas — permintaan DITAHAN (dugaan ganda, BL-20) tidak lagi menyumbat 200 baris pertama;
# batasnya hanya waktu satu tarikan. Naikkan ke kolom "dicoba_at" bila yang ditahan pernah ribuan.
HALAMAN, BATAS_HALAMAN = 200, 10


def pull_once(owner, confirm_duplicate=False):
    """Tarik permintaan order Web Sales ke internal. Aman diulang.

    Dua basis data tidak bisa satu transaksi, jadi urutannya: tulis order internal
    dengan `request_id` unik lebih dulu, baru tandai permintaan sebagai `pulled`.
    Bila penandaan gagal, pull berikutnya menabrak kunci unik dan permintaan itu
    hanya ditandai, bukan digandakan. Karena itu dua pull yang jalan bersamaan pun
    tidak menggandakan order — kunci unik yang menjaga, bukan penjadwalannya.

    Nasib tiap permintaan (O1 putaran 1): masuk (`imported`); sudah pernah masuk (`already_imported`); DITAHAN dugaan ganda (`failed`,
    tetap pending, menunggu manusia); DITOLAK PERMANEN (`rejected`: status `rejected` + kode + sebab — aturan cabang/harga, channel
    beda master, angka beda dengan pratinjau sales, data rusak; tidak dicoba lagi selamanya). Next tak pasti / konfigurasi / aturan
    belum terbit = tarikan BERHENTI (dilempar ke endpoint), tidak ada yang ditolak.
    """
    imported, duplicated, failed, rejected = [], [], [], []
    setelah = None
    for _ in range(BATAS_HALAMAN):
        batch = websales_store.pending(HALAMAN, setelah)
        if batch and setelah is None:
            # Aturan terbit diperiksa SEKALI sebelum permintaan disentuh (butir 6): rusak/kosong = galat GLOBAL, tarikan berhenti,
            # semua tetap pending — bukan Next ditanya lalu tiap permintaan ditolak karena keadaan server.
            if not published_rules()[0]:
                raise Ditolak(409, "ATURAN_BELUM_TERBIT", "Belum ada aturan promo terbit; terbitkan Summary sebelum order dihitung")
        for entry in batch:
            # SUDAH DITARIK diperiksa LEBIH DULU, bukan diserahkan ke kunci unik: gerbang order ganda menahan permintaan
            # yang ordernya SUDAH ADA dengan 409 sebelum kunci unik sempat berbunyi — ia lalu muncul lagi sebagai "dugaan
            # order ganda" pada setiap tarikan berikutnya, padahal yang ia gandakan dirinya sendiri.
            with connect() as db:
                sudah = db.execute("SELECT id FROM sales_order WHERE request_id=?", (entry["id"],)).fetchone()
            if sudah:
                duplicated.append(entry["id"])
                continue
            try:
                order_id = store_order(owner, entry["outlet"], entry["channel"], entry["order_date"],
                                       entry["note"], entry["lines"], request_id=entry["id"],
                                       customer_no=entry.get("customer_no", ""), sidik=entry.get("sidik", ""),
                                       confirm_duplicate=confirm_duplicate)
                imported.append({"request_id": entry["id"], "order_id": order_id})
            except sqlite3.IntegrityError:
                duplicated.append(entry["id"])
                continue
            except Ditolak as error:
                if error.kode in GLOBAL:
                    raise
                if error.kode == "ORDER_GANDA":
                    failed.append({"request_id": entry["id"], "error": error.pesan, "kode": error.kode, "duplicate": True})
                    continue
                websales_store.mark_rejected(entry["id"], error.kode, error.pesan)
                rejected.append({"request_id": entry["id"], "kode": error.kode, "error": error.pesan})
                continue
            except (ValueError, KeyError, TypeError) as error:
                websales_store.mark_rejected(entry["id"], "DATA_TIDAK_VALID", public_error(error))
                rejected.append({"request_id": entry["id"], "kode": "DATA_TIDAK_VALID", "error": public_error(error)})
                continue
            websales_store.mark_pulled(entry["id"])
        if len(batch) < HALAMAN:
            break
        setelah = (batch[-1]["created_at"], batch[-1]["id"])
    for request_id in duplicated:
        websales_store.mark_pulled(request_id)
    return {"imported": imported, "already_imported": duplicated, "failed": failed, "rejected": rejected}


@router.post("/pull")
async def pull_requests(request: Request):
    """Tarik manual oleh petugas; jalur otomatis ada di /orders/pull-cron."""
    user = require_user(request, True)
    if not user_has_permission(user, "order", "edit"):
        raise HTTPException(403, "Hanya petugas yang boleh menarik order Web Sales")
    try:
        return {"ok": True, **pull_once(identity(user))}
    except (Ditolak, TidakPasti) as error:
        return jawab(error)


# Koneksi Web Sales: petugas menyalakan, penarikan berjalan sampai dinonaktifkan.
#
# ponytail: TIDAK ada worker asyncio di dalam FastAPI. Penjadwalnya cron 5 menit yang sudah
# terpasang (pola sama dengan /api/cron/sync-accurate), dan endpoint ini no-op saat koneksi
# mati. Alasannya: status bertahan melewati restart, tidak ada dua worker saat uvicorn
# dijalankan multi-proses, dan tidak ada task yang harus dimatikan rapi. Naikkan ke worker
# in-process hanya kalau latensi 5 menit terbukti tidak cukup.
CONNECTION = JsonStore("websales_connection")
BLANK_CONNECTION = {"enabled": False, "owner": "", "updated_by": "", "updated_at": "",
                    "last_run_at": "", "last_result": None}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connection_state():
    try:
        return {**BLANK_CONNECTION, **CONNECTION["state"]}
    except (KeyError, ValueError):
        return dict(BLANK_CONNECTION)


@router.get("/connection")
def connection_status(request: Request):
    require_user(request)
    return {"ok": True, "connection": connection_state(), "pending": websales_store.pending_count()}


@router.post("/connection")
async def set_connection(request: Request):
    user = require_user(request, True)
    if not user_has_permission(user, "order", "edit"):
        raise HTTPException(403, "Hanya petugas yang boleh mengatur koneksi Web Sales")
    try:
        body = json.loads(await request.body() or b"{}")
        if not isinstance(body, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(400, "Format permintaan tidak valid") from None
    if not isinstance(body.get("enabled"), bool):
        raise HTTPException(400, "Kirim enabled true atau false")
    state = connection_state()
    # Order hasil tarik otomatis dimiliki petugas yang menyalakan koneksi — itu yang
    # membuatnya terlihat di "Milik saya" dan jelas siapa yang bertanggung jawab.
    state.update(enabled=body["enabled"], updated_by=identity(user), updated_at=now_iso())
    if body["enabled"]:
        state["owner"] = identity(user)
    CONNECTION["state"] = state
    return {"ok": True, "connection": state, "pending": websales_store.pending_count()}


@router.post("/pull-cron")
async def pull_cron(request: Request):
    """Dipanggil penjadwal tiap 5 menit; TIDAK memakai sesi pengguna.

    Secret dibandingkan konstan-waktu dan wajib ada: tanpa `CRON_SECRET` endpoint ini
    menolak, bukan terbuka.
    """
    secret = str(os.getenv("CRON_SECRET", "")).strip()
    if not secret:
        raise HTTPException(503, "CRON_SECRET belum dikonfigurasi di server")
    if not hmac.compare_digest(str(request.headers.get("X-Cron-Secret", "")), secret):
        raise HTTPException(403, "Secret penjadwal tidak cocok")
    state = connection_state()
    if not state["enabled"]:
        return {"ok": True, "skipped": "koneksi Web Sales dimatikan", "imported": [],
                "already_imported": [], "failed": [], "rejected": []}
    if not state["owner"]:
        raise HTTPException(409, "Koneksi aktif tanpa pemilik; nyalakan ulang dari halaman Order Masuk")
    try:
        result = pull_once(state["owner"])
    except (Ditolak, TidakPasti) as error:
        return jawab(error)
    state.update(last_run_at=now_iso(),
                 last_result={key: len(value) for key, value in result.items()})
    CONNECTION["state"] = state
    return {"ok": True, **result}


def order_detail_row(order_id, user, everyone=False):
    with connect() as db:
        query = ("SELECT id,owner,outlet,channel,order_date,status,note,lines,rules,sources,result,request_id,"
                 "customer_no,created_at FROM sales_order WHERE id=?")
        row = db.execute(query if everyone else query + " AND owner=?", (order_id,) if everyone else (order_id, identity(user))).fetchone()
    if row is None:
        return None
    value = dict(row)
    for key in ("lines", "rules", "sources", "result"):
        value[key] = json.loads(value[key])
    return value


@router.get("")
def list_orders(request: Request, scope: str = "mine"):
    user = require_user(request)
    everyone = scope == "all" and user_has_permission(user, "order", "edit")
    with connect() as db:
        query = ("SELECT id,owner,outlet,channel,order_date,status,result,request_id,customer_no,created_at"
                 " FROM sales_order "
                 + ("" if everyone else "WHERE owner=? ") + "ORDER BY created_at DESC,id DESC LIMIT 100")
        rows = db.execute(query, () if everyone else (identity(user),)).fetchall()
    return {"ok": True, "scope": "all" if everyone else "mine",
            "orders": [{**dict(row), "result": json.loads(row["result"])} for row in rows]}


@router.get("/{order_id}")
def order_detail(request: Request, order_id: str):
    user = require_user(request)
    order = order_detail_row(order_id, user, user_has_permission(user, "order", "edit"))
    if order is None:
        raise HTTPException(404, "Order tidak ditemukan")
    return {"ok": True, "order": order}
