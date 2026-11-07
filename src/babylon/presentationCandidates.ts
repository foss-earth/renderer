/**
 * The meshes Babylon visits each frame. Babylon's own candidates are every
 * mesh in the scene: for each it looks up the camera's level of detail,
 * counts its vertices and asks whether it is ready, all before it asks
 * whether the mesh is enabled (`Scene._evaluateActiveMeshes`). Map tiles the
 * caches keep but do not show are disabled, so in a long session most of
 * that walk passes over meshes Babylon then skips.
 *
 * Two filters, each offering Babylon the meshes it would have drawn anyway,
 * in the scene's order, so the frame is the same:
 *
 * - Skipping disabled meshes (renderer.skipDisabledMeshes): only meshes whose
 *   `isEnabled()` holds, asked just as Babylon would ask it, before the walk.
 * - Presentation (renderer.experiments.presentationCandidates): while a
 *   navigation lease presents its own view, the globe camera draws only the
 *   presentation layer, so only meshes on that layer.
 */
import type { AbstractMesh, ISmartArrayLike, Scene } from "@babylonjs/core";

/** The setting that turns skipping disabled meshes off; it is on when a host does not register it. */
export const SKIP_DISABLED_MESHES_ID = "renderer.skipDisabledMeshes";

export interface PresentationCandidates {
  /** The presentation filter. */
  setEnabled(enabled: boolean): void;
  readonly enabled: boolean;
  /** Offer only enabled meshes. */
  setSkipDisabled(skip: boolean): void;
  readonly skipDisabled: boolean;
  /** The meshes offered in the last frame that was filtered, for checks. */
  readonly lastFiltered: number | null;
  dispose(): void;
}

export function createPresentationCandidates(scene: Scene, presentationLayer: number): PresentationCandidates {
  const everyMesh = scene.getActiveMeshCandidates;
  const filtered: ISmartArrayLike<AbstractMesh> = { data: [], length: 0 };
  let presentation = false;
  let skipDisabled = false;
  let lastFiltered: number | null = null;

  function candidates(): ISmartArrayLike<AbstractMesh> {
    const camera = scene.activeCamera;
    // Only the one camera that draws the presentation layer alone; any other view gets every layer.
    const presenting = presentation && camera !== null && camera.layerMask === presentationLayer && (scene.activeCameras?.length ?? 0) <= 1;
    if (!presenting && !skipDisabled) return everyMesh.call(scene);
    const meshes = scene.meshes, data = filtered.data;
    let length = 0;
    for (let index = 0; index < meshes.length; index++) {
      const mesh = meshes[index]!;
      if (presenting && (mesh.layerMask & presentationLayer) === 0) continue;
      if (skipDisabled && !mesh.isEnabled()) continue;
      data[length++] = mesh;
    }
    data.length = length;
    filtered.length = length;
    lastFiltered = length;
    return filtered;
  }

  function install(): void {
    scene.getActiveMeshCandidates = presentation || skipDisabled ? candidates : everyMesh;
    filtered.data.length = 0;
    filtered.length = 0;
    lastFiltered = null;
  }

  return {
    setEnabled(next) {
      if (next === presentation) return;
      presentation = next;
      install();
    },
    get enabled() { return presentation; },
    setSkipDisabled(next) {
      if (next === skipDisabled) return;
      skipDisabled = next;
      install();
    },
    get skipDisabled() { return skipDisabled; },
    get lastFiltered() { return lastFiltered; },
    dispose() {
      if (presentation || skipDisabled) scene.getActiveMeshCandidates = everyMesh;
      presentation = false;
      skipDisabled = false;
      filtered.data.length = 0;
    },
  };
}
