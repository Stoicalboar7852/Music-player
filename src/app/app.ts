// The shared context every UI module receives.

import type { CaptureManager } from '../audio/capture';
import type { AudioEngine } from '../audio/engine';
import type { BeatGrids } from '../audio/grids';
import type { PlaylistLibrary } from '../library/playlists';
import type { IncomingFile } from '../player/local';
import type { Player } from '../player/player';
import type { Collection, Track } from '../player/types';
import type { MusicService } from '../services/types';
import type { Renderer } from '../viz/renderer';

export type SheetName = 'sources' | 'gallery' | 'settings' | 'shortcuts' | 'library';

export interface App {
  engine: AudioEngine;
  renderer: Renderer;
  player: Player;
  capture: CaptureManager;
  services: MusicService[];
  library: PlaylistLibrary;
  /** Beat grids for local files, worked out in the background. */
  beatGrids: BeatGrids;

  toast(message: string, kind?: 'info' | 'error'): void;
  /** Opens a sheet, optionally on a specific tab/section. */
  openSheet(name: SheetName, section?: string): void;
  closeSheet(): void;
  toggleQueue(force?: boolean): void;

  addFiles(files: IncomingFile[], opts?: { play?: boolean }): void;
  openFilePicker(): void;
  openFolderPicker(): Promise<void>;
  playDemo(): Promise<void>;
  /** Opens the browser's share dialog; `thisTab` offers the current tab first. */
  startCapture(opts?: { thisTab?: boolean }): Promise<void>;
  toggleFullscreen(): void;
  setVisualizer(id: string): void;
  stepVisualizer(direction: 1 | -1): void;
  setAutoCycle(on: boolean): void;
  /** Plays (or, with append, queues) a Phosphor playlist. Call from a click: local files may need permission again. */
  playPlaylist(id: string, opts?: { append?: boolean }): Promise<void>;
  /** Opens the "add to which playlist?" menu next to `anchor`. */
  addToPlaylist(anchor: HTMLElement, what: { tracks?: Track[]; collection?: Collection; label: string }): void;
}
