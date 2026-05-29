/**
 * operators.js — The nine operators
 *
 * A closed algebra of transformation. Every change to application state
 * decomposes into one or more of these. Dependency-ordered:
 *
 *   NUL → SIG → INS → SEG → CON → SYN → DEF → EVA → REC
 *
 * NUL and SIG are ephemeral (no timeline events). The remaining seven
 * populate the room timeline and feed the fold.
 *
 * Anchors are content-addressed: hash of (entity_type + payload + sender + ts).
 * Same inputs produce the same anchor — idempotent INS.
 * Git model: hash for identity, hash for change.
 */

import { getClient } from './client.js';
import { enqueue } from './outbox.js';

// ── Optimistic dispatch hook ──
// main.js installs this so emit() can apply the operator to the
// in-memory state immediately, before the server echoes the event back.
// The hook receives a plain event object the same shape onTimeline
// hands to the store.
let optimisticHook = null;
export function setOptimisticHook(fn) { optimisticHook = fn; }

// ── Namespace ──

let NS = 'io.matrix-events';

export function setNamespace(namespace) { NS = namespace; }
export function getNamespace() { return NS; }

// ── Fast hash (cyrb53) ──
// 53-bit hash, excellent distribution, not crypto. Used for
// content-addressed anchors (git-style: identity = hash of content).
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// ── Operator definitions ──

export const OP = {
  NUL: { key: 'nul', glyph: '∅', triad: 'existence',    order: 0, stored: false },
  SIG: { key: 'sig', glyph: '○', triad: 'existence',    order: 1, stored: false },
  INS: { key: 'ins', glyph: '●', triad: 'existence',    order: 2, stored: true  },
  SEG: { key: 'seg', glyph: '｜', triad: 'structure',    order: 3, stored: true  },
  CON: { key: 'con', glyph: '⋈', triad: 'structure',    order: 4, stored: true  },
  SYN: { key: 'syn', glyph: '△', triad: 'structure',    order: 5, stored: true  },
  DEF: { key: 'def', glyph: '⊢', triad: 'significance', order: 6, stored: true  },
  EVA: { key: 'eva', glyph: '⊨', triad: 'significance', order: 7, stored: true  },
  REC: { key: 'rec', glyph: '⊛', triad: 'significance', order: 8, stored: true  },
};

export function eventType(op) {
  return `${NS}.${op.key}`;
}

export function parseEventType(type) {
  if (!type.startsWith(NS + '.')) return null;
  const suffix = type.slice(NS.length + 1);
  return Object.values(OP).find(op => op.key === suffix) || null;
}

// ── Emit ──

/**
 * Emit an operator event into a room.
 *
 * Goes through the outbox: the operation is persisted locally (and
 * folded into in-memory state immediately, via the optimistic hook),
 * then flushed to the homeserver by the OutboxFlusher when the network
 * is available. The returned id is the local txnId — the same value
 * appears as `unsigned.transaction_id` on the echoed timeline event,
 * so callers can correlate.
 */
export async function emit(roomId, op, content) {
  if (!op.stored) {
    throw new Error(`${op.key} is ephemeral and cannot be emitted to the timeline`);
  }
  const client = getClient();
  const sender = client ? client.getUserId() : 'anon';

  const record = await enqueue({ roomId, eventType: eventType(op), content });

  if (optimisticHook) {
    try {
      optimisticHook({
        roomId,
        event: {
          type: eventType(op),
          content,
          origin_server_ts: Date.now(),
          sender,
          event_id: record.localId,
          _pending: true,
        },
      });
    } catch (e) {
      console.warn('[operators] optimistic hook failed:', e);
    }
  }

  return record.localId;
}

// ── Convenience emitters ──

/**
 * INS — Instantiate a new entity.
 *
 * Anchor is content-addressed: hash of (type + payload + sender + timestamp).
 * Git model — the identity IS the hash of what created it.
 * Same creation event produces the same anchor (idempotent INS).
 * Different creation events always produce different anchors (no-cloning).
 */
export async function ins(roomId, entityType, payload = {}) {
  const client = getClient();
  const sender = client ? client.getUserId() : 'anon';
  const ts = Date.now();

  // Content-addressed anchor: hash of creation content
  const input = `${entityType}\0${JSON.stringify(payload)}\0${sender}\0${ts}`;
  const hash = cyrb53(input);
  const anchor = `${entityType}_${hash.toString(16)}`;

  await emit(roomId, OP.INS, { anchor, entity_type: entityType, payload });
  return anchor;
}

/** DEF — Set a value within the current frame. */
export async function def(roomId, anchor, path, value) {
  return emit(roomId, OP.DEF, { anchor, path, value });
}

/** DEF targeting schema — no anchor, path auto-prefixed with _schema. */
export async function defSchema(roomId, path, value) {
  return emit(roomId, OP.DEF, { anchor: null, path: '_schema.' + path, value });
}

/** SEG — Move an entity across a partition boundary. */
export async function seg(roomId, anchor, partition) {
  return emit(roomId, OP.SEG, { anchor, partition });
}

/** CON — Create a typed relationship between two anchors. */
export async function con(roomId, sourceAnchor, targetAnchor, relationType) {
  return emit(roomId, OP.CON, {
    source_anchor: sourceAnchor,
    target_anchor: targetAnchor,
    relation_type: relationType,
  });
}

/** SYN — Merge multiple entities into a synthesized whole. */
export async function syn(roomId, inputAnchors, output) {
  return emit(roomId, OP.SYN, { input_anchors: inputAnchors, output });
}

/** EVA — Evaluate an entity against a criterion. */
export async function eva(roomId, anchor, criterion, result, note = '') {
  return emit(roomId, OP.EVA, { anchor, criterion, result, note });
}

/** REC — Recontextualize: change what the data means. */
export async function rec(roomId, scope, beforeFrame, afterFrame) {
  return emit(roomId, OP.REC, { scope, before_frame: beforeFrame, after_frame: afterFrame });
}
