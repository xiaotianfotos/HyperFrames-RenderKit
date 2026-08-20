import { createHash } from "node:crypto";
import { parse } from "acorn";
import * as walk from "acorn-walk";

export const STATIC_SELECTOR_PROOF_KIND = "hyperframes-restricted-static-selector-proof";
export const STATIC_SELECTOR_PROOF_SCHEMA_VERSION = 1;
export const STATIC_SELECTOR_PROOF_CONTRACT = Object.freeze({
  parser: "acorn@8.18.0",
  evaluator: "literal-array-join-template-call-closure-v1",
  unknownPolicy: "fail-closed",
  maximumConcreteValues: 4096,
  maximumInvocations: 20000,
});

const DOM_SELECTOR_METHODS = new Set([
  "querySelector",
  "querySelectorAll",
  "matches",
  "closest",
  "getElementsByTagName",
  "createElement",
]);
const ANIMATION_SELECTOR_METHODS = new Set([
  "to",
  "from",
  "fromTo",
  "set",
  "quickTo",
  "quickSetter",
  "toArray",
]);
const CALLBACK_METHODS = new Set([
  "addEventListener",
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "queueMicrotask",
]);
const UNKNOWN = Object.freeze({ kind: "unknown" });

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function result(values, reason = null) {
  if (!Array.isArray(values)) return { known: false, values: [], reason: reason ?? "unknown" };
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const key = value?.kind === "function" ? `function:${value.id}` : canonical(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
    if (unique.length > STATIC_SELECTOR_PROOF_CONTRACT.maximumConcreteValues) {
      return { known: false, values: [], reason: "concrete-value-limit" };
    }
  }
  return { known: true, values: unique, reason: null };
}

function unknown(reason) {
  return { known: false, values: [], reason };
}

function merge(results, reason = "merged-unknown") {
  if (results.some((item) => !item.known)) {
    return unknown(results.find((item) => !item.known)?.reason ?? reason);
  }
  return result(results.flatMap((item) => item.values));
}

class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map();
  }

  set(name, value) {
    this.bindings.set(name, value);
  }

  get(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    return this.parent?.get(name) ?? unknown(`unbound:${name}`);
  }
}

function parseJavaScript(source, sourceLabel) {
  const options = {
    ecmaVersion: "latest",
    allowHashBang: true,
    locations: true,
    ranges: true,
  };
  try {
    return parse(source, { ...options, sourceType: "script" });
  } catch (scriptError) {
    try {
      return parse(source, { ...options, sourceType: "module" });
    } catch {
      throw new Error(`${sourceLabel} JavaScript parse failed: ${scriptError.message}`);
    }
  }
}

function memberName(node) {
  if (!node || node.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string") {
    return node.property.value;
  }
  return null;
}

function receiverName(node) {
  if (!node) return "";
  if (node.type === "ChainExpression") return receiverName(node.expression);
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    const left = receiverName(node.object);
    const right = memberName(node) ?? "?";
    return left ? `${left}.${right}` : right;
  }
  if (node.type === "CallExpression") return receiverName(node.callee);
  return "";
}

function selectorCallKind(node) {
  if (node?.type !== "CallExpression") return null;
  let callee = node.callee;
  if (callee.type === "ChainExpression") callee = callee.expression;
  if (callee.type !== "MemberExpression") return null;
  const method = memberName(callee);
  if (DOM_SELECTOR_METHODS.has(method)) return { kind: "dom", method };
  if (!ANIMATION_SELECTOR_METHODS.has(method)) return null;
  // Preserve the previous proxy-tree fail-closed boundary: any method with an
  // animation-target name is treated as selector-bearing unless the known
  // opaque runtime itself is explicitly exempted by the caller. This can
  // conservatively reject a custom Map-like `.set()`, but never lets an
  // unknown animation library bypass selector proof because of its receiver.
  return { kind: "animation", method, receiver: receiverName(callee.object) };
}

function crossProduct(parts) {
  let combinations = [[]];
  for (const values of parts) {
    const next = [];
    for (const prefix of combinations) {
      for (const value of values) {
        next.push([...prefix, value]);
        if (next.length > STATIC_SELECTOR_PROOF_CONTRACT.maximumConcreteValues) return null;
      }
    }
    combinations = next;
  }
  return combinations;
}

function evaluator(scope) {
  const evaluate = (node) => {
    if (!node) return result([undefined]);
    if (node.type === "ChainExpression") return evaluate(node.expression);
    if (node.type === "Literal") return result([node.value]);
    if (node.type === "Identifier") {
      if (node.name === "undefined") return result([undefined]);
      return scope.get(node.name);
    }
    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      return result([functionValue(node, scope, "<inline>")]);
    }
    if (node.type === "TemplateLiteral") {
      const expressions = node.expressions.map(evaluate);
      if (expressions.some((item) => !item.known)) {
        return unknown(`template:${expressions.find((item) => !item.known)?.reason}`);
      }
      const combinations = crossProduct(expressions.map((item) => item.values));
      if (!combinations) return unknown("template-value-limit");
      return result(combinations.map((values) => {
        let output = node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw ?? "";
        for (let index = 0; index < values.length; index += 1) {
          output += String(values[index]);
          output += node.quasis[index + 1]?.value.cooked ?? node.quasis[index + 1]?.value.raw ?? "";
        }
        return output;
      }));
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      if (!left.known || !right.known) return unknown(`binary:${left.reason ?? right.reason}`);
      const combinations = crossProduct([left.values, right.values]);
      if (!combinations) return unknown("binary-value-limit");
      return result(combinations.map(([a, b]) => a + b));
    }
    if (node.type === "LogicalExpression") {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      if (!left.known || !right.known) return unknown(`logical:${left.reason ?? right.reason}`);
      const values = [];
      for (const value of left.values) {
        if (node.operator === "||") {
          if (value) values.push(value);
          else values.push(...right.values);
        } else if (node.operator === "&&") {
          if (!value) values.push(value);
          else values.push(...right.values);
        } else if (node.operator === "??") {
          if (value != null) values.push(value);
          else values.push(...right.values);
        }
      }
      return result(values);
    }
    if (node.type === "ConditionalExpression") {
      return merge([evaluate(node.consequent), evaluate(node.alternate)], "conditional-unknown");
    }
    if (node.type === "UnaryExpression") {
      const argument = evaluate(node.argument);
      if (!argument.known) return argument;
      return result(argument.values.map((value) => {
        if (node.operator === "+") return +value;
        if (node.operator === "-") return -value;
        if (node.operator === "!") return !value;
        if (node.operator === "void") return undefined;
        return UNKNOWN;
      }).filter((value) => value !== UNKNOWN));
    }
    if (node.type === "ArrayExpression") {
      const elements = node.elements.map((item) => item ? evaluate(item) : result([undefined]));
      if (elements.some((item) => !item.known)) {
        return unknown(`array:${elements.find((item) => !item.known)?.reason}`);
      }
      const combinations = crossProduct(elements.map((item) => item.values));
      return combinations ? result(combinations) : unknown("array-value-limit");
    }
    if (node.type === "ObjectExpression") {
      const keys = [];
      const values = [];
      for (const property of node.properties) {
        if (property.type !== "Property" || property.kind !== "init" || property.computed) {
          return unknown("object-nonstatic-property");
        }
        const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
        const value = evaluate(property.value);
        if (!value.known) return unknown(`object:${value.reason}`);
        keys.push(String(key));
        values.push(value.values);
      }
      const combinations = crossProduct(values);
      if (!combinations) return unknown("object-value-limit");
      return result(combinations.map((items) => Object.fromEntries(keys.map((key, index) => [key, items[index]]))));
    }
    if (node.type === "MemberExpression") {
      const object = evaluate(node.object);
      let property;
      if (!node.computed && node.property.type === "Identifier") property = result([node.property.name]);
      else property = evaluate(node.property);
      if (!object.known || !property.known) return unknown(`member:${object.reason ?? property.reason}`);
      const combinations = crossProduct([object.values, property.values]);
      if (!combinations) return unknown("member-value-limit");
      const values = [];
      for (const [container, key] of combinations) {
        if (container == null || !(typeof container === "object" || typeof container === "string")) {
          return unknown("member-nonstatic-object");
        }
        values.push(container[key]);
      }
      return result(values);
    }
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression"
        && memberName(node.callee) === "join") {
      const object = evaluate(node.callee.object);
      const separator = evaluate(node.arguments[0]);
      if (!object.known || !separator.known) return unknown(`join:${object.reason ?? separator.reason}`);
      const combinations = crossProduct([object.values, separator.values]);
      if (!combinations) return unknown("join-value-limit");
      const values = [];
      for (const [items, delimiter] of combinations) {
        if (!Array.isArray(items) || typeof delimiter !== "string") return unknown("join-nonstatic-input");
        if (items.some((item) => !["string", "number", "boolean"].includes(typeof item))) {
          return unknown("join-nonprimitive-element");
        }
        values.push(items.join(delimiter));
      }
      return result(values);
    }
    return unknown(`unsupported-expression:${node.type}`);
  };
  return evaluate;
}

function bindPattern(pattern, abstractValue, scope) {
  if (!pattern) return;
  if (pattern.type === "Identifier") {
    scope.set(pattern.name, abstractValue);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    const fallback = evaluator(scope)(pattern.right);
    const supplied = abstractValue.known
      ? result(abstractValue.values.filter((value) => value !== undefined))
      : abstractValue;
    bindPattern(pattern.left, supplied.known && supplied.values.length ? supplied : fallback, scope);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    if (!abstractValue.known || abstractValue.values.some((value) => !Array.isArray(value))) {
      for (const item of pattern.elements) bindPattern(item, unknown("array-destructure-unknown"), scope);
      return;
    }
    for (let index = 0; index < pattern.elements.length; index += 1) {
      bindPattern(pattern.elements[index], result(abstractValue.values.map((value) => value[index])), scope);
    }
    return;
  }
  if (pattern.type === "ObjectPattern") {
    if (!abstractValue.known || abstractValue.values.some((value) => value == null || typeof value !== "object")) {
      for (const item of pattern.properties) bindPattern(item.value, unknown("object-destructure-unknown"), scope);
      return;
    }
    for (const item of pattern.properties) {
      if (item.type !== "Property") continue;
      const key = item.key.type === "Identifier" ? item.key.name : item.key.value;
      bindPattern(item.value, result(abstractValue.values.map((value) => value[key])), scope);
    }
  }
}

function functionValue(node, closure, sourceLabel) {
  return {
    kind: "function",
    id: `${sourceLabel}:${node.start}:${node.end}`,
    node,
    closure,
  };
}

export function proveStaticSelectorTargets({ source, sourceLabel = "<javascript>" } = {}) {
  const text = String(source ?? "");
  const ast = parseJavaScript(text, sourceLabel);
  const targetNodes = new Set();
  walk.full(ast, (node) => {
    if (selectorCallKind(node)) targetNodes.add(node);
  });

  const seenTargets = new Set();
  const targetValues = new Map();
  const blockers = [];
  const invocationStack = new Set();
  let invocationCount = 0;

  const location = (node) => ({
    start: node.start,
    end: node.end,
    line: node.loc?.start?.line ?? 0,
    column: node.loc?.start?.column ?? 0,
    expression: text.slice(node.start, node.end),
  });
  const addBlocker = (node, reason, details = {}) => {
    blockers.push({ reason, ...location(node), ...details });
  };

  const invoke = (fn, argumentValues, callNode) => {
    invocationCount += 1;
    if (invocationCount > STATIC_SELECTOR_PROOF_CONTRACT.maximumInvocations) {
      addBlocker(callNode, "invocation-limit");
      return;
    }
    if (invocationStack.has(fn.id)) {
      addBlocker(callNode, "recursive-selector-flow", { functionId: fn.id });
      return;
    }
    invocationStack.add(fn.id);
    const callScope = new Scope(fn.closure);
    for (let index = 0; index < fn.node.params.length; index += 1) {
      bindPattern(fn.node.params[index], argumentValues[index] ?? result([undefined]), callScope);
    }
    if (fn.node.body.type === "BlockStatement") processBlock(fn.node.body.body, callScope);
    else visitExpression(fn.node.body, callScope);
    invocationStack.delete(fn.id);
  };

  const processSelectorCall = (node, scope) => {
    const kind = selectorCallKind(node);
    if (!kind) return false;
    seenTargets.add(node);
    const selected = evaluator(scope)(node.arguments[0]);
    if (!selected.known || !selected.values.length
        || selected.values.some((value) => typeof value !== "string" || !value.trim())) {
      addBlocker(node, "selector-not-static", {
        method: kind.method,
        selectorKind: kind.kind,
        evaluationReason: selected.reason,
      });
      return true;
    }
    const values = targetValues.get(node) ?? new Set();
    for (const value of selected.values) values.add(value);
    targetValues.set(node, values);
    return true;
  };

  const processCall = (node, scope) => {
    processSelectorCall(node, scope);
    const evaluate = evaluator(scope);
    let callee = node.callee;
    if (callee.type === "ChainExpression") callee = callee.expression;
    const method = callee.type === "MemberExpression" ? memberName(callee) : null;
    if (method === "forEach" && callee.type === "MemberExpression") {
      const collection = evaluate(callee.object);
      const callback = evaluate(node.arguments[0]);
      if (!collection.known || !callback.known
          || collection.values.some((value) => !Array.isArray(value))
          || callback.values.some((value) => value?.kind !== "function")) {
        addBlocker(node, "for-each-not-static", {
          collectionReason: collection.reason,
          callbackReason: callback.reason,
        });
        return;
      }
      for (const list of collection.values) {
        for (let index = 0; index < list.length; index += 1) {
          for (const fn of callback.values) {
            invoke(fn, [result([list[index]]), result([index]), result([list])], node);
          }
        }
      }
      return;
    }
    const direct = evaluate(callee);
    if (direct.known && direct.values.some((value) => value?.kind === "function")) {
      const arguments_ = node.arguments.map((item) => evaluate(item));
      for (const fn of direct.values.filter((value) => value?.kind === "function")) {
        invoke(fn, arguments_, node);
      }
    }
    const callbackMethod = callee.type === "Identifier" ? callee.name : method;
    if (CALLBACK_METHODS.has(callbackMethod)) {
      const callbackIndex = callbackMethod === "addEventListener" ? 1 : 0;
      const callback = evaluate(node.arguments[callbackIndex]);
      if (callback.known) {
        for (const fn of callback.values.filter((value) => value?.kind === "function")) {
          invoke(fn, [unknown("runtime-callback-argument")], node);
        }
      }
    }
  };

  const visitExpression = (node, scope) => {
    if (!node) return;
    if (node.type === "ChainExpression") {
      visitExpression(node.expression, scope);
      return;
    }
    if (node.type === "CallExpression") {
      processCall(node, scope);
      visitExpression(node.callee, scope);
      for (const argument of node.arguments) {
        if (argument.type !== "FunctionExpression" && argument.type !== "ArrowFunctionExpression") {
          visitExpression(argument, scope);
        }
      }
      return;
    }
    if (node.type === "AssignmentExpression") {
      visitExpression(node.right, scope);
      if (node.left.type === "Identifier") scope.set(node.left.name, evaluator(scope)(node.right));
      else visitExpression(node.left, scope);
      return;
    }
    if (node.type === "UpdateExpression") return;
    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return;
    if (node.type === "MemberExpression") {
      visitExpression(node.object, scope);
      if (node.computed) visitExpression(node.property, scope);
      return;
    }
    if (node.type === "ConditionalExpression") {
      visitExpression(node.test, scope);
      visitExpression(node.consequent, new Scope(scope));
      visitExpression(node.alternate, new Scope(scope));
      return;
    }
    if (node.type === "LogicalExpression" || node.type === "BinaryExpression") {
      visitExpression(node.left, scope);
      visitExpression(node.right, scope);
      return;
    }
    if (node.type === "UnaryExpression" || node.type === "AwaitExpression") {
      visitExpression(node.argument, scope);
      return;
    }
    if (node.type === "SequenceExpression") {
      for (const expression of node.expressions) visitExpression(expression, scope);
      return;
    }
    if (node.type === "ArrayExpression") {
      for (const element of node.elements) visitExpression(element, scope);
      return;
    }
    if (node.type === "ObjectExpression") {
      for (const property of node.properties) {
        if (property.type === "Property") visitExpression(property.value, scope);
        else if (property.argument) visitExpression(property.argument, scope);
      }
      return;
    }
    if (node.type === "TaggedTemplateExpression") {
      addBlocker(node, "tagged-template-unsupported");
    }
  };

  const processStatement = (node, scope) => {
    if (!node) return;
    if (node.type === "BlockStatement") {
      processBlock(node.body, new Scope(scope));
      return;
    }
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        visitExpression(declaration.init, scope);
        bindPattern(declaration.id, evaluator(scope)(declaration.init), scope);
      }
      return;
    }
    if (node.type === "ExpressionStatement") {
      visitExpression(node.expression, scope);
      return;
    }
    if (node.type === "IfStatement") {
      visitExpression(node.test, scope);
      processStatement(node.consequent, new Scope(scope));
      processStatement(node.alternate, new Scope(scope));
      return;
    }
    if (node.type === "ReturnStatement" || node.type === "ThrowStatement") {
      visitExpression(node.argument, scope);
      return;
    }
    if (node.type === "ForOfStatement") {
      const collection = evaluator(scope)(node.right);
      if (!collection.known || collection.values.some((value) => !Array.isArray(value))) {
        const loopScope = new Scope(scope);
        const pattern = node.left.type === "VariableDeclaration" ? node.left.declarations[0]?.id : node.left;
        bindPattern(pattern, unknown("for-of-not-static"), loopScope);
        processStatement(node.body, loopScope);
        return;
      }
      for (const list of collection.values) {
        for (const value of list) {
          const loopScope = new Scope(scope);
          const pattern = node.left.type === "VariableDeclaration" ? node.left.declarations[0]?.id : node.left;
          bindPattern(pattern, result([value]), loopScope);
          processStatement(node.body, loopScope);
        }
      }
      return;
    }
    if (node.type === "ForStatement" || node.type === "WhileStatement" || node.type === "DoWhileStatement") {
      if (node.init?.type === "VariableDeclaration") processStatement(node.init, scope);
      else visitExpression(node.init, scope);
      visitExpression(node.test, scope);
      processStatement(node.body, new Scope(scope));
      visitExpression(node.update, scope);
      return;
    }
    if (node.type === "TryStatement") {
      processStatement(node.block, new Scope(scope));
      processStatement(node.handler?.body, new Scope(scope));
      processStatement(node.finalizer, new Scope(scope));
      return;
    }
    if (node.type === "SwitchStatement") {
      visitExpression(node.discriminant, scope);
      for (const item of node.cases) processBlock(item.consequent, new Scope(scope));
      return;
    }
    if (node.type === "LabeledStatement") processStatement(node.body, scope);
  };

  const processBlock = (statements, scope) => {
    for (const statement of statements) {
      if (statement.type === "FunctionDeclaration" && statement.id) {
        scope.set(statement.id.name, result([functionValue(statement, scope, sourceLabel)]));
      }
    }
    for (const statement of statements) {
      if (statement.type !== "FunctionDeclaration" && statement.type !== "EmptyStatement") {
        processStatement(statement, scope);
      }
    }
  };

  const rootScope = new Scope();
  processBlock(ast.body, rootScope);
  for (const node of targetNodes) {
    if (!seenTargets.has(node)) addBlocker(node, "selector-call-not-reached-by-static-flow");
  }

  const targets = [...targetValues.entries()].map(([node, values]) => {
    const kind = selectorCallKind(node);
    return {
      ...location(node),
      selectorKind: kind.kind,
      method: kind.method,
      selectors: [...values].sort(),
    };
  }).sort((left, right) => left.start - right.start);
  const normalizedBlockers = [...new Map(blockers.map((item) => [canonical(item), item])).values()]
    .sort((left, right) => left.start - right.start || left.reason.localeCompare(right.reason));
  const sourceSha256 = `sha256:${sha256(text)}`;
  const core = {
    kind: STATIC_SELECTOR_PROOF_KIND,
    schemaVersion: STATIC_SELECTOR_PROOF_SCHEMA_VERSION,
    contract: STATIC_SELECTOR_PROOF_CONTRACT,
    sourceLabel,
    sourceSha256,
    targets,
    blockers: normalizedBlockers,
    eligible: normalizedBlockers.length === 0,
  };
  return {
    ...core,
    proofIdentity: `sha256:${sha256(canonical(core))}`,
  };
}
