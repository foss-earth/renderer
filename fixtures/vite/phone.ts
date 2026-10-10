import { createRenderScheduler } from "@foss-earth/renderer";

// An initial/phone entry may use pure scheduler contracts without loading a GPU
// renderer. The public Babylon adapter is reached only through this dynamic edge.
export { createRenderScheduler };
export const phoneReady = true;
export const loadRenderer = () => import("./renderer.js");

// Keep the app entry observable under Vite's application tree-shaking semantics.
// The proof builds these bytes; it does not execute them in a browser.
Object.defineProperty(globalThis, "rendererBuildFixture", {
  configurable: true,
  value: { createRenderScheduler, phoneReady, loadRenderer },
});
