// The presenter: a sprite list drawn with WebGL2, which is the browser's half
// of the picture and the only file in the player that holds a GL context.
//
// `player.html` loads it with a script element and draws through it on its own
// animation frame, and `conformance.html` loads the same file and draws the
// same way into a canvas it then reads back, so what the conformance probe
// holds to the reference rasterizer is this code and not a copy of it. Nothing
// here knows a game, a worker or a run: a list in, a texture's four levels in,
// a picture out.
//
// HOW A LIST IS DRAWN is `interface/game.h`'s, and the rules the header leaves
// to the pixel are `products/raster`'s, whose `DECISIONS.md` says which case
// pins each. What this file does with them:
//
// - The list is copied as it stands into one instance buffer, because both
//   kinds of record map onto WebGL2's integer attributes at a 32-byte stride:
//   a sprite's `source` as four `UNSIGNED_SHORT` at 4, its rectangle as four
//   `INT` at 12, `angle` and `flags` as two `UNSIGNED_SHORT` at 28; a shape's
//   colour as four `UNSIGNED_BYTE` at 0, its ends as four `INT` at 4, and
//   `half_width` and `radius` as two `INT` at 20; each with a divisor of 1.
//   The list is cut into runs by kind first, read off `game_shape_flag` in the
//   `flags` both carry at 30, and a run of sprites by texture after, so a
//   shape's colour, which sits where a sprite's `texture` does, is never
//   looked up as one. Consecutive sprites from one texture are one instanced
//   draw, and so are consecutive shapes whatever their colours, since a shape
//   reads no texture; a shape between two sprites of one texture splits their
//   run, so it costs that run a draw beside its own. Since WebGL2 has no base
//   instance the attributes are pointed at each run's first record. The page
//   pays for runs rather than records (`docs/runs/webgl2-probe-run.md`
//   section 4), and does not reorder the list, because list order is drawing
//   order across both kinds.
// - The vertex shader divides by 256 and 65,536 and turns the rectangle about
//   its centre. A turn is folded to its quarter first and the sine taken of
//   what is left, so a quarter turn is exact, as `products/raster`'s 20-bit
//   sine is.
// - The fragment shader chooses the level once per sprite from the record and
//   the picture's scale, by the header's formula, clamped to 0 through 3 and
//   rounded to the nearest 256th of a level as the rasterizer rounds it, and
//   reads it with `textureLod` on a sampler that is linear within and between
//   levels and clamps to each level's edge. The GPU's own per-pixel estimate
//   is not used.
// - A shape is drawn by a program and a vertex array of its own, on its box
//   grown by a picture pixel along its axis and across it, so no triangle edge
//   touches a pixel it covers and the GPU breaks no tie. Its figures cross as
//   integers, and the ends' sum and difference are taken in integers before
//   either becomes a float, which the bound `host_core_check_sprites` holds
//   them to keeps exact; times `P / 512` or `P / 256`, a power of two, they
//   stay exact in picture pixels. The colour is premultiplied in integers,
//   `round (c * a / 255)`, as a texel is. Each fragment takes `d`, its
//   centre's signed distance to the box's edge, in floats from those, and is
//   covered by `clamp (0.5 - d, 0, 1)`; a `half_width` of zero folds the box
//   to a point and draws nothing. `raster_coverage` carries `d` in integers
//   and rounds it its own way, and the two are held to each other only within
//   the conformance tolerance.
// - Blending is premultiplied, `ONE, ONE_MINUS_SRC_ALPHA`, over a picture
//   cleared to `background`, for both kinds.
//
// THE LIST IS DRAWN INTO PICTURES, NEVER INTO THE DISPLAY. `compositeScales`
// in `player.js` names the pictures a display at the box's scale is shown, at
// `lo` and `hi` device pixels a frame pixel, powers of two from 1 to 8, and
// the mix between them in 256ths. Each is an RGBA8 texture of one level, the
// frame times its scale on a side, linear both ways and clamped to its edge,
// attached to a framebuffer of its own; the list is drawn into `lo` and, where
// the mix is not 0, into `hi`, each cleared to `background` first with the
// viewport its whole size. Then the drawing buffer is cleared to `background`,
// the letterbox, and one quad over the box samples both pictures at each
// device pixel's centre and mixes them, with blending off, since a picture is
// opaque. The sampler's bilinear tap at `(x + 1/2) / box` is exactly the
// carry-back `raster_resample` computes, `(2x + 1) * picture / (2 * box)`
// picture pixels less the half a texel's centre sits in, so the GPU is held
// to the rasterizer's resample by the conformance probe as it is to its
// list. Where the mix is 0 the second sampler is bound to the first picture
// and the mix is 0, which `mix` answers exactly, so the program never
// branches. A picture is held by its scale across frames and remade only when
// the frame's size changes, and one neither picture now names is released,
// which is a layout change; a lost context loses them with the rest.
//
// A PICTURE THE GPU CANNOT HOLD IS DRAWN SMALLER: where the frame at `hi`
// passes `MAX_TEXTURE_SIZE` or `MAX_VIEWPORT_DIMS`, whichever is less, the
// display is shown `lo` alone, and `lo` is halved while it still does not
// fit, so the picture is magnified rather than refused. Said once per
// presenter on the page's console, naming the frame and both scales, which is
// where the page says everything that plays on degraded - a texture the GPU
// would not take, an audio stall - where the HUD's banner is a refusal, and a
// softer picture is not one.
//
// A TEXTURE ARRIVES AS FOUR `ImageBitmap`s already cut out of its file and
// premultiplied by `createImageBitmap` with colour conversion off, which
// `presentCut` below does and the render worker calls; this file allocates four
// levels with `texStorage2D` and fills each with `texSubImage2D`. Both browsers ignore WebGL's own unpack
// flags for an `ImageBitmap` (`docs/runs/webgl2-probe-run.md` section 6), and
// they are set to do nothing anyway, so an upload means one thing whatever a
// browser decides about them later.
//
// DERIVED FROM THE GL PROBE, NOT SHARED WITH IT. `webgl2-probe.js`'s
// `probeRenderer` is where the attribute layout, the run splitting and the
// sampler were first drawn and timed, and this is that renderer grown into the
// console's: a texture of its own size per run rather than one sheet size, the
// level rounded as the rasterizer rounds it, the turn folded to its quarter, a
// viewport that letterboxes the frame, and the scissor and the readback a
// probe needs. The shape's program is this file's alone: the probe never drew
// one. The probe stays as phase 2 ran it, because its readings in that log are
// readings of its own code.

'use strict';

const PRESENT_RECORD_BYTES = 32;
const PRESENT_LEVELS = 4;

// `game_shape_flag`, the bit of `flags` that makes a record a shape, and where
// `flags` sits in a record of either kind.
const PRESENT_SHAPE_FLAG = 1 << 15;
const PRESENT_FLAGS_AT = 30;

const PRESENT_VERTEX = `#version 300 es
layout (location = 0) in vec2 corner;
layout (location = 1) in uvec4 source;
layout (location = 2) in ivec4 rectangle;
layout (location = 3) in uvec2 angleFlags;

uniform vec2 frame;
uniform vec2 sheet;

out vec2 uv;
flat out vec4 spans;

void main () {
    vec2 size = vec2 (rectangle.zw) / 256.0;
    vec2 centre = vec2 (rectangle.xy) / 256.0 + size * 0.5;

    uint quarter = angleFlags.x >> 14u;
    float within = float (angleFlags.x & 16383u)
        * (6.283185307179586 / 65536.0);
    float s = sin (within);
    float c = cos (within);

    vec2 turn = quarter == 0u ? vec2 (s, c)
        : quarter == 1u ? vec2 (c, -s)
        : quarter == 2u ? vec2 (-s, -c)
        : vec2 (-c, s);

    vec2 local = (corner - 0.5) * size;
    vec2 at = centre + vec2 (local.x * turn.y - local.y * turn.x,
        local.x * turn.x + local.y * turn.y);

    gl_Position = vec4 (at.x / frame.x * 2.0 - 1.0,
        1.0 - at.y / frame.y * 2.0, 0.0, 1.0);

    uv = (vec2 (source.xy) + corner * vec2 (source.zw)) / sheet;
    spans = vec4 (vec2 (source.zw), size);
}
`;

const PRESENT_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D levels;
uniform float scale;

in vec2 uv;
flat in vec4 spans;

out vec4 colour;

void main () {
    float shrink = max (spans.x / (spans.z * scale),
        spans.y / (spans.w * scale));
    float lod = clamp (log2 (shrink), 0.0, 3.0);

    colour = textureLod (levels, uv, floor (lod * 256.0 + 0.5) / 256.0);
}
`;

// The shape, in picture pixels with `y` down, as the frame's own: `picture`
// is the picture's size and `scale` its `P`. What crosses to the fragment is
// the box as `raster_coverage` measures from it - its centre, its axis's
// direction, how far the rectangle its corners are rounded about reaches along
// the axis and across it, and the radius - and the colour premultiplied.
const PRESENT_SHAPE_VERTEX = `#version 300 es
layout (location = 0) in vec2 corner;
layout (location = 1) in uvec4 rgba;
layout (location = 2) in ivec4 ends;
layout (location = 3) in ivec2 sizes;

uniform vec2 picture;
uniform float scale;

flat out vec2 centre;
flat out vec2 along;
flat out vec3 reach;
flat out vec4 shade;

void main () {
    vec2 sum = vec2 (ends.xy + ends.zw);
    vec2 axis = vec2 (ends.zw - ends.xy);
    float span = length (axis);
    vec2 direction = span > 0.0 ? axis / span : vec2 (1.0, 0.0);
    vec2 middle = sum * (scale / 512.0);

    float halfLength = span * (scale / 512.0);
    float halfWidth = float (sizes.x) * (scale / 256.0);
    float radius = float (sizes.y) * (scale / 256.0);

    uvec3 premultiplied = (rgba.rgb * rgba.a + 127u) / 255u;

    vec2 grown = sizes.x > 0
        ? vec2 (halfLength + halfWidth + 1.0, halfWidth + 1.0) : vec2 (0.0);
    vec2 local = (corner * 2.0 - 1.0) * grown;
    vec2 at = middle + direction * local.x
        + vec2 (-direction.y, direction.x) * local.y;

    centre = middle;
    along = direction;
    reach = vec3 (halfLength + halfWidth - radius, halfWidth - radius, radius);
    shade = vec4 (vec3 (premultiplied), float (rgba.a)) / 255.0;

    gl_Position = vec4 (at.x / picture.x * 2.0 - 1.0,
        1.0 - at.y / picture.y * 2.0, 0.0, 1.0);
}
`;

// `gl_FragCoord` is a pixel's centre with `y` up, turned to the frame's `y`
// down. `past` is how far the centre lies beyond the inner rectangle along the
// axis and across it, and `d` the rounded box's signed distance from it.
const PRESENT_SHAPE_FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 picture;

flat in vec2 centre;
flat in vec2 along;
flat in vec3 reach;
flat in vec4 shade;

out vec4 colour;

void main () {
    vec2 at = vec2 (gl_FragCoord.x, picture.y - gl_FragCoord.y) - centre;
    vec2 past = abs (vec2 (dot (at, along), at.y * along.x - at.x * along.y))
        - reach.xy;
    float d = length (max (past, 0.0)) + min (max (past.x, past.y), 0.0)
        - reach.z;

    colour = shade * clamp (0.5 - d, 0.0, 1.0);
}
`;

// The resample: one quad over the viewport, which is the frame's box.
const PRESENT_RESAMPLE_VERTEX = `#version 300 es
layout (location = 0) in vec2 corner;

void main () {
    gl_Position = vec4 (corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

// `box` is the frame's box in the drawing buffer's own device pixels, its
// origin at the bottom left as GL's window is, and a picture's rows run up
// from its bottom as the box's do, since the list was drawn into it through
// the same turn of `y`. `gl_FragCoord` is already a pixel's centre.
const PRESENT_RESAMPLE_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D low;
uniform sampler2D high;
uniform vec4 box;
uniform float blend;

out vec4 colour;

void main () {
    vec2 uv = (gl_FragCoord.xy - box.xy) / box.zw;

    colour = mix (texture (low, uv), texture (high, uv), blend);
}
`;

// What a context is asked for: an opaque buffer, because the frame is cleared
// opaque and nothing shows through it; no depth, stencil or multisampling,
// because the list's order is the depth and a turned edge is the triangle's
// own; premultiplied, because every texel is.
const PRESENT_CONTEXT = {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: true, preserveDrawingBuffer: false,
};

class Presenter {
    // A presenter over `canvas`, or null where the browser has no WebGL2,
    // which is the one context this console draws with.
    static open (canvas, options = {}) {
        const gl = canvas.getContext ('webgl2',
            { ...PRESENT_CONTEXT, ...options });

        return gl ? new Presenter (canvas, gl) : null;
    }

    constructor (canvas, gl) {
        this.canvas = canvas;
        this.gl = gl;

        // Whether this presenter has said it drew a picture smaller than the
        // display asked for, which it says once, and a restored context does
        // not make it news again.
        this.shrunk = false;

        this.build ();
    }

    // Everything a context loses when it is lost, made again: the three
    // programs, the three vertex arrays, the corner buffer and an instance
    // buffer of no size. The textures are not among them - they came from
    // files this file never saw - so a restored context draws nothing a list
    // names until the run is reset. The pictures are, and the first draw makes
    // them again.
    //
    // `textures` is every texture this presenter holds, by resource id: the GL
    // object, level 0's size, and whether a list has named it live yet. One
    // that has not was uploaded ahead of its answer and is not the table's to
    // retire until it has been. `pictures` is every picture it holds, by its
    // scale.
    build () {
        const gl = this.gl;

        this.program = this.link (PRESENT_VERTEX, PRESENT_FRAGMENT);
        this.shapeProgram = this.link (PRESENT_SHAPE_VERTEX,
            PRESENT_SHAPE_FRAGMENT);
        this.resample = this.link (PRESENT_RESAMPLE_VERTEX,
            PRESENT_RESAMPLE_FRAGMENT);
        this.vao = gl.createVertexArray ();
        this.shapeVao = gl.createVertexArray ();
        this.quad = gl.createVertexArray ();
        this.corners = gl.createBuffer ();
        this.instances = gl.createBuffer ();
        this.capacity = 0;

        gl.bindBuffer (gl.ARRAY_BUFFER, this.corners);
        gl.bufferData (gl.ARRAY_BUFFER, new Float32Array ([0, 0, 1, 0, 0, 1, 1, 1]),
            gl.STATIC_DRAW);

        // A sprite's array and a shape's: the same four corners, and three
        // attributes per instance that `point` and `pointShapes` aim at a
        // run's first record.
        for (const vao of [this.vao, this.shapeVao]) {
            gl.bindVertexArray (vao);
            gl.bindBuffer (gl.ARRAY_BUFFER, this.corners);
            gl.enableVertexAttribArray (0);
            gl.vertexAttribPointer (0, 2, gl.FLOAT, false, 0, 0);

            gl.bindBuffer (gl.ARRAY_BUFFER, this.instances);

            for (const location of [1, 2, 3]) {
                gl.enableVertexAttribArray (location);
                gl.vertexAttribDivisor (location, 1);
            }
        }

        // The resample's quad is the same four corners with nothing per
        // instance.
        gl.bindVertexArray (this.quad);
        gl.bindBuffer (gl.ARRAY_BUFFER, this.corners);
        gl.enableVertexAttribArray (0);
        gl.vertexAttribPointer (0, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray (null);

        this.at = {
            frame: gl.getUniformLocation (this.program, 'frame'),
            sheet: gl.getUniformLocation (this.program, 'sheet'),
            scale: gl.getUniformLocation (this.program, 'scale'),
            levels: gl.getUniformLocation (this.program, 'levels'),
        };

        this.shaped = {
            picture: gl.getUniformLocation (this.shapeProgram, 'picture'),
            scale: gl.getUniformLocation (this.shapeProgram, 'scale'),
        };

        this.across = {
            low: gl.getUniformLocation (this.resample, 'low'),
            high: gl.getUniformLocation (this.resample, 'high'),
            box: gl.getUniformLocation (this.resample, 'box'),
            blend: gl.getUniformLocation (this.resample, 'blend'),
        };

        gl.useProgram (this.resample);
        gl.uniform1i (this.across.low, 0);
        gl.uniform1i (this.across.high, 1);
        gl.useProgram (null);

        // The widest and tallest picture this GPU draws: a texture past the
        // first is refused, and a viewport past the second is quietly cut
        // down, which would draw the frame into a corner of its picture. A
        // lost context answers null for both, and a limit it cannot say is
        // none.
        const viewport = gl.getParameter (gl.MAX_VIEWPORT_DIMS) || [];

        this.limit = Math.min (gl.getParameter (gl.MAX_TEXTURE_SIZE) || Infinity,
            viewport [0] || Infinity, viewport [1] || Infinity);

        this.textures = new Map ();
        this.pictures = new Map ();
    }

    get lost () { return this.gl.isContextLost (); }

    link (vertex, fragment) {
        const gl = this.gl;

        const compile = (type, text) => {
            const shader = gl.createShader (type);

            gl.shaderSource (shader, text);
            gl.compileShader (shader);

            if (! gl.getShaderParameter (shader, gl.COMPILE_STATUS)
                && ! gl.isContextLost ())
            {
                throw new Error (`present.js: ${gl.getShaderInfoLog (shader)}`);
            }

            return shader;
        };

        const program = gl.createProgram ();

        gl.attachShader (program, compile (gl.VERTEX_SHADER, vertex));
        gl.attachShader (program, compile (gl.FRAGMENT_SHADER, fragment));
        gl.linkProgram (program);

        if (! gl.getProgramParameter (program, gl.LINK_STATUS)
            && ! gl.isContextLost ())
        {
            throw new Error (`present.js: ${gl.getProgramInfoLog (program)}`);
        }

        return program;
    }

    has (id) { return this.textures.has (id); }

    // A texture's four levels onto the GPU, under the id a sprite names it by.
    // Answers null when it is there, or a sentence saying why it is not: a GL
    // error is the GPU refusing, which nothing past this call could repair.
    upload (id, width, height, levels) {
        const gl = this.gl;

        while (gl.getError () !== gl.NO_ERROR) { /* drained */ }

        const texture = gl.createTexture ();

        gl.bindTexture (gl.TEXTURE_2D, texture);
        gl.texStorage2D (gl.TEXTURE_2D, PRESENT_LEVELS, gl.RGBA8, width, height);

        gl.pixelStorei (gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

        for (let level = 0; level < PRESENT_LEVELS; level++) {
            gl.texSubImage2D (gl.TEXTURE_2D, level, 0, 0, width >> level,
                height >> level, gl.RGBA, gl.UNSIGNED_BYTE, levels [level]);
        }

        gl.texParameteri (gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
            gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri (gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri (gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri (gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri (gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
        gl.texParameteri (gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL,
            PRESENT_LEVELS - 1);

        const error = gl.getError ();

        if (error !== gl.NO_ERROR) {
            gl.deleteTexture (texture);

            return `the GPU refused a texture of ${width} by ${height} texels `
                + `with GL error 0x${error.toString (16)}`;
        }

        this.textures.set (id, { texture, width, height, named: false });

        return null;
    }

    discard (id) {
        const held = this.textures.get (id);

        if (! held) { return; }

        this.gl.deleteTexture (held.texture);
        this.textures.delete (id);
    }

    // Every texture at once, which is a run ending: a new run mints ids from
    // 1 again, so nothing the old one uploaded may answer for them.
    forget () {
        for (const id of [...this.textures.keys ()]) { this.discard (id); }
    }

    // The table a list was captured against, read for what it no longer
    // names: a texture this presenter holds that a list has named live before
    // and that `live` leaves out has had its unload settle, and every list
    // that could name it has been handed over, so it is deleted.
    retire (live) {
        const named = new Set (live);

        for (const [id, held] of [...this.textures]) {
            if (named.has (id)) { held.named = true; continue; }

            if (held.named) { this.discard (id); }
        }
    }

    // One display: the whole buffer cleared to `background`, then the frame
    // of `frameWidth` by `frameHeight` drawn into its pictures and resampled
    // into `box` - device pixels, `y` from the top, and `scale` device pixels
    // per frame pixel, which chooses the pictures. `span` is the list as a
    // golden hashes it, `count` and then the records, or null for a frame with
    // nothing to draw yet. Answers how many draws it cost, every picture's and
    // the resample's, and how many sprites named a texture it does not hold.
    draw (span, background, box, frameWidth, frameHeight) {
        const gl = this.gl;
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;

        gl.bindFramebuffer (gl.FRAMEBUFFER, null);
        gl.disable (gl.SCISSOR_TEST);
        gl.viewport (0, 0, width, height);
        gl.clearColor (background [0] / 255, background [1] / 255,
            background [2] / 255, 1);
        gl.clear (gl.COLOR_BUFFER_BIT);

        const count = span && span.length >= 4
            ? new DataView (span.buffer, span.byteOffset, 4).getUint32 (0, true)
            : 0;

        if (! count) { return { draws: 0, missing: 0 }; }

        const shown = this.shown (box.scale, frameWidth, frameHeight);
        const low = this.picture (shown.lo, frameWidth, frameHeight);
        const high = shown.mix
            ? this.picture (shown.hi, frameWidth, frameHeight) : low;

        for (const [scale, held] of [...this.pictures]) {
            if (held !== low && held !== high) { this.release (scale); }
        }

        gl.bindBuffer (gl.ARRAY_BUFFER, this.instances);

        const bytes = count * PRESENT_RECORD_BYTES;

        if (bytes > this.capacity) {
            this.capacity = Math.max (bytes, this.capacity * 2);

            gl.bufferData (gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
        }

        gl.bufferSubData (gl.ARRAY_BUFFER, 0, span, 4, bytes);

        const records = new DataView (span.buffer, span.byteOffset + 4, bytes);
        let draws = 0, missing = 0;

        for (const picture of low === high ? [low] : [low, high]) {
            const drawn = this.list (picture, records, count, frameWidth,
                frameHeight);

            draws += drawn.draws;
            missing = drawn.missing;
        }

        // The resample, into the box over the letterbox already cleared.
        const bottom = height - box.y - box.height;

        gl.bindFramebuffer (gl.FRAMEBUFFER, null);
        gl.viewport (box.x, bottom, box.width, box.height);
        gl.enable (gl.SCISSOR_TEST);
        gl.scissor (box.x, bottom, box.width, box.height);

        gl.useProgram (this.resample);
        gl.uniform4f (this.across.box, box.x, bottom, box.width, box.height);
        gl.uniform1f (this.across.blend, shown.mix / 256);

        gl.activeTexture (gl.TEXTURE1);
        gl.bindTexture (gl.TEXTURE_2D, high.texture);
        gl.activeTexture (gl.TEXTURE0);
        gl.bindTexture (gl.TEXTURE_2D, low.texture);

        gl.bindVertexArray (this.quad);
        gl.drawArrays (gl.TRIANGLE_STRIP, 0, 4);
        draws++;

        // Neither picture is left on a unit, so nothing that later draws into
        // one can find it bound where a program reads.
        gl.bindTexture (gl.TEXTURE_2D, null);
        gl.activeTexture (gl.TEXTURE1);
        gl.bindTexture (gl.TEXTURE_2D, null);
        gl.activeTexture (gl.TEXTURE0);

        gl.bindVertexArray (null);
        gl.disable (gl.SCISSOR_TEST);

        return { draws, missing };
    }

    // The pictures a display at `scale` is shown, as `compositeScales` names
    // them, unless one would be larger than this GPU draws: then `lo` alone,
    // halved until it fits, said once.
    shown (scale, frameWidth, frameHeight) {
        const asked = compositeScales (scale);
        const fits = (picture) => frameWidth * picture <= this.limit
            && frameHeight * picture <= this.limit;

        if (fits (asked.hi)) { return asked; }

        let lo = asked.lo;

        while (lo > 1 && ! fits (lo)) { lo /= 2; }

        if (! this.shrunk) {
            this.shrunk = true;

            console.warn (`present.js: the ${frameWidth} by ${frameHeight} `
                + `frame at ${+scale.toFixed (3)} device pixels a frame pixel `
                + `asks for a picture at ${asked.hi}, which is past this `
                + `GPU's ${this.limit} pixels a side, so it is drawn at ${lo} `
                + `and magnified`);
        }

        return { lo, hi: lo, mix: 0 };
    }

    // The picture at `scale` of a frame `frameWidth` by `frameHeight`: the one
    // held, or a new one where none is held at that scale or the frame has
    // changed size under it.
    picture (scale, frameWidth, frameHeight) {
        const gl = this.gl;
        const width = frameWidth * scale;
        const height = frameHeight * scale;
        const held = this.pictures.get (scale);

        if (held && held.width === width && held.height === height) {
            return held;
        }

        this.release (scale);

        const texture = gl.createTexture ();
        const framebuffer = gl.createFramebuffer ();

        gl.bindTexture (gl.TEXTURE_2D, texture);
        gl.texStorage2D (gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        gl.texParameteri (gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri (gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri (gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri (gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture (gl.TEXTURE_2D, null);

        gl.bindFramebuffer (gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D (gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D, texture, 0);

        const made = { scale, width, height, texture, framebuffer };

        this.pictures.set (scale, made);

        return made;
    }

    release (scale) {
        const held = this.pictures.get (scale);

        if (! held) { return; }

        this.gl.deleteFramebuffer (held.framebuffer);
        this.gl.deleteTexture (held.texture);
        this.pictures.delete (scale);
    }

    // The list drawn into `picture`, cleared to the colour already set, with
    // the instance buffer already holding its `count` records. Answers how
    // many draws it cost and how many sprites named a texture it does not
    // hold, which a shape never does: it names nothing.
    //
    // A run is cut by kind before it is cut by texture, so consecutive shapes
    // are one draw and a shape's colour, at a sprite's `texture`, is never
    // looked up. Each program keeps its uniforms across a switch, so both are
    // set once a picture and a run of the other kind only rebinds.
    list (picture, records, count, frameWidth, frameHeight) {
        const gl = this.gl;

        gl.bindFramebuffer (gl.FRAMEBUFFER, picture.framebuffer);
        gl.viewport (0, 0, picture.width, picture.height);
        gl.clear (gl.COLOR_BUFFER_BIT);

        gl.enable (gl.BLEND);
        gl.blendFunc (gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram (this.shapeProgram);
        gl.uniform2f (this.shaped.picture, picture.width, picture.height);
        gl.uniform1f (this.shaped.scale, picture.scale);

        gl.useProgram (this.program);
        gl.uniform2f (this.at.frame, frameWidth, frameHeight);
        gl.uniform1f (this.at.scale, picture.scale);
        gl.uniform1i (this.at.levels, 0);
        gl.activeTexture (gl.TEXTURE0);

        gl.bindVertexArray (this.vao);
        gl.bindBuffer (gl.ARRAY_BUFFER, this.instances);

        const shape = (index) => (records.getUint16 (
            index * PRESENT_RECORD_BYTES + PRESENT_FLAGS_AT, true)
            & PRESENT_SHAPE_FLAG) !== 0;

        const texture = (index) =>
            records.getUint32 (index * PRESENT_RECORD_BYTES, true);

        let draws = 0, missing = 0, start = 0, shapes = false;

        while (start < count) {
            const shaped = shape (start);
            const id = shaped ? 0 : texture (start);
            let end = start + 1;

            while (end < count && shape (end) === shaped
                && (shaped || texture (end) === id))
            {
                end++;
            }

            const held = shaped ? null : this.textures.get (id);

            if (shaped || held) {
                if (shapes !== shaped) {
                    shapes = shaped;

                    gl.useProgram (shaped ? this.shapeProgram : this.program);
                    gl.bindVertexArray (shaped ? this.shapeVao : this.vao);
                }

                if (shaped) {
                    this.pointShapes (start);
                } else {
                    this.point (start);

                    gl.uniform2f (this.at.sheet, held.width, held.height);
                    gl.bindTexture (gl.TEXTURE_2D, held.texture);
                }

                gl.drawArraysInstanced (gl.TRIANGLE_STRIP, 0, 4, end - start);

                draws++;
            } else {
                missing += end - start;
            }

            start = end;
        }

        gl.bindVertexArray (null);
        gl.disable (gl.BLEND);

        return { draws, missing };
    }

    // The three instance attributes pointed at record `first`, which is how a
    // run that does not start at the buffer's first record is drawn without an
    // extension for a base instance.
    point (first) {
        const gl = this.gl;
        const base = first * PRESENT_RECORD_BYTES;

        gl.vertexAttribIPointer (1, 4, gl.UNSIGNED_SHORT, PRESENT_RECORD_BYTES,
            base + 4);
        gl.vertexAttribIPointer (2, 4, gl.INT, PRESENT_RECORD_BYTES, base + 12);
        gl.vertexAttribIPointer (3, 2, gl.UNSIGNED_SHORT, PRESENT_RECORD_BYTES,
            base + 28);
    }

    // The same for a run of shapes, on the shape's vertex array: the colour's
    // four channels, the two ends, and `half_width` and `radius`.
    pointShapes (first) {
        const gl = this.gl;
        const base = first * PRESENT_RECORD_BYTES;

        gl.vertexAttribIPointer (1, 4, gl.UNSIGNED_BYTE, PRESENT_RECORD_BYTES,
            base);
        gl.vertexAttribIPointer (2, 4, gl.INT, PRESENT_RECORD_BYTES, base + 4);
        gl.vertexAttribIPointer (3, 2, gl.INT, PRESENT_RECORD_BYTES, base + 20);
    }

    // Solid rectangles over the picture, in frame pixels, through `box`: the
    // presentation probe's stamp, which is `stampBands` in `player.js`. Each is
    // a scissored clear, so it is exactly its colour and covers whole device
    // pixels however the frame is scaled.
    bands (rectangles, box) {
        const gl = this.gl;
        const height = gl.drawingBufferHeight;

        gl.enable (gl.SCISSOR_TEST);

        for (const band of rectangles) {
            const left = box.x + Math.round (band.x * box.scale);
            const right = box.x + Math.round ((band.x + band.width) * box.scale);
            const top = box.y + Math.round (band.y * box.scale);
            const under = box.y + Math.round ((band.y + band.height) * box.scale);

            gl.scissor (left, height - under, right - left, under - top);
            gl.clearColor (band.colour [0] / 255, band.colour [1] / 255,
                band.colour [2] / 255, 1);
            gl.clear (gl.COLOR_BUFFER_BIT);
        }

        gl.disable (gl.SCISSOR_TEST);
    }

    // The drawing buffer as RGBA8, top row first, which is what a probe holds
    // against an image: `readPixels` answers the bottom row first. Read in the
    // same task as the draw, which is what lets a buffer that is not preserved
    // be read at all.
    read () {
        const gl = this.gl;
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const upward = new Uint8Array (width * height * 4);

        gl.bindFramebuffer (gl.FRAMEBUFFER, null);
        gl.readPixels (0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, upward);

        return { width, height, pixels: presentFlip (upward, width, height) };
    }

    // An image's texels as they reached the GPU, top row first: the bitmap
    // uploaded into a texture of one level and read back through a framebuffer
    // it is attached to, which is how `docs/runs/webgl2-probe-run.md` section 6
    // read every level it checked.
    texels (bitmap) {
        const gl = this.gl;
        const width = bitmap.width;
        const height = bitmap.height;
        const texture = gl.createTexture ();
        const framebuffer = gl.createFramebuffer ();
        const upward = new Uint8Array (width * height * 4);

        gl.bindTexture (gl.TEXTURE_2D, texture);
        gl.texStorage2D (gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
        gl.pixelStorei (gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei (gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texSubImage2D (gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA,
            gl.UNSIGNED_BYTE, bitmap);

        gl.bindFramebuffer (gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D (gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D, texture, 0);
        gl.readPixels (0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, upward);
        gl.bindFramebuffer (gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer (framebuffer);
        gl.deleteTexture (texture);

        // A texture's row 0 is the bitmap's top row, and a framebuffer's
        // readback starts at row 0, so this one needs no turning over.
        return { width, height, pixels: upward };
    }
}

// A texture's four levels cut out of its file: each level's rectangle, which
// `levelRect` in `player.js` lays out, decoded by `createImageBitmap`
// premultiplied as `round (c * a / 255)` and with colour conversion off, which
// both browsers do exactly and the reference rasterizer's decode matches
// (`docs/runs/webgl2-probe-run.md` section 6). `'none'` is required rather than
// tidy: Chrome honours a `gAMA` or `cHRM` chunk under the default and moves
// texels by up to 106. No GL is touched, so a worker cuts and the page uploads,
// which is the split that costs the page 16 to 21 ms of a sheet instead of 83
// to 396.
function presentCut (bytes, width, height) {
    const file = new Blob ([bytes], { type: 'image/png' });

    return Promise.all ([0, 1, 2, 3].map ((level) => {
        const rect = levelRect (width, height, level);

        return createImageBitmap (file, rect.x, rect.y, rect.width,
            rect.height, { premultiplyAlpha: 'premultiply',
                colorSpaceConversion: 'none' });
    }));
}

// Rows end for end, which is the difference between GL's window origin and
// an image's.
function presentFlip (pixels, width, height) {
    const row = width * 4;
    const turned = new Uint8Array (pixels.length);

    for (let y = 0; y < height; y++) {
        turned.set (pixels.subarray (y * row, (y + 1) * row),
            (height - 1 - y) * row);
    }

    return turned;
}

// The node door, for a worker that imports this file under a harness: `module`
// is undefined in a browser, where a classic script's declarations are already
// global.

if (typeof module !== 'undefined') {
    module.exports = { Presenter, presentCut, presentFlip,
        PRESENT_RECORD_BYTES, PRESENT_LEVELS, PRESENT_SHAPE_FLAG,
        PRESENT_FLAGS_AT };
}
