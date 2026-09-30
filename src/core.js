/**
 * Zoned Event Normalizer
 *
 * Converts a local time with a timezone identifier into the correct UTC epoch
 * milliseconds, handling ambiguous and non-existent times during DST transitions.
 *
 * Interpretation decisions (stated plainly so callers know what they get):
 *
 * 1. We rely on the host platform's Intl.DateTimeFormat for timezone data.
 *    The platform is the source of truth for zone rules. We do not bundle tzdata.
 *
 * 2. For AMBIGUOUS times (a local time that occurs twice during a fall-back
 *    transition), we resolve to the EARLIER occurrence (the one before the
 *    transition, i.e. the one that is still on the pre-transition offset).
 *    Rationale: earlier-of-duplicate is the most common default and is least
 *    surprising for scheduling systems that stamp events created "at" a local
 *    time before the clocks changed.
 *
 * 3. For NON-EXISTENT times (a local time skipped by a spring-forward
 *    transition), we resolve to the first instant AFTER the gap — i.e. the
 *    moment the clock reads on the post-transition side, advanced by the gap
 *    duration from the start of the gap. Practically: we move the time forward
 *    by the offset delta so it lands on a real, valid instant.
 *
 * These three rules are the whole policy. Do not expect alternative policies;
 * wrap this module if you need them.
 */

/**
 * Outcome of a normalization attempt.
 *
 * - 'unique'   : the local time maps to exactly one UTC instant.
 * - 'earlier'  : the local time was ambiguous (fall-back) and we chose the
 *                earlier of the two possible instants.
 * - 'later'    : the local time was ambiguous (fall-back) and we chose the
 *                later of the two possible instants. (Never returned by the
 *                default policy; present for completeness and future use.)
 * - 'gap'      : the local time did not exist (spring-forward); we advanced
 *                into a real instant.
 *
 * @typedef {string} ResolvedTime
 */

/**
 * Parse an ISO-like local datetime string "YYYY-MM-DDTHH:MM" (seconds optional,
 * fractional seconds optional) into a UTC base epoch assuming the fields were
 * in UTC. This is the inverse of building a Date from UTC components.
 *
 * Why parse manually instead of using Date.parse on the local string? Because
 * implementations differ wildly on how they treat strings without a zone suffix,
 * and we need the components in UTC regardless of the target zone.
 *
 * @param {string} localDateTime
 * @returns {{utcBaseEpoch: number, hour: number, minute: number}}
 */
function parseLocalFields(localDateTime) {
  // Accept "YYYY-MM-DDTHH:MM[:SS[.sss]]" or "YYYY-MM-DD HH:MM[:SS[.sss]]".
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(localDateTime);
  if (!m) {
    throw new RangeError(`Invalid local datetime string: ${JSON.stringify(localDateTime)}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;
  const fracStr = m[7] ?? '';
  let ms = 0;
  if (fracStr) {
    // pad/truncate to 3 digits for milliseconds
    const padded = (fracStr + '000').slice(0, 3);
    ms = Number(padded);
  }
  // Validate ranges defensively (Date.UTC will also normalize, but we want a clear error).
  if (month < 1 || month > 12) throw new RangeError(`Month out of range: ${month}`);
  if (day < 1 || day > 31) throw new RangeError(`Day out of range: ${day}`);
  if (hour > 23 || minute > 59 || second > 60) {
    throw new RangeError(`Time out of range: ${hour}:${minute}:${second}`);
  }
  const utcBaseEpoch = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  return { utcBaseEpoch, hour, minute };
}

/**
 * Get the zone offset (in minutes) at a given UTC epoch, for a zone.
 *
 * Uses Intl.DateTimeFormat with timeZoneName: 'shortOffset' when available, and
 * falls back to parsing the 'longOffset' form. shortOffset yields strings like
 * "GMT+5:30" or "GMT-4" or "GMT" (for UTC). We parse the sign, hours, minutes.
 *
 * @param {string} timeZone
 * @param {number} epochMillis
 * @returns {number} offset in minutes east of UTC
 */
function offsetAtUtc(timeZone, epochMillis) {
  const d = new Date(epochMillis);
  // shortOffset is widely supported in modern V8/Node; longOffset is the fallback.
  let parts;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    });
    parts = fmt.formatToParts(d);
  } catch (_) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    });
    parts = fmt.formatToParts(d);
  }
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  if (!tzPart) {
    throw new RangeError(`Could not determine offset for zone ${JSON.stringify(timeZone)} at ${epochMillis}`);
  }
  return parseOffsetString(tzPart.value);
}

/**
 * Parse an offset string like "GMT", "GMT+5:30", "GMT-4", "UTC+0".
 * @param {string} s
 * @returns {number} minutes east of UTC
 */
function parseOffsetString(s) {
  // Normalize: strip "GMT" or "UTC" prefix.
  let rest = s.replace(/^(GMT|UTC)/, '').trim();
  if (rest === '' || rest === '+0' || rest === '-0' || rest === '0') return 0;
  const m = /^([+-])(\d{1,2})(?::(\d{2}))?$/.exec(rest);
  if (!m) {
    // Some platforms may emit "GMT-04:00" with a colon already; the regex covers that.
    // If still no match, it's something unexpected — fail loudly.
    throw new RangeError(`Unparseable offset string: ${JSON.stringify(s)}`);
  }
  const sign = m[1] === '+' ? 1 : -1;
  const hours = Number(m[2]);
  const minutes = m[3] ? Number(m[3]) : 0;
  return sign * (hours * 60 + minutes);
}

/**
 * Compute the wall-clock fields in the zone at a given UTC epoch.
 * Returns hour/minute in the zone's local time.
 *
 * @param {string} timeZone
 * @param {number} epochMillis
 * @returns {{hour: number, minute: number}}
 */
function wallClockInZone(timeZone, epochMillis) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(epochMillis));
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'hour') hour = Number(p.value);
    if (p.type === 'minute') minute = Number(p.value);
  }
  // hour12:false can still produce "24" on some platforms for midnight; normalize to 0.
  if (hour === 24) hour = 0;
  return { hour, minute };
}

/**
 * Normalize a local datetime in a zone to UTC epoch milliseconds.
 *
 * @param {string} localDateTime - e.g. "2024-11-03T01:30"
 * @param {string} timeZone - IANA timezone identifier, e.g. "America/New_York"
 * @returns {{ epochMillis: number, outcome: ResolvedTime }}
 */
export function normalizeZonedTime(localDateTime, timeZone) {
  if (typeof localDateTime !== 'string') {
    throw new TypeError('localDateTime must be a string');
  }
  if (typeof timeZone !== 'string') {
    throw new TypeError('timeZone must be a string');
  }
  // Validate the zone by constructing a formatter; throws RangeError if unknown.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch (e) {
    throw new RangeError(`Unknown or unsupported timezone: ${JSON.stringify(timeZone)}`);
  }

  const { utcBaseEpoch, hour, minute } = parseLocalFields(localDateTime);

  // Candidate 1: treat the wall-clock fields as being at the offset that is in
  // effect slightly BEFORE the UTC instant that has the same numeric value.
  // We probe the offset at utcBaseEpoch - 6h and utcBaseEpoch + 6h to find the
  // two candidate offsets that might bracket a transition. Then for each
  // candidate offset we compute the UTC instant = utcBaseEpoch - offsetMinutes*60000
  // and check whether the wall clock at that instant actually reads (hour, minute).

  const probeBefore = offsetAtUtc(timeZone, utcBaseEpoch - 6 * 3600_000);
  const probeAfter = offsetAtUtc(timeZone, utcBaseEpoch + 6 * 3600_000);

  const candidates = new Set([probeBefore, probeAfter]);

  /** @type {number[]} */
  const validEpochs = [];
  /** @type {number[]} */
  const validOffsets = [];

  for (const offMin of candidates) {
    const epoch = utcBaseEpoch - offMin * 60_000;
    const wc = wallClockInZone(timeZone, epoch);
    if (wc.hour === hour && wc.minute === minute) {
      validEpochs.push(epoch);
      validOffsets.push(offMin);
    }
  }

  if (validEpochs.length === 0) {
    // Non-existent time (spring-forward gap).
    // Policy: advance into the post-transition real time. We do this by taking
    // the offset in effect just after the gap (probeAfter) and computing the
    // epoch as utcBaseEpoch - probeAfter*60000. Because the wall time was
    // skipped, that epoch will be a real instant whose wall clock reads the
    // first valid time after the gap. To be precise and match "advance by the
    // gap", we instead compute the offset that would apply if the time existed
    // at the later side: take the smaller (more negative / pre-transition for
    // spring-forward) offset so the resulting epoch lands in the post-gap
    // real time, with the wall clock advanced by the gap duration.
    const postOffset = Math.min(probeBefore, probeAfter);
    const epoch = utcBaseEpoch - postOffset * 60_000;
    return { epochMillis: epoch, outcome: 'gap' };
  }

  if (validEpochs.length === 1) {
    return { epochMillis: validEpochs[0], outcome: 'unique' };
  }

  // Two valid instants => ambiguous (fall-back). Pick the earlier epoch.
  // The earlier epoch corresponds to the larger offset (more east before fall-back).
  // Sort ascending by epoch.
  const idxSorted = validEpochs
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e - b.e);
  const earliest = idxSorted[0];
  return { epochMillis: earliest.e, outcome: 'earlier' };
}

export const ResolvedTime = ['unique', 'earlier', 'later', 'gap'];
