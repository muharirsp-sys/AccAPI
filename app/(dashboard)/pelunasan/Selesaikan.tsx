/*
 * Tujuan: Selesaikan pelunasan Tidak pasti (Fiori S6e-2b, owner #7, kontrak S6e-2 §4–§6): hasil pencarian server di Accurate tampil DULU,
 *   baru keputusan Terposting (nomor yang ditemukan) / Tidak ada di Accurate, tempat memeriksa, alasan ≥ 15. Pilihan yang ditolak server
 *   (kode 409) tidak ditawarkan lagi; jawaban tidak pasti = "hasilnya belum pasti" + pencarian diulang (simpan terkunci selama itu).
 *   Daftar "Perlu tindakan" (GET summary ?rows=1) membuka dialog yang sama untuk baris dari kiriman sesi lain (Finance).
 * Caller: LangkahKirim.tsx (LangkahHasil), Pelunasan.tsx (langkah Jenis).
 * Dependensi: ./bersama (cariPenyelesaian, simpanPenyelesaian, muatRingkasan, labelDatabase), lib/pelunasan-wizard, components/fiori.
 * Main Functions: SelesaikanDialog, DaftarTindakan.
 * Side Effects: GET /api/idempotency/resolve (baca Accurate dengan sesi pemanggil), POST /api/idempotency/resolve (catat keputusan; TIDAK
 *   menulis ke Accurate), GET /api/idempotency/summary?rows=1.
 */
"use client";

import { useCallback, useId, useState, type ReactNode } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Button, ErrorState, ListItem, MessageStrip, ResponsiveTable, Section, Skeleton, StatusBadge, type Column } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { rupiah } from "@/lib/promo-ui";
import { LABEL_STATUS_SERVER, type Penyelesaian } from "@/lib/pelunasan-wizard";
import { waktuWita } from "@/app/(dashboard)/principal-order/bersama";
import { ALASAN, cariPenyelesaian, labelDatabase, muatRingkasan, namaDatabase, simpanPenyelesaian, type BarisRingkasan, type Ringkasan, type Sesi } from "./bersama";

type Keputusan = "terposting" | "tidak_ada";
const TETAP = " Tidak ada yang diubah.";

/** Kontrak §5 `hint:"takeover"`: cicilan yang BELUM terkirim tidak diselesaikan di sini, melainkan dikirim ulang terkendali dari Tinjau. */
const arahTakeover = (izin: boolean) => `Bila baris ini cicilan yang BELUM terkirim, jangan diselesaikan di sini: tutup dialog lalu kirim ulang terkendali — unggah ulang baris ini lewat Pelunasan baru; di Tinjau baris tertahan sebagai kiriman sebelumnya belum pasti, centang lalu Izinkan yang dicentang… dengan alasan minimal 15 karakter (takeover Finance, tercatat).${izin ? "" : " Akun Anda tidak berhak mengizinkannya; minta Finance yang berhak mengizinkan baris ganda."}`;
type SelisihServer = { nomor: string; kandidat: number | null; baris: number | null; beda: number | null };

/**
 * `lockDb` = database yang dicatat lock baris ini (wizard: database kiriman; daftar: `databaseId` ringkasan, null = baris sebelum S6e-2).
 * `onClose(p)` membawa keputusan server bila baris sudah selesai (disimpan di sini, atau status SUCCESS/FAILED terbaca saat pencarian).
 */
export function SelesaikanDialog({ kunci, ringkas, lockDb, izinTakeover, onClose }: {
    kunci: string; ringkas: ReactNode; lockDb: { id: string | null; label: string }; onClose: (p?: Penyelesaian) => void;
    /** finance.override_duplicate: boleh mengizinkan kirim ulang terkendali di Tinjau (hanya mengubah kalimat arah, bukan tombol di sini). */
    izinTakeover: boolean;
}) {
    const nama = useId();
    const [load, cariUlang] = useLoad(useCallback(() => cariPenyelesaian(kunci), [kunci]));
    const [keputusan, setKeputusan] = useState<Keputusan | "">("");
    const [nomor, setNomor] = useState("");
    const [sumber, setSumber] = useState("");
    /** Pilihan yang ditolak server (kode 409) — tidak ditawarkan lagi di dialog ini, alasan dari server. */
    const [ditolak, setDitolak] = useState<Partial<Record<Keputusan, string>>>({});
    /** 409 wrong_database: database lock menurut server. */
    const [dbWajib, setDbWajib] = useState<string | null>(null);
    const [izinDitolak, setIzinDitolak] = useState(false);
    /** Konfirmasi Finance bahwa kandidat yang nominalnya beda memang kiriman baris ini (acceptSimilar); 409 similar_not_identical memaksanya. */
    const [yakin, setYakin] = useState(false);
    /** 409 similar_not_identical: rincian server (nomor terpilih, nominal kandidat vs baris, selisih) — memaksa konfirmasi. */
    const [selisihServer, setSelisihServer] = useState<SelisihServer | null>(null);

    const cariLagi = () => { setKeputusan(""); setNomor(""); setYakin(false); cariUlang(); };
    const db = load.status === "siap" ? load.data : undefined;
    const r = db?.rows.find((x) => x.key === kunci);
    // SUCCESS dari server tanpa keputusan di dialog ini: `receiptNumbers` = KANDIDAT pencarian (menyentuh faktur), bukan nomor yang
    // ditetapkan — nomornya hanya di jejak penyelesaian (susulan S6e, tinjauan 2b).
    const sudah: Penyelesaian | undefined = r?.status === "SUCCESS" ? { status: "SUCCESS", nomor: [], pesan: "sudah tercatat terposting di server; nomor pelunasan Accurate lihat jejak penyelesaian." }
        : r?.status === "FAILED" ? { status: "FAILED", nomor: [], pesan: "sudah tercatat tidak terkirim di server; boleh dikirim ulang." } : undefined;
    const target = dbWajib ? { id: dbWajib, label: `database id ${dbWajib}` } : lockDb;
    // Nomor untuk "terposting" = kandidat yang menyentuh faktur baris (server menerima kandidat mana pun; nomor kosong tidak bisa dipakai).
    const nomorOpsi = [...new Set([...(r?.receiptNumbers ?? []), ...(r?.candidates ?? []).map((k) => k.receiptNumber)].filter(Boolean))];
    const nomorPilih = nomor || (nomorOpsi.length === 1 ? nomorOpsi[0] : "");
    // Kandidat MIRIP (nominal ≠ baris) bisa jadi cicilan lain: konfirmasi wajib + jalan lain (kirim ulang terkendali) ditawarkan.
    const kandidatPilih = r?.candidates.find((k) => k.receiptNumber === nomorPilih);
    const selisih = keputusan === "terposting" && kandidatPilih && kandidatPilih.amount !== null && r && kandidatPilih.amount !== r.amount ? kandidatPilih.amount : null;
    const tidakIdentikServer = selisihServer?.nomor === nomorPilih ? selisihServer : null;
    const perluYakin = keputusan === "terposting" && Boolean(nomorPilih) && (selisih !== null || tidakIdentikServer !== null);

    // Dari jawaban server (status, eligible, found, database lock) — klien tidak menebak aturan umur.
    const umum = !r ? "Menunggu hasil pencarian."
        : sudah ? `Baris ini ${sudah.pesan}`
            : !r.eligible ? `Status aplikasi ${LABEL_STATUS_SERVER[r.status] ?? r.status}: kiriman masih berjalan atau baru saja berubah; cari lagi beberapa menit lagi.`
                : r.found === null ? `Riwayat Accurate gagal dibaca${r.readError ? ` (${r.readError})` : ""}; cari lagi.` : "";
    const tidak: Record<Keputusan, string> = {
        terposting: umum || ditolak.terposting || (nomorOpsi.length ? ""
            : r?.found ? "Pelunasan yang menyentuh faktur ini tidak bernomor di jawaban Accurate; periksa nomornya di Accurate lalu Cari lagi."
                : "Tidak ada pelunasan di Accurate yang menyentuh faktur ini; server hanya menerima nomor dari pencarian."),
        tidak_ada: umum || ditolak.tidak_ada || (r?.found
            ? "Ada pelunasan di Accurate yang menyentuh faktur ini; bandingkan nominalnya — bila itu kiriman ini, tetapkan terposting dengan nomornya. Mengirim ulang bisa membuat pelunasan ganda."
            : target.id === null ? "Database kiriman tidak tercatat (baris sebelum pembaruan): tidak ditemukan di database ini bisa berarti terposting di database lain." : ""),
    };
    const dbBeda = db && target.id !== null && db.databaseId !== target.id
        ? `Baris ini dikirim ke ${target.label}; sesi Anda membuka ${namaDatabase(db)}. Buka database itu di Konsol AOL lalu Cari lagi.` : "";
    const blok = load.status === "memuat" ? "Menunggu hasil pencarian di Accurate"
        : !r ? "Pencarian belum berhasil — cari lagi"
            : izinDitolak ? ALASAN.selesaikanDitolak
                : !db?.databaseId ? "Sesi Accurate tanpa database terbuka; buka database lewat Konsol AOL lalu Cari lagi"
                    : dbBeda || (!keputusan ? "Pilih hasil pemeriksaan dulu" : tidak[keputusan])
                        || (keputusan === "terposting" && !nomorPilih ? "Pilih nomor pelunasan" : "")
                        || (perluYakin && !yakin ? "Centang konfirmasi selisih nominal dulu" : "")
                        || (!sumber.trim() ? "Isi tempat Anda memeriksa" : "") || undefined;

    async function simpan(alasan: string) {
        if (!r || !db?.databaseId || !keputusan || blok) throw new Error("Lengkapi isian dulu.");
        const j = await simpanPenyelesaian({
            key: kunci, decision: keputusan, accurateNumber: keputusan === "terposting" ? nomorPilih : "", reason: alasan, checkedSource: sumber.trim(),
            expectedDatabaseId: db.databaseId, ...(perluYakin && yakin ? { acceptSimilar: true as const } : {}),
        });
        if (j.jenis === "ok") {
            // alreadyResolved: klik ganda atau Finance lain lebih dulu — yang berlaku = status SERVER, bukan pilihan di dialog ini.
            if (j.sudah) {
                onClose(j.status === "SUCCESS"
                    ? { status: "SUCCESS", nomor: [], pesan: "sudah diselesaikan sebelumnya (oleh Anda atau Finance lain): terposting, nomor pelunasan Accurate lihat jejak penyelesaian; status baris mengikuti server." }
                    : { status: "FAILED", nomor: [], pesan: "sudah diselesaikan sebelumnya (oleh Anda atau Finance lain): tidak ada di Accurate, boleh dikirim ulang; status baris mengikuti server." });
                return;
            }
            onClose(j.status === "SUCCESS"
                ? { status: "SUCCESS", nomor: [nomorPilih], pesan: `ditetapkan terposting ${nomorPilih}.` }
                : { status: "FAILED", nomor: [], pesan: "ditetapkan tidak ada di Accurate; boleh dikirim ulang lewat Pelunasan baru." });
            return;
        }
        if (j.jenis === "ragu") {
            cariLagi();
            throw new Error("Server tidak memberi jawaban yang pasti — hasilnya belum pasti: penyelesaian mungkin sudah tercatat, mungkin belum. Pencarian dimuat ulang; periksa status baris sebelum menyimpan lagi.");
        }
        const pesan = j.pesan ? `${j.pesan}.`.replace(/\.\.$/, ".") : "";
        switch (j.code) {
            case "database_changed":
                cariLagi();
                throw new Error(`Database Accurate sesi Anda berubah sejak pencarian${typeof j.data.databaseAlias === "string" ? ` (kini ${j.data.databaseAlias})` : ""}.${TETAP} Pencarian diulang di database yang terbuka.`);
            case "wrong_database":
                setDbWajib(String(j.data.lockDatabaseId ?? "") || null);
                throw new Error(`${pesan || "Baris ini dikirim ke database lain."}${TETAP}`);
            case "database_unknown":
                setDitolak((d) => ({ ...d, tidak_ada: j.pesan || "Database kiriman tidak tercatat." }));
                setKeputusan("");
                throw new Error(`${pesan}${TETAP}`);
            case "not_eligible":
                setDitolak((d) => ({ ...d, [keputusan]: j.pesan || "Server menolak keputusan ini untuk baris ini." }));
                cariLagi();
                throw new Error(`${pesan}${TETAP} Pencarian dimuat ulang.`);
            case "similar_found":
                // Grup pelanggan+tanggal memuat pelunasan yang menyentuh faktur ini — "tidak ada" tidak ditawarkan lagi; kandidat tampil sesudah cari ulang.
                setDitolak((d) => ({ ...d, tidak_ada: j.pesan || "Ada pelunasan di Accurate yang menyentuh faktur ini." }));
                cariLagi();
                throw new Error(`${pesan || "Ada pelunasan di Accurate yang menyentuh faktur ini."}${TETAP} Pencarian dimuat ulang; bandingkan kandidatnya.${j.data.hint === "takeover" ? ` ${arahTakeover(izinTakeover)}` : ""}`);
            case "similar_not_identical": {
                // Kandidat tidak identik kasar → wajib konfirmasi eksplisit (acceptSimilar) sebelum terposting; rincian dari server.
                const sel = (j.data.selected && typeof j.data.selected === "object" ? j.data.selected : {}) as Record<string, unknown>;
                const angka = (v: unknown) => (typeof v === "number" ? v : null);
                setSelisihServer({ nomor: String(sel.receiptNumber ?? nomorPilih) || nomorPilih, kandidat: angka(j.data.candidateAmount), baris: angka(j.data.rowAmount), beda: angka(j.data.difference) });
                setYakin(false);
                throw new Error(`${pesan || "Pelunasan terpilih tidak identik dengan baris ini."}${TETAP} Bandingkan selisihnya lalu centang konfirmasi bila memang kiriman ini.`);
            }
            case "number_mismatch": case "changed": case "search_failed":
                cariLagi();
                throw new Error(`${pesan}${TETAP} Pencarian dimuat ulang.`);
            case "not_found":
                throw new Error(`Baris ini tidak ada di catatan aplikasi.${TETAP}`);
            case "DATABASE_REQUIRED": case "ACCURATE_SESSION_INCOMPLETE":
                cariLagi();
                throw new Error(`Sesi Accurate belum lengkap; masuk dan buka database lewat Konsol AOL, lalu Cari lagi.${TETAP}`);
            case "forbidden": case "HTTP_403":
                setIzinDitolak(true);
                throw new Error(`${ALASAN.selesaikanDitolak}${TETAP}`);
            case "HTTP_401":
                throw new Error(`Sesi login berakhir; masuk ulang lalu buka lagi baris ini.${TETAP}`);
            default:
                throw new Error(`${pesan || "Penyelesaian ditolak server."}${TETAP}`);
        }
    }

    const pilihan: Array<[Keputusan, string, string]> = [
        ["terposting", nomorPilih ? `Tetapkan terposting sebagai ${nomorPilih}` : "Tetapkan terposting", "Baris pindah ke Terposting dengan nomor itu; pastikan kandidat itu memang kiriman ini."],
        ["tidak_ada", "Tetapkan tidak ada di Accurate", "Baris dibuka lagi untuk dikirim ulang (proxy tetap menahan yang mirip riwayat)."],
    ];
    return (
        <ConfirmDialog open onClose={() => onClose(sudah)} tag="Hanya Finance" title="Selesaikan pelunasan tidak pasti" description={ringkas}
            reason={{ label: "Alasan", min: 15, placeholder: "Apa yang Anda lihat di Accurate dan mengapa" }}
            confirmLabel={keputusan === "tidak_ada" ? "Tetapkan tidak ada" : "Tetapkan terposting"} confirmDisabled={blok} alasanTerlihat onConfirm={simpan}>
            {load.status === "memuat" && <Skeleton rows={3} label="Mencari pelunasan di Accurate dengan sesi Anda" />}
            {load.status === "galat" && <ErrorState title="Pencarian di Accurate gagal" message={load.error} onRetry={cariLagi} />}
            {load.status === "siap" && !r && <ErrorState title="Baris tidak ditemukan di catatan aplikasi" message="Pencarian tidak mengembalikan baris ini." onRetry={cariLagi} />}
            {r && db && (
                <>
                    <div className="fi-panel" style={{ padding: 12 }} role="status" aria-label="Hasil pencarian">
                        <b>{r.found === true ? `Ada ${r.candidates.length || r.receiptNumbers.length} pelunasan di Accurate yang menyentuh faktur ini` : r.found === false ? "Tidak ada pelunasan di Accurate yang menyentuh faktur ini" : "Riwayat Accurate gagal dibaca"}</b>
                        <p className="fi-small">Pelanggan {r.customerNo}, tanggal {r.transDate}, faktur {r.invoiceNo}, nilai {rupiah(r.amount)} · status aplikasi {LABEL_STATUS_SERVER[r.status] ?? r.status}
                            {r.readError ? ` · ${r.readError}` : ""} · dicari di {namaDatabase(db)}.</p>
                        {r.candidates.length > 0 && (
                            <ul className="fi-small" aria-label="Pelunasan yang menyentuh faktur ini" style={{ margin: "6px 0 0", paddingLeft: "1.25rem", listStyle: "disc" }}>
                                {r.candidates.map((k, i) => (
                                    <li key={`${k.receiptNumber}-${i}`}>
                                        <b className="fi-mono">{k.receiptNumber || "tanpa nomor"}</b>{k.transDate ? ` · ${k.transDate}` : ""} · faktur {k.invoiceNos.join(", ") || "—"}
                                        {k.amount !== null ? ` · ${rupiah(k.amount)} (${k.amount === r.amount ? "nominal sama dengan baris" : `baris ${rupiah(r.amount)}`})` : ""}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {dbBeda && <p className="fi-small fi-why">{dbBeda}</p>}
                    </div>
                    {sudah && <MessageStrip tone="info" title={`Baris ini ${sudah.pesan}`}>Tutup dialog; hasil baris diperbarui.</MessageStrip>}
                    <fieldset className="fi-field" style={{ border: 0, padding: 0, margin: 0 }}>
                        <legend className="fi-label">Hasil pemeriksaan<span className="fi-req" aria-hidden>*</span></legend>
                        {pilihan.map(([k, judul, isi]) => (
                            <label key={k} className="fi-check" style={{ alignItems: "flex-start" }}>
                                <input type="radio" name={nama} value={k} checked={keputusan === k} disabled={Boolean(tidak[k])} onChange={() => setKeputusan(k)} />
                                <span><b>{judul}</b><span className="fi-sub">{tidak[k] ? `Tidak tersedia: ${tidak[k]}` : isi}</span></span>
                            </label>
                        ))}
                    </fieldset>
                    {keputusan === "terposting" && nomorOpsi.length > 1 && (
                        <FormField label="Nomor pelunasan Accurate" required help="Beberapa pelunasan menyentuh faktur ini; pilih yang berasal dari kiriman ini.">
                            {(a11y) => <select {...a11y} className="fi-input" value={nomor} onChange={(e) => { setNomor(e.target.value); setYakin(false); }}>
                                <option value="">Pilih nomor…</option>
                                {nomorOpsi.map((n) => <option key={n} value={n}>{n}</option>)}
                            </select>}
                        </FormField>
                    )}
                    {perluYakin && (
                        <MessageStrip tone="warn" title={tidakIdentikServer && tidakIdentikServer.kandidat !== null && tidakIdentikServer.baris !== null && tidakIdentikServer.beda
                            ? `Pelunasan ${nomorPilih} ${rupiah(tidakIdentikServer.kandidat)} ≠ baris ini ${rupiah(tidakIdentikServer.baris)} (selisih ${rupiah(Math.abs(tidakIdentikServer.beda))}) — bisa jadi cicilan lain.`
                            : selisih !== null ? `Pelunasan ${nomorPilih} ${rupiah(selisih)} ≠ baris ini ${rupiah(r.amount)} — bisa jadi cicilan lain.`
                                : `Pelunasan ${nomorPilih} tidak identik dengan baris ini (faktur atau nominal per faktur berbeda) — bisa jadi cicilan lain.`}>
                            Tetapkan terposting hanya bila pelunasan itu memang kiriman baris ini. {arahTakeover(izinTakeover)}
                            <label className="fi-check" style={{ marginTop: 8 }}>
                                <input type="checkbox" checked={yakin} onChange={(e) => setYakin(e.target.checked)} />
                                {`Saya sudah membandingkan: ${nomorPilih} adalah kiriman baris ini walau tidak identik.`}
                            </label>
                        </MessageStrip>
                    )}
                    <FormField label="Diperiksa di" required help="Mis. Accurate › Penerimaan Penjualan, saring pelanggan dan tanggal yang sama.">
                        {(a11y) => <input {...a11y} className="fi-input" value={sumber} onChange={(e) => setSumber(e.target.value)} />}
                    </FormField>
                    <div className="fi-btnrow"><Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={cariLagi}>Cari lagi</Button></div>
                </>
            )}
        </ConfirmDialog>
    );
}

// ── Daftar Perlu tindakan (BL-41, ?rows=1) ─────────────────────────────────────────────────────────────

/** "retryable" = Gagal (tidak terkirim); "uncertain" / "processingStale" = boleh diselesaikan (kontrak §6). */
const gagal = (r: BarisRingkasan) => r.category === "retryable";
const Badge = ({ r }: { r: BarisRingkasan }) => (gagal(r) ? <StatusBadge tone="neg">Gagal · boleh diulang</StatusBadge>
    : <StatusBadge tone="warn">{r.category === "processingStale" ? "Tidak pasti · kunci macet" : "Tidak pasti"}</StatusBadge>);

export function DaftarTindakan({ izinSelesaikan, izinTakeover, sesi, sesiMemuat }: { izinSelesaikan: boolean; izinTakeover: boolean; sesi: Sesi | undefined; sesiMemuat: boolean }) {
    // Bawaan: database aktif sesi (baris database lain hanya bisa diselesaikan sesudah membuka database itu); "semua" = tanpa saring.
    // Selama sesi dibaca, daftar menunggu — supaya tidak sekilas menampilkan semua database lalu berganti.
    const [semua, setSemua] = useState(false);
    const dbAktif = sesi?.databaseConnected ? sesi.databaseId ?? undefined : undefined;
    const saring = semua ? undefined : dbAktif;
    const [load, muatUlang] = useLoad(useCallback((): Promise<Load<Ringkasan>> => (sesiMemuat ? Promise.resolve({ status: "memuat" }) : muatRingkasan(saring)), [saring, sesiMemuat]));
    const [buka, setBuka] = useState<BarisRingkasan | null>(null);
    const [pesan, setPesan] = useState<string | null>(null);
    const rows = load.data?.rows ?? [];
    const nRagu = rows.filter((r) => !gagal(r)).length;
    const faktur = (r: BarisRingkasan) => r.invoiceNo || "—";
    // Tombol tulis mengikuti data penentu: daftar memuat ulang / gagal dimuat ulang = baris yang tampil mungkin usang.
    const kunci = !izinSelesaikan ? ALASAN.selesaikan
        : load.status === "memuat" ? "Daftar sedang dimuat ulang."
            : load.status === "galat" ? "Daftar gagal dimuat ulang; tekan Coba lagi dulu." : undefined;

    const tombol = (r: BarisRingkasan) => !gagal(r)
        ? <Button variant="tertiary" icon={<Search className="fi-icon" aria-hidden />} aria-label={`Selesaikan ${faktur(r)}…`} disabled={Boolean(kunci)} disabledReason={kunci}
            onClick={() => { setPesan(null); setBuka(r); }}>Selesaikan…</Button>
        : <span className="fi-small">Unggah ulang lewat wizard</span>;
    const kolom: Column<BarisRingkasan>[] = [
        { key: "faktur", header: "Faktur / outlet", cell: (r) => <><b className="fi-mono">{faktur(r)}</b><span className="fi-codes">{r.customerNo ?? "—"} · {r.transDate ?? "—"}</span></> },
        { key: "nilai", header: "Nilai", align: "end", cell: (r) => <span className="fi-tnum">{rupiah(r.amount ?? 0)}</span> },
        { key: "db", header: "Database", secondary: true, cell: (r) => <span className="fi-small">{labelDatabase(r.databaseId, sesi)}</span> },
        { key: "status", header: "Status", cell: (r) => <><Badge r={r} /><span className="fi-codes">{waktuWita(r.updatedAt)} WITA</span></> },
        { key: "aksi", header: "Tindakan", cell: tombol },
    ];

    return (
        <Section title="Perlu tindakan" subtitle="Tidak pasti dan gagal dari kiriman sebelumnya · terbaru dulu"
            actions={dbAktif && sesi ? (
                <label className="fi-small" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>Tampilkan
                    <select className="fi-input" value={semua ? "semua" : "aktif"} onChange={(e) => setSemua(e.target.value === "semua")}>
                        <option value="aktif">{`Database aktif: ${namaDatabase(sesi)}`}</option>
                        <option value="semua">Semua database</option>
                    </select>
                </label>
            ) : undefined}>
            {pesan && <div className="fi-sect-in"><MessageStrip tone="pos" title="Status baris diperbarui." onClose={() => setPesan(null)}>{pesan}</MessageStrip></div>}
            <ResponsiveTable<BarisRingkasan> title="Perlu tindakan" count={rows.length} columns={kolom} rows={rows} rowKey={(r) => r.key}
                status={load.status} error={load.error} onRetry={muatUlang}
                empty={{ title: "Tidak ada pelunasan yang tidak pasti atau gagal", message: "Kiriman yang belum pasti atau tidak terkirim muncul di sini." }}
                mobileItem={(r) => <ListItem doc={faktur(r)} amount={rupiah(r.amount ?? 0)} title={`${r.customerNo ?? "—"} · ${labelDatabase(r.databaseId, sesi)}`}
                    meta={tombol(r)} badge={<Badge r={r} />} />} />
            {load.data?.rowsTruncated && <p className="fi-small fi-why" style={{ padding: "8px 16px" }}>Daftar dipotong: 200 baris terbaru ditampilkan.</p>}
            {kunci && nRagu > 0 && <p className="fi-small fi-why" style={{ padding: "8px 16px" }}>Selesaikan nonaktif: {kunci}</p>}
            {buka && (
                <SelesaikanDialog kunci={buka.key} lockDb={{ id: buka.databaseId, label: labelDatabase(buka.databaseId, sesi) }} izinTakeover={izinTakeover}
                    ringkas={<><span className="fi-mono">{faktur(buka)}</span> · {buka.customerNo} · {rupiah(buka.amount ?? 0)} · {buka.transDate} · {labelDatabase(buka.databaseId, sesi)}</>}
                    onClose={(p) => { if (p) { setPesan(`${faktur(buka)} · ${buka.customerNo}: ${p.pesan}`); muatUlang(); } setBuka(null); }} />
            )}
        </Section>
    );
}
