import { NextRequest, NextResponse } from "next/server";
import { SYSTEM_PROMPT } from "@/lib/prompts";

export async function POST(req: NextRequest) {
  const baseUrl = process.env.LLM_BASE_URL || "http://localhost:11434/v1";
  const model = process.env.LLM_MODEL || "llama3";
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 120000;

  let body: { message: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.message || typeof body.message !== "string") {
    return NextResponse.json(
      { error: "message field is required" },
      { status: 400 },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: body.message },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return NextResponse.json(
        { error: `LLM server error: ${response.status}`, detail: text },
        { status: 502 },
      );
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return NextResponse.json(
        { error: "No content in LLM response" },
        { status: 502 },
      );
    }

    let parsed: { elements?: unknown[] };
    try {
      parsed = JSON.parse(content);
    } catch {
      return NextResponse.json(
        { error: "LLM returned invalid JSON", raw: content },
        { status: 502 },
      );
    }

    if (!Array.isArray(parsed.elements) || parsed.elements.length === 0) {
      return NextResponse.json(
        { error: "LLM response missing elements array", raw: parsed },
        { status: 502 },
      );
    }

    return NextResponse.json({ elements: parsed.elements });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return NextResponse.json(
        { error: "LLM request timed out" },
        { status: 504 },
      );
    }
    return NextResponse.json(
      { error: "Failed to reach LLM server", detail: String(err) },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
