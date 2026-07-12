export class TurnQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(agentId) ?? Promise.resolve();
    const next = tail.then(fn, fn);
    this.tails.set(agentId, next.catch(() => undefined));
    return next;
  }
}
