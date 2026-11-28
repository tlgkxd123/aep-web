#version 450
// The interface's pixels, premultiplied for blending over what is below: textures are straight (the font atlas) or
// premultiplied (a rendered frame), vertex colors straight.
layout(set = 0, binding = 0) uniform sampler2D u_texture;
layout(push_constant) uniform Push {
  vec2 scale;
  vec2 translate;
  vec4 uvRect;
  int premultiplied;
} pc;
layout(location = 0) in vec2 v_uv;
layout(location = 1) in vec4 v_color;
layout(location = 0) out vec4 color;

void main() {
  vec4 t = texture(u_texture, v_uv);
  if (pc.premultiplied != 0) {
    color = t * vec4(v_color.rgb * v_color.a, v_color.a);
  } else {
    vec4 c = v_color * t;
    color = vec4(c.rgb * c.a, c.a);
  }
}
