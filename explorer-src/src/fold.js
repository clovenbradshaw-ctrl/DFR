/**
 * fold.js — The integral fold
 *
 * State is never stored. It is always derived by folding the event stream.
 *
 *   state(t) = fold(dispatch, initial, events[0..t])
 *
 * The fold is a nine-case dispatch. Each event carries its operator type.
 * The fold applies each event to the accumulator and produces the current
 * state at any cursor position.
 *
 * Dependency ordering gives the fold three properties:
 *
 * 1. Helix high-water mark (_hwm) per entity — the highest operator
 *    order that has fired. The dispatcher uses this to detect violations
 *    structurally (EVA without prior DEF = criterionless judgment) without
 *    replaying the log.
 *
 * 2. Short-circuit potential — an entity at _hwm=2 (INS only) cannot
 *    have EVA or REC results. Queries skip what the helix says isn't there.
 *
 * 3. Concurrency map — entities with no CON between them have disjoint
 *    causal chains. Partition by anchor, fold in parallel, synchronize
 *    only at CON boundaries. The _hwm metadata enables this.
 *
 * The fold is permissive: it processes whatever the log contains.
 * Violations are flagged in state._violations, never blocked.
 * The linter diagnoses; the fold records.
 */

import { parseEventType, OP } from './operators.js';

/**
 * @typedef {Object} FoldState
 * @property {Object<string, Entity>} entities      - Anchor → entity
 * @property {Object<string, string>} partitions    - Anchor → partition name
 * @property {Array<Connection>}      connections   - Typed links between anchors
 * @property {Array<Frame>}           frames        - REC events (paradigm shifts)
 * @property {Object}                 schema        - DEF events targeting _schema.* paths
 * @property {number}                 cursor        - Timestamp of last processed event
 * @property {number}                 _undecryptable - Events still encrypted
 * @property {Array}                  _violations    - Dependency ordering violations
 * @property {string}                 _stateHash     - Content hash of entities for change detection
 */

/**
 * Create an empty initial state.
 */
export function initial() {
  return {
    entities: {},
    partitions: {},
    connections: [],
    frames: [],
    schema: {},
    cursor: 0,
    _undecryptable: 0,
    _violations: [],
  };
}

// ── Helpers ──

function setPath(obj, path, value) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ── Fast content hash (cyrb53) ──
// Used for state change detection and content-addressed identity.
// 53-bit hash with excellent distribution. Not crypto — speed.
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

export { cyrb53 };

// ── Dispatch ──

/**
 * Dispatch a single event into the accumulator.
 * Mutates state in place for performance. Returns state.
 *
 * Each operator case:
 *   1. Validates structural prerequisites
 *   2. Applies the transformation
 *   3. Updates the entity's helix high-water mark (_hwm)
 *   4. Flags dependency violations (permissive — never blocks)
 */
function dispatch(state, event) {
  const type = typeof event.getType === 'function' ? event.getType() : event.type;
  const content = typeof event.getContent === 'function' ? event.getContent() : event.content;
  const ts = typeof event.getTs === 'function' ? event.getTs() : event.origin_server_ts || 0;
  const sender = typeof event.getSender === 'function' ? event.getSender() : event.sender;
  const eventId = typeof event.getId === 'function' ? event.getId() : event.event_id || null;

  if (type === 'm.room.encrypted') {
    state._undecryptable++;
    return state;
  }

  if (!content || Object.keys(content).length === 0) return state;

  const op = parseEventType(type);
  if (!op) return state;

  state.cursor = ts;

  switch (op) {
    case OP.INS: {
      const { anchor, entity_type, payload } = content;
      if (!anchor) break;
      state.entities[anchor] = {
        ...payload,
        _anchor: anchor,
        _type: entity_type,
        _created: ts,
        _sender: sender,
        _eventId: eventId,
        _hwm: OP.INS.order,
      };
      break;
    }

    case OP.SEG: {
      const { anchor, partition } = content;
      if (!anchor) break;
      const entity = state.entities[anchor];
      if (!entity) {
        // SEG on non-existent entity — INS dependency missing
        state._violations.push({
          type: 'missing_ins', op: 'SEG', anchor, _ts: ts,
        });
        break;
      }
      state.partitions[anchor] = partition;
      entity._partition = partition;
      entity._updated = ts;
      if (OP.SEG.order > entity._hwm) entity._hwm = OP.SEG.order;
      break;
    }

    case OP.CON: {
      const { source_anchor, target_anchor, relation_type } = content;

      // CON bridges two entities — this is the serialization boundary.
      // Flag if either endpoint doesn't exist (Cartesian product).
      const srcMissing = !state.entities[source_anchor];
      const tgtMissing = !state.entities[target_anchor];
      if (srcMissing || tgtMissing) {
        state._violations.push({
          type: 'cartesian_product', op: 'CON',
          source: source_anchor, target: target_anchor,
          missing: srcMissing && tgtMissing ? 'both' : srcMissing ? 'source' : 'target',
          _ts: ts,
        });
      }

      state.connections.push({
        source: source_anchor,
        target: target_anchor,
        type: relation_type,
        _ts: ts,
        _sender: sender,
        _eventId: eventId,
      });

      // Advance _hwm on both endpoints if they exist
      const src = state.entities[source_anchor];
      const tgt = state.entities[target_anchor];
      if (src && OP.CON.order > src._hwm) src._hwm = OP.CON.order;
      if (tgt && OP.CON.order > tgt._hwm) tgt._hwm = OP.CON.order;
      break;
    }

    case OP.SYN: {
      const { input_anchors, output } = content;
      const synAnchor = eventId ? `syn_${eventId}` : `syn_${ts}_${sender || 'anon'}`;

      // Flag missing inputs
      if (input_anchors) {
        for (const ia of input_anchors) {
          if (!state.entities[ia]) {
            state._violations.push({
              type: 'missing_ins', op: 'SYN', anchor: ia, _ts: ts,
            });
          }
        }
      }

      state.entities[synAnchor] = {
        ...output,
        _anchor: synAnchor,
        _type: '_synthesis',
        _inputs: input_anchors,
        _created: ts,
        _sender: sender,
        _eventId: eventId,
        _hwm: OP.SYN.order,
      };
      break;
    }

    case OP.DEF: {
      const { anchor, path, value } = content;

      // Schema DEF: no anchor, path starts with _schema
      if (!anchor && path?.startsWith('_schema.')) {
        setPath(state.schema, path.slice('_schema.'.length), value);
        break;
      }

      if (!anchor) break;
      const entity = state.entities[anchor];
      if (!entity) {
        state._violations.push({
          type: 'missing_ins', op: 'DEF', anchor, _ts: ts,
        });
        break;
      }
      if (path) {
        setPath(entity, path, value);
        entity._updated = ts;
        entity._updatedBy = sender;
      }
      if (OP.DEF.order > entity._hwm) entity._hwm = OP.DEF.order;
      break;
    }

    case OP.EVA: {
      const { anchor, criterion, result, note } = content;
      const entity = state.entities[anchor];
      if (!entity) {
        state._violations.push({
          type: 'missing_ins', op: 'EVA', anchor, _ts: ts,
        });
        break;
      }

      // Criterionless judgment: EVA without prior DEF
      if (entity._hwm < OP.DEF.order) {
        state._violations.push({
          type: 'criterionless_judgment', op: 'EVA', anchor,
          hwm: entity._hwm, required: OP.DEF.order, _ts: ts,
        });
      }

      if (!entity._evaluations) entity._evaluations = [];
      entity._evaluations.push({ criterion, result, note, _ts: ts, _sender: sender });
      if (OP.EVA.order > entity._hwm) entity._hwm = OP.EVA.order;
      break;
    }

    case OP.REC: {
      // Blind restructuring: REC without prior EVA in the system
      const hasAnyEva = Object.values(state.entities).some(e => e._hwm >= OP.EVA.order);
      if (!hasAnyEva && state.frames.length === 0) {
        state._violations.push({
          type: 'blind_restructuring', op: 'REC', _ts: ts,
        });
      }

      state.frames.push({
        ...content,
        _ts: ts,
        _sender: sender,
      });
      break;
    }
  }

  return state;
}

// ── Public API ──

/**
 * Fold an array of events into state from scratch.
 * Events should be in chronological order.
 */
export function fold(events) {
  return events.reduce(dispatch, initial());
}

/**
 * Incremental fold: apply new events onto existing state.
 * O(1) per event — the dependency floor of the incoming operator
 * determines what prior state it reads, not the full history.
 *
 * @param {FoldState} state - Previous state (will be mutated)
 * @param {Array} newEvents - New events in chronological order
 * @returns {FoldState}
 */
export function foldFrom(state, newEvents) {
  return newEvents.reduce(dispatch, state);
}

// ── Query helpers ──

export function entitiesOfType(state, entityType) {
  return Object.values(state.entities).filter(e => e._type === entityType);
}

export function entitiesInPartition(state, partition) {
  return Object.values(state.entities).filter(e => state.partitions[e._anchor] === partition);
}

export function connectionsFor(state, anchor) {
  return state.connections.filter(c => c.source === anchor || c.target === anchor);
}

export function currentFrame(state) {
  return state.frames.length > 0 ? state.frames[state.frames.length - 1] : null;
}

/**
 * Entities reachable from a given anchor via CON.
 * Returns the set of anchors in the same causal partition.
 * Entities NOT in this set can be folded in parallel.
 */
export function causalPartition(state, anchor) {
  const visited = new Set();
  const queue = [anchor];
  while (queue.length > 0) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const c of state.connections) {
      if (c.source === current && !visited.has(c.target)) queue.push(c.target);
      if (c.target === current && !visited.has(c.source)) queue.push(c.source);
    }
  }
  return visited;
}

/**
 * Compute a content hash of the current entity state.
 * For change detection: "has anything changed since last render?"
 */
export function stateHash(state) {
  const keys = Object.keys(state.entities).sort();
  let input = '';
  for (const k of keys) {
    const e = state.entities[k];
    input += k + ':' + (e._hwm || 0) + ':' + (e._updated || e._created || 0) + ';';
  }
  input += 'c:' + state.connections.length + ';f:' + state.frames.length;
  // Include schema and partitions so DEF-on-schema and SEG trigger re-render
  const pKeys = Object.keys(state.partitions).sort();
  for (const pk of pKeys) input += 'p:' + pk + '=' + state.partitions[pk] + ';';
  const sKeys = Object.keys(state.schema).sort();
  for (const sk of sKeys) input += 's:' + sk + ';';
  return cyrb53(input);
}
