import { MAX_FILE, UnsupportedProfile, profile, workerOnly } from "./profile.js";

/** Retained byte-exact reference for an equal-worker comparison. */
export function createTypeScriptGoogleCore() {
  workerOnly();
  return {
    actualTier: "typescript", validationStatus: "unvalidated",
    decodeGlb(data) {
      if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) throw new TypeError("Google tile must be an ArrayBuffer or Uint8Array");
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bytes.byteLength < 28 || bytes.byteLength > MAX_FILE || !(bytes.buffer instanceof ArrayBuffer)) throw new Error("Google tile exceeds its file bounds");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const unsupported = reason => ({ supported: false, reason });
      if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) return unsupported("GLB envelope");
      const jsonSize = view.getUint32(12, true), binStart = 28 + jsonSize;
      if (jsonSize % 4 || binStart > bytes.length || view.getUint32(16, true) !== 0x4e4f534a || view.getUint32(binStart - 4, true) !== 0x004e4942) return unsupported("GLB envelope");
      const binSize = view.getUint32(binStart - 8, true);
      if (binSize % 4 || binStart + binSize !== bytes.length) return unsupported("GLB envelope");
      let metadata, selected;
      try {
        metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, 20 + jsonSize)));
        selected = profile(metadata, binSize);
      } catch (error) {
        if (error instanceof UnsupportedProfile || error instanceof SyntaxError || error instanceof TypeError) return unsupported(error.message);
        throw error;
      }
      function decode(accessor, floating) {
        const words = new Uint32Array(accessor.count * accessor.components);
        for (let i = 0; i < accessor.count; i++) for (let c = 0; c < accessor.components; c++) {
          const offset = binStart + accessor.offset + i * accessor.stride + c * (accessor.component === 5126 ? 4 : accessor.component === 5123 ? 2 : 1);
          words[i * accessor.components + c] = accessor.component === 5126 ? view.getUint32(offset, true) : accessor.component === 5123 ? view.getUint16(offset, true) : view.getUint8(offset);
        }
        return floating ? new Float32Array(words.buffer) : words;
      }
      const primitives = selected.primitives.map(primitive => {
        const positions = decode(primitive.positions, true), uvs = decode(primitive.uvs, true), indices = decode(primitive.indices, false);
        for (const value of indices) if (value >= primitive.positions.count) throw new Error("Google tile index exceeds its position accessor");
        return { positions, uvs, indices, sourceIndexComponentType: primitive.indices.component, materialIndex: primitive.material,
          jpeg: bytes.slice(binStart + primitive.image.offset, binStart + primitive.image.offset + primitive.image.length), sampler: primitive.sampler };
      });
      return { supported: true, actualTier: "typescript", validationStatus: "unvalidated", metadata, matrix: Float64Array.from(selected.node.matrix), nodeName: selected.node.name, meshName: metadata.meshes[0].name, primitives };
    },
  };
}
