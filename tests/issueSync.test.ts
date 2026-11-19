/**
 * P0-1（第 9 轮）：IssueSync 协调器确定性单测（审计二-D 等）。
 * 不经过 UI：直接驱动协调器时序，覆盖：
 * - D：同一 issue 旧保存 in-flight → 新 mutation 入队 → 旧保存成功 ack
 *   → 不得清新 mutation 的 pending；新 mutation 仍受保护，最终保存最新状态；
 * - ack 早于读取发起 → 服务端值可安全应用；ack 晚于读取发起 → 快照可能缺失 → 保护；
 * - mutation 早于读取发起且保存仍 pending → 保护（审计二-C 的协调器层证明）；
 * - confirm：发生时在途旧读保护；confirm 后开始的读取不保护（非永久 pending，
 *   跨设备后续更新可见）；confirm ID 不进入 pending；confirm 响应不得覆盖/ack/
 *   删除更晚的本地 pending mutation（第 10 轮 P0-1——本地删除在保存成功前/失败时
 *   不得被服务端旧行复活，最终保存后按服务端事实收敛）；
 * - journal 清理：可能被在途读取漏掉的条目在读取结束前不得删除；
 *   无在途读取且已 ack 后必须可清理；
 * - 读取代次：仅最新读取可应用，旧读取反序返回必须丢弃；
 * - applyIssueMerge：touched 保留本地/已删不复活；未 touched 取服务端；
 *   服务端缺失的本地项仅 touched 保留（跨设备删除可见）。
 */
import { describe, expect, it } from "vitest";
import { applyIssueMerge, IssueSync } from "../src/store/issueSync.js";

interface TestIssue {
  issueId: string;
  status: string;
}

describe("P0-1（第 9 轮）：IssueSync 协调器", () => {
  it("D. 旧保存 in-flight→新 mutation→旧保存成功 ack：不清新 pending；新 mutation 受保护；最终保存最新", () => {
    const sync = new IssueSync();
    const id = "issue-d";

    // 1) 第一次 mutation（resolve），旧保存开始（捕获 token1）。
    sync.noteMutation(id);
    expect(sync.isPending(id)).toBe(true);
    const ackOldSave = sync.captureSaveToken(id);

    // 2) 旧保存在途时发生新 mutation（同 issue 再次修改）→ token 被替换。
    sync.noteMutation(id);

    // 3) 旧保存先成功 → ack：token 已不是最新 → 不得清除新 mutation 的 pending。
    ackOldSave();
    expect(sync.isPending(id)).toBe(true); // 关键：新 mutation 仍 pending

    // 4) 读取期间冻结：新 mutation（mutationClock > read.clock）→ touched → 保护。
    const read = sync.beginRead();
    const decisions = sync.freezeDecisions(read, [id], [id]);
    expect(decisions.get(id)).toBe(true);

    // 5) 新保存成功（token2 匹配）→ pending 清除。
    const ackNewSave = sync.captureSaveToken(id);
    ackNewSave();
    expect(sync.isPending(id)).toBe(false);
    sync.endRead(read.gen);

    // 6) 之后开始的读取：mutation 早于读取且已 ack → 不保护（服务端已含最终状态）。
    const read2 = sync.beginRead();
    const decisions2 = sync.freezeDecisions(read2, [id], [id]);
    expect(decisions2.get(id)).toBe(false);
    sync.endRead(read2.gen);
  });

  it("D（续）：旧保存成功 ack 后，在途读取的合并仍保留本地最新状态", () => {
    const sync = new IssueSync();
    const id = "issue-d2";
    const local: TestIssue = { issueId: id, status: "resolved" };
    const serverOld: TestIssue = { issueId: id, status: "open" };

    // 读取发起 → mutation → 旧保存 ack（新 mutation 仍在途）。
    const read = sync.beginRead();
    sync.noteMutation(id);
    const ackOldSave = sync.captureSaveToken(id);
    sync.noteMutation(id); // 新 mutation 替换 token
    ackOldSave(); // 旧保存成功：不得清新 pending

    const decisions = sync.freezeDecisions(read, [id], [id]);
    const merged = applyIssueMerge(decisions, [serverOld], [local]);
    // 合并保留本地 resolved（不被旧 open 快照覆盖）。
    expect(merged).toEqual([local]);
    sync.endRead(read.gen);
  });

  it("mutation 早于读取发起且保存仍 pending：GET 返回旧快照不覆盖（审计二-C 协调器层）", () => {
    const sync = new IssueSync();
    const id = "issue-c";
    const local: TestIssue = { issueId: id, status: "resolved" };
    const serverOld: TestIssue = { issueId: id, status: "open" };

    sync.noteMutation(id); // mutation 在读取发起前
    expect(sync.isPending(id)).toBe(true); // 保存仍 pending

    const read = sync.beginRead(); // 读取在 mutation 之后发起
    const decisions = sync.freezeDecisions(read, [id], [id]);
    expect(decisions.get(id)).toBe(true); // pending → 保护
    const merged = applyIssueMerge(decisions, [serverOld], [local]);
    expect(merged).toEqual([local]);
    sync.endRead(read.gen);
  });

  it("ack 早于读取发起：服务端值可安全应用（新 GET 可清掉已 ack journal）", () => {
    const sync = new IssueSync();
    const id = "issue-ack-early";

    sync.noteMutation(id);
    const ack = sync.captureSaveToken(id);
    ack(); // 保存成功，ack 早于读取发起
    expect(sync.isPending(id)).toBe(false);

    const read = sync.beginRead();
    const decisions = sync.freezeDecisions(read, [id], [id]);
    expect(decisions.get(id)).toBe(false); // 不保护 → 服务端值（快照必含已落盘保存）
    sync.endRead(read.gen);
  });

  it("ack 晚于读取发起（保存在读取在途期间落盘）：快照可能取到旧值 → 保护", () => {
    const sync = new IssueSync();
    const id = "issue-ack-late";

    sync.noteMutation(id); // mutation（保存开始，未完成）
    const read = sync.beginRead(); // 读取发起（mutation 之后、ack 之前）
    const ack = sync.captureSaveToken(id);
    ack(); // ack 发生在读取在途期间 → ackedClock > read.clock
    const decisions = sync.freezeDecisions(read, [id], [id]);
    expect(decisions.get(id)).toBe(true); // 快照可能缺失 → 保护
    sync.endRead(read.gen);
    expect(sync.isPending(id)).toBe(false);
  });

  it("confirm：在途旧读保护；confirm 后开始的读取不保护（非永久 pending，跨设备可见）", () => {
    const sync = new IssueSync();
    const id = "issue-cfm";

    // confirm 发生时读取在途 → 保护。
    const read1 = sync.beginRead();
    sync.noteConfirmed(id);
    expect(sync.isPending(id)).toBe(false); // confirm 不进入 pending
    const d1 = sync.freezeDecisions(read1, [id], [id]);
    expect(d1.get(id)).toBe(true);
    sync.endRead(read1.gen);

    // confirm 完成后开始的读取 → 不保护：服务端快照可正常更新/删除它。
    const read2 = sync.beginRead();
    const d2 = sync.freezeDecisions(read2, [id], [id]);
    expect(d2.get(id)).toBe(false);
    sync.endRead(read2.gen);
  });

  it("confirm 响应不得覆盖较新本地 pending mutation：保留 local 条目与 token；仅最新 save token 成功才 ack；之后按服务端事实收敛", () => {
    const sync = new IssueSync();
    const id = "issue-cfm-pending";

    // 确认请求在途期间发生本地 delete/resolve（较新 mutation，保存未完成）。
    sync.noteMutation(id);
    expect(sync.isPending(id)).toBe(true);

    // confirm 原子返回包含该 issue：不得覆盖/ack/删除本地 pending（第 10 轮 P0-1）。
    sync.noteConfirmed(id);
    expect(sync.isPending(id)).toBe(true); // 关键：pending token 保留

    // confirm 之后发起的读取：pending → 保护——服务端旧 resolved/open 行不得复活本地删除。
    const read = sync.beginRead();
    const decisions = sync.freezeDecisions(read, [id], [id]);
    expect(decisions.get(id)).toBe(true);
    sync.endRead(read.gen);

    // 旧 token 的迟到 ack（token 已被更新 mutation 替换的情形由 D 例覆盖）；
    // 此处对应最新 token 成功 → ack → pending 清除。
    const ack = sync.captureSaveToken(id);
    ack();
    expect(sync.isPending(id)).toBe(false);

    // 之后发起的新读取：不保护 → 按服务端事实（删除已落盘）收敛，不永久 pending。
    const read2 = sync.beginRead();
    const d2 = sync.freezeDecisions(read2, [id], [id]);
    expect(d2.get(id)).toBe(false);
    sync.endRead(read2.gen);
  });

  it("confirm 在途→本地 mutation→confirm 返回：confirm 前旧读与 confirm 后新读均不复活本地删除（合并层）", () => {
    const sync = new IssueSync();
    const id = "issue-cfm-del";
    const serverResolved = { issueId: id, status: "resolved" };

    const readOld = sync.beginRead(); // confirm 发起前的旧读（在途）。
    sync.noteMutation(id); // 确认在途期间本地删除（pending）。
    sync.noteConfirmed(id); // confirm 返回 resolvedIssues：保留 local pending。
    expect(sync.isPending(id)).toBe(true);

    // 旧读（confirm/mutation 前发起）与 confirm 后的新读都不得用服务端行复活本地删除。
    const dOld = sync.freezeDecisions(readOld, [id], []);
    expect(dOld.get(id)).toBe(true);
    sync.endRead(readOld.gen);
    const readNew = sync.beginRead();
    const dNew = sync.freezeDecisions(readNew, [id], []);
    expect(dNew.get(id)).toBe(true);
    // 合并层：本地已删（prev=[]）→ 不复活。
    expect(applyIssueMerge(dNew, [serverResolved], [])).toEqual([]);
    sync.endRead(readNew.gen);

    // 删除保存成功 ack 后：新读不保护 → 服务端事实（已删除，快照缺失）生效。
    sync.captureSaveToken(id)();
    expect(sync.isPending(id)).toBe(false);
    const readFinal = sync.beginRead();
    // 条目已按读取边界清理（无在途读且已 ack）；显式查询该 ID 的决策 → 未保护。
    const dFinal = sync.freezeDecisions(readFinal, [id], [id]);
    expect(dFinal.get(id) ?? false).toBe(false);
    expect(applyIssueMerge(dFinal, [], [])).toEqual([]);
    sync.endRead(readFinal.gen);
  });

  it("journal 清理：可能被在途读取漏掉的条目在读取结束前不得删除；之后必须可清理", () => {
    const sync = new IssueSync();
    const id = "issue-clean";

    // 读取 R 发起 → mutation → ack（ack 晚于 R 发起 → R 可能漏掉）。
    const read = sync.beginRead();
    sync.noteMutation(id);
    const ack = sync.captureSaveToken(id);
    ack(); // pending 清除，但 ackedClock > read.clock

    // 触发清理（再开一个读取并结束，drive cleanup）：
    const readDriver = sync.beginRead();
    sync.endRead(readDriver.gen);
    // read 仍在途（clock 更早）→ 条目不得被清理：冻结决策仍保护。
    const decisions = sync.freezeDecisions(read, [id], [id]);
    expect(decisions.get(id)).toBe(true);

    // read 结束（无在途读取、已 ack）→ 必须可清理 → 后续读取不保护。
    sync.endRead(read.gen);
    const readAfter = sync.beginRead();
    const dAfter = sync.freezeDecisions(readAfter, [id], [id]);
    expect(dAfter.get(id)).toBe(false);
    sync.endRead(readAfter.gen);
  });

  it("读取代次：仅最新读取可应用；旧读取反序返回必须丢弃", () => {
    const sync = new IssueSync();
    const read1 = sync.beginRead();
    const read2 = sync.beginRead();
    expect(sync.isLatestRead(read1.gen)).toBe(false); // 旧
    expect(sync.isLatestRead(read2.gen)).toBe(true); // 最新
    sync.endRead(read1.gen);
    sync.endRead(read2.gen);
  });

  it("applyIssueMerge：touched 保留本地/已删不复活；未 touched 取服务端；跨设备删除可见", () => {
    const kept = { issueId: "a", status: "local" };
    const serverA = { issueId: "a", status: "server" };
    const serverB = { issueId: "b", status: "server" };
    const localOnlyTouched = { issueId: "c", status: "local" };
    const localOnlyDeleted = { issueId: "d", status: "local" };

    const decisions = new Map<string, boolean>([
      ["a", true], // touched → 保留本地
      ["c", true], // 本地新增未落盘 → 保留
      ["d", false], // 未 touched 且服务端缺失 → 跨设备删除 → 不保留
    ]);
    const merged = applyIssueMerge(
      decisions,
      [serverA, serverB],
      [kept, localOnlyTouched, localOnlyDeleted],
    );
    // a: touched → 本地；b: 未 touched → 服务端；c: touched 本地-only → 保留；d: 删除。
    expect(merged).toEqual([kept, serverB, localOnlyTouched]);

    // touched 且本地已删除（服务端仍有）→ 不复活。
    const merged2 = applyIssueMerge(new Map([["a", true]]), [serverA], []);
    expect(merged2).toEqual([]);
  });
});
