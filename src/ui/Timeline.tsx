/**
 * 时间轴（canvas）：字幕段密度条 + 刻度（静态层）与播放头 + 循环区（overlay）。
 *
 * - props.segments 是 Workbench 传入的稳定轻量数据（仅 id/start/end/status，
 *   纯正文编辑时引用不变，React.memo 直接跳过本组件 render）；
 * - 静态层仅在 id/start/end/status/时长/尺寸变化时重绘（sameTimelineData 精确失效）；
 * - overlay 每帧廉价绘制；rAF 热路径不遍历段数据；
 * - 点击/拖动跳转。
 */
import { memo, useCallback, useEffect, useRef } from "react";
import { sameTimelineData, type TimelineSegLike } from "../core/selection.js";
import type { LoopRegion } from "../audio/usePlayer.js";

/** O(1) 几何键：时长/宽高/DPR 任一变化即不同（静态层失效判定，rAF 内零段遍历）。 */
export function timelineGeometryKey(
  durationMs: number,
  clientWidth: number,
  clientHeight: number,
  dpr: number,
): string {
  return `${durationMs}|${clientWidth}|${clientHeight}|${dpr}`;
}

interface Props {
  /** 轻量时间轴数据（由 Workbench 保证引用稳定）。 */
  segments: TimelineSegLike[];
  durationMs: number;
  loop: LoopRegion | null;
  onSeek: (ms: number) => void;
  subscribeCurrentMs: (cb: (ms: number) => void) => () => void;
}

const STATUS_COLORS: Record<string, string> = {
  unreviewed: "#94a3b8",
  editing: "#d97706",
  questioned: "#dc2626",
  confirmed: "#16a34a",
  accepted_unclear: "#9333ea",
};

export const Timeline = memo(function Timeline({
  segments,
  durationMs,
  loop,
  onSeek,
  subscribeCurrentMs,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const segmentsRef = useRef(segments);
  const durationRef = useRef(durationMs);
  const loopRef = useRef(loop);
  const currentRef = useRef(0);
  segmentsRef.current = segments;
  durationRef.current = durationMs;
  loopRef.current = loop;

  useEffect(() => {
    return subscribeCurrentMs((ms) => {
      currentRef.current = ms;
    });
  }, [subscribeCurrentMs]);

  // 静态层失效：仅由 props.segments 引用变化触发（引用稳定由 Workbench 保证），
  // 且用 sameTimelineData 双重确认内容确实变化。
  const staticDirtyRef = useRef(true);
  const prevDataRef = useRef<TimelineSegLike[]>(segments);
  if (prevDataRef.current !== segments && !sameTimelineData(prevDataRef.current, segments)) {
    staticDirtyRef.current = true; // id/start/end/status 变化 → 重绘
  }
  prevDataRef.current = segments;

  const staticBitmapRef = useRef<HTMLCanvasElement | null>(null);
  const geometryKeyRef = useRef("");

  const drawStatic = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const off = staticBitmapRef.current ?? document.createElement("canvas");
    if (off.width !== Math.round(w * dpr) || off.height !== Math.round(h * dpr)) {
      off.width = Math.round(w * dpr);
      off.height = Math.round(h * dpr);
    }
    const octx = off.getContext("2d");
    if (!octx) return;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, w, h);
    octx.fillStyle = "#ffffff";
    octx.fillRect(0, 0, w, h);

    const d = durationRef.current;
    const steps = [60_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];
    const step = steps.find((x) => (x / d) * w >= 70) ?? 3_600_000;
    octx.font = "10px ui-monospace, monospace";
    octx.fillStyle = "#64748b";
    octx.strokeStyle = "#dbe2ea";
    for (let t = 0; t <= d; t += step) {
      const x = (t / d) * w;
      octx.beginPath();
      octx.moveTo(x, h - 14);
      octx.lineTo(x, h);
      octx.stroke();
      const mm = Math.floor(t / 60_000);
      const label = `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`;
      octx.fillText(label, x + 2, h - 3);
    }

    const y0 = 6;
    const y1 = h - 18;
    for (const seg of segmentsRef.current) {
      const x0 = Math.max(0, (seg.startMs / d) * w);
      const x1 = Math.min(w, (seg.endMs / d) * w);
      if (x1 <= x0) continue;
      octx.fillStyle = STATUS_COLORS[seg.status] ?? "#94a3b8";
      octx.fillRect(x0, y0, Math.max(1, x1 - x0), y1 - y0);
    }
    staticBitmapRef.current = off;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;

    const draw = () => {
      const d = durationRef.current;
      const ctx = canvas.getContext("2d");
      if (ctx && d > 0) {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        // 几何键 O(1)：时长/宽高/DPR 任一变化置脏静态层（不遍历段数组）。
        const geoKey = timelineGeometryKey(d, w, h, dpr);
        if (geoKey !== geometryKeyRef.current) {
          geometryKeyRef.current = geoKey;
          staticDirtyRef.current = true;
        }
        if (staticDirtyRef.current) {
          drawStatic();
          staticDirtyRef.current = false;
        }
        if (staticBitmapRef.current) {
          ctx.drawImage(staticBitmapRef.current, 0, 0, w, h);
        }

        // overlay：循环区 + 播放头（每帧廉价绘制，不遍历段数据）。
        const lp = loopRef.current;
        if (lp) {
          const lx0 = (lp.startMs / d) * w;
          const lx1 = (lp.endMs / d) * w;
          ctx.fillStyle = "rgba(37, 99, 235, 0.14)";
          ctx.fillRect(lx0, 0, Math.max(2, lx1 - lx0), h);
          ctx.strokeStyle = "#2563eb";
          ctx.beginPath();
          ctx.moveTo(lx0, 0);
          ctx.lineTo(lx0, h);
          ctx.moveTo(lx1, 0);
          ctx.lineTo(lx1, h);
          ctx.stroke();
        }
        const cx = (currentRef.current / d) * w;
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seekFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const d = durationRef.current;
    if (!canvas || d <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(Math.min(d, Math.max(0, ratio * d)));
  };

  const draggingRef = useRef(false);

  return (
    <div className="timeline-wrap">
      <canvas
        ref={canvasRef}
        className="timeline"
        aria-label="字幕时间轴：点击或拖动跳转播放位置"
        onPointerDown={(e) => {
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromEvent(e);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) seekFromEvent(e);
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
    </div>
  );
});
