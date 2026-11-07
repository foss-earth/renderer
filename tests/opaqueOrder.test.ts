import { Constants, FreeCamera, MeshBuilder, NullEngine, RenderTargetTexture, Scene, StandardMaterial, SubMesh, Vector3, type Material } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpaqueOrder } from "../src/babylon/opaqueOrder.js";

const engines: NullEngine[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const engine of engines.splice(0)) engine.dispose(); });

/** Tiles in a row ahead of the camera, their materials made far first, as map tiles load coarse first. */
function setup(count = 8) {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -1), scene);
  camera.setTarget(new Vector3(0, 0, 10));
  camera.maxZ = 1000;
  scene.activeCamera = camera;
  const materials: Material[] = [];
  for (let index = count - 1; index >= 0; index--) {
    const box = MeshBuilder.CreateBox(`tile-${index}`, { size: 0.5 }, scene);
    box.position.z = index * 2 + 1;
    const material = new StandardMaterial(`material-${index}`, scene);
    box.material = material;
    materials[index] = material;
  }
  return { scene, camera, materials };
}

/** The meshes' draws in one frame, in order, opaque or not. */
function drawn(scene: Scene): string[] {
  const order: string[] = [];
  const render = SubMesh.prototype.render;
  const spy = vi.spyOn(SubMesh.prototype, "render").mockImplementation(function (this: SubMesh, enableAlphaMode: boolean) {
    order.push(this.getMesh().name);
    return render.call(this, enableAlphaMode);
  });
  try { scene.render(); } finally { spy.mockRestore(); }
  return order;
}

const nearFirst = (count: number) => Array.from({ length: count }, (_, index) => `tile-${index}`);
const farFirst = (count: number) => nearFirst(count).reverse();

describe("opaque order near to far (L24)", () => {
  it("draws Babylon's order, by material, without it", () => {
    const { scene } = setup();
    expect(drawn(scene)).toEqual(farFirst(8));
  });

  it("draws opaque meshes nearest first when every one tests and writes depth", () => {
    const { scene } = setup();
    const order = createOpaqueOrder(scene);
    order.setNearToFar(true);
    expect(drawn(scene)).toEqual(nearFirst(8));
    expect(order.lastSorted).toBe(true);
    order.dispose();
  });

  it("measures from each frame's camera", () => {
    const { scene, camera } = setup();
    const order = createOpaqueOrder(scene);
    order.setNearToFar(true);
    expect(drawn(scene)).toEqual(nearFirst(8));
    camera.position.set(0, 0, 30);
    camera.setTarget(new Vector3(0, 0, 0));
    expect(drawn(scene)).toEqual(farFirst(8));
    order.dispose();
  });

  it("keeps Babylon's order at equal distances", () => {
    const { scene } = setup(2);
    const left = MeshBuilder.CreateBox("left", { size: 0.5 }, scene), right = MeshBuilder.CreateBox("right", { size: 0.5 }, scene);
    left.position.set(-1, 0, 20);
    right.position.set(1, 0, 20);
    // Babylon's order puts right first: its material is older.
    right.material = new StandardMaterial("right", scene);
    left.material = new StandardMaterial("left", scene);
    const order = createOpaqueOrder(scene);
    order.setNearToFar(true);
    expect(drawn(scene)).toEqual(["tile-0", "tile-1", "right", "left"]);
    order.dispose();
  });

  // Babylon's order is tile-7 … tile-0 (materials made far first); tile-3's
  // material is order-dependent, so it stays fourth from the end and each run
  // around it is sorted near to far.
  const aroundTile3 = ["tile-4", "tile-5", "tile-6", "tile-7", "tile-3", "tile-0", "tile-1", "tile-2"];
  const orderDependent: Array<[string, (material: Material) => void]> = [
    ["does not write depth", material => { material.disableDepthWrite = true; }],
    ["tests depth its own way", material => { material.depthFunction = Constants.ALWAYS; }],
    ["writes no colour", material => { material.disableColorWrite = true; }],
    ["uses the stencil", material => { material.stencil.enabled = true; }],
  ];
  for (const [what, change] of orderDependent) {
    it(`keeps an opaque mesh that ${what} in Babylon's place, and sorts the runs before and after it`, () => {
      const { scene, materials } = setup();
      const order = createOpaqueOrder(scene);
      order.setNearToFar(true);
      expect(drawn(scene)).toEqual(nearFirst(8));
      expect(order.lastFixed).toBe(0);
      change(materials[3]!);
      expect(drawn(scene)).toEqual(aroundTile3);
      expect(order.lastSorted).toBe(true);
      expect(order.lastFixed).toBe(1);
      // The next frame without it sorts all of them as one run.
      materials[3]!.dispose();
      scene.getMeshByName("tile-3")!.material = new StandardMaterial("plain", scene);
      expect(drawn(scene)).toEqual(nearFirst(8));
      expect(order.lastFixed).toBe(0);
      order.dispose();
    });
  }

  it("keeps fixed draws in Babylon's order among themselves, with a run between them", () => {
    const { scene, materials } = setup();
    const order = createOpaqueOrder(scene);
    order.setNearToFar(true);
    materials[5]!.disableDepthWrite = true;
    materials[2]!.disableDepthWrite = true;
    materials[1]!.disableDepthWrite = true;
    expect(drawn(scene)).toEqual(["tile-6", "tile-7", "tile-5", "tile-3", "tile-4", "tile-2", "tile-1", "tile-0"]);
    expect(order.lastFixed).toBe(3);
    order.dispose();
  });

  it("places fixed draws by Babylon's order, not the order meshes reach the list", () => {
    const { scene } = setup();
    const order = createOpaqueOrder(scene);
    order.setNearToFar(true);
    // tile-7 is made first, so it is listed first; its new material puts it last in Babylon's order.
    const late = new StandardMaterial("late", scene);
    late.disableDepthWrite = true;
    scene.getMeshByName("tile-7")!.material = late;
    expect(drawn(scene)).toEqual([...nearFirst(7), "tile-7"]);
    order.dispose();
  });

  it("keeps a mesh at no finite distance in Babylon's place", () => {
    const { scene } = setup();
    const order = createOpaqueOrder(scene);
    order.setNearToFar(true);
    expect(drawn(scene)).toEqual(nearFirst(8));
    scene.getMeshByName("tile-5")!.position.z = Number.NaN;
    expect(drawn(scene)).toEqual(["tile-6", "tile-7", "tile-5", "tile-0", "tile-1", "tile-2", "tile-3", "tile-4"]);
    expect(order.lastFixed).toBe(1);
    order.dispose();
  });

  it("leaves render targets' own draws alone", () => {
    const { scene } = setup();
    const order = createOpaqueOrder(scene);
    order.setNearToFar(true);
    const target = new RenderTargetTexture("target", 4, scene);
    const odd = MeshBuilder.CreateBox("odd", { size: 0.5 }, scene);
    odd.material = new StandardMaterial("odd", scene);
    odd.material.disableDepthWrite = true;
    odd.layerMask = 0x20000000;
    target.renderList = [odd, ...scene.meshes.filter(mesh => mesh.name.startsWith("tile-"))];
    expect(drawn(scene)).toEqual(nearFirst(8));
    target.render();
    expect(order.lastSorted).toBe(true);
    expect(order.lastFixed).toBe(0);
    target.dispose();
    order.dispose();
  });

  it("leaves see-through meshes and other groups in their own order", () => {
    const { scene } = setup(4);
    const glass = ["glass-far", "glass-near"].map((name, index) => {
      const mesh = MeshBuilder.CreateBox(name, { size: 0.5 }, scene);
      mesh.position.set(2, 0, index === 0 ? 9 : 2);
      const material = new StandardMaterial(name, scene);
      material.alpha = 0.5;
      mesh.material = material;
      return mesh;
    });
    const overlay = ["overlay-far", "overlay-near"].map((name, index) => {
      const mesh = MeshBuilder.CreateBox(name, { size: 0.5 }, scene);
      mesh.position.set(-2, 0, index === 0 ? 9 : 2);
      mesh.material = new StandardMaterial(name, scene);
      mesh.renderingGroupId = 1;
      return mesh;
    });
    const before = drawn(scene);
    const order = createOpaqueOrder(scene);
    order.setNearToFar(true);
    const after = drawn(scene);
    const only = (list: string[], names: string[]) => list.filter(name => names.includes(name));
    expect(only(after, glass.map(mesh => mesh.name))).toEqual(["glass-far", "glass-near"]);
    expect(only(after, overlay.map(mesh => mesh.name))).toEqual(only(before, overlay.map(mesh => mesh.name)));
    expect(only(after, nearFirst(4))).toEqual(nearFirst(4));
    order.dispose();
  });

  it("gives Babylon's own order back when turned off or disposed", () => {
    const { scene } = setup();
    const order = createOpaqueOrder(scene);
    order.setNearToFar(true);
    expect(scene.onBeforeRenderingGroupObservable.hasObservers()).toBe(true);
    expect(scene.onAfterRenderingGroupObservable.hasObservers()).toBe(true);
    order.setNearToFar(false);
    expect(scene.onBeforeRenderingGroupObservable.hasObservers()).toBe(false);
    expect(scene.onAfterRenderingGroupObservable.hasObservers()).toBe(false);
    expect(drawn(scene)).toEqual(farFirst(8));
    order.setNearToFar(true);
    expect(drawn(scene)).toEqual(nearFirst(8));
    order.dispose();
    expect(order.nearToFar).toBe(false);
    expect(drawn(scene)).toEqual(farFirst(8));
  });
});
