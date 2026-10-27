/**
 * Which of two version.txt values a build may write over the other.
 *
 * Its own module because the property is behavioural — "a rebuild must never lower the number" — and
 * a gate that reads build-web's source can only assert the SHAPE of the decision. One was written
 * that way first and stayed green with the guard deleted: the helper's own definitions still matched
 * every pattern it looked for. This can be called with real values instead.
 */

/** Numeric rank of a version tag, or null when it is not one. */
export function rank(bytes) {
  const m = String(bytes).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  // Compared as numbers, never as text: "v1.0.9" sorts AFTER "v1.0.46" as a string, which waves
  // through exactly the regression this exists to stop.
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : null;
}

/**
 * True when `incoming` may replace `current`.
 *
 * `current` absent or unreadable → yes: there is nothing to lose, and a bundle with no version at
 * all is the case the copy was introduced for. `incoming` unreadable → no: refusing keeps a good
 * value, while writing replaces a real version with something that is not one.
 */
export function mayReplaceVersion(current, incoming) {
  const there = rank(incoming);
  if (there === null) return false;
  if (current === null || current === undefined) return true;
  const here = rank(current);
  if (here === null) return true;
  return there >= here;
}

/**
 * What the minimal bundles' version should become, or why it may not change.
 *
 * 🚨 EXTRACTED FOR THE SAME REASON `mayReplaceVersion` WAS. A gate that reads
 * bump-minimal-version.mjs can only assert the SHAPE of these rules; this can be called with real
 * values. The precedent is written at the top of this file — the first version-guard gate stayed
 * green with the guard deleted, because the helper's own definitions matched every pattern it
 * looked for.
 *
 * @param values  what each bundle's version.txt currently reads, in bundle order
 * @param asked   an explicit version, or undefined for a patch bump
 * @returns {{ next: string } | { error: string }}
 */
export function nextMinimalVersion(values, asked) {
  const trimmed = (values || []).map((v) => String(v == null ? '' : v).trim());
  if (trimmed.length === 0) return { error: 'no bundles to read' };
  if (trimmed.some((v) => v === '')) return { error: 'a bundle has no version at all' };

  // Two bundles that already disagree are a fault to fix, not an input to choose from: bumping
  // would pick one arbitrarily and bury how they diverged. The publisher refuses to release a
  // disagreement anyway, so failing here reports it one step earlier and with the values named.
  const distinct = [...new Set(trimmed)];
  if (distinct.length !== 1) return { error: `the bundles disagree: ${distinct.join(', ')}` };

  const from = distinct[0];
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(from);
  if (!parts) return { error: `"${from}" is not a version tag` };

  const next = asked
    ? (String(asked).startsWith('v') ? String(asked) : `v${asked}`)
    : `v${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
  if (!/^v\d+\.\d+\.\d+$/.test(next)) return { error: `"${next}" is not a version tag` };

  // STRICTLY greater, not merely "not older". Re-stamping a number that has already been released
  // is how a publish ends up describing bytes that went out under that name — which is the exact
  // failure the publisher's read-from-the-artefact rule exists to prevent.
  if (!(rank(next) > rank(from))) {
    return { error: `${next} is not newer than ${from} — a release track only moves forward` };
  }
  return { next };
}
