// @vitest-environment jsdom
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { describe, expect, it, vi } from "vitest";
import { createRendererPanel } from "../src/panel/rendererPanel.js";
import type { RendererChoiceGroupOptions, RendererPanelUiPort, RendererPanelSection } from "../src/panel/types.js";
import { RENDERER_PARAMETERS } from "../src/settings/catalogue.js";

/** Deliberately small injected UI fake, not a copy of the UI implementation. */
function uiFixture() {
  const destroy = vi.fn();
  const parameterSection = vi.fn<RendererPanelUiPort["createParameterSection"]>((_settings, options) => ({ element: options.main!, destroy }));
  const appendHost = vi.fn<RendererPanelUiPort["appendHostSections"]>(() => ({ destroy }));
  const groupOptions = vi.fn<(options: RendererChoiceGroupOptions | undefined) => void>();
  const help = (content: HTMLElement) => { const element = document.createElement("span"); element.className = "help"; element.append(content); return element; };
  const ui: RendererPanelUiPort = {
    document, isInput: (value): value is HTMLInputElement => value instanceof HTMLInputElement,
    createChoiceGroup(name, _heading, choices, options) {
      groupOptions(options);
      const group = document.createElement("div");
      for (const choice of choices) { const input = document.createElement("input"); input.type = "radio"; input.name = name; input.value = choice.id; group.append(input); }
      if (options?.status) group.append(options.status);
      if (options?.help instanceof HTMLElement) group.append(help(options.help));
      return group;
    },
    createChoiceNote(text) { const note = document.createElement("p"); note.textContent = text; return note; },
    checkChoice(root, name, id) { for (const input of root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) input.checked = input.value === id; },
    createHelpTooltip: ({ content }) => ({ element: help(content), destroy }),
    createParameterSection: parameterSection,
    createSectionsElement(initial) { const element = document.createElement("div"); const ids = new Set<string>(); const append = (entry: RendererPanelSection) => { ids.add(entry.id); element.append(entry.element); }; initial.forEach(append); return { element, append, has: id => ids.has(id), destroy }; },
    appendHostSections: appendHost,
  };
  return { ui, destroy, parameterSection, appendHost, groupOptions };
}

describe("injected Renderer panel", () => {
  it("saves a choice as pending, applies it only on Apply & reload, and keeps forced fallback diagnostics behind ?", () => {
    const settings = createSettingsRegistry(); settings.register(RENDERER_PARAMETERS);
    settings.set("renderer.backend", "webgpu");
    const f = uiFixture();
    const onChange = vi.fn();
    const section = { id: "performance", title: "Host diagnostics", element: document.createElement("div") };
    const panel = createRendererPanel({ renderer: { mode: "webgl2", requested: "webgpu", fallbackReason: "adapter lost", diagnostics: { navigatorGpuPresent: true, isSupportedAsyncResult: false, isSecureContext: true } }, settings, ui: f.ui, onChange, sections: [section] });
    document.body.append(panel.element);
    // Auto, no repeated title, the actual running renderer, and the failure in one terse visible line.
    expect(f.groupOptions.mock.calls[0][0]).toMatchObject({ hideHeading: true });
    const status = f.groupOptions.mock.calls[0][0]!.status!;
    expect(status.textContent).toBe("WebGL2 running");
    expect([...panel.element.querySelectorAll(":scope p")].filter(note => !note.closest(".help")).map(note => note.textContent)).toEqual(["WebGPU did not start: adapter lost."]);
    const help = f.groupOptions.mock.calls[0][0]!.help as HTMLElement;
    expect(help.textContent).toContain("Running on WebGL2. WebGPU was chosen but did not start.");
    expect(help.textContent).toContain("Apply & reload");
    expect(help.querySelector("pre")?.textContent).toContain("Error: adapter lost");
    expect(panel.element.querySelector<HTMLInputElement>("input:checked")?.value).toBe("webgpu");
    expect(f.parameterSection.mock.calls[0][0] === settings).toBe(true);
    expect(f.parameterSection.mock.calls[0][1]).toMatchObject({ tab: "renderer", section: "backend", covers: ["renderer.backend"] });
    expect(f.appendHost.mock.calls[0][0] === settings).toBe(true);
    expect(f.appendHost.mock.calls[0][1]).toBe("renderer");
    expect(f.appendHost.mock.calls[0][3]).toEqual(["backend", "performance"]);
    const reload = f.parameterSection.mock.calls[0][1].reload!;
    panel.element.querySelector<HTMLInputElement>('input[value="auto"]')!.click();
    expect(settings.get("renderer.backend")).toBe("auto");
    expect(onChange).not.toHaveBeenCalled();
    reload();
    expect(onChange).toHaveBeenLastCalledWith(null);
    panel.element.querySelector<HTMLInputElement>('input[value="webgl"]')!.click();
    reload();
    expect(onChange).toHaveBeenLastCalledWith("webgl");
    // Discard returns the registry to this start's value, and the track follows.
    settings.set("renderer.backend", "webgpu");
    expect(panel.element.querySelector<HTMLInputElement>("input:checked")?.value).toBe("webgpu");
    panel.destroy(); panel.destroy();
    expect(f.destroy).toHaveBeenCalledTimes(3);
  });
  it("says when an automatic WebGL came from a saved fallback, and when WebGPU is tried again, behind ?", () => {
    const settings = createSettingsRegistry(); settings.register(RENDERER_PARAMETERS);
    const at = Date.UTC(2026, 9, 12, 8);
    const f = uiFixture();
    const panel = createRendererPanel({ renderer: { mode: "webgl2", requested: "auto", fallbackReason: "probe failed",
      diagnostics: { navigatorGpuPresent: true, isSupportedAsyncResult: null, isSecureContext: true, fromPersistedPreference: true, fallbackSavedAt: at } },
    settings, ui: f.ui, onChange: vi.fn() });
    const text = (f.groupOptions.mock.calls[0][0]!.help as HTMLElement).querySelector("pre")?.textContent;
    expect(text).toContain("Error: probe failed");
    expect(text).toContain("Saved fallback from 2026-10-12: WebGPU is tried again from 2026-10-15, or sooner if the browser changes.");
    // A saved fallback is not this start's failure.
    expect([...panel.element.querySelectorAll("p")].filter(note => !note.closest(".help"))).toHaveLength(0);
    panel.destroy();
  });

  it("shows each advice as a terse line, with its fix and guide behind ?", () => {
    const settings = createSettingsRegistry(); settings.register(RENDERER_PARAMETERS);
    const panel = createRendererPanel({ renderer: { mode: "webgl2", requested: "auto", diagnostics: { navigatorGpuPresent: false, isSupportedAsyncResult: false, isSecureContext: false } },
      settings, ui: uiFixture().ui, onChange: vi.fn(),
      advice: [{ id: "insecure-origin", tone: "warning", text: "WebGPU needs HTTPS.", fix: ["Forward the port."], docs: "https://example.org/guide" }] });
    const row = panel.element.querySelector<HTMLElement>(".foss-earth-renderer-advice")!;
    expect(row.dataset.adviceId).toBe("insecure-origin");
    expect([...row.querySelectorAll(":scope > p")].map(note => note.textContent)).toEqual(["WebGPU needs HTTPS."]);
    const fix = row.querySelector(".help")!;
    expect([...fix.querySelectorAll("p")].map(note => note.textContent)).toEqual(["Forward the port.", "The guide"]);
    expect(fix.querySelector("a")?.href).toBe("https://example.org/guide");
    expect(row.lastElementChild).toBe(fix);
    panel.destroy();
  });

  it("keeps the Sky exposure/fill controls out of the renderer catalogue", () => {
    expect(RENDERER_PARAMETERS.some(spec => spec.id === "renderer.exposureEV" || spec.id === "renderer.ambientFillMultiplier")).toBe(false);
  });
});
