import type { RendererMode, RendererSelection } from "../rendererTypes.js";
import { getRendererLabel } from "../rendererStartNote.js";
import { RENDERER_FALLBACK_RETRY_MS } from "../rendererPreference.js";
import type { RendererAdvice } from "../rendererAdvice.js";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
import type { RendererPanelUiPort, RendererPanelSection } from "./types.js";

const RENDERER_CHOICE_NAME = "foss-earth-renderer";

export interface RendererPanelOptions {
  /** The runtime's `renderer`: what runs, what was asked for, and why they differ. */
  renderer: Pick<RendererSelection, "mode" | "requested" | "fallbackReason" | "diagnostics">;
  /**
   * The user's choice, or null for auto-detect. A renderer only changes on a
   * reload, so the host saves the choice and reloads.
   */
  onChange(force: RendererMode | null): void;
  /** The registry of the tab's parameters; the app's when omitted. */
  settings: SettingsRegistry;
  /** UI-owned factories plus the host document/input realm; no UI implementation is copied. */
  ui: RendererPanelUiPort;
  /**
   * Sections an app draws itself for sections of this tab, by section id
   * ("performance" for renderer/performance), such as FOSS Earth's
   * Performance debug. They follow the tab's other sections.
   */
  sections?: readonly RendererPanelSection[];
  /** `adviseRenderer`'s advice, listed with each fix, including what the log was asked not to show again. */
  advice?: readonly RendererAdvice[];
}

export interface RendererPanelHandle {
  element: HTMLElement;
  destroy(): void;
}

export { getRendererLabel };

function describeRenderer({ mode, requested }: RendererPanelOptions["renderer"]): string {
  if (requested === "auto") return `Running on ${getRendererLabel(mode)}, chosen automatically.`;
  if (requested === mode) return `Running on ${getRendererLabel(mode)}.`;
  return `Running on ${getRendererLabel(mode)}. ${getRendererLabel(requested)} was chosen but did not start.`;
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function diagnosticLines({ diagnostics, fallbackReason }: RendererPanelOptions["renderer"]): string[] {
  if (!diagnostics) return [];
  return [
    `Secure context: ${diagnostics.isSecureContext ? "✓ yes" : "✗ no — WebGPU requires HTTPS"}`,
    `navigator.gpu: ${diagnostics.navigatorGpuPresent ? "✓ present" : "✗ missing"}`,
    diagnostics.isSupportedAsyncResult !== null ? `IsSupportedAsync: ${diagnostics.isSupportedAsyncResult}` : null,
    fallbackReason ? `${diagnostics.webGlRequired ? "Reason" : "Error"}: ${fallbackReason}` : null,
    diagnostics.fallbackSavedAt !== undefined
      ? `Saved fallback from ${day(diagnostics.fallbackSavedAt)}: WebGPU is tried again from ${day(diagnostics.fallbackSavedAt + RENDERER_FALLBACK_RETRY_MS)}, or sooner if the browser changes.`
      : null,
  ].filter((line): line is string => line !== null);
}

/**
 * The contents of the Renderer tab: which GPU API draws the globe, then any
 * section a host's parameters are homed in, such as 0sfs's Instruments.
 */
export function createRendererPanel(options: RendererPanelOptions): RendererPanelHandle {
  const settings = options.settings;
  const { document, checkChoice, createChoiceGroup, createChoiceNote, appendHostSections, createParameterSection, createSectionsElement } = options.ui;
  const element = document.createElement("div");
  element.className = "foss-earth-choice-panel";
  const group = createChoiceGroup(RENDERER_CHOICE_NAME, "Renderer", [
    { id: "auto", label: "Auto-detect" },
    { id: "webgpu", label: "WebGPU" },
    { id: "webgl2", label: "WebGL2" },
    { id: "webgl", label: "WebGL" },
  ]);
  group.prepend(createChoiceNote(describeRenderer(options.renderer)));
  group.append(createChoiceNote("Changing the renderer reloads the page."));
  element.append(group);
  checkChoice(element, RENDERER_CHOICE_NAME, options.renderer.requested);

  const lines = diagnosticLines(options.renderer);
  if (lines.length > 0) {
    const diagnostics = document.createElement("pre");
    diagnostics.className = "foss-earth-renderer-diagnostics";
    diagnostics.textContent = lines.join("\n");
    element.append(diagnostics);
  }

  const advice = options.advice ?? [];
  if (advice.length > 0) {
    const list = document.createElement("div");
    list.className = "foss-earth-choices foss-earth-renderer-advice";
    const heading = document.createElement("span");
    heading.className = "foss-earth-choices__heading";
    heading.textContent = "Advice";
    list.append(heading);
    for (const item of advice) {
      const text = createChoiceNote(item.text);
      text.dataset.adviceId = item.id;
      list.append(text, ...item.fix.map(step => createChoiceNote(step)));
      if (item.docs) {
        const link = document.createElement("a");
        link.href = item.docs;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "The guide";
        const note = createChoiceNote("");
        note.append(link);
        list.append(note);
      }
    }
    element.append(list);
  }

  const onChange = (event: Event): void => {
    const input = event.target;
    if (!options.ui.isInput(input) || input.name !== RENDERER_CHOICE_NAME) return;
    const value = input.value;
    options.onChange(value === "webgpu" || value === "webgl2" || value === "webgl" ? value : null);
  };
  element.addEventListener("change", onChange);
  const backend = createParameterSection(settings, { tab: "renderer", section: "backend", main: element, covers: ["renderer.backend"] });
  const sections = createSectionsElement([
    { id: "renderer.backend", title: settings.getSectionTitle("renderer", "backend"), element: backend.element, defaultOpen: true },
  ]);
  const own = options.sections ?? [];
  const hostSections = appendHostSections(settings, "renderer", sections, ["backend", ...own.map(section => section.id)]);
  for (const section of own) sections.append({ ...section, id: `renderer.${section.id}` });

  let destroyed = false;
  return {
    element: sections.element,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      element.removeEventListener("change", onChange);
      backend.destroy();
      hostSections.destroy();
      sections.destroy();
    },
  };
}
