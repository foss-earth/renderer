/** Stable host-owned identities. Values describe the actual supplied device/backend. */
export interface RendererIdentity {
  rendererId: string;
  backendId: string;
  deviceId: string;
}

declare const generationBrand: unique symbol;

/** Opaque token. Tokens are accepted only by the lifecycle that issued them. */
export interface RendererGeneration {
  readonly [generationBrand]: true;
  readonly sequence: number;
  readonly identity: Readonly<RendererIdentity>;
}

export interface ResourceDescriptor<T> {
  value: T;
  /** Release the actual GPU/device object; called exactly once by this owner. */
  dispose(value: T): void;
  /** No callback means the supplied resource is already ready to draw. */
  whenReady?(value: T): Promise<void>;
  /** Hidden preparation is the default. Only use true for content already shown. */
  initiallyVisible?: boolean;
}

export interface RendererResource<T> {
  readonly value: T;
  readonly generation: RendererGeneration;
  isCurrent(): boolean;
  /** False after replacement/disposal, including readiness that finishes late. */
  ready(): Promise<boolean>;
  /** Await readiness, then change visible content synchronously and ask for one frame. */
  commitVisible(change: (value: T) => void): Promise<boolean>;
  /** Idempotent. Removing visible content asks for a frame; hidden release does not. */
  dispose(): void;
}

export interface RendererResourceLifecycleOptions {
  identity: Readonly<RendererIdentity>;
  /** The host's existing render scheduler, never a new loop. */
  requestRender(): void;
}

export interface RendererResourceLifecycle {
  currentGeneration(): RendererGeneration;
  isCurrent(generation: RendererGeneration): boolean;
  /** Transfer ownership. A stale or foreign token disposes the object and returns null. */
  adopt<T>(generation: RendererGeneration, resource: ResourceDescriptor<T>): RendererResource<T> | null;
  /** Retire resources before the host replaces/destroys its device or backend. */
  invalidate(identity?: Readonly<RendererIdentity>): RendererGeneration;
  /** Dispose every owned resource. Further adoption rejects and disposes incoming objects. */
  dispose(): void;
}

interface ResourceRecord {
  disposed: boolean;
  visible: boolean;
  release(): void;
}

function checkedIdentity(identity: Readonly<RendererIdentity>): Readonly<RendererIdentity> {
  for (const key of ["rendererId", "backendId", "deviceId"] as const) {
    if (!identity[key].trim()) throw new TypeError(`${key} must name the host's supplied authority.`);
  }
  return Object.freeze({ ...identity });
}

/**
 * One ownership scope over a supplied host device. It allocates no backend,
 * submits no work, starts no timers, and never guesses a device from globals.
 * Call invalidate before host device replacement; late loader results must
 * carry their original token into adopt, rather than obtaining a fresh token.
 */
export function createRendererResourceLifecycle(options: RendererResourceLifecycleOptions): RendererResourceLifecycle {
  let stopped = false;
  let sequence = 0;
  const issue = (identity: Readonly<RendererIdentity>): RendererGeneration => Object.freeze({
    sequence: sequence++, identity: checkedIdentity(identity),
  }) as RendererGeneration;
  let current = issue(options.identity);
  const resources = new Set<ResourceRecord>();
  const isCurrent = (generation: RendererGeneration): boolean => !stopped && generation === current;

  const disposeAll = (): void => {
    const failures: unknown[] = [];
    const visible = [...resources].some(resource => resource.visible);
    for (const resource of [...resources]) {
      try { resource.release(); } catch (error) { failures.push(error); }
    }
    if (visible) options.requestRender();
    if (failures.length) throw new AggregateError(failures, "Renderer resource disposal failed.");
  };

  return {
    currentGeneration: () => current,
    isCurrent,
    adopt<T>(generation: RendererGeneration, descriptor: ResourceDescriptor<T>): RendererResource<T> | null {
      if (!isCurrent(generation)) {
        descriptor.dispose(descriptor.value);
        return null;
      }
      const record: ResourceRecord = {
        disposed: false,
        visible: descriptor.initiallyVisible ?? false,
        release(): void {
          if (record.disposed) return;
          record.disposed = true;
          resources.delete(record);
          descriptor.dispose(descriptor.value);
        },
      };
      resources.add(record);
      const active = (): boolean => !record.disposed && isCurrent(generation);
      let readiness: Promise<boolean> | null = null;
      const ready = (): Promise<boolean> => {
        if (!active()) return Promise.resolve(false);
        readiness ??= Promise.resolve().then(() => {
          if (!active()) return;
          return descriptor.whenReady?.(descriptor.value);
        }).then(() => active(), error => {
          const wasCurrent = active();
          const visible = record.visible;
          try { record.release(); } finally { if (visible) options.requestRender(); }
          if (wasCurrent) throw error;
          return false;
        });
        return readiness;
      };
      return {
        value: descriptor.value,
        generation,
        isCurrent: active,
        ready,
        async commitVisible(change): Promise<boolean> {
          if (!await ready() || !active()) return false;
          record.visible = true;
          try { change(descriptor.value); } finally { if (active()) options.requestRender(); }
          // The callback may synchronously cause host replacement or disposal.
          if (!active()) return false;
          return true;
        },
        dispose(): void {
          if (record.disposed) return;
          const visible = record.visible;
          try { record.release(); } finally { if (visible) options.requestRender(); }
        },
      };
    },
    invalidate(identity = current.identity): RendererGeneration {
      if (stopped) throw new Error("The renderer resource lifecycle is disposed.");
      const next = issue(identity);
      current = next;
      disposeAll();
      return next;
    },
    dispose(): void {
      if (stopped) return;
      stopped = true;
      disposeAll();
    },
  };
}
