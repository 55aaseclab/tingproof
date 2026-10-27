/**
 * V1.1.4 机器文本可疑点预筛面板（PRD §3.4.9 / AC-069~071 + 主审计五轮修正）：
 * - 白底工作台入口与进度：未运行 / 运行中 已处理 N/M / 已完成 新增·复用·拒绝 / 失败可重试；
 *   latest 读取失败时入口显示"状态读取失败"（P0-1 第 3 轮），不冒充"未运行"。
 * - 每次打开/配置重试立即进入真实 loading（P0-1 第 4 轮）：config 置 null，期间不得用旧配置启动。
 * - config 与 latest 各自独立完整请求代次（P0-1 第 5 轮）：
 *   新 open/config retry 发起时立即使旧 latest 失效；旧 open/旧 retry 的任何迟到
 *   resolve/reject 均不能覆盖第二次状态或错误。
 * - 操作代次（operation generation，P0-1 第 5 轮）：每次 start/resume/retry/cancel
 *   分配唯一 opGen；循环、cancel response、catch/finally 都只更新当前操作；
 *   旧操作不得 setRun/setError/setBusy/继续 next。
 * - 取消精确指向本次活动 run（P0-2 第 4/5 轮）：start 新 runId 未得到前不显示旧 run 的取消；
 *   resume/retry 从请求开始即可取消已知 run；迟到 mutation 不覆盖 cancel。
 * - 运行前 flush 后检查 save.state，失败拒绝创建 run（P0-2 第 3 轮）。
 * - processed=false 不忙轮询（P0-2）；继续/重试按钮受三元配置门禁。
 * - run 模型配置与当前不一致（P0-6）：零副作用、显示配置不匹配、提供「用当前配置开始新预筛」。
 */
import { useCallback, useRef, useState } from "react";
import {
  createPrefilterRun,
  getLatestPrefilterRun,
  getPrefilterConfig,
  prefilterCancel,
  prefilterNext,
  prefilterRetry,
} from "../store/repo.js";
import type { PrefilterConfigDto, PrefilterRunDto } from "../store/types.js";
import type { SaveState } from "../store/saveCoordinator.js";

interface Props {
  projectId: string;
  /** 每个批次落库后刷新工作台疑点列表（机器建议进入现有队列）。 */
  onIssuesChanged: () => Promise<void>;
  /** 运行前先刷新保存队列（PRD §3.4.9：运行前先落盘人工草稿）。 */
  flushSaves: () => Promise<void>;
  /** P0-2（第 3 轮）：读取 SaveCoordinator 当前状态（flush 后检查是否 failed）。 */
  getSaveState: () => SaveState;
}

/** 可继续处理的非终态（含 partial/failed——重试路径）。 */
const RESUMABLE = new Set(["queued", "running", "partial", "failed"]);

const CONFIDENCE_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };

/** P0-3（第 2 轮）：精确三元配置比较（provider + model + promptVersion 全部一致才匹配）。 */
function configMatches(run: PrefilterRunDto, config: PrefilterConfigDto): boolean {
  return run.provider === config.provider && run.model === config.model && run.promptVersion === config.promptVersion;
}

/** 面板旁入口的最近一次状态摘要。P0-1（第 3 轮）：latest 失败时显示"状态读取失败"。 */
export function prefilterStatusText(
  run: PrefilterRunDto | null,
  busy: boolean,
  latestRunError: string | null = null,
): string {
  if (busy) return "运行中…";
  if (latestRunError !== null) return "状态读取失败";
  if (!run) return "未运行";
  switch (run.status) {
    case "queued":
    case "running":
      return `运行中 已处理 ${run.processed}/${run.total}`;
    case "completed":
      return `已完成 新增 ${run.created} · 复用 ${run.reused} · 拒绝 ${run.rejected}`;
    case "partial":
    case "failed":
      return `失败可重试（已处理 ${run.processed}/${run.total}）`;
    case "cancelled":
      return `已取消（已处理 ${run.processed}/${run.total}）`;
    default:
      return run.status;
  }
}

export function PrefilterPanel({ projectId, onIssuesChanged, flushSaves, getSaveState }: Props) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<PrefilterConfigDto | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  /** P0-2（第 2 轮）：最近 run 读取失败（不冒充无 run）。 */
  const [latestRunError, setLatestRunError] = useState<string | null>(null);
  const [run, setRun] = useState<PrefilterRunDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  /** P0-2：processed=false（其他客户端持有批次）→ 停止循环，显示「继续」按钮。 */
  const [waitingForOtherClient, setWaitingForOtherClient] = useState(false);
  /**
   * P0-1（第 5 轮）：latest 独立请求代次——fetchLatestRun 和 fetchConfig 都递增
   * （新 open/config retry 立即使旧 latest 失效）；显式 mutation 也递增。
   * 旧 latest 迟到 resolve/reject 时代次不匹配 → 丢弃。
   */
  const latestGenRef = useRef(0);
  /** P0-1（第 4 轮）：config 独立请求代次——每次 fetchConfig 递增；旧 config 迟到→丢弃。 */
  const configGenRef = useRef(0);
  /**
   * P0-1（第 5 轮）：操作代次——每次 start/resume/retry/cancel 分配唯一 token。
   * 循环、cancel response、catch/finally 都检查 opGen 是否仍为当前操作；
   * 旧操作不得 setRun/setError/setBusy/继续 next。
   */
  const opGenRef = useRef(0);
  /** P0-2（第 5 轮）：本次活动的 runId（cancel 精确指向）。resume/retry 请求前已知。 */
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  /** run 状态的同步只读镜像（迟到的 runLoop 闭包读取最新 UI 指向）。 */
  const runRef = useRef(run);
  runRef.current = run;
  /**
   * P1-4（第 9/10 轮）：cancel 状态——点击即记录（含响应未返回的在途取消）。
   * 迟到 processed batch 的只读 latest 同步在两种响应顺序下都恰好发生一次：
   * - cancel 响应先返回（settled）→ 迟到批次到达时直接同步（既有顺序）；
   * - 迟到批次先返回（cancel 响应仍挂起）→ 标记 syncRequested，cancel 响应落地后
   *   补做一次同步——否则 cancel 响应携带的 materialize 前旧快照会让 UI 永久停在旧计数。
   * 期间出现任何新操作（start/resume/retry/新 cancel）→ opGen 失配，全部路径失效。
   */
  const cancelStateRef = useRef<{
    runId: string;
    opGen: number;
    /** cancel 响应已返回（UI 已是 cancelled 快照）。 */
    settled: boolean;
    /** 迟到批次已请求 latest 同步（每种响应顺序合计恰好一次）。 */
    syncRequested: boolean;
  } | null>(null);

  /** 使旧 latest 失效（新 open/config retry/显式 mutation 时调用）。 */
  const bumpLatestGen = useCallback(() => {
    latestGenRef.current += 1;
  }, []);

  /** 每次显式打开面板、config 就绪后、重试状态都做只读 latest GET；带独立代次保护。 */
  const fetchLatestRun = useCallback(() => {
    const gen = ++latestGenRef.current;
    void getLatestPrefilterRun(projectId)
      .then((latest) => {
        if (gen !== latestGenRef.current) return; // 旧响应不覆盖
        setRun(latest);
        setLatestRunError(null);
      })
      .catch((err: unknown) => {
        if (gen !== latestGenRef.current) return;
        setLatestRunError(err instanceof Error ? err.message : String(err));
      });
  }, [projectId]);

  /**
   * 只读刷新 config（独立代次）。P0-1（第 5 轮）：
   * 立即清空旧配置 + 立即使旧 latest 失效（新 open/config retry 时旧 latest 不得覆盖）。
   */
  const fetchConfig = useCallback(() => {
    const gen = ++configGenRef.current;
    setConfig(null);
    setConfigError(null);
    bumpLatestGen(); // P0-1（第 5 轮）：新 config 请求使旧 latest 失效
    void getPrefilterConfig()
      .then((c) => {
        if (gen !== configGenRef.current) return;
        setConfig(c);
        fetchLatestRun();
      })
      .catch((err: unknown) => {
        if (gen !== configGenRef.current) return;
        setConfigError(err instanceof Error ? err.message : String(err));
      });
  }, [fetchLatestRun, bumpLatestGen]);

  /** 打开面板：每次都只读刷新 config + latest。 */
  const openPanel = useCallback(() => {
    setOpen(true);
    fetchConfig();
  }, [fetchConfig]);

  /** 重试配置读取。只做只读 GET。 */
  const retryConfig = useCallback(() => {
    fetchConfig();
  }, [fetchConfig]);

  /**
   * P1-4（第 9/10 轮）：cancel 后迟到的 processed batch 落库 → 只读同步一次 latest 计数。
   * 前置条件（全部满足才同步）：
   * - cancel 之后没有更新的操作（opGen 仍等于 cancel 时刻的值——
   *   若已开始新 run，绝不应用可能覆盖新 run 的 latest）；
   * - cancel 响应已返回且界面仍指向该 cancelled run（runRef 匹配 runId 且
   *   status=cancelled）；cancel 响应仍挂起时只标记 syncRequested，由响应落地后补做；
   * - 服务端 latest 仍是该 run（保守：别的 run 不经此路径覆盖）。
   * 只读：不轮询、不 create、不调 next/模型；失败静默（显式重试承担错误显示）。
   */
  const syncLatestAfterLateBatch = useCallback(
    async () => {
      const state = cancelStateRef.current;
      if (state === null) return;
      if (state.opGen !== opGenRef.current) return; // 已有新操作（start/resume/retry/新 cancel）
      if (!state.settled) {
        // P1-4（第 10 轮）：迟到批次先于 cancel 响应到达 → 挂起同步，响应落地后补做
        //（恰好一次；cancel 响应可能是 materialize 前旧快照，不能作为最终计数）。
        state.syncRequested = true;
        return;
      }
      const current = runRef.current;
      if (!current || current.runId !== state.runId || current.status !== "cancelled") {
        return; // 界面不指向被取消的 run
      }
      const gen = ++latestGenRef.current;
      try {
        const latest = await getLatestPrefilterRun(projectId);
        if (gen !== latestGenRef.current) return; // 旧 latest 响应不覆盖新状态
        if (cancelStateRef.current !== state) return; // 期间又有新 cancel
        if (latest === null || latest.runId !== state.runId) return; // 服务端 latest 非该 run
        // 应用同 run 最终 processed/created/reused/rejected；status 显式钉死为 cancelled
        //（服务端契约同样是取消竞态下保持 cancelled——不伪装完成）。
        // 不清除 latestRunError：本同步由迟到的旧操作触发（P1 第 9 轮错误恢复口径——
        // 旧 GET/旧 operation 迟到不得清新错误）；错误由显式重试或新的当前操作清除。
        setRun({ ...latest, status: "cancelled" });
      } catch {
        // 只读同步失败：静默（显式「重试读取状态」承担错误显示）。
      }
    },
    [projectId],
  );

  /**
   * 批次循环（P0-1 第 5 轮）：每次操作分配唯一 opGen。
   * 所有 setRun/setError/setBusy 都检查 opGen 是否仍为当前操作。
   * 旧操作（cancelled/完成后用户开始新 run）不得覆盖新操作的状态。
   */
  const runLoop = useCallback(
    async (
      first: () => Promise<{
        run: PrefilterRunDto;
        error: { code: string; message: string } | null;
        processed: boolean;
      }>,
    ) => {
      const opGen = ++opGenRef.current;
      const isCurrent = () => opGen === opGenRef.current;
      setBusy(true);
      setError(null);
      setBatchError(null);
      setWaitingForOtherClient(false);
      bumpLatestGen();
      try {
        const firstResult = await first();
        if (!isCurrent()) {
          // P1-4（第 7/9 轮）：旧操作的 first/resume/retry 已完成且批次落库 → 刷新 issues；
          // 若 cancel 仍是最新操作且界面仍指向被取消 run → 只读同步一次 latest 计数。
          if (firstResult.processed) {
            await onIssuesChanged();
            await syncLatestAfterLateBatch();
          }
          return;
        }
        let current = firstResult.run;
        setRun(current);
        setActiveRunId(current.runId);
        // P1-3（第 7 轮）：成功取得权威 run → 清除旧 latest 读取错误。
        setLatestRunError(null);
        if (firstResult.processed) await onIssuesChanged();
        if (!isCurrent()) return;
        if (firstResult.error) {
          if (firstResult.error.code === "config_mismatch") {
            setError(firstResult.error.message);
            return;
          }
          setBatchError(firstResult.error.message);
          return;
        }
        if (!firstResult.processed) {
          setWaitingForOtherClient(true);
          return;
        }
        while (RESUMABLE.has(current.status)) {
          if (!isCurrent()) return; // 旧操作：不继续 next
          const res = await prefilterNext(projectId, current.runId);
          if (!isCurrent()) {
            // P1-4（第 7/9 轮）：旧操作的 next 已完成且批次实际落库（processed=true）→
            // 安全地只读刷新一次 issues（不轮询、不触发模型/新 run），
            // 确保 cancelled UI 下新落库的 machine_prefilter issues 可见；
            // 若 cancel 仍是最新操作且界面仍指向被取消 run → 只读同步一次 latest 计数。
            if (res.processed) {
              await onIssuesChanged();
              await syncLatestAfterLateBatch();
            }
            return;
          }
          current = res.run;
          setRun(current);
          if (res.processed) await onIssuesChanged();
          if (!isCurrent()) return;
          if (res.error) {
            if (res.error.code === "config_mismatch") {
              setError(res.error.message);
              return;
            }
            setBatchError(res.error.message);
            return;
          }
          if (!res.processed) {
            setWaitingForOtherClient(true);
            return;
          }
        }
      } catch (err) {
        if (isCurrent()) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isCurrent()) setBusy(false);
      }
    },
    [projectId, onIssuesChanged, bumpLatestGen, syncLatestAfterLateBatch],
  );

  /**
   * 开始新预筛。P0-2（第 4/5 轮）：activeRunId 清空（新 runId 未得到前不显示旧取消按钮）。
   */
  const start = useCallback(() => {
    setActiveRunId(null);
    void runLoop(async () => {
      await flushSaves();
      const saveState = getSaveState();
      if (saveState.state === "failed") {
        throw new Error(
          `保存队列尚未成功（${saveState.failedCount} 项未落盘），已阻止预筛启动。请先重试保存成功后再开始预筛。`,
        );
      }
      const created = await createPrefilterRun(projectId);
      return { run: created, error: null, processed: true };
    });
  }, [runLoop, flushSaves, getSaveState, projectId]);

  /** 继续未完成的 run。P0-2（第 5 轮）：runId 请求前已知，立即设 activeRunId 使取消可用。 */
  const resume = useCallback(() => {
    if (!run) return;
    setActiveRunId(run.runId); // 请求前已知 runId → 取消按钮立即可见
    void runLoop(() => prefilterNext(projectId, run.runId));
  }, [run, runLoop, projectId]);

  /** 重试失败批次。P0-2（第 5 轮）：同 resume，立即设 activeRunId。 */
  const retry = useCallback(() => {
    if (!run) return;
    setActiveRunId(run.runId);
    void runLoop(() => prefilterRetry(projectId, run.runId));
  }, [run, runLoop, projectId]);

  /**
   * P0-2（第 4/5 轮）+ P0-3（第 6 轮）：取消精确指向本次活动 run（activeRunId）。
   * 分配新 opGen 使旧操作的后续响应失效。
   * P0-3：cancel 失败也必须正确收尾 busy/waiting（不永久锁死 UI），
   * 失败后 UI 可明确重试/继续。
   */
  const cancel = useCallback(() => {
    if (!activeRunId) return;
    const targetRunId = activeRunId;
    const opGen = ++opGenRef.current; // 新操作代次：旧 runLoop 的后续响应全部失效
    bumpLatestGen();
    // P1-4（第 10 轮）：点击即记录 cancel 状态（响应未返回也视为在途取消）——
    // 迟到批次先于 cancel 响应到达时据此挂起 latest 同步，响应落地后补做一次。
    cancelStateRef.current = { runId: targetRunId, opGen, settled: false, syncRequested: false };
    void prefilterCancel(projectId, targetRunId)
      .then((cancelled) => {
        if (opGen !== opGenRef.current) return; // 已被更新操作覆盖
        setRun(cancelled);
        setActiveRunId(cancelled.runId);
        setBusy(false);
        setWaitingForOtherClient(false);
        const state = cancelStateRef.current;
        if (state && state.opGen === opGen) {
          state.settled = true;
          state.runId = cancelled.runId;
          // runRef 手动镜像：迟到批次同步的守卫立即可见（不等下一轮 render）。
          runRef.current = cancelled;
          // P1-4（第 10 轮）：迟到批次先于本响应到达（syncRequested）→ 现在补做一次
          // 只读 latest 同步——本响应可能携带 materialize 前旧快照，不能作为最终计数。
          if (state.syncRequested) {
            state.syncRequested = false;
            void syncLatestAfterLateBatch();
          }
        }
      })
      .catch((err: unknown) => {
        if (opGen !== opGenRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        // P0-3（第 6 轮）：取消失败也收尾 busy/waiting——UI 不永久锁死。
        setBusy(false);
        setWaitingForOtherClient(false);
        // 取消未成立：清除在途 cancel 状态（迟到批次不再触发 latest 同步）。
        const state = cancelStateRef.current;
        if (state && state.opGen === opGen) cancelStateRef.current = null;
      });
  }, [activeRunId, projectId, bumpLatestGen, syncLatestAfterLateBatch]);

  const isResumable = run !== null && RESUMABLE.has(run.status);
  const isRetryable = run !== null && (run.status === "partial" || run.status === "failed");
  const configOk = run !== null && config !== null && configMatches(run, config);

  return (
    <div className="prefilter-entry">
      <button
        onClick={() => (open ? setOpen(false) : openPanel())}
        title="机器可疑点预筛（只读取原始转写文本）"
      >
        机器预筛
      </button>
      <span className="hint" title={latestRunError ?? undefined}>
        {prefilterStatusText(run, busy, latestRunError)}
      </span>
      {open && (
        <div className="prefilter-panel">
          {configError !== null ? (
            <div>
              <div className="notice-err" role="alert">✖ 读取预筛配置失败：{configError}</div>
              <div className="prefilter-actions">
                <button onClick={retryConfig}>重试读取配置</button>
              </div>
              <p className="hint">预筛暂不可用不影响人工校对；可稍后重试或检查服务端配置。</p>
            </div>
          ) : config === null ? (
            <p className="hint">正在读取预筛配置…</p>
          ) : !config.available ? (
            <div>
              <div className="notice-warn">机器预筛未配置。</div>
              <p className="hint">
                请在服务端环境设置 TINGPROOF_LLM_BASE_URL 与 TINGPROOF_LLM_MODEL
                （API key 只从服务端环境变量 TINGPROOF_LLM_API_KEY 读取，浏览器不保存密钥）。
              </p>
            </div>
          ) : (
            <div>
              <p className="hint">
                只发送原始机器转写文本，不发送音频和人工校对稿。模型：{config.model}
                （{config.provider}，提示词 {config.promptVersion}）。
                范围：当前项目中未确认的字幕段；已确认段不重复筛。
              </p>
              {run && (
                <p className="hint" role="status">
                  {prefilterStatusText(run, busy)}
                  {run.status === "completed" && ` · 批次 ${run.batches.length}`}
                  {!configMatches(run, config) && (
                    <span title="run 创建时的模型配置与当前不一致（P0-6：不可漂移）">
                      {" "}· run 配置：{run.model}
                    </span>
                  )}
                </p>
              )}
              {run && run.batches.some((b) => b.errorCode !== null) && (
                <p className="hint">
                  失败批次：
                  {run.batches
                    .filter((b) => b.errorCode !== null)
                    .map((b) => `#${b.batchNo + 1}（${b.errorMessage ?? b.errorCode}）`)
                    .join("、")}
                </p>
              )}
              {waitingForOtherClient && (
                <div className="notice-warn">
                  另一客户端正在处理当前批次。点击「继续」在对方批次完成后接手（不会忙轮询）。
                </div>
              )}
              {latestRunError && (
                <div className="notice-err" role="alert">
                  ✖ 读取预筛状态失败：{latestRunError}
                  <button style={{ marginLeft: 8 }} onClick={fetchLatestRun}>重试读取状态</button>
                </div>
              )}
              {batchError && <div className="notice-warn">批次失败：{batchError}</div>}
              {error && <div className="notice-err" role="alert">✖ {error}</div>}
              <div className="prefilter-actions">
                <button className="primary" disabled={busy} onClick={start}>
                  {busy
                    ? "预筛中…"
                    : run && !configMatches(run, config)
                      ? "用当前配置开始新预筛"
                      : "开始预筛"}
                </button>
                {isResumable && !busy && !waitingForOtherClient && configOk && (
                  <button onClick={resume}>继续预筛</button>
                )}
                {isRetryable && !busy && configOk && (
                  <button onClick={retry}>重试失败批次</button>
                )}
                {waitingForOtherClient && !busy && configOk && (
                  <button onClick={resume}>继续</button>
                )}
                {busy && activeRunId !== null && (
                  <button onClick={cancel}>取消（批次边界生效）</button>
                )}
              </div>
              {run && (
                <p className="hint">
                  候选以“机器建议”warning 疑点进入右侧队列（置信度{" "}
                  {Object.values(CONFIDENCE_LABEL).join("/")}）；机器建议不自动改稿、不自动确认。
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
