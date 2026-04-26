import { REST, Routes, Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

interface BotEntry {
  name: string;
  token: string;
  clientId: string;
}

const bots: BotEntry[] = [];
for (let i = 1; i <= 5; i++) {
  const token = process.env[`BOT_${i}_TOKEN`];
  const name = process.env[`BOT_${i}_NAME`] ?? `${i}号機`;
  if (!token) continue;
  bots.push({ name, token, clientId: '' });
}

async function discoverClientId(token: string): Promise<string> {
  const rest = new REST({ version: '10' }).setToken(token);
  const app = await rest.get(Routes.currentApplication()) as { id: string };
  return app.id;
}

async function unregisterCommandsForBot(bot: BotEntry & { clientId: string }): Promise<void> {
  console.log(`--- [${bot.name}] のコマンド登録解除処理を開始します ---`);

  const rest = new REST({ version: '10' }).setToken(bot.token);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => {
        console.log(`[${bot.name}] としてログイン成功: ${client.user?.tag}`);
        resolve();
      });
      client.login(bot.token).catch(reject);
    });

    console.log(`[${bot.name}] グローバルコマンドを削除しています...`);
    await rest.put(Routes.applicationCommands(bot.clientId), { body: [] });
    console.log(`[${bot.name}] ✅ グローバルコマンドの削除が完了しました。`);

    const guilds = client.guilds.cache;
    console.log(`[${bot.name}] ${guilds.size}個のサーバーのコマンドをチェックします...`);

    for (const [guildId, guild] of guilds) {
      try {
        console.log(`  -> サーバー: "${guild.name}" (${guildId}) のコマンドを削除しています...`);
        await rest.put(Routes.applicationGuildCommands(bot.clientId, guildId), { body: [] });
        console.log(`  -> ✅ サーバー: "${guild.name}" のコマンド削除が完了しました。`);
      } catch (err) {
        console.error(`  -> ❌ サーバー: "${guild.name}" (${guildId}) のコマンド削除に失敗しました。`, (err as Error).message);
      }
    }
  } catch (error) {
    console.error(`[${bot.name}] の処理中に致命的なエラーが発生しました:`, error);
  } finally {
    console.log(`[${bot.name}] 処理が終了したため、ログアウトします。`);
    client.destroy();
  }
  console.log(`--- [${bot.name}] のコマンド登録解除処理が完了しました ---\n`);
}

async function main(): Promise<void> {
  console.log('全てのボットのコマンド登録解除処理を開始します...');

  for (const bot of bots) {
    try {
      const clientId = await discoverClientId(bot.token);
      await unregisterCommandsForBot({ ...bot, clientId });
    } catch (err) {
      console.error(`[${bot.name}] クライアントIDの取得に失敗しました:`, (err as Error).message);
    }
  }

  console.log('全ての処理が完了しました。');
}

main();
