import { createFrameProfileSession, bindFrameProfileSettings, createCanvasTextureDevicePorts, createTextureTransferTracker } from "@foss-earth/renderer/babylon";
import { createFrameBudgetPanel, type FrameBudgetPanelOptions } from "@foss-earth/renderer/panel";
import { frameProfilingParameters } from "@foss-earth/renderer/settings";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { Scene } from "@babylonjs/core";

/** This fixture defines the public wiring; the host supplies the shared frame and policy. */
export function mountProfiling(host: {
  scene: Scene; settings: SettingsRegistry; nowMs(): number;
  subscribeRefresh(listener: () => void): () => void;
  ui: FrameBudgetPanelOptions["ui"]; actions: FrameBudgetPanelOptions["actions"];
}) {
  host.settings.register(frameProfilingParameters({ tab: "renderer", section: "performance" }));
  const session = createFrameProfileSession({ scene: host.scene, engine: host.scene.getEngine(), now: host.nowMs });
  const unbind = bindFrameProfileSettings(host.settings, session);
  const panel = createFrameBudgetPanel({ session, settings: host.settings, ui: host.ui, actions: host.actions,
    refreshPort: { nowMs: host.nowMs, subscribe: host.subscribeRefresh } });
  return { panel, session, beforeFrame: session.frame, dispose() { panel.destroy(); unbind(); session.dispose(); } };
}

export function canvasTextures(host: Parameters<typeof createTextureTransferTracker>[0] & {
  createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas;
}) {
  const transfers = createTextureTransferTracker(host);
  const textures = createCanvasTextureDevicePorts({ scene: host.scene, createCanvas: host.createCanvas, transfer: transfers.transfer });
  return { textures, transfers };
}
