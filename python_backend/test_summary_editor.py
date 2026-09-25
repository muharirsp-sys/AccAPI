"""Tujuan: Mengunci sambungan editor QA (self_correction) di summary_mistral.extract, tanpa jaringan.
Mistral dipalsukan lewat httpx.MockTransport, MiMo lewat mimo_post palsu. Dijalankan run_checks.py.
Yang dikunci: tanpa MIMO_API_KEY editor tidak dipanggil; dengan kunci, tambalan diterapkan dan
tampil sebagai peringatan; hasil terkoreksi dibekukan di cache; editor gagal -> baris utuh + peringatan."""
import asyncio, json, os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["SUMMARY_STORE_PATH"] = os.path.join(tempfile.mkdtemp(), "s.sqlite3")
os.environ["MISTRAL_API_KEY"] = "dummy"
import fitz, httpx, self_correction, summary_mistral, surat_struktur



def main():
    doc = fitz.open(); doc.new_page(); raw = doc.tobytes()
    row = {f: "" for f in surat_struktur.BIDANG["PRISKILA"]} | {"group_item_text": "Bellagio EDT 100ml", "paket": "4+1", "channel_gtmt": "Retail"}
    def mistral(request):
        return httpx.Response(200, json={"pages": [{"markdown": "| Bellagio EDT 100ml | 7+1 |"}],
                                         "document_annotation": json.dumps({"rows": [row], "warnings": []})})
    master = {"items": [{"kode_barang": "P1", "nama_barang": "BLAGIO", "kelompok": "X"}]}
    calls = []
    async def fake_mimo(payload):
        calls.append(payload)
        rid = json.loads(payload["messages"][0]["content"].split("=== HASIL EKSTRAKSI ===\n")[1])[0]["id"]
        return json.dumps({"patches": [{"id": rid, "field": "paket", "to": "7+1", "alasan": "Bellagio EDT 100ml | 7+1"}]})
    self_correction.mimo_post = fake_mimo

    async def run(user):
        async with httpx.AsyncClient(transport=httpx.MockTransport(mistral)) as client:
            return await summary_mistral.extract(raw, master, user, "PRISKILA", client=client)

    os.environ.pop("MIMO_API_KEY", None)
    off = asyncio.run(run("u|a"))
    assert off["rows"][0]["paket"] == "4+1" and off["self_correction"] is None and not calls, off
    os.environ["MIMO_API_KEY"] = "dummy"
    on = asyncio.run(run("u|a"))
    assert not on.get("cached"), "editor aktif harus memakai kunci cache berbeda"
    assert on["rows"][0]["paket"] == "7+1", on["rows"]
    assert any("diubah editor QA" in w and "Baris 1" in w for w in on["warnings"]), on["warnings"]
    assert on["self_correction"]["patches"][0]["from"] == "4+1"
    again = asyncio.run(run("u|a"))
    assert again.get("cached") and len(calls) == 1, "hasil terkoreksi dibekukan; run ke-2 tanpa panggilan MiMo"
    async def broken(payload): raise httpx.ConnectError("down")
    self_correction.mimo_post = broken
    os.environ["SUMMARY_EDITOR_MODEL"] = "other"
    fail = asyncio.run(run("u|a"))
    assert fail["rows"][0]["paket"] == "4+1" and any("Editor QA tidak berjalan" in w for w in fail["warnings"]), fail["warnings"]
    print("smoke editor PASSED")


if __name__ == "__main__":
    main()
