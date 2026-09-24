CREATE TABLE IF NOT EXISTS sales_history_export (
    item_id integer PRIMARY KEY,
    referensi text NOT NULL,
    jenis_transaksi text NOT NULL,
    tanggal text NOT NULL,
    principal text NOT NULL,
    kode_cust text NOT NULL,
    customer_nama text NOT NULL,
    kode_objek text NOT NULL,
    nama_produk text NOT NULL,
    qty double precision NOT NULL,
    satuan text NOT NULL,
    harga_satuan double precision NOT NULL,
    harga_total double precision NOT NULL,
    diskon_rp double precision NOT NULL,
    dpp double precision NOT NULL,
    ppn double precision NOT NULL,
    batch_id integer NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_she_tanggal ON sales_history_export(tanggal);
CREATE INDEX IF NOT EXISTS idx_she_principal ON sales_history_export(principal);
CREATE INDEX IF NOT EXISTS idx_she_kode_cust ON sales_history_export(kode_cust);
CREATE INDEX IF NOT EXISTS idx_she_jenis ON sales_history_export(jenis_transaksi);
