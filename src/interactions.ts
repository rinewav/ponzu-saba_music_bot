import type {
  MessageComponentInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { MessageFlags } from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import { create as createYtdlp } from 'yt-dlp-exec';
const ytdlp = createYtdlp(process.env.YTDLP_PATH || 'yt-dlp');
import { queue } from './state.js';
import { processSongs, playSong, type VideoData } from './player.js';
import { createPlayerControlButtons } from './ui.js';

export async function handleComponent(interaction: MessageComponentInteraction): Promise<void> {
  try {
    const serverQueue = queue.get(interaction.guildId!);

    if (interaction.customId === 'play-track-select') {
      const selectInteraction = interaction as StringSelectMenuInteraction;
      await selectInteraction.deferUpdate();
      const videoInfo = await ytdlp(selectInteraction.values[0], { dumpJson: true }) as VideoData;
      await processSongs(selectInteraction, [videoInfo]);
      return;
    }

    if (interaction.customId.startsWith('control-')) {
      if (!serverQueue?.player) {
        await interaction.reply({ content: '現在操作できる曲がありません。', flags: MessageFlags.Ephemeral });
        return;
      }

      const controlType = interaction.customId.replace('control-', '');

      switch (controlType) {
        case 'restart':
          if (serverQueue.songs[0]) {
            playSong(interaction.guild!, serverQueue.songs[0], (serverQueue.textChannel ?? interaction.channel) as import('discord.js').TextChannel);
          }
          await interaction.deferUpdate();
          break;

        case 'toggle-pause':
          if (serverQueue.player.state.status === AudioPlayerStatus.Playing) {
            serverQueue.player.pause();
          } else {
            serverQueue.player.unpause();
          }
          const updatedComponents = createPlayerControlButtons(serverQueue.player.state.status);
          await interaction.update({ components: [updatedComponents] });
          break;

        case 'skip':
          serverQueue.player.stop();
          await interaction.deferUpdate();
          break;
      }
    }
  } catch (e) {
    console.error('コンポーネント処理エラー:', e);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'エラーが発生しました。', flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.followUp({ content: 'エラーが発生しました。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
}
