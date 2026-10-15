// Rate-limit matrix probe — runs on Render, driven via HTTP.
//
// POST /probe   — fire N requests and return results
// POST /matrix  — run the full matrix test
// GET  /health  — liveness
// GET  /ip      — show this service's egress IP

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = parseInt(process.env.PORT || "10000", 10);
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY!;
const OPENCODE_ORG_ID = process.env.OPENCODE_ORG_ID!;
const PROBE_KEY = process.env.PROBE_KEY || "probe-default";

const ZEN_BASE = "https://opencode.ai/zen/v1";
const INF_BASE = "https://opencode.ai/inference/v1";

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastTs = 0, counter = 0;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function mintId(prefix: string, descending: boolean): string {
  const ts = Date.now();
  if (ts !== lastTs) { lastTs = ts; counter = 0; }
  counter++;
  const cur = BigInt(ts) * 0x1000n + BigInt(counter);
  const val = descending ? ~cur : cur;
  let hex = "";
  for (let i = 0; i < 6; i++)
    hex += ((Number((val >> BigInt(40 - 8 * i)) & 0xffn)) & 0xff).toString(16).padStart(2, "0");
  const rnd = new Uint8Array(14);
  crypto.getRandomValues(rnd);
  return prefix + "_" + hex + Array.from(rnd, (b) => ID_CHARS[b % 62]).join("");
}

function randomHex(n: number): string {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

type ProbeResult = {
  idx: number;
  label: string;
  status: number;
  ttfbMs: number;
  totalMs: number;
  outputTokens: number;
  retryAfter?: string;
  rateLimitHeaders: Record<string, string>;
  error?: string;
  bodySnippet?: string;
};

type ProbeConfig = {
  model: string;
  gateway: "zen" | "inference";
  prompt: string;
  maxTokens: number;
  stream: boolean;
  sessionId?: string;
  auth: "token" | "public" | "none";
  label: string;
};

async function fireOne(cfg: ProbeConfig, idx: number): Promise<ProbeResult> {
  const base = cfg.gateway === "zen" ? ZEN_BASE : INF_BASE;
  const sessionId = cfg.sessionId || mintId("ses", true);
  const tid = randomHex(16);
  const sid = randomHex(8);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "*/*",
    "user-agent": "opencode/latest/2.0.28/cli",
    "x-opencode-client": "cli",
    "x-opencode-org-id": OPENCODE_ORG_ID,
    "x-opencode-project": "rate-matrix-probe",
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
    b3: `${tid}-${sid}-1`,
    traceparent: `00-${tid}-${sid}-01`,
  };

  if (cfg.auth === "token") {
    headers.authorization = `Bearer ${OPENCODE_API_KEY}`;
  } else if (cfg.auth === "public") {
    headers.authorization = "Bearer public";
  }

  const body: Record<string, any> = {
    model: cfg.model,
    messages: [{ role: "user", content: cfg.prompt }],
    stream: cfg.stream,
    tools: [
      { type: "function", function: { name: "shell", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } } },
      { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
    ],
  };
  if (cfg.maxTokens > 0) body.max_tokens = cfg.maxTokens;
  if (cfg.stream) body.stream_options = { include_usage: true };

  const t0 = performance.now();
  let ttfb = 0, outputTokens = 0, status = 0;
  let error: string | undefined;
  let retryAfter: string | undefined;
  let bodySnippet: string | undefined;
  const rateLimitHeaders: Record<string, string> = {};

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    status = res.status;
    retryAfter = res.headers.get("retry-after") ?? undefined;
    for (const [k, v] of res.headers.entries()) {
      if (k.startsWith("x-ratelimit") || k === "retry-after") {
        rateLimitHeaders[k] = v;
      }
    }

    if (status >= 400) {
      const txt = await res.text();
      error = txt.slice(0, 500);
      bodySnippet = txt.slice(0, 200);
    } else if (cfg.stream) {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "", firstChunk = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunk) { ttfb = Math.round(performance.now() - t0); firstChunk = false; }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop()!;
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const p = line.slice(5).trim();
          if (!p || p === "[DONE]") continue;
          try {
            const j = JSON.parse(p);
            if (j.usage) outputTokens = j.usage.completion_tokens ?? 0;
          } catch {}
        }
      }
    } else {
      ttfb = Math.round(performance.now() - t0);
      const txt = await res.text();
      bodySnippet = txt.slice(0, 200);
      try {
        const j = JSON.parse(txt);
        outputTokens = j.usage?.completion_tokens ?? 0;
      } catch {}
    }
  } catch (e: any) {
    error = e.message?.slice(0, 300);
  }

  return {
    idx,
    label: cfg.label,
    status,
    ttfbMs: ttfb,
    totalMs: Math.round(performance.now() - t0),
    outputTokens,
    retryAfter,
    rateLimitHeaders,
    error,
    bodySnippet,
  };
}

async function runMatrix(): Promise<any> {
  const shortPrompt = "Reply with the single word pong.";
  const mediumPrompt = "Explain the difference between a B-tree and a B+ tree in 3 paragraphs.";

  const matrix: ProbeConfig[] = [
    { model: "deepseek-v4.1-flash-free", gateway: "zen", prompt: shortPrompt, maxTokens: 32, stream: true, auth: "token", label: "baseline-zen-stream" },
    { model: "deepseek-v4.1-flash-free", gateway: "inference", prompt: shortPrompt, maxTokens: 32, stream: true, auth: "token", label: "baseline-inf-stream" },
    { model: "deepseek-v4.1-flash-free", gateway: "zen", prompt: shortPrompt, maxTokens: 32, stream: false, auth: "token", label: "baseline-zen-nostream" },
    { model: "deepseek-v4.1-flash-free", gateway: "zen", prompt: shortPrompt, maxTokens: 32, stream: true, auth: "public", label: "auth-public" },
    { model: "deepseek-v4.1-flash-free", gateway: "zen", prompt: shortPrompt, maxTokens: 32, stream: true, auth: "none", label: "auth-none" },
    { model: "nemotron-3.5-lightning-free", gateway: "zen", prompt: shortPrompt, maxTokens: 32, stream: true, auth: "token", label: "model-nemotron" },
    { model: "deepseek-v4-free", gateway: "zen", prompt: shortPrompt, maxTokens: 32, stream: true, auth: "token", label: "model-dsv4" },
    { model: "deepseek-v4.1-flash-free", gateway: "zen", prompt: shortPrompt, maxTokens: 32, stream: true, auth: "token", sessionId: "ses_fixed_rate_test_session_01", label: "session-fixed" },
    { model: "deepseek-v4.1-flash-free", gateway: "zen", prompt: mediumPrompt, maxTokens: 512, stream: true, auth: "token", label: "medium-prompt" },
  ];

  const phase1Results: ProbeResult[] = [];
  for (let i = 0; i < matrix.length; i++) {
    const r = await fireOne(matrix[i]!, i);
    phase1Results.push(r);
    await sleep(500);
  }

  // Phase 2: 10 rapid sequential requests
  const burstResults: ProbeResult[] = [];
  for (let i = 0; i < 10; i++) {
    const r = await fireOne({
      model: "deepseek-v4.1-flash-free", gateway: "zen", prompt: shortPrompt,
      maxTokens: 32, stream: true, auth: "token", label: `burst-seq-${i}`,
    }, i);
    burstResults.push(r);
  }

  // Phase 3: 10 concurrent requests
  const concurrentResults = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      fireOne({
        model: "deepseek-v4.1-flash-free", gateway: "zen", prompt: shortPrompt,
        maxTokens: 32, stream: true, auth: "token", label: `burst-conc-${i}`,
      }, i)
    )
  );

  // Phase 4: 20 requests at 1 req/3s
  const sustainedResults: ProbeResult[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await fireOne({
      model: "deepseek-v4.1-flash-free", gateway: "zen", prompt: shortPrompt,
      maxTokens: 32, stream: true, auth: "token", label: `sustained-${i}`,
    }, i);
    sustainedResults.push(r);
    if (i < 19) await sleep(3000);
  }

  let egressIP = "unknown";
  try {
    const ipRes = await fetch("https://api.ipify.org?format=json");
    const ipData = await ipRes.json() as any;
    egressIP = ipData.ip;
  } catch {}

  return {
    egressIP,
    timestamp: new Date().toISOString(),
    phase1_matrix: phase1Results,
    phase2_burst_sequential: burstResults,
    phase3_burst_concurrent: concurrentResults,
    phase4_sustained: sustainedResults,
    summary: {
      phase1: { total: phase1Results.length, ok: phase1Results.filter(r => r.status === 200).length, rate429: phase1Results.filter(r => r.status === 429).length },
      phase2: { total: burstResults.length, ok: burstResults.filter(r => r.status === 200).length, rate429: burstResults.filter(r => r.status === 429).length },
      phase3: { total: concurrentResults.length, ok: concurrentResults.filter(r => r.status === 200).length, rate429: concurrentResults.filter(r => r.status === 429).length },
      phase4: { total: sustainedResults.length, ok: sustainedResults.filter(r => r.status === 200).length, rate429: sustainedResults.filter(r => r.status === 429).length },
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: any) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path === "/health") {
      return sendJson(res, 200, { status: "ok", port: PORT });
    }

    if (path === "/ip") {
      const r = await fetch("https://api.ipify.org?format=json");
      const txt = await r.text();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(txt);
    }

    const auth = req.headers["authorization"]?.replace("Bearer ", "") ||
      (req.headers["x-probe-key"] as string);
    if (auth !== PROBE_KEY) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (path === "/probe" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as ProbeConfig & { count?: number };
      const count = body.count || 1;
      const results = await Promise.all(
        Array.from({ length: count }, (_, i) => fireOne(body, i))
      );
      return sendJson(res, 200, { results });
    }

    if (path === "/matrix" && req.method === "POST") {
      const result = await runMatrix();
      return sendJson(res, 200, result);
    }

    // Relay endpoint: proxy an arbitrary request to OpenCode from this node's IP
    if (path === "/relay" && req.method === "POST") {
      const payload = JSON.parse(await readBody(req)) as {
        url: string;
        headers: Record<string, string>;
        body: any;
      };

      const upstream = await fetch(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: JSON.stringify(payload.body),
        signal: AbortSignal.timeout(300_000),
      });

      if (upstream.status === 429 || upstream.status >= 400) {
        const txt = await upstream.text();
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/json",
          ...(upstream.headers.get("retry-after") ? { "retry-after": upstream.headers.get("retry-after")! } : {}),
        });
        return res.end(txt);
      }

      // Stream SSE through
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const reader = upstream.body!.getReader();
      const dec = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(dec.decode(value, { stream: true }));
        }
      } catch {}
      return res.end();
    }

    sendJson(res, 404, { error: "not found", routes: ["/health", "/ip", "/probe", "/relay", "/matrix"] });
  } catch (e: any) {
    sendJson(res, 500, { error: e.message });
  }
});

httpServer.listen(PORT, () => {
  console.log(`Rate probe listening on :${PORT}`);
});
