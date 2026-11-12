export const kvsMemory = new Map();

export class Filter {
  and(attribute, condition) {
    this.attribute = attribute;
    this.condition = condition;
    return this;
  }
}

export const FilterConditions = { equalTo: (value) => value };

export const kvs = {
  get: async (key) => structuredClone(kvsMemory.get(key)),
  set: async (key, value, options) => {
    if (options?.keyPolicy === 'FAIL_IF_EXISTS' && kvsMemory.has(key)) throw new Error('Key already exists');
    kvsMemory.set(key, structuredClone(value));
  },
  delete: async (key) => {
    kvsMemory.delete(key);
  },
  entity: () => kvs,
  transact() {
    return {
      delete(key, { conditions }) {
        return {
          async execute() {
            const value = kvsMemory.get(key);
            if (value?.[conditions.attribute] !== conditions.condition) throw new Error('Condition not met');
            kvsMemory.delete(key);
          }
        };
      }
    };
  }
};
