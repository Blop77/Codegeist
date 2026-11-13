/**
 * In-memory stand-in for @forge/kvs. Plain keys and custom-entity keys share one map, as the
 * app's keys never collide. Tests can set `globalThis.__kvsHook = async (op, key) => …` to pause
 * inside a read or before a write, which lets two invocations interleave the way separate Forge
 * invocations can.
 */
export const kvsMemory = new Map();

const hook = async (op, key) => {
  if (globalThis.__kvsHook) await globalThis.__kvsHook(op, key);
};

export class Filter {
  and(attribute, condition) {
    this.attribute = attribute;
    this.condition = condition;
    return this;
  }
}

export const FilterConditions = { equalTo: (value) => value };

const conditionHolds = (key, conditions) => {
  if (!conditions) return true;
  const value = kvsMemory.get(key);
  // A condition on a key that does not exist fails. The app never relies on that case.
  return value !== undefined && value?.[conditions.attribute] === conditions.condition;
};

export const kvs = {
  get: async (key) => {
    const value = structuredClone(kvsMemory.get(key));
    await hook('get', key);
    return value;
  },
  set: async (key, value, options) => {
    await hook('set', key);
    if (options?.keyPolicy === 'FAIL_IF_EXISTS' && kvsMemory.has(key)) throw new Error('Key already exists');
    kvsMemory.set(key, structuredClone(value));
  },
  delete: async (key) => {
    kvsMemory.delete(key);
  },
  entity: () => kvs,
  /** Conditional sets and deletes, applied together only if every condition holds. */
  transact() {
    const ops = [];
    const builder = {
      // Conditions only exist on custom entities, so a conditional write must name its entity,
      // as the real SDK requires; without it the write would land in the plain key-value store.
      set(key, value, entity) {
        if (entity?.conditions && !entity?.entityName) throw new Error('entityName is required with conditions');
        ops.push({ type: 'set', key, value, conditions: entity?.conditions });
        return builder;
      },
      delete(key, entity) {
        if (entity?.conditions && !entity?.entityName) throw new Error('entityName is required with conditions');
        ops.push({ type: 'delete', key, conditions: entity?.conditions });
        return builder;
      },
      async execute() {
        for (const op of ops) await hook('transact', op.key);
        if (!ops.every((op) => conditionHolds(op.key, op.conditions))) throw new Error('Condition not met');
        for (const op of ops) {
          if (op.type === 'set') kvsMemory.set(op.key, structuredClone(op.value));
          else kvsMemory.delete(op.key);
        }
      }
    };
    return builder;
  }
};
