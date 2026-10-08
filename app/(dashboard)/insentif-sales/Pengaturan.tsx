/*
 * Tujuan: Halaman "Pengaturan" Insentif Sales (Fiori S4c, it07): Object Page dengan anchor bar — konstanta skema, penyebut AO
 *   GT/TT, cabang beracuan NILAI_JUAL, SM dalam skema, hierarki (PengaturanHierarki.tsx), akun belum ditautkan, riwayat.
 *   Konstanta gagal dibaca = editor DIKUNCI (AM-020): angka bawaan tidak pernah ikut tersimpan karena gagal baca.
 *   Versi + tolak 409 (AM-045) dan riwayat nilai lama → baru (BL-33) belum ada di main → VariantNote.
 * Caller: app/(dashboard)/insentif-sales/pengaturan/page.tsx.
 * Dependensi: ./Rangka (InsentifRangka), ./PengaturanHierarki, ./data (formatRp), components/fiori/{core,interactive},
 *   lib/insentif-konstanta, lib/insentif-ui (readApi), lib/rekapan-nota/ui (ambil).
 * Main Functions: Pengaturan (default).
 * Side Effects: GET /api/insentif-sales/settings; PATCH settings (konstanta, gtAoMode, branchNilaiJual, smBerhak) lewat ConfirmDialog —
 *   MENGUBAH NOMINAL insentif setiap perhitungan berikutnya. beforeunload saat ada draf.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Pencil, RotateCcw } from "lucide-react";
import { AnchorBar, Button, ErrorState, FooterToolbar, MessageStrip, Section, Skeleton, VariantNote } from "@/components/fiori/core";
import { ConfirmDialog, useLoad, useUnsavedGuard } from "@/components/fiori/interactive";
import { ambil } from "@/lib/rekapan-nota/ui";
import { readApi } from "@/lib/insentif-ui";
import { DEFAULT_KONSTANTA, KONSTANTA_FIELDS, getField, parseKonstanta, setField, type Konstanta, type KonstantaKind } from "@/lib/insentif-konstanta";
import { formatRp } from "./data";
import { InsentifRangka } from "./Rangka";
import { AkunTautan, Hierarki } from "./PengaturanHierarki";

interface Setelan { gtAoMode: "fixed240" | "file"; branchNilaiJual: string[]; smBerhak: string[]; konstanta: unknown; konstantaBawaan?: unknown }
type FieldDaftar = "branchNilaiJual" | "smBerhak";

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

type Dlg = { kind: "simpanKonst" } | { kind: "daftar"; field: FieldDaftar } | { kind: "ao"; mode: "fixed240" | "file" } | null;

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
    const terkunci = !setelan;
    const tersimpan = useMemo(() => (setelan ? parseKonstanta(setelan.konstanta) : null), [setelan]);
    const bawaan = useMemo(() => (setelan?.konstantaBawaan ? parseKonstanta(setelan.konstantaBawaan) : DEFAULT_KONSTANTA), [setelan]);
    const [draf, setDraf] = useState<Konstanta | null>(null);
    const nilaiK = draf ?? tersimpan;
    const berubah = useMemo(() => (draf && tersimpan ? KONSTANTA_FIELDS.filter((f) => getField(draf, f.path) !== getField(tersimpan, f.path)) : []), [draf, tersimpan]);

    const [teks, setTeks] = useState<Record<FieldDaftar, string | null>>({ branchNilaiJual: null, smBerhak: null });
    const daftarNilai = (f: FieldDaftar) => { const t = teks[f]; return t === null ? (setelan?.[f] ?? []) : normDaftar(t); };
    const daftarBerubah = (f: FieldDaftar) => teks[f] !== null && setelan !== null && daftarNilai(f).join("|") !== setelan[f].join("|");
    const adaDraf = berubah.length > 0 || DAFTAR.some((d) => daftarBerubah(d.field));
    useUnsavedGuard(adaDraf);

    const [dialog, setDialog] = useState<Dlg>(null);
    const [pesan, setPesan] = useState<string | null>(null);

    async function patch(body: Record<string, unknown>): Promise<Setelan> {
        const res = await fetch("/api/insentif-sales/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await readApi(res);
        if (!res.ok) throw new Error(String(data.error ?? "Gagal menyimpan setelan."));
        const s = data as unknown as Setelan;
        setBaru(s);
        return s;
    }

    async function simpanKonst() {
        if (!draf || !berubah.length) return;
        const jumlah = berubah.length;
        await patch({ konstanta: draf });
        setDraf(null); setDialog(null);
        setPesan(`Konstanta tersimpan (${jumlah} angka berubah). Berlaku untuk perhitungan sesudah ini; pembayaran yang sudah tercatat tidak berubah.`);
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

    const muatUlang = () => { setBaru(null); muat(); };
    const aoAmbang = tersimpan?.gt.aoAmbang ?? DEFAULT_KONSTANTA.gt.aoAmbang;
    const alasanSimpan = terkunci ? "Editor konstanta terkunci" : tanpaIzin ?? (berubah.length ? undefined : "Belum ada perubahan konstanta");
    const dlgDaftar = dialog?.kind === "daftar" ? DAFTAR.find((x) => x.field === dialog.field) : undefined;
    const tambah = dlgDaftar && setelan ? daftarNilai(dlgDaftar.field).filter((v) => !setelan[dlgDaftar.field].includes(v)) : [];
    const hilang = dlgDaftar && setelan ? setelan[dlgDaftar.field].filter((v) => !daftarNilai(dlgDaftar.field).includes(v)) : [];

    const memuatAwal = load.status === "memuat" && !setelan;
    const galatBaca = load.status === "galat" && !setelan ? `Setelan belum berhasil dibaca (${load.error}).` : null;

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
                    <div><dt>Penyebut AO GT/TT</dt><dd>{setelan.gtAoMode === "file" ? "Target AO dari berkas" : `${aoAmbang} (tetap)`}</dd></div>
                    <div><dt>SM dalam skema</dt><dd>{setelan.smBerhak.join(", ") || "—"}</dd></div>
                    <div><dt>Cabang NILAI_JUAL</dt><dd>{setelan.branchNilaiJual.length} cabang</dd></div>
                </dl>
            )}
            {pesan && <MessageStrip tone="pos" title={pesan} onClose={() => setPesan(null)} />}
            {galatBaca && (
                <MessageStrip tone="neg" title="Konstanta tersimpan gagal dibaca — editor dikunci agar angka bawaan tidak ikut tersimpan.">
                    {galatBaca} Bagian hierarki dan akun di halaman ini tetap bisa dipakai.
                </MessageStrip>
            )}

            <Section id="konstanta" title="Konstanta skema" subtitle={terkunci ? "terkunci" : "pool, bobot, ambang bayar, rate SPV, strata SM, tarif PPh"}
                actions={<Button variant="tertiary" disabled={terkunci || Boolean(tanpaIzin)} disabledReason={terkunci ? "Editor konstanta terkunci" : tanpaIzin} onClick={() => setDraf(bawaan)}>Isi dengan bawaan</Button>}>
                <div className="fi-sect-in">
                    {memuatAwal ? <Skeleton rows={6} label="Memuat konstanta" />
                        : !nilaiK || !tersimpan ? <ErrorState title="Konstanta gagal dibaca — editor dikunci" message={`${galatBaca ?? ""} Muat ulang untuk mengubah konstanta.`} onRetry={muatUlang} />
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
                                                        step={f.kind === "rasio" ? "0.01" : "1"} min="0" value={String(v)} disabled={Boolean(tanpaIzin)}
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
                    <VariantNote bl="AM-045">
                        Hari ini Simpan menimpa konstanta terakhir tanpa nomor versi: bila dua admin mengubah bersamaan, yang terakhir menang tanpa
                        peringatan. Usulan: nomor versi di kepala halaman, server menolak bila konstanta sudah diubah admin lain, lalu dialog muat ulang.
                    </VariantNote>
                </div>
            </Section>

            <Section id="penyebut-ao" title="Penyebut AO GT/TT" subtitle="pembagi pencapaian AO pada skema GT/TT; mengubahnya mengubah nominal yang dibayar">
                <div className="fi-sect-in">
                    {memuatAwal ? <Skeleton rows={2} label="Memuat setelan" /> : !setelan ? <p className="fi-small fi-subtle">Terkunci sampai setelan berhasil dibaca.</p> : (
                        <>
                            <div className="fi-segs" role="group" aria-label="Penyebut AO GT/TT">
                                <button type="button" aria-pressed={setelan.gtAoMode !== "file"} disabled={Boolean(tanpaIzin)} title={tanpaIzin}
                                    onClick={() => { if (setelan.gtAoMode === "file") setDialog({ kind: "ao", mode: "fixed240" }); }}>{aoAmbang} (tetap)</button>
                                <button type="button" aria-pressed={setelan.gtAoMode === "file"} disabled={Boolean(tanpaIzin)} title={tanpaIzin}
                                    onClick={() => { if (setelan.gtAoMode !== "file") setDialog({ kind: "ao", mode: "file" }); }}>Target AO dari berkas</button>
                            </div>
                            <p className="fi-small fi-subtle">
                                {setelan.gtAoMode === "file"
                                    ? "Tiap sales GT/TT dinilai terhadap Target AO barisnya sendiri di berkas target."
                                    : `Semua sales GT/TT dinilai terhadap ${aoAmbang}, kecuali baris yang tombol "Pakai target file"-nya dinyalakan di halaman Support principal.`}
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
                                        value={teks[d.field] ?? (setelan?.[d.field] ?? []).join("\n")} disabled={terkunci || Boolean(tanpaIzin)}
                                        onChange={(e) => { const v = e.target.value; setTeks((t) => ({ ...t, [d.field]: v })); }} />
                                    <div className="fi-btnrow">
                                        <Button disabled={terkunci || Boolean(tanpaIzin) || !ubah} disabledReason={terkunci ? "Terkunci sampai setelan berhasil dibaca" : tanpaIzin ?? "Belum ada perubahan"}
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

            <FooterToolbar message={terkunci ? "Editor konstanta terkunci" : tanpaIzin ? "Hanya pemegang izin kelola insentif yang dapat mengubah konstanta"
                : berubah.length ? `${berubah.length} konstanta diubah, belum disimpan` : "Belum ada perubahan konstanta"}>
                {berubah.length > 0 && <Button variant="tertiary" icon={<RotateCcw className="fi-icon" aria-hidden />} onClick={() => setDraf(null)}>Batalkan perubahan</Button>}
                <Button variant="primary" disabled={Boolean(alasanSimpan)} disabledReason={alasanSimpan} onClick={() => setDialog({ kind: "simpanKonst" })}>
                    {berubah.length ? `Simpan ${berubah.length} perubahan…` : "Simpan"}
                </Button>
            </FooterToolbar>

            <ConfirmDialog open={dialog?.kind === "simpanKonst"} onClose={() => setDialog(null)} tag="Konstanta"
                title={`Simpan ${berubah.length} perubahan konstanta?`} confirmLabel="Simpan" onConfirm={simpanKonst}
                facts={[
                    ...berubah.map((f): [string, string] => [`${f.grup} · ${f.label}`, `${tampil(getField(tersimpan ?? DEFAULT_KONSTANTA, f.path), f.kind)} → ${tampil(getField(draf ?? DEFAULT_KONSTANTA, f.path), f.kind)}`]),
                    ["Berlaku untuk", "Setiap perhitungan sesudah disimpan — semua sales, SPV, dan SM, termasuk periode lampau yang belum dibayar"],
                    ["Tidak berubah", "Pembayaran yang sudah tercatat tetap memakai bruto tersimpan"],
                ]} />
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
                title={dialog?.kind === "ao" ? (dialog.mode === "fixed240" ? `Ubah penyebut AO GT/TT ke ${aoAmbang} untuk SEMUA sales?` : "Ubah penyebut AO GT/TT ke Target AO di berkas target?") : ""}
                confirmLabel="Ubah penyebut AO" onConfirm={() => (dialog?.kind === "ao" ? gantiAo(dialog.mode) : undefined)}
                facts={[["Akibat", "Nominal insentif AO semua sales GT/TT dihitung ulang pada perhitungan berikutnya"], ["Tidak berubah", "Pembayaran yang sudah tercatat"]]} />
        </InsentifRangka>
    );
}
