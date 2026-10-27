/**
 * P0-1（第 9 轮）：issues 同步并发保护协调器——per-ID version journal + pending token。
 * 从 Workbench 提取以支持确定性单测（第 9 轮审计二-D：旧保存在途→新 mutation→旧 ack）。
 *
 * 可证明的不变量：
 * 1. 单调时钟 clock：mutation/confirm/ack/beginRead 均递增，所有事件全序可比。
 * 2. 本地 mutation（create/resolve/delete）分配 per-ID pending token；
 *    保存成功仅在 token 仍是该 ID 最新时 ack——较旧在途保存不得清新 mutation。
 * 3. confirm 原子结果不进入 pending（服务端已落盘，无后续 issue save 会 ack），
 *    只保护“confirm 发生时在途的旧读”；confirm 之后开始的读取取服务端值
 *    （跨设备后续变化可见，不永久保护）。若 confirm 响应到达时该 ID 存在更晚的
 *    本地 pending mutation（确认在途期间用户又 create/resolve/delete），
 *    保留 local 条目与 token——绝不覆盖/ack/删除本地待保存状态（第 10 轮 P0-1）。
 * 4. 冻结决策 freezeDecisions 在响应到达时同步执行：React 状态更新器是延迟执行的，
 *    且 finally 的 journal 清理先于更新器运行——更新器内不得读取 journal
 *    （第 9 轮 E 例的根因）。决策覆盖 latest ∪ knownLocalIds ∪ journal keys：
 *    更新器执行时 prev 中的任何 ID 必属其一（mutation 先写 journal 再 setIssues；
 *    冻结与更新器之间为同步块，无交错）。
 * 5. journal 清理（cleanup）：条目只在其“可能被在途读取漏掉”的全部读取结束后删除：
 *    读取 R（clock CR）可能漏掉条目 E 当且仅当 E 未 ack（保存未确认，任何快照都可能
 *    缺失）或 CR < E.ackedClock（保存/confirm 落盘晚于读取发起，快照可能取到旧值）。
 *    无在途读取、已 ack 的条目必须可清理；新 GET 在 ack 之后开始可安全取服务端值。
 */

export interface IssueSyncEntry {
  /** mutation（或 confirm）发生时的时钟。 */
  mutationClock: number;
  kind: "local" | "confirmed";
  /** 保存成功 ack 时的时钟；null = 尚未 ack（pending）。confirmed 条目 = mutationClock。 */
  ackedClock: number | null;
}

export interface IssueReadHandle {
  /** 读取代次（仅最新读取可应用合并；旧读取反序返回必须丢弃）。 */
  gen: number;
  /** 读取发起时的时钟（用于冻结 touched 决策）。 */
  clock: number;
}

export class IssueSync {
  private clock = 0;
  private readGen = 0;
  private journal = new Map<string, IssueSyncEntry>();
  private pendingTokens = new Map<string, symbol>();
  /** 在途读取：gen → 发起时 clock。 */
  private activeReads = new Map<number, number>();

  /** 本地 mutation（create/resolve/delete）：写 journal + 分配新 pending token。 */
  noteMutation(...issueIds: string[]): void {
    this.clock += 1;
    for (const id of issueIds) {
      this.journal.set(id, { mutationClock: this.clock, kind: "local", ackedClock: null });
      this.pendingTokens.set(id, Symbol(`issue-save-${id}`));
    }
  }

  /**
   * confirmSegment 原子返回的 resolvedIssues：服务端已落盘，不进入待保存集合。
   * P1（第 10 轮）：若该 ID 存在较新的本地 pending mutation（确认请求在途期间用户的
   * create/resolve/delete），绝不能覆盖/ack/删除其 journal 条目与 pending token——
   * 本地待保存状态继续受保护（含对 confirm 前旧读的保护），只有对应最新 save token
   * 成功才能 ack；confirm 的服务端结果由该保存最终落盘收敛（upsert/delete 幂等）。
   * 无 pending mutation 时才记录 confirmed 条目：只保护 confirm 前发起的旧读，
   * confirm 后的新读以服务端为准（不永久 pending，跨设备后续变化可见）。
   */
  noteConfirmed(...issueIds: string[]): void {
    this.clock += 1;
    for (const id of issueIds) {
      // 较新本地 mutation 仍在途：保留其 local 条目与 pending token。
      if (this.pendingTokens.has(id)) continue;
      this.journal.set(id, { mutationClock: this.clock, kind: "confirmed", ackedClock: this.clock });
    }
  }

  /**
   * 捕获该 ID 当前 pending token；返回 ack 闭包：仅当 token 仍是最新时
   * 清除 pending 并记录 ackedClock（较旧在途保存不得清新 mutation）。
   */
  captureSaveToken(issueId: string): () => void {
    const token = this.pendingTokens.get(issueId);
    return () => {
      if (token !== undefined && this.pendingTokens.get(issueId) === token) {
        this.pendingTokens.delete(issueId);
        this.clock += 1;
        const entry = this.journal.get(issueId);
        if (entry && entry.kind === "local" && entry.ackedClock === null) {
          entry.ackedClock = this.clock;
        }
      }
      this.cleanup();
    };
  }

  beginRead(): IssueReadHandle {
    this.readGen += 1;
    this.clock += 1;
    const handle: IssueReadHandle = { gen: this.readGen, clock: this.clock };
    this.activeReads.set(handle.gen, handle.clock);
    return handle;
  }

  /** 仅最新读取可应用；旧读取反序返回必须整体丢弃。 */
  isLatestRead(gen: number): boolean {
    return gen === this.readGen;
  }

  /** 读取结束（完成或失效）。 */
  endRead(gen: number): void {
    this.activeReads.delete(gen);
    this.cleanup();
  }

  /** 该 ID 是否仍有未确认成功的保存（测试辅助）。 */
  isPending(issueId: string): boolean {
    return this.pendingTokens.has(issueId);
  }

  /**
   * 响应到达时同步冻结 per-ID touched 决策（不得在 React 更新器内读取 journal）。
   */
  freezeDecisions(
    read: IssueReadHandle,
    latestIds: Iterable<string>,
    knownLocalIds: Iterable<string>,
  ): Map<string, boolean> {
    const decisions = new Map<string, boolean>();
    const note = (id: string) => {
      if (!decisions.has(id)) decisions.set(id, this.isTouchedAtFreeze(read, id));
    };
    for (const id of latestIds) note(id);
    for (const id of knownLocalIds) note(id);
    for (const id of this.journal.keys()) note(id);
    return decisions;
  }

  private isTouchedAtFreeze(read: IssueReadHandle, id: string): boolean {
    const entry = this.journal.get(id);
    if (entry === undefined) return false;
    // mutation/confirm 发生在读取发起之后 → 读取期间的变化 → 保护。
    if (entry.mutationClock > read.clock) return true;
    // 读取发起之前已发生：
    if (entry.kind === "confirmed") {
      // confirm 完成先于读取发起 → 服务端快照必含 → 不保护（跨设备后续更新可见）。
      return false;
    }
    if (entry.ackedClock === null) {
      // 保存未确认成功 → 快照可能缺失 → 保护。
      return true;
    }
    // 保存 ack 晚于读取发起（读取在途期间落盘）→ 快照可能取到落盘前的旧值 → 保护。
    // 保存 ack 早于读取发起 → 快照必含 → 不保护。
    return entry.ackedClock > read.clock;
  }

  /** 清理：仅删除所有在途读取都不可能漏掉的条目。 */
  private cleanup(): void {
    let minActiveClock = Number.POSITIVE_INFINITY;
    for (const clock of this.activeReads.values()) {
      if (clock < minActiveClock) minActiveClock = clock;
    }
    for (const [id, entry] of this.journal) {
      // pending（ackedClock=null）：保存未确认成功，任何未来读取都可能漏掉 → 永不清理
      //（保存失败保持 pending 和本地状态）。
      if (entry.ackedClock === null) continue;
      // 已 ack 于 A：读取 clock < A 才可能漏掉；无在途读取或全部读取 clock ≥ A → 可删。
      if (minActiveClock >= entry.ackedClock) this.journal.delete(id);
    }
  }
}

/**
 * 纯合并（可在更新器内安全执行：只读 decisions/latest/prev，不触碰协调器状态）。
 * - 服务端快照项：touched → 本地存在则保留本地版本（本地已删除则不复活）；未 touched → 服务端值。
 * - 本地项不在服务端快照：touched → 保留（新建未落盘/本地删除对旧快照不可见）；
 *   未 touched → 服务端缺失 = 跨设备删除事实 → 不保留（删除本地）。
 */
export function applyIssueMerge<T extends { issueId: string }>(
  decisions: Map<string, boolean>,
  latest: T[],
  prev: T[],
): T[] {
  const prevById = new Map(prev.map((i) => [i.issueId, i]));
  const merged: T[] = [];
  const seenIds = new Set<string>();
  for (const serverIssue of latest) {
    seenIds.add(serverIssue.issueId);
    if (decisions.get(serverIssue.issueId) === true) {
      const local = prevById.get(serverIssue.issueId);
      if (local) merged.push(local);
    } else {
      merged.push(serverIssue);
    }
  }
  for (const localIssue of prev) {
    if (!seenIds.has(localIssue.issueId)) {
      if (decisions.get(localIssue.issueId) === true) merged.push(localIssue);
    }
  }
  return merged;
}
