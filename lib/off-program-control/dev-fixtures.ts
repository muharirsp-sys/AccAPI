/*
 * Tujuan: Membuat dataset OFF deterministik berukuran besar untuk uji density dan performa UI lokal.
 * Caller: `OffProgramControlPage` ketika query `mock` aktif pada mode development.
 * Dependensi: Tidak ada; generator murni dan deterministik.
 * Main Functions: `getOffDevBatchCount`, `createOffDevBatches`, `isOffDevBatchId`.
 * Side Effects: Tidak ada DB/HTTP/file I/O; hanya mengalokasikan array fixture di memori browser.
 */

const DEV_BATCH_PREFIX = "dev-off-batch-";
const MAX_DEV_BATCHES = 2_000;

const PRINCIPLES = [
  ["RB", "RECKITT BENCKISER, PT"],
  ["GDI", "GODREJ DISTRIBUSI INDONESIA, PT"],
  ["HEINZ", "HEINZ ABC INDONESIA, PT"],
  ["KINO", "KINO INDONESIA. TBK, PT"],
  ["FON", "FONTERRA BRANDS INDONESIA, PT"],
] as const;

const SCENARIOS = [
  { status: "Draft", smStatus: "Not Started", claimStatus: "Not Started", omStatus: "Not Started", financeStatus: "Not Started", finalStatus: "Not Started", locked: false },
  { status: "Submitted to SM", smStatus: "Waiting Review", claimStatus: "Not Started", omStatus: "Not Started", financeStatus: "Not Started", finalStatus: "Not Started", locked: false },
  { status: "Approved by SM", smStatus: "Approved by SM", claimStatus: "Not Started", omStatus: "Not Started", financeStatus: "Not Started", finalStatus: "Not Started", locked: true },
  { status: "Claim Approved", smStatus: "Approved by SM", claimStatus: "Approved", omStatus: "Waiting Approval", financeStatus: "Not Started", finalStatus: "Not Started", locked: true },
  { status: "OM Approved", smStatus: "Approved by SM", claimStatus: "Approved", omStatus: "Approved", financeStatus: "Waiting Payment", finalStatus: "Not Started", locked: true },
  { status: "Paid", smStatus: "Approved by SM", claimStatus: "Approved", omStatus: "Approved", financeStatus: "Paid", finalStatus: "Waiting Claim Final Verification", locked: true },
  { status: "Completed", smStatus: "Approved by SM", claimStatus: "Approved", omStatus: "Approved", financeStatus: "Paid", finalStatus: "Completed", locked: true },
] as const;

export function getOffDevBatchCount(rawCount: string | null, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== "development" || !rawCount) return 0;
  const parsed = Number.parseInt(rawCount, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_DEV_BATCHES)
    : 0;
}

export function isOffDevBatchId(batchId: string) {
  return batchId.startsWith(DEV_BATCH_PREFIX);
}

export function createOffDevBatches(requestedCount: number) {
  const count = Math.max(0, Math.min(Math.trunc(requestedCount), MAX_DEV_BATCHES));
  const referenceTime = Date.UTC(2026, 5, 30, 8, 0, 0);

  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    const [principleCode, principleName] = PRINCIPLES[index % PRINCIPLES.length];
    const scenario = SCENARIOS[index % SCENARIOS.length];
    const monthNumber = (index % 12) + 1;
    const bulan = String(monthNumber).padStart(2, "0");
    const tahun = String(2025 + (Math.floor(index / 12) % 2));
    const totalNominal = 1_500_000 + (index % 24) * 625_000;
    const createdAt = new Date(referenceTime - (index % 120) * 86_400_000).toISOString();

    return {
      id: `${DEV_BATCH_PREFIX}${sequence}`,
      noPengajuan: `${String(sequence).padStart(4, "0")}/${principleCode}/${bulan}/${tahun}`,
      gelombang: String((index % 3) + 1).padStart(3, "0"),
      principleName,
      principleCode,
      bulan,
      tahun,
      supervisorName: `Supervisor Area ${(index % 12) + 1}`,
      ...scenario,
      createdAt,
      updatedAt: createdAt,
      summary: {
        totalNominal,
        totalRows: (index % 8) + 1,
        transfer: Math.round(totalNominal * 0.8),
        tunai: Math.round(totalNominal * 0.2),
      },
      paymentSummary: scenario.financeStatus === "Paid"
        ? { totalNominal, totalPaid: totalNominal, remainingAmount: 0, isFullyPaid: true }
        : undefined,
      searchText: `${principleCode} ${principleName} Supervisor Area ${(index % 12) + 1} ${scenario.status}`.toLowerCase(),
      periodDates: { pengajuan: [`${tahun}-${bulan}-01`] },
    };
  });
}
