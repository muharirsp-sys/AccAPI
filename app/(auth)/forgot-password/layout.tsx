/* Tujuan: judul tab /forgot-password — page.tsx-nya komponen klien, tidak boleh mengekspor metadata. */
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Lupa sandi" };

export default function Layout({ children }: { children: ReactNode }) {
    return children;
}
