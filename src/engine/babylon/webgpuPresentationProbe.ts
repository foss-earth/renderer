import { FreeCamera, Vector3, type Scene, type WebGPUEngine } from "@babylonjs/core";

export function isWebGpuPresentationError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("importmemory")
    || lower.includes("allocation size")
    || lower.includes("invalid texture")
    || lower.includes("invalid textureview")
    || lower.includes("swapchain")
    || lower.includes("resolve")
    || lower.includes("invalid commandbuffer")
    || lower.includes("destroyed texture")
  );
}

function getGpuDevice(engine: WebGPUEngine): GPUDevice | null {
  if ("device" in engine) {
    const device = (engine as WebGPUEngine & { device?: GPUDevice }).device;
    if (device) return device;
  }
  return (engine as unknown as { _device?: GPUDevice })._device ?? null;
}

/** Dawn/Vulkan often reports swap-chain failures after the submit returns. */
const PRESENTATION_PROBE_FRAMES = 3;
const PRESENTATION_ERROR_SETTLE_RAF_COUNT = 4;
const PRESENTATION_ERROR_SETTLE_MS = 75;

async function waitForPresentationErrors(): Promise<void> {
  for (let i = 0; i < PRESENTATION_ERROR_SETTLE_RAF_COUNT; i += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, PRESENTATION_ERROR_SETTLE_MS);
  });
}

export interface WebGpuPresentationProbeResult {
  ok: boolean;
  errors: string[];
}

/**
 * Render several frames on the provided scene to verify the WebGPU swap chain
 * can present. The scene is the real runtime scene — not a throwaway.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function probeWebGpuPresentation(
  engine: WebGPUEngine,
  scene: Scene,
): Promise<WebGpuPresentationProbeResult> {
  const errors: string[] = [];
  const onUncapturedError: EventListener = (event): void => {
    const gpuError = (event as GPUUncapturedErrorEvent).error;
    const message = gpuError?.message ?? String(gpuError);
    errors.push(message);
  };

  const device = getGpuDevice(engine);
  device?.addEventListener("uncapturederror", onUncapturedError);

  // Swap-chain presentation requires a render pass; the runtime camera is not
  // attached yet, so use a disposable probe camera and remove it before tiles load.
  const probeCamera = new FreeCamera(
    "__webgpu_presentation_probe__",
    new Vector3(0, 0, -1),
    scene,
  );
  scene.activeCamera = probeCamera;

  try {
    try {
      // Match runtime dimensions before probing — swap-chain size mismatches
      // (e.g. DPR / canvas CSS vs backing store) are a common WebGPU failure mode.
      engine.resize();

      for (let frame = 0; frame < PRESENTATION_PROBE_FRAMES; frame += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await waitForPresentationErrors();
      }
    } catch (error) {
      errors.push(getErrorMessage(error));
    }

    const presentationErrors = errors.filter(isWebGpuPresentationError);
    return {
      ok: presentationErrors.length === 0 && errors.length === 0,
      errors: presentationErrors.length > 0 ? presentationErrors : errors,
    };
  } finally {
    probeCamera.dispose();
    if (scene.activeCamera === probeCamera) {
      scene.activeCamera = null;
    }
    device?.removeEventListener("uncapturederror", onUncapturedError);
  }
}
