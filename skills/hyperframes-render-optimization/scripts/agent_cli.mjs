#!/usr/bin/env node

import {
  createHash,
} from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildDeliveryRoutePlan,
  renderFromConfig,
  scanProject,
} from "./delivery.mjs";
import { verifyMotionContract } from "./motion_contract.mjs";

const REPORT_KIND = "hyperframes-agent-render-report";
const REPORT_SCHEMA_VERSION = 1;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI_EXECUTABLE = resolve(REPOSITORY_ROOT, "bin", "hf-render");
const COMMANDS = new Set(["check", "plan", "run", "help"]);
const LAYOUT_REVIEW_CODES = new Set([
  "container_overflow",
  "content_overlap",
  "escaped_container",
  "text_box_overflow",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(file) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

function parseArgs(tokens) {
  const positional = [];
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      options[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    const next = tokens[index + 1];
    if (next != null && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  let command = "check";
  if (COMMANDS.has(positional[0])) command = positional.shift();
  return {
    command,
    projectRoot: resolve(positional[0] ?? process.cwd()),
    options,
    extra: positional.slice(1),
  };
}

function commonVerify(projectRoot, configPath) {
  const configArg = configPath == null ? "" : ` --config=${JSON.stringify(configPath)}`;
  return [`${JSON.stringify(CLI_EXECUTABLE)} check ${JSON.stringify(projectRoot)}${configArg}`];
}

function compatibilityGuide(ruleId) {
  if (ruleId.includes("opacity")) {
    return {
      goal: "保留原 GSAP 入场、变化和退场节奏，同时处理快速 Canvas 路径的透明度语义风险。",
      steps: [
        "在报告列出的行和动画实际激活时刻检查 opacity/autoAlpha 的起点、中点、落点与退场。",
        "先修渲染器或给受影响时间区间选择已验证的忠实后端；只有像素等价时才把元素透明度改写为颜色/素材自身的 alpha。",
        "用同一连续帧区间比较原生 Chromium 与快速路径，核对出现帧、稳定帧和消失帧。",
      ],
      constraints: [
        "不得删补间、缩短动画、烘焙成静态阶段图或只保留推拉缩放。",
        "promote-dynamic 不是 alpha 等价证明；不能只看单张 hero frame。",
      ],
    };
  }
  if (["css-filter-compositing", "css-blend-mode", "css-mask", "css-clip-path", "css-3d-transform", "css-negative-stacking", "svg-filter-compositing", "svg-mask", "svg-clip-path"].includes(ruleId)) {
    return {
      goal: "让该浏览器合成语义走已证明的后端，而不是用静态改稿消除扫描结果。",
      steps: [
        "定位该效果真正可见的连续时间区间，并保留原生 Chromium 输出作为像素与运动基准。",
        "优先实现/修复快速渲染器支持；否则只把受影响区间路由到 faithful Chromium。",
        "对效果出现前、变化中、稳定态和退出后的连续帧做 A/B，再冻结区间后端计划。",
      ],
      constraints: [
        "acknowledge 只记录审查，不能把 blocker 变安全。",
        "不得删除 filter/mask/clip/3D 动画来换取快速路径通过。",
      ],
    };
  }
  if (ruleId === "remote-runtime-dependency") {
    return {
      goal: "把运行时依赖变成本地、可冻结、可复现的文件。",
      steps: [
        "下载或复制依赖到项目资产目录，并把 HTML/CSS/JS 引用改为本地相对路径。",
        "确认许可证与字体/脚本版本后，重新运行检查并冻结新文件哈希。",
      ],
      constraints: ["生产渲染不得依赖网络可用性或未冻结 CDN 内容。"],
    };
  }
  return {
    goal: "证明并修复该 DOM/CSS/媒体语义在生产后端中的表现。",
    steps: [
      "打开报告中的文件和行，确定它在时间轴上首次激活、稳定和退出的时刻。",
      "使用原生 Chromium 作为参考，修渲染器或为受影响区间选择已验证后端。",
      "连续帧 A/B 通过后再更新项目扫描审批身份。",
    ],
    constraints: ["不要用删动画、隐藏元素或静态图替换来消除告警。"],
  };
}

function guideFor(code, detail = {}) {
  if (code.startsWith("HF-COMPAT-")) return compatibilityGuide(detail.ruleId ?? "");
  if (code.startsWith("HF-MOTION-")) {
    return {
      goal: "恢复用户已批准的作者动画结构。",
      steps: [
        "从版本历史或批准版恢复报告点名的 composition、timeline、tween、onUpdate 或动画属性。",
        "确认恢复后仍是同步、可 seek、有限 repeat 的 HyperFrames timeline。",
        "先让原 motion contract 通过，再做原生 Chromium 与候选后端连续帧 A/B。",
      ],
      constraints: [
        "不要刷新 motion contract 来接受当前退化版本。",
        "不要用 PNG/视频阶段图替换原 DOM/GSAP 动画。",
      ],
    };
  }
  if (code.startsWith("HF-LAYOUT-") || code.startsWith("HF-HYPERFRAMES-")) {
    if (code.startsWith("HF-HYPERFRAMES-CHECK-")) {
      return {
        goal: "恢复一个版本固定、能输出 JSON 的标准 HyperFrames 检查入口。",
        steps: [
          "在项目 package.json 中固定 HyperFrames 版本，并提供 check 脚本，或安装项目本地 node_modules/.bin/hyperframes。",
          "手工运行该检查并确认最后返回包含 lint/runtime/layout/motion/contrast 的 JSON。",
          "重新运行 hf-render；不要因为标准检查不可用而跳过此门。",
        ],
        constraints: ["生产检查不得临时下载未固定版本，也不得把检查启动失败当作通过。"],
      };
    }
    return {
      goal: "在作者分辨率和最终 4K 输出中都保持正确布局与安全边距。",
      steps: [
        "在报告给出的 sourceFile、selector 和 time 复现问题。",
        "修正元素相对其 offset parent 的坐标、尺寸或文本约束；确认只发生一次 1920→3840 缩放。",
        "检查动画开始、运动中、落点和退出四类帧，特别确认左侧安全边距与人物不闪现。",
      ],
      constraints: [
        "只有确认是设计性越界时才使用 data-layout-allow-*，不能用它掩盖真实错位。",
        "不要只在 1080p Studio 看一张静帧。",
      ],
    };
  }
  if (code === "HF-CONFIG-FROZEN-FILE-CHANGED") {
    return {
      goal: "确认工具链变更是预期且已回归，再只更新对应冻结哈希。",
      steps: [
        "查看该文件的 Git diff/commit，确认不是意外覆盖或错误仓库。",
        "运行该模块单元测试和一个包含动态 MG 的 exact-vs-faithful 短段。",
        `验证通过后执行 sha256sum ${detail.file ?? "<file>"}，只更新配置中这一项。`,
      ],
      constraints: ["不要批量重算所有哈希，也不要在没有动态回归时解除冻结。"],
    };
  }
  if (code.startsWith("HF-ROUTE-")) {
    return {
      goal: "建立可证明、不会静默掉动画的快速生产路由。",
      steps: [
        "从高风险 MG、透明度过渡、混合帧率素材、首尾切换各选代表短段。",
        "同区间渲染 exact 与 faithful，记录连续帧差异和冷/热速度；先解决差异边界。",
        "只有动态 A/B 通过后才更新 approvedExactProjectScanSha256；若这些 review 已由该冻结 profile 证明，再显式设 treatReviewAsRisk:false，或把风险区间写入后端计划。",
      ],
      constraints: [
        "不能把整片 faithful 的多小时估时称为快速管线耗时。",
        "不能仅凭 blocker=0、单帧或 contact sheet 开始整片。",
      ],
    };
  }
  if (code.startsWith("HF-CONFIG-")) {
    return {
      goal: "修复生产配置，使项目、入口、输出合同和冻结身份明确且可复现。",
      steps: [
        "按 evidence 修正唯一一项配置，不要复制旧项目或预检短段的参数。",
        "确认 projectRoot、entry、4K60 帧数、音频、输出路径和自动路由合同。",
        "重新运行 check；通过后再运行 run。",
      ],
      constraints: ["不要覆盖既有输出；每次交付使用新的输出文件和证据 sidecar。"],
    };
  }
  if (code.startsWith("HF-RENDER-")) {
    return {
      goal: "从首个可复现的渲染/校验错误修复管线，禁止静默降级。",
      steps: [
        "读取错误、route evidence 与 renderer metrics，确认失败属于预检、解码、绘制、编码、封装还是校验。",
        "在相同区间和输出合同下复现，修复后先跑短段，再重新运行整片。",
      ],
      constraints: ["exit 1、信号退出、生成部分输出或校验失败都不能触发质量降级。"],
    };
  }
  return {
    goal: "修复报告中的确定问题并用同一入口复检。",
    steps: ["按 location 和 evidence 定位根因。", "做最小、可验证、保持作者语义的修改。", "重新运行 check。"],
    constraints: ["保留用户已有素材、动画和无关改动。"],
  };
}

export function makeIssue({
  code,
  severity = "error",
  stage,
  title,
  summary,
  file = null,
  line = null,
  time = null,
  selector = null,
  evidence = null,
  detail = {},
  projectRoot,
  configPath,
}) {
  const location = { file, line, time, selector };
  const guide = guideFor(code, { ...detail, file });
  guide.verify = commonVerify(projectRoot, configPath);
  const fingerprint = sha256(JSON.stringify([code, location, summary, evidence])).slice(0, 12);
  return {
    id: `${code}:${fingerprint}`,
    code,
    severity,
    blocking: severity === "error",
    stage,
    title,
    summary,
    location,
    evidence,
    detail,
    agent: guide,
  };
}

function issueFactory(context) {
  return (issue) => makeIssue({ ...issue, ...context });
}

export function discoverConfig(projectRoot, explicitConfig = null) {
  if (explicitConfig != null) return resolve(projectRoot, explicitConfig);
  const preferred = [
    ".hyperframes/delivery.json",
    "render-config.production.json",
    "render-config.final-4k60.json",
  ];
  for (const candidate of preferred) {
    const file = resolve(projectRoot, candidate);
    if (existsSync(file)) return file;
  }
  const finals = readdirSync(projectRoot)
    .filter((name) => /^render-config\.final.*\.json$/i.test(name))
    .sort();
  return finals.length === 1 ? resolve(projectRoot, finals[0]) : null;
}

function readConfig(configPath, add, command) {
  if (configPath == null) {
    add({
      code: "HF-CONFIG-NOT-FOUND",
      severity: command === "check" ? "warning" : "error",
      stage: "config",
      title: "没有找到唯一的生产渲染配置",
      summary: "自动查找 .hyperframes/delivery.json、render-config.production.json 或 render-config.final-4k60.json 均失败。",
      evidence: "用 --config=/absolute/render-config.json 明确指定生产配置。",
    });
    return null;
  }
  if (!existsSync(configPath)) {
    add({
      code: "HF-CONFIG-NOT-FOUND",
      severity: "error",
      stage: "config",
      title: "指定的生产渲染配置不存在",
      summary: configPath,
      file: configPath,
    });
    return null;
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    add({
      code: "HF-CONFIG-INVALID-JSON",
      severity: "error",
      stage: "config",
      title: "生产渲染配置不是有效 JSON",
      summary: String(error.message ?? error),
      file: configPath,
    });
    return null;
  }
}

function validateConfig(config, projectRoot, configPath, add, command) {
  if (config == null) return;
  const configuredRoot = resolve(config.projectRoot ?? projectRoot);
  if (configuredRoot !== projectRoot) {
    add({
      code: "HF-CONFIG-PROJECT-MISMATCH",
      stage: "config",
      title: "配置指向了另一个工程",
      summary: `CLI 工程是 ${projectRoot}，配置 projectRoot 是 ${configuredRoot}。`,
      file: configPath,
    });
  }
  const entry = resolve(projectRoot, config.entry ?? "index.html");
  if (!existsSync(entry)) {
    add({
      code: "HF-CONFIG-ENTRY-MISSING",
      stage: "config",
      title: "实际渲染入口不存在",
      summary: config.entry ?? "index.html",
      file: entry,
    });
  }
  const render = config.render ?? {};
  for (const [key, value] of Object.entries({ width: render.width, height: render.height, fps: render.fps, frames: render.frames })) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
      add({
        code: "HF-CONFIG-OUTPUT-CONTRACT",
        stage: "config",
        title: `输出合同缺少有效的 ${key}`,
        summary: `${key}=${String(value)}`,
        file: configPath,
      });
    }
  }
  if (command === "run" && typeof config.output === "string" && existsSync(resolve(config.output))) {
    add({
      code: "HF-CONFIG-OUTPUT-EXISTS",
      stage: "config",
      title: "目标输出已经存在",
      summary: "生产入口拒绝覆盖旧成片；请换新文件名或显式传 --output。",
      file: resolve(config.output),
    });
  }
  if (config.automaticFallback?.enabled === true && !config.authoringMotionContract) {
    add({
      code: "HF-MOTION-CONTRACT-MISSING",
      stage: "motion",
      title: "自动生产路由缺少作者动画契约",
      summary: "在用户批准的原生/Studio 动画版本上冻结契约后才能做兼容改造。",
      file: configPath,
    });
  }
}

async function verifyFrozenFiles(config, add) {
  if (config == null) return [];
  const verified = [];
  const entries = Object.entries(config.requiredFileSha256 ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (config.automaticFallback?.enabled === true && entries.length === 0) {
    add({
      code: "HF-CONFIG-FROZEN-FILES-MISSING",
      stage: "identity",
      title: "自动路由没有冻结工具链文件",
      summary: "requiredFileSha256 为空，无法证明 Electron、renderer、runtime 和时间计划身份。",
    });
    return verified;
  }
  for (const [configuredPath, expected] of entries) {
    const file = resolve(configuredPath);
    if (!isAbsolute(configuredPath) || !/^[a-f0-9]{64}$/.test(String(expected))) {
      add({
        code: "HF-CONFIG-FROZEN-FILE-INVALID",
        stage: "identity",
        title: "冻结文件条目格式错误",
        summary: `${configuredPath} -> ${String(expected)}`,
        file: configuredPath,
      });
      continue;
    }
    if (!existsSync(file) || !lstatSync(file).isFile()) {
      add({
        code: "HF-CONFIG-FROZEN-FILE-MISSING",
        stage: "identity",
        title: "冻结的工具链文件不存在",
        summary: file,
        file,
      });
      continue;
    }
    const observed = await fileSha256(file);
    if (observed !== expected) {
      add({
        code: "HF-CONFIG-FROZEN-FILE-CHANGED",
        stage: "identity",
        title: "冻结的工具链身份已变化",
        summary: basename(file),
        file,
        evidence: `expected=${expected} observed=${observed}`,
        detail: { expected, observed },
      });
      continue;
    }
    verified.push({ file, sha256: observed });
  }
  return verified;
}

function collectMotionIssues(config, projectRoot, configPath, add) {
  if (config?.authoringMotionContract == null) return null;
  try {
    const result = verifyMotionContract(projectRoot, config.authoringMotionContract);
    for (const message of result.errors) {
      const match = /^([^:]+):\s*(.*)$/.exec(message);
      add({
        code: "HF-MOTION-CONTRACT-REGRESSION",
        stage: "motion",
        title: "作者动画结构发生退化",
        summary: match?.[2] ?? message,
        file: match?.[1] ?? result.contractPath,
        evidence: message,
      });
    }
    for (const message of result.warnings) {
      const match = /^([^:]+):\s*(.*)$/.exec(message);
      add({
        code: "HF-MOTION-SOURCE-CHANGED",
        severity: "warning",
        stage: "motion",
        title: "动画源码已修改，结构计数暂未退化",
        summary: match?.[2] ?? message,
        file: match?.[1] ?? result.contractPath,
        evidence: message,
      });
    }
    return result;
  } catch (error) {
    add({
      code: "HF-MOTION-CONTRACT-INVALID",
      stage: "motion",
      title: "作者动画契约无法验证",
      summary: String(error.message ?? error),
      file: configPath,
    });
    return null;
  }
}

export function collectCompatibilityIssues(scan, add) {
  if (scan == null) return;
  const groups = new Map();
  for (const finding of scan.findings) {
    if (finding.severity === "info") continue;
    const key = `${finding.ruleId}\0${finding.file}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  for (const findings of groups.values()) {
    const first = findings[0];
    const lines = [...new Set(findings.map((finding) => finding.line))].sort((a, b) => a - b);
    add({
      code: `HF-COMPAT-${first.ruleId.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "-")}`,
      severity: first.severity === "blocker" ? "error" : "warning",
      stage: "compatibility",
      title: first.summary,
      summary: `${first.file} 报告采样 ${findings.length} 处；行 ${lines.join(", ")}`,
      file: first.file,
      line: lines[0] ?? null,
      evidence: findings.slice(0, 3).map((finding) => `L${finding.line}: ${finding.evidence}`).join(" | "),
      detail: { ruleId: first.ruleId, count: findings.length, lines },
    });
  }
}

function runCaptured(command, args, { cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

export function parseHyperframesJson(output) {
  for (let index = output.indexOf("{"); index !== -1; index = output.indexOf("{", index + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let cursor = index; cursor < output.length; cursor += 1) {
      const character = output[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      if (depth !== 0) continue;
      try {
        const value = JSON.parse(output.slice(index, cursor + 1));
        if (value != null && typeof value === "object" && "ok" in value) return value;
      } catch {
        // Log text can contain brace pairs; continue with the next opening brace.
      }
      break;
    }
  }
  return null;
}

function collectHyperframesFindings(result, add) {
  if (result == null) return;
  for (const sectionName of ["lint", "runtime", "layout", "motion", "contrast"]) {
    const section = result[sectionName];
    for (const finding of section?.findings ?? []) {
      const reviewInfo = finding.severity === "info" && LAYOUT_REVIEW_CODES.has(finding.code);
      if (finding.severity === "info" && !reviewInfo) continue;
      const severity = finding.severity === "error" ? "error" : "warning";
      add({
        code: reviewInfo
          ? `HF-LAYOUT-${finding.code.toUpperCase().replaceAll("_", "-")}`
          : `HF-HYPERFRAMES-${String(finding.code ?? sectionName).toUpperCase().replaceAll("_", "-")}`,
        severity,
        stage: `hyperframes-${sectionName}`,
        title: finding.message ?? `${sectionName} finding`,
        summary: finding.fixHint ?? finding.message ?? "HyperFrames check finding",
        file: finding.sourceFile ?? null,
        line: finding.line ?? null,
        time: finding.time ?? finding.firstSeen ?? null,
        selector: finding.selector ?? null,
        evidence: finding.rect == null ? null : JSON.stringify({ rect: finding.rect, overflow: finding.overflow }),
        detail: { hyperframesCode: finding.code, section: sectionName },
      });
    }
  }
}

async function runHyperframesCheck(projectRoot, add, runner = runCaptured) {
  const packagePath = resolve(projectRoot, "package.json");
  let command = null;
  let args = null;
  if (existsSync(packagePath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      if (packageJson.scripts?.check) {
        command = "npm";
        args = ["run", "check", "--", "--json"];
      }
    } catch {
      // The HyperFrames checker will surface an invalid project manifest.
    }
  }
  const localCli = resolve(projectRoot, "node_modules", ".bin", "hyperframes");
  if (command == null && existsSync(localCli)) {
    command = localCli;
    args = ["check", "--json"];
  }
  if (command == null) {
    add({
      code: "HF-HYPERFRAMES-CHECK-MISSING",
      stage: "hyperframes",
      title: "项目没有固定版本的 HyperFrames 检查入口",
      summary: "package.json 缺少 check 脚本，且 node_modules/.bin/hyperframes 不存在。",
      file: packagePath,
    });
    return null;
  }
  try {
    const run = await runner(command, args, { cwd: projectRoot });
    const parsed = parseHyperframesJson(`${run.stdout}\n${run.stderr}`);
    if (parsed == null) {
      add({
        code: "HF-HYPERFRAMES-CHECK-UNREADABLE",
        stage: "hyperframes",
        title: "HyperFrames 标准检查没有返回可解析 JSON",
        summary: `exit=${run.code}${run.signal ? ` signal=${run.signal}` : ""}`,
        evidence: `${run.stdout}\n${run.stderr}`.trim().slice(-1200),
      });
      return null;
    }
    collectHyperframesFindings(parsed, add);
    if (run.code !== 0 && parsed.ok !== false) {
      add({
        code: "HF-HYPERFRAMES-CHECK-FAILED",
        stage: "hyperframes",
        title: "HyperFrames 标准检查异常退出",
        summary: `exit=${run.code}${run.signal ? ` signal=${run.signal}` : ""}`,
      });
    }
    return parsed;
  } catch (error) {
    add({
      code: "HF-HYPERFRAMES-CHECK-FAILED",
      stage: "hyperframes",
      title: "无法启动 HyperFrames 标准检查",
      summary: String(error.message ?? error),
    });
    return null;
  }
}

function routeIssues(config, scan, configPath, add) {
  if (config == null || scan == null) return null;
  const acknowledgement = config.acknowledgedProjectScanSha256 ?? config.approvedProjectScanSha256;
  if ((config.acknowledgedRuleIds ?? config.approvedRuleIds ?? []).length > 0
      && acknowledgement !== scan.projectScanSha256) {
    add({
      code: "HF-ROUTE-ACKNOWLEDGEMENT-STALE",
      stage: "route",
      title: "兼容性审查身份已经过期",
      summary: "项目源码变化后，旧 acknowledgedProjectScanSha256 不能继续使用。",
      file: configPath,
      evidence: `configured=${String(acknowledgement)} current=${scan.projectScanSha256}`,
    });
  }
  try {
    const plan = buildDeliveryRoutePlan(config, scan);
    if (plan.selectedRoute === "faithful-screenshot") {
      add({
        code: "HF-ROUTE-FAITHFUL-SELECTED",
        severity: "warning",
        stage: "route",
        title: "当前计划将走忠实逐帧截图后端",
        summary: `reason=${plan.reason}; 这不是快速管线的预计耗时。`,
        file: configPath,
        evidence: JSON.stringify(plan),
      });
    }
    return plan;
  } catch (error) {
    const message = String(error.message ?? error);
    add({
      code: message.includes("allowWholeProjectScreenshotFallback")
        ? "HF-ROUTE-SLOW-FALLBACK-NOT-APPROVED"
        : "HF-ROUTE-PLAN-FAILED",
      stage: "route",
      title: message.includes("allowWholeProjectScreenshotFallback")
        ? "风险项会触发整片慢速回退，但没有成本批准"
        : "生产路由计划无法建立",
      summary: message,
      file: configPath,
    });
    return null;
  }
}

function countIssues(issues) {
  return {
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length,
  };
}

function reportStatus(command, counts, renderResult) {
  if (counts.errors > 0) return "blocked";
  if (command === "run" && renderResult != null) return "rendered";
  return "ready";
}

function reportMarkdown(report) {
  const lines = [
    "# HyperFrames AI render report",
    "",
    `- Status: **${report.status}**`,
    `- Project: \`${report.projectRoot}\``,
    `- Config: ${report.configPath == null ? "not found" : `\`${report.configPath}\``}`,
    `- Issues: ${report.counts.errors} errors, ${report.counts.warnings} warnings, ${report.counts.info} info`,
    `- Production route: ${report.routePlan?.selectedRoute ?? "unavailable"}`,
    `- Check elapsed: ${(Number(report.elapsedMs ?? 0) / 1000).toFixed(2)}s`,
    "",
  ];
  for (const issue of report.issues) {
    lines.push(`## [${issue.severity.toUpperCase()}] ${issue.code}`);
    lines.push("");
    lines.push(issue.title);
    lines.push("");
    lines.push(`- ID: \`${issue.id}\``);
    if (issue.location.file) lines.push(`- File: \`${issue.location.file}${issue.location.line ? `:${issue.location.line}` : ""}\``);
    if (issue.location.time != null) lines.push(`- Time: \`${issue.location.time}s\``);
    if (issue.location.selector) lines.push(`- Selector: \`${issue.location.selector}\``);
    lines.push(`- Problem: ${issue.summary}`);
    if (issue.evidence) lines.push(`- Evidence: \`${String(issue.evidence).replaceAll("`", "'")}\``);
    lines.push("");
    lines.push(`AI objective: ${issue.agent.goal}`);
    lines.push("");
    lines.push("Steps:");
    lines.push("");
    issue.agent.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push("");
    lines.push("Constraints:");
    lines.push("");
    issue.agent.constraints.forEach((constraint) => lines.push(`- ${constraint}`));
    lines.push("");
    lines.push(`Verify: \`${issue.agent.verify[0]}\``);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function writeReports(report, reportDirectory) {
  mkdirSync(reportDirectory, { recursive: true });
  const jsonPath = resolve(reportDirectory, "latest.json");
  const markdownPath = resolve(reportDirectory, "latest.md");
  const withPaths = { ...report, reportFiles: { json: jsonPath, markdown: markdownPath } };
  writeFileSync(jsonPath, `${JSON.stringify(withPaths, null, 2)}\n`);
  writeFileSync(markdownPath, reportMarkdown(withPaths));
  return withPaths;
}

function printHuman(report, { all = false } = {}) {
  const marker = report.status === "blocked" ? "BLOCKED" : report.status === "rendered" ? "DONE" : "READY";
  console.log(`[${marker}] HyperFrames ${report.command}: errors=${report.counts.errors} warnings=${report.counts.warnings}`);
  console.log(`project: ${report.projectRoot}`);
  if (report.configPath) console.log(`config:  ${report.configPath}`);
  if (report.routePlan) console.log(`route:   ${report.routePlan.selectedRoute} (${report.routePlan.reason})`);
  const visible = report.issues.filter((issue) => all || issue.severity !== "info");
  const limit = all ? visible.length : 24;
  for (const issue of visible.slice(0, limit)) {
    const location = issue.location.file
      ? ` ${issue.location.file}${issue.location.line ? `:${issue.location.line}` : ""}${issue.location.time != null ? ` @${issue.location.time}s` : ""}`
      : "";
    console.log(`\n${issue.severity.toUpperCase()} ${issue.code}${location}`);
    console.log(`  ${issue.title}`);
    console.log(`  问题: ${issue.summary}`);
    console.log(`  AI下一步: ${issue.agent.steps[0]}`);
  }
  if (visible.length > limit) console.log(`\n... ${visible.length - limit} more issues are in the report files.`);
  console.log(`\nJSON report: ${report.reportFiles.json}`);
  console.log(`AI guide:    ${report.reportFiles.markdown}`);
  if (report.status === "blocked") console.log(`下一步: 让 AI 按 latest.md 修复 error，再重复同一条 hf-render 命令。`);
  else if (report.command !== "run") console.log(`下一步: ${JSON.stringify(CLI_EXECUTABLE)} run ${JSON.stringify(report.projectRoot)}${report.configPath ? ` --config=${JSON.stringify(report.configPath)}` : ""}`);
}

export async function inspectProject({
  command = "check",
  projectRoot: requestedProjectRoot,
  configPath: requestedConfigPath = null,
  output = null,
  reportDirectory = null,
  hyperframesRunner = runCaptured,
} = {}) {
  const startedAt = Date.now();
  const projectRoot = realpathSync(resolve(requestedProjectRoot ?? process.cwd()));
  const configPath = discoverConfig(projectRoot, requestedConfigPath);
  const issues = [];
  const add = issueFactory({ projectRoot, configPath });
  const push = (issue) => {
    const normalized = add(issue);
    issues.push(normalized);
    return normalized;
  };
  const config = readConfig(configPath, push, command);
  if (config != null && output != null) config.output = resolve(output);
  validateConfig(config, projectRoot, configPath, push, command);
  const entry = config?.entry ?? "index.html";

  const hyperframes = await runHyperframesCheck(projectRoot, push, hyperframesRunner);
  const scan = await scanProject(projectRoot, {
    entry,
    acknowledgedRuleIds: config?.acknowledgedRuleIds ?? config?.approvedRuleIds ?? [],
  }).catch((error) => {
    push({
      code: "HF-COMPAT-SCAN-FAILED",
      stage: "compatibility",
      title: "兼容性扫描失败",
      summary: String(error.message ?? error),
      file: resolve(projectRoot, entry),
    });
    return null;
  });
  collectCompatibilityIssues(scan, push);
  const motionContract = collectMotionIssues(config, projectRoot, configPath, push);
  const frozenFiles = await verifyFrozenFiles(config, push);
  const routePlan = routeIssues(config, scan, configPath, push);

  let dryPlan = null;
  if (configPath != null && issues.every((issue) => !issue.blocking)) {
    try {
      dryPlan = await renderFromConfig(configPath, { dryRun: true, output });
    } catch (error) {
      push({
        code: "HF-ROUTE-DRY-PLAN-FAILED",
        stage: "route",
        title: "完整生产预检仍未通过",
        summary: String(error.message ?? error),
        file: configPath,
      });
    }
  }

  issues.sort((left, right) => {
    const rank = { error: 0, warning: 1, info: 2 };
    return rank[left.severity] - rank[right.severity]
      || left.code.localeCompare(right.code)
      || String(left.location.file ?? "").localeCompare(String(right.location.file ?? ""))
      || Number(left.location.line ?? 0) - Number(right.location.line ?? 0);
  });
  const counts = countIssues(issues);
  const report = {
    kind: REPORT_KIND,
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    command,
    status: reportStatus(command, counts, null),
    projectRoot,
    configPath,
    counts,
    renderReady: counts.errors === 0,
    checks: {
      hyperframes: hyperframes == null ? "failed" : hyperframes.ok ? "passed" : "failed",
      compatibility: scan == null ? "failed" : scan.blockerCount > 0 ? "blocked" : "passed-with-review",
      motion: config?.authoringMotionContract == null ? "missing" : motionContract?.passed ? "passed" : "failed",
      frozenFiles: config == null ? "unavailable" : `${frozenFiles.length}/${Object.keys(config.requiredFileSha256 ?? {}).length}`,
      dryPlan: dryPlan == null ? "not-available" : "passed",
    },
    compatibility: scan == null ? null : {
      projectScanSha256: scan.projectScanSha256,
      blockerCount: scan.blockerCount,
      reviewCount: scan.reviewCount,
      recommendedBackend: scan.recommendedBackend,
    },
    authoringMotion: motionContract == null ? null : {
      passed: motionContract.passed,
      contractPath: motionContract.contractPath,
      contractSha256: motionContract.contractSha256,
      baselineTotals: motionContract.baselineTotals,
      currentTotals: motionContract.currentTotals,
    },
    standardHyperframes: hyperframes == null ? null : {
      ok: hyperframes.ok,
      lint: {
        errors: hyperframes.lint?.errorCount ?? 0,
        warnings: hyperframes.lint?.warningCount ?? 0,
        info: hyperframes.lint?.infoCount ?? 0,
      },
      runtime: {
        errors: hyperframes.runtime?.errorCount ?? 0,
        warnings: hyperframes.runtime?.warningCount ?? 0,
      },
      layout: {
        issues: hyperframes.layout?.totalIssueCount ?? hyperframes.layout?.findings?.length ?? 0,
        samples: hyperframes.layout?.samples ?? [],
      },
    },
    frozenToolchain: config == null ? null : {
      verified: frozenFiles.length,
      expected: Object.keys(config.requiredFileSha256 ?? {}).length,
    },
    routePlan: dryPlan?.routePlan ?? routePlan,
    renderResult: null,
    issues,
  };
  return writeReports(report, resolve(reportDirectory ?? join(projectRoot, ".hyperframes", "render-agent")));
}

export async function execute(argv, dependencies = {}) {
  const parsed = parseArgs(argv);
  if (parsed.command === "help" || parsed.options.help === true) {
    usage();
    return { exitCode: 0, report: null };
  }
  if (parsed.extra.length > 0) throw new Error(`unexpected arguments: ${parsed.extra.join(" ")}`);
  const report = await inspectProject({
    command: parsed.command,
    projectRoot: parsed.projectRoot,
    configPath: typeof parsed.options.config === "string" ? parsed.options.config : null,
    output: typeof parsed.options.output === "string" ? parsed.options.output : null,
    reportDirectory: typeof parsed.options.report === "string" ? parsed.options.report : null,
    hyperframesRunner: dependencies.hyperframesRunner,
  });
  let finalReport = report;
  if (parsed.command === "run" && report.renderReady) {
    try {
      const renderResult = await renderFromConfig(report.configPath, {
        output: typeof parsed.options.output === "string" ? parsed.options.output : null,
      });
      finalReport = writeReports({
        ...report,
        generatedAt: new Date().toISOString(),
        status: "rendered",
        renderResult,
      }, dirname(report.reportFiles.json));
    } catch (error) {
      const add = issueFactory({ projectRoot: report.projectRoot, configPath: report.configPath });
      const renderIssue = add({
        code: "HF-RENDER-FAILED",
        stage: "render",
        title: "生产渲染或最终快速校验失败",
        summary: String(error.message ?? error),
        file: report.configPath,
      });
      const issues = [...report.issues, renderIssue];
      finalReport = writeReports({
        ...report,
        generatedAt: new Date().toISOString(),
        status: "blocked",
        counts: countIssues(issues),
        renderReady: false,
        issues,
      }, dirname(report.reportFiles.json));
    }
  }
  if (parsed.options.json === true) console.log(JSON.stringify(finalReport, null, 2));
  else printHuman(finalReport, { all: parsed.options.all === true });
  return { exitCode: finalReport.status === "blocked" ? 2 : 0, report: finalReport };
}

function usage() {
  console.log(`HyperFrames AI production CLI\n\nUsage:\n  hf-render [PROJECT] [--config FILE]\n  hf-render check [PROJECT] [--config FILE]\n  hf-render plan [PROJECT] [--config FILE]\n  hf-render run [PROJECT] [--config FILE] [--output MOV]\n\nDefaults:\n  command = check\n  PROJECT = current directory\n  config auto-detects .hyperframes/delivery.json, render-config.production.json, or render-config.final-4k60.json\n\nReports:\n  PROJECT/.hyperframes/render-agent/latest.json\n  PROJECT/.hyperframes/render-agent/latest.md\n\nOptions:\n  --json          print the machine-readable report\n  --all           print informational findings too\n  --report DIR    write reports outside the project`);
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  execute(process.argv.slice(2)).then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
