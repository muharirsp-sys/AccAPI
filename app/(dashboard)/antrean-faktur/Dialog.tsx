/*
 * Tujuan: Dialog layar Antrean Faktur (Fiori S6c, it02): Kirim (BL-39, isi kiriman dari pratinjau server), Selesaikan tidak pasti
 *   (BL-16/AM-047: hasil pencarian dulu, baru keputusan + alasan), Antre ulang (pencarian faktur dulu, owner E2), Buang (BL-17,
 *   alasan wajib di layar), dan Riwayat per order (BL-17). Menggantikan window.confirm/prompt halaman lama.
 * Caller: app/(dashboard)/antrean-faktur/AntreanFaktur.tsx.
 * Dependensi: GET /api/invoice-outbox/send/preview, POST /api/invoice-outbox/send, GET+POST /api/invoice-outbox/resolve,
 *   POST /api/invoice-outbox (resend/discard), GET /api/invoice-outbox/riwayat; components/fiori/*; ./bersama; lib/rekapan-nota/ui;
 *   lib/promo-ui (rupiah).
 * Main Functions: KirimDialog, SelesaikanDialog, AntreUlangDialog, BuangDialog, RiwayatDialog.
 * Side Effects: Kirim MENULIS FAKTUR DI ACCURATE (lewat server, sesi penekan). Selesaikan/Antre ulang/Buang mengubah antrean + riwayat.
 *   Pencarian faktur = GET baca-saja ke Accurate oleh server.
 */
"use client";

import { useCallback, useId, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import Dialog from "@/components/ui/Dialog";
import { Button, EmptyState, ErrorState, KeyValues, MessageStrip, Skeleton, StatusBadge } from "@/components/fiori/core";
import { ConfirmDialog, useLoad, type Load } from "@/components/fiori/interactive";
import { ambil, jamWita, tanggalPendek } from "@/lib/rekapan-nota/ui";
import { rupiah } from "@/lib/promo-ui";
import {
    STATUS, TidakPasti, kalimatAccurate, kalimatPencarian, nomorSo, pesanGagal, tulis, usia,
    type Pencarian, type Row,
} from "./bersama";

// ── Kirim (BL-39) ──────────────────────────────────────────────────────────────────────────────────────

export type OrderPratinjau = {
    orderId: string; soNo: string | null; principal: string; customerNo: string; orderDate: string; transDate: string;
    lines: number; dpp: number; ppn: number; total: number;
};
type Pratinjau = {
    ok: boolean;
    database: { tujuan: string; sesiPenekan: { id: string; alias: string }; cocok: boolean };
    maksPerTekan: number; jumlah: number; antreanMenunggu: number; ditolak?: string;
    perPrincipal: { principal: string; jumlah: number; dpp: number; ppn: number; total: number }[];
    total: { dpp: number; ppn: number; total: number };
    orders: OrderPratinjau[];
};
export type HasilKirim = {
    ok: boolean; sent: number; verifiedOk: number; mismatched: number; unchecked: number; rejected: number; unknown: number; remaining: number;
    results: { orderId: string; state: string; accurateId?: string; number?: string; error?: string }[];
    verified: { orderId: string; status: "cocok" | "selisih" | "tak-terperiksa"; reason?: string; invoiceNumber?: string }[];
    sentBy: string;
};

/** Kalimat database tanpa nama env/endpoint (aturan: istilah internal tidak tampil). */
function kalimatSesi(db: Pratinjau["database"]): string {
    if (!db.tujuan) return "Database tujuan faktur belum diatur di server — hubungi IT. Kirim akan ditolak.";
    if (!db.sesiPenekan.id) return "Sesi Accurate Anda belum lengkap — login Accurate dulu di menu API Wrapper, lalu buka dialog ini lagi.";
    return `Sesi Accurate Anda terbuka pada database ${db.sesiPenekan.alias || db.sesiPenekan.id}, bukan database faktur ${db.tujuan} — ganti database di API Wrapper.`;
}

function rentangTanggal(orders: OrderPratinjau[]): string {
    const unik = [...new Set(orders.map((o) => o.transDate).filter(Boolean))];
    if (unik.length === 0) return "tanggal SO masing-masing";
    return unik.length <= 3 ? `tanggal SO masing-masing (${unik.join(", ")})` : `tanggal SO masing-masing (${unik.length} tanggal berbeda)`;
}

function urlPratinjau(dipilih: string[], tanggal: string) {
    const q = new URLSearchParams();
    for (const id of dipilih) q.append("orderId", id);
    if (tanggal) q.set("invoiceDate", tanggal);
    return `/api/invoice-outbox/send/preview?${q}`;
}
/** Yang menentukan isi kiriman: database, penolakan, dan per order kunci + nilai + tanggal. */
const sidikPratinjau = (p: Pratinjau) => JSON.stringify([p.database.cocok, p.database.tujuan, p.ditolak ?? "", p.orders.map((o) => [o.orderId, o.total, o.transDate])]);

/**
 * Dialog Kirim. Isinya dari pratinjau server (kueri & urutan yang sama dengan Kirim). Yang dikirim = `orderIds` HASIL PRATINJAU,
 * bukan "semua yang antre": antrean bisa bertambah sesudah pratinjau, dan yang terkirim harus sama dengan yang dibaca petugas.
 */
export function KirimDialog({ dipilih, tanggal, saringanAktif, onClose, onTerkirim, onTidakPasti }: {
    dipilih: string[]; tanggal: string; saringanAktif?: boolean; onClose: () => void;
    onTerkirim: (hasil: HasilKirim, urutan: OrderPratinjau[]) => void; onTidakPasti: (pesan: string) => void;
}) {
    const url = urlPratinjau(dipilih, tanggal);
    const [pratinjau, muatUlang] = useLoad(useCallback((): Promise<Load<Pratinjau>> => ambil<Pratinjau>(url, (j) => j as Pratinjau), [url]));
    // Pratinjau yang diperiksa ulang saat Kirim dan ternyata berubah: menggantikan yang tampil sampai dimuat ulang.
    const [baru, setBaru] = useState<Pratinjau | null>(null);
    const p = baru ?? (pratinjau.status === "siap" ? pratinjau.data : undefined);
    const lebih = p && dipilih.length > p.maksPerTekan ? dipilih.length - p.orders.length : 0;
    const keluar = p && dipilih.length && !lebih ? dipilih.length - p.orders.length : 0;

    const blok = !p && pratinjau.status === "memuat" ? "Menyiapkan ringkasan kiriman…"
        : !p ? "Ringkasan kiriman gagal dimuat — coba lagi"
            : !p.database.cocok ? "Sesi Accurate Anda tidak cocok dengan database tujuan"
                : p.ditolak ? "Ada faktur yang tidak bisa dikirim — lihat pesan"
                    : p.jumlah === 0 ? "Tidak ada faktur antre untuk dikirim" : undefined;

    const kirim = async () => {
        if (!p) return;
        // Pratinjau bisa basi (antrean bertambah/berubah selagi dialog terbuka): periksa ulang TEPAT sebelum mengirim.
        const cek = await ambil<Pratinjau>(url, (j) => j as Pratinjau);
        if (cek.status !== "siap" || !cek.data) throw new Error(`Pratinjau tidak bisa diperiksa ulang (${cek.error ?? "tanpa jawaban"}); tidak ada faktur dikirim.`);
        if (sidikPratinjau(cek.data) !== sidikPratinjau(p)) {
            setBaru(cek.data);
            throw new Error("Pratinjau berubah sejak dialog dibuka — periksa lagi isi di atas, lalu tekan Kirim. Tidak ada faktur dikirim.");
        }
        // Server memperlakukan orderIds kosong sebagai "semua yang antre": jangan pernah mengirimnya kosong.
        if (cek.data.orders.length === 0) throw new Error("Tidak ada faktur antre untuk dikirim; tidak ada yang dikirim.");
        try {
            const { status, data } = await tulis("/api/invoice-outbox/send",
                { orderIds: cek.data.orders.map((o) => o.orderId), invoiceDate: tanggal || undefined }, { batasMs: 620_000 });
            // 200 = hasil per order (ok=false bila ada tidak pasti/selisih — tetap hasil, bukan galat). 4xx = tidak ada yang dikirim.
            if (status !== 200 || !Array.isArray(data.results)) throw new Error(pesanGagal(status, data, "Pengiriman ditolak server; tidak ada faktur dikirim."));
            onTerkirim(data as unknown as HasilKirim, p.orders);
        } catch (e) {
            if (e instanceof TidakPasti) { onTidakPasti(e.message); return; }
            throw e;
        }
    };

    return (
        <ConfirmDialog open onClose={onClose} tag="BL-39" title={p ? `Kirim ${p.jumlah} faktur ke Accurate?` : "Kirim faktur ke Accurate?"}
            confirmLabel={p ? `Kirim ${p.jumlah} faktur` : "Kirim"} confirmDisabled={blok} onConfirm={kirim}>
            {!p && pratinjau.status === "memuat" && <Skeleton rows={5} label="Menyiapkan ringkasan kiriman" />}
            {!p && pratinjau.status === "galat" && <ErrorState title="Ringkasan kiriman gagal dimuat" message={pratinjau.error} onRetry={() => { setBaru(null); muatUlang(); }} />}
            {p && (
                <>
                    <KeyValues items={[
                        ["Database tujuan", p.database.cocok && p.database.sesiPenekan.alias ? `${p.database.sesiPenekan.alias} (${p.database.tujuan})` : p.database.tujuan || "Belum diatur"],
                        ["Sesi Accurate Anda", p.database.cocok
                            ? <StatusBadge tone="pos">Sama dengan tujuan</StatusBadge>
                            : <StatusBadge tone="neg">Tidak cocok</StatusBadge>],
                        ["Faktur", `${p.jumlah} (maks. ${p.maksPerTekan} per tekan)`],
                        ["Per principal", p.perPrincipal.length
                            ? <span>{p.perPrincipal.map((x) => <span key={x.principal} className="fi-sub">{x.principal} · {x.jumlah} · {rupiah(x.total)}</span>)}</span>
                            : "–"],
                        ["Nilai (DPP + PPN 11%)", <span key="n">{rupiah(p.total.total)}<span className="fi-sub">DPP {rupiah(p.total.dpp)} · PPN {rupiah(p.total.ppn)} · perkiraan, Accurate membulatkan PPN sendiri</span></span>],
                        ["Tanggal faktur", tanggal ? `${tanggalPendek(tanggal)} untuk semua faktur` : rentangTanggal(p.orders)],
                    ]} />
                    {!p.database.cocok && <MessageStrip tone="neg" title="Kirim akan ditolak.">{kalimatSesi(p.database)}</MessageStrip>}
                    {p.ditolak && <MessageStrip tone="neg" title="Tidak ada faktur dikirim.">{p.ditolak}</MessageStrip>}
                    {lebih > 0 && <MessageStrip tone="info">Anda memilih {dipilih.length} baris; maks. {p.maksPerTekan} per tekan — {lebih} sisanya tidak ikut kali ini.</MessageStrip>}
                    {keluar > 0 && <MessageStrip tone="info">{keluar} baris pilihan tidak lagi berstatus Antre dan tidak ikut dikirim.</MessageStrip>}
                    {!dipilih.length && saringanAktif && (
                        <MessageStrip tone="info" title="Saringan di layar tidak membatasi Kirim.">Tanpa pilihan, yang antre paling lama ikut — periksa daftar di bawah, atau batalkan lalu pilih barisnya.</MessageStrip>
                    )}
                    {!dipilih.length && p.antreanMenunggu > p.jumlah && (
                        <MessageStrip tone="info">{p.antreanMenunggu - p.jumlah} faktur lainnya tetap antre (maks. {p.maksPerTekan} per tekan).</MessageStrip>
                    )}
                    {p.orders.length > 0 && (
                        <details>
                            <summary className="fi-small">Daftar {p.orders.length} faktur yang dikirim</summary>
                            <KeyValues items={p.orders.map((o) => [o.soNo ?? o.orderId, `${o.principal} · ${o.customerNo} · ${o.lines} baris · ${rupiah(o.total)}`])} />
                        </details>
                    )}
                    <MessageStrip tone="warn" title="Faktur yang terbentuk di Accurate tidak bisa ditarik dari aplikasi ini.">
                        Setelah terkirim, isinya dibaca balik dan dibandingkan per baris. Bila Accurate tidak menjawab, faktur itu ditandai Tidak pasti dan
                        pengiriman berhenti. Dikirim dengan sesi Accurate Anda; nama Anda tercatat sebagai pengirim.
                    </MessageStrip>
                </>
            )}
        </ConfirmDialog>
    );
}

// ── Selesaikan tidak pasti (BL-16 / AM-047) ────────────────────────────────────────────────────────────

type HasilCari = {
    pencarian: Pencarian; faktur: { tanggal: string; total: number | null } | null;
    dikirim: { dpp: number; ppn: number; total: number } | null; sisaMenit: number;
};
type Keputusan = "terposting" | "tidak_terposting";

function BlokPencarian({ cari }: { cari: HasilCari }) {
    const p = cari.pencarian;
    if (p.hasil === "gagal_cek") {
        return <MessageStrip tone="neg" title="Pencarian tidak bisa memastikan.">{p.alasan}. Tidak ada keputusan yang bisa disimpan; ulangi setelah sesi Accurate Anda aktif.</MessageStrip>;
    }
    if (p.hasil === "ketemu") {
        return (
            <div className="fi-panel" style={{ boxShadow: "none", border: "1px solid var(--line)" }} role="status">
                <span className="fi-small fi-subtle">
                    Ditemukan {p.sumber === "cache" ? "di salinan lokal, dikonfirmasi ke Accurate" : "langsung di Accurate"} · cocok lewat{" "}
                    {p.cocok === "charField1" ? "kunci antrean di kepala faktur" : p.cocok === "baris" ? "kunci antrean di baris faktur" : "keterangan faktur"}
                </span>
                <b className="fi-mono">{p.number || `id ${p.id}`}</b>
                <KeyValues items={[
                    ["Tanggal faktur", cari.faktur?.tanggal || "belum tersalin ke aplikasi"],
                    ["Total di Accurate", cari.faktur?.total != null ? rupiah(cari.faktur.total) : "belum tersalin ke aplikasi"],
                    ["Nilai yang dikirim", cari.dikirim ? rupiah(cari.dikirim.total) : "–"],
                ]} />
                {p.semua.length > 1 && (
                    <MessageStrip tone="neg" title={`${p.semua.length} faktur membawa kunci SO ini — kemungkinan faktur ganda.`}>
                        {p.semua.map((f) => f.number || f.id).join(", ")}. Tetapkan terposting memakai {p.number || p.id}; faktur lainnya dibereskan di Accurate.
                    </MessageStrip>
                )}
            </div>
        );
    }
    return (
        <div className="fi-panel" style={{ boxShadow: "none", border: "1px solid var(--line)" }} role="status">
            <b>Tidak ditemukan di Accurate</b>
            <span className="fi-small fi-subtle">
                {p.diperiksa} faktur pelanggan ini sejak SO masuk antrean diperiksa satu per satu; tidak satu pun membawa kunci SO ini.
                Ini bukan bukti mutlak — faktur yang kuncinya terhapus tidak dikenali.
            </span>
            {p.calon_tanpa_kunci.length > 0 && (
                <>
                    <MessageStrip tone="warn" title={`${p.calon_tanpa_kunci.length} faktur pelanggan ini tanpa kunci antrean.`}>
                        Periksa di Accurate apakah salah satunya SO ini sebelum menetapkan tidak terposting.
                    </MessageStrip>
                    <KeyValues items={p.calon_tanpa_kunci.map((c) => [c.number || `id ${c.id}`, `${c.transDate || "tanggal ?"} · ${c.totalAmount != null ? rupiah(c.totalAmount) : "total ?"}`])} />
                </>
            )}
            {cari.dikirim && <span className="fi-small">Nilai yang dikirim: {rupiah(cari.dikirim.total)}</span>}
        </div>
    );
}

/**
 * Selesaikan TIDAK PASTI: hasil pencarian server tampil DULU (GET, baca-saja), baru pilihan keputusan + alasan ≥ 15 karakter.
 * Server mencari ULANG saat menyimpan; hasil yang bertentangan / masa tunggu = 409 dan layar diperbarui dari jawabannya.
 */
export function SelesaikanDialog({ row, onClose, onSelesai, onTidakPasti }: {
    row: Row; onClose: () => void; onSelesai: (pesan: string) => void; onTidakPasti: (pesan: string) => void;
}) {
    const nama = useId();
    const [load, cariLagi] = useLoad(useCallback(() => ambil<HasilCari>(`/api/invoice-outbox/resolve?orderId=${encodeURIComponent(row.orderId)}`,
        (j) => j as HasilCari, 120_000), [row.orderId]));
    // Jawaban 409 POST membawa pencarian/masa tunggu terbaru: menimpa yang tampil sampai dicari lagi.
    // `berubah` = jenis hasil pencarian di jawaban 409 beda dengan yang tadi dibaca petugas (alasannya mungkin tidak berlaku lagi).
    const [timpa, setTimpa] = useState<{ dari: HasilCari; isi: Partial<HasilCari>; berubah: boolean } | null>(null);
    const [pilih, setPilih] = useState<Keputusan | "">("");
    const cari = load.status === "siap" && load.data ? { ...load.data, ...(timpa?.dari === load.data ? timpa.isi : {}) } : undefined;
    const p = cari?.pencarian;
    // Tidak pernah dipilih otomatis: keputusan + alasan selalu dari petugas, juga setelah hasil pencarian berubah.
    const keputusan: Keputusan | "" = pilih;

    const alasanTidak = !p ? "Menunggu hasil pencarian"
        : p.hasil === "ketemu" ? "Tidak tersedia: faktur ditemukan — mengirim ulang akan membuat faktur ganda."
            : p.hasil === "gagal_cek" ? "Tidak tersedia: pencarian tidak bisa memastikan."
                : cari!.sisaMenit > 0 ? `Tersedia ${cari!.sisaMenit} menit lagi: kiriman terakhir mungkin masih diproses Accurate.` : "";
    const alasanYa = !p ? "Menunggu hasil pencarian" : p.hasil === "ketemu" ? ""
        : p.hasil === "gagal_cek" ? "Tidak tersedia: pencarian tidak bisa memastikan." : "Tidak tersedia: faktur tidak ditemukan oleh pencarian.";
    const blok = load.status === "memuat" ? "Menunggu hasil pencarian"
        : !cari ? "Pencarian belum berhasil — cari lagi"
            : !keputusan ? "Pilih hasil dulu"
                : keputusan === "terposting" ? alasanYa || undefined : alasanTidak || undefined;

    const simpan = async (alasan: string) => {
        try {
            const { status, data } = await tulis("/api/invoice-outbox/resolve", { orderId: row.orderId, keputusan, alasan }, { batasMs: 150_000 });
            if (status === 200 && data.ok) {
                onSelesai(data.state === "posted"
                    ? `SO ${nomorSo(row)} ditetapkan terposting sebagai ${String(data.number || data.accurateId)}. Baris ikut verifikasi balik.`
                    : `SO ${nomorSo(row)} ditetapkan tidak terposting dan kini berstatus Ditolak. Antre ulang akan mencari fakturnya lagi sebelum mengantrekan.`);
                return;
            }
            if (status === 409 && cari && load.data && (data.pencarian || typeof data.sisaMenit === "number")) {
                const pencarian = data.pencarian as Pencarian | undefined;
                setTimpa({ dari: load.data, berubah: Boolean(pencarian && pencarian.hasil !== cari.pencarian.hasil), isi: {
                    ...(pencarian ? { pencarian } : {}),
                    ...(typeof data.sisaMenit === "number" ? { sisaMenit: data.sisaMenit } : {}),
                } });
                setPilih("");
            }
            throw new Error(pesanGagal(status, data, "Penyelesaian ditolak server; tidak ada yang diubah."));
        } catch (e) {
            if (e instanceof TidakPasti) { onTidakPasti(e.message); return; }
            throw e;
        }
    };

    const opsi: Array<{ k: Keputusan; judul: string; ket: string; tidak: string }> = [
        { k: "terposting", judul: p?.hasil === "ketemu" ? `Tetapkan terposting sebagai ${p.number || p.id}` : "Tetapkan terposting",
            ket: "Baris pindah ke Terposting dan ikut verifikasi balik.", tidak: alasanYa },
        { k: "tidak_terposting", judul: "Tetapkan tidak terposting",
            ket: "Baris menjadi Ditolak; Antre ulang mencari fakturnya lagi sebelum mengantrekan.", tidak: alasanTidak },
    ];

    return (
        <ConfirmDialog open onClose={onClose} tag="BL-16" title="Selesaikan faktur tidak pasti"
            description={<>SO <span className="fi-mono">{nomorSo(row)}</span> · {row.outlet || row.customerNo} · dicoba {row.attempts}×, terakhir {jamWita(row.updatedAt)} WITA.
                {row.lastError ? ` ${kalimatAccurate(row.lastError)}` : ""}</>}
            reason={{ label: "Alasan", min: 15, placeholder: "Apa yang diperiksa dan di mana, mis. dicek di Accurate › Faktur Penjualan, pelanggan dan tanggal yang sama" }}
            confirmLabel={keputusan === "tidak_terposting" ? "Tetapkan tidak terposting" : keputusan === "terposting" ? "Tetapkan terposting" : "Simpan penyelesaian"}
            confirmDisabled={blok} onConfirm={simpan}>
            {load.status === "memuat" && <Skeleton rows={3} label="Mencari faktur di Accurate dengan sesi Anda (bisa sampai 1–2 menit)" />}
            {load.status === "galat" && <ErrorState title="Pencarian faktur gagal" message={load.error} onRetry={cariLagi} />}
            {cari && (
                <>
                    {timpa?.dari === load.data && timpa.berubah && (
                        <MessageStrip tone="warn" title="Hasil pencarian berubah saat disimpan.">
                            Sekarang: {kalimatPencarian(cari.pencarian)}. Pilih keputusan lagi dan sesuaikan alasan Anda dengan hasil ini.
                        </MessageStrip>
                    )}
                    <BlokPencarian cari={cari} />
                    <div role="radiogroup" aria-label="Hasil penyelesaian" className="fi-sect-in" style={{ padding: 0 }}>
                        {opsi.map((o) => (
                            <label key={o.k} className="fi-check" style={{ alignItems: "flex-start" }}>
                                <input type="radio" name={nama} value={o.k} checked={keputusan === o.k} disabled={Boolean(o.tidak)} onChange={() => setPilih(o.k)} />
                                <span><b>{o.judul}</b><span className="fi-sub">{o.tidak || o.ket}</span></span>
                            </label>
                        ))}
                    </div>
                    <div className="fi-btnrow"><Button variant="tertiary" onClick={() => { setTimpa(null); setPilih(""); cariLagi(); }}>Cari lagi</Button></div>
                </>
            )}
        </ConfirmDialog>
    );
}

// ── Antre ulang (Ditolak, owner E2) & Buang (BL-17) ────────────────────────────────────────────────────

export type HasilAksi = { tone: "pos" | "warn"; judul: string; isi?: ReactNode; riwayat?: Row };

const faktaBaris = (row: Row): Array<[string, ReactNode]> => [
    ["SO", <span key="so" className="fi-mono">{nomorSo(row)}</span>],
    ["Outlet", row.outlet ? `${row.outlet} · ${row.customerNo}` : row.customerNo],
    ["Status", row.state === "queued" ? "Antre, belum pernah dikirim" : `${STATUS[row.state].label}, dicoba ${row.attempts}×`],
    ...(row.lastError ? [["Jawaban Accurate", kalimatAccurate(row.lastError)] as [string, ReactNode]] : []),
];

/** Antre ulang baris Ditolak: server SELALU mencari fakturnya dulu (ketemu = terposting, tidak dikirim). */
export function AntreUlangDialog({ row, onClose, onSelesai, onTidakPasti }: {
    row: Row; onClose: () => void; onSelesai: (hasil: HasilAksi) => void; onTidakPasti: (pesan: string) => void;
}) {
    const jalankan = async () => {
        try {
            const { status, data } = await tulis("/api/invoice-outbox", { orderId: row.orderId, action: "resend" }, { batasMs: 150_000 }); // pencarian faktur s.d. 90 dtk
            if (status !== 200 || !data.ok) throw new Error(pesanGagal(status, data, "Antre ulang ditolak server; tidak ada yang diubah."));
            const p = data.pencarian as Pencarian | undefined;
            if (data.state === "posted") {
                onSelesai({ tone: "pos", judul: `Faktur ${String(data.number || data.accurateId)} sudah ada di Accurate.`,
                    isi: `SO ${nomorSo(row)} ditandai Terposting dan tidak dikirim ulang (${kalimatPencarian(p)}).` });
                return;
            }
            const calon = p?.hasil === "tidak_ketemu_dicek" ? p.calon_tanpa_kunci : [];
            onSelesai({
                tone: calon.length ? "warn" : "pos", judul: `SO ${nomorSo(row)} kembali ke antrean.`,
                isi: <>Pencarian: {kalimatPencarian(p)}. Belum dikirim — kirim lewat tombol Kirim.
                    {calon.length > 0 && <> Perhatian: {calon.length} faktur pelanggan ini tanpa kunci antrean ({calon.map((c) => `${c.number || c.id}${c.totalAmount != null ? ` ${rupiah(c.totalAmount)}` : ""}`).join(", ")}) — periksa di Accurate sebelum Kirim.</>}</>,
            });
        } catch (e) {
            if (e instanceof TidakPasti) { onTidakPasti(e.message); return; }
            throw e;
        }
    };
    return (
        <ConfirmDialog open onClose={onClose} tag="Ditolak" title={`Antre ulang SO ${nomorSo(row)}?`} facts={faktaBaris(row)}
            description="Sebelum diantrekan, server mencari faktur SO ini di Accurate dengan sesi Accurate Anda. Ketemu: baris menjadi Terposting dan tidak dikirim. Tidak ketemu: baris kembali Antre (belum dikirim). Pencarian gagal: tidak ada yang berubah."
            confirmLabel="Cari lalu antre ulang" onConfirm={jalankan} />
    );
}

/** Buang baris Antre/Ditolak. Alasan wajib di layar (server mencatatnya di event `buang` bersama salinan baris). */
export function BuangDialog({ row, onClose, onSelesai, onTidakPasti }: {
    row: Row; onClose: () => void; onSelesai: (hasil: HasilAksi) => void; onTidakPasti: (pesan: string) => void;
}) {
    const jalankan = async (alasan: string) => {
        try {
            const { status, data } = await tulis("/api/invoice-outbox", { orderId: row.orderId, action: "discard", reason: alasan });
            if (status !== 200 || !data.ok) throw new Error(pesanGagal(status, data, "Buang ditolak server; tidak ada yang diubah."));
            onSelesai({ tone: "pos", judul: `SO ${nomorSo(row)} dibuang dari antrean.`, isi: "Isi baris dan alasannya tersimpan di riwayat.", riwayat: row });
        } catch (e) {
            if (e instanceof TidakPasti) { onTidakPasti(e.message); return; }
            throw e;
        }
    };
    return (
        <ConfirmDialog open onClose={onClose} tone="negative" tag="BL-17" title="Buang 1 baris dari antrean?" facts={faktaBaris(row)}
            description="Fakturnya belum ada di Accurate. Baris dihapus dari antrean; isinya dan alasan Anda tersimpan di riwayat. SO bisa diantrekan lagi dari Order Principal setelah angkanya diperbaiki — saat itu server mencari fakturnya di Accurate dulu."
            reason={{ label: "Alasan buang", placeholder: "mis. harga kategori di batch salah; diunggah ulang setelah diperbaiki" }}
            confirmLabel="Buang baris" onConfirm={jalankan} />
    );
}

// ── Riwayat (BL-17) ────────────────────────────────────────────────────────────────────────────────────

type Event = {
    id: number; jenis: string; stateFrom: string | null; stateTo: string | null; actor: string; httpStatus: number | null;
    errorCode: string; reason: string; createdAt: string; detail: Record<string, unknown> | null;
};

function kalimatEvent(e: Event): { apa: string; ubah?: string } {
    const d = e.detail ?? {};
    const p = d.pencarian as Pencarian | undefined;
    switch (e.jenis) {
        case "antre": return { apa: "Masuk antrean", ubah: p ? `Pernah dibuang; pencarian: ${kalimatPencarian(p)}` : undefined };
        case "kirim": return { apa: `Dikirim ke Accurate (percobaan ke-${String(d.attempt ?? "?")})`,
            ubah: [d.target_db ? `database ${String(d.target_db)}` : "", d.trans_date ? `tanggal faktur ${String(d.trans_date)}` : ""].filter(Boolean).join(" · ") || undefined };
        case "posted": return e.stateFrom === "sending"
            ? { apa: `Terposting${d.number ? ` sebagai ${String(d.number)}` : ""}` }
            : { apa: "Ditandai terposting tanpa dikirim", ubah: e.reason || kalimatPencarian(p) };
        case "rejected": return { apa: "Ditolak Accurate", ubah: kalimatAccurate(e.reason) };
        case "unknown": return { apa: "Tidak pasti", ubah: kalimatAccurate(e.reason) || (e.errorCode ? `galat ${e.errorCode}` : undefined) };
        case "buang": return { apa: "Dibuang dari antrean", ubah: e.reason ? `Alasan: ${e.reason}` : "tanpa alasan tercatat" };
        case "antre_ulang": return { apa: "Antre ulang", ubah: p ? `Pencarian: ${kalimatPencarian(p)}` : undefined };
        case "selesaikan": return { apa: e.stateTo === "posted" ? "Diselesaikan: ditetapkan terposting" : "Diselesaikan: ditetapkan tidak terposting",
            ubah: [e.reason ? `Alasan: ${e.reason}` : "", p ? `pencarian: ${kalimatPencarian(p)}` : ""].filter(Boolean).join(" · ") };
        case "sapu": return { apa: `Mengirim lebih dari 15 menit → Tidak pasti (otomatis)` };
        default: return { apa: e.jenis };
    }
}

export function RiwayatDialog({ row, onClose }: { row: Row; onClose: () => void }) {
    const judul = useId();
    const [load, muatUlang] = useLoad(useCallback(() => ambil<{ events: Event[]; terpotong: boolean }>(`/api/invoice-outbox/riwayat?orderId=${encodeURIComponent(row.orderId)}`,
        (j) => ({ events: (j as { events?: Event[] }).events ?? [], terpotong: Boolean((j as { terpotong?: boolean }).terpotong) })), [row.orderId]));
    return (
        <Dialog open onClose={onClose} labelledBy={judul} className="fi-dialog" closeOnBackdrop>
            <header>
                <div><span className="fi-tag" data-tone="info">BL-17</span><h2 id={judul}>Riwayat SO {nomorSo(row)}</h2></div>
                <button type="button" className="fi-btn fi-btn--icon" aria-label="Tutup" onClick={onClose}><X className="fi-icon" aria-hidden /></button>
            </header>
            <div className="fi-dialog-body">
                <p className="fi-small fi-subtle">Catatan tidak bisa diubah atau dihapus. Masuk antrean {jamWita(row.createdAt)} WITA · umur {usia(row.ageMinutes)}.</p>
                {load.status === "memuat" && <Skeleton rows={4} label="Memuat riwayat" />}
                {load.status === "galat" && <ErrorState title="Riwayat gagal dimuat" message={load.error} onRetry={muatUlang} />}
                {load.data?.terpotong && <MessageStrip tone="info">Menampilkan 200 catatan terbaru; catatan yang lebih tua tidak ditampilkan.</MessageStrip>}
                {load.status === "siap" && (load.data?.events.length ? (
                    <ol className="fi-hist" aria-label={`Riwayat SO ${nomorSo(row)}`}>
                        {load.data.events.map((e) => {
                            const k = kalimatEvent(e);
                            return (
                                <li key={e.id}>
                                    <time dateTime={e.createdAt}>{jamWita(e.createdAt)}</time>
                                    <span><b>{k.apa}</b> · {e.actor || "sistem"}{e.httpStatus ? ` · HTTP ${e.httpStatus}` : ""}</span>
                                    {k.ubah && <span className="fi-chg">{k.ubah}</span>}
                                </li>
                            );
                        })}
                    </ol>
                ) : <EmptyState title="Belum ada riwayat" message="Baris ini masuk antrean sebelum riwayat mulai dicatat." />)}
            </div>
            <footer><Button onClick={onClose}>Tutup</Button></footer>
        </Dialog>
    );
}
