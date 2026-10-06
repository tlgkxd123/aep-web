// Run-time half of the expression sandbox (see compile.ts): the guards every
// member access of compiled code goes through, AE's vector operators, and the
// small set of JavaScript globals expressions may use.
//
// The guards hold these invariants:
// - no key in DENIED_KEYS is ever read, written or deleted, so constructor and
//   prototype chains (and with them `Function`) are unreachable;
// - functions are never written to or deleted from, so shared built-ins and API
//   objects cannot be patched to run expression code inside host code;
// - API objects (functions registered with `registerApiObject`) are only read
//   through their node, never through their raw JavaScript properties.
import { DENIED_KEYS, ExpressionSecurityError } from "./compile.ts";

/** The behaviour behind an API object handed to expressions. */
export interface ApiNode {
  /** `obj.key`. Throws for attributes the object does not have. */
  get(key: PropertyKey): unknown;
  /** `obj(...args)`, for objects AE lets you call (layers, property groups). */
  invoke?(args: unknown[]): unknown;
  /** What the object turns into in arithmetic and as a result (a property's value). */
  primitive?(): unknown;
}

const nodes = new WeakMap<object, ApiNode>();

/** Wraps a node as a callable, frozen API object. */
export function apiObject(node: ApiNode, label: string): unknown {
  const f = (...args: unknown[]) => {
    if (!node.invoke) throw new TypeError(`${label} is not a function`);
    return node.invoke(args);
  };
  const toPrimitive = () => (node.primitive ? node.primitive() : `[object ${label}]`);
  Object.defineProperty(f, "valueOf", { value: toPrimitive });
  Object.defineProperty(f, "toString", { value: () => String(toPrimitive()) });
  Object.defineProperty(f, Symbol.toPrimitive, { value: toPrimitive });
  Object.defineProperty(f, "name", { value: label });
  Object.freeze(f);
  nodes.set(f, node);
  return f;
}

export function apiNodeOf(value: unknown): ApiNode | undefined {
  return typeof value === "function" ? nodes.get(value) : undefined;
}

/** A property or key object stands for its value in arithmetic and in results. */
export function unwrap(value: unknown): unknown {
  const node = apiNodeOf(value);
  return node?.primitive ? node.primitive() : value;
}

function denied(key: string): never {
  throw new ExpressionSecurityError(`access to "${key}" is not allowed in expressions`);
}

/** Converts a computed key once (so a key object cannot answer differently later) and checks it. */
function toKey(k: unknown): PropertyKey {
  if (typeof k === "number" || typeof k === "symbol") return k;
  const key = typeof k === "string" ? k : String(k);
  if (DENIED_KEYS.has(key)) denied(key);
  return key;
}

const describe = (o: unknown) => (o === null ? "null" : typeof o);

function read(o: unknown, key: PropertyKey): unknown {
  if (o === null || o === undefined) throw new TypeError(`Cannot read properties of ${describe(o)} (reading '${String(key)}')`);
  const node = apiNodeOf(o);
  if (node) return node.get(key);
  return (o as Record<PropertyKey, unknown>)[key];
}

function write(o: unknown, key: PropertyKey, v: unknown): unknown {
  if (o === null || o === undefined) throw new TypeError(`Cannot set properties of ${describe(o)} (setting '${String(key)}')`);
  if (typeof o === "function") throw new TypeError(`functions and After Effects objects cannot be modified (setting '${String(key)}')`);
  (o as Record<PropertyKey, unknown>)[key] = v;
  return v;
}

// --- vector arithmetic ------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === "number";

function vectorPair(a: unknown[], b: unknown[], op: (x: number, y: number) => number): number[] {
  const n = Math.max(a.length, b.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = op(Number(i < a.length ? unwrap(a[i]) : 0), Number(i < b.length ? unwrap(b[i]) : 0));
  return out;
}

function scaled(a: unknown[], s: number, op: (x: number, y: number) => number): number[] {
  return a.map((x) => op(Number(unwrap(x)), s));
}

/** `a + b`: arrays add per component; an array and a number add the number to the first component. */
export function add(a: unknown, b: unknown): unknown {
  if (isNum(a) && isNum(b)) return a + b;
  a = unwrap(a);
  b = unwrap(b);
  if (Array.isArray(a) && Array.isArray(b)) return vectorPair(a, b, (x, y) => x + y);
  if (Array.isArray(a) && (isNum(b) || typeof b === "boolean")) return a.map((x, i) => (i === 0 ? Number(unwrap(x)) + Number(b) : Number(unwrap(x))));
  if (Array.isArray(b) && (isNum(a) || typeof a === "boolean")) return b.map((x, i) => (i === 0 ? Number(a) + Number(unwrap(x)) : Number(unwrap(x))));
  return (a as number) + (b as number);
}

export function sub(a: unknown, b: unknown): unknown {
  if (isNum(a) && isNum(b)) return a - b;
  a = unwrap(a);
  b = unwrap(b);
  if (Array.isArray(a) && Array.isArray(b)) return vectorPair(a, b, (x, y) => x - y);
  if (Array.isArray(a) && (isNum(b) || typeof b === "boolean")) return a.map((x, i) => (i === 0 ? Number(unwrap(x)) - Number(b) : Number(unwrap(x))));
  if (Array.isArray(b) && (isNum(a) || typeof a === "boolean")) return b.map((x, i) => (i === 0 ? Number(a) - Number(unwrap(x)) : -Number(unwrap(x))));
  return (a as number) - (b as number);
}

export function mul(a: unknown, b: unknown): unknown {
  if (isNum(a) && isNum(b)) return a * b;
  a = unwrap(a);
  b = unwrap(b);
  if (Array.isArray(a) && !Array.isArray(b)) return scaled(a, Number(b), (x, y) => x * y);
  if (Array.isArray(b) && !Array.isArray(a)) return scaled(b, Number(a), (x, y) => x * y);
  if (Array.isArray(a) && Array.isArray(b)) return vectorPair(a, b, (x, y) => x * y);
  return (a as number) * (b as number);
}

export function div(a: unknown, b: unknown): unknown {
  if (isNum(a) && isNum(b)) return a / b;
  a = unwrap(a);
  b = unwrap(b);
  if (Array.isArray(a) && !Array.isArray(b)) return scaled(a, Number(b), (x, y) => x / y);
  if (Array.isArray(a) && Array.isArray(b)) return vectorPair(a, b, (x, y) => x / y);
  return (a as number) / (b as number);
}

export function neg(a: unknown): unknown {
  if (isNum(a)) return -a;
  a = unwrap(a);
  if (Array.isArray(a)) return a.map((x) => -Number(unwrap(x)));
  return -(a as number);
}

function binary(op: string, a: unknown, b: unknown): unknown {
  const x = a as number;
  const y = b as number;
  switch (op) {
    case "+=":
      return add(a, b);
    case "-=":
      return sub(a, b);
    case "*=":
      return mul(a, b);
    case "/=":
      return div(a, b);
    case "%=":
      return x % y;
    case "**=":
      return x ** y;
    case "<<=":
      return x << y;
    case ">>=":
      return x >> y;
    case ">>>=":
      return x >>> y;
    case "&=":
      return x & y;
    case "|=":
      return x | y;
    case "^=":
      return x ^ y;
  }
  throw new SyntaxError(`unsupported operator ${op}`);
}

// --- helpers the compiled code calls as $$h.* ---------------------------------------

export class LoopBudgetError extends Error {
  override name = "RangeError";
}

export const helpers = Object.freeze({
  key: toKey,
  get(o: unknown, k: unknown): unknown {
    return read(o, toKey(k));
  },
  set(o: unknown, k: unknown, v: unknown): unknown {
    return write(o, toKey(k), v);
  },
  setOp(o: unknown, k: unknown, op: string, v: unknown): unknown {
    const key = toKey(k);
    return write(o, key, binary(op, read(o, key), v));
  },
  update(o: unknown, k: unknown, delta: number, prefix: boolean): unknown {
    const key = toKey(k);
    const old = Number(unwrap(read(o, key)));
    write(o, key, old + delta);
    return prefix ? old + delta : old;
  },
  del(o: unknown, k: unknown): boolean {
    const key = toKey(k);
    if (o === null || o === undefined) throw new TypeError(`Cannot convert ${describe(o)} to object`);
    if (typeof o === "function") throw new TypeError("functions and After Effects objects cannot be modified");
    return delete (o as Record<PropertyKey, unknown>)[key];
  },
  call(o: unknown, k: unknown, args: unknown[]): unknown {
    const key = toKey(k);
    const f = read(o, key);
    if (typeof f !== "function") throw new TypeError(`${String(key)} is not a function`);
    return Reflect.apply(f, apiNodeOf(o) ? undefined : o, args);
  },
  optCall(o: unknown, k: unknown, args: unknown[]): unknown {
    const key = toKey(k);
    const f = read(o, key);
    if (f === null || f === undefined) return undefined;
    if (typeof f !== "function") throw new TypeError(`${String(key)} is not a function`);
    return Reflect.apply(f, apiNodeOf(o) ? undefined : o, args);
  },
  chain(base: unknown, steps: [boolean, (v: unknown) => unknown][]): unknown {
    let v = base;
    for (const [optional, step] of steps) {
      if (optional && (v === null || v === undefined)) return undefined;
      v = step(v);
    }
    return v;
  },
  free(api: Record<string, unknown>, name: string): unknown {
    if (Object.hasOwn(api, name)) return api[name];
    throw new ReferenceError(`${name} is not defined`);
  },
  maybeFree(api: Record<string, unknown>, name: string): unknown {
    return Object.hasOwn(api, name) ? api[name] : undefined;
  },
  typeofFree(api: Record<string, unknown>, name: string): string {
    return Object.hasOwn(api, name) ? typeof api[name] : "undefined";
  },
  budget(): never {
    throw new LoopBudgetError("expression exceeded its loop budget (infinite loop?)");
  },
  add,
  sub,
  mul,
  div,
  neg,
});

// --- JavaScript globals --------------------------------------------------------------

/**
 * A stand-in for a built-in constructor: constructs the real thing and shares
 * its prototype (so `instanceof` works) but carries only the listed statics.
 */
function constructorLike(name: string, construct: (args: unknown[], called: boolean) => unknown, native: { prototype: unknown }, statics: Record<string, unknown>): unknown {
  const f = function (this: unknown, ...args: unknown[]) {
    return construct(args, new.target === undefined);
  };
  Object.defineProperty(f, "name", { value: name });
  f.prototype = native.prototype as object;
  for (const [k, v] of Object.entries(statics)) Object.defineProperty(f, k, { value: v, enumerable: false });
  return Object.freeze(f);
}

const freezeCopy = (source: object, names: string[]): object => {
  const out: Record<string, unknown> = Object.create(null);
  for (const n of names) out[n] = (source as Record<string, unknown>)[n];
  return Object.freeze(out);
};

const errorType = (Native: ErrorConstructor) =>
  constructorLike(Native.name, (args) => new Native(...(args as [string?])), Native, {});

/** The JavaScript built-ins expressions can name. */
export const jsGlobals: Record<string, unknown> = {
  Math: freezeCopy(Math, Object.getOwnPropertyNames(Math)),
  JSON: freezeCopy(JSON, ["parse", "stringify"]),
  Number: constructorLike("Number", (args, called) => (called ? Number(args[0] ?? 0) : new Number(args[0] ?? 0)), Number, {
    EPSILON: Number.EPSILON,
    MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
    MAX_VALUE: Number.MAX_VALUE,
    MIN_VALUE: Number.MIN_VALUE,
    POSITIVE_INFINITY: Infinity,
    NEGATIVE_INFINITY: -Infinity,
    NaN: NaN,
    isFinite: Number.isFinite,
    isInteger: Number.isInteger,
    isNaN: Number.isNaN,
    isSafeInteger: Number.isSafeInteger,
    parseFloat: Number.parseFloat,
    parseInt: Number.parseInt,
  }),
  String: constructorLike("String", (args, called) => (called ? String(args.length ? args[0] : "") : new String(args.length ? args[0] : "")), String, {
    fromCharCode: String.fromCharCode,
    fromCodePoint: String.fromCodePoint,
    raw: String.raw,
  }),
  Boolean: constructorLike("Boolean", (args, called) => (called ? Boolean(args[0]) : new Boolean(args[0])), Boolean, {}),
  Array: constructorLike("Array", (args) => (args.length === 1 && typeof args[0] === "number" ? new Array(args[0]) : [...args]), Array, {
    isArray: Array.isArray,
    from: Array.from,
    of: Array.of,
  }),
  Object: constructorLike("Object", (args) => (args[0] !== null && typeof args[0] === "object" ? args[0] : {}), Object, {
    keys: Object.keys,
    values: Object.values,
    entries: Object.entries,
    fromEntries: Object.fromEntries,
    is: Object.is,
    hasOwn: Object.hasOwn,
  }),
  Date: constructorLike("Date", (args, called) => (called ? String(new Date()) : new Date(...(args as []))), Date, { now: Date.now, parse: Date.parse, UTC: Date.UTC }),
  Error: errorType(Error),
  TypeError: errorType(TypeError),
  RangeError: errorType(RangeError),
  ReferenceError: errorType(ReferenceError),
  SyntaxError: errorType(SyntaxError),
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  encodeURI,
  decodeURI,
};
