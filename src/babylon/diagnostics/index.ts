/**
 * Generic diagnostics over a supplied Babylon scene. This optional entry loads
 * Babylon definitions; it creates no device, scene, frame queue or host registry.
 */
export {
  createMeshInspector, type MeshInspector, type MeshInspectorHandle, type MeshInspectorNode, type MeshInspectorOptions, type MeshInspectorSnapshot,
} from "./createMeshInspector.js";
export {
  createVectorDebugDrawing, type ArcDebugDrawingSettings, type DebugVector, type VectorDebugDrawingOptions,
  type VectorDebugDrawingSettings,
} from "./createVectorDebugDrawing.js";

export * from "./metrics.js";
