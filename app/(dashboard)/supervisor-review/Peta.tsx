"use client";
/*
 * Tujuan: peta Supervisor Review (SR-3) — Leaflet + ubin OpenStreetMap, dipakai langsung tanpa pembungkus React. Penanda toko berkoordinat
 *   (cincin warna token per StatusToko + HURUF status di tengahnya, jadi status tidak hanya terbaca lewat warna) + titik check-in dari kunjungan
 *   ber-GPS; memilih satu salesman menyaring keduanya dan menggambar garis urutan check-in. Daftar teks "Lihat toko dan check-in sebagai daftar"
 *   memberi jalan bagi papan ketik dan pembaca layar (penanda peta sendiri tidak bisa difokus).
 * Caller: SR-2 supervisor-review layar (dynamic import ssr:false) lewat `PetaProps` — props TIDAK boleh berubah.
 * Dependensi: leaflet (JS dimuat di useEffect karena butuh window; CSS diimpor statis — aman, modul ini hanya dimuat tanpa SSR),
 *   components/fiori/core, lib/supervisor-review/kontrak, lib/tampil (KOSONG).
 * Main Functions: Peta (default), PetaProps.
 * Side Effects: Permintaan ubin https://tile.openstreetmap.org; map.remove() saat unmount / data berubah.
 */
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, MessageStrip } from "@/components/fiori/core";
import { JARAK_JAUH_M, type Kunjungan, type PenandaToko, type StatusToko } from "@/lib/supervisor-review/kontrak";
import { KOSONG } from "@/lib/tampil";

export interface PetaProps {
    penanda: PenandaToko[];
    kunjungan: Kunjungan[];
    /** null = semua salesman dalam cakupan; terisi = saring + gambar garis urutan check-in. */
    salesCodeTerpilih: string | null;
}

/**
 * Warna = token Fiori (var() dibaca browser, ikut mode gelap); huruf = isyarat kedua untuk pengguna buta warna. Kelas `peta-<status>` melekat
 * pada path SVG (dipakai uji dan gaya). Warna cincin: ec hijau, tanpa_ec jingga, belum merah, faktur_tanpa_checkin nila (bukan ungu dekoratif).
 */
const STATUS: Record<StatusToko, { warna: string; huruf: string; label: string }> = {
    ec: { warna: "var(--pos-solid)", huruf: "E", label: "Dikunjungi, EC" },
    tanpa_ec: { warna: "var(--warn-solid)", huruf: "T", label: "Dikunjungi, tanpa EC" },
    belum: { warna: "var(--neg-solid)", huruf: "B", label: "Terjadwal, belum dikunjungi" },
    faktur_tanpa_checkin: { warna: "var(--info-solid)", huruf: "F", label: "Berfaktur, tanpa check-in" },
};
/** Status di luar kontrak (data baru / rusak): tetap digambar abu-abu, tidak boleh membuat peta gagal. */
const LAIN = { warna: "var(--neu-solid)", huruf: "?", label: "Status tidak dikenal", kelas: "lain" };
const URUT: StatusToko[] = ["ec", "tanpa_ec", "belum", "faktur_tanpa_checkin"];
const TITIK_CHECKIN = "var(--primary)";

interface Gambar {
    pen: PenandaToko[];
    titik: Kunjungan[];
    garis: boolean;
}

/** Saring menurut salesman terpilih; titik = kunjungan ber-GPS, urut `mulai` (urutan garis). */
function saring(penanda: PenandaToko[], kunjungan: Kunjungan[], kode: string | null): Gambar {
    const titik = kunjungan
        .filter((k) => k.lat != null && k.lng != null && (kode === null || k.salesCode === kode))
        .sort((a, b) => Date.parse(a.mulai ?? "") - Date.parse(b.mulai ?? "") || 0);
    return { pen: kode === null ? penanda : penanda.filter((p) => p.salesCode === kode), titik, garis: kode !== null };
}

/** Isi popup sebagai node teks — nama toko berasal dari data, tidak pernah disisipkan sebagai HTML. */
function popup(judul: string, ...baris: string[]): HTMLElement {
    const el = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = judul;
    el.append(b, ...baris.map((t) => Object.assign(document.createElement("div"), { textContent: t })));
    return el;
}

const jam = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("id-ID", { timeZone: "Asia/Makassar", hour: "2-digit", minute: "2-digit" }) : KOSONG);
const infoStatus = (s: string) => (STATUS[s as StatusToko] ? { ...STATUS[s as StatusToko], kelas: s } : LAIN);

/** Huruf status di tengah cincin: tinta di atas isi permukaan (kontras terjaga di mode terang dan gelap); `huruf` konstanta di atas, bukan data pengguna. */
const cakram = (huruf: string, ukuran: number) =>
    `<span style="display:flex;align-items:center;justify-content:center;width:${ukuran}px;height:${ukuran}px;font:700 ${Math.round(ukuran * 0.55)}px/1 var(--font-sans);color:var(--ink)">${huruf}</span>`;

export default function Peta({ penanda, kunjungan, salesCodeTerpilih }: PetaProps) {
    // Kunci teks: induk yang mengirim array baru tiap render tidak membangun ulang peta (kedip + zoom hilang) selama isinya sama.
    const kunci = useMemo(() => JSON.stringify(saring(penanda, kunjungan, salesCodeTerpilih)), [penanda, kunjungan, salesCodeTerpilih]);
    const data = useMemo(() => JSON.parse(kunci) as Gambar, [kunci]);
    const ada = data.pen.length + data.titik.length > 0;
    const wadah = useRef<HTMLDivElement>(null);
    const [galat, setGalat] = useState(false);
    // Isi daftar teks baru dirender saat dibuka: ribuan toko tidak perlu masuk DOM selama peta saja yang dilihat.
    const [daftarBuka, setDaftarBuka] = useState(false);

    useEffect(() => {
        const el = wadah.current;
        if (!el) return; // tanpa titik: wadah tidak dirender (EmptyState)
        let batal = false;
        let bersih = () => {};
        setGalat(false);
        import("leaflet").then((L) => {
            if (batal) return;
            const peta = L.map(el);
            try {
                L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
                    maxZoom: 19,
                    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
                }).addTo(peta);

                // circleMarker (vektor): ikon gambar bawaan Leaflet pecah di bundler. Huruf status = divIcon non-interaktif di atasnya
                // (klik tetap sampai ke circleMarker di bawahnya yang membuka popup).
                for (const p of data.pen) {
                    const st = infoStatus(p.status);
                    L.circleMarker([p.lat, p.lng], { radius: 10, color: st.warna, weight: 4, fillColor: "var(--surface)", fillOpacity: 1, className: `peta-${st.kelas}` })
                        .bindPopup(popup(p.namaToko, `${st.huruf}: ${st.label}`, p.salesCode)).addTo(peta);
                    const huruf = L.marker([p.lat, p.lng], {
                        icon: L.divIcon({ className: "peta-huruf", html: cakram(st.huruf, 20), iconSize: [20, 20], iconAnchor: [10, 10] }),
                        interactive: false, keyboard: false,
                    }).addTo(peta);
                    huruf.getElement()?.setAttribute("aria-hidden", "true");
                }
                for (const k of data.titik) {
                    const jauh = k.jarakKeTokoM != null && k.jarakKeTokoM > JARAK_JAUH_M;
                    L.circleMarker([k.lat!, k.lng!], { radius: 5, color: TITIK_CHECKIN, weight: 2.5, fillColor: "var(--surface)", fillOpacity: 1, className: "peta-checkin" })
                        .bindPopup(popup(k.namaToko, `Check-in ${jam(k.mulai)}`, ...(jauh ? [`Jauh dari toko (${Math.round(k.jarakKeTokoM!)} m)`] : []))).addTo(peta);
                }
                if (data.garis && data.titik.length > 1) {
                    L.polyline(data.titik.map((k) => [k.lat!, k.lng!] as [number, number]), { color: TITIK_CHECKIN, weight: 3, opacity: 0.7, dashArray: "6 6", className: "peta-garis" }).addTo(peta);
                }

                const semua = [...data.pen, ...data.titik].map((t) => [t.lat!, t.lng!] as [number, number]);
                peta.setView(semua[0], 13); // pandangan awal: wadah tersembunyi tak boleh membiarkan peta tanpa pusat
                const pas = () => { if (el.clientWidth && el.clientHeight) peta.fitBounds(L.latLngBounds(semua), { padding: [24, 24], maxZoom: 17 }); };
                pas();
                // Wadah tersembunyi saat dibuat (tab Peta di ponsel): ukurannya baru ada belakangan → hitung ulang ukuran lalu pas sekali.
                let perluPas = !el.clientWidth || !el.clientHeight;
                const ro = new ResizeObserver(() => {
                    peta.invalidateSize();
                    if (perluPas && el.clientWidth && el.clientHeight) { perluPas = false; pas(); }
                });
                ro.observe(el);
                bersih = () => { ro.disconnect(); peta.remove(); };
            } catch { peta.remove(); setGalat(true); } // data aneh tidak boleh meninggalkan peta setengah jadi tanpa kabar
        }).catch(() => { if (!batal) setGalat(true); });
        return () => { batal = true; bersih(); };
    }, [data]);

    if (!ada) return <EmptyState title="Belum ada toko berkoordinat / check-in ber-GPS" message="Toko tampil di peta setelah koordinatnya diunggah (Form Kontrol › Koordinat Toko); check-in tampil bila salesman mengizinkan GPS." />;

    const jumlah = (s: StatusToko) => data.pen.filter((p) => p.status === s).length;
    return (
        <div className="grid gap-2 min-w-0">
            {galat && <MessageStrip tone="neg" title="Peta gagal dimuat.">Muat ulang halaman; tabel dan rincian tetap bisa dipakai.</MessageStrip>}
            {/* isolate: z-index panel Leaflet (hingga 1000) tidak boleh menimpa dialog / kepala tetap Fiori. */}
            <div ref={wadah} role="region" aria-label="Peta toko dan titik check-in" className="isolate relative z-0 w-full h-[300px] sm:h-[360px] rounded border border-[var(--line)]" />
            <ul aria-label="Legenda peta" className="flex flex-wrap gap-x-4 gap-y-1 fi-small" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {URUT.map((s) => (
                    <li key={s} className="flex items-center gap-1">
                        <span aria-hidden className="inline-flex h-5 w-5 items-center justify-center rounded-full" style={{ border: `3px solid ${STATUS[s].warna}`, background: "var(--surface)", font: "700 .6875rem/1 var(--font-sans)", color: "var(--ink)" }}>{STATUS[s].huruf}</span>
                        {STATUS[s].label} <b className="fi-tnum">{jumlah(s)}</b>
                    </li>
                ))}
                <li className="flex items-center gap-1">
                    <span aria-hidden className="inline-block w-3 h-3 rounded-full" style={{ background: "var(--surface)", border: `2.5px solid ${TITIK_CHECKIN}` }} />
                    Titik check-in <b className="fi-tnum">{data.titik.length}</b>
                </li>
                {data.garis && <li>Garis putus-putus: urutan check-in salesman terpilih</li>}
            </ul>
            <details onToggle={(e) => setDaftarBuka(e.currentTarget.open)}>
                <summary className="fi-small" style={{ cursor: "pointer", minHeight: "var(--ctl-h)", display: "flex", alignItems: "center" }}>
                    Lihat toko dan check-in sebagai daftar ({data.pen.length + data.titik.length})
                </summary>
                {daftarBuka && (
                    <div role="region" aria-label="Daftar toko dan check-in" tabIndex={0} className="fi-small" style={{ maxHeight: "16rem", overflow: "auto" }}>
                        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                            {data.pen.map((p) => {
                                const st = infoStatus(p.status);
                                return <li key={`t-${p.custCode}-${p.salesCode}`} style={{ padding: "4px 0" }}><b>{p.namaToko}</b> · {st.huruf}: {st.label} · {p.salesCode}</li>;
                            })}
                            {data.titik.map((k, i) => (
                                <li key={`c-${k.custCode}-${k.mulai ?? i}`} style={{ padding: "4px 0" }}>
                                    Check-in <b>{k.namaToko}</b> · {jam(k.mulai)} WITA{k.jarakKeTokoM != null ? ` · ${Math.round(k.jarakKeTokoM)} m dari toko${k.jarakKeTokoM > JARAK_JAUH_M ? " (jauh)" : ""}` : ""}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </details>
        </div>
    );
}
