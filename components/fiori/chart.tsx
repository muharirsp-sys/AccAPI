/*
 * Tujuan: Primitive grafik Fiori tanpa dependensi (Opsi A+, docs/audit/AUDIT_CHART.md): `Bullet` = batang nilai + garis 100% + penanda
 *   acuan (mis. capaian vs Time Gone), satu skala untuk semua baris supaya penandanya sejajar.
 * Caller: app/(dashboard)/insentif-sales/Rincian.tsx (LajuBatang).
 * Dependensi: React (JSX); kelas `fi-bullet*` + nada `[data-tone]` (`--ts`) di app/fiori.css.
 * Main Functions: Bullet, skalaBullet, posisiBullet.
 * Side Effects: Tidak ada.
 */
import type { Tone } from "./core";

/** Skala bersama satu tabel: minimal 100, dibulatkan ke atas ke kelipatan 10. Nilai bukan angka diabaikan. */
export function skalaBullet(nilai: number[]): number {
    const maks = Math.max(100, ...nilai.filter(Number.isFinite));
    return Math.ceil(maks / 10) * 10;
}

/** Posisi nilai pada skala, dalam persen lebar trek; di luar rentang dijepit ke 0..100, bukan meluber. */
export function posisiBullet(nilai: number, skala: number): number {
    if (!Number.isFinite(nilai) || !(skala > 0)) return 0;
    return Math.min(100, Math.max(0, (nilai / skala) * 100));
}

/**
 * Batang `nilai` + garis tipis 100% + garis tebal `acuan` dalam skala 0..`skala` (pakai skalaBullet untuk satu tabel). Dekoratif bagi
 * pembaca layar (`aria-hidden`): angka dan nadanya wajib tertulis di sebelahnya (mis. badge Laju). Tanpa animasi.
 */
export function Bullet({ nilai, acuan, skala, tone }: { nilai: number; acuan: number; skala: number; tone: Exclude<Tone, "info"> }) {
    const penuh = posisiBullet(100, skala), ref = posisiBullet(acuan, skala);
    return (
        <svg className="fi-bullet" data-tone={tone} viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden focusable="false">
            <rect className="fi-bullet-track" x="0" y="6" width="100" height="8" />
            <rect className="fi-bullet-bar" x="0" y="6" width={posisiBullet(nilai, skala)} height="8" />
            <line className="fi-bullet-full" x1={penuh} x2={penuh} y1="3" y2="17" />
            <line className="fi-bullet-ref" x1={ref} x2={ref} y1="0" y2="20" />
        </svg>
    );
}
