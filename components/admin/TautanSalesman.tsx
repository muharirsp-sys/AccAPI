/*
 * Tujuan: Bagian "Karyawan Accurate (salesman)" di Object Page User (O2): tautan akun <-> karyawan salesman Accurate sekarang + cabangnya,
 *   pilih karyawan salesman aktif (cari nama/nomor/cabang; yang sudah tertaut ke akun lain atau kodenya dipegang profil akun lain ditandai dan
 *   tidak bisa dipilih), simpan lewat dialog, lepas lewat dialog konfirmasi. Cabang salesman = cabang karyawannya di Accurate, jadi tautan
 *   menentukan pelanggan dan barang yang boleh dipesan akun itu di Order Sales. "Lepas" HANYA mematikan tautan: profil sales, kode, dan hierarki
 *   Form Kontrol tetap (kontrak O1). Mengganti kode yang punya laporan Form Kontrol ditolak server (KODE_DIPAKAI_FORM_KONTROL) kecuali
 *   dikonfirmasi: dialog kedua menyebut hitungan laporannya. Kode yang masih dipegang profil akun LAIN yang tautannya dilepas (salesman ganti
 *   akun) ditolak KODE_DIPAKAI_PROFIL_LAIN; dialog memindahkan profil itu (kode tetap, riwayat Form Kontrol ikut) lewat `pindahkanProfil`.
 *   `users.view` = baca-saja; `users.manage` = tulis.
 * Caller: app/(dashboard)/admin/users/Pengguna.tsx (dipasang ulang dengan `key` per user + versi muat ulang).
 * Dependensi: GET|PUT|DELETE /api/admin/users/[id]/salesman (kontrak docs/handover/O1-KONTRAK-ORDER-CABANG.md §3); components/admin/{Bersama,admin-ui};
 *   components/fiori/*.
 * Main Functions: TautanSalesman.
 * Side Effects: HTTP tulis ke API admin (PUT/DELETE) lewat `tulisAdmin`; audit salesman.link / salesman.unlink dicatat server.
 */
"use client";

import { useCallback, useState } from "react";
import { Link2, Link2Off, RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, KeyValues, ListItem, MessageStrip, Skeleton, StatusBadge } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad } from "@/components/fiori/interactive";
import { GalatAdmin, muatAdmin, tulisAdmin } from "./Bersama";

type Tautan = {
    salesCode: string; salesName: string; employeeId: number | null; employeeName: string | null;
    branchId: number | null; branchName: string | null; salesman: boolean | null; suspended: boolean | null; aktif: boolean;
    /** false = tautan DILEPAS (profil sales tetap). Tidak ada (server lama) = tertaut. */
    terhubung?: boolean;
};
type Pilihan = {
    id: number; number: string; name: string; branchId: number | null; branchName: string | null;
    /** `terhubung: false` = kode dipegang profil Form Kontrol akun itu yang tautannya sudah dilepas (kode unik: tidak bisa dipakai akun lain). */
    terhubungKe: { userId: string; name: string | null; email: string | null; terhubung?: boolean } | null;
};
type Data = { tautan: Tautan[]; pilihan: Pilihan[] };
type TulisHasil = { changed: boolean; tautan?: { salesCode: string; employeeName: string; branchName: string } };
type Laporan = { laporanHarian?: number; ao?: number; merchandising?: number; jks?: number; total?: number };
type Dialog = { jenis: "tautkan"; p: Pilihan } | { jenis: "lepas" } | { jenis: "kode"; p: Pilihan; laporan: Laporan } | { jenis: "pindah"; p: Pilihan; dari: string } | null;

const BATAS_TAMPIL = 40;

/** Sebab tautan yang ada tidak aktif — kalimat, bukan kolom mentah. */
function sebabTidakAktif(t: Tautan): string {
    if (t.employeeId === null) return "nomor karyawan ini tidak ada di master pegawai hasil sinkron";
    if (t.suspended) return "karyawannya nonaktif di Accurate";
    if (!t.salesman) return "karyawannya bukan salesman di Accurate";
    if (t.branchId === null) return "karyawannya belum punya cabang di Accurate";
    return "data karyawannya belum lengkap";
}

const angka = (v: unknown) => (typeof v === "number" ? v : 0);

type Props = {
    user: { id: string; name: string };
    bolehKelola: boolean;
    /** Alasan aksi tulis terkunci dari halaman (izin / daftar user memuat / galat). */
    kunciTulis?: string;
    /** Penangan aksi tulis halaman (pesan sukses, muat ulang, galat tidak pasti). Mengembalikan setelah penanganan; melempar untuk galat yang tampil di dialog. */
    jalankan: (fn: () => Promise<string>) => Promise<void>;
};

export function TautanSalesman({ user, bolehKelola, kunciTulis, jalankan }: Props) {
    const [d, muat] = useLoad(useCallback(() => muatAdmin<Data>(`/api/admin/users/${user.id}/salesman`), [user.id]));
    const [cari, setCari] = useState("");
    const [dialog, setDialog] = useState<Dialog>(null);
    const kunci = kunciTulis ?? (d.status === "memuat" ? "Menunggu data karyawan dimuat" : d.status === "galat" ? "Data tautan gagal dimuat — muat ulang dulu" : undefined);
    const url = `/api/admin/users/${user.id}/salesman`;

    if (d.status === "memuat" && !d.data) return <div className="fi-sect-in"><Skeleton rows={3} label="Memuat tautan karyawan Accurate" /></div>;
    if (d.status === "galat" && !d.data) return <ErrorState title="Tautan karyawan Accurate gagal dimuat" message={d.error} onRetry={muat} />;

    const tautan = d.data?.tautan ?? [];
    const pilihan = d.data?.pilihan ?? [];
    const aktifTertaut = tautan.filter((t) => t.terhubung !== false);
    const dilepas = tautan.filter((t) => t.terhubung === false);
    const sekarang = aktifTertaut[0] ?? null;
    const q = cari.trim().toLowerCase();
    const cocok = pilihan.filter((p) => !q || p.name.toLowerCase().includes(q) || p.number.toLowerCase().includes(q) || (p.branchName ?? "").toLowerCase().includes(q));
    const tampil = cocok.slice(0, BATAS_TAMPIL);
    // Pemegang lain: tertaut aktif ke akun lain, atau profil Form Kontrol akun lain yang tautannya dilepas (kode tetap miliknya).
    const pemegangLain = (p: Pilihan) => (p.terhubungKe && p.terhubungKe.userId !== user.id ? p.terhubungKe : null);
    const terkunci = (alasan: string | undefined) => alasan ? <p className="fi-small fi-why">Terkunci: {alasan}.</p> : null;

    const dialogP = dialog?.jenis === "tautkan" || dialog?.jenis === "kode" || dialog?.jenis === "pindah" ? dialog.p : null;

    /**
     * Tulis tautan. Galat KODE_DIPAKAI_FORM_KONTROL dicegat: dialog konfirmasi kedua (hitungan laporan), lalu PUT ulang dengan konfirmasi.
     * KODE_DIPAKAI_PROFIL_LAIN dicegat juga: dialog "pindahkan profil", lalu PUT ulang dengan `pindahkanProfil`.
     */
    async function tautkan(p: Pilihan, konfirmasiGantiKode: boolean, pindahkanProfil = false) {
        try {
            await jalankan(async () => {
                const r = await tulisAdmin<TulisHasil>(url, "PUT", { employeeNumber: p.number, ...(konfirmasiGantiKode ? { konfirmasiGantiKode: true } : {}), ...(pindahkanProfil ? { pindahkanProfil: true } : {}) });
                return r.changed
                    ? `${user.name} ditautkan ke ${r.tautan?.employeeName ?? p.name} (${r.tautan?.salesCode ?? p.number}), cabang ${r.tautan?.branchName ?? p.branchName ?? "—"}.`
                    : `${user.name} sudah tertaut ke ${p.name}; tidak ada yang berubah.`;
            });
        } catch (e) {
            if (e instanceof GalatAdmin && e.code === "KODE_DIPAKAI_FORM_KONTROL" && !konfirmasiGantiKode) {
                setDialog({ jenis: "kode", p, laporan: (e.data?.laporan ?? {}) as Laporan });
                return;
            }
            if (e instanceof GalatAdmin && e.code === "KODE_DIPAKAI_PROFIL_LAIN" && !pindahkanProfil) {
                const dari = (e.data?.terhubungKe ?? {}) as { name?: unknown; userId?: unknown };
                setDialog({ jenis: "pindah", p, dari: typeof dari.name === "string" && dari.name ? dari.name : typeof dari.userId === "string" ? dari.userId : "akun lain" });
                return;
            }
            throw e;
        }
        setDialog(null);
    }

    return (
        <div className="fi-sect-in">
            {terkunci(kunciTulis)}
            {d.status === "galat" && (
                <MessageStrip tone="neg" title="Gagal memuat ulang tautan.">{d.error} Yang tampil hasil sebelumnya; aksi tulis terkunci. <Button variant="tertiary" onClick={muat}>Coba lagi</Button></MessageStrip>
            )}
            {!sekarang && (
                <MessageStrip tone="info" title="Belum dihubungkan ke karyawan Accurate.">
                    Akun salesman yang belum ditautkan tidak bisa memakai Order Sales (cabangnya belum diketahui). Akun yang bukan salesman tidak perlu ditautkan.
                    {dilepas.length > 0 && ` Profil sales ${dilepas.map((t) => `${t.salesName} (${t.salesCode})`).join(", ")} tetap ada (tautannya dilepas); menautkan ke karyawan yang sama memakainya kembali.`}
                </MessageStrip>
            )}
            {aktifTertaut.length > 1 && (
                <MessageStrip tone="warn" title={`Akun ini punya ${aktifTertaut.length} profil sales.`}>
                    Server menolak mengganti tautan selama profilnya lebih dari satu. Lepas dulu, lalu tautkan ulang: {aktifTertaut.map((t) => `${t.salesName} (${t.salesCode})`).join(", ")}.
                </MessageStrip>
            )}
            {sekarang && (
                <KeyValues items={[
                    ["Karyawan Accurate", `${sekarang.employeeName ?? sekarang.salesName} · ${sekarang.salesCode}`],
                    ["Cabang salesman", sekarang.branchName ?? "belum ada"],
                    ["Status", sekarang.aktif
                        ? <StatusBadge tone="pos">Aktif</StatusBadge>
                        : <><StatusBadge tone="warn">Tidak aktif</StatusBadge> <span className="fi-small fi-why">{sebabTidakAktif(sekarang)}</span></>],
                    ...(sekarang.aktif ? [["Akibat", `Order Sales hanya untuk pelanggan dan barang cabang ${sekarang.branchName}`] as [string, string]] : []),
                ]} />
            )}
            {sekarang && !sekarang.aktif && (
                <MessageStrip tone="warn" title="Tautan ini belum bisa dipakai.">
                    Akun ini tidak bisa memakai Order Sales ({sebabTidakAktif(sekarang)}). Betulkan di Accurate lalu sinkronkan master pegawai, atau tautkan ke karyawan lain.
                </MessageStrip>
            )}

            {bolehKelola ? (
                <>
                    <FormField label="Cari karyawan salesman" help={`Salesman aktif di Accurate: ${pilihan.length}. Cari nama, nomor, atau cabang.`}>
                        {(a) => <input {...a} type="search" className="fi-input" autoComplete="off" value={cari} placeholder="mis. SALES A atau CABANG A" onChange={(e) => setCari(e.target.value)} />}
                    </FormField>
                    {pilihan.length === 0 ? (
                        <EmptyState title="Belum ada karyawan salesman aktif" message="Master pegawai belum tersinkron dari Accurate, atau tidak ada yang bertanda salesman aktif. Sinkronkan master pegawai lebih dulu." />
                    ) : tampil.length === 0 ? (
                        <EmptyState title={`Tidak ada karyawan “${cari.trim()}”`} message="Coba nama, nomor, atau cabang lain." />
                    ) : (
                        <>
                            <ul className="fi-list" style={{ display: "block", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", overflow: "auto", maxHeight: "18rem", margin: 0 }} aria-label="Karyawan salesman Accurate">
                                {tampil.map((p) => {
                                    const lain = pemegangLain(p);
                                    const ini = p.terhubungKe?.userId === user.id && p.terhubungKe.terhubung !== false;
                                    const lama = Boolean(lain && lain.terhubung === false);
                                    return (
                                        <li key={p.id}>
                                            <ListItem doc={p.number} title={p.name} meta={`Cabang ${p.branchName ?? "belum ada"}`}
                                                badge={lain
                                                    ? <StatusBadge tone="warn">{lama ? `Kode dipegang profil lama ${lain.name ?? "akun lain"} (tautan dilepas) — bisa dipindahkan` : `Sudah ditautkan ke ${lain.name ?? "akun lain"}`}</StatusBadge>
                                                    : ini ? <StatusBadge tone="pos">Tertaut ke akun ini</StatusBadge> : undefined}
                                                onClick={(lain && !lama) || ini || kunci ? undefined : () => setDialog({ jenis: "tautkan", p })} />
                                        </li>
                                    );
                                })}
                            </ul>
                            {cocok.length > tampil.length && <p className="fi-small fi-muted">Tampil {tampil.length} dari {cocok.length} — persempit pencarian.</p>}
                        </>
                    )}
                    {kunci && !kunciTulis && <p className="fi-small fi-why">Memilih karyawan terkunci: {kunci}.</p>}
                    <div className="fi-btnrow">
                        <Button variant="negative" icon={<Link2Off className="fi-icon" aria-hidden />} disabled={Boolean(kunci) || !sekarang} disabledReason={kunci ?? "Belum ada tautan untuk dilepas"} onClick={() => setDialog({ jenis: "lepas" })}>Lepas tautan…</Button>
                        <Button variant="tertiary" icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={muat}>Muat ulang daftar</Button>
                    </div>
                </>
            ) : (
                <p className="fi-small fi-subtle">Baca-saja: menautkan atau melepas karyawan butuh izin Kelola user (users.manage).</p>
            )}

            <ConfirmDialog open={dialog?.jenis === "tautkan"} onClose={() => setDialog(null)} tag="Salesman" confirmLabel="Tautkan" title={`Tautkan ${user.name} ke ${dialogP?.name ?? ""}?`}
                confirmDisabled={kunci} alasanTerlihat
                facts={[
                    ["Karyawan", dialogP ? `${dialogP.name} · ${dialogP.number}` : ""],
                    ["Cabang salesman", dialogP?.branchName ?? "belum ada"],
                    ...(sekarang ? [["Mengganti", `${sekarang.employeeName ?? sekarang.salesName} · ${sekarang.salesCode}`] as [string, string]] : []),
                    ["Akibat", `${user.name} hanya bisa memesan pelanggan dan barang cabang ${dialogP?.branchName ?? "itu"} di Order Sales`],
                    ["Riwayat", "Tercatat di riwayat user (siapa, sebelum, sesudah)"],
                ]}
                onConfirm={async () => { if (dialogP) await tautkan(dialogP, false); }}>
                {sekarang && <MessageStrip tone="warn" title="Tautan lama diganti.">Cabang salesman berubah mengikuti karyawan baru. Bila server menolak, alasannya tampil di dialog ini dan tidak ada yang berubah.</MessageStrip>}
            </ConfirmDialog>

            <ConfirmDialog open={dialog?.jenis === "kode"} onClose={() => setDialog(null)} tag="Ganti kode" tone="negative" confirmLabel="Ganti kode dan tautkan"
                title={`Ganti kode salesman ${user.name} yang punya laporan Form Kontrol?`} confirmDisabled={kunci} alasanTerlihat
                description={`Akun ini punya ${angka(dialog?.jenis === "kode" ? dialog.laporan.total : 0)} laporan Form Kontrol berkode ${sekarang?.salesCode ?? "salesman lama"}. Mengganti kode ke ${dialogP?.number ?? "kode baru"} berarti laporan itu tidak lagi berada di bawah kode yang sama dengan akun ini. Lanjutkan hanya bila memang disengaja; server menolak bila tidak dikonfirmasi.`}
                facts={dialog?.jenis === "kode" ? [
                    ["Laporan harian", String(angka(dialog.laporan.laporanHarian))],
                    ["Kontrol AO", String(angka(dialog.laporan.ao))],
                    ["Merchandising", String(angka(dialog.laporan.merchandising))],
                    ["Daftar toko (JKS)", String(angka(dialog.laporan.jks))],
                    ["Kode baru", dialog.p.number],
                    ["Riwayat", "Tercatat di riwayat user, termasuk hitungan laporannya"],
                ] : undefined}
                onConfirm={async () => { if (dialog?.jenis === "kode") await tautkan(dialog.p, true); }} />

            <ConfirmDialog open={dialog?.jenis === "pindah"} onClose={() => setDialog(null)} tag="Pindah profil" tone="negative" confirmLabel="Pindahkan profil dan tautkan"
                title={`Pindahkan profil sales dari ${dialog?.jenis === "pindah" ? dialog.dari : ""} ke ${user.name}?`} confirmDisabled={kunci} alasanTerlihat
                description={`Kode ${dialogP?.number ?? ""} masih dipegang profil Form Kontrol akun ${dialog?.jenis === "pindah" ? dialog.dari : "lain"} (tautan Accurate-nya sudah dilepas). Pakai ini bila salesman berganti akun: profil itu dipindahkan apa adanya ke akun ${user.name}, kodenya tetap sama, dan tautan ke ${dialogP?.name ?? "karyawan"} dinyalakan.`}
                facts={[
                    ["Dari akun", dialog?.jenis === "pindah" ? dialog.dari : ""],
                    ["Ke akun", user.name],
                    ["Karyawan", dialogP ? `${dialogP.name} · ${dialogP.number}` : ""],
                    ["Cabang salesman", dialogP?.branchName ?? "belum ada"],
                    ["Ikut pindah", "Kode tetap persis, jadi riwayat Form Kontrol dan atasan SPV/SM profil itu ikut ke akun ini"],
                    ["Riwayat", "Tercatat di riwayat user (dipindah dari akun mana)"],
                ]}
                onConfirm={async () => { if (dialog?.jenis === "pindah") await tautkan(dialog.p, false, true); }} />

            <ConfirmDialog open={dialog?.jenis === "lepas"} onClose={() => setDialog(null)} tag="Lepas" tone="negative" confirmLabel="Lepas tautan"
                title={`Lepas tautan ${user.name} dari karyawan Accurate?`} confirmDisabled={kunci} alasanTerlihat
                facts={[
                    ["Karyawan", sekarang ? `${sekarang.employeeName ?? sekarang.salesName} · ${sekarang.salesCode}` : "—"],
                    ["Akibat", `${user.name} tidak bisa memakai Order Sales sampai ditautkan lagi (cabangnya tidak diketahui)`],
                    ["Tetap ada", "Profil sales, kode, dan hierarki Form Kontrol tidak dihapus; hanya tautan ke karyawan Accurate yang dimatikan"],
                    ["Data lain", "Order yang sudah dikirim tidak terpengaruh"],
                    ["Riwayat", "Tercatat di riwayat user"],
                ]}
                onConfirm={async () => {
                    await jalankan(async () => {
                        const r = await tulisAdmin<{ changed: boolean }>(url, "DELETE");
                        return r.changed ? `Tautan ${user.name} ke karyawan Accurate dilepas (profil sales tetap).` : `${user.name} memang belum tertaut; tidak ada yang berubah.`;
                    });
                    setDialog(null);
                }} />
            <p className="fi-small fi-subtle"><Link2 className="fi-icon" aria-hidden style={{ verticalAlign: "-0.15em" }} /> Cabang salesman tidak diketik: selalu cabang karyawan di Accurate.</p>
        </div>
    );
}
