/** Stand-in for @forge/llm. Tests set globalThis.__chat; calls are recorded in __llmCalls. */
export async function chat(request) {
  (globalThis.__llmCalls ??= []).push(request);
  return globalThis.__chat(request);
}
