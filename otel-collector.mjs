#!/usr/bin/env node
/**
 * NanoClaw OTEL Collector
 * Minimal HTTP server that receives OTLP/JSON telemetry from Claude Code containers.
 *
 * Claude Code emits:
 *   POST /v1/metrics  — PeriodicExportingMetricReader every 5 min
 *     Metric: "claude_code.token.usage"  (Counter, unit: tokens)
 *       attributes: { model: "claude-sonnet-4-6", type: "input"|"output"|"cacheRead"|"cacheCreation" }
 *     Metric: "claude_code.cost.usage"   (Counter, unit: USD)
 *       attributes: { model: "claude-sonnet-4-6" }
 *
 *   POST /v1/traces   — BatchSpanProcessor
 *   POST /v1/logs     — BatchLogRecordProcessor
 *     (spans/logs contain individual LLM request details too)
 *
 * Usage:
 *   node otel-collector.mjs --store ~/NanoClaw/store
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import os from 'os';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    store: { type: 'string', default: path.join(os.homedir(), 'NanoClaw', 'store') },
    port:  { type: 'string', default: '4318' },
  },
});

const STORE_DIR = args.store.startsWith('~')
  ? args.store.replace('~', os.homedir())
  : args.store;
const PORT = parseInt(args.port, 10);
const LOG_FILE = path.join(STORE_DIR, 'token-usage.jsonl');

fs.mkdirSync(STORE_DIR, { recursive: true });

console.log(`[otel-collector] Starting on port ${PORT}`);
console.log(`[otel-collector] Writing to ${LOG_FILE}`);

// ---------------------------------------------------------------------------
// Cost computation (mirrors container-runner logic)
// ---------------------------------------------------------------------------

/** @param {string} model @param {number} input @param {number} output */
function computeCostUsd(model, input, output) {
  const m = model.toLowerCase();
  let inputPricePerM = 0;
  let outputPricePerM = 0;
  if (m.includes('haiku')) {
    inputPricePerM = 0.8;
    outputPricePerM = 4.0;
  } else if (m.includes('sonnet')) {
    inputPricePerM = 3.0;
    outputPricePerM = 15.0;
  } else if (m.includes('opus')) {
    inputPricePerM = 15.0;
    outputPricePerM = 75.0;
  }
  return (input / 1_000_000) * inputPricePerM + (output / 1_000_000) * outputPricePerM;
}

// ---------------------------------------------------------------------------
// Aggregate per-export-batch: group by (model, channel) so each flush becomes
// one jsonl record rather than N individual data-point lines.
// ---------------------------------------------------------------------------

/**
 * Extract the "channel" (group folder) from OTLP resource attributes.
 * Claude Code sets service.name="claude-code"; we look for a custom
 * "channel" or "nanoclaw.channel" attribute injected via OTEL_RESOURCE_ATTRIBUTES.
 *
 * Fallback: "unknown"
 *
 * @param {Record<string, any>[]} resourceAttrs
 */
function extractChannel(resourceAttrs) {
  if (!Array.isArray(resourceAttrs)) return 'unknown';
  for (const attr of resourceAttrs) {
    const key = attr?.key ?? '';
    if (key === 'channel' || key === 'nanoclaw.channel' || key === 'service.instance.id') {
      return String(attr?.value?.stringValue ?? attr?.value ?? 'unknown');
    }
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// OTLP /v1/metrics handler
// Claude Code uses a Counter for claude_code.token.usage with:
//   attributes: model (string), type ("input"|"output"|"cacheRead"|"cacheCreation")
// and claude_code.cost.usage:
//   attributes: model (string)
// ---------------------------------------------------------------------------

function handleMetrics(body, channel) {
  const resourceMetrics = body?.resourceMetrics ?? [];
  const timestamp = new Date().toISOString();

  // Accumulate per (model) totals within this batch
  /** @type {Map<string, {input:number,output:number,cacheRead:number,cacheCreation:number,cost:number}>} */
  const byModel = new Map();

  for (const rm of resourceMetrics) {
    // Try to extract channel from resource attrs if not already known
    const resChannel = extractChannel(rm?.resource?.attributes ?? []);
    const effectiveChannel = (channel === 'unknown' && resChannel !== 'unknown')
      ? resChannel : channel;

    for (const sm of rm?.scopeMetrics ?? []) {
      for (const metric of sm?.metrics ?? []) {
        const name = metric?.name ?? '';

        if (name === 'claude_code.token.usage') {
          // Sum is (dataPoints[].asDouble or asInt)
          for (const dp of metric?.sum?.dataPoints ?? []) {
            const value = dp?.asDouble ?? dp?.asInt ?? 0;
            if (!value) continue;

            let model = 'unknown';
            let tokenType = 'input';
            for (const attr of dp?.attributes ?? []) {
              if (attr.key === 'model') model = String(attr.value?.stringValue ?? attr.value ?? 'unknown');
              if (attr.key === 'type')  tokenType = String(attr.value?.stringValue ?? attr.value ?? 'input');
            }

            if (!byModel.has(model)) byModel.set(model, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 });
            const entry = byModel.get(model);
            if (tokenType === 'input')          entry.input        += value;
            else if (tokenType === 'output')    entry.output       += value;
            else if (tokenType === 'cacheRead') entry.cacheRead    += value;
            else                                entry.cacheCreation += value;
          }
        }

        if (name === 'claude_code.cost.usage') {
          for (const dp of metric?.sum?.dataPoints ?? []) {
            const value = dp?.asDouble ?? dp?.asInt ?? 0;
            if (!value) continue;

            let model = 'unknown';
            for (const attr of dp?.attributes ?? []) {
              if (attr.key === 'model') model = String(attr.value?.stringValue ?? attr.value ?? 'unknown');
            }

            if (!byModel.has(model)) byModel.set(model, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 });
            byModel.get(model).cost += value;
          }
        }
      }
    }

    // Write one record per model group
    for (const [model, totals] of byModel.entries()) {
      if (totals.input === 0 && totals.output === 0 && totals.cost === 0) continue;

      const costUsd = totals.cost > 0
        ? parseFloat(totals.cost.toFixed(6))
        : parseFloat(computeCostUsd(model, totals.input, totals.output).toFixed(6));

      const record = {
        timestamp,
        source: 'otel-metrics',
        channel: effectiveChannel,
        model,
        input_tokens:           totals.input,
        output_tokens:          totals.output,
        cache_read_tokens:      totals.cacheRead,
        cache_creation_tokens:  totals.cacheCreation,
        cost_usd:               costUsd,
      };

      const line = JSON.stringify(record) + '\n';
      fs.appendFileSync(LOG_FILE, line, { flag: 'a' });
      console.log(`[otel-collector] metrics | channel=${effectiveChannel} model=${model} in=${totals.input} out=${totals.output} cost=$${costUsd}`);
    }
  }
}

// ---------------------------------------------------------------------------
// OTLP /v1/traces handler — extract token usage from span attributes/events
// Claude Code emits spans with "claude_code.llm_request" events that carry
// input_tokens / output_tokens / model in their attributes.
// ---------------------------------------------------------------------------

function handleTraces(body, channel) {
  const resourceSpans = body?.resourceSpans ?? [];
  const timestamp = new Date().toISOString();

  for (const rs of resourceSpans) {
    const resChannel = extractChannel(rs?.resource?.attributes ?? []);
    const effectiveChannel = (channel === 'unknown' && resChannel !== 'unknown')
      ? resChannel : channel;

    for (const ss of rs?.scopeSpans ?? []) {
      for (const span of ss?.spans ?? []) {
        // Look for token usage in span attributes directly
        let inputTokens = 0, outputTokens = 0, model = 'unknown';

        for (const attr of span?.attributes ?? []) {
          const k = attr.key ?? '';
          const v = attr.value?.intValue ?? attr.value?.doubleValue ?? attr.value?.stringValue ?? null;
          if (k === 'input_tokens' || k === 'gen_ai.usage.input_tokens' || k === 'llm.token_count.prompt') inputTokens = Number(v ?? 0);
          if (k === 'output_tokens' || k === 'gen_ai.usage.output_tokens' || k === 'llm.token_count.completion') outputTokens = Number(v ?? 0);
          if (k === 'model' || k === 'gen_ai.request.model' || k === 'llm.request.model') model = String(v ?? 'unknown');
        }

        // Also scan span events for token data
        for (const event of span?.events ?? []) {
          for (const attr of event?.attributes ?? []) {
            const k = attr.key ?? '';
            const v = attr.value?.intValue ?? attr.value?.doubleValue ?? attr.value?.stringValue ?? null;
            if (k === 'input_tokens') inputTokens = Number(v ?? 0);
            if (k === 'output_tokens') outputTokens = Number(v ?? 0);
            if (k === 'model') model = String(v ?? model);
          }
        }

        if (inputTokens === 0 && outputTokens === 0) continue;

        const costUsd = parseFloat(computeCostUsd(model, inputTokens, outputTokens).toFixed(6));
        const record = {
          timestamp,
          source: 'otel-traces',
          channel: effectiveChannel,
          model,
          input_tokens:  inputTokens,
          output_tokens: outputTokens,
          cost_usd:      costUsd,
          span_name:     span?.name ?? '',
        };

        const line = JSON.stringify(record) + '\n';
        fs.appendFileSync(LOG_FILE, line, { flag: 'a' });
        console.log(`[otel-collector] traces  | channel=${effectiveChannel} span=${span?.name} model=${model} in=${inputTokens} out=${outputTokens}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// OTLP /v1/logs handler
// Claude Code logs LLM requests as LogRecords with body containing usage.
// ---------------------------------------------------------------------------

function handleLogs(body, channel) {
  const resourceLogs = body?.resourceLogs ?? [];
  const timestamp = new Date().toISOString();

  for (const rl of resourceLogs) {
    const resChannel = extractChannel(rl?.resource?.attributes ?? []);
    const effectiveChannel = (channel === 'unknown' && resChannel !== 'unknown')
      ? resChannel : channel;

    for (const sl of rl?.scopeLogs ?? []) {
      for (const record of sl?.logRecords ?? []) {
        let inputTokens = 0, outputTokens = 0, model = 'unknown';

        // Check attributes
        for (const attr of record?.attributes ?? []) {
          const k = attr.key ?? '';
          const v = attr.value?.intValue ?? attr.value?.doubleValue ?? attr.value?.stringValue ?? null;
          if (k === 'input_tokens' || k === 'gen_ai.usage.input_tokens') inputTokens = Number(v ?? 0);
          if (k === 'output_tokens' || k === 'gen_ai.usage.output_tokens') outputTokens = Number(v ?? 0);
          if (k === 'model' || k === 'gen_ai.request.model') model = String(v ?? 'unknown');
        }

        // Check body (kvlistValue or string)
        const bodyKv = record?.body?.kvlistValue?.values ?? [];
        for (const kv of bodyKv) {
          const k = kv.key ?? '';
          const v = kv.value?.intValue ?? kv.value?.doubleValue ?? kv.value?.stringValue ?? null;
          if (k === 'input_tokens') inputTokens = Number(v ?? 0);
          if (k === 'output_tokens') outputTokens = Number(v ?? 0);
          if (k === 'model') model = String(v ?? model);
        }

        if (inputTokens === 0 && outputTokens === 0) continue;

        const costUsd = parseFloat(computeCostUsd(model, inputTokens, outputTokens).toFixed(6));
        const logRecord = {
          timestamp,
          source: 'otel-logs',
          channel: effectiveChannel,
          model,
          input_tokens:  inputTokens,
          output_tokens: outputTokens,
          cost_usd:      costUsd,
        };

        const line = JSON.stringify(logRecord) + '\n';
        fs.appendFileSync(LOG_FILE, line, { flag: 'a' });
        console.log(`[otel-collector] logs    | channel=${effectiveChannel} model=${model} in=${inputTokens} out=${outputTokens}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  // CORS pre-flight (just in case)
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const validPaths = ['/v1/metrics', '/v1/traces', '/v1/logs'];
  if (!validPaths.includes(req.url)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  let rawBody = '';
  req.on('data', chunk => { rawBody += chunk.toString(); });

  req.on('end', () => {
    // Extract channel hint from query string (?channel=discord_main) or
    // X-Nanoclaw-Channel header — containers can set either.
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const channel = req.headers['x-nanoclaw-channel']
      ?? urlObj.searchParams.get('channel')
      ?? 'unknown';

    try {
      const body = JSON.parse(rawBody);

      console.log(`[otel-collector] ${req.url} from ${req.socket.remoteAddress} channel=${channel} bytes=${rawBody.length}`);

      if (req.url === '/v1/metrics') handleMetrics(body, channel);
      else if (req.url === '/v1/traces') handleTraces(body, channel);
      else if (req.url === '/v1/logs') handleLogs(body, channel);

      // OTLP response: empty ExportMetricsServiceResponse / etc.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    } catch (err) {
      console.error(`[otel-collector] Failed to parse ${req.url} payload:`, err.message);
      console.error(`[otel-collector] Raw body (first 500):`, rawBody.slice(0, 500));
      // Still return 200 so the exporter doesn't retry endlessly
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });

  req.on('error', err => {
    console.error('[otel-collector] Request error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[otel-collector] Listening on 0.0.0.0:${PORT}`);
  console.log(`[otel-collector] Endpoints: POST /v1/metrics  /v1/traces  /v1/logs`);
});

server.on('error', err => {
  console.error('[otel-collector] Server error:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
