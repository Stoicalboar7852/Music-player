// In the desktop app: carries out commands from its control API
// (http://127.0.0.1:<port>/api/command?key=…&do=…, see desktop/server.mjs),
// which FreeShow actions, Bitfocus Companion or a Stream Deck can call, and
// from presentation software cue sync (desktop/stagelink.mjs). Each answers
// with what Phosphor is doing afterwards.

import type { Overlays } from '../present/protocol';
import type { App } from './app';
import { desktop } from './desktop';

const OVERLAYS: (keyof Overlays)[] = ['qr', 'title', 'logo', 'blackout', 'freeze'];

/** What Phosphor is doing, for the control API's answers and /api/status. */
export function remoteStatus(app: App) {
  const track = app.player.current;
  return {
    playing: app.player.playing,
    title: track?.title ?? '',
    artist: track?.artist ?? '',
    source: track?.source ?? '',
    visualizer: app.renderer.currentId ?? '',
    presenting: app.presenter.status !== 'closed',
    overlays: { ...app.presenter.overlays },
    volume: Math.round(app.player.volume * 100) / 100,
  };
}

/** "1", "on", "true" → true; "0", "off", "false" → false; "toggle" or nothing → the opposite of now. */
function onOff(value: string | undefined, now: boolean): boolean {
  const v = (value ?? 'toggle').toLowerCase();
  if (['1', 'on', 'true', 'yes', 'show'].includes(v)) return true;
  if (['0', 'off', 'false', 'no', 'hide'].includes(v)) return false;
  return !now;
}

/** Carries out one command; throws with a plain explanation when it can't. */
export async function runCommand(app: App, name: string, params: Record<string, string>) {
  const { player, renderer, presenter } = app;
  switch (name) {
    case 'play':
      await player.play();
      break;
    case 'pause':
      await player.pause();
      break;
    case 'toggle':
      await player.toggle();
      break;
    case 'next':
      await player.next();
      break;
    case 'previous':
      await player.previous();
      break;
    case 'volume': {
      const volume = Number(params.value);
      if (!Number.isFinite(volume)) throw new Error('volume needs value=0…1');
      player.setVolume(volume > 1 ? volume / 100 : volume);
      break;
    }
    case 'visualizer': {
      const wanted = (params.id ?? params.name ?? '').toLowerCase();
      const def = renderer.defs.find((d) => d.id === wanted || d.name.toLowerCase() === wanted);
      if (!def) throw new Error(`no visualizer "${params.id ?? params.name ?? ''}" (ids: ${renderer.defs.map((d) => d.id).join(', ')})`);
      app.setVisualizer(def.id);
      break;
    }
    case 'visualizer-next':
      app.stepVisualizer(1);
      break;
    case 'visualizer-previous':
      app.stepVisualizer(-1);
      break;
    case 'overlay': {
      const overlay = params.name as keyof Overlays;
      if (!OVERLAYS.includes(overlay)) throw new Error(`overlay needs name=${OVERLAYS.join('|')}`);
      presenter.setOverlay(overlay, onOff(params.on, presenter.overlays[overlay]));
      break;
    }
    case 'qr':
    case 'title':
    case 'logo':
    case 'blackout':
    case 'freeze':
      presenter.setOverlay(name, onOff(params.on, presenter.overlays[name]));
      break;
    case 'present':
      if (onOff(params.on, presenter.status !== 'closed')) {
        if (presenter.status === 'closed') presenter.open();
      } else presenter.close();
      break;
    case 'status':
      break;
    default:
      throw new Error(`unknown command "${name}"`);
  }
  return remoteStatus(app);
}

export function connectRemote(app: App) {
  desktop?.onRemote?.((name, params) => runCommand(app, name, params));
}
