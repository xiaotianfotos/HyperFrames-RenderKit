# AI production CLI

`hf-render` is the low-argument, fail-closed entry for Codex and other AI
agents. It composes the standard HyperFrames checker, the production
compatibility scan, the frozen authoring-motion contract, frozen toolchain
identity, route planning, rendering, and fast output verification. It does not
invent fixes or silently choose a cheaper visual result.

## Commands

From this repository:

```bash
# Read-only diagnosis. A path without a verb means `check`.
./bin/hf-render /path/to/project
./bin/hf-render check /path/to/project

# Preflight only; do not launch the renderer.
./bin/hf-render plan /path/to/project

# Run the exact same preflight, then render only when no blocking issue remains.
./bin/hf-render run /path/to/project
```

The project defaults to the current directory. The config is discovered in this
order:

1. `--config FILE`;
2. `.hyperframes/delivery.json`;
3. `render-config.production.json`;
4. `render-config.final-4k60.json`;
5. one unambiguous `render-config.final*.json`.

Use `--output NEW.mov` for a new delivery name. Existing outputs are never
overwritten. Use `--report DIR` for probes that must not write report artifacts
inside the project.

## Agent loop

Every invocation writes:

```text
PROJECT/.hyperframes/render-agent/latest.json
PROJECT/.hyperframes/render-agent/latest.md
```

The JSON is the machine contract. Each issue has:

- a stable problem `code` and instance `id`;
- severity and blocking status;
- stage, file, line, time, selector, and evidence when known;
- an agent objective, ordered repair steps, forbidden shortcuts, and the exact
  verification command.

The Markdown file is a ready-to-use Agent task. The intended loop is:

1. run `hf-render check`;
2. read `latest.json` or give `latest.md` to the Agent;
3. fix the earliest root-cause error without flattening authoring;
4. repeat the identical command;
5. run `hf-render run` only when the report is `ready`.

Exit status `0` means ready/rendered, `2` means a diagnosed production block,
and `1` means the CLI itself could not run. Warnings remain in the report even
when an approved route can proceed.

## Independent production gates

The CLI keeps compatibility, authoring fidelity, layout, routing, and frozen
runtime identity as separate gates:

- `HF-COMPAT-*` says whether the candidate backend understands the authoring;
- `HF-MOTION-*` says whether the authoring itself was weakened after approval;
- `HF-LAYOUT-*` points to a selector and sampled time rather than accepting a
  clean screenshot;
- `HF-ROUTE-*` refuses to call an unapproved whole-project screenshot ETA the
  fast pipeline;
- `HF-CONFIG-FROZEN-*` refuses stale or missing runtime identities.

Do not clear these findings by refreshing the motion baseline, acknowledging a
blocker, deleting opacity transitions, baking stages, or bulk-rehashing the
toolchain. The report instructions deliberately direct the Agent toward renderer
repair, proven interval routing, and consecutive-frame A/B evidence.

For example, an unsupported opacity transition can produce a compatibility
finding while the motion contract remains valid. The correct repair is to fix
the renderer or route the affected interval through a proven backend, then run
consecutive-frame comparison. The CLI must not modify the composition or count
a whole-project faithful fallback as optimized-path performance.
