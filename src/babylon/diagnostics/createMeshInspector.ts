import {
  AbstractMesh,
  Camera,
  Color3,
  InstancedMesh,
  Material,
  MaterialPluginBase,
  Mesh,
  StandardMaterial,
  ShaderLanguage,
  TransformNode,
  type Observer,
  type Scene,
  type UniformBuffer,
} from "@babylonjs/core";
import { whenMeshesReady } from "../sceneUpdates.js";

export interface MeshInspectorNode {
  id: number;
  name: string;
  children: readonly MeshInspectorNode[];
  /** This node has triangle geometry of its own. */
  mesh: boolean;
  /** All geometry in this branch is selected. */
  selected: boolean;
  /** Some, but not all, geometry in this branch is selected. */
  mixed: boolean;
}

export interface MeshInspectorSnapshot {
  roots: readonly MeshInspectorNode[];
  enabled: boolean;
  error: string | null;
}

export interface MeshInspectorOptions {
  requestRender?(): void;
  /** Override readiness in CPU-only tests. Hidden overlays are prepared together. */
  whenReady?(meshes: readonly AbstractMesh[], signal: AbortSignal): Promise<void>;
}

export interface MeshInspector {
  setRoots(roots: readonly TransformNode[]): void;
  setEnabled(enabled: boolean): void;
  getSnapshot(): MeshInspectorSnapshot;
  subscribe(listener: () => void): () => void;
  /** Select a node's own geometry and every geometry beneath it. */
  setSelected(id: number, selected: boolean): void;
  selectAll(selected: boolean): void;
  dispose(): void;
}

/** Alias used by hosts to distinguish the controller from its snapshot. */
export type MeshInspectorHandle = MeshInspector;

interface Entry {
  node: TransformNode;
  geometrySource: Mesh | null;
  children: Entry[];
  selected: boolean;
}

interface Overlay {
  source: AbstractMesh;
  mesh: Mesh;
  ready: boolean;
}

function geometrySource(node: TransformNode): Mesh | null {
  const mesh = node instanceof InstancedMesh ? node.sourceMesh : node instanceof Mesh ? node : null;
  return mesh?.geometry && mesh.getTotalVertices() > 0 ? mesh : null;
}

/** Polygon offset cannot bias native lines, and WebGPU rejects it for line lists. */
class WireframeDepthBias extends MaterialPluginBase {
  private renderId = -1;
  private camera: Camera | null = null;
  private bias = 0;

  constructor(material: StandardMaterial) {
    super(material, "MeshInspectorDepthBias", 200, {}, true, true);
  }

  override isCompatible(language: ShaderLanguage): boolean {
    return language === ShaderLanguage.GLSL || language === ShaderLanguage.WGSL;
  }

  override getUniforms(language: ShaderLanguage = ShaderLanguage.GLSL) {
    return {
      ubo: [{ name: "meshInspectorDepthBias", size: 1, type: "float" }],
      vertex: language === ShaderLanguage.WGSL
        ? "uniform meshInspectorDepthBias: f32;"
        : "uniform float meshInspectorDepthBias;",
    };
  }

  override bindForSubMesh(buffer: UniformBuffer, scene: Scene): void {
    if (this.renderId !== scene.getRenderId() || this.camera !== scene.activeCamera) {
      this.renderId = scene.getRenderId();
      this.camera = scene.activeCamera;
      const engine = scene.getEngine();
      const projection = scene.getProjectionMatrix().m;
      const depthScale = this.camera?.mode === Camera.ORTHOGRAPHIC_CAMERA ? projection[10] : projection[14];
      // Bias by the depth equivalent of one camera-plane pixel. Unlike a fixed
      // NDC offset, this scales with projection and resolution, staying small at
      // flight-camera distances. Compute it once for this camera's render pass.
      const height = engine.getRenderHeight() * (this.camera?.viewport.height ?? 1);
      const bias = Math.abs(depthScale) * 2 / (Math.abs(projection[5]) * height);
      this.bias = (engine.useReverseDepthBuffer ? 1 : -1) * bias;
    }
    buffer.updateFloat("meshInspectorDepthBias", this.bias);
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): { [point: string]: string } | null {
    if (shaderType !== "vertex") return null;
    return {
      CUSTOM_VERTEX_MAIN_END: language === ShaderLanguage.WGSL
        ? "vertexOutputs.position.z += uniforms.meshInspectorDepthBias;"
        : "gl_Position.z += meshInspectorDepthBias;",
    };
  }
}

/**
 * Selected meshes keep their original materials and receive an orange triangle
 * wireframe pass. Geometry buffers, skeletal animation and morph targets are
 * shared; Babylon builds a cached line index buffer on its first wireframe draw.
 * No adjacency search, vertex expansion, picking, timer or continuous render loop
 * is needed. WebGPU, WebGL 2 and WebGL 1 all use Babylon's native line-list path.
 *
 * Disabled inspectors retain only the tree/selection: no overlays, material or
 * frame observer. Replacing a model selects its new nodes by default; passing
 * existing nodes preserves their selection. The caller supplies only model roots
 * so effects and unrelated scene geometry never enter the tree.
 */
export function createMeshInspector(scene: Scene, options: MeshInspectorOptions = {}): MeshInspector {
  const whenReady = options.whenReady ?? ((meshes, signal) => whenMeshesReady(meshes, { signal }));
  const listeners = new Set<() => void>();
  const entries = new Map<number, Entry>();
  const overlays = new Map<number, Overlay>();
  let roots: Entry[] = [];
  let enabled = false;
  let disposed = false;
  let error: string | null = null;
  let material: StandardMaterial | null = null;
  let pending: AbortController | null = null;
  let beforeMeshes: Observer<Scene> | null = null;
  let snapshot: MeshInspectorSnapshot = { roots: [], enabled, error };

  const publish = (): void => {
    const describe = (entry: Entry): { node: MeshInspectorNode; count: number; selected: number } => {
      const children = entry.children.map(describe);
      const count = (entry.geometrySource ? 1 : 0) + children.reduce((sum, child) => sum + child.count, 0);
      const selected = (entry.geometrySource && entry.selected ? 1 : 0) + children.reduce((sum, child) => sum + child.selected, 0);
      return {
        count,
        selected,
        node: {
          id: entry.node.uniqueId,
          name: entry.node.name,
          children: children.map(child => child.node),
          mesh: entry.geometrySource !== null,
          selected: count > 0 && count === selected,
          mixed: selected > 0 && selected < count,
        },
      };
    };
    snapshot = { roots: roots.map(entry => describe(entry).node), enabled, error };
    for (const listener of listeners) listener();
  };

  const shown = ({ source, ready }: Overlay): boolean => ready && !source.isDisposed()
    && source.isEnabled() && source.isVisible && source.visibility > 0;

  const synchronize = (overlay: Overlay): void => {
    const { mesh, source } = overlay;
    // isVisible/visibility are not inherited through the parent transform.
    // Read them after animation, before Babylon evaluates its active meshes.
    mesh.isVisible = source.isVisible && source.visibility > 0;
    mesh.visibility = source.visibility;
    mesh.layerMask = source.layerMask;
    mesh.renderingGroupId = source.renderingGroupId;
  };

  const stopObserver = (): void => {
    if (!beforeMeshes) return;
    scene.onBeforeActiveMeshesEvaluationObservable.remove(beforeMeshes);
    beforeMeshes = null;
  };

  const releaseResources = (): boolean => {
    pending?.abort();
    pending = null;
    stopObserver();
    const changed = [...overlays.values()].some(shown);
    for (const overlay of overlays.values()) overlay.mesh.dispose();
    overlays.clear();
    material?.dispose();
    material = null;
    return changed;
  };

  const reconcile = (): void => {
    pending?.abort();
    pending = null;
    if (!enabled) {
      if (releaseResources()) options.requestRender?.();
      return;
    }
    let removedShown = false;
    for (const [id, overlay] of overlays) {
      const entry = entries.get(id);
      if (entry?.selected && !entry.node.isDisposed()) continue;
      removedShown ||= shown(overlay);
      overlay.mesh.dispose();
      overlays.delete(id);
    }
    for (const [id, entry] of entries) {
      if (!entry.selected || !entry.geometrySource || entry.node.isDisposed() || overlays.has(id)) continue;
      if (!material) {
        material = new StandardMaterial("mesh-inspector-wireframe", scene);
        material.atomicMaterialsUpdate(wire => {
          wire.disableLighting = true;
          wire.emissiveColor = new Color3(1, 0.35, 0);
          wire.diffuseColor = Color3.Black();
          wire.specularColor = Color3.Black();
          wire.wireframe = true;
          wire.backFaceCulling = false;
          wire.disableDepthWrite = true;
          // Draw after opaque surfaces so hidden edges still fail the depth test.
          wire.transparencyMode = Material.MATERIAL_ALPHABLEND;
          wire.fogEnabled = false;
        });
        new WireframeDepthBias(material);
      }
      const source = entry.node as AbstractMesh;
      const mesh = new Mesh(`mesh-inspector-wireframe:${id}`, scene);
      mesh.setEnabled(false);
      mesh.parent = source;
      mesh.material = material;
      mesh.isUnIndexed = entry.geometrySource.isUnIndexed;
      entry.geometrySource.geometry!.applyToMesh(mesh);
      mesh.isPickable = false;
      mesh.skeleton = entry.geometrySource.skeleton;
      mesh.updatePoseMatrix(entry.geometrySource.getPoseMatrix());
      mesh.numBoneInfluencers = entry.geometrySource.numBoneInfluencers;
      mesh.computeBonesUsingShaders = entry.geometrySource.computeBonesUsingShaders;
      mesh.morphTargetManager = entry.geometrySource.morphTargetManager;
      mesh.bakedVertexAnimationManager = entry.geometrySource.bakedVertexAnimationManager;
      const overlay = { source, mesh, ready: false };
      synchronize(overlay);
      overlays.set(id, overlay);
    }
    if (removedShown) options.requestRender?.();
    if (overlays.size === 0) {
      stopObserver();
      material?.dispose();
      material = null;
      return;
    }
    if (!beforeMeshes) {
      beforeMeshes = scene.onBeforeActiveMeshesEvaluationObservable.add(() => {
        for (const overlay of overlays.values()) synchronize(overlay);
      });
    }
    const preparing = [...overlays.values()].filter(overlay => !overlay.ready);
    if (preparing.length === 0) return;
    const controller = new AbortController();
    pending = controller;
    void whenReady(preparing.map(overlay => overlay.mesh), controller.signal).then(() => {
      if (disposed || pending !== controller || controller.signal.aborted) return;
      pending = null;
      let changed = false;
      for (const overlay of preparing) {
        if (overlay.mesh.isDisposed() || overlay.source.isDisposed()) continue;
        overlay.ready = true;
        synchronize(overlay);
        overlay.mesh.setEnabled(true);
        changed ||= shown(overlay);
      }
      if (changed) options.requestRender?.();
    }).catch((reason: unknown) => {
      if (disposed || pending !== controller || controller.signal.aborted) return;
      pending = null;
      for (const overlay of preparing) {
        overlay.mesh.dispose();
        overlays.delete(overlay.source.uniqueId);
      }
      if (overlays.size === 0) {
        stopObserver();
        material?.dispose();
        material = null;
      }
      error = reason instanceof Error ? reason.message : String(reason);
      publish();
    });
  };

  const changeSelection = (targets: readonly Entry[], selected: boolean): void => {
    let changed = false;
    const visit = (entry: Entry): void => {
      if (entry.geometrySource && entry.selected !== selected) {
        entry.selected = selected;
        changed = true;
      }
      entry.children.forEach(visit);
    };
    targets.forEach(visit);
    if (!changed) return;
    error = null;
    reconcile();
    publish();
  };

  return {
    setRoots(nodes): void {
      if (disposed) return;
      const previous = new Map(entries);
      const overlayMeshes = new Set([...overlays.values()].map(overlay => overlay.mesh));
      entries.clear();
      const visit = (node: TransformNode): Entry | null => {
        if (node.isDisposed() || entries.has(node.uniqueId)) return null;
        const entry: Entry = { node, geometrySource: geometrySource(node), children: [], selected: previous.get(node.uniqueId)?.selected ?? true };
        entries.set(node.uniqueId, entry);
        entry.children = node.getChildren().filter((child): child is TransformNode => child instanceof TransformNode)
          .filter(child => !overlayMeshes.has(child as Mesh))
          .map(visit).filter((child): child is Entry => child !== null);
        return entry;
      };
      roots = nodes.map(visit).filter((entry): entry is Entry => entry !== null);
      error = null;
      reconcile();
      publish();
    },
    setEnabled(value): void {
      if (disposed || enabled === value) return;
      enabled = value;
      error = null;
      reconcile();
      publish();
    },
    getSnapshot: () => snapshot,
    subscribe(listener): () => void {
      if (!disposed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setSelected(id, selected): void {
      const entry = entries.get(id);
      if (!disposed && entry) changeSelection([entry], selected);
    },
    selectAll(selected): void {
      if (!disposed) changeSelection(roots, selected);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const changed = releaseResources();
      entries.clear();
      roots = [];
      snapshot = { roots: [], enabled: false, error: null };
      listeners.clear();
      if (changed) options.requestRender?.();
    },
  };
}
