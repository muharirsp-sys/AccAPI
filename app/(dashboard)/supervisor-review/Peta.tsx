"use client";
/*
 * Tujuan: peta Supervisor Review (SR-3) — Leaflet + ubin OpenStreetMap, dipakai langsung tanpa pembungkus React. Penanda toko berkoordinat
 *   (warna per StatusToko) + titik check-in dari kunjungan ber-GPS; memilih satu salesman menyaring keduanya dan menggambar garis urutan check-in.
 * Caller: SR-2 supervisor-review layar (dynamic import ssr:false) lewat `PetaProps` — props TIDAK boleh berubah.
 * Dependensi: leaflet (JS dimuat di useEffect karena butuh window; CSS diimpor statis — aman, modul ini hanya dimuat tanpa SSR),
 *   components/fiori/core, lib/supervisor-review/kontrak.
 * Main Functions: Peta (default), PetaProps.
 * Side Effects: Permintaan ubin https://tile.openstreetmap.org; map.remove() saat unmount / data berubah.
 * ponytail: penanda (SVG path) tidak bisa difokus papan ketik — teks alternatifnya legenda berhitung di bawah peta + daftar kunjungan SR-2.
 */
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, MessageStrip } from "@/components/fiori/core";
import { JARAK_JAUH_M, type Kunjungan, type PenandaToko, type StatusToko } from "@/lib/supervisor-review/kontrak";

export interface PetaProps {
    penanda: PenandaToko[];
    kunjungan: Kunjungan[];
    /** null = semua salesman dalam cakupan; terisi = saring + gambar garis urutan check-in. */
    salesCodeTerpilih: string | null;
}

/** Warna + teks legenda; kelas `peta-<status>` melekat pada path SVG (dipakai uji dan gaya). */
const STATUS: Record<StatusToko, { warna: string; label: string }> = {
    ec: { warna: "#2e7d32", label: "Dikunjungi, EC" },
    tanpa_ec: { warna: "#f9a825", label: "Dikunjungi, tanpa EC" },
    belum: { warna: "#c62828", label: "Terjadwal, belum dikunjungi" },
    faktur_tanpa_checkin: { warna: "#6a1b9a", label: "Berfaktur, tanpa check-in" },
};
/** Status di luar kontrak (data baru / rusak): tetap digambar abu-abu, tidak boleh membuat peta gagal. */
const LAIN = { warna: "#9e9e9e", label: "Status tidak dikenal", kelas: "lain" };
const URUT: StatusToko[] = ["ec", "tanpa_ec", "belum", "faktur_tanpa_checkin"];
const BIRU = "#1565c0";

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

const jam = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("id-ID", { timeZone: "Asia/Makassar", hour: "2-digit", minute: "2-digit" }) : "—");

export default function Peta({ penanda, kunjungan, salesCodeTerpilih }: PetaProps) {
    // Kunci teks: induk yang mengirim array baru tiap render tidak membangun ulang peta (kedip + zoom hilang) selama isinya sama.
    const kunci = useMemo(() => JSON.stringify(saring(penanda, kunjungan, salesCodeTerpilih)), [penanda, kunjungan, salesCodeTerpilih]);
    const data = useMemo(() => JSON.parse(kunci) as Gambar, [kunci]);
    const ada = data.pen.length + data.titik.length > 0;
    const wadah = useRef<HTMLDivElement>(null);
    const [galat, setGalat] = useState(false);

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

                // circleMarker (vektor): ikon gambar bawaan Leaflet pecah di bundler.
                for (const p of data.pen) {
                    const st = STATUS[p.status] ? { ...STATUS[p.status], kelas: p.status } : LAIN;
                    L.circleMarker([p.lat, p.lng], { radius: 9, color: "#1f2937", weight: 1.5, fillColor: st.warna, fillOpacity: 0.9, className: `peta-${st.kelas}` })
                        .bindPopup(popup(p.namaToko, st.label, p.salesCode)).addTo(peta);
                }
                for (const k of data.titik) {
                    const jauh = k.jarakKeTokoM != null && k.jarakKeTokoM > JARAK_JAUH_M;
                    L.circleMarker([k.lat!, k.lng!], { radius: 5, color: BIRU, weight: 2.5, fillColor: "#ffffff", fillOpacity: 1, className: "peta-checkin" })
                        .bindPopup(popup(k.namaToko, `Check-in ${jam(k.mulai)}`, ...(jauh ? [`Jauh dari toko (${Math.round(k.jarakKeTokoM!)} m)`] : []))).addTo(peta);
                }
                if (data.garis && data.titik.length > 1) {
                    L.polyline(data.titik.map((k) => [k.lat!, k.lng!] as [number, number]), { color: BIRU, weight: 3, opacity: 0.7, dashArray: "6 6", className: "peta-garis" }).addTo(peta);
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
                        <span aria-hidden className="inline-block w-3 h-3 rounded-full" style={{ background: STATUS[s].warna, border: "1.5px solid #1f2937" }} />
                        {STATUS[s].label} <b className="fi-tnum">{jumlah(s)}</b>
                    </li>
                ))}
                <li className="flex items-center gap-1">
                    <span aria-hidden className="inline-block w-3 h-3 rounded-full" style={{ background: "#fff", border: `2.5px solid ${BIRU}` }} />
                    Titik check-in <b className="fi-tnum">{data.titik.length}</b>
                </li>
                {data.garis && <li>Garis putus-putus: urutan check-in salesman terpilih</li>}
            </ul>
        </div>
    );
}
