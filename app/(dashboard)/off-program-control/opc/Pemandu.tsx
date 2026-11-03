/*
 * Tujuan: Pemandu OFF Program Control ala tutorial game (owner 3 Nov 2026): papan "Misi Anda" (pekerjaan yang menunggu peran ini +
 *   yang lewat batas waktu, dengan tautan langsung), tombol Panduan + tur pertama kali per peran, dan tautan ke mode latihan.
 * Caller: app/(dashboard)/off-program-control/OpcApp.tsx.
 * Dependensi: components/fiori/{core,Tur}, lib/opc-ui (TAMPILAN, TAB_OPC, LABEL_PERAN), lib/off-program-control/access (tipe).
 * Main Functions: MisiAnda, TombolPanduan, langkahTurOpc, useTurPertama.
 * Side Effects: localStorage `opc-tur-v1:<peran>` (tur sudah dilihat) dan `opc-misi-tutup` (papan diciutkan); keduanya hanya
 *   kenyamanan per peramban, dibungkus try/catch.
 */
"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { Compass, GraduationCap } from "lucide-react";
import { Button, StatusBadge } from "@/components/fiori/core";
import { Tur, type LangkahTur } from "@/components/fiori/Tur";
import type { OffRole, OffTab } from "@/lib/off-program-control/access";
import { TAB_OPC, TAMPILAN } from "@/lib/opc-ui";
import type { DaftarOpc } from "./Bersama";

export const URL_LATIHAN = "/off-program-control/latihan";

const baca = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const tulis = (k: string, v: string | null) => {
    try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch { /* mode privat: abaikan */ }
};

/** Satu pekerjaan di papan Misi: jumlah, label antrean, dan tautan ke tab + sub-tampilannya. */
type Misi = { kunci: string; n: number; label: string; href: string };

/** Kalimat "apa yang harus dilakukan" per peran saat tidak ada yang menunggu. */
const LANGKAH_PERAN: Partial<Record<OffRole, string>> = {
    supervisor: "Untuk mengajukan biaya promo, buka tab Supervisor lalu tekan Batch baru.",
    sales_manager: "Pengajuan dari Supervisor akan muncul di tab Sales Manager untuk Anda setujui atau kembalikan.",
    claim: "Setelah Sales Manager menyetujui, periksa berkas di Validasi setelah SM. Setelah Keuangan membayar, lanjutkan di Verifikasi final.",
    operational_manager: "Pengajuan yang sudah lolos pemeriksaan Klaim akan menunggu persetujuan Anda di tab Operational Manager.",
    finance: "Pengajuan yang disetujui OM akan menunggu pembayaran di tab Keuangan.",
    admin: "Pantau semua antrean dari tab Ringkasan.",
    manager: "Pantau semua antrean dari tab Ringkasan; aksi tulis milik peran masing-masing.",
};

/**
 * Papan Misi Anda: daftar antrean yang berisi pekerjaan untuk peran ini (dari predikat TAMPILAN yang sama dengan tab), jumlah yang
 * lewat batas waktu (lonceng), dan langkah berikutnya. <details> asli: bisa diciutkan, keadaannya diingat per peramban.
 */
export function MisiAnda({ peran, boleh, daftar, hrefTab, onBukaBatch, aksi }: {
    peran: OffRole; boleh: OffTab[]; daftar: DaftarOpc; hrefTab: (tab: OffTab, sub: string | null) => string;
    onBukaBatch: (id: string) => void; aksi: ReactNode;
}) {
    const tutup = useSyncExternalStore(() => () => undefined, () => baca("opc-misi-tutup") === "1", () => false);
    const [buka, setBuka] = useState<boolean | null>(null);
    const terbuka = buka ?? !tutup;
    const misi: Misi[] = [];
    const banyakTab = boleh.filter((t) => t !== "overview" && t !== "audit").length > 1;
    for (const tab of boleh) {
        if (tab === "overview" || tab === "audit") continue;
        const views = TAMPILAN[tab];
        for (const v of views) {
            const n = daftar.batches.filter(v.antrean).length;
            if (!n) continue;
            const judulTab = TAB_OPC.find((t) => t.key === tab)?.label ?? tab;
            // Nama tab ikut ditulis bila peran memegang lebih dari satu antrean (admin, manager, Klaim) supaya jelas meja mana.
            misi.push({ kunci: `${tab}-${v.kunci}`, n, label: views.length > 1 || banyakTab ? `${judulTab}: ${v.label}` : v.label, href: hrefTab(tab, views.length > 1 ? v.kunci : null) });
        }
    }
    const lewat = daftar.masalah;
    const nTugas = misi.reduce((t, m) => t + m.n, 0);
    const siap = daftar.load.status === "siap" || Boolean(daftar.load.data);
    const ringkas = !siap ? (daftar.load.status === "galat" ? "jumlah pekerjaan belum bisa dihitung" : "menghitung pekerjaan…")
        : nTugas || lewat.length ? `${nTugas} menunggu Anda${lewat.length ? `, ${lewat.length} lewat batas waktu` : ""}` : "tidak ada yang menunggu Anda";
    return (
        <details className="fi-panel fi-misi" open={terbuka} data-tur="misi"
            onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; setBuka(o); tulis("opc-misi-tutup", o ? null : "1"); }}>
            <summary>
                <span>Misi Anda</span>
                <span className="fi-small fi-subtle" style={{ fontWeight: 400 }}>{ringkas}</span>
                {lewat.length > 0 && <StatusBadge tone="warn">{lewat.length} lewat batas</StatusBadge>}
            </summary>
            <div style={{ display: "grid", gap: 10 }}>
                {siap && misi.length > 0 && (
                    <ul className="fi-btnrow" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Pekerjaan yang menunggu Anda">
                        {misi.map((m) => (
                            <li key={m.kunci}>
                                <Link href={m.href} replace scroll={false} className="fi-btn fi-btn--secondary">
                                    <b className="fi-tnum">{m.n}</b>&nbsp;{m.label}
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
                {siap && lewat.length > 0 && (
                    <p className="fi-small">
                        Lewat batas waktu: <b className="fi-mono">{lewat[0].noPengajuan}</b>, {lewat[0].title}.{" "}
                        <Button variant="tertiary" onClick={() => onBukaBatch(lewat[0].batchId)}>Buka pengajuannya</Button>
                        {lewat.length > 1 ? ` Sisanya ada di lonceng di kanan atas.` : ""}
                    </p>
                )}
                {siap && !misi.length && !lewat.length && <p className="fi-small">{LANGKAH_PERAN[peran] ?? "Tidak ada pekerjaan yang menunggu Anda."}</p>}
                <div className="fi-btnrow">{aksi}</div>
            </div>
        </details>
    );
}

/** Langkah tur halaman utama OPC: umum dulu, lalu khusus peran. Sasaran yang tidak ada di layar dilewati otomatis oleh Tur. */
export function langkahTurOpc(peran: OffRole): LangkahTur[] {
    const umum: LangkahTur[] = [
        {
            judul: "Selamat datang di OFF Program Control",
            isi: "Di sini pengajuan biaya promo berjalan dari Supervisor sampai uangnya kembali dari principal, tanpa Excel dan bisa dibuka dari mana saja. Tur ini menunjukkan bagian penting halaman dalam satu menit.",
        },
        { target: "misi", judul: "Misi Anda", isi: "Kotak ini selalu menunjukkan pekerjaan yang menunggu Anda dan yang sudah lewat batas waktu. Tekan salah satu pekerjaan untuk langsung membukanya." },
        { target: "tab-peran", judul: "Satu tab untuk setiap meja", isi: "Pengajuan berpindah dari meja ke meja: Supervisor, Sales Manager, Klaim, Operational Manager, lalu Keuangan. Angka di samping tab adalah jumlah yang menunggu." },
        { target: "cari", judul: "Cari pengajuan", isi: "Ketik nomor pengajuan, principal, atau nama Supervisor. Tekan tombol garis miring ( / ) untuk langsung mencari." },
        { target: "lonceng", judul: "Lonceng lewat batas waktu", isi: "Pengajuan yang terlambat di meja mana pun muncul di sini, lengkap dengan alasannya. Batas waktu dihitung dengan hari kerja." },
    ];
    const khusus: Partial<Record<OffRole, LangkahTur[]>> = {
        supervisor: [
            { target: "spv-batch-baru", judul: "Buat pengajuan baru", isi: "Mulai dari sini. Pilih principal, lalu isi item: satu item untuk satu toko dan satu program." },
            { target: "spv-nama-program", judul: "Nama program memberi saran", isi: "Tulis nama program seperti di surat. Sistem langsung menyarankan tipe program yang cocok." },
            { target: "spv-tipe", judul: "Tidak yakin tipe programnya?", isi: "Tekan Bantu saya memilih tipe, lalu jawab satu pertanyaan: uang ini dipakai untuk apa. Pilih Lainnya hanya bila tidak ada yang cocok, dan tulis alasannya." },
            { target: "spv-beban", judul: "Beban: ditagih atau tidak", isi: "CL berarti biaya ini ditagih balik ke principal. DM berarti dibayar dari dana distributor sendiri dan tidak diklaim." },
            { target: "antrean", judul: "Draf dan yang dikembalikan", isi: "Pengajuan yang masih Anda pegang ada di daftar ini. Yang dikembalikan Sales Manager atau Klaim diberi tanda merah beserta catatannya." },
        ],
        sales_manager: [{ target: "antrean", judul: "Tinjauan Sales Manager", isi: "Buka pengajuan, periksa item dan nominalnya, lalu Setujui atau Kembalikan ke Supervisor dengan catatan." }],
        claim: [
            { target: "segmen-antrean", judul: "Tiga antrean Klaim", isi: "Validasi setelah SM untuk memeriksa berkas dan deadline. Verifikasi final setelah Keuangan membayar. Batch CLM untuk pengajuan arahan direksi." },
            { target: "antrean", judul: "Pengajuan yang menunggu Klaim", isi: "Buka pengajuan untuk memeriksa kelengkapan berkas. Item beban distributor (DM) tidak perlu No Claim." },
        ],
        operational_manager: [{ target: "antrean", judul: "Persetujuan OM", isi: "Pengajuan di sini sudah diperiksa Klaim. Setujui supaya Keuangan bisa membayar, atau batalkan dengan alasan." }],
        finance: [{ target: "antrean", judul: "Pembayaran", isi: "Buka pengajuan, centang item dengan cara bayar yang sama, lalu catat tanggal bayar. Potong Tagihan berarti nilai dipotongkan dari tagihan toko." }],
        admin: [{ target: "antrean", judul: "Semua pengajuan", isi: "Sebagai admin Anda bisa membuka pengajuan mana pun dan melihat riwayatnya." }],
        manager: [{ target: "antrean", judul: "Semua pengajuan", isi: "Anda bisa membaca semua antrean dan log audit. Aksi tulis milik peran masing-masing." }],
    };
    const penutup: LangkahTur[] = [
        { target: "progres", judul: "Bar progres pengajuan", isi: "Di setiap pengajuan terlihat sudah sampai tahap ke berapa dan berapa item yang berkasnya sudah ada." },
        { target: "tombol-latihan", judul: "Mau mencoba dulu?", isi: "Mode latihan menjalankan satu pengajuan contoh dari awal sampai selesai. Tidak ada data yang tersimpan atau terkirim." },
        { target: "tombol-panduan", judul: "Tur bisa diulang", isi: "Tekan Panduan kapan saja untuk melihat tur ini lagi." },
    ];
    return [...umum, ...(khusus[peran] ?? []), ...penutup];
}

const kunciTur = (peran: OffRole) => `opc-tur-v1:${peran}`;

/**
 * Tur pertama kali per peran: terbuka sendiri sekali setelah antrean termuat (ditunda sedikit supaya halaman sudah tergambar),
 * lalu ditandai sudah dilihat saat ditutup atau selesai.
 */
export function useTurPertama(peran: OffRole, siap: boolean): [boolean, (buka: boolean) => void] {
    const [buka, setBuka] = useState(false);
    useEffect(() => {
        if (!siap || peran === "unknown" || baca(kunciTur(peran))) return;
        // Dialog yang sedang terbuka (top layer) menutupi tur: lewati kali ini, tur terbuka lagi di kunjungan berikutnya.
        const t = window.setTimeout(() => { if (!document.querySelector("dialog[open]")) setBuka(true); }, 700);
        return () => window.clearTimeout(t);
    }, [peran, siap]);
    const ubah = (b: boolean) => { setBuka(b); if (!b) tulis(kunciTur(peran), "1"); };
    return [buka, ubah];
}

/** Tombol Panduan (mulai tur) + tautan mode latihan; tur dipasang hanya selama terbuka. */
export function TombolPanduan({ peran, buka, setBuka }: { peran: OffRole; buka: boolean; setBuka: (b: boolean) => void }) {
    return (
        <>
            <Button icon={<Compass className="fi-icon" aria-hidden />} onClick={() => setBuka(true)} data-tur="tombol-panduan">Panduan</Button>
            <Link href={URL_LATIHAN} className="fi-btn fi-btn--tertiary" data-tur="tombol-latihan">
                <GraduationCap className="fi-icon" aria-hidden /> Mode latihan
            </Link>
            {buka && <Tur langkah={langkahTurOpc(peran)} onTutup={() => setBuka(false)} label="Panduan OPC" />}
        </>
    );
}
