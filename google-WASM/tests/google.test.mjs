import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTypeScriptGoogleCore } from '../../google-TS/index.js';
import { instantiateGoogleCore } from '../index.js';
import { createGoogleWorkerKernel } from '../worker.js';

function fixture({ indexComponent = 5121, primitiveCount = 1, mutate = () => {} } = {}) {
  const jpeg = Uint8Array.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]);
  const bin = new Uint8Array(96), view = new DataView(bin.buffer);
  const values = [0,-0,2,.25,.5, 1,0,2,.75,.5, 0,1,2,.25,1];
  values.forEach((value, i) => view.setFloat32(i * 4, value, true));
  for (let i = 0; i < 3; i++) {
    if (indexComponent === 5121) view.setUint8(60 + i, i);
    else view.setUint16(60 + i * 2, i, true);
  }
  bin.set(jpeg, 68);
  const primitive = { attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 };
  const json = { asset: { version: '2.0', copyright: 'Synthetic fixture only' }, extensionsUsed: ['KHR_materials_unlit'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'fixture', matrix: [1,0,0,0,0,1,0,0,0,0,1,0,4,5,6,1] }],
    meshes: [{ primitives: Array.from({length:primitiveCount}, () => structuredClone(primitive)) }],
    buffers: [{byteLength:96}], bufferViews: [{ buffer:0, byteOffset:0, byteLength:60, byteStride:20 },
      {buffer:0, byteOffset:60, byteLength:indexComponent === 5121 ? 3 : 6 }, {buffer:0, byteOffset:68, byteLength:jpeg.length}],
    accessors: [{bufferView:0, byteOffset:0, componentType:5126, count:3, type:'VEC3'},
      {bufferView:0, byteOffset:12, componentType:5126, count:3, type:'VEC2'},
      {bufferView:1, componentType:indexComponent, count:3, type:'SCALAR'}],
    materials:[{extensions:{KHR_materials_unlit:{}},pbrMetallicRoughness:{baseColorTexture:{index:0}}}],
    textures:[{source:0}], images:[{bufferView:2,mimeType:'image/jpeg'}] };
  mutate(json);
  let text = JSON.stringify(json); text += ' '.repeat((4 - text.length % 4) % 4);
  const encoded = new TextEncoder().encode(text), bytes = new Uint8Array(28 + encoded.length + bin.length), glb = new DataView(bytes.buffer);
  [0x46546c67,2,bytes.length,encoded.length,0x4e4f534a].forEach((value,i)=>glb.setUint32(i*4,value,true));
  bytes.set(encoded,20); glb.setUint32(20+encoded.length,bin.length,true); glb.setUint32(24+encoded.length,0x004e4942,true); bytes.set(bin,28+encoded.length);
  return bytes;
}
const wasm = await instantiateGoogleCore(await readFile(new URL('../single/google.wasm',import.meta.url)));
const reference = createTypeScriptGoogleCore();
test('actual WASM agrees with equal-worker reference for interleaved data and index widths', () => {
  for (const indexComponent of [5121,5123]) for (const primitiveCount of [1,2]) {
    const bytes = fixture({indexComponent,primitiveCount}), expected=reference.decodeGlb(bytes), actual=wasm.decodeGlb(bytes);
    assert.equal(actual.supported,true); assert.equal(expected.supported,true);
    assert.deepEqual(actual.metadata,expected.metadata); assert.deepEqual(actual.matrix,expected.matrix);
    for(let i=0;i<primitiveCount;i++) for(const key of ['positions','uvs','indices','jpeg']) assert.deepEqual(new Uint8Array(actual.primitives[i][key].buffer),new Uint8Array(expected.primitives[i][key].buffer));
  }
});
test('unsupported hierarchy is explicit in both backends', () => {
  const bytes=fixture({mutate(json){json.nodes.push({});}});
  for(const core of [reference,wasm]) assert.deepEqual(core.decodeGlb(bytes),{supported:false,reason:'node hierarchy'});
});
async function workerReply(start, options={}) {
  const replies=[], images=[];
  const scope={onmessage:null,postMessage(reply){replies.push(reply);}};
  const kernel=createGoogleWorkerKernel(scope,{start,createImageBitmap:async()=>{const image={width:1,height:1,closed:0,close(){this.closed++;}};images.push(image);return image;},onError(error){throw error;},...options});
  scope.onmessage({data:{version:1,id:1,generation:3,kind:'decode',bytes:fixture().buffer,colorSpaceConversion:options.colorSpaceConversion}});
  for(let i=0;i<20&&!replies.length;i++) await new Promise(resolve=>setImmediate(resolve));
  return {replies,images,kernel,scope};
}
test('worker admits WASM only after parity and transfers bitmap ownership',async()=>{
  const {replies,images,kernel}=await workerReply(()=>wasm);
  assert.equal(replies[0].actualTier,'single'); assert.equal(replies[0].parity,'same'); assert.equal(images[0].closed,0);
  kernel.dispose(); assert.equal(images[0].closed,0); images[0].close();
});
test('startup failure and WASM mismatch retain complete worker TS output with reasons',async()=>{
  for(const start of [()=>{throw Error('load fixture');},()=>({...wasm,decodeGlb(bytes){const result=wasm.decodeGlb(bytes);result.primitives[0].positions[0]=42;return result;}})]) {
    const {replies,images,kernel}=await workerReply(start);
    assert.equal(replies[0].supported,true); assert.equal(replies[0].actualTier,'typescript'); assert.match(replies[0].fallbackReason,/WASM/);
    assert.equal(replies[0].primitives[0].positions[0],0); kernel.dispose(); images[0].close();
  }
});
test('cancel during pending JPEG closes the late bitmap without publishing',async()=>{
  let finish; const pending=new Promise(resolve=>{finish=resolve;});
  const result=await workerReply(()=>reference,{createImageBitmap:()=>pending});
  result.scope.onmessage({data:{version:1,id:1,generation:3,kind:'cancel'}});
  const bitmap={width:1,height:1,closed:0,close(){this.closed++;}};finish(bitmap);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(bitmap.closed,1); assert.equal(result.replies.some(reply=>reply.kind==='decoded'),false);result.kernel.dispose();
});
test('threaded requests run worker TypeScript with an explicit unavailable reason',async()=>{
  const {replies,images,kernel}=await workerReply(()=>{throw Error('must not load');},{requestedTier:'threaded'});
  assert.equal(replies[0].actualTier,'typescript');assert.match(replies[0].fallbackReason,/Threaded.*unavailable/);images[0].close();kernel.dispose();
});
test('EXIF JPEG metadata uses the original loader before allocating bitmaps',async()=>{
  for(const [marker,signature] of [[0xe1,'Exif\0\0']]){
    const start=()=>({...reference,decodeGlb(bytes){const result=reference.decodeGlb(bytes),source=result.primitives[0].jpeg,header=new TextEncoder().encode(signature),jpeg=new Uint8Array(source.length+header.length+4);jpeg.set([255,216,255,marker,0,header.length+2]);jpeg.set(header,6);jpeg.set(source.subarray(2),6+header.length);result.primitives[0].jpeg=jpeg;return result;}});
    const {replies,images,kernel}=await workerReply(start);assert.equal(replies[0].supported,false);assert.match(replies[0].reason,/original image loader/);assert.equal(images.length,0);kernel.dispose();
  }
});

test('ICC JPEGs retain the original loader in WebGL and WASM bitmap decode in WebGPU',async()=>{
  const start=()=>({...reference,decodeGlb(bytes){const result=reference.decodeGlb(bytes),source=result.primitives[0].jpeg,header=new TextEncoder().encode('ICC_PROFILE\0'),jpeg=new Uint8Array(source.length+header.length+4);jpeg.set([255,216,255,0xe2,0,header.length+2]);jpeg.set(header,6);jpeg.set(source.subarray(2),6+header.length);result.primitives[0].jpeg=jpeg;return result;}});
  const webgl=await workerReply(start,{colorSpaceConversion:'default'});assert.equal(webgl.replies[0].supported,false);assert.match(webgl.replies[0].reason,/original WebGL/);assert.equal(webgl.images.length,0);webgl.kernel.dispose();
  const webgpu=await workerReply(start,{colorSpaceConversion:'none'});assert.equal(webgpu.replies[0].supported,true);webgpu.images[0].close();webgpu.kernel.dispose();
});
