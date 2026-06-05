// netlify/functions/anthropic.js
// 클라이언트가 보낸 {system, messages, max_tokens}를 받아
// 서버에 보관된 ANTHROPIC_API_KEY로 Anthropic API에 중계합니다.
// (API 키가 브라우저에 노출되지 않도록 하는 핵심 부분)

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: "Method Not Allowed" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({
        error:
          "ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Netlify 사이트 설정 > Environment variables 에서 추가하세요.",
      }),
    };
  }

  try {
    const inbound = JSON.parse(event.body || "{}");
    const payload = {
      model: inbound.model || DEFAULT_MODEL,
      max_tokens: inbound.max_tokens || 1024,
      ...(inbound.system ? { system: inbound.system } : {}),
      messages: Array.isArray(inbound.messages) ? inbound.messages : [],
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    return {
      statusCode: r.status,
      headers: { ...cors, "content-type": "application/json" },
      body: text,
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ error: String(e && e.message ? e.message : e) }),
    };
  }
};
