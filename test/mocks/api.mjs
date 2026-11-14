/** In-memory stand-ins for @forge/api. Tests set globalThis.__jira, __confluence and __twg. */
export const route = (strings, ...values) =>
  strings.reduce((out, part, i) => out + part + (i < values.length ? encodeURIComponent(values[i]) : ''), '');

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

export default {
  asUser: () => ({
    requestJira: async (path, options) => globalThis.__jira(path, json, options),
    requestConfluence: async (path) => globalThis.__confluence(path, json),
    requestTeamworkGraph: async (query, variables, operationName) =>
      (globalThis.__twg ? globalThis.__twg(query, variables, json, operationName) : json({ data: {} }))
  }),
  // Calls made as the app (for example from a product-event trigger) are flagged with `asApp`.
  asApp: () => ({
    requestJira: async (path, options) => globalThis.__jira(path, json, { ...options, asApp: true })
  })
};

export const startsWith = (value) => ({ condition: 'STARTS_WITH', value });

// The app now stores everything through @forge/kvs, so the legacy storage stand-in shares its map:
// tests that inspect `memory` see the same records the app writes.
import { kvsMemory } from './kvs.mjs';
export const memory = kvsMemory;
globalThis.__memory = memory;

export const storage = {
  get: async (key) => memory.get(key),
  set: async (key, value) => {
    if (key.length > 500) throw new Error('storage key too long');
    memory.set(key, structuredClone(value));
  },
  delete: async (key) => {
    memory.delete(key);
  },
  query() {
    const q = { prefix: '', limit: 10, cursor: 0 };
    const builder = {
      where(_field, condition) { q.prefix = condition.value; return builder; },
      limit(n) { if (n > 20) throw new Error('Forge storage pages hold at most 20 entries'); q.limit = n; return builder; },
      cursor(c) { q.cursor = Number(c); return builder; },
      async getMany() {
        const all = [...memory.entries()].filter(([key]) => key.startsWith(q.prefix)).sort();
        const page = all.slice(q.cursor, q.cursor + q.limit).map(([key, value]) => ({ key, value }));
        return { results: page, nextCursor: q.cursor + q.limit < all.length ? String(q.cursor + q.limit) : undefined };
      }
    };
    return builder;
  }
};
