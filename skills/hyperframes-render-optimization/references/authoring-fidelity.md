# Authoring fidelity and fast-path decisions

## Purpose

Treat the approved native HyperFrames preview as the semantic oracle. The optimized renderer supports a verified subset of browser semantics; it must not redefine the composition merely to make a fast backend eligible.

Keep static compatibility and authoring fidelity as independent gates. A project can pass a compatibility scan after an accidental editorial downgrade, and a valid authoring project can still require faithful Chromium capture for unsupported intervals.

## Non-negotiable rules

- Keep the approved composition unchanged as the reference.
- Put compatibility fixes in the renderer, capture plan, media route, or interval backend first.
- Do not replace motion with staged images, remove tweens, shorten transitions, or insert token movement to satisfy a check.
- Do not refresh the motion baseline after a renderer workaround. Refresh it only after an editorial change is reviewed and approved in the native preview.
- Route an unsupported interval through faithful Chromium capture or stop for a decision.

Accept a mechanical authoring rewrite only when all of these are true:

1. visual and temporal intent is unchanged;
2. the original motion contract still passes;
3. native-versus-candidate consecutive frames cover entrance, midpoint, settled state, and exit;
4. trigger frames, easing, layer order, opacity, edges, and final state match;
5. the requested implementation itself is not part of the contract.

## Onboard a project

1. Play and approve the project in native HyperFrames/Chromium.
2. Freeze its motion structure before compatibility adaptation:

   ```bash
   node scripts/motion_contract.mjs freeze /path/to/project \
     --entry=index.html \
     --approval-note="Native preview approved"
   ```

3. Run both pre-render gates:

   ```bash
   node scripts/motion_contract.mjs check /path/to/project
   node scripts/delivery.mjs check /path/to/project --entry=index.html
   ```

4. Select a backend for every interval. Unsupported exact intervals normally use faithful capture rather than a whole-project rewrite.
5. Render representative dynamic clips through both the native oracle and candidate route.
6. Compare onset, transition, settled, exit, and first-clean frames at normal speed and frame-step.
7. Freeze the approved project scan, runtime hashes, media/timing routes, motion contract, and output contract.
8. Re-run the gates before every production output.

## Require dynamic evidence

For each motion-bearing interval, retain:

- a frame immediately before the first change;
- multiple frames inside the transition;
- the settled state;
- multiple exit frames;
- the first clean frame after exit.

Verify motion direction, onset and exit frames, duration, easing, layer order, transparency, clipping, and restoration of the base plate. A contact sheet or one hero frame cannot reveal a one-frame base-plate flash or missing movement whose final state still looks correct.

## Stop rules

Treat a whole-project faithful estimate as safety-backend evidence, not as fast-path performance. When the task is renderer optimization, benchmark exact and faithful on the same dynamic intervals, locate the incompatible boundary, and repair or plan that interval.

Use the faithful path when compatibility work approaches the cost of a faithful output, unsupported effects dominate, or the project is unlikely to be rendered again. Use the fast path when onboarding and dynamic validation can be reused safely across repeated outputs.

Typical symptoms and responses:

| Symptom | Response |
|---|---|
| Descendants vanish at partial opacity | Fix capture semantics or use a faithful interval; do not flatten motion. |
| 4K output draws a smaller DOM near one edge | Fix root/canvas coordinate scaling and validate all edges. |
| The base plate flashes between animation states | Compare consecutive frames and repair interval timing/layer capture. |
| Static checks pass after motion structure shrinks | Restore authoring and enforce the frozen motion contract. |
| Still frames look correct but movement is absent | Compare dynamic sequences, not sparse images. |
