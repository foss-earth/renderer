import {
  Color3, Constants, type DynamicTexture, Material, Mesh, MeshBuilder, Quaternion, StandardMaterial,
  Texture, TransformNode, Vector3, type Scene,
} from "@babylonjs/core";
import type { CanvasTextureDevicePorts } from "../canvasTextureDevice.js";
import { whenMeshesReady } from "../sceneUpdates.js";

export interface DebugVector {
  id: string;
  label: string;
  color: string;
  /** Both vector and anchor are in the supplied parent's local coordinate system. */
  vector: readonly [number, number, number];
  anchor: readonly [number, number, number];
  /**
   * `arrow`, the default, draws the vector from its anchor. `arc` draws a
   * rotation about the vector's direction through its anchor by the right-hand
   * rule, for a moment, a torque or an angular velocity: the sweep is its
   * magnitude and the arrowhead its sense.
   */
  shape?: "arrow" | "arc";
}

export interface ArcDebugDrawingSettings {
  /** Scalar data units represented by one degree of sweep. */
  valuePerDegree: number;
  radiusMeters: number;
  /** Caps the sweep, at most a full turn; labels keep the full magnitude. */
  maxSweepDegrees: number;
}

export interface VectorDebugDrawingSettings {
  enabled: boolean;
  /** Scalar data units represented by one metre of arrow. */
  valuePerMeter: number;
  maxArrowMeters: number;
  labels: boolean;
  labelRefreshHz: number;
  /** Needed only by vectors drawn as arcs, which stay hidden without it. */
  arcs?: ArcDebugDrawingSettings;
}

export interface VectorDebugDrawingOptions {
  /** Required when labels are enabled; canvas creation/upload belong to the host renderer. */
  textureDevice?: CanvasTextureDevicePorts;
  settings: VectorDebugDrawingSettings;
  /** Unit conversion for label values; geometry uses the unscaled input vector. */
  valueDisplayScale: number;
  valueUnit: string;
  /** Label conversion for arcs, whose quantity usually has a unit of its own; defaults to the arrows'. */
  arcValueDisplayScale?: number;
  arcValueUnit?: string;
  requestRender?(): void;
  onError?(message: string): void;
  whenReady?(meshes: readonly Mesh[], signal: AbortSignal): Promise<void>;
}

type GlyphShape = NonNullable<DebugVector["shape"]>;

interface VectorGlyph {
  shape: GlyphShape;
  root: TransformNode;
  /** A unit cylinder scaled along the arrow, or an updatable tube along the arc. */
  shaft: Mesh;
  head: Mesh;
  label: Mesh | null;
  labelAnchor: TransformNode | null;
  texture: DynamicTexture | null;
  key: string;
  text: string;
  labelTime: number;
  color: string;
  labelText: string;
}

interface GlyphExtent {
  magnitude: number;
  visible: boolean;
  capped: boolean;
  /** Arrow length in metres, or arc sweep in degrees. */
  size: number;
}

/** Points along an arc's tube; a tube keeps its point count when updated. */
const ARC_POINTS = 49;
const HEAD_METERS = 0.35;
const LABEL_GAP_METERS = 0.35;
const shapeOf = (vector: DebugVector): GlyphShape => vector.shape ?? "arrow";

/**
 * An arc starts from parent-local up projected onto its plane, or from
 * forward when its axis lies within 30 degrees of up, so a reversed rotation
 * starts at the same place and only its sense changes.
 */
function arcBasis(axis: Vector3): { u: Vector3; v: Vector3 } {
  let u = new Vector3(0, 1, 0).subtractInPlace(axis.scale(axis.y));
  if (u.length() < 0.5) u = new Vector3(0, 0, 1).subtractInPlace(axis.scale(axis.z));
  u.normalize();
  return { u, v: Vector3.Cross(axis, u) };
}

/** World-space vector glyphs in parent-local coordinates, independent of any domain model. */
export function createVectorDebugDrawing(scene: Scene, parent: TransformNode, options: VectorDebugDrawingOptions) {
  const requireLabelDevice = (next: VectorDebugDrawingSettings): void => {
    if (next.labels && !options.textureDevice) throw new Error("Vector labels require the host renderer canvas texture device.");
  };
  requireLabelDevice(options.settings);
  let settings = options.settings;
  let disposed = false;
  let root: TransformNode | null = null;
  let prepared = false;
  let preparation = Promise.resolve();
  let controller: AbortController | null = null;
  let snapshot: { vectors: readonly DebugVector[]; timeSeconds: number } | null = null;
  let withinScheduledFrame = false;
  const requestFrame = (): void => { if (!withinScheduledFrame) options.requestRender?.(); };
  const glyphs = new Map<string, VectorGlyph>();
  const materials: StandardMaterial[] = [];
  const retired: { root: TransformNode; glyphs: VectorGlyph[]; materials: StandardMaterial[] }[] = [];
  const warnings = new Set<string>();

  const warn = (message: string): void => {
    if (warnings.has(message)) return;
    warnings.add(message);
    options.onError?.(message);
  };
  const disposeRetired = (): boolean => {
    let visible = false;
    for (const previous of retired.splice(0)) {
      visible ||= previous.root.isEnabled();
      for (const glyph of previous.glyphs) glyph.texture?.dispose();
      previous.root.dispose();
      for (const material of previous.materials) material.dispose();
    }
    return visible;
  };
  const clearGeometry = (preserveVisible = false): void => {
    const wasVisible = root?.isEnabled() ?? false;
    controller?.abort();
    controller = null;
    if (preserveVisible && wasVisible && root) {
      retired.push({ root, glyphs: [...glyphs.values()], materials: materials.splice(0) });
    } else {
      for (const glyph of glyphs.values()) glyph.texture?.dispose();
      root?.dispose();
      for (const material of materials.splice(0)) material.dispose();
    }
    glyphs.clear();
    root = null;
    prepared = false;
    if (!preserveVisible && (disposeRetired() || wasVisible)) requestFrame();
  };
  const stop = (): void => {
    clearGeometry();
    snapshot = null;
  };

  function material(name: string, color: string): StandardMaterial {
    const result = new StandardMaterial(name, scene);
    result.disableLighting = true;
    result.emissiveColor = Color3.FromHexString(color);
    result.diffuseColor = result.emissiveColor;
    result.specularColor = Color3.Black();
    result.depthFunction = Constants.ALWAYS;
    result.disableDepthWrite = true;
    result.alpha = 0.98;
    result.transparencyMode = Material.MATERIAL_ALPHABLEND;
    result.doNotSerialize = true;
    materials.push(result);
    return result;
  }

  function createGlyph(force: DebugVector): VectorGlyph {
    const node = new TransformNode(`vector-debug/${force.id}`, scene);
    node.parent = root;
    node.rotationQuaternion = Quaternion.Identity();
    node.doNotSerialize = true;
    const color = material(`vector-debug/${force.id}/material`, force.color);
    const shape = shapeOf(force);
    const shaft = shape === "arc"
      ? MeshBuilder.CreateTube(`vector-debug/${force.id}/shaft`, {
        path: Array.from({ length: ARC_POINTS }, (_, index) => {
          const angle = index / (ARC_POINTS - 1) * Math.PI / 2;
          return new Vector3(Math.cos(angle), 0, Math.sin(angle));
        }),
        radius: 0.0225, tessellation: 6, updatable: true,
      }, scene)
      : MeshBuilder.CreateCylinder(`vector-debug/${force.id}/shaft`, { height: 1, diameter: 0.045, tessellation: 6 }, scene);
    const head = MeshBuilder.CreateCylinder(`vector-debug/${force.id}/head`, { height: 1, diameterTop: 0, diameterBottom: 0.22, tessellation: 6 }, scene);
    // An arrow turns its whole glyph; an arc's head turns alone along the arc.
    if (shape === "arc") head.rotationQuaternion = Quaternion.Identity();
    for (const mesh of [shaft, head]) {
      mesh.parent = node;
      mesh.material = color;
      mesh.isPickable = false;
      mesh.doNotSerialize = true;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.alphaIndex = 10003;
      mesh.metadata = { debugVector: { id: force.id, label: force.label } };
    }
    let label: Mesh | null = null;
    let labelAnchor: TransformNode | null = null;
    let texture: DynamicTexture | null = null;
    if (settings.labels) {
      // Babylon billboards discard their parent's orientation while composing
      // a nonzero child offset. An ordinary tip node transforms that offset
      // first; the zero-position billboard then only changes its facing.
      labelAnchor = new TransformNode(`vector-debug/${force.id}/label-anchor`, scene);
      labelAnchor.parent = node;
      labelAnchor.doNotSerialize = true;
      label = MeshBuilder.CreatePlane(`vector-debug/${force.id}/label`, { width: 3.5, height: 0.55 }, scene);
      label.parent = labelAnchor;
      label.billboardMode = Mesh.BILLBOARDMODE_ALL;
      label.isPickable = false;
      label.doNotSerialize = true;
      label.alwaysSelectAsActiveMesh = true;
      label.alphaIndex = 10004;
      label.metadata = { debugVector: { id: force.id, kind: "label" } };
      if (!options.textureDevice) throw new Error("Vector labels require the host renderer canvas texture device.");
      texture = options.textureDevice.createTexture({ name: `vector-debug/${force.id}/text`, width: 512, height: 80, mipmaps: false, samplingMode: Texture.BILINEAR_SAMPLINGMODE });
      texture.hasAlpha = true;
      const labelMaterial = material(`vector-debug/${force.id}/label-material`, "#ffffff");
      labelMaterial.diffuseTexture = texture;
      labelMaterial.emissiveTexture = texture;
      labelMaterial.useAlphaFromDiffuseTexture = true;
      labelMaterial.transparencyMode = Material.MATERIAL_ALPHABLEND;
      labelMaterial.backFaceCulling = false;
      label.material = labelMaterial;
    }
    const glyph = { shape, root: node, shaft, head, label, labelAnchor, texture, key: "", text: "", labelTime: Number.NaN,
      color: force.color, labelText: force.label };
    if (texture) {
      // DynamicTexture becomes ready only after its first upload. Waiting for
      // material readiness before drawing text would wait for that upload
      // forever. Paint the initial label while its complete glyph is hidden.
      const { magnitude, capped } = extent(force);
      paintLabel(glyph, labelText(force, magnitude, capped), force.color);
      // Keep labelTime unset: the atomic reveal must refresh the latest
      // snapshot if observations changed while preparation was pending.
    }
    return glyph;
  }

  function labelText(force: DebugVector, magnitude: number, capped: boolean): string {
    const arc = shapeOf(force) === "arc";
    const scale = arc ? options.arcValueDisplayScale ?? options.valueDisplayScale : options.valueDisplayScale;
    const unit = arc ? options.arcValueUnit ?? options.valueUnit : options.valueUnit;
    return `${force.label}: ${(magnitude * scale).toFixed(1)} ${unit}${capped ? " [capped]" : ""}`;
  }

  function extent(force: DebugVector): GlyphExtent {
    const magnitude = Math.hypot(...force.vector);
    const finite = [...force.vector, ...force.anchor, magnitude].every(Number.isFinite);
    const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
    let limit = 0, unscaled = 0;
    if (shapeOf(force) === "arc") {
      const arcs = settings.arcs;
      if (finite && arcs && positive(arcs.valuePerDegree) && positive(arcs.radiusMeters) && positive(arcs.maxSweepDegrees)) {
        limit = Math.min(arcs.maxSweepDegrees, 360);
        unscaled = magnitude / arcs.valuePerDegree;
      }
    } else if (finite && positive(settings.valuePerMeter) && positive(settings.maxArrowMeters)) {
      limit = settings.maxArrowMeters;
      unscaled = magnitude / settings.valuePerMeter;
    }
    const size = Math.min(unscaled, limit);
    const visible = magnitude > 0 && size > 0;
    return { magnitude, visible, capped: visible && unscaled > limit, size };
  }

  function poseArrow(glyph: VectorGlyph, vector: DebugVector["vector"], magnitude: number, length: number): void {
    const direction = new Vector3(vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude);
    // The helper compares 1 + dot(from,to) with epsilon. Its default
    // .001 treats directions within ~2.56 degrees of down as exactly
    // opposite, erasing real vector components. Limit that fallback to
    // floating-point indistinguishability while retaining exact down.
    Quaternion.FromUnitVectorsToRef(Vector3.Up(), direction, glyph.root.rotationQuaternion!, 4 * Number.EPSILON);
    const headLength = Math.min(HEAD_METERS, length * 0.25);
    glyph.shaft.scaling.y = length - headLength;
    glyph.shaft.position.y = (length - headLength) / 2;
    glyph.head.scaling.y = headLength;
    glyph.head.position.y = length - headLength / 2;
    if (glyph.labelAnchor) glyph.labelAnchor.position.y = length + LABEL_GAP_METERS;
  }

  function poseArc(glyph: VectorGlyph, vector: DebugVector["vector"], magnitude: number, sweepDegrees: number): void {
    const radius = settings.arcs!.radiusMeters;
    const { u, v } = arcBasis(new Vector3(vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude));
    const point = (angle: number, distance = radius): Vector3 =>
      u.scale(distance * Math.cos(angle)).addInPlace(v.scale(distance * Math.sin(angle)));
    const end = sweepDegrees * Math.PI / 180;
    const headLength = Math.min(HEAD_METERS, radius * end * 0.25);
    const tubeEnd = end - headLength / radius;
    const path = Array.from({ length: ARC_POINTS }, (_, index) => point(tubeEnd * index / (ARC_POINTS - 1)));
    // A sweep too small to separate its points has no tube direction to draw.
    const drawable = path.every((next, index) => index === 0 || !next.equals(path[index - 1]));
    glyph.shaft.setEnabled(drawable);
    if (drawable) MeshBuilder.CreateTube(glyph.shaft.name, { path, instance: glyph.shaft });
    const tangent = v.scale(Math.cos(tubeEnd)).subtractInPlace(u.scale(Math.sin(tubeEnd)));
    glyph.head.position.copyFrom(point(tubeEnd).addInPlace(tangent.scale(headLength / 2)));
    Quaternion.FromUnitVectorsToRef(Vector3.Up(), tangent, glyph.head.rotationQuaternion!, 4 * Number.EPSILON);
    glyph.head.scaling.y = headLength;
    if (glyph.labelAnchor) glyph.labelAnchor.position.copyFrom(point(end, radius + LABEL_GAP_METERS));
  }

  function paintLabel(glyph: VectorGlyph, text: string, color: string, styleChanged = false): boolean {
    if (!glyph.texture || text === glyph.text && !styleChanged) return false;
    glyph.text = text;
    const context = glyph.texture.getContext();
    context.font = "bold 28px sans-serif";
    const textWidth = context.measureText(text).width;
    const fontPixels = Math.min(28, Math.floor(28 * 480 / Math.max(1, textWidth)));
    glyph.texture.drawText(text, null, 52, `bold ${fontPixels}px sans-serif`, color, "#101820d9", true, false);
    options.textureDevice!.updateTexture(glyph.texture, true);
    return true;
  }

  function applySnapshot(): void {
    if (!snapshot || !root || !prepared) return;
    let changed = false;
    const seen = new Set<string>();
    for (const force of snapshot.vectors) {
      const glyph = glyphs.get(force.id);
      if (!glyph) continue;
      seen.add(force.id);
      if (glyph.shape === "arc" && !settings.arcs) warn("Arc vectors need arc settings; they stay hidden without them.");
      const { magnitude, visible, capped, size } = extent(force);
      const styleChanged = glyph.color !== force.color || glyph.labelText !== force.label;
      const key = [...force.vector, ...force.anchor, size, visible, force.color, force.label,
        glyph.shape === "arc" ? settings.arcs?.radiusMeters : ""].join("/");
      if (key !== glyph.key) {
        glyph.key = key;
        if (styleChanged) {
          const colorMaterial = glyph.shaft.material as StandardMaterial;
          colorMaterial.emissiveColor.copyFrom(Color3.FromHexString(force.color));
          colorMaterial.diffuseColor.copyFrom(colorMaterial.emissiveColor);
          glyph.color = force.color;
          glyph.labelText = force.label;
          for (const mesh of [glyph.shaft, glyph.head]) mesh.metadata = { debugVector: { id: force.id, label: force.label } };
        }
        glyph.root.setEnabled(visible);
        if (visible) {
          glyph.root.position.set(...force.anchor);
          if (glyph.shape === "arc") poseArc(glyph, force.vector, magnitude, size);
          else poseArrow(glyph, force.vector, magnitude, size);
        }
        glyph.root.metadata = { debugVector: { ...force, magnitude, capped,
          ...(glyph.shape === "arc" ? { sweepDegrees: size } : { arrowMeters: size }) } };
        changed = true;
      }
      const time = snapshot.timeSeconds;
      const hz = settings.labelRefreshHz;
      const due = !Number.isFinite(glyph.labelTime) || time < glyph.labelTime
        || (Number.isFinite(time) && Number.isFinite(hz) && hz > 0 && time - glyph.labelTime >= 1 / hz);
      const text = labelText(force, magnitude, capped);
      if (glyph.texture && visible && (due || styleChanged)) {
        glyph.labelTime = time;
        changed = paintLabel(glyph, text, force.color, styleChanged) || changed;
      }
    }
    for (const [id, glyph] of glyphs) if (!seen.has(id) && glyph.root.isEnabled()) {
      glyph.root.setEnabled(false); glyph.key = ""; changed = true;
    }
    if (changed) requestFrame();
  }

  function createGeometry(): void {
    if (!snapshot) return;
    root = new TransformNode("vector-debug", scene);
    root.parent = parent;
    root.doNotSerialize = true;
    root.setEnabled(false);
    for (const force of snapshot.vectors) glyphs.set(force.id, createGlyph(force));
    controller = new AbortController();
    const signal = controller.signal;
    const meshes = [...glyphs.values()].flatMap(glyph => [glyph.shaft, glyph.head, ...(glyph.label ? [glyph.label] : [])]);
    const prepare = options.whenReady ?? ((next: readonly Mesh[], nextSignal: AbortSignal) => whenMeshesReady(next, { signal: nextSignal }));
    preparation = prepare(meshes, signal).then(() => {
      if (disposed || signal.aborted || !root) return;
      prepared = true;
      const replacedVisible = disposeRetired();
      root.setEnabled(settings.enabled);
      const previous = withinScheduledFrame;
      withinScheduledFrame = true;
      try { applySnapshot(); } finally { withinScheduledFrame = previous; }
      if (replacedVisible || [...glyphs.values()].some(glyph => glyph.root.isEnabled())) requestFrame();
    }).catch(error => {
      if (!disposed && !signal.aborted) warn(`Vector drawing could not prepare: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function update(vectors: readonly DebugVector[], timeSeconds: number, alreadyScheduled = false): void {
    if (disposed || !settings.enabled) return;
    const previous = withinScheduledFrame;
    withinScheduledFrame = alreadyScheduled;
    try {
      snapshot = { vectors, timeSeconds };
      if (!root) createGeometry();
      else if (vectors.some(vector => glyphs.get(vector.id)?.shape !== shapeOf(vector))) { clearGeometry(true); createGeometry(); }
      applySnapshot();
    } finally { withinScheduledFrame = previous; }
  }

  return {
    get ready(): Promise<void> { return preparation; },
    update,
    setSettings(next: VectorDebugDrawingSettings): void {
      if (disposed) return;
      requireLabelDevice(next);
      const rebuildLabels = next.labels !== settings.labels;
      settings = next;
      if (!settings.enabled) { stop(); return; }
      if (rebuildLabels) clearGeometry(true);
      update(snapshot?.vectors ?? [], snapshot?.timeSeconds ?? 0);
    },
    dispose(): void { if (!disposed) { disposed = true; stop(); } },
  };
}
