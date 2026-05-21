import {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  getVoiceConnection,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  entersState,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Guild, TextChannel, ChatInputCommandInteraction, StringSelectMenuInteraction, GuildMember } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { create as createYtdlp } from 'yt-dlp-exec';
import dotenv from 'dotenv';
dotenv.config();
const ytdlpExec = createYtdlp(process.env.YTDLP_PATH || 'yt-dlp').exec;
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Song, ServerQueue } from './types.js';
import { queue, downloadDir, volumeSettings, saveVolumeSettings, savePlaybackState, clearPlaybackState } from './state.js';
import { measureLufs, fetchAndParseLyrics } from './audio.js';
import { createPlayerControlButtons, createNowPlayingEmbed, startUpdateIntervals } from './ui.js';
import CustomEmbed from './lib/defaultEmbed.js';
import { sendToParent } from './ipc.js';
import type { ExecaChildProcess } from 'execa';

export type StatusCallback = (playing: boolean, songTitle?: string) => void;
let onStatusChange: StatusCallback | null = null;

export function setStatusCallback(cb: StatusCallback): void {
  onStatusChange = cb;
}

export function setupConnectionHandlers(connection: VoiceConnection, guildId: string): void {
  connection.on('error', (err) => {
    console.error(`VoiceConnection エラー (GuildID: ${guildId}):`, err.message);
  });
  connection.on(VoiceConnectionStatus.Disconnected, async (_oldState, newState) => {
    try {
      if (
        newState.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
        newState.closeCode === 4014
      ) {
        await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
      } else {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      }
    } catch {
      console.warn(`VC再接続失敗 (GuildID: ${guildId}). 接続破棄します。`);
      try { connection.destroy(); } catch {}
    }
  });
}

function setupPlayerErrorHandler(sq: ServerQueue, guildId: string): void {
  sq.player.removeAllListeners('error');
  sq.player.on('error', (err) => {
    console.error(`AudioPlayer エラー (GuildID: ${guildId}):`, err.message);
  });
}

function killStreamProcess(sq: ServerQueue): void {
  if (sq.streamProcess && !sq.streamProcess.killed) {
    try {
      sq.streamProcess.kill('SIGKILL');
    } catch {
      sq.streamProcess.kill();
    }
    sq.streamProcess = null;
  }
}

async function startStreamPlayback(guild: Guild, song: Song, textChannel: TextChannel, sq: ServerQueue, isRetry: boolean): Promise<boolean> {
  killStreamProcess(sq);

  const streamArgs: Record<string, unknown> = {
    output: '-',
    extractAudio: true,
    audioFormat: 'opus',
    audioQuality: 0,
    retries: 10,
    fragmentRetries: 10,
    hlsPreferNative: true,
  };

  if (isRetry) {
    console.log(`ライブ配信の再接続を試みます: ${song.title}`);
  }

  const streamProcess = ytdlpExec(song.url, streamArgs) as ExecaChildProcess;
  if (!streamProcess.stdout) throw new Error('ストリーミングプロセスのstdoutが取得できません。');

  sq.streamProcess = streamProcess;

  streamProcess.on('error', (err) => {
    console.error('ストリームプロセスエラー:', err.message);
  });

  streamProcess.catch((err) => {
    console.error('ストリームプロセス終了:', err?.message ?? 'unknown');
  });

  const resource = createAudioResource(streamProcess.stdout, { metadata: { song }, inlineVolume: true });
  resource.volume!.setVolume(sq.volume);
  sq.resource = resource;
  sq.currentMode = 'ストリーミング';
  sq.player.play(resource);

  if (streamProcess.stderr) {
    streamProcess.stderr.on('data', () => {});
  }

  sendToParent({ type: 'status', status: 'playing', detail: song.title });
  onStatusChange?.(true, song.title);
  savePlaybackState(guild.id, song.url, song.title, textChannel.id);
  return true;
}

async function playSong(guild: Guild, song: Song | undefined, textChannel: TextChannel): Promise<void> {
  const serverQueue = queue.get(guild.id);
  if (!song) {
    sendToParent({ type: 'status', status: 'online' });
    onStatusChange?.(false);
    clearPlaybackState(guild.id);
    if (serverQueue?.textChannel) {
      serverQueue.textChannel.send({ embeds: [new CustomEmbed().setDescription('キューの再生が終了しました。')] });
    }
    return;
  }

  if (serverQueue!.progressInterval) clearInterval(serverQueue!.progressInterval);
  if (serverQueue!.lyricsInterval) clearInterval(serverQueue!.lyricsInterval);
  if (serverQueue!.nowPlayingMessage) {
    await serverQueue!.nowPlayingMessage.delete().catch(() => {});
    serverQueue!.nowPlayingMessage = null;
  }
  if (serverQueue!.lyricsMessage) {
    await serverQueue!.lyricsMessage.delete().catch(() => {});
    serverQueue!.lyricsMessage = null;
  }

  let resource;
  const sq = serverQueue!;

  const isLive = song.is_live;

  sq.player.removeAllListeners(AudioPlayerStatus.Idle);
  sq.player.on(AudioPlayerStatus.Idle, () => {
    if (sq.progressInterval) clearInterval(sq.progressInterval);
    if (sq.lyricsInterval) clearInterval(sq.lyricsInterval);
    if (sq.nowPlayingMessage) sq.nowPlayingMessage.delete().catch(() => {});
    if (sq.lyricsMessage) sq.lyricsMessage.delete().catch(() => {});

    const finishedSong = sq.songs[0];
    const wasLive = finishedSong && finishedSong.is_live;
    if (finishedSong?.filePath && fs.existsSync(finishedSong.filePath)) {
      try {
        fs.unlinkSync(finishedSong.filePath);
      } catch (e) {
        console.error('一時ファイルの削除に失敗:', e);
      }
    }
    sq.songs.shift();

    if (sq.stopped) {
      sq.stopped = false;
      killStreamProcess(sq);
      return;
    }

    if (wasLive && !sq.isStreamReconnecting) {
      sq.isStreamReconnecting = true;
      console.log(`ライブ配信が切断されました。5秒後に再接続します: ${finishedSong!.title}`);
      sq.textChannel?.send({ embeds: [new CustomEmbed().setColor(0xFFFF00).setDescription(`ライブ配信が切断されました。5秒後に再接続します: [${finishedSong!.title}](${finishedSong!.url})`)] }).catch(() => {});
      setTimeout(() => {
        sq.isStreamReconnecting = false;
        const reconnectedSong: Song = {
          ...finishedSong!,
          status: 'queued',
          filePath: null,
          lufs: null,
          lyrics: null,
        };
        sq.songs.unshift(reconnectedSong);
        playSong(guild, sq.songs[0], sq.textChannel ?? textChannel);
      }, 5000);
      return;
    }

    killStreamProcess(sq);
    playSong(guild, sq.songs[0], sq.textChannel ?? textChannel);
  });

  if (!isLive && song.status === 'downloading' && song.downloadPromise) {
    sq.currentMode = 'ダウンロード';
    const progressEmbed = new CustomEmbed()
      .setTitle(`ダウンロード中: ${song.title.slice(0, 50)}...`)
      .setDescription(`${':black_large_square:'.repeat(10)}(0%)`);
    const progressMessage = await textChannel.send({ embeds: [progressEmbed] });
    const progressTimer = setInterval(() => {
      const pct = Math.round(song.downloadProgress ?? 0);
      const barCount = Math.round(pct / 10);
      const bar = ':green_square:'.repeat(barCount) + ':black_large_square:'.repeat(10 - barCount);
      progressEmbed.setDescription(`${bar}(${pct}%)`);
      progressMessage.edit({ embeds: [progressEmbed] }).catch(() => {});
    }, 1000);

    await song.downloadPromise;
    clearInterval(progressTimer);

    const currentStatus = (song as { status: string }).status;
    if (currentStatus === 'downloaded' && song.filePath && fs.existsSync(song.filePath)) {
      const finalBar = ':green_square:'.repeat(10);
      progressEmbed.setTitle('ダウンロード完了！').setDescription(`${finalBar}(100%)`);
      await progressMessage.edit({ embeds: [progressEmbed] }).catch(() => {});
      setTimeout(() => progressMessage.delete().catch(() => {}), 1500);
      resource = createAudioResource(song.filePath, { metadata: { song, filePath: song.filePath }, inlineVolume: true });
    } else {
      await progressMessage.delete().catch(() => {});
      await sq.textChannel?.send({ embeds: [new CustomEmbed().setColor(0xFFFF00).setTitle('⚠️ ダウンロード失敗').setDescription('ストリーミング再生に切り替えます...')] }).catch(() => {});
      sq.currentMode = 'ストリーミング';
      try {
        await startStreamPlayback(guild, song, textChannel, sq, false);
      } catch (streamError) {
        console.error('フォールバック ストリーミングエラー:', (streamError as Error).message);
        await sq.textChannel?.send({ embeds: [new CustomEmbed().setColor(0xFF0000).setTitle('❌ 再生エラー').setDescription(`「${song.title}」の再生に完全に失敗しました。`)] }).catch(() => {});
        sq.songs.shift();
        playSong(guild, sq.songs[0], textChannel);
        return;
      }
    }
  }

  if (isLive) {
    sq.currentMode = 'ストリーミング';
    try {
      await startStreamPlayback(guild, song, textChannel, sq, false);
    } catch (streamError) {
      console.error('ストリーミングエラー:', streamError);
      await sq.textChannel?.send({ embeds: [new CustomEmbed().setColor(0xFF0000).setTitle('❌ 再生エラー').setDescription(`「${song.title}」の再生に失敗しました。`)] });
      sq.songs.shift();
      playSong(guild, sq.songs[0], textChannel);
      return;
    }
  } else if (!resource && song.status === 'downloaded' && song.filePath && fs.existsSync(song.filePath)) {
    sq.currentMode = 'ダウンロード';
    resource = createAudioResource(song.filePath, { metadata: { song, filePath: song.filePath }, inlineVolume: true });
  } else if (!resource) {
    sq.currentMode = 'ダウンロード';
    const opusFilePath = path.join(downloadDir, `${guild.id}-${Date.now()}.opus`);
    const progressEmbed = new CustomEmbed().setTitle('ダウンロード準備中...').setDescription(`${':black_large_square:'.repeat(10)}(0%)`);
    const progressMessage = await textChannel.send({ embeds: [progressEmbed] });
    let lastUpdateTime = 0;

    try {
      const ytdlpProcess = ytdlpExec(song.url, {
        output: opusFilePath,
        extractAudio: true,
        audioFormat: 'opus',
        audioQuality: 0,
        progress: true,
        newline: true,
        progressTemplate: 'download:PROGRESS:%(progress._percent_str)s',
      } as Record<string, unknown>) as ExecaChildProcess;
      sq.activeDownload = ytdlpProcess;
      if (!ytdlpProcess.stdout) throw new Error('ダウンロードプロセスのstdoutが取得できません。');
      const rl = readline.createInterface({ input: ytdlpProcess.stdout });
      rl.on('line', (line: string) => {
        if (line.startsWith('PROGRESS:')) {
          const now = Date.now();
          if (now - lastUpdateTime > 1000) {
            lastUpdateTime = now;
            const percentage = parseFloat(line.substring('PROGRESS:'.length).trim());
            if (!isNaN(percentage)) {
              const barCount = Math.round(percentage / 10);
              const progressBar = ':green_square:'.repeat(barCount) + ':black_large_square:'.repeat(10 - barCount);
              progressEmbed.setTitle(`ダウンロード中: ${song.title.slice(0, 50)}...`).setDescription(`${progressBar}(${Math.round(percentage)}%)`);
              progressMessage.edit({ embeds: [progressEmbed] }).catch(() => {});
            }
          }
        }
      });
      await ytdlpProcess;
      sq.activeDownload = null;
      if (sq.stopped || sq.skipping) {
        await progressMessage.delete().catch(() => {});
        if (fs.existsSync(opusFilePath)) { try { fs.unlinkSync(opusFilePath); } catch {} }
        return;
      }
      const finalProgressBar = ':green_square:'.repeat(10);
      progressEmbed.setTitle('ダウンロード完了！').setDescription(`${finalProgressBar}(100%)`);
      await progressMessage.edit({ embeds: [progressEmbed] }).catch(() => {});

      resource = createAudioResource(opusFilePath, { metadata: { song, filePath: opusFilePath }, inlineVolume: true });
      song.filePath = opusFilePath;
      setTimeout(() => progressMessage.delete().catch(() => {}), 1500);
    } catch (downloadError) {
      sq.activeDownload = null;
      if (sq.stopped || sq.skipping) {
        await progressMessage.delete().catch(() => {});
        if (fs.existsSync(opusFilePath)) { try { fs.unlinkSync(opusFilePath); } catch {} }
        return;
      }
      const err = downloadError as Error;
      console.error('ダウンロードエラー:', err.message, err.stack);
      progressMessage.delete().catch(() => {});
      await sq.textChannel?.send({ embeds: [new CustomEmbed().setColor(0xFFFF00).setTitle('⚠️ ダウンロード失敗').setDescription('ストリーミング再生に切り替えます...')] });
      sq.currentMode = 'ストリーミング';
      try {
        await startStreamPlayback(guild, song, textChannel, sq, false);
      } catch (streamError) {
        const sErr = streamError as Error;
        console.error('フォールバック ストリーミングエラー:', sErr.message);
        await sq.textChannel?.send({ embeds: [new CustomEmbed().setColor(0xFF0000).setTitle('❌ 再生エラー').setDescription(`「${song.title}」の再生に完全に失敗しました。`)] });
        sq.songs.shift();
        playSong(guild, sq.songs[0], textChannel);
        return;
      }
    }
  }

  if (!isLive && song.filePath && !song.lufs) {
    try {
      const lufsData = await measureLufs(song.filePath);
      song.lufs = parseFloat(lufsData.input_i).toFixed(2);
    } catch (e) {
      console.error('LUFSの測定に失敗しました:', (e as Error).message);
    }
  }
  if (!isLive && !song.lyrics) {
    try {
      song.lyrics = await fetchAndParseLyrics(song);
    } catch (e) {
      console.warn(`歌詞の取得に失敗: ${(e as Error).message}`);
    }
  }

  if (!isLive && resource) {
    resource.volume!.setVolume(sq.volume);
    sq.player.play(resource);
    sq.resource = resource;

    sendToParent({ type: 'status', status: 'playing', detail: song.title });
    onStatusChange?.(true, song.title);
    savePlaybackState(guild.id, song.url, song.title, textChannel.id);
  }

  if (!isLive) {
    downloadWorker(sq);
  }

  const components = createPlayerControlButtons(sq.player.state.status);
  const nowPlayingEmbed = createNowPlayingEmbed(song, guild.id);

  sq.nowPlayingMessage = await textChannel.send({ embeds: [nowPlayingEmbed], components: [components] });

  if (song.lyrics && song.lyrics.length > 0) {
    sq.lyricsMessage = await textChannel.send({ embeds: [new CustomEmbed().setDescription('`...`')] });
  }

  startUpdateIntervals(guild.id, song);
}

function startSongDownload(sq: ServerQueue, song: Song): Promise<void> {
  song.status = 'downloading';
  song.downloadProgress = 0;
  const fileName = `${sq.voiceChannel.guild.id}-${Date.now()}.opus`;
  const opusFilePath = path.join(downloadDir, fileName);

  const proc = ytdlpExec(song.url, {
    output: opusFilePath,
    extractAudio: true,
    audioFormat: 'opus',
    audioQuality: 0,
    progress: true,
    newline: true,
    progressTemplate: 'download:PROGRESS:%(progress._percent_str)s',
  } as Record<string, unknown>);

  if (proc.stdout) {
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line: string) => {
      if (line.startsWith('PROGRESS:')) {
        const pct = parseFloat(line.substring('PROGRESS:'.length).trim());
        if (!isNaN(pct)) song.downloadProgress = pct;
      }
    });
  }

  return proc.then(() => {
    song.filePath = opusFilePath;
    song.status = 'downloaded';
    song.downloadProgress = 100;
    console.log(`事前ダウンロード完了: ${song.title}`);
  }).catch((e: Error) => {
    console.error(`事前ダウンロード失敗: ${song.title}`, e?.message);
    song.status = 'error';
    if (fs.existsSync(opusFilePath)) {
      try { fs.unlinkSync(opusFilePath); } catch {}
    }
  });
}

async function downloadWorker(sq: ServerQueue): Promise<void> {
  if (sq.isDownloading) return;
  sq.isDownloading = true;
  try {
    while (true) {
      const song = sq.songs.find(s => s.status === 'queued' && !s.is_live);
      if (!song) break;
      console.log(`事前ダウンロード開始: ${song.title}`);
      song.downloadPromise = startSongDownload(sq, song);
      await song.downloadPromise;
      if (!sq.songs.includes(song) && song.filePath && fs.existsSync(song.filePath)) {
        try { fs.unlinkSync(song.filePath); } catch {}
      }
    }
  } finally {
    sq.isDownloading = false;
  }
}

export interface VideoData {
  title?: string;
  webpage_url: string;
  uploader?: string;
  duration: number | null;
  duration_string?: string | null;
  is_live: boolean | null;
  live_status?: string | null;
  thumbnail?: string | null;
}

function detectIsLive(video: VideoData): boolean {
  if (video.is_live === true) return true;
  if (video.live_status === 'is_live' || video.live_status === 'post_live') return true;
  if (video.duration == null && video.is_live !== false) return true;
  return false;
}

export async function processSongs(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  videoData: VideoData[],
): Promise<void> {
  const member = interaction.member as GuildMember | null;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel?.isVoiceBased()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [new CustomEmbed().setColor(0xFF0000).setDescription('VCに参加してください。')] });
    } else {
      await interaction.reply({ embeds: [new CustomEmbed().setColor(0xFF0000).setDescription('VCに参加してください。')], flags: MessageFlags.Ephemeral });
    }
    return;
  }

  const songs: Song[] = [];
  for (const video of videoData) {
    if (!video?.title) continue;
    const isLive = detectIsLive(video);
    songs.push({
      title: video.title,
      webpage_url: video.webpage_url,
      url: video.webpage_url,
      uploader: video.uploader ?? 'Unknown',
      duration: video.duration ?? 0,
      duration_string: video.duration_string ?? (isLive ? 'LIVE' : 'N/A'),
      is_live: isLive,
      thumbnail: video.thumbnail ?? '',
      requestedBy: interaction.user,
      status: 'queued',
      filePath: null,
      lufs: null,
      lyrics: null,
    });
  }

  let serverQueue = queue.get(interaction.guildId!);
  if (!serverQueue) {
    const guildVolume = volumeSettings[interaction.guildId!] ?? 0.3;
    serverQueue = {
      textChannel: interaction.channel as TextChannel | null,
      voiceChannel,
      connection: null,
      player: createAudioPlayer(),
      songs: [],
      volume: guildVolume,
      currentFilter: 'loudness',
      currentMode: '不明',
      progressInterval: null,
      lyricsInterval: null,
      nowPlayingMessage: null,
      lyricsMessage: null,
      resource: null,
      stopped: false,
      skipping: false,
      streamProcess: null,
      activeDownload: null,
      isStreamReconnecting: false,
      isDownloading: false,
    };
    queue.set(interaction.guildId!, serverQueue);
  }
  serverQueue.textChannel = interaction.channel as TextChannel | null;
  const wasQueueEmpty = serverQueue.songs.length === 0;
  serverQueue.songs.push(...songs);

  const embed = new CustomEmbed().setColor(0x00ff00);
  if (songs.length > 1) {
    embed.setTitle(`✅ ${songs.length}曲をキューに追加しました`);
  } else {
    embed.setTitle('✅ キューに追加しました').setDescription(`[${songs[0].title}](${songs[0].url})`);
  }
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], components: [] });
  } else {
    await interaction.reply({ embeds: [embed], components: [] });
  }

  if (!getVoiceConnection(interaction.guildId!)) {
    serverQueue.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId!,
      adapterCreator: interaction.guild!.voiceAdapterCreator,
    });
    setupConnectionHandlers(serverQueue.connection, interaction.guildId!);
    serverQueue.connection.subscribe(serverQueue.player);
  }
  setupPlayerErrorHandler(serverQueue, interaction.guildId!);

  downloadWorker(serverQueue);
  if (wasQueueEmpty) {
    playSong(interaction.guild!, serverQueue.songs[0], interaction.channel as TextChannel);
  }
}

export { playSong };

export async function gracefulShutdown(): Promise<void> {
  for (const [gid, sq] of queue) {
    if (sq.progressInterval) clearInterval(sq.progressInterval);
    if (sq.lyricsInterval) clearInterval(sq.lyricsInterval);
    if (sq.streamProcess && !sq.streamProcess.killed) {
      try {
        sq.streamProcess.kill('SIGKILL');
      } catch {
        sq.streamProcess.kill();
      }
    }
    if (sq.nowPlayingMessage) {
      await sq.nowPlayingMessage.delete().catch(() => {});
    }
    if (sq.lyricsMessage) {
      await sq.lyricsMessage.delete().catch(() => {});
    }
    for (const song of sq.songs) {
      if (song.filePath && fs.existsSync(song.filePath)) {
        try { fs.unlinkSync(song.filePath); } catch {}
      }
    }
    if (sq.connection) {
      sq.connection.destroy();
    }
    queue.delete(gid);
  }
}
