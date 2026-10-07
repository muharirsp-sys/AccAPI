/*
 * Tujuan: Pembungkus `.fiori` (font + token design system Fiori) untuk halaman yang sudah dimigrasi.
 * Caller: Halaman yang sudah dimigrasi ke design system Fiori (mulai app/(dashboard)/dev/ui-kit).
 * Dependensi: next/font/google (Plus Jakarta Sans, Geist Mono), app/fiori.css.
 * Main Functions: FioriScope, fioriClass.
 * Side Effects: Memuat font hanya di rute yang memakai FioriScope.
 */
import type { ReactNode } from "react";
import { Geist_Mono, Plus_Jakarta_Sans } from "next/font/google";

// Font variabel: bobot 650 di token judul butuh sumbu wght, jadi tanpa daftar `weight`.
const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono-fi", subsets: ["latin"], display: "swap" });

/** Kelas `.fiori` + variabel font, untuk elemen selain <div> (mis. bagian shell). */
export const fioriClass = `fiori ${jakarta.variable} ${geistMono.variable}`;

export function FioriScope({ children, className = "" }: { children: ReactNode; className?: string }) {
    return <div className={`${fioriClass} ${className}`}>{children}</div>;
}
