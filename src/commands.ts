import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import { create as createYtdlp } from 'yt-dlp-exec';
const ytdlp = createYtdlp(process.env.YTDLP_PATH || 'yt-dlp');
const ytdlpExec = ytdlp.exec;
import type { ServerQueue, Song } from './types.js';
import { queue, volumeSettings, saveVolumeSettings, clearPlaybackState } from './state.js';
import { processSongs, playSong, type VideoData } from './player.js';
import type { TextChannel } from 'discord.js';
import { createPlayerControlButtons, createNowPlayingEmbed } from './ui.js';
import CustomEmbed from './lib/defaultEmbed.js';
import type {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  ModalSubmitInteraction,
  GuildMember,
} from 'discord.js';
import fs from 'node:fs';

export const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('音楽を再生/追加します。')
    .addStringOption(option =>
      option
        .setName('query')
        .setDescription('再生したい曲のURLまたは検索キーワード')
        .setRequired(false),
    ),
  new SlashCommandBuilder().setName('skip').setDescription('次の曲に移ります'),
  new SlashCommandBuilder().setName('stop').setDescription('停止します'),
  new SlashCommandBuilder().setName('queue').setDescription('現在の再生キューを表示します。'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('現在再生中の曲の情報を表示します。'),
  new SlashCommandBuilder().setName('pause').setDescription('再生を一時停止します。'),
  new SlashCommandBuilder().setName('resume').setDescription('一時停止を解除します。'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('音量を変更します（引数なしで現在の音量を表示）。')
    .addIntegerOption(option =>
      option
        .setName('level')
        .setDescription('設定したい音量レベル (1-200)')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('filter')
    .setDescription('オーディオフィルター（エフェクト）を設定します。')
    .addStringOption(option =>
      option
        .setName('effect')
        .setDescription('適用するエフェクトを選択')
        .setRequired(true)
        .addChoices(
          { name: 'オフ', value: 'off' },
          { name: '低音強化するやつ', value: 'bassboost' },
          { name: '音量揃えてくれるやつ', value: 'loudness' },
        ),
    ),
  new SlashCommandBuilder().setName('reload').setDescription('【⚠️】 ボットを再起動します'),
].map(command => command.toJSON());

export async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const query = interaction.options.getString('query');
  if (!query) {
    const modal = new ModalBuilder().setCustomId('play-modal').setTitle('音楽の再生');
    const songInput = new TextInputBuilder()
      .setCustomId('song-input')
      .setLabel('曲名またはURLを入力してください')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(songInput));
    await interaction.showModal(modal);
  } else {
    await interaction.deferReply();
    await searchAndQueue(interaction, query);
  }
}

export async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply();
  const query = interaction.fields.getTextInputValue('song-input');
  await searchAndQueue(interaction, query);
}

async function searchAndQueue(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  query: string,
): Promise<void> {
  const member = interaction.member as GuildMember | null;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel?.isVoiceBased()) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        embeds: [new CustomEmbed().setColor(0xff0000).setDescription('まずボイスチャンネルに参加してください。')],
      });
    } else {
      await interaction.reply({
        embeds: [new CustomEmbed().setColor(0xff0000).setDescription('まずボイスチャンネルに参加してください。')],
      });
    }
    return;
  }
  try {
    const isUrl = query.startsWith('http');
    let searchResults: unknown[] = [];

    if (isUrl && (query.includes('playlist') || query.includes('list='))) {
      const output = await ytdlpExec(query, { dumpJson: true, flatPlaylist: true });
      searchResults = output.stdout.split(/\r?\n/).filter(Boolean).map((line: string) => JSON.parse(line));
    } else if (isUrl) {
      const videoInfo = await ytdlp(query, { dumpJson: true });
      searchResults.push(videoInfo);
    } else {
      const output = await ytdlpExec(query, {
        defaultSearch: 'ytsearch5',
        flatPlaylist: true,
        noWarnings: true,
        print: '%(.{title,duration_string,uploader,webpage_url,id,duration})j',
      } as Record<string, unknown>);
      searchResults = output.stdout.split(/\r?\n/).filter(Boolean).map((line: string) => JSON.parse(line));
    }

    if (searchResults.length === 0) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          embeds: [new CustomEmbed().setColor(0xff0000).setTitle('❌ 曲が見つかりません').setDescription(`「${query}」での検索結果がありませんでした。`)],
        });
      } else {
        await interaction.reply({
          embeds: [new CustomEmbed().setColor(0xff0000).setTitle('❌ 曲が見つかりません').setDescription(`「${query}」での検索結果がありませんでした。`)],
        });
      }
      return;
    }
    if (searchResults.length > 1 && !isUrl) {
      const options = (searchResults as Array<Record<string, unknown>>).map(track => ({
        label: ((track.title as string) || 'タイトル不明').slice(0, 100),
        description: `[${track.duration_string || 'N/A'}] by ${track.uploader || 'Unknown'}`.slice(0, 100),
        value: track.webpage_url as string,
      }));
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('play-track-select')
          .setPlaceholder('再生する曲を選択')
          .addOptions(options),
      );
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          embeds: [new CustomEmbed().setTitle('🔍 検索結果').setDescription(`「${query}」の検索結果です。`)],
          components: [row],
        });
      } else {
        await interaction.reply({
          embeds: [new CustomEmbed().setTitle('🔍 検索結果').setDescription(`「${query}」の検索結果です。`)],
          components: [row],
        });
      }
    } else {
      await processSongs(interaction as ChatInputCommandInteraction, searchResults as VideoData[]);
    }
  } catch (e) {
    console.error(e);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        embeds: [new CustomEmbed().setColor(0xff0000).setTitle('エラー').setDescription('曲の情報の取得中にエラーが発生しました。')],
      });
    } else {
      await interaction.reply({
        embeds: [new CustomEmbed().setColor(0xff0000).setTitle('エラー').setDescription('曲の情報の取得中にエラーが発生しました。')],
      });
    }
  }
}

export async function handleSkip(
  interaction: ChatInputCommandInteraction,
  serverQueue: ServerQueue | undefined,
): Promise<void> {
  if (!serverQueue || serverQueue.songs.length === 0) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('スキップする曲がありません。')], flags: MessageFlags.Ephemeral });
    return;
  }
  const status = serverQueue.player.state.status;
  const isPlayingLike =
    status === AudioPlayerStatus.Playing ||
    status === AudioPlayerStatus.Buffering ||
    status === AudioPlayerStatus.Paused ||
    status === AudioPlayerStatus.AutoPaused;

  if (isPlayingLike) {
    serverQueue.player.stop();
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('曲をスキップしました。')] });
    return;
  }

  serverQueue.skipping = true;
  if (serverQueue.activeDownload && !serverQueue.activeDownload.killed) {
    try { serverQueue.activeDownload.kill('SIGKILL'); } catch { try { serverQueue.activeDownload.kill(); } catch {} }
  }
  if (serverQueue.streamProcess && !serverQueue.streamProcess.killed) {
    try { serverQueue.streamProcess.kill('SIGKILL'); } catch { try { serverQueue.streamProcess.kill(); } catch {} }
  }
  if (serverQueue.progressInterval) clearInterval(serverQueue.progressInterval);
  if (serverQueue.lyricsInterval) clearInterval(serverQueue.lyricsInterval);
  if (serverQueue.nowPlayingMessage) {
    await serverQueue.nowPlayingMessage.delete().catch(() => {});
    serverQueue.nowPlayingMessage = null;
  }
  if (serverQueue.lyricsMessage) {
    await serverQueue.lyricsMessage.delete().catch(() => {});
    serverQueue.lyricsMessage = null;
  }
  const finished = serverQueue.songs.shift();
  if (finished?.filePath && fs.existsSync(finished.filePath)) {
    try { fs.unlinkSync(finished.filePath); } catch {}
  }
  await interaction.reply({ embeds: [new CustomEmbed().setDescription('曲をスキップしました。')] });
  await new Promise(r => setTimeout(r, 100));
  serverQueue.skipping = false;
  const next = serverQueue.songs[0];
  if (next) {
    const tc = (serverQueue.textChannel ?? interaction.channel) as TextChannel;
    playSong(interaction.guild!, next, tc);
  }
}

export async function handleStop(
  interaction: ChatInputCommandInteraction,
  serverQueue: ServerQueue | undefined,
): Promise<void> {
  if (!serverQueue) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('再生中の曲はありません。')], flags: MessageFlags.Ephemeral });
    return;
  }
  if (serverQueue.progressInterval) clearInterval(serverQueue.progressInterval);
  if (serverQueue.lyricsInterval) clearInterval(serverQueue.lyricsInterval);

  if (serverQueue.nowPlayingMessage) {
    await serverQueue.nowPlayingMessage.delete().catch(() => {});
    serverQueue.nowPlayingMessage = null;
  }
  if (serverQueue.lyricsMessage) {
    await serverQueue.lyricsMessage.delete().catch(() => {});
    serverQueue.lyricsMessage = null;
  }

  serverQueue.songs.forEach(song => {
    if (song.filePath && fs.existsSync(song.filePath)) {
      try {
        fs.unlinkSync(song.filePath);
      } catch (e) {
        console.error(`ファイル削除失敗: ${song.filePath}`, e);
      }
    }
  });
  serverQueue.stopped = true;
  if (serverQueue.activeDownload && !serverQueue.activeDownload.killed) {
    try { serverQueue.activeDownload.kill('SIGKILL'); } catch { try { serverQueue.activeDownload.kill(); } catch {} }
  }
  if (serverQueue.streamProcess && !serverQueue.streamProcess.killed) {
    try { serverQueue.streamProcess.kill('SIGKILL'); } catch { try { serverQueue.streamProcess.kill(); } catch {} }
  }
  serverQueue.songs = [];
  serverQueue.player.stop();
  clearPlaybackState(interaction.guildId!);
  await interaction.reply({ embeds: [new CustomEmbed().setDescription('再生を停止し、キューをクリアしました。\nVCには接続したままです。')] });
}

export async function handleQueue(
  interaction: ChatInputCommandInteraction,
  serverQueue: ServerQueue | undefined,
): Promise<void> {
  if (!serverQueue || serverQueue.songs.length === 0) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('キューは空です。')], flags: MessageFlags.Ephemeral });
    return;
  }

  const generateQueueEmbed = (songs: Song[]) => {
    const description =
      songs.length > 0
        ? songs
            .map((s, i) => `**${i + 1}.** \`[${s.duration_string}]\` [${s.title}](${s.url}) | ${s.requestedBy.toString()}`)
            .join('\n')
            .slice(0, 4000)
        : 'キューは空になりました。';
    return new CustomEmbed().setTitle('再生キュー').setDescription(description);
  };

  const generateSelectMenu = (songs: Song[]) => {
    if (songs.length === 0) return null;
    const options = songs.map((song, index) => ({
      label: `${index + 1}. ${song.title}`.slice(0, 100),
      description: `[${song.duration_string}]`.slice(0, 100),
      value: index.toString(),
    }));
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('remove-from-queue')
        .setPlaceholder('キューから削除する曲を選択...')
        .setMinValues(1)
        .setMaxValues(options.length)
        .addOptions(options),
    );
  };

  const embed = generateQueueEmbed(serverQueue.songs);
  const selectMenu = generateSelectMenu(serverQueue.songs.slice(0, 25));
  const components = selectMenu ? [selectMenu] : [];
  await interaction.reply({ embeds: [embed], components });
  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });
  collector.on('collect', async i => {
    if (i.customId === 'remove-from-queue') {
      const indicesToRemove = i.values.map(v => parseInt(v)).sort((a, b) => b - a);
      let removedCount = 0;
      for (const index of indicesToRemove) {
        const songToRemove = serverQueue.songs[index];
        if (songToRemove) {
          if (songToRemove.filePath && fs.existsSync(songToRemove.filePath)) {
            try {
              fs.unlinkSync(songToRemove.filePath);
            } catch (e) {
              console.error(`ファイル削除失敗: ${songToRemove.filePath}`, e);
            }
          }
          serverQueue.songs.splice(index, 1);
          removedCount++;
        }
      }
      const newEmbed = generateQueueEmbed(serverQueue.songs);
      const newSelectMenu = generateSelectMenu(serverQueue.songs.slice(0, 25));
      const newComponents = newSelectMenu ? [newSelectMenu] : [];
      await i.update({ embeds: [newEmbed], components: newComponents });
      await i.followUp({ content: `✅ ${removedCount}曲をキューから削除しました。`, flags: MessageFlags.Ephemeral });
    }
  });
  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => {});
  });
}

export async function handleNowPlaying(
  interaction: ChatInputCommandInteraction,
  serverQueue: ServerQueue | undefined,
): Promise<void> {
  if (!serverQueue || serverQueue.songs.length === 0) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('再生中の曲はありません。')], flags: MessageFlags.Ephemeral });
    return;
  }
  const song = serverQueue.songs[0];
  const embed = createNowPlayingEmbed(song, interaction.guildId!, true);
  await interaction.reply({ embeds: [embed] });
}

export async function handlePause(
  interaction: ChatInputCommandInteraction,
  serverQueue: ServerQueue | undefined,
): Promise<void> {
  if (!serverQueue?.player) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('再生中の曲はありません。')], flags: MessageFlags.Ephemeral });
    return;
  }
  if (serverQueue.player.state.status === AudioPlayerStatus.Paused) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('既に一時停止しています。')], flags: MessageFlags.Ephemeral });
    return;
  }
  serverQueue.player.pause();
  await interaction.reply({ embeds: [new CustomEmbed().setDescription('⏸️ 一時停止しました。')] });
}

export async function handleResume(
  interaction: ChatInputCommandInteraction,
  serverQueue: ServerQueue | undefined,
): Promise<void> {
  if (!serverQueue?.player) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('再生中の曲はありません。')], flags: MessageFlags.Ephemeral });
    return;
  }
  if (serverQueue.player.state.status === AudioPlayerStatus.Playing) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('既に再生中です。')], flags: MessageFlags.Ephemeral });
    return;
  }
  serverQueue.player.unpause();
  await interaction.reply({ embeds: [new CustomEmbed().setDescription('▶️ 再生を再開しました。')] });
}

export async function handleVolume(
  interaction: ChatInputCommandInteraction,
  serverQueue: ServerQueue | undefined,
): Promise<void> {
  if (!serverQueue) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('再生中の曲はありません。')], flags: MessageFlags.Ephemeral });
    return;
  }
  const volumeLevel = interaction.options.getInteger('level');
  if (volumeLevel === null) {
    const currentVolume = serverQueue.volume * 100;
    await interaction.reply({ embeds: [new CustomEmbed().setDescription(`現在の音量は **${Math.round(currentVolume)}%** です。`)] });
    return;
  }
  if (volumeLevel < 1 || volumeLevel > 200) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('音量は1から200の間で設定してください。')], flags: MessageFlags.Ephemeral });
    return;
  }
  serverQueue.volume = volumeLevel / 100;
  volumeSettings[interaction.guildId!] = serverQueue.volume;
  saveVolumeSettings();
  if (serverQueue.player.state.status === AudioPlayerStatus.Playing && serverQueue.resource?.volume) {
    serverQueue.resource.volume.setVolume(serverQueue.volume);
  }
  await interaction.reply({ embeds: [new CustomEmbed().setDescription(`音量を ${volumeLevel}% に設定しました。`)] });
}

export async function handleFilter(
  interaction: ChatInputCommandInteraction,
  serverQueue: ServerQueue | undefined,
): Promise<void> {
  if (!serverQueue) {
    await interaction.reply({ embeds: [new CustomEmbed().setDescription('再生中の曲はありません。')], flags: MessageFlags.Ephemeral });
    return;
  }
  serverQueue.currentFilter = interaction.options.getString('effect') as ServerQueue['currentFilter'];
  await interaction.reply({
    embeds: [
      new CustomEmbed().setDescription(
        `フィルターを **${serverQueue.currentFilter}** に設定しました。\n(この設定はストリーミング再生時や次の曲から適用されます)`,
      ),
    ],
  });
}

export async function handleReload(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ embeds: [new CustomEmbed().setDescription('🛑 ボットを再起動します...')] });
  const { gracefulShutdown } = await import('./player.js');
  await gracefulShutdown();
  process.exit(0);
}
