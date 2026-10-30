/*
 * Tujuan: User (Fiori S7a, FCL): daftar (cari, grup, status) → Object Page user dengan Grup (semua grup + ★ utama: tambah lewat dialog,
 *   keluarkan, tandai/lepas bintang dengan peringatan role), Salesman (O2: tautan ke karyawan salesman Accurate = cabang order), Keamanan
 *   (atur sandi bertopeng, aktif/nonaktif), Riwayat (kursor).
 *   Dialog `buatUser`, `sandi`, `nonaktif`, bintang, `keluarkan`. Menggantikan UserManagement.tsx (window.prompt/confirm).
 * Caller: app/(dashboard)/admin/users/page.tsx (izin dari server: users.view = baca-saja, users.manage = tulis).
 * Dependensi: GET /api/admin/users/permissions, GET /api/admin/groups (hanya users.manage), POST /api/admin/users,
 *   POST /api/admin/users/[id]/{password,status}, PUT|DELETE /api/admin/users/[id]/primary-group, POST|DELETE /api/admin/groups/[id]/members,
 *   GET /api/admin/users/[id]/history, GET|PUT|DELETE /api/admin/users/[id]/salesman (components/admin/TautanSalesman);
 *   components/admin/*, components/fiori/*. Kontrak: docs/handover/S7-KONTRAK-ADMIN-API.md + O1-KONTRAK-ORDER-CABANG.md.
 * Main Functions: Pengguna.
 * Side Effects: HTTP tulis ke API admin (zona auth). Sandi tidak pernah masuk state/URL/riwayat.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, Plus, Power, Star, StarOff, UserMinus } from "lucide-react";
import {
    AnchorBar, Button, EmptyState, ErrorState, FlexibleColumnLayout, KeyValues, ListItem, MessageStrip, ObjectPageHeader, Section, Skeleton, StatusBadge,
} from "@/components/fiori/core";
import { ConfirmDialog, FilterBar, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { DialogKeluarkan, GalatAdmin, PeringatanRole, Riwayat, izinPerluDisegarkan, SandiGanda, muatAdmin, tulisAdmin, type GrupRingkas, type UserBaris } from "@/components/admin/Bersama";
import { labelRole, perkiraanRole, roleDariGrup, statusAkun } from "@/components/admin/admin-ui";
import { TautanSalesman } from "@/components/admin/TautanSalesman";

type Dialog = { jenis: "buat" | "sandi" | "status" | "tambah" } | { jenis: "bintang"; grupId: string | null } | { jenis: "keluar"; grupId: string };
type SaringStatus = "aktif" | "nonaktif" | "semua";

const BACA_SAJA = "Baca-saja: butuh izin Kelola user (users.manage)";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUAT_KOSONG = { nama: "", email: "", grupIds: [] as string[], utamaId: "" };
const TANPA_GRUP: Load<{ groups: GrupRingkas[] }> = { status: "siap", data: { groups: [] } };

const grupTeks = (u: UserBaris) => (u.groups.length
    ? u.groups.map((g) => (g.id === u.primaryGroupId ? `★ ${g.name}` : g.name)).join(" · ")
    : "Tanpa grup (akses role lama)");

export default function Pengguna({ permKeys, aktorId }: { permKeys: string[]; aktorId: string }) {
    const router = useRouter();
    const bolehKelola = permKeys.includes("users.manage");
    const [daftar, muatDaftar] = useLoad(useCallback(() => muatAdmin<{ users: UserBaris[] }>("/api/admin/users/permissions"), []));
    // Daftar grup hanya untuk menulis (tambah ke grup, buat user); GET /api/admin/groups butuh users.manage.
    const [grupL, muatGrup] = useLoad(useCallback(() => (bolehKelola ? muatAdmin<{ groups: GrupRingkas[] }>("/api/admin/groups") : Promise.resolve(TANPA_GRUP)), [bolehKelola]));
    const [cari, setCari] = useState("");
    const [saringStatus, setSaringStatus] = useState<SaringStatus>("aktif");
    const [saringGrup, setSaringGrup] = useState("");
    const [pilihId, setPilihId] = useState<string | null>(null);
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [pesan, setPesan] = useState<{ tone: "pos" | "warn" | "neg"; teks: string } | null>(null);
    const [versi, setVersi] = useState(0);
    const [tambahId, setTambahId] = useState("");
    const [menambah, setMenambah] = useState(false);
    const [buat, setBuat] = useState(BUAT_KOSONG);
    const [alasanNonaktif, setAlasanNonaktif] = useState("");
    const sandiRef = useRef<HTMLInputElement>(null);
    const [alasanSandi, setAlasanSandi] = useState<string | undefined>("Isi sandi sementara");

    const users = daftar.data?.users ?? [];
    const grupList = grupL.data?.groups ?? [];
    const u = users.find((x) => x.id === pilihId) ?? null;
    const st = u ? statusAkun(u) : null;
    // User setengah jadi (buat user gagal sebagian, kontrak USER_SETENGAH_JADI) dibiarkan nonaktif: tidak boleh diaktifkan, IT Support menghapusnya.
    const kunciSetengah = st?.setengah ? "User ini setengah jadi (pembuatannya gagal sebagian); minta IT Support menghapusnya, jangan diaktifkan" : undefined;

    // Aksi tulis terkunci saat data penentu memuat / galat / usang (gagal dimuat ulang).
    const kunciData = daftar.status === "memuat" ? "Menunggu data user dimuat ulang"
        : daftar.status === "galat" ? "Data user gagal dimuat; muat ulang dulu" : undefined;
    const kunciTulis = !bolehKelola ? BACA_SAJA : kunciData;
    const kunciGrup = kunciTulis ?? (grupL.status === "memuat" ? "Menunggu daftar grup dimuat"
        : grupL.status === "galat" ? "Daftar grup gagal dimuat; muat ulang dulu" : undefined);

    function muatSemua() { muatDaftar(); if (bolehKelola) muatGrup(); setVersi((v) => v + 1); }
    /** Coba lagi sesudah galat baca: izin bisa saja yang berubah, jadi izin halaman dibaca ulang bersama datanya. */
    function cobaLagi() { router.refresh(); muatSemua(); }

    /** Penangan aksi tulis: sukses = pesan + muat ulang; galat yang menuntut muat ulang (tidak pasti, data/izin berubah) = tutup dialog,
     * pesan di halaman, muat ulang; galat lain dilempar ke dialog (isian tetap). */
    async function jalankan(fn: () => Promise<string>) {
        try {
            const teks = await fn();
            setDialog(null);
            setPesan({ tone: "pos", teks });
            muatSemua();
        } catch (e) {
            if (e instanceof GalatAdmin && e.muatUlang) {
                setDialog(null);
                setPesan({ tone: e.belumPasti ? "warn" : "neg", teks: e.message });
                muatSemua();
                if (izinPerluDisegarkan(e)) router.refresh(); // izin akun berubah: baca ulang izin layout/halaman, bukan hanya data
                return;
            }
            throw e;
        }
    }

    function buka(d: Dialog) {
        setAlasanSandi("Isi sandi sementara");
        if (d.jenis === "buat") setBuat(BUAT_KOSONG);
        if (d.jenis === "status") setAlasanNonaktif("");
        setDialog(d);
    }

    async function tambahKeGrup() {
        if (!u || !tambahId) return;
        const g = grupList.find((x) => x.id === tambahId);
        setMenambah(true);
        try {
            await jalankan(async () => {
                const r = await tulisAdmin<{ added: boolean; role?: string | null }>(`/api/admin/groups/${tambahId}/members`, "POST", { userId: u.id });
                const role = r.role !== undefined && r.role !== u.role ? ` Role identitas kini ${labelRole(r.role)}.` : "";
                return r.added ? `${u.name} ditambahkan ke ${g?.name ?? "grup"}.${role}` : `${u.name} sudah anggota ${g?.name ?? "grup itu"}; tidak ada yang berubah.`;
            });
            setTambahId("");
        } catch (e) {
            setPesan({ tone: "neg", teks: e instanceof Error ? e.message : String(e) });
        } finally {
            setMenambah(false);
        }
    }

    // ---------- Daftar ----------
    const q = cari.trim().toLowerCase();
    const cocok = users.filter((x) => (!q || x.name.toLowerCase().includes(q) || x.email.toLowerCase().includes(q))
        && (!saringGrup || x.groups.some((g) => g.name === saringGrup)));
    const nAktif = cocok.filter((x) => statusAkun(x).aktif).length;
    const tampil = cocok.filter((x) => saringStatus === "semua" || (saringStatus === "aktif") === statusAkun(x).aktif);
    const namaGrup = [...new Set(users.flatMap((x) => x.groups.map((g) => g.name)))].sort();
    const memuatAwal = daftar.status === "memuat" && !daftar.data;
    const STATUS_LABEL: Record<SaringStatus, string> = { aktif: `Aktif ${nAktif}`, nonaktif: `Nonaktif ${cocok.length - nAktif}`, semua: `Semua ${cocok.length}` };

    const daftarEl = (
        <div className="fi-sect" style={{ borderRadius: 0, boxShadow: "none" }}>
            <header><h2>User</h2><span>{daftar.data ? `${tampil.length} dari ${users.length}` : ""}{daftar.status === "memuat" && daftar.data ? " · memperbarui…" : ""}</span></header>
            {memuatAwal ? <div className="fi-sect-in"><Skeleton rows={6} label="Memuat user" /></div>
                : daftar.status === "galat" && !daftar.data ? <ErrorState title="Daftar user gagal dimuat" message={daftar.error} onRetry={cobaLagi} />
                : users.length === 0 ? <EmptyState title="Belum ada user" message={bolehKelola ? "Buat user pertama lewat tombol Buat user." : undefined} />
                : tampil.length === 0 ? <EmptyState title={q ? `Tidak ada user “${cari.trim()}”` : "Tidak ada user yang sesuai saringan"} message="Cari dengan nama atau email lain, atau ubah saringan status dan grup." />
                : (
                    <ul className="fi-list" style={{ display: "block" }} aria-label="Daftar user">
                        {tampil.map((x) => {
                            const s = statusAkun(x);
                            return (
                                <li key={x.id} className="fi-wl-row">
                                    <ListItem doc={x.email} title={x.name} meta={grupTeks(x)} badge={<StatusBadge tone={s.tone}>{s.label}</StatusBadge>}
                                        current={x.id === pilihId} onClick={() => setPilihId(x.id)} />
                                </li>
                            );
                        })}
                    </ul>
                )}
        </div>
    );

    // ---------- Object Page ----------
    const terkunci = (alasan: string | undefined) => alasan ? <p className="fi-small fi-why">Terkunci: {alasan}.</p> : null;
    const calon = u ? grupList.filter((g) => !u.groups.some((x) => x.id === g.id)) : [];
    const calonPilih = calon.find((g) => g.id === tambahId);
    const prTambah = u && calonPilih ? perkiraanRole(u.groups, u.role, { tambah: { ...calonPilih, isPrimary: false } }) : null;

    const detail = !u ? (
        pilihId && daftar.data
            ? <EmptyState title="User tidak ada di daftar" message="Mungkin sudah dihapus. Pilih user lain." />
            : <EmptyState title="Pilih user di daftar" message="Grup, keamanan, dan riwayat tampil di sini." />
    ) : (
        <div style={{ display: "grid", gap: 12 }}>
            {/* h2: halaman sudah punya h1 "User dan Izin" (audit No 140a). */}
            <ObjectPageHeader title={u.name} headingLevel={2} status={st && <StatusBadge tone={st.tone}>{st.label}</StatusBadge>}
                attributes={[
                    { label: "Email", value: u.email },
                    { label: "Grup utama", value: u.primaryGroupName ? `★ ${u.primaryGroupName}` : "Belum ada (Beranda gabungan izin)" },
                    { label: "Role identitas", value: labelRole(u.role) },
                ]} />
            <AnchorBar anchors={[{ id: "u-grup", label: "Grup" }, { id: "u-salesman", label: "Salesman" }, { id: "u-keamanan", label: "Keamanan" }, { id: "u-riwayat", label: "Riwayat" }]} />

            <Section id="u-grup" title="Grup" subtitle="izin = gabungan semua grup; ★ utama menentukan Beranda">
                <div className="fi-sect-in">
                    {terkunci(kunciTulis)}
                    {u.groups.length === 0 ? (
                        <MessageStrip tone="warn" title="Belum punya grup.">Akses mengikuti role lama ({labelRole(u.role)}). Tambahkan ke grup agar izinnya dari grup.</MessageStrip>
                    ) : (
                        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }} aria-label={`Grup ${u.name}`}>
                            {u.groups.map((g) => (
                                <li key={g.id} className="fi-btnrow" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                                    <b>{g.name}</b>
                                    {g.id === u.primaryGroupId && <StatusBadge tone="info">{g.isPrimary && u.groups.length > 1 ? "★ Utama" : "★ Utama (satu-satunya grup)"}</StatusBadge>}
                                    {g.isPreset && <span className="fi-tag">Preset</span>}
                                    <span className="fi-spacer" style={{ flex: 1 }} />
                                    {u.groups.length > 1 && !g.isPrimary && (
                                        <Button variant="tertiary" icon={<Star className="fi-icon" aria-hidden />} disabled={Boolean(kunciTulis)} disabledReason={kunciTulis}
                                            aria-label={`Jadikan utama: ${g.name}`} onClick={() => buka({ jenis: "bintang", grupId: g.id })}>Jadikan utama…</Button>
                                    )}
                                    {u.groups.length > 1 && g.isPrimary && (
                                        <Button variant="tertiary" icon={<StarOff className="fi-icon" aria-hidden />} disabled={Boolean(kunciTulis)} disabledReason={kunciTulis}
                                            aria-label={`Lepas bintang ${g.name}`} onClick={() => buka({ jenis: "bintang", grupId: null })}>Lepas bintang…</Button>
                                    )}
                                    <Button variant="tertiary" icon={<UserMinus className="fi-icon" aria-hidden />} disabled={Boolean(kunciTulis)} disabledReason={kunciTulis}
                                        aria-label={`Keluarkan dari ${g.name}`} onClick={() => buka({ jenis: "keluar", grupId: g.id })}>Keluarkan…</Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {bolehKelola && (
                        <div className="fi-btnrow" style={{ alignItems: "end" }}>
                            <FormField label="Tambah ke grup">
                                {(a11y) => (
                                    <select {...a11y} className="fi-input" value={tambahId} disabled={Boolean(kunciGrup)} onChange={(e) => setTambahId(e.target.value)}>
                                        <option value="">{calon.length ? "Pilih grup…" : "Sudah anggota semua grup"}</option>
                                        {calon.map((g) => <option key={g.id} value={g.id}>{g.name}{g.isPreset ? " (preset)" : ""}</option>)}
                                    </select>
                                )}
                            </FormField>
                            <Button icon={<Plus className="fi-icon" aria-hidden />} busy={menambah} disabled={Boolean(kunciGrup) || !tambahId}
                                disabledReason={kunciGrup ?? "Pilih grup dulu"} onClick={() => buka({ jenis: "tambah" })}>Tambah ke grup…</Button>
                        </div>
                    )}
                    {bolehKelola && grupL.status === "galat" && <MessageStrip tone="neg" title="Daftar grup gagal dimuat.">{grupL.error} <Button variant="tertiary" onClick={muatGrup}>Coba lagi</Button></MessageStrip>}
                    {prTambah?.berubah && <PeringatanRole dari={u.role} ke={prTambah.role} />}
                </div>
            </Section>

            <Section id="u-salesman" title="Karyawan Accurate (salesman)" subtitle="cabang salesman = cabang karyawan di Accurate; menentukan pelanggan dan barang Order Sales">
                <TautanSalesman key={`${u.id}-${versi}`} user={{ id: u.id, name: u.name }} bolehKelola={bolehKelola} kunciTulis={kunciTulis} jalankan={jalankan} />
            </Section>

            <Section id="u-keamanan" title="Keamanan" subtitle="tanpa email: beri tahu sandi langsung ke user">
                <div className="fi-sect-in">
                    {terkunci(kunciTulis)}
                    {kunciSetengah && (
                        <MessageStrip tone="warn" title="User ini belum selesai dibuat.">
                            Pembuatannya gagal sebagian dan dibiarkan nonaktif (tidak bisa masuk). Minta IT Support menghapusnya (id {u.id}), lalu buat ulang. Jangan diaktifkan.
                        </MessageStrip>
                    )}
                    <KeyValues items={[
                        ["Status", st?.label ?? ""],
                        ...(u.banned && u.banReason ? [["Alasan nonaktif", u.banReason] as [string, string]] : []),
                    ]} />
                    <div className="fi-btnrow">
                        <Button icon={<KeyRound className="fi-icon" aria-hidden />} disabled={Boolean(kunciTulis)} disabledReason={kunciTulis} onClick={() => buka({ jenis: "sandi" })}>Atur sandi sementara…</Button>
                        <Button variant={st?.aktif ? "negative" : "secondary"} icon={<Power className="fi-icon" aria-hidden />} disabled={Boolean(kunciTulis ?? kunciSetengah)} disabledReason={kunciTulis ?? kunciSetengah}
                            onClick={() => buka({ jenis: "status" })}>{st?.aktif ? "Nonaktifkan…" : "Aktifkan…"}</Button>
                    </div>
                    {!kunciTulis && terkunci(kunciSetengah)}
                    <p className="fi-small fi-subtle">Atur sandi dan Nonaktifkan mengakhiri semua sesi user itu. Nonaktif tidak menghapus user; grup dan riwayat tetap. Untuk mencabut akses, Nonaktifkan (user tidak boleh tanpa grup).</p>
                </div>
            </Section>

            <Section id="u-riwayat" title="Riwayat" subtitle="grup, bintang, sandi, dan status; terbaru dulu">
                <Riwayat key={`${u.id}-${versi}`} url={`/api/admin/users/${u.id}/history`} sudut="user" />
            </Section>
        </div>
    );

    // ---------- Dialog ----------
    const dGrup = dialog && "grupId" in dialog && u ? u.groups.find((g) => g.id === dialog.grupId) ?? null : null;
    const prBintang = dialog?.jenis === "bintang" && u ? perkiraanRole(u.groups, u.role, { bintang: dialog.grupId }) : null;
    const bintangLama = u?.groups.find((g) => g.isPrimary) ?? null;
    const buatUtama = buat.grupIds.length === 1 ? grupList.find((g) => g.id === buat.grupIds[0]) : grupList.find((g) => g.id === buat.utamaId);
    const buatAlasan = kunciGrup ?? (!buat.nama.trim() ? "Isi nama" : !EMAIL.test(buat.email.trim()) ? "Isi email yang valid"
        : buat.grupIds.length === 0 ? "Pilih minimal satu grup awal" : alasanSandi);
    const diriSendiri = u?.id === aktorId;

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Pengaturan</span></li><li><span aria-current="page">User dan Izin</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>User dan Izin</h1>
                    <span className="fi-spacer" />
                    {bolehKelola && <Link className="fi-btn fi-btn--secondary" href="/admin/groups">Kelola Akses Grup</Link>}
                    <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} disabled={Boolean(kunciGrup)} disabledReason={kunciGrup} onClick={() => buka({ jenis: "buat" })}>Buat user…</Button>
                </div>
                <p>Satu tempat per orang: semua grup (★ grup utama menentukan Beranda), keamanan akun, dan riwayat. Izin per grup diatur di Kelola Akses Grup.</p>
            </header>
            {!bolehKelola && (
                <MessageStrip tone="info" title="Baca-saja.">
                    Akun Anda punya izin Lihat user (users.view). Membuat user, mengubah grup, sandi, dan status butuh Kelola user (users.manage); tombolnya terkunci.
                </MessageStrip>
            )}
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}
            {daftar.status === "galat" && daftar.data && (
                <MessageStrip tone="neg" title="Gagal memuat ulang user.">{daftar.error} Yang tampil hasil sebelumnya; aksi tulis terkunci. <Button variant="tertiary" onClick={cobaLagi}>Coba lagi</Button></MessageStrip>
            )}
            <div className="fi-panel" style={{ padding: 0, overflow: "clip" }}>
                <FilterBar title="Saringan" activeCount={(saringGrup ? 1 : 0) + (saringStatus !== "aktif" ? 1 : 0)} onReset={() => { setSaringGrup(""); setSaringStatus("aktif"); }}
                    search={<FormField label="Cari">{(a11y) => <input {...a11y} className="fi-input" type="search" placeholder="Nama atau email" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>}
                    fields={<>
                        <FormField label="Grup">{(a11y) => <select {...a11y} className="fi-input" value={saringGrup} onChange={(e) => setSaringGrup(e.target.value)}><option value="">Semua grup</option>{namaGrup.map((n) => <option key={n}>{n}</option>)}</select>}</FormField>
                        <div className="fi-field">
                            <span className="fi-label">Status</span>
                            <div className="fi-segs" role="group" aria-label="Status akun">
                                {(["aktif", "nonaktif", "semua"] as const).map((s) => <button key={s} type="button" aria-pressed={saringStatus === s} onClick={() => setSaringStatus(s)}>{STATUS_LABEL[s]}</button>)}
                            </div>
                        </div>
                    </>}
                    chips={[
                        ...(saringGrup ? [{ label: `Grup: ${saringGrup}`, onRemove: () => setSaringGrup("") }] : []),
                        ...(saringStatus !== "aktif" ? [{ label: `Status: ${saringStatus === "semua" ? "Semua" : "Nonaktif"}`, onRemove: () => setSaringStatus("aktif") }] : []),
                    ]} />
            </div>
            <FlexibleColumnLayout list={daftarEl} detail={detail} detailOpen={pilihId !== null} onBack={() => setPilihId(null)} listLabel="Daftar user" detailLabel="Detail user" />

            <ConfirmDialog open={dialog?.jenis === "buat"} onClose={() => setDialog(null)} tag="Buat" title="Buat user" confirmLabel="Buat user"
                confirmDisabled={buatAlasan} alasanTerlihat
                facts={[
                    ["Masuk", "Dengan email dan sandi ini; tanpa email aktivasi"],
                    ["Sandi", "Beri tahu langsung ke user; tidak wajib diganti saat masuk"],
                    ["Role identitas", roleDariGrup(buatUtama ?? null) ?? "viewer"],
                    ["Riwayat", "Pembuatan tercatat tanpa isi sandi"],
                ]}
                onConfirm={() => jalankan(async () => {
                    const groupIds = buat.grupIds;
                    const r = await tulisAdmin<{ user: { id: string; name: string } }>("/api/admin/users", "POST", {
                        name: buat.nama.trim(), email: buat.email.trim(), password: sandiRef.current?.value ?? "", groupIds,
                        ...(groupIds.length > 1 && buat.utamaId ? { primaryGroupId: buat.utamaId } : {}),
                    });
                    setPilihId(r.user.id);
                    setSaringStatus("aktif");
                    const nama = groupIds.map((id) => grupList.find((g) => g.id === id)?.name).filter(Boolean).join(", ");
                    return `${r.user.name} dibuat dengan grup ${nama}. Beri tahu sandinya langsung ke ${r.user.name}.`;
                })}>
                <div className="fi-formgrid">
                    <FormField label="Nama" required>{(a11y) => <input {...a11y} className="fi-input" autoComplete="off" value={buat.nama} onChange={(e) => setBuat({ ...buat, nama: e.target.value })} />}</FormField>
                    <FormField label="Email" required help="Dipakai untuk masuk; tidak harus alamat nyata.">{(a11y) => <input {...a11y} className="fi-input" type="email" autoComplete="off" value={buat.email} onChange={(e) => setBuat({ ...buat, email: e.target.value })} />}</FormField>
                </div>
                <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                    <legend className="fi-label">Grup awal<span className="fi-req" aria-hidden>*</span></legend>
                    <ul className="fi-chips" style={{ margin: "6px 0 0" }}>
                        {grupList.map((g) => (
                            <li key={g.id}>
                                <label className="fi-chip pointer-coarse:min-h-11">
                                    <input type="checkbox" checked={buat.grupIds.includes(g.id)} onChange={(e) => {
                                        const grupIds = e.target.checked ? [...buat.grupIds, g.id] : buat.grupIds.filter((x) => x !== g.id);
                                        setBuat({ ...buat, grupIds, utamaId: grupIds.includes(buat.utamaId) ? buat.utamaId : "" });
                                    }} />{g.name}
                                </label>
                            </li>
                        ))}
                    </ul>
                </fieldset>
                {buat.grupIds.length > 1 && (
                    <FormField label="Grup utama (★)" help="Opsional. Menentukan Beranda; grup preset juga menurunkan role identitas.">
                        {(a11y) => (
                            <select {...a11y} className="fi-input" value={buat.utamaId} onChange={(e) => setBuat({ ...buat, utamaId: e.target.value })}>
                                <option value="">Tanpa bintang (Beranda gabungan izin)</option>
                                {buat.grupIds.map((id) => <option key={id} value={id}>{grupList.find((g) => g.id === id)?.name ?? id}</option>)}
                            </select>
                        )}
                    </FormField>
                )}
                <SandiGanda masuk={sandiRef} onUbah={setAlasanSandi} />
            </ConfirmDialog>

            <ConfirmDialog open={dialog?.jenis === "sandi" && Boolean(u)} onClose={() => setDialog(null)} tag="Sandi" title={`Atur sandi sementara untuk ${u?.name ?? ""}`}
                confirmLabel="Simpan sandi" confirmDisabled={kunciTulis ?? alasanSandi} alasanTerlihat
                facts={[
                    ["Tanpa email", "Beri tahu sandi langsung ke user; tidak wajib diganti saat masuk"],
                    ["Akibat", "Semua sesi user ini diakhiri (keluar dari semua perangkat)"],
                    ["Riwayat", "Tercatat tanpa isi sandi"],
                ]}
                onConfirm={() => jalankan(async () => {
                    if (!u) return "";
                    const r = await tulisAdmin<{ sessionsRevoked: number }>(`/api/admin/users/${u.id}/password`, "POST", { password: sandiRef.current?.value ?? "" });
                    return `Sandi ${u.name} diatur; ${r.sessionsRevoked} sesi diakhiri. Beri tahu sandinya langsung ke ${u.name}.`;
                })}>
                {diriSendiri && <MessageStrip tone="warn" title="Ini akun Anda sendiri.">Sesi Anda juga diakhiri. Anda harus masuk lagi dengan sandi baru.</MessageStrip>}
                <SandiGanda masuk={sandiRef} onUbah={setAlasanSandi} />
            </ConfirmDialog>

            <ConfirmDialog open={dialog?.jenis === "status" && Boolean(u)} onClose={() => setDialog(null)} tag={st?.aktif ? "Nonaktif" : "Aktif"}
                tone={st?.aktif ? "negative" : "primary"} title={st?.aktif ? `Nonaktifkan ${u?.name ?? ""}?` : `Aktifkan ${u?.name ?? ""}?`}
                confirmLabel={st?.aktif ? "Nonaktifkan" : "Aktifkan"} alasanTerlihat
                confirmDisabled={kunciTulis ?? kunciSetengah ?? (st?.aktif && diriSendiri ? "Anda tidak bisa menonaktifkan akun sendiri"
                    : !st?.aktif && u?.groups.length === 0 ? `Tambahkan ${u?.name} ke grup dulu (user aktif tanpa grup jatuh ke akses role lama)` : undefined)}
                facts={st?.aktif ? [
                    ["Akibat", "Tidak bisa masuk; sesi di semua perangkat diakhiri"],
                    ["Data", "User tidak dihapus; grup dan riwayat tetap"],
                    ["Kembali", "Bisa diaktifkan lagi kapan saja"],
                ] : [
                    ["Akibat", "Bisa masuk lagi dengan sandi terakhirnya"],
                    ["Grup", u?.groups.length ? u.groups.map((g) => g.name).join(", ") : "Tidak ada"],
                ]}
                onConfirm={() => jalankan(async () => {
                    if (!u || !st) return "";
                    const alasan = alasanNonaktif.trim();
                    const r = await tulisAdmin<{ changed: boolean; active: boolean; sessionsRevoked: number }>(`/api/admin/users/${u.id}/status`, "POST",
                        { active: !st.aktif, ...(st.aktif && alasan ? { reason: alasan } : {}) }, { aktivasi: !st.aktif });
                    if (!r.changed) return `${u.name} sudah ${r.active ? "aktif" : "nonaktif"}; tidak ada yang berubah.`;
                    return r.active ? `${u.name} diaktifkan.` : `${u.name} dinonaktifkan; ${r.sessionsRevoked} sesi diakhiri.`;
                })}>
                {st?.aktif && (
                    <FormField label="Alasan (opsional)" help="Maksimal 200 karakter; tampil di status dan riwayat.">
                        {(a11y) => <textarea {...a11y} className="fi-input" maxLength={200} rows={2} value={alasanNonaktif} onChange={(e) => setAlasanNonaktif(e.target.value)} />}
                    </FormField>
                )}
            </ConfirmDialog>

            <ConfirmDialog open={dialog?.jenis === "bintang" && Boolean(u)} onClose={() => setDialog(null)} tag="Grup utama" confirmLabel={dialog?.jenis === "bintang" && dialog.grupId ? "Jadikan utama" : "Lepas bintang"}
                title={dialog?.jenis === "bintang" && dialog.grupId ? `Jadikan ${dGrup?.name ?? ""} grup utama ${u?.name ?? ""}?` : `Lepas bintang ${bintangLama?.name ?? ""} dari ${u?.name ?? ""}?`}
                confirmDisabled={kunciTulis} alasanTerlihat
                facts={prBintang ? [
                    ["Beranda", prBintang.utama ? `Mengikuti ${prBintang.utama.name}` : "Gabungan izin (tanpa grup utama)"],
                    ["Izin", "Tidak berubah: tetap gabungan semua grup"],
                    ["Role identitas", prBintang.berubah ? `${labelRole(u?.role)} → ${labelRole(prBintang.role)}` : "Tidak berubah"],
                ] : undefined}
                onConfirm={() => jalankan(async () => {
                    if (!u || dialog?.jenis !== "bintang") return "";
                    const url = `/api/admin/users/${u.id}/primary-group`;
                    const r = dialog.grupId
                        ? await tulisAdmin<{ changed: boolean; role: string | null; roleChanged: boolean }>(url, "PUT", { groupId: dialog.grupId })
                        : await tulisAdmin<{ changed: boolean; role: string | null; roleChanged: boolean }>(url, "DELETE");
                    if (!r.changed) return "Tidak ada yang berubah.";
                    const role = r.roleChanged ? ` Role identitas kini ${labelRole(r.role)}.` : "";
                    return dialog.grupId ? `Grup utama ${u.name}: ${dGrup?.name ?? ""}.${role}` : `Bintang ${bintangLama?.name ?? ""} dilepas dari ${u.name}.${role}`;
                })}>
                {prBintang?.berubah && <PeringatanRole dari={u?.role ?? null} ke={prBintang.role} />}
            </ConfirmDialog>

            {/* Tambah ke grup memberi izin (dan bisa mengubah role identitas): lewat dialog (audit No 5); fungsi tulis tetap tambahKeGrup. */}
            <ConfirmDialog open={dialog?.jenis === "tambah" && Boolean(u && calonPilih)} onClose={() => setDialog(null)} tag="Grup"
                title={`Tambahkan ${u?.name ?? ""} ke ${calonPilih?.name ?? ""}?`} confirmLabel="Tambahkan" confirmDisabled={kunciGrup} alasanTerlihat
                facts={u && calonPilih ? [
                    ["Grup", `${calonPilih.name}${calonPilih.isPreset ? " (preset)" : ""}`],
                    ["Izin yang didapat", `${calonPilih.permCount} kunci izin grup ini; izin user = gabungan semua grupnya`],
                    ["Role identitas", prTambah?.berubah ? `${labelRole(u.role)} → ${labelRole(prTambah.role)}` : "Tidak berubah"],
                    ["Berlaku", "Pada permintaan berikutnya; tidak perlu masuk ulang"],
                    ["Riwayat", "Tercatat di riwayat user dan grup"],
                ] : undefined}
                onConfirm={async () => { await tambahKeGrup(); setDialog(null); }} />
            <DialogKeluarkan target={dialog?.jenis === "keluar" && u && dGrup ? { user: u, grup: dGrup } : null} aktorId={aktorId} kunci={kunciTulis}

                onClose={() => setDialog(null)} jalankan={jalankan} />
        </div>
    );
}
