/** Pure completion contracts; no device, DOM, feature layout or scheduler imports. */
export type TextureTransferOutcome =
  | { readonly status: "uploaded" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "device-lost" };
export interface TextureTransferRetirement {
  /** Proven native completion or observed loss; cancellation alone supplies neither. */
  readonly status: "completed" | "device-lost";
  /** Every independent cleanup was attempted; the host owns this failure policy. */
  readonly cleanupError?: unknown;
}
export interface TextureTransferAdmission {
  /** Synchronous admission/retention teardown prevents every later allocation. */
  readonly active: boolean;
  readonly settled: Promise<TextureTransferOutcome>;
  readonly retired: Promise<TextureTransferRetirement>;
  /** One synchronous native submission. Reentrant cancellation stops later copies. */
  submit(copy: (isActive: () => boolean) => void): void;
  /** Stops publication immediately; native/input holds wait for proven retirement. */
  cancel(reason?: unknown): void;
}
export type TryAdmitTextureTransfer = (
  bytes: number, label: string, retainInput: () => () => void,
) => TextureTransferAdmission | null;
