/**
 * The order Babylon draws the main group's opaque meshes in (audit L24).
 * Babylon's default groups them by material to save state changes
 * (`RenderingGroup.PainterSortCompare`). Every map tile has a material of its
 * own, so that is about the order tiles loaded: coarse first, which is close
 * to far first and the most overdraw. Apple's GPUs remove hidden surfaces
 * before shading, so there it costs nothing; most other GPUs shade each
 * fragment that passes the depth test when it is drawn.
 *
 * Near to far, by each submesh's bounding sphere from the camera, ties in
 * Babylon's order. Babylon measures that distance only for see-through
 * meshes, so it is measured here, once per frame, just before the group
 * sorts.
 *
 * Exact. A plain draw tests depth with the engine's function, writes depth
 * and colour, and uses no stencil. A run of plain draws leaves each pixel
 * with its nearest fragment whatever their order; only fragments at exactly
 * the same depth can resolve differently. Any other draw (the sky dome, which
 * writes no depth) stays where Babylon's order puts it, and so does a draw at
 * no finite distance; only the plain draws between two of them are reordered,
 * among themselves. A Babylon that no longer keeps the list where 8.x does
 * keeps its own order.
 */
import { RenderingGroup, Vector3 } from "@babylonjs/core";
import type { Observer, RenderingGroupInfo, Scene, SubMesh } from "@babylonjs/core";

/** The setting that turns it on; off by default and when a host does not register it (held, audit L24). */
export const OPAQUE_NEAR_TO_FAR_ID = "renderer.opaqueNearToFar";
/** The scene's main group, where the globe's tiles are. */
const MAIN_GROUP = 0;

export interface OpaqueOrder {
  setNearToFar(nearToFar: boolean): void;
  readonly nearToFar: boolean;
  /** Whether the last main-group draw was ordered near to far; null before one, for checks. */
  readonly lastSorted: boolean | null;
  /** Draws the last sorted frame kept in place, as order-dependent; for checks. */
  readonly lastFixed: number;
  dispose(): void;
}

interface SubMeshList {
  data: SubMesh[];
  length: number;
}

/** The group's opaque list, which Babylon 8 keeps private; null if it is not there. */
function opaqueList(info: RenderingGroupInfo): SubMeshList | null {
  const group = info.renderingManager?.getRenderingGroup(info.renderingGroupId) as unknown as { _opaqueSubMeshes?: SubMeshList } | undefined;
  const list = group?._opaqueSubMeshes;
  return list && Array.isArray(list.data) && typeof list.length === "number" ? list : null;
}

/** A draw whose pixels do not depend on when it is drawn, except at equal depths. */
export function drawsByDepth(subMesh: SubMesh): boolean {
  const material = subMesh.getMaterial();
  if (!material) return true;
  return material.depthFunction === 0 && !material.disableDepthWrite && !material.disableColorWrite && material.stencil?.enabled !== true;
}

export function createOpaqueOrder(scene: Scene): OpaqueOrder {
  let nearToFar = false;
  let sortNow = false;
  let lastSorted: boolean | null = null;
  let lastFixed = 0;
  let observer: Observer<RenderingGroupInfo> | null = null;
  let after: Observer<RenderingGroupInfo> | null = null;
  // Each draw's place in Babylon's order, by runs: plain draws before the
  // first fixed draw are run 0, that draw is 1, the plain draws after it 2,
  // and so on. Empty when no draw is fixed: one run.
  const runs = new Map<SubMesh, number>();
  const fixed = new Set<SubMesh>();
  const painted: SubMesh[] = [];
  const run = (subMesh: SubMesh): number => runs.get(subMesh) ?? 0;

  const compare = (a: SubMesh, b: SubMesh): number => {
    if (!sortNow) return RenderingGroup.PainterSortCompare(a, b);
    // A fixed draw is a run of its own, so distances only order plain runs.
    return run(a) - run(b) || a._distanceToCamera - b._distanceToCamera || RenderingGroup.PainterSortCompare(a, b);
  };

  /** Just before the group sorts: measure each opaque draw and find the runs, or keep Babylon's order this time. */
  function measure(info: RenderingGroupInfo): void {
    // The observer's mask keeps this to the main group. Render targets have
    // managers of their own, in Babylon's order; only the scene's is sorted.
    if (info.renderingManager !== scene.renderingManager) return;
    sortNow = false;
    lastSorted = false;
    release();
    const list = opaqueList(info);
    if (!list) return;
    const eye = info.camera?.globalPosition ?? Vector3.ZeroReadOnly;
    for (let index = 0; index < list.length; index++) {
      const subMesh = list.data[index]!;
      const distance = Vector3.Distance(subMesh.getBoundingInfo().boundingSphere.centerWorld, eye);
      subMesh._distanceToCamera = distance;
      if (!Number.isFinite(distance) || !drawsByDepth(subMesh)) fixed.add(subMesh);
    }
    lastFixed = fixed.size;
    if (fixed.size > 0) {
      // Babylon's own order, as its stable sort of the same list gives it.
      painted.length = 0;
      for (let index = 0; index < list.length; index++) painted.push(list.data[index]!);
      painted.sort(RenderingGroup.PainterSortCompare);
      let seen = 0;
      for (const subMesh of painted) {
        if (fixed.has(subMesh)) runs.set(subMesh, 2 * seen++ + 1);
        else if (seen > 0) runs.set(subMesh, 2 * seen);
      }
      painted.length = 0;
    }
    sortNow = true;
    lastSorted = true;
  }

  /** After the group draws, so no draw outlives its frame here. */
  function release(): void {
    runs.clear();
    fixed.clear();
  }

  function install(): void {
    // Observer.remove() would leave Babylon 8's count of observers off by one.
    if (observer) scene.onBeforeRenderingGroupObservable.remove(observer);
    if (after) scene.onAfterRenderingGroupObservable.remove(after);
    observer = null;
    after = null;
    sortNow = false;
    lastSorted = null;
    lastFixed = 0;
    release();
    if (nearToFar) {
      observer = scene.onBeforeRenderingGroupObservable.add(measure, 1 << MAIN_GROUP);
      after = scene.onAfterRenderingGroupObservable.add(release, 1 << MAIN_GROUP);
    }
    // null gives Babylon's own order back, as the group was made with.
    scene.setRenderingOrder(MAIN_GROUP, nearToFar ? compare : null);
  }

  return {
    setNearToFar(next) {
      if (next === nearToFar) return;
      nearToFar = next;
      install();
    },
    get nearToFar() { return nearToFar; },
    get lastSorted() { return lastSorted; },
    get lastFixed() { return lastFixed; },
    dispose() {
      if (!nearToFar) return;
      nearToFar = false;
      install();
    },
  };
}
