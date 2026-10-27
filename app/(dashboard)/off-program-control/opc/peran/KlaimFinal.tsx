/*
 * Tujuan: Verifikasi final Klaim OFF Program Control (Fiori S4d, claimView=after|after-finance): nilai awal isian dari detail batch
 *   (No Claim per item, checklist final, catatan, nilai fix), ringkasan uang final, syarat Selesaikan (salinan cek klien kode lama),
 *   payload POST /final-claim action=complete (SAMA dengan completeFinalClaim kode lama), dan bagian form/baca di Object Page.
 * Caller: opc/peran/Klaim.tsx (DetailKlaim).
 * Dependensi: components/fiori/{core,interactive}, lib/off-program-control/workflow (hasMinimalFinalChecklist), lib/opc-ui, lib/promo-ui,
 *   lib/tampil (KOSONG), lib/angka-lokal (nominalKeTeks, isianNominal: pengurai rupiah bersama, audit No 122).
 * Isian Nilai fix (No 122): teks bebas berformat ribuan id-ID; yang DISIMPAN di `nilaiFix` tetap teks desimal kanonik ("1500000",
 *   "1250000.5") hasil pengurai bersama, jadi payloadSelesai/perkiraanSelisih dan pemakai lain (Klaim.tsx) membaca angka yang sama
 *   seperti dulu. Masukan tidak sah disimpan apa adanya, ditandai di isian, dan menahan Selesaikan (kekuranganFinal).
 * Main Functions: awalFinal, uangFinal, kekuranganFinal, payloadSelesai, perkiraanSelisih, BagianFinal.
 * Side Effects: Tidak ada; tulis dilakukan Klaim.tsx lewat dialog.
 */
"use client";

import { useState } from "react";
import { MessageStrip, KeyValues, ListItem, ResponsiveTable, type Column } from "@/components/fiori/core";
import { FormField } from "@/components/fiori/interactive";
import { hasMinimalFinalChecklist } from "@/lib/off-program-control/workflow";
import { rupiah } from "@/lib/promo-ui";
import { tanggalOpc, type BatchOpc, type ItemOpc } from "@/lib/opc-ui";
import { isianNominal, nominalKeTeks } from "@/lib/angka-lokal";
import { KOSONG } from "@/lib/tampil";
import type { DetailBatch } from "../Bersama";

const CEKLIS = [
    ["finalKwt", "KWT"], ["finalSkp", "SKP"], ["finalFp", "FP"], ["finalPc", "PC"], ["finalFoto", "Foto"], ["finalRekap", "Rekap"], ["finalOthers", "Lainnya"],
] as const;
type KunciCeklis = (typeof CEKLIS)[number][0];
export type CeklisFinal = Record<KunciCeklis, boolean> & { finalOthersText: string; finalCompletenessNote: string };
export type IsianFinal = { refs: Record<string, string>; ceklis: Record<string, CeklisFinal>; catatan: string; nilaiFix: string };

/** Nilai awal form dari detail (loadFinalDetail kode lama). */
export function awalFinal({ batch, items }: DetailBatch): IsianFinal {
    return {
        refs: Object.fromEntries(items.map((i) => [i.id, i.noClaim || ""])),
        ceklis: Object.fromEntries(items.map((i) => [i.id, {
            finalKwt: Boolean(i.finalKwt), finalSkp: Boolean(i.finalSkp), finalFp: Boolean(i.finalFp), finalPc: Boolean(i.finalPc),
            finalFoto: Boolean(i.finalFoto), finalRekap: Boolean(i.finalRekap), finalOthers: Boolean(i.finalOthers),
            finalOthersText: i.finalOthersText || "", finalCompletenessNote: i.finalCompletenessNote || "",
        }])),
        catatan: batch.finalClaimNote || "",
        // #17 Gap a: isi nilai fix dengan verifiedAmount yang ada, atau kosong (default = paidAmount di payload).
        nilaiFix: batch.verifiedAmount != null ? String(batch.verifiedAmount) : "",
    };
}

const metode = (v: string | null) => {
    const n = String(v || "").trim().toLowerCase();
    return n === "transfer" ? "Transfer" : n === "tunai" ? "Tunai" : v;
};
const jumlah = (xs: ItemOpc[]) => xs.reduce((t, i) => t + Number(i.nominal || 0), 0);

/** Ringkasan uang final (kode lama): total/transfer/tunai dari ringkasan server atau item; dibayar & sisa dari pembayaran. */
export function uangFinal({ batch, items, summary, paymentSummary }: DetailBatch) {
    const total = Number(summary?.totalNominal || jumlah(items));
    const dibayar = Number(paymentSummary?.totalPaid ?? batch.paidAmount ?? 0);
    return {
        total,
        transfer: Number(summary?.transfer || jumlah(items.filter((i) => metode(i.caraBayar) === "Transfer"))),
        tunai: Number(summary?.tunai || jumlah(items.filter((i) => metode(i.caraBayar) === "Tunai"))),
        dibayar,
        sisa: Number(paymentSummary?.remainingAmount ?? Math.max(0, total - dibayar)),
    };
}

/** Alasan Selesaikan belum bisa: urutan dan kalimat cek klien kode lama (server memeriksa ulang). */
export function kekuranganFinal(data: DetailBatch, isian: IsianFinal): string[] {
    const kurang: string[] = [];
    if (uangFinal(data).sisa > 0) kurang.push("Pembayaran belum lunas, belum bisa disetujui Klaim.");
    const bersurat = data.items.filter((i) => i.noSurat);
    const tanpaNoClaim = bersurat.filter((i) => !String(isian.refs[i.id] || "").trim());
    if (tanpaNoClaim.length) kurang.push(`No Claim wajib diisi untuk No Surat: ${tanpaNoClaim.map((i) => i.noSurat).join(", ")}.`);
    const tanpaCeklis = bersurat.filter((i) => { const cl = isian.ceklis[i.id]; return !cl || !hasMinimalFinalChecklist(cl); });
    if (tanpaCeklis.length) kurang.push(`Checklist kelengkapan final wajib diisi minimal satu untuk No Surat: ${tanpaCeklis.map((i) => i.noSurat).join(", ")}.`);
    // No 122: nilai fix yang tidak terbaca tidak boleh diam-diam menjadi "sama dengan dibayar".
    const fix = galatNilaiFix(isian.nilaiFix);
    if (fix) kurang.push(`Nilai fix belum sah: ${fix}`);
    return kurang;
}

/** Galat pengurai rupiah bersama untuk isian nilai fix; kosong = sah (sama dengan dibayar). */
const galatNilaiFix = (t: string) => { if (!t.trim()) return ""; const r = nominalKeTeks(t); return "galat" in r ? r.galat : ""; };
/** Isian manusia -> yang disimpan di `nilaiFix`: kosong tetap kosong, sah = teks desimal kanonik, tidak sah = apa adanya (ditahan). */
const kanonikFix = (t: string) => { if (!t.trim()) return ""; const r = nominalKeTeks(t); return "galat" in r ? t : r.teks; };
/** Tampilan `nilaiFix` berformat ribuan id-ID; teks yang tidak bisa dibaca bolak-balik tampil apa adanya. */
const tampilFix = (v: string) => { const r = v.trim() ? nominalKeTeks(v) : null; return r && "teks" in r ? isianNominal(Number(r.teks)) ?? v : v; };

/**
 * Body POST /final-claim action=complete: SAMA dengan completeFinalClaim kode lama, plus `alasanSendiri` (BL-10, #132):
 * layar Fiori SELALU mengirimnya (kosong bila pelaku bukan pembuat batch) supaya server tidak memakai jalur transisi tanpa alasan.
 */
export function payloadSelesai(data: DetailBatch, isian: IsianFinal, alasanSendiri: string) {
    const claimRefs = data.items.filter((i) => i.noSurat).map((i) => {
        const cl: Partial<CeklisFinal> = isian.ceklis[i.id] || {};
        return {
            itemId: i.id, noSurat: i.noSurat, noClaim: String(isian.refs[i.id] || "").trim(),
            finalKwt: cl.finalKwt || false, finalSkp: cl.finalSkp || false, finalFp: cl.finalFp || false, finalPc: cl.finalPc || false,
            finalFoto: cl.finalFoto || false, finalRekap: cl.finalRekap || false, finalOthers: cl.finalOthers || false,
            finalOthersText: cl.finalOthersText || "", finalCompletenessNote: cl.finalCompletenessNote || "",
        };
    });
    return {
        action: "complete",
        note: isian.catatan,
        alasanSendiri,
        claimRefs,
        // #17 Gap a: kirim nilai fix jika Claim mengubahnya dari default paidAmount.
        ...(isian.nilaiFix.trim() ? { verifiedAmount: Number(isian.nilaiFix.replace(/[^\d.]/g, "")) || undefined } : {}),
    };
}

/** Perkiraan selisih yang akan dihitung server (final-claim: verifiedAmount kosong/tidak sah = dibayar; lebih = dibayar − nilai fix). */
export function perkiraanSelisih(dibayar: number, nilaiFix: string) {
    const fix = nilaiFix.trim() ? Number(nilaiFix.replace(/[^\d.]/g, "")) || undefined : undefined;
    return Math.max(0, dibayar - (fix ?? dibayar));
}

const labelCeklis = (cl: Partial<Record<KunciCeklis, boolean | null>>) => CEKLIS.filter(([k]) => cl[k]).map(([, l]) => l).join(", ") || KOSONG;
const periodeItem = (p: string | null) => {
    const [awal = "", akhir = ""] = String(p || "").split(" - ");
    return awal || akhir ? `${tanggalOpc(awal || null)} – ${tanggalOpc(akhir || null)}` : "";
};

type BagianFinalProps = { data: DetailBatch; isian: IsianFinal; ubah?: (f: (x: IsianFinal) => IsianFinal) => void; kurang?: string[] };

/** Bagian "Verifikasi final": form (bila `ubah`) atau baca (batch selesai / menunggu selisih / bukan antrean). */
export function BagianFinal({ data, isian, ubah, kurang = [] }: BagianFinalProps) {
    const b: BatchOpc = data.batch;
    // Teks yang sedang diketik tetap tampil selama masih mewakili `nilaiFix`; sesudah blur tampil berformat ribuan (No 122).
    const [ketikFix, setKetikFix] = useState<string | null>(null);
    const u = uangFinal(data);
    const ringkas = (
        <KeyValues items={[
            ["Total diajukan", <span key="t" className="fi-tnum">{rupiah(u.total)}</span>],
            ["Transfer", <span key="tr" className="fi-tnum">{rupiah(u.transfer)}</span>],
            ["Tunai", <span key="tu" className="fi-tnum">{rupiah(u.tunai)}</span>],
            ["Dibayar Keuangan", <span key="d" className="fi-tnum">{rupiah(u.dibayar)}</span>],
            ["Sisa pembayaran", <span key="s" className="fi-tnum">{rupiah(u.sisa)}</span>],
            ["Tanggal bayar", tanggalOpc(b.paymentDate)],
            ["Catatan Keuangan", b.financeNote || KOSONG],
            ["Diajukan ke principal", tanggalOpc(b.claimSubmittedDate)],
            ["Deadline klaim", tanggalOpc(b.claimDeadline)],
        ]} />
    );

    if (!ubah) {
        const kolom: Column<ItemOpc>[] = [
            { key: "surat", header: "No Surat", cell: (i) => <span className="fi-mono">{i.noSurat || KOSONG}</span> },
            { key: "claim", header: "No Claim", cell: (i) => (i.noClaim ? <span className="fi-mono">{i.noClaim}</span> : "Belum ada") },
            { key: "ceklis", header: "Kelengkapan final", cell: (i) => labelCeklis(i) },
            { key: "lain", header: "Keterangan lainnya", secondary: true, cell: (i) => i.finalOthersText || KOSONG },
            { key: "catatan", header: "Catatan", secondary: true, cell: (i) => i.finalCompletenessNote || KOSONG },
        ];
        return (
            <>
                <div className="fi-sect-in">
                    {ringkas}
                    <KeyValues items={[
                        ["Nilai fix (realisasi klaim)", b.verifiedAmount != null ? <span className="fi-tnum">{rupiah(b.verifiedAmount)}</span> : "Belum diverifikasi"],
                        ["Catatan verifikasi final", b.finalClaimNote || KOSONG],
                    ]} />
                </div>
                <ResponsiveTable title="Hasil verifikasi final per item" columns={kolom} rows={data.items} rowKey={(i) => i.id}
                    empty={{ title: data.uji ? "Item tidak dimuat untuk data uji" : "Batch ini tidak punya item" }}
                    mobileItem={(i) => <ListItem doc={i.noSurat || `Item ${i.itemNo}`} title={i.noClaim ? `No Claim ${i.noClaim}` : "No Claim belum ada"} meta={labelCeklis(i)} />} />
            </>
        );
    }

    const teksFix = ketikFix !== null && kanonikFix(ketikFix) === isian.nilaiFix ? ketikFix : tampilFix(isian.nilaiFix);
    const galatFix = galatNilaiFix(isian.nilaiFix);
    const lebih = perkiraanSelisih(u.dibayar, isian.nilaiFix);
    const fixAngka = Number(isian.nilaiFix);
    const tampilSelisih = isian.nilaiFix.trim() !== "" && !Number.isNaN(fixAngka) && fixAngka !== u.dibayar;
    const ubahCeklis = (id: string, patch: Partial<CeklisFinal>) =>
        ubah((x) => ({ ...x, ceklis: { ...x.ceklis, [id]: { ...x.ceklis[id], ...patch } } }));
    return (
        <>
            <div className="fi-sect-in">
                <MessageStrip tone="info" title="Yang diperiksa Klaim:">
                    bukti pembayaran, kesesuaian total pembayaran, dan No Claim per No Surat. Bila kelengkapan belum lengkap, kirim pengingat ke SM dan SPV;
                    bila sesuai, selesaikan pengajuan.
                </MessageStrip>
                {ringkas}
                {u.sisa > 0 && <MessageStrip tone="neg" title="Pembayaran belum lunas.">Sisa {rupiah(u.sisa)}; verifikasi final belum bisa diselesaikan.</MessageStrip>}
            </div>
            <ol aria-label="Item verifikasi final" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {data.items.length === 0 && <li className="fi-sect-in fi-small fi-subtle">{data.uji ? "Item tidak dimuat untuk data uji." : "Batch ini tidak punya item."}</li>}
                {data.items.map((i) => {
                    const cl = isian.ceklis[i.id];
                    const idCek = `opc-final-cek-${i.id}`;
                    return (
                        <li key={i.id} className="fi-sect-in" style={{ borderTop: "1px solid var(--line)" }}>
                            <div role="group" aria-label={`Item ${i.itemNo}`} style={{ display: "grid", gap: 10 }}>
                                <p className="fi-small">
                                    <b>Item {i.itemNo}</b> · <span className="fi-mono">{i.noSurat || "tanpa No Surat"}</span> · {i.toko || KOSONG} · <span className="fi-tnum">{rupiah(i.nominal)}</span>
                                </p>
                                <p className="fi-small fi-subtle">
                                    {[i.namaProgram, periodeItem(i.periode), i.barang, i.caraBayar, i.type, i.deadline ? `deadline ${tanggalOpc(i.deadline)}` : ""].filter(Boolean).join(" · ")}
                                </p>
                                <div className="fi-formgrid">
                                    <FormField label="No Claim" required={Boolean(i.noSurat)}>{(a) => (
                                        <input {...a} className="fi-input fi-mono" value={isian.refs[i.id] || ""} placeholder="Isi No Claim"
                                            onChange={(e) => { const v = e.target.value; ubah((x) => ({ ...x, refs: { ...x.refs, [i.id]: v } })); }} />
                                    )}</FormField>
                                    <FormField label="Keterangan lainnya">{(a) => (
                                        <input {...a} className="fi-input" value={cl?.finalOthersText || ""} disabled={!cl?.finalOthers} placeholder="Bila Lainnya dicentang"
                                            onChange={(e) => ubahCeklis(i.id, { finalOthersText: e.target.value })} />
                                    )}</FormField>
                                </div>
                                <div className="fi-field">
                                    {/* Grup checkbox tidak mengenal aria-required: wajibnya diucapkan lewat teks tersembunyi. */}
                                    <span className="fi-label" id={idCek}>Kelengkapan final{i.noSurat && <><span className="fi-req" aria-hidden>*</span><span className="sr-only"> (wajib, minimal satu)</span></>}</span>
                                    <div role="group" aria-labelledby={idCek} className="fi-btnrow">
                                        {CEKLIS.map(([k, label]) => (
                                            <label key={k} className="fi-check">
                                                <input type="checkbox" checked={Boolean(cl?.[k])} onChange={(e) => ubahCeklis(i.id, { [k]: e.target.checked })} />{label}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                                <FormField label="Catatan kelengkapan final">{(a) => (
                                    <textarea {...a} className="fi-input" rows={2} value={cl?.finalCompletenessNote || ""} placeholder="Catatan per item"
                                        onChange={(e) => ubahCeklis(i.id, { finalCompletenessNote: e.target.value })} />
                                )}</FormField>
                            </div>
                        </li>
                    );
                })}
            </ol>
            <div className="fi-sect-in" style={{ borderTop: "1px solid var(--line)" }}>
                <div className="fi-formgrid">
                    <div className="fi-field">
                        <span className="fi-label">Total dibayar Keuangan</span>
                        <b className="fi-tnum">{rupiah(u.dibayar)}</b>
                    </div>
                    <FormField label="Nilai fix (isi bila berbeda)" error={galatFix || undefined}
                        help={`Isi bila realisasi klaim berbeda dari total yang sudah dibayar Keuangan, mis. 1.500.000. Kosong berarti sama dengan ${rupiah(u.dibayar)}. Selisih masuk Data Selisih dan dikembalikan SPV/SM.`}>
                        {(a) => (
                            // type="text": roda mouse tidak mengubah nilai yang menentukan selisih, dan "1.500.000" terbaca sebagai ribuan.
                            <input {...a} className="fi-input fi-tnum" type="text" inputMode="numeric" autoComplete="off" value={teksFix}
                                onChange={(e) => { const t = e.target.value; setKetikFix(t); ubah((x) => ({ ...x, nilaiFix: kanonikFix(t) })); }}
                                onBlur={() => setKetikFix(null)} />
                        )}
                    </FormField>
                </div>
                {tampilSelisih && (
                    <MessageStrip tone="warn" title={`Selisih ${rupiah(Math.abs(u.dibayar - fixAngka))}.`}>
                        {u.dibayar > fixAngka ? `Akan masuk Data Selisih dan memerlukan pengembalian ${rupiah(lebih)}.` : "Nilai fix lebih besar dari pembayaran."}
                    </MessageStrip>
                )}
                <FormField label="Catatan verifikasi final" help="Wajib bila mengirim pengingat kelengkapan belum lengkap.">{(a) => (
                    <textarea {...a} className="fi-input" rows={3} value={isian.catatan} onChange={(e) => { const v = e.target.value; ubah((x) => ({ ...x, catatan: v })); }} />
                )}</FormField>
                {kurang.length > 0 && (
                    <MessageStrip tone="warn" title="Belum bisa diselesaikan:">
                        <ul style={{ margin: 0, paddingLeft: 18 }}>{kurang.map((k) => <li key={k}>{k}</li>)}</ul>
                    </MessageStrip>
                )}
            </div>
        </>
    );
}
