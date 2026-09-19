/*
 * Tujuan: Keyword matching engine untuk chatbot rule-based.
 * Caller: app/api/chatbot/route.ts.
 * Dependensi: faq.json, greetings.ts, types.ts.
 * ponytail: string.includes() + Levenshtein distance. No NLP lib.
 */
import faqData from "./faq.json";
import { getFallback, getMenu, getGreeting } from "./greetings";
import type { BotResponse, FaqEntry } from "./types";

const faq: FaqEntry[] = faqData as FaqEntry[];

const NAV_MAP: Record<string, { label: string; href: string }[]> = {
  opc: [{ label: "OFF Program Control", href: "/off-program-control" }],
  claim: [{ label: "Claim Workflow", href: "/claim-workflow" }],
  payment: [{ label: "Pembayaran", href: "/payments" }],
  payments: [{ label: "Pembayaran", href: "/payments" }],
  sppd: [{ label: "Format SPPD", href: "/payments/sppd" }],
  sales: [{ label: "Insentif Sales", href: "/insentif-sales" }],
  insentif: [{ label: "Insentif Sales", href: "/insentif-sales" }],
  "form-kontrol": [{ label: "Form Kontrol", href: "/form-kontrol" }],
  "form kontrol": [{ label: "Form Kontrol", href: "/form-kontrol" }],
  admin: [{ label: "User & RBAC", href: "/admin/users" }, { label: "Kelola Akses Group", href: "/admin/groups" }],
  user: [{ label: "User & RBAC", href: "/admin/users" }],
  rbac: [{ label: "Kelola Akses Group", href: "/admin/groups" }],
  principle: [{ label: "Master Principle", href: "/principles" }],
  principal: [{ label: "Master Principle", href: "/principles" }],
  summary: [{ label: "Summary Promo", href: "/summary" }],
  finance: [{ label: "Finance", href: "/finance" }],
  accurate: [{ label: "AOL Form Engine", href: "/api-wrapper" }],
  aol: [{ label: "AOL Form Engine", href: "/api-wrapper" }],
  dashboard: [{ label: "Dashboard", href: "/" }],
};

const CONVERSATIONAL: [RegExp, () => BotResponse][] = [
  [/^(terima ?kasih|makasih|thanks|thx|ty)/i, () => ({ text: "Sama-sama! Ada yang bisa saya bantu lagi? Ketik 'menu' untuk panduan." })],
  [/^(oke|ok|siap|paham|mengerti|baik|noted)/i, () => ({ text: "Baik! Jika butuh bantuan lagi, ketik 'menu' atau tanya langsung." })],
  [/^(siapa kamu|kamu siapa|apa ini|chatbot|bot)/i, () => ({ text: "Saya AI Assistant — chatbot rule-based yang membantu navigasi Smart ERP CV. Surya Perkasa. Saya bisa:\n\n- Menjawab pertanyaan tentang modul ERP\n- Memberikan panduan navigasi\n- Mengambil data dari database\n\nKetik 'menu' untuk panduan lengkap." })],
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function fuzzyIncludes(input: string, keyword: string): boolean {
  if (input.includes(keyword)) return true;
  // ponytail: fuzzy only for keywords >= 4 chars, tolerance = 2
  if (keyword.length < 4) return false;
  const words = input.split(" ");
  for (const w of words) {
    if (Math.abs(w.length - keyword.length) <= 2 && levenshtein(w, keyword) <= 2) return true;
  }
  return false;
}

function scoreMatch(input: string, keywords: string[]): number {
  const n = normalize(input);
  let score = 0;
  for (const kw of keywords) {
    const nk = normalize(kw);
    if (n.includes(nk)) {
      score += 3;
    } else if (fuzzyIncludes(n, nk)) {
      score += 1;
    }
  }
  return score;
}

export function matchFaq(input: string): BotResponse {
  const n = normalize(input);

  if (!n) return getMenu();

  if (/^(hi|halo|hai|hello|hey)\b/.test(n)) return getGreeting();
  if (/^(menu|help|bantuan|panduan|faq)\b/.test(n)) return getMenu();

  for (const [pattern, handler] of CONVERSATIONAL) {
    if (pattern.test(n)) return handler();
  }

  const diMana = n.match(/di mana (menu |modul |halaman )?(.+)/);
  if (diMana) {
    const term = diMana[2].trim();
    for (const [key, links] of Object.entries(NAV_MAP)) {
      if (normalize(key).includes(term) || term.includes(normalize(key))) {
        return { text: `Menu tersebut ada di sidebar navigasi:`, links };
      }
    }
    for (const entry of faq) {
      if (entry.keywords.some((kw) => normalize(kw).includes(term) || term.includes(normalize(kw)))) {
        return { text: entry.answer, links: entry.links };
      }
    }
  }

  let best: FaqEntry | null = null;
  let bestScore = 0;
  for (const entry of faq) {
    const s = scoreMatch(n, entry.keywords);
    if (s > bestScore) {
      bestScore = s;
      best = entry;
    }
  }

  if (best && bestScore >= 2) {
    return { text: best.answer, links: best.links };
  }

  if (best && bestScore >= 1) {
    return { text: best.answer + "\n\n_(Pertanyaan Anda mungkin terkait topik ini — ketik 'menu' untuk panduan lengkap)_", links: best.links };
  }

  return getFallback();
}
