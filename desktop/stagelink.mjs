// Cue sync with presentation software, from the desktop app's main process.
//
// ProPresenter (7.9 and later) and FreeShow both have local network APIs.
// Phosphor follows their live slides and reacts to Phosphor commands written
// in a slide's notes, and tells them when a new song starts:
//
//   ProPresenter API (OpenAPI 1.0): GET /version, GET /v1/status/slide
//   (?chunked=true streams {current:{text,notes,uuid}, next}), GET
//   /v1/macro/{id}/trigger and POST /v1/message/{id}/trigger with tokens
//   [{name, text:{text}}]; ids may be a UUID, a name or an index.
//
//   FreeShow API (REST, port 5506 by default): POST {action, ...data}, with
//   "Authorization: Bearer <password>" when one is set. get_* actions answer
//   {action, ..., data}; others answer 204. Used here: get_output (the live
//   slide: {slide:{id, layout, index}}), get_show, get_variables,
//   change_variable {id, key:"text", value} and name_run_action {value}.
//
// Notes commands are lines starting with "phosphor", for example
//   phosphor: visualizer aurora
//   phosphor: blackout on
//   phosphor: next; qr off
// and run through the same commands as the control API (see server.mjs).

const COMMAND = /^[a-z][a-z-]{1,40}$/;
const ALIASES = {
  viz: 'visualizer',
  vis: 'visualizer',
  'next-visualizer': 'visualizer-next',
  'previous-visualizer': 'visualizer-previous',
  'prev-visualizer': 'visualizer-previous',
  prev: 'previous',
  presenter: 'present',
  black: 'blackout',
};
const SWITCHES = new Set(['qr', 'title', 'logo', 'blackout', 'freeze', 'present']);

/** Phosphor commands in slide notes, in order: [{ name, params }]. */
export function parseNoteCommands(notes) {
  const commands = [];
  for (const line of String(notes ?? '').split(/\r?\n/)) {
    const match = /^\s*phosphor\b\s*:?\s*(.*)$/i.exec(line);
    if (!match) continue;
    for (const part of match[1].split(';')) {
      const command = parseCommand(part.trim());
      if (command) commands.push(command);
    }
  }
  return commands;
}

function parseCommand(text) {
  if (!text) return null;
  // The control API's own form: do=visualizer&id=aurora
  if (/^do=/i.test(text)) {
    const query = new URLSearchParams(text);
    const name = normalise(query.get('do'));
    if (!name) return null;
    query.delete('do');
    return { name, params: Object.fromEntries(query) };
  }
  const [first, ...args] = text.split(/\s+/);
  const name = normalise(first);
  if (!name) return null;
  const params = {};
  if (name === 'visualizer' && args.length) params.id = args.join(' ');
  else if (name === 'overlay') {
    if (args[0]) params.name = args[0].toLowerCase();
    if (args[1]) params.on = args[1].toLowerCase();
  } else if (SWITCHES.has(name) && args[0]) params.on = args[0].toLowerCase();
  else if (name === 'volume' && args[0]) params.value = args[0];
  return { name, params };
}

function normalise(word) {
  const name = String(word ?? '').toLowerCase();
  const full = ALIASES[name] ?? name;
  return COMMAND.test(full) ? full : null;
}

/** Pulls whole JSON values out of a stream, whatever separates them. */
export function jsonSplitter(onValue) {
  let buffer = '';
  return (text) => {
    buffer += text;
    for (;;) {
      let start = 0;
      while (start < buffer.length && /\s/.test(buffer[start])) start++;
      if (start >= buffer.length) {
        buffer = '';
        return;
      }
      if (buffer[start] !== '{' && buffer[start] !== '[') {
        // Not JSON (a stray line): skip it.
        const newline = buffer.indexOf('\n', start);
        if (newline < 0) {
          buffer = buffer.slice(start);
          return;
        }
        buffer = buffer.slice(newline + 1);
        continue;
      }
      let depth = 0;
      let inString = false;
      let end = -1;
      for (let i = start; i < buffer.length; i++) {
        const c = buffer[i];
        if (inString) {
          if (c === '\\') i++;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end < 0) {
        buffer = buffer.slice(start);
        return;
      }
      const piece = buffer.slice(start, end);
      buffer = buffer.slice(end);
      try {
        onValue(JSON.parse(piece));
      } catch {
        /* not ours */
      }
    }
  };
}

/** FreeShow's live slide index counts each slide's child slides too (as FreeShow does). */
export function freeshowSlideAt(show, layoutId, index) {
  const layout = show?.layouts?.[layoutId ?? show?.settings?.activeLayout];
  const slides = show?.slides ?? {};
  if (!layout || !Array.isArray(layout.slides)) return null;
  const flat = [];
  for (const layoutSlide of layout.slides) {
    const slide = layoutSlide && slides[layoutSlide.id];
    if (!slide) continue;
    flat.push(slide);
    for (let child of (slide.children ?? []).flat()) {
      if (Array.isArray(child)) child = child[0];
      if (slides[child]) flat.push(slides[child]);
    }
  }
  return flat[index] ?? null;
}

/** Titles go into FreeShow text variables; braces would be read as FreeShow placeholders. */
const plain = (text) => String(text ?? '').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')'));

const describeError = (error) => {
  const code = error?.cause?.code ?? error?.code;
  if (code === 'ECONNREFUSED') return 'not answering';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'address not found';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'no answer (timed out)';
  return error?.cause?.message ?? error?.message ?? String(error);
};

const DEFAULTS = {
  propresenter: { enabled: false, host: '127.0.0.1', port: 50001, notes: true, macro: '', message: '' },
  freeshow: { enabled: false, host: '127.0.0.1', port: 5506, password: '', notes: true, variables: true, action: '' },
};

/**
 * @param {{ onCommand: (name: string, params: Record<string,string>) => Promise<unknown>,
 *           onStatus?: (status: object) => void, log?: (...args: unknown[]) => void,
 *           pollMs?: number, retryMs?: number }} options
 */
export function createStageLink({ onCommand, onStatus = () => {}, log = () => {}, pollMs = 1000, retryMs = 3000 }) {
  let config = structuredClone(DEFAULTS);
  const status = {
    propresenter: { state: 'off', detail: '' },
    freeshow: { state: 'off', detail: '' },
  };
  let song = { title: '', artist: '', visualizer: '' };
  let pro = null;
  let free = null;

  const setStatus = (which, state, detail = '') => {
    const before = status[which];
    if (before.state === state && before.detail === detail) return;
    status[which] = { state, detail };
    onStatus(structuredClone(status));
  };

  const run = async (source, commands) => {
    for (const { name, params } of commands) {
      try {
        await onCommand(name, params);
        log(`${source}: ran "${name}"`, params);
      } catch (error) {
        log(`${source}: "${name}" failed: ${error.message}`);
      }
    }
  };

  // ------------------------------------------------------------- ProPresenter

  function startPro(settings) {
    const base = `http://${settings.host}:${settings.port}`;
    let stopped = false;
    let controller = null;
    let timer = null;
    let lastSlide = null;

    const slide = (data) => {
      // A stream update may arrive wrapped ({url, data}) or bare ({current, next}).
      const value = data && typeof data === 'object' && 'data' in data && 'url' in data ? data.data : data;
      const current = value?.current;
      if (!current || typeof current !== 'object') return;
      const key = current.uuid || `${current.text ?? ''}\u0000${current.notes ?? ''}`;
      if (key === lastSlide) return;
      lastSlide = key;
      if (settings.notes) void run('ProPresenter', parseNoteCommands(current.notes));
    };

    const retry = (detail) => {
      if (stopped) return;
      setStatus('propresenter', 'error', detail);
      timer = setTimeout(connect, retryMs);
    };

    async function connect() {
      if (stopped) return;
      setStatus('propresenter', 'connecting', base);
      try {
        const version = await fetch(`${base}/version`, { signal: AbortSignal.timeout(4000) });
        if (!version.ok) throw new Error(`answered ${version.status}`);
        const info = await version.json().catch(() => ({}));
        const name = info.host_description || 'ProPresenter';
        setStatus('propresenter', 'connected', `${name} at ${settings.host}:${settings.port}`);
        if (!settings.notes) return; // only song changes to send: nothing to follow
        controller = new AbortController();
        const response = await fetch(`${base}/v1/status/slide?chunked=true`, { signal: controller.signal });
        if (!response.ok || !response.body) return poll(name);
        const feed = jsonSplitter(slide);
        const decoder = new TextDecoder();
        for await (const chunk of response.body) feed(decoder.decode(chunk, { stream: true }));
        retry('the connection closed');
      } catch (error) {
        if (!stopped) retry(`${base}: ${describeError(error)}`);
      }
    }

    // Older versions without streaming: ask once a second.
    async function poll(name) {
      while (!stopped) {
        try {
          const response = await fetch(`${base}/v1/status/slide`, { signal: AbortSignal.timeout(4000) });
          if (response.ok) slide(await response.json());
          setStatus('propresenter', 'connected', `${name} at ${settings.host}:${settings.port}`);
        } catch (error) {
          return retry(`${base}: ${describeError(error)}`);
        }
        await new Promise((resolve) => (timer = setTimeout(resolve, pollMs)));
      }
    }

    async function songChanged(next) {
      const calls = [];
      if (settings.macro) calls.push(['macro', `${base}/v1/macro/${encodeURIComponent(settings.macro)}/trigger`, { method: 'GET' }]);
      if (settings.message) {
        const tokens = [
          { name: 'Title', text: { text: next.title } },
          { name: 'Artist', text: { text: next.artist } },
        ];
        calls.push([
          'message',
          `${base}/v1/message/${encodeURIComponent(settings.message)}/trigger`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tokens) },
        ]);
      }
      for (const [what, url, init] of calls) {
        try {
          const response = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });
          if (response.status === 404) setStatus('propresenter', 'error', `ProPresenter has no ${what} named "${what === 'macro' ? settings.macro : settings.message}"`);
          else if (!response.ok) setStatus('propresenter', 'error', `the ${what} answered ${response.status}`);
        } catch (error) {
          setStatus('propresenter', 'error', `${base}: ${describeError(error)}`);
        }
      }
    }

    void connect();
    return {
      songChanged,
      visualizerChanged() {},
      stop() {
        stopped = true;
        clearTimeout(timer);
        controller?.abort();
      },
    };
  }

  // ----------------------------------------------------------------- FreeShow

  function startFree(settings) {
    const base = `http://${settings.host}:${settings.port}/`;
    let stopped = false;
    let timer = null;
    let lastSlide = null;
    let shows = new Map();

    async function call(action, data = {}) {
      const headers = { 'content-type': 'application/json' };
      if (settings.password) headers.authorization = `Bearer ${settings.password}`;
      const response = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, ...data }),
        signal: AbortSignal.timeout(action.startsWith('get_') ? 11000 : 4000),
      });
      if (response.status === 401) throw new Error('wrong or missing password (FreeShow → Settings → Connection)');
      if (response.status === 204) return null;
      if (!response.ok) throw new Error(`answered ${response.status}`);
      return response.json().catch(() => null);
    }

    const variables = async () => {
      const reply = await call('get_variables');
      return Array.isArray(reply?.data) ? reply.data : [];
    };

    const setVariables = async (values) => {
      if (!settings.variables) return;
      const list = await variables();
      const wanted = Object.entries(values);
      for (const [name, value] of wanted) {
        // Only variables named exactly so: FreeShow matches names loosely, and
        // would otherwise change whichever variable is closest.
        const found = list.find((v) => String(v.name ?? '').toLowerCase().trim().replaceAll(' ', '_') === name);
        if (found?.id) await call('change_variable', { id: found.id, key: 'text', value: plain(value) });
      }
    };

    async function follow() {
      while (!stopped) {
        try {
          const output = await call('get_output');
          const live = output?.data?.slide;
          const key = live?.id ? `${live.id}|${live.layout ?? ''}|${live.index ?? ''}` : '';
          if (key && key !== lastSlide) {
            lastSlide = key;
            let show = shows.get(live.id);
            if (!show) {
              show = (await call('get_show', { id: live.id }))?.data ?? null;
              if (show) shows.set(live.id, show);
            }
            let slide = freeshowSlideAt(show, live.layout, live.index ?? -1);
            if (!slide && show) {
              // Edited since it was fetched: fetch it again.
              show = (await call('get_show', { id: live.id }))?.data ?? null;
              if (show) shows.set(live.id, show);
              slide = freeshowSlideAt(show, live.layout, live.index ?? -1);
            }
            if (slide?.notes) void run('FreeShow', parseNoteCommands(slide.notes));
          } else if (!key) lastSlide = null;
          setStatus('freeshow', 'connected', `FreeShow at ${settings.host}:${settings.port}`);
        } catch (error) {
          setStatus('freeshow', 'error', `${base}: ${describeError(error)}`);
          shows = new Map();
        }
        await new Promise((resolve) => (timer = setTimeout(resolve, pollMs)));
      }
    }

    async function connect() {
      setStatus('freeshow', 'connecting', base);
      try {
        await variables();
        setStatus('freeshow', 'connected', `FreeShow at ${settings.host}:${settings.port}`);
        if (song.title) await setVariables({ phosphor_title: song.title, phosphor_artist: song.artist, phosphor_visualizer: song.visualizer });
      } catch (error) {
        if (stopped) return;
        setStatus('freeshow', 'error', `${base}: ${describeError(error)}`);
        timer = setTimeout(connect, retryMs);
        return;
      }
      if (settings.notes) void follow();
    }

    void connect();
    return {
      async songChanged(next) {
        try {
          await setVariables({ phosphor_title: next.title, phosphor_artist: next.artist, phosphor_visualizer: next.visualizer });
          if (settings.action) await call('name_run_action', { value: settings.action });
        } catch (error) {
          setStatus('freeshow', 'error', `${base}: ${describeError(error)}`);
        }
      },
      async visualizerChanged(next) {
        try {
          await setVariables({ phosphor_visualizer: next.visualizer });
        } catch {
          /* reported by the next poll */
        }
      },
      stop() {
        stopped = true;
        clearTimeout(timer);
      },
    };
  }

  // --------------------------------------------------------------- the link

  const clean = (value, fallback) => ({ ...fallback, ...(value && typeof value === 'object' ? value : {}) });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  return {
    /** New settings from the page (Settings → Presentation software). */
    configure(next) {
      const proSettings = clean(next?.propresenter, DEFAULTS.propresenter);
      const freeSettings = clean(next?.freeshow, DEFAULTS.freeshow);
      if (!same(proSettings, config.propresenter)) {
        pro?.stop();
        pro = null;
        if (proSettings.enabled && proSettings.host) pro = startPro(proSettings);
        else setStatus('propresenter', 'off');
      }
      if (!same(freeSettings, config.freeshow)) {
        free?.stop();
        free = null;
        if (freeSettings.enabled && freeSettings.host) free = startFree(freeSettings);
        else setStatus('freeshow', 'off');
      }
      config = { propresenter: proSettings, freeshow: freeSettings };
    },
    /** What Phosphor is playing (the main window's state): new songs and visualizers go out. */
    update(state) {
      const next = { title: state?.title ?? '', artist: state?.artist ?? '', visualizer: state?.visualizer ?? '' };
      const newSong = next.title !== song.title || next.artist !== song.artist;
      const newVisualizer = next.visualizer !== song.visualizer;
      song = next;
      if (newSong && next.title) {
        void pro?.songChanged(next);
        void free?.songChanged(next);
      } else if (newVisualizer) {
        void free?.visualizerChanged(next);
      }
    },
    get status() {
      return structuredClone(status);
    },
    stop() {
      pro?.stop();
      free?.stop();
      pro = free = null;
    },
  };
}
