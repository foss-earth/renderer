import { describe, expect, it, vi } from "vitest";
import { applyRendererChoice } from "../src/babylon/browserRenderer.js";
import { RENDERER_PREFERENCE_STORAGE_KEY } from "../src/rendererPreference.js";

describe("renderer choice host reload", () => {
  it("saves Auto, forgets the working preference and strips both legacy URL overrides", () => {
    const set = vi.fn();
    const assign = vi.fn();
    const removeItem = vi.fn();
    applyRendererChoice(null, { set }, { href: "https://renderer.invalid/?renderer=webgl&set.renderer.backend=webgpu&dev=1#view", assign }, { getItem: () => null, setItem: vi.fn(), removeItem });
    expect(set).toHaveBeenCalledWith("renderer.backend", "auto");
    expect(removeItem).toHaveBeenCalledWith(RENDERER_PREFERENCE_STORAGE_KEY);
    expect(assign).toHaveBeenCalledWith("https://renderer.invalid/?dev=1#view");
  });
});
