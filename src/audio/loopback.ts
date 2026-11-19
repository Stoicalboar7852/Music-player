// Loopback devices: virtual sound devices that carry what the computer plays
// back in as an input (BlackHole or Loopback on a Mac, VB-CABLE or Stereo Mix
// on Windows, PulseAudio/PipeWire monitors on Linux). Listening to one needs
// the browser's microphone permission once; after that Phosphor can listen by
// itself whenever a streaming song plays, with no share dialog, and it hears
// other apps too (the Spotify app, Apple Music...).

import type { Platform } from './capture';

interface Pattern {
  test: RegExp;
  name: string;
  /** Higher is a better guess. */
  rank: number;
}

const PATTERNS: Pattern[] = [
  { test: /blackhole/i, name: 'BlackHole', rank: 10 },
  { test: /^monitor of |\.monitor$/i, name: 'Monitor', rank: 10 },
  { test: /cable output|vb-audio virtual cable|vb-cable/i, name: 'VB-CABLE', rank: 10 },
  // Windows' own, in the languages its drivers use.
  { test: /stereo ?mix|what u hear|wave out mix|mixage st[ée]r[ée]o|mezcla est[ée]reo|missaggio stereo|mixagem est[ée]reo|mistura est[ée]reo|stereomix/i, name: 'Stereo Mix', rank: 9 },
  { test: /^loopback audio|rogue amoeba|\bloopback\b/i, name: 'Loopback', rank: 9 },
  { test: /voicemeeter (out|output|aux out)|vb-audio voicemeeter/i, name: 'Voicemeeter', rank: 8 },
  { test: /virtual audio cable|line \d+ \(virtual/i, name: 'Virtual Audio Cable', rank: 8 },
  { test: /soundflower/i, name: 'Soundflower', rank: 7 },
  { test: /background music/i, name: 'Background Music', rank: 7 },
];

export interface LoopbackMatch {
  deviceId: string;
  label: string;
  /** Which kind of loopback it looks like (BlackHole, VB-CABLE, Stereo Mix…). */
  kind: string;
  rank: number;
}

/**
 * The inputs that look like loopback devices, best first. Windows lists the
 * default and communications devices twice ("Default - …"); the real entry
 * is kept. Labels are empty until the microphone permission is granted.
 */
export function findLoopbacks(devices: Pick<MediaDeviceInfo, 'deviceId' | 'label' | 'kind'>[]): LoopbackMatch[] {
  const out: LoopbackMatch[] = [];
  for (const device of devices) {
    if (device.kind !== 'audioinput' || !device.label) continue;
    if (device.deviceId === 'default' || device.deviceId === 'communications') continue;
    const pattern = PATTERNS.find((p) => p.test.test(device.label));
    if (pattern) out.push({ deviceId: device.deviceId, label: device.label, kind: pattern.name, rank: pattern.rank });
  }
  return out.sort((a, b) => b.rank - a.rank);
}

export interface LoopbackGuide {
  /** Steps to set one up on this computer. */
  steps: (string | { text: string; href: string })[][];
  note?: string;
}

/** How to set up a loopback device, per operating system. */
export function loopbackGuide(platform: Platform): LoopbackGuide | null {
  switch (platform) {
    case 'mac':
      return {
        steps: [
          ['Install BlackHole 2ch (free and open source): ', { text: 'existential.audio/blackhole', href: 'https://existential.audio/blackhole/' }, '.'],
          ['Open Audio MIDI Setup (in Applications → Utilities), click + at the bottom left and choose Create Multi-Output Device. Tick your speakers or headphones, and BlackHole 2ch.'],
          ['In System Settings → Sound, choose that Multi-Output Device as the output. You still hear everything, and BlackHole gets a copy.'],
          ['Back here, press Find devices and choose BlackHole 2ch.'],
        ],
        note: "macOS's volume keys don't change a Multi-Output Device; set the volume in the app that's playing, or switch the output back to your speakers when you're done.",
      };
    case 'windows':
      return {
        steps: [
          ['If your sound card has Stereo Mix (many do): open Settings → System → Sound → More sound settings → Recording, right-click and choose Show Disabled Devices, then right-click Stereo Mix and choose Enable. Choose it here.'],
          ['Otherwise install VB-CABLE (free): ', { text: 'vb-audio.com/Cable', href: 'https://vb-audio.com/Cable/' }, '. Choose CABLE Input as your output device; to still hear it, open More sound settings → Recording → CABLE Output → Properties → Listen, tick Listen to this device and pick your speakers.'],
          ['Back here, press Find devices and choose Stereo Mix or CABLE Output.'],
        ],
      };
    case 'linux':
      return {
        steps: [['Nothing to install: PulseAudio and PipeWire offer a "Monitor of …" input for each output. Press Find devices and choose the monitor of the output you listen on.']],
      };
    default:
      return null;
  }
}

export type LoopbackResult = 'listening' | 'needs-permission' | 'missing' | 'denied' | 'failed';

interface InputCapture {
  listInputs(): Promise<MediaDeviceInfo[]>;
  startInput(deviceId?: string, label?: string): Promise<void>;
}

/**
 * Starts listening to the chosen loopback device. Without a click to go on
 * (a song moving on by itself), it only goes ahead once the microphone
 * permission is granted, so no prompt appears out of the blue.
 */
export async function listenToLoopback(capture: InputCapture, device: { id: string; label: string }, opts: { fromClick: boolean }): Promise<LoopbackResult> {
  const permission = await navigator.permissions?.query({ name: 'microphone' as PermissionName }).catch(() => null);
  if (permission?.state === 'denied') return 'denied';
  if (permission?.state !== 'granted' && !opts.fromClick) return 'needs-permission';
  let deviceId = device.id;
  if (permission?.state === 'granted') {
    // Ids stay the same while the site keeps its data; otherwise find it by name.
    const inputs = await capture.listInputs().catch(() => [] as MediaDeviceInfo[]);
    const found = inputs.find((d) => d.deviceId === device.id) ?? inputs.find((d) => d.label === device.label);
    if (!found) return 'missing';
    deviceId = found.deviceId;
  }
  try {
    await capture.startInput(deviceId, device.label);
    return 'listening';
  } catch (error) {
    const reason = (error as { reason?: string }).reason;
    if (reason === 'dismissed') return 'denied';
    // A stale id after site data was cleared: try again by name now that names show.
    const inputs = await capture.listInputs().catch(() => [] as MediaDeviceInfo[]);
    const byName = inputs.find((d) => d.label === device.label && d.deviceId !== deviceId);
    if (byName) {
      try {
        await capture.startInput(byName.deviceId, device.label);
        return 'listening';
      } catch {
        /* reported below */
      }
    }
    return inputs.some((d) => d.label === device.label) ? 'failed' : 'missing';
  }
}
