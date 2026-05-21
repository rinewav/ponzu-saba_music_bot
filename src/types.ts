import type {
  TextChannel,
  User,
  Message,
  Collection,
  VoiceBasedChannel,
} from 'discord.js';
import type { VoiceConnection, AudioPlayer, AudioResource } from '@discordjs/voice';
import type { ChildProcess } from 'node:child_process';
import type { ExecaChildProcess } from 'execa';

export interface LyricLine {
  start: number;
  end: number;
  text: string;
}

export interface Song {
  title: string;
  url: string;
  webpage_url: string;
  uploader: string;
  duration: number;
  duration_string: string;
  is_live: boolean;
  thumbnail: string;
  requestedBy: User;
  status: 'queued' | 'downloading' | 'downloaded' | 'error';
  filePath: string | null;
  lufs: string | null;
  lyrics: LyricLine[] | null;
  downloadProgress?: number;
  downloadPromise?: Promise<void>;
}

export interface ServerQueue {
  textChannel: TextChannel | null;
  voiceChannel: VoiceBasedChannel;
  connection: VoiceConnection | null;
  player: AudioPlayer;
  songs: Song[];
  volume: number;
  currentFilter: 'off' | 'bassboost' | 'loudness';
  currentMode: string;
  progressInterval: ReturnType<typeof setInterval> | null;
  lyricsInterval: ReturnType<typeof setInterval> | null;
  nowPlayingMessage: Message<true> | null;
  lyricsMessage: Message<true> | null;
  resource: AudioResource | null;
  stopped: boolean;
  skipping: boolean;
  streamProcess: import('execa').ExecaChildProcess | null;
  activeDownload: import('execa').ExecaChildProcess | null;
  isStreamReconnecting: boolean;
  isDownloading: boolean;
}

export type QueueMap = Collection<string, ServerQueue>;
export type VolumeSettings = Record<string, number>;
export type VcState = Record<string, string>;

export interface PlaybackState {
  url: string;
  title: string;
  channelId: string;
}

export type BotStatus = 'offline' | 'online' | 'playing';

export interface BotConfig {
  name: string;
  token: string;
}

export interface IpcStatusMessage {
  type: 'status';
  status: BotStatus;
  detail?: string;
}

export interface IpcLogMessage {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type ChildMessage = IpcStatusMessage | IpcLogMessage;

export type ParentMessage =
  | { type: 'init'; config: BotConfig; guildId: string; instanceIndex: number }
  | { type: 'restart' }
  | { type: 'shutdown' };

export interface LogEntry {
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface InstanceState {
  name: string;
  status: BotStatus;
  detail?: string;
  logs: LogEntry[];
  process: ChildProcess | null;
  restartCount: number;
  lastRestartAt: Date | null;
  intentionallyStopped: boolean;
}
