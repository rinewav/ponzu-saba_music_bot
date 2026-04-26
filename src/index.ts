import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  REST,
  Routes,
} from 'discord.js';
import {
  createAudioPlayer,
  joinVoiceChannel,
} from '@discordjs/voice';
import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig, ParentMessage, VcState, ServerQueue } from './types.js';
import { queue, setInstanceIndex, initVolumeSettings, saveVcState, deleteVcState, volumeSettings, clearPlaybackState, loadPlaybackStates } from './state.js';
import { commands, handlePlay, handleSkip, handleStop, handleQueue, handleNowPlaying, handlePause, handleResume, handleVolume, handleFilter, handleReload, handleModalSubmit } from './commands.js';
import { handleComponent } from './interactions.js';
import { sendToParent, onParentMessage } from './ipc.js';
import { setStatusCallback, playSong, gracefulShutdown } from './player.js';
import CustomEmbed from './lib/defaultEmbed.js';
import dotenv from 'dotenv';
import { create as createYtdlp } from 'yt-dlp-exec';
dotenv.config();

const ytdlp = createYtdlp(process.env.YTDLP_PATH || 'yt-dlp');

const isChildProcess = !!process.send;

if (isChildProcess) {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => { origLog(...args); sendToParent({ type: 'log', level: 'info', message: args.join(' ') }); };
  console.warn = (...args: unknown[]) => { origWarn(...args); sendToParent({ type: 'log', level: 'warn', message: args.join(' ') }); };
  console.error = (...args: unknown[]) => { origError(...args); sendToParent({ type: 'log', level: 'error', message: args.join(' ') }); };
}

function updateStatus(client: Client, isPlaying: boolean, songTitle?: string): void {
  if (isPlaying && songTitle) {
    client.user?.setActivity(`🎵 ${songTitle}`, { type: ActivityType.Playing });
  } else if (isPlaying) {
    client.user?.setActivity('❌️ 使用中です！', { type: ActivityType.Playing });
  } else {
    client.user?.setActivity('⭕️ 空いています！', { type: ActivityType.Playing });
  }
}

function startBot(config: BotConfig, guild: string, instanceIdx: number): void {
  setInstanceIndex(instanceIdx);
  initVolumeSettings();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
    ],
    partials: [Partials.Channel],
  });

  setStatusCallback((playing, songTitle) => updateStatus(client, playing, songTitle));

  client.once('ready', async () => {
    console.log(`${client.user?.tag}としてログインしました。`);
    updateStatus(client, false);
    sendToParent({ type: 'status', status: 'online' });

    const rest = new REST({ version: '10' }).setToken(config.token);
    try {
      console.log('スラッシュコマンドの登録を開始します...');
      await rest.put(Routes.applicationGuildCommands(client.user!.id, guild), { body: commands });
      console.log('スラッシュコマンドの登録が正常に完了しました。');
    } catch (error) {
      console.error(error);
    }

    const vcFile = path.join(process.cwd(), `active_vcs_${instanceIdx}.json`);
    if (fs.existsSync(vcFile)) {
      const vcStates: VcState = JSON.parse(fs.readFileSync(vcFile, 'utf-8'));
      for (const gid in vcStates) {
        try {
          const guildObj = await client.guilds.fetch(gid);
          const channel = await guildObj.channels.fetch(vcStates[gid]);
          if (channel?.isVoiceBased()) {
            const humanCount = channel.members.filter(m => !m.user.bot).size;
            if (humanCount === 0) {
              console.log(`サーバー[${guildObj.name}]のVC[${channel.name}]は誰もいないため、再接続をスキップします。`);
              deleteVcState(gid);
              clearPlaybackState(gid);
              continue;
            }
            console.log(`サーバー[${guildObj.name}]のVC[${channel.name}]に自動再接続します。`);
            const connection = joinVoiceChannel({
              channelId: channel.id,
              guildId: guildObj.id,
              adapterCreator: guildObj.voiceAdapterCreator,
            });
            const serverQueue: ServerQueue = {
              textChannel: null,
              voiceChannel: channel,
              connection,
              player: createAudioPlayer(),
              songs: [],
              volume: volumeSettings[gid] ?? 0.3,
              currentFilter: 'loudness' as const,
              currentMode: '不明',
              progressInterval: null,
              lyricsInterval: null,
              nowPlayingMessage: null,
              lyricsMessage: null,
              resource: null,
              stopped: false,
              streamProcess: null,
              isStreamReconnecting: false,
              isDownloading: false,
            };

            const playbackStates = loadPlaybackStates();
            const saved = playbackStates[gid];
            let textChannel: import('discord.js').TextChannel | null = null;
            if (saved?.channelId) {
              try {
                const ch = await guildObj.channels.fetch(saved.channelId);
                if (ch?.isTextBased()) textChannel = ch as import('discord.js').TextChannel;
              } catch {}
            }
            serverQueue.textChannel = textChannel;

            queue.set(gid, serverQueue);
            connection.subscribe(serverQueue.player);

            if (saved) {
              console.log(`サーバー[${guildObj.name}]の再生状態を復元します: ${saved.title}`);
              try {
                if (textChannel) {
                  const videoInfo = await ytdlp(saved.url, { dumpJson: true }) as Record<string, unknown>;
                  const song = {
                    title: (videoInfo.title as string) ?? saved.title,
                    url: videoInfo.webpage_url as string,
                    webpage_url: videoInfo.webpage_url as string,
                    uploader: (videoInfo.uploader as string) ?? 'Unknown',
                    duration: (videoInfo.duration as number) ?? 0,
                    duration_string: (videoInfo.duration_string as string) ?? 'N/A',
                    is_live: (videoInfo.is_live as boolean) ?? false,
                    thumbnail: (videoInfo.thumbnail as string) ?? '',
                    requestedBy: client.user!,
                    status: 'queued' as const,
                    filePath: null,
                    lufs: null,
                    lyrics: null,
                  };
                  serverQueue.songs.push(song);
                  playSong(guildObj, song, textChannel as import('discord.js').TextChannel);
                }
              } catch (e) {
                console.error(`再生状態の復元に失敗しました (GuildID: ${gid}):`, (e as Error).message);
              }
            }
          }
        } catch (e) {
          console.error(`VCへの自動再接続に失敗しました (GuildID: ${gid}):`, (e as Error).message);
          deleteVcState(gid);
        }
      }
    }
  });

  client.on('interactionCreate', async interaction => {
    if (!interaction.guild) return;
    if (interaction.isChatInputCommand()) {
      const serverQueue = queue.get(interaction.guildId!);
      switch (interaction.commandName) {
        case 'play': await handlePlay(interaction); break;
        case 'skip': await handleSkip(interaction, serverQueue); break;
        case 'stop': await handleStop(interaction, serverQueue); break;
        case 'queue': await handleQueue(interaction, serverQueue); break;
        case 'nowplaying': await handleNowPlaying(interaction, serverQueue); break;
        case 'pause': await handlePause(interaction, serverQueue); break;
        case 'resume': await handleResume(interaction, serverQueue); break;
        case 'volume': await handleVolume(interaction, serverQueue); break;
        case 'filter': await handleFilter(interaction, serverQueue); break;
        case 'reload': await handleReload(interaction); break;
      }
    } else if (interaction.isMessageComponent()) {
      await handleComponent(interaction);
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'play-modal') {
        await handleModalSubmit(interaction);
      }
    }
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    const serverQueue = queue.get(oldState.guild.id);
    if (newState.id === client.user!.id) {
      if (!oldState.channelId && newState.channelId) {
        updateStatus(client, true);
        sendToParent({ type: 'status', status: 'online' });
        saveVcState(newState.guild.id, newState.channelId);
      } else if (oldState.channelId && !newState.channelId) {
        updateStatus(client, false);
        sendToParent({ type: 'status', status: 'online' });
        if (serverQueue) {
          if (serverQueue.progressInterval) clearInterval(serverQueue.progressInterval);
          if (serverQueue.lyricsInterval) clearInterval(serverQueue.lyricsInterval);
          if (serverQueue.streamProcess && !serverQueue.streamProcess.killed) {
            try {
              serverQueue.streamProcess.kill('SIGKILL');
            } catch {
              serverQueue.streamProcess.kill();
            }
          }
          for (const song of serverQueue.songs) {
            if (song.filePath && fs.existsSync(song.filePath)) {
              try { fs.unlinkSync(song.filePath); } catch {}
            }
          }
        }
        queue.delete(oldState.guild.id);
        deleteVcState(oldState.guild.id);
        clearPlaybackState(oldState.guild.id);
      }
      return;
    }
    if (!serverQueue?.connection) return;
    const botChannel = oldState.guild.members.me?.voice.channel;
    if (!botChannel) return;
    if (botChannel.members.filter(m => !m.user.bot).size === 0) {
      if (serverQueue.streamProcess && !serverQueue.streamProcess.killed) {
        try {
          serverQueue.streamProcess.kill('SIGKILL');
        } catch {
          serverQueue.streamProcess.kill();
        }
      }
      serverQueue.connection.destroy();
      if (serverQueue.textChannel) {
        serverQueue.textChannel.send({ embeds: [new CustomEmbed().setDescription('誰もいなくなったため、ボイスチャンネルから切断しました。')] });
      }
    }
  });

  client.login(config.token);
}

if (isChildProcess) {
  onParentMessage(async (msg: ParentMessage) => {
    if (msg.type === 'init') {
      startBot(msg.config, msg.guildId, msg.instanceIndex);
    } else if (msg.type === 'shutdown') {
      console.log('シャットダウン要求を受信しました。');
      await gracefulShutdown();
      process.exit(0);
    } else if (msg.type === 'restart') {
      console.log('再起動要求を受信しました。');
      await gracefulShutdown();
      process.exit(0);
    }
  });
  process.on('SIGINT', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
  if (process.platform === 'win32') {
    process.on('SIGHUP', async () => {
      await gracefulShutdown();
      process.exit(0);
    });
  }
} else {
  dotenv.config();
  const token = process.env.BOT_1_TOKEN;
  const name = process.env.BOT_1_NAME ?? '1号機';
  const guild = process.env.GUILD_ID;
  if (!token || !guild) {
    console.error('BOT_1_TOKEN または GUILD_ID が設定されていません。');
    process.exit(1);
  }
  startBot({ name, token }, guild, 1);
  process.on('SIGINT', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
  if (process.platform === 'win32') {
    process.on('SIGHUP', async () => {
      await gracefulShutdown();
      process.exit(0);
    });
  }
}
