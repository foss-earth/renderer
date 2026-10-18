// @vitest-environment jsdom
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { describe, expect, it, vi } from "vitest";
import { createRendererPanel } from "../src/panel/rendererPanel.js";
import type { RendererPanelUiPort, RendererPanelSection } from "../src/panel/types.js";
import { RENDERER_PARAMETERS } from "../src/settings/catalogue.js";

/** Deliberately small injected UI fake, not a copy of the UI implementation. */
function uiFixture() {
  const destroy = vi.fn();
  const parameterSection = vi.fn<RendererPanelUiPort["createParameterSection"]>((_settings, options) => ({ element: options.main!, destroy }));
  const appendHost = vi.fn<RendererPanelUiPort["appendHostSections"]>(() => ({ destroy }));
  const ui: RendererPanelUiPort = {
    document, isInput: (value): value is HTMLInputElement => value instanceof HTMLInputElement,
    createChoiceGroup(name, _heading, choices) { const group = document.createElement("div"); for (const choice of choices) { const input = document.createElement("input"); input.type = "radio"; input.name = name; input.value = choice.id; group.append(input); } return group; },
    createChoiceNote(text) { const note = document.createElement("p"); note.textContent = text; return note; },
    checkChoice(root, name, id) { for (const input of root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) input.checked = input.value === id; },
    createParameterSection: parameterSection,
    createSectionsElement(initial) { const element = document.createElement("div"); const ids = new Set<string>(); const append = (entry: RendererPanelSection) => { ids.add(entry.id); element.append(entry.element); }; initial.forEach(append); return { element, append, has: id => ids.has(id), destroy }; },
    appendHostSections: appendHost,
  };
  return { ui, destroy, parameterSection, appendHost };
}

describe("injected Renderer panel", () => {
  it("preserves forced fallback diagnostics and backend choice using the supplied registry/UI", () => {
    const settings = createSettingsRegistry(); settings.register(RENDERER_PARAMETERS);
    const f = uiFixture();
    const onChange = vi.fn();
    const section = { id: "performance", title: "Host diagnostics", element: document.createElement("div") };
    const panel = createRendererPanel({ renderer: { mode: "webgl2", requested: "webgpu", fallbackReason: "adapter lost", diagnostics: { navigatorGpuPresent: true, isSupportedAsyncResult: false, isSecureContext: true } }, settings, ui: f.ui, onChange, sections: [section] });
    document.body.append(panel.element);
    expect(panel.element.textContent).toContain("Running on WebGL2. WebGPU was chosen but did not start.");
    expect(panel.element.querySelector("pre")?.textContent).toContain("Error: adapter lost");
    expect(panel.element.querySelector<HTMLInputElement>("input:checked")?.value).toBe("webgpu");
    expect(f.parameterSection.mock.calls[0][0] === settings).toBe(true);
    expect(f.parameterSection.mock.calls[0][1]).toMatchObject({ tab: "renderer", section: "backend", covers: ["renderer.backend"] });
    expect(f.appendHost.mock.calls[0][0] === settings).toBe(true);
    expect(f.appendHost.mock.calls[0][1]).toBe("renderer");
    expect(f.appendHost.mock.calls[0][3]).toEqual(["backend", "performance"]);
    panel.element.querySelector<HTMLInputElement>('input[value="auto"]')!.click();
    expect(onChange).toHaveBeenLastCalledWith(null);
    panel.element.querySelector<HTMLInputElement>('input[value="webgl"]')!.click();
    expect(onChange).toHaveBeenLastCalledWith("webgl");
    panel.destroy(); panel.destroy();
    expect(f.destroy).toHaveBeenCalledTimes(3);
  });
  it("says when an automatic WebGL came from a saved fallback, and when WebGPU is tried again", () => {
    const settings = createSettingsRegistry(); settings.register(RENDERER_PARAMETERS);
    const at = Date.UTC(2026, 9, 12, 8);
    const panel = createRendererPanel({ renderer: { mode: "webgl2", requested: "auto", fallbackReason: "probe failed",
      diagnostics: { navigatorGpuPresent: true, isSupportedAsyncResult: null, isSecureContext: true, fromPersistedPreference: true, fallbackSavedAt: at } },
    settings, ui: uiFixture().ui, onChange: vi.fn() });
    const text = panel.element.querySelector("pre")?.textContent;
    expect(text).toContain("Error: probe failed");
    expect(text).toContain("Saved fallback from 2026-10-12: WebGPU is tried again from 2026-10-15, or sooner if the browser changes.");
    panel.destroy();
  });

  it("lists the advice with each step of its fix and its guide", () => {
    const settings = createSettingsRegistry(); settings.register(RENDERER_PARAMETERS);
    const panel = createRendererPanel({ renderer: { mode: "webgl2", requested: "auto", diagnostics: { navigatorGpuPresent: false, isSupportedAsyncResult: false, isSecureContext: false } },
      settings, ui: uiFixture().ui, onChange: vi.fn(),
      advice: [{ id: "insecure-origin", tone: "warning", text: "WebGPU needs HTTPS.", fix: ["Forward the port."], docs: "https://example.org/guide" }] });
    const list = panel.element.querySelector(".foss-earth-renderer-advice");
    expect([...list!.querySelectorAll("p")].map(note => note.textContent)).toEqual(["WebGPU needs HTTPS.", "Forward the port.", "The guide"]);
    expect(list!.querySelector("[data-advice-id]")?.getAttribute("data-advice-id")).toBe("insecure-origin");
    expect(list!.querySelector("a")?.href).toBe("https://example.org/guide");
    panel.destroy();
  });

  it("keeps the Sky exposure/fill controls out of the renderer catalogue", () => {
    expect(RENDERER_PARAMETERS.some(spec => spec.id === "renderer.exposureEV" || spec.id === "renderer.ambientFillMultiplier")).toBe(false);
  });
});
