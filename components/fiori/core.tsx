/*
 * Tujuan: Komponen presentasional design system Fiori (tombol, badge, pesan, tile, list item, Object Page, tabel, FCL, keadaan).
 * Caller: Halaman yang sudah dimigrasi ke `.fiori` (lihat docs/UI_DESIGN_SYSTEM.md); app/(dashboard)/dev/ui-kit.
 * Dependensi: React, next/link, lucide-react, kelas `fi-*` di app/fiori.css.
 * Main Functions: Button, StatusBadge, MessageStrip, Tile, ListItem, ObjectPageHeader, Flow, AnchorBar, FooterToolbar,
 *   KeyValues, EmptyState, ErrorState, Skeleton, ResponsiveTable, FlexibleColumnLayout, Section, VariantNote.
 * Side Effects: Tidak ada; aksi diteruskan ke callback pemanggil.
 */
import { Fragment, type ButtonHTMLAttributes, type ReactNode } from "react";
import Link from "next/link";
import {
    ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronLeft, ChevronRight, CircleCheck, CircleDashed, CircleX,
    Inbox, Info, LoaderCircle, Pencil, RefreshCw, TriangleAlert, X,
} from "lucide-react";

export type Tone = "pos" | "neg" | "warn" | "info" | "neu";

const TONE_ICON = { pos: CircleCheck, neg: CircleX, warn: TriangleAlert, info: Info, neu: CircleDashed } as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "tertiary" | "negative" | "icon";
    icon?: ReactNode;
    busy?: boolean;
    /** Alasan tombol nonaktif; tampil sebagai title. Tampilkan juga sebagai teks di FooterToolbar bila itu aksi utama. */
    disabledReason?: string;
    count?: number;
};

/** Label kata kerja. Varian `icon` wajib `aria-label`. Satu `primary` per kelompok aksi. */
export function Button({ variant = "secondary", icon, busy, disabledReason, count, className = "", children, disabled, type = "button", title, ...rest }: ButtonProps) {
    const off = Boolean(disabled || busy);
    return (
        <button {...rest} type={type} className={`fi-btn fi-btn--${variant} ${className}`} disabled={off} aria-busy={busy || undefined}
            title={off && disabledReason ? disabledReason : title}>
            {busy ? <LoaderCircle className="fi-icon fi-spin" aria-hidden /> : icon}
            {children}
            {count != null && <span className="fi-count">{count}</span>}
        </button>
    );
}

/** Status selalu ikon + label + warna semantik; tidak pernah warna saja. */
export function StatusBadge({ tone, busy, children }: { tone: Tone; busy?: boolean; children: ReactNode }) {
    const Icon = busy ? LoaderCircle : TONE_ICON[tone];
    return <span className="fi-badge" data-tone={tone}><Icon className={`fi-icon${busy ? " fi-spin" : ""}`} aria-hidden />{children}</span>;
}

/** Pesan di halaman. `neg` = role alert (galat); lainnya = role status. Galat validasi tidak memakai toast. */
export function MessageStrip({ tone, title, children, onClose }: { tone: Exclude<Tone, "neu">; title?: string; children?: ReactNode; onClose?: () => void }) {
    const Icon = TONE_ICON[tone];
    return (
        <div className="fi-strip" data-tone={tone} role={tone === "neg" ? "alert" : "status"}>
            <Icon className="fi-icon" aria-hidden />
            <div>{title && <b>{title} </b>}{children}</div>
            {onClose
                ? <button type="button" className="fi-btn fi-btn--icon" aria-label="Tutup pesan" onClick={onClose}><X className="fi-icon" aria-hidden /></button>
                : <span />}
        </div>
    );
}

type TileProps = {
    title: string; subtitle?: string; icon?: ReactNode; footer?: ReactNode;
    /** Angka besar hanya bila angka itu inti tugasnya. */
    value?: ReactNode; unit?: string; tone?: Tone;
    href?: string; onClick?: () => void;
};

export function Tile({ title, subtitle, icon, footer, value, unit, tone, href, onClick }: TileProps) {
    const body = (
        <>
            {icon && <span className="fi-tile-ico" aria-hidden>{icon}</span>}
            <span className="fi-tile-t">{title}</span>
            {subtitle && <span className="fi-tile-s">{subtitle}</span>}
            {value != null && <span className="fi-tile-v" data-tone={tone}>{value}{unit && <small>{unit}</small>}</span>}
            {footer && <span className="fi-tile-f">{footer}</span>}
        </>
    );
    return href ? <Link href={href} className="fi-tile">{body}</Link> : <button type="button" className="fi-tile" onClick={onClick}>{body}</button>;
}

type ListItemProps = { doc: ReactNode; amount?: ReactNode; title?: ReactNode; meta?: ReactNode; badge?: ReactNode; current?: boolean; href?: string; onClick?: () => void };

/** Baris daftar ponsel dan item worklist (kolom pertama FCL). */
export function ListItem({ doc, amount, title, meta, badge, current, href, onClick }: ListItemProps) {
    const inner = (
        <>
            <span className="fi-li-r1"><span className="fi-li-doc">{doc}</span>{amount != null && <span className="fi-li-amt">{amount}</span>}</span>
            {title != null && <span className="fi-li-title">{title}</span>}
            {(meta != null || badge != null) && <span className="fi-li-r3"><span>{meta}</span>{badge}</span>}
            {(href || onClick) && <ChevronRight className="fi-icon fi-chev" aria-hidden />}
        </>
    );
    const ariaCurrent = current ? "true" as const : undefined;
    if (href) return <Link href={href} className="fi-li" aria-current={ariaCurrent}>{inner}</Link>;
    if (onClick) return <button type="button" className="fi-li" aria-current={ariaCurrent} onClick={onClick}>{inner}</button>;
    return <div className="fi-li">{inner}</div>;
}

export function KeyValues({ items }: { items: Array<[string, ReactNode]> }) {
    return <dl className="fi-kv">{items.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>;
}

export type FlowStep = { label: string; state: "done" | "current" | "late" | "stop" | "todo" };
const STEP_SR: Record<FlowStep["state"], string> = { done: "selesai", current: "", late: "terlambat", stop: "berhenti", todo: "belum" };

/** Langkah status dokumen; langkah aktif memakai aria-current="step". */
export function Flow({ steps, label = "Tahap dokumen" }: { steps: FlowStep[]; label?: string }) {
    return (
        <ol className="fi-flow" aria-label={label}>
            {steps.map((step, index) => (
                <li key={step.label} data-state={step.state} aria-current={step.state === "current" || step.state === "late" ? "step" : undefined}>
                    <span className="fi-step" aria-hidden>{step.state === "done" ? <Check size={12} /> : index + 1}</span>
                    {step.label}
                    {STEP_SR[step.state] && <span className="sr-only"> ({STEP_SR[step.state]})</span>}
                </li>
            ))}
        </ol>
    );
}

type ObjectPageHeaderProps = {
    breadcrumbs?: Array<{ label: string; href?: string }>;
    title: string; status?: ReactNode; draft?: boolean; actions?: ReactNode;
    attributes?: Array<{ label: string; value: ReactNode }>;
    flow?: ReactNode;
};

// ponytail: header tidak menciut saat digulir (dynamic page penuh); AnchorBar yang sticky. Tambah menciut bila Object Page panjang butuh.
export function ObjectPageHeader({ breadcrumbs, title, status, draft, actions, attributes, flow }: ObjectPageHeaderProps) {
    return (
        <header className="fi-oph">
            {breadcrumbs?.length ? (
                <nav aria-label="Jejak halaman">
                    <ol className="fi-crumb">
                        {breadcrumbs.map((b) => <li key={b.label}>{b.href ? <Link href={b.href}>{b.label}</Link> : <span aria-current="page">{b.label}</span>}</li>)}
                    </ol>
                </nav>
            ) : null}
            <div className="fi-oph-title">
                <h1>{title}</h1>
                {status}
                {draft && <span className="fi-draft"><Pencil className="fi-icon" aria-hidden />Draf belum disimpan</span>}
                {actions && <div className="fi-oph-acts">{actions}</div>}
            </div>
            {attributes?.length ? (
                <dl className="fi-attrs">{attributes.map((a) => <div key={a.label}><dt>{a.label}</dt><dd>{a.value}</dd></div>)}</dl>
            ) : null}
            {flow}
        </header>
    );
}

export function AnchorBar({ anchors }: { anchors: Array<{ id: string; label: string }> }) {
    return <nav className="fi-anchors" aria-label="Bagian halaman">{anchors.map((a) => <a key={a.id} href={`#${a.id}`}>{a.label}</a>)}</nav>;
}

/** Aksi final di kanan bawah. `message` = alasan tombol nonaktif / status draf, tampil sebagai teks. */
export function FooterToolbar({ message, children }: { message?: ReactNode; children: ReactNode }) {
    return <div className="fi-ftb"><p className="fi-ftb-msg">{message}</p>{children}</div>;
}

export function EmptyState({ title, message, action }: { title: string; message?: string; action?: ReactNode }) {
    return (
        <div className="fi-state" role="status">
            <span className="fi-state-ico" aria-hidden><Inbox className="fi-icon" /></span>
            <h3>{title}</h3>
            {message && <p>{message}</p>}
            {action}
        </div>
    );
}

/** Galat tidak pernah tampil sebagai kosong. */
export function ErrorState({ title = "Data gagal dimuat", message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
    return (
        <div className="fi-state" role="alert">
            <span className="fi-state-ico" aria-hidden><TriangleAlert className="fi-icon" /></span>
            <h3>{title}</h3>
            {message && <p>{message}</p>}
            {onRetry && <Button icon={<RefreshCw className="fi-icon" aria-hidden />} onClick={onRetry}>Coba lagi</Button>}
        </div>
    );
}

export function Skeleton({ rows = 4, label = "Memuat data" }: { rows?: number; label?: string }) {
    return (
        <div className="fi-skel" role="status">
            <span className="sr-only">{label}</span>
            {Array.from({ length: rows }, (_, i) => <i key={i} aria-hidden style={{ width: `${Math.max(52, 94 - i * 9)}%` }} />)}
        </div>
    );
}

export type Column<T> = {
    key: string; header: string; cell: (row: T) => ReactNode;
    align?: "end";
    /** Disembunyikan di lebar < 760 px dan dipindah ke bawah kolom pertama (pop-in). */
    secondary?: boolean;
    sortable?: boolean;
};

type ResponsiveTableProps<T> = {
    title: string; count?: number; actions?: ReactNode;
    columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string;
    /** Isi satu baris di ponsel (< 600 px lebar wadah); biasanya <ListItem>. */
    mobileItem: (row: T) => ReactNode;
    status?: "memuat" | "siap" | "galat"; error?: string; onRetry?: () => void;
    /** Kalimat berbeda untuk "belum ada data" dan "tidak ada yang sesuai saringan" — pemanggil yang memilih. */
    empty: { title: string; message?: string; action?: ReactNode };
    sort?: { key: string; dir: "asc" | "desc" }; onSortChange?: (key: string) => void;
    selected?: ReadonlySet<string>; onSelectedChange?: (next: Set<string>) => void;
    /** Baris yang boleh dipilih; lainnya kotaknya nonaktif dan tidak ikut "Pilih semua". Bawaan: semua. */
    selectableRow?: (row: T) => boolean;
    /** Nama aksesibel kotak pilih per baris (bawaan: "Pilih <rowKey>"). */
    rowLabel?: (row: T) => string;
};

// ponytail: tabel desktop dan daftar ponsel dirender dua-duanya lalu dipilih lewat container query — DOM ganda.
// Cukup untuk halaman berpaginasi (≤ ratusan baris); virtualisasi bila satu halaman memuat ribuan baris.
export function ResponsiveTable<T>(props: ResponsiveTableProps<T>) {
    const { title, count, actions, columns, rows, rowKey, mobileItem, status = "siap", error, onRetry, empty, sort, onSortChange, selected, onSelectedChange, selectableRow, rowLabel } = props;
    const selectable = Boolean(selected && onSelectedChange);
    const keys = rows.map(rowKey);
    const pickable = rows.map((row) => !selectableRow || selectableRow(row));
    const pickableKeys = keys.filter((_, i) => pickable[i]);
    const nSelected = selectable ? pickableKeys.filter((k) => selected!.has(k)).length : 0;
    const secondaryCols = columns.filter((c) => c.secondary);
    const toggle = (key: string) => {
        const next = new Set(selected);
        if (next.has(key)) next.delete(key); else next.add(key);
        onSelectedChange!(next);
    };

    let body: ReactNode;
    if (rows.length === 0 && status === "memuat") body = <Skeleton />;
    else if (rows.length === 0 && status === "galat") body = <ErrorState message={error} onRetry={onRetry} />;
    else if (rows.length === 0) body = <EmptyState {...empty} />;
    else body = (
        <div className={status === "memuat" ? "fi-busy" : undefined}>
            <div className="fi-tablescroll">
                <table className="fi-table">
                    <caption className="sr-only">{title}</caption>
                    <thead>
                        <tr>
                            {selectable && (
                                <th className="fi-sel">
                                    <input type="checkbox" aria-label="Pilih semua baris" disabled={pickableKeys.length === 0}
                                        checked={pickableKeys.length > 0 && nSelected === pickableKeys.length}
                                        ref={(el) => { if (el) el.indeterminate = nSelected > 0 && nSelected < pickableKeys.length; }}
                                        onChange={() => {
                                            // Hanya baris yang terlihat; pilihan di luar saringan tidak ikut berubah.
                                            const next = new Set(selected);
                                            for (const k of pickableKeys) { if (nSelected === pickableKeys.length) next.delete(k); else next.add(k); }
                                            onSelectedChange!(next);
                                        }} />
                                </th>
                            )}
                            {columns.map((c) => {
                                const active = sort?.key === c.key;
                                const SortIcon = active ? (sort!.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
                                return (
                                    <th key={c.key} scope="col" className={`${c.align === "end" ? "fi-end" : ""} ${c.secondary ? "fi-secondary" : ""}`}
                                        aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
                                        {c.sortable && onSortChange
                                            ? <button type="button" onClick={() => onSortChange(c.key)}>{c.header}<SortIcon className="fi-icon" aria-hidden /></button>
                                            : c.header}
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, i) => {
                            const key = keys[i];
                            const isSel = selectable && selected!.has(key);
                            return (
                                <tr key={key} data-selected={isSel || undefined}>
                                    {selectable && <td className="fi-sel"><input type="checkbox" aria-label={rowLabel ? rowLabel(row) : `Pilih ${key}`} checked={isSel} disabled={!pickable[i]} onChange={() => toggle(key)} /></td>}
                                    {columns.map((c, ci) => (
                                        <td key={c.key} className={`${c.align === "end" ? "fi-end" : ""} ${c.secondary ? "fi-secondary" : ""}`}>
                                            {c.cell(row)}
                                            {ci === 0 && secondaryCols.length > 0 && (
                                                <span className="fi-popin">{secondaryCols.map((s) => <span key={s.key}>{s.header}: {s.cell(row)} · </span>)}</span>
                                            )}
                                        </td>
                                    ))}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <ul className="fi-list" aria-label={title}>{rows.map((row, i) => <li key={keys[i]}>{mobileItem(row)}</li>)}</ul>
        </div>
    );

    return (
        <section className="fi-tablebox" aria-busy={(status === "memuat" && rows.length > 0) || undefined}>
            <div className="fi-tbar">
                <h2>{title}{count != null && <span> ({count})</span>}</h2>
                {actions}
            </div>
            {status === "galat" && rows.length > 0 && (
                <div style={{ padding: "12px 16px 0" }}>
                    <MessageStrip tone="neg" title="Gagal memuat ulang.">
                        {error} Yang tampil adalah hasil sebelumnya.{" "}
                        {onRetry && <button type="button" className="fi-btn fi-btn--tertiary" onClick={onRetry}>Coba lagi</button>}
                    </MessageStrip>
                </div>
            )}
            {body}
        </section>
    );
}

type FclProps = { list: ReactNode; detail: ReactNode; detailOpen: boolean; onBack?: () => void; listLabel?: string; detailLabel?: string };

/** Dua kolom di ≥ 1024 px; di bawahnya satu kolom (daftar ↔ detail) dengan tombol Kembali. */
export function FlexibleColumnLayout({ list, detail, detailOpen, onBack, listLabel = "Daftar", detailLabel = "Detail" }: FclProps) {
    return (
        <div className="fi-fcl" data-detail-open={detailOpen ? "true" : "false"}>
            <section className="fi-fcl-list" aria-label={listLabel}>{list}</section>
            <section className="fi-fcl-detail" aria-label={detailLabel}>
                {onBack && <Button variant="tertiary" className="fi-fcl-back" icon={<ChevronLeft className="fi-icon" aria-hidden />} onClick={onBack}>Kembali ke daftar</Button>}
                {detail}
            </section>
        </div>
    );
}

type SectionProps = { id?: string; title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string };

/** Bagian Object Page / worklist: kepala (judul + keterangan + aksi) lalu isi. `ResponsiveTable` boleh langsung jadi anak. */
export function Section({ id, title, subtitle, actions, children, className = "" }: SectionProps) {
    return (
        <section id={id} className={`fi-sect fi-section ${className}`} aria-label={title}>
            <header>
                <h2>{title}</h2>
                {subtitle != null && <span>{subtitle}</span>}
                {actions && <div className="fi-sect-acts">{actions}</div>}
            </header>
            {children}
        </section>
    );
}

/** Catatan "varian berlabel": logic BL yang belum ada di main; layar menampilkan perilaku hari ini dan menyebut usulannya. */
export function VariantNote({ bl, children }: { bl: string; children: ReactNode }) {
    return (
        <aside className="fi-varbox" aria-label={`Usulan ${bl}`}>
            <span className="fi-tag" data-tone="info">Perilaku hari ini · usulan {bl} lewat tracker AM</span>
            <p>{children}</p>
        </aside>
    );
}
