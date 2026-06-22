"use client";

import { useEffect, useRef } from "react";

import { useReducedMotion } from "@/hooks/useReducedMotion";

/**
 * 全屏 WebGL2 极光/星云背景。
 * - 分层 FBM(simplex)噪声形成缓慢流动的极光带:靛紫(--v1/--v2)→品红(--v3)→青(--v4)。
 * - 近黑深空基底 + 微弱视差星场;辉光靠着色器内加性叠加(非 CSS blur)。
 * - DPR 上限 1.5,resize 防抖,context-loss 容错。
 * - reduced-motion → 只渲一帧静态(不开 rAF 循环);IntersectionObserver 离屏暂停。
 */

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

// 颜色取自 globals.css 设计 token(靛紫 #7468f0 / #9166ef / 品红 #b06ce8 / 青 #3fc9ad),
// 直接内联为 GLSL 常量,避免每帧从 JS 传色。
const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;

uniform vec2  u_res;
uniform float u_time;
uniform vec2  u_mouse;   // -1..1,鼠标视差
uniform vec2  u_mouseVel; // 鼠标速度(移动时驱动背景流动)
uniform float u_mAct;    // 鼠标激活(首次移动后 →1)
uniform float u_scroll;  // 滚动累积偏移(滚轮 → 背景纵向流动)
uniform float u_dpr;

// --- simplex 噪声(Ashima/McEwan,经典实现) ---
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec3 permute(vec3 x){ return mod289(((x*34.0)+1.0)*x); }

float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0))
                          + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// 分层 FBM
float fbm(vec2 p){
  float f = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++){
    f += amp * snoise(p);
    p = p * 2.02 + vec2(11.3, 7.7);
    amp *= 0.5;
  }
  return f;
}

// 哈希星场
float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = uv;
  p.x *= aspect;

  // 鼠标视差(极轻)
  vec2 par = u_mouse * 0.04;
  float t = u_time * 0.035;

  // --- 深空基底(近黑,微暖冷渐变) #0a0a0e ---
  vec3 base = vec3(0.039, 0.039, 0.055);
  base += vec3(0.02, 0.015, 0.05) * (1.0 - uv.y);

  // --- 极光带:IQ 域扭曲(domain warping)塑有机流动丝带 ---
  vec2 q = p * 1.4 + par;
  vec2 warp = vec2(
    fbm(q + vec2(1.7, 9.2) + t * 0.15),
    fbm(q + vec2(8.3, 2.8) - t * 0.12)
  );
  vec2 qw = q + 0.8 * warp + vec2(0.0, u_scroll);         // 扭曲坐标 + 滚动纵向流
  // 鼠标搅动:光标处涡旋 + 沿移动方向推流(鼠标动 → 背景流动)
  vec2 mpos = u_mouse * 0.5 + 0.5;
  mpos.x *= aspect;
  vec2 toM = p - mpos;
  float mInfl = exp(-dot(toM, toM) * 6.0) * u_mAct;
  qw += (vec2(-toM.y, toM.x) * 0.16 + u_mouseVel * 0.5) * mInfl;
  float n1 = fbm(qw + vec2(t * 0.5, 0.0));
  float n2 = fbm(qw * 1.4 - vec2(0.0, t * 0.6));
  float bands = fbm(vec2(qw.x * 0.9 + n2 * 0.5, qw.y * 2.0 - t * 1.0));

  // 把噪声塑成纵向流动的极光丝带
  float ribbon = smoothstep(0.08, 0.92, bands * 0.5 + 0.5);
  ribbon *= smoothstep(1.1, 0.2, uv.y + n1 * 0.14);
  ribbon = pow(ribbon, 1.5);

  // 色彩沿带渐变:靛紫 → 品红 → 青
  vec3 cIndigo  = vec3(0.455, 0.408, 0.941); // #7468f0
  vec3 cViolet  = vec3(0.569, 0.400, 0.937); // #9166ef
  vec3 cMagenta = vec3(0.690, 0.424, 0.910); // #b06ce8
  vec3 cTeal    = vec3(0.247, 0.788, 0.678); // #3fc9ad

  float mixA = smoothstep(0.0, 1.0, n2 * 0.5 + 0.5);
  float mixB = smoothstep(0.2, 0.9, n1 * 0.5 + 0.5);
  vec3 aurora = mix(cIndigo, cViolet, mixA);
  aurora = mix(aurora, cMagenta, smoothstep(0.4, 1.0, mixB));
  // 青色作为冷极:噪声偏冷处沿流动带显现,形成靛紫↔品红↔青的冷暖对流
  float tealMask = smoothstep(0.62, 0.04, n2 * 0.5 + 0.5) * smoothstep(0.22, 0.82, ribbon);
  aurora = mix(aurora, cTeal, tealMask * 0.62);

  // 加性叠加辉光(非 CSS blur)
  vec3 col = base + aurora * ribbon * 1.02;

  // 第二层稀薄星云,增加景深
  float neb = fbm(q * 0.6 - vec2(t * 0.5, t * 0.3));
  col += cIndigo * smoothstep(0.4, 1.0, neb) * 0.06;

  // --- 视差星场(两层) ---
  vec2 suv = uv * u_res / u_dpr;
  for (int layer = 0; layer < 2; layer++){
    float scale = (layer == 0) ? 1.0 : 1.8;
    vec2 g = suv * 0.5 * scale + par * (40.0 * float(layer + 1));
    vec2 cell = floor(g);
    float star = hash21(cell);
    if (star > 0.985){
      vec2 f = fract(g) - 0.5;
      float d = length(f);
      float tw = 0.5 + 0.5 * sin(u_time * 1.5 + star * 30.0);
      float s = smoothstep(0.08, 0.0, d) * (0.4 + 0.6 * tw);
      col += vec3(0.7, 0.75, 0.95) * s * (layer == 0 ? 0.6 : 0.35);
    }
  }

  // 丝带高光柔辉(bloom 近似):亮处再扩一层辉光
  col += aurora * pow(ribbon, 3.0) * 0.32;

  // 光标激活辉光(鼠标处微微点亮极光)
  col += aurora * mInfl * 0.08;

  // 暗角
  float vig = smoothstep(1.25, 0.35, length(uv - 0.5));
  col *= mix(0.76, 1.0, vig);

  // 色彩分级:轻提饱和 + 柔提亮,更通透
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 1.16);
  col = pow(max(col, 0.0), vec3(0.92));

  // 轻微胶片颗粒,去 banding
  float grain = (hash21(gl_FragCoord.xy + u_time) - 0.5) * 0.014;
  col += grain;

  outColor = vec4(col, 1.0);
}
`;

const MAX_DPR = 1.5;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function AuroraBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      powerPreference: "low-power",
    });

    // WebGL2 不可用 → 静默降级(CSS 渐变兜底由 hero.css 提供)
    if (!gl) {
      canvas.classList.add("aurora-canvas--fallback");
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) {
      canvas.classList.add("aurora-canvas--fallback");
      return;
    }
    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      canvas.classList.add("aurora-canvas--fallback");
      return;
    }
    gl.useProgram(prog);

    // 全屏三角形
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "u_res");
    const uTime = gl.getUniformLocation(prog, "u_time");
    const uMouse = gl.getUniformLocation(prog, "u_mouse");
    const uDpr = gl.getUniformLocation(prog, "u_dpr");
    const uMouseVel = gl.getUniformLocation(prog, "u_mouseVel");
    const uMAct = gl.getUniformLocation(prog, "u_mAct");
    const uScroll = gl.getUniformLocation(prog, "u_scroll");

    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const mouse = { x: 0, y: 0 };
    const mouseTarget = { x: 0, y: 0 };
    const mouseVel = { x: 0, y: 0 };
    const prevTarget = { x: 0, y: 0 };
    let mAct = 0;
    let scrollVel = 0;
    let scrollOfs = 0;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uDpr, dpr);
    };

    let resizeRaf = 0;
    const onResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(resize);
    };

    const onPointer = (e: PointerEvent) => {
      mouseTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouseTarget.y = (e.clientY / window.innerHeight) * 2 - 1;
      mAct = 1;
    };
    const onWheel = (e: WheelEvent) => {
      scrollVel += e.deltaY * 0.0004;
    };

    // context-loss 容错
    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
    };
    const onRestored = () => {
      // 简单策略:刷新页面级状态由浏览器处理;此处重设视口尺寸
      resize();
      if (!reduced) loop(performance.now());
    };
    canvas.addEventListener("webglcontextlost", onLost, false);
    canvas.addEventListener("webglcontextrestored", onRestored, false);

    resize();

    let raf = 0;
    let running = true;
    const start = performance.now();

    const renderFrame = (now: number) => {
      // 鼠标位置缓动(lerp)→ 视差 + 光标焦点
      mouse.x += (mouseTarget.x - mouse.x) * 0.05;
      mouse.y += (mouseTarget.y - mouse.y) * 0.05;
      // 鼠标速度:移动时不为零、停下衰减归零 → 背景随移动而流动
      mouseVel.x += ((mouseTarget.x - prevTarget.x) * 4 - mouseVel.x) * 0.12;
      mouseVel.y += ((mouseTarget.y - prevTarget.y) * 4 - mouseVel.y) * 0.12;
      prevTarget.x = mouseTarget.x;
      prevTarget.y = mouseTarget.y;
      gl.uniform1f(uTime, (now - start) / 1000);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform2f(uMouseVel, mouseVel.x, mouseVel.y);
      gl.uniform1f(uMAct, mAct);
      // 滚动累积偏移(滚轮速度衰减积分)→ 背景纵向流动
      scrollOfs += scrollVel;
      scrollVel *= 0.9;
      gl.uniform1f(uScroll, scrollOfs);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = (now: number) => {
      if (!running) return;
      renderFrame(now);
      raf = requestAnimationFrame(loop);
    };

    // 离屏暂停 rAF
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.isIntersecting ?? true;
        if (reduced) return; // 静态模式不参与
        if (visible && !running) {
          running = true;
          raf = requestAnimationFrame(loop);
        } else if (!visible && running) {
          running = false;
          cancelAnimationFrame(raf);
        }
      },
      { threshold: 0.01 },
    );
    io.observe(canvas);

    window.addEventListener("resize", onResize);

    if (reduced) {
      // 只渲一帧静态极光,不开循环、不监听鼠标
      renderFrame(2200); // 取一个观感不错的时间点
    } else {
      window.addEventListener("pointermove", onPointer, { passive: true });
      window.addEventListener("wheel", onWheel, { passive: true });
      raf = requestAnimationFrame(loop);
    }

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeRaf);
      io.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, [reduced]);

  return <canvas ref={canvasRef} className="aurora-canvas" aria-hidden="true" />;
}
