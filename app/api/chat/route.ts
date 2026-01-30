import { NextRequest } from "next/server";
import { SYSTEM_PROMPT } from "@/lib/prompts";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function POST(req: NextRequest) {
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || 120000;

  let body: {
    messages: Array<{ role: string; content: string }>;
    canvasContext?: string;
    llmSettings?: {
      baseUrl?: string;
      model?: string;
      apiKey?: string;
    };
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Use client-provided settings, falling back to env vars
  const baseUrl = body.llmSettings?.baseUrl || process.env.LLM_BASE_URL || "http://localhost:11434/v1";
  const model = body.llmSettings?.model || process.env.LLM_MODEL || "llama3";
  const apiKey = body.llmSettings?.apiKey || process.env.LLM_API_KEY || "";

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(
      JSON.stringify({ error: "messages array is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Build LLM messages: system prompt + optional canvas context + conversation history (last 10)
  const llmMessages: ChatMessage[] = [];

  let systemContent = SYSTEM_PROMPT;
  if (body.canvasContext) {
    systemContent += `\n\n## Current Canvas State\n${body.canvasContext}`;
  }
  llmMessages.push({ role: "system", content: systemContent });

  // Take last 10 messages to prevent token overflow
  const recentMessages = body.messages.slice(-10);
  for (const msg of recentMessages) {
    if (msg.role === "user" || msg.role === "assistant") {
      llmMessages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: llmMessages,
        response_format: { type: "json_object" },
        temperature: 0.3,
        stream: true,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return new Response(
        JSON.stringify({
          error: `LLM server error: ${response.status}`,
          detail: text,
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    // If the LLM doesn't support streaming, fall back to non-streaming
    const contentType = response.headers.get("content-type") || "";
    if (
      !contentType.includes("text/event-stream") &&
      !contentType.includes("text/plain") &&
      contentType.includes("application/json")
    ) {
      // Non-streaming response
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        return new Response(
          JSON.stringify({ error: "No content in LLM response" }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ content, done: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Streaming SSE response - relay to client
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(streamController) {
        const reader = response.body?.getReader();
        if (!reader) {
          streamController.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: "No response body" })}\n\n`,
            ),
          );
          streamController.close();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data: ")) continue;

              const payload = trimmed.slice(6);
              if (payload === "[DONE]") {
                streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }

              try {
                const chunk = JSON.parse(payload);
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) {
                  streamController.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ token: delta })}\n\n`,
                    ),
                  );
                }
              } catch {
                // Skip malformed chunks
              }
            }
          }
        } catch (err) {
          if (
            err instanceof DOMException &&
            err.name === "AbortError"
          ) {
            streamController.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: "Request aborted" })}\n\n`,
              ),
            );
          }
        } finally {
          streamController.close();
          reader.releaseLock();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return new Response(
        JSON.stringify({ error: "LLM request timed out" }),
        { status: 504, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        error: "Failed to reach LLM server",
        detail: String(err),
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  } finally {
    clearTimeout(timeout);
  }
}
