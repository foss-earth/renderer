import { describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { GLTFLoader } from "@babylonjs/loaders/glTF/2.0/glTFLoader.js";
import "@babylonjs/loaders/glTF/2.0/index.js";
import { createGooglePreparedContainer, googleTextureSampler, installGoogleTilePreparation, type GoogleTilePreparationRenderer, type GoogleTilePreparationTile } from "../src/babylon/google.js";
import { createGoogleTileWorkerClient, type GooglePreparedTile, type GoogleTileWorkerPort } from "../src/babylon/google.js";

function tile(count = 1): Extract<GooglePreparedTile, { supported: true }> {
  return { supported: true, matrix: Float64Array.from(Matrix.Compose(new Vector3(2, 3, 4), Quaternion.RotationYawPitchRoll(.2, .4, .3), new Vector3(4, 5, 6)).asArray()),
    nodeName: "fixture", metadata: { asset: { version: "2.0", copyright: "Synthetic fixture only" }, nodes: [{ extras: { fixture: true } }],
      materials: [{ name: "paint", extensions: { KHR_materials_unlit: {} }, doubleSided: true, alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [.2, .3, .4, .5] } }] },
    primitives: Array.from({ length: count }, () => ({ positions: new Float32Array([0, -0, 0, 1, 0, 0, 0, 1, 0]), uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]), sourceIndexComponentType: 5121, materialIndex: 0,
      bitmap: { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap })) };
}
const texture = async (scene: Scene) => RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
function environment() { const engine = new NullEngine(); const scene = new Scene(engine); return { engine, scene }; }
const nodeExtras = (prepared: ReturnType<typeof tile>) => {
  const extras = (prepared.metadata as { nodes?: { extras?: unknown }[] }).nodes?.[0]?.extras;
  return extras ? { extras } : {};
};
/** What picking and Babylon read off each node: its own metadata and the loader's internal glTF pointers. */
const records = (root: TransformNode) => root.getDescendants().map(node => [node.name, node.metadata, (node as TransformNode & { _internalMetadata?: unknown })._internalMetadata]);
async function reference(scene: Scene, prepared: ReturnType<typeof tile>) {
  const p = prepared.primitives[0], bytes = new Uint8Array(64); bytes.set(new Uint8Array(p.positions.buffer)); bytes.set(new Uint8Array(p.uvs.buffer), 36); bytes.set([0, 1, 2], 60);
  const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: prepared.nodeName, mesh: 0, matrix: Array.from(prepared.matrix), ...nodeExtras(prepared) }],
    meshes: [{ primitives: prepared.primitives.map(() => ({ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 })) }],
    buffers: [{ byteLength: 64, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: 3 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" }, { bufferView: 2, componentType: 5121, count: 3, type: "SCALAR" }] };
  return LoadAssetContainerAsync(`data:${JSON.stringify(json)}`, scene, { pluginExtension: ".gltf", pluginOptions: { gltf: { skipMaterials: true } } });
}
describe("Google prepared Babylon consumer", () => {
  it("matches original glTF hierarchy, handedness, geometry and matrix operation order", async () => {
    for (const rightHanded of [false, true]) for (const count of [1, 2]) for (const extras of [true, false]) {
      const { engine, scene } = environment(); scene.useRightHandedSystem = rightHanded;
      const prepared = tile(count); if (!extras) (prepared.metadata as { nodes?: object[] }).nodes = [{}];
      const original = await reference(scene, prepared); original.addAllToScene();
      const adjustment = Matrix.RotationX(.5), transform = Matrix.Translation(10, 20, 30);
      const actual = await createGooglePreparedContainer(scene, prepared, adjustment, transform, { createTexture: texture });
      const originalRoot = original.rootNodes[0] as TransformNode; originalRoot.rotationQuaternion = Quaternion.Identity();
      adjustment.multiply(originalRoot.computeWorldMatrix(true)).decompose(originalRoot.scaling, originalRoot.rotationQuaternion, originalRoot.position);
      originalRoot.computeWorldMatrix(true).multiply(transform).decompose(originalRoot.scaling, originalRoot.rotationQuaternion, originalRoot.position);
      const a = actual.scene.getChildMeshes() as Mesh[], b = originalRoot.getChildMeshes() as Mesh[];
      expect(a.map(m => m.name)).toEqual(b.map(m => m.name));
      expect(actual.scene.getDescendants().map(n => [n.name, n.parent?.name])).toEqual(originalRoot.getDescendants().map(n => [n.name, n.parent?.name]));
      for (let i = 0; i < a.length; i++) {
        expect(Array.from(a[i].computeWorldMatrix(true).asArray())).toEqual(Array.from(b[i].computeWorldMatrix(true).asArray()));
        expect(Array.from(a[i].getVerticesData("position")!)).toEqual(Array.from(b[i].getVerticesData("position")!));
        expect(Array.from(a[i].getVerticesData("uv")!)).toEqual(Array.from(b[i].getVerticesData("uv")!));
        expect(Array.from(a[i].getIndices()!)).toEqual(Array.from(b[i].getIndices()!)); expect(a[i].sideOrientation).toEqual(b[i].sideOrientation);
      }
      // A tile's meshes say what the original loader's do, in the same places: a glTF pointer on a
      // mesh's own metadata reads as a point of interest, and a twist over it would not hold the ground.
      expect(records(actual.scene)).toEqual(records(originalRoot));
      expect(actual.scene.isEnabled()).toBe(false); expect(actual.metadata).toBe(prepared.metadata);
      const material = a[0].material as PBRMaterial;
      expect(material.unlit).toBe(true); expect(material.albedoColor.asArray()).toEqual([.2, .3, .4]); expect(material.alpha).toBe(.5);
      expect(material.transparencyMode).toBe(PBRMaterial.PBRMATERIAL_ALPHABLEND); expect(material.backFaceCulling).toBe(false);
      actual.container.dispose(); original.dispose();
      for (const p of prepared.primitives) expect(p.bitmap.close).toHaveBeenCalledOnce();
      scene.dispose(); engine.dispose();
    }
  });
  it("matches every original glTF sampler filter and address mode without dropping mips", () => {
    const loader = GLTFLoader as unknown as { _GetTextureSamplingMode(c: string, s: object): number; _GetTextureWrapMode(c: string, n?: number): number };
    for (const magFilter of [9728, 9729, undefined]) for (const minFilter of [9728, 9729, 9984, 9985, 9986, 9987, undefined]) for (const wrapS of [33071, 33648, 10497, undefined]) {
      const sampler = { magFilter, minFilter, wrapS, wrapT: wrapS }, actual = googleTextureSampler(sampler);
      expect(actual.samplingMode).toBe(loader._GetTextureSamplingMode("fixture", sampler)); expect(actual.wrapU).toBe(loader._GetTextureWrapMode("fixture", wrapS));
      expect(actual.noMipmap).toBe(minFilter === 9728 || minFilter === 9729);
    }
    expect(() => googleTextureSampler({ minFilter: 1 })).toThrow("filter");
  });
  it("disposes all resources and images on upload error or abort", async () => {
    for (const aborted of [false, true]) {
      const { engine, scene } = environment(), prepared = tile(2), controller = new AbortController();
      await expect(createGooglePreparedContainer(scene, prepared, Matrix.Identity(), Matrix.Identity(), { createTexture: async scene => {
        if (aborted) { controller.abort(); return texture(scene); } throw new Error("upload fixture");
      } }, controller.signal)).rejects.toThrow();
      expect(scene.meshes).toHaveLength(0); expect(scene.materials.filter(m => m.name === "paint")).toHaveLength(0);
      for (const p of prepared.primitives) expect(p.bitmap.close).toHaveBeenCalledOnce(); scene.dispose(); engine.dispose();
    }
  });
  it("retains compressed JPEG context-restoration data and closes uploaded bitmap pixels", async () => {
    const { engine, scene } = environment(), prepared = tile();
    const jpeg = new Uint8Array([255, 216, 255, 217]); prepared.primitives[0].jpeg = jpeg;
    const result = await createGooglePreparedContainer(scene, prepared, Matrix.Identity(), Matrix.Identity(), { createTexture: texture });
    expect(result.container.textures[0].getInternalTexture()?._buffer).toBe(jpeg);
    expect(prepared.primitives[0].bitmap.close).toHaveBeenCalledOnce(); result.container.dispose();
    expect(prepared.primitives[0].bitmap.close).toHaveBeenCalledOnce(); scene.dispose(); engine.dispose();
  });
  it("uses original loader for unsupported content and rejects stale preparation generations", async () => {
    const { engine, scene } = environment(); const replies: ((value: GooglePreparedTile) => void)[] = [];
    const original = vi.fn(async () => {}), dispose = vi.fn();
    const renderer: GoogleTilePreparationRenderer = { parseTile: original, dispose, _upRotationMatrix: Matrix.Identity() };
    const client = { decode: vi.fn(() => new Promise<GooglePreparedTile>(resolve => replies.push(resolve))), fallback: vi.fn(), dispose: vi.fn(), getStatus: vi.fn() };
    installGoogleTilePreparation(renderer, scene, client, { createTexture: texture });
    const target: GoogleTilePreparationTile = { engineData: { transform: Matrix.Identity(), scene: null } };
    const bytes = new ArrayBuffer(28); new DataView(bytes).setUint32(0, 0x46546c67, true); const signal = new AbortController().signal;
    const first = renderer.parseTile(bytes, target, "glb", "fixture", signal), second = renderer.parseTile(bytes, target, "glb", "fixture", signal);
    const stale = tile(), latest = tile(); replies[1](latest); await second; const active = target.engineData.scene;
    replies[0](stale); await first; expect(target.engineData.scene).toBe(active); expect(stale.primitives[0].bitmap.close).toHaveBeenCalledOnce();
    expect(active?.isEnabled()).toBe(false); target.engineData.container?.dispose();
    const third = renderer.parseTile(bytes, target, "glb", "fixture", signal); replies[2]({ supported: false, reason: "node hierarchy" }); await third;
    expect(original).toHaveBeenCalledOnce(); expect(client.fallback).toHaveBeenCalledWith("Unsupported Google profile: node hierarchy"); renderer.dispose(); expect(client.dispose).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
    scene.dispose(); engine.dispose();
  });
});
describe("Google worker host ownership", () => {
  function worker(): GoogleTileWorkerPort { return { onmessage: null, onerror: null, onmessageerror: null, postMessage: vi.fn(), terminate: vi.fn() }; }
  it("waits outside its execution timeout, holds cancelled compute through the actual reply and serializes ready jobs", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn(), grants: Array<(value: { lanes: number; release: typeof release }) => void> = [];
      const acquire = vi.fn(() => new Promise<{ lanes: number; release: typeof release }>(resolve => grants.push(resolve)));
      const port = { ...worker(), compute: { acquire } }, client = createGoogleTileWorkerClient({ createWorker: () => port, timeoutMs: 10 });
      const abort = new AbortController(), first = client.decode(new ArrayBuffer(28), abort.signal), next = client.decode(new ArrayBuffer(28));
      await vi.advanceTimersByTimeAsync(100); expect(port.postMessage).not.toHaveBeenCalled(); expect(acquire).toHaveBeenCalledOnce();
      grants.shift()!({ lanes: 1, release }); await Promise.resolve();
      abort.abort(); await expect(first).rejects.toThrow("cancelled");
      expect(release).not.toHaveBeenCalled(); expect(port.postMessage).toHaveBeenCalledOnce();
      const stale = tile(); port.onmessage?.({ data: { ...stale, version: 1, id: 1, generation: 0, kind: "decoded" } } as MessageEvent);
      expect(stale.primitives[0].bitmap.close).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledWith("stale");
      expect(acquire).toHaveBeenCalledTimes(2); grants.shift()!({ lanes: 1, release }); await Promise.resolve();
      port.onmessage?.({ data: { supported: false, reason: "fixture", version: 1, id: 2, generation: 0, kind: "decoded" } } as MessageEvent);
      await next; client.dispose(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("starts lazily, bounds its queue, retains fallback input and closes cancelled late output", async () => {
    const port = worker(), factory = vi.fn(() => port), client = createGoogleTileWorkerClient({ createWorker: factory, maxPending: 1 });
    expect(factory).not.toHaveBeenCalled(); const controller = new AbortController(), input = new ArrayBuffer(28);
    const pending = client.decode(input, controller.signal); expect(input.byteLength).toBe(28);
    await expect(client.decode(input)).rejects.toThrow("queue"); controller.abort(); await expect(pending).rejects.toThrow("cancelled");
    const stale = tile(); port.onmessage?.({ data: { ...stale, version: 1, id: 1, generation: 0, kind: "decoded" } } as MessageEvent);
    expect(stale.primitives[0].bitmap.close).toHaveBeenCalledOnce(); client.dispose(); expect(port.terminate).toHaveBeenCalledOnce();
  });
  it("reports actual backend, geometry parity, work and transfer sizes", async () => {
    const port = worker(), client = createGoogleTileWorkerClient({ createWorker: () => port }); const pending = client.decode(new ArrayBuffer(28));
    port.onmessage?.({ data: { ...tile(), version: 1, id: 1, generation: 0, kind: "decoded", actualTier: "single", parity: "same", workMs: 12 } } as MessageEvent);
    const result = await pending; expect(client.getStatus()).toMatchObject({ actual: "wasm-single", parity: "same", jobs: 1, pending: 0, workMs: 12 });
    expect(client.getStatus().copyBytes).toBeGreaterThan(28); if (result.supported) result.primitives[0].bitmap.close(); client.dispose();
  });
  it("retires timed out workers and makes the original fallback explicit", async () => {
    vi.useFakeTimers(); const port = worker(), client = createGoogleTileWorkerClient({ createWorker: () => port, timeoutMs: 10 });
    const failed = expect(client.decode(new ArrayBuffer(28))).rejects.toThrow("timeout"); await vi.advanceTimersByTimeAsync(11); await failed;
    expect(client.getStatus()).toMatchObject({ actual: "original", failures: 1, pending: 0 }); expect(port.terminate).toHaveBeenCalledOnce(); client.dispose(); vi.useRealTimers();
  });
});
