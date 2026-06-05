// Tujuan: Breadcrumb navigasi khusus halaman OFF Program Control.
// Caller: app/(dashboard)/off-program-control/page.tsx.
// Dependensi: lucide-react, next/link.
// Main Functions: OffBreadcrumb.
// Side Effects: Tidak ada.
"use client";

import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";

export default function OffBreadcrumb() {
    return (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm mb-4">
            <Link
                href="/"
                className="flex items-center gap-1 text-[var(--luxury-subtle)] hover:text-[var(--luxury-gold)] transition-colors"
            >
                <Home size={14} />
                <span className="hidden sm:inline">Dashboard</span>
            </Link>
            <ChevronRight size={12} className="text-[var(--luxury-subtle)] opacity-60" />
            <span className="font-semibold text-[var(--luxury-text)]">OFF Program Control</span>
        </nav>
    );
}
