/*
 * Tujuan: Tampilan program promo hasil pratinjau Order (O2): kartu "hampir dapat" di baris (nama program, kemajuan, kalimat server, tombol Tambah
 *   hanya untuk program jumlah satu barang), penanda "program terpakai", per baris (diskon, persen berantai, bonus, netto) dan ringkasan per order
 *   (bruto, diskon promo, netto, program yang berlaku, bonus berkode barang, program yang tidak berlaku untuk outlet ini + sebabnya).
 *   Memakai bentuk respons pratinjau yang ADA SEKARANG (result.lines/applications/bonuses/blocked); dipisah dari layar supaya mudah disesuaikan
 *   bila bentuk respons promo O1 berubah.
 * Caller: app/(dashboard)/sales/OrderSales.tsx, app/(dashboard)/orders/OrderBaru.tsx.
 * Dependensi: ./order-cabang (promoBaris, ringkasPromo), lib/promo-ui (rupiah, persen), components/fiori/core.
 * Main Functions: PromoBarisInfo, KartuPromoBaris, PanelPromo.
 * Side Effects: Tidak ada.
 */
import type { ReactNode } from "react";
import { Lightbulb, Plus } from "lucide-react";
import { Button, KeyValues, StatusBadge } from "@/components/fiori/core";
import { persen, rupiah } from "@/lib/promo-ui";
import { bacaSaran, namaProgramTerpakai, promoBaris, ringkasPromo, type KartuSaran, type Result, type Suggestion } from "./order-cabang";

/** Promo satu baris: tampil hanya bila server menghitung baris itu (hasil ada). Tanpa diskon dinyatakan "Tanpa diskon promo", bukan dikosongkan. */
export function PromoBarisInfo({ result, code, unit, nomor, saran = [] }: { result: Result | null | undefined; code: string; unit: string; nomor: number; saran?: Suggestion[] }) {
    const p = promoBaris(result, code, unit);
    if (!p) return null;
    // Penanda "program terpakai": nama hanya bila tepat satu program berlaku di order ini (hasil server tidak menyebut program per baris).
    const terpakai = namaProgramTerpakai(result, saran);
    return (
        <div className="flex flex-wrap items-center gap-2 fi-small" role="group" aria-label={`Promo barang ${nomor}`}>
            {p.diskon > 0
                ? <><StatusBadge tone="pos">Diskon promo {rupiah(p.diskon)}</StatusBadge>
                    {(p.persen.length > 0 || p.tunai > 0) && (
                        <span className="fi-muted fi-tnum">
                            {[p.persen.length ? p.persen.map(persen).join(" + ") : null, p.tunai > 0 ? `potongan ${rupiah(p.tunai)}` : null].filter(Boolean).join(" + ")}
                        </span>
                    )}</>
                : <StatusBadge tone="neu">Tanpa diskon promo</StatusBadge>}
            {(p.diskon > 0 || p.bonus.length > 0) && terpakai.length > 0 && <StatusBadge tone="pos">{terpakai.length === 1 ? `Program ${terpakai[0]} terpakai` : "Program promo terpakai"}</StatusBadge>}
            {p.bonus.map((b, i) => <StatusBadge key={i} tone="info">Bonus {b.quantity} {b.unit}</StatusBadge>)}
            <span className="fi-tnum fi-muted">netto {rupiah(p.net)}</span>
        </div>
    );
}

const angka = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 2 });

function KartuSaranIsi({ k, saran, namaBarang, onTambah }: { k: KartuSaran; saran: Suggestion; namaBarang: (code: string) => string; onTambah?: (n: number) => void }) {
    const teks = k.tipe === "nilai" ? `${rupiah(k.sekarang)} / ${rupiah(k.target)}` : `${angka(k.sekarang)} / ${angka(k.target)}${k.unit ? ` ${k.unit}` : ""}`;
    return (
        <div style={{ border: "1px solid var(--line)", borderLeft: "3px solid var(--warn)", borderRadius: "var(--r-md)", padding: "var(--sp-3)", display: "grid", gap: 6, background: "var(--surface)", minWidth: 0 }}>
            <p className="fi-small" style={{ display: "flex", gap: 6, alignItems: "center", margin: 0 }}><Lightbulb className="fi-icon" aria-hidden /><b style={{ overflowWrap: "anywhere" }}>{k.nama}</b></p>
            <div role="progressbar" aria-label={`Kemajuan ${k.nama}`} aria-valuemin={0} aria-valuemax={k.target} aria-valuenow={Math.min(k.sekarang, k.target)} aria-valuetext={teks}
                style={{ height: 6, borderRadius: "var(--r-pill)", background: "var(--surface-3)", overflow: "hidden" }}>
                <i style={{ display: "block", height: "100%", width: `${k.persen}%`, background: "var(--brand)" }} />
            </div>
            <p className="fi-small fi-tnum fi-muted" style={{ margin: 0 }}>{teks}</p>
            <p style={{ margin: 0, overflowWrap: "anywhere" }}>{saran.message}</p>
            {k.campur && <p className="fi-small fi-muted" style={{ margin: 0 }}>Dihitung dari: {k.codes.map(namaBarang).join(", ")}</p>}
            {k.tambah !== null && onTambah && (
                <div><Button variant="secondary" icon={<Plus className="fi-icon" aria-hidden />} onClick={() => onTambah(k.tambah!)}>Tambah {k.tambah} {k.unit}</Button></div>
            )}
        </div>
    );
}

/**
 * Kartu ajakan "hampir dapat" untuk satu baris: SEMUA saran baris itu (urut gap terkecil), bukan hanya yang pertama. Tombol "Tambah N UNIT" hanya
 * mengubah jumlah baris itu (pratinjau dihitung ulang, sidik lama batal); tidak menyimpan apa pun dan tidak menjanjikan angka sendiri.
 */
export function KartuPromoBaris({ nomor, kodeBaris, unitBaris, saran, namaBarang, onTambah }: {
    nomor: number; kodeBaris: string; unitBaris: string; saran: Suggestion[]; namaBarang: (code: string) => string; onTambah: (n: number) => void;
}) {
    const kartu = saran.flatMap((s) => { const k = bacaSaran(s, kodeBaris, unitBaris); return k ? [{ k, s }] : []; });
    if (kartu.length === 0) return null;
    return (
        <div role="group" aria-label={`Promo hampir tercapai barang ${nomor}`} aria-live="polite" style={{ display: "grid", gap: 8, minWidth: 0 }}>
            {kartu.map(({ k, s }) => <KartuSaranIsi key={k.id} k={k} saran={s} namaBarang={namaBarang} onTambah={onTambah} />)}
        </div>
    );
}

type PanelProps = {
    result: Result | null | undefined;
    suggestions?: Suggestion[];
    /** Jumlah barang tanpa harga (tidak ikut dihitung). */
    nTanpaHarga?: number;
    /** Tambahkan baris PPN 11% + total faktur (petugas internal). Tanpa ini angka tetap berlabel "sebelum PPN": PPN ditambahkan saat faktur. */
    ppn?: boolean;
    /** Catatan kaki. */
    catatan?: ReactNode;
    /** Saran tingkat order (program nilai / tak ada baris yang cocok): kartu tanpa tombol di ringkasan. */
    saranRingkasan?: Suggestion[];
    namaBarang?: (code: string) => string;
};

const PPN = 0.11;

/** Ringkasan per order. `aria-label="Perkiraan nilai order"` dipakai uji dan pembaca layar. */
export function PanelPromo({ result, suggestions = [], nTanpaHarga = 0, ppn, catatan, saranRingkasan = [], namaBarang = (code) => code }: PanelProps) {
    const r = ringkasPromo(result, suggestions);
    if (!r) return null;
    return (
        <div className="fi-panel" role="group" aria-label="Perkiraan nilai order">
            <KeyValues items={[
                [nTanpaHarga ? "Bruto (yang sudah ada harganya)" : "Bruto", rupiah(r.gross)],
                ["Diskon promo", rupiah(r.diskon)],
                ["Netto estimasi (sebelum PPN)", rupiah(r.net)],
                ...(ppn ? [["PPN 11%", rupiah(Math.round(r.net * PPN))], ["Total faktur (estimasi)", rupiah(Math.round(r.net * (1 + PPN)))]] as Array<[string, string]> : []),
            ]} />
            {r.program.length > 0 && (
                <div>
                    <p className="fi-small"><b>Program promo yang berlaku</b></p>
                    <ul className="fi-small fi-muted" aria-label="Program promo yang berlaku" style={{ margin: 0, paddingLeft: "1.1rem" }}>
                        {r.program.map((p) => <li key={p.id}>{p.nama} — potongan {rupiah(p.diskon)}</li>)}
                    </ul>
                </div>
            )}
            {saranRingkasan.length > 0 && (
                <div role="group" aria-label="Promo hampir tercapai (seluruh order)" aria-live="polite" style={{ display: "grid", gap: 8, minWidth: 0 }}>
                    <p className="fi-small" style={{ margin: 0 }}><b>Hampir dapat promo</b></p>
                    {saranRingkasan.flatMap((s) => { const k = bacaSaran(s, "", ""); return k ? [<KartuSaranIsi key={k.id} k={k} saran={s} namaBarang={namaBarang} />] : []; })}
                </div>
            )}
            {r.bonusLain.length > 0 && (
                <ul className="fi-small fi-muted" aria-label="Bonus barang" style={{ margin: 0, paddingLeft: "1.1rem" }}>
                    {r.bonusLain.map((b, i) => <li key={i}>Bonus {b.jumlah} {b.unit} {b.kode} — {b.nama}</li>)}
                </ul>
            )}
            {r.tidakBerlaku.length > 0 && (
                <ul className="fi-small fi-subtle" aria-label="Program yang tidak berlaku" style={{ margin: 0, paddingLeft: "1.1rem" }}>
                    {r.tidakBerlaku.map((b, i) => <li key={i}>Tidak berlaku untuk outlet ini: {b.nama} ({b.alasan})</li>)}
                </ul>
            )}
            {!ppn && <p className="fi-small fi-subtle">Angka di atas sebelum PPN; PPN 11% ditambahkan saat faktur.</p>}
            {nTanpaHarga > 0 && <p className="fi-small fi-why">{nTanpaHarga} barang belum berharga tidak ikut dihitung.</p>}
            {catatan && <p className="fi-small fi-subtle">{catatan}</p>}
        </div>
    );
}
