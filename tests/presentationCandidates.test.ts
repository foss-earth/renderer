import { Constants, FreeCamera, Mesh, MeshBuilder, NullEngine, Scene, TransformNode, Vector3, type AbstractMesh } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createPresentationCandidates } from "../src/babylon/presentationCandidates.js";

const PRESENTATION = 0x10000000;
const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function setup() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  // A retained world, and the one mesh a presentation draws.
  for (let index = 0; index < 40; index++) MeshBuilder.CreateBox(`tile-${index}`, { size: 0.1 }, scene).position.x = index * 0.2 - 4;
  const sphere = MeshBuilder.CreatePlane("panorama", { size: 1 }, scene);
  sphere.layerMask = 0x0fffffff | PRESENTATION;
  return { scene, camera, sphere };
}

const activeNames = (scene: Scene) => scene.getActiveMeshes().data.slice(0, scene.getActiveMeshes().length).map(mesh => mesh.name).sort();

describe("presentation candidates", () => {
  it("draws what the presentation camera draws, from its own meshes alone", () => {
    const { scene, camera } = setup();
    camera.layerMask = PRESENTATION;
    scene.render();
    const without = activeNames(scene);
    expect(without).toEqual(["panorama"]);

    const candidates = createPresentationCandidates(scene, PRESENTATION);
    candidates.setEnabled(true);
    scene.render();
    expect(activeNames(scene)).toEqual(without);
    expect(candidates.lastFiltered).toBe(1);
    candidates.dispose();
  });

  it("offers every mesh when the camera draws the globe, and restores the default when turned off", () => {
    const { scene, camera } = setup();
    const everyMesh = scene.getActiveMeshCandidates;
    const candidates = createPresentationCandidates(scene, PRESENTATION);
    candidates.setEnabled(true);
    camera.layerMask = 0x0fffffff;
    expect(scene.getActiveMeshCandidates().length).toBe(scene.meshes.length);
    scene.render();
    expect(activeNames(scene)).toHaveLength(41);

    camera.layerMask = PRESENTATION;
    expect(scene.getActiveMeshCandidates().length).toBe(1);
    candidates.setEnabled(false);
    expect(scene.getActiveMeshCandidates).toBe(everyMesh);
    expect(scene.getActiveMeshCandidates().length).toBe(scene.meshes.length);
  });

  it("finds a mesh that joins the presentation layer after it started", () => {
    const { scene, camera } = setup();
    const candidates = createPresentationCandidates(scene, PRESENTATION);
    candidates.setEnabled(true);
    camera.layerMask = PRESENTATION;
    scene.getMeshByName("tile-3")!.layerMask = PRESENTATION;
    scene.render();
    expect(activeNames(scene)).toEqual(["panorama", "tile-3"]);
    candidates.dispose();
  });

  it("draws the same active meshes, in the same order, when it offers only enabled meshes", () => {
    const { scene } = setup();
    // Tiles as the caches keep them: some disabled themselves, some under a disabled root (as a hidden Google tile is),
    // and enabled meshes Babylon still skips for other reasons.
    const roots = [0, 1, 2].map(index => new TransformNode(`root-${index}`, scene));
    const tiles = scene.meshes.filter(mesh => mesh.name.startsWith("tile-"));
    tiles.forEach((tile, index) => { if (index % 3 === 0) tile.parent = roots[index % roots.length]!; });
    tiles[5]!.isVisible = false;
    tiles[7]!.visibility = 0;
    tiles[8]!.layerMask = 0;
    tiles[10]!.position.x = 1e6;
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const ordered = () => { const list = scene.getActiveMeshes(); return list.data.slice(0, list.length).map(mesh => mesh.name); };
    const babylon = scene.getActiveMeshCandidates;
    const candidates = createPresentationCandidates(scene, PRESENTATION);
    let skipped = 0;
    for (let frame = 0; frame < 60; frame++) {
      for (const tile of tiles) if (random() < 0.3) tile.setEnabled(!tile.isEnabled(false));
      for (const root of roots) if (random() < 0.2) root.setEnabled(!root.isEnabled(false));
      if (frame % 7 === 3) scene.removeMesh(tiles[Math.floor(random() * tiles.length)]!);
      if (frame % 9 === 4) MeshBuilder.CreateBox(`late-${frame}`, { size: 0.1 }, scene).setEnabled(random() < 0.5);
      candidates.setSkipDisabled(false);
      expect(scene.getActiveMeshCandidates).toBe(babylon);
      scene.render();
      const every = ordered();
      candidates.setSkipDisabled(true);
      scene.render();
      expect(ordered()).toEqual(every);
      const enabled = scene.meshes.filter(mesh => mesh.isEnabled());
      expect(candidates.lastFiltered).toBe(enabled.length);
      skipped += scene.meshes.length - enabled.length;
    }
    expect(skipped).toBeGreaterThan(100);
    candidates.dispose();
  });

  it("offers exactly the enabled meshes, in the scene's order, and nothing Babylon would not skip", () => {
    const { scene, sphere } = setup();
    const root = new TransformNode("hidden-tile", scene);
    const child = MeshBuilder.CreateBox("under-hidden", { size: 0.1 }, scene);
    child.parent = root;
    root.setEnabled(false);
    scene.getMeshByName("tile-4")!.setEnabled(false);
    // Enabled, but skipped by Babylon later on: these stay candidates.
    scene.getMeshByName("tile-6")!.isVisible = false;
    scene.getMeshByName("tile-9")!.layerMask = 0;
    const loading = scene.getMeshByName("tile-11") as Mesh;
    loading.delayLoadState = Constants.DELAYLOADSTATE_LOADING;
    expect(loading.isReady()).toBe(false);
    const candidates = createPresentationCandidates(scene, PRESENTATION);
    candidates.setSkipDisabled(true);
    const offered = scene.getActiveMeshCandidates();
    const names = offered.data.slice(0, offered.length).map((mesh: AbstractMesh) => mesh.name);
    expect(names).toEqual(scene.meshes.filter(mesh => mesh.name !== "under-hidden" && mesh.name !== "tile-4").map(mesh => mesh.name));
    expect(names).toContain("tile-6");
    expect(names).toContain("tile-9");
    expect(names).toContain("tile-11");
    expect(names).toContain(sphere.name);
    candidates.dispose();
  });

  it("keeps one filter installed while the other is on, and combines them while presenting", () => {
    const { scene, camera } = setup();
    const everyMesh = scene.getActiveMeshCandidates;
    const candidates = createPresentationCandidates(scene, PRESENTATION);
    candidates.setSkipDisabled(true);
    candidates.setEnabled(true);
    candidates.setEnabled(false);
    expect(scene.getActiveMeshCandidates).not.toBe(everyMesh);
    expect(candidates.skipDisabled).toBe(true);

    candidates.setEnabled(true);
    camera.layerMask = PRESENTATION;
    scene.getMeshByName("tile-2")!.layerMask = PRESENTATION;
    scene.getMeshByName("tile-3")!.layerMask = PRESENTATION;
    scene.getMeshByName("tile-3")!.setEnabled(false);
    const offered = scene.getActiveMeshCandidates();
    expect(offered.data.slice(0, offered.length).map((mesh: AbstractMesh) => mesh.name)).toEqual(["tile-2", "panorama"]);
    scene.render();
    expect(activeNames(scene)).toEqual(["panorama", "tile-2"]);

    candidates.setSkipDisabled(false);
    candidates.setEnabled(false);
    expect(scene.getActiveMeshCandidates).toBe(everyMesh);
    candidates.setSkipDisabled(true);
    candidates.dispose();
    expect(scene.getActiveMeshCandidates).toBe(everyMesh);
    expect(candidates.skipDisabled).toBe(false);
  });
});
