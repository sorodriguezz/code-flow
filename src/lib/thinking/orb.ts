import type { ThinkingActivity } from "./activity";
import { palette, rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";

/**
 * "Orbe" — the voice-powered orb (21st.dev, @isaiahbjork), the glowing ring whose edge boils with
 * noise and swells with the voice it hears.
 *
 * The voice here is the run: the orb breathes slowly while the model thinks, chatters while the
 * answer streams (the closest thing a text model has to speaking), and goes nearly still when the
 * run has printed nothing for minutes.
 *
 * **One WebGL context for all of them.** A browser allows a handful of live WebGL contexts per page
 * and a task list can show a dozen orbs, so the shader runs on one shared, detached canvas: each
 * orb renders its own frame there and copies it onto its plain 2D canvas in the same tick
 * (`preserveDrawingBuffer`, so the copy never reads a cleared buffer). Where WebGL is missing the
 * orb falls back to a 2D ring with the same hues.
 */

const VERTEX = `
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

// The shader as published (it is ReactBits' "Orb"), with the hue rotation taken out — the base
// colours are swapped for the app's own instead.
const FRAGMENT = `
precision highp float;
uniform float iTime;
uniform vec3 iResolution;
uniform float hover;
uniform float rot;
uniform vec3 color1;
uniform vec3 color2;
uniform vec3 color3;
varying vec2 vUv;

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.11369, 0.13787));
  p3 += dot(p3, p3.yxz + 19.19);
  return -1.0 + 2.0 * fract(vec3(p3.x + p3.y, p3.x + p3.z, p3.y + p3.z) * p3.zyx);
}

float snoise3(vec3 p) {
  const float K1 = 0.333333333;
  const float K2 = 0.166666667;
  vec3 i = floor(p + (p.x + p.y + p.z) * K1);
  vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
  vec3 e = step(vec3(0.0), d0 - d0.yzx);
  vec3 i1 = e * (1.0 - e.zxy);
  vec3 i2 = 1.0 - e.zxy * (1.0 - e);
  vec3 d1 = d0 - (i1 - K2);
  vec3 d2 = d0 - (i2 - K1);
  vec3 d3 = d0 - 0.5;
  vec4 h = max(0.6 - vec4(dot(d0, d0), dot(d1, d1), dot(d2, d2), dot(d3, d3)), 0.0);
  vec4 n = h * h * h * h * vec4(dot(d0, hash33(i)), dot(d1, hash33(i + i1)), dot(d2, hash33(i + i2)), dot(d3, hash33(i + 1.0)));
  return dot(vec4(31.316), n);
}

vec4 extractAlpha(vec3 colorIn) {
  float a = max(max(colorIn.r, colorIn.g), colorIn.b);
  return vec4(colorIn.rgb / (a + 1e-5), a);
}

const float innerRadius = 0.6;
const float noiseScale = 0.65;

float light1(float intensity, float attenuation, float dist) {
  return intensity / (1.0 + dist * attenuation);
}

float light2(float intensity, float attenuation, float dist) {
  return intensity / (1.0 + dist * dist * attenuation);
}

vec4 draw(vec2 uv) {
  float ang = atan(uv.y, uv.x);
  float len = length(uv);
  float invLen = len > 0.0 ? 1.0 / len : 0.0;
  float n0 = snoise3(vec3(uv * noiseScale, iTime * 0.5)) * 0.5 + 0.5;
  float r0 = mix(mix(innerRadius, 1.0, 0.4), mix(innerRadius, 1.0, 0.6), n0);
  float d0 = distance(uv, (r0 * invLen) * uv);
  float v0 = light1(1.0, 10.0, d0);
  v0 *= smoothstep(r0 * 1.05, r0, len);
  float cl = cos(ang + iTime * 2.0) * 0.5 + 0.5;
  float a = iTime * -1.0;
  vec2 pos = vec2(cos(a), sin(a)) * r0;
  float d = distance(uv, pos);
  float v1 = light2(1.5, 5.0, d);
  v1 *= light1(1.0, 50.0, d0);
  float v2 = smoothstep(1.0, mix(innerRadius, 1.0, n0 * 0.5), len);
  float v3 = smoothstep(innerRadius, mix(innerRadius, 1.0, 0.5), len);
  vec3 col = mix(color1, color2, cl);
  col = mix(color3, col, v0);
  col = (col + v1) * v2 * v3;
  col = clamp(col, 0.0, 1.0);
  return extractAlpha(col);
}

void main() {
  vec2 fragCoord = vUv * iResolution.xy;
  vec2 center = iResolution.xy * 0.5;
  float size = min(iResolution.x, iResolution.y);
  vec2 uv = (fragCoord - center) / size * 2.0;
  float s = sin(rot);
  float c = cos(rot);
  uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
  uv.x += hover * 0.1 * sin(uv.y * 10.0 + iTime);
  uv.y += hover * 0.1 * sin(uv.x * 10.0 + iTime);
  vec4 col = draw(uv);
  gl_FragColor = vec4(col.rgb * col.a, col.a);
}`;

interface Shared {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  u: Record<"time" | "res" | "hover" | "rot" | "c1" | "c2" | "c3", WebGLUniformLocation | null>;
}

let shared: Shared | null | undefined;

function sharedGl(): Shared | null {
  if (shared !== undefined) return shared;
  shared = null;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) return null;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    // One triangle covering the viewport.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.clearColor(0, 0, 0, 0);
    const at = (name: string) => gl.getUniformLocation(program, name);
    shared = {
      canvas,
      gl,
      u: {
        time: at("iTime"),
        res: at("iResolution"),
        hover: at("hover"),
        rot: at("rot"),
        c1: at("color1"),
        c2: at("color2"),
        c3: at("color3"),
      },
    };
  } catch {
    shared = null;
  }
  return shared;
}

export function createOrb(canvas: HTMLCanvasElement, px: number): Painter {
  const ctx = prepareCanvas(canvas, px);
  const buffer = canvas.width;
  let time = 0;
  let turn = 0;
  let voice = 0;
  let alpha = 1;
  let activity: ThinkingActivity | undefined;

  /** How loud the "voice" is right now — what the shader's wobble is driven by. */
  function target(): number {
    if (activity?.done || activity?.stopping) return 0;
    if (activity?.quiet) return 0.05;
    switch (activity?.phase) {
      case "start":
        return 0.15;
      case "write":
        // Speech-like: syllables over a slower phrase.
        return 0.25 + 0.75 * Math.abs(Math.sin(time * 9) * Math.sin(time * 2.7));
      case "think":
      case "plan":
        return 0.45 + 0.2 * Math.sin(time * 1.3);
      default:
        return 0.3 + 0.15 * Math.sin(time * 2.1);
    }
  }

  function paint() {
    if (!ctx) return;
    ctx.clearRect(0, 0, px, px);
    ctx.globalAlpha = alpha;
    const p = palette();
    const gl = sharedGl();
    if (gl) {
      const g = gl.gl;
      if (gl.canvas.width !== buffer) {
        gl.canvas.width = buffer;
        gl.canvas.height = buffer;
      }
      g.viewport(0, 0, buffer, buffer);
      g.clear(g.COLOR_BUFFER_BIT);
      const unit = (c: readonly number[]) => [c[0] / 255, c[1] / 255, c[2] / 255] as const;
      g.uniform1f(gl.u.time, time);
      g.uniform3f(gl.u.res, buffer, buffer, 1);
      // The wobble is a sine across the disc: past a whisper it folds the ring into a polygon at
      // the sizes this lives at, so only a loud "voice" (the answer streaming) ripples it at all.
      // What the voice mostly drives is the turn — as in the original.
      g.uniform1f(gl.u.hover, voice * voice * 0.12);
      g.uniform1f(gl.u.rot, turn);
      g.uniform3f(gl.u.c1, ...unit(p.a));
      g.uniform3f(gl.u.c2, ...unit(p.c));
      // The deep tone under the ring: the indigo, darkened — the published navy, in our hue.
      g.uniform3f(gl.u.c3, ...unit(p.b.map((v) => v * 0.6)));
      g.drawArrays(g.TRIANGLES, 0, 3);
      ctx.drawImage(gl.canvas, 0, 0, px, px);
    } else {
      // No WebGL: a ring in the same hues, its brightest point travelling round.
      const r = px * 0.36;
      const grad = ctx.createConicGradient?.(turn * 3, px / 2, px / 2);
      if (grad) {
        grad.addColorStop(0, rgb(p.a));
        grad.addColorStop(0.5, rgb(p.c));
        grad.addColorStop(1, rgb(p.a));
      }
      ctx.lineWidth = px * (0.1 + voice * 0.06);
      ctx.strokeStyle = grad ?? rgb(p.b);
      ctx.beginPath();
      ctx.arc(px / 2, px / 2, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  return {
    setActivity(next) {
      activity = next;
    },
    tick(dt) {
      time += dt * (activity?.quiet ? 0.3 : 1);
      voice += (target() - voice) * Math.min(1, dt * 6);
      turn += dt * (0.3 + voice * 1.5);
      const wanted = activity?.stopping ? 0.3 : 1;
      alpha += (wanted - alpha) * Math.min(1, dt * 3.5);
      paint();
    },
    still() {
      if (time === 0) time = 2.2;
      voice = target();
      alpha = activity?.stopping ? 0.3 : 1;
      paint();
    },
  };
}
