# Renderer owner rules

Renderer owns generic render scheduling, readiness, device/backend/scene
lifecycle and GPU resource ownership. It must not import engine, terrain,
scene documents, flight, campus, host app settings or singletons. Hosts inject
one device/backend identity, one scheduler and their settings/readiness ports.
Pure contracts load without React, browser globals or device initialization;
browser and renderer-specific adapters have separate public entries.

Draw visible changes once, prepare content hidden and await readiness before
display, reject and dispose stale generation completions. Release resources
before the host destroys their device. Never create a second scheduler during
consumer adoption. Preserve the committed-source provenance in this candidate.

Keep scratch/check logs in `build/`. Request the coordinator's exclusive check
slot, cap test workers at 50%, and do not start servers, benchmarks, browsers or
native builds implicitly. Do not commit, publish or change remote settings
without the primary/coordinator gate. Common attribution checks come only from
the pinned Platform `@foss-earth/ci` public caller; do not implement a checker.

YOU CANNOT HAVE AI AS A CO-AUTHOR, OR YOUR CONTRIBUTIONS WILL BE REJECTED.
