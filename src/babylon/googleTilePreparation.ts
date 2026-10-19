import { AssetContainer } from "@babylonjs/core/assetContainer.js";
import { Matrix, Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { Color3 } from "@babylonjs/core/Maths/math.color.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
import { Material } from "@babylonjs/core/Materials/material.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { Texture } from "@babylonjs/core/Materials/Textures/texture.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { GooglePreparedPrimitive, GooglePreparedTile, GoogleTileWorkerClient } from "./googleTileWorkerClient.js";
import { closeGoogleTileBitmaps } from "./googleTileWorkerClient.js";

export interface GoogleTextureSampler {
  noMipmap: boolean; samplingMode: number; wrapU: number; wrapV: number;
}
/** Match the Babylon glTF loader's complete mag/min combination table. */
export function googleTextureSampler(sampler: GooglePreparedPrimitive["sampler"] = {}): GoogleTextureSampler {
  const filters = [9728, 9729, 9984, 9985, 9986, 9987];
  const linear = [Texture.LINEAR_NEAREST, Texture.LINEAR_LINEAR, Texture.LINEAR_NEAREST_MIPNEAREST,
    Texture.LINEAR_LINEAR_MIPNEAREST, Texture.LINEAR_NEAREST_MIPLINEAR, Texture.LINEAR_LINEAR_MIPLINEAR];
  const nearest = [Texture.NEAREST_NEAREST, Texture.NEAREST_LINEAR, Texture.NEAREST_NEAREST_MIPNEAREST,
    Texture.NEAREST_LINEAR_MIPNEAREST, Texture.NEAREST_NEAREST_MIPLINEAR, Texture.NEAREST_LINEAR_MIPLINEAR];
  const mag = sampler.magFilter ?? 9729, min = sampler.minFilter ?? 9987;
  const index = filters.indexOf(min);
  if (![9728, 9729].includes(mag) || index < 0) throw new Error("Unsupported Google texture filter");
  const wrap = (mode = 10497) => {
    if (mode === 33071) return Texture.CLAMP_ADDRESSMODE;
    if (mode === 33648) return Texture.MIRROR_ADDRESSMODE;
    if (mode === 10497) return Texture.WRAP_ADDRESSMODE;
    throw new Error("Unsupported Google texture wrap");
  };
  return { noMipmap: min === 9728 || min === 9729, samplingMode: (mag === 9729 ? linear : nearest)[index],
    wrapU: wrap(sampler.wrapS), wrapV: wrap(sampler.wrapT) };
}
let textureId = 0;
async function bitmapTexture(scene: Scene, primitive: GooglePreparedPrimitive, sampler: GoogleTextureSampler, signal?: AbortSignal): Promise<Texture> {
  let texture: Texture | undefined;
  try {
    return await new Promise<Texture>((resolve, reject) => {
      let loaded = false;
      const abort = () => { texture?.dispose(); reject(new DOMException("Google texture upload cancelled", "AbortError")); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      const finish = () => signal?.removeEventListener("abort", abort);
      // Keep the bitmap alive with the texture, including context restoration.
      texture = new Texture(`data:foss-google-${++textureId}`, scene, { ...sampler, invertY: false,
        buffer: primitive.bitmap, mimeType: "image/jpeg", useSRGBBuffer: true,
        onLoad() { loaded = true; finish(); if (texture) resolve(texture); },
        onError(message, error) { finish(); reject(error ?? new Error(message ?? "Google texture upload failed")); } });
      texture.wrapU = sampler.wrapU; texture.wrapV = sampler.wrapV;
      if (loaded || texture.isReady()) { finish(); resolve(texture); }
    });
  } catch (error) { texture?.dispose(); throw error; }
}
interface GltfRecord { gltf?: { pointers?: string[]; extras?: unknown } }
/** Where the Babylon glTF loader records a node, mesh or material: its pointer in internal metadata,
 * and its extras, if any, in `metadata.gltf.extras`. Picking reads `metadata`, so a pointer there
 * would make a ground tile look like a point of interest. */
function recordGltf(object: { metadata: GltfRecord | null; _internalMetadata?: GltfRecord }, pointer: string, extras?: unknown): void {
  object.metadata = object.metadata || {};
  const gltf = ((object._internalMetadata ||= {}).gltf ||= {});
  (gltf.pointers ||= []).push(pointer);
  if (extras && typeof extras === "object" && Object.keys(extras).length > 0) (object.metadata.gltf ||= {}).extras = extras;
}
export interface GooglePreparationOptions {
  /** Test/device port; must preserve sRGB, invertY:false and the supplied sampler. */
  createTexture?(scene: Scene, primitive: GooglePreparedPrimitive, sampler: GoogleTextureSampler, signal?: AbortSignal): Promise<Texture>;
  textureTimeoutMs?: number;
}
export interface GooglePreparedContainer { scene: Mesh; container: AssetContainer; metadata: Record<string, unknown>; }
/** Consume all transferred bitmaps, including failures. The result remains disabled
 * until the existing tile traversal/readiness policy enables it. */
export async function createGooglePreparedContainer(scene: Scene, tile: Extract<GooglePreparedTile, { supported: true }>,
  adjustment: Matrix, tileTransform: Matrix, options: GooglePreparationOptions = {}, signal?: AbortSignal): Promise<GooglePreparedContainer> {
  const container = new AssetContainer(scene), root = new Mesh("__root__", scene);
  root.setEnabled(false); root.rotationQuaternion = Quaternion.Identity(); container.meshes.push(root); container.rootNodes.push(root);
  if (!scene.useRightHandedSystem) { root.rotationQuaternion.set(0, 1, 0, 0); root.scaling.z = -1; }
  const closed = new Set<ImageBitmap>();
  const close = (bitmap: ImageBitmap) => { if (!closed.has(bitmap)) { closed.add(bitmap); bitmap.close(); } };
  // Container owns geometry, textures, materials and bitmaps from this point.
  const disposeContainer = container.dispose.bind(container);
  container.dispose = () => {
    const failures: unknown[] = [];
    try { disposeContainer(); } catch (error) { failures.push(error); }
    for (const primitive of tile.primitives) { try { close(primitive.bitmap); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, "Google tile resource cleanup failed");
  };
  const check = () => { if (signal?.aborted) throw new DOMException("Google tile preparation cancelled", "AbortError"); };
  try {
    check();
    const metadata = tile.metadata as { nodes?: { name?: string; extras?: unknown }[]; materials?: {
      name?: string; doubleSided?: boolean; alphaMode?: string; alphaCutoff?: number;
      pbrMetallicRoughness?: { baseColorFactor?: number[] }; extras?: unknown;
    }[] };
    const name = tile.nodeName || "node0";
    const node: TransformNode = tile.primitives.length === 1 ? new Mesh(name, scene) : new TransformNode(name, scene);
    node.parent = root; node.rotationQuaternion = Quaternion.Identity();
    if (node instanceof Mesh) container.meshes.push(node); else container.transformNodes.push(node);
    Matrix.FromArray(tile.matrix).decompose(node.scaling, node.rotationQuaternion, node.position);
    const materials = new Map<number, PBRMaterial>();
    for (let index = 0; index < tile.primitives.length; index++) {
      const primitive = tile.primitives[index];
      const mesh: Mesh = node instanceof Mesh ? node : new Mesh(`${name}_primitive${index}`, scene);
      if (mesh !== node) { mesh.parent = node; container.meshes.push(mesh); }
      recordGltf(mesh, `/meshes/0/primitives/${index}`);
      mesh.sideOrientation = scene.useRightHandedSystem ? Material.CounterClockWiseSideOrientation : Material.ClockWiseSideOrientation;
      const data = new VertexData(); data.positions = primitive.positions; data.uvs = primitive.uvs; data.indices = primitive.indices;
      data.applyToMesh(mesh); if (mesh.geometry) container.geometries.push(mesh.geometry);
      let material = materials.get(primitive.materialIndex);
      if (!material) {
        const source = metadata.materials?.[primitive.materialIndex];
        if (!source) throw new Error("Prepared Google material is missing");
        material = new PBRMaterial(source.name || `material${primitive.materialIndex}`, scene);
        container.materials.push(material); materials.set(primitive.materialIndex, material);
        material.unlit = true; material.metallic = 1; material.roughness = 1;
        const factor = source.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
        material.albedoColor = Color3.FromArray(factor); material.alpha = factor[3];
        material.backFaceCulling = !source.doubleSided; material.twoSidedLighting = !!source.doubleSided;
        recordGltf(material, `/materials/${primitive.materialIndex}`, source.extras);
        const sampler = googleTextureSampler(primitive.sampler);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let expired = false;
        const uploadAbort = new AbortController();
        const cancelUpload = () => { expired = true; uploadAbort.abort(); };
        signal?.addEventListener("abort", cancelUpload, { once: true });
        const upload = (options.createTexture ?? bitmapTexture)(scene, primitive, sampler, uploadAbort.signal).then(texture => {
          if (expired) { texture.dispose(); return texture; }
          return texture;
        });
        let texture: Texture;
        try {
          texture = await Promise.race([upload, new Promise<never>((_, reject) => {
            timer = setTimeout(() => { cancelUpload(); reject(new Error("Google texture upload timeout")); }, options.textureTimeoutMs ?? 15_000);
          })]);
        } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancelUpload); }
        container.textures.push(texture); texture.name = `${material.name} (Base Color)`;
        material.albedoTexture = texture;
        if (primitive.jpeg) {
          // Babylon restores URL textures from these buffers after context loss.
          // Keep the compressed JPEG, then release decoded pixels after upload.
          texture._buffer = primitive.jpeg;
          const internal = texture.getInternalTexture(); if (internal) internal._buffer = primitive.jpeg;
          close(primitive.bitmap);
        } else texture.onDisposeObservable.add(() => close(primitive.bitmap));
        switch (source.alphaMode ?? "OPAQUE") {
          case "OPAQUE": material.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE; material.alpha = 1; break;
          case "MASK": material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST; material.alphaCutOff = source.alphaCutoff ?? 0.5; texture.hasAlpha = true; break;
          case "BLEND": material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND; texture.hasAlpha = true; material.useAlphaFromAlbedoTexture = true; break;
          default: throw new Error("Unsupported Google alpha mode");
        }
        check();
      } else close(primitive.bitmap); // Shared material reuses its original texture.
      mesh.material = material;
    }
    // The supported profile is one node with one mesh; the loader records the node after its primitives.
    recordGltf(node, "/nodes/0", metadata.nodes?.[0]?.extras);
    // The retained 3d-tiles GLTFLoader resets the glTF root quaternion before
    // its adjustment (while retaining the handedness scale). Keep that order.
    root.rotationQuaternion = Quaternion.Identity();
    adjustment.multiply(root.computeWorldMatrix(true)).decompose(root.scaling, root.rotationQuaternion!, root.position);
    root.computeWorldMatrix(true).multiply(tileTransform).decompose(root.scaling, root.rotationQuaternion!, root.position);
    check();
    return { scene: root, container, metadata: tile.metadata };
  } catch (error) {
    try { container.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Google tile preparation and cleanup failed"); }
    throw error;
  }
}
export interface GoogleTilePreparationTile {
  engineData: { transform: Matrix; scene: TransformNode | null; container?: AssetContainer | null; metadata?: unknown };
}
export interface GoogleTilePreparationRenderer {
  parseTile(buffer: ArrayBuffer, tile: GoogleTilePreparationTile, extension: string, uri: string, signal: AbortSignal): Promise<void>;
  dispose(): void; checkCollisions?: boolean; _upRotationMatrix?: Matrix;
}
/** Install before engine readiness wrapping. Unsupported/non-GLB content and worker
 * failures use the exact original loader; a generation can publish at most once. */
export function installGoogleTilePreparation<T extends GoogleTilePreparationRenderer>(renderer: T, scene: Scene,
  client: GoogleTileWorkerClient, options: GooglePreparationOptions = {}): { dispose(): void } {
  const originalParse = renderer.parseTile, originalDispose = renderer.dispose;
  const generations = new WeakMap<GoogleTilePreparationTile, AbortController>();
  const pending = new Set<AbortController>();
  let disposed = false;
  renderer.parseTile = async function(buffer, tile, extension, uri, signal) {
    generations.get(tile)?.abort();
    const generation = new AbortController(); generations.set(tile, generation); pending.add(generation);
    const abort = () => generation.abort(); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const combined = generation.signal;
    const active = () => !disposed && !combined.aborted && generations.get(tile) === generation;
    try {
    if (!active()) return;
    const fallback = async (reason: string) => { client.fallback(reason); if (active()) await originalParse.call(renderer, buffer, tile, extension, uri, combined); };
    const magic = buffer.byteLength >= 4 ? new DataView(buffer).getUint32(0, true) : 0;
    if (magic !== 0x46546c67) { await fallback(`Original loader: ${extension} content`); return; }
    let prepared: GooglePreparedTile;
    try { prepared = await client.decode(buffer, combined); }
    catch (error) { if (active()) await fallback(`Google worker fallback: ${String(error)}`); return; }
    if (!prepared.supported) { await fallback(`Unsupported Google profile: ${prepared.reason}`); return; }
    if (!active()) { closeGoogleTileBitmaps(prepared); return; }
    let result: GooglePreparedContainer;
    try { result = await createGooglePreparedContainer(scene, prepared, renderer._upRotationMatrix ?? Matrix.Identity(), tile.engineData.transform, options, combined); }
    catch (error) { if (active()) await fallback(`Google renderer fallback: ${String(error)}`); return; }
    if (!active()) { result.container.dispose(); return; }
    for (const mesh of result.scene.getChildMeshes()) mesh.checkCollisions = !!renderer.checkCollisions;
    tile.engineData.scene = result.scene; tile.engineData.container = result.container; tile.engineData.metadata = result.metadata;
    } finally { signal.removeEventListener("abort", abort); pending.delete(generation); }
  };
  const dispose = () => { if (disposed) return; disposed = true; for (const request of pending) request.abort(); client.dispose(); };
  renderer.dispose = function() { dispose(); originalDispose.call(renderer); };
  return { dispose };
}
