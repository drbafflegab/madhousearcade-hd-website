// The thread the picture is made on, and it holds no canvas at all.
//
// It is a second instance of the game's own module - `Consumer` in `player.js`,
// the class the worklet already holds - handed the video description the
// simulation captured after a step, each resource scoped for `render_video`,
// and the rows of the store, and never a state block. It runs the game's own
// `render_video` on those bytes, checks the list it wrote against the store
// through `host-core.wasm` - the same rules, in the same code, that `console`
// runs natively - and transfers the list to the page, which owns the WebGL2
// context and draws it on its own animation frame.
//
// AND IT CUTS TEXTURES. A texture load's file arrives down the same channel
// before the load is answered, and this thread cuts its four levels out of it
// with `createImageBitmap`, premultiplied and with colour conversion off, and
// transfers the four bitmaps to the page, which uploads them and tells the
// simulation so; the simulation answers the load only then. Here rather than on
// the page because the cut is the expensive half and the upload the cheap one:
// the default sheet's four levels cost a page 83 to 94 ms in Safari and 396 in
// Chrome to cut, against 16 to 21 ms to upload once a worker had cut them
// (`docs/runs/webgl2-probe-run.md` section 6).
//
// WHY THE LIST IS MADE HERE AT ALL, since it costs a display frame and buys no
// throughput: a `render_video` that never returns would take the run with it on
// the thread that steps, and on the page it would wedge the tab. Here it wedges
// a thread the page can replace, and the simulation plays on.
// `madhousearcade`'s `docs/archived/render-worker-plan.md` at `3f4fdb8d` argues
// the trade and prices the frame.
//
// WHY THE PAGE DRAWS rather than this thread, into an `OffscreenCanvas` of its
// own: a Safari worker's animation frame is not the display's, for WebGL2 as for
// a 2D canvas - 57.6 to 58.0 Hz at a concentration of 0.052 and 0.028 against
// the page's frames, where the page reads 0.924 and 0.934 at 59.4 to 59.6 Hz
// (`docs/runs/webgl2-probe-run.md` sections 1 and 2). A picture committed from
// here would be shown at moments the display did not choose.
//
// IT DRAWS ON RECEIPT. One animation frame on the page posts one tick, and a
// tick publishes at most one description, so a description arriving here is a
// page frame that asked for it; a frame loop on this thread would be a second
// rate between the display and the picture.
//
// THERE IS NO HEARTBEAT HERE BUT THE LIST. The page marks its own draw of a new
// list, and `RenderWatch` in `player.js` reads that mark; what this thread says
// about itself is that it is open, and after that it says lists - and lists
// that stop arriving are exactly the silence a renderer is replaced for.
//
// THE DELIVERY RULE, from the receiving end. A description names a resource by
// ID, so a description naming an id whose bytes this instance does not hold is
// a picture drawn out of bytes that are not there. The simulation posts every
// resource this instance has not been handed, and the store's rows, IN the
// message carrying the description that can name one - so the rule is kept by
// the sender and read here as an ordering rather than as a check. A texture is
// the exception that proves it: no call here locks one, so what crosses is its
// row, which is what the list is checked against, and its file goes to be cut
// rather than to be held.
//
// A classic worker rather than a module one, for `sim.worker.js`'s reason and
// `task.worker.js`'s before it: `importScripts` needs no MIME rules on somebody's
// static host, and the file it names sits beside this one because the preview
// copies them all to the same directory.
//
// WHAT IT DOES NOT DO. It never calls `construct` and never calls `step`, it is
// never handed a state block, and it renders no `save` - `Consumer` says why
// each of those is the stepping instance's alone. It holds no store and writes
// no recording, and it holds no canvas, asks for no animation frame and draws
// no pixel.

// `player.js`, exactly as the simulation beside it - `Consumer` and
// `liveTextures` are that file's - and `present.js` for `presentCut` alone,
// which is the cut the conformance probe makes too. No GL is touched here.
importScripts ('player.js', 'present.js');

// The second instance, or null before the page has opened a run. Built at
// `open` rather than at startup, because the addresses it renders into are the
// simulation's and the page cannot say what they are until its arena is down.

let consumer = null;

// The port the simulation publishes down, which runs one way: a renderer that
// answered would be a renderer the simulation waited on. What this thread
// says, it says to the PAGE.

let stream = null;

// The frame the newest description was captured after, the rows of the store
// it was captured against, and whether it came out of the scrub ring - which is
// what the list below carries beside itself.

let drawn = 0;
let rows = [];
let scrubbed = false;

// The game's own renderer, and its list out to the page.
//
// `renderVideo` answers false for an instance that has been handed no
// description yet, so a repaint before the first step posts nothing. It throws
// a list the rules refuse, in the console's sentence, which the page reads as
// this worker's exception and ends the run on.
//
// The list goes out as a golden hashes it - `count` and the records the list
// holds of it, sprites and shapes alike - copied, because the instance writes
// the next one into the same bytes. Nothing here reads a record, so nothing
// here tells a shape from a sprite: `present.js` does, as it draws. `live` is
// the textures the store named live when the description was captured, read
// off the store's rows rather than off the list, so a shape, which names
// nothing in the store, cannot keep a texture alive; it is how the page knows
// when a texture's unload has reached it, and a scrubbed list's rows are an
// old table's and retire nothing.

const draw = () => {
    if (! consumer) { return; }

    if (! consumer.renderVideo ()) { return; }

    const sprites = consumer.sprites.slice ().buffer;

    self.postMessage ({ kind: 'list', frame: drawn,
        width: consumer.frameWidth, height: consumer.frameHeight,
        sprites, live: liveTextures (rows), scrub: scrubbed }, [sprites]);
};

// A texture's four levels, cut out of its file by `presentCut` and posted to
// the page with the id its sprites will name it by. The four bitmaps are
// transferred.
//
// A file the browser will not cut is said to the page rather than thrown here:
// what the page does about it is fail the load, which a throw on this thread
// would turn into the end of the run.

const cut = async (texture) => {
    try {
        const levels = await presentCut (texture.bytes, texture.width,
            texture.height);

        self.postMessage ({ kind: 'levels', id: texture.id, file: texture.file,
            width: texture.width, height: texture.height, levels }, levels);
    } catch (error) {
        self.postMessage ({ kind: 'levels', id: texture.id, file: texture.file,
            width: texture.width, height: texture.height, levels: null,
            reason: `${error && error.message || error}` });
    }
};

// One message from the simulation: a description to draw, the resources scoped
// for `render_video` this instance has not been handed and the rows of the
// store as the step that captured the description left it - or textures to
// cut, which carry nothing else.
//
// In that order, and in one message, which is the whole of the delivery rule
// from this end: the bytes land at their addresses, the mirror is made the
// table the description was captured against, and only then is anything drawn.
//
// A SCRUBBED FRAME COMES DOWN THE SAME PATH, marked `scrub`: an old description
// out of the simulation's ring with the rows it was captured against and no
// bytes, because a scrub delivers nothing. `Consumer.mirrorResources` says why
// the mirror keeps what it holds for it.

const receive = (said) => {
    if (! consumer) { return; }

    if (said.textures) {
        for (const texture of said.textures) { cut (texture); }

        return;
    }

    consumer.acceptResources (said.fresh);
    consumer.mirrorResources (said.rows, said.scrub === true);

    consumer.acceptDescriptions ({ videoState: said.videoState });

    drawn = said.frame;
    rows = said.rows || [];
    scrubbed = said.scrub === true;

    draw ();
};

self.onmessage = (event) => {
    const message = event.data;

    switch (message.kind) {

    // A new run, which is a new instance and a new linear memory. The page
    // builds a fresh worker for a reset rather than reopening this one, so this
    // happens once per worker. It arrives after the simulation has opened,
    // because everything in it that is not the module is a fact about the
    // simulation's arena.
    case 'open': {
        // The BYTES rather than the compiled module, compiled here, so one
        // spelling serves this consumer and the worklet, which cannot be handed
        // a module. The trampoline and the rulebook arrive compiled, and the
        // rulebook is what this instance's mirror of the store is kept in.
        consumer = new Consumer (new WebAssembly.Module (message.bytes),
            message.layout, message.trampoline, message.core);

        // The regions the simulation laid down once and never writes again:
        // the argument storage and the save blob `construct` was handed.
        for (const region of message.resident || []) {
            consumer.accept (region.address, region.bytes);
        }

        stream = message.port;
        stream.onmessage = (said) => receive (said.data);

        // It is up, which is what ARMS the page's render watchdog: a
        // `render_video` that never returns from its FIRST call would
        // otherwise arm nothing and be reported by nothing. Posted after the
        // port is listened to, so the order the page reads is the real one.
        self.postMessage ({ kind: 'ready' });

        break;
    }

    // The page wants the list made again from the description this instance
    // already holds, whatever the last step claimed. It carries the frame the
    // last description carried, so the page recognises a list it has already
    // drawn and marks no new draw for it.
    case 'repaint':
        draw ();

        break;

    // The run is over. Closing this end of the channel is what lets the
    // simulation close its own, and dropping the instance is what stops a
    // description still in the port's queue from being drawn for a run that
    // no longer exists.
    case 'close':
        if (stream) { stream.close (); stream = null; }

        consumer = null;

        break;
    }
};
