"""Tujuan: Mendefinisikan alias keyword dan metadata Power Query laporan Principal.
Caller: laporan_harian.load_lookups_json.
Dependensi: Nama Principal kanonik dan aturan di laporan_harian_principal.py.
Main Functions: REPORT_TARGETS; SAHAR lintas principal dan MSM dengan mapping eksplisit.
Side Effects: Tidak ada.
"""

REPORT_TARGETS = {
    "SAHAR": {"group_type": "spv", "values": ["SAHAR"]},
    "HEINZ": {"group_type": "principal", "values": ["HEINZ ABC INDONESIA, PT"], "sales_column": "GOLONGAN", "sales_values": ["ZUL & ARUL"]},
    "MSM": {"group_type": "principal", "values": ["MEGA SURYA MAS, PT"]},
    "ABCPI": {"group_type": "principal", "values": ["ABC PRESIDENT INDONESIA, PT"]},
    "ENERGIZER": {"group_type": "principal", "values": ["ENERGIZER INDONESIA, PT"]},
    "FONTERRA": {"group_type": "principal", "values": ["FONTERRA BRANDS INDONESIA, PT"]},
    "GODREJJ": {"group_type": "principal", "values": ["GODREJ CONSUMER PRODUCTS INDONESIA, PT"]},
    "MOTASA MKS 1": {"group_type": "principal", "values": ["MOTASA INDONESIA, PT"]},
    "MOTASA MKS 2": {"group_type": "principal", "values": ["MOTASA INDONESIA, PT"]},
    "MUSTIKA RATU": {"group_type": "principal", "values": ["MUSTIKA RATUBUANA INTERNATIONAL"]},
    "RECKIT": {"group_type": "principal", "values": ["RECKITT BENCKISER, PT"]},
    "URC": {"group_type": "principal", "values": ["URC INDONESIA, PT"]},
}
