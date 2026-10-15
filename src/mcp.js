/**
 * MCP protocol layer for revision 2026-07-28.
 *
 * The 2026-07-28 revision is stateless: there is no `initialize` handshake and
 * no `Mcp-Session-Id`. Each request carries its own protocol version, client
 * identity and capabilities in `params._meta`, mirrored into HTTP headers that
 * the transport layer validates.
 *
 * This server is *dual-era*: it also answers the legacy `initialize` handshake
 * (2025-03-26 through 2025-11-25) so clients that have not moved to the new
 * revision still work. Legacy requests are still handled statelessly — we
 * simply do not require the per-request metadata.
 */

import { TOOLS, UnknownToolError, callTool } from './tools.js';

export const PROTOCOL_VERSION = '2026-07-28';

/** Newest first — this is also the order advertised to clients. */
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

export const LEGACY_VERSIONS = SUPPORTED_VERSIONS.filter((v) => v !== PROTOCOL_VERSION);

export const SERVER_INFO = {
  name: 'lovense-mcp',
  title: 'Lovense Control',
  version: '1.0.0',
};

export const CAPABILITIES = {
  tools: { listChanged: false },
};

/** How long clients may cache `tools/list`. The tool set is static. */
const TOOLS_LIST_TTL_MS = 3_600_000;

const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
};

export const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
};

export class RpcError extends Error {
  /** @param {number} code @param {string} message @param {{data?: unknown, status?: number}} [options] */
  constructor(code, message, { data, status = 400 } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
    this.status = status;
  }
}

/**
 * Decode the Base64 sentinel form clients use for header values that are not
 * plain ASCII: `=?base64?<payload>?=`.
 *
 * @param {string | null} value
 * @returns {string | null}
 */
export function decodeHeaderValue(value) {
  if (value === null || value === undefined) return null;
  const match = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!match) return value;
  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    throw new RpcError(ERROR_CODES.HEADER_MISMATCH, 'Malformed Base64 sentinel in header value');
  }
}

/**
 * Decide which protocol era a request belongs to.
 *
 * @param {Headers} headers
 * @param {any} message
 */
export function resolveProtocolVersion(headers, message) {
  const fromBody = message?.params?._meta?.[META.protocolVersion];
  const fromHeader = headers.get('mcp-protocol-version');
  return { fromBody, fromHeader, version: fromBody ?? fromHeader ?? null };
}

/**
 * Enforce the header/body mirroring rules the 2026-07-28 Streamable HTTP
 * transport requires. A mismatch between what an intermediary routed on and
 * what the server executes is a real security hazard, so this is strict.
 *
 * @param {Headers} headers
 * @param {any} message
 */
export function validateModernHeaders(headers, message) {
  const protocolHeader = headers.get('mcp-protocol-version');
  const bodyVersion = message?.params?._meta?.[META.protocolVersion];

  if (!protocolHeader) {
    throw new RpcError(ERROR_CODES.HEADER_MISMATCH, 'Missing required header: MCP-Protocol-Version');
  }
  if (!bodyVersion) {
    throw new RpcError(
      ERROR_CODES.INVALID_PARAMS,
      'Missing required field: params._meta["io.modelcontextprotocol/protocolVersion"]',
    );
  }
  if (protocolHeader !== bodyVersion) {
    throw new RpcError(
      ERROR_CODES.HEADER_MISMATCH,
      `Header mismatch: MCP-Protocol-Version header value '${protocolHeader}' does not match body value '${bodyVersion}'`,
    );
  }

  const methodHeader = headers.get('mcp-method');
  if (!methodHeader) {
    throw new RpcError(ERROR_CODES.HEADER_MISMATCH, 'Missing required header: Mcp-Method');
  }
  if (methodHeader !== message.method) {
    throw new RpcError(
      ERROR_CODES.HEADER_MISMATCH,
      `Header mismatch: Mcp-Method header value '${methodHeader}' does not match body value '${message.method}'`,
    );
  }

  // `Mcp-Name` mirrors params.name (tools/call, prompts/get) or params.uri
  // (resources/read). Only tools/call is reachable on this server.
  if (message.method === 'tools/call') {
    const nameHeader = decodeHeaderValue(headers.get('mcp-name'));
    if (nameHeader === null) {
      throw new RpcError(ERROR_CODES.HEADER_MISMATCH, 'Missing required header: Mcp-Name');
    }
    if (nameHeader !== message?.params?.name) {
      throw new RpcError(
        ERROR_CODES.HEADER_MISMATCH,
        `Header mismatch: Mcp-Name header value '${nameHeader}' does not match body value '${message?.params?.name}'`,
      );
    }
  }

  if (message?.params?._meta?.[META.clientCapabilities] === undefined) {
    throw new RpcError(
      ERROR_CODES.INVALID_PARAMS,
      'Missing required field: params._meta["io.modelcontextprotocol/clientCapabilities"]',
    );
  }
}

/** Stamp `serverInfo` into a result's `_meta`, as servers SHOULD do. */
function withServerInfo(result) {
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), [META.serverInfo]: SERVER_INFO },
  };
}

function toolsListResult() {
  return {
    resultType: 'complete',
    tools: TOOLS,
    ttlMs: TOOLS_LIST_TTL_MS,
    cacheScope: 'private',
  };
}

/**
 * Handle one JSON-RPC request and return its `result` object.
 *
 * @param {any} message
 * @param {Record<string, any>} env
 * @param {{modern: boolean, version: string | null}} context
 */
export async function handleRequest(message, env, context) {
  const { method, params = {} } = message;

  switch (method) {
    case 'server/discover':
      return withServerInfo({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      });

    case 'tools/list':
      return withServerInfo(toolsListResult());

    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, 'params.name is required and must be a string');
      }
      let result;
      try {
        result = await callTool(name, params.arguments ?? {}, env);
      } catch (error) {
        if (error instanceof UnknownToolError) {
          throw new RpcError(ERROR_CODES.INVALID_PARAMS, error.message);
        }
        throw error;
      }
      return withServerInfo({ resultType: 'complete', ...result });
    }

    // ---- Legacy (initialize-based) compatibility -------------------------
    case 'initialize': {
      const requested = params?.protocolVersion;
      // Answer in the client's version when we know it, otherwise the newest
      // legacy version. A modern client never sends `initialize`.
      const negotiated = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      return {
        protocolVersion: negotiated,
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
        instructions:
          'Controls a Lovense toy via the Lovense Standard API. Call lovense_pair_qr first to link the ' +
          'device, then use lovense_vibrate, lovense_thrust, lovense_pattern, lovense_custom_pattern and ' +
          'lovense_stop. A Lovense Vulse only responds to vibrate; lovense_thrust is for thrusting toys. ' +
          `This server also supports MCP ${PROTOCOL_VERSION} (stateless).`,
      };
    }

    // Client-to-server notifications. This revision defines none over HTTP,
    // but legacy clients still send `notifications/initialized`, and the spec
    // does not define header rules for notification POSTs — so accept the
    // known ones and let the transport answer 202.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return {};

    case 'ping':
      // Removed in 2026-07-28 but still sent by legacy clients as a keepalive.
      if (context.modern) {
        throw new RpcError(ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`, { status: 404 });
      }
      return {};

    default:
      throw new RpcError(ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`, { status: 404 });
  }
}

/**
 * Validate the request against the protocol version rules and dispatch it.
 *
 * @param {Headers} headers
 * @param {any} message
 * @param {Record<string, any>} env
 */
export async function dispatch(headers, message, env) {
  if (message?.jsonrpc !== '2.0' || typeof message?.method !== 'string') {
    throw new RpcError(ERROR_CODES.INVALID_REQUEST, 'Request must be a JSON-RPC 2.0 message with a method');
  }

  const { version } = resolveProtocolVersion(headers, message);
  const isNotification = message.method.startsWith('notifications/');
  const isLegacyHandshake = message.method === 'initialize';

  // A request that names a version we do not implement is rejected outright,
  // with the list the client should retry from.
  if (version && !SUPPORTED_VERSIONS.includes(version) && !isLegacyHandshake && !isNotification) {
    throw new RpcError(ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      data: { supported: SUPPORTED_VERSIONS, requested: version },
    });
  }

  const modern = version === PROTOCOL_VERSION;
  if (modern && !isNotification) {
    validateModernHeaders(headers, message);
  }

  return handleRequest(message, env, { modern, version });
}
