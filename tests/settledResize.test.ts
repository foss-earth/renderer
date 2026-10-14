import { expect, it } from "vitest";
import { createBrowserRendererPlatform } from "../src/babylon/browserRenderer.js";

function harness() {
  const listeners = new Map<string, Set<() => void>>();
  const timers = new Map<number, () => void>();
  const frames = new Map<number, () => void>();
  let id = 1;
  let box = { width: 200, height: 100 };
  const root = { dataset: {} as Record<string, string | undefined> };
  const canvas = {
    style: { width: "", height: "" },
    getBoundingClientRect: () => ({ width: box.width, height: box.height, top: 0, left: 0, right: box.width, bottom: box.height, x: 0, y: 0, toJSON() { return {}; } }),
  };
  // One media query per density watched; `change` fires when the ratio leaves it.
  const queries: { media: string; listeners: Set<() => void> }[] = [];
  const view = {
    devicePixelRatio: 1,
    matchMedia(media: string) {
      const query = { media, listeners: new Set<() => void>() };
      queries.push(query);
      return {
        media,
        addEventListener: (_type: string, fn: () => void) => { query.listeners.add(fn); },
        removeEventListener: (_type: string, fn: () => void) => { query.listeners.delete(fn); },
      };
    },
    document: { documentElement: root, hidden: false },
    addEventListener(type: string, fn: () => void) {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: () => void) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event: Event) {
      for (const fn of [...(listeners.get(event.type) ?? [])]) fn();
      return true;
    },
    setTimeout(fn: () => void) { const handle = id++; timers.set(handle, fn); return handle; },
    clearTimeout(handle: number) { timers.delete(handle); },
    requestAnimationFrame(fn: () => void) { const handle = id++; frames.set(handle, fn); return handle; },
    cancelAnimationFrame(handle: number) { frames.delete(handle); },
  };
  const platform = createBrowserRendererPlatform({
    window: view as unknown as Window,
    document: view.document as unknown as Document,
    canvas: canvas as unknown as HTMLElement,
  });
  return {
    root, canvas, platform,
    resizeTo(width: number, height: number) { box = { width, height }; },
    fire(type: string) { view.dispatchEvent(new Event(type)); },
    flush() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
      const framed = [...frames.values()];
      frames.clear();
      for (const fn of framed) fn();
    },
    pending: () => timers.size,
    /** The display's density changes; the browser fires `change` on the query that matched before. */
    setDensity(ratio: number) {
      view.devicePixelRatio = ratio;
      for (const query of [...queries]) for (const fn of [...query.listeners]) fn();
    },
    watched: () => queries.filter(query => query.listeners.size > 0).map(query => query.media),
  };
}

it("resizes immediately until release mode is chosen", () => {
  const { platform, canvas, fire } = harness();
  const seen: number[] = [];
  platform.onResize(() => seen.push(seen.length + 1));
  fire("resize");
  expect(seen).toEqual([1]);
  expect(canvas.style.width).toBe("");
});

it("keeps the previous drawing size until the browser window stops changing shape", () => {
  const { platform, canvas, root, fire, flush, resizeTo, pending } = harness();
  root.dataset.worldResize = "release";
  let draws = 0;
  platform.onResize(() => { draws += 1; });
  resizeTo(360, 240);
  fire("resize");
  fire("resize");
  expect(draws).toBe(0);
  expect(pending()).toBe(1);
  expect(canvas.style.width).toBe("200px");
  expect(canvas.style.height).toBe("100px");
  expect(root.dataset.worldDrawHeld).toBe("true");
  flush();
  expect(draws).toBe(1);
  expect(canvas.style.width).toBe("");
  expect(root.dataset.worldDrawHeld).toBeUndefined();
});

it("resizes once when a panel drag ends and ignores shape changes during the drag", () => {
  const { platform, canvas, root, fire, flush, resizeTo } = harness();
  root.dataset.worldResize = "release";
  let draws = 0;
  platform.onResize(() => { draws += 1; });
  fire("foss-earth-panel-resize-start");
  resizeTo(360, 240);
  fire("resize");
  expect(draws).toBe(0);
  expect(canvas.style.width).toBe("");
  fire("foss-earth-panel-resize-end");
  expect(draws).toBe(0);
  flush();
  expect(draws).toBe(1);
});

it("redraws when the device pixel ratio changes without a change of shape, and watches the new ratio", () => {
  const { platform, setDensity, watched } = harness();
  let draws = 0;
  const stop = platform.onResize(() => { draws += 1; });
  expect(watched()).toEqual(["(resolution: 1dppx)"]);
  setDensity(2);
  expect(draws).toBe(1);
  expect(watched()).toEqual(["(resolution: 2dppx)"]);
  setDensity(1);
  expect(draws).toBe(2);
  stop();
  expect(watched()).toEqual([]);
});
