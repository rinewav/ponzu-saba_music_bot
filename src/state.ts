import { Collection } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerQueue, QueueMap, VolumeSettings, VcState, PlaybackState } from './types.js';

let instanceIndex = 0;

export const queue: QueueMap = new Collection();

export const downloadDir = path.join(process.cwd(), 'downloads');
export function vcStateFile(): string {
  return path.join(process.cwd(), `active_vcs_${instanceIndex}.json`);
}
export function volumeConfigFile(): string {
  return path.join(process.cwd(), `volume_settings_${instanceIndex}.json`);
}
export function playbackStateFile(): string {
  return path.join(process.cwd(), `playback_state_${instanceIndex}.json`);
}

export let volumeSettings: VolumeSettings = {};

export function setInstanceIndex(index: number): void {
  instanceIndex = index;
}

export function getInstanceIndex(): number {
  return instanceIndex;
}

export function initVolumeSettings(): void {
  try {
    if (fs.existsSync(volumeConfigFile())) {
      volumeSettings = JSON.parse(fs.readFileSync(volumeConfigFile(), 'utf-8'));
    }
  } catch (error) {
    console.error('音量設定ファイルの読み込みに失敗しました:', error);
  }
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }
}

export function saveVcState(guildId: string, channelId: string): void {
  let states: VcState = {};
  if (fs.existsSync(vcStateFile())) {
    states = JSON.parse(fs.readFileSync(vcStateFile(), 'utf-8'));
  }
  states[guildId] = channelId;
  fs.writeFileSync(vcStateFile(), JSON.stringify(states, null, 2));
}

export function deleteVcState(guildId: string): void {
  if (fs.existsSync(vcStateFile())) {
    const states: VcState = JSON.parse(fs.readFileSync(vcStateFile(), 'utf-8'));
    delete states[guildId];
    fs.writeFileSync(vcStateFile(), JSON.stringify(states, null, 2));
  }
}

export function saveVolumeSettings(): void {
  try {
    fs.writeFileSync(volumeConfigFile(), JSON.stringify(volumeSettings, null, 2));
  } catch (error) {
    console.error('音量設定の保存に失敗しました:', error);
  }
}

export function savePlaybackState(guildId: string, url: string, title: string, channelId: string): void {
  try {
    const state: Record<string, PlaybackState> = fs.existsSync(playbackStateFile())
      ? JSON.parse(fs.readFileSync(playbackStateFile(), 'utf-8'))
      : {};
    state[guildId] = { url, title, channelId };
    fs.writeFileSync(playbackStateFile(), JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('再生状態の保存に失敗しました:', error);
  }
}

export function clearPlaybackState(guildId: string): void {
  try {
    if (!fs.existsSync(playbackStateFile())) return;
    const state: Record<string, PlaybackState> = JSON.parse(fs.readFileSync(playbackStateFile(), 'utf-8'));
    delete state[guildId];
    fs.writeFileSync(playbackStateFile(), JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('再生状態のクリアに失敗しました:', error);
  }
}

export function loadPlaybackStates(): Record<string, PlaybackState> {
  try {
    if (!fs.existsSync(playbackStateFile())) return {};
    return JSON.parse(fs.readFileSync(playbackStateFile(), 'utf-8'));
  } catch (error) {
    console.error('再生状態の読み込みに失敗しました:', error);
    return {};
  }
}
