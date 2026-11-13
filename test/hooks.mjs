/**
 * Node module hooks for the tests: swap the Forge packages for in-memory mocks, and resolve the
 * extensionless relative imports the Forge bundler accepts (`./scan`, `../domain/extractDecisions`).
 */
const MOCKS = {
  '@forge/api': new URL('./mocks/api.mjs', import.meta.url).href,
  '@forge/resolver': new URL('./mocks/resolver.mjs', import.meta.url).href,
  '@forge/kvs': new URL('./mocks/kvs.mjs', import.meta.url).href,
  '@forge/llm': new URL('./mocks/llm.mjs', import.meta.url).href,
  '@forge/events': new URL('./mocks/events.mjs', import.meta.url).href
};

export async function resolve(specifier, context, next) {
  if (MOCKS[specifier]) return { url: MOCKS[specifier], shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier)) {
      for (const extension of ['.ts', '.js', '/index.js']) {
        try {
          return await next(specifier + extension, context);
        } catch {
          // Try the next extension.
        }
      }
    }
    throw error;
  }
}
