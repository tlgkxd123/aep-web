// Expression editing helpers: tokens for syntax colouring and completions for
// the identifier, member or name string at the caret.

export type TokenKind = "comment" | "string" | "number" | "keyword" | "builtin" | "punct" | "ident" | "space";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "var", "let", "const", "function", "return", "if", "else", "for", "while", "do", "break", "continue", "switch", "case",
  "default", "new", "typeof", "instanceof", "in", "of", "true", "false", "null", "undefined", "this", "try", "catch",
  "finally", "throw",
]);

export interface Completion {
  label: string;
  /** Text inserted in place of the typed prefix; a trailing "()" puts the caret between the parentheses. */
  insert: string;
  detail?: string;
}

const fn = (label: string, args: string, detail?: string): Completion => ({ label: `${label}(${args})`, insert: `${label}()`, detail });
const attr = (label: string, detail?: string): Completion => ({ label, insert: label, detail });

const PROPERTY_MEMBERS: Completion[] = [
  attr("value", "value at the current time"),
  fn("valueAtTime", "t"),
  attr("velocity"),
  fn("velocityAtTime", "t"),
  attr("speed"),
  fn("speedAtTime", "t"),
  fn("wiggle", "freq, amp, octaves, ampMult, t", "random wobble around the value"),
  fn("temporalWiggle", "freq, amp"),
  fn("smooth", "width, samples"),
  fn("loopOut", 'type = "cycle", numKeyframes', '"cycle", "pingpong", "offset", "continue"'),
  fn("loopIn", 'type = "cycle", numKeyframes'),
  fn("loopOutDuration", 'type = "cycle", duration'),
  fn("loopInDuration", 'type = "cycle", duration'),
  fn("key", "index"),
  attr("numKeys"),
  fn("nearestKey", "t"),
  attr("propertyIndex"),
  attr("name"),
  attr("active"),
];

const TRANSFORM_MEMBERS: Completion[] = [
  "anchorPoint", "position", "xPosition", "yPosition", "zPosition", "scale", "rotation", "xRotation", "yRotation",
  "zRotation", "orientation", "opacity",
].map((n) => attr(n));

const LAYER_MEMBERS: Completion[] = [
  attr("transform"),
  fn("effect", "name"),
  fn("mask", "name"),
  fn("content", "name"),
  attr("text"),
  attr("name"),
  attr("index"),
  attr("inPoint"),
  attr("outPoint"),
  attr("startTime"),
  attr("width"),
  attr("height"),
  attr("hasParent"),
  attr("parent"),
  attr("source"),
  attr("timeRemap"),
  attr("marker"),
  attr("audioLevels"),
  fn("toComp", "point"),
  fn("fromComp", "point"),
  fn("toWorld", "point"),
  fn("fromWorld", "point"),
  fn("sampleImage", "point, radius = [0.5, 0.5], postEffect = true, t = time"),
  ...TRANSFORM_MEMBERS,
];

const COMP_MEMBERS: Completion[] = [
  fn("layer", "name or index"),
  attr("numLayers"),
  attr("activeCamera"),
  attr("width"),
  attr("height"),
  attr("duration"),
  attr("frameDuration"),
  attr("displayStartTime"),
  attr("pixelAspect"),
  attr("bgColor"),
  attr("name"),
  attr("marker"),
];

const MATH_MEMBERS: Completion[] = [
  ...["abs", "floor", "ceil", "round", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sqrt", "pow", "min", "max", "random", "exp", "log", "sign", "hypot", "trunc"].map((n) => fn(n, "")),
  attr("PI"),
  attr("E"),
];

const GLOBALS: Completion[] = [
  attr("time", "the current time in seconds"),
  attr("value", "the property's own value"),
  attr("thisComp"),
  attr("thisLayer"),
  attr("thisProperty"),
  attr("thisProject"),
  fn("comp", "name"),
  fn("footage", "name"),
  fn("wiggle", "freq, amp", "random wobble around the value"),
  fn("loopOut", 'type = "cycle"', '"cycle", "pingpong", "offset", "continue"'),
  fn("loopIn", 'type = "cycle"'),
  fn("linear", "t, tMin, tMax, value1, value2"),
  fn("ease", "t, tMin, tMax, value1, value2"),
  fn("easeIn", "t, tMin, tMax, value1, value2"),
  fn("easeOut", "t, tMin, tMax, value1, value2"),
  fn("clamp", "value, min, max"),
  fn("random", "min, max"),
  fn("gaussRandom", "min, max"),
  fn("seedRandom", "offset, timeless = false"),
  fn("noise", "valOrArray"),
  fn("posterizeTime", "fps"),
  fn("valueAtTime", "t"),
  attr("velocity"),
  attr("speed"),
  fn("key", "index"),
  attr("numKeys"),
  fn("nearestKey", "t"),
  fn("length", "vec"),
  fn("normalize", "vec"),
  fn("add", "a, b"),
  fn("sub", "a, b"),
  fn("mul", "a, b"),
  fn("div", "a, b"),
  fn("dot", "a, b"),
  fn("cross", "a, b"),
  fn("lookAt", "fromPoint, atPoint"),
  fn("degreesToRadians", "degrees"),
  fn("radiansToDegrees", "radians"),
  fn("timeToFrames", "t = time"),
  fn("framesToTime", "frames"),
  fn("timeToTimecode", "t = time"),
  fn("rgbToHsl", "rgba"),
  fn("hslToRgb", "hsla"),
  fn("hexToRgb", "hex"),
  fn("createPath", "points, inTangents, outTangents, isClosed"),
  attr("Math"),
  ...LAYER_MEMBERS,
];

const BUILTINS = new Set(GLOBALS.map((c) => c.insert.replace(/\(\)$/, "")));

/** Splits an expression into tokens for colouring; concatenating them gives back the source. */
export function tokenize(source: string): Token[] {
  const out: Token[] = [];
  const pattern =
    /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\.\d+\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\w\s])/gy;
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while (pattern.lastIndex < source.length && (match = pattern.exec(source))) {
    const [text, comment, string, number, ident, space] = match;
    if (comment) out.push({ kind: "comment", text });
    else if (string) out.push({ kind: "string", text });
    else if (number) out.push({ kind: "number", text });
    else if (ident) out.push({ kind: KEYWORDS.has(ident) ? "keyword" : BUILTINS.has(ident) ? "builtin" : "ident", text });
    else if (space) out.push({ kind: "space", text });
    else out.push({ kind: "punct", text });
  }
  if (pattern.lastIndex < source.length) out.push({ kind: "ident", text: source.slice(pattern.lastIndex) });
  return out;
}

/** Names the completions can offer inside strings: the comp's layers and a layer's effects, parameters and masks. */
export interface NameSource {
  layers(): string[];
  /** Effects of the named layer (undefined: the expression's own layer). */
  effects(layer?: string): string[];
  params(effect: string, layer?: string): string[];
  masks(layer?: string): string[];
}

export interface CompletionResult {
  /** Where the replaced prefix starts in the source. */
  from: number;
  items: Completion[];
}

/** The text before `end` that a member access applies to: identifiers, dots and balanced calls, read backwards. */
function ownerBefore(source: string, end: number): string {
  let i = end;
  let depth = 0;
  while (i > 0) {
    const c = source[i - 1];
    if (c === ")" || c === "]") depth++;
    else if (c === "(" || c === "[") {
      if (!depth) break;
      depth--;
    } else if (!depth && !/[\w$."']/.test(c)) break;
    i--;
  }
  return source.slice(i, end);
}

function ownerMembers(owner: string): Completion[] {
  const last = owner.replace(/\([^()]*\)/g, "()").split(".").pop() ?? "";
  if (/^Math$/.test(last)) return MATH_MEMBERS;
  if (/^(thisComp|comp\(\))$/.test(last)) return COMP_MEMBERS;
  if (/^(thisLayer|layer\(\)|parent|activeCamera)$/.test(last)) return LAYER_MEMBERS;
  if (/^transform$/.test(last)) return TRANSFORM_MEMBERS;
  if (/^text$/.test(last)) return [attr("sourceText")];
  if (/^key\(\)$/.test(last)) return [attr("value"), attr("time"), attr("index")];
  if (/^effect\(\)$/.test(last)) return [fn("param", "name"), attr("name"), attr("active")];
  if (/^(thisProject)$/.test(last)) return [attr("fullPath"), attr("bitsPerChannel"), attr("linearBlending")];
  return PROPERTY_MEMBERS;
}

const rank = (items: Completion[], prefix: string): Completion[] => {
  const p = prefix.toLowerCase();
  const seen = new Set<string>();
  const unique = items.filter((c) => !seen.has(c.label) && seen.add(c.label));
  const starts = unique.filter((c) => c.insert.toLowerCase().startsWith(p));
  const contains = p ? unique.filter((c) => !c.insert.toLowerCase().startsWith(p) && c.insert.toLowerCase().includes(p)) : [];
  return [...starts, ...contains].filter((c) => c.insert !== prefix);
};

/** Completions for the caret at `caret`, or undefined where none apply (in comments, numbers, after a value). */
export function complete(source: string, caret: number, names: NameSource): CompletionResult | undefined {
  const before = source.slice(0, caret);
  // Inside a name string: layer("...", effect("...", mask("...", or an effect's ("...") parameter.
  const call = /(?:(layer|effect|mask|content)|(\)))\(\s*(["'])([^"'\n]*)$/.exec(before);
  if (call) {
    const [, fnName, closing, , typed] = call;
    const from = caret - typed.length;
    const head = before.slice(0, call.index);
    const ofLayer = /layer\(\s*["']([^"']*)["']\s*\)\.$/.exec(head)?.[1];
    let list: string[] = [];
    if (fnName === "layer") list = names.layers();
    else if (fnName === "effect") list = names.effects(ofLayer);
    else if (fnName === "mask") list = names.masks(ofLayer);
    else if (closing) {
      const effect = /effect\(\s*["']([^"']*)["']\s*$/.exec(head);
      if (effect) {
        const layerName = /layer\(\s*["']([^"']*)["']\s*\)\.effect\(\s*["'][^"']*["']\s*$/.exec(head)?.[1];
        list = names.params(effect[1], layerName);
      }
    }
    const items = rank(list.map((n) => ({ label: n, insert: n })), typed);
    return items.length ? { from, items } : undefined;
  }
  if (inCommentOrString(before)) return undefined;
  const word = /[A-Za-z_$][\w$]*$/.exec(before);
  const prefix = word?.[0] ?? "";
  const start = caret - prefix.length;
  if (source[start - 1] === ".") {
    const owner = ownerBefore(source, start - 1);
    if (!owner || /^\d/.test(owner)) return undefined;
    const items = rank(ownerMembers(owner), prefix);
    return items.length ? { from: start, items } : undefined;
  }
  if (!prefix) return undefined;
  const items = rank(GLOBALS, prefix);
  return items.length ? { from: start, items } : undefined;
}

function inCommentOrString(before: string): boolean {
  const tokens = tokenize(before);
  const last = tokens[tokens.length - 1];
  if (!last) return false;
  if (last.kind === "comment") return !last.text.startsWith("/*") || !last.text.endsWith("*/") || last.text.length < 4;
  if (last.kind === "string") return last.text.length < 2 || last.text[last.text.length - 1] !== last.text[0];
  return false;
}
