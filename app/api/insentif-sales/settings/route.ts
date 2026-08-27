/*
 * Tujuan: Baca & ubah setelan aturan insentif (saat ini: ambang Target AO skema GT).
 * Caller: app/(dashboard)/insentif-sales/page.tsx (panel Admin).
 * Dependensi: lib/insentif-settings, lib/rbac/resolve.
 * Main Functions: GET mode aktif; PATCH ganti mode.
 * Side Effects: PATCH menulis app_setting dan MENGUBAH NOMINAL insentif GT/TT periode mana pun
 *   yang dihitung setelahnya — karena itu izinnya `manage`, bukan `input_support`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import { getGtAoTargetMode, setGtAoTargetMode, type GtAoTargetMode } from "@/lib/insentif-settings";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;
    return NextResponse.json({ gtAoMode: await getGtAoTargetMode() });
}

export async function PATCH(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage");
    if (gate.response) return gate.response;

    let mode: unknown;
    try {
        mode = (await req.json())?.gtAoMode;
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    // Nilai asing DITOLAK, bukan dijatuhkan ke default: "flie" yang salah ketik akan diam-diam
    // memakai ambang 240 dan penggunanya yakin sudah mengubah aturan.
    if (mode !== "fixed240" && mode !== "file") {
        return NextResponse.json({ error: 'gtAoMode harus "fixed240" atau "file".' }, { status: 400 });
    }

    await setGtAoTargetMode(mode as GtAoTargetMode, gate.session.user.id);
    return NextResponse.json({ gtAoMode: mode });
}
