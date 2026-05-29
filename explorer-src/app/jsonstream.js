/**
 * jsonstream.js — dependency-free streaming JSON/NDJSON reading.
 *
 * Pulled out of hydrate.js so it carries no Matrix imports and can be unit
 * tested directly under Node. Uses only Web Streams APIs (ReadableStream,
 * DecompressionStream, TextDecoderStream) available in modern browsers and
 * Node ≥ 18.
 */

/** True if the first bytes are the gzip magic number (0x1f 0x8b). */
export function isGzipMagic(bytes) {
  return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Return a ReadableStream<string> of decoded text, transparently gunzipping
 * when the source is gzip. Works for fetch bodies and File streams.
 */
export async function textStreamFrom(byteStream, { forceGzip = null } = {}) {
  const reader = byteStream.getReader();
  const first = await reader.read();
  reader.releaseLock();

  let gz = forceGzip;
  if (gz === null && first.value) gz = isGzipMagic(first.value);

  const reassembled = new ReadableStream({
    start(controller) {
      if (first.value) controller.enqueue(first.value);
      if (first.done) { controller.close(); return; }
      const r = byteStream.getReader();
      (function pump() {
        r.read().then(({ done, value }) => {
          if (done) { controller.close(); return; }
          controller.enqueue(value);
          pump();
        }).catch(e => controller.error(e));
      })();
    },
  });

  let s = reassembled;
  if (gz && typeof DecompressionStream !== 'undefined') {
    s = s.pipeThrough(new DecompressionStream('gzip'));
  }
  return s.pipeThrough(new TextDecoderStream());
}

export async function* readChunks(textStream, signal) {
  const reader = textStream.getReader();
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Yield each element of the first relevant JSON array in the stream without
 * buffering the whole document. Handles strings/escapes and nested brackets.
 * Targets a top-level array, or the `rootKey` array of a wrapping object
 * (default "features", for GeoJSON FeatureCollections).
 *
 * Assumes the array holds objects (or primitives); it is not a general JSON
 * parser. Sufficient for GeoJSON features and flat row objects.
 */
export async function* streamElements(chunks, { rootKey = 'features' } = {}) {
  let buf = '';
  let phase = 'seek';
  let depth = 0;
  let inStr = false, esc = false;
  let elemStart = -1;
  let i = 0;

  const enterArrayAt = (idx) => { phase = 'array'; i = idx + 1; };

  for await (const chunk of chunks) {
    buf += chunk;

    if (phase === 'seek') {
      const firstNonWs = buf.search(/\S/);
      if (firstNonWs >= 0 && buf[firstNonWs] === '[') {
        enterArrayAt(firstNonWs);
      } else {
        const keyIdx = buf.indexOf('"' + rootKey + '"');
        if (keyIdx >= 0) {
          const br = buf.indexOf('[', keyIdx);
          if (br >= 0) enterArrayAt(br);
        }
      }
      if (phase === 'seek') {
        if (buf.length > 1 << 20) buf = buf.slice(-4096);
        continue;
      }
    }

    for (; i < buf.length; i++) {
      const ch = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { if (depth === 0 && elemStart < 0) elemStart = i; inStr = true; continue; }
      if (ch === '{' || ch === '[') { if (depth === 0 && elemStart < 0) elemStart = i; depth++; continue; }
      if (ch === '}' || ch === ']') {
        if (depth === 0) return; // closing the target array → done
        depth--;
        if (depth === 0 && elemStart >= 0) {
          yield JSON.parse(buf.slice(elemStart, i + 1));
          elemStart = -1;
        }
        continue;
      }
      if (depth === 0) {
        if (ch === ',') {
          if (elemStart >= 0) { yield JSON.parse(buf.slice(elemStart, i)); elemStart = -1; }
          continue;
        }
        if (/\s/.test(ch)) continue;
        if (elemStart < 0) elemStart = i; // start of a primitive element
      }
    }
    const keepFrom = elemStart >= 0 ? elemStart : i;
    if (keepFrom > 0) {
      buf = buf.slice(keepFrom);
      i -= keepFrom;
      if (elemStart >= 0) elemStart -= keepFrom;
    }
  }
}

export async function* streamNdjson(chunks) {
  let buf = '';
  for await (const chunk of chunks) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim());
}
