export type AoStatus = "ordered" | "active" | "not_order" | "not_visited" | "priority";
export type MingguPattern = "ganjil" | "genap" | "all";
export type BriefingSession = "pagi" | "sore";

export interface JksMasterRow {
    id: string;
    salesCode: string;
    salesName: string;
    custCode: string;
    custName: string;
    market: string | null;
    alamat: string | null;
    kota: string | null;
    hariKunjungan: string | null;
    mingguPattern: MingguPattern;
    area: string | null;
    rayon: string | null;
    principle: string;
    channel: string;
    visitFrequency: number;
    isActive: boolean;
}

export interface AoControlRow {
    id: string;
    salesCode: string;
    custCode: string;
    principle: string;
    date: string;
    status: AoStatus;
    noOrderReasonCode: string | null;
    noOrderNote: string | null;
    isVisited: boolean | null;
    autoMatched: boolean;
    checkinAt: Date | null;
    checkinPhotoUrl: string | null;
    checkoutAt: Date | null;
    checkoutPhotoUrl: string | null;
}

export interface NoOrderReasonRow {
    id: string;
    reasonCode: string;
    label: string;
    category: string;
    sortOrder: number;
    isActive: boolean;
}

export interface MerchandisingRow {
    id: string;
    salesCode: string;
    custCode: string;
    principle: string;
    date: string;
    produkJelas: boolean;
    displayRapi: boolean;
    dibersihkan: boolean;
    ditataulang: boolean;
    posisiMudah: boolean;
    semuaSku: boolean;
    photoUrl: string | null;
    stepPhotos: Record<string, string> | null;
    note: string | null;
}

export interface TodayRouteRow extends JksMasterRow {
    aoStatus: AoStatus | null;
    noOrderReasonCode: string | null;
    noOrderNote: string | null;
    isVisited: boolean | null;
    checkinAt: Date | null;
    checkinPhotoUrl: string | null;
    checkoutAt: Date | null;
    checkoutPhotoUrl: string | null;
    monthlyOrderCount: number;
    needsAttention: boolean;
}

export interface VisitDetail {
    store: JksMasterRow;
    ao: AoControlRow | null;
    merch: MerchandisingRow | null;
}

export interface SpvSalesmanSummary {
    salesCode: string;
    salesName: string;
    totalRoute: number;
    ordered: number;
    notOrder: number;
    notVisited: number;
    checkedIn: number;
    checkedOut: number;
    submittedAt: Date | null;
    tindakLanjut: string | null;
}
