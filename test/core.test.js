import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZonedTime } from '../src/index.js';

/**
 * Tests are deterministic and assert against known epoch values derived from
 * fixed historical/lawful DST transitions. No wall-clock dependence.
 */

test('unique time in America/New_York resolves to correct UTC epoch', () => {
  // 2024-07-15T12:30 in New York is EDT (UTC-4), unambiguous.
  // 12:30 local - (-4h) = 16:30 UTC => epoch 1721051400000.
  const r = normalizeZonedTime('2024-07-15T12:30', 'America/New_York');
  assert.equal(r.outcome, 'unique');
  assert.equal(r.epochMillis, Date.UTC(2024, 6, 15, 16, 30));
});

test('UTC zone produces unique outcome equal to the UTC epoch', () => {
  const r = normalizeZonedTime('2024-01-01T00:00', 'UTC');
  assert.equal(r.outcome, 'unique');
  assert.equal(r.epochMillis, Date.UTC(2024, 0, 1, 0, 0));
});

test('ambiguous fall-back time resolves to the earlier occurrence', () => {
  // America/New_York fall-back 2024: clocks 02:00 -> 01:00 EDT->EST on Nov 3.
  // 01:30 local occurs twice. Earlier is 01:30 EDT (UTC-4) => 05:30 UTC.
  // Later would be 01:30 EST (UTC-5) => 06:30 UTC.
  const r = normalizeZonedTime('2024-11-03T01:30', 'America/New_York');
  assert.equal(r.outcome, 'earlier');
  assert.equal(r.epochMillis, Date.UTC(2024, 10, 3, 5, 30));
});

test('non-existent spring-forward time resolves to post-gap instant', () => {
  // America/New_York spring-forward 2024: clocks 02:00 -> 03:00 EST->EDT on Mar 10.
  // 02:30 local does not exist. Policy: advance to post-transition side.
  // Advancing 02:30 by the 1-hour gap yields 03:30 EDT, which is 07:30 UTC (UTC-4).
  const r = normalizeZonedTime('2024-03-10T02:30', 'America/New_York');
  assert.equal(r.outcome, 'gap');
  // The returned epoch must be a real instant whose wall clock is a valid time.
  assert.equal(r.epochMillis, Date.UTC(2024, 2, 10, 7, 30));
});

test('gap result lands on a real wall-clock time after the transition', () => {
  const r = normalizeZonedTime('2024-03-10T02:30', 'America/New_York');
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(r.epochMillis));
  let hh = '', mm = '';
  for (const p of parts) {
    if (p.type === 'hour') hh = p.value;
    if (p.type === 'minute') mm = p.value;
  }
  // After springing forward from 02:00 to 03:00, 02:30 advanced by the gap lands at 03:30.
  assert.equal(hh, '03');
  assert.equal(mm, '30');
});

test('ambiguous time an hour before the fall-back transition is unique', () => {
  // 2024-11-03T00:30 in New York is EDT (UTC-4), unambiguous.
  const r = normalizeZonedTime('2024-11-03T00:30', 'America/New_York');
  assert.equal(r.outcome, 'unique');
  assert.equal(r.epochMillis, Date.UTC(2024, 10, 3, 4, 30));
});

test('ambiguous time an hour after the fall-back transition is unique', () => {
  // 2024-11-03T03:00 in New York is EST (UTC-5), unambiguous.
  const r = normalizeZonedTime('2024-11-03T03:00', 'America/New_York');
  assert.equal(r.outcome, 'unique');
  assert.equal(r.epochMillis, Date.UTC(2024, 10, 3, 8, 0));
});

test('Europe/London ambiguous time resolves to earlier occurrence', () => {
  // London fall-back 2024: clocks 02:00 BST -> 01:00 GMT on Oct 27.
  // 01:30 occurs twice. Earlier is 01:30 BST (UTC+1) => 00:30 UTC.
  const r = normalizeZonedTime('2024-10-27T01:30', 'Europe/London');
  assert.equal(r.outcome, 'earlier');
  assert.equal(r.epochMillis, Date.UTC(2024, 9, 27, 0, 30));
});

test('Australia/Sydney spring-forward gap is detected', () => {
  // Sydney springs forward 2024-10-06: 02:00 -> 03:00 AEST->AEDT (UTC+10 -> UTC+11).
  // 02:30 does not exist.
  const r = normalizeZonedTime('2024-10-06T02:30', 'Australia/Sydney');
  assert.equal(r.outcome, 'gap');
});

test('seconds and fractional seconds are honored', () => {
  // 2024-07-15T12:30:45.500 New York EDT (UTC-4) => 16:30:45.500 UTC.
  const r = normalizeZonedTime('2024-07-15T12:30:45.500', 'America/New_York');
  assert.equal(r.outcome, 'unique');
  assert.equal(r.epochMillis, Date.UTC(2024, 6, 15, 16, 30, 45, 500));
});

test('space separator is accepted in place of T', () => {
  const r = normalizeZonedTime('2024-07-15 12:30', 'America/New_York');
  assert.equal(r.outcome, 'unique');
  assert.equal(r.epochMillis, Date.UTC(2024, 6, 15, 16, 30));
});

test('invalid timezone throws RangeError', () => {
  assert.throws(
    () => normalizeZonedTime('2024-07-15T12:30', 'Not/A/Zone'),
    RangeError,
  );
});

test('malformed local datetime throws RangeError', () => {
  assert.throws(
    () => normalizeZonedTime('2024-07-15', 'America/New_York'),
    RangeError,
  );
});
