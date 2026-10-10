import { Engine, OpenPBRMaterial, PBRMaterial, ShaderStore } from "@babylonjs/core";
import { createSceneUpdates } from "@foss-earth/renderer/babylon";

// Build the real retained Babylon root-module shape, including its shader
// registrations. Bundling this file does not instantiate an engine or device.
export { Engine, OpenPBRMaterial, PBRMaterial, ShaderStore, createSceneUpdates };
