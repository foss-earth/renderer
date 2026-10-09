import type { SettingsRegistry } from "@foss-earth/ui/settings";

export interface RendererPanelSection { id: string; title: string; element: HTMLElement; defaultOpen?: boolean; }
export interface RendererPanelSections {
  element: HTMLElement;
  append(section: RendererPanelSection): void;
  has(id: string): boolean;
  destroy(): void;
}
export interface RendererPanelElement { element: HTMLElement; destroy(): void; }

/** Match UI's public factories; the host binds functions that need receivers. */
export interface RendererPanelUiPort {
  document: Document;
  isInput(value: EventTarget | null): value is HTMLInputElement;
  createChoiceGroup(name: string, heading: string, choices: readonly { id: string; label: string }[]): HTMLElement;
  createChoiceNote(text: string): HTMLElement;
  checkChoice(root: ParentNode, name: string, id: string | null): void;
  createParameterSection(settings: SettingsRegistry, options: { tab: string; section: string; main?: HTMLElement; covers?: readonly string[] }): RendererPanelElement;
  createSectionsElement(sections: readonly RendererPanelSection[]): RendererPanelSections;
  appendHostSections(settings: SettingsRegistry, tab: string, sections: RendererPanelSections, own: readonly string[]): { destroy(): void };
}
