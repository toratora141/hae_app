// relay/worker.js
//
// api.codiv.ai はCORSプリフライト(OPTIONS)に対応しておらず、実レスポンスにも
// Access-Control-Allow-Origin ヘッダーが付かないため、GitHub Pages上のブラウザから
// 直接 fetch() することができない(詳細はREADME.mdの「CORSについて」を参照)。
//
// このCloudflare Workerは、静的サイトとapi.codiv.aiの間に立ち、
// - CORSヘッダーを付与する
// - APIキーをWorkerのシークレット環境変数(CODIV_API_KEY)から読み、
//   アプリ側にはキーを持たせない
// ための薄い中継(リレー)。デプロイは行っていない。
// README.md の「Cloudflare Workers 中継のデプロイ手順」を参照。

const UPSTREAM = "https://api.codiv.ai/v1/systemone";

// 本番ではALLOWED_ORIGINをGitHub PagesのオリジンURLに限定すること。
// (例: "https://<your-username>.github.io")
function corsHeaders(env, request) {
  const allowedOrigin = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin") || "";
  const allowOrigin =
    allowedOrigin === "*"
      ? "*"
      : allowedOrigin.split(",").map((s) => s.trim()).includes(origin)
      ? origin
      : "null";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POSTのみ対応しています" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (!env.CODIV_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Workerのシークレット CODIV_API_KEY が未設定です" }),
        { status: 500, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    let body;
    try {
      body = await request.text();
    } catch (e) {
      return new Response(JSON.stringify({ error: "リクエストボディを読めませんでした" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const upstreamResp = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.CODIV_API_KEY}`,
      },
      body,
    });

    const respBody = await upstreamResp.text();
    return new Response(respBody, {
      status: upstreamResp.status,
      headers: {
        ...headers,
        "Content-Type": upstreamResp.headers.get("Content-Type") || "application/json",
      },
    });
  },
};
