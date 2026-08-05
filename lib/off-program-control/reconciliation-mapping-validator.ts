import type { ReconciliationDivision } from "./reconciliation-store";
import {
  parseCussonsMappings,
  parseGodrejMappings as parseGodrejSalesMappings,
  parseKinoMappings,
  parseMotasaMappings,
  parseShinzuiMappings,
} from "./sales-reconciliation";
import {
  parseForisaMappings,
  parseKinoPurchaseMappings,
  parseMappings as parseGodrejPurchaseMappings,
  parseReckittMappings,
} from "./purchase-reconciliation";
import {
  parseGodrejMappings as parseGodrejReturnMappings,
  parseHeinzMappings,
  parseKinoReturnMappings,
  parseMappings as parseShinzuiReturnMappings,
} from "./return-reconciliation";

export function validateReconciliationMapping(
  division: ReconciliationDivision,
  principal: string,
  workbook: Buffer | Uint8Array,
): void {
  switch (`${division}:${principal}`) {
    case "sales:KINO": parseKinoMappings(workbook); return;
    case "sales:GODREJ": parseGodrejSalesMappings(workbook); return;
    case "sales:SHINZUI": parseShinzuiMappings(workbook); return;
    case "sales:MOTASA": parseMotasaMappings(workbook); return;
    case "sales:CUSSONS": parseCussonsMappings(workbook); return;
    case "purchases:GODREJ": parseGodrejPurchaseMappings(workbook); return;
    case "purchases:RECKITT": parseReckittMappings(workbook); return;
    case "purchases:CUSSONS": parseCussonsMappings(workbook); return;
    case "purchases:KINO": parseKinoPurchaseMappings(workbook); return;
    case "purchases:FORISA": parseForisaMappings(workbook); return;
    case "returns:SHINZUI": parseShinzuiReturnMappings(workbook); return;
    case "returns:KINO": parseKinoReturnMappings(workbook); return;
    case "returns:GODREJ": parseGodrejReturnMappings(workbook); return;
    case "returns:HEINZ": parseHeinzMappings(workbook); return;
    case "returns:CUSSONS": parseCussonsMappings(workbook); return;
    default: throw new Error(`Kontrak rekonsiliasi tidak didukung: ${division}:${principal}`);
  }
}
