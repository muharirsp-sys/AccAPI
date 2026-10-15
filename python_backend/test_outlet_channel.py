"""Tujuan: Mengunci perilaku gerbang channel outlet — terutama caranya GAGAL.
Caller: `python -m pytest test_outlet_channel.py` atau `python test_outlet_channel.py`.

Yang diuji di sini bukan jalur bahagianya. Jalur bahagia akan ketahuan sendiri kalau rusak;
yang tidak akan ketahuan adalah gerbang yang diam-diam MELOLOSKAN saat tidak tahu jawabannya.
"""
import outlet_channel
from outlet_channel import ChannelTidakPasti


def _pakai(peta, dipanggil=None):
    """Ganti `channels_of` dengan jawaban tetap, supaya tidak ada jaringan di dalam uji."""
    def palsu(kode):
        if dipanggil is not None:
            dipanggil.append(sorted(kode))
        return dict(peta)
    outlet_channel.channels_of = palsu


_ASLI = outlet_channel.channels_of


def setup_function():
    outlet_channel._CACHE.clear()
    outlet_channel.channels_of = _ASLI


def teardown_function():
    # Fungsinya dikembalikan, modulnya TIDAK di-reload: reload membuat kelas
    # `ChannelTidakPasti` yang baru, dan `except` di berkas ini masih menunjuk yang lama —
    # jadi galat yang seharusnya tertangkap justru lolos ke pemanggil.
    outlet_channel.channels_of = _ASLI


def test_channel_cocok_dengan_master_diterima():
    _pakai({"C-GAL006-KN": "GT"})
    assert outlet_channel.verify("C-GAL006-KN", "GT") == "GT"
    # Huruf kecil dari klien tetap diterima; yang dibandingkan nilainya, bukan ejaannya.
    assert outlet_channel.verify("C-GAL006-KN", "gt") == "GT"


def test_channel_berbeda_dari_master_DITOLAK_dan_menyebut_keduanya():
    """Kasus HINDA MART: laporan bilang General Trade, master bilang MT."""
    _pakai({"C-HIL009-KN": "MT"})
    try:
        outlet_channel.verify("C-HIL009-KN", "GT")
    except ChannelTidakPasti as error:
        pesan = str(error)
        assert "GT" in pesan and "MT" in pesan, pesan
        assert "C-HIL009-KN" in pesan
    else:
        raise AssertionError("order GT untuk outlet MT seharusnya ditolak")


def test_outlet_tanpa_kategori_di_master_DITAHAN_bukan_diloloskan():
    # 378 pelanggan produksi berkategori kosong. Kosong bukan "berlaku di mana saja";
    # ia berarti kita tidak tahu, dan yang tidak diketahui ditahan.
    _pakai({"C-BARU001-KN": ""})
    try:
        outlet_channel.verify("C-BARU001-KN", "GT")
    except ChannelTidakPasti as error:
        assert "belum punya kategori" in str(error)
    else:
        raise AssertionError("outlet tanpa kategori seharusnya ditahan")


def test_outlet_tidak_ada_di_master_DITAHAN():
    _pakai({})
    try:
        outlet_channel.verify("C-HANTU001-KN", "GT")
    except ChannelTidakPasti as error:
        assert "tidak ada di master" in str(error)
    else:
        raise AssertionError("outlet di luar master seharusnya ditahan")


def test_kode_pelanggan_kosong_ditahan():
    _pakai({"C-GAL006-KN": "GT"})
    try:
        outlet_channel.verify("", "GT")
    except ChannelTidakPasti as error:
        assert "wajib diisi" in str(error)
    else:
        raise AssertionError("order tanpa kode pelanggan seharusnya ditahan")


def test_next_tidak_bisa_dihubungi_menahan_order_bukan_meloloskannya():
    """GAGAL TERTUTUP. Ini satu-satunya uji yang benar-benar penting di berkas ini."""
    def meledak(_kode):
        raise ChannelTidakPasti("Tidak bisa menanyakan channel outlet ke Next: connection refused")
    outlet_channel.channels_of = meledak
    try:
        outlet_channel.verify("C-GAL006-KN", "GT")
    except ChannelTidakPasti as error:
        assert "Tidak bisa menanyakan" in str(error)
    else:
        raise AssertionError("Next mati harus MENAHAN order, bukan meloloskannya")


def test_kegagalan_jaringan_tidak_pernah_di_cache():
    """Cache-nya optimisasi, bukan sumber kebenaran; kegagalan tidak boleh mengendap di sana."""
    def meledak(_kode):
        raise ChannelTidakPasti("connection refused")
    outlet_channel.channels_of = meledak
    try:
        outlet_channel.verify("C-GAL006-KN", "GT")
    except ChannelTidakPasti:
        pass
    # Kalau kegagalan ikut di-cache, outlet ini akan tertahan selama TTL meski Next sudah hidup
    # lagi — hukuman yang menimpa orang yang tidak melakukan kesalahan apa pun.
    assert outlet_channel._CACHE == {}


def test_cache_dipakai_supaya_satu_order_tidak_menanyakan_berulang():
    dipanggil = []
    _pakai({"C-GAL006-KN": "GT"}, dipanggil)
    assert outlet_channel.verify("C-GAL006-KN", "GT") == "GT"
    assert outlet_channel.verify("C-GAL006-KN", "GT") == "GT"
    # `verify` memang memanggil `channels_of` tiap kali; cache-nya hidup DI DALAM `channels_of`
    # (diuji terpisah lewat `_CACHE`), jadi yang dijaga di sini hanya bahwa jawabannya tetap.
    assert len(dipanggil) == 2


def test_jawaban_pasti_master_berkelas_ChannelBedaMaster_jaringan_tidak():
    """O1 putaran 1: tarikan menolak permanen HANYA jawaban pasti master; kegagalan jaringan menghentikan tarikan (bukan menolak)."""
    from outlet_channel import ChannelBedaMaster
    for peta, kode, channel in [({"C-HIL009-KN": "MT"}, "C-HIL009-KN", "GT"), ({"C-BARU001-KN": ""}, "C-BARU001-KN", "GT"),
                                ({}, "C-HANTU001-KN", "GT"), ({}, "", "GT")]:
        _pakai(peta)
        try:
            outlet_channel.verify(kode, channel)
        except ChannelBedaMaster:
            pass
        else:
            raise AssertionError(f"{kode or '(kosong)'} seharusnya ChannelBedaMaster")

    def meledak(_kode):
        raise ChannelTidakPasti("Tidak bisa menanyakan channel outlet ke Next: connection refused")
    outlet_channel.channels_of = meledak
    try:
        outlet_channel.verify("C-GAL006-KN", "GT")
    except ChannelBedaMaster:
        raise AssertionError("jaringan putus BUKAN jawaban master")
    except ChannelTidakPasti:
        pass


def test_secret_ditolak_next_atau_kosong_KONFIGURASI_dengan_log_cache_dingin():
    """Putaran 2 (butir 8): 401/403 dari /api/outlet-channel = CRON_SECRET beda -> ChannelKonfigurasi + log, bukan "HTTP 401" tak berkode."""
    import logging
    import os
    import sys
    import types
    from outlet_channel import ChannelKonfigurasi
    catatan = []

    class Tangkap(logging.Handler):
        def emit(self, record):
            catatan.append(record.getMessage())

    outlet_channel.LOG.addHandler(Tangkap())
    lama = {k: os.environ.get(k) for k in ("CRON_SECRET", "NEXT_INTERNAL_URL")}
    asli = sys.modules.get("requests")
    try:
        os.environ["NEXT_INTERNAL_URL"] = "http://next.uji:3000"
        os.environ.pop("CRON_SECRET", None)
        try:
            outlet_channel.verify("C-GAL006-KN", "GT")
        except ChannelKonfigurasi:
            pass
        else:
            raise AssertionError("CRON_SECRET kosong = konfigurasi")
        os.environ["CRON_SECRET"] = "beda"
        for status in (401, 403):
            outlet_channel._CACHE.clear()  # cache DINGIN: pertanyaan benar-benar ke Next
            sys.modules["requests"] = types.SimpleNamespace(get=lambda *a, **k: types.SimpleNamespace(status_code=status, json=lambda: {}))
            try:
                outlet_channel.verify("C-GAL006-KN", "GT")
            except ChannelKonfigurasi as error:
                assert "CRON_SECRET" in str(error)
            else:
                raise AssertionError(f"HTTP {status} = konfigurasi")
        assert sum("CRON_SECRET" in c for c in catatan) == 2, catatan
        sys.modules["requests"] = types.SimpleNamespace(get=lambda *a, **k: types.SimpleNamespace(status_code=502, json=lambda: {}))
        outlet_channel._CACHE.clear()
        try:
            outlet_channel.verify("C-GAL006-KN", "GT")
        except ChannelKonfigurasi:
            raise AssertionError("502 = layanan tak pasti, bukan konfigurasi")
        except ChannelTidakPasti:
            pass
    finally:
        for k, v in lama.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if asli is None:
            sys.modules.pop("requests", None)
        else:
            sys.modules["requests"] = asli


def main():
    for nama, fungsi in sorted(globals().items()):
        if nama.startswith("test_") and callable(fungsi):
            setup_function()
            fungsi()
            teardown_function()
    print("PASS: gerbang channel outlet menahan saat tidak tahu, bukan meloloskan")


if __name__ == "__main__":
    main()

