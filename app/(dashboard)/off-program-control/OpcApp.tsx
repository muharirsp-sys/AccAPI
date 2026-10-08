/*
 * Tujuan: Klien OFF Program Control (Fiori S4d): resolusi peran SAMA dengan kode lama (sesi Better Auth + useLocalAuthRole →
 *   resolveOffRole, getOffAccessibleTabs; SM hanya tab Sales Manager), navigasi antar-antrean lewat kunci `?tab=` lama, lonceng +
 *   pencarian global yang membuka `?batch=` di kolom kedua untuk peran apa pun, `?mock=` fixture dev, dan penjaga draf
 *   (dialog sebelum pindah batch/tab + beforeunload). Isi tiap tab = modul peran di opc/peran/*.
 * Caller: app/(dashboard)/off-program-control/page.tsx.
 * Dependensi: authClient, useLocalAuthRole (SidebarLayout), lib/off-program-control/{access,dev-fixtures}, lib/opc-ui, opc/Bersama,
 *   opc/peran/*, components/off-program-control/{OffNotificationBell,OffGlobalSearch}, components/fiori.
 * Main Functions: OpcApp.
 * Side Effects: router.replace untuk tab/batch/sub-tampilan; GET daftar batch (lewat useDaftarBatch).
 */
"use client";

import { useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EmptyState, Skeleton } from "@/components/fiori/core";
import { ConfirmDialog, useUnsavedGuard } from "@/components/fiori/interactive";
import { useLocalAuthRole } from "@/components/SidebarLayout";
import OffGlobalSearch from "@/components/off-program-control/OffGlobalSearch";
import OffNotificationBell from "@/components/off-program-control/OffNotificationBell";
import { authClient } from "@/lib/auth-client";
import { resolveOffRole, type OffAction, type OffTab } from "@/lib/off-program-control/access";
import { getOffDevBatchCount } from "@/lib/off-program-control/dev-fixtures";
import { LABEL_PERAN, TAB_OPC, TAMPILAN, infoTahap, izinAksi, subTampilan, tabEfektif, tabPunyaDetail, tabTerlihat } from "@/lib/opc-ui";
import { useDaftarBatch, type OpcKonteks, type PeranProps } from "./opc/Bersama";
import Audit from "./opc/peran/Audit";
import Keuangan from "./opc/peran/Keuangan";
import Klaim from "./opc/peran/Klaim";
import Om from "./opc/peran/Om";
import Ringkasan from "./opc/peran/Ringkasan";
import Sm from "./opc/peran/Sm";
import Spv from "./opc/peran/Spv";

const MODUL: Record<OffTab, ComponentType<PeranProps>> = { overview: Ringkasan, supervisor: Spv, sales: Sm, claim: Klaim, om: Om, finance: Keuangan, audit: Audit };

type SessionUser = { id?: string | null; name?: string | null; email?: string | null; role?: unknown; userRole?: unknown; type?: unknown; position?: unknown; department?: unknown };

export default function OpcApp({ permKeys }: { permKeys: string[] }) {
    // Cegah hydration mismatch: sesi nyata berasal dari klien, sedangkan bypass localhost menerima peran dari layout server.
    const mounted = useSyncExternalStore(() => () => undefined, () => true, () => false);
    const sp = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const localAuthRole = useLocalAuthRole();
    const { data: session, isPending } = authClient.useSession();
    const user = session?.user as SessionUser | undefined;
    const peran = resolveOffRole({
        role: user?.role ?? localAuthRole, userRole: user?.userRole, type: user?.type, position: user?.position, department: user?.department, email: user?.email,
    }).role;
    const perms = useMemo(() => new Set(permKeys), [permKeys]);
    const boleh = tabTerlihat(peran);
    const tab = tabEfektif(peran, sp.get("tab"));
    const siap = mounted && !(isPending && !localAuthRole);
    const devBatchCount = getOffDevBatchCount(sp.get("mock"));
    const penggunaId = user?.id ?? "";
    const daftar = useDaftarBatch({ peran, penggunaId, devBatchCount, aktif: siap && boleh.length > 0 });

    const [draf, setDraf] = useState(false);
    const [tunda, setTunda] = useState<string | null>(null);
    useUnsavedGuard(draf);

    const urlDengan = (ubah: Record<string, string | null>) => {
        const p = new URLSearchParams(sp.toString());
        for (const [k, v] of Object.entries(ubah)) { if (v) p.set(k, v); else p.delete(k); }
        const q = p.toString();
        return q ? `${pathname}?${q}` : pathname;
    };
    const urlKini = urlDengan({});
    // Semua navigasi internal lewat sini. Tujuan = URL sekarang (klik batch yang sedang terbuka, Ctrl K ke batch yang sama):
    // tidak ada yang dibongkar, jadi tanpa dialog. Selain itu, bila ada draf, tanya dulu (dialog di bawah).
    const ke = (url: string) => {
        if (url === urlKini) return;
        if (draf) setTunda(url); else router.replace(url, { scroll: false });
    };
    const ubahUrl = (ubah: Record<string, string | null>) => ke(urlDengan(ubah));

    const ctx: OpcKonteks | null = tab ? {
        peran, perms, pengguna: { id: penggunaId, nama: user?.name || user?.email || "" }, tab,
        sub: subTampilan(tab, sp.get("claimView"), sp.get("view")),
        batchId: tabPunyaDetail(tab) ? sp.get("batch") : null,
        devBatchCount,
        izin: (aksi: OffAction) => izinAksi(peran, aksi),
        // Log audit tidak punya kolom kedua: batch dibuka di tab pertama yang punya (Ringkasan bila boleh).
        bukaBatch: (id) => ubahUrl(id && !tabPunyaDetail(tab) ? { tab: boleh.find(tabPunyaDetail) ?? tab, batch: id } : { batch: id }),
        pilihSub: (kunci) => ubahUrl(tab === "claim" ? { claimView: kunci } : { view: kunci }),
        ubahUrl,
        setDraf,
    } : null;

    // Galat/muat daftar diteruskan ke lonceng dan pencarian: daftar gagal ≠ "tidak ada masalah" / "tidak ditemukan".
    const muat = { status: daftar.load.status, error: daftar.load.error, adaData: Boolean(daftar.load.data) };
    const judulTab = TAB_OPC.find((t) => t.key === tab)?.label;
    const head = (
        <header className="fi-page-head">
            <nav aria-label="Jejak halaman">
                <ol className="fi-crumb">
                    <li><span>Promo &amp; Klaim</span></li>
                    <li><span>OFF Program Control</span></li>
                    {judulTab && <li><span aria-current="page">{judulTab}</span></li>}
                </ol>
            </nav>
            <div className="fi-page-bar">
                <h1>OFF Program Control</h1>
                <span className="fi-spacer" />
                {siap && ctx && (
                    <>
                        <div style={{ flex: "0 1 18rem", minWidth: 0 }}>
                            <OffGlobalSearch placeholder="Cari pengajuan (Ctrl K)" onSelect={(id) => ctx.bukaBatch(id)} muat={muat}
                                items={daftar.batches.map((b) => ({ id: b.id, noPengajuan: b.noPengajuan, principleName: b.principleName, status: infoTahap(b).label, supervisorName: b.supervisorName }))} />
                        </div>
                        <OffNotificationBell problems={daftar.masalah} onSelectBatch={(id) => ctx.bukaBatch(id)} muat={muat} />
                    </>
                )}
            </div>
            {siap && (
                <p>
                    {peran === "admin" ? "Pantau semua antrean lalu buka batch untuk melihat detailnya." : "Kerjakan batch di antrean Anda; batch terbuka tampil di kolom kanan."}
                    {" "}Peran OFF: {LABEL_PERAN[peran]}.
                </p>
            )}
        </header>
    );

    if (!siap) {
        return <div className="fi-page">{head}<Skeleton rows={4} label="Menyiapkan akses OFF Program Control" /></div>;
    }
    if (!ctx) {
        return (
            <div className="fi-page">
                {head}
                <EmptyState
                    title={peran === "sales" ? "Peran Sales belum dikonfigurasi untuk OFF Program Control" : "Anda belum memiliki akses OFF Program Control"}
                    message="Hubungi admin untuk menambahkan peran OFF (Supervisor, Sales Manager, Klaim, Operational Manager, atau Keuangan) ke akun Anda."
                />
            </div>
        );
    }

    const Modul = MODUL[ctx.tab];
    const nTab = (t: OffTab) => (t === "overview" || t === "audit" ? 0 : daftar.batches.filter((b) => TAMPILAN[t].some((v) => v.antrean(b))).length);
    return (
        <div className="fi-page">
            {head}
            {boleh.length > 1 && (
                <nav className="fi-subnav" aria-label="Antrean OFF Program Control">
                    {TAB_OPC.filter((t) => boleh.includes(t.key)).map((t) => {
                        const href = urlDengan({ tab: t.key, batch: null, claimView: null, view: null });
                        const n = nTab(t.key);
                        return (
                            <Link key={t.key} href={href} replace scroll={false} aria-current={t.key === ctx.tab ? "page" : undefined}
                                onClick={(e) => { if (draf) { e.preventDefault(); ke(href); } }}>
                                {t.label}{n ? ` (${n})` : ""}
                            </Link>
                        );
                    })}
                </nav>
            )}
            <Modul key={ctx.tab} ctx={ctx} daftar={daftar} />
            <ConfirmDialog open={tunda !== null} onClose={() => setTunda(null)} tag="Draf" tone="negative"
                title="Tinggalkan perubahan yang belum disimpan?" confirmLabel="Tinggalkan"
                description="Perubahan yang belum disimpan hilang bila batch atau form yang sedang diubah tertutup karena perpindahan ini."
                // Draf TIDAK dimatikan di sini: editor yang benar-benar dibongkar mematikannya sendiri (cleanup setDraf(false)).
                // Bila perpindahan tidak membongkar editor (mis. ganti tampilan dengan batch yang sama), penjaga tetap hidup.
                onConfirm={() => { const url = tunda; setTunda(null); if (url) router.replace(url, { scroll: false }); }} />
        </div>
    );
}
