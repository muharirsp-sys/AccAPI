/*
 * Tujuan: API route untuk chatbot rule-based.
 * Caller: components/ChatWidget.tsx.
 * Dependensi: lib/chatbot/matcher.ts, lib/chatbot/commands.ts, lib/auth.ts.
 * ponytail: session-only guard (chatbot tidak butuh RBAC granular, cukup login).
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isLocalAuthBypassEnabled } from "@/lib/local-dev-auth";
import { matchFaq } from "@/lib/chatbot/matcher";
import { tryCommand, getCommandHelp } from "@/lib/chatbot/commands";

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session && !isLocalAuthBypassEnabled(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const message = body?.message;

  if (!message || typeof message !== "string" || !message.trim()) {
    return NextResponse.json({ reply: matchFaq("") });
  }

  const input = message.trim().slice(0, 500);

  if (/^(data|query|command)/i.test(input)) {
    return NextResponse.json({ reply: { text: getCommandHelp() } });
  }

  const cmdResult = await tryCommand(input);
  if (cmdResult) {
    return NextResponse.json({ reply: cmdResult });
  }

  const reply = matchFaq(input);
  return NextResponse.json({ reply });
}
