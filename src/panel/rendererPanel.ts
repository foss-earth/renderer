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
   * Apply & reload: the user's choice, or null for auto-detect. A renderer only
   * changes on a reload, so a choice is saved and shown as pending until the
   * host applies it, saving the choice and reloading.
   */
  onChange(force: RendererMode | null): void;
  /** The registry of the tab's parameters; the app's when omitted. */
  settings: SettingsRegistry;
  /** UI-owned factories plus the host document/input realm; no UI implementation is copied. */
  ui: RendererPanelUiPort;
  /**
   * Sections an app draws itself for sections of this tab, by section id
   * ("performance" for renderer/performance), such as FOSS Earth's
   * Debug. They follow the tab's other sections.
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

/** The one visible line for a renderer that did not start this time; a saved fallback or a device that needs WebGL is explained behind ?. */
function failureLine({ mode, requested, fallbackReason, diagnostics }: RendererPanelOptions["renderer"]): string | null {
  const wanted = requested === "auto" ? "webgpu" : requested;
  if (wanted === mode || diagnostics?.webGlRequired || diagnostics?.fallbackSavedAt !== undefined) return null;
  if (requested === "auto" && !fallbackReason) return null;
  return `${getRendererLabel(wanted)} did not start${fallbackReason ? `: ${fallbackReason.trim().replace(/\.+$/, "")}` : ""}.`;
}

const RENDERER_BACKEND_ID = "renderer.backend";
const asForce = (value: unknown): RendererMode | null => value === "webgpu" || value === "webgl2" || value === "webgl" ? value : null;

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
 * The contents of the Renderer tab: which GPU API draws the globe and the
 * tab's other everyday controls (resolution, upscaling, dynamic resolution, antialiasing, frame rate cap),
 * drawn on the tab itself, then any section a host's parameters are homed
 * in, such as 0sfs's Instruments.
 */
export function createRendererPanel(options: RendererPanelOptions): RendererPanelHandle {
  const settings = options.settings;
  const { document, checkChoice, createChoiceGroup, createChoiceNote, createHelpTooltip, appendHostSections, createParameterSection, createSectionsElement } = options.ui;
  const element = document.createElement("div");
  element.className = "foss-earth-choice-panel";
  const status = document.createElement("span");
  status.textContent = `${getRendererLabel(options.renderer.mode)} running`;
  const help = document.createElement("div");
  const about = document.createElement("p");
  about.textContent = `${describeRenderer(options.renderer)} A new choice is saved at once and starts after Apply & reload. Auto-detect tries WebGPU and falls back to WebGL.`;
  help.append(about);
  const lines = diagnosticLines(options.renderer);
  if (lines.length > 0) {
    const diagnostics = document.createElement("pre");
    diagnostics.className = "foss-earth-renderer-diagnostics";
    diagnostics.textContent = lines.join("\n");
    help.append(diagnostics);
  }
  // The tab is titled Renderer, so the group's title is only its accessible name.
  const group = createChoiceGroup(RENDERER_CHOICE_NAME, "Renderer", [
    { id: "auto", label: "Auto-detect", shortLabel: "Auto" },
    { id: "webgpu", label: "WebGPU" },
    { id: "webgl2", label: "WebGL2" },
    { id: "webgl", label: "WebGL" },
  ], { hideHeading: true, status, help, helpLabel: "Explain the renderer" });
  element.append(group);
  const failure = failureLine(options.renderer);
  if (failure) element.append(createChoiceNote(failure));
  checkChoice(element, RENDERER_CHOICE_NAME, options.renderer.requested);

  const tooltips: { destroy(): void }[] = [];
  for (const item of options.advice ?? []) {
    const row = document.createElement("div");
    row.className = "foss-earth-choices foss-earth-renderer-advice";
    row.dataset.adviceId = item.id;
    const text = createChoiceNote(item.text);
    const fix = document.createElement("div");
    for (const step of item.fix) {
      const line = document.createElement("p");
      line.textContent = step;
      fix.append(line);
    }
    if (item.docs) {
      const link = document.createElement("a");
      link.href = item.docs;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "The guide";
      const line = document.createElement("p");
      line.append(link);
      fix.append(line);
    }
    const tooltip = createHelpTooltip({ label: "How to fix this", content: fix });
    tooltips.push(tooltip);
    row.append(text, tooltip.element);
    element.append(row);
  }

  // A choice is saved and pending; the section's Apply & reload starts it.
  const onChange = (event: Event): void => {
    const input = event.target;
    if (!options.ui.isInput(input) || input.name !== RENDERER_CHOICE_NAME) return;
    settings.set(RENDERER_BACKEND_ID, input.value);
  };
  element.addEventListener("change", onChange);
  // Discard, an import or a preset changes the choice too.
  const offChoice = settings.subscribe(changed => {
    if (changed.has(RENDERER_BACKEND_ID)) checkChoice(element, RENDERER_CHOICE_NAME, String(settings.get(RENDERER_BACKEND_ID)));
  });
  // One Apply & reload for the tab's controls. The host's apply starts a new
  // renderer choice; antialiasing alone only needs the page reloaded.
  const backend = createParameterSection(settings, {
    tab: "renderer", section: "main", main: element, covers: [RENDERER_BACKEND_ID],
    reload: () => {
      if (String(settings.get(RENDERER_BACKEND_ID)) !== options.renderer.requested) options.onChange(asForce(settings.get(RENDERER_BACKEND_ID)));
      else document.defaultView?.location.reload();
    },
  });
  const sections = createSectionsElement([
    { id: "renderer.main", title: settings.getSectionTitle("renderer", "main"), element: backend.element },
  ]);
  const own = options.sections ?? [];
  const hostSections = appendHostSections(settings, "renderer", sections, ["main", ...own.map(section => section.id)]);
  for (const section of own) sections.append({ ...section, id: `renderer.${section.id}` });

  let destroyed = false;
  return {
    element: sections.element,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      element.removeEventListener("change", onChange);
      offChoice();
      for (const tooltip of tooltips) tooltip.destroy();
      backend.destroy();
      hostSections.destroy();
      sections.destroy();
    },
  };
}
