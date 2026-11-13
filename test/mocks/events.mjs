/**
 * Stand-in for @forge/events. Pushed events wait in globalThis.__queued until a test hands them to
 * the consumer, as Forge would. Set globalThis.__queueFail to make a push throw.
 */
export class Queue {
  constructor({ key }) {
    this.key = key;
  }

  async push(event) {
    if (globalThis.__queueFail) throw new Error('Queue unavailable');
    (globalThis.__queued ??= []).push({ queue: this.key, ...structuredClone(event) });
  }
}
