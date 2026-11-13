/*
 * Tujuan: Item Super Form Kontrol (owner 13 Nov 2026) — GET ringkasan / daftar per principal; POST unggah berkas "Item Super per Channel per
 *   Principal" (multipart `file` + `peta` JSON {principal, sales} + `periode`) yang MENGGANTI daftar principal di berkas.
 * Caller: app/(dashboard)/form-kontrol/tabs/TabItemSuper.tsx.
 * Dependensi: lib/form-kontrol/item-super (bacaItemSuper, murni), lib/form-kontrol/item-super-db (gantiItemSuper, ringkasan, daftar), xlsx,
 *   lib/rbac/resolve (form_kontrol.view / form_kontrol.manage), writeKontrolAudit.
 * Side Effects: POST menulis item_super (DELETE + INSERT satu transaksi) + kontrol_audit_log.
 */
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { requirePermissionH } from "@/lib/rbac/resolve";
import { writeKontrolAudit } from "@/lib/form-kontrol";
import { SHEET_ITEM_SUPER, bacaItemSuper, type PetaItemSuper } from "@/lib/form-kontrol/item-super";
import { daftarItemSuper, gantiItemSuper, ringkasanItemSuper } from "@/lib/form-kontrol/item-super-db";

const BATAS_BERKAS = 8 * 1024 * 1024;

export async function GET(req: Request) {
    const gate = await requirePermissionH("form_kontrol.view");
    if (gate.response) return gate.response;
    try {
        const principle = new URL(req.url).searchParams.get("principle")?.trim();
        return NextResponse.json(principle ? { rows: await daftarItemSuper(principle) } : { ringkasan: await ringkasanItemSuper() });
    } catch {
        return NextResponse.json({ error: "Data item super belum berhasil dimuat." }, { status: 500 });
    }
}

/** Baris sheet ber-judul (header di baris 3); sheet tidak ada = []. */
function sheet(wb: XLSX.WorkBook, nama: string): Record<string, unknown>[] {
    const s = wb.Sheets[wb.SheetNames.find((n) => n.trim().toLowerCase() === nama.toLowerCase()) ?? ""];
    return s ? XLSX.utils.sheet_to_json<Record<string, unknown>>(s, { defval: "", range: 2 }) : [];
}

export async function POST(req: Request) {
    const gate = await requirePermissionH("form_kontrol.manage");
    if (gate.response) return gate.response;
    try {
        if (Number(req.headers.get("content-length") ?? 0) > BATAS_BERKAS + 64 * 1024) {
            return NextResponse.json({ kode: "BERKAS_TERLALU_BESAR", error: "Berkas lebih dari 8 MB." }, { status: 413 });
        }
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof File) || file.size > BATAS_BERKAS) return NextResponse.json({ kode: "BERKAS_WAJIB", error: "Pilih berkas .xlsx (maks. 8 MB)." }, { status: 400 });
        let peta: PetaItemSuper;
        try {
            const p = JSON.parse(String(form.get("peta") ?? "")) as PetaItemSuper;
            if (!p || typeof p.principal !== "object" || typeof p.sales !== "object") throw new Error();
            peta = { principal: p.principal, sales: p.sales };
        } catch {
            return NextResponse.json({ kode: "PETA_WAJIB", error: "Peta principal belum terkirim. Pilih ulang berkasnya." }, { status: 400 });
        }
        const periode = String(form.get("periode") ?? "").trim().slice(0, 60);
        if (!periode) return NextResponse.json({ kode: "PERIODE_WAJIB", error: "Isi periode data (mis. Mei–Okt 2026)." }, { status: 400 });

        const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" });
        const channel = sheet(wb, SHEET_ITEM_SUPER.channel);
        if (channel.length === 0) return NextResponse.json({ kode: "SHEET_TIDAK_ADA", error: `Sheet "${SHEET_ITEM_SUPER.channel}" tidak ditemukan atau kosong.` }, { status: 400 });
        const hasil = bacaItemSuper(channel, sheet(wb, SHEET_ITEM_SUPER.mtSales), peta);
        if (hasil.galat.length) {
            return NextResponse.json({ kode: "BERKAS_BERMASALAH", galat: hasil.galat.slice(0, 50),
                error: `Tidak ada yang ditulis: ${hasil.galat.length} baris bermasalah (mis. ${hasil.galat[0].sheet} baris ${hasil.galat[0].baris}: ${hasil.galat[0].pesan})` }, { status: 400 });
        }
        if (hasil.saran.length === 0) return NextResponse.json({ kode: "PETA_KOSONG", error: "Belum ada principal yang dipetakan; tidak ada yang ditulis." }, { status: 400 });
        const tulis = await gantiItemSuper(hasil.saran, periode, gate.session.user.id);
        await writeKontrolAudit("item_super", tulis.principal.join(","), "unggah", gate.session.user.id, gate.session.user.name ?? null,
            { berkas: file.name, periode, ...tulis, varianDigabung: hasil.varianDigabung, lewat: hasil.lewat });
        return NextResponse.json({ success: true, ...tulis, varianDigabung: hasil.varianDigabung, lewat: hasil.lewat });
    } catch {
        return NextResponse.json({ error: "Unggah item super gagal; tidak ada yang ditulis." }, { status: 500 });
    }
}
