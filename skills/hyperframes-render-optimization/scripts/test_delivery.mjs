#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeliveryRoutePlan, renderFromConfig, scanProject } from "./delivery.mjs";
import { captureMotionContract } from "./motion_contract.mjs";

const root = mkdtempSync(join(tmpdir(), "hf-delivery-test-"));

function writeExecutable(file, source) {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function baseConfig({ projectRoot, output, environment = {} }) {
  const runtime = join(root, "fake-runtime.mjs");
  const main = join(root, "fake-main.mjs");
  const hyperframesRuntime = join(root, "fake-hyperframes-runtime.js");
  const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const timing = join(projectRoot, "timing.json");
  const route = join(projectRoot, "route.json");
  const motionContractDirectory = join(projectRoot, ".hyperframes");
  const motionContract = join(motionContractDirectory, "authoring-motion-contract.json");
  writeFileSync(timing, "{}\n");
  writeFileSync(route, "{}\n");
  mkdirSync(motionContractDirectory, { recursive: true });
  if (!existsSync(motionContract)) {
    writeFileSync(motionContract, `${JSON.stringify(captureMotionContract(projectRoot, {
      entry: "index.html",
      approvalNote: "Approved native authoring preview for delivery helper regression test",
    }), null, 2)}\n`);
  }
  return {
    kind: "hyperframes-delivery-config",
    schemaVersion: 1,
    runtime,
    main,
    hyperframesRuntime,
    runtimeArgs: [],
    environment: { ...environment, FAKE_ATTEMPT_LOG: join(root, "attempts.log") },
    projectRoot,
    entry: "index.html",
    authoringMotionContract: motionContract,
    output,
    ffprobe: join(root, "fake-ffprobe.mjs"),
    acknowledgedRuleIds: [],
    acknowledgedProjectScanSha256: null,
    requiredFileSha256: {
      [runtime]: sha256(runtime),
      [main]: sha256(main),
      [hyperframesRuntime]: sha256(hyperframesRuntime),
      [timing]: sha256(timing),
      [route]: sha256(route),
      [motionContract]: sha256(motionContract),
    },
    render: {
      width: 3840,
      height: 2160,
      fps: 60,
      frames: 12,
      startFrame: 0,
      bitrate: 40_000_000,
      compositeMode: "layered",
      outputBackend: "webcodecs",
      mediaDecoderBackend: "production-webcodecs",
      mediaFrameMode: "video",
      mediaTargetMode: "timing-plan",
      mediaAdvanceMode: "playback-step",
      mediaTailPolicy: "hold-last",
      mediaTimingPlan: "timing.json",
      mediaTimingPlanVerify: "sha256",
      canonicalMediaRoute: "route.json",
      canonicalMediaRouteVerify: "sha256",
      mixProjectAudio: false,
      extraArgs: ["--queueLimit=8"],
    },
    automaticFallback: {
      enabled: true,
      allowWholeProjectScreenshotFallback: true,
      treatReviewAsRisk: true,
      onCompatibilityRisk: "faithful-screenshot",
      onCanonicalCacheRequired: "faithful-screenshot",
      screenshotRender: {
        mediaTimingPlan: "timing.json",
        mediaTimingPlanVerify: "sha256",
        extraArgs: [
          "--screenshotMediaPolicy=faithful",
          "--mediaSeekBiasFrames=0",
          "--screenshotCaptureTimeoutMs=10000",
        ],
      },
    },
  };
}

function writeConfig(name, config) {
  const file = join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

try {
  writeFileSync(join(root, "fake-main.mjs"), "// fake main\n");
  writeFileSync(join(root, "fake-hyperframes-runtime.js"), "// fake HyperFrames runtime\n");
  writeExecutable(join(root, "fake-runtime.mjs"), `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const value = (name) => process.argv.find((token) => token.startsWith(name + "="))?.slice(name.length + 1);
const backend = value("--outputBackend");
const output = value("--output");
appendFileSync(process.env.FAKE_ATTEMPT_LOG, backend + "\\n");
if (backend === "webcodecs") {
  if (process.env.FAKE_MUTATE_PROJECT === "1") writeFileSync(process.env.FAKE_PROJECT_ENTRY, "<!doctype html><style>.x{filter:blur(9px)}</style>");
  if (process.env.FAKE_MUTATE_TIMING === "1") writeFileSync(process.env.FAKE_TIMING_PATH, '{"changed":true}');
  if (process.env.FAKE_CREATE_ON_EXACT === "1") writeFileSync(output, "unexpected");
  process.exit(Number(process.env.FAKE_EXACT_EXIT ?? 2));
}
writeFileSync(output, "fake-movie");
`);
  writeExecutable(join(root, "fake-ffprobe.mjs"), `#!/usr/bin/env node
console.log(JSON.stringify({streams:[{codec_name:"h264",codec_type:"video",width:3840,height:2160,r_frame_rate:"60/1",avg_frame_rate:"60/1",start_time:"0.000000",duration:"0.200000",nb_read_packets:"12",color_range:"tv",color_space:"bt709",color_transfer:"bt709",color_primaries:"bt709"}]}));
`);

  const cleanProject = join(root, "clean-project");
  const blockerProject = join(root, "blocker-project");
  const reviewProject = join(root, "review-project");
  const opacityProject = join(root, "opacity-project");
  const lowOpacityProject = join(root, "low-opacity-project");
  const alternateEntryProject = join(root, "alternate-entry-project");
  const unquotedClosureProject = join(root, "unquoted-closure-project");
  const commentedImportProject = join(root, "commented-import-project");
  const dynamicImportProject = join(root, "dynamic-import-project");
  const remoteDependencyProject = join(root, "remote-dependency-project");
  const scriptedPaintRiskProject = join(root, "scripted-paint-risk-project");
  const svgPaintRiskProject = join(root, "svg-paint-risk-project");
  const escapingSymlinkProject = join(root, "escaping-symlink-project");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(cleanProject), mkdir(blockerProject), mkdir(reviewProject), mkdir(opacityProject), mkdir(lowOpacityProject), mkdir(alternateEntryProject),
    mkdir(unquotedClosureProject), mkdir(commentedImportProject), mkdir(dynamicImportProject),
    mkdir(remoteDependencyProject), mkdir(scriptedPaintRiskProject), mkdir(svgPaintRiskProject),
    mkdir(escapingSymlinkProject),
  ]));
  writeFileSync(join(cleanProject, "index.html"), "<!doctype html><main>clean</main>");
  writeFileSync(join(blockerProject, "index.html"), "<!doctype html><style>.x{filter:blur(3px)}</style><main class=x>blocked</main>");
  writeFileSync(join(reviewProject, "index.html"), "<!doctype html><script>document.createElement('div')</script>");
  writeFileSync(join(opacityProject, "index.html"), "<!doctype html><script>gsap.to(node,{autoAlpha:0,duration:1})</script>");
  writeFileSync(join(lowOpacityProject, "index.html"), "<!doctype html><script>gsap.fromTo(flash,{autoAlpha:0},{autoAlpha:.05,duration:.05})</script>");
  writeFileSync(join(alternateEntryProject, "index.html"), "<!doctype html><main>unused clean entry</main>");
  writeFileSync(join(alternateEntryProject, "compiled.html"), "<!doctype html><style>.x{filter:blur(2px)}</style>");
  writeFileSync(join(unquotedClosureProject, "index.html"), "<!doctype html><link rel=stylesheet href=risk.css>");
  writeFileSync(join(unquotedClosureProject, "risk.css"), ".x{filter:blur(2px)}");
  writeFileSync(join(commentedImportProject, "index.html"), "<!doctype html><script type=module src=main.js></script>");
  writeFileSync(join(commentedImportProject, "main.js"), "import /* dependency */ './risk.js';");
  writeFileSync(join(commentedImportProject, "risk.js"), "document.body.innerHTML='<style>.x{filter:blur(2px)}</style>';");
  writeFileSync(join(dynamicImportProject, "index.html"), "<!doctype html><script type=module>import('./' + window.name)</script>");
  writeFileSync(join(remoteDependencyProject, "index.html"), "<!doctype html><script src=https://example.com/app.js></script>");
  writeFileSync(join(scriptedPaintRiskProject, "index.html"), `<!doctype html>
<script>
gsap.to(node, {
  clipPath: "inset(0 20% 0 0)",
  maskImage: "linear-gradient(#000, transparent)",
  transformPerspective: 800,
  rotationY: 12,
});
node.style.filter = "blur(2px)";
node.style.clipPath = "circle(50%)";
node.style.webkitMaskImage = "linear-gradient(#000, transparent)";
</script>`);
  writeFileSync(join(svgPaintRiskProject, "index.html"), `<!doctype html>
<svg><defs><filter id="glow"></filter><mask id="fade"></mask><clipPath id="crop"></clipPath></defs>
<g filter="url(#glow)" mask="url(#fade)" clip-path="url(#crop)"></g></svg>`);
  const outsideDependency = join(root, "outside.js");
  writeFileSync(outsideDependency, "document.body.textContent='outside'");
  symlinkSync(outsideDependency, join(escapingSymlinkProject, "linked.js"));
  writeFileSync(join(escapingSymlinkProject, "index.html"), "<!doctype html><script src=linked.js></script>");

  const cleanConfig = baseConfig({ projectRoot: cleanProject, output: join(root, "clean.mov") });
  const blockerConfig = baseConfig({ projectRoot: blockerProject, output: join(root, "blocker.mov") });
  const missingMotionContract = baseConfig({
    projectRoot: cleanProject,
    output: join(root, "missing-motion-contract.mov"),
  });
  delete missingMotionContract.requiredFileSha256[missingMotionContract.authoringMotionContract];
  delete missingMotionContract.authoringMotionContract;
  await assert.rejects(
    () => renderFromConfig(writeConfig("missing-motion-contract", missingMotionContract), { dryRun: true }),
    /requires authoringMotionContract/,
  );
  const cleanScan = await scanProject(cleanProject);
  const blockerScan = await scanProject(blockerProject);
  const reviewScan = await scanProject(reviewProject);
  const opacityScan = await scanProject(opacityProject);
  assert(opacityScan.findings.some((finding) => finding.ruleId === "canvas-draw-dynamic-opacity"));
  const lowOpacityScan = await scanProject(lowOpacityProject);
  assert(lowOpacityScan.findings.some((finding) => finding.ruleId === "canvas-draw-dynamic-opacity"));
  assert(lowOpacityScan.findings.some((finding) => finding.ruleId === "canvas-draw-explicit-partial-opacity"));
  assert(lowOpacityScan.findings.some((finding) => finding.ruleId === "canvas-draw-low-partial-opacity" && finding.severity === "blocker"));
  const opacityConfig = baseConfig({ projectRoot: opacityProject, output: join(root, "opacity.mov") });
  opacityConfig.automaticFallback.treatReviewAsRisk = false;
  opacityConfig.automaticFallback.approvedExactProjectScanSha256 = opacityScan.projectScanSha256;
  opacityConfig.acknowledgedRuleIds = ["canvas-draw-dynamic-opacity"];
  opacityConfig.acknowledgedProjectScanSha256 = opacityScan.projectScanSha256;
  await assert.rejects(
    () => renderFromConfig(writeConfig("opacity-policy-missing", opacityConfig), { dryRun: true }),
    /partialOpacityPolicy=promote-dynamic/,
  );
  opacityConfig.render.extraArgs.push("--partialOpacityPolicy=promote-dynamic");
  const opacityDry = await renderFromConfig(
    writeConfig("opacity-policy-explicit", opacityConfig),
    { dryRun: true },
  );
  assert.equal(opacityDry.routePlan.selectedRoute, "production-exact");

  const dependencyMain = join(root, "dependency-main.mjs");
  const dependencyModule = join(root, "dependency-module.mjs");
  writeFileSync(dependencyModule, "export const dependency = true;\n");
  writeFileSync(dependencyMain, "import { dependency } from './dependency-module.mjs';\nvoid dependency;\n");
  const dependencyConfig = baseConfig({ projectRoot: cleanProject, output: join(root, "dependency.mov") });
  dependencyConfig.main = dependencyMain;
  dependencyConfig.requiredFileSha256[dependencyMain] = createHash("sha256")
    .update(readFileSync(dependencyMain)).digest("hex");
  await assert.rejects(
    () => renderFromConfig(writeConfig("dependency-unfrozen", dependencyConfig), { dryRun: true }),
    /frozen SHA-256 for local module dependency.*dependency-module\.mjs/,
  );
  dependencyConfig.requiredFileSha256[dependencyModule] = createHash("sha256")
    .update(readFileSync(dependencyModule)).digest("hex");
  const dependencyDry = await renderFromConfig(
    writeConfig("dependency-frozen", dependencyConfig),
    { dryRun: true },
  );
  assert(dependencyDry.frozenMainModuleClosure.some(({ file }) => file === dependencyModule));
  const alternateDefaultScan = await scanProject(alternateEntryProject);
  const alternateCompiledScan = await scanProject(alternateEntryProject, { entry: "compiled.html" });
  assert.equal(alternateDefaultScan.blockerCount, 0);
  assert.equal(alternateCompiledScan.blockerCount, 1);
  assert.notEqual(alternateDefaultScan.projectScanSha256, alternateCompiledScan.projectScanSha256);
  const unquotedScan = await scanProject(unquotedClosureProject);
  assert.equal(unquotedScan.scannedFiles, 2);
  assert(unquotedScan.findings.some((finding) => finding.ruleId === "css-filter-compositing" && finding.file === "risk.css"));
  const commentedImportScan = await scanProject(commentedImportProject);
  assert.equal(commentedImportScan.scannedFiles, 3);
  assert(commentedImportScan.findings.some((finding) => finding.ruleId === "css-filter-compositing" && finding.file === "risk.js"));
  const dynamicImportScan = await scanProject(dynamicImportProject);
  assert(dynamicImportScan.findings.some((finding) => finding.ruleId === "module-dynamic-dependency"));
  const remoteDependencyScan = await scanProject(remoteDependencyProject);
  assert(remoteDependencyScan.findings.some((finding) => finding.ruleId === "remote-runtime-dependency"));
  const scriptedPaintRiskScan = await scanProject(scriptedPaintRiskProject);
  assert(scriptedPaintRiskScan.findings.some((finding) => finding.ruleId === "css-clip-path"));
  assert(scriptedPaintRiskScan.findings.some((finding) => finding.ruleId === "css-mask"));
  assert(scriptedPaintRiskScan.findings.some((finding) => finding.ruleId === "css-filter-compositing"));
  assert(scriptedPaintRiskScan.findings.some((finding) => finding.ruleId === "css-3d-transform"));
  assert.equal(scriptedPaintRiskScan.productionEligibleForLayered, false);
  const svgPaintRiskScan = await scanProject(svgPaintRiskProject);
  assert(svgPaintRiskScan.findings.some((finding) => finding.ruleId === "svg-filter-compositing"));
  assert(svgPaintRiskScan.findings.some((finding) => finding.ruleId === "svg-mask"));
  assert(svgPaintRiskScan.findings.some((finding) => finding.ruleId === "svg-clip-path"));
  assert.equal(svgPaintRiskScan.productionEligibleForLayered, false);
  const acknowledgedBlockerScan = await scanProject(blockerProject, {
    acknowledgedRuleIds: ["css-filter-compositing"],
  });
  assert.equal(acknowledgedBlockerScan.blockerCount, 1);
  assert.equal(acknowledgedBlockerScan.acknowledgedFindingCount, 1);
  assert.equal(acknowledgedBlockerScan.productionEligibleForLayered, false);
  assert.equal(acknowledgedBlockerScan.findings[0].acknowledged, true);
  const legacyAcknowledgedBlockerScan = await scanProject(blockerProject, {
    approvedRuleIds: ["css-filter-compositing"],
  });
  assert.equal(legacyAcknowledgedBlockerScan.blockerCount, 1);
  assert.equal(legacyAcknowledgedBlockerScan.findings[0].acknowledged, true);
  await assert.rejects(() => scanProject(escapingSymlinkProject), /dependency resolves outside project root/);

  const alternateConfig = baseConfig({ projectRoot: alternateEntryProject, output: join(root, "alternate.mov") });
  alternateConfig.entry = "compiled.html";
  const alternateDry = await renderFromConfig(writeConfig("alternate-entry", alternateConfig), { dryRun: true });
  assert.equal(alternateDry.scan.entry, "compiled.html");
  assert.equal(alternateDry.routePlan.selectedRoute, "faithful-screenshot");

  assert.equal(buildDeliveryRoutePlan(cleanConfig, cleanScan).selectedRoute, "faithful-screenshot");
  assert.equal(buildDeliveryRoutePlan(cleanConfig, cleanScan).reason, "exact-route-project-approval-missing-or-stale");
  cleanConfig.automaticFallback.approvedExactProjectScanSha256 = cleanScan.projectScanSha256;
  assert.equal(buildDeliveryRoutePlan(cleanConfig, cleanScan).selectedRoute, "production-exact");
  assert.equal(buildDeliveryRoutePlan(blockerConfig, blockerScan).selectedRoute, "faithful-screenshot");
  const acknowledgedBlockerConfig = baseConfig({
    projectRoot: blockerProject,
    output: join(root, "acknowledged-blocker.mov"),
  });
  assert.equal(
    buildDeliveryRoutePlan(acknowledgedBlockerConfig, acknowledgedBlockerScan).selectedRoute,
    "faithful-screenshot",
  );
  assert.equal(buildDeliveryRoutePlan(baseConfig({ projectRoot: reviewProject, output: join(root, "review.mov") }), reviewScan).selectedRoute, "faithful-screenshot");

  const legacyReviewConfig = baseConfig({ projectRoot: reviewProject, output: join(root, "legacy-review.mov") });
  delete legacyReviewConfig.automaticFallback;
  assert.equal(buildDeliveryRoutePlan(legacyReviewConfig, reviewScan).selectedRoute, "production-exact");
  const legacyBlockerConfig = baseConfig({ projectRoot: blockerProject, output: join(root, "legacy-blocker.mov") });
  delete legacyBlockerConfig.automaticFallback;
  assert.equal(buildDeliveryRoutePlan(legacyBlockerConfig, blockerScan).selectedRoute, "blocked");

  const dry = await renderFromConfig(writeConfig("blocker-dry", blockerConfig), { dryRun: true });
  assert.equal(dry.routePlan.selectedRoute, "faithful-screenshot");
  assert(dry.invocation.args.includes("--outputBackend=screenshot"));
  assert(dry.invocation.args.includes(`--hyperframesRuntime=${join(root, "fake-hyperframes-runtime.js")}`));
  assert(dry.invocation.args.includes("--screenshotMediaPolicy=faithful"));
  assert(!dry.invocation.args.some((token) => token.startsWith("--canonicalMediaRoute=")));
  assert.equal(dry.routeEvidence, `${blockerConfig.output}.delivery-route.jsonl`);
  assert.equal(existsSync(dry.routeEvidence), false);

  writeFileSync(join(root, "attempts.log"), "");
  const completed = await renderFromConfig(writeConfig("exact-exit-two", cleanConfig));
  assert.equal(completed.routePlan.selectedRoute, "faithful-screenshot");
  assert.equal(completed.routePlan.reason, "canonical-cache-required-fell-back-to-faithful-screenshot");
  assert.deepEqual(completed.attempts.map(({ route, exitCode }) => ({ route, exitCode })), [
    { route: "production-exact", exitCode: 2 },
    { route: "faithful-screenshot", exitCode: 0 },
  ]);
  assert.equal(readFileSync(join(root, "attempts.log"), "utf8"), "webcodecs\nscreenshot\n");
  assert.equal(completed.verification.passed, true);
  const completedEvidence = readFileSync(completed.routeEvidence, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(completedEvidence.map(({ event }) => event), [
    "route-selected", "attempt-finished", "fallback-selected", "attempt-finished", "fast-verification",
  ]);
  assert.equal(completedEvidence[1].exitCode, 2);
  assert.equal(completedEvidence[3].exitCode, 0);

  writeFileSync(join(root, "attempts.log"), "");
  const hardFailure = baseConfig({
    projectRoot: cleanProject,
    output: join(root, "hard-failure.mov"),
    environment: { FAKE_EXACT_EXIT: "1" },
  });
  hardFailure.automaticFallback.approvedExactProjectScanSha256 = cleanScan.projectScanSha256;
  await assert.rejects(() => renderFromConfig(writeConfig("hard-failure", hardFailure)), /render exited 1/);
  assert.equal(readFileSync(join(root, "attempts.log"), "utf8"), "webcodecs\n");

  writeFileSync(join(root, "attempts.log"), "");
  const timingMutationProject = join(root, "timing-mutation-project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(timingMutationProject));
  writeFileSync(join(timingMutationProject, "index.html"), "<!doctype html><main>initial</main>");
  const timingMutationConfig = baseConfig({
    projectRoot: timingMutationProject,
    output: join(root, "timing-mutation.mov"),
    environment: { FAKE_MUTATE_TIMING: "1", FAKE_TIMING_PATH: join(timingMutationProject, "timing.json") },
  });
  const timingMutationScan = await scanProject(timingMutationProject);
  timingMutationConfig.automaticFallback.approvedExactProjectScanSha256 = timingMutationScan.projectScanSha256;
  await assert.rejects(() => renderFromConfig(writeConfig("timing-mutation", timingMutationConfig)), /required file identity changed/);
  assert.equal(readFileSync(join(root, "attempts.log"), "utf8"), "webcodecs\n");

  writeFileSync(join(root, "attempts.log"), "");
  const mutatingProject = join(root, "mutating-project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(mutatingProject));
  const mutatingEntry = join(mutatingProject, "index.html");
  writeFileSync(mutatingEntry, "<!doctype html><main>initial</main>");
  const mutatingConfig = baseConfig({
    projectRoot: mutatingProject,
    output: join(root, "mutating.mov"),
    environment: { FAKE_MUTATE_PROJECT: "1", FAKE_PROJECT_ENTRY: mutatingEntry },
  });
  const mutatingScan = await scanProject(mutatingProject);
  mutatingConfig.automaticFallback.approvedExactProjectScanSha256 = mutatingScan.projectScanSha256;
  await assert.rejects(() => renderFromConfig(writeConfig("mutating", mutatingConfig)), /identity changed between exact preflight and fallback/);
  assert.equal(readFileSync(join(root, "attempts.log"), "utf8"), "webcodecs\n");

  writeFileSync(join(root, "attempts.log"), "");
  const unsafeExitTwo = baseConfig({
    projectRoot: cleanProject,
    output: join(root, "unsafe-exit-two.mov"),
    environment: { FAKE_CREATE_ON_EXACT: "1" },
  });
  unsafeExitTwo.automaticFallback.approvedExactProjectScanSha256 = cleanScan.projectScanSha256;
  await assert.rejects(() => renderFromConfig(writeConfig("unsafe-exit-two", unsafeExitTwo)), /after creating an output/);
  assert.equal(readFileSync(join(root, "attempts.log"), "utf8"), "webcodecs\n");

  const malformedFallback = baseConfig({ projectRoot: blockerProject, output: join(root, "malformed.mov") });
  malformedFallback.automaticFallback.screenshotRender.extraArgs = ["--mediaSeekBiasFrames=0"];
  assert.throws(() => buildDeliveryRoutePlan(malformedFallback, blockerScan), /screenshotMediaPolicy=faithful/);
  assert.throws(() => buildDeliveryRoutePlan(malformedFallback, cleanScan), /screenshotMediaPolicy=faithful/);

  const unapprovedWholeProjectFallback = baseConfig({ projectRoot: blockerProject, output: join(root, "unapproved-fallback.mov") });
  delete unapprovedWholeProjectFallback.automaticFallback.allowWholeProjectScreenshotFallback;
  assert.throws(
    () => buildDeliveryRoutePlan(unapprovedWholeProjectFallback, blockerScan),
    /allowWholeProjectScreenshotFallback=true/,
  );

  const unfrozen = baseConfig({ projectRoot: cleanProject, output: join(root, "unfrozen.mov") });
  unfrozen.automaticFallback.approvedExactProjectScanSha256 = cleanScan.projectScanSha256;
  unfrozen.requiredFileSha256 = {};
  assert.throws(() => buildDeliveryRoutePlan(unfrozen, cleanScan), /requires a frozen SHA-256/);

  const missingTiming = baseConfig({ projectRoot: cleanProject, output: join(root, "missing-timing.mov") });
  missingTiming.automaticFallback.approvedExactProjectScanSha256 = cleanScan.projectScanSha256;
  delete missingTiming.requiredFileSha256[join(cleanProject, "timing.json")];
  assert.throws(() => buildDeliveryRoutePlan(missingTiming, cleanScan), /timing\.json/);

  const missingRoute = baseConfig({ projectRoot: cleanProject, output: join(root, "missing-route.mov") });
  missingRoute.automaticFallback.approvedExactProjectScanSha256 = cleanScan.projectScanSha256;
  delete missingRoute.requiredFileSha256[join(cleanProject, "route.json")];
  assert.throws(() => buildDeliveryRoutePlan(missingRoute, cleanScan), /route\.json/);

  const missingHyperFramesRuntime = baseConfig({ projectRoot: cleanProject, output: join(root, "missing-hyperframes-runtime.mov") });
  missingHyperFramesRuntime.automaticFallback.approvedExactProjectScanSha256 = cleanScan.projectScanSha256;
  delete missingHyperFramesRuntime.requiredFileSha256[missingHyperFramesRuntime.hyperframesRuntime];
  assert.throws(
    () => buildDeliveryRoutePlan(missingHyperFramesRuntime, cleanScan),
    /fake-hyperframes-runtime\.js/,
  );

  writeFileSync(join(root, "attempts.log"), "");
  const occupiedEvidence = baseConfig({ projectRoot: cleanProject, output: join(root, "occupied-evidence.mov") });
  occupiedEvidence.automaticFallback.approvedExactProjectScanSha256 = cleanScan.projectScanSha256;
  writeFileSync(`${occupiedEvidence.output}.delivery-route.jsonl`, "foreign evidence\n");
  await assert.rejects(() => renderFromConfig(writeConfig("occupied-evidence", occupiedEvidence)), /route evidence already exists/);
  assert.equal(readFileSync(join(root, "attempts.log"), "utf8"), "");

  const foreignEvidencePath = baseConfig({ projectRoot: cleanProject, output: join(root, "foreign-evidence.mov") });
  foreignEvidencePath.automaticFallback.approvedExactProjectScanSha256 = cleanScan.projectScanSha256;
  foreignEvidencePath.routeEvidence = join(cleanProject, "route-evidence.jsonl");
  await assert.rejects(() => renderFromConfig(writeConfig("foreign-evidence-path", foreignEvidencePath), { dryRun: true }), /must be in the output directory/);

  console.log("delivery automatic routing tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
