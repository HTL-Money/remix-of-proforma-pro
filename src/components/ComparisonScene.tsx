import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { fmtUSD } from "@/lib/proforma";

/**
 * ComparisonScene — a canvas-rendered 2.5D "money skyline" comparing
 * Current Platform vs Hometown Lending annual net compensation.
 *
 * Rendered live in the app (animated rise + count-up, subtle cursor parallax)
 * and snapshotted to a PNG that gets embedded in the submission email, so the
 * emailed visual is pixel-identical to what the LO saw on screen.
 */

export interface ComparisonSceneHandle {
  /** Renders a final (fully-risen) frame offscreen and returns a PNG data URL. */
  snapshot: () => string | null;
}

interface SceneValues {
  currentAnnual: number;
  htlAnnual: number;
  currentSub: string; // e.g. "200 BPS · 2.00%"
  htlSub: string;     // e.g. "90% split · Broker + Correspondent"
  diffAnnual: number;
  diffMonthly: number;
  recruitName?: string;
}

// Palette — validated for CVD separation + contrast on the navy surface
const SURFACE_TOP = "#0d1b33";
const SURFACE_BOTTOM = "#142b4e";
const GRID = "rgba(141, 168, 209, 0.22)";
const INK = "#f2f6fc";
const INK_MUTED = "#8fa3c4";
const CUR_FACE = "#5b85d6";
const CUR_TOP = "#84a6e3";
const CUR_SIDE = "#3f62a8";
const HTL_FACE = "#3fa47e";
const HTL_TOP = "#63c29d";
const HTL_SIDE = "#2b7a5c";
const HTL_GLOW = "rgba(63, 164, 126, 0.30)";
const GAIN = "#63c29d";
const LOSS = "#e08579";

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

const roundedRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
};

interface DrawOpts extends SceneValues {
  /** 0 → bars flat, 1 → fully risen */
  progress: number;
  /** values the animation is rising FROM (for count-up + height lerp) */
  fromCurrent: number;
  fromHtl: number;
  /** -1..1 cursor parallax */
  parallax: number;
}

function drawScene(ctx: CanvasRenderingContext2D, w: number, h: number, o: DrawOpts) {
  const p = easeOutCubic(Math.min(1, Math.max(0, o.progress)));
  const curVal = o.fromCurrent + (o.currentAnnual - o.fromCurrent) * p;
  const htlVal = o.fromHtl + (o.htlAnnual - o.fromHtl) * p;

  // ---- background ----
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, SURFACE_TOP);
  bg.addColorStop(1, SURFACE_BOTTOM);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const baseline = h - Math.max(84, h * 0.15);
  const depthX = 24 + o.parallax * 6;
  const depthY = -12;

  // ---- perspective floor grid ----
  const vpX = w / 2 + o.parallax * 40;
  const vpY = baseline - h * 0.55;
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  // receding horizontals (exponential spacing toward horizon)
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    const y = baseline - (baseline - (vpY + 40)) * (1 - Math.pow(1 - t, 2.2));
    ctx.globalAlpha = 1 - t * 0.75;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  // converging rays
  for (let i = 0; i <= 10; i++) {
    const x = (w / 10) * i;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, baseline);
    ctx.lineTo(vpX + (x - vpX) * 0.22, vpY + 40);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // baseline edge
  ctx.strokeStyle = "rgba(141, 168, 209, 0.35)";
  ctx.beginPath();
  ctx.moveTo(0, baseline);
  ctx.lineTo(w, baseline);
  ctx.stroke();

  // ---- title block ----
  const pad = Math.max(28, w * 0.045);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = HTL_TOP;
  ctx.font = `700 ${Math.max(10, w * 0.011)}px Inter, system-ui, sans-serif`;
  ctx.save();
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "2.5px";
  ctx.fillText("HOMETOWN LENDING · LO PRO FORMA", pad, pad + 12);
  ctx.restore();
  ctx.fillStyle = INK;
  ctx.font = `700 ${Math.max(20, w * 0.026)}px "Playfair Display", Georgia, serif`;
  ctx.fillText("Annual Net Compensation", pad, pad + 46);
  if (o.recruitName) {
    ctx.fillStyle = INK_MUTED;
    ctx.font = `400 ${Math.max(11, w * 0.013)}px Inter, system-ui, sans-serif`;
    ctx.fillText(`Prepared for ${o.recruitName}`, pad, pad + 68);
  }

  // ---- bars ----
  const maxVal = Math.max(curVal, htlVal, o.currentAnnual, o.htlAnnual, 1);
  const maxBarH = baseline - (vpY + 96);
  const minPad = 12;
  let barW = Math.min(150, Math.max(96, w * 0.13));
  let gap = Math.min(260, Math.max(150, w * 0.22));
  let groupW = barW * 2 + gap;
  // On narrow canvases (roughly <366px) the natural group width plus depth
  // and side padding overflows the canvas, clipping the bars. Scale the
  // whole group down to fit instead.
  if (groupW + depthX + minPad * 2 > w) {
    const scale = (w - depthX - minPad * 2) / groupW;
    barW *= scale;
    gap *= scale;
    groupW = barW * 2 + gap;
  }
  const startX = Math.max(minPad, (w - groupW - depthX) / 2);

  const heightFor = (v: number) => Math.max(4, (Math.max(v, 0) / maxVal) * maxBarH);

  const drawBar = (
    x: number, val: number,
    face: string, top: string, side: string,
    label: string, sub: string,
    glow: boolean,
  ) => {
    const bh = heightFor(val);
    const y = baseline - bh;

    if (glow) {
      const g = ctx.createRadialGradient(x + barW / 2, y, 10, x + barW / 2, y, Math.max(barW * 1.9, 60));
      g.addColorStop(0, HTL_GLOW);
      g.addColorStop(1, "rgba(63,164,126,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - barW * 2, y - barW * 2, barW * 5, barW * 4 + bh);
    }

    // ground shadow
    const sh = ctx.createRadialGradient(x + barW / 2 + depthX / 2, baseline + 6, 2, x + barW / 2 + depthX / 2, baseline + 6, barW);
    sh.addColorStop(0, "rgba(4, 10, 22, 0.55)");
    sh.addColorStop(1, "rgba(4, 10, 22, 0)");
    ctx.fillStyle = sh;
    ctx.save();
    ctx.translate(x + barW / 2 + depthX / 2, baseline + 7);
    ctx.scale(1, 0.22);
    ctx.beginPath();
    ctx.arc(0, 0, barW, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // side face
    ctx.fillStyle = side;
    ctx.beginPath();
    ctx.moveTo(x + barW, y);
    ctx.lineTo(x + barW + depthX, y + depthY);
    ctx.lineTo(x + barW + depthX, baseline + depthY);
    ctx.lineTo(x + barW, baseline);
    ctx.closePath();
    ctx.fill();

    // top face
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + barW, y);
    ctx.lineTo(x + barW + depthX, y + depthY);
    ctx.lineTo(x + depthX, y + depthY);
    ctx.closePath();
    ctx.fill();

    // front face with sheen
    const fg = ctx.createLinearGradient(x, 0, x + barW, 0);
    fg.addColorStop(0, face);
    fg.addColorStop(0.5, face);
    fg.addColorStop(1, side);
    ctx.fillStyle = fg;
    ctx.fillRect(x, y, barW, bh);
    const sheen = ctx.createLinearGradient(x, 0, x + barW * 0.5, 0);
    sheen.addColorStop(0, "rgba(255,255,255,0.16)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(x, y, barW * 0.5, bh);

    // value label above the top face
    ctx.textAlign = "center";
    ctx.fillStyle = INK;
    ctx.font = `700 ${Math.max(19, w * 0.024)}px Inter, system-ui, sans-serif`;
    ctx.fillText(fmtUSD(val), x + barW / 2 + depthX / 2, y + depthY - 14);

    // name + sub below baseline
    ctx.fillStyle = INK_MUTED;
    ctx.font = `700 ${Math.max(10, w * 0.0115)}px Inter, system-ui, sans-serif`;
    ctx.save();
    if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "1.5px";
    ctx.fillText(label.toUpperCase(), x + barW / 2 + depthX / 2, baseline + 26);
    ctx.restore();
    ctx.fillStyle = "rgba(143, 163, 196, 0.75)";
    ctx.font = `400 ${Math.max(10, w * 0.011)}px Inter, system-ui, sans-serif`;
    ctx.fillText(sub, x + barW / 2 + depthX / 2, baseline + 44);
    ctx.textAlign = "left";
  };

  const curX = startX;
  const htlX = startX + barW + gap;
  drawBar(curX, curVal, CUR_FACE, CUR_TOP, CUR_SIDE, "Current Platform", o.currentSub, false);
  drawBar(htlX, htlVal, HTL_FACE, HTL_TOP, HTL_SIDE, "Hometown Lending", o.htlSub, true);

  // ---- the gain: dashed guide at Current's top, delta bracket on the HTL bar ----
  const curTopY = baseline - heightFor(curVal);
  const htlTopY = baseline - heightFor(htlVal);
  const positive = o.diffAnnual >= 0;
  const guideEnd = htlX + barW + depthX + 18;

  ctx.strokeStyle = positive ? "rgba(99, 194, 157, 0.75)" : "rgba(224, 133, 121, 0.75)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(curX + barW + depthX + 10, curTopY + depthY);
  ctx.lineTo(guideEnd, curTopY + depthY);
  ctx.stroke();
  ctx.setLineDash([]);

  // bracket from guide line to HTL top, along HTL bar's right edge
  const bx = guideEnd;
  ctx.strokeStyle = positive ? GAIN : LOSS;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(bx, curTopY + depthY);
  ctx.lineTo(bx, htlTopY + depthY);
  ctx.stroke();
  // arrowhead pointing at HTL top
  const dir = htlTopY < curTopY ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(bx, htlTopY + depthY);
  ctx.lineTo(bx - 5, htlTopY + depthY + 8 * dir);
  ctx.lineTo(bx + 5, htlTopY + depthY + 8 * dir);
  ctx.closePath();
  ctx.fillStyle = positive ? GAIN : LOSS;
  ctx.fill();

  // delta pill next to the bracket midpoint
  const midY = (curTopY + htlTopY) / 2 + depthY;
  const dispDiff = htlVal - curVal;
  const line1 = `${dispDiff >= 0 ? "+" : ""}${fmtUSD(dispDiff)} / yr`;
  const line2 = `${o.diffMonthly >= 0 ? "+" : ""}${fmtUSD(o.diffMonthly)} / mo`;
  ctx.font = `700 ${Math.max(14, w * 0.017)}px Inter, system-ui, sans-serif`;
  const w1 = ctx.measureText(line1).width;
  ctx.font = `400 ${Math.max(10, w * 0.012)}px Inter, system-ui, sans-serif`;
  const w2 = ctx.measureText(line2).width;
  const pillW = Math.max(w1, w2) + 32;
  const pillH = Math.max(48, w * 0.055);
  const pillX = bx + 14;
  const pillY = Math.min(Math.max(midY - pillH / 2, 12), baseline - pillH - 8);

  if (pillX + pillW <= w - 8) {
    ctx.fillStyle = positive ? "rgba(43, 122, 92, 0.35)" : "rgba(160, 70, 60, 0.35)";
    roundedRect(ctx, pillX, pillY, pillW, pillH, 10);
    ctx.fill();
    ctx.strokeStyle = positive ? GAIN : LOSS;
    ctx.lineWidth = 1.5;
    roundedRect(ctx, pillX + 0.5, pillY + 0.5, pillW - 1, pillH - 1, 10);
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.fillStyle = positive ? GAIN : LOSS;
    ctx.font = `700 ${Math.max(14, w * 0.017)}px Inter, system-ui, sans-serif`;
    ctx.fillText(line1, pillX + pillW / 2, pillY + pillH * 0.44);
    ctx.fillStyle = INK_MUTED;
    ctx.font = `400 ${Math.max(10, w * 0.012)}px Inter, system-ui, sans-serif`;
    ctx.fillText(line2, pillX + pillW / 2, pillY + pillH * 0.78);
    ctx.textAlign = "left";
  } else {
    // narrow canvas: no room for a floating pill without collisions, so the
    // delta joins the header lockup as a plain text line under the title
    const headerY = pad + (o.recruitName ? 92 : 72);
    ctx.fillStyle = positive ? GAIN : LOSS;
    ctx.font = `700 ${Math.max(13, w * 0.016)}px Inter, system-ui, sans-serif`;
    const gainWord = positive ? "Gain" : "Difference";
    ctx.fillText(`${gainWord}: ${line1}  ·  ${line2}`, pad, headerY);
  }

  // footnote
  ctx.fillStyle = "rgba(143, 163, 196, 0.55)";
  ctx.font = `400 ${Math.max(9, w * 0.01)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.fillText("Figures from your pro forma inputs · illustrative estimates", w - pad, h - 16);
  ctx.textAlign = "left";
}

export const ComparisonScene = forwardRef<ComparisonSceneHandle, SceneValues>((props, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // animation state lives outside React renders
  const anim = useRef({
    progress: 1,
    fromCurrent: 0,
    fromHtl: 0,
    // Seeded to 0 (not the target props) so the very first render has
    // something to rise from instead of already showing the final frame.
    shownCurrent: 0,
    shownHtl: 0,
    parallax: 0,
    parallaxTarget: 0,
    raf: 0,
    startTs: 0,
    running: false,
  });

  const reducedMotion = typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const cssW = wrap.clientWidth;
    const cssH = Math.max(380, Math.min(560, cssW * 0.58));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = `${cssH}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const a = anim.current;
    drawScene(ctx, cssW, cssH, {
      ...propsRef.current,
      progress: a.progress,
      fromCurrent: a.fromCurrent,
      fromHtl: a.fromHtl,
      parallax: a.parallax,
    });
  }, []);

  const tick = useCallback((ts: number) => {
    const a = anim.current;
    if (!a.startTs) a.startTs = ts;
    if (a.progress < 1) {
      a.progress = Math.min(1, (ts - a.startTs) / 900);
    }
    // ease parallax toward target
    a.parallax += (a.parallaxTarget - a.parallax) * 0.08;
    render();
    const settled = a.progress >= 1 && Math.abs(a.parallaxTarget - a.parallax) < 0.002;
    if (!settled) {
      a.raf = requestAnimationFrame(tick);
    } else {
      a.parallax = a.parallaxTarget;
      a.running = false;
      render();
    }
  }, [render]);

  const kick = useCallback(() => {
    const a = anim.current;
    if (a.running) return;
    a.running = true;
    a.raf = requestAnimationFrame(tick);
  }, [tick]);

  // re-animate when the values change
  useEffect(() => {
    const a = anim.current;
    if (reducedMotion) {
      a.progress = 1;
      a.fromCurrent = props.currentAnnual;
      a.fromHtl = props.htlAnnual;
      render();
    } else {
      // rise from whatever is currently displayed
      const p = easeOutCubic(Math.min(1, a.progress));
      a.fromCurrent = a.fromCurrent + (a.shownCurrent - a.fromCurrent) * p;
      a.fromHtl = a.fromHtl + (a.shownHtl - a.fromHtl) * p;
      a.shownCurrent = props.currentAnnual;
      a.shownHtl = props.htlAnnual;
      a.progress = 0;
      a.startTs = 0;
      kick();
    }
  }, [props.currentAnnual, props.htlAnnual, props.diffAnnual, props.diffMonthly, props.currentSub, props.htlSub, props.recruitName, kick, render, reducedMotion]);

  // resize
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => render());
    ro.observe(wrap);
    render();
    return () => ro.disconnect();
  }, [render]);

  // cleanup rAF on unmount
  useEffect(() => () => cancelAnimationFrame(anim.current.raf), []);

  const onMouseMove = (e: React.MouseEvent) => {
    if (reducedMotion) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    anim.current.parallaxTarget = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    kick();
  };
  const onMouseLeave = () => {
    anim.current.parallaxTarget = 0;
    if (!reducedMotion) kick();
  };

  useImperativeHandle(ref, () => ({
    snapshot: () => {
      const off = document.createElement("canvas");
      const W = 1200, H = 700, scale = 2;
      off.width = W * scale;
      off.height = H * scale;
      const ctx = off.getContext("2d");
      if (!ctx) return null;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawScene(ctx, W, H, {
        ...propsRef.current,
        progress: 1,
        fromCurrent: propsRef.current.currentAnnual,
        fromHtl: propsRef.current.htlAnnual,
        parallax: 0,
      });
      try {
        return off.toDataURL("image/png");
      } catch {
        return null;
      }
    },
  }), []);

  return (
    <div ref={wrapRef} className="w-full overflow-hidden rounded-xl border border-primary/20 shadow-elegant">
      <canvas
        ref={canvasRef}
        className="block w-full"
        role="img"
        aria-label={`Annual net compensation comparison: Current Platform ${fmtUSD(props.currentAnnual)} versus Hometown Lending ${fmtUSD(props.htlAnnual)}, a difference of ${fmtUSD(props.diffAnnual)} per year.`}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      />
    </div>
  );
});
ComparisonScene.displayName = "ComparisonScene";
