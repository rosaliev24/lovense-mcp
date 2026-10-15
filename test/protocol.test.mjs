import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import worker from '../src/index.js';

const ENDPOINT = 'https://lovense-mcp.example.workers.dev/mcp/test-key';
const VERSION = '2026-07-28';

const ENV = {
  LOVENSE_TOKEN: 'test-lovense-token',
  MCP_ACCESS_KEY: 'test-key',
  LOVENSE_UID: 'test-uid',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Capture outbound Lovense API calls.
 * @param {(url: string, init: RequestInit) => unknown} [responder]
 */
function captureLovense(responder) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    const payload = responder?.(String(url), init) ?? { result: true, code: 200, message: 'Success' };
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

/**
 * Build a spec-compliant 2026-07-28 request. Pass `null` for a header value to
 * omit it, which is how the header-validation tests exercise failure paths.
 *
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @param {{headers?: Record<string, string | null>, id?: number | null, url?: string}} [options]
 */
function modernRequest(method, params = {}, { headers = {}, id = 1, url = ENDPOINT } = {}) {
  const body = {
    jsonrpc: '2.0',
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': VERSION,
        'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  if (id !== null) body.id = id;

  /** @type {Record<string, string | null>} */
  const merged = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': VERSION,
    'mcp-method': method,
    ...(method === 'tools/call' ? { 'mcp-name': String(params.name ?? '') } : {}),
    ...headers,
  };
  const finalHeaders = new Headers();
  for (const [key, value] of Object.entries(merged)) {
    if (value !== null) finalHeaders.set(key, value);
  }
  return new Request(url, { method: 'POST', headers: finalHeaders, body: JSON.stringify(body) });
}

/** @param {Request} request */
async function send(request, env = ENV) {
  const response = await worker.fetch(request, env);
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

/** Call a tool and return the parsed result. */
async function callTool(name, args = {}) {
  return send(modernRequest('tools/call', { name, arguments: args }));
}

describe('transport', () => {
  it('rejects GET on the MCP endpoint with 405', async () => {
    const response = await worker.fetch(new Request(ENDPOINT, { method: 'GET' }), ENV);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  });

  it('rejects DELETE on the MCP endpoint with 405', async () => {
    const response = await worker.fetch(new Request(ENDPOINT, { method: 'DELETE' }), ENV);
    assert.equal(response.status, 405);
  });

  it('rejects a request with no access key', async () => {
    const { response, json } = await send(
      modernRequest('tools/list', {}, { url: 'https://example.workers.dev/mcp' }),
    );
    assert.equal(response.status, 401);
    assert.match(json.error.message, /access key/i);
  });

  it('rejects a request with the wrong access key', async () => {
    const { response } = await send(
      modernRequest('tools/list', {}, { url: 'https://example.workers.dev/mcp/nope' }),
    );
    assert.equal(response.status, 401);
  });

  it('accepts the access key as a bearer token', async () => {
    const { response } = await send(
      modernRequest(
        'tools/list',
        {},
        { url: 'https://example.workers.dev/mcp', headers: { authorization: 'Bearer test-key' } },
      ),
    );
    assert.equal(response.status, 200);
  });

  it('tolerates a secret stored with a trailing newline', async () => {
    // `echo key | wrangler secret put` stores the shell's newline too.
    const { response } = await send(modernRequest('tools/list'), {
      ...ENV,
      MCP_ACCESS_KEY: 'test-key\r\n',
    });
    assert.equal(response.status, 200);
  });

  it('tolerates whitespace around a presented bearer token', async () => {
    const { response } = await send(
      modernRequest(
        'tools/list',
        {},
        { url: 'https://example.workers.dev/mcp', headers: { authorization: 'Bearer test-key  ' } },
      ),
    );
    assert.equal(response.status, 200);
  });

  it('treats a whitespace-only MCP_ACCESS_KEY as unconfigured', async () => {
    const { response, json } = await send(modernRequest('tools/list'), { ...ENV, MCP_ACCESS_KEY: '   ' });
    assert.equal(response.status, 401);
    assert.match(json.error.message, /MCP_ACCESS_KEY/);
  });

  it('fails closed when no MCP_ACCESS_KEY is configured', async () => {
    const { response, json } = await send(modernRequest('tools/list'), {
      ...ENV,
      MCP_ACCESS_KEY: undefined,
    });
    assert.equal(response.status, 401);
    assert.match(json.error.message, /MCP_ACCESS_KEY/);
  });

  it('rejects a disallowed origin with 403', async () => {
    const { response } = await send(
      modernRequest('tools/list', {}, { headers: { origin: 'http://evil.example.com' } }),
    );
    assert.equal(response.status, 403);
  });

  it('answers a notification with 202 and no body', async () => {
    const request = modernRequest('notifications/initialized', {}, { id: null });
    const response = await worker.fetch(request, ENV);
    assert.equal(response.status, 202);
    assert.equal(await response.text(), '');
  });
});

describe('header/body validation (SEP-2243)', () => {
  it('rejects an Mcp-Method that disagrees with the body', async () => {
    const { response, json } = await send(
      modernRequest('tools/list', {}, { headers: { 'mcp-method': 'tools/call' } }),
    );
    assert.equal(response.status, 400);
    assert.equal(json.error.code, -32020);
    assert.match(json.error.message, /Mcp-Method/);
  });

  it('rejects a missing MCP-Protocol-Version header', async () => {
    const { response, json } = await send(
      modernRequest('tools/list', {}, { headers: { 'mcp-protocol-version': null } }),
    );
    assert.equal(response.status, 400);
    assert.equal(json.error.code, -32020);
  });

  it('rejects a missing Mcp-Name on tools/call', async () => {
    const { response, json } = await send(
      modernRequest('tools/call', { name: 'lovense_stop', arguments: {} }, { headers: { 'mcp-name': null } }),
    );
    assert.equal(response.status, 400);
    assert.equal(json.error.code, -32020);
    assert.match(json.error.message, /Mcp-Name/);
  });

  it('rejects an Mcp-Name that disagrees with the body', async () => {
    const { response, json } = await send(
      modernRequest(
        'tools/call',
        { name: 'lovense_stop', arguments: {} },
        { headers: { 'mcp-name': 'lovense_thrust' } },
      ),
    );
    assert.equal(response.status, 400);
    assert.equal(json.error.code, -32020);
  });

  it('accepts a Base64 sentinel Mcp-Name', async () => {
    captureLovense();
    const encoded = `=?base64?${Buffer.from('lovense_stop', 'utf8').toString('base64')}?=`;
    const { response } = await send(
      modernRequest('tools/call', { name: 'lovense_stop', arguments: {} }, { headers: { 'mcp-name': encoded } }),
    );
    assert.equal(response.status, 200);
  });

  it('rejects a request whose _meta omits clientCapabilities', async () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION } },
    };
    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': VERSION,
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify(body),
    });
    const { response, json } = await send(request);
    assert.equal(response.status, 400);
    assert.equal(json.error.code, -32602);
  });
});

describe('version negotiation', () => {
  it('rejects an unknown protocol version with -32022 and lists supported versions', async () => {
    const request = new Request(ENDPOINT, {
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
    const { response, json } = await send(request);
    assert.equal(response.status, 400);
    assert.equal(json.error.code, -32022);
    assert.ok(json.error.data.supported.includes(VERSION));
    assert.equal(json.error.data.requested, '1900-01-01');
  });

  it('implements server/discover', async () => {
    const { response, json } = await send(modernRequest('server/discover'));
    assert.equal(response.status, 200);
    assert.equal(json.result.resultType, 'complete');
    assert.equal(json.result.supportedVersions[0], VERSION);
    assert.ok(json.result.capabilities.tools);
    assert.equal(json.result.serverInfo.name, 'lovense-mcp');
  });

  it('still answers the legacy initialize handshake', async () => {
    const request = new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'legacy-client', version: '1.0.0' },
        },
      }),
    });
    const { response, json } = await send(request);
    assert.equal(response.status, 200);
    assert.equal(json.result.protocolVersion, '2025-06-18');
    assert.ok(json.result.serverInfo);
  });

  it('returns 404 with -32601 for an unknown method', async () => {
    const { response, json } = await send(modernRequest('resources/list'));
    assert.equal(response.status, 404);
    assert.equal(json.error.code, -32601);
  });
});

describe('tools/list', () => {
  it('returns the tool set with caching metadata', async () => {
    const { response, json } = await send(modernRequest('tools/list'));
    assert.equal(response.status, 200);
    assert.equal(json.result.resultType, 'complete');
    assert.equal(typeof json.result.ttlMs, 'number');
    assert.ok(['public', 'private'].includes(json.result.cacheScope));
    assert.equal(json.result._meta['io.modelcontextprotocol/serverInfo'].name, 'lovense-mcp');

    const names = json.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'lovense_pair_qr',
      'lovense_thrust',
      'lovense_vibrate',
      'lovense_stop',
      'lovense_pattern',
      'lovense_custom_pattern',
    ]);
    for (const tool of json.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  it('is deterministic across calls', async () => {
    const first = await send(modernRequest('tools/list'));
    const second = await send(modernRequest('tools/list'));
    assert.deepEqual(first.json.result.tools, second.json.result.tools);
  });
});

describe('device control', () => {
  it('sends a Thrusting function command', async () => {
    const calls = captureLovense();
    const { json } = await callTool('lovense_thrust', { speed: 12, duration_sec: 30 });

    assert.equal(json.result.isError, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/lan\/v2\/command$/);
    assert.deepEqual(calls[0].body, {
      token: 'test-lovense-token',
      uid: 'test-uid',
      command: 'Function',
      action: 'Thrusting:12',
      timeSec: 30,
      apiVer: 1,
    });
    assert.match(json.result.content[0].text, /Thrusting speed set to 12\/20 for 30s/);
  });

  it('treats thrusting speed 0 as a stop', async () => {
    const calls = captureLovense();
    await callTool('lovense_thrust', { speed: 0 });
    assert.equal(calls[0].body.action, 'Stop');
  });

  it('sends a Vibrate function command', async () => {
    const calls = captureLovense();
    await callTool('lovense_vibrate', { strength: 7 });
    assert.equal(calls[0].body.action, 'Vibrate:7');
    assert.equal(calls[0].body.timeSec, 0);
  });

  it('sends Stop', async () => {
    const calls = captureLovense();
    const { json } = await callTool('lovense_stop', {});
    assert.equal(calls[0].body.action, 'Stop');
    assert.equal(json.result.content[0].text, 'Stopped.');
  });

  it('targets a single toy when given a toy id', async () => {
    const calls = captureLovense();
    await callTool('lovense_thrust', { speed: 5, toy: 'abc123' });
    assert.equal(calls[0].body.toy, 'abc123');
  });

  it('rejects an out-of-range speed as a tool error, not a protocol error', async () => {
    const calls = captureLovense();
    const { response, json } = await callTool('lovense_thrust', { speed: 99 });
    assert.equal(response.status, 200);
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /between 0 and 20/);
    assert.equal(calls.length, 0, 'no Lovense call should be made for invalid input');
  });

  it('clamps an over-long duration to one hour', async () => {
    const calls = captureLovense();
    await callTool('lovense_thrust', { speed: 5, duration_sec: 99999 });
    assert.equal(calls[0].body.timeSec, 3600);
  });

  it('returns -32602 for an unknown tool', async () => {
    const { response, json } = await callTool('lovense_teleport', {});
    assert.equal(response.status, 400);
    assert.equal(json.error.code, -32602);
  });
});

describe('patterns', () => {
  it('sends a preset as a Pattern command on the vibrate channel by default', async () => {
    const calls = captureLovense();
    const { json } = await callTool('lovense_pattern', { preset: 'waves', duration_sec: 120 });

    assert.equal(json.result.isError, false);
    assert.equal(calls[0].body.command, 'Pattern');
    assert.equal(calls[0].body.apiVer, 2);
    assert.equal(calls[0].body.rule, 'V:1;F:v;S:900#');
    assert.equal(calls[0].body.strength, '4;7;11;15;18;20;18;15;11;7;4;3');
    assert.equal(calls[0].body.timeSec, 120);
  });

  it('can still target the thrusting channel explicitly', async () => {
    const calls = captureLovense();
    await callTool('lovense_pattern', { preset: 'pulse', function: 'thrusting' });
    assert.equal(calls[0].body.rule, 'V:1;F:t;S:800#');
  });

  it('can drive both motors', async () => {
    const calls = captureLovense();
    await callTool('lovense_pattern', { preset: 'pulse', function: 'both' });
    assert.equal(calls[0].body.rule, 'V:1;F:t,v;S:800#');
  });

  it('rejects an unknown preset', async () => {
    const calls = captureLovense();
    const { json } = await callTool('lovense_pattern', { preset: 'nope' });
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /Unknown preset/);
    assert.equal(calls.length, 0);
  });

  it('rejects an unknown function name', async () => {
    const calls = captureLovense();
    const { json } = await callTool('lovense_pattern', { preset: 'pulse', function: 'levitate' });
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /function must be one of/);
    assert.equal(calls.length, 0);
  });

  it('builds a custom waveform', async () => {
    const calls = captureLovense();
    await callTool('lovense_custom_pattern', { steps: [0, 5, 10, 20], interval_ms: 1000 });
    assert.equal(calls[0].body.rule, 'V:1;F:v;S:1000#');
    assert.equal(calls[0].body.strength, '0;5;10;20');
  });

  it('raises a sub-100ms interval to the Lovense minimum', async () => {
    const calls = captureLovense();
    await callTool('lovense_custom_pattern', { steps: [10], interval_ms: 101 });
    assert.equal(calls[0].body.rule, 'V:1;F:v;S:101#');
  });

  it('rejects a step value above 20', async () => {
    const calls = captureLovense();
    const { json } = await callTool('lovense_custom_pattern', { steps: [10, 25] });
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /steps\[1\]/);
    assert.equal(calls.length, 0);
  });

  it('rejects more than 50 steps', async () => {
    const { json } = await callTool('lovense_custom_pattern', { steps: new Array(51).fill(5) });
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /at most 50/);
  });
});

describe('pairing', () => {
  it('returns the QR url, the code, and an inlined image', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const calls = captureLovense((url) => {
      if (url.endsWith('/api/lan/getQrCode')) {
        return { code: 0, message: 'Success', result: true, data: { qr: 'https://cdn.lovense.com/qr/x.jpg', code: '482913' } };
      }
      return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });

    const { json } = await callTool('lovense_pair_qr', { nickname: 'Bedroom' });

    assert.equal(calls[0].body.uname, 'Bedroom');
    assert.equal(calls[0].body.v, 2);
    assert.equal(calls[0].body.token, 'test-lovense-token');
    assert.match(calls[0].body.utoken, /^[0-9a-f]{32}$/, 'utoken should be a derived hex digest');

    assert.equal(json.result.structuredContent.qrUrl, 'https://cdn.lovense.com/qr/x.jpg');
    assert.equal(json.result.structuredContent.code, '482913');
    const image = json.result.content.find((item) => item.type === 'image');
    assert.ok(image, 'the QR image should be inlined');
    assert.equal(image.mimeType, 'image/jpeg');
    assert.equal(Buffer.from(image.data, 'base64').length, jpeg.length);
  });

  it('derives a stable utoken across calls', async () => {
    const responder = () => ({ code: 0, result: true, data: { qr: 'https://cdn.lovense.com/qr/x.jpg', code: '1' } });
    const first = captureLovense(responder);
    await callTool('lovense_pair_qr', {});
    const second = captureLovense(responder);
    await callTool('lovense_pair_qr', {});
    assert.equal(first[0].body.utoken, second[0].body.utoken);
  });

  it('surfaces a Lovense API rejection as a tool error', async () => {
    captureLovense(() => ({ code: 401, result: false, message: 'Invalid token' }));
    const { response, json } = await callTool('lovense_thrust', { speed: 10 });
    assert.equal(response.status, 200);
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /Invalid token/);
  });

  it('reports a missing LOVENSE_TOKEN as an actionable tool error', async () => {
    captureLovense();
    const request = modernRequest('tools/call', { name: 'lovense_stop', arguments: {} });
    const { json } = await send(request, { ...ENV, LOVENSE_TOKEN: undefined });
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /wrangler secret put LOVENSE_TOKEN/);
  });
});

describe('lovense callback', () => {
  it('acknowledges the toy-status callback', async () => {
    const response = await worker.fetch(
      new Request('https://lovense-mcp.example.workers.dev/lovense/callback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uid: 'test-uid', toys: {} }),
      }),
      ENV,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result, true);
  });

  it('answers GET so a dashboard URL probe sees a live endpoint', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(
        new Request('https://lovense-mcp.example.workers.dev/lovense/callback', { method }),
        ENV,
      );
      assert.equal(response.status, 200, `${method} should be 200`);
    }
  });
});
