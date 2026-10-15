/**
 * Thin client for the Lovense Standard (server) API.
 *
 * Docs: https://developer.lovense.com/docs/standard-solutions/standard-api.html
 *
 * Two endpoints are used:
 *   POST /api/lan/getQrCode   — mint a pairing QR for the Lovense Remote app
 *   POST /api/lan/v2/command  — send Function / Pattern / Stop commands
 */

const DEFAULT_BASE_URL = 'https://api.lovense-api.com';
const REQUEST_TIMEOUT_MS = 10_000;

export class LovenseError extends Error {
  /** @param {string} message @param {{code?: number, body?: unknown}} [meta] */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LovenseError';
    this.code = meta.code;
    this.body = meta.body;
  }
}

/**
 * Derive a stable per-user token. Lovense uses `utoken` to stop a third party
 * who learns your `uid` from taking over the toy, so it must be unguessable
 * but identical across calls. Deriving it via HMAC keeps the worker stateless.
 *
 * @param {string} uid
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function deriveUserToken(uid, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`lovense-utoken:${uid}`));
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export class LovenseClient {
  /** @param {{token: string, uid: string, utoken: string, baseUrl?: string}} config */
  constructor({ token, uid, utoken, baseUrl = DEFAULT_BASE_URL }) {
    this.token = token;
    this.uid = uid;
    this.utoken = utoken;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * @param {string} path
   * @param {Record<string, unknown>} payload
   * @returns {Promise<any>}
   */
  async #post(path, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') {
        throw new LovenseError(`Lovense API request to ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new LovenseError(`Could not reach the Lovense API: ${cause?.message ?? cause}`);
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new LovenseError(
        `Lovense API returned a non-JSON response (HTTP ${response.status}): ${raw.slice(0, 200)}`,
      );
    }

    if (!response.ok) {
      throw new LovenseError(`Lovense API returned HTTP ${response.status}`, { body });
    }

    // The API signals success two different ways depending on the endpoint:
    // getQrCode uses code 0, the command endpoint uses code 200.
    const code = body?.code;
    const ok = body?.result === true || code === 0 || code === 200;
    if (!ok) {
      throw new LovenseError(body?.message || `Lovense API rejected the request (code ${code})`, {
        code,
        body,
      });
    }
    return body;
  }

  /**
   * Mint a pairing QR code. Scanning it in the Lovense Remote app binds that
   * user's toys to our `uid`, after which commands can be addressed to it.
   *
   * @param {{uname?: string}} [options]
   * @returns {Promise<{qr: string, code: string}>}
   */
  async createPairingQr({ uname = 'Claude' } = {}) {
    const body = await this.#post('/api/lan/getQrCode', {
      token: this.token,
      uid: this.uid,
      uname,
      utoken: this.utoken,
      v: 2,
    });
    const qr = body?.data?.qr;
    if (!qr) {
      throw new LovenseError('Lovense returned a success code but no QR image URL', { body });
    }
    return { qr, code: body?.data?.code ?? '' };
  }

  /**
   * Send a simple Function command, e.g. `Vibrate:12` or `Stop`.
   *
   * @param {{action: string, timeSec?: number, toy?: string, loopRunningSec?: number, loopPauseSec?: number}} options
   */
  async sendFunction({ action, timeSec = 0, toy, loopRunningSec, loopPauseSec }) {
    /** @type {Record<string, unknown>} */
    const payload = {
      token: this.token,
      uid: this.uid,
      command: 'Function',
      action,
      timeSec,
      apiVer: 1,
    };
    if (toy) payload.toy = toy;
    if (loopRunningSec !== undefined) payload.loopRunningSec = loopRunningSec;
    if (loopPauseSec !== undefined) payload.loopPauseSec = loopPauseSec;
    return this.#post('/api/lan/v2/command', payload);
  }

  /**
   * Send a Pattern command built by `patterns.js`.
   *
   * @param {{rule: string, strength: string, timeSec?: number, toy?: string}} options
   */
  async sendPattern({ rule, strength, timeSec = 0, toy }) {
    /** @type {Record<string, unknown>} */
    const payload = {
      token: this.token,
      uid: this.uid,
      command: 'Pattern',
      rule,
      strength,
      timeSec,
      apiVer: 2,
    };
    if (toy) payload.toy = toy;
    return this.#post('/api/lan/v2/command', payload);
  }

  /** Stop every running command on all connected toys. */
  async stopAll({ toy } = {}) {
    return this.sendFunction({ action: 'Stop', timeSec: 0, toy });
  }
}
