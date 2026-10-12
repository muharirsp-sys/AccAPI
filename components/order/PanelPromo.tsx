/*
 * Tujuan: Tampilan program promo hasil pratinjau Order (O2): per baris (diskon, persen berantai, bonus, netto) dan ringkasan per order
 *   (bruto, diskon promo, netto, program yang berlaku, bonus berkode barang, program yang tidak berlaku untuk outlet ini + sebabnya).
 *   Memakai bentuk respons pratinjau yang ADA SEKARANG (result.lines/applications/bonuses/blocked); dipisah dari layar supaya mudah disesuaikan
 *   bila bentuk respons promo O1 berubah.
 * Caller: app/(dashboard)/sales/OrderSales.tsx, app/(dashboard)/orders/OrderBaru.tsx.
 * Dependensi: ./order-cabang (promoBaris, ringkasPromo), lib/promo-ui (rupiah, persen), components/fiori/core.
 * Main Functions: PromoBarisInfo, PanelPromo.
 * Side Effects: Tidak ada.
 */
import type { ReactNode } from "react";
import { KeyValues, StatusBadge } from "@/components/fiori/core";
import { persen, rupiah } from "@/lib/promo-ui";
import { promoBaris, ringkasPromo, type Result, type Suggestion } from "./order-cabang";

/** Promo satu baris: tampil hanya bila server menghitung baris itu (hasil ada). Tanpa diskon dinyatakan "Tanpa diskon promo", bukan dikosongkan. */
export function PromoBarisInfo({ result, code, unit, nomor }: { result: Result | null | undefined; code: string; unit: string; nomor: number }) {
    const p = promoBaris(result, code, unit);
    if (!p) return null;
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
            {p.bonus.map((b, i) => <StatusBadge key={i} tone="info">Bonus {b.quantity} {b.unit}</StatusBadge>)}
            <span className="fi-tnum fi-muted">netto {rupiah(p.net)}</span>
        </div>
    );
}

type PanelProps = {
    result: Result | null | undefined;
    suggestions?: Suggestion[];
    /** Jumlah barang tanpa harga (tidak ikut dihitung). */
    nTanpaHarga?: number;
    /** Tambahkan baris PPN 11% + total faktur (petugas internal). */
    ppn?: boolean;
    /** Catatan kaki. */
    catatan?: ReactNode;
};

const PPN = 0.11;

/** Ringkasan per order. `aria-label="Perkiraan nilai order"` dipakai uji dan pembaca layar. */
export function PanelPromo({ result, suggestions = [], nTanpaHarga = 0, ppn, catatan }: PanelProps) {
    const r = ringkasPromo(result, suggestions);
    if (!r) return null;
    return (
        <div className="fi-panel" role="group" aria-label="Perkiraan nilai order">
            <KeyValues items={[
                [nTanpaHarga ? "Bruto (yang sudah ada harganya)" : "Bruto", rupiah(r.gross)],
                ["Diskon promo", rupiah(r.diskon)],
                ["Netto estimasi", rupiah(r.net)],
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
            {nTanpaHarga > 0 && <p className="fi-small fi-why">{nTanpaHarga} barang belum berharga tidak ikut dihitung.</p>}
            {catatan && <p className="fi-small fi-subtle">{catatan}</p>}
        </div>
    );
}
