/*
 * Tujuan: Halaman "Pengaturan" Insentif Sales (Fiori S4c, it07): Object Page dengan anchor bar — konstanta skema, penyebut AO
 *   GT/TT, cabang beracuan NILAI_JUAL, SM dalam skema, hierarki (PengaturanHierarki.tsx), akun belum ditautkan, riwayat.
 *   Konstanta gagal dibaca = editor DIKUNCI (AM-020): GET gagal, atau GET 200 dengan `konstantaSumber: "gagal_baca"` (angkanya
 *   bawaan, bukan tersimpan) — angka bawaan tidak pernah tampil sebagai tersimpan dan tidak ikut tersimpan.
 *   Versi (AM-045): draf konstanta menyimpan versi DASAR-nya (versi setelan saat draf mulai dibuat) dan versi itulah yang dikirim
 *   saat PATCH konstanta — jawaban PATCH lain atau muat ulang tidak menyegarkannya; 409 KONSTANTA_BERUBAH → dialog konflik, draf
 *   basi tidak dikirim lagi, muat ulang. Riwayat nilai lama → baru (BL-33) → VariantNote.
 *   Jawaban PATCH tidak pasti (putus, ≥ 502, bukan JSON) → "hasilnya belum pasti" + muat ulang; tulis terkunci selama memuat ulang.
 * Caller: app/(dashboard)/insentif-sales/pengaturan/page.tsx.
 * Dependensi: ./Rangka (InsentifRangka), ./PengaturanHierarki, ./data (formatRp), components/fiori/{core,interactive},
 *   lib/insentif-konstanta, lib/insentif-ui (readApi), lib/rekapan-nota/ui (ambil, jamWita).
 * Main Functions: Pengaturan (default).
 * Side Effects: GET /api/insentif-sales/settings; PATCH settings (konstanta, gtAoMode, branchNilaiJual, smBerhak) lewat ConfirmDialog —
 *   MENGUBAH NOMINAL insentif setiap perhitungan berikutnya. beforeunload saat ada draf.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Pencil, RefreshCw, RotateCcw } from "lucide-react";
import { AnchorBar, Button, ErrorState, FooterToolbar, MessageStrip, Section, Skeleton, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, useLoad, useUnsavedGuard } from "@/components/fiori/interactive";
import { ambil, jamWita } from "@/lib/rekapan-nota/ui";
import { readApi } from "@/lib/insentif-ui";
import { DEFAULT_KONSTANTA, KONSTANTA_FIELDS, getField, parseKonstanta, setField, type Konstanta, type KonstantaKind } from "@/lib/insentif-konstanta";
import { formatRp } from "./data";
import { InsentifRangka } from "./Rangka";
import { AkunTautan, Hierarki } from "./PengaturanHierarki";

interface Setelan {
    gtAoMode: "fixed240" | "file"; branchNilaiJual: string[]; smBerhak: string[]; konstanta: unknown; konstantaBawaan?: unknown;
    /** AM-020: "gagal_baca" = `konstanta` adalah BAWAAN karena yang tersimpan tak terbaca — tidak boleh menjadi dasar draf/simpan. */
    konstantaSumber?: "tersimpan" | "gagal_baca";
    /** AM-045: updatedAt ISO konstanta tersimpan (null = belum pernah disimpan); dikirim balik saat PATCH konstanta. */
    konstantaVersi?: string | null;
}
type FieldDaftar = "branchNilaiJual" | "smBerhak";

/** PATCH konstanta dijawab 409 KONSTANTA_BERUBAH: admin lain menyimpan sejak editor dimuat (AM-045). */
class KonstantaBerubah extends Error {}
const BELUM_PASTI = "Hasilnya belum pasti: server tidak memberi jawaban yang jelas. Setelan dimuat ulang — periksa angkanya sebelum menyimpan lagi.";

/**
 * Setelan berbentuk DAFTAR (cabang beracuan NILAI_JUAL, SM yang ikut skema insentif). Keduanya dulu konstanta di kode:
 * menambah satu principal berarti satu deploy. Editor sengaja textarea satu-baris-satu-nilai, bukan tabel dengan tombol
 * tambah/hapus — isinya belasan nama, dan menempel dari Excel harus bekerja apa adanya.
 */
const DAFTAR: ReadonlyArray<{ field: FieldDaftar; id: string; judul: string; desc: string; contoh: string; catatan: string }> = [
    {
        field: "branchNilaiJual", id: "nilai-jual", judul: "Cabang beracuan NILAI_JUAL",
        desc: "Cabang (kolom JENISPRODUK di file closing) yang realisasi Value-nya diambil dari NILAI_JUAL. Cabang di luar daftar ini memakai DPP.",
        contoh: "VINDA\nKINO NON FOOD\nMIX NON FOOD\nABC",
        catatan: "Berlaku untuk unggahan closing BERIKUTNYA. Periode yang sudah masuk harus dihapus lalu diunggah ulang agar angkanya ikut berubah.",
    },
    {
        field: "smBerhak", id: "sm-skema", judul: "SM yang ikut skema insentif",
        desc: "Nama SM yang berhak atas insentif SM (strata flat berbasis Value). Dicocokkan sebagai kata utuh, jadi HENDRIK tidak akan cocok dengan HENDRIKUS.",
        contoh: "HENDRIK",
        catatan: "Langsung mengubah nominal insentif SM periode mana pun yang dihitung setelah ini.",
    },
];

/** Tampilan angka konstanta: rupiah untuk nominal, persen untuk rasio, cacahan untuk qty. */
function tampil(v: number, kind: KonstantaKind) {
    if (kind === "rp") return formatRp(v);
    if (kind === "rasio") return `${(v * 100).toLocaleString("id-ID")}%`;
    return v.toLocaleString("id-ID");
}
const normDaftar = (teks: string) => teks.split("\n").map((v) => v.trim().toUpperCase().replace(/\s+/g, " ")).filter(Boolean);
const GRUP = [...new Set(KONSTANTA_FIELDS.map((f) => f.grup))];

type Dlg = { kind: "simpanKonst" } | { kind: "konflik" } | { kind: "daftar"; field: FieldDaftar } | { kind: "ao"; mode: "fixed240" | "file" } | null;

export default function Pengaturan({ permKeys }: { permKeys: string[] }) {
    const perms = useMemo(() => new Set(permKeys), [permKeys]);
    // PATCH settings memakai izin `manage` (bukan input_support): angka di sini mengubah nominal semua orang.
    const bolehUbah = perms.has("insentif_sales.manage");
    const bolehHierarki = perms.has("insentif_sales.manage_hierarchy");
    const tanpaIzin = bolehUbah ? undefined : "Butuh izin kelola insentif";

    const [load, muat] = useLoad(useCallback(() => ambil<Setelan>("/api/insentif-sales/settings"), []));
    /** Respons PATCH terakhir (route mengembalikan seluruh setelan setelah menulis). */
    const [baru, setBaru] = useState<Setelan | null>(null);
    const setelan = baru ?? load.data ?? null;
    // Tulis hanya dari setelan segar: saat dimuat ulang atau gagal dimuat ulang (data lama tetap tampil), semua tombol simpan terkunci.
    const alasanKunci = !setelan ? "Terkunci sampai setelan berhasil dibaca"
        : baru === null && load.status === "memuat" ? "Setelan sedang dimuat ulang"
            : baru === null && load.status === "galat" ? "Setelan gagal dimuat ulang — coba lagi dulu" : undefined;
    const gagalBacaKonst = setelan?.konstantaSumber === "gagal_baca";
    // AM-020: angka dari "gagal_baca" adalah bawaan — bukan dasar draf, bukan "tersimpan".
    const tersimpan = useMemo(() => (setelan && setelan.konstantaSumber !== "gagal_baca" ? parseKonstanta(setelan.konstanta) : null), [setelan]);
    const bawaan = useMemo(() => (setelan?.konstantaBawaan ? parseKonstanta(setelan.konstantaBawaan) : DEFAULT_KONSTANTA), [setelan]);
    /**
     * Draf + versi DASAR-nya (AM-045): versi setelan saat draf mulai dibuat (null → isi). Versi dasar inilah yang dikirim saat simpan.
     * Versi terbaru (dari jawaban PATCH penyebut AO/daftar, atau muat ulang setelah "belum pasti") tidak boleh menggantikannya:
     * draf berbasis angka lama + versi baru = CAS lolos dan perubahan admin lain kembali diam-diam.
     * Kecuali draf sudah SAMA dengan tersimpan (`berubah` kosong): tidak ada yang bisa ditimpa, jadi edit berikutnya berdasar
     * versi saat ini — mis. PATCH yang ternyata tertulis tetapi jawabannya hilang; dengan versi lama edit berikutnya 409 palsu.
     */
    const [drafDasar, setDrafDasar] = useState<{ nilai: Konstanta; versi: string | null } | null>(null);
    const draf = drafDasar?.nilai ?? null;
    const nilaiK = draf ?? tersimpan;
    const berubah = useMemo(() => (draf && tersimpan ? KONSTANTA_FIELDS.filter((f) => getField(draf, f.path) !== getField(tersimpan, f.path)) : []), [draf, tersimpan]);
    const setDraf = (k: Konstanta | null) => setDrafDasar((d) => (k === null ? null
        : { nilai: k, versi: d && berubah.length > 0 ? d.versi : setelan?.konstantaVersi ?? null }));

    const [teks, setTeks] = useState<Record<FieldDaftar, string | null>>({ branchNilaiJual: null, smBerhak: null });
    const daftarNilai = (f: FieldDaftar) => { const t = teks[f]; return t === null ? (setelan?.[f] ?? []) : normDaftar(t); };
    const daftarBerubah = (f: FieldDaftar) => teks[f] !== null && setelan !== null && daftarNilai(f).join("|") !== setelan[f].join("|");
    const adaDraf = berubah.length > 0 || DAFTAR.some((d) => daftarBerubah(d.field));
    useUnsavedGuard(adaDraf);

    const [dialog, setDialog] = useState<Dlg>(null);
    const [pesan, setPesan] = useState<string | null>(null);
    /** 409 AM-045: draf berbasis angka lama — Simpan terkunci sampai dimuat ulang (draf dibuang saat itu). */
    const [konflik, setKonflik] = useState<{ jumlah: number; pesan: string } | null>(null);

    const muatUlang = () => { setBaru(null); muat(); };

    async function patch(body: Record<string, unknown>): Promise<Setelan> {
        const res = await fetch("/api/insentif-sales/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
            .catch(() => null);
        // Putus / ≥ 502 / bukan JSON: perubahan mungkin sudah tertulis → "belum pasti" dan muat ulang (tulis terkunci sampai terbaca).
        const data = res && res.status < 502 ? await readApi(res).catch(() => null) : null;
        if (!res || !data) { muatUlang(); throw new Error(BELUM_PASTI); }
        if (res.status === 409 && data.code === "KONSTANTA_BERUBAH") throw new KonstantaBerubah(String(data.error ?? "Konstanta sudah diubah admin lain."));
        if (!res.ok) throw new Error(String(data.error ?? "Gagal menyimpan setelan."));
        const s = data as unknown as Setelan;
        setBaru(s);
        return s;
    }

    async function simpanKonst() {
        if (!drafDasar || !berubah.length) return;
        const jumlah = berubah.length;
        try {
            // AM-045: versi yang dimuat; server menolak (409) bila admin lain menyimpan duluan, dan 400 bila versi tidak dikirim.
            await patch({ konstanta: drafDasar.nilai, konstantaVersi: drafDasar.versi });
        } catch (e) {
            if (!(e instanceof KonstantaBerubah)) throw e;
            // Draf berbasis angka lama: mengirimnya lagi = mengembalikan perubahan admin lain. Tidak dikirim; muat ulang dulu.
            setKonflik({ jumlah, pesan: e.message });
            setDialog({ kind: "konflik" });
            return;
        }
        setDraf(null); setDialog(null);
        setPesan(`Konstanta tersimpan (${jumlah} angka berubah). Berlaku untuk perhitungan sesudah ini; pembayaran yang sudah tercatat tidak berubah.`);
    }

    /** Konflik: draf basi dibuang, editor menampilkan angka terbaru; perubahan diulang dari sana. */
    function muatUlangKonflik() {
        setDraf(null); setKonflik(null); setDialog(null);
        muatUlang();
    }

    async function simpanDaftar(f: FieldDaftar) {
        const judul = DAFTAR.find((d) => d.field === f)?.judul ?? f;
        const s = await patch({ [f]: daftarNilai(f) });
        setTeks((t) => ({ ...t, [f]: null })); setDialog(null);
        setPesan(`${judul} tersimpan (${s[f].length} entri).`);
    }

    async function gantiAo(mode: "fixed240" | "file") {
        await patch({ gtAoMode: mode });
        setDialog(null);
        setPesan("Penyebut AO diperbarui. Nominal baru tampil saat Dashboard dimuat ulang.");
    }

    // Konstanta tak terbaca: ambang AO bawaan tidak dipakai sebagai label.
    const aoAmbang = tersimpan ? String(tersimpan.gt.aoAmbang) : null;
    const labelAoTetap = aoAmbang ? `${aoAmbang} (tetap)` : "Ambang tetap";
    const alasanKonst = !setelan ? "Editor konstanta terkunci"
        : gagalBacaKonst ? "Editor konstanta terkunci: konstanta tersimpan gagal dibaca"
            : alasanKunci ?? (konflik ? "Konstanta sudah diubah admin lain — muat ulang dulu" : undefined);
    const alasanSimpan = alasanKonst ?? tanpaIzin ?? (berubah.length ? undefined : "Belum ada perubahan konstanta");
    const teksVersi = (v: string | null | undefined) => (v ? `tersimpan ${jamWita(v)} WITA` : "belum pernah disimpan");
    const versiTeks = gagalBacaKonst ? "gagal dibaca" : teksVersi(setelan?.konstantaVersi);
    const dlgDaftar = dialog?.kind === "daftar" ? DAFTAR.find((x) => x.field === dialog.field) : undefined;
    const tambah = dlgDaftar && setelan ? daftarNilai(dlgDaftar.field).filter((v) => !setelan[dlgDaftar.field].includes(v)) : [];
    const hilang = dlgDaftar && setelan ? setelan[dlgDaftar.field].filter((v) => !daftarNilai(dlgDaftar.field).includes(v)) : [];

    const memuatAwal = load.status === "memuat" && !setelan;
    const galatBaca = load.status === "galat" && !setelan ? `Setelan belum berhasil dibaca (${load.error}).` : null;
    const galatMuatUlang = load.status === "galat" && Boolean(load.data) && baru === null;

    return (
        <InsentifRangka halaman="pengaturan" permKeys={permKeys} saringan={false}
            deskripsi="Angka dan daftar di halaman ini berlaku untuk semua periode yang dihitung sesudah disimpan."
            aksi={adaDraf ? <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />Draf belum disimpan</span> : undefined}>
            <AnchorBar anchors={[
                { id: "konstanta", label: "Konstanta" }, { id: "penyebut-ao", label: "Penyebut AO" }, { id: "nilai-jual", label: "Cabang NILAI_JUAL" },
                { id: "sm-skema", label: "SM dalam skema" }, { id: "hierarki", label: "Hierarki" }, { id: "akun", label: "Akun belum ditautkan" }, { id: "riwayat", label: "Riwayat" },
            ]} />
            {setelan && (
                <dl className="fi-attrs">
                    <div><dt>Versi konstanta</dt><dd>{versiTeks}</dd></div>
                    <div><dt>Penyebut AO GT/TT</dt><dd>{setelan.gtAoMode === "file" ? "Target AO dari berkas" : labelAoTetap}</dd></div>
                    <div><dt>SM dalam skema</dt><dd>{setelan.smBerhak.join(", ") || "—"}</dd></div>
                    <div><dt>Cabang NILAI_JUAL</dt><dd>{setelan.branchNilaiJual.length} cabang</dd></div>
                </dl>
            )}
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {(galatBaca || gagalBacaKonst) && (
                <MessageStrip tone="neg" title="Konstanta tersimpan gagal dibaca — editor dikunci agar angka bawaan tidak ikut tersimpan.">
                    {galatBaca ? `${galatBaca} Bagian hierarki dan akun di halaman ini tetap bisa dipakai.` : "Muat ulang nanti. Bagian lain di halaman ini tetap bisa dipakai."}
                </MessageStrip>
            )}
            {galatMuatUlang && (
                <MessageStrip tone="neg" title="Setelan gagal dimuat ulang.">
                    {load.error} Yang tampil adalah hasil sebelumnya; menyimpan dikunci sampai setelan terbaca.{" "}
                    <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlang}>Coba lagi</Button>
                </MessageStrip>
            )}
            {konflik && (
                <MessageStrip tone="warn" title="Konstanta sudah diubah admin lain.">
                    {konflik.jumlah} angka Anda belum disimpan dan tidak dikirim dari angka lama.{" "}
                    <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muatUlangKonflik}>Muat ulang</Button>
                </MessageStrip>
            )}

            <Section id="konstanta" title="Konstanta skema" subtitle={tersimpan ? "pool, bobot, ambang bayar, rate SPV, strata SM, tarif PPh" : "terkunci"}
                actions={<Button variant="tertiary" disabled={Boolean(alasanKonst || tanpaIzin)} disabledReason={alasanKonst ?? tanpaIzin} onClick={() => setDraf(bawaan)}>Isi dengan bawaan</Button>}>
                <div className="fi-sect-in">
                    {memuatAwal ? <Skeleton rows={6} label="Memuat konstanta" />
                        : !nilaiK || !tersimpan ? <ErrorState title="Konstanta gagal dibaca — editor dikunci"
                            message={`${galatBaca ?? "Server hanya bisa mengirim angka bawaan, jadi angka itu tidak ditampilkan sebagai tersimpan."} Muat ulang untuk mengubah konstanta.`} onRetry={muatUlang} />
                            : GRUP.map((g) => (
                                <div key={g} className="grid gap-2">
                                    <h3 className="fi-title-3">{g}</h3>
                                    <div className="fi-formgrid">
                                        {KONSTANTA_FIELDS.filter((f) => f.grup === g).map((f) => {
                                            const v = getField(nilaiK, f.path);
                                            const asal = getField(tersimpan, f.path);
                                            const beda = v !== asal;
                                            const id = `konst-${f.path}`;
                                            return (
                                                <div key={f.path} className="fi-field">
                                                    <label className="fi-label" htmlFor={id}>{f.label}{beda && <span className="fi-why"> · diubah</span>}</label>
                                                    <input id={id} aria-describedby={`${id}-help`} className="fi-input fi-tnum" style={{ textAlign: "end" }} type="number" inputMode="decimal"
                                                        step={f.kind === "rasio" ? "0.01" : "1"} min="0" value={String(v)} disabled={Boolean(tanpaIzin || alasanKonst)}
                                                        onChange={(e) => {
                                                            const x = Number(e.target.value);
                                                            if (!Number.isFinite(x) || x < 0) return;
                                                            setDraf(setField(nilaiK, f.path, x));
                                                        }} />
                                                    <p className="fi-help" id={`${id}-help`}>
                                                        {f.kind === "rasio" ? `= ${(v * 100).toLocaleString("id-ID")}%` : tampil(v, f.kind)}
                                                        {beda && <span className="fi-why"> · sebelumnya {tampil(asal, f.kind)}</span>}
                                                        {` · bawaan ${tampil(getField(bawaan, f.path), f.kind)}`}{f.catatan ? ` · ${f.catatan}` : ""}
                                                    </p>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                    <p className="fi-small fi-why">
                        Mengubah angka di sini langsung menggeser nominal insentif SEMUA orang pada setiap perhitungan berikutnya, termasuk periode
                        lampau yang belum dibayar. Pembayaran yang sudah tercatat tetap memakai angka bruto yang tersimpan.
                    </p>
                </div>
            </Section>

            <Section id="penyebut-ao" title="Penyebut AO GT/TT" subtitle="pembagi pencapaian AO pada skema GT/TT; mengubahnya mengubah nominal yang dibayar">
                <div className="fi-sect-in">
                    {memuatAwal ? <Skeleton rows={2} label="Memuat setelan" /> : !setelan ? <p className="fi-small fi-subtle">Terkunci sampai setelan berhasil dibaca.</p> : (
                        <>
                            <div className="fi-segs" role="group" aria-label="Penyebut AO GT/TT">
                                <button type="button" aria-pressed={setelan.gtAoMode !== "file"} disabled={Boolean(tanpaIzin || alasanKunci)} title={tanpaIzin ?? alasanKunci}
                                    onClick={() => { if (setelan.gtAoMode === "file") setDialog({ kind: "ao", mode: "fixed240" }); }}>{labelAoTetap}</button>
                                <button type="button" aria-pressed={setelan.gtAoMode === "file"} disabled={Boolean(tanpaIzin || alasanKunci)} title={tanpaIzin ?? alasanKunci}
                                    onClick={() => { if (setelan.gtAoMode !== "file") setDialog({ kind: "ao", mode: "file" }); }}>Target AO dari berkas</button>
                            </div>
                            <p className="fi-small fi-subtle">
                                {setelan.gtAoMode === "file"
                                    ? "Tiap sales GT/TT dinilai terhadap Target AO barisnya sendiri di berkas target."
                                    : `Semua sales GT/TT dinilai terhadap ${aoAmbang ?? "ambang tetap di konstanta"}, kecuali baris yang tombol "Pakai target file"-nya dinyalakan di halaman Support principal.`}
                            </p>
                        </>
                    )}
                </div>
            </Section>

            {DAFTAR.map((d) => {
                const nilai = daftarNilai(d.field);
                const ubah = daftarBerubah(d.field);
                return (
                    <Section key={d.field} id={d.id} title={d.judul} subtitle={d.desc}>
                        <div className="fi-sect-in">
                            {memuatAwal ? <Skeleton rows={2} label="Memuat setelan" /> : (
                                <>
                                    <textarea aria-label={d.judul} className="fi-input fi-mono" rows={5} spellCheck={false} placeholder={setelan ? d.contoh : "Terkunci sampai setelan berhasil dibaca"}
                                        value={teks[d.field] ?? (setelan?.[d.field] ?? []).join("\n")} disabled={Boolean(alasanKunci || tanpaIzin)}
                                        onChange={(e) => { const v = e.target.value; setTeks((t) => ({ ...t, [d.field]: v })); }} />
                                    <div className="fi-btnrow">
                                        <Button disabled={Boolean(alasanKunci || tanpaIzin) || !ubah} disabledReason={alasanKunci ?? tanpaIzin ?? "Belum ada perubahan"}
                                            onClick={() => setDialog({ kind: "daftar", field: d.field })}>Simpan…</Button>
                                        {teks[d.field] !== null && <Button variant="tertiary" icon={<RotateCcw className="fi-icon" aria-hidden />} onClick={() => setTeks((t) => ({ ...t, [d.field]: null }))}>Batalkan perubahan</Button>}
                                        <span className="fi-small fi-subtle">{nilai.length} entri · satu per baris · huruf besar/kecil dan spasi ganda diabaikan{ubah ? " · belum disimpan" : ""}</span>
                                    </div>
                                    <p className="fi-small fi-why">{d.catatan}</p>
                                </>
                            )}
                        </div>
                    </Section>
                );
            })}

            <Hierarki bolehHierarki={bolehHierarki} />
            <AkunTautan bolehHierarki={bolehHierarki} />

            <Section id="riwayat" title="Riwayat" subtitle="nilai lama → baru">
                <div className="fi-sect-in">
                    <VariantNote bl="BL-33">
                        Hari ini hanya nilai terakhir yang tersimpan; nilai lama konstanta, daftar, dan tautan akun tidak dicatat. Usulan: riwayat
                        bersama yang mencatat siapa, kapan, dan nilai lama → baru untuk setiap perubahan di halaman ini.
                    </VariantNote>
                </div>
            </Section>

            <FooterToolbar message={alasanKonst ?? (tanpaIzin ? "Hanya pemegang izin kelola insentif yang dapat mengubah konstanta"
                : berubah.length ? `${berubah.length} konstanta diubah, belum disimpan` : "Belum ada perubahan konstanta")}>
                {berubah.length > 0 && <Button variant="tertiary" icon={<RotateCcw className="fi-icon" aria-hidden />} onClick={() => setDraf(null)}>Batalkan perubahan</Button>}
                <Button variant="primary" disabled={Boolean(alasanSimpan)} disabledReason={alasanSimpan} onClick={() => setDialog({ kind: "simpanKonst" })}>
                    {berubah.length ? `Simpan ${berubah.length} perubahan…` : "Simpan"}
                </Button>
            </FooterToolbar>

            <ConfirmDialog open={dialog?.kind === "simpanKonst"} onClose={() => setDialog(null)} tag="Konstanta"
                title={`Simpan ${berubah.length} perubahan konstanta?`} confirmLabel="Simpan" confirmDisabled={alasanSimpan} onConfirm={simpanKonst}
                facts={[
                    ...berubah.map((f): [string, string] => [`${f.grup} · ${f.label}`, `${tampil(getField(tersimpan ?? DEFAULT_KONSTANTA, f.path), f.kind)} → ${tampil(getField(draf ?? DEFAULT_KONSTANTA, f.path), f.kind)}`]),
                    ["Versi dasar", `${drafDasar ? teksVersi(drafDasar.versi) : versiTeks} — ditolak bila admin lain menyimpan sesudahnya`],
                    ["Berlaku untuk", "Setiap perhitungan sesudah disimpan — semua sales, SPV, dan SM, termasuk periode lampau yang belum dibayar"],
                    ["Tidak berubah", "Pembayaran yang sudah tercatat tetap memakai bruto tersimpan"],
                ]} />
            <ConfirmDialog open={dialog?.kind === "konflik"} onClose={() => setDialog(null)} tag="Konstanta"
                title="Konstanta sudah diubah admin lain" confirmLabel="Muat ulang" cancelLabel="Tutup" onConfirm={muatUlangKonflik}
                description={konflik?.pesan}
                facts={konflik ? [
                    ["Perubahan Anda", `${konflik.jumlah} angka, belum disimpan`],
                    ["Muat ulang", "Draf dibuang dan editor menampilkan angka terbaru; ulangi perubahan dari angka itu"],
                ] : []} />
            <ConfirmDialog open={dialog?.kind === "daftar"} onClose={() => setDialog(null)} tag="Setelan"
                title={`Simpan perubahan ${dlgDaftar?.judul ?? ""}?`} confirmLabel="Simpan"
                onConfirm={() => (dialog?.kind === "daftar" ? simpanDaftar(dialog.field) : undefined)}
                facts={dlgDaftar ? [
                    ["Ditambah", tambah.join(", ") || "—"],
                    ["Dihapus", hilang.join(", ") || "—"],
                    ["Jumlah entri", String(daftarNilai(dlgDaftar.field).length)],
                    ["Akibat", dlgDaftar.catatan],
                ] : []} />
            <ConfirmDialog open={dialog?.kind === "ao"} onClose={() => setDialog(null)} tag="Penyebut AO"
                title={dialog?.kind === "ao" ? (dialog.mode === "fixed240" ? `Ubah penyebut AO GT/TT ke ${aoAmbang ?? "ambang tetap"} untuk SEMUA sales?` : "Ubah penyebut AO GT/TT ke Target AO di berkas target?") : ""}
                confirmLabel="Ubah penyebut AO" onConfirm={() => (dialog?.kind === "ao" ? gantiAo(dialog.mode) : undefined)}
                facts={[["Akibat", "Nominal insentif AO semua sales GT/TT dihitung ulang pada perhitungan berikutnya"], ["Tidak berubah", "Pembayaran yang sudah tercatat"]]} />
        </InsentifRangka>
    );
}
