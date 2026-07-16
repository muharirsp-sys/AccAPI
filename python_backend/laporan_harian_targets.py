"""Tujuan: Mendefinisikan alias keyword penerima untuk laporan Principal.
Caller: laporan_harian.load_lookups_json.
Dependensi: Nama Principal kanonik dari laporan_harian_lookups.json.
Main Functions: REPORT_TARGETS.
Side Effects: Tidak ada.
"""

REPORT_TARGETS = {
    "ABCPI": {"group_type": "principal", "values": ["ABC PRESIDENT INDONESIA, PT"]},
    "ENERGIZER": {"group_type": "principal", "values": ["ENERGIZER INDONESIA, PT"]},
    "FONTERRA": {"group_type": "principal", "values": ["FONTERRA BRANDS INDONESIA, PT"]},
    "GODREJJ": {"group_type": "principal", "values": ["GODREJ CONSUMER PRODUCTS INDONESIA, PT"]},
    "HEINZ": {"group_type": "principal", "values": ["HEINZ ABC INDONESIA, PT"]},
    "MOTASA MKS 1": {"group_type": "principal", "values": ["MOTASA INDONESIA, PT"]},
    "MOTASA MKS 2": {"group_type": "principal", "values": ["MOTASA INDONESIA, PT"]},
    "MUSTIKA RATU": {"group_type": "principal", "values": ["MUSTIKA RATUBUANA INTERNATIONAL"]},
    "RECKIT": {"group_type": "principal", "values": ["RECKITT BENCKISER, PT"]},
    "URC": {"group_type": "principal", "values": ["URC INDONESIA, PT"]},
}
