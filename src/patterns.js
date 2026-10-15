/**
 * Waveform presets for the Lovense `Pattern` command.
 *
 * A pattern is a list of strength steps (each 0-20) that the toy walks through
 * at a fixed interval, looping until `timeSec` elapses. Lovense caps the list
 * at 50 steps and requires the interval to be greater than 100ms.
 *
 * The presets use long intervals (600-1800ms) so each step is felt as a
 * distinct change rather than a stutter. They play on the Vibrate channel by
 * default, which is the only channel a Lovense Vulse responds to (its push
 * motion and vibration share one motor). Toys with a real thrusting channel
 * can pass `function: "thrusting"`.
 */

export const MAX_STRENGTH = 20;
export const MAX_STEPS = 50;
export const MIN_INTERVAL_MS = 101;

/**
 * Pattern rule feature letters. `v` drives the Vibrate channel, `t` the
 * Thrusting channel (only on toys that have one; not the Vulse).
 */
export const FEATURES = {
  thrusting: 't',
  vibrate: 'v',
  both: 't,v',
};

export const FUNCTION_NAMES = Object.keys(FEATURES);

/** @type {Record<string, {label: string, description: string, intervalMs: number, steps: number[]}>} */
export const PRESETS = {
  slow_build: {
    label: 'Slow build',
    description: 'Very gradual climb from gentle to maximum intensity over about half a minute, then resets.',
    intervalMs: 1800,
    steps: [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 20, 20, 0, 0],
  },
  waves: {
    label: 'Waves',
    description: 'Rolling intensity cycles — rises high, eases back low, repeats without stopping.',
    intervalMs: 900,
    steps: [4, 7, 11, 15, 18, 20, 18, 15, 11, 7, 4, 3],
  },
  pulse: {
    label: 'Pulse',
    description: 'Bursts of high intensity separated by full stops.',
    intervalMs: 800,
    steps: [18, 20, 20, 0, 0, 18, 20, 20, 0, 0],
  },
  tease: {
    label: 'Tease',
    description: 'Long gentle stretches broken by short unpredictable bursts.',
    intervalMs: 1100,
    steps: [3, 3, 4, 3, 18, 20, 4, 3, 3, 0, 0, 5, 20, 20, 4, 3],
  },
  crescendo: {
    label: 'Crescendo',
    description: 'Steady climb to maximum intensity and then holds there — no drop back.',
    intervalMs: 1400,
    steps: [3, 5, 7, 9, 11, 13, 15, 17, 19, 20, 20, 20, 20, 20, 20, 20],
  },
  relentless: {
    label: 'Relentless',
    description: 'Sustained high intensity with irregular jolts, never dropping low.',
    intervalMs: 600,
    steps: [16, 20, 17, 20, 18, 20, 15, 20, 19, 20],
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

/** Human-readable list used in the tool description so the model can pick sensibly. */
export function describePresets() {
  return PRESET_NAMES.map((name) => `"${name}" — ${PRESETS[name].description}`).join('\n');
}

/**
 * Validate and normalise a custom step list.
 * @param {unknown} steps
 * @returns {number[]}
 */
export function normaliseSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new RangeError('steps must be a non-empty array of numbers');
  }
  if (steps.length > MAX_STEPS) {
    throw new RangeError(`steps must contain at most ${MAX_STEPS} values (got ${steps.length})`);
  }
  return steps.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`steps[${index}] must be a number`);
    }
    const rounded = Math.round(value);
    if (rounded < 0 || rounded > MAX_STRENGTH) {
      throw new RangeError(`steps[${index}] must be between 0 and ${MAX_STRENGTH} (got ${value})`);
    }
    return rounded;
  });
}

/**
 * Resolve a friendly function name ("thrusting", "vibrate", "both") to the
 * feature letters the Lovense rule string uses.
 *
 * @param {string} [name]
 * @returns {string}
 */
export function resolveFeatures(name = 'vibrate') {
  const letters = FEATURES[name];
  if (!letters) {
    throw new RangeError(`function must be one of: ${FUNCTION_NAMES.join(', ')} (got "${name}")`);
  }
  return letters;
}

/**
 * Build the `rule` / `strength` pair the Lovense Pattern command expects.
 *
 * @param {{steps: number[], intervalMs: number, features?: string}} input
 * @returns {{rule: string, strength: string}}
 */
export function buildPattern({ steps, intervalMs, features = FEATURES.vibrate }) {
  const normalised = normaliseSteps(steps);
  const interval = Math.max(MIN_INTERVAL_MS, Math.round(intervalMs));
  return {
    rule: `V:1;F:${features};S:${interval}#`,
    strength: normalised.join(';'),
  };
}
