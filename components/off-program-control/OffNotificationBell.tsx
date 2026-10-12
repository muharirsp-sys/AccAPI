/*
 * Tujuan: Lonceng "Pengajuan bermasalah" OFF Program Control (Fiori S4d): tombol berjumlah + popover daftar masalah SLA;
 *   "Buka pengajuan" membuka batch di kolom kedua untuk peran apa pun (perubahan #2 it03). Daftar gagal dimuat tampil sebagai galat,
 *   bukan "tidak ada masalah".
 * Caller: app/(dashboard)/off-program-control/OpcApp.tsx.
 * Dependensi: components/fiori/core, lucide-react, lib/off-program-control/problematic (tipe), lib/opc-ui (label/tone severity).
 * Main Functions: OffNotificationBell.
 * Side Effects: State "sembunyikan" lokal (hilang saat halaman dimuat ulang — BL-34); posisi popover ditulis ke style elemennya;
 *   callback onSelectBatch ke parent.
 */
"use client";

import { useId, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { Button, StatusBadge } from "@/components/fiori/core";
import type { ProblematicBatch } from "@/lib/off-program-control/problematic";
import { labelMasalah, toneMasalah } from "@/lib/opc-ui";

/** Keadaan daftar sumber (useDaftarBatch). */
export type MuatDaftar = { status: "memuat" | "siap" | "galat"; error?: string; adaData: boolean };

interface OffNotificationBellProps {
    problems: ProblematicBatch[];
    onSelectBatch?: (batchId: string) => void;
    muat?: MuatDaftar;
}

const LEBAR = 400;

export default function OffNotificationBell({ problems, onSelectBatch, muat }: OffNotificationBellProps) {
    const id = useId();
    const ref = useRef<HTMLDivElement>(null);
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());
    const visible = problems.filter((p) => !dismissed.has(p.batchId + p.code));
    const dismiss = (problem: ProblematicBatch) => setDismissed((prev) => new Set([...prev, problem.batchId + problem.code]));
    const gagalTotal = muat?.status === "galat" && !muat.adaData;
    const memuatAwal = muat?.status === "memuat" && !muat.adaData;

    // Popover (top layer) diletakkan tepat di bawah tombolnya, tidak menutupinya: klik kedua pada tombol menutup popover
    // (popoverTarget, bukan light dismiss). Ditulis langsung ke style sebelum popover tampil (onClick jalan sebelum toggle bawaan).
    const letakkan = (tombol: HTMLElement) => {
        const el = ref.current;
        if (!el) return;
        const r = tombol.getBoundingClientRect();
        const lebar = Math.min(LEBAR, window.innerWidth - 16);
        el.style.inset = "auto";
        el.style.top = `${Math.round(r.bottom + 6)}px`;
        el.style.left = `${Math.round(Math.min(Math.max(8, r.right - lebar), window.innerWidth - lebar - 8))}px`;
        el.style.width = `${lebar}px`;
        el.style.maxHeight = `min(480px, calc(100dvh - ${Math.round(r.bottom + 18)}px))`;
    };

    return (
        <>
            <Button icon={<Bell className="fi-icon" aria-hidden />} count={gagalTotal ? undefined : visible.length || undefined} aria-haspopup="dialog"
                popoverTarget={id} onClick={(e) => letakkan(e.currentTarget)}>
                Pengajuan bermasalah
            </Button>
            <div id={id} ref={ref} popover="auto" role="dialog" aria-label="Pengajuan bermasalah" className="fi-menu">
                <h2>Pengajuan bermasalah{gagalTotal || memuatAwal ? "" : ` (${visible.length})`}</h2>
                {gagalTotal ? (
                    <p className="fi-menu-row fi-small" role="alert">
                        Daftar pengajuan gagal dimuat, jadi peringatan SLA belum bisa dihitung. Ini bukan berarti tidak ada masalah. {muat?.error}
                    </p>
                ) : memuatAwal ? (
                    <p className="fi-menu-row fi-small" role="status">Memuat daftar pengajuan…</p>
                ) : visible.length === 0 ? (
                    <p className="fi-menu-row fi-small" role="status">Tidak ada pengajuan yang lewat SLA untuk peran Anda.</p>
                ) : (
                    <ul>
                        {visible.map((problem) => (
                            <li key={problem.batchId + problem.code} className="fi-menu-row" style={{ borderBottom: "1px solid var(--line)" }}>
                                <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                                    <StatusBadge tone={toneMasalah(problem.severity)}>{labelMasalah(problem.severity)}</StatusBadge>
                                    <b className="fi-mono">{problem.noPengajuan}</b>
                                </span>
                                <b>{problem.title}</b>
                                <span className="fi-small fi-subtle">{problem.message} · {problem.principleName}</span>
                                <span className="fi-btnrow">
                                    {onSelectBatch && (
                                        <Button variant="primary" onClick={() => { ref.current?.hidePopover(); onSelectBatch(problem.batchId); }}>Buka pengajuan</Button>
                                    )}
                                    <Button variant="tertiary" aria-label={`Sembunyikan peringatan ${problem.noPengajuan}`} onClick={() => dismiss(problem)}>Sembunyikan</Button>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
                {muat?.status === "galat" && muat.adaData && (
                    <p className="fi-menu-row fi-small" role="alert">Daftar terakhir gagal diperbarui; peringatan di atas dari data sebelumnya. {muat.error}</p>
                )}
                <p className="fi-menu-note">Dihitung di browser dari 200 batch terbaru dengan hari kerja. “Sembunyikan” berlaku sampai halaman dimuat ulang.</p>
            </div>
        </>
    );
}
