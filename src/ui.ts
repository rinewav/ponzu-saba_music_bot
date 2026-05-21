import { AudioPlayerStatus, type AudioResource } from '@discordjs/voice';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import type { Song, ServerQueue } from './types.js';
import CustomEmbed from './lib/defaultEmbed.js';
import { queue } from './state.js';

export function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

export function createPlayerControlButtons(playerStatus: string): ActionRowBuilder<ButtonBuilder> {
  const isPaused = playerStatus === AudioPlayerStatus.Paused;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('control-restart')
      .setLabel('最初から')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⏪'),
    new ButtonBuilder()
      .setCustomId('control-toggle-pause')
      .setLabel(isPaused ? '再開' : '一時停止')
      .setStyle(ButtonStyle.Primary)
      .setEmoji(isPaused ? '▶️' : '⏸️'),
    new ButtonBuilder()
      .setCustomId('control-skip')
      .setLabel('次へ')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⏩'),
  );
}

export function createNowPlayingEmbed(
  song: Song,
  guildId: string,
  includeProgress = false,
): CustomEmbed {
  const serverQueue = queue.get(guildId);
  const embed = new CustomEmbed()
    .setColor(0x0099ff)
    .setTitle('🎶 再生中')
    .setDescription(`[${song.title}](${song.url})`)
    .setThumbnail(song.thumbnail && song.thumbnail.startsWith('http') ? song.thumbnail : null)
    .addFields(
      { name: '長さ', value: song.duration_string, inline: true },
      { name: '再生したひと', value: song.requestedBy.toString(), inline: true },
      { name: '再生モード', value: serverQueue?.currentMode ?? '不明', inline: true },
      { name: 'ラウドネスノーマライズ', value: serverQueue?.currentFilter === 'loudness' ? 'オン' : 'オフ', inline: true },
    );

  if (song.lufs) {
    embed.addFields({ name: 'ラウドネス値', value: `\`${song.lufs} LUFS\``, inline: true });
  }

  let progressBarField: { name: string; value: string } = {
    name: '進捗',
    value: '`ライブ配信または長時間動画のため表示されません`',
  };
  if (!song.is_live && serverQueue) {
    const resource = serverQueue.resource as AudioResource | null;
    const playbackTime = includeProgress && resource ? Math.floor(resource.playbackDuration / 1000) : 0;
    const totalTime = song.duration;
    const percentage = totalTime > 0 ? playbackTime / totalTime : 0;
    const barLength = 25;
    const progress = Math.round(barLength * percentage);
    const progressBar = '▬'.repeat(progress) + '🔘' + '▬'.repeat(barLength - progress);
    progressBarField.value = '`[' + formatTime(playbackTime) + ' / ' + song.duration_string + ']`\n`' + progressBar + '`';
  }
  embed.addFields(progressBarField);

  return embed;
}

export function startUpdateIntervals(guildId: string, song: Song): void {
  const serverQueue = queue.get(guildId);
  if (!serverQueue) return;

  if (!song.is_live) {
    serverQueue.progressInterval = setInterval(() => {
      const q = queue.get(guildId);
      if (!q || !q.resource || !q.nowPlayingMessage || q.player.state.status !== AudioPlayerStatus.Playing) {
        if (q?.progressInterval) clearInterval(q.progressInterval);
        return;
      }
      const newEmbed = createNowPlayingEmbed(song, guildId, true);
      const components = createPlayerControlButtons(q.player.state.status);
      q.nowPlayingMessage.edit({ embeds: [newEmbed], components: [components] }).catch(() => {
        if (q.progressInterval) clearInterval(q.progressInterval);
      });
    }, 5000);
  }

  if (song.lyrics && song.lyrics.length > 0) {
    let lastLyricLine = '';
    serverQueue.lyricsInterval = setInterval(() => {
      const q = queue.get(guildId);
      if (!q || !q.resource || !q.lyricsMessage || q.player.state.status !== AudioPlayerStatus.Playing) {
        if (q?.lyricsInterval) clearInterval(q.lyricsInterval);
        return;
      }
      const playbackTime = q.resource.playbackDuration / 1000;
      const currentLyric = song.lyrics!.find(line => playbackTime >= line.start && playbackTime < line.end);
      if (currentLyric && currentLyric.text !== lastLyricLine) {
        lastLyricLine = currentLyric.text;
        const lyricIndex = song.lyrics!.findIndex(line => line.text === lastLyricLine);
        const contextLines = song.lyrics!.slice(Math.max(0, lyricIndex - 3), Math.min(song.lyrics!.length, lyricIndex + 4));
        const lyricText = contextLines
          .map(line =>
            line.text === lastLyricLine ? `**\`▶ ${line.text}\`**` : `\`   ${line.text}\``
          )
          .join('\n');
        q.lyricsMessage.edit({ embeds: [new CustomEmbed().setTitle('🎤 歌詞').setDescription(lyricText)] }).catch(() => {
          if (q.lyricsInterval) clearInterval(q.lyricsInterval);
        });
      }
    }, 500);
  }
}
