/*
 * Tujuan: Komponen klien design system Fiori: dialog konfirmasi, form field, filter bar + bottom sheet, pengalih mode/density,
 *   dan penjaga perubahan belum disimpan.
 * Caller: Halaman yang sudah dimigrasi ke `.fiori`; app/(dashboard)/dev/ui-kit.
 * Dependensi: React, components/ui/Dialog (native <dialog>), components/fiori/core, fiori/scheme (kunci localStorage), lucide-react.
 * Main Functions: ConfirmDialog, FormField, FilterBar, SchemeSwitcher, useUnsavedGuard, useLoad.
 * Side Effects: SchemeSwitcher menulis html[data-scheme|data-density] + localStorage; useUnsavedGuard memasang beforeunload.
 */
"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Monitor, Moon, SlidersHorizontal, Sun, X } from "lucide-react";
import Dialog from "@/components/ui/Dialog";
import { Button, KeyValues } from "@/components/fiori/core";
import { FIORI_DENSITY_KEY, FIORI_SCHEME_KEY } from "@/components/fiori/scheme";

type ConfirmDialogProps = {
    open: boolean;
    onClose: () => void;
    /** Judul berupa pertanyaan: "Kirim 3 faktur ke Accurate?" */
    title: string;
    tag?: string;
    description?: ReactNode;
    /** Daftar akibat: apa yang dikirim/diubah, jumlah, nilai, dasar. */
    facts?: Array<[string, ReactNode]>;
    /** Alasan wajib (mis. setuju sendiri, maker-checker lunak). `min` = panjang minimal setelah dipangkas, sama dengan server (bawaan 1). */
    reason?: { label: string; placeholder?: string; min?: number };
    /** Label aksi, bukan "OK"/"Ya". */
    confirmLabel: string;
    /** Label tombol tutup; bawaan "Batal". Pakai "Kembali" bila aksinya sendiri bernama Batalkan. */
    cancelLabel?: string;
    tone?: "primary" | "negative";
    /** Galat dari pemanggil; galat yang dilempar onConfirm juga tampil di dialog. Isian tidak dikosongkan. */
    error?: string;
    /** Isian tambahan milik pemanggil (FormField), tampil sebelum `facts`; pemanggil memegang nilainya. */
    children?: ReactNode;
    /** Alasan tombol konfirmasi nonaktif (mis. "Pilih berkas dulu"); tampil sebagai title. */
    confirmDisabled?: string;
    onConfirm: (reason: string) => Promise<void> | void;
};

/** Dialog konfirmasi aksi tulis; tidak tertutup sendiri setelah konfirmasi — pemanggil menutupnya saat berhasil. */
export function ConfirmDialog(props: ConfirmDialogProps) {
    const titleId = useId();
    const [busy, setBusy] = useState(false);
    // Selama aksi tulis berjalan, Escape/Tutup diabaikan supaya hasilnya tidak tersembunyi.
    const close = () => { if (!busy) props.onClose(); };
    return (
        <Dialog open={props.open} onClose={close} labelledBy={titleId} className="fi-dialog">
            {/* Isi dipasang ulang tiap kali dibuka supaya alasan lama tidak terbawa. */}
            {props.open && <ConfirmBody {...props} onClose={close} titleId={titleId} busy={busy} setBusy={setBusy} />}
        </Dialog>
    );
}

type BodyProps = ConfirmDialogProps & { titleId: string; busy: boolean; setBusy: (busy: boolean) => void };

function ConfirmBody({ onClose, title, tag, description, facts, reason, confirmLabel, cancelLabel = "Batal", tone = "primary", error, children, confirmDisabled, onConfirm, titleId, busy, setBusy }: BodyProps) {
    const [text, setText] = useState("");
    const [failure, setFailure] = useState<string>();
    const inFlight = useRef(false); // disabled baru berlaku sesudah render; ref menahan klik ganda.
    const reasonId = useId();
    const min = reason?.min ?? 1;
    const pendek = Boolean(reason) && text.trim().length < min;
    const blocked = !pendek ? confirmDisabled
        : text.trim() && min > 1 ? `${reason?.label} minimal ${min} karakter` : `Isi ${reason?.label.toLowerCase()} dulu`;

    const confirm = async () => {
        if (inFlight.current || blocked) return;
        inFlight.current = true;
        setBusy(true);
        setFailure(undefined);
        try {
            await onConfirm(text.trim());
        } catch (e) {
            setFailure(e instanceof Error ? e.message : "Aksi gagal. Coba lagi.");
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    };

    return (
        <>
            <header>
                <div>
                    {tag && <span className="fi-tag" data-tone={tone === "negative" ? "neg" : "info"}>{tag}</span>}
                    <h2 id={titleId}>{title}</h2>
                </div>
                <button type="button" className="fi-btn fi-btn--icon" aria-label="Tutup" disabled={busy} onClick={onClose}><X className="fi-icon" aria-hidden /></button>
            </header>
            <div className="fi-dialog-body">
                {description && <div className="fi-muted">{description}</div>}
                {children}
                {facts?.length ? <KeyValues items={facts} /> : null}
                {reason && (
                    <div className="fi-field">
                        <label className="fi-label" htmlFor={reasonId}>{reason.label}<span className="fi-req" aria-hidden>*</span></label>
                        <textarea id={reasonId} className="fi-input" required value={text} placeholder={reason.placeholder} onChange={(e) => setText(e.target.value)}
                            aria-describedby={min > 1 ? `${reasonId}-min` : undefined} />
                        {min > 1 && <p className="fi-help" id={`${reasonId}-min`}>Minimal {min} karakter; tersimpan bersama aksi ini.</p>}
                    </div>
                )}
                {(error || failure) && <p className="fi-msg" role="alert">{error || failure}</p>}
            </div>
            <footer>
                <Button onClick={onClose} disabled={busy}>{cancelLabel}</Button>
                <Button variant={tone} busy={busy} disabled={Boolean(blocked)} disabledReason={blocked} onClick={confirm}>
                    {confirmLabel}
                </Button>
            </footer>
        </>
    );
}

type FieldA11y = { id: string; "aria-describedby"?: string; "aria-invalid"?: true; required?: boolean };

/** Label terikat ke field, wajib ditandai, bantuan/galat lewat aria-describedby. Isi = render prop yang menerima atribut a11y. */
export function FormField({ label, required, help, error, children }: { label: string; required?: boolean; help?: string; error?: string; children: (a11y: FieldA11y) => ReactNode }) {
    const id = useId();
    const describedBy = [error && `${id}-err`, help && `${id}-help`].filter(Boolean).join(" ") || undefined;
    return (
        <div className="fi-field">
            <label className="fi-label" htmlFor={id}>{label}{required && <span className="fi-req" aria-hidden>*</span>}</label>
            {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, required })}
            {error && <p className="fi-msg" id={`${id}-err`}>{error}</p>}
            {help && <p className="fi-help" id={`${id}-help`}>{help}</p>}
        </div>
    );
}

type FilterBarProps = {
    title: string;
    /** Isian saringan (FormField). Di ponsel pindah ke bottom sheet. */
    fields: ReactNode;
    /** Isian cari yang tetap terlihat di ponsel. */
    search?: ReactNode;
    activeCount: number;
    chips?: Array<{ label: string; onRemove: () => void }>;
    onReset: () => void;
    actions?: ReactNode;
};

// ponytail: saringan tersimpan (variant, BL-36) belum ada; judul = nama tampilan. Tambah saat BL-36 masuk lewat AM.
export function FilterBar({ title, fields, search, activeCount, chips, onReset, actions }: FilterBarProps) {
    const [sheetOpen, setSheetOpen] = useState(false);
    const sheetTitle = useId();
    return (
        <div className="fi-fbar">
            <div className="fi-fbar-top">
                <h2>{title}</h2>
                {actions}
            </div>
            <div className="fi-fbar-fields">{search}{fields}</div>
            <div className="fi-fbar-mobile">
                <div style={{ flex: 1, minWidth: 0 }}>{search}</div>
                <Button icon={<SlidersHorizontal className="fi-icon" aria-hidden />} count={activeCount || undefined} onClick={() => setSheetOpen(true)}>Saringan</Button>
            </div>
            {chips?.length ? (
                <ul className="fi-chips" aria-label="Saringan aktif">
                    {chips.map((c) => (
                        <li key={c.label} className="fi-chip">{c.label}
                            <button type="button" aria-label={`Hapus saringan ${c.label}`} onClick={c.onRemove}><X className="fi-icon" aria-hidden /></button>
                        </li>
                    ))}
                    <li><Button variant="tertiary" onClick={onReset}>Hapus semua</Button></li>
                </ul>
            ) : null}
            <Dialog open={sheetOpen} onClose={() => setSheetOpen(false)} labelledBy={sheetTitle} className="fi-dialog fi-sheet" closeOnBackdrop>
                {sheetOpen && (
                    <>
                        <header>
                            <h2 id={sheetTitle}>Saringan</h2>
                            <button type="button" className="fi-btn fi-btn--icon" aria-label="Tutup" onClick={() => setSheetOpen(false)}><X className="fi-icon" aria-hidden /></button>
                        </header>
                        <div className="fi-dialog-body">{fields}</div>
                        <footer>
                            <Button onClick={onReset}>Hapus semua</Button>
                            <Button variant="primary" onClick={() => setSheetOpen(false)}>Tampilkan hasil</Button>
                        </footer>
                    </>
                )}
            </Dialog>
        </div>
    );
}

function useHtmlAttr(name: string, fallback: string) {
    return useSyncExternalStore(
        (onChange) => {
            const observer = new MutationObserver(onChange);
            observer.observe(document.documentElement, { attributes: true, attributeFilter: [name] });
            return () => observer.disconnect();
        },
        () => document.documentElement.getAttribute(name) ?? fallback,
        () => fallback,
    );
}

function savePref(attr: string, key: string, value: string, fallback: string) {
    const root = document.documentElement;
    if (value === fallback) root.removeAttribute(attr); else root.setAttribute(attr, value);
    try {
        if (value === fallback) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch {
        // localStorage tidak tersedia; pilihan tetap berlaku sampai halaman dimuat ulang.
    }
}

const SCHEMES = [["system", "Sistem", Monitor], ["light", "Terang", Sun], ["dark", "Gelap", Moon]] as const;
const DENSITIES = [["auto", "Otomatis"], ["compact", "Compact"], ["cozy", "Cozy"]] as const;

/** Mode Sistem/Terang/Gelap + density Otomatis/Compact/Cozy. Menggantikan ThemeSwitcher lama saat shell dimigrasi (S1). */
export function SchemeSwitcher() {
    const scheme = useHtmlAttr("data-scheme", "system");
    const density = useHtmlAttr("data-density", "auto");
    const id = useId();
    return (
        <div className="fi-scheme">
            <span id={`${id}-mode`} className="fi-caption">Mode</span>
            <div className="fi-segs" role="group" aria-labelledby={`${id}-mode`}>
                {SCHEMES.map(([value, label, Icon]) => (
                    <button key={value} type="button" aria-pressed={scheme === value} onClick={() => savePref("data-scheme", FIORI_SCHEME_KEY, value, "system")}>
                        <Icon className="fi-icon" aria-hidden />{label}
                    </button>
                ))}
            </div>
            <span id={`${id}-density`} className="fi-caption">Density</span>
            <div className="fi-segs" role="group" aria-labelledby={`${id}-density`}>
                {DENSITIES.map(([value, label]) => (
                    <button key={value} type="button" aria-pressed={density === value} onClick={() => savePref("data-density", FIORI_DENSITY_KEY, value, "auto")}>{label}</button>
                ))}
            </div>
        </div>
    );
}

/** Draf: peringatan peramban saat menutup/memuat ulang tab dengan perubahan belum disimpan. */
export function useUnsavedGuard(dirty: boolean) {
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
}

export type Load<T> = { status: "memuat" | "siap" | "galat"; data?: T; error?: string };

/**
 * Memuat data lewat `loader` (stabil: useCallback) dan memuat ulang lewat fungsi kedua.
 * Saat memuat ulang, data lama tetap tampil dengan status "memuat" (aturan enam keadaan); respons usang diabaikan.
 * setState hanya dipanggil dari callback promise, bukan sinkron di effect (react-hooks/set-state-in-effect).
 */
export function useLoad<T>(loader: () => Promise<Load<T>>, opsi: { pertahankan?: boolean } = {}): [Load<T>, () => void] {
    const pertahankan = Boolean(opsi.pertahankan);
    const [versi, setVersi] = useState(0);
    const [hasil, setHasil] = useState<{ by: () => Promise<Load<T>>; versi: number; load: Load<T> } | null>(null);
    useEffect(() => {
        let alive = true;
        void loader().then((load) => {
            if (!alive) return;
            // Galat memuat ulang tidak membuang hasil sebelumnya: layar menampilkan data lama + strip "hasil sebelumnya".
            setHasil((prev) => {
                const lama = prev && (prev.by === loader || pertahankan) ? prev.load.data : undefined;
                return { by: loader, versi, load: load.status === "galat" && load.data === undefined && lama !== undefined ? { ...load, data: lama } : load };
            });
        });
        return () => { alive = false; };
    }, [loader, versi, pertahankan]);
    // Bawaan: loader baru (mis. tanggal berganti) = kueri lain, data lama TIDAK dipinjam, supaya aksi yang membaca data (urutan wave
    // berikutnya, nihil per tanggal) tidak memakai tanggal sebelumnya. `pertahankan` (daftar bersaring, mis. cari/saringan): data lama
    // tetap tampil redup sampai jawaban baru tiba, seperti List Report. Muat ulang kunci sama = selalu data lama + "memuat".
    const kunciSama = hasil !== null && hasil.by === loader;
    const segar = kunciSama && hasil.versi === versi;
    const load: Load<T> = segar ? hasil.load : hasil !== null && (kunciSama || pertahankan) ? { ...hasil.load, status: "memuat" } : { status: "memuat" };
    return [load, () => setVersi((v) => v + 1)];
}
