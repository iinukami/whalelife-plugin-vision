/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { MultimodalToolOutput, ToolDefinition } from 'whalelife';

type VisualOutput = MultimodalToolOutput<Record<string, unknown>>;
type VisualTool<A> = ToolDefinition<A, VisualOutput>;

function cancelled(name: string): VisualOutput {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'cancelled',
      message: '本次视觉调用已取消或设置已更新，请按当前设置重新调用。' }) }],
    receipt: { action: name, outcome: 'failed', code: 'cancelled' },
  };
}

/** One runtime's public visual tools and complete invocations, including result transport. */
export class VisualToolScope {
  #closed = false;
  #controller = new AbortController();
  #disposers = new Set<() => void>();
  #pending = new Set<Promise<unknown>>();
  #disposeFailed = false;
  #stopping?: Promise<void>;

  wrap<A>(tool: VisualTool<A>): VisualTool<A>;
  // Local transport projects inside the tracked call, before the final cancellation check.
  wrap<A, Result>(tool: VisualTool<A>, project: (output: VisualOutput) => Result): ToolDefinition<A, Result>;
  wrap<A, Result = VisualOutput>(tool: VisualTool<A>, project?: (output: VisualOutput) => Result): ToolDefinition<A, Result | VisualOutput> {
    const convert = (output: VisualOutput) => project ? project(output) : output;
    return { ...tool, run: (args, session) => {
      const signal = session.signal ? AbortSignal.any([session.signal, this.#controller.signal]) : this.#controller.signal;
      const stopped = () => this.#closed || signal.aborted;
      if (stopped()) return convert(cancelled(tool.name));
      // Defer entry until the promise is registered: even a synchronous run may close its scope.
      const pending = Promise.resolve().then(async () => {
        if (stopped()) return convert(cancelled(tool.name));
        try {
          const output = await tool.run(args, { ...session, signal });
          if (stopped()) return convert(cancelled(tool.name));
          const result = convert(output);
          return stopped() ? convert(cancelled(tool.name)) : result;
        } catch (error) {
          if (stopped()) return convert(cancelled(tool.name));
          throw error;
        }
      });
      this.#pending.add(pending);
      // Both handlers resolve, so cleanup never creates an unhandled rejection.
      void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
      return pending;
    } };
  }

  add(disposer: () => void): void {
    if (this.#closed) this.#dispose(disposer);
    else this.#disposers.add(disposer);
  }

  #dispose(disposer: () => void): void {
    try { disposer(); }
    catch { this.#disposeFailed = true; }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    const disposers = [...this.#disposers];
    this.#disposers.clear();
    for (const dispose of disposers) this.#dispose(dispose);
  }

  stop(): Promise<void> {
    this.close();
    return this.#stopping ??= Promise.allSettled([...this.#pending]).then(() => {
      if (this.#disposeFailed) throw new Error('视觉工具入口撤销失败，未完成设置切换。');
    });
  }
}
