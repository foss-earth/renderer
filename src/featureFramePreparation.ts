/** The feature receives the one host frame, never another loop or clock. */
export interface FeatureFramePorts {
  onFrame(frame: { now: number; dtMs: number }): boolean;
  isCurrent(): boolean;
  requestRender(): void;
}
export function createFeatureFramePreparation(ports: FeatureFramePorts) {
  return { prepare(frame: { nowMs: number; deltaSeconds: number }) {
    if (!ports.isCurrent()) return;
    if (ports.onFrame({ now: frame.nowMs, dtMs: frame.deltaSeconds * 1000 }) && ports.isCurrent()) ports.requestRender();
  } };
}
export function createResourceFrameWork(ports: {
  uploader: { pump(): number }; transfers: { pump(): void }; isCurrent(): boolean;
}) {
  return { prepare() {
    if (!ports.isCurrent()) return;
    const failures: unknown[] = [];
    try { ports.uploader.pump(); } catch (error) { failures.push(error); }
    try { if (ports.isCurrent()) ports.transfers.pump(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Resource frame preparation failed.");
  } };
}
