/*
 * Tujuan: Layar "Rekaman pembayaran" (Fiori S6a, it08 List Report): tile status sekaligus saringan, FilterBar (cari, principal, tipe),
 *   tabel 8 kolom dengan kunci per baris dari server (`locked_reason`), pilihan HANYA di layar (tidak disimpan, tidak menyeberangi
 *   saringan, hanya baris Siap diajukan), draf isian per rekaman yang disimpan SATU PERMINTAAN PER REKAMAN (hasil per baris), lalu
 *   Buat keranjang. Pengganti grid 18 kolom + "Hapus Ceklis" + "Clear Semua" di page.tsx lama.
 * Caller: app/(dashboard)/payments/page.tsx (prop permKeys).
 * Dependensi: ./bersama (baca, tulis, RangkaPembayaran), ./RekamanDialog (dialog unggah/manual/keranjang/rincian/hapus),
 *   components/fiori/*, lib/payments-ui, lib/promo-ui (rupiah), next/navigation.
 * Main Functions: Rekaman (default), simpanDraf.
 * Side Effects: GET /payments/data; POST /payments/update per rekaman berubah (izin payments.update). Dialog: upload, manual/add,
 *   cart/create, delete (lihat RekamanDialog). beforeunload selama ada draf.
 *
 * Kenapa per rekaman: /payments/update menolak SEMUA item bila satu saja salah (angka AM-044, kunci BL-05 409). Spesifikasi it08
 * "baris lain tersimpan" hanya bisa dipenuhi tanpa mengubah server dengan mengirim tiap rekaman sebagai permintaan sendiri.
 * Centang `ajukan` lama TIDAK dikirim lagi: pilihan bukan data (A4-#32) — record_ids keranjang diambil dari layar.
 */
"use client";

import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Download, Lock, Plus, RefreshCw, ShoppingCart, Upload } from "lucide-react";
import { Button, FooterToolbar, ListItem, MessageStrip, ResponsiveTable, StatusBadge, type Column } from "@/components/fiori/core";
import { FilterBar, FormField, useLoad, useUnsavedGuard } from "@/components/fiori/interactive";
import {
    STATUS_REKAMAN, angka, bisaDiajukan, galatIsian, izinPembayaran, kurangLengkap, nilaiAwal, statusRekaman, tanggalTampil, tipeRekaman,
    type Draf, type Isian, type Rekaman as Baris, type StatusRekaman,
} from "@/lib/payments-ui";
import { rupiah } from "@/lib/promo-ui";
import { BELUM_PASTI, RangkaPembayaran, baca, tulis, unduhUrl } from "./bersama";
import { DialogHapus, DialogKeranjang, DialogManual, DialogUnggah, RincianRekaman } from "./RekamanDialog";

const KOSONG: ReadonlySet<string> = new Set();
const PAGE = 50;
const urutStatus: StatusRekaman[] = ["draf", "siap", "diajukan", "ulang", "transfer"];
const nama = (r: Baris) => r.no_lpb || r.record_id;
const dokumen = (r: Baris) => (tipeRekaman(r) === "NON_LPB" ? [r.nomor_dokumen, r.jenis_dokumen].filter(Boolean).join(" · ") : r.invoice_no || r.invoice || "");

export default function Rekaman({ permKeys }: { permKeys: string[] }) {
    const router = useRouter();
    const izin = izinPembayaran(permKeys);
    const [load, muat] = useLoad(useCallback(() => baca("/payments/data", (d) => (Array.isArray(d.data) ? (d.data as Baris[]) : undefined)), []));
    const rows = useMemo(() => load.data ?? [], [load.data]);
    const byId = useMemo(() => new Map(rows.map((r) => [r.record_id, r])), [rows]);

    // Saringan
    const [tile, setTile] = useState<StatusRekaman | null>(null);
    const [cari, setCari] = useState("");
    const [principal, setPrincipal] = useState("");
    const [tipe, setTipe] = useState("");
    const [hal, setHal] = useState(1);
    const principals = useMemo(() => [...new Set(rows.map((r) => (r.principle ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "id")), [rows]);
    const q = cari.trim().toLowerCase();
    const tersaring = useMemo(() => rows.filter((r) =>
        (!q || [r.no_lpb, r.record_id, r.invoice_no, r.nomor_dokumen, r.principle].some((v) => String(v ?? "").toLowerCase().includes(q)))
        && (!principal || (r.principle ?? "").trim() === principal)
        && (!tipe || tipeRekaman(r) === tipe)), [rows, q, principal, tipe]);
    const jumlahTile = useMemo(() => {
        const n: Record<StatusRekaman, number> = { draf: 0, siap: 0, diajukan: 0, ulang: 0, transfer: 0 };
        for (const r of tersaring) n[statusRekaman(r)] += 1;
        return n;
    }, [tersaring]);
    const terlihat = useMemo(() => (tile ? tersaring.filter((r) => statusRekaman(r) === tile) : tersaring), [tersaring, tile]);
    const nHal = Math.max(1, Math.ceil(terlihat.length / PAGE));
    const halAktif = Math.min(hal, nHal);
    const barisHal = terlihat.slice((halAktif - 1) * PAGE, halAktif * PAGE);
    const ubahSaring = (f: () => void) => { f(); setHal(1); };
    const hapusSaringan = () => ubahSaring(() => { setTile(null); setCari(""); setPrincipal(""); setTipe(""); });

    // Draf isian (per rekaman) + hasil simpan per baris
    const [draf, setDraf] = useState<Draf>({});
    const [galatBaris, setGalatBaris] = useState<Record<string, string>>({});
    const [ringkasSimpan, setRingkasSimpan] = useState<{ tone: "pos" | "neg" | "warn"; judul: string; isi?: string } | null>(null);
    const [menyimpan, setMenyimpan] = useState(false);
    // Jawaban tidak pasti → tulis dikunci sampai data selesai dimuat ulang (versi data berubah).
    const [kunciPada, setKunciPada] = useState<Baris[] | null>(null);
    const nIsian = Object.values(draf).reduce((a, d) => a + Object.keys(d).length, 0);
    const idDraf = Object.keys(draf).filter((id) => Object.keys(draf[id]).length > 0);
    useUnsavedGuard(nIsian > 0);

    const ubahIsian = (id: string, k: Isian, v: string) => setDraf((prev) => {
        const r = byId.get(id);
        const satu = { ...(prev[id] ?? {}) };
        if (r && v === nilaiAwal(r, k)) delete satu[k]; else satu[k] = v;
        const next = { ...prev, [id]: satu };
        if (Object.keys(satu).length === 0) delete next[id];
        return next;
    });

    // Pilihan = layar saja: hanya baris yang terlihat (lolos saringan), Siap diajukan, tanpa draf isian.
    const [pilihan, setPilihan] = useState<ReadonlySet<string>>(KOSONG);
    const bolehPilih = (r: Baris) => bisaDiajukan(r) && !draf[r.record_id];
    const dipilih = terlihat.filter((r) => pilihan.has(r.record_id) && bolehPilih(r));
    const total = dipilih.reduce((a, r) => a + (angka(r.nilai_invoice) || 0), 0);

    // Penanda baris baru setelah unggah/tambah manual: id yang belum ada sebelum aksi.
    const [sebelum, setSebelum] = useState<ReadonlySet<string> | null>(null);
    const baru = useMemo(() => (sebelum && load.status === "siap" ? new Set(rows.map((r) => r.record_id).filter((id) => !sebelum.has(id))) : KOSONG), [sebelum, rows, load.status]);
    const [pesan, setPesan] = useState<string | null>(null);

    const terkunci = kunciPada !== null && kunciPada === load.data;
    const kunciTulis = load.status === "galat" ? "Data gagal dimuat ulang; muat ulang dulu sebelum menulis."
        : load.status === "memuat" ? "Data sedang dimuat."
            : terkunci ? "Hasil tulis terakhir belum pasti; tunggu data selesai dimuat ulang." : undefined;

    const [dialog, setDialog] = useState<null | "unggah" | "manual" | "keranjang">(null);
    const [rincian, setRincian] = useState<string | null>(null);
    const [hapus, setHapus] = useState<string | null>(null);

    function setelahTulis(p: { pesan?: string; tandaiBaru?: boolean; tidakPasti?: boolean }) {
        if (p.tandaiBaru) setSebelum(new Set(rows.map((r) => r.record_id)));
        if (p.tidakPasti) setKunciPada(load.data ?? null);
        if (p.pesan) setPesan(p.pesan);
        muat();
    }

    /** Simpan draf: satu POST /payments/update per rekaman, berurutan; berhenti pada jawaban tidak pasti. */
    async function simpanDraf() {
        if (menyimpan) return;
        setMenyimpan(true);
        setRingkasSimpan(null);
        const ids = idDraf.filter((id) => byId.has(id));
        const gagal: Record<string, string> = {};
        const sukses: string[] = [];
        let tidakPasti = false;
        for (const id of ids) {
            const r = byId.get(id)!;
            const isi = draf[id];
            const item: Record<string, unknown> = { record_id: id, source_updated_at: r.updated_at ?? "" };
            for (const [k, v] of Object.entries(isi)) item[k] = k === "nilai_invoice" ? String(v).trim() : v;
            const res = await tulis("/payments/update", { items: [item] });
            if (res.ok) { sukses.push(id); continue; }
            if (res.tidakPasti) { tidakPasti = true; gagal[id] = "Hasil simpan belum pasti — periksa nilainya setelah dimuat ulang."; break; }
            gagal[id] = res.error;
        }
        setDraf((prev) => { const next = { ...prev }; for (const id of sukses) delete next[id]; return next; });
        setGalatBaris(gagal);
        const nGagal = Object.keys(gagal).length;
        const contoh = Object.entries(gagal).slice(0, 3).map(([id, e]) => `${nama(byId.get(id)!)}: ${e}`).join(" · ");
        if (tidakPasti) setRingkasSimpan({ tone: "warn", judul: `${sukses.length} dari ${ids.length} rekaman tersimpan; hasil sisanya belum pasti.`, isi: `${BELUM_PASTI} ${contoh}` });
        else if (nGagal) setRingkasSimpan({ tone: "neg", judul: `${sukses.length} dari ${ids.length} rekaman tersimpan.`, isi: `${nGagal} ditolak server — ${contoh}. Isian yang ditolak tetap di layar; perbaiki lalu simpan lagi. Perubahan lain sudah aman.` });
        else setRingkasSimpan({ tone: "pos", judul: `${sukses.length} rekaman tersimpan.` });
        if (tidakPasti) setKunciPada(load.data ?? null);
        setMenyimpan(false);
        muat();
    }

    const galatDraf = idDraf.flatMap((id) => Object.entries(draf[id]).map(([k, v]) => galatIsian(k as Isian, v ?? "")).filter(Boolean));
    const alasanSimpan = izin.ubah ?? kunciTulis ?? (galatDraf.length ? "Perbaiki isian yang bukan angka dulu." : undefined);
    const alasanKeranjang = izin.keranjang ?? kunciTulis ?? (nIsian ? "Simpan atau batalkan perubahan isian dulu." : dipilih.length === 0 ? "Pilih baris berstatus Siap diajukan." : undefined);

    const statusSel = (r: Baris): ReactNode => {
        const st = STATUS_REKAMAN[statusRekaman(r)];
        const kurang = statusRekaman(r) === "draf" ? kurangLengkap(r) : [];
        return (
            <span className="grid gap-1 justify-items-start">
                <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                {baru.has(r.record_id) && <StatusBadge tone="info">Baru</StatusBadge>}
                {draf[r.record_id] && <span className="fi-draft">Diubah, belum disimpan</span>}
                {(r.sppd_no || r.accurate_purchase_payment_number) && <span className="fi-codes">{[r.sppd_no, r.accurate_purchase_payment_number].filter(Boolean).join(" · ")}</span>}
                {kurang.length > 0 && <span className="fi-small fi-subtle">Kurang: {kurang.join(", ")}</span>}
                {r.locked_reason && <span className="fi-small fi-subtle"><Lock className="fi-icon" aria-hidden /> Terkunci: {r.locked_reason}</span>}
                {galatBaris[r.record_id] && <span className="fi-msg" role="alert">Ditolak: {galatBaris[r.record_id]}</span>}
            </span>
        );
    };
    const tampil = (r: Baris, k: Isian) => draf[r.record_id]?.[k] ?? nilaiAwal(r, k);
    const nilaiTampil = (r: Baris) => {
        const v = tampil(r, "nilai_invoice");
        const n = angka(v);
        return v.trim() === "" ? "—" : Number.isNaN(n) ? <span className="fi-why">{v}</span> : rupiah(n);
    };
    const selisih = (r: Baris) => {
        const win = typeof r.nilai_win === "number" ? r.nilai_win : angka(r.nilai_win_display ?? r.nilai_win);
        const inv = angka(tampil(r, "nilai_invoice"));
        if (!tampil(r, "nilai_invoice").trim() || Number.isNaN(inv) || Number.isNaN(win)) return "—";
        return rupiah(win - inv);
    };

    const kolom: Column<Baris>[] = [
        { key: "rekaman", header: "Rekaman", cell: (r) => (
            <span className="grid">
                <button type="button" className="fi-btn fi-btn--tertiary fi-mono" style={{ justifySelf: "start", paddingInline: 0 }} onClick={() => setRincian(r.record_id)} aria-label={`Buka rincian ${nama(r)}`}>{nama(r)}</button>
                <span className="fi-small fi-subtle">{tipeRekaman(r)}</span>
            </span>
        ) },
        { key: "principal", header: "Principal", cell: (r) => tampil(r, "principle") || "—" },
        { key: "invoice", header: "Invoice", cell: (r) => (tipeRekaman(r) === "NON_LPB" ? [tampil(r, "nomor_dokumen"), tampil(r, "jenis_dokumen")].filter(Boolean).join(" · ") : tampil(r, "invoice_no")) || "—" },
        { key: "tanggal", header: "Tanggal · JT", secondary: true, cell: (r) => `${tanggalTampil(tampil(r, "tgl_invoice"))} · JT ${tanggalTampil(tampil(r, "jt_invoice"))}` },
        { key: "nilai", header: "Nilai invoice", align: "end", cell: (r) => <span className="fi-tnum">{nilaiTampil(r)}</span> },
        { key: "selisih", header: "Selisih WIN", align: "end", secondary: true, cell: (r) => <span className="fi-tnum">{selisih(r)}</span> },
        { key: "status", header: "Status", cell: statusSel },
    ];

    const kotak = (r: Baris) => (
        <input type="checkbox" aria-label={`Pilih ${nama(r)}`} checked={pilihan.has(r.record_id) && bolehPilih(r)} disabled={!bolehPilih(r)}
            onChange={() => setPilihan((prev) => { const n = new Set(prev); if (n.has(r.record_id)) n.delete(r.record_id); else n.add(r.record_id); return n; })} />
    );

    const status = load.status;
    const disaring = Boolean(tile || q || principal || tipe);
    const chips = [
        ...(tile ? [{ label: `Status: ${STATUS_REKAMAN[tile].label}`, onRemove: () => ubahSaring(() => setTile(null)) }] : []),
        ...(principal ? [{ label: `Principal: ${principal}`, onRemove: () => ubahSaring(() => setPrincipal("")) }] : []),
        ...(tipe ? [{ label: `Tipe: ${tipe}`, onRemove: () => ubahSaring(() => setTipe("")) }] : []),
    ];

    return (
        <RangkaPembayaran halaman="rekaman" judul="Rekaman pembayaran" permKeys={permKeys}
            deskripsi="Tagihan principal dari LPB, CBD (bayar di muka), dan dokumen lain. Pilih baris yang siap, lalu buat keranjang pengajuan ke Finance."
            aksi={
                <>
                    {nIsian > 0 && <span className="fi-draft">Draf belum disimpan</span>}
                    <Button icon={<Upload className="fi-icon" aria-hidden />} disabled={Boolean(izin.unggah)} disabledReason={izin.unggah} onClick={() => setDialog("unggah")}>Unggah LPB</Button>
                    <Button icon={<Plus className="fi-icon" aria-hidden />} disabled={Boolean(izin.manual)} disabledReason={izin.manual} onClick={() => setDialog("manual")}>Tambah manual</Button>
                    <a className="fi-btn fi-btn--tertiary" href={unduhUrl("/payments/export")} target="_blank" rel="noopener noreferrer"><Download className="fi-icon" aria-hidden />Unduh backup</a>
                    <Button variant="icon" aria-label="Muat ulang" icon={<RefreshCw className="fi-icon" aria-hidden />} busy={load.status === "memuat" && rows.length > 0} onClick={muat} />
                </>
            }
        >
            {(izin.unggah || izin.ubah || izin.keranjang) && (
                <MessageStrip tone="info" title="Sebagian aksi nonaktif untuk akun Anda.">
                    {[izin.ubah, izin.unggah, izin.keranjang].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" ")}
                </MessageStrip>
            )}
            {status !== "galat" || rows.length > 0 ? (
                <div className="fi-kcards" role="group" aria-label="Saring menurut status">
                    {urutStatus.map((s) => (
                        <button key={s} type="button" className="fi-kc" aria-pressed={tile === s} onClick={() => ubahSaring(() => setTile(tile === s ? null : s))}
                            style={STATUS_REKAMAN[s].tone === "warn" ? ({ "--tf": "var(--warn)" } as CSSProperties) : undefined}>
                            <span>{STATUS_REKAMAN[s].label}</span>
                            <b>{load.data === undefined ? "–" : jumlahTile[s]}</b>
                            <small>{STATUS_REKAMAN[s].catatan}</small>
                        </button>
                    ))}
                </div>
            ) : null}
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {ringkasSimpan && <MessageStrip tone={ringkasSimpan.tone} title={ringkasSimpan.judul} onClose={() => setRingkasSimpan(null)}>{ringkasSimpan.isi}</MessageStrip>}
            <FilterBar title="Rekaman" activeCount={chips.length} chips={chips} onReset={hapusSaringan}
                search={
                    <FormField label="Cari">
                        {(a) => <input {...a} className="fi-input" type="search" placeholder="LPB, invoice, principal" value={cari} onChange={(e) => ubahSaring(() => setCari(e.target.value))} />}
                    </FormField>
                }
                fields={
                    <>
                        <FormField label="Principal">
                            {(a) => <select {...a} className="fi-input" value={principal} onChange={(e) => ubahSaring(() => setPrincipal(e.target.value))}>
                                <option value="">Semua principal</option>
                                {principals.map((p) => <option key={p} value={p}>{p}</option>)}
                            </select>}
                        </FormField>
                        <FormField label="Tipe">
                            {(a) => <select {...a} className="fi-input" value={tipe} onChange={(e) => ubahSaring(() => setTipe(e.target.value))}>
                                <option value="">LPB, CBD, NON_LPB</option><option value="LPB">LPB</option><option value="CBD">CBD</option><option value="NON_LPB">NON_LPB</option>
                            </select>}
                        </FormField>
                    </>
                }
            />
            <ResponsiveTable<Baris>
                title="Rekaman" count={terlihat.length} columns={kolom} rows={barisHal} rowKey={(r) => r.record_id} rowLabel={(r) => `Pilih ${nama(r)}`}
                status={status} error={load.error} onRetry={muat}
                selected={pilihan} onSelectedChange={setPilihan} selectableRow={bolehPilih}
                actions={nHal > 1 ? (
                    <div className="fi-btnrow" role="group" aria-label="Halaman tabel">
                        <span className="fi-small fi-subtle fi-tnum">{(halAktif - 1) * PAGE + 1}–{Math.min(halAktif * PAGE, terlihat.length)} dari {terlihat.length}</span>
                        <Button disabled={halAktif <= 1} onClick={() => setHal(halAktif - 1)}>Sebelumnya</Button>
                        <Button disabled={halAktif >= nHal} onClick={() => setHal(halAktif + 1)}>Berikutnya</Button>
                    </div>
                ) : undefined}
                empty={rows.length === 0
                    ? { title: "Belum ada rekaman pembayaran", message: "Unggah LPB dari templat, atau tambah pengajuan CBD/NON_LPB secara manual. Rekaman yang sudah diajukan tetap terlihat di tile Diajukan." }
                    : { title: "Tidak ada rekaman untuk saringan ini", message: `${rows.length} rekaman lain tersembunyi oleh saringan.`, action: <Button onClick={hapusSaringan}>Hapus saringan</Button> }}
                mobileItem={(r) => (
                    <div className="fi-wl-row">
                        {bisaDiajukan(r) && kotak(r)}
                        <ListItem doc={nama(r)} amount={nilaiTampil(r)} title={`${tampil(r, "principle") || "—"} · ${dokumen(r) || "invoice kosong"}`}
                            meta={r.locked_reason ? `Terkunci: ${r.locked_reason}` : galatBaris[r.record_id] ? `Ditolak: ${galatBaris[r.record_id]}` : draf[r.record_id] ? "Diubah, belum disimpan" : tanggalTampil(r.tgl_invoice)}
                            badge={<StatusBadge tone={STATUS_REKAMAN[statusRekaman(r)].tone}>{STATUS_REKAMAN[statusRekaman(r)].label}</StatusBadge>}
                            onClick={() => setRincian(r.record_id)} />
                    </div>
                )}
            />
            <p className="fi-small fi-subtle">Pilih semua hanya memilih baris di halaman tabel ini yang berstatus Siap diajukan. Pilihan tidak disimpan ke rekaman dan hilang bila saringan menyembunyikannya.{disaring && dipilih.length < pilihan.size ? ` ${pilihan.size - dipilih.length} pilihan lain tidak ikut karena tersembunyi saringan.` : ""}</p>

            {nIsian > 0 ? (
                <FooterToolbar message={alasanSimpan ? <span className="fi-why">{alasanSimpan}</span> : `${nIsian} isian di ${idDraf.length} rekaman belum disimpan. Tiap rekaman disimpan sendiri; yang ditolak tetap di layar.`}>
                    <Button variant="tertiary" disabled={menyimpan} onClick={() => { setDraf({}); setGalatBaris({}); }}>Batalkan perubahan</Button>
                    <Button variant="primary" busy={menyimpan} disabled={Boolean(alasanSimpan)} disabledReason={alasanSimpan} onClick={simpanDraf}>Simpan {nIsian} perubahan</Button>
                </FooterToolbar>
            ) : (
                <FooterToolbar message={dipilih.length > 0
                    ? <span className="fi-sum"><b>{dipilih.length} dipilih</b> · {rupiah(total)}{alasanKeranjang && <span className="fi-why"> · {alasanKeranjang}</span>}</span>
                    : <span className="fi-why">{alasanKeranjang}</span>}>
                    {dipilih.length > 0 && <Button variant="tertiary" onClick={() => setPilihan(KOSONG)}>Kosongkan pilihan</Button>}
                    <Button variant="primary" icon={<ShoppingCart className="fi-icon" aria-hidden />} disabled={Boolean(alasanKeranjang)} disabledReason={alasanKeranjang} onClick={() => setDialog("keranjang")}>
                        Buat keranjang…
                    </Button>
                </FooterToolbar>
            )}

            <DialogUnggah open={dialog === "unggah"} onClose={() => setDialog(null)} izin={izin.unggah} kunci={kunciTulis}
                onSelesai={(p) => { setDialog(null); setelahTulis({ ...p, tandaiBaru: true }); }} onTidakPasti={() => setelahTulis({ tidakPasti: true })} />
            <DialogManual open={dialog === "manual"} onClose={() => setDialog(null)} izin={izin.manual} kunci={kunciTulis}
                onSelesai={(p) => { setDialog(null); setelahTulis({ ...p, tandaiBaru: true }); }} onTidakPasti={() => setelahTulis({ tidakPasti: true })} />
            <DialogKeranjang open={dialog === "keranjang"} onClose={() => setDialog(null)} dipilih={dipilih} total={total} alasan={alasanKeranjang}
                onSelesai={(draftId) => router.push(`/payments/cart/${encodeURIComponent(draftId)}`)} onTidakPasti={() => setelahTulis({ tidakPasti: true })} />
            <RincianRekaman baris={rincian ? byId.get(rincian) ?? null : null} onClose={() => setRincian(null)} draf={rincian ? draf[rincian] ?? {} : {}}
                galat={rincian ? galatBaris[rincian] : undefined} izinUbah={izin.ubah ?? kunciTulis} izinHapus={izin.hapus ?? kunciTulis}
                onUbah={(k, v) => rincian && ubahIsian(rincian, k, v)} onHapus={() => { setHapus(rincian); setRincian(null); }} />
            <DialogHapus baris={hapus ? byId.get(hapus) ?? null : null} onClose={() => setHapus(null)} kunci={izin.hapus ?? kunciTulis}
                onSelesai={(p) => { setHapus(null); setDraf((prev) => { const n = { ...prev }; if (hapus) delete n[hapus]; return n; }); setelahTulis(p); }}
                onTidakPasti={() => setelahTulis({ tidakPasti: true })} />
        </RangkaPembayaran>
    );
}
