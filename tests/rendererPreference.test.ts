import { describe, expect, it, vi } from "vitest";
import {
  readRendererPreference, saveRendererPreference, clearRendererPreference, readRendererFallback, saveRendererFallback, staleFallbackReason,
  RENDERER_PREFERENCE_STORAGE_KEY, RENDERER_FALLBACK_STORAGE_KEY, RENDERER_FALLBACK_RETRY_MS, type RendererFallback,
  readWebGpuVerification, saveWebGpuVerification, webGpuVerificationHolds, RENDERER_WEBGPU_VERIFIED_STORAGE_KEY, RENDERER_WEBGPU_VERIFIED_MS,
  type WebGpuVerification,
} from "../src/rendererPreference.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const fallback: RendererFallback = { mode: "webgl2", reason: "probe failed", at: 1_000_000, isSecureContext: true, navigatorGpuPresent: true, userAgent: "Chrome/141" };

describe("host-owned remembered renderer", () => {
  it("validates remembered working modes and uses the retained storage key", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    expect(readRendererPreference(storage)).toBeNull();
    saveRendererPreference("webgl", storage);
    expect(values.get(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgl");
    expect(readRendererPreference(storage)).toBe("webgl");
    values.set(RENDERER_PREFERENCE_STORAGE_KEY, "unsupported");
    expect(readRendererPreference(storage)).toBeNull();
    clearRendererPreference(storage);
    expect(values.size).toBe(0);
  });
  it("keeps auto detection available when persistence is denied", () => {
    const denied = vi.fn(() => { throw new Error("storage denied"); });
    const storage = { getItem: denied, setItem: denied, removeItem: denied };
    expect(readRendererPreference(storage)).toBeNull();
    expect(() => saveRendererPreference("webgpu", storage)).not.toThrow();
    expect(() => clearRendererPreference(storage)).not.toThrow();
  });
  it("saves a fallback as JSON beside the preference, reads back only a whole one, and forgets it with null", () => {
    const storage = memoryStorage();
    saveRendererFallback(fallback, storage);
    expect(readRendererFallback(storage)).toEqual(fallback);
    expect(readRendererPreference(storage)).toBeNull();
    storage.values.set(RENDERER_FALLBACK_STORAGE_KEY, JSON.stringify({ ...fallback, at: "yesterday" }));
    expect(readRendererFallback(storage)).toBeNull();
    storage.values.set(RENDERER_FALLBACK_STORAGE_KEY, JSON.stringify({ ...fallback, mode: "webgpu" }));
    expect(readRendererFallback(storage)).toBeNull();
    storage.values.set(RENDERER_FALLBACK_STORAGE_KEY, "{not json");
    expect(readRendererFallback(storage)).toBeNull();
    saveRendererFallback(null, storage);
    expect(storage.values.has(RENDERER_FALLBACK_STORAGE_KEY)).toBe(false);
  });
  it("forgets the fallback with the preference when the visitor chooses Auto-detect", () => {
    const storage = memoryStorage();
    saveRendererPreference("webgpu", storage);
    saveRendererFallback(fallback, storage);
    clearRendererPreference(storage);
    expect(storage.values.size).toBe(0);
  });
  it("holds a fallback until what it depended on changes, or for three days", () => {
    const now = { ...fallback, at: fallback.at + 1000 };
    expect(staleFallbackReason(fallback, now)).toBeNull();
    expect(staleFallbackReason({ ...fallback, isSecureContext: false }, now)).toContain("secure context");
    expect(staleFallbackReason({ ...fallback, isSecureContext: false }, { ...now, isSecureContext: false })).toBeNull();
    expect(staleFallbackReason({ ...fallback, navigatorGpuPresent: false }, now)).toContain("offers WebGPU");
    // Losing WebGPU is no reason to try it again.
    expect(staleFallbackReason(fallback, { ...now, navigatorGpuPresent: false })).toBeNull();
    expect(staleFallbackReason(fallback, { ...now, userAgent: "Chrome/142" })).toContain("browser has changed");
    expect(staleFallbackReason(fallback, { ...now, at: fallback.at + RENDERER_FALLBACK_RETRY_MS - 1 })).toBeNull();
    expect(staleFallbackReason(fallback, { ...now, at: fallback.at + RENDERER_FALLBACK_RETRY_MS })).toContain("three days");
    // A clock set back cannot keep a fallback for ever.
    expect(staleFallbackReason(fallback, { ...now, at: fallback.at - 1 })).toContain("three days");
  });
  it("saves a passed probe as JSON, reads back only a whole one, and forgets it with null or Auto-detect", () => {
    const storage = memoryStorage();
    const verification: WebGpuVerification = { antialias: true, adaptToDeviceRatio: true, userAgent: "Chrome/141", at: 1_000_000 };
    saveWebGpuVerification(verification, storage);
    expect(JSON.parse(storage.values.get(RENDERER_WEBGPU_VERIFIED_STORAGE_KEY)!)).toEqual(verification);
    expect(readWebGpuVerification(storage)).toEqual(verification);
    storage.values.set(RENDERER_WEBGPU_VERIFIED_STORAGE_KEY, JSON.stringify({ ...verification, antialias: "yes" }));
    expect(readWebGpuVerification(storage)).toBeNull();
    storage.values.set(RENDERER_WEBGPU_VERIFIED_STORAGE_KEY, "{not json");
    expect(readWebGpuVerification(storage)).toBeNull();
    saveWebGpuVerification(null, storage);
    expect(storage.values.size).toBe(0);
    saveWebGpuVerification(verification, storage);
    clearRendererPreference(storage);
    expect(storage.values.size).toBe(0);
  });
  it("holds a passed probe in the same browser for 30 days", () => {
    const verification: WebGpuVerification = { antialias: true, adaptToDeviceRatio: true, userAgent: "Chrome/141", at: 1_000_000 };
    expect(webGpuVerificationHolds(verification, { userAgent: "Chrome/141", at: verification.at + 1 })).toBe(true);
    expect(webGpuVerificationHolds(verification, { userAgent: "Chrome/142", at: verification.at + 1 })).toBe(false);
    expect(webGpuVerificationHolds(verification, { userAgent: "Chrome/141", at: verification.at + RENDERER_WEBGPU_VERIFIED_MS })).toBe(false);
    expect(webGpuVerificationHolds(verification, { userAgent: "Chrome/141", at: verification.at - 1 })).toBe(false);
  });
});
