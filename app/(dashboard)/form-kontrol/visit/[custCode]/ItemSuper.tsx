/*
 * Tujuan: Blok Item super kunjungan (owner 13 Nov 2026) + bentuk dan aturan jawabannya, dipakai dua layar: halaman order kunjungan (status
 *   ORDER, owner 14 Nov 2026: "wajib menawarkan item super terlebih dahulu" sebelum input order) dan langkah Merchandising wizard (status
 *   TIDAK ORDER, seperti semula). Saran WAJIB = item super principal × channel toko yang belum dibeli toko 3 bulan terakhir (maks. 10).
 * Caller: ./Kunjungan.tsx, ./order/OrderKunjungan.tsx.
 * Dependensi: GET /api/form-kontrol/item-super/saran (ambilSaran), ../../lapangan (ambilJson, PESAN_SINYAL, sebabGagal), components/fiori/*,
 *   lib/form-kontrol/item-super (ALASAN_ITEM_SUPER), lib/rekapan-nota/ui (tanggalPanjang).
 * Main Functions: ambilSaran, jawabanAwal, jawabanLengkap, ringkasItemSuper, ItemSuperBlok.
 * Side Effects: HTTP GET saran saja; jawaban disimpan pemanggil (POST /merchandising atau /order-kunjungan, server memeriksa ulang).
 */
"use client";

import type { ReactNode } from "react";
import { MessageStrip, StatusBadge } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";
import { tanggalPanjang } from "@/lib/rekapan-nota/ui";
import { ALASAN_ITEM_SUPER } from "@/lib/form-kontrol/item-super";
import { PESAN_SINYAL, ambilJson, sebabGagal } from "../../lapangan";

/** Saran item super kunjungan ini (lib/form-kontrol/item-super.ts pilihSaran). */
export interface SaranItem { kodeBarang: string; kodeLain: string[]; namaBarang: string; peringkat: number; terakhirDibeli: string | null }
export type Jawaban = { ditawarkan: boolean | null; dipesan: boolean | null; alasan: string; catatan: string };
export interface ItemSuperInfo {
    wajib: SaranItem[]; lain: SaranItem[]; riwayatTerbaca: boolean; adaDaftar: boolean;
    tersimpan: { kodeBarang: string; ditawarkan: boolean; dipesan: boolean | null; alasan: string | null; catatan: string | null }[];
}
const KOSONG_JAWABAN: Jawaban = { ditawarkan: null, dipesan: null, alasan: "", catatan: "" };

/** GET saran item super kunjungan ini; jawaban tak dikenal / galat = pesan (bukan daftar kosong yang menyesatkan). */
export async function ambilSaran(p: URLSearchParams): Promise<{ info: ItemSuperInfo } | { galat: string }> {
    const s = await ambilJson(`/api/form-kontrol/item-super/saran?${p}`);
    if (s.status < 200 || s.status >= 300 || !s.data) {
        return { galat: `Saran item super gagal dimuat. ${s.status === 0 ? `${PESAN_SINYAL} Coba lagi saat ada sinyal.` : sebabGagal(s.status)}` };
    }
    const is = s.data as Partial<ItemSuperInfo>;
    return { info: { wajib: Array.isArray(is.wajib) ? is.wajib : [], lain: Array.isArray(is.lain) ? is.lain : [],
        tersimpan: Array.isArray(is.tersimpan) ? is.tersimpan : [], riwayatTerbaca: is.riwayatTerbaca !== false, adaDaftar: is.adaDaftar === true } };
}

/** Jawaban per saran: isian di layar (`sebelumnya`) menang, lalu yang tersimpan di server, selain itu kosong. */
export function jawabanAwal(info: ItemSuperInfo | null, sebelumnya: Record<string, Jawaban>): Record<string, Jawaban> {
    if (!info) return sebelumnya;
    return Object.fromEntries([...info.wajib, ...info.lain].map((s) => {
        const t = info.tersimpan.find((x) => x.kodeBarang === s.kodeBarang);
        return [s.kodeBarang, sebelumnya[s.kodeBarang] ?? (t ? { ditawarkan: t.ditawarkan, dipesan: t.dipesan, alasan: t.alasan ?? "", catatan: t.catatan ?? "" }
            : { ...KOSONG_JAWABAN })];
    }));
}

/**
 * Jawaban saran item super lengkap — aturan SAMA dengan server (lib/form-kontrol/item-super.ts periksaTawaran): ditawarkan dipilih; ditawarkan →
 * dipesan dipilih; tidak dipesan (termasuk tidak ditawarkan) → alasan; alasan Lainnya → catatan ≥ 5 huruf.
 */
export function jawabanLengkap(j: Jawaban | undefined): boolean {
    if (!j || j.ditawarkan === null) return false;
    if (j.ditawarkan && j.dipesan === null) return false;
    if (j.dipesan === true) return true;
    return Boolean(j.alasan) && (j.alasan !== "LAINNYA" || j.catatan.trim().length >= 5);
}

/** Saran wajib yang jawabannya belum lengkap. */
export const jumlahBelum = (info: ItemSuperInfo | null, j: Record<string, Jawaban>) => (info ? info.wajib.filter((s) => !jawabanLengkap(j[s.kodeBarang])).length : 0);

/** Isian POST (merchandising / order-kunjungan): semua jawaban lengkap (wajib + lain yang dijawab). */
export function isianTawaran(j: Record<string, Jawaban>) {
    return Object.entries(j).filter(([, x]) => jawabanLengkap(x)).map(([kodeBarang, x]) => ({ kodeBarang, ditawarkan: x.ditawarkan,
        dipesan: x.ditawarkan ? x.dipesan : null, alasan: x.dipesan === true ? null : x.alasan || null, catatan: x.catatan.trim() || null }));
}

/** Ubah satu jawaban; ganti "Ditawarkan" = pertanyaan berikutnya berbeda, jadi pesanan dan alasan lama tidak terbawa. */
export function ubahJawabanDi(p: Record<string, Jawaban>, kode: string, patch: Partial<Jawaban>): Record<string, Jawaban> {
    const lama = p[kode];
    const n = { ...KOSONG_JAWABAN, ...lama, ...patch };
    if (patch.ditawarkan !== undefined && patch.ditawarkan !== lama?.ditawarkan) { n.dipesan = null; n.alasan = ""; n.catatan = ""; }
    if (n.dipesan === true) { n.alasan = ""; n.catatan = ""; }
    return { ...p, [kode]: n };
}

export function ringkasItemSuper(j: Record<string, Jawaban>): string {
    const v = Object.values(j).filter(jawabanLengkap);
    return `${v.filter((x) => x.ditawarkan).length} ditawarkan · ${v.filter((x) => x.dipesan).length} dipesan · ${v.filter((x) => !x.ditawarkan).length} tidak ditawarkan`;
}

/** Pilihan Ya/Tidak bersentuh 44 px (radiogroup bernama). */
function YaTidak({ nama, label, nilai, ubah, terkunci }: { nama: string; label: string; nilai: boolean | null; ubah: (v: boolean) => void; terkunci: boolean }) {
    return (
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={label}>
            <span className="fi-small" style={{ minWidth: "7rem" }}>{label}</span>
            {[true, false].map((v) => (
                <label key={String(v)} className="fi-btn fi-btn--secondary" style={{ minHeight: 44, minWidth: 72,
                    ...(nilai === v ? { background: v ? "var(--pos-bg)" : "var(--neg-bg)", borderColor: v ? "var(--pos)" : "var(--neg)", color: v ? "var(--pos)" : "var(--neg)" } : {}) }}>
                    <input type="radio" name={nama} checked={nilai === v} disabled={terkunci} onChange={() => ubah(v)}
                        style={{ width: 18, height: 18, minHeight: 0, minWidth: 0, margin: 0, accentColor: "var(--primary)" }} />
                    {v ? "Ya" : "Tidak"}
                </label>
            ))}
        </div>
    );
}

/**
 * Tiap saran: ditawarkan? → dipesan? → alasan bila tidak dipesan. Saran lain (sudah dibeli / di luar 10) boleh dijawab, tidak wajib.
 * `aksiDipesan` = isi tambahan di baris yang dijawab "dipesan" (halaman order salesman AccAPI: tombol Tambah ke order).
 */
export function ItemSuperBlok({ info, jawaban, ubah, terkunci, isKurang, aksiDipesan, pengantar }: {
    info: ItemSuperInfo; jawaban: Record<string, Jawaban>; ubah: (kode: string, patch: Partial<Jawaban>) => void; terkunci: boolean; isKurang: number;
    aksiDipesan?: (s: SaranItem) => ReactNode; pengantar?: ReactNode;
}) {
    if (!info.adaDaftar) {
        return (
            <section className="fi-panel grid gap-2" aria-labelledby="judul-item-super">
                <h2 className="fi-title-3" id="judul-item-super">Item super</h2>
                <p className="fi-small fi-muted">Belum ada daftar item super untuk principal dan channel toko ini, jadi tidak ada penawaran yang perlu dicatat.</p>
            </section>
        );
    }
    const baris = (s: SaranItem) => {
        const j = jawaban[s.kodeBarang] ?? KOSONG_JAWABAN;
        const perluAlasan = j.ditawarkan === false || j.dipesan === false;
        return (
            <li key={s.kodeBarang} className="grid gap-2" style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}>
                <div className="min-w-0">
                    <b className="fi-small" style={{ overflowWrap: "anywhere" }}>{s.namaBarang}</b>
                    <span className="fi-codes">
                        #{s.peringkat} · {s.kodeBarang}{s.kodeLain.length ? ` (+${s.kodeLain.length} varian)` : ""} · {s.terakhirDibeli
                            ? `terakhir dibeli ${tanggalPanjang(s.terakhirDibeli)}` : "belum dibeli 3 bulan terakhir"}
                    </span>
                </div>
                <YaTidak nama={`tawar-${s.kodeBarang}`} label="Ditawarkan?" nilai={j.ditawarkan} terkunci={terkunci} ubah={(v) => ubah(s.kodeBarang, { ditawarkan: v })} />
                {j.ditawarkan && <YaTidak nama={`pesan-${s.kodeBarang}`} label="Dipesan toko?" nilai={j.dipesan} terkunci={terkunci} ubah={(v) => ubah(s.kodeBarang, { dipesan: v })} />}
                {j.dipesan === true && aksiDipesan?.(s)}
                {perluAlasan && (
                    <FormField label={j.ditawarkan === false ? "Alasan tidak ditawarkan" : "Alasan tidak dipesan"} required error={!j.alasan ? "Pilih alasan" : undefined}>{(a) => (
                        <select {...a} className="fi-input" value={j.alasan} disabled={terkunci} onChange={(e) => ubah(s.kodeBarang, { alasan: e.target.value })}>
                            <option value="">Pilih alasan</option>
                            {ALASAN_ITEM_SUPER.map((x) => <option key={x.kode} value={x.kode}>{x.label}</option>)}
                        </select>
                    )}</FormField>
                )}
                {perluAlasan && j.alasan === "LAINNYA" && (
                    <FormField label="Catatan alasan" required error={j.catatan.trim().length < 5 ? "Tulis minimal 5 huruf" : undefined}>{(a) => (
                        <input {...a} className="fi-input" value={j.catatan} maxLength={300} disabled={terkunci} onChange={(e) => ubah(s.kodeBarang, { catatan: e.target.value })} />
                    )}</FormField>
                )}
            </li>
        );
    };
    return (
        <section className="fi-panel grid gap-2" aria-labelledby="judul-item-super">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="fi-title-3" id="judul-item-super">Item super</h2>
                {info.wajib.length > 0 && <StatusBadge tone={isKurang ? "neu" : "pos"}>{info.wajib.length - isKurang} dari {info.wajib.length} dijawab</StatusBadge>}
            </div>
            <p className="fi-small fi-muted">
                {pengantar ?? "Tawarkan item super yang belum dibeli toko ini. Catat apakah ditawarkan dan dipesan; bila tidak dipesan, pilih alasannya."}
                {!info.riwayatTerbaca && " Riwayat beli toko sedang tidak terbaca, jadi saran diurut menurut peringkat saja."}
            </p>
            {info.wajib.length === 0
                ? <MessageStrip tone="pos" title="Toko ini sudah membeli semua item super dalam 3 bulan terakhir.">Tidak ada penawaran wajib.</MessageStrip>
                : <ul aria-label="Item super yang wajib ditawarkan" style={{ listStyle: "none", margin: 0, padding: 0 }}>{info.wajib.map(baris)}</ul>}
            {info.lain.length > 0 && (
                <details>
                    <summary className="fi-small" style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer" }}>
                        Item super lain ({info.lain.length}) · sudah dibeli atau di luar 10 teratas · tidak wajib
                    </summary>
                    <ul aria-label="Item super lain" style={{ listStyle: "none", margin: 0, padding: 0 }}>{info.lain.map(baris)}</ul>
                </details>
            )}
        </section>
    );
}
