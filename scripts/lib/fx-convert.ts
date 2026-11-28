// Converts a WebGL2 effect fragment shader (GLSL ES 3.00, as src/render/effects compile them for ctx.pass) into Vulkan
// GLSL for the native engine, keeping its code as it is:
//
// - Samplers get bindings 0..7 in the order they are declared; which input each reads is set at run time, as WebGL's
//   texture units are (FxUniforms::i on the sampler's name).
// - Every other uniform goes into one std430 storage block at binding 8, at offsets the generator records, so the
//   engine can fill it by name as gl.uniform* calls do.
// - The engine's images are top row first, WebGL's bottom row first: gl_FragCoord, v_uv, texture(), textureLod() and
//   texelFetch() are replaced by versions that count rows from the bottom, so the shader sees what WebGL shows it.
// - The output is written to the target through quantize() when it is 8-bit (rounded half up, as WebGL rounds).
//
// An effect that draws geometry (instanced quads, as Audio Spectrum's capsules) also gives its vertex shader, which is
// converted alongside: both stages share the samplers and the parameter block; its one vec2 attribute holds the
// corners of a quad drawn as a 4-vertex strip ((0, 0), (1, 0), (0, 1), (1, 1)); gl_InstanceID and gl_VertexID become
// their Vulkan names; varyings get locations in the order the vertex shader declares them; and gl_Position.y is
// negated, since Vulkan's clip space runs down where WebGL's runs up, over images stored the other way round.

export type FxType = "float" | "vec2" | "vec3" | "vec4" | "int" | "ivec2" | "ivec3" | "ivec4" | "uint" | "uvec2" | "uvec3" | "uvec4" | "bool" | "mat2" | "mat3" | "mat4";

export interface FxUniform {
  name: string;
  type: FxType;
  /** 1 for a plain uniform, the length of an array. */
  count: number;
  array: boolean;
  /** Byte offset in the parameter block. */
  offset: number;
  /** Bytes from one array element to the next. */
  stride: number;
}

export interface ConvertedFx {
  source: string;
  /** The converted vertex shader, when one was given. */
  vertex?: string;
  uniforms: FxUniform[];
  samplers: string[];
  /** Size of the parameter block in bytes (0 when the shader has no plain uniforms). */
  paramBytes: number;
}

/** std430 base alignment and size of a type. */
const LAYOUT: Record<FxType, { align: number; size: number }> = {
  float: { align: 4, size: 4 },
  int: { align: 4, size: 4 },
  uint: { align: 4, size: 4 },
  bool: { align: 4, size: 4 },
  vec2: { align: 8, size: 8 },
  ivec2: { align: 8, size: 8 },
  uvec2: { align: 8, size: 8 },
  vec3: { align: 16, size: 12 },
  ivec3: { align: 16, size: 12 },
  uvec3: { align: 16, size: 12 },
  vec4: { align: 16, size: 16 },
  ivec4: { align: 16, size: 16 },
  uvec4: { align: 16, size: 16 },
  // Matrices are columns of vectors: mat2 columns 8 bytes apart, mat3 and mat4 16.
  mat2: { align: 8, size: 16 },
  mat3: { align: 16, size: 48 },
  mat4: { align: 16, size: 64 },
};

/** Words GLSL ES 3.00 lets a shader use as names that are keywords in Vulkan GLSL 4.50. */
const KEYWORDS_450 = ["sample", "buffer", "shared", "patch", "subroutine", "resource", "coherent", "volatile", "restrict", "readonly", "writeonly", "precise", "atomic_uint"];

const PRELUDE = `#version 450
layout(push_constant) uniform FxPush { vec2 size; int quantize; } fx_push;
layout(location = 0) out vec4 fx_target;
vec4 fxFragCoord;
vec2 v_uv;
vec4 fx_texture(sampler2D s, vec2 uv) { return texture(s, vec2(uv.x, 1.0 - uv.y)); }
vec4 fx_texture(sampler2D s, vec2 uv, float bias) { return texture(s, vec2(uv.x, 1.0 - uv.y), bias); }
vec4 fx_textureLod(sampler2D s, vec2 uv, float lod) { return textureLod(s, vec2(uv.x, 1.0 - uv.y), lod); }
vec4 fx_texelFetch(sampler2D s, ivec2 p, int lod) { return texelFetch(s, ivec2(p.x, textureSize(s, lod).y - 1 - p.y), lod); }
vec4 fx_quantize(vec4 c) {
  precise vec4 scaled = clamp(c, 0.0, 1.0) * 255.0;
  precise vec4 rounded = floor(scaled + 0.5);
  return rounded / 255.0;
}
`;

const VERTEX_PRELUDE = `#version 450
vec4 fx_texture(sampler2D s, vec2 uv) { return textureLod(s, vec2(uv.x, 1.0 - uv.y), 0.0); }
vec4 fx_textureLod(sampler2D s, vec2 uv, float lod) { return textureLod(s, vec2(uv.x, 1.0 - uv.y), lod); }
vec4 fx_texelFetch(sampler2D s, ivec2 p, int lod) { return texelFetch(s, ivec2(p.x, textureSize(s, lod).y - 1 - p.y), lod); }
`;

const QUALIFIER = "(?:(?:lowp|mediump|highp)\\s+)?";

function constantValue(source: string, name: string): number {
  const define = new RegExp(`#define\\s+${name}\\s+(\\d+)`).exec(source);
  const constant = new RegExp(`const\\s+int\\s+${name}\\s*=\\s*(\\d+)\\s*;`).exec(source);
  const value = define?.[1] ?? constant?.[1];
  if (value === undefined) throw new Error(`array size ${name} is not a constant the converter can read`);
  return Number(value);
}

/** What the stages of one effect program share: its samplers and the uniforms of its parameter block. */
interface Shared {
  samplers: string[];
  uniforms: FxUniform[];
  offset: number;
}

/** A stage's source without its version, precision lines and Vulkan keywords, its uniforms moved into `shared`. */
function prepare(input: string, label: string, shared: Shared): string {
  let source = input.replace(/\r\n/g, "\n");
  if (!/^\s*#version\s+300\s+es/.test(source)) throw new Error(`${label}: not a GLSL ES 3.00 shader`);
  for (const unsupported of ["textureOffset", "texelFetchOffset", "textureGrad", "textureProj", "gl_FragDepth", "dFdx", "dFdy", "fwidth", "isampler", "usampler", "samplerCube", "sampler3D", "sampler2DArray"])
    if (new RegExp(`\\b${unsupported}\\b`).test(source)) throw new Error(`${label}: ${unsupported} is not converted yet`);
  source = source.replace(/^\s*#version\s+300\s+es[^\n]*\n/, "");
  source = source.replace(/^\s*precision\s+\w+\s+\w+\s*;[^\n]*$/gm, "");
  // A declaration may follow a library's closing brace on the same line (`}uniform int u_x;`): give it its own line.
  source = source.replace(/([;}])[ \t]*(uniform\s)/g, "$1\n$2");
  for (const word of KEYWORDS_450) source = source.replace(new RegExp(`\\b${word}\\b`, "g"), `fx_${word}`);

  source = source.replace(/^[ \t]*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+([^;]+);[^\n]*$/gm, (_, type: string, declarators: string) => {
    for (const declarator of declarators.split(",")) {
      const m = /^\s*(\w+)\s*(?:\[\s*(\w+)\s*\])?\s*$/.exec(declarator);
      if (!m) throw new Error(`${label}: cannot read uniform declaration "${declarator}"`);
      const name = m[1];
      if (type === "sampler2D") {
        if (m[2]) throw new Error(`${label}: sampler arrays are not converted`);
        if (!shared.samplers.includes(name)) shared.samplers.push(name);
        continue;
      }
      if (!(type in LAYOUT)) throw new Error(`${label}: uniform type ${type} is not converted`);
      const count = m[2] ? (/^\d+$/.test(m[2]) ? Number(m[2]) : constantValue(input, m[2])) : 1;
      const known = shared.uniforms.find((u) => u.name === name);
      if (known) {
        if (known.type !== type || known.count !== count || known.array !== !!m[2]) throw new Error(`${label}: the stages declare ${name} differently`);
        continue;
      }
      const layout = LAYOUT[type as FxType];
      // std430: array elements are as far apart as their alignment rounds their size up to.
      const stride = Math.ceil(layout.size / layout.align) * layout.align;
      shared.offset = Math.ceil(shared.offset / layout.align) * layout.align;
      shared.uniforms.push({ name, type: type as FxType, count, array: !!m[2], offset: shared.offset, stride });
      shared.offset += count === 1 ? layout.size : stride * count;
    }
    return "";
  });
  if (!/\bvoid\s+main\s*\(\s*(void)?\s*\)/.test(source)) throw new Error(`${label}: no main()`);
  source = source.replace(/\bvoid\s+main\s*\(\s*(void)?\s*\)/, "void fx_main()");
  source = source.replace(/\btexelFetch\s*\(/g, "fx_texelFetch(");
  source = source.replace(/\btextureLod\s*\(/g, "fx_textureLod(");
  source = source.replace(/\btexture\s*\(/g, "fx_texture(");
  return source;
}

/** The declarations of the shared samplers and parameter block, the same in every stage. */
function declarations(shared: Shared): string {
  const samplers = shared.samplers.map((name, i) => `layout(set = 0, binding = ${i}) uniform sampler2D ${name};\n`).join("");
  const block = shared.uniforms.length
    ? `layout(std430, set = 0, binding = 8) readonly buffer FxParams {\n${shared.uniforms
        .map((u) => `  layout(offset = ${u.offset}) ${u.type} ${u.name}${u.array ? `[${u.count}]` : ""};`)
        .join("\n")}\n};\n`
    : "";
  return samplers + block;
}

/** Converts a vertex shader; returns its source with its declarations still to be put in, and its varyings' locations. */
function convertVertex(input: string, label: string, shared: Shared): { source: string; varyings: Map<string, number> } {
  let source = prepare(input, label, shared);
  let corner = "";
  source = source.replace(new RegExp(`^[ \\t]*(?:layout\\s*\\([^)]*\\)\\s*)?in\\s+${QUALIFIER}(\\w+)\\s+(\\w+)\\s*;[^\\n]*$`, "gm"), (_, type: string, name: string) => {
    if (type !== "vec2" || corner) throw new Error(`${label}: only one vec2 attribute (a quad's corners) is converted`);
    corner = name;
    return `vec2 ${name};`;
  });
  const varyings = new Map<string, number>();
  source = source.replace(new RegExp(`^[ \\t]*((?:flat|smooth)\\s+)?out\\s+${QUALIFIER}(\\w+)\\s+(\\w+)\\s*;`, "gm"), (_, interpolation: string | undefined, type: string, name: string) => {
    varyings.set(name, varyings.size);
    return `layout(location = ${varyings.get(name)}) ${interpolation ?? ""}out ${type} ${name};`;
  });
  source = source.replace(/\bgl_InstanceID\b/g, "gl_InstanceIndex").replace(/\bgl_VertexID\b/g, "gl_VertexIndex");
  const main = `
void main() {
  ${corner ? `${corner} = vec2(float(gl_VertexIndex & 1), float(gl_VertexIndex >> 1));` : ""}
  fx_main();
  gl_Position.y = -gl_Position.y;
}
`;
  return { source: `${source}${main}`, varyings };
}

export function convertFx(input: string, label: string, vertexInput?: string): ConvertedFx {
  const shared: Shared = { samplers: [], uniforms: [], offset: 0 };
  const vertex = vertexInput !== undefined ? convertVertex(vertexInput, `${label} (vertex)`, shared) : undefined;
  let source = prepare(input, label, shared);
  if (shared.samplers.length > 8) throw new Error(`${label}: more than 8 samplers`);

  source = source.replace(/^[ \t]*in\s+(?:(?:lowp|mediump|highp)\s+)?vec2\s+v_uv\s*;[^\n]*$/m, "");
  source = source.replace(new RegExp(`^[ \\t]*((?:flat|smooth)\\s+)?in\\s+${QUALIFIER}(\\w+)\\s+(\\w+)\\s*;`, "gm"), (_, interpolation: string | undefined, type: string, name: string) => {
    const location = vertex?.varyings.get(name);
    if (location === undefined) throw new Error(`${label}: input ${name} is not written by a vertex shader`);
    return `layout(location = ${location}) ${interpolation ?? ""}in ${type} ${name};`;
  });
  let output = "";
  source = source.replace(/^[ \t]*(?:layout\s*\(\s*location\s*=\s*0\s*\)\s*)?out\s+(?:(?:lowp|mediump|highp)\s+)?vec4\s+(\w+)\s*;[^\n]*$/m, (_, name: string) => {
    output = name;
    return `vec4 ${name};`;
  });
  if (!output) throw new Error(`${label}: no vec4 output`);
  source = source.replace(/\bgl_FragCoord\b/g, "fxFragCoord");

  const main = `
void main() {
  fxFragCoord = vec4(gl_FragCoord.x, fx_push.size.y - gl_FragCoord.y, gl_FragCoord.zw);
  v_uv = fxFragCoord.xy / fx_push.size;
  ${output} = vec4(0.0);
  fx_main();
  fx_target = fx_push.quantize != 0 ? fx_quantize(${output}) : ${output};
}
`;
  const paramBytes = shared.uniforms.length ? Math.ceil(shared.offset / 16) * 16 : 0;
  const shared_ = declarations(shared);
  return {
    source: `${PRELUDE}${shared_}// ${label}\n${source}${main}`,
    ...(vertex ? { vertex: `${VERTEX_PRELUDE}${shared_}// ${label} (vertex)\n${vertex.source}` } : {}),
    uniforms: shared.uniforms,
    samplers: shared.samplers,
    paramBytes,
  };
}
