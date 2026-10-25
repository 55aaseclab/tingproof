/**
 * 快捷键说明与改键面板。点“改键”后按任意允许的键完成绑定；Esc 取消。
 */
import { DEFAULT_KEYMAP, type Keymap, type KeymapApi } from "./useKeymap.js";

const ACTIONS: { key: keyof Keymap; label: string; hint: string }[] = [
  { key: "playPause", label: "播放 / 暂停", hint: "任意焦点可用（含编辑器聚焦时）" },
  { key: "seekBack", label: "后退 2 秒", hint: "可配置 0.5–10 秒（V0.1 固定 2 秒）" },
  { key: "seekForward", label: "前进 2 秒", hint: "" },
];

export function KeymapBar({ keymap, onClose }: { keymap: KeymapApi; onClose: () => void }) {
  return (
    <div className="pairing" style={{ margin: "8px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>快捷键（默认按 PRD 2.3.4）</strong>
        <button onClick={onClose}>收起</button>
      </div>
      <table>
        <tbody>
          {ACTIONS.map((a) => (
            <tr key={a.key}>
              <th>{a.label}</th>
              <td>
                <span className="kbd">{keymap[a.key]}</span>{" "}
                <button onClick={() => keymap.startListening(a.key)}>
                  {keymap.listeningFor === a.key ? "按任意键…" : "改键"}
                </button>
              </td>
              <td className="hint">{a.hint}</td>
            </tr>
          ))}
          <tr>
            <th>上一段 / 下一段</th>
            <td>
              <span className="kbd">Alt</span>+<span className="kbd">←</span> /{" "}
              <span className="kbd">Alt</span>+<span className="kbd">→</span>
            </td>
            <td className="hint">固定</td>
          </tr>
          <tr>
            <th>确认当前段并前进</th>
            <td>
              <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span>
            </td>
            <td className="hint">保存并确认当前段，定位下一未校对段段首（不自动播放）</td>
          </tr>
          <tr>
            <th>循环当前段</th>
            <td>
              <span className="kbd">Ctrl</span>+<span className="kbd">L</span>
            </td>
            <td className="hint">再按一次解除</td>
          </tr>
          <tr>
            <th>创建疑点</th>
            <td>
              <span className="kbd">Ctrl</span>+<span className="kbd">?</span>
            </td>
            <td className="hint">对当前段创建默认疑点（听不清 / 阻塞）</td>
          </tr>
          <tr>
            <th>退出编辑框</th>
            <td>
              <span className="kbd">Esc</span>
            </td>
            <td className="hint">输入法组合期间快捷键全部不触发</td>
          </tr>
        </tbody>
      </table>
      <div>
        <button onClick={keymap.resetToDefaults}>恢复默认（F7 / F8 / F9）</button>
        <span className="hint" style={{ marginLeft: 8 }}>
          当前默认：{DEFAULT_KEYMAP.seekBack} 后退 · {DEFAULT_KEYMAP.playPause} 播放 ·{" "}
          {DEFAULT_KEYMAP.seekForward} 前进；改键保存在本机浏览器。
        </span>
      </div>
    </div>
  );
}
