/*
 * Tujuan: Tur pemandu (spotlight) ala tutorial game untuk halaman Fiori: menggelapkan layar, menyorot satu bagian, dan menjelaskannya
 *   langkah demi langkah (Lanjut / Kembali / Lewati). Langkah yang sasarannya tidak ada di layar dilewati otomatis.
 * Caller: app/(dashboard)/off-program-control/opc/Pemandu.tsx (tur OPC per peran), off-program-control/latihan (mode latihan).
 * Dependensi: React, components/fiori/core (Button), lucide-react; kelas .fi-tur-* di app/fiori.css.
 * Main Functions: Tur.
 * Side Effects: Menggulir sasaran ke tengah layar; posisi sorotan/kartu ditulis langsung ke style elemen (tanpa setState di effect);
 *   fokus dipindah ke kartu dan dikembalikan ke elemen semula saat tur ditutup.
 */
"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Compass, X } from "lucide-react";
import { Button } from "@/components/fiori/core";

export type LangkahTur = {
    /** Nilai atribut `data-tur` sasaran; kosong = kartu di tengah tanpa sorotan. */
    target?: string;
    judul: string;
    isi: ReactNode;
};

const cari = (target?: string) => (target ? document.querySelector<HTMLElement>(`[data-tur="${target}"]`) : null);
/** Langkah sah: tanpa sasaran, atau sasarannya ada dan terlihat (bukan display:none). */
const sah = (l: LangkahTur) => !l.target || Boolean(cari(l.target)?.getClientRects().length);

/**
 * Tur dipasang hanya selama terbuka (pemanggil: `{buka && <Tur …/>}`), jadi langkah selalu mulai dari awal.
 * `onTutup(true)` = selesai sampai langkah terakhir; `false` = dilewati/ditutup.
 */
export function Tur({ langkah, onTutup, label = "Panduan" }: { langkah: LangkahTur[]; onTutup: (selesai: boolean) => void; label?: string }) {
    const [i, setI] = useState(() => Math.max(0, langkah.findIndex(sah)));
    const sorot = useRef<HTMLDivElement>(null);
    const kartu = useRef<HTMLDivElement>(null);
    const judulRef = useRef<HTMLHeadingElement>(null);
    const judulId = useId();
    // Elemen yang fokus SEBELUM tur dipasang (penginisialisasi state berjalan sebelum effect mana pun memindah fokus ke kartu).
    const [asal] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)));
    const l = langkah[i];
    // Nomor langkah dihitung dari langkah yang sah sekarang (sasaran yang tidak ada tidak ikut dihitung).
    const sahSemua = langkah.map(sah);
    const nomor = sahSemua.slice(0, i + 1).filter(Boolean).length;
    const total = sahSemua.filter(Boolean).length;

    const ke = (arah: 1 | -1) => {
        let j = i + arah;
        while (j >= 0 && j < langkah.length && !sah(langkah[j])) j += arah;
        if (j >= langkah.length) { onTutup(true); return; }
        if (j >= 0) setI(j);
    };
    const akhir = (() => { let j = i + 1; while (j < langkah.length && !sah(langkah[j])) j += 1; return j >= langkah.length; })();

    // Fokus dikembalikan ke elemen asal saat tur ditutup (bila elemen itu masih ada di halaman).
    useEffect(() => () => { if (asal?.isConnected) asal.focus({ preventScroll: true }); }, [asal]);
    // Tidak ada satu pun langkah yang sasarannya tampil: tur langsung ditutup, bukan kartu "langkah 0 dari 0".
    useEffect(() => { if (total === 0) onTutup(false); }, [total, onTutup]);
    // Papan ketik didengar di window: tetap bekerja walau fokus jatuh ke <body> (mis. klik teks kartu). Ref diperbarui tiap render.
    const tombolRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
    useEffect(() => {
        const dengar = (e: KeyboardEvent) => tombolRef.current(e);
        window.addEventListener("keydown", dengar);
        return () => window.removeEventListener("keydown", dengar);
    }, []);

    // Posisi sorotan + kartu. Ditulis langsung ke style (bukan state) dan diperbarui saat gulir/ubah ukuran.
    useLayoutEffect(() => {
        const el = cari(l.target);
        const kurangiGerak = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        el?.scrollIntoView({ block: "center", inline: "nearest", behavior: kurangiGerak ? "auto" : "smooth" });
        const tata = () => {
            const s = sorot.current, k = kartu.current;
            if (!s || !k) return;
            const vw = window.innerWidth, vh = window.innerHeight, jarak = 12, pad = 6;
            const r = el?.getBoundingClientRect();
            if (!r) {
                s.style.display = "none";
                k.dataset.letak = "tengah";
                k.style.left = k.style.top = "";
                return;
            }
            s.style.display = "block";
            s.style.left = `${r.left - pad}px`; s.style.top = `${r.top - pad}px`;
            s.style.width = `${r.width + pad * 2}px`; s.style.height = `${r.height + pad * 2}px`;
            if (vw < 640) { k.dataset.letak = "bawah-layar"; k.style.left = k.style.top = ""; return; }
            k.dataset.letak = "dekat";
            const kw = k.offsetWidth, kh = k.offsetHeight;
            const bawah = r.bottom + pad + jarak, atas = r.top - pad - jarak - kh;
            const top = bawah + kh <= vh - 8 ? bawah : atas >= 8 ? atas : Math.max(8, vh - kh - 8);
            const left = Math.min(Math.max(8, r.left), vw - kw - 8);
            k.style.left = `${left}px`; k.style.top = `${top}px`;
        };
        tata();
        let rafId = 0;
        const jadwal = () => { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(tata); };
        window.addEventListener("resize", jadwal);
        window.addEventListener("scroll", jadwal, true);
        // Gulir halus selesai belakangan: tata ulang beberapa kali selama ±0,6 detik.
        const ulang = [150, 350, 650].map((ms) => window.setTimeout(tata, ms));
        judulRef.current?.focus({ preventScroll: true });
        return () => {
            window.removeEventListener("resize", jadwal);
            window.removeEventListener("scroll", jadwal, true);
            cancelAnimationFrame(rafId);
            ulang.forEach(clearTimeout);
        };
    }, [l.target, i]);

    const tombol = (e: KeyboardEvent) => {
        if (e.key === "Escape") { e.preventDefault(); onTutup(false); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); ke(1); return; }
        if (e.key === "ArrowLeft") { e.preventDefault(); ke(-1); return; }
        if (e.key === "Tab") {
            // Fokus tetap di dalam kartu (modal).
            const fokus = Array.from(kartu.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
            if (!fokus.length) return;
            const pertama = fokus[0], terakhir = fokus[fokus.length - 1];
            if (e.shiftKey && (document.activeElement === pertama || document.activeElement === judulRef.current)) { e.preventDefault(); terakhir.focus(); }
            else if (!e.shiftKey && document.activeElement === terakhir) { e.preventDefault(); pertama.focus(); }
        }
    };
    useEffect(() => { tombolRef.current = tombol; });

    return (
        <div className="fi-tur">
            {/* Penahan klik: halaman di belakang tidak bisa diklik selama tur. Tanpa sasaran, penahan juga menggelapkan layar. */}
            <div className="fi-tur-tahan" data-gelap={l.target && cari(l.target) ? undefined : "true"} aria-hidden />
            <div ref={sorot} className="fi-tur-sorot" aria-hidden />
            <div ref={kartu} className="fi-tur-kartu" role="dialog" aria-modal="true" aria-labelledby={judulId} data-letak="tengah">
                <div className="fi-btnrow" style={{ gap: 6 }}>
                    <Compass className="fi-icon" aria-hidden />
                    <span className="fi-tag" data-tone="info">{label} · langkah {nomor} dari {total}</span>
                    <button type="button" className="fi-btn fi-btn--icon" style={{ marginLeft: "auto" }} aria-label="Tutup panduan" onClick={() => onTutup(false)}>
                        <X className="fi-icon" aria-hidden />
                    </button>
                </div>
                <h2 id={judulId} ref={judulRef} tabIndex={-1} className="fi-title-3" style={{ margin: 0, outline: "none" }}>{l.judul}</h2>
                <div className="fi-small" style={{ color: "var(--ink-muted)" }}>{l.isi}</div>
                <div className="fi-tur-titik" aria-hidden>
                    {sahSemua.map((ok, j) => (ok ? <span key={j} data-aktif={j === i || undefined} /> : null))}
                </div>
                <div className="fi-btnrow">
                    <Button variant="tertiary" onClick={() => onTutup(false)}>Lewati</Button>
                    <span style={{ flex: 1 }} />
                    {nomor > 1 && <Button icon={<ChevronLeft className="fi-icon" aria-hidden />} onClick={() => ke(-1)}>Kembali</Button>}
                    <Button variant="primary" onClick={() => ke(1)}>
                        {akhir ? "Selesai" : <>Lanjut <ChevronRight className="fi-icon" aria-hidden /></>}
                    </Button>
                </div>
            </div>
        </div>
    );
}
