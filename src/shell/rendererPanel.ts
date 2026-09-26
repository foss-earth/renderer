import type { RendererMode, RendererSelection } from "../engine/babylon/createRendererMode";
import { getAppSettings } from "../settings/appSettings";
import type { SettingsRegistry } from "../settings/registry";
import { checkChoice, createChoiceGroup, createChoiceNote } from "./choiceGroup";
import { appendHostSections, createParameterSection, createSectionsElement, type SectionsElementEntry } from "./settings/parameterSection";

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
  settings?: SettingsRegistry;
  /**
   * Sections an app draws itself for sections of this tab, by section id
   * ("performance" for renderer/performance), such as FOSS Earth's
   * Performance debug. They follow the tab's other sections.
   */
  sections?: readonly SectionsElementEntry[];
}

export interface RendererPanelHandle {
  element: HTMLElement;
  destroy(): void;
}

export function getRendererLabel(mode: RendererMode): string {
  if (mode === "webgpu") return "WebGPU";
  if (mode === "webgl2") return "WebGL2";
  return "WebGL";
}

function describeRenderer({ mode, requested }: RendererPanelOptions["renderer"]): string {
  if (requested === "auto") return `Running on ${getRendererLabel(mode)}, chosen automatically.`;
  if (requested === mode) return `Running on ${getRendererLabel(mode)}.`;
  return `Running on ${getRendererLabel(mode)}. ${getRendererLabel(requested)} was chosen but did not start.`;
}

function diagnosticLines({ diagnostics, fallbackReason }: RendererPanelOptions["renderer"]): string[] {
  if (!diagnostics) return [];
  return [
    `Secure context: ${diagnostics.isSecureContext ? "✓ yes" : "✗ no — WebGPU requires HTTPS"}`,
    `navigator.gpu: ${diagnostics.navigatorGpuPresent ? "✓ present" : "✗ missing"}`,
    diagnostics.isSupportedAsyncResult !== null ? `IsSupportedAsync: ${diagnostics.isSupportedAsyncResult}` : null,
    fallbackReason ? `Error: ${fallbackReason}` : null,
  ].filter((line): line is string => line !== null);
}

/**
 * The contents of the Renderer tab: which GPU API draws the globe, then any
 * section a host's parameters are homed in, such as 0sfs's Instruments.
 */
export function createRendererPanel(options: RendererPanelOptions): RendererPanelHandle {
  const settings = options.settings ?? getAppSettings();
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

  const onChange = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== RENDERER_CHOICE_NAME) return;
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

  return {
    element: sections.element,
    destroy(): void {
      element.removeEventListener("change", onChange);
      backend.destroy();
      hostSections.destroy();
      sections.destroy();
    },
  };
}
