#!/usr/bin/env node
/**
 * Probe a running lovense-mcp instance over real HTTP.
 *
 * Usage:
 *   node scripts/check.mjs <base-url> <access-key>
 *   node scripts/check.mjs http://127.0.0.1:8787 local-dev-key
 *
 * Only read-only protocol methods are exercised — nothing is sent to the toy.
 */

const [, , baseUrl = 'http://127.0.0.1:8787', accessKey = 'local-dev-key'] = process.argv;
const endpoint = `${baseUrl.replace(/\/+$/, '')}/mcp/${accessKey}`;
const VERSION = '2026-07-28';

let failures = 0;

/** @param {string} label @param {boolean} ok @param {string} [detail] */
function report(label, ok, detail = '') {
  if (!ok) failures += 1;
  const mark = ok ? '[32mPASS[0m' : '[31mFAIL[0m';
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @param {Record<string, string>} [extraHeaders]
 */
async function rpc(method, params = {}, extraHeaders = {}) {
  const body = {
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e6),
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': VERSION,
        'io.modelcontextprotocol/clientInfo': { name: 'lovense-mcp-check', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': VERSION,
    'mcp-method': method,
    ...(method === 'tools/call' ? { 'mcp-name': String(params.name ?? '') } : {}),
    ...extraHeaders,
  };
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

console.log(`Checking ${endpoint}\n`);

// 1. server/discover
try {
  const { status, json } = await rpc('server/discover');
  report(
    'server/discover advertises 2026-07-28',
    status === 200 && json?.result?.supportedVersions?.includes(VERSION),
    `HTTP ${status}, versions: ${json?.result?.supportedVersions?.join(', ') ?? 'none'}`,
  );
} catch (error) {
  report('server/discover advertises 2026-07-28', false, String(error.message));
}

// 2. tools/list
try {
  const { status, json } = await rpc('tools/list');
  const tools = json?.result?.tools ?? [];
  report(
    'tools/list returns the tool set with cache metadata',
    status === 200 && tools.length === 6 && typeof json.result.ttlMs === 'number' && !!json.result.cacheScope,
    `HTTP ${status}, ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`,
  );
  report(
    'results carry resultType and serverInfo',
    json?.result?.resultType === 'complete' &&
      !!json?.result?._meta?.['io.modelcontextprotocol/serverInfo'],
  );
} catch (error) {
  report('tools/list returns the tool set with cache metadata', false, String(error.message));
}

// 3. Header/body mismatch must be rejected with -32020.
try {
  const { status, json } = await rpc('tools/list', {}, { 'mcp-method': 'tools/call' });
  report(
    'header/body mismatch rejected with -32020',
    status === 400 && json?.error?.code === -32020,
    `HTTP ${status}, code ${json?.error?.code}`,
  );
} catch (error) {
  report('header/body mismatch rejected with -32020', false, String(error.message));
}

// 4. Unsupported protocol version must be rejected with -32022.
try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '1900-01-01',
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '1900-01-01',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const json = await response.json();
  report(
    'unsupported version rejected with -32022',
    response.status === 400 && json?.error?.code === -32022,
    `HTTP ${response.status}, code ${json?.error?.code}`,
  );
} catch (error) {
  report('unsupported version rejected with -32022', false, String(error.message));
}

// 5. GET on the MCP endpoint must be 405 (no GET stream in this revision).
try {
  const response = await fetch(endpoint, { method: 'GET' });
  report('GET on the MCP endpoint returns 405', response.status === 405, `HTTP ${response.status}`);
} catch (error) {
  report('GET on the MCP endpoint returns 405', false, String(error.message));
}

// 6. A bad access key must be refused.
try {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/mcp/definitely-wrong-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-protocol-version': VERSION, 'mcp-method': 'tools/list' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  report('wrong access key refused with 401', response.status === 401, `HTTP ${response.status}`);
} catch (error) {
  report('wrong access key refused with 401', false, String(error.message));
}

// 7. Legacy initialize handshake still answered (needed by older clients).
try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
    }),
  });
  const json = await response.json();
  report(
    'legacy initialize handshake still answered',
    response.status === 200 && !!json?.result?.protocolVersion,
    `negotiated ${json?.result?.protocolVersion}`,
  );
} catch (error) {
  report('legacy initialize handshake still answered', false, String(error.message));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
