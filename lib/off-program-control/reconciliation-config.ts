import type { ReconciliationDivision } from "./reconciliation-store";

export type ReconciliationInputConfig = {
  role: "accurateFile" | "headerFile" | "principalFile";
  label: string;
  extension: ".csv" | ".xlsx";
  accept: string;
};

export type ReconciliationConfig = {
  division: ReconciliationDivision;
  principal: string;
  endpoint: string;
  description: string;
  inputs: ReconciliationInputConfig[];
};

const csv = ".csv,text/csv,application/csv";
const xlsx = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const accurateSales: ReconciliationInputConfig = { role: "accurateFile", label: "Rincian Faktur Penjualan (Accurate)", extension: ".xlsx", accept: xlsx };
const accuratePurchases: ReconciliationInputConfig = { role: "accurateFile", label: "Rincian Faktur Pembelian (Accurate)", extension: ".xlsx", accept: xlsx };
const accurateReturns: ReconciliationInputConfig = { role: "accurateFile", label: "Retur Penjualan (Accurate)", extension: ".xlsx", accept: xlsx };
const input = (role: ReconciliationInputConfig["role"], label: string, extension: ".csv" | ".xlsx"): ReconciliationInputConfig => ({ role, label, extension, accept: extension === ".csv" ? csv : xlsx });

export const RECONCILIATION_CONFIG = {
  "sales:KINO": { division: "sales", principal: "KINO", endpoint: "api/reconciliation/kino/sales", description: "Bandingkan faktur Accurate dengan data penjualan prinsipal KINO.", inputs: [accurateSales, input("principalFile", "Sales Detail KINO", ".xlsx")] },
  "sales:GODREJ": { division: "sales", principal: "GODREJ", endpoint: "api/reconciliation/godrej/sales", description: "Bandingkan faktur Accurate dengan data penjualan prinsipal GODREJ.", inputs: [accurateSales, input("principalFile", "Sales Detail GODREJ", ".xlsx")] },
  "sales:SHINZUI": { division: "sales", principal: "SHINZUI", endpoint: "api/reconciliation/shinzui/sales", description: "Bandingkan faktur Accurate dengan data penjualan prinsipal SHINZUI.", inputs: [accurateSales, input("principalFile", "Sales Detail SHINZUI", ".xlsx")] },
  "sales:MOTASA": { division: "sales", principal: "MOTASA", endpoint: "api/reconciliation/motasa/sales", description: "Bandingkan faktur Accurate dengan data penjualan prinsipal MOTASA.", inputs: [accurateSales, input("principalFile", "Sales Detail MOTASA", ".xlsx")] },
  "sales:CUSSONS": { division: "sales", principal: "CUSSONS", endpoint: "api/reconciliation/cussons/sales", description: "Bandingkan faktur Accurate dengan data penjualan prinsipal CUSSONS.", inputs: [accurateSales, input("principalFile", "Detail CUSSONS", ".csv")] },
  "purchases:GODREJ": { division: "purchases", principal: "GODREJ", endpoint: "api/reconciliation/godrej/purchases", description: "Bandingkan faktur pembelian Accurate dengan GRN Status Report GODREJ.", inputs: [accuratePurchases, input("principalFile", "GRN Status Report GODREJ", ".csv")] },
  "purchases:RECKITT": { division: "purchases", principal: "RECKITT", endpoint: "api/reconciliation/reckitt/purchases", description: "Bandingkan faktur pembelian Accurate dengan TXN_COMPINV_DTL RECKITT.", inputs: [accuratePurchases, input("principalFile", "TXN_COMPINV_DTL RECKITT", ".csv")] },
  "purchases:CUSSONS": { division: "purchases", principal: "CUSSONS", endpoint: "api/reconciliation/cussons/purchases", description: "Bandingkan faktur pembelian Accurate dengan TXN_COMPINV_DTL CUSSONS.", inputs: [accuratePurchases, input("principalFile", "TXN_COMPINV_DTL CUSSONS", ".csv")] },
  "purchases:KINO": { division: "purchases", principal: "KINO", endpoint: "api/reconciliation/kino/purchases", description: "Bandingkan faktur pembelian Accurate dengan PO Report KINO.", inputs: [accuratePurchases, input("principalFile", "PO Report KINO", ".xlsx")] },
  "purchases:FORISA": { division: "purchases", principal: "FORISA", endpoint: "api/reconciliation/forisa/purchases", description: "Bandingkan faktur pembelian Accurate dengan DO FORISA.", inputs: [accuratePurchases, input("principalFile", "DO FORISA", ".xlsx")] },
  "returns:SHINZUI": { division: "returns", principal: "SHINZUI", endpoint: "api/reconciliation/shinzui/returns", description: "Bandingkan retur Accurate dengan laporan PenjualanInvoice SHINZUI.", inputs: [accurateReturns, input("principalFile", "PenjualanInvoice SHINZUI", ".xlsx")] },
  "returns:KINO": { division: "returns", principal: "KINO", endpoint: "api/reconciliation/kino/returns", description: "Bandingkan retur Accurate dengan laporan Sales Detail KINO.", inputs: [accurateReturns, input("principalFile", "Sales Detail KINO", ".xlsx")] },
  "returns:GODREJ": { division: "returns", principal: "GODREJ", endpoint: "api/reconciliation/godrej/returns", description: "Bandingkan retur Accurate dengan laporan Sale Returns GODREJ.", inputs: [accurateReturns, input("principalFile", "Sale Returns GODREJ", ".csv")] },
  "returns:HEINZ": { division: "returns", principal: "HEINZ", endpoint: "api/reconciliation/heinz/returns", description: "Bandingkan retur Accurate dengan laporan HEADER dan DETAIL HEINZ.", inputs: [accurateReturns, input("headerFile", "HEADER HEINZ", ".csv"), input("principalFile", "DETAIL HEINZ", ".csv")] },
  "returns:CUSSONS": { division: "returns", principal: "CUSSONS", endpoint: "api/reconciliation/cussons/returns", description: "Bandingkan retur Accurate dengan laporan TXN_NOTEPRD CUSSONS.", inputs: [accurateReturns, input("principalFile", "TXN_NOTEPRD CUSSONS", ".csv")] },
} satisfies Record<string, ReconciliationConfig>;

export function getReconciliationConfig(division: ReconciliationDivision, principal: string): ReconciliationConfig {
  const config = RECONCILIATION_CONFIG[`${division}:${principal}` as keyof typeof RECONCILIATION_CONFIG];
  if (!config) throw new Error(`Kontrak rekonsiliasi tidak didukung: ${division}:${principal}`);
  return config;
}

export function reconciliationKeys(): string[] {
  return Object.keys(RECONCILIATION_CONFIG);
}
