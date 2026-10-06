// Compiles an After Effects expression into a sandboxed JavaScript function.
//
// The source is parsed with acorn and rebuilt node by node from an allowlist,
// then printed with astring and compiled with `new Function` in strict mode:
//
// - every identifier the expression declares is renamed `v_<name>`; every free
//   identifier becomes a lookup in the expression API (`$$a.x`, `$$c.x`,
//   `thisLayer`/`thisProperty` attributes) or a ReferenceError, so the
//   compiled code names no global at all;
// - every member read, write, call and delete goes through the guards in
//   sandbox.ts, which refuse prototype and constructor chains and writes to
//   functions;
// - `+ - * /` and unary minus become vector-aware helpers, the way AE's
//   JavaScript engine (and the legacy ExtendScript engine, natively) treats
//   arrays;
// - the value of the last evaluated expression statement is the result, as
//   with AE's script completion values;
// - loops share an iteration budget.
//
// The printed code is parsed again and checked independently (verifyOutput):
// it may only name the helper parameters, renamed bindings and `arguments`,
// and member expressions may only read fixed names off the helper objects.
import { parse } from "acorn";
import { generate } from "astring";

/** An ESTree node; acorn's own types are too narrow for a generic rewriter. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export class ExpressionSyntaxError extends Error {
  override name = "SyntaxError";
}

export class ExpressionSecurityError extends Error {
  override name = "SecurityError";
}

/** Property names expressions may never read or write: they lead to constructors and prototypes. */
export const DENIED_KEYS: ReadonlySet<string> = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "caller",
  "callee",
  "arguments",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** Names resolved against the per-evaluation context (`$$c`). */
export const CONTEXT_NAMES: ReadonlySet<string> = new Set([
  "time",
  "value",
  "thisComp",
  "thisLayer",
  "thisProperty",
  "thisProject",
  "colorDepth",
  "this_comp",
  "this_layer",
  "this_property",
]);

/** Free names AE resolves against `thisProperty`. */
export const PROPERTY_NAMES: ReadonlySet<string> = new Set([
  "velocity",
  "speed",
  "numKeys",
  "key",
  "nearestKey",
  "valueAtTime",
  "velocityAtTime",
  "speedAtTime",
  "wiggle",
  "temporalWiggle",
  "smooth",
  "loopIn",
  "loopOut",
  "loopInDuration",
  "loopOutDuration",
  "propertyGroup",
  "propertyIndex",
  "points",
  "inTangents",
  "outTangents",
  "isClosed",
  "pointOnPath",
  "tangentOnPath",
  "normalOnPath",
]);

/** Free names AE resolves against `thisLayer`. */
export const LAYER_NAMES: ReadonlySet<string> = new Set([
  "name",
  "index",
  "parent",
  "hasParent",
  "inPoint",
  "outPoint",
  "startTime",
  "hasVideo",
  "hasAudio",
  "active",
  "enabled",
  "audioActive",
  "width",
  "height",
  "source",
  "transform",
  "anchorPoint",
  "position",
  "xPosition",
  "yPosition",
  "zPosition",
  "scale",
  "rotation",
  "xRotation",
  "yRotation",
  "zRotation",
  "orientation",
  "opacity",
  "effect",
  "mask",
  "content",
  "text",
  "marker",
  "timeRemap",
  "audioLevels",
  "cameraOption",
  "lightOption",
  "materialOption",
  "toComp",
  "fromComp",
  "toWorld",
  "fromWorld",
  "toCompVec",
  "fromCompVec",
  "toWorldVec",
  "fromWorldVec",
  "fromCompToSurface",
  "sourceRectAtTime",
  "sourceTime",
  "sampleImage",
]);

const MAX_LOOP_ITERATIONS = 10_000_000;

export interface CompiledExpression {
  /** Runs the expression: `(helpers, api, context) => completion value`. */
  run: (helpers: unknown, api: unknown, context: unknown) => unknown;
  /** The generated JavaScript (for diagnostics and tests). */
  code: string;
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

const id = (name: string): N => ({ type: "Identifier", name });
const lit = (value: string | number | boolean | null): N => ({ type: "Literal", value });
const member = (object: N, name: string): N => ({ type: "MemberExpression", object, property: id(name), computed: false, optional: false });
const call = (callee: N, args: N[]): N => ({ type: "CallExpression", callee, arguments: args, optional: false });
const helper = (name: string, args: N[]): N => call(member(id("$$h"), name), args);
const assign = (left: N, right: N, operator = "="): N => ({ type: "AssignmentExpression", operator, left, right });
const stmt = (expression: N): N => ({ type: "ExpressionStatement", expression });
const voidZero = (): N => ({ type: "UnaryExpression", operator: "void", prefix: true, argument: lit(0) });
const arrayOf = (elements: N[]): N => ({ type: "ArrayExpression", elements });

const VECTOR_OPS: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "div" };
const VECTOR_ASSIGN: Record<string, string> = { "+=": "add", "-=": "sub", "*=": "mul", "/=": "div" };

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

class Scope {
  readonly names = new Set<string>();
  readonly parent: Scope | null;
  readonly kind: "program" | "function" | "arrow" | "block";
  constructor(kind: Scope["kind"], parent: Scope | null) {
    this.kind = kind;
    this.parent = parent;
  }
  /** The nearest scope that `var` declarations land in. */
  get functionScope(): Scope {
    let s: Scope = this;
    while (s.kind === "block") s = s.parent!;
    return s;
  }
}

type Resolution = { kind: "local" } | { kind: "arguments" } | { kind: "free" };

function resolve(scope: Scope, name: string): Resolution {
  for (let s: Scope | null = scope; s; s = s.parent) {
    if (s.names.has(name)) return { kind: "local" };
    if (name === "arguments" && s.kind === "function") return { kind: "arguments" };
  }
  return { kind: "free" };
}

function patternNames(pattern: N, out: string[] = []): string[] {
  if (!pattern) return out;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const p of pattern.properties) patternNames(p.type === "RestElement" ? p.argument : p.value, out);
      break;
    case "ArrayPattern":
      for (const e of pattern.elements) if (e) patternNames(e, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
  }
  return out;
}

/** `var` names and top-level function declarations of a function body, not entering nested functions. */
function hoistedNames(statements: N[], scope: Scope): void {
  const visit = (node: N, topLevel: boolean) => {
    if (!node) return;
    switch (node.type) {
      case "VariableDeclaration":
        if (node.kind === "var") for (const d of node.declarations) for (const n of patternNames(d.id)) scope.names.add(n);
        break;
      case "FunctionDeclaration":
        if (topLevel) scope.names.add(node.id.name);
        break;
      case "IfStatement":
        visit(node.consequent, false);
        visit(node.alternate, false);
        break;
      case "BlockStatement":
        node.body.forEach((s: N) => visit(s, false));
        break;
      case "ForStatement":
        visit(node.init, false);
        visit(node.body, false);
        break;
      case "ForInStatement":
      case "ForOfStatement":
        visit(node.left, false);
        visit(node.body, false);
        break;
      case "WhileStatement":
      case "DoWhileStatement":
      case "LabeledStatement":
        visit(node.body, false);
        break;
      case "TryStatement":
        visit(node.block, false);
        if (node.handler) visit(node.handler.body, false);
        visit(node.finalizer, false);
        break;
      case "SwitchStatement":
        for (const c of node.cases) c.consequent.forEach((s: N) => visit(s, false));
        break;
    }
  };
  statements.forEach((s) => visit(s, true));
}

/** let/const/class (and, in strict code, function) declarations directly in a statement list. */
function lexicalNames(statements: N[], scope: Scope): void {
  for (const s of statements) {
    if (s.type === "VariableDeclaration" && s.kind !== "var") for (const d of s.declarations) for (const n of patternNames(d.id)) scope.names.add(n);
    else if (s.type === "ClassDeclaration") scope.names.add(s.id.name);
    else if (s.type === "FunctionDeclaration" && scope.kind === "block") scope.names.add(s.id.name);
  }
}

// ---------------------------------------------------------------------------
// The rewriter
// ---------------------------------------------------------------------------

interface Options {
  /** Names the expression assigns without declaring (AE's implicit globals). */
  implicit: Set<string>;
  /** Collect mode: only records implicit globals; the output is discarded. */
  collect: boolean;
  /** Legacy ExtendScript engine: a top-level `this` is thisLayer. */
  legacy?: boolean;
}

class Rewriter {
  private scope: Scope;
  private readonly options: Options;
  /** Statements at this depth contribute the completion value. */
  private completion = true;
  readonly program: Scope;

  constructor(options: Options) {
    this.options = options;
    this.program = new Scope("program", null);
    this.scope = this.program;
  }

  private fail(node: N, message: string): never {
    throw new ExpressionSyntaxError(`${message}${node?.start !== undefined ? ` (at character ${node.start})` : ""}`);
  }

  private deny(node: N, key: string): never {
    throw new ExpressionSecurityError(`access to "${key}" is not allowed in expressions${node?.start !== undefined ? ` (at character ${node.start})` : ""}`);
  }

  private withScope<T>(scope: Scope, fn: () => T): T {
    const saved = this.scope;
    this.scope = scope;
    try {
      return fn();
    } finally {
      this.scope = saved;
    }
  }

  private withCompletion<T>(on: boolean, fn: () => T): T {
    const saved = this.completion;
    this.completion = on;
    try {
      return fn();
    } finally {
      this.completion = saved;
    }
  }

  // --- identifiers -----------------------------------------------------------

  private binding(name: string): N {
    return id(`v_${name}`);
  }

  /** A free name: the expression API, or a ReferenceError at run time. */
  private freeName(name: string): N {
    if (name === "undefined") return voidZero();
    if (name === "NaN") return { type: "BinaryExpression", operator: "/", left: lit(0), right: lit(0) };
    if (name === "Infinity") return { type: "BinaryExpression", operator: "/", left: lit(1), right: lit(0) };
    if (CONTEXT_NAMES.has(name)) return member(id("$$c"), name);
    if (PROPERTY_NAMES.has(name)) return helper("get", [member(id("$$c"), "thisProperty"), lit(name)]);
    if (LAYER_NAMES.has(name)) return helper("get", [member(id("$$c"), "thisLayer"), lit(name)]);
    return helper("free", [id("$$a"), lit(name)]);
  }

  private reference(node: N): N {
    const name: string = node.name;
    const r = resolve(this.scope, name);
    if (r.kind === "local") return this.binding(name);
    if (r.kind === "arguments") return id("arguments");
    return this.freeName(name);
  }

  /** An identifier being assigned; undeclared ones become implicit globals. */
  private target(node: N): N {
    const r = resolve(this.scope, node.name);
    if (r.kind === "arguments") this.fail(node, "assigning to arguments is not allowed");
    if (r.kind === "free") {
      this.options.implicit.add(node.name);
      if (!this.options.collect) this.fail(node, `internal: unresolved assignment to ${node.name}`);
    }
    return this.binding(node.name);
  }

  // --- statements ------------------------------------------------------------

  rewriteProgram(ast: N): N[] {
    hoistedNames(ast.body, this.program);
    lexicalNames(ast.body, this.program);
    for (const name of this.options.implicit) this.program.names.add(name);
    return this.statements(ast.body);
  }

  private statements(list: N[]): N[] {
    const out: N[] = [];
    for (const s of list) {
      const r = this.statement(s);
      if (Array.isArray(r)) out.push(...r);
      else if (r) out.push(r);
    }
    return out;
  }

  private block(node: N, extra?: (scope: Scope) => void): N {
    const scope = new Scope("block", this.scope);
    extra?.(scope);
    lexicalNames(node.body, scope);
    return this.withScope(scope, () => ({ type: "BlockStatement", body: this.statements(node.body) }));
  }

  /** A statement in a position that may hold a single statement (if/loop bodies). */
  private body(node: N): N {
    if (node.type === "BlockStatement") return this.block(node);
    const r = this.statement(node);
    if (Array.isArray(r)) return { type: "BlockStatement", body: r };
    return r ?? { type: "EmptyStatement" };
  }

  private loopBody(node: N): N {
    const body = this.body(node);
    const check: N = {
      type: "IfStatement",
      test: { type: "BinaryExpression", operator: ">", left: { type: "UpdateExpression", operator: "++", prefix: true, argument: id("$$n") }, right: lit(MAX_LOOP_ITERATIONS) },
      consequent: stmt(helper("budget", [])),
      alternate: null,
    };
    return { type: "BlockStatement", body: [check, ...(body.type === "BlockStatement" ? body.body : [body])] };
  }

  /** Statements whose own completion value starts as undefined (if, loops, switch, try). */
  private resetting(node: N): N | N[] {
    return this.completion ? [stmt(assign(id("$$r"), voidZero())), node] : node;
  }

  private statement(node: N): N | N[] | null {
    switch (node.type) {
      case "ExpressionStatement": {
        const e = this.expr(node.expression);
        return stmt(this.completion ? assign(id("$$r"), e) : e);
      }
      case "EmptyStatement":
      case "DebuggerStatement":
        return null;
      case "BlockStatement":
        return this.block(node);
      case "VariableDeclaration":
        return this.declaration(node);
      case "FunctionDeclaration":
        return this.fn(node, true);
      case "ClassDeclaration":
        return this.cls(node);
      case "ReturnStatement":
        return { type: "ReturnStatement", argument: node.argument ? this.expr(node.argument) : null };
      case "IfStatement":
        return this.resetting({ type: "IfStatement", test: this.expr(node.test), consequent: this.body(node.consequent), alternate: node.alternate ? this.body(node.alternate) : null });
      case "LabeledStatement": {
        // The completion reset goes before the label so `continue label` still names a loop.
        const inner = node.body.type === "BlockStatement" ? this.block(node.body) : this.statement(node.body);
        const label = id(node.label.name);
        if (Array.isArray(inner)) return [...inner.slice(0, -1), { type: "LabeledStatement", label, body: inner[inner.length - 1] }];
        return { type: "LabeledStatement", label, body: inner ?? { type: "EmptyStatement" } };
      }
      case "BreakStatement":
      case "ContinueStatement":
        return { type: node.type, label: node.label ? id(node.label.name) : null };
      case "ThrowStatement":
        return { type: "ThrowStatement", argument: this.expr(node.argument) };
      case "WhileStatement":
        return this.resetting({ type: "WhileStatement", test: this.expr(node.test), body: this.loopBody(node.body) });
      case "DoWhileStatement":
        return this.resetting({ type: "DoWhileStatement", body: this.loopBody(node.body), test: this.expr(node.test) });
      case "ForStatement": {
        const scope = new Scope("block", this.scope);
        if (node.init?.type === "VariableDeclaration" && node.init.kind !== "var") for (const d of node.init.declarations) for (const n of patternNames(d.id)) scope.names.add(n);
        return this.resetting(
          this.withScope(scope, () => ({
            type: "ForStatement",
            init: node.init ? (node.init.type === "VariableDeclaration" ? this.declaration(node.init) : this.expr(node.init)) : null,
            test: node.test ? this.expr(node.test) : null,
            update: node.update ? this.expr(node.update) : null,
            body: this.loopBody(node.body),
          })),
        );
      }
      case "ForInStatement":
      case "ForOfStatement": {
        if (node.await) this.fail(node, "for await is not supported");
        const scope = new Scope("block", this.scope);
        if (node.left.type === "VariableDeclaration" && node.left.kind !== "var") for (const d of node.left.declarations) for (const n of patternNames(d.id)) scope.names.add(n);
        return this.resetting(
          this.withScope(scope, () => ({
            type: node.type,
            left: node.left.type === "VariableDeclaration" ? this.declaration(node.left) : this.pattern(node.left, true),
            right: this.expr(node.right),
            body: this.loopBody(node.body),
          })),
        );
      }
      case "SwitchStatement": {
        const discriminant = this.expr(node.discriminant);
        const scope = new Scope("block", this.scope);
        lexicalNames(node.cases.flatMap((c: N) => c.consequent), scope);
        return this.resetting(
          this.withScope(scope, () => ({
            type: "SwitchStatement",
            discriminant,
            cases: node.cases.map((c: N) => ({ type: "SwitchCase", test: c.test ? this.expr(c.test) : null, consequent: this.statements(c.consequent) })),
          })),
        );
      }
      case "TryStatement": {
        const block = this.block(node.block);
        let handler: N = null;
        if (node.handler) {
          const param = node.handler.param;
          handler = {
            type: "CatchClause",
            param: null,
            body: null,
          };
          const scope = new Scope("block", this.scope);
          for (const n of patternNames(param)) scope.names.add(n);
          this.withScope(scope, () => {
            handler.param = param ? this.pattern(param, false) : null;
            handler.body = this.block(node.handler.body);
          });
        }
        const finalizer = node.finalizer ? this.withCompletion(false, () => this.block(node.finalizer)) : null;
        return this.resetting({ type: "TryStatement", block, handler, finalizer });
      }
      case "WithStatement":
        return this.fail(node, "with statements are not supported");
      default:
        return this.fail(node, `${node.type} is not supported in expressions`);
    }
  }

  private declaration(node: N): N {
    return {
      type: "VariableDeclaration",
      kind: node.kind,
      declarations: node.declarations.map((d: N) => ({ type: "VariableDeclarator", id: this.pattern(d.id, false), init: d.init ? this.expr(d.init) : null })),
    };
  }

  // --- functions and classes ---------------------------------------------------

  private fn(node: N, declaration: boolean): N {
    if (node.async) this.fail(node, "async functions are not supported");
    if (node.generator) this.fail(node, "generators are not supported");
    const arrow = node.type === "ArrowFunctionExpression";
    let outer = this.scope;
    if (!declaration && node.id) {
      outer = new Scope("block", this.scope);
      outer.names.add(node.id.name);
    }
    const scope = new Scope(arrow ? "arrow" : "function", outer);
    for (const p of node.params) for (const n of patternNames(p)) scope.names.add(n);
    const expressionBody = arrow && node.expression;
    if (!expressionBody) {
      hoistedNames(node.body.body, scope);
      lexicalNames(node.body.body, scope);
    }
    return this.withScope(scope, () =>
      this.withCompletion(false, () => {
        const params = node.params.map((p: N) => this.pattern(p, false));
        const body = expressionBody ? this.expr(node.body) : { type: "BlockStatement", body: this.statements(node.body.body) };
        const out: N = { type: node.type, id: node.id ? this.binding(node.id.name) : null, params, body, async: false, generator: false };
        if (arrow) out.expression = !!expressionBody;
        return out;
      }),
    );
  }

  private cls(node: N): N {
    if (node.superClass) this.fail(node, "class inheritance is not supported");
    const outer = node.type === "ClassExpression" && node.id ? new Scope("block", this.scope) : this.scope;
    if (outer !== this.scope) outer.names.add(node.id.name);
    return this.withScope(outer, () => ({
      type: node.type,
      id: node.id ? this.binding(node.id.name) : null,
      superClass: null,
      body: {
        type: "ClassBody",
        body: node.body.body.map((m: N) => {
          if (m.type !== "MethodDefinition") this.fail(m, `${m.type} is not supported`);
          return { type: "MethodDefinition", kind: m.kind, static: m.static, computed: m.computed, key: m.computed ? this.expr(m.key) : this.key(m.key), value: this.fn(m.value, false) };
        }),
      },
    }));
  }

  // --- patterns ----------------------------------------------------------------

  /** A binding or assignment pattern; `assigning` marks undeclared identifiers as implicit globals. */
  private pattern(node: N, assigning: boolean): N {
    switch (node.type) {
      case "Identifier":
        return assigning ? this.target(node) : this.binding(node.name);
      case "AssignmentPattern":
        return { type: "AssignmentPattern", left: this.pattern(node.left, assigning), right: this.expr(node.right) };
      case "RestElement":
        return { type: "RestElement", argument: this.pattern(node.argument, assigning) };
      case "ArrayPattern":
        return { type: "ArrayPattern", elements: node.elements.map((e: N) => (e ? this.pattern(e, assigning) : null)) };
      case "ObjectPattern":
        return {
          type: "ObjectPattern",
          properties: node.properties.map((p: N) => {
            if (p.type === "RestElement") return { type: "RestElement", argument: this.pattern(p.argument, assigning) };
            // Patterns read properties natively, so their keys are checked like member keys.
            const key = p.computed ? helper("key", [this.expr(p.key)]) : this.patternKey(p.key);
            return { type: "Property", kind: "init", method: false, shorthand: false, computed: !!p.computed, key, value: this.pattern(p.value, assigning) };
          }),
        };
      case "MemberExpression":
        return this.fail(node, "assigning to a property inside a destructuring pattern is not supported");
      default:
        return this.fail(node, `${node.type} is not supported in a pattern`);
    }
  }

  /** A static key that only defines (class members): any name is fine. */
  private key(node: N): N {
    return node.type === "Identifier" ? id(node.name) : lit(node.value);
  }

  /** A static key a destructuring pattern reads. */
  private patternKey(node: N): N {
    const name = node.type === "Identifier" ? node.name : node.value;
    if (DENIED_KEYS.has(String(name))) this.deny(node, String(name));
    return this.key(node);
  }

  /** The key of a member expression: a literal for `a.b`, the rewritten expression for `a[b]`. */
  private memberKey(node: N): N {
    if (node.computed) {
      if (node.property.type === "Literal" && typeof node.property.value === "string" && DENIED_KEYS.has(node.property.value)) this.deny(node, node.property.value);
      return this.expr(node.property);
    }
    if (node.property.type === "PrivateIdentifier") this.fail(node, "private fields are not supported");
    if (DENIED_KEYS.has(node.property.name)) this.deny(node, node.property.name);
    return lit(node.property.name);
  }

  // --- expressions -------------------------------------------------------------

  private exprs(list: N[]): N[] {
    return list.map((e) => (e === null ? null : this.expr(e)));
  }

  private args(list: N[]): N[] {
    return list.map((a) => (a.type === "SpreadElement" ? { type: "SpreadElement", argument: this.expr(a.argument) } : this.expr(a)));
  }

  expr(node: N): N {
    switch (node.type) {
      case "Identifier":
        return this.reference(node);
      case "Literal":
        if (node.regex) return { type: "Literal", value: null, regex: { pattern: node.regex.pattern, flags: node.regex.flags }, raw: node.raw };
        if (typeof node.bigint === "string") return { type: "Literal", value: null, bigint: node.bigint, raw: node.raw };
        return lit(node.value);
      case "ThisExpression": {
        let s = this.scope.functionScope;
        while (s.kind === "arrow") s = s.parent!.functionScope;
        if (s.kind === "function") return { type: "ThisExpression" };
        return this.options.legacy ? member(id("$$c"), "thisLayer") : voidZero();
      }
      case "TemplateLiteral":
        return { type: "TemplateLiteral", quasis: node.quasis.map((q: N) => ({ type: "TemplateElement", tail: q.tail, value: { raw: q.value.raw, cooked: q.value.cooked } })), expressions: this.exprs(node.expressions) };
      case "TaggedTemplateExpression":
        return { type: "TaggedTemplateExpression", tag: this.expr(node.tag), quasi: this.expr(node.quasi) };
      case "ArrayExpression":
        return arrayOf(node.elements.map((e: N) => (e === null ? null : e.type === "SpreadElement" ? { type: "SpreadElement", argument: this.expr(e.argument) } : this.expr(e))));
      case "ObjectExpression":
        return {
          type: "ObjectExpression",
          properties: node.properties.map((p: N) => {
            if (p.type === "SpreadElement") return { type: "SpreadElement", argument: this.expr(p.argument) };
            if (!p.computed && (p.key.name ?? p.key.value) === "__proto__") this.deny(p, "__proto__");
            const key = p.computed ? this.expr(p.key) : p.key.type === "Identifier" ? id(p.key.name) : lit(p.key.value);
            const value = p.kind === "init" && !p.method ? this.expr(p.value) : this.fn(p.value, false);
            return { type: "Property", kind: p.kind, method: p.method, shorthand: false, computed: p.computed, key, value };
          }),
        };
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return this.fn(node, false);
      case "ClassExpression":
        return this.cls(node);
      case "SequenceExpression":
        return { type: "SequenceExpression", expressions: this.exprs(node.expressions) };
      case "ConditionalExpression":
        return { type: "ConditionalExpression", test: this.expr(node.test), consequent: this.expr(node.consequent), alternate: this.expr(node.alternate) };
      case "LogicalExpression":
        return { type: "LogicalExpression", operator: node.operator, left: this.expr(node.left), right: this.expr(node.right) };
      case "BinaryExpression": {
        const op = VECTOR_OPS[node.operator];
        if (op) return helper(op, [this.expr(node.left), this.expr(node.right)]);
        return { type: "BinaryExpression", operator: node.operator, left: this.expr(node.left), right: this.expr(node.right) };
      }
      case "UnaryExpression":
        return this.unary(node);
      case "UpdateExpression":
        if (node.argument.type === "MemberExpression") {
          return helper("update", [this.expr(node.argument.object), this.memberKey(node.argument), lit(node.operator === "++" ? 1 : -1), lit(node.prefix)]);
        }
        if (node.argument.type !== "Identifier") this.fail(node, "invalid update target");
        return { type: "UpdateExpression", operator: node.operator, prefix: node.prefix, argument: this.target(node.argument) };
      case "AssignmentExpression":
        return this.assignment(node);
      case "MemberExpression":
        if (node.object.type === "Super") this.fail(node, "super is not supported");
        return helper("get", [this.expr(node.object), this.memberKey(node)]);
      case "CallExpression":
        return this.call(node);
      case "NewExpression":
        return { type: "NewExpression", callee: this.expr(node.callee), arguments: this.args(node.arguments) };
      case "ChainExpression":
        return this.chain(node.expression);
      case "ParenthesizedExpression":
        return this.expr(node.expression);
      case "ImportExpression":
        return this.fail(node, "import() is not allowed in expressions");
      case "MetaProperty":
        return this.fail(node, `${node.meta.name}.${node.property.name} is not allowed in expressions`);
      case "AwaitExpression":
      case "YieldExpression":
        return this.fail(node, `${node.type} is not supported`);
      case "Super":
        return this.fail(node, "super is not supported");
      default:
        return this.fail(node, `${node.type} is not supported in expressions`);
    }
  }

  private unary(node: N): N {
    const arg = node.argument;
    if (node.operator === "-") return helper("neg", [this.expr(arg)]);
    if (node.operator === "delete") {
      if (arg.type === "MemberExpression") return helper("del", [this.expr(arg.object), this.memberKey(arg)]);
      return this.fail(node, "delete is only supported on properties");
    }
    if (node.operator === "typeof" && arg.type === "Identifier" && resolve(this.scope, arg.name).kind === "free") {
      const n = arg.name;
      if (!CONTEXT_NAMES.has(n) && !PROPERTY_NAMES.has(n) && !LAYER_NAMES.has(n) && n !== "NaN" && n !== "Infinity") {
        return helper("typeofFree", [id("$$a"), lit(n)]);
      }
    }
    return { type: "UnaryExpression", operator: node.operator, prefix: true, argument: this.expr(arg) };
  }

  private assignment(node: N): N {
    const { left, operator } = node;
    if (left.type === "MemberExpression") {
      if (left.object.type === "Super") this.fail(left, "super is not supported");
      const object = this.expr(left.object);
      const key = this.memberKey(left);
      const right = this.expr(node.right);
      if (operator === "=") return helper("set", [object, key, right]);
      return helper("setOp", [object, key, lit(operator), right]);
    }
    if (left.type === "Identifier") {
      const target = this.target(left);
      const right = this.expr(node.right);
      const op = VECTOR_ASSIGN[operator];
      if (op) return assign(target, helper(op, [this.binding(left.name), right]));
      return assign(target, right, operator);
    }
    if (operator !== "=") this.fail(node, "invalid compound assignment target");
    return assign(this.pattern(left, true), this.expr(node.right));
  }

  private call(node: N): N {
    const callee = node.callee;
    const args = this.args(node.arguments);
    if (callee.type === "Super") this.fail(node, "super is not supported");
    if (callee.type === "MemberExpression") {
      if (callee.object.type === "Super") this.fail(node, "super is not supported");
      return helper("call", [this.expr(callee.object), this.memberKey(callee), arrayOf(args)]);
    }
    if (callee.type === "Identifier" && resolve(this.scope, callee.name).kind === "free") {
      const name = callee.name;
      if (PROPERTY_NAMES.has(name)) return helper("call", [member(id("$$c"), "thisProperty"), lit(name), arrayOf(args)]);
      if (LAYER_NAMES.has(name)) return helper("call", [member(id("$$c"), "thisLayer"), lit(name), arrayOf(args)]);
    }
    return call(this.expr(callee), args);
  }

  /** `a?.b`, `a?.[k]`, `a?.b()`: evaluated through helpers that short-circuit on null. */
  private chain(node: N): N {
    // Each link becomes a thunk applied to the previous value; a nullish
    // optional link ends the whole chain with undefined.
    const links: { optional: boolean; apply: (value: N) => N }[] = [];
    let base: N = node;
    for (;;) {
      if (base.type === "MemberExpression") {
        const b = base;
        const key = this.memberKey(b);
        links.unshift({ optional: b.optional, apply: (v) => helper("get", [v, key]) });
        base = b.object;
      } else if (base.type === "CallExpression") {
        const c = base;
        const args = this.args(c.arguments);
        if (c.callee.type === "MemberExpression") {
          const key = this.memberKey(c.callee);
          const optionalCall = c.optional;
          links.unshift({ optional: c.callee.optional, apply: (v) => helper(optionalCall ? "optCall" : "call", [v, key, arrayOf(args)]) });
          base = c.callee.object;
        } else {
          links.unshift({ optional: c.optional, apply: (v) => call(v, args) });
          base = c.callee;
        }
      } else break;
    }
    const steps = links.map((l) => ({
      type: "ArrowFunctionExpression",
      id: null,
      params: [id("$$v")],
      body: l.apply(id("$$v")),
      expression: true,
      async: false,
      generator: false,
      optional: l.optional,
    }));
    return helper("chain", [this.expr(base), arrayOf(steps.map((s) => ({ type: "ArrayExpression", elements: [lit(s.optional), { ...s, optional: undefined }] })))]);
  }
}

// ---------------------------------------------------------------------------
// Output verification
// ---------------------------------------------------------------------------

const HELPER_PARAMS = new Set(["$$h", "$$a", "$$c"]);
const HELPER_LOCALS = new Set(["$$n", "$$r", "$$v"]);

/**
 * Independent check of generated code: every identifier in a reference
 * position is a helper parameter, a helper local, `arguments`, or a renamed
 * binding, and plain member expressions only read fixed names off the helper
 * parameters. Anything else means the rewriter let something through.
 */
export function verifyOutput(code: string): void {
  const ast = parse(code, { ecmaVersion: 2020, sourceType: "script", allowReturnOutsideFunction: true }) as N;
  const bad = (what: string): never => {
    throw new ExpressionSecurityError(`generated code failed verification: ${what}`);
  };
  const walk = (node: N, parent: N, field: string, inFunction: boolean) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "ThisExpression":
        if (!inFunction) bad("top-level this");
        return;
      case "FunctionExpression":
      case "FunctionDeclaration":
        inFunction = true;
        break;
      case "Identifier": {
        const keyPosition =
          (parent?.type === "MemberExpression" && field === "property" && !parent.computed) ||
          ((parent?.type === "Property" || parent?.type === "MethodDefinition") && field === "key" && !parent.computed) ||
          ((parent?.type === "LabeledStatement" || parent?.type === "BreakStatement" || parent?.type === "ContinueStatement") && field === "label");
        if (keyPosition) return;
        const n: string = node.name;
        if (!HELPER_PARAMS.has(n) && !HELPER_LOCALS.has(n) && n !== "arguments" && !n.startsWith("v_")) bad(`free identifier ${n}`);
        return;
      }
      case "MemberExpression":
        if (node.computed || node.object.type !== "Identifier" || !HELPER_PARAMS.has(node.object.name)) bad("direct member access");
        if (DENIED_KEYS.has(node.property.name)) bad(`helper member ${node.property.name}`);
        return;
      case "WithStatement":
      case "ImportExpression":
      case "MetaProperty":
      case "Super":
        bad(node.type);
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach((c) => walk(c, node, key, inFunction));
      else if (child && typeof child === "object" && typeof child.type === "string") walk(child, node, key, inFunction);
    }
  };
  walk(ast, null, "", false);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseSource(source: string): N {
  try {
    return parse(source, { ecmaVersion: 2020, sourceType: "script", allowReturnOutsideFunction: true, allowHashBang: false });
  } catch (error) {
    throw new ExpressionSyntaxError((error as Error).message);
  }
}

/** Compiles an expression; throws ExpressionSyntaxError / ExpressionSecurityError for rejected source. */
export function compileExpression(source: string, options: { legacy?: boolean } = {}): CompiledExpression {
  const ast = parseSource(source);
  const implicit = new Set<string>();
  new Rewriter({ implicit, collect: true, legacy: options.legacy }).rewriteProgram(parseSource(source));
  const rewriter = new Rewriter({ implicit, collect: false, legacy: options.legacy });
  const body = rewriter.rewriteProgram(ast);
  // Program-level bindings that shadow API names start from the API value,
  // as a redeclared global would (`var value = value * 2`).
  const inits: N[] = [];
  for (const name of rewriter.program.names) {
    if (CONTEXT_NAMES.has(name) || PROPERTY_NAMES.has(name) || LAYER_NAMES.has(name) || implicit.has(name)) {
      const declaredLexically = ast.body.some(
        (s: N) => (s.type === "VariableDeclaration" && s.kind !== "var" && s.declarations.some((d: N) => patternNames(d.id).includes(name))) || (s.type === "ClassDeclaration" && s.id.name === name),
      );
      if (declaredLexically) continue;
      const isFunction = ast.body.some((s: N) => s.type === "FunctionDeclaration" && s.id.name === name);
      if (isFunction) continue;
      const apiName = CONTEXT_NAMES.has(name) || PROPERTY_NAMES.has(name) || LAYER_NAMES.has(name);
      inits.push({
        type: "VariableDeclaration",
        kind: "var",
        declarations: [{ type: "VariableDeclarator", id: id(`v_${name}`), init: apiName ? new Rewriter({ implicit: new Set(), collect: false }).expr(id(name)) : helper("maybeFree", [id("$$a"), lit(name)]) }],
      });
    }
  }
  const program: N = {
    type: "Program",
    sourceType: "script",
    body: [
      stmt(lit("use strict")),
      { type: "VariableDeclaration", kind: "let", declarations: [{ type: "VariableDeclarator", id: id("$$n"), init: lit(0) }, { type: "VariableDeclarator", id: id("$$r"), init: null }] },
      ...inits,
      ...body,
      { type: "ReturnStatement", argument: id("$$r") },
    ],
  };
  program.body[0].directive = "use strict";
  const code = generate(program);
  verifyOutput(code);
  let fn: (helpers: unknown, api: unknown, context: unknown) => unknown;
  try {
    fn = new Function("$$h", "$$a", "$$c", code) as typeof fn;
  } catch (error) {
    throw new ExpressionSyntaxError((error as Error).message);
  }
  return { run: (helpers, api, context) => Reflect.apply(fn, undefined, [helpers, api, context]), code };
}
