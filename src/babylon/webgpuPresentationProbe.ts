import { FreeCamera, Vector3, type Scene, type WebGPUEngine } from "@babylonjs/core";
interface PresentationErrorDevice { addEventListener(type: string, listener: EventListener): void; removeEventListener(type: string, listener: EventListener): void; }
interface PresentationErrorEvent extends Event { error?: { message?: string }; }

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

function getGpuDevice(engine: WebGPUEngine): PresentationErrorDevice | null {
  if ("device" in engine) {
    const device = (engine as WebGPUEngine & { device?: PresentationErrorDevice }).device;
    if (device) return device;
  }
  return (engine as unknown as { _device?: PresentationErrorDevice })._device ?? null;
}

export interface PresentationProbePolicy {
  frames: number;
  settleFrameCount: number;
  settleMs: number;
}
export const defaultPresentationProbePolicy: Readonly<PresentationProbePolicy> = Object.freeze({ frames: 3, settleFrameCount: 4, settleMs: 75 });
export interface WebGpuPresentationProbeOptions {
  nextFrame(): Promise<void>;
  delay(ms: number): Promise<void>;
  policy?: Readonly<PresentationProbePolicy>;
}
async function waitForPresentationErrors(options: WebGpuPresentationProbeOptions, policy: Readonly<PresentationProbePolicy>): Promise<void> {
  for (let i = 0; i < policy.settleFrameCount; i += 1) await options.nextFrame();
  await options.delay(policy.settleMs);
}

export interface WebGpuPresentationProbeResult {
  ok: boolean;
  errors: string[];
}

/**
 * Render several frames on the provided scene to verify the WebGPU swap chain
 * can present. Bootstrap supplies its disposable offscreen scene so a failed
 * probe leaves the runtime canvas available to WebGL.
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
  options: WebGpuPresentationProbeOptions,
): Promise<WebGpuPresentationProbeResult> {
  const policy = options.policy ?? defaultPresentationProbePolicy;
  if (!Number.isInteger(policy.frames) || policy.frames < 1 || !Number.isInteger(policy.settleFrameCount) || policy.settleFrameCount < 0 || !Number.isFinite(policy.settleMs) || policy.settleMs < 0) throw new RangeError("Presentation probe frames must be >= 1; settle frames/ms must be >= 0.");
  const errors: string[] = [];
  const onUncapturedError: EventListener = (event): void => {
    const gpuError = (event as PresentationErrorEvent).error;
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

      for (let frame = 0; frame < policy.frames; frame += 1) {
        engine.beginFrame();
        scene.render();
        engine.endFrame();
        await waitForPresentationErrors(options, policy);
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
