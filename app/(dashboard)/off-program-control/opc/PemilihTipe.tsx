/*
 * Tujuan: Pemandu tipe program OPC: bantuan di bawah dropdown Tipe program (penjelasan tipe terpilih + saran dari nama program)
 *   dan dialog "Uang ini dipakai untuk apa?" yang memetakan jawaban orang awam ke tipe tersimpan.
 * Caller: opc/peran/SpvForm.tsx (EditorItem), off-program-control/latihan (mode latihan).
 * Dependensi: components/fiori/{core,interactive}, lib/off-program-control/program-type (INFO_TIPE, sarankanTipe).
 * Main Functions: BantuanTipe, DialogPilihTipe.
 * Side Effects: Tidak ada; pilihan dikembalikan lewat callback.
 */
"use client";

import { useState } from "react";
import { Lightbulb, ListChecks } from "lucide-react";
import { Button } from "@/components/fiori/core";
import { ConfirmDialog } from "@/components/fiori/interactive";
import { INFO_TIPE, OFF_PROGRAM_TYPES, labelTipe, sarankanTipe, type OffProgramType } from "@/lib/off-program-control/program-type";

const TIPE_SPV = OFF_PROGRAM_TYPES as readonly string[];

/**
 * Di bawah dropdown: arti tipe terpilih, saran dari nama program (bila beda), dan tombol pembuka pemilih.
 * Saran tipe CLM (mis. Insentif Distributor) tidak bisa dipakai SPV: ditampilkan sebagai petunjuk ke tim Klaim.
 */
export function BantuanTipe({ tipe, namaProgram, onPilih }: { tipe: string; namaProgram: string; onPilih: (t: OffProgramType) => void }) {
    const [buka, setBuka] = useState(false);
    const saran = sarankanTipe(namaProgram);
    const info = (INFO_TIPE as Record<string, (typeof INFO_TIPE)[OffProgramType] | undefined>)[tipe];
    const saranSpv = saran && TIPE_SPV.includes(saran) ? (saran as OffProgramType) : null;
    return (
        <div style={{ display: "grid", gap: 6 }}>
            {info && (
                <p className="fi-help">
                    {info.jelas}{info.contoh.length ? ` Contoh: ${info.contoh.slice(0, 3).join(", ")}.` : ""}
                    {info.catatanBeban ? ` ${info.catatanBeban}` : ""}
                </p>
            )}
            {saranSpv && saranSpv !== tipe && (
                <p className="fi-small" role="status" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                    <Lightbulb className="fi-icon" aria-hidden />
                    <span>Dari nama program, tipe yang cocok: <b>{labelTipe(saranSpv)}</b>.</span>
                    <Button variant="tertiary" onClick={() => onPilih(saranSpv)}>Pakai saran</Button>
                </p>
            )}
            {saran && !saranSpv && (
                <p className="fi-small fi-subtle" role="status">
                    Nama program ini mirip <b>{saran}</b>, yang biasanya diajukan tim Klaim. Bila tetap Anda ajukan, pilih Lainnya dan tulis alasannya.
                </p>
            )}
            <div>
                <Button variant="tertiary" icon={<ListChecks className="fi-icon" aria-hidden />} onClick={() => setBuka(true)} data-tur="bantu-tipe">
                    Bantu saya memilih tipe
                </Button>
            </div>
            {buka && <DialogPilihTipe awal={TIPE_SPV.includes(tipe) ? (tipe as OffProgramType) : saranSpv} onClose={() => setBuka(false)}
                onPilih={(t) => { onPilih(t); setBuka(false); }} />}
        </div>
    );
}

/**
 * Satu pertanyaan, satu jawaban per tipe (bahasa awam) + contoh nama program. Jawaban terpilih = tipe tersimpan.
 * Pemanggil memasang komponen ini hanya selama terbuka, jadi pilihan awal selalu dari `awal`.
 */
export function DialogPilihTipe({ awal, onClose, onPilih }: { awal: OffProgramType | null; onClose: () => void; onPilih: (t: OffProgramType) => void }) {
    const [pilih, setPilih] = useState<OffProgramType | null>(awal);
    return (
        <ConfirmDialog open onClose={onClose} tag="Pemandu tipe program" title="Uang ini dipakai untuk apa?"
            description="Pilih jawaban yang paling mendekati. Tipe program terisi otomatis dari jawaban Anda."
            confirmLabel={pilih ? `Pakai ${labelTipe(pilih)}` : "Pakai tipe ini"} confirmDisabled={pilih ? undefined : "Pilih satu jawaban dulu."}
            onConfirm={() => { if (pilih) onPilih(pilih); }}>
            <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "grid", gap: 4 }}>
                <legend className="sr-only">Jawaban</legend>
                {OFF_PROGRAM_TYPES.map((t) => {
                    const info = INFO_TIPE[t];
                    return (
                        <label key={t} className="fi-check" style={{ alignItems: "flex-start", padding: "6px 4px", borderRadius: 6, background: pilih === t ? "var(--brand-tint)" : undefined }}>
                            <input type="radio" name="jawaban-tipe" checked={pilih === t} onChange={() => setPilih(t)} style={{ marginTop: 3 }} />
                            <span>
                                <b>{info.jawaban}</b>
                                <span className="fi-small fi-subtle" style={{ display: "block" }}>
                                    Tipe {info.label}{info.contoh.length ? `. Contoh: ${info.contoh.slice(0, 3).join(", ")}` : ""}
                                </span>
                            </span>
                        </label>
                    );
                })}
            </fieldset>
        </ConfirmDialog>
    );
}
