/*
 * Tujuan: Beranda per peran (Launchpad Fiori): Perlu tindakan (tile dari endpoint yang ada), Pintasan, Pantauan, Semua aplikasi.
 * Caller: app/(dashboard)/page.tsx.
 * Dependensi: lib/beranda (katalog tile), config/workspace-navigation (profil peran, katalog menu), lib/rbac, components/fiori/core.
 * Main Functions: Beranda.
 * Side Effects: GET ke endpoint sumber tile (sekali per sumber per muat, ulang per sumber lewat Coba lagi); tidak menulis data.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    CalendarDays, CircleCheck, ClipboardCheck, Clock, FileText, Package, RefreshCw, Send, ShoppingCart, TriangleAlert, Undo2, Users, Wallet,
    type LucideIcon,
} from "lucide-react";
import { canAccessPathWithKeys } from "@/lib/rbac";
import { ROLE_PROFILES, navigationForPermissions, roleProfile, roleShortcuts } from "@/config/workspace-navigation";
import { SOURCES, TILES, cardFor, tilesFor, witaToday, type SourceKey, type TileId, type TileValue } from "@/lib/beranda";
import { MessageStrip, Skeleton, StatusBadge, Tile } from "@/components/fiori/core";

const ICONS: Record<string, LucideIcon> = {
    send: Send, file: FileText, alert: TriangleAlert, box: Package, cart: ShoppingCart, clipboard: ClipboardCheck,
    undo: Undo2, wallet: Wallet, clock: Clock, check: CircleCheck, users: Users,
};

type Load = { status: "memuat" | "siap" | "galat"; data?: unknown };

export default function Beranda({ permKeys, firstName, greeting, dateLabel, previewProfile }: {
    permKeys: string[]; firstName: string; greeting: string; dateLabel: string;
    /** Hanya development: pratinjau Beranda peran lain (?peran=). */
    previewProfile?: string;
}) {
    const keys = useMemo(() => new Set(permKeys), [permKeys]);
    const profile = (previewProfile && ROLE_PROFILES.find((p) => p.id === previewProfile)) || roleProfile(keys);
    const tileIds = tilesFor(profile?.id, keys);
    const card = cardFor(profile?.id, keys);
    const sourceList = [...new Set<SourceKey>([...tileIds.map((id) => TILES[id].source), ...(card ? [card.source] : [])])].join(",");
    const groups = navigationForPermissions((href) => canAccessPathWithKeys(href, keys));
    const shortcuts = roleShortcuts(keys, groups.flatMap((g) => g.items), 4, profile);
    const [loads, setLoads] = useState<Partial<Record<SourceKey, Load>>>({});

    const fetchSource = useCallback(async (key: SourceKey) => {
        let next: Load;
        try {
            // Batas waktu: endpoint yang menggantung jadi galat (dengan Coba lagi), bukan "memuat" selamanya.
            const res = await fetch(SOURCES[key].url(witaToday()), { cache: "no-store", signal: AbortSignal.timeout(20_000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            next = { status: "siap", data: await res.json() };
        } catch {
            next = { status: "galat" };
        }
        setLoads((prev) => ({ ...prev, [key]: next }));
    }, []);

    useEffect(() => {
        for (const key of sourceList.split(",").filter(Boolean)) void fetchSource(key as SourceKey);
    }, [sourceList, fetchSource]);

    const retry = (key: SourceKey) => {
        setLoads((prev) => ({ ...prev, [key]: { status: "memuat" } }));
        void fetchSource(key);
    };
    const status = (key: SourceKey) => loads[key]?.status ?? "memuat";
    const failed = sourceList.split(",").filter(Boolean).map((k) => k as SourceKey).filter((k) => status(k) === "galat");
    const loading = tileIds.some((id) => status(TILES[id].source) === "memuat");
    const allClear = tileIds.length > 0 && tileIds.every((id) => {
        if (status(TILES[id].source) !== "siap") return false;
        const value: TileValue = TILES[id].pick(loads[TILES[id].source]?.data);
        return value.value === 0 && !value.more;
    });

    return (
        <div className="fi-home">
            <div className="fi-home-greet">
                <h1 className="fi-title-1">{greeting}, {firstName}</h1>
                <span className="fi-small fi-subtle"><CalendarDays className="fi-icon" aria-hidden />{dateLabel}</span>
            </div>

            {failed.length > 0 && (
                <MessageStrip tone="neg" title={`${failed.map((k) => SOURCES[k].label).join(", ")} gagal dimuat.`}>
                    Data lain di halaman ini tetap terbaru.{" "}
                    <button type="button" className="fi-btn fi-btn--tertiary" onClick={() => failed.forEach(retry)}>Coba lagi</button>
                </MessageStrip>
            )}

            {tileIds.length > 0 && (
                <section className="fi-home-blk" aria-labelledby="beranda-tugas">
                    <div className="fi-home-head">
                        <h2 id="beranda-tugas" className="fi-title-3">Perlu tindakan</h2>
                        <span className="fi-small fi-subtle" aria-live="polite">{loading ? "memuat…" : allClear ? "semua beres" : ""}</span>
                    </div>
                    {allClear && (
                        <div className="fi-panel fi-home-clear" role="status">
                            <CircleCheck className="fi-icon" aria-hidden />
                            <div><b>Tidak ada yang perlu Anda tindak lanjuti</b><span>Tugas baru muncul di sini begitu ada pengajuan, kiriman, atau batas waktu yang mendekat.</span></div>
                        </div>
                    )}
                    <div className="fi-tiles">
                        {tileIds.map((id) => <TaskTile key={id} id={id} load={loads[TILES[id].source]} onRetry={() => retry(TILES[id].source)} />)}
                    </div>
                </section>
            )}

            {shortcuts.length > 0 && (
                <section className="fi-home-blk" aria-labelledby="beranda-pintasan">
                    <h2 id="beranda-pintasan" className="fi-title-3">Pintasan</h2>
                    <div className="fi-shortcuts">
                        {shortcuts.map((item) => {
                            const Icon = item.icon;
                            return <Link key={item.href} href={item.href} prefetch={false} className="fi-shortcut">
                                <span className="fi-tile-ico" aria-hidden><Icon className="fi-icon" /></span>
                                <span><b>{item.name}</b><small>{groups.find((g) => g.items.includes(item))?.name}</small></span>
                            </Link>;
                        })}
                    </div>
                </section>
            )}

            {card && (
                <section className="fi-home-blk" aria-labelledby="beranda-pantauan">
                    <h2 id="beranda-pantauan" className="fi-title-3">Pantauan</h2>
                    <article className="fi-card">
                        <header><h3>{card.title}</h3><span>{card.subtitle}</span></header>
                        {status(card.source) === "memuat" ? <Skeleton rows={3} label={`Memuat ${card.title}`} />
                            : status(card.source) === "galat" ? <p className="fi-card-note fi-card-note--err">{SOURCES[card.source].label} gagal dimuat.</p>
                                : <CardRows kind={card.kind} rows={card.rows(loads[card.source]?.data)} />}
                        <footer><Link href={card.href} prefetch={false}>{card.more}</Link></footer>
                    </article>
                </section>
            )}

            {groups.length > 0 ? (
                <details className="fi-apps">
                    <summary>Semua aplikasi yang bisa Anda buka</summary>
                    <div>
                        {groups.map((group) => (
                            <div key={group.id}>
                                <b>{group.name}</b>
                                {group.items.map((item) => <Link key={item.href} href={item.href} prefetch={false}>{item.name}</Link>)}
                            </div>
                        ))}
                    </div>
                </details>
            ) : (
                <p className="fi-small fi-subtle" role="status">Belum ada modul yang dapat diakses. Hubungi admin untuk mengatur akses Anda.</p>
            )}
        </div>
    );
}

function TaskTile({ id, load, onRetry }: { id: TileId; load?: Load; onRetry: () => void }) {
    const spec = TILES[id];
    const Icon = ICONS[spec.icon];
    if (!load || load.status === "memuat") {
        return <div className="fi-tile" aria-busy="true"><span className="fi-tile-t">{spec.title}</span><Skeleton rows={2} label={`Memuat ${spec.title}`} /></div>;
    }
    if (load.status === "galat") {
        // Galat tidak pernah tampil sebagai nol/kosong.
        return <button type="button" className="fi-tile fi-tile--err" onClick={onRetry}>
            <span className="fi-tile-t">{spec.title}</span>
            <span className="fi-tile-s">{spec.subtitle}</span>
            <span className="fi-tile-v" data-tone="neg">Tidak bisa dimuat</span>
            <span className="fi-tile-f"><RefreshCw className="fi-icon" aria-hidden />Coba lagi</span>
        </button>;
    }
    const value: TileValue = spec.pick(load.data);
    return <Tile title={spec.title} subtitle={spec.subtitle} icon={<Icon className="fi-icon" />} value={value.more ? `${value.value}+` : value.value} unit={value.unit} tone={value.tone} footer={value.footer} href={spec.href} />;
}

function CardRows({ kind, rows }: { kind: "list" | "kv"; rows: ReturnType<NonNullable<ReturnType<typeof cardFor>>["rows"]> }) {
    if (!rows.length) return <p className="fi-card-note">Tidak ada yang menunggu.</p>;
    if (kind === "kv") return <dl className="fi-card-kv">{rows.map((r) => <div key={r.title}><dt>{r.title}</dt><dd>{r.meta}</dd></div>)}</dl>;
    return (
        <ul>
            {rows.map((r) => (
                <li key={`${r.title}-${r.meta}`}>
                    <b>{r.title}</b><span>{r.meta}</span>
                    {r.badge && <StatusBadge tone={r.badge[0]}>{r.badge[1]}</StatusBadge>}
                </li>
            ))}
        </ul>
    );
}
