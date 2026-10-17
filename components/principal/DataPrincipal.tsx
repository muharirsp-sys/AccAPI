/*
 * Tujuan: Layar Data Principal (Fiori S7b, FCL): daftar principal resmi (cari, status, jumlah varian/alias) → Object Page dengan
 *   kepala (kode tetap, nama resmi, status + aktif/nonaktif), Varian (tambah, aktif/nonaktif), Alias (tambah, hapus), Riwayat
 *   (kursor `sebelum`) dan "Dipakai di" (tautan ke layar yang sudah ada). Aksi tulis disembunyikan tanpa izin; semua aksi memakai
 *   ConfirmDialog yang menyebut nama principal; galat 403/409 tampil dengan kalimat server.
 * Caller: app/(dashboard)/data-principal/page.tsx (izin dari server: principles.view / principles.upload / principles.delete).
 * Dependensi: GET/POST /api/principals, PATCH /api/principals/{id}, POST|PATCH /api/principals/{id}/variants, POST
 *   /api/principals/{id}/aliases, DELETE /api/principals/{id}/aliases/{aliasId}; ./principal-ui, ./RiwayatPrincipal, components/fiori/*.
 *   Kontrak: docs/handover/S7-2-KONTRAK-PRINCIPAL-API.md.
 * Main Functions: DataPrincipal.
 * Side Effects: HTTP tulis ke API principal (zona master data; alias baru memengaruhi resolver S7-2b).
 * Rute lama (/principles, /principal-mapping, /master-barang) TIDAK dialihkan di slice ini; bagian "Dipakai di" hanya menautkannya.
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Plus, Power, Trash2 } from "lucide-react";
import {
    AnchorBar, Button, EmptyState, ErrorState, FlexibleColumnLayout, ListItem, MessageStrip, ObjectPageHeader, Section, Skeleton, StatusBadge, Tile,
} from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad } from "@/components/fiori/interactive";
import { canAccessPathWithKeys } from "@/lib/rbac";
import { RiwayatPrincipal } from "./RiwayatPrincipal";
import {
    baca, GalatTulis, JENIS_ALIAS, labelJenis, labelVarian, LABEL_JENIS, saring, SUMBER_KODE, tulis, waktuWita,
    type Alias, type Principal, type SaringStatus, type Varian,
} from "./principal-ui";

type Dialog =
    | { jenis: "buat" | "status" | "varian-baru" | "alias-baru" }
    | { jenis: "varian-status"; key: string }
    | { jenis: "alias-hapus"; id: string };
type Pesan = { tone: "pos" | "warn" | "neg"; teks: string };

const FORM_KOSONG = { kode: "", nama: "", key: "", dasar: false, alias: "", jenis: "nama" as string, untuk: "*" };
const NONAKTIF = "Principal nonaktif — aktifkan dulu";
const BARIS = { borderBottom: "1px solid var(--line)", paddingBottom: 8 } as const;
// Layar yang memakai data principal. Belum satu pun menerima saringan principal lewat URL, jadi tautannya polos.
const DIPAKAI = [
    { href: "/master-barang", judul: "Master Barang", ket: "Master per principal dan kode Master Barang 2 karakter" },
    { href: "/principal-mapping", judul: "Mapping Principal", ket: "Kode barang, pelanggan, dan salesman principal → kode internal" },
    { href: "/principles", judul: "Master Principle", ket: "Berkas master principle dan daftar master aktif" },
    { href: "/claim-workflow", judul: "Claim Workflow", ket: "Klaim dan No Claim per principal" },
];

export default function DataPrincipal({ permKeys }: { permKeys: string[] }) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const bolehTulis = keys.has("principles.upload");
    const bolehHapus = keys.has("principles.delete");
    const [daftar, muatUlang] = useLoad(useCallback(() => baca<Principal[]>("/api/principals", (j) => j.principals as Principal[], "Data principal gagal dimuat."), []));
    const [cari, setCari] = useState("");
    const [status, setStatus] = useState<SaringStatus>("semua");
    const [pilihId, setPilihId] = useState<string | null>(null);
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [pesan, setPesan] = useState<Pesan | null>(null);
    const [f, setF] = useState(FORM_KOSONG);
    const [versi, setVersi] = useState(0);

    const semua = daftar.data ?? [];
    const p = semua.find((x) => x.id === pilihId) ?? null;
    const tampil = saring(semua, cari, status);
    const nAktif = semua.filter((x) => x.isActive).length;
    const memuatAwal = daftar.status === "memuat" && !daftar.data;
    // Tulis terkunci saat data penentu memuat / gagal dimuat ulang (isi layar bisa usang).
    const kunciData = daftar.status === "memuat" ? "Menunggu data dimuat ulang" : daftar.status === "galat" ? "Data gagal dimuat — muat ulang dulu" : undefined;
    const kunciPrincipal = kunciData ?? (p && !p.isActive ? NONAKTIF : undefined);

    function segarkan() { muatUlang(); setVersi((v) => v + 1); }
    function buka(d: Dialog) { setF(FORM_KOSONG); setDialog(d); }

    /** Sukses = tutup dialog + pesan + muat ulang. Jawaban belum pasti = tutup + pesan peringatan + muat ulang. Galat lain (403/409/400) dilempar
     * ke dialog dengan kalimat server; 409 juga memuat ulang data di belakang (bentrok = data layar mungkin usang). */
    async function jalankan(fn: () => Promise<string>) {
        try {
            const teks = await fn();
            setDialog(null);
            setPesan({ tone: "pos", teks });
            segarkan();
        } catch (e) {
            if (e instanceof GalatTulis && e.belumPasti) { setDialog(null); setPesan({ tone: "warn", teks: e.message }); segarkan(); return; }
            if (e instanceof GalatTulis && e.status === 409) segarkan();
            throw e;
        }
    }

    const ubahAktif = async (url: string, body: Record<string, unknown>, nama: string, aktif: boolean) => {
        const r = await tulis(url, "PATCH", body);
        return r.berubah === false ? `${nama} sudah ${aktif ? "aktif" : "nonaktif"}; tidak ada yang berubah.` : `${nama} ${aktif ? "diaktifkan" : "dinonaktifkan"}.`;
    };

    // ---------- Daftar ----------
    const daftarEl = (
        <div className="fi-sect" style={{ borderRadius: 0, boxShadow: "none" }}>
            <header><h2>Principal</h2><span>{daftar.data ? `${tampil.length} dari ${semua.length}` : ""}{daftar.status === "memuat" && daftar.data ? " · memperbarui…" : ""}</span></header>
            {memuatAwal ? <div className="fi-sect-in"><Skeleton rows={6} label="Memuat principal" /></div>
                : daftar.status === "galat" && !daftar.data ? <ErrorState title="Daftar principal gagal dimuat" message={daftar.error} onRetry={segarkan} />
                : semua.length === 0 ? <EmptyState title="Belum ada principal" message={bolehTulis ? "Tambahkan principal pertama lewat tombol Tambah principal." : "Principal resmi belum didaftarkan."} />
                : tampil.length === 0 ? <EmptyState title={cari.trim() ? `Tidak ada principal “${cari.trim()}”` : "Tidak ada principal yang sesuai saringan"} message="Cari dengan kode, nama, atau ejaan alias lain, atau ubah saringan status." />
                : (
                    <ul className="fi-list" style={{ display: "block" }} aria-label="Daftar principal">
                        {tampil.map((x) => (
                            <li key={x.id} className="fi-wl-row">
                                <ListItem doc={x.code} title={x.name} meta={`${x.variants.length} varian · ${x.aliases.length} alias`}
                                    badge={<StatusBadge tone={x.isActive ? "pos" : "neu"}>{x.isActive ? "Aktif" : "Nonaktif"}</StatusBadge>}
                                    current={x.id === pilihId} onClick={() => setPilihId(x.id)} />
                            </li>
                        ))}
                    </ul>
                )}
        </div>
    );

    // ---------- Object Page ----------
    const dipakai = DIPAKAI.filter((x) => canAccessPathWithKeys(x.href, keys));
    const terkunci = (alasan: string | undefined) => (alasan ? <p className="fi-small fi-why">Terkunci: {alasan}.</p> : null);
    const detail = !p ? (
        pilihId && daftar.data
            ? <EmptyState title="Principal tidak ada di daftar" message="Mungkin sudah tidak terdaftar. Pilih principal lain." />
            : <EmptyState title="Pilih principal di daftar" message="Varian, alias, riwayat, dan pemakainya tampil di sini." />
    ) : (
        <div style={{ display: "grid", gap: 12 }}>
            <ObjectPageHeader title={p.name} status={<StatusBadge tone={p.isActive ? "pos" : "neu"}>{p.isActive ? "Aktif" : "Nonaktif"}</StatusBadge>}
                actions={bolehTulis ? (
                    <Button variant={p.isActive ? "negative" : "secondary"} icon={<Power className="fi-icon" aria-hidden />} disabled={Boolean(kunciData)} disabledReason={kunciData}
                        onClick={() => buka({ jenis: "status" })}>{p.isActive ? "Nonaktifkan…" : "Aktifkan…"}</Button>
                ) : undefined}
                attributes={[
                    { label: "Kode", value: <><span className="fi-mono">{p.code}</span> <span className="fi-small fi-subtle">Tidak bisa diubah. Kode salah: buat principal baru, nonaktifkan yang lama.</span></> },
                    { label: "Nama resmi", value: p.name },
                    { label: "Dibuat", value: waktuWita(p.createdAt) },
                    { label: "Diubah", value: waktuWita(p.updatedAt) },
                ]} />
            <AnchorBar anchors={[{ id: "p-varian", label: "Varian" }, { id: "p-alias", label: "Alias" }, { id: "p-riwayat", label: "Riwayat" }, { id: "p-dipakai", label: "Dipakai di" }]} />

            <Section id="p-varian" title="Varian" subtitle={p.variants.length ? `${p.variants.length} varian` : "tanpa varian"}
                actions={bolehTulis ? <Button icon={<Plus className="fi-icon" aria-hidden />} disabled={Boolean(kunciPrincipal)} disabledReason={kunciPrincipal} onClick={() => buka({ jenis: "varian-baru" })}>Tambah varian…</Button> : undefined}>
                <div className="fi-sect-in">
                    {bolehTulis && terkunci(kunciPrincipal)}
                    {p.variants.length === 0 ? <p className="fi-muted">Principal ini dirujuk utuh (tanpa varian). Varian dipakai bila satu principal punya beberapa lini, mis. NON_FOOD.</p> : (
                        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }} aria-label={`Varian ${p.name}`}>
                            {p.variants.map((v) => (
                                <li key={v.variantKey} className="fi-btnrow" style={BARIS}>
                                    <b>{labelVarian(v.variantKey)}</b>
                                    <StatusBadge tone={v.isActive ? "pos" : "neu"}>{v.isActive ? "Aktif" : "Nonaktif"}</StatusBadge>
                                    {v.name && <span className="fi-muted">{v.name}</span>}
                                    <span className="fi-spacer" style={{ flex: 1 }} />
                                    {bolehTulis && (
                                        <Button variant="tertiary" icon={<Power className="fi-icon" aria-hidden />} disabled={Boolean(kunciData)} disabledReason={kunciData}
                                            aria-label={`${v.isActive ? "Nonaktifkan" : "Aktifkan"} varian ${labelVarian(v.variantKey)}`}
                                            onClick={() => buka({ jenis: "varian-status", key: v.variantKey })}>{v.isActive ? "Nonaktifkan…" : "Aktifkan…"}</Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </Section>

            <Section id="p-alias" title="Alias" subtitle="ejaan yang dikenali resolver; satu ejaan = satu principal"
                actions={bolehTulis ? <Button icon={<Plus className="fi-icon" aria-hidden />} disabled={Boolean(kunciPrincipal)} disabledReason={kunciPrincipal} onClick={() => buka({ jenis: "alias-baru" })}>Tambah alias…</Button> : undefined}>
                <div className="fi-sect-in">
                    {p.aliases.length === 0 ? <p className="fi-muted">Belum ada alias.</p> : (
                        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }} aria-label={`Alias ${p.name}`}>
                            {p.aliases.map((a) => (
                                <li key={a.id} className="fi-btnrow" style={BARIS}>
                                    <b>{a.aliasAsli}</b>
                                    <span className="fi-tag">{labelJenis(a.jenis)}</span>
                                    {a.variantKey !== null && <span className="fi-tag">Varian {labelVarian(a.variantKey)}</span>}
                                    {a.sumber === SUMBER_KODE && <span className="fi-small fi-subtle">alias kode — tetap</span>}
                                    <span className="fi-spacer" style={{ flex: 1 }} />
                                    {bolehHapus && a.sumber !== SUMBER_KODE && (
                                        <Button variant="tertiary" icon={<Trash2 className="fi-icon" aria-hidden />} disabled={Boolean(kunciData)} disabledReason={kunciData}
                                            aria-label={`Hapus alias ${a.aliasAsli}`} onClick={() => buka({ jenis: "alias-hapus", id: a.id })}>Hapus…</Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </Section>

            <Section id="p-riwayat" title="Riwayat" subtitle="pembuatan, aktif/nonaktif, dan penghapusan alias — terbaru dulu">
                <RiwayatPrincipal key={`${p.id}-${versi}`} id={p.id} />
            </Section>

            <Section id="p-dipakai" title="Dipakai di" subtitle="layar yang membaca data principal">
                <div className="fi-sect-in">
                    {dipakai.length === 0 ? <p className="fi-muted">Akun Anda belum berhak membuka layar-layar yang memakai data principal.</p> : (
                        <>
                            <div className="fi-tiles">{dipakai.map((x) => <Tile key={x.href} title={x.judul} subtitle={x.ket} href={x.href} />)}</div>
                            <p className="fi-small fi-subtle">Layar-layar ini belum menerima saringan principal lewat tautan; pilih {p.name} di layar tujuan.</p>
                        </>
                    )}
                </div>
            </Section>
        </div>
    );

    // ---------- Dialog ----------
    const dv: Varian | undefined = dialog?.jenis === "varian-status" && p ? p.variants.find((v) => v.variantKey === dialog.key) : undefined;
    const da: Alias | undefined = dialog?.jenis === "alias-hapus" && p ? p.aliases.find((a) => a.id === dialog.id) : undefined;
    const nama = p?.name ?? "";
    const alasanBuat = kunciData ?? (!f.kode.trim() ? "Isi kode" : !f.nama.trim() ? "Isi nama resmi" : undefined);
    const alasanVarian = kunciPrincipal ?? (!f.dasar && !f.key.trim() ? "Isi kode varian atau pilih varian dasar" : undefined);
    const alasanAlias = kunciPrincipal ?? (!f.alias.trim() ? "Isi ejaan alias" : undefined);
    const set = (patch: Partial<typeof FORM_KOSONG>) => setF((x) => ({ ...x, ...patch }));

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Pengaturan</span></li><li><span aria-current="page">Data Principal</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>Data Principal</h1>
                    <span className="fi-spacer" />
                    {bolehTulis && <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} disabled={Boolean(kunciData)} disabledReason={kunciData} onClick={() => buka({ jenis: "buat" })}>Tambah principal…</Button>}
                </div>
                <p>Daftar resmi principal beserta varian dan ejaan (alias) yang dikenali sistem. {nAktif} dari {semua.length} principal aktif.</p>
            </header>
            {!bolehTulis && (
                <MessageStrip tone="info" title="Baca-saja.">
                    Akun Anda punya izin Lihat Principles. Menambah principal, varian, alias, dan mengubah status butuh Upload Principles (menghapus alias: Hapus Principles).
                </MessageStrip>
            )}
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}
            {daftar.status === "galat" && daftar.data && (
                <MessageStrip tone="neg" title="Gagal memuat ulang principal.">{daftar.error} Yang tampil hasil sebelumnya; aksi tulis terkunci. <Button variant="tertiary" onClick={segarkan}>Coba lagi</Button></MessageStrip>
            )}
            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar title="Saringan" activeCount={status !== "semua" ? 1 : 0} onReset={() => { setStatus("semua"); setCari(""); }}
                    search={<FormField label="Cari">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Kode, nama, atau alias" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>}
                    fields={
                        <div className="fi-field">
                            <span className="fi-label">Status</span>
                            <div className="fi-segs" role="group" aria-label="Status principal">
                                {([["semua", `Semua ${semua.length}`], ["aktif", `Aktif ${nAktif}`], ["nonaktif", `Nonaktif ${semua.length - nAktif}`]] as const)
                                    .map(([s, label]) => <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{label}</button>)}
                            </div>
                        </div>
                    }
                    chips={status !== "semua" ? [{ label: `Status: ${status === "aktif" ? "Aktif" : "Nonaktif"}`, onRemove: () => setStatus("semua") }] : []} />
            </div>
            <FlexibleColumnLayout list={daftarEl} detail={detail} detailOpen={pilihId !== null} onBack={() => setPilihId(null)} listLabel="Daftar principal" detailLabel="Detail principal" />

            <ConfirmDialog open={dialog?.jenis === "buat"} onClose={() => setDialog(null)} tag="Tambah" title="Tambah principal" confirmLabel="Tambah principal"
                confirmDisabled={alasanBuat} alasanTerlihat
                facts={[["Otomatis", "Alias kode dan alias nama resmi ikut dibuat"], ["Kode", "Tidak bisa diubah sesudah dibuat"], ["Riwayat", "Pembuatan tercatat"]]}
                onConfirm={() => jalankan(async () => {
                    const r = await tulis("/api/principals", "POST", { code: f.kode.trim(), name: f.nama.trim() });
                    const baru = r.principal as Principal;
                    setPilihId(baru.id); setCari(""); setStatus("semua");
                    return `Principal ${baru.code} (${baru.name}) ditambahkan.`;
                })}>
                <div className="fi-formgrid">
                    <FormField label="Kode" required help="1–20 karakter: huruf besar, angka, _ atau -.">
                        {(a11y) => <input {...a11y} className="fi-input" autoComplete="off" maxLength={20} value={f.kode} onChange={(e) => set({ kode: e.target.value.toUpperCase() })} />}
                    </FormField>
                    <FormField label="Nama resmi" required>
                        {(a11y) => <input {...a11y} className="fi-input" autoComplete="off" maxLength={200} value={f.nama} onChange={(e) => set({ nama: e.target.value })} />}
                    </FormField>
                </div>
            </ConfirmDialog>

            <ConfirmDialog open={dialog?.jenis === "status" && Boolean(p)} onClose={() => setDialog(null)} tag={p?.isActive ? "Nonaktif" : "Aktif"} tone={p?.isActive ? "negative" : "primary"}
                title={p?.isActive ? `Nonaktifkan ${nama}?` : `Aktifkan ${nama}?`} confirmLabel={p?.isActive ? "Nonaktifkan" : "Aktifkan"} confirmDisabled={kunciData} alasanTerlihat
                facts={[
                    ["Principal", p ? `${p.code} · ${p.name}` : ""],
                    p?.isActive ? ["Akibat", "Resolver menandainya nonaktif; varian dan alias baru tidak bisa ditambahkan"] : ["Akibat", "Varian dan alias baru bisa ditambahkan lagi"],
                    ["Data", "Varian dan alias tidak dihapus; bisa dikembalikan kapan saja"],
                ]}
                onConfirm={() => jalankan(() => {
                    if (!p) return Promise.resolve("");
                    return ubahAktif(`/api/principals/${p.id}`, { isActive: !p.isActive }, `Principal ${p.name}`, !p.isActive);
                })} />

            <ConfirmDialog open={dialog?.jenis === "varian-baru" && Boolean(p)} onClose={() => setDialog(null)} tag="Tambah" title={`Tambah varian ke ${nama}`} confirmLabel="Tambah varian"
                confirmDisabled={alasanVarian} alasanTerlihat
                facts={[["Principal", p ? `${p.code} · ${p.name}` : ""], ["Nama varian", "Bila diisi, ikut menjadi alias varian"]]}
                onConfirm={() => jalankan(async () => {
                    if (!p) return "";
                    const kunci = f.dasar ? "" : f.key.trim();
                    await tulis(`/api/principals/${p.id}/variants`, "POST", { variantKey: kunci, ...(f.nama.trim() ? { name: f.nama.trim() } : {}) });
                    return `Varian ${labelVarian(kunci.toUpperCase())} ditambahkan ke ${p.name}.`;
                })}>
                <div className="fi-formgrid">
                    <FormField label="Kode varian" required={!f.dasar} help="Huruf besar, angka, _ atau - (maks. 20), mis. NON_FOOD; tanpa spasi.">
                        {(a11y) => <input {...a11y} className="fi-input" autoComplete="off" maxLength={20} disabled={f.dasar} value={f.dasar ? "" : f.key} onChange={(e) => set({ key: e.target.value.toUpperCase() })} />}
                    </FormField>
                    <FormField label="Nama varian (opsional)">
                        {(a11y) => <input {...a11y} className="fi-input" autoComplete="off" maxLength={200} value={f.nama} onChange={(e) => set({ nama: e.target.value })} />}
                    </FormField>
                </div>
                <label className="fi-chip" style={{ justifySelf: "start" }}>
                    <input type="checkbox" checked={f.dasar} onChange={(e) => set({ dasar: e.target.checked })} />Varian dasar (tanpa kode; hanya bila principal punya varian lain)
                </label>
            </ConfirmDialog>

            <ConfirmDialog open={Boolean(dv)} onClose={() => setDialog(null)} tag={dv?.isActive ? "Nonaktif" : "Aktif"} tone={dv?.isActive ? "negative" : "primary"}
                title={`${dv?.isActive ? "Nonaktifkan" : "Aktifkan"} varian ${labelVarian(dv?.variantKey ?? null)} ${nama}?`} confirmLabel={dv?.isActive ? "Nonaktifkan" : "Aktifkan"}
                confirmDisabled={kunciData} alasanTerlihat
                facts={[["Principal", p ? `${p.code} · ${p.name}` : ""], ["Varian", dv ? `${labelVarian(dv.variantKey)}${dv.name ? ` · ${dv.name}` : ""}` : ""], ["Data", "Alias varian tidak dihapus"]]}
                onConfirm={() => jalankan(() => {
                    if (!p || !dv) return Promise.resolve("");
                    return ubahAktif(`/api/principals/${p.id}/variants`, { variantKey: dv.variantKey, isActive: !dv.isActive }, `Varian ${labelVarian(dv.variantKey)} ${p.name}`, !dv.isActive);
                })} />

            <ConfirmDialog open={dialog?.jenis === "alias-baru" && Boolean(p)} onClose={() => setDialog(null)} tag="Tambah" title={`Tambah alias ke ${nama}`} confirmLabel="Tambah alias"
                confirmDisabled={alasanAlias} alasanTerlihat
                facts={[["Principal", p ? `${p.code} · ${p.name}` : ""], ["Penulisan", "Huruf besar-kecil dan tanda baca OCR dirapikan server"], ["Bentrok", "Ejaan yang sudah dipakai principal lain ditolak, tidak ditimpa"]]}
                onConfirm={() => jalankan(async () => {
                    if (!p) return "";
                    const untuk = f.untuk === "*" ? undefined : f.untuk.slice(2);
                    const r = await tulis(`/api/principals/${p.id}/aliases`, "POST", { alias: f.alias.trim(), jenis: f.jenis, ...(untuk === undefined ? {} : { variantKey: untuk }) });
                    return `Alias “${(r.alias as Alias).aliasAsli}” ditambahkan ke ${p.name}.`;
                })}>
                <div className="fi-formgrid">
                    <FormField label="Ejaan alias" required>
                        {(a11y) => <input {...a11y} className="fi-input" autoComplete="off" maxLength={200} value={f.alias} onChange={(e) => set({ alias: e.target.value })} />}
                    </FormField>
                    <FormField label="Jenis" required help={f.jenis === "kode_master_barang" ? "Kode Master Barang = tepat 2 huruf/angka." : undefined}>
                        {(a11y) => <select {...a11y} className="fi-input" value={f.jenis} onChange={(e) => set({ jenis: e.target.value })}>{JENIS_ALIAS.map((j) => <option key={j} value={j}>{LABEL_JENIS[j]}</option>)}</select>}
                    </FormField>
                    <FormField label="Berlaku untuk">
                        {(a11y) => (
                            <select {...a11y} className="fi-input" value={f.untuk} onChange={(e) => set({ untuk: e.target.value })}>
                                <option value="*">Seluruh principal</option>
                                {p?.variants.filter((v) => v.isActive).map((v) => <option key={v.variantKey} value={`v:${v.variantKey}`}>Varian {labelVarian(v.variantKey)}</option>)}
                            </select>
                        )}
                    </FormField>
                </div>
            </ConfirmDialog>

            <ConfirmDialog open={Boolean(da)} onClose={() => setDialog(null)} tag="Hapus" tone="negative" title={`Hapus alias “${da?.aliasAsli ?? ""}” dari ${nama}?`} confirmLabel="Hapus alias"
                confirmDisabled={kunciData} alasanTerlihat
                description="Ejaan ini tidak lagi dikenali sebagai principal ini. Penghapusan tercatat di riwayat."
                facts={[["Principal", p ? `${p.code} · ${p.name}` : ""], ["Alias", da?.aliasAsli ?? ""], ["Jenis", da ? labelJenis(da.jenis) : ""], ["Berlaku untuk", da ? labelVarian(da.variantKey) : ""]]}
                onConfirm={() => jalankan(async () => {
                    if (!p || !da) return "";
                    await tulis(`/api/principals/${p.id}/aliases/${da.id}`, "DELETE");
                    return `Alias “${da.aliasAsli}” dihapus dari ${p.name}.`;
                })} />
        </div>
    );
}
