# Roadmap and release boundaries

This repository's source-controlled plans are authoritative; external project trackers mirror them. A released **initial extension RC** is the gating event separating near-term deliverables from the following vNext proposals. No vNext feature here is an RC acceptance criterion.

## Initial RC track

Prove the host-neutral incremental projection engine in the first VS Code adapter with C#→Python, provider/model selection justified by real trajectory benchmark results, and the existing bounded-context, revision, privacy, and validation contracts. Finish RC stabilization, publish candidate artifacts, and document the actual tested feature set; do not overclaim semantic translation from the scaffold.

## Post-RC vNext (not for initial RC)

### SMA-282 — Bidirectional transpilation and equal-opportunity editability

Allow edits in either participant language to drive synchronized semantic projection. No participant is intrinsically a permanently read-only derivative. Defer detailed design and implementation until after RC. Areas to resolve then: revision authority, ambiguous/lossy mappings, concurrent edits/conflicts, bidirectional correspondence, cycle prevention, validation, undo/recovery, and host presentation.

Tracker: https://linear.app/smartcaveman/issue/SMA-282

### SMA-283 — Arbitrary number of transpilation targets / participant languages

Support an arbitrary configurable number of targets, and—when combined with bidirectionality—an arbitrary number of languages that can participate in editing. Do not hard-code pairwise-only product semantics as a permanent architectural contract. Detailed graph/session topology, propagation/fanout, bounded work, failure isolation, policy compatibility, resource ceilings, and UI layout are unresolved until post-RC.

Tracker: https://linear.app/smartcaveman/issue/SMA-283

**Noncommitments:** Neither feature chooses an event/conflict algorithm, requires complete round-trip semantics, promises simultaneous unbounded resources, or changes the first RC's acceptance. Current one-way pair is a delivery adapter and can evolve without refactoring core preemptively.
