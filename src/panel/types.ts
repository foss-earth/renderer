import type { SettingsRegistry } from "@foss-earth/ui/settings";

/** "renderer.main", the tab's main section, is drawn on the tab itself, with no disclosure or title. */
export interface RendererPanelSection { id: string; title: string; element: HTMLElement; defaultOpen?: boolean; }
export interface RendererPanelSections {
  element: HTMLElement;
  append(section: RendererPanelSection): void;
  has(id: string): boolean;
  destroy(): void;
}
export interface RendererPanelElement { element: HTMLElement; destroy(): void; }

export interface RendererChoiceGroupOptions {
  /** Explanation behind the group's trailing ?. */
  help?: string | HTMLElement;
  helpLabel?: string;
  /** Terse state after the segments, before ?. */
  status?: HTMLElement;
  /** The section heading already names the choice; the heading stays the accessible name. */
  hideHeading?: boolean;
}

/** Match UI's public factories; the host binds functions that need receivers. */
export interface RendererPanelUiPort {
  document: Document;
  isInput(value: EventTarget | null): value is HTMLInputElement;
  createChoiceGroup(name: string, heading: string, choices: readonly { id: string; label: string; shortLabel?: string }[], options?: RendererChoiceGroupOptions): HTMLElement;
  createChoiceNote(text: string): HTMLElement;
  checkChoice(root: ParentNode, name: string, id: string | null): void;
  /** A trailing ? whose content opens on click or keyboard. */
  createHelpTooltip(options: { label: string; content: HTMLElement }): { element: HTMLElement; destroy(): void };
  /** `reload` is Apply & reload for the section's values that apply on the next start. */
  createParameterSection(settings: SettingsRegistry, options: { tab: string; section: string; main?: HTMLElement; covers?: readonly string[]; reload?: () => void }): RendererPanelElement;
  createSectionsElement(sections: readonly RendererPanelSection[]): RendererPanelSections;
  appendHostSections(settings: SettingsRegistry, tab: string, sections: RendererPanelSections, own: readonly string[]): { destroy(): void };
}
