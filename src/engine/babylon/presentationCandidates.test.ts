import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createPresentationCandidates } from "./presentationCandidates";

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
  const panorama = MeshBuilder.CreatePlane("panorama", { size: 1 }, scene);
  panorama.layerMask = 0x0fffffff | PRESENTATION;
  return { scene, camera, panorama };
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
});
