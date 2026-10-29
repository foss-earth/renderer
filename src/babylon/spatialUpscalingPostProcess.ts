import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import type { Camera } from "@babylonjs/core/Cameras/camera.js";
import { Effect } from "@babylonjs/core/Materials/effect.js";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage.js";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess.js";
import type { Scene } from "@babylonjs/core/scene.js";

/**
 * 12-tap edge-adaptive upsampling and 5-tap contrast-adaptive sharpening.
 * The filter follows AMD FidelityFX Super Resolution 1 (MIT): a directional
 * Lanczos-style kernel clamped to the four nearest texels, then a negative
 * lobe whose weight cannot clip the local contrast.
 */
export const EASU_FRAGMENT_GLSL = `varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec2 inputSize;
vec4 sampleTap(vec2 pixel) {
  vec2 size = max(inputSize, vec2(1.0));
  vec2 clamped = clamp(pixel, vec2(0.0), size - vec2(1.0));
  return texture2D(textureSampler, (clamped + vec2(0.5)) / size);
}
float luma(vec3 color) { return dot(color, vec3(0.25, 0.5, 0.25)); }
vec3 addGradient(vec3 dirLen, float w, float lA, float lB, float lC, float lD, float lE) {
  vec2 dir = dirLen.xy;
  float len = dirLen.z;
  float lenX = max(abs(lD - lC), abs(lC - lB));
  float dirX = lD - lB;
  dir.x += dirX * w;
  float sx = clamp(abs(dirX) / max(lenX, 1.0e-6), 0.0, 1.0);
  len += sx * sx * w;
  float lenY = max(abs(lE - lC), abs(lC - lA));
  float dirY = lE - lA;
  dir.y += dirY * w;
  float sy = clamp(abs(dirY) / max(lenY, 1.0e-6), 0.0, 1.0);
  len += sy * sy * w;
  return vec3(dir, len);
}
vec4 addTap(vec4 accum, vec2 offset, vec2 dir, vec2 len, float lob, float clp, vec3 color) {
  vec2 v = vec2(offset.x * dir.x + offset.y * dir.y, offset.x * -dir.y + offset.y * dir.x) * len;
  float d2 = min(dot(v, v), clp);
  float wB = (2.0 / 5.0) * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
  float weight = wB * wA;
  return vec4(accum.rgb + color * weight, accum.a + weight);
}
void main(void) {
  vec2 pp = vUV * inputSize - vec2(0.5);
  vec2 base = floor(pp);
  pp -= base;
  vec3 b = sampleTap(base + vec2(0.0, -1.0)).rgb;
  vec3 c = sampleTap(base + vec2(1.0, -1.0)).rgb;
  vec4 eSample = sampleTap(base + vec2(-1.0, 0.0));
  vec3 e = eSample.rgb;
  vec4 fSample = sampleTap(base);
  vec3 f = fSample.rgb;
  vec3 g = sampleTap(base + vec2(1.0, 0.0)).rgb;
  vec3 h = sampleTap(base + vec2(2.0, 0.0)).rgb;
  vec3 i = sampleTap(base + vec2(-1.0, 1.0)).rgb;
  vec3 j = sampleTap(base + vec2(0.0, 1.0)).rgb;
  vec3 k = sampleTap(base + vec2(1.0, 1.0)).rgb;
  vec3 l = sampleTap(base + vec2(2.0, 1.0)).rgb;
  vec3 n = sampleTap(base + vec2(0.0, 2.0)).rgb;
  vec3 o = sampleTap(base + vec2(1.0, 2.0)).rgb;
  float bL = luma(b), cL = luma(c), eL = luma(e), fL = luma(f), gL = luma(g), hL = luma(h);
  float iL = luma(i), jL = luma(j), kL = luma(k), lL = luma(l), nL = luma(n), oL = luma(o);
  float wS = (1.0 - pp.x) * (1.0 - pp.y);
  float wT = pp.x * (1.0 - pp.y);
  float wU = (1.0 - pp.x) * pp.y;
  float wV = pp.x * pp.y;
  vec3 dirLen = addGradient(vec3(0.0), wS, bL, eL, fL, gL, jL);
  dirLen = addGradient(dirLen, wT, cL, fL, gL, hL, kL);
  dirLen = addGradient(dirLen, wU, fL, iL, jL, kL, nL);
  dirLen = addGradient(dirLen, wV, gL, jL, kL, lL, oL);
  vec2 dir = dirLen.xy;
  float len = dirLen.z;
  float dirR = dot(dir, dir);
  if (dirR < (1.0 / 32768.0)) dir = vec2(1.0, 0.0);
  else dir *= inversesqrt(dirR);
  len = len * 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((0.25 - 0.04) - 0.5) * len;
  float clp = 1.0 / max(lob, 1.0e-4);
  vec4 accum = vec4(0.0);
  accum = addTap(accum, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, b);
  accum = addTap(accum, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, c);
  accum = addTap(accum, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
  accum = addTap(accum, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, f);
  accum = addTap(accum, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, g);
  accum = addTap(accum, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, h);
  accum = addTap(accum, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
  accum = addTap(accum, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, j);
  accum = addTap(accum, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, k);
  accum = addTap(accum, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, l);
  accum = addTap(accum, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, n);
  accum = addTap(accum, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, o);
  vec3 resolved = accum.a > 1.0e-5 ? accum.rgb / accum.a : f;
  vec3 min4 = min(min(f, g), min(j, k));
  vec3 max4 = max(max(f, g), max(j, k));
  gl_FragColor = vec4(clamp(resolved, min4, max4), fSample.a);
}`;

export const EASU_FRAGMENT_WGSL = `varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
uniform inputSize: vec2f;
fn sampleTap(pixel: vec2f) -> vec4f {
  let size = max(uniforms.inputSize, vec2f(1.0));
  let clamped = clamp(pixel, vec2f(0.0), size - vec2f(1.0));
  return textureSampleLevel(textureSampler, textureSamplerSampler, (clamped + vec2f(0.5)) / size, 0.0);
}
fn luma(color: vec3f) -> f32 { return dot(color, vec3f(0.25, 0.5, 0.25)); }
fn addGradient(dirLen: vec3f, w: f32, lA: f32, lB: f32, lC: f32, lD: f32, lE: f32) -> vec3f {
  var dir = dirLen.xy;
  var len = dirLen.z;
  let lenX = max(abs(lD - lC), abs(lC - lB));
  let dirX = lD - lB;
  dir.x = dir.x + dirX * w;
  let sx = clamp(abs(dirX) / max(lenX, 1.0e-6), 0.0, 1.0);
  len = len + sx * sx * w;
  let lenY = max(abs(lE - lC), abs(lC - lA));
  let dirY = lE - lA;
  dir.y = dir.y + dirY * w;
  let sy = clamp(abs(dirY) / max(lenY, 1.0e-6), 0.0, 1.0);
  len = len + sy * sy * w;
  return vec3f(dir, len);
}
fn addTap(accum: vec4f, offset: vec2f, dir: vec2f, len: vec2f, lob: f32, clp: f32, color: vec3f) -> vec4f {
  let v = vec2f(offset.x * dir.x + offset.y * dir.y, offset.x * -dir.y + offset.y * dir.x) * len;
  let d2 = min(dot(v, v), clp);
  var wB = (2.0 / 5.0) * d2 - 1.0;
  var wA = lob * d2 - 1.0;
  wB = wB * wB;
  wA = wA * wA;
  wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
  let weight = wB * wA;
  return vec4f(accum.rgb + color * weight, accum.a + weight);
}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  var pp = input.vUV * uniforms.inputSize - vec2f(0.5);
  let base = floor(pp);
  pp = pp - base;
  let b = sampleTap(base + vec2f(0.0, -1.0)).rgb;
  let c = sampleTap(base + vec2f(1.0, -1.0)).rgb;
  let e = sampleTap(base + vec2f(-1.0, 0.0)).rgb;
  let fSample = sampleTap(base);
  let f = fSample.rgb;
  let g = sampleTap(base + vec2f(1.0, 0.0)).rgb;
  let h = sampleTap(base + vec2f(2.0, 0.0)).rgb;
  let i = sampleTap(base + vec2f(-1.0, 1.0)).rgb;
  let j = sampleTap(base + vec2f(0.0, 1.0)).rgb;
  let k = sampleTap(base + vec2f(1.0, 1.0)).rgb;
  let l = sampleTap(base + vec2f(2.0, 1.0)).rgb;
  let n = sampleTap(base + vec2f(0.0, 2.0)).rgb;
  let o = sampleTap(base + vec2f(1.0, 2.0)).rgb;
  let bL = luma(b); let cL = luma(c); let eL = luma(e); let fL = luma(f); let gL = luma(g); let hL = luma(h);
  let iL = luma(i); let jL = luma(j); let kL = luma(k); let lL = luma(l); let nL = luma(n); let oL = luma(o);
  let wS = (1.0 - pp.x) * (1.0 - pp.y);
  let wT = pp.x * (1.0 - pp.y);
  let wU = (1.0 - pp.x) * pp.y;
  let wV = pp.x * pp.y;
  var dirLen = addGradient(vec3f(0.0), wS, bL, eL, fL, gL, jL);
  dirLen = addGradient(dirLen, wT, cL, fL, gL, hL, kL);
  dirLen = addGradient(dirLen, wU, fL, iL, jL, kL, nL);
  dirLen = addGradient(dirLen, wV, gL, jL, kL, lL, oL);
  var dir = dirLen.xy;
  var len = dirLen.z;
  let dirR = dot(dir, dir);
  if (dirR < (1.0 / 32768.0)) { dir = vec2f(1.0, 0.0); }
  else { dir = dir * inverseSqrt(dirR); }
  len = len * 0.5;
  len = len * len;
  let stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  let len2 = vec2f(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  let lob = 0.5 + ((0.25 - 0.04) - 0.5) * len;
  let clp = 1.0 / max(lob, 1.0e-4);
  var accum = vec4f(0.0);
  accum = addTap(accum, vec2f(0.0, -1.0) - pp, dir, len2, lob, clp, b);
  accum = addTap(accum, vec2f(1.0, -1.0) - pp, dir, len2, lob, clp, c);
  accum = addTap(accum, vec2f(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
  accum = addTap(accum, vec2f(0.0, 0.0) - pp, dir, len2, lob, clp, f);
  accum = addTap(accum, vec2f(1.0, 0.0) - pp, dir, len2, lob, clp, g);
  accum = addTap(accum, vec2f(2.0, 0.0) - pp, dir, len2, lob, clp, h);
  accum = addTap(accum, vec2f(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
  accum = addTap(accum, vec2f(0.0, 1.0) - pp, dir, len2, lob, clp, j);
  accum = addTap(accum, vec2f(1.0, 1.0) - pp, dir, len2, lob, clp, k);
  accum = addTap(accum, vec2f(2.0, 1.0) - pp, dir, len2, lob, clp, l);
  accum = addTap(accum, vec2f(0.0, 2.0) - pp, dir, len2, lob, clp, n);
  accum = addTap(accum, vec2f(1.0, 2.0) - pp, dir, len2, lob, clp, o);
  let resolved = select(f, accum.rgb / accum.a, accum.a > 1.0e-5);
  let min4 = min(min(f, g), min(j, k));
  let max4 = max(max(f, g), max(j, k));
  fragmentOutputs.color = vec4f(clamp(resolved, min4, max4), fSample.a);
}`;

export const RCAS_FRAGMENT_GLSL = `varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec2 inputSize;
uniform float attenuation;
float luma(vec3 color) { return dot(color, vec3(0.25, 0.5, 0.25)); }
float rcp(float value) {
  float signedValue = abs(value) < 1.0e-5 ? (value < 0.0 ? -1.0e-5 : 1.0e-5) : value;
  return 1.0 / signedValue;
}
void main(void) {
  vec2 texel = 1.0 / max(inputSize, vec2(1.0));
  vec3 north = texture2D(textureSampler, vUV + vec2(0.0, -texel.y)).rgb;
  vec3 west = texture2D(textureSampler, vUV + vec2(-texel.x, 0.0)).rgb;
  vec4 centerSample = texture2D(textureSampler, vUV);
  vec3 center = centerSample.rgb;
  vec3 east = texture2D(textureSampler, vUV + vec2(texel.x, 0.0)).rgb;
  vec3 south = texture2D(textureSampler, vUV + vec2(0.0, texel.y)).rgb;
  float northL = luma(north), westL = luma(west), centerL = luma(center), eastL = luma(east), southL = luma(south);
  float noise = 0.25 * (northL + westL + eastL + southL) - centerL;
  float lumaMax = max(max(max(northL, westL), max(centerL, eastL)), southL);
  float lumaMin = min(min(min(northL, westL), min(centerL, eastL)), southL);
  noise = clamp(abs(noise) * rcp(lumaMax - lumaMin), 0.0, 1.0);
  noise = -0.5 * noise + 1.0;
  vec3 ringMin = min(min(north, west), min(east, south));
  vec3 ringMax = max(max(north, west), max(east, south));
  float hitMinR = min(ringMin.r, center.r) * rcp(4.0 * ringMax.r);
  float hitMinG = min(ringMin.g, center.g) * rcp(4.0 * ringMax.g);
  float hitMinB = min(ringMin.b, center.b) * rcp(4.0 * ringMax.b);
  float hitMaxR = (1.0 - max(ringMax.r, center.r)) * rcp(4.0 * ringMin.r - 4.0);
  float hitMaxG = (1.0 - max(ringMax.g, center.g)) * rcp(4.0 * ringMin.g - 4.0);
  float hitMaxB = (1.0 - max(ringMax.b, center.b)) * rcp(4.0 * ringMin.b - 4.0);
  float lobe = max(-0.1875, min(max(max(-hitMinR, hitMaxR), max(max(-hitMinG, hitMaxG), max(-hitMinB, hitMaxB))), 0.0));
  lobe *= attenuation * noise;
  vec3 sharpened = (lobe * (north + west + south + east) + center) * rcp(4.0 * lobe + 1.0);
  vec3 low = min(center, ringMin);
  vec3 high = max(center, ringMax);
  gl_FragColor = vec4(clamp(sharpened, low, high), centerSample.a);
}`;

export const RCAS_FRAGMENT_WGSL = `varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
uniform inputSize: vec2f;
uniform attenuation: f32;
fn luma(color: vec3f) -> f32 { return dot(color, vec3f(0.25, 0.5, 0.25)); }
fn rcp(value: f32) -> f32 {
  let signedValue = select(value, select(1.0e-5, -1.0e-5, value < 0.0), abs(value) < 1.0e-5);
  return 1.0 / signedValue;
}
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let texel = vec2f(1.0) / max(uniforms.inputSize, vec2f(1.0));
  let north = textureSampleLevel(textureSampler, textureSamplerSampler, input.vUV + vec2f(0.0, -texel.y), 0.0).rgb;
  let west = textureSampleLevel(textureSampler, textureSamplerSampler, input.vUV + vec2f(-texel.x, 0.0), 0.0).rgb;
  let centerSample = textureSampleLevel(textureSampler, textureSamplerSampler, input.vUV, 0.0);
  let center = centerSample.rgb;
  let east = textureSampleLevel(textureSampler, textureSamplerSampler, input.vUV + vec2f(texel.x, 0.0), 0.0).rgb;
  let south = textureSampleLevel(textureSampler, textureSamplerSampler, input.vUV + vec2f(0.0, texel.y), 0.0).rgb;
  let northL = luma(north); let westL = luma(west); let centerL = luma(center); let eastL = luma(east); let southL = luma(south);
  var noise = 0.25 * (northL + westL + eastL + southL) - centerL;
  let lumaMax = max(max(max(northL, westL), max(centerL, eastL)), southL);
  let lumaMin = min(min(min(northL, westL), min(centerL, eastL)), southL);
  noise = clamp(abs(noise) * rcp(lumaMax - lumaMin), 0.0, 1.0);
  noise = -0.5 * noise + 1.0;
  let ringMin = min(min(north, west), min(east, south));
  let ringMax = max(max(north, west), max(east, south));
  let hitMinR = min(ringMin.r, center.r) * rcp(4.0 * ringMax.r);
  let hitMinG = min(ringMin.g, center.g) * rcp(4.0 * ringMax.g);
  let hitMinB = min(ringMin.b, center.b) * rcp(4.0 * ringMax.b);
  let hitMaxR = (1.0 - max(ringMax.r, center.r)) * rcp(4.0 * ringMin.r - 4.0);
  let hitMaxG = (1.0 - max(ringMax.g, center.g)) * rcp(4.0 * ringMin.g - 4.0);
  let hitMaxB = (1.0 - max(ringMax.b, center.b)) * rcp(4.0 * ringMin.b - 4.0);
  var lobe = max(-0.1875, min(max(max(-hitMinR, hitMaxR), max(max(-hitMinG, hitMaxG), max(-hitMinB, hitMaxB))), 0.0));
  lobe = lobe * uniforms.attenuation * noise;
  let sharpened = (lobe * (north + west + south + east) + center) * rcp(4.0 * lobe + 1.0);
  let low = min(center, ringMin);
  let high = max(center, ringMax);
  fragmentOutputs.color = vec4f(clamp(sharpened, low, high), centerSample.a);
}`;

const EASU_KEY = "easuPixelShader";
const RCAS_KEY = "rcasPixelShader";

/** Registers both languages. Barrel index files are not imported: their side effects are stripped. */
export function registerSpatialUpscalingShaders(): void {
  Effect.ShadersStore[EASU_KEY] = EASU_FRAGMENT_GLSL;
  Effect.ShadersStore[RCAS_KEY] = RCAS_FRAGMENT_GLSL;
  ShaderStore.ShadersStore[EASU_KEY] = EASU_FRAGMENT_GLSL;
  ShaderStore.ShadersStore[RCAS_KEY] = RCAS_FRAGMENT_GLSL;
  ShaderStore.ShadersStoreWGSL[EASU_KEY] = EASU_FRAGMENT_WGSL;
  ShaderStore.ShadersStoreWGSL[RCAS_KEY] = RCAS_FRAGMENT_WGSL;
}

registerSpatialUpscalingShaders();

export interface SpatialUpscalingSync {
  easu: boolean;
  rcas: boolean;
  attenuation: number;
  renderScale: number;
}

export interface SpatialUpscalingPasses {
  sync(state: SpatialUpscalingSync): void;
  isAttached(): boolean;
  /** Drops GPU resources across a device loss without forgetting the last request. */
  suspend(): void;
  resume(): void;
  dispose(): void;
}

type CameraPasses = Camera & { _postProcesses: Array<PostProcess | null> };

function passesOf(camera: Camera): Array<PostProcess | null> {
  return (camera as CameraPasses)._postProcesses;
}

function setRatio(pass: PostProcess, ratio: number): void {
  const clamped = Math.min(1, Math.max(ratio, 1 / 64));
  // `_options` is the render-size ratio. It is private, and there is no setter.
  const internal = pass as unknown as { _options: number | { width?: number; height?: number } };
  if (internal._options === clamped) return;
  internal._options = clamped;
  pass.markTextureDirty();
}

/**
 * Attaches EASU, then RCAS, to the active camera. EASU's ratio is the internal
 * render scale, so the scene is drawn into that smaller target and reconstructed
 * to the canvas. The browser scaling path attaches nothing.
 */
export function createSpatialUpscalingPasses(scene: Scene, engine: AbstractEngine): SpatialUpscalingPasses {
  let disposed = false;
  let suspended = false;
  let camera: Camera | null = scene.activeCamera;
  let easu: PostProcess | null = null;
  let rcas: PostProcess | null = null;
  let wantedEasu = false;
  let wantedRcas = false;
  let attenuation = 1;
  let renderScale = 1;

  const language = (): ShaderLanguage => engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL;
  const attached = (pass: PostProcess): boolean => camera !== null && passesOf(camera).includes(pass);
  const detach = (pass: PostProcess): void => {
    if (!camera) return;
    const list = passesOf(camera);
    const index = list.indexOf(pass);
    camera.detachPostProcess(pass);
    if (index !== -1 && list[index] === null) list.splice(index, 1);
  };
  const destroyPass = (pass: PostProcess): void => {
    detach(pass);
    pass.dispose(camera ?? undefined);
  };
  const destroyPasses = (): void => {
    if (easu) destroyPass(easu);
    if (rcas) destroyPass(rcas);
    easu = null;
    rcas = null;
  };
  const bind = (pass: PostProcess, index: number | null): void => {
    if (!camera || attached(pass)) return;
    camera.attachPostProcess(pass, index);
  };
  const ensurePass = (name: string, fragment: string, uniforms: string[], apply: (effect: Effect, pass: PostProcess) => void): PostProcess => {
    const pass = new PostProcess(name, fragment, {
      uniforms,
      size: 1,
      samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
      engine,
      shaderLanguage: language(),
      blockCompilation: true,
    });
    pass.onApply = effect => apply(effect, pass);
    return pass;
  };
  const reconcile = (): void => {
    if (disposed || suspended) return;
    const next = scene.activeCamera;
    if (camera && camera !== next) {
      if (easu) detach(easu);
      if (rcas) detach(rcas);
    }
    camera = next;
    if (!wantedEasu && !wantedRcas) {
      destroyPasses();
      return;
    }
    if (!camera) return;
    if (wantedEasu && !easu) {
      easu = ensurePass("EASU", "easu", ["inputSize"], (effect, pass) => {
        effect.setFloat2("inputSize", Math.max(pass.width, 1), Math.max(pass.height, 1));
      });
    }
    if (!wantedEasu && easu) { destroyPass(easu); easu = null; }
    if (wantedRcas && !rcas) {
      rcas = ensurePass("RCAS", "rcas", ["inputSize", "attenuation"], (effect, pass) => {
        effect.setFloat2("inputSize", Math.max(pass.width, 1), Math.max(pass.height, 1));
        effect.setFloat("attenuation", attenuation);
      });
    }
    if (!wantedRcas && rcas) { destroyPass(rcas); rcas = null; }
    if (easu) setRatio(easu, renderScale);
    if (rcas) setRatio(rcas, 1);
    if (easu) bind(easu, 0);
    if (rcas) bind(rcas, null);
  };

  const cameraObserver = scene.onActiveCameraChanged.add(() => reconcile());
  const resizeObserver = engine.onResizeObservable.add(() => {
    easu?.markTextureDirty();
    rcas?.markTextureDirty();
  });

  return {
    sync(state) {
      if (disposed) return;
      wantedEasu = state.easu;
      wantedRcas = state.rcas;
      attenuation = Number.isFinite(state.attenuation) ? state.attenuation : 1;
      renderScale = Number.isFinite(state.renderScale) ? state.renderScale : 1;
      reconcile();
    },
    isAttached: () => (easu !== null && attached(easu)) || (rcas !== null && attached(rcas)),
    suspend() {
      suspended = true;
      destroyPasses();
    },
    resume() {
      if (disposed) return;
      suspended = false;
      reconcile();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      suspended = true;
      scene.onActiveCameraChanged.remove(cameraObserver);
      engine.onResizeObservable.remove(resizeObserver);
      destroyPasses();
    },
  };
}
