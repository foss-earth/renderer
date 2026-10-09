import {
  Mesh,
  MeshBuilder,
  Matrix,
  MorphTarget,
  MorphTargetManager,
  NullEngine,
  Scene,
  Skeleton,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createMeshInspector, type MeshInspectorHandle } from "./createMeshInspector.js";

let engine: NullEngine;
let scene: Scene;
let inspector: MeshInspectorHandle;
let requestRender: Mock<() => void>;

const overlays = (): Mesh[] => scene.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.name.startsWith("mesh-inspector-wireframe:"));
const settled = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

function model(): { root: TransformNode; wing: Mesh; flap: Mesh } {
  const root = new TransformNode("model", scene);
  const wing = MeshBuilder.CreateBox("wing", {}, scene);
  wing.parent = root;
  const flap = MeshBuilder.CreateBox("flap", {}, scene);
  flap.parent = wing;
  return { root, wing, flap };
}

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  requestRender = vi.fn<() => void>();
  inspector = createMeshInspector(scene, { requestRender, whenReady: async () => {} });
});

afterEach(() => {
  inspector.dispose();
  scene.dispose();
  engine.dispose();
});

describe("mesh inspection", () => {
  it("keeps a stable snapshot and does no rendering work while the feature is off", () => {
    const { root, flap } = model();
    const changed = vi.fn();
    const stop = inspector.subscribe(changed);
    const observerCount = scene.onBeforeActiveMeshesEvaluationObservable.observers.length;
    inspector.setRoots([root]);
    const snapshot = inspector.getSnapshot();
    expect(inspector.getSnapshot()).toBe(snapshot);
    expect(snapshot.roots[0].selected).toBe(true);
    inspector.setSelected(flap.uniqueId, false);
    expect(inspector.getSnapshot().roots[0].mixed).toBe(true);
    expect(overlays()).toHaveLength(0);
    expect(scene.onBeforeActiveMeshesEvaluationObservable.observers).toHaveLength(observerCount);
    expect(requestRender).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    inspector.selectAll(true);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("selects entire branches and marks a branch containing its own deselected geometry mixed", () => {
    const { root, wing, flap } = model();
    inspector.setRoots([root]);
    inspector.setSelected(wing.uniqueId, false);
    expect(inspector.getSnapshot().roots[0].selected).toBe(false);
    expect(inspector.getSnapshot().roots[0].mixed).toBe(false);
    inspector.setSelected(flap.uniqueId, true);
    expect(inspector.getSnapshot().roots[0].children[0]).toMatchObject({ selected: false, mixed: true });
    inspector.setSelected(root.uniqueId, true);
    expect(inspector.getSnapshot().roots[0]).toMatchObject({ selected: true, mixed: false, mesh: false });
    const snapshot = inspector.getSnapshot();
    inspector.selectAll(true);
    inspector.setSelected(-1, false);
    expect(inspector.getSnapshot()).toBe(snapshot);
  });

  it("shares source geometry and deformation while preserving materials and animated transforms", async () => {
    const { root, wing, flap } = model();
    const original = new StandardMaterial("original", scene);
    wing.material = original;
    flap.material = original;
    wing.position.set(3, 4, 5);
    root.position.x = 100;
    wing.skeleton = new Skeleton("rig", "rig", scene);
    wing.updatePoseMatrix(Matrix.Translation(7, 8, 9));
    flap.morphTargetManager = new MorphTargetManager(scene);
    flap.morphTargetManager.addTarget(new MorphTarget("flex", 0, scene));
    const geometryCount = scene.geometries.length;
    inspector.setRoots([root]);
    inspector.setEnabled(true);
    expect(overlays().every(mesh => !mesh.isEnabled())).toBe(true);
    expect(requestRender).not.toHaveBeenCalled();
    await settled();
    const wireWing = overlays().find(mesh => mesh.parent === wing)!;
    const wireFlap = overlays().find(mesh => mesh.parent === flap)!;
    expect(scene.geometries).toHaveLength(geometryCount);
    expect(wireWing.geometry).toBe(wing.geometry);
    expect(wireWing.skeleton).toBe(wing.skeleton);
    expect(wireWing.getPoseMatrix().equals(wing.getPoseMatrix())).toBe(true);
    expect(wireFlap.morphTargetManager).toBe(flap.morphTargetManager);
    expect(wireWing.material).toBe(wireFlap.material);
    expect(wireWing.material).toMatchObject({ wireframe: true, disableLighting: true, disableDepthWrite: true });
    expect(wing.material).toBe(original);
    expect(flap.material).toBe(original);
    expect(original.wireframe).toBe(false);
    expect(wireWing.isPickable).toBe(false);
    expect(wireWing.computeWorldMatrix(true).equals(wing.computeWorldMatrix(true))).toBe(true);
    wing.rotation.y = 1.2;
    wing.position.addInPlace(new Vector3(5, 1, 3));
    expect(wireWing.computeWorldMatrix(true).equals(wing.computeWorldMatrix(true))).toBe(true);
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("respects independently hidden geometry without changing any original visibility", async () => {
    const { root, wing, flap } = model();
    inspector.setRoots([root]);
    inspector.setEnabled(true);
    await settled();
    const wireWing = overlays().find(mesh => mesh.parent === wing)!;
    const wireFlap = overlays().find(mesh => mesh.parent === flap)!;
    wing.isVisible = false;
    flap.visibility = 0.35;
    flap.layerMask = 8;
    scene.onBeforeActiveMeshesEvaluationObservable.notifyObservers(scene);
    expect(wireWing.isVisible).toBe(false);
    expect(wireFlap.isVisible).toBe(true);
    expect(wireFlap.visibility).toBe(0.35);
    expect(wireFlap.layerMask).toBe(8);
    expect(wing.isVisible).toBe(false);
    expect(flap.isVisible).toBe(true);
    root.setEnabled(false);
    expect(wireFlap.isEnabled()).toBe(false);
    inspector.selectAll(false);
    expect(wing.isVisible).toBe(false);
    expect(flap.visibility).toBe(0.35);
  });

  it("releases every debug resource and frame observer when disabled", async () => {
    const { root, wing, flap } = model();
    const original = new StandardMaterial("source-material", scene);
    wing.material = original;
    flap.material = original;
    const counts = { meshes: scene.meshes.length, materials: scene.materials.length, geometries: scene.geometries.length };
    const observers = scene.onBeforeActiveMeshesEvaluationObservable.observers.length;
    inspector.setRoots([root]);
    inspector.setEnabled(true);
    await settled();
    expect(scene.meshes).toHaveLength(counts.meshes + 2);
    expect(scene.materials).toHaveLength(counts.materials + 1);
    expect(scene.onBeforeActiveMeshesEvaluationObservable.observers).toHaveLength(observers + 1);
    requestRender.mockClear();
    inspector.setEnabled(false);
    expect(scene.meshes).toHaveLength(counts.meshes);
    expect(scene.materials).toHaveLength(counts.materials);
    expect(scene.geometries).toHaveLength(counts.geometries);
    expect(wing.geometry?.meshes).toHaveLength(1);
    expect(scene.onBeforeActiveMeshesEvaluationObservable.observers.filter(observer => !observer._willBeUnregistered)).toHaveLength(observers);
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("never reveals cancelled preparation and reports readiness failures without leaking", async () => {
    inspector.dispose();
    let ready!: () => void;
    let fail!: (reason: Error) => void;
    let signal!: AbortSignal;
    inspector = createMeshInspector(scene, {
      requestRender,
      whenReady: (_meshes, activeSignal) => {
        signal = activeSignal;
        return new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
      },
    });
    const { root } = model();
    inspector.setRoots([root]);
    inspector.setEnabled(true);
    inspector.setEnabled(false);
    expect(signal.aborted).toBe(true);
    ready();
    await settled();
    expect(overlays()).toHaveLength(0);
    expect(requestRender).not.toHaveBeenCalled();
    inspector.setEnabled(true);
    fail(new Error("Cannot prepare wireframe"));
    await settled();
    expect(inspector.getSnapshot().error).toBe("Cannot prepare wireframe");
    expect(overlays()).toHaveLength(0);
    expect(scene.materials.some(material => material.name === "mesh-inspector-wireframe")).toBe(false);
  });

  it("excludes its own overlays from rebuilt trees and resets selection for replacement models", async () => {
    const { root, wing, flap } = model();
    inspector.setRoots([root]);
    inspector.setSelected(flap.uniqueId, false);
    inspector.setEnabled(true);
    await settled();
    inspector.setRoots([root]);
    expect(inspector.getSnapshot().roots[0].children[0].children).toHaveLength(1);
    expect(inspector.getSnapshot().roots[0].children[0].children[0].selected).toBe(false);
    const replacement = model();
    inspector.setRoots([replacement.root]);
    await settled();
    expect(inspector.getSnapshot().roots[0].selected).toBe(true);
    expect(overlays()).toHaveLength(2);
    expect(overlays().some(mesh => mesh.parent === wing)).toBe(false);
    inspector.setRoots([]);
    expect(overlays()).toHaveLength(0);
    expect(inspector.getSnapshot().roots).toHaveLength(0);
  });

  it("does not inspect or alter unrelated scene geometry", async () => {
    const { root } = model();
    const terrain = MeshBuilder.CreateBox("terrain", {}, scene);
    const terrainMaterial = new StandardMaterial("terrain", scene);
    terrain.material = terrainMaterial;
    inspector.setRoots([root]);
    inspector.setEnabled(true);
    await settled();
    inspector.selectAll(false);
    expect(terrain.material).toBe(terrainMaterial);
    expect(terrainMaterial.wireframe).toBe(false);
    expect(terrain.getChildren()).toHaveLength(0);
    expect(terrain.isVisible).toBe(true);
  });

  it("preserves non-indexed triangle counts when sharing glTF geometry", async () => {
    const source = new Mesh("non-indexed", scene);
    source.isUnIndexed = true;
    source.setVerticesData("position", [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    source.setIndices([]);
    inspector.setRoots([source]);
    inspector.setEnabled(true);
    await settled();
    expect(overlays()[0].geometry).toBe(source.geometry);
    expect(overlays()[0].subMeshes[0].indexCount).toBe(3);
    expect(overlays()[0].isUnIndexed).toBe(true);
  });

  it("can be created and enabled empty without accessing a renderer", () => {
    const inert = createMeshInspector({} as Scene);
    inert.setEnabled(true);
    inert.setRoots([]);
    inert.setEnabled(false);
    inert.dispose();
    expect(inert.getSnapshot().roots).toHaveLength(0);
  });
});
