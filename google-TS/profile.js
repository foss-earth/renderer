// The Google tile profile both twins accept: file and accessor bounds, the
// glTF subset checked before any geometry is decoded, and the worker guard.
export const MAX_FILE = 64 * 1024 * 1024;
const MAX_ELEMENTS = 4_194_304;
export class UnsupportedProfile extends Error {}
const requireProfile = (condition, message) => { if (!condition) throw new UnsupportedProfile(message); };
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
export function workerOnly() { if (typeof document !== "undefined") throw new Error("Google geometry preparation must run in a worker"); }

export function profile(json, binBytes) {
  requireProfile(json && json.asset?.version === "2.0", "glTF version");
  for (const field of ["extensionsRequired", "extensionsUsed"]) requireProfile(json[field] === undefined || Array.isArray(json[field]) && json[field].every(value => value === "KHR_materials_unlit"), "extensions");
  requireProfile(!json.animations?.length && !json.skins?.length && !json.cameras?.length && !json.extensions, "animated or extended scene");
  requireProfile(Array.isArray(json.scenes) && json.scenes.length === 1 && (json.scene === undefined || json.scene === 0), "scene count");
  requireProfile(Array.isArray(json.nodes) && json.nodes.length === 1 && Array.isArray(json.scenes[0].nodes) && json.scenes[0].nodes.length === 1 && json.scenes[0].nodes[0] === 0, "node hierarchy");
  const node = json.nodes[0];
  requireProfile(Array.isArray(node.matrix) && node.matrix.length === 16 && node.matrix.every(Number.isFinite)
    && !node.translation && !node.rotation && !node.scale && !node.children?.length && node.skin === undefined && !node.extensions, "node matrix");
  requireProfile(Array.isArray(json.meshes) && json.meshes.length === 1 && node.mesh === 0 && !json.meshes[0].weights, "mesh count");
  requireProfile(Array.isArray(json.meshes[0].primitives) && json.meshes[0].primitives.length >= 1 && json.meshes[0].primitives.length <= 2, "primitive count");
  requireProfile(Array.isArray(json.buffers) && json.buffers.length === 1 && !json.buffers[0].uri && integer(json.buffers[0].byteLength)
    && json.buffers[0].byteLength <= binBytes && binBytes - json.buffers[0].byteLength <= 3, "embedded buffer");
  const viewAt = index => {
    requireProfile(integer(index), "bufferView index");
    const view = json.bufferViews?.[index];
    requireProfile(view && view.buffer === 0 && !view.extensions && integer(view.byteOffset ?? 0) && integer(view.byteLength)
      && (view.byteOffset ?? 0) + view.byteLength <= json.buffers[0].byteLength, "bufferView range");
    return view;
  };
  function accessorAt(index, type, components, allowed) {
    requireProfile(integer(index), "accessor index");
    const accessor = json.accessors?.[index];
    requireProfile(accessor && !accessor.sparse && !accessor.extensions && !accessor.normalized && accessor.type === type
      && allowed.includes(accessor.componentType) && integer(accessor.count) && accessor.count > 0 && accessor.count <= MAX_ELEMENTS
      && integer(accessor.byteOffset ?? 0), "accessor format");
    const view = viewAt(accessor.bufferView), width = accessor.componentType === 5126 ? 4 : accessor.componentType === 5123 ? 2 : 1;
    const packed = components * width, stride = view.byteStride ?? packed, offset = accessor.byteOffset ?? 0;
    requireProfile(integer(stride) && stride >= packed && stride <= 252 && stride % width === 0 && offset % width === 0
      && (view.byteOffset ?? 0) % width === 0 && offset + (accessor.count - 1) * stride + packed <= view.byteLength, "accessor range");
    return { offset: (view.byteOffset ?? 0) + offset, count: accessor.count, stride, component: accessor.componentType, components };
  }
  const primitives = json.meshes[0].primitives.map(primitive => {
    requireProfile((primitive.mode === undefined || primitive.mode === 4) && !primitive.targets && !primitive.extensions, "primitive mode or extension");
    const names = Object.keys(primitive.attributes ?? {}).sort();
    requireProfile(names.length === 2 && names[0] === "POSITION" && names[1] === "TEXCOORD_0", "vertex attributes");
    const positions = accessorAt(primitive.attributes.POSITION, "VEC3", 3, [5126]);
    const uvs = accessorAt(primitive.attributes.TEXCOORD_0, "VEC2", 2, [5126]);
    const indices = accessorAt(primitive.indices, "SCALAR", 1, [5121, 5123]);
    requireProfile(positions.count === uvs.count && indices.count % 3 === 0, "triangle dimensions");
    requireProfile(integer(primitive.material), "material index");
    const material = json.materials?.[primitive.material];
    requireProfile(material && material.extensions?.KHR_materials_unlit && Object.keys(material.extensions).every(name => name === "KHR_materials_unlit"), "unlit material");
    const info = material.pbrMetallicRoughness?.baseColorTexture;
    requireProfile(info && integer(info.index) && (info.texCoord === undefined || info.texCoord === 0) && !info.extensions, "base colour texture");
    const texture = json.textures?.[info.index];
    requireProfile(texture && !texture.extensions && integer(texture.source), "texture source");
    const image = json.images?.[texture.source];
    requireProfile(image && image.mimeType === "image/jpeg" && !image.uri && !image.extensions, "JPEG image");
    const imageView = viewAt(image.bufferView);
    requireProfile(imageView.byteStride === undefined && imageView.byteLength > 0, "JPEG bufferView");
    const sampler = texture.sampler === undefined ? undefined : json.samplers?.[texture.sampler];
    requireProfile(texture.sampler === undefined || integer(texture.sampler) && sampler && !sampler.extensions, "sampler");
    return { positions, uvs, indices, material: primitive.material, image: { offset: imageView.byteOffset ?? 0, length: imageView.byteLength }, sampler };
  });
  return { node, primitives };
}
