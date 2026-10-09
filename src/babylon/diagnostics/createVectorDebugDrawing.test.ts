import { FreeCamera, Mesh, NullEngine, Quaternion, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanvasTextureDevicePorts } from "../canvasTextureDevice.js";
import { createVectorDebugDrawing, type DebugVector } from "./createVectorDebugDrawing.js";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const settings = { enabled: true, valuePerMeter: 1000, maxArrowMeters: 3, labels: false, labelRefreshHz: 5 };
const vector: DebugVector = { id: "sample", label: "Observed vector", color: "#ffcc00", vector: [0, 5000, 0], anchor: [1, 2, 3] };

function fixture(overrides: Partial<Parameters<typeof createVectorDebugDrawing>[2]> = {}) {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine);
  const parent = new TransformNode("parent", scene);
  const requestRender = vi.fn();
  const drawing = createVectorDebugDrawing(scene, parent, {
    settings, valueDisplayScale: 0.001, valueUnit: "kN", requestRender,
    textureDevice: createCanvasTextureDevicePorts({ scene,
      createCanvas: (width, height) => new OffscreenCanvas(width, height),
      transfer: (_bytes, _label, submit) => submit(),
    }),
    whenReady: async () => {}, ...overrides,
  });
  const node = () => scene.getTransformNodeByName("vector-debug/sample")!;
  return { scene, parent, requestRender, drawing, node };
}

function mockCanvas() {
  const fillText = vi.fn();
  const context = { font: "", fillStyle: "", clearRect: vi.fn(), fillRect: vi.fn(), fillText,
    measureText: vi.fn(() => ({ width: 200 })) };
  class Canvas {
    width: number; height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext() { return context; }
  }
  vi.stubGlobal("OffscreenCanvas", Canvas);
  return fillText;
}

describe("shared world vector drawing", () => {
  it.each([
    ["near down", [0.000196, -5000, -183.72017] as const],
    ["very near down", [0.001, -5000, 0.003] as const],
    ["exactly down", [0, -5000, 0] as const],
  ])("preserves the observed %s direction in actual arrow geometry without an antiparallel snap", async (_name, components) => {
    const t = fixture();
    t.drawing.update([{ ...vector, vector: components }], 1); await t.drawing.ready;
    const direction = Vector3.FromArray(components).normalize();
    const actualDirection = Vector3.TransformNormal(Vector3.Up(), t.node().computeWorldMatrix(true)).normalize();
    expect(Vector3.Distance(actualDirection, direction)).toBeLessThan(1e-8);
    expect(t.node().rotationQuaternion!.asArray().every(Number.isFinite)).toBe(true);
    const head = t.scene.getMeshByName("vector-debug/sample/head")!;
    const tip = Vector3.TransformCoordinates(new Vector3(0, 0.5, 0), head.computeWorldMatrix(true));
    const expected = Vector3.FromArray(vector.anchor).add(direction.scale(settings.maxArrowMeters));
    expect(Vector3.Distance(tip, expected)).toBeLessThan(1e-6);
    t.drawing.dispose();
  });
  it("keeps camera-facing labels at downward/lateral vector tips through parent rotation, scale and rebasing", async () => {
    mockCanvas();
    const t = fixture({ settings: { ...settings, labels: true } });
    t.scene.useRightHandedSystem = true;
    const camera = new FreeCamera("camera", new Vector3(40, 30, 50), t.scene);
    t.scene.activeCamera = camera;
    camera.setTarget(new Vector3(10, 20, 30)); camera.getViewMatrix();
    t.parent.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.8, 0.3, -0.4);
    t.parent.scaling.set(1.7, 0.8, 1.2);
    t.parent.position.set(10, 20, 30);
    const vectors: DebugVector[] = [
      { ...vector, id: "down", vector: [0, -5000, 0] },
      { ...vector, id: "near-down", vector: [0.000196, -5000, -183.72017] },
      { ...vector, id: "lateral", vector: [-1500, 0, 0], anchor: [-2, 1, 0.5] },
    ];
    t.drawing.update(vectors, 1); await t.drawing.ready;
    const assertTips = (): void => {
      const parentWorld = t.parent.computeWorldMatrix(true);
      for (const force of vectors) {
        const label = t.scene.getMeshByName(`vector-debug/${force.id}/label`)!;
        const length = Math.min(Math.hypot(...force.vector) / settings.valuePerMeter, settings.maxArrowMeters);
        const direction = Vector3.FromArray(force.vector).normalize();
        const tip = Vector3.FromArray(force.anchor).add(direction.scale(length + 0.35));
        const expected = Vector3.TransformCoordinates(tip, parentWorld);
        const world = label.computeWorldMatrix(true);
        // Hierarchical render matrices are Float32 at these ~300 m scene
        // offsets. Keep the assertion below 0.1 mm, without demanding more
        // precision than the matrix representation can supply.
        expect(Vector3.Distance(label.getAbsolutePosition(), expected)).toBeLessThan(1e-4);
        expect(label.position.equals(Vector3.Zero())).toBe(true);
        const normal = Vector3.TransformNormal(Vector3.Forward(), world).normalize();
        const cameraNormal = Vector3.TransformNormal(Vector3.Forward(), camera.getWorldMatrix()).normalize();
        expect(Math.abs(Vector3.Dot(normal, cameraNormal))).toBeCloseTo(1, 5);
      }
    };
    assertTips();
    // Neither rebasing nor steering the camera while native time is held
    // should detach the label from its real parent-transformed vector tip.
    t.parent.position.set(-300, 150, -80);
    camera.position.set(-260, 190, -40); camera.setTarget(t.parent.position); camera.getViewMatrix();
    t.drawing.update(vectors, 1);
    assertTips();
    t.drawing.dispose();
  });
  it("uploads initial label pixels while hidden before waiting for texture/material readiness", async () => {
    const fillText = mockCanvas();
    let release!: () => void;
    const whenReady = vi.fn((meshes: readonly Mesh[]) => {
      expect(meshes.every(mesh => !mesh.isEnabled())).toBe(true);
      const label = meshes.find(mesh => mesh.name.endsWith("/label"))!;
      const texture = (label.material as StandardMaterial).diffuseTexture!;
      expect(texture.isReady()).toBe(true);
      expect(fillText.mock.calls.at(-1)![0]).toBe("Observed vector: 5.0 kN [capped]");
      return new Promise<void>(resolve => { release = resolve; });
    });
    const t = fixture({ settings: { ...settings, labels: true }, whenReady });
    // NullEngine does not upload pixels or mark dynamic textures ready.
    // Model the real GPU upload contract, so readiness is contingent on the
    // renderer issuing that upload before calling its wait function.
    const upload = vi.spyOn(t.scene.getEngine(), "updateDynamicTexture").mockImplementation(texture => {
      if (texture) texture.isReady = true;
    });
    t.drawing.update([vector], 1);
    expect(upload).toHaveBeenCalledOnce();
    expect(whenReady).toHaveBeenCalledOnce();
    expect(t.requestRender).not.toHaveBeenCalled();
    // Preparation can span changed observations. The first visible label
    // must match the latest snapshot, even inside the normal refresh interval.
    t.drawing.update([{ ...vector, vector: [0, 6000, 0] }], 1.1);
    release(); await t.drawing.ready;
    expect(fillText.mock.calls.at(-1)![0]).toBe("Observed vector: 6.0 kN [capped]");
    expect(t.node().isEnabled()).toBe(true);
    expect(t.requestRender).toHaveBeenCalledOnce();
    t.drawing.dispose();
  });
  it("prepares hidden, then reveals actual magnitude with a bounded arrow and local anchor", async () => {
    let release!: () => void;
    const t = fixture({ whenReady: () => new Promise<void>(resolve => { release = resolve; }) });
    expect(t.scene.meshes).toHaveLength(0);
    t.drawing.update([vector], 0);
    expect(t.scene.meshes).toHaveLength(2);
    expect(t.scene.meshes.every(mesh => !mesh.isEnabled())).toBe(true);
    expect(t.requestRender).not.toHaveBeenCalled();
    release(); await t.drawing.ready;
    expect(t.scene.meshes.every(mesh => mesh.isEnabled())).toBe(true);
    expect(t.node().position.asArray()).toEqual([1, 2, 3]);
    expect(t.node().metadata.debugVector).toMatchObject({ magnitude: 5000, arrowMeters: 3, capped: true });
    expect(t.requestRender).toHaveBeenCalledOnce();
    t.drawing.dispose();
  });

  it("follows parent rotation and rebasing while directing the arrow along its actual local vector", async () => {
    const t = fixture();
    t.parent.position.set(10, 20, 30);
    t.parent.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2);
    t.drawing.update([{ ...vector, vector: [0, 0, 1000] }], 1); await t.drawing.ready;
    t.node().computeWorldMatrix(true);
    const origin = t.node().getAbsolutePosition();
    expect(origin.x).toBeCloseTo(13, 5); expect(origin.y).toBeCloseTo(22, 5); expect(origin.z).toBeCloseTo(29, 5);
    const worldDirection = Vector3.TransformNormal(Vector3.Up(), t.node().getWorldMatrix()).normalize();
    expect(worldDirection.x).toBeCloseTo(1, 5); expect(worldDirection.y).toBeCloseTo(0, 5); expect(worldDirection.z).toBeCloseTo(0, 5);
    t.parent.position.subtractInPlace(new Vector3(10, 20, 30));
    t.node().computeWorldMatrix(true);
    expect(t.node().getAbsolutePosition().x).toBeCloseTo(3, 5);
    t.drawing.dispose();
  });

  it("requests no paused or duplicate scheduled frames and redraws explicit setting changes", async () => {
    const t = fixture();
    t.drawing.update([vector], 42, true); await t.drawing.ready;
    expect(t.requestRender).toHaveBeenCalledOnce(); // Asynchronous readiness needs its own frame.
    t.requestRender.mockClear();
    t.drawing.update([vector], 42); t.drawing.update([vector], 42);
    expect(t.requestRender).not.toHaveBeenCalled();
    const changed = { ...vector, vector: [0, 0, 1000] as const };
    t.drawing.update([changed], 43, true);
    expect(t.requestRender).not.toHaveBeenCalled();
    t.drawing.setSettings({ ...settings, valuePerMeter: 2000 });
    expect(t.node().metadata.debugVector.arrowMeters).toBe(0.5);
    expect(t.requestRender).toHaveBeenCalledOnce();
    t.drawing.dispose();
  });

  it("hides missing, zero, and nonfinite vectors and updates color/label at paused time", async () => {
    const t = fixture();
    t.drawing.update([vector], 1); await t.drawing.ready;
    t.drawing.update([{ ...vector, label: "Changed", color: "#00ff00" }], 1);
    const material = t.scene.getMeshByName("vector-debug/sample/shaft")!.material as StandardMaterial;
    expect(material.emissiveColor.asArray()).toEqual([0, 1, 0]);
    expect(t.node().metadata.debugVector.label).toBe("Changed");
    for (const next of [[], [{ ...vector, vector: [0, 0, 0] as const }], [{ ...vector, anchor: [Number.NaN, 0, 0] as const }]]) {
      t.drawing.update(next, 1);
      expect(t.node().isEnabled()).toBe(false);
      expect(t.node().position.asArray().every(Number.isFinite)).toBe(true);
    }
    t.drawing.dispose();
  });

  it("releases resources when disabled and cancels late readiness without resurrecting geometry", async () => {
    let release!: () => void;
    let signal!: AbortSignal;
    const t = fixture({ whenReady: (_meshes, nextSignal) => {
      signal = nextSignal;
      return new Promise<void>(resolve => { release = resolve; });
    } });
    t.drawing.update([vector], 0);
    const pending = t.drawing.ready;
    t.drawing.setSettings({ ...settings, enabled: false });
    expect(signal.aborted).toBe(true);
    expect(t.scene.meshes).toHaveLength(0); expect(t.scene.materials).toHaveLength(0);
    release(); await pending;
    expect(t.scene.meshes).toHaveLength(0); expect(t.requestRender).not.toHaveBeenCalled();
    t.drawing.dispose(); t.drawing.dispose();
  });

  it("keeps existing glyphs visible until their complete replacement is ready", async () => {
    const releases: (() => void)[] = [];
    const t = fixture({ whenReady: () => new Promise<void>(resolve => releases.push(resolve)) });
    t.drawing.update([vector], 0); releases[0](); await t.drawing.ready;
    const previous = t.node();
    t.requestRender.mockClear();
    t.drawing.update([vector, { ...vector, id: "second" }], 1);
    expect(previous.isEnabled()).toBe(true);
    expect(previous.isDisposed()).toBe(false);
    expect(t.scene.getTransformNodeByName("vector-debug/second")!.isEnabled()).toBe(false);
    expect(t.requestRender).not.toHaveBeenCalled();
    releases[1](); await t.drawing.ready;
    expect(previous.isDisposed()).toBe(true);
    expect(t.scene.getTransformNodeByName("vector-debug/second")!.isEnabled()).toBe(true);
    expect(t.scene.meshes).toHaveLength(4);
    expect(t.scene.materials).toHaveLength(2);
    expect(t.requestRender).toHaveBeenCalledOnce();
    t.drawing.dispose(); expect(t.scene.meshes).toHaveLength(0); expect(t.scene.materials).toHaveLength(0);
  });

  describe("arcs", () => {
    const arcs = { valuePerDegree: 100, radiusMeters: 2, maxSweepDegrees: 300 };
    const moment: DebugVector = { ...vector, label: "Moment", shape: "arc", vector: [0, 0, 9000] };
    const arcFixture = (overrides: Partial<Parameters<typeof createVectorDebugDrawing>[2]> = {}) => fixture({
      settings: { ...settings, arcs }, arcValueDisplayScale: 0.001, arcValueUnit: "kN·m", ...overrides,
    });
    const headTip = (scene: Scene) => {
      const head = scene.getMeshByName("vector-debug/sample/head")!;
      return Vector3.TransformCoordinates(new Vector3(0, 0.5, 0), head.computeWorldMatrix(true));
    };

    it.each([
      ["sweeps by the right-hand rule about its axis", [0, 0, 9000] as const, [-2, 0, 0]],
      ["reverses its sense, not its start, for the opposite rotation", [0, 0, -9000] as const, [2, 0, 0]],
      ["starts from forward when its axis is near up", [0, 9000, 0] as const, [2, 0, 0]],
    ])("%s", async (_name, components, tipOffset) => {
      const t = arcFixture();
      t.drawing.update([{ ...moment, vector: components }], 1); await t.drawing.ready;
      expect(t.node().metadata.debugVector).toMatchObject({ magnitude: 9000, sweepDegrees: 90, capped: false });
      const anchor = Vector3.FromArray(moment.anchor);
      // The arrowhead ends a quarter turn from the start, on the circle the radius sets.
      expect(Vector3.Distance(headTip(t.scene), anchor.add(Vector3.FromArray(tipOffset)))).toBeLessThan(0.05);
      const axis = Vector3.FromArray(components).normalize();
      const shaft = t.scene.getMeshByName("vector-debug/sample/shaft")!;
      const positions = shaft.getVerticesData("position")!;
      for (let index = 0; index < positions.length; index += 3) {
        const offset = Vector3.FromArray(positions, index);
        const along = Vector3.Dot(offset, axis);
        expect(Math.abs(along)).toBeLessThan(0.0226);
        expect(Math.abs(offset.subtract(axis.scale(along)).length() - arcs.radiusMeters)).toBeLessThan(0.0226);
      }
      t.drawing.dispose();
    });

    it("caps the sweep, keeps the full magnitude in its own unit, and follows a new radius", async () => {
      const fillText = mockCanvas();
      const t = arcFixture({ settings: { ...settings, labels: true, arcs } });
      t.drawing.update([{ ...moment, vector: [0, 0, 50000] }], 1); await t.drawing.ready;
      expect(t.node().metadata.debugVector).toMatchObject({ sweepDegrees: 300, capped: true });
      expect(fillText.mock.calls.at(-1)![0]).toBe("Moment: 50.0 kN·m [capped]");
      const label = t.scene.getTransformNodeByName("vector-debug/sample/label-anchor")!;
      expect(label.position.length()).toBeCloseTo(arcs.radiusMeters + 0.35, 6);
      t.requestRender.mockClear();
      t.drawing.setSettings({ ...settings, labels: true, arcs: { ...arcs, radiusMeters: 4 } });
      expect(label.position.length()).toBeCloseTo(4.35, 6);
      expect(t.requestRender).toHaveBeenCalledOnce();
      t.drawing.dispose();
    });

    it("hides arcs without arc settings and says so once", async () => {
      const onError = vi.fn();
      const t = fixture({ onError });
      t.drawing.update([moment], 1); await t.drawing.ready;
      t.drawing.update([moment], 2);
      expect(t.node().isEnabled()).toBe(false);
      expect(onError).toHaveBeenCalledOnce();
      t.drawing.dispose();
    });

    it("rebuilds a glyph whose shape changes, keeping arrows and arcs in one drawing", async () => {
      const t = arcFixture();
      t.drawing.update([vector, { ...moment, id: "moment" }], 1); await t.drawing.ready;
      expect(t.scene.getMeshByName("vector-debug/moment/shaft")!.getTotalVertices()).toBeGreaterThan(
        t.scene.getMeshByName("vector-debug/sample/shaft")!.getTotalVertices());
      t.drawing.update([{ ...vector, shape: "arc" }, { ...moment, id: "moment" }], 2); await t.drawing.ready;
      expect(t.node().metadata.debugVector).toMatchObject({ sweepDegrees: 50 });
      t.drawing.dispose();
    });
  });

  it("keeps labels in real units and refreshes changed values only on the supplied clock", async () => {
    const fillText = mockCanvas();
    const t = fixture({ settings: { ...settings, labels: true } });
    t.drawing.update([vector], 1); await t.drawing.ready;
    expect(t.scene.getMeshByName("vector-debug/sample/label")!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(fillText.mock.calls.at(-1)![0]).toBe("Observed vector: 5.0 kN [capped]");
    fillText.mockClear();
    t.drawing.update([{ ...vector, vector: [0, 6000, 0] }], 1.1);
    expect(fillText).not.toHaveBeenCalled();
    t.drawing.update([{ ...vector, vector: [0, 6000, 0] }], 1.21);
    expect(fillText.mock.calls.at(-1)![0]).toBe("Observed vector: 6.0 kN [capped]");
    fillText.mockClear();
    t.drawing.update([{ ...vector, vector: [0, 7000, 0] }], 1.21);
    expect(fillText).not.toHaveBeenCalled();
    t.drawing.update([{ ...vector, vector: [0, 7000, 0] }], 0); // Native reset moves the supplied clock backwards.
    expect(fillText.mock.calls.at(-1)![0]).toBe("Observed vector: 7.0 kN [capped]");
    t.drawing.dispose(); expect(t.scene.textures).toHaveLength(0);
  });
});
