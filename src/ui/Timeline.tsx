/**
 * 时间轴（canvas）：字幕段密度条 + 刻度 + 播放头 + 循环区。
 * 点击/拖动跳转；当前时间通过订阅 rAF 时钟重绘，不触发 React 渲染。
 * V0.1 不做全量波形解码（3.5 小时音频整段解码会占用数 GB 内存），见 README 已知限制。
 */
import { useEffect, useRef } from "react";
import type { LoopRegion } from "../audio/usePlayer.js";
import type { SegmentRecord } from "../store/types.js";

interface Props {
  segments: SegmentRecord[];
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

export function Timeline({ segments, durationMs, loop, onSeek, subscribeCurrentMs }: Props) {
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
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);

        // 刻度：选择使标签间距 >= 70px 的时间步长。
        const steps = [60_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];
        const step = steps.find((s) => (s / d) * w >= 70) ?? 3_600_000;
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillStyle = "#64748b";
        ctx.strokeStyle = "#dbe2ea";
        for (let t = 0; t <= d; t += step) {
          const x = (t / d) * w;
          ctx.beginPath();
          ctx.moveTo(x, h - 14);
          ctx.lineTo(x, h);
          ctx.stroke();
          const mm = Math.floor(t / 60_000);
          const label = `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`;
          ctx.fillText(label, x + 2, h - 3);
        }

        // 字幕段块。
        const y0 = 6;
        const y1 = h - 18;
        const segs = segmentsRef.current;
        if (segs.length > 0 && segs[segs.length - 1].endMs > d) {
          // 字幕超出音频时按字幕范围兜底显示（越界属于质量问题，工作台会提示）。
        }
        for (const s of segs) {
          const x0 = Math.max(0, (s.startMs / d) * w);
          const x1 = Math.min(w, (s.endMs / d) * w);
          if (x1 <= x0) continue;
          ctx.fillStyle = STATUS_COLORS[s.status] ?? "#475569";
          ctx.fillRect(x0, y0, Math.max(1, x1 - x0), y1 - y0);
        }

        // 循环区。
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

        // 播放头。
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
}
