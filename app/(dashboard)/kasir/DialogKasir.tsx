/*
 * Tujuan: Dialog tulis layar Kasir ↔ Incaso (K2b, BL-59; KASIR-KONTRAK §8.4–§8.7): setoran (Tunai/Transfer/Giro; Form Kasir wajib bila > 0,
 *   bukti foto/PDF WAJIB bila Transfer > 0, Giro wajib nomor BG + jatuh tempo — owner 12 Okt), jelaskan (selisih orang / uang tak teralokasi),
 *   tutup hari, buka kembali (OM/Admin), konfirmasi hapus massal cache. Semua lewat ConfirmDialog (tanpa window.*), satu POST per klik.
 * Caller: Kasir.tsx (dipasang hanya saat dialog itu aktif).
 * Dependensi: components/fiori (ConfirmDialog, FormField, useUnsavedGuard, MessageStrip, KeyValues), ./bersama (kirimKasir, nominalKeTeks, format).
 * Main Functions: DialogSetoran, DialogJelaskan, DialogTutup, DialogBuka, DialogHapus.
 * Side Effects: POST /api/kasir/{setoran,jelaskan,tutup,buka} (via kirimKasir); hasil diteruskan ke pemanggil (selesai / ragu / muat ulang).
 */
"use client";

import { useState, type ReactNode } from "react";
import { MessageStrip } from "@/components/fiori/core";
import { ConfirmDialog, FormField, useUnsavedGuard } from "@/components/fiori/interactive";
import {
    bulatAtas100, jamWita, kirimKasir, LABEL_STATUS, LABEL_TINDAK, labelEmber, namaTampil, nominalKeTeks, panjang, rp, rpSen, senDari,
    tanggalPanjang, waktuWita, type BarisOrang, type Ember, type Hari, type Jawab, type TindakLanjut,
} from "./bersama";

/** Kabar ke pemanggil. `ragu` = jawaban TIDAK PASTI: pemanggil menutup dialog, memuat ulang, lalu membandingkan dengan `periksa`. */
export type Kabar = {
    selesai: (pesan: string) => void;
    ragu: (aksi: string, periksa: (h: Hari) => string) => void;
    muatUlang: () => void;
    tutup: () => void;
};
type Umum = { hari: Hari; tanggal: string; kunci?: string; kabar: Kabar };

/** Penolakan PASTI -> Error untuk dialog (isian tetap). 409 apa pun = keadaan berubah: data dimuat ulang. */
function tolak(j: Extract<Jawab, { jenis: "tolak" }>, kabar: Kabar, tambahan = ""): never {
    if (j.http === 409 || j.http === 422) kabar.muatUlang();
    throw new Error(`${j.pesan}${tambahan ? ` ${tambahan}` : ""}`);
}

const geserHari = (ymd: string, n: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const tampilAngka = (t: string) => (Number(t) ? Number(t).toLocaleString("id-ID", { maximumFractionDigits: 2 }) : "");
/** Isian awal: koreksi = nominal + Form Kasir/BG revisi terakhir; baru = kosong. */
const isiDari = (b: BarisOrang | null) => ({
    tunai: b?.setoran ? tampilAngka(b.setoran.tunai) : "", transfer: b?.setoran ? tampilAngka(b.setoran.transfer) : "",
    giro: b?.setoran ? tampilAngka(b.setoran.giro) : "", form: b?.setoranTerakhir?.noFormKasir ?? "", bg: b?.setoranTerakhir?.giroNomor ?? "",
    tempo: b?.setoranTerakhir?.giroJatuhTempo ?? "", catatan: "",
});
/** Klien tidak lebih ketat dari server (server memeriksa MAGIC BYTES): tipe ATAU ekstensi yang dikenal cukup. */
const BUKTI_TIPE = /\.(jpe?g|jpe|jfif|png|pdf)$/i;
const BUKTI_MIME = new Set(["image/jpeg", "image/png", "application/pdf"]);
const tglId = (ymd: string) => ymd.split("-").reverse().join("/");
const MAKS_BUKTI = 5 * 1024 * 1024;

// ── Setoran ──────────────────────────────────────────────────────────────────────────────────────────────

type Pilihan = { kode: string; orang: string; nama: string };

export function DialogSetoran({ hari, tanggal, kunci, kabar, orangAwal }: Umum & { orangAwal: string | null }) {
    // Pilihan pegawai: orang yang sudah ada di hari ini (kecuali Tanpa salesman) + pegawai salesman aktif (setoran tanpa pelunasan).
    const pilihan: Pilihan[] = [];
    for (const o of hari.orang) if (o.orang !== "") pilihan.push({ kode: o.orang, orang: o.orang, nama: o.nama });
    for (const p of hari.pegawai) if (!pilihan.some((x) => x.orang === p.orang)) pilihan.push(p);
    const [pilih, setPilih] = useState(orangAwal ?? "");
    const terpilih = pilihan.find((p) => p.orang === pilih) ?? null;
    const barisDari = (o: string): BarisOrang | null => hari.orang.find((x) => x.orang === o && o !== "") ?? null;
    const baris = barisDari(pilih);
    const t0 = baris?.setoranTerakhir;
    const [isi, setIsi] = useState(() => isiDari(baris));
    const [bukti, setBukti] = useState<File | null>(null);
    const [awalIsi] = useState(isi);
    const ubah = (k: keyof typeof isi) => (v: string) => setIsi((s) => ({ ...s, [k]: v }));
    const dirty = bukti !== null || (Object.keys(isi) as (keyof typeof isi)[]).some((k) => isi[k] !== awalIsi[k]) || pilih !== (orangAwal ?? "");
    useUnsavedGuard(dirty);

    const n = { tunai: nominalKeTeks(isi.tunai), transfer: nominalKeTeks(isi.transfer), giro: nominalKeTeks(isi.giro) };
    const galatNominal = (k: keyof typeof n) => ("galat" in n[k] ? (n[k] as { galat: string }).galat : undefined);
    const sen = (k: keyof typeof n) => ("sen" in n[k] ? (n[k] as { sen: number }).sen : 0);
    const total = sen("tunai") + sen("transfer") + sen("giro");
    const pelSen = senDari(baris?.pelunasan);
    // Bukti revisi lama dipakai ulang hanya bila revisi terakhir kode UTAMA punya bukti DAN transfernya sama (§8.4 buktiLama).
    const revLama = t0 && t0.kode === baris?.orang ? hari.riwayat.setoran.find((r) => r.id === t0.id) : undefined;
    const buktiLama = !bukti && sen("transfer") > 0 && Boolean(revLama?.buktiUrl) && senDari(revLama?.transfer) === sen("transfer");
    const bawah = geserHari(tanggal, -7);
    const atas = `${Number(tanggal.slice(0, 4)) + 1}${tanggal.slice(4)}`;
    // Berkas hanya berarti bila Transfer > 0 (selain itu tidak dikirim): galatnya tidak boleh mengunci Simpan dari kolom yang tersembunyi.
    const buktiDipakai = sen("transfer") > 0 ? bukti : null;
    const galatBukti = buktiDipakai && !BUKTI_MIME.has(buktiDipakai.type) && !BUKTI_TIPE.test(buktiDipakai.name) ? "Bukti harus foto JPG/PNG atau PDF."
        : buktiDipakai && buktiDipakai.size > MAKS_BUKTI ? "Berkas bukti maksimal 5 MB." : undefined;

    const blok = kunci
        ?? (!terpilih ? "Pilih pegawai dulu"
            : galatNominal("tunai") ? `Tunai: ${galatNominal("tunai")}` : galatNominal("transfer") ? `Transfer: ${galatNominal("transfer")}`
            : galatNominal("giro") ? `Giro: ${galatNominal("giro")}`
            : total > 0 && !isi.form.trim() ? "Isi Nomor Form Kasir (wajib bila setoran lebih dari 0)"
            : panjang(isi.form) > 100 ? "Nomor Form Kasir maksimal 100 karakter"
            : sen("transfer") > 0 && !bukti && !buktiLama ? "Unggah bukti transfer (foto/PDF) — wajib untuk setoran Transfer"
            : galatBukti
            ?? (sen("giro") > 0 && !isi.bg.trim() ? "Isi nomor BG (wajib untuk setoran Giro)"
                : sen("giro") > 0 && panjang(isi.bg) > 100 ? "Nomor BG maksimal 100 karakter"
                : sen("giro") > 0 && !isi.tempo ? "Isi tanggal jatuh tempo Giro"
                : sen("giro") > 0 && (isi.tempo < bawah || isi.tempo > atas) ? `Jatuh tempo Giro harus antara ${tglId(bawah)} dan ${tglId(atas)}`
                : panjang(isi.catatan) > 500 ? "Catatan maksimal 500 karakter" : undefined));

    async function simpan() {
        if (!terpilih) return;
        const teks = (k: keyof typeof n) => ("teks" in n[k] ? (n[k] as { teks: string }).teks : "0");
        const dikirim = { tunai: sen("tunai"), transfer: sen("transfer"), giro: sen("giro") };
        const giroAda = dikirim.giro > 0;
        const data: Record<string, unknown> = {
            tanggal, orang: terpilih.kode, tunai: teks("tunai"), transfer: teks("transfer"), giro: teks("giro"),
            ...(isi.form.trim() ? { noFormKasir: isi.form.trim() } : {}),
            ...(giroAda ? { giroNomor: isi.bg.trim(), giroJatuhTempo: isi.tempo } : {}),
            ...(buktiLama ? { buktiLama: true } : {}),
            ...(isi.catatan.trim() ? { catatan: isi.catatan.trim() } : {}),
            dasar: baris?.dasar ?? [],
        };
        let body: Record<string, unknown> | FormData = data;
        if (bukti && dikirim.transfer > 0) {
            body = new FormData();
            body.append("data", JSON.stringify(data));
            body.append("bukti", bukti);
        }
        const j = await kirimKasir("/api/kasir/setoran", body);
        const nama = namaTampil(terpilih);
        if (j.jenis === "ok") {
            const rev = Array.isArray(j.data.revisi) ? (j.data.revisi as { kode: string; revisi: number }[]).find((r) => r.kode === terpilih.orang) : undefined;
            return kabar.selesai(`Setoran ${nama} tersimpan${rev ? ` (revisi ${rev.revisi})` : ""}.`);
        }
        const dasarKirim = JSON.stringify([...(baris?.dasar ?? [])].map((d) => `${d.kode}:${d.revisi}`).sort());
        const sama = (s: { tunai: string; transfer: string; giro: string } | null | undefined) =>
            Boolean(s) && senDari(s!.tunai) === dikirim.tunai && senDari(s!.transfer) === dikirim.transfer && senDari(s!.giro) === dikirim.giro;
        if (j.jenis === "ragu") {
            return kabar.ragu(`setoran ${nama}`, (h) => {
                const b = h.orang.find((o) => o.orang === terpilih.orang);
                const sekarang = JSON.stringify((b?.dasar ?? []).map((d) => `${d.kode}:${d.revisi}`).sort());
                if (sekarang === dasarKirim) return `Belum tersimpan: revisi setoran ${nama} masih sama seperti sebelum dikirim. Catat lagi bila perlu.`;
                const utama = b?.setoranPerKode.find((x) => x.kode === terpilih.orang);
                return utama && sama(utama)
                    ? `Tersimpan: setoran ${nama} revisi ${utama.revisi} tercatat dengan nominal yang Anda kirim. Jangan catat lagi.`
                    : `Setoran ${nama} berubah ke revisi baru dengan nominal lain — periksa riwayat revisi sebelum mencatat lagi.`;
            });
        }
        if (j.kode === "SETORAN_BERUBAH") {
            const k = (j.data.keadaan ?? {}) as { setoran?: { tunai: string; transfer: string; giro: string } | null };
            if (sama(k.setoran)) return kabar.selesai(`Setoran ${nama} dengan nominal yang sama sudah tercatat (klik ganda); tidak dicatat dua kali.`);
            tolak(j, kabar, "Data dimuat ulang — periksa revisi terbaru sebelum menyimpan lagi.");
        }
        tolak(j, kabar);
    }

    const opsi = (
        <FormField label="Pegawai" required help={orangAwal === null ? "Pilih salesman; bisa juga pegawai tanpa pelunasan hari ini (setoran tanpa pelunasan)." : undefined}>
            {(a) => (
                <select {...a} className="fi-input" value={pilih} disabled={orangAwal !== null}
                    onChange={(e) => { setPilih(e.target.value); setIsi(isiDari(barisDari(e.target.value))); setBukti(null); }}>
                    <option value="">Pilih pegawai…</option>
                    {pilihan.map((p) => <option key={p.orang} value={p.orang}>{namaTampil(p)}</option>)}
                </select>
            )}
        </FormField>
    );
    const kolomUang = (k: "tunai" | "transfer" | "giro", label: string) => (
        <FormField label={label} error={galatNominal(k)} help="Rupiah, mis. 1.250.000; kosong = 0.">
            {(a) => <input {...a} className="fi-input fi-tnum" inputMode="decimal" value={isi[k]} placeholder="0" onChange={(e) => ubah(k)(e.target.value)} />}
        </FormField>
    );
    const selisihSen = pelSen === null ? null : total - pelSen;
    const klop = pelSen !== null && (total === pelSen || total === bulatAtas100(pelSen));

    return (
        <ConfirmDialog open onClose={kabar.tutup} tag={baris?.setoran ? "Koreksi setoran" : "Setoran"}
            title={terpilih ? `Catat setoran ${namaTampil(terpilih)}, ${tanggalPanjang(tanggal)}` : `Catat setoran, ${tanggalPanjang(tanggal)}`}
            description={dirty ? <span className="fi-draft">Draf belum disimpan</span> : undefined}
            confirmLabel="Simpan setoran" confirmDisabled={blok} alasanTerlihat onConfirm={simpan}
            facts={[
                ["Pelunasan Incaso", baris?.pelunasan == null ? (baris ? "belum terbaca" : "tidak ada (setoran tanpa pelunasan)") : `${rp(baris.pelunasan)}${baris.jumlahFaktur != null ? ` · ${baris.jumlahFaktur} faktur` : ""}`],
                ["Total setoran", rpSen(total)],
                ["Selisih", selisihSen === null ? "—" : <span key="s">{rpSen(selisihSen)} · {klop ? "Klop" : "Selisih — wajib dijelaskan sebelum Tutup"}</span>],
            ]}>
            {opsi}
            {baris?.setoran && (
                <MessageStrip tone="info" title="Koreksi = revisi baru; revisi lama tetap tercatat.">
                    {baris.setoranPerKode.map((x) => `${x.kode} revisi ${x.revisi}: Tunai ${rp(x.tunai)} · Transfer ${rp(x.transfer)} · Giro ${rp(x.giro)}`).join("; ")}
                    {t0?.noFormKasir ? ` · Form Kasir ${t0.noFormKasir}` : ""}
                    {baris.setoranPerKode.length > 1 ? ` Kode lain milik ${baris.orang} dicatat 0 (digabung ke ${baris.orang}).` : ""}
                </MessageStrip>
            )}
            <div className="fi-formgrid">
                {kolomUang("tunai", "Tunai")}
                {kolomUang("transfer", "Transfer")}
                {kolomUang("giro", "Giro")}
                <FormField label="Nomor Form Kasir" required={total > 0} help="Wajib bila setoran lebih dari 0.">
                    {(a) => <input {...a} className="fi-input" value={isi.form} onChange={(e) => ubah("form")(e.target.value)} />}
                </FormField>
            </div>
            {sen("transfer") > 0 && (
                <FormField label="Bukti transfer" required error={galatBukti}
                    help={buktiLama ? `Bukti revisi ${revLama?.revisi} dipakai lagi (transfer sama). Pilih berkas untuk menggantinya.` : "Foto JPG/PNG atau PDF, maksimal 5 MB."}>
                    {(a) => <input {...a} className="fi-input" type="file" accept="image/jpeg,image/png,application/pdf,.jpg,.jpeg,.jpe,.jfif,.png,.pdf"
                        onChange={(e) => setBukti(e.target.files?.[0] ?? null)} />}
                </FormField>
            )}
            {sen("giro") > 0 && (
                <div className="fi-formgrid">
                    <FormField label="Nomor BG" required>{(a) => <input {...a} className="fi-input" value={isi.bg} onChange={(e) => ubah("bg")(e.target.value)} />}</FormField>
                    <FormField label="Jatuh tempo Giro" required help={`Antara ${tglId(bawah)} dan ${tglId(atas)}.`}>
                        {(a) => <input {...a} className="fi-input" type="date" min={bawah} max={atas} value={isi.tempo} onChange={(e) => ubah("tempo")(e.target.value)} />}
                    </FormField>
                </div>
            )}
            <FormField label="Catatan" help="Opsional, maksimal 500 karakter.">
                {(a) => <textarea {...a} className="fi-input" value={isi.catatan} onChange={(e) => ubah("catatan")(e.target.value)} />}
            </FormField>
        </ConfirmDialog>
    );
}

// ── Jelaskan ─────────────────────────────────────────────────────────────────────────────────────────────

export type TargetJelaskan = { jenis: "selisih"; orang: string } | { jenis: "tak_teralokasi"; pelunasanId: number };

function Penjelasan({ nilai, ubah }: { nilai: string; ubah: (v: string) => void }) {
    const n = panjang(nilai);
    return (
        <FormField label="Penjelasan" required help={`Minimal 15, maksimal 1000 karakter (${n}).`}>
            {(a) => <textarea {...a} className="fi-input" value={nilai} onChange={(e) => ubah(e.target.value)} />}
        </FormField>
    );
}
const blokTeks = (t: string, label: string) => (panjang(t) < 15 ? `${label} minimal 15 karakter` : panjang(t) > 1000 ? `${label} maksimal 1000 karakter` : undefined);

export function DialogJelaskan({ hari, tanggal, kunci, kabar, target }: Umum & { target: TargetJelaskan }) {
    const [teks, setTeks] = useState("");
    const [tindak, setTindak] = useState<TindakLanjut | "">("");
    useUnsavedGuard(teks.trim() !== "" || tindak !== "");
    const b = target.jenis === "selisih" ? hari.orang.find((o) => o.orang === target.orang) : undefined;
    const e: Ember | undefined = target.jenis === "tak_teralokasi" ? hari.takTeralokasi?.find((x) => x.pelunasanId === target.pelunasanId) : undefined;
    const blok = kunci ?? (!b && !e ? "Baris ini tidak ada lagi di data terbaru" : blokTeks(teks, "Penjelasan")
        ?? (b && !tindak ? "Pilih tindak lanjut" : undefined));
    const sebelum = hari.riwayat.penjelasan.map((p) => p.id);

    async function simpan() {
        const body = b
            ? { tanggal, jenis: "selisih", orang: b.orang, angka: { pelunasan: b.pelunasan ?? "0", setoran: b.setoran?.total ?? "0" }, penjelasan: teks.trim(), tindakLanjut: tindak }
            : { tanggal, jenis: "tak_teralokasi", pelunasanId: e!.pelunasanId, angka: { sisa: e!.sisa }, penjelasan: teks.trim() };
        const j = await kirimKasir("/api/kasir/jelaskan", body);
        const apa = b ? `selisih ${namaTampil(b)}` : `uang tak teralokasi ${e!.nomor}`;
        if (j.jenis === "ok") return kabar.selesai(j.data.sudahAda ? `Penjelasan ${apa} yang sama sudah tercatat; tidak dicatat dua kali.` : `Penjelasan ${apa} tersimpan.`);
        if (j.jenis === "ragu") {
            return kabar.ragu(`penjelasan ${apa}`, (h) => h.riwayat.penjelasan.some((p) => !sebelum.includes(p.id) && p.penjelasan === teks.trim())
                ? `Tersimpan: penjelasan ${apa} tercatat. Jangan jelaskan lagi.`
                : `Belum tersimpan: belum ada penjelasan baru untuk ${apa}. Jelaskan lagi bila perlu.`);
        }
        if (j.kode === "TIDAK_PERLU_DIJELASKAN") return kabar.selesai(`${j.pesan} Data dimuat ulang.`);
        tolak(j, kabar, j.kode === "ANGKA_BERUBAH" ? "Angka sudah berubah sejak dimuat; data dimuat ulang — periksa lalu jelaskan lagi." : "");
    }

    const facts: Array<[string, ReactNode]> = b ? [
        ["Pelunasan Incaso", `${rp(b.pelunasan)}${b.jumlahFaktur != null ? ` · ${b.jumlahFaktur} faktur` : ""}`],
        ["Setoran Kasir", b.setoran ? rp(b.setoran.total) : "belum setor"],
        ["Selisih", `${rp(b.selisih)}${b.status ? ` · ${LABEL_STATUS[b.status].label}` : ""}`],
    ] : e ? [
        ["Pelunasan", e.nomor], ["Alasan", labelEmber(e)], ["Sisa", rp(e.sisa)],
        ["Orang", e.orang.length ? e.orang.map(namaTampil).join(", ") : "—"],
    ] : [];
    return (
        <ConfirmDialog open onClose={kabar.tutup} tag="Jelaskan"
            title={b ? `Jelaskan ${b.status === "belum_setor" ? "belum setor" : "selisih"} ${namaTampil(b)} · ${rp(b.selisih)}` : `Jelaskan uang tak teralokasi ${e?.nomor ?? ""}`}
            description="Penjelasan terikat ke angka saat ini; bila angka berubah sesudahnya, penjelasan tidak berlaku lagi."
            facts={facts} confirmLabel="Simpan penjelasan" confirmDisabled={blok} alasanTerlihat onConfirm={simpan}>
            <Penjelasan nilai={teks} ubah={setTeks} />
            {b && (
                <FormField label="Tindak lanjut" required>
                    {(a) => (
                        <select {...a} className="fi-input" value={tindak} onChange={(ev) => setTindak(ev.target.value as TindakLanjut | "")}>
                            <option value="">Pilih tindak lanjut…</option>
                            {(Object.keys(LABEL_TINDAK) as TindakLanjut[]).map((k) => <option key={k} value={k}>{LABEL_TINDAK[k]}</option>)}
                        </select>
                    )}
                </FormField>
            )}
        </ConfirmDialog>
    );
}

// ── Tutup hari ───────────────────────────────────────────────────────────────────────────────────────────

export function DialogTutup({ hari, tanggal, kunci, kabar, onBasi }: Umum & { onBasi: () => void }) {
    const klop = hari.orang.filter((o) => o.status === "klop").length;
    const dijelaskan = hari.orang.filter((o) => o.status !== "klop" && o.dijelaskan).length;
    const ember = (hari.takTeralokasi ?? []).length;
    const akhir = hari.hari.event.at(-1)?.id ?? 0;
    const blok = kunci ?? (!hari.sidik ? "Angka Incaso belum terbaca lengkap" : !hari.segarUntukTutup ? "Pelunasan perlu disegarkan dulu" : undefined);

    async function simpan() {
        const j = await kirimKasir("/api/kasir/tutup", { tanggal, sidik: hari.sidik });
        if (j.jenis === "ok") {
            return kabar.selesai(j.data.sudahDitutup ? `Hari ${tanggalPanjang(tanggal)} sudah ditutup sebelumnya; tidak dicatat dua kali.` : `Hari ${tanggalPanjang(tanggal)} ditutup.`);
        }
        if (j.jenis === "ragu") {
            return kabar.ragu(`tutup hari ${tanggalPanjang(tanggal)}`, (h) => {
                const e = h.hari.event.at(-1);
                return e && e.id > akhir && e.jenis === "tutup" ? `Tersimpan: hari ditutup ${jamWita(e.pada)} WITA oleh ${e.oleh}.` : "Belum tersimpan: hari belum ditutup. Tutup lagi bila perlu.";
            });
        }
        if (j.kode === "BACA_BELUM_SEGAR") return onBasi();
        tolak(j, kabar, j.alasan?.length ? `Masih terhalang: ${j.alasan.join(" ")}` : j.kode === "ANGKA_BERUBAH" ? "Data dimuat ulang — periksa angka lalu tutup lagi." : "");
    }

    return (
        <ConfirmDialog open onClose={kabar.tutup} tag="Tutup hari" title={`Tutup hari ${tanggalPanjang(tanggal)}?`}
            confirmLabel="Tutup hari" confirmDisabled={blok} alasanTerlihat onConfirm={simpan}
            facts={[
                ["Klop", `${klop} dari ${hari.orang.length} orang`],
                ["Selisih dijelaskan", `${dijelaskan} orang`],
                ["Uang tak teralokasi dijelaskan", `${ember}`],
                ["Pelunasan Incaso", rp(hari.total.pelunasan)],
                ["Setoran Kasir", rp(hari.total.setoran)],
                ["Pelunasan dibaca lengkap", hari.baca?.lengkapPada ? `pukul ${jamWita(hari.baca.lengkapPada)} WITA${hari.baca.akun ? ` · akun sinkron ${hari.baca.akun}` : ""}` : "—"],
                ["Sesudah ditutup", "Setoran dan penjelasan terkunci; membuka kembali hanya OM/Admin dengan alasan."],
            ]} />
    );
}

// ── Buka kembali ─────────────────────────────────────────────────────────────────────────────────────────

/** 20.00 WITA berikutnya sesudah `sekarang` (perkiraan untuk dialog; server menjawab `kunciBerikutnya`). */
function kunciBerikut(sekarang: Date) {
    const t = new Date(Date.UTC(sekarang.getUTCFullYear(), sekarang.getUTCMonth(), sekarang.getUTCDate(), 12));
    if (t.getTime() <= sekarang.getTime()) t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString();
}

export function DialogBuka({ hari, tanggal, kunci, kabar }: Umum) {
    const [teks, setTeks] = useState("");
    useUnsavedGuard(teks.trim() !== "");
    const [sampai] = useState(() => kunciBerikut(new Date()));
    const akhir = hari.hari.event.at(-1)?.id ?? 0;
    const blok = kunci ?? blokTeks(teks, "Alasan");

    async function simpan() {
        const j = await kirimKasir("/api/kasir/buka", { tanggal, alasan: teks.trim() });
        if (j.jenis === "ok") {
            return kabar.selesai(`Hari ${tanggalPanjang(tanggal)} dibuka kembali sampai ${waktuWita(String(j.data.kunciBerikutnya ?? sampai))} WITA.`);
        }
        if (j.jenis === "ragu") {
            return kabar.ragu(`buka kembali ${tanggalPanjang(tanggal)}`, (h) => {
                const e = h.hari.event.at(-1);
                return e && e.id > akhir && e.jenis === "buka" ? `Tersimpan: hari dibuka kembali oleh ${e.oleh}.` : "Belum tersimpan: hari masih terkunci. Buka lagi bila perlu.";
            });
        }
        if (j.kode === "TIDAK_TERKUNCI") return kabar.selesai(`${j.pesan} Data dimuat ulang.`);
        tolak(j, kabar);
    }

    return (
        <ConfirmDialog open onClose={kabar.tutup} tag="Buka kembali" title={`Buka kembali hari ${tanggalPanjang(tanggal)}?`}
            confirmLabel="Buka kembali" confirmDisabled={blok} alasanTerlihat onConfirm={simpan}
            facts={[
                ["Sekarang", hari.hari.sebab === "tutup" ? "Ditutup" : "Terkunci otomatis 20.00 WITA"],
                ["Sesudah dibuka", `Setoran dan penjelasan bisa diubah; terkunci lagi otomatis ${waktuWita(sampai)} WITA.`],
            ]}>
            <FormField label="Alasan membuka" required help={`Minimal 15, maksimal 1000 karakter (${panjang(teks)}); tersimpan bersama aksi ini.`}>
                {(a) => <textarea {...a} className="fi-input" value={teks} onChange={(e) => setTeks(e.target.value)} />}
            </FormField>
        </ConfirmDialog>
    );
}

// ── Konfirmasi hapus massal (cache pelunasan) ────────────────────────────────────────────────────────────

export function DialogHapus({ hari, tanggal, kunci, kabar, onKonfirmasi }: Umum & { onKonfirmasi: () => void }) {
    const daftar = hari.baca?.ditolak ?? [];
    return (
        <ConfirmDialog open onClose={kabar.tutup} tag="Baca-saja Accurate" tone="negative"
            title={`Hapus ${daftar.length} pelunasan dari cache ${tanggalPanjang(tanggal)}?`}
            description="Pembaca menahan penghapusan karena jumlahnya besar atau akun sinkron berganti. Konfirmasi hanya bila pelunasan ini memang sudah dihapus atau dipindah tanggal di Accurate. Accurate tidak diubah."
            confirmLabel={`Hapus ${daftar.length} dari cache`} confirmDisabled={kunci} alasanTerlihat
            facts={[["Akan dihapus", daftar.map((d) => d.nomor || `id ${d.id}`).join(", ") || "—"]]}
            onConfirm={() => { kabar.tutup(); onKonfirmasi(); }} />
    );
}
