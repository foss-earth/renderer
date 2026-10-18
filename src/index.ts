export { createRenderScheduler } from "./renderScheduler.js";
export * from "./borrowedFrameClosure.js";
export * from "./featureFramePreparation.js";
export type { RenderScheduler, WorkRenderScheduler, RenderSchedulerOptions, RenderFrameCallback } from "./renderScheduler.js";
export { checkUntilSettled, defaultReadinessPolicy } from "./readiness.js";
export type { ReadinessPolicy, ReadinessTimers } from "./readiness.js";
export { createRendererResourceLifecycle } from "./resourceLifecycle.js";
export type { RendererIdentity, RendererGeneration, ResourceDescriptor, RendererResource, RendererResourceLifecycleOptions, RendererResourceLifecycle } from "./resourceLifecycle.js";
export type { RendererMode, RendererDiagnostics, RendererSelection, RendererModeOptions } from "./rendererTypes.js";
export {
  RENDERER_PREFERENCE_STORAGE_KEY, RENDERER_FALLBACK_STORAGE_KEY, RENDERER_FALLBACK_RETRY_MS,
  RENDERER_WEBGPU_VERIFIED_STORAGE_KEY, RENDERER_WEBGPU_VERIFIED_MS,
  readRendererPreference, saveRendererPreference, clearRendererPreference, readRendererFallback, saveRendererFallback, staleFallbackReason,
  readWebGpuVerification, saveWebGpuVerification, webGpuVerificationHolds,
} from "./rendererPreference.js";
export type { RendererPreferenceStorage, RendererFallback, RendererFallbackFacts, WebGpuVerification } from "./rendererPreference.js";
export { describeRendererStart, getRendererLabel } from "./rendererStartNote.js";
export type { RendererStartNote } from "./rendererStartNote.js";
export {
  adviseRenderer, identifyBrowser, readDismissedAdvice, dismissAdvice, RENDERER_ADVICE_DISMISSED_STORAGE_KEY, WEBGPU_ON_A_PHONE_DOCS,
} from "./rendererAdvice.js";
export type { RendererAdvice, RendererAdviceId, RendererFacts, BrowserIdentity, BrowserFamily, BrowserPlatform } from "./rendererAdvice.js";
export * from "./profiling/index.js";
export type { TextureTransferOutcome, TextureTransferRetirement, TextureTransferAdmission, TryAdmitTextureTransfer } from "./textureTransferTypes.js";
