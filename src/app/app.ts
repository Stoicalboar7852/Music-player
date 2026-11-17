// The shared context every UI module receives.

import type { CaptureManager } from '../audio/capture';
import type { AudioEngine } from '../audio/engine';
import type { IncomingFile } from '../player/local';
import type { Player } from '../player/player';
import type { MusicService } from '../services/types';
import type { Renderer } from '../viz/renderer';

export type SheetName = 'sources' | 'gallery' | 'settings' | 'shortcuts';

export interface App {
  engine: AudioEngine;
  renderer: Renderer;
  player: Player;
  capture: CaptureManager;
  services: MusicService[];

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
}
