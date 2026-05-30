/**
 * parseflights.js — interpret reassembled raw bytes as flight records.
 *
 * Carries no Matrix imports (only domain + stream helpers), so it is unit
 * testable and reusable. Honours the manifest's declared payload_format:
 * gunzips when needed, then parses NDJSON or a JSON / GeoJSON array. Used when
 * a chained-raw dataset is small enough to hold in memory.
 */

import { toRecord } from './dfr.js';
import { gunzip, isGzip } from './packset.js';
import { streamElements } from './jsonstream.js';

const decoder = new TextDecoder();
async function* oneChunk(text) { yield text; }

export async function flightsFromBytes(bytes, payloadFormat) {
  let buf = bytes;
  if ((payloadFormat === 'gzip' || payloadFormat === 'gzip-ndjson' || isGzip(bytes)) && isGzip(buf)) {
    buf = await gunzip(buf);
  }
  const text = decoder.decode(buf).replace(/^﻿/, '');
  const head = text.slice(0, 4096).trimStart();
  const out = [];

  const arrayOrFeatureColl =
    head.startsWith('[') || (head.startsWith('{') && /"features"\s*:/.test(head));

  if (payloadFormat !== 'ndjson' && arrayOrFeatureColl) {
    for await (const el of streamElements(oneChunk(text))) out.push(toRecord(el));
  } else {
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(toRecord(JSON.parse(s))); } catch { /* skip bad line */ }
    }
  }
  return out;
}
