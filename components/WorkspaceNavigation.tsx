/*
 * Tujuan: Navigasi accordion, pencarian menu, dan maksimum tiga favorit per akun.
 * Caller: SidebarLayout desktop/mobile.
 * Dependensi: katalog workspace-navigation, Next Link, React, localStorage.
 * Main Functions: WorkspaceNavigation; storage favorit hanya berisi href yang diizinkan.
 * Side Effects: Navigasi dan simpan preferensi lokal; tidak ada DB/API write.
 */
"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, Search, Star, X } from "lucide-react";
import { HOME_ITEM, activeNavigationItem, type WorkspaceGroup, type WorkspaceItem } from "@/config/workspace-navigation";

export default function WorkspaceNavigation({ groups, pathname, collapsed = false, homeVisible, storageKey, onNavigate, onExpand }: {
    groups: WorkspaceGroup[]; pathname: string; collapsed?: boolean; homeVisible: boolean; storageKey: string;
    onNavigate: () => void; onExpand: () => void;
}) {
    const [query, setQuery] = useState("");
    const [openGroup, setOpenGroup] = useState<{ path: string; id: string | null } | null>(null);
    const [favorites, setFavorites] = useState<string[]>([]);
    const [notice, setNotice] = useState("");
    const [hydrated, setHydrated] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);
    const items = groups.flatMap(group => group.items);
    const active = activeNavigationItem(pathname, [HOME_ITEM, ...items]);
    const routeGroup = groups.find(group => group.items.some(item => item.href === active?.href));
    const expandedId = openGroup?.path === pathname ? openGroup.id : routeGroup?.id;

    useEffect(() => {
        const read = () => {
            try {
                const value: unknown = JSON.parse(localStorage.getItem(storageKey) || "[]");
                setFavorites(Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string"))].slice(0, 3) : []);
            } catch { setFavorites([]); }
        };
        const frame = requestAnimationFrame(() => { read(); setHydrated(true); });
        window.addEventListener("storage", read);
        window.addEventListener("workspace-favorites", read);
        return () => { cancelAnimationFrame(frame); window.removeEventListener("storage", read); window.removeEventListener("workspace-favorites", read); };
    }, [storageKey]);

    const toggleFavorite = (href: string) => {
        const allowed = favorites.filter(value => items.some(item => item.href === value));
        if (!allowed.includes(href) && allowed.length >= 3) { setNotice("Maksimal tiga favorit. Lepaskan salah satu untuk menggantinya."); return; }
        const next = allowed.includes(href) ? allowed.filter(value => value !== href) : [...allowed, href];
        setFavorites(next); setNotice("");
        try { localStorage.setItem(storageKey, JSON.stringify(next)); window.dispatchEvent(new Event("workspace-favorites")); } catch { setNotice("Preferensi tidak dapat disimpan di browser ini."); }
    };
    const renderItem = (item: WorkspaceItem, favoriteControl = true) => {
        const Icon = item.icon;
        return <div key={item.href} className="workspace-nav-item">
            <Link href={item.href} prefetch={false} onClick={onNavigate} aria-current={active?.href === item.href ? "page" : undefined} className="workspace-nav-link" title={collapsed ? item.name : undefined} aria-label={collapsed ? item.name : undefined}>
                <Icon size={18} strokeWidth={1.6} aria-hidden="true" />{!collapsed && <span>{item.name}</span>}
            </Link>
            {!collapsed && favoriteControl && <button type="button" className="workspace-star" aria-label={`${favorites.includes(item.href) ? "Lepaskan" : "Favoritkan"} ${item.name}`} aria-pressed={favorites.includes(item.href)} onClick={() => toggleFavorite(item.href)}><Star size={13} fill={favorites.includes(item.href) ? "currentColor" : "none"} aria-hidden="true" /></button>}
        </div>;
    };
    const normalizedQuery = query.trim().toLocaleLowerCase("id-ID");
    return <>
        {!collapsed ? <div className="workspace-search"><Search size={17} aria-hidden="true" /><input disabled={!hydrated} ref={searchRef} aria-label="Cari menu" placeholder="Cari menu..." value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="Hapus pencarian" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={14} /></button>}</div>
            : <button type="button" className="workspace-rail-button" aria-label="Cari menu" title="Cari menu" onClick={onExpand}><Search size={19} /></button>}
        {homeVisible && renderItem(HOME_ITEM, false)}
        {!collapsed && !normalizedQuery && favorites.some(href => items.some(item => item.href === href)) && <div className="workspace-favorites"><p className="workspace-nav-eyebrow">Favorit</p>{favorites.map(href => items.find(item => item.href === href)).filter((item): item is WorkspaceItem => Boolean(item)).map(item => renderItem(item))}</div>}
        <div className="workspace-groups">{groups.map(group => {
            const matches = normalizedQuery ? group.items.filter(item => `${group.name} ${item.name}`.toLocaleLowerCase("id-ID").includes(normalizedQuery)) : group.items;
            if (!matches.length) return null;
            const Icon = group.icon;
            const expanded = Boolean(normalizedQuery || expandedId === group.id);
            return <section key={group.id} className="workspace-nav-group">
                <button type="button" disabled={!hydrated} className="workspace-group-toggle" aria-label={group.name} aria-expanded={!collapsed && expanded} title={collapsed ? group.name : undefined} onClick={() => { setOpenGroup({ path: pathname, id: collapsed || !expanded ? group.id : null }); if (collapsed) onExpand(); }}>
                    <Icon size={19} strokeWidth={1.6} aria-hidden="true" />{!collapsed && <><span>{group.name}</span><ChevronDown size={14} className={expanded ? "is-open" : ""} aria-hidden="true" /></>}
                </button>
                {!collapsed && expanded && <div className="workspace-submenu">{matches.map(item => renderItem(item))}</div>}
            </section>;
        })}</div>
        {!collapsed && normalizedQuery && !items.some(item => `${groups.find(group => group.items.includes(item))?.name} ${item.name}`.toLocaleLowerCase("id-ID").includes(normalizedQuery)) && <p role="status" className="workspace-nav-empty">Menu tidak ditemukan.</p>}
        {!collapsed && <p role="status" className="workspace-nav-notice">{notice}</p>}
    </>;
}
