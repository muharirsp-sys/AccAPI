export const offPrinciples = [
    { name: "RECKITT BENCKISER, PT", code: "RB" },
    { name: "FKS FOOD SEJAHTERA, PT", code: "FKS" },
    { name: "FONTERRA BRANDS INDONESIA, PT", code: "FON" },
    { name: "GUMINDO BOGAMANIS, PT", code: "REBO" },
    { name: "MARKETAMA INDAH, PT", code: "MI" },
    { name: "PRIMARASA ABADI SEJAHTERA, PT", code: "PAS" },
    { name: "SUN PAPER SOURCE, PT", code: "SPS" },
    { name: "GODREJ DISTRIBUSI INDONESIA, PT", code: "GDI" },
    { name: "DOLPHIN, PT", code: "DOLPHIN" },
    { name: "UNIVERSAL INDOFOOD PRODUCT, PT", code: "UNIBIS" },
    { name: "URC INDONESIA, PT", code: "URC" },
    { name: "HEINZ ABC INDONESIA, PT", code: "HEINZ" },
    { name: "ENERGIZER INDONESIA, PT", code: "ENI" },
    { name: "GONDOWANGI TRADISIONAL KOSMETIK, PT", code: "NATUR" },
    { name: "MUSTIKA RATUBUANA INTERNATIONAL", code: "MR" },
    { name: "PRISKILA PRIMA MAKMUR, PT", code: "PRISKILA" },
    { name: "UNITAMA SARI MAS, PT", code: "USM" },
    { name: "VINDA INTERNATIONAL INDONESIA, PT", code: "VINDA" },
    { name: "KINO INDONESIA. TBK, PT", code: "KINO" },
    { name: "ABC PRESIDENT INDONESIA, PT", code: "ABC" },
    { name: "PZ CUSSONS INDONESIA, PT", code: "CUSSONS" },
    { name: "FOKUS RITEL NUSAPRIMA, PT", code: "SHINZUI" },
    { name: "FORISA NUSAPERSADA, PT", code: "FRS" },
    { name: "MOTASA INDONESIA, PT", code: "MOTASA" },
    { name: "PURATOS, PT", code: "PURATOS" },
];

export const offPaymentMethods = ["Transfer", "Tunai"] as const;

export const offStatuses = {
    draft: "Draft",
    submittedToSm: "Submitted to SM",
    returnedBySm: "Returned by SM",
    approvedBySm: "Approved by SM",
    claimApproved: "Claim Approved",
    omApproved: "OM Approved",
    partialPaid: "Partial Paid",
    paid: "Paid",
    returnedToFinance: "Returned to Finance",
    completed: "Completed",
} as const;

export const offFinanceStatuses = {
    waitingPayment: "Waiting Payment",
    partialPaid: "Partial Paid",
    paid: "Paid",
    needCorrection: "Need Correction",
} as const;

// --- Kwitansi (HOLD sementara) ---
// NOTE: Kwitansi dinonaktifkan sementara karena format/nilai kwitansi dapat
// berubah setelah pembayaran dari Keuangan (nominal bayar, PPh, no claim,
// tanggal bayar, toko, no surat, metode bayar).
// Tombol tetap tampil di UI namun disabled. Endpoint generate ditahan agar
// tidak menghasilkan kwitansi aktif. Kode lama tidak dihapus.
export const OFF_KWITANSI_DISABLED = true;
export const OFF_KWITANSI_DISABLED_MESSAGE = "Kwitansi Sementara Nonaktif";
