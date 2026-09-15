"""Tujuan: Mengenali ORDER YANG DIDUGA GANDA — outlet sama, barang MIRIP tetapi tidak persis sama.
Caller: routers.orders (Order Sales lewat POST /orders, Order Masuk lewat pull). Dependensi: stdlib.
Main Functions: find_duplicate, duplicate_message. Side Effects: tidak ada; murni.

KEMBARAN `lib/order-duplicate.ts`, yang menjaga Order Principal. Keduanya WAJIB menjawab sama,
dan itu dikunci dengan contoh angka yang SAMA PERSIS di kedua berkas ujinya. Kalau aturannya
berubah di satu sisi, ubah juga di sisi lain — dua jawaban berbeda tentang "apakah order ini
ganda" lebih buruk daripada tidak punya pemeriksaan.

KENAPA "MIRIP", BUKAN "SAMA PERSIS". Order ganda yang isinya identik masih mungkin ketahuan
mata. Yang berbahaya justru yang hampir sama: satu order diketik ulang karena yang pertama
dikira gagal, lalu satu barang ditambah. Dua-duanya lalu terlihat sebagai order yang berbeda,
dan barangnya keluar gudang dua kali.

KENAPA CONTAINMENT, BUKAN JACCARD. Order 3 barang yang seluruhnya ada di dalam order 10 barang
punya Jaccard 0,3 — terlihat tidak mirip — padahal itu bentuk ketikan ulang paling khas.
Containment (irisan dibagi yang TERKECIL) membacanya 1,0.
"""

# Ambang kemiripan bawaan. Satu angka, dan sengaja jadi parameter supaya bisa digeser tanpa
# membedah logikanya. 0,5 = "setengah isi order yang lebih kecil sudah pernah diorder outlet ini
# pada hari yang sama".
DUPLICATE_THRESHOLD = 0.5


def _clean(value):
    return str(value or "").strip().upper()


def _codes(items):
    return {code for code in (_clean(item) for item in (items or [])) if code}


def find_duplicate(candidate, existing, threshold=DUPLICATE_THRESHOLD):
    """Order lain yang PALING mirip, atau None.

    `candidate` dan tiap isi `existing` berbentuk
    ``{"key": str, "outlet": str, "order_date": "yyyy-mm-dd", "item_codes": [str]}``.

    Jendela bandingnya TANGGAL YANG SAMA di outlet yang sama. Bukan tujuh hari: outlet memang
    wajar memesan barang yang sama minggu depan, dan menahan pesanan rutin akan membuat
    konfirmasinya kehilangan arti — yang ditahan terlalu sering akan dilewati tanpa dibaca.

    Yang dikembalikan yang TERKUAT: containment tertinggi, lalu irisan terbanyak.
    """
    mine = _codes(candidate.get("item_codes"))
    outlet = _clean(candidate.get("outlet"))
    date = str(candidate.get("order_date") or "")[:10]
    if not mine or not outlet or not date:
        return None

    best = None
    for other in existing or []:
        if other.get("key") == candidate.get("key"):
            continue
        if _clean(other.get("outlet")) != outlet:
            continue
        if str(other.get("order_date") or "")[:10] != date:
            continue
        theirs = _codes(other.get("item_codes"))
        if not theirs:
            continue
        shared = sorted(mine & theirs)
        if not shared:
            continue
        containment = len(shared) / min(len(mine), len(theirs))
        if containment < threshold:
            continue
        hit = {"key": other.get("key"), "shared": shared, "containment": containment,
               "identical": len(mine) == len(theirs) and len(shared) == len(mine)}
        if best is None or hit["containment"] > best["containment"] or (
                hit["containment"] == best["containment"] and len(hit["shared"]) > len(best["shared"])):
            best = hit
    return best


def duplicate_message(hit, sebutan="Order"):
    """Kalimat yang dibaca admin. Sama dengan `duplicateFinding` pada kembaran TypeScript-nya."""
    if hit["identical"]:
        return (f"{sebutan} ini membawa barang yang PERSIS SAMA dengan {hit['key']} pada outlet dan "
                "tanggal yang sama. Pastikan ini bukan order ganda sebelum diproses.")
    persen = round(hit["containment"] * 100)
    contoh = ", ".join(hit["shared"][:8])
    return (f"{sebutan} ini mirip {persen}% dengan {hit['key']} pada outlet dan tanggal yang sama "
            f"({len(hit['shared'])} barang sama: {contoh}). Mirip tetapi tidak sama persis justru "
            "bentuk ketikan ulang yang paling sering lolos — konfirmasi dulu bahwa ini bukan order ganda.")
