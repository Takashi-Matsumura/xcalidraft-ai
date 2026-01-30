import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  let body: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const baseUrl = body.baseUrl || process.env.LLM_BASE_URL || "http://localhost:11434/v1";
  const model = body.model || process.env.LLM_MODEL || "llama3";
  const apiKey = body.apiKey || process.env.LLM_API_KEY || "";

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    // Send a minimal request to verify the connection and model
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return Response.json({
        ok: false,
        error: `Server returned ${response.status}: ${text.slice(0, 200)}`,
      });
    }

    return Response.json({
      ok: true,
      message: `Connected to ${baseUrl} with model "${model}"`,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return Response.json({ ok: false, error: "Connection timed out (10s)" });
    }
    const msg = err instanceof Error ? err.message : String(err);
    let detail = msg;
    if (msg.includes("ECONNREFUSED")) {
      detail = `Cannot connect to ${baseUrl} — is the server running?`;
    } else if (msg.includes("fetch failed")) {
      detail = `Cannot reach ${baseUrl} — check the URL`;
    }
    return Response.json({ ok: false, error: detail });
  }
}
