# Agent instructions

Follow the shared rules for every foss-earth repository in
[foss-earth/.github/AGENTS.md](https://github.com/foss-earth/.github/blob/main/AGENTS.md)
(in a local checkout of the organization: `../.github/AGENTS.md`).

## TypeScript and WebAssembly twins

`google-TS/` holds the TypeScript reference for Google tile geometry decoding
and the profile check both twins share. Its Rust twin is `google-WASM/`: a
Cargo workspace with its JavaScript wrapper, worker kernel, checked-in binary
and build receipt. New cores use Rust. Keep the TypeScript reference. Accept a
WebAssembly result only after exact functional parity (`npm run test:wasm`),
and report the requested and actual backend and every fallback. Do not claim
speed or power improvements from a successful conversion or correctness test.
No fast math or reduced precision to make a benchmark pass. Rebuild with
`npm run build:wasm`, which uses installed tools offline and keeps
intermediates under `build/`; never install a toolchain without the user's
authorization.
