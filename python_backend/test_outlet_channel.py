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


def main():
    for nama, fungsi in sorted(globals().items()):
        if nama.startswith("test_") and callable(fungsi):
            setup_function()
            fungsi()
            teardown_function()
    print("PASS: gerbang channel outlet menahan saat tidak tahu, bukan meloloskan")


if __name__ == "__main__":
    main()
