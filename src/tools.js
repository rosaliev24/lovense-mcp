/**
 * Tool definitions and handlers.
 *
 * Tested on a Lovense Vulse. Although it is marketed as a thrusting egg, the
 * Lovense API exposes only a Vibrate channel for it: its push motion and its
 * vibration come from the same motor, and `Thrusting:N` returns success but the
 * toy does not move. So `Vibrate:0-20` is the default everywhere; the Thrusting
 * channel is still exposed for toys that have one (untested here).
 *
 * Every handler returns a `CallToolResult` body (without `resultType`, which
 * the protocol layer stamps on). Recoverable problems come back as
 * `isError: true` results so the model can correct itself; genuine protocol
 * faults are thrown and become JSON-RPC errors.
 */

import { LovenseClient, LovenseError, deriveUserToken } from './lovense.js';
import {
  FUNCTION_NAMES,
  MAX_STEPS,
  MAX_STRENGTH,
  PRESETS,
  PRESET_NAMES,
  buildPattern,
  describePresets,
  resolveFeatures,
} from './patterns.js';

const MAX_DURATION_SEC = 3600;

const TOY_PROPERTY = {
  type: 'string',
  description: 'Optional Lovense toy ID to target a single toy. Omit to address every connected toy.',
};

const DURATION_PROPERTY = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_DURATION_SEC,
  default: 0,
  description:
    'How long to run, in seconds. 0 means run indefinitely until lovense_stop is called. Maximum 3600.',
};

const FUNCTION_PROPERTY = {
  type: 'string',
  enum: FUNCTION_NAMES,
  default: 'vibrate',
  description:
    'Which channel the pattern drives: "vibrate" (default), "thrusting", or "both". ' +
    'A Vulse only responds to "vibrate"; use "thrusting" only for toys with a thrusting channel.',
};

export const TOOLS = [
  {
    name: 'lovense_pair_qr',
    title: 'Generate pairing QR code',
    description:
      'Generate a Lovense pairing QR code. Scan it with the Lovense Remote mobile app (Discover > scan) ' +
      'to connect your toy to this server. Returns the QR image plus its URL. ' +
      'Run this once before any control commands, and again if the toy stops responding.',
    inputSchema: {
      type: 'object',
      properties: {
        nickname: {
          type: 'string',
          maxLength: 60,
          description: 'Display name shown in the Lovense app for this connection. Defaults to "Claude".',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'lovense_thrust',
    title: 'Set thrusting speed',
    description:
      'Set the thrusting speed on a Lovense toy that has a thrusting channel. Speed runs from 0 (stopped) ' +
      'to 20 (fastest). A Vulse does not respond to this: use lovense_vibrate for a Vulse. ' +
      'Setting speed to 0 stops it.',
    inputSchema: {
      type: 'object',
      properties: {
        speed: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_STRENGTH,
          description: 'Thrusting speed from 0 (stopped) to 20 (fastest).',
        },
        duration_sec: DURATION_PROPERTY,
        toy: TOY_PROPERTY,
      },
      required: ['speed'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'lovense_vibrate',
    title: 'Set vibration strength',
    description:
      'Set the vibration strength on the paired Lovense toy. Strength runs from 0 (off) to 20 (maximum). ' +
      'This is the control for a Vulse: it drives both its push motion and its vibration. ' +
      'Setting strength to 0 stops it.',
    inputSchema: {
      type: 'object',
      properties: {
        strength: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_STRENGTH,
          description: 'Vibration strength from 0 (off) to 20 (maximum).',
        },
        duration_sec: DURATION_PROPERTY,
        toy: TOY_PROPERTY,
      },
      required: ['strength'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'lovense_stop',
    title: 'Stop all activity',
    description: 'Immediately stop all thrusting, vibration and patterns on the paired Lovense toy.',
    inputSchema: {
      type: 'object',
      properties: { toy: TOY_PROPERTY },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'lovense_pattern',
    title: 'Play a waveform preset',
    description:
      'Play a named waveform preset. The preset varies intensity over time and loops until the ' +
      `duration elapses or lovense_stop is called.\n\nAvailable presets:\n${describePresets()}`,
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          enum: PRESET_NAMES,
          description: 'Which waveform preset to play.',
        },
        function: FUNCTION_PROPERTY,
        duration_sec: DURATION_PROPERTY,
        toy: TOY_PROPERTY,
      },
      required: ['preset'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'lovense_custom_pattern',
    title: 'Play a custom waveform',
    description:
      'Play an arbitrary waveform built from a list of speed steps. The toy walks through the steps at a ' +
      `fixed interval and loops. Up to ${MAX_STEPS} steps, each 0-20. For thrusting, keep interval_ms at ` +
      '600ms or above — a mechanical stroke takes time, and shorter steps just produce a stutter.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_STEPS,
          items: { type: 'integer', minimum: 0, maximum: MAX_STRENGTH },
          description: 'Intensity values from 0 to 20, played in order and then looped.',
        },
        interval_ms: {
          type: 'integer',
          minimum: 101,
          maximum: 10000,
          default: 800,
          description:
            'Milliseconds each step is held. Lovense requires more than 100ms; 600-1500ms suits thrusting.',
        },
        function: FUNCTION_PROPERTY,
        duration_sec: DURATION_PROPERTY,
        toy: TOY_PROPERTY,
      },
      required: ['steps'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

/** @param {string} text @param {boolean} [isError] */
function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

/** @param {number} durationSec */
function describeDuration(durationSec) {
  return durationSec > 0 ? `for ${durationSec}s` : 'until stopped';
}

/** @param {unknown} value */
function clampDuration(value) {
  if (value === undefined || value === null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_DURATION_SEC, Math.round(n));
}

/**
 * Build a Lovense client from worker bindings.
 * @param {Record<string, any>} env
 */
async function clientFor(env) {
  const token = env.LOVENSE_TOKEN;
  if (!token) {
    throw new LovenseError(
      'LOVENSE_TOKEN is not configured on this worker. Set it with: npx wrangler secret put LOVENSE_TOKEN',
    );
  }
  const uid = env.LOVENSE_UID || 'claude-mcp';
  const utoken = await deriveUserToken(uid, env.LOVENSE_UTOKEN_SECRET || token);
  return new LovenseClient({ token, uid, utoken, baseUrl: env.LOVENSE_API_BASE_URL });
}

/**
 * Fetch the QR image and inline it so mobile clients render it directly.
 * Falls back to URL-only if the image cannot be retrieved.
 * @param {string} url
 */
async function inlineQrImage(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 900_000) return null;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return {
      type: 'image',
      data: btoa(binary),
      mimeType: response.headers.get('content-type')?.split(';')[0] || 'image/jpeg',
    };
  } catch {
    return null;
  }
}

/**
 * Shared implementation for the two single-motor tools.
 *
 * @param {{action: string, level: unknown, label: string, args: any, env: any}} options
 */
async function setLevel({ action, level, label, args, env }) {
  if (!Number.isInteger(level) || level < 0 || level > MAX_STRENGTH) {
    return textResult(`${label} must be an integer between 0 and ${MAX_STRENGTH} (got ${level}).`, true);
  }
  const durationSec = clampDuration(args.duration_sec);
  const lovense = await clientFor(env);
  // Level 0 through the Function command is accepted, but an explicit Stop is
  // unambiguous and also clears any pattern that is still running.
  if (level === 0) {
    await lovense.stopAll({ toy: args.toy });
    return textResult(`${label} 0 — stopped.`);
  }
  await lovense.sendFunction({ action: `${action}:${level}`, timeSec: durationSec, toy: args.toy });
  return textResult(`${label} set to ${level}/${MAX_STRENGTH} ${describeDuration(durationSec)}.`);
}

/**
 * Shared implementation for the two pattern tools.
 *
 * @param {{steps: number[], intervalMs: number, summary: string, args: any, env: any}} options
 */
async function playPattern({ steps, intervalMs, summary, args, env }) {
  let pattern;
  try {
    pattern = buildPattern({ steps, intervalMs, features: resolveFeatures(args.function) });
  } catch (error) {
    return textResult(String(error.message), true);
  }
  const durationSec = clampDuration(args.duration_sec);
  const lovense = await clientFor(env);
  await lovense.sendPattern({ ...pattern, timeSec: durationSec, toy: args.toy });
  return textResult(`${summary} on ${args.function ?? 'vibrate'} ${describeDuration(durationSec)}.`);
}

/** @type {Record<string, (args: any, env: any) => Promise<any>>} */
const HANDLERS = {
  async lovense_pair_qr(args, env) {
    const lovense = await clientFor(env);
    const { qr, code } = await lovense.createPairingQr({ uname: args.nickname || 'Claude' });
    const image = await inlineQrImage(qr);
    const content = [
      {
        type: 'text',
        text:
          'Pairing QR code ready.\n\nOpen the Lovense Remote app and scan this code to connect your toy.\n' +
          `QR image: ${qr}\n` +
          (code ? `Pairing code: ${code}\n` : '') +
          '\nThe code expires after a few minutes — generate a new one if it stops working.',
      },
    ];
    if (image) content.push(image);
    return { content, isError: false, structuredContent: { qrUrl: qr, code } };
  },

  lovense_thrust(args, env) {
    return setLevel({ action: 'Thrusting', level: args.speed, label: 'Thrusting speed', args, env });
  },

  lovense_vibrate(args, env) {
    return setLevel({ action: 'Vibrate', level: args.strength, label: 'Vibration strength', args, env });
  },

  async lovense_stop(args, env) {
    const lovense = await clientFor(env);
    await lovense.stopAll({ toy: args.toy });
    return textResult('Stopped.');
  },

  lovense_pattern(args, env) {
    const preset = PRESETS[args.preset];
    if (!preset) {
      return Promise.resolve(
        textResult(`Unknown preset "${args.preset}". Available presets: ${PRESET_NAMES.join(', ')}.`, true),
      );
    }
    return playPattern({
      steps: preset.steps,
      intervalMs: preset.intervalMs,
      summary: `Playing "${preset.label}"`,
      args,
      env,
    });
  },

  lovense_custom_pattern(args, env) {
    const intervalMs = args.interval_ms ?? 800;
    return playPattern({
      steps: args.steps,
      intervalMs,
      summary: `Playing a custom ${Array.isArray(args.steps) ? args.steps.length : 0}-step waveform at ${intervalMs}ms per step`,
      args,
      env,
    });
  },
};

/** Raised for a tool name this server does not define — a protocol error, not a tool error. */
export class UnknownToolError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`Unknown tool: ${name}`);
    this.name = 'UnknownToolError';
  }
}

/**
 * Dispatch a tools/call.
 *
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {Record<string, any>} env
 */
export async function callTool(name, args, env) {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new UnknownToolError(name);
  }
  try {
    return await handler(args ?? {}, env);
  } catch (error) {
    if (error instanceof LovenseError) {
      // Surface as a tool execution error: the model (and user) can act on it.
      return textResult(`Lovense API error: ${error.message}`, true);
    }
    if (error instanceof RangeError) {
      // Argument validation — actionable, so the model gets it as a tool error.
      return textResult(String(error.message), true);
    }
    throw error;
  }
}
