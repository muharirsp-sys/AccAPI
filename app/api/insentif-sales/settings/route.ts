/*
 * Tujuan: Baca & ubah setelan aturan insentif tanpa deploy: ambang Target AO skema GT,
 *   daftar cabang beracuan NILAI_JUAL, daftar SM yang ikut skema insentif SM, dan SELURUH
 *   konstanta uang (pool/bobot/ambang GT & MT, rate SPV, strata SM, tarif PPh).
 * Caller: app/(dashboard)/insentif-sales/page.tsx (panel Admin).
 * Dependensi: lib/insentif-settings, lib/rbac/resolve.
 * Main Functions: GET mode aktif; PATCH ganti mode.
 * Side Effects: PATCH menulis app_setting dan MENGUBAH NOMINAL insentif GT/TT periode mana pun
 *   yang dihitung setelahnya — karena itu izinnya `manage`, bukan `input_support`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac/resolve";
import {
    getGtAoTargetMode, setGtAoTargetMode, type GtAoTargetMode,
    getBranchNilaiJual, getSmBerhak, setDaftar,
    readKonstantaVersi, setKonstanta, KonstantaBerubahError,
    BRANCH_NILAI_JUAL_KEY, SM_BERHAK_KEY,
} from "@/lib/insentif-settings";
import { validateKonstanta, DEFAULT_KONSTANTA } from "@/lib/insentif-konstanta";

export async function GET(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.view");
    if (gate.response) return gate.response;
    // AM-020: tampilan boleh degraded (bawaan) bila setelan tak terbaca, tetapi DILABELI —
    // editor menolak menyimpan draf yang dasarnya fallback.
    const [gtAoMode, branchNilaiJual, smBerhak, [konstanta, konstantaSumber, konstantaVersi]] = await Promise.all([
        getGtAoTargetMode(), getBranchNilaiJual(), getSmBerhak(),
        readKonstantaVersi().then((r) => [r.konstanta, "tersimpan", r.versi] as const, () => [DEFAULT_KONSTANTA, "gagal_baca", null] as const),
    ]);
    return NextResponse.json({ gtAoMode, branchNilaiJual, smBerhak, konstanta, konstantaSumber, konstantaVersi, konstantaBawaan: DEFAULT_KONSTANTA });
}

export async function PATCH(req: NextRequest) {
    const gate = await requirePermission(req, "insentif_sales.manage");
    if (gate.response) return gate.response;

    let body: Record<string, unknown>;
    try {
        body = (await req.json()) ?? {};
    } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if ("gtAoMode" in body) {
        const mode = body.gtAoMode;
        // Nilai asing DITOLAK, bukan dijatuhkan ke default: "flie" yang salah ketik akan diam-diam
        // memakai ambang 240 dan penggunanya yakin sudah mengubah aturan.
        if (mode !== "fixed240" && mode !== "file") {
            return NextResponse.json({ error: 'gtAoMode harus "fixed240" atau "file".' }, { status: 400 });
        }
        await setGtAoTargetMode(mode as GtAoTargetMode, gate.session.user.id);
    }

    // Daftar sengaja divalidasi sebagai array string murni. Angka atau objek yang lolos akan
    // tersimpan sebagai "[object Object]" dan diam-diam tidak pernah cocok dengan cabang mana
    // pun — gejalanya "kok pencapaiannya turun", bukan pesan error.
    for (const [field, key] of [["branchNilaiJual", BRANCH_NILAI_JUAL_KEY], ["smBerhak", SM_BERHAK_KEY]] as const) {
        if (!(field in body)) continue;
        const nilai = body[field];
        if (!Array.isArray(nilai) || nilai.some((v) => typeof v !== "string")) {
            return NextResponse.json({ error: `${field} harus berupa array teks.` }, { status: 400 });
        }
        await setDaftar(key, nilai as string[], gate.session.user.id);
    }

    // Konstanta uang: divalidasi dulu dan DITOLAK seluruhnya kalau ada satu angka aneh.
    // Menyimpan sebagian akan meninggalkan tabel rate setengah berubah — nominal yang keluar
    // bukan aturan lama maupun aturan baru.
    if ("konstanta" in body) {
        const pesan = validateKonstanta(body.konstanta);
        if (pesan.length) return NextResponse.json({ error: pesan.join(" ") }, { status: 400 });
        // AM-045: tanpa versi yang dimuat, dua admin saling menimpa diam-diam. null = belum pernah disimpan.
        const versi = body.konstantaVersi;
        if (versi !== null && typeof versi !== "string") {
            return NextResponse.json({ error: "konstantaVersi wajib dikirim (muat ulang editor)." }, { status: 400 });
        }
        try {
            await setKonstanta(body.konstanta, gate.session.user.id, versi);
        } catch (e) {
            if (e instanceof KonstantaBerubahError) return NextResponse.json({ error: e.message, code: "KONSTANTA_BERUBAH" }, { status: 409 });
            throw e;
        }
    }

    // Review #3: jawaban PATCH menjadi dasar draf editor berikutnya -> baca strict, bukan fallback.
    const [gtAoMode, branchNilaiJual, smBerhak, { konstanta, versi: konstantaVersi }] = await Promise.all([
        getGtAoTargetMode(), getBranchNilaiJual(), getSmBerhak(), readKonstantaVersi(),
    ]);
    return NextResponse.json({ gtAoMode, branchNilaiJual, smBerhak, konstanta, konstantaSumber: "tersimpan", konstantaVersi, konstantaBawaan: DEFAULT_KONSTANTA });
}
