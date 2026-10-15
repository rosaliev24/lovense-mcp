/**
 * Cloudflare Worker entry point — Streamable HTTP transport for MCP 2026-07-28.
 *
 * Routes:
 *   POST /mcp/<access-key>     the MCP endpoint
 *   POST /lovense/callback     Lovense posts toy status here after a QR scan
 *   GET  /                     human-readable status page
 *
 * Per the 2026-07-28 transport binding there is no GET stream and no DELETE
 * session teardown, so both return 405 on the MCP endpoint.
 */

import { ERROR_CODES, PROTOCOL_VERSION, RpcError, SERVER_INFO, SUPPORTED_VERSIONS, dispatch } from './mcp.js';

/**
 * Compare two secrets without leaking their length relationship through timing.
 * @param {string} a @param {string} b
 */
function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Fold length into the result rather than returning early on a mismatch.
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/**
 * The MCP endpoint controls a physical device, so it is closed by default:
 * without MCP_ACCESS_KEY configured the worker serves nothing.
 *
 * @param {Request} request
 * @param {string} pathKey
 * @param {Record<string, any>} env
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function authorize(request, pathKey, env) {
  // Trim both sides. Piping a secret into `wrangler secret put` (rather than
  // pasting it interactively) stores the shell's trailing newline as part of
  // the value, which otherwise makes every request fail with no useful signal.
  // No legitimate access key has leading or trailing whitespace, so this only
  // ever rescues a mis-set secret.
  const expected = (env.MCP_ACCESS_KEY ?? '').trim();
  if (!expected) {
    return {
      ok: false,
      reason:
        'This server has no MCP_ACCESS_KEY configured and refuses to accept requests. ' +
        'Set one with: npx wrangler secret put MCP_ACCESS_KEY',
    };
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  const presented = (pathKey || bearer || '').trim();
  if (!presented || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'Invalid or missing access key.' };
  }
  return { ok: true };
}

/**
 * Reject cross-origin browser traffic (DNS rebinding defence, required by the
 * transport spec). Non-browser clients send no Origin at all and are allowed.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 */
function originAllowed(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return true;

  const allowList = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowList.length > 0) return allowList.includes(origin);

  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') return true;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} id
 * @param {number} code
 * @param {string} message
 * @param {{data?: unknown, status?: number}} [options]
 */
function jsonRpcError(id, code, message, { data, status = 400 } = {}) {
  /** @type {Record<string, unknown>} */
  const error = { code, message };
  if (data !== undefined) error.data = data;
  const body = { jsonrpc: '2.0', error };
  if (id !== undefined && id !== null) body.id = id;
  return Response.json(body, { status });
}

/**
 * @param {Request} request
 * @param {string} pathKey
 * @param {Record<string, any>} env
 */
async function handleMcp(request, pathKey, env) {
  if (request.method !== 'POST') {
    // 2026-07-28 removed the GET stream and DELETE teardown entirely.
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }

  if (!originAllowed(request, env)) {
    return jsonRpcError(null, ERROR_CODES.INVALID_REQUEST, 'Origin not allowed', { status: 403 });
  }

  const auth = authorize(request, pathKey, env);
  if (!auth.ok) {
    return jsonRpcError(null, ERROR_CODES.INVALID_REQUEST, auth.reason, { status: 401 });
  }

  let message;
  try {
    message = await request.json();
  } catch {
    return jsonRpcError(null, ERROR_CODES.PARSE_ERROR, 'Request body is not valid JSON', { status: 400 });
  }

  if (Array.isArray(message)) {
    return jsonRpcError(null, ERROR_CODES.INVALID_REQUEST, 'JSON-RPC batching is not supported', {
      status: 400,
    });
  }

  const id = message?.id;
  const isNotification = id === undefined || id === null;

  try {
    const result = await dispatch(request.headers, message, env);
    if (isNotification) {
      // Notifications get no body, only an acknowledgement.
      return new Response(null, { status: 202 });
    }
    return Response.json({ jsonrpc: '2.0', id, result });
  } catch (error) {
    if (error instanceof RpcError) {
      if (isNotification) {
        return jsonRpcError(null, error.code, error.message, { data: error.data, status: error.status });
      }
      return jsonRpcError(id, error.code, error.message, { data: error.data, status: error.status });
    }
    console.error('Unhandled error while dispatching MCP request', error);
    return jsonRpcError(id ?? null, ERROR_CODES.INTERNAL_ERROR, 'Internal server error', { status: 500 });
  }
}

const INFO_PAGE = [
  `${SERVER_INFO.name} v${SERVER_INFO.version}`,
  '',
  `MCP protocol: ${PROTOCOL_VERSION} (also serves ${SUPPORTED_VERSIONS.slice(1).join(', ')})`,
  'Transport: Streamable HTTP, stateless',
  '',
  'MCP endpoint: POST /mcp/<access-key>',
  'This endpoint controls a physical device and requires an access key.',
  '',
].join('\n');

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Lovense posts the toy list here once a user scans the pairing QR. We are
    // stateless and address toys by uid, so acknowledging is enough.
    //
    // GET and HEAD answer 200 as well: the Lovense dashboard may probe the URL
    // when you save it, and a 405 would read as an unreachable endpoint.
    if (path === '/lovense/callback') {
      if (request.method === 'GET' || request.method === 'HEAD') {
        return Response.json({ result: true, code: 200, message: 'Callback endpoint ready' });
      }
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, POST' } });
      }
      return Response.json({ result: true, code: 200, message: 'Success' });
    }

    const mcpMatch = /^\/mcp(?:\/(.+))?$/.exec(path);
    if (mcpMatch) {
      return handleMcp(request, mcpMatch[1] ?? '', env);
    }

    if (path === '/' && request.method === 'GET') {
      return new Response(INFO_PAGE, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
