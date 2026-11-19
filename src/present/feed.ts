// In the desktop app: shares the presenter with pages elsewhere through the
// app's local server (desktop/server.mjs, /feed). A page at
// http://127.0.0.1:<port>/present.html?feed (a FreeShow web item, an OBS
// browser source, a browser on the same machine) asks for frames there; this
// window answers, exactly as it answers its own presenter window.

import { desktop } from '../app/desktop';
import type { PresenterHost, PresenterTransport } from './host';
import type { ControllerMessage, PresenterMessage } from './protocol';

/** Each frame for a page elsewhere starts with that page's id (a UUID). */
export const FEED_ID_LENGTH = 36;

export function connectFeed(host: PresenterHost): void {
  const bridge = desktop;
  if (!bridge?.feed) return;
  let socket: WebSocket | null = null;
  let remove: (() => void) | null = null;
  let attempt = 0;
  const encoder = new TextEncoder();

  const transport: PresenterTransport = {
    send(message: ControllerMessage) {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (message.type === 'frame') {
        const body = new Uint8Array(message.frame);
        const out = new Uint8Array(FEED_ID_LENGTH + body.length);
        out.set(encoder.encode(message.to.slice(0, FEED_ID_LENGTH).padEnd(FEED_ID_LENGTH)));
        out.set(body, FEED_ID_LENGTH);
        socket.send(out);
      } else {
        socket.send(JSON.stringify(message));
      }
    },
  };

  const open = async () => {
    const info = await bridge.feed!().catch(() => null);
    if (!info) return;
    const ws = new WebSocket(`${info.url}?role=host&key=${encodeURIComponent(info.key)}`);
    ws.binaryType = 'arraybuffer';
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      remove = host.addTransport(transport);
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        host.receive(JSON.parse(event.data) as PresenterMessage, transport);
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      remove?.();
      remove = null;
      if (socket === ws) socket = null;
      window.setTimeout(() => void open(), Math.min(10000, 500 * 2 ** attempt++));
    };
  };
  void open();
}
