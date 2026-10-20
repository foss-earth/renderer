import { MAX_FILE, UnsupportedProfile, profile, workerOnly } from "../google-TS/profile.js";

const MAX_MEMORY = 256 * 1024 * 1024;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Lazy, explicit loading. The original loader remains the host's fallback. */
export async function loadGoogleCore({ wasmUrl = new URL("./single/google.wasm", import.meta.url), fetch: fetchBytes = globalThis.fetch } = {}) {
  workerOnly();
  const response = await fetchBytes(wasmUrl);
  if (!response.ok) throw new Error(`Google WASM request failed (${response.status})`);
  return instantiateGoogleCore(await response.arrayBuffer());
}
export async function instantiateGoogleCore(bytes) {
  workerOnly(); const result = await WebAssembly.instantiate(bytes, {});
  return createGoogleCore((result.instance ?? result).exports);
}

export function createGoogleCore(exports) {
  workerOnly();
  for (const name of ["google_abi_version", "google_alloc", "google_free", "google_validate_glb", "google_decode_accessor"]) if (typeof exports?.[name] !== "function") throw new Error(`Invalid Google core ABI: ${name}`);
  if (!(exports.memory instanceof WebAssembly.Memory) || exports.google_abi_version() !== 1) throw new Error("Unsupported Google core ABI");
  function memory() { const buffer = exports.memory.buffer; if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_MEMORY || !buffer.byteLength) throw new Error("Invalid Google core memory"); return buffer; }
  function span(pointer, bytes, alignment) {
    if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer > 0xffff_ffff || pointer % alignment || pointer > memory().byteLength || bytes > memory().byteLength - pointer) throw new Error("Invalid Google core allocation");
  }
  function allocation(kind, length) { const ptr = exports.google_alloc(kind, length); if (!ptr) throw new Error("Google core allocation limit"); return ptr; }
  function release(kind, ptr, length) { if (exports.google_free(kind, ptr, length) !== 0) throw new Error("Google core release failed"); }
  memory();
  return {
    actualTier: "single", validationStatus: "unvalidated",
    decodeGlb(data) {
      if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) throw new TypeError("Google tile must be an ArrayBuffer or Uint8Array");
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bytes.byteLength < 28 || bytes.byteLength > MAX_FILE || !(bytes.buffer instanceof ArrayBuffer)) throw new Error("Google tile exceeds its file bounds");
      const input = allocation(0, bytes.length);
      try {
        span(input, bytes.length, 1); new Uint8Array(memory(), input, bytes.length).set(bytes);
        const status = exports.google_validate_glb(input, bytes.length);
        if (status !== 0) return { supported: false, reason: `GLB envelope (${status})` };
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const jsonSize = view.getUint32(12, true), binStart = 20 + jsonSize + 8, binSize = view.getUint32(binStart - 8, true);
        let metadata, selected;
        try {
          metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, 20 + jsonSize)));
          selected = profile(metadata, binSize);
        } catch (error) {
          if (error instanceof UnsupportedProfile || error instanceof SyntaxError || error instanceof TypeError) return { supported: false, reason: error.message };
          throw error;
        }
        function decode(accessor, floating) {
          const length = accessor.count * accessor.components, output = allocation(1, length);
          try {
            span(output, length * 4, 4); span(input, bytes.length, 1);
            if (input < output + length * 4 && output < input + bytes.length) throw new Error("Overlapping Google core allocations");
            const status = exports.google_decode_accessor(input, bytes.length, binStart + accessor.offset, accessor.count, accessor.stride, accessor.component, accessor.components, output, length);
            if (status !== 0) throw new Error(`Google accessor decode failed (${status})`);
            span(output, length * 4, 4);
            const words = new Uint32Array(length), buffer = memory();
            if (LITTLE_ENDIAN) words.set(new Uint32Array(buffer, output, length));
            else { const values = new DataView(buffer, output, length * 4); for (let i = 0; i < length; i++) words[i] = values.getUint32(i * 4, true); }
            return floating ? new Float32Array(words.buffer) : words;
          } finally { release(1, output, length); }
        }
        const primitives = selected.primitives.map(primitive => {
          const positions = decode(primitive.positions, true), uvs = decode(primitive.uvs, true), indices = decode(primitive.indices, false);
          for (const value of indices) if (value >= primitive.positions.count) throw new Error("Google tile index exceeds its position accessor");
          return { positions, uvs, indices, sourceIndexComponentType: primitive.indices.component, materialIndex: primitive.material,
            jpeg: bytes.slice(binStart + primitive.image.offset, binStart + primitive.image.offset + primitive.image.length), sampler: primitive.sampler };
        });
        return { supported: true, actualTier: "single", validationStatus: "unvalidated", metadata, matrix: Float64Array.from(selected.node.matrix), nodeName: selected.node.name, meshName: metadata.meshes[0].name, primitives };
      } finally { release(0, input, bytes.length); }
    },
  };
}
