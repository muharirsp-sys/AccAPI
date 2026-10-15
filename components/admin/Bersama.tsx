/*
 * Tujuan: Bagian bersama layar User & Akses Group (Fiori S7a): tulis/baca API admin S7-1 (galat dari `code`, jawaban tidak pasti),
 *   dua kolom sandi bertopeng, Riwayat berkursor, dan dialog Keluarkan dari grup.
 * Caller: app/(dashboard)/admin/users/Pengguna.tsx, app/(dashboard)/admin/groups/AksesGrup.tsx.
 * Dependensi: components/admin/admin-ui (logika murni), components/fiori/{core,interactive}; kontrak docs/handover/S7-KONTRAK-ADMIN-API.md.
 * Main Functions: tulisAdmin, muatAdmin, GalatAdmin, SandiGanda, Riwayat, DialogKeluarkan.
 * Side Effects: HTTP ke /api/admin/** (GET riwayat; DELETE anggota lewat DialogKeluarkan).
 * Catatan: sandi TIDAK pernah masuk state React — kolom bertopeng tak terkendali (ref), sehingga tidak tersinkron ke atribut
 *   `value` DOM; yang disimpan hanya panjangnya untuk pemeriksa.
 */
"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, MessageStrip, Skeleton } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useLoad, type Load } from "@/components/fiori/interactive";
import { alasanSandi, pesanGalat, perkiraanRole, ringkasRiwayat, waktuWita, type GrupU, type ItemRiwayat } from "./admin-ui";

export type UserBaris = {
    id: string; name: string; email: string; role: string | null; banned: boolean | null; banReason: string | null;
    groups: GrupU[]; primaryGroupId: string | null; primaryGroupName: string | null;
};
export type GrupRingkas = { id: string; name: string; description: string | null; isPreset: boolean; permCount: number; memberCount: number };

/** Galat tulis. `muatUlang` = data penentu harus dibaca ulang (tidak pasti, data berubah, izin berubah). `data` = badan jawaban server (mis. `laporan`). */
export class GalatAdmin extends Error {
    constructor(message: string, readonly muatUlang: boolean, readonly belumPasti: boolean, readonly code?: string, readonly data?: Record<string, unknown>) {
        super(message);
    }
}

/**
 * Galat yang berarti IZIN akun berubah di server (IZIN_BERUBAH, atau 403 tanpa kode dari gerbang requirePermission): permKeys halaman
 * berasal dari server component, jadi memuat ulang data saja tidak cukup — halaman memanggil router.refresh() agar izin layout terbaca ulang.
 */
export const izinPerluDisegarkan = (e: unknown) => e instanceof GalatAdmin && (e.code === "IZIN_BERUBAH" || e.code === "forbidden");

async function minta(url: string, init?: RequestInit): Promise<{ status: number; data: Record<string, unknown> | null }> {
    try {
        const res = await fetch(url, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(30_000), ...init });
        return { status: res.status, data: await res.json().catch(() => null) };
    } catch {
        return { status: 0, data: null }; // putus / batas waktu: hasil tulis tidak diketahui
    }
}

/** Tulis ke API admin. Sukses = JSON `ok !== false`; selain itu melempar GalatAdmin berkalimat dari `code`. */
export async function tulisAdmin<T>(url: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, konteks: { aktivasi?: boolean } = {}): Promise<T> {
    const { status, data } = await minta(url, {
        method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (status >= 200 && status < 300 && data && data.ok !== false) return data as T;
    const g = pesanGalat(status, data, konteks);
    throw new GalatAdmin(g.pesan, g.muatUlang, g.belumPasti, g.code, data ?? undefined);
}

/** Baca API admin -> Load. Galat (izin, putus, server) tampil sebagai galat, tidak pernah sebagai daftar kosong. */
export async function muatAdmin<T>(url: string): Promise<Load<T>> {
    const { status, data } = await minta(url);
    if (status >= 200 && status < 300 && data && data.ok !== false) return { status: "siap", data: data as T };
    if (status === 0 || status >= 502 || data === null) return { status: "galat", error: "Server tidak menjawab dengan jelas (jaringan putus atau server sibuk). Coba lagi." };
    if (status === 403) return { status: "galat", error: "Akun Anda tidak berizin melihat data ini (butuh Lihat user atau Kelola user). Minta admin menambahkannya ke grup Anda." };
    if (status === 401) return { status: "galat", error: "Sesi Anda berakhir. Masuk lagi." };
    return { status: "galat", error: pesanGalat(status, data).pesan };
}

/** Dua kolom sandi bertopeng (ketik dua kali). `masuk` = ref kolom pertama (dibaca pemanggil saat konfirmasi). */
export function SandiGanda({ masuk, onUbah }: { masuk: RefObject<HTMLInputElement | null>; onUbah: (alasan: string | undefined) => void }) {
    const ulang = useRef<HTMLInputElement>(null);
    const [beda, setBeda] = useState(false);
    const perbarui = () => {
        const a = masuk.current?.value ?? "", b = ulang.current?.value ?? "";
        setBeda(b.length > 0 && a !== b);
        onUbah(alasanSandi(a.length, b.length, a === b));
    };
    return (
        <>
            <FormField label="Sandi sementara" required help="Minimal 6 karakter. Tidak ditampilkan dan tidak tercatat di riwayat.">
                {(a11y) => <input {...a11y} ref={masuk} className="fi-input" type="password" autoComplete="new-password" spellCheck={false} onChange={perbarui} />}
            </FormField>
            <FormField label="Ketik ulang sandi" required error={beda ? "Belum sama dengan sandi" : undefined}>
                {(a11y) => <input {...a11y} ref={ulang} className="fi-input" type="password" autoComplete="new-password" spellCheck={false} onChange={perbarui} />}
            </FormField>
        </>
    );
}

type Halaman = { items: ItemRiwayat[]; nextCursor: string | null };

/** Riwayat terbaru dulu, paginasi kursor (kontrak §5.9). Pasang ulang dengan `key` baru untuk memuat ulang sesudah perubahan. */
export function Riwayat({ url, sudut }: { url: string; sudut: "user" | "grup" }) {
    const [awal, muat] = useLoad(useCallback(() => muatAdmin<Halaman>(`${url}?limit=20`), [url]));
    const [lanjut, setLanjut] = useState<{ dasar: Halaman; items: ItemRiwayat[]; next: string | null } | null>(null);
    const [lagi, setLagi] = useState<{ status: "memuat" | "galat"; error?: string } | null>(null);
    const dasar = awal.data;
    const ext = dasar && lanjut?.dasar === dasar ? lanjut : null;
    const items = [...(dasar?.items ?? []), ...(ext?.items ?? [])];
    const next = ext ? ext.next : dasar?.nextCursor ?? null;

    async function muatLagi() {
        if (!next || !dasar) return;
        setLagi({ status: "memuat" });
        const h = await muatAdmin<Halaman>(`${url}?limit=20&cursor=${encodeURIComponent(next)}`);
        if (h.status !== "siap" || !h.data) { setLagi({ status: "galat", error: h.error }); return; }
        setLanjut({ dasar, items: [...(ext?.items ?? []), ...h.data.items], next: h.data.nextCursor });
        setLagi(null);
    }

    if (awal.status === "memuat" && !dasar) return <div className="fi-sect-in"><Skeleton rows={3} label="Memuat riwayat" /></div>;
    if (awal.status === "galat" && !dasar) return <ErrorState title="Riwayat gagal dimuat" message={awal.error} onRetry={muat} />;
    if (items.length === 0) return <EmptyState title="Belum ada riwayat" message="Perubahan grup, izin, sandi, dan status tercatat di sini." />;
    return (
        <div>
            <ol className="fi-hist" aria-label="Riwayat">
                {items.map((it, i) => {
                    const r = ringkasRiwayat(it, sudut);
                    return (
                        <li key={it.id ?? i}>
                            <time dateTime={it.createdAt}>{waktuWita(it.createdAt)}</time>
                            <span><b>{r.apa}</b>{it.actorName ? ` · oleh ${it.actorName}` : ""}</span>
                            {r.rinci && <span className="fi-chg">{r.rinci}</span>}
                        </li>
                    );
                })}
            </ol>
            {lagi?.status === "galat" && (
                <div className="fi-sect-in"><MessageStrip tone="neg" title="Riwayat lebih lama gagal dimuat.">{lagi.error}</MessageStrip></div>
            )}
            {next && (
                <div className="fi-sect-in">
                    <Button icon={<RefreshCw className="fi-icon" aria-hidden />} busy={lagi?.status === "memuat"} onClick={muatLagi}>
                        {lagi?.status === "galat" ? "Coba lagi" : "Muat riwayat lebih lama"}
                    </Button>
                </div>
            )}
        </div>
    );
}

/** Peringatan WAJIB kontrak §4: perubahan grup utama menurunkan role identitas lama. */
export function PeringatanRole({ dari, ke }: { dari: string | null; ke: string | null }) {
    return (
        <MessageStrip tone="warn" title={`Role identitas lama akan menjadi ${ke ?? "—"} (sekarang ${dari ?? "—"}).`}>
            Gerbang berbasis role (OPC/Klaim/Form Kontrol, sinkron Accurate tanpa ACCURATE_SYNC_USER_ID) ikut berubah. Izin grup tidak berubah.
        </MessageStrip>
    );
}

type KeluarkanProps = {
    target: { user: UserBaris; grup: { id: string; name: string } } | null;
    aktorId: string;
    /** Alasan aksi tulis terkunci (izin / data memuat / galat). */
    kunci?: string;
    onClose: () => void;
    /** Jalankan aksi tulis lewat penangan halaman (pesan sukses / muat ulang). */
    jalankan: (fn: () => Promise<string>) => Promise<void>;
};

/** Dialog `keluarkan`: user tanpa grup ditolak server (GRUP_TERAKHIR) — dicegah lebih dulu bila data menunjukkannya. */
export function DialogKeluarkan({ target, aktorId, kunci, onClose, jalankan }: KeluarkanProps) {
    const u = target?.user, g = target?.grup;
    const sisa = u && g ? u.groups.filter((x) => x.id !== g.id) : [];
    const pr = u && g ? perkiraanRole(u.groups, u.role, { keluar: g.id }) : null;
    const tunggal = u && g && sisa.length === 0
        ? `${u.name} hanya punya grup ini. User tidak boleh tanpa grup — tambahkan ke grup lain dulu, atau Nonaktifkan untuk mencabut akses.`
        : undefined;
    return (
        <ConfirmDialog open={Boolean(target)} onClose={onClose} tag="Anggota" tone="negative" confirmLabel="Keluarkan"
            title={u && g ? `Keluarkan ${u.name} dari ${g.name}?` : "Keluarkan dari grup"}
            confirmDisabled={kunci ?? tunggal} alasanTerlihat
            facts={u && g && pr ? [
                ["Izin yang hilang", `Izin ${g.name} yang tidak dimiliki grup lain ${u.name}`],
                ["Grup tersisa", sisa.length ? sisa.map((x) => x.name).join(", ") : "Tidak ada"],
                ["Grup utama sesudahnya", pr.utama ? pr.utama.name : "Belum ada — Beranda gabungan izin"],
                ["Riwayat", "Tercatat di riwayat user dan grup"],
            ] : undefined}
            onConfirm={() => jalankan(async () => {
                if (!u || !g) return "";
                const r = await tulisAdmin<{ role?: string | null; primaryGroupId?: string | null }>(`/api/admin/groups/${g.id}/members`, "DELETE", { userId: u.id });
                const role = r.role !== undefined && r.role !== u.role ? ` Role identitas kini ${r.role ?? "—"}.` : "";
                return `${u.name} dikeluarkan dari ${g.name}.${role}`;
            })}>
            {pr?.berubah && <PeringatanRole dari={u?.role ?? null} ke={pr.role} />}
            {u?.id === aktorId && <MessageStrip tone="warn" title="Ini akun Anda sendiri.">Server menolak bila Anda kehilangan Kelola user (users.manage).</MessageStrip>}
        </ConfirmDialog>
    );
}
