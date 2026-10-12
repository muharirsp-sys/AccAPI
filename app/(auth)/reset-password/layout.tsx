/* Tujuan: judul tab /reset-password — page.tsx-nya komponen klien, tidak boleh mengekspor metadata. */
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Atur ulang sandi" };

export default function Layout({ children }: { children: ReactNode }) {
    return children;
}
