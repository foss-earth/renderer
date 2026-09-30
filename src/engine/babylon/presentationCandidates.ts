/**
 * While a navigation lease presents its own view, the globe camera draws only
 * the presentation layer, but Babylon still visits every retained map mesh
 * twice a frame (checking it is ready, updating its world matrix, choosing
 * its level of detail) before the layer mask rejects it. This offers Babylon
 * only the meshes that camera can draw, which is what it would have drawn;
 * the renderer.experiments.presentationCandidates parameter turns it on.
 */
import type { AbstractMesh, ISmartArrayLike, Scene } from "@babylonjs/core";

export interface PresentationCandidates {
  setEnabled(enabled: boolean): void;
  readonly enabled: boolean;
  /** The meshes offered in the last frame that was filtered, for checks. */
  readonly lastFiltered: number | null;
  dispose(): void;
}

export function createPresentationCandidates(scene: Scene, presentationLayer: number): PresentationCandidates {
  const everyMesh = scene.getActiveMeshCandidates;
  const filtered: ISmartArrayLike<AbstractMesh> = { data: [], length: 0 };
  let enabled = false;
  let lastFiltered: number | null = null;

  function candidates(): ISmartArrayLike<AbstractMesh> {
    const camera = scene.activeCamera;
    // Only the one camera that draws the presentation layer alone; any other view gets everything.
    const presenting = camera !== null && camera.layerMask === presentationLayer && (scene.activeCameras?.length ?? 0) <= 1;
    if (!presenting) return everyMesh.call(scene);
    const data = filtered.data;
    let length = 0;
    for (const mesh of scene.meshes) {
      if ((mesh.layerMask & presentationLayer) !== 0) data[length++] = mesh;
    }
    data.length = length;
    filtered.length = length;
    lastFiltered = length;
    return filtered;
  }

  return {
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      scene.getActiveMeshCandidates = enabled ? candidates : everyMesh;
      filtered.data.length = 0;
      filtered.length = 0;
      lastFiltered = null;
    },
    get enabled() { return enabled; },
    get lastFiltered() { return lastFiltered; },
    dispose() {
      if (enabled) scene.getActiveMeshCandidates = everyMesh;
      enabled = false;
      filtered.data.length = 0;
    },
  };
}
