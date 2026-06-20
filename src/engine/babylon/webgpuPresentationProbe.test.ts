// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { isWebGpuPresentationError } from "./webgpuPresentationProbe";

describe("isWebGpuPresentationError", () => {
  it("detects swapchain import memory failures", () => {
    expect(isWebGpuPresentationError(
      "Requested allocation size (204800) is smaller than the image requires (311296).",
    )).toBe(true);
  });

  it("detects invalid resolve target failures", () => {
    expect(isWebGpuPresentationError(
      '[Invalid TextureView "TextureView_SwapChain_ResolveTarget"] is invalid.',
    )).toBe(true);
  });

  it("ignores unrelated shader errors", () => {
    expect(isWebGpuPresentationError("Shader module compilation failed.")).toBe(false);
  });
});
