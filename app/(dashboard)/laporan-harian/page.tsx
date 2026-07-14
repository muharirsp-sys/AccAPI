/*
 * Tujuan: UI web modul Laporan Harian untuk upload FIX, memperbarui dashboard, meninjau penerima, lalu mengirim email setelah konfirmasi.
 * Caller: menu sidebar "Laporan Harian" (/laporan-harian). Guard RBAC: laporan_harian.view.
 * Dependensi: POST /api/laporan-harian/upload, POST /api/laporan-harian/[runId]/send.
 * Main Functions: LaporanHarianPage, handleUpload, handleSend.
 * Side Effects: HTTP call; tidak menyimpan state di localStorage.
 */
"use client";

import { useState } from "react";

type Summary = { spv: string; rows: number; dpp: number; ao: number; ec: number; ia: number };
type Recipient = { keyword: string; spv: string; fileName: string; emails: string[] };
type UploadResult = {
    ok: boolean; runId: string; period: { month: number; year: number };
    dashboardFed: { inserted: number }; salesRows: number; netDpp: number;
    summary: Summary[]; recipientsPreview: Recipient[]; totalRecipients: number;
};

const rupiah = (n: number) => "Rp " + Math.round(n).toLocaleString("id-ID");

export default function LaporanHarianPage() {
    const [penjualan, setPenjualan] = useState<File | null>(null);
    const [retur, setRetur] = useState<File | null>(null);
    const [stock, setStock] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<UploadResult | null>(null);
    const [sendState, setSendState] = useState<{ status: string; sent?: number; failed?: number } | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function handleUpload() {
        if (!penjualan) { setError("Pilih file Penjualan (rincian faktur INV) dulu."); return; }
        setError(null); setResult(null); setSendState(null); setBusy(true);
        try {
            const fd = new FormData();
            fd.append("penjualan", penjualan);
            if (retur) fd.append("retur", retur);
            if (stock) fd.append("stock", stock);
            const resp = await fetch("/api/laporan-harian/upload", { method: "POST", body: fd });
            const data = await resp.json();
            if (!resp.ok || !data.ok) {
                setError([data.error, data.detail].filter(Boolean).join(": ") || "Proses gagal");
                return;
            }
            setResult(data);
        } catch (e) {
            setError("Gagal upload/proses: " + String(e));
        } finally { setBusy(false); }
    }

    async function handleSend() {
        if (!result) return;
        const total = result.totalRecipients;
        if (!confirm(`Kirim email laporan ke ${total} penerima untuk ${result.recipientsPreview.length} file?\nTindakan ini benar-benar mengirim email.`)) return;
        setBusy(true); setError(null);
        try {
            const resp = await fetch(`/api/laporan-harian/${result.runId}/send`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm: true }),
            });
            const data = await resp.json();
            if (!resp.ok) { setError(data.error || "Kirim gagal"); return; }
            setSendState({ status: data.status, sent: data.emailsSent, failed: data.emailsFailed });
        } catch (e) {
            setError("Gagal kirim: " + String(e));
        } finally { setBusy(false); }
    }

    return (
        <main className="ui-page-shell ui-page-shell--standard space-y-6" aria-busy={busy}>
            <header className="ui-page-header">
                <h1 className="ui-page-title">Laporan Harian per SPV</h1>
                <p className="ui-page-description">
                    Upload 3 laporan Accurate: <b>Penjualan</b> (rincian faktur INV) + <b>Retur</b> (RJN) + <b>Stock</b>.
                    Sistem memproses data per SPV, memperbarui dashboard, lalu menampilkan review sebelum email dikirim.
                </p>
            </header>

            <section className="ui-surface-panel space-y-4" aria-labelledby="laporan-upload-title">
                <h2 id="laporan-upload-title" className="text-base font-semibold">Pilih laporan sumber</h2>
                <div className="grid md:grid-cols-3 gap-4">
                    <label className="text-sm">
                        <span className="block mb-1 font-medium">Penjualan (wajib)</span>
                        <input type="file" accept=".xlsx" onChange={(e) => setPenjualan(e.target.files?.[0] ?? null)}
                            className="block min-h-11 w-full rounded-lg border p-2 text-sm" />
                    </label>
                    <label className="text-sm">
                        <span className="block mb-1 font-medium">Retur (opsional)</span>
                        <input type="file" accept=".xlsx" onChange={(e) => setRetur(e.target.files?.[0] ?? null)}
                            className="block min-h-11 w-full rounded-lg border p-2 text-sm" />
                    </label>
                    <label className="text-sm">
                        <span className="block mb-1 font-medium">Stock (opsional)</span>
                        <input type="file" accept=".xlsx" onChange={(e) => setStock(e.target.files?.[0] ?? null)}
                            className="block min-h-11 w-full rounded-lg border p-2 text-sm" />
                    </label>
                </div>
                <button onClick={handleUpload} disabled={busy || !penjualan}
                    className="ui-button-primary min-h-11 disabled:opacity-50">
                    {busy ? "Memproses..." : "Proses & Perbarui Dashboard"}
                </button>
                {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
            </section>

            {result && (
                <>
                    <section className="ui-surface-panel space-y-3" aria-labelledby="laporan-summary-title">
                        <h2 id="laporan-summary-title" className="font-semibold">Ringkasan (periode {result.period?.month}/{result.period?.year})</h2>
                        <p className="text-sm text-gray-500">
                            {result.salesRows.toLocaleString("id-ID")} baris, Net DPP {rupiah(result.netDpp)},
                            dashboard di-update: {result.dashboardFed?.inserted?.toLocaleString("id-ID")} baris.
                        </p>
                        <div className="ui-table-frame overflow-x-auto">
                            <table className="ui-data-table w-full text-sm">
                                <caption className="sr-only">Ringkasan laporan harian per SPV</caption>
                                <thead><tr className="text-left border-b">
                                    <th className="py-1">SPV</th><th>Baris</th><th>DPP</th><th>AO</th><th>EC</th><th>Item Aktif</th>
                                </tr></thead>
                                <tbody>
                                    {result.summary.map((s) => (
                                        <tr key={s.spv} className="border-b last:border-0">
                                            <td className="py-1 font-medium">{s.spv}</td>
                                            <td>{s.rows.toLocaleString("id-ID")}</td>
                                            <td>{rupiah(s.dpp)}</td><td>{s.ao}</td><td>{s.ec}</td><td>{s.ia}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <section className="ui-surface-panel space-y-3" aria-labelledby="laporan-recipient-title">
                        <h2 id="laporan-recipient-title" className="font-semibold">Preview Penerima ({result.totalRecipients} email), belum dikirim</h2>
                        <div className="overflow-x-auto max-h-72 overflow-y-auto">
                            <table className="ui-data-table w-full text-sm">
                                <caption className="sr-only">Daftar file dan penerima email laporan harian</caption>
                                <thead><tr className="text-left border-b"><th className="py-1">File</th><th>Keyword</th><th>Email</th></tr></thead>
                                <tbody>
                                    {result.recipientsPreview.map((r, i) => (
                                        <tr key={i} className="border-b last:border-0 align-top">
                                            <td className="py-1">{r.fileName}</td>
                                            <td>{r.keyword}</td>
                                            <td className="text-gray-600">{r.emails.join(", ")}</td>
                                        </tr>
                                    ))}
                                    {result.recipientsPreview.length === 0 && (
                                        <tr><td colSpan={3} className="py-2 text-gray-500">Tidak ada penerima yang cocok (cek mapping keyword).</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        <div className="flex items-center gap-3 pt-2">
                            <button onClick={handleSend} disabled={busy || result.totalRecipients === 0 || sendState?.status === "sent"}
                                className="ui-button-primary min-h-11 disabled:opacity-50">
                                {busy ? "Mengirim..." : "Kirim Email"}
                            </button>
                            {sendState && (
                                <span className="text-sm">
                                    Status: <b>{sendState.status}</b>, terkirim {sendState.sent ?? 0}
                                    {sendState.failed ? `, gagal ${sendState.failed}` : ""}
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-gray-400">
                            Email hanya terkirim setelah Anda konfirmasi. Pastikan SMTP di .env sudah benar.
                        </p>
                    </section>
                </>
            )}
        </main>
    );
}
