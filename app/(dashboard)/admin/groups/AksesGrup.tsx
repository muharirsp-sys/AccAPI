/*
 * Tujuan: Akses Grup (Fiori S7a, FCL): daftar grup (preset terkunci nama) → Object Page dengan Izin per modul (20 modul, label satu
 *   sumber lib/rbac; kunci kapabilitas dicentang satu per satu), Anggota (tambah dan keluarkan lewat dialog), Info, Riwayat; footer Simpan → dialog
 *   SELISIH izin (ditambah/dicabut, anggota terkena; mencabut users.manage = peringatan + tombol tegas); Hapus grup custom; Grup baru.
 *   Menggantikan GroupManagement.tsx (gaya inline + hex, confirm, simpan langsung).
 * Caller: app/(dashboard)/admin/groups/page.tsx (gerbang users.manage).
 * Dependensi: GET|POST /api/admin/groups, GET|PATCH|DELETE /api/admin/groups/[id], POST|DELETE /api/admin/groups/[id]/members,
 *   GET /api/admin/groups/[id]/history, GET /api/admin/users/permissions; lib/rbac(/registry); config/workspace-navigation (nama halaman
 *   tujuan); lib/tampil (KOSONG); components/admin/*, components/fiori/*.
 * Main Functions: AksesGrup.
 * Side Effects: HTTP tulis ke API admin (zona auth). beforeunload saat ada draf izin/info.
 * TERBUKA (server): PATCH grup tidak menerima/mencatat alasan cabut users.manage (kontrak §5.8) — karena itu dialog TIDAK meminta
 *   isian alasan (tidak boleh mewajibkan isian yang dibuang); konfirmasinya tegas lewat peringatan + tombol "Simpan dan cabut Kelola user".
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Save, Trash2, UserMinus, UserPlus } from "lucide-react";
import {
    AnchorBar, Button, EmptyState, ErrorState, FlexibleColumnLayout, FooterToolbar, ListItem, MessageStrip, ObjectPageHeader, Section, Skeleton, StatusBadge,
} from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, useUnsavedGuard, type Load } from "@/components/fiori/interactive";
import { DialogKeluarkan, GalatAdmin, PeringatanRole, Riwayat, izinPerluDisegarkan, muatAdmin, tulisAdmin, type GrupRingkas, type UserBaris } from "@/components/admin/Bersama";
import { labelRole, perkiraanRole, selisihIzin } from "@/components/admin/admin-ui";
import { HOME_ITEM, WORKSPACE_GROUPS, activeNavigationItem } from "@/config/workspace-navigation";
import { actionLabels, permissionKeyLabel, permissionModuleLabels } from "@/lib/rbac";
import { KOSONG as KOSONG_TEKS } from "@/lib/tampil";
import { CAPABILITY_KEYS, PERMISSION_MODULES, PERMISSION_REGISTRY, isValidPermissionKey, moduleAllOn, toggleModuleKeys, type PermissionModule } from "@/lib/rbac/registry";

type Anggota = { userId: string; userName: string; userEmail: string; isPrimary: boolean };
type DetailGrup = { group: { id: string; name: string; description: string | null; isPreset: boolean }; permissions: string[]; members: Anggota[] };
type Draf = { name: string; description: string; perms: Set<string> };
type Dialog = "simpan" | "hapus" | "baru" | "buang" | "tambah" | { keluar: string };

const AKSI = actionLabels as Record<string, string>;
const KOSONG: Load<DetailGrup | null> = { status: "siap", data: null };
const daftarNama = (nama: string[], maks = 5) => nama.slice(0, maks).join(", ") + (nama.length > maks ? ` dan ${nama.length - maks} lain` : "");
/** Nama menu untuk tautan tujuan yang ditahan (bukan path mentah; audit No 30). */
const SEMUA_MENU = [HOME_ITEM, ...WORKSPACE_GROUPS.flatMap((g) => g.items)];
const namaHalaman = (tujuan: string) => activeNavigationItem(tujuan.split(/[?#]/)[0], SEMUA_MENU)?.name ?? "Halaman lain";

export default function AksesGrup({ aktorId }: { aktorId: string }) {
    const router = useRouter();
    const [grupL, muatGrup] = useLoad(useCallback(() => muatAdmin<{ groups: GrupRingkas[] }>("/api/admin/groups"), []));
    const [userL, muatUser] = useLoad(useCallback(() => muatAdmin<{ users: UserBaris[] }>("/api/admin/users/permissions"), []));
    const [pilihId, setPilihId] = useState<string | null>(null);
    const [detailL, muatDetail] = useLoad(useCallback(() => (pilihId ? muatAdmin<DetailGrup>(`/api/admin/groups/${pilihId}`) : Promise.resolve(KOSONG)), [pilihId]));
    const [draf, setDraf] = useState<Draf | null>(null);
    const [dialog, setDialog] = useState<Dialog | null>(null);
    const [pindahKe, setPindahKe] = useState<string | null | undefined>(undefined);
    const [tujuan, setTujuan] = useState<string | null>(null); // tautan keluar halaman yang sedang ditahan (draf belum disimpan)
    const [pesan, setPesan] = useState<{ tone: "pos" | "warn" | "neg"; teks: string } | null>(null);
    const [cari, setCari] = useState("");
    const [versi, setVersi] = useState(0);
    const [baru, setBaru] = useState({ nama: "", deskripsi: "" });
    const [tambahId, setTambahId] = useState("");
    const [menambah, setMenambah] = useState(false);

    const groups = grupL.data?.groups ?? [];
    const users = userL.data?.users ?? [];
    const det = detailL.data && detailL.data.group.id === pilihId ? detailL.data : null;
    // Kunci di DB yang tak ada di registry (usang) tidak tampil dan tidak ikut draf: dikirim TANPA kunci itu (server menolak KUNCI_TIDAK_VALID),
    // diumumkan di Object Page dan di dialog selisih, dan tercatat dicabut oleh server saat izin disimpan.
    const asli: Draf | null = det ? { name: det.group.name, description: det.group.description ?? "", perms: new Set(det.permissions.filter(isValidPermissionKey)) } : null;
    const usang = det ? det.permissions.filter((k) => !isValidPermissionKey(k)).sort() : [];
    const nilai = draf ?? asli;
    const sel = asli && nilai ? selisihIzin(asli.perms, nilai.perms) : { ditambah: [], dicabut: [] };
    const infoBerubah = Boolean(asli && nilai && (nilai.name.trim() !== asli.name || nilai.description.trim() !== asli.description));
    const izinBerubah = sel.ditambah.length + sel.dicabut.length > 0;
    const berubah = izinBerubah || infoBerubah;
    useUnsavedGuard(berubah);
    // Navigasi klien (Link, menu samping, bilah bawah, pencarian menu) tidak memicu beforeunload dan kit belum punya penjaga navigasi:
    // selama ada draf, klik tautan ke halaman lain ditahan di fase tangkap (tanpa mengubah SidebarLayout) dan ditanyakan lewat dialog.
    // TERBUKA: tombol Kembali/Maju peramban dan navigasi terprogram tidak tertahan (butuh penjaga navigasi di kit).
    useEffect(() => {
        if (!berubah) return;
        const tahan = (e: MouseEvent) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
            if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
            const url = new URL(a.href, window.location.href);
            if (url.origin !== window.location.origin) return;
            if (url.pathname === window.location.pathname && url.search === window.location.search) return; // tautan #hash di halaman ini
            e.preventDefault();
            e.stopPropagation();
            setTujuan(url.pathname + url.search + url.hash);
            setDialog("buang");
        };
        document.addEventListener("click", tahan, true);
        return () => document.removeEventListener("click", tahan, true);
    }, [berubah]);
    const adminPreset = Boolean(det?.group.isPreset && det.group.name === "Admin");
    const cabutKelola = sel.dicabut.includes("users.manage");

    // Aksi tulis terkunci saat data penentu (detail grup; untuk anggota juga daftar user) memuat / galat / usang.
    const kunciSimpan = !pilihId ? undefined : detailL.status === "memuat" ? "Menunggu detail grup dimuat ulang"
        : detailL.status === "galat" ? "Detail grup gagal dimuat; muat ulang dulu" : undefined;
    const kunciAnggota = kunciSimpan ?? (userL.status === "memuat" ? "Menunggu daftar user dimuat"
        : userL.status === "galat" ? "Daftar user gagal dimuat; muat ulang dulu" : undefined);

    function muatSemua() { muatGrup(); muatUser(); muatDetail(); setVersi((v) => v + 1); }
    /** Coba lagi sesudah galat baca: izin bisa saja yang berubah, jadi izin halaman dibaca ulang bersama datanya. */
    function cobaLagi() { router.refresh(); muatSemua(); }

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
                if (izinPerluDisegarkan(e)) router.refresh(); // izin akun berubah: baca ulang izin layout/halaman (tanpa users.manage halaman ini menolak), bukan hanya data
                return;
            }
            throw e;
        }
    }

    function pindah(id: string | null) { setPilihId(id); setDraf(null); setTambahId(""); }
    /** Perubahan belum disimpan tidak dibuang diam-diam: pindah grup lewat dialog. */
    function buka(id: string | null) { if (berubah) { setPindahKe(id); setDialog("buang"); } else pindah(id); }
    const ubah = (patch: Partial<Draf>) => { if (nilai) setDraf({ ...nilai, ...patch }); };
    function toggleKunci(key: string) {
        if (!nilai) return;
        const perms = new Set(nilai.perms);
        if (perms.has(key)) perms.delete(key); else perms.add(key);
        ubah({ perms });
    }
    function toggleModul(mod: PermissionModule) {
        if (!nilai) return;
        const perms = toggleModuleKeys(nilai.perms, mod);
        if (adminPreset && nilai.perms.has("users.manage")) perms.add("users.manage"); // tidak bisa dicabut dari preset Admin (server: ADMIN_PRESET_TERKUNCI)
        ubah({ perms });
    }

    async function tambahAnggota() {
        if (!det || !tambahId) return;
        const u = users.find((x) => x.id === tambahId);
        setMenambah(true);
        try {
            await jalankan(async () => {
                const r = await tulisAdmin<{ added: boolean; role?: string | null }>(`/api/admin/groups/${det.group.id}/members`, "POST", { userId: tambahId });
                const role = u && r.role !== undefined && r.role !== u.role ? ` Role identitas ${u.name} kini ${labelRole(r.role)}.` : "";
                return r.added ? `${u?.name ?? "User"} ditambahkan ke ${det.group.name}.${role}` : `${u?.name ?? "User"} sudah anggota ${det.group.name}; tidak ada yang berubah.`;
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
    const tampil = groups.filter((g) => !q || g.name.toLowerCase().includes(q));
    const daftarEl = (
        <div className="fi-sect" style={{ borderRadius: 0, boxShadow: "none" }}>
            <header><h2>Grup</h2><span>{grupL.data ? `${tampil.length} dari ${groups.length}` : ""}{grupL.status === "memuat" && grupL.data ? " · memperbarui…" : ""}</span></header>
            <div className="fi-sect-in" style={{ paddingBottom: 0 }}>
                <FormField label="Cari grup">{(a11y) => <input {...a11y} className="fi-input" type="search" value={cari} onChange={(e) => setCari(e.target.value)} />}</FormField>
            </div>
            {grupL.status === "memuat" && !grupL.data ? <div className="fi-sect-in"><Skeleton rows={6} label="Memuat grup" /></div>
                : grupL.status === "galat" && !grupL.data ? <ErrorState title="Daftar grup gagal dimuat" message={grupL.error} onRetry={cobaLagi} />
                : groups.length === 0 ? <EmptyState title="Belum ada grup" message="Buat grup lewat tombol Grup baru." />
                : tampil.length === 0 ? <EmptyState title={`Tidak ada grup “${cari.trim()}”`} message="Cari dengan nama lain." />
                : (
                    <ul className="fi-list" style={{ display: "block" }} aria-label="Daftar grup">
                        {tampil.map((g) => (
                            <li key={g.id} className="fi-wl-row">
                                <ListItem doc={`${g.permCount} izin · ${g.memberCount} anggota`} title={g.name} meta={g.description || undefined} current={g.id === pilihId} onClick={() => buka(g.id)}
                                    badge={<StatusBadge tone={g.isPreset ? "neu" : "info"}>{g.isPreset ? "Preset" : "Custom"}</StatusBadge>} />
                            </li>
                        ))}
                    </ul>
                )}
        </div>
    );

    // ---------- Object Page ----------
    const anggotaUser = (det?.members ?? []).map((m) => ({ m, u: users.find((x) => x.id === m.userId) }));
    const terakhir = anggotaUser.filter(({ u }) => u && u.groups.length === 1).map(({ m }) => m.userName);
    const calon = det ? users.filter((x) => !det.members.some((m) => m.userId === x.id)) : [];
    // Perkiraan role identitas bila user terpilih ditambahkan (cermin server, sama dengan layar User) — diperingatkan SEBELUM klik.
    const calonPilih = calon.find((x) => x.id === tambahId) ?? null;
    const prTambah = det && calonPilih
        ? perkiraanRole(calonPilih.groups, calonPilih.role, { tambah: { id: det.group.id, name: det.group.name, isPreset: det.group.isPreset, isPrimary: false } }) : null;
    // Hapus grup: role identitas tiap anggota yang berubah (keluar dari grup ini -> utama/role dihitung ulang).
    const perubahanRole = det ? anggotaUser.flatMap(({ m, u }) => {
        if (!u) return [];
        const p = perkiraanRole(u.groups, u.role, { keluar: det.group.id });
        return p.berubah ? [`${m.userName}: ${labelRole(u.role)} → ${labelRole(p.role)}`] : [];
    }) : [];
    const keluarTarget = dialog && typeof dialog === "object" && det ? (() => {
        const u = users.find((x) => x.id === dialog.keluar);
        return u ? { user: u, grup: { id: det.group.id, name: det.group.name } } : null;
    })() : null;

    const detail = !pilihId ? <EmptyState title="Pilih grup di daftar" message="Izin per modul, anggota, dan riwayat tampil di sini." />
        : detailL.status === "memuat" && !det ? <div className="fi-sect-in"><Skeleton rows={8} label="Memuat detail grup" /></div>
        : !det || !nilai ? <ErrorState title="Detail grup gagal dimuat" message={detailL.error ?? "Grup tidak ditemukan. Mungkin sudah dihapus."} onRetry={muatDetail} />
        : (
            <div style={{ display: "grid", gap: 12 }}>
                {/* h2: halaman sudah punya h1 "Kelola Akses Grup" (audit No 140a). */}
                <ObjectPageHeader title={det.group.name} draft={berubah} headingLevel={2}
                    actions={
                        // Aksi destruktif di header objek (bukan footer): footer Draf hanya memuat Batal + Simpan, selalu muat 390 px (tinjauan S7a #1).
                        <Button variant="tertiary" icon={<Trash2 className="fi-icon" aria-hidden />} disabled={det.group.isPreset || Boolean(kunciAnggota)}
                            disabledReason={det.group.isPreset ? "Grup preset tidak bisa dihapus" : kunciAnggota} onClick={() => setDialog("hapus")}>Hapus grup…</Button>
                    }
                    status={<StatusBadge tone={det.group.isPreset ? "neu" : "info"}>{det.group.isPreset ? "Preset" : "Custom"}</StatusBadge>}
                    attributes={[
                        { label: "Izin", value: String(asli?.perms.size ?? 0) },
                        { label: "Anggota", value: String(det.members.length) },
                        { label: "Jenis", value: det.group.isPreset ? "Preset: nama terkunci, tidak bisa dihapus" : "Custom" },
                    ]} />
                <AnchorBar anchors={[{ id: "g-izin", label: "Izin" }, { id: "g-anggota", label: "Anggota" }, { id: "g-info", label: "Info" }, { id: "g-riwayat", label: "Riwayat" }]} />
                {detailL.status === "galat" && <MessageStrip tone="neg" title="Gagal memuat ulang detail grup.">{detailL.error} Yang tampil hasil sebelumnya; simpan terkunci. <Button variant="tertiary" onClick={muatDetail}>Coba lagi</Button></MessageStrip>}
                {det.group.isPreset && <MessageStrip tone="info">Grup preset: izinnya bisa diubah di sini, tetapi kembali ke bawaan bila seed preset dijalankan dengan reset.</MessageStrip>}

                <Section id="g-izin" title="Izin" subtitle={`${nilai.perms.size} kunci aktif · label tugas; garis putus = kunci kapabilitas, dicentang satu per satu`}>
                    <div className="fi-sect-in">
                        {kunciSimpan && <p className="fi-small fi-why">Terkunci: {kunciSimpan}.</p>}
                        {usang.length > 0 && (
                            <MessageStrip tone="info" title={`Grup ini memuat ${usang.length} kunci usang (tidak dikenal registry).`}>
                                {usang.join(", ")}. Kunci itu tidak tampil di daftar dan dibuang saat Anda menyimpan perubahan izin; riwayat mencatatnya sebagai dicabut.
                            </MessageStrip>
                        )}
                        {nilai.perms.size === 0 && <MessageStrip tone="info" title="Grup ini belum punya izin.">Centang izin per modul. Anggota grup tanpa izin hanya melihat Beranda.</MessageStrip>}
                        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))" }}>
                            {PERMISSION_MODULES.map((mod) => {
                                const aksi = PERMISSION_REGISTRY[mod] as readonly string[];
                                const nyala = aksi.filter((a) => nilai.perms.has(`${mod}.${a}`)).length;
                                const semua = moduleAllOn(nilai.perms, mod);
                                const label = permissionModuleLabels[mod];
                                return (
                                    <fieldset key={mod} style={{ border: "1px solid var(--line)", borderRadius: "var(--r-md)", padding: "6px 10px 10px", margin: 0, minWidth: 0 }}>
                                        <legend style={{ padding: "0 4px" }}>
                                            <label className="fi-check">
                                                <input type="checkbox" aria-label={`Semua izin ${label}`} checked={semua} disabled={Boolean(kunciSimpan)}
                                                    ref={(el) => { if (el) el.indeterminate = nyala > 0 && !semua; }} onChange={() => toggleModul(mod)} />
                                                <b>{label}</b><span className="fi-small fi-subtle">{nyala}/{aksi.length}</span>
                                            </label>
                                        </legend>
                                        <ul className="fi-chips" style={{ margin: 0 }}>
                                            {aksi.map((a) => {
                                                const key = `${mod}.${a}`;
                                                const cap = CAPABILITY_KEYS.has(key);
                                                const tanda = sel.ditambah.includes(key) ? "+" : sel.dicabut.includes(key) ? "−" : "";
                                                const kunciAdmin = adminPreset && key === "users.manage" && nilai.perms.has(key);
                                                return (
                                                    <li key={key}>
                                                        {/* Target sentuh 44 px di pointer kasar (audit No 45); tanda +/− juga terbaca pembaca layar (No 140d). */}
                                                        <label className="fi-chip pointer-coarse:min-h-11" title={kunciAdmin ? "Tidak bisa dicabut dari grup preset Admin" : key} data-tone={tanda ? "warn" : undefined}
                                                            style={cap ? { borderStyle: "dashed" } : undefined}>
                                                            <input type="checkbox" aria-label={`${permissionKeyLabel(key)}${tanda === "+" ? " (akan ditambah)" : tanda ? " (akan dicabut)" : ""}`} checked={nilai.perms.has(key)}
                                                                disabled={Boolean(kunciSimpan) || kunciAdmin} onChange={() => toggleKunci(key)} />
                                                            {tanda && <span aria-hidden>{tanda}</span>}{AKSI[a] ?? a}
                                                            {cap && <span className="sr-only"> (kunci kapabilitas)</span>}
                                                        </label>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                        {adminPreset && mod === "users" && <p className="fi-small fi-subtle" style={{ marginTop: 6 }}>Manage terkunci: tidak bisa dicabut dari grup preset Admin.</p>}
                                    </fieldset>
                                );
                            })}
                        </div>
                    </div>
                </Section>

                <Section id="g-anggota" title="Anggota" subtitle={`${det.members.length} orang · izin berlaku pada permintaan berikutnya`}>
                    <div className="fi-sect-in">
                        {kunciAnggota && <p className="fi-small fi-why">Terkunci: {kunciAnggota}.</p>}
                        {det.members.length === 0 ? <EmptyState title="Belum ada anggota" message="Tambahkan user; izin berlaku pada permintaan berikutnya." /> : (
                            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }} aria-label={`Anggota ${det.group.name}`}>
                                {anggotaUser.map(({ m, u }) => (
                                    <li key={m.userId} className="fi-btnrow" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                                        <span><b>{m.userName}</b> <span className="fi-small fi-subtle">{m.userEmail}</span></span>
                                        {(m.isPrimary || u?.primaryGroupId === det.group.id) && <StatusBadge tone="info">★ Utama</StatusBadge>}
                                        {u && u.groups.length > 1 && <span className="fi-small fi-subtle">juga {u.groups.filter((g) => g.id !== det.group.id).map((g) => g.name).join(", ")}</span>}
                                        <span style={{ flex: 1 }} />
                                        <Button variant="tertiary" icon={<UserMinus className="fi-icon" aria-hidden />} disabled={Boolean(kunciAnggota)} disabledReason={kunciAnggota}
                                            aria-label={`Keluarkan ${m.userName}`} onClick={() => setDialog({ keluar: m.userId })}>Keluarkan…</Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="fi-btnrow" style={{ alignItems: "end" }}>
                            <FormField label="Tambah anggota">
                                {(a11y) => (
                                    <select {...a11y} className="fi-input" value={tambahId} disabled={Boolean(kunciAnggota)} onChange={(e) => setTambahId(e.target.value)}>
                                        <option value="">{calon.length ? "Pilih user…" : "Semua user sudah anggota"}</option>
                                        {calon.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.email})</option>)}
                                    </select>
                                )}
                            </FormField>
                            <Button icon={<UserPlus className="fi-icon" aria-hidden />} busy={menambah} disabled={Boolean(kunciAnggota) || !tambahId}
                                disabledReason={kunciAnggota ?? "Pilih user dulu"} onClick={() => setDialog("tambah")}>Tambah anggota…</Button>
                        </div>
                        {prTambah?.berubah && <PeringatanRole dari={calonPilih?.role ?? null} ke={prTambah.role} />}
                        {userL.status === "galat" && <MessageStrip tone="neg" title="Daftar user gagal dimuat.">{userL.error} <Button variant="tertiary" onClick={muatUser}>Coba lagi</Button></MessageStrip>}
                    </div>
                </Section>

                <Section id="g-info" title="Info">
                    <div className="fi-sect-in">
                        <div className="fi-formgrid">
                            <FormField label="Nama grup" help={det.group.isPreset ? "Nama grup preset terkunci." : undefined}>
                                {(a11y) => <input {...a11y} className="fi-input" value={nilai.name} disabled={det.group.isPreset || Boolean(kunciSimpan)} onChange={(e) => ubah({ name: e.target.value })} />}
                            </FormField>
                            <FormField label="Deskripsi">
                                {(a11y) => <input {...a11y} className="fi-input" value={nilai.description} disabled={Boolean(kunciSimpan)} onChange={(e) => ubah({ description: e.target.value })} />}
                            </FormField>
                        </div>
                    </div>
                </Section>

                <Section id="g-riwayat" title="Riwayat" subtitle="izin ditambah/dicabut, anggota, info; terbaru dulu">
                    <Riwayat key={`${det.group.id}-${versi}`} url={`/api/admin/groups/${det.group.id}/history`} sudut="grup" />
                </Section>

                <FooterToolbar message={berubah
                    ? <span className="fi-sum"><b>+{sel.ditambah.length} −{sel.dicabut.length}</b> belum disimpan{infoBerubah ? " · info grup" : ""}</span>
                    : kunciSimpan ? <span className="fi-why">{kunciSimpan}</span> : undefined}>
                    {berubah && <Button variant="tertiary" onClick={() => setDraf(null)}>Batal perubahan</Button>}
                    <Button variant="primary" icon={<Save className="fi-icon" aria-hidden />} disabled={!berubah || Boolean(kunciSimpan) || (infoBerubah && !nilai.name.trim())}
                        disabledReason={kunciSimpan ?? (!berubah ? "Belum ada perubahan" : "Isi nama grup")} onClick={() => setDialog("simpan")}>Simpan izin…</Button>
                </FooterToolbar>
            </div>
        );

    return (
        <div className="fi-page" style={{ paddingBottom: 0 }}>
            <header className="fi-page-head">
                <nav aria-label="Jejak halaman"><ol className="fi-crumb"><li><span>Pengaturan</span></li><li><span aria-current="page">Kelola Akses Grup</span></li></ol></nav>
                <div className="fi-page-bar">
                    <h1>Kelola Akses Grup</h1>
                    <span className="fi-spacer" />
                    <Link className="fi-btn fi-btn--secondary" href="/admin/users">User dan Izin</Link>
                    <Button variant="primary" icon={<Plus className="fi-icon" aria-hidden />} onClick={() => { setBaru({ nama: "", deskripsi: "" }); setDialog("baru"); }}>Grup baru…</Button>
                </div>
                <p>Izin per modul untuk setiap grup. Izin user = gabungan semua grupnya. Selisih izin ditampilkan sebelum disimpan dan tercatat di riwayat.</p>
            </header>
            {pesan && <MessageStrip tone={pesan.tone} title={pesan.teks} onClose={() => setPesan(null)} />}
            {grupL.status === "galat" && grupL.data && <MessageStrip tone="neg" title="Gagal memuat ulang grup.">{grupL.error} Daftar masih hasil sebelumnya. <Button variant="tertiary" onClick={cobaLagi}>Coba lagi</Button></MessageStrip>}
            <FlexibleColumnLayout list={daftarEl} detail={detail} detailOpen={pilihId !== null} onBack={() => buka(null)} listLabel="Daftar grup" detailLabel="Detail grup" />

            <ConfirmDialog open={dialog === "simpan" && Boolean(det)} onClose={() => setDialog(null)} tag="Izin"
                title={izinBerubah ? `Simpan izin grup ${asli?.name ?? ""}?` : `Simpan info grup ${asli?.name ?? ""}?`}
                confirmLabel={cabutKelola ? "Simpan dan cabut Kelola user" : izinBerubah ? "Simpan izin" : "Simpan info"} tone={cabutKelola ? "negative" : "primary"}
                confirmDisabled={kunciSimpan} alasanTerlihat
                facts={det && nilai && asli ? [
                    ...(nilai.name.trim() !== asli.name ? [["Nama", `${asli.name} → ${nilai.name.trim()}`] as [string, string]] : []),
                    ...(nilai.description.trim() !== asli.description ? [["Deskripsi", `${asli.description || KOSONG_TEKS} → ${nilai.description.trim() || KOSONG_TEKS}`] as [string, string]] : []),
                    ["Terkena", det.members.length ? `${det.members.length} anggota: ${daftarNama(det.members.map((m) => m.userName))}` : "Belum ada anggota"],
                    ["Berlaku", "Pada permintaan berikutnya; tidak perlu masuk ulang"],
                    ["Riwayat", "Kunci yang ditambah dan dicabut tercatat"],
                ] : undefined}
                onConfirm={() => jalankan(async () => {
                    if (!det || !nilai || !asli) return "";
                    await tulisAdmin(`/api/admin/groups/${det.group.id}`, "PATCH", {
                        ...(izinBerubah ? { permissions: [...nilai.perms] } : {}),
                        ...(infoBerubah ? { ...(det.group.isPreset ? {} : { name: nilai.name.trim() }), description: nilai.description.trim() } : {}),
                    });
                    setDraf(null);
                    const izin = izinBerubah ? `${sel.ditambah.length} ditambah, ${sel.dicabut.length} dicabut${usang.length ? `, ${usang.length} kunci usang dibuang` : ""}` : "info diperbarui";
                    return `Grup ${nilai.name.trim()} tersimpan: ${izin}; tercatat di riwayat. Berlaku untuk ${det.members.length} anggota pada permintaan berikutnya.`;
                })}>
                {sel.ditambah.length > 0 && (
                    <div>
                        <b className="fi-small">Ditambah ({sel.ditambah.length})</b>
                        <ul aria-label="Izin ditambah" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                            {sel.ditambah.map((k) => <li key={k} className="fi-small">+ {permissionKeyLabel(k)}{CAPABILITY_KEYS.has(k) ? " (kunci kapabilitas)" : ""}</li>)}
                        </ul>
                    </div>
                )}
                {sel.dicabut.length > 0 && (
                    <div>
                        <b className="fi-small">Dicabut ({sel.dicabut.length})</b>
                        <ul aria-label="Izin dicabut" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                            {sel.dicabut.map((k) => <li key={k} className="fi-small">− {permissionKeyLabel(k)}</li>)}
                        </ul>
                    </div>
                )}
                {izinBerubah && usang.length > 0 && (
                    <div>
                        <b className="fi-small">Kunci usang dibuang ({usang.length})</b>
                        <ul aria-label="Kunci usang dibuang" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                            {usang.map((k) => <li key={k} className="fi-small">− {permissionKeyLabel(k)} (usang, tidak dikenal registry)</li>)}
                        </ul>
                        <p className="fi-small fi-subtle">Ada di grup ini tetapi sudah tidak terdaftar. Dikirim tanpa kunci itu; tercatat dicabut di riwayat.</p>
                    </div>
                )}
                {cabutKelola && (
                    <MessageStrip tone="warn" title="Mencabut Kelola user (users.manage).">
                        Anggota grup ini kehilangan pengelolaan user kecuali dari grup lain. Server menolak bila tidak tersisa admin aktif, atau bila akses Anda sendiri ikut hilang. Riwayat mencatat kunci yang dicabut dan siapa yang mencabutnya, bukan alasannya.
                    </MessageStrip>
                )}
            </ConfirmDialog>

            <ConfirmDialog open={dialog === "hapus" && Boolean(det)} onClose={() => setDialog(null)} tag="Hapus" tone="negative" title={`Hapus grup ${det?.group.name ?? ""}?`}
                confirmLabel="Hapus grup" alasanTerlihat
                confirmDisabled={kunciAnggota ?? (terakhir.length ? `Ditolak: ${daftarNama(terakhir)} hanya punya grup ini. Tambahkan ke grup lain dulu, atau Nonaktifkan untuk mencabut akses.` : undefined)}
                facts={det ? [
                    ["Anggota", det.members.length ? `${det.members.length}: ${daftarNama(det.members.map((m) => m.userName))}` : "0"],
                    ["Izin", String(det.permissions.length)],
                    ["Akibat", "Izin dan keanggotaan grup ini dihapus; grup utama dan role identitas tiap anggota dihitung ulang"],
                    ["Role identitas", perubahanRole.length ? `${perubahanRole.length} anggota berubah (rinci di atas)` : "Tidak ada anggota yang berubah"],
                    ["Riwayat", "Tetap terbaca sesudah grup dihapus"],
                ] : undefined}
                onConfirm={() => jalankan(async () => {
                    if (!det) return "";
                    await tulisAdmin(`/api/admin/groups/${det.group.id}`, "DELETE");
                    pindah(null);
                    return `Grup ${det.group.name} dihapus.`;
                })}>
                {perubahanRole.length > 0 && (
                    <MessageStrip tone="warn" title={`Role identitas lama berubah untuk ${perubahanRole.length} anggota.`}>
                        <ul aria-label="Role identitas berubah" style={{ margin: "4px 0", paddingLeft: 18, listStyle: "disc" }}>{perubahanRole.map((t) => <li key={t}>{t}</li>)}</ul>
                        Gerbang berbasis role (OPC, Klaim, Form Kontrol, dan sinkron Accurate bila akun sinkron khusus belum diatur) ikut berubah. Izin dari grup lain tidak berubah.
                    </MessageStrip>
                )}
            </ConfirmDialog>

            <ConfirmDialog open={dialog === "baru"} onClose={() => setDialog(null)} tag="Buat" title="Buat grup baru?" confirmLabel="Buat grup"
                confirmDisabled={baru.nama.trim() ? undefined : "Isi nama grup"} alasanTerlihat
                facts={[["Isi awal", "Tanpa izin dan anggota; centang izin lalu Simpan"]]}
                onConfirm={() => jalankan(async () => {
                    const r = await tulisAdmin<{ group: { id: string; name: string } }>("/api/admin/groups", "POST", { name: baru.nama.trim(), description: baru.deskripsi.trim() });
                    pindah(r.group.id);
                    return `Grup ${r.group.name} dibuat tanpa izin dan anggota. Centang izin lalu Simpan.`;
                })}>
                <FormField label="Nama grup" required>{(a11y) => <input {...a11y} className="fi-input" value={baru.nama} onChange={(e) => setBaru({ ...baru, nama: e.target.value })} />}</FormField>
                <FormField label="Deskripsi">{(a11y) => <input {...a11y} className="fi-input" value={baru.deskripsi} onChange={(e) => setBaru({ ...baru, deskripsi: e.target.value })} />}</FormField>
            </ConfirmDialog>

            <ConfirmDialog open={dialog === "buang"} onClose={() => { setDialog(null); setPindahKe(undefined); setTujuan(null); }} tag="Perubahan" tone="negative"
                title={`Buang perubahan pada grup ${asli?.name ?? ""}?`} confirmLabel="Buang perubahan"
                facts={[
                    ["Akibat", `${sel.ditambah.length + sel.dicabut.length} perubahan izin${infoBerubah ? " dan info grup" : ""} dikembalikan ke nilai tersimpan`],
                    ...(tujuan ? [["Pindah ke", namaHalaman(tujuan)] as [string, string]] : []),
                ]}
                onConfirm={() => {
                    const ke = tujuan;
                    setDialog(null);
                    setTujuan(null);
                    if (ke) { router.push(ke); return; } // halaman ini dilepas bersama drafnya
                    if (pindahKe !== undefined) pindah(pindahKe);
                    setPindahKe(undefined);
                }} />

            {/* Tambah anggota memberi izin (dan bisa mengubah role identitas): lewat dialog (audit No 5); fungsi tulis tetap tambahAnggota. */}
            <ConfirmDialog open={dialog === "tambah" && Boolean(det && calonPilih)} onClose={() => setDialog(null)} tag="Anggota"
                title={`Tambahkan ${calonPilih?.name ?? ""} ke ${det?.group.name ?? ""}?`} confirmLabel="Tambahkan" confirmDisabled={kunciAnggota} alasanTerlihat
                facts={det && calonPilih ? [
                    ["User", `${calonPilih.name} (${calonPilih.email})`],
                    ["Izin yang didapat", `${det.permissions.length} kunci izin grup ${det.group.name}; izin user = gabungan semua grupnya`],
                    ["Role identitas", prTambah?.berubah ? `${labelRole(calonPilih.role)} → ${labelRole(prTambah.role)}` : "Tidak berubah"],
                    ["Berlaku", "Pada permintaan berikutnya; tidak perlu masuk ulang"],
                    ["Riwayat", "Tercatat di riwayat user dan grup"],
                ] : undefined}
                onConfirm={async () => { await tambahAnggota(); setDialog(null); }} />
            <DialogKeluarkan target={keluarTarget} aktorId={aktorId} kunci={kunciAnggota} onClose={() => setDialog(null)} jalankan={jalankan} />

        </div>
    );
}
