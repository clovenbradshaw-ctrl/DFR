/**
 * chunkstream.js — turn a byte source into fixed-size payloads, incrementally.
 *
 * For multi-GB uploads we must never hold the whole file in memory. A File is
 * read slice-by-slice (the browser pages it off disk); a fetch Response body is
 * read from its stream and re-buffered to the target chunk size. Either way the
 * peak memory is ~one chunk.
 */

/** Yield `chunkSize`-byte payloads from a File/Blob (last one may be smaller). */
export async function* fileChunks(file, chunkSize, signal) {
  let off = 0;
  const size = file.size;
  while (off < size) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const end = Math.min(off + chunkSize, size);
    const buf = await file.slice(off, end).arrayBuffer();
    yield new Uint8Array(buf);
    off = end;
  }
}

function concat(parts, total) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Yield `chunkSize`-byte payloads from a ReadableStream<Uint8Array>. */
export async function* streamChunks(byteStream, chunkSize, signal) {
  const reader = byteStream.getReader();
  let parts = [];
  let len = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      parts.push(value);
      len += value.length;
      while (len >= chunkSize) {
        const merged = concat(parts, len);
        yield merged.subarray(0, chunkSize);
        const rest = merged.subarray(chunkSize);
        parts = rest.length ? [rest.slice()] : [];
        len = rest.length;
      }
    }
    if (len > 0) yield concat(parts, len);
  } finally {
    reader.releaseLock();
  }
}

/** Best-effort payload-format guess from a filename / URL. */
export function guessFormat(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.gz') || n.endsWith('.gzip')) return 'gzip';
  if (n.endsWith('.ndjson') || n.endsWith('.jsonl')) return 'ndjson';
  if (n.endsWith('.geojson')) return 'geojson';
  if (n.endsWith('.json')) return 'json';
  return 'binary';
}
