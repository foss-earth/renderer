import { describe, expect, it, vi } from "vitest";
import { readRendererPreference, saveRendererPreference, clearRendererPreference, RENDERER_PREFERENCE_STORAGE_KEY } from "../src/rendererPreference.js";

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
});
