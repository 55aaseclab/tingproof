/**
 * 保存协调器：所有「用户数据的持久化」（片段校对、疑点、播放设置）统一经过这里，
 * 保证：
 * - 500ms 防抖合并同目标写入（按 label 去重，后写覆盖前写）；
 * - 状态可订阅：idle / saving / saved(at) / failed(message, 剩余数量)；
 * - 失败绝不静默丢失：出错的及后续操作保留在队列中，可 retry；
 * - 顺序执行，避免对同一记录的并发写竞争。
 */

export type SaveState =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; at: number }
  | { state: "failed"; message: string; failedCount: number };

export interface SaveOp {
  /** 去重键，如 "segment:<id>"、"issue:<id>"。 */
  label: string;
  run: () => Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SaveCoordinator {
  private queue = new Map<string, SaveOp>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  /** 进行中的 flush promise：并发 flush 调用 join 它，直到队列（含执行中入队的新 op）真正处理完。 */
  private activeFlush: Promise<void> | null = null;
  private _state: SaveState = { state: "idle" };
  private listeners = new Set<(s: SaveState) => void>();

  constructor(private debounceMs = 500) {}

  get state(): SaveState {
    return this._state;
  }

  get pendingCount(): number {
    return this.queue.size;
  }

  subscribe(fn: (s: SaveState) => void): () => void {
    this.listeners.add(fn);
    fn(this._state);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private setState(s: SaveState): void {
    this._state = s;
    for (const fn of this.listeners) fn(s);
  }

  /** 加入或替换一个待保存操作（同 label 去重）。 */
  enqueue(label: string, run: () => Promise<void>): void {
    this.queue.set(label, { label, run });
  }

  /** 防抖调度；failed 状态不回退为 saving（失败持续可见，直到重试成功）。 */
  schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this._state.state !== "failed") this.setState({ state: "saving" });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /**
   * 立即落盘（页面隐藏、导航护栏、手动重试时调用）。
   * 并发语义：已有 flush 在执行时，本次调用 join 同一个 activeFlush——
   * 一直等到队列（包括执行期间新入队的 op）真正处理完，并观察最终 saved/failed 状态。
   * 因此 safeNavigate 在“自动保存进行中”调用 flush 不会提前拿到 saving 状态而误放行。
   */
  async flush(): Promise<void> {
    if (this.flushing && this.activeFlush) {
      return this.activeFlush;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.size === 0) {
      if (this._state.state === "saving") this.setState({ state: "saved", at: Date.now() });
      return;
    }
    this.flushing = true;
    this.setState({ state: "saving" });
    const run: Promise<void> = (async () => {
      try {
        while (this.queue.size > 0) {
          const ops = [...this.queue.values()];
          for (const op of ops) {
            await op.run();
            // 只删除“仍是同一个 op 对象”的队列项：
            // 执行期间若同 label 有新 op 入队（Map.set 替换），旧 op 完成后不得连带删除新 op。
            if (this.queue.get(op.label) === op) {
              this.queue.delete(op.label);
            }
          }
        }
        this.setState({ state: "saved", at: Date.now() });
      } catch (err) {
        // 失败的操作与其余未执行操作都保留在队列里，等待 retry。
        this.setState({
          state: "failed",
          message: messageOf(err),
          failedCount: this.queue.size,
        });
      } finally {
        this.flushing = false;
        this.activeFlush = null;
      }
    })();
    this.activeFlush = run;
    return run;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
