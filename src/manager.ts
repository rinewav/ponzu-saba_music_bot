import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import type { InstanceState, ChildMessage, BotConfig } from './types.js';
import { Dashboard } from './tui/dashboard.js';

dotenv.config();

const MAX_RESTART_DELAY = 30000;
const BASE_RESTART_DELAY = 1000;

function loadBotConfigs(): { guildId: string; bots: BotConfig[] } {
  const guildId = process.env.GUILD_ID;
  if (!guildId) {
    console.error('GUILD_ID が .env に設定されていません。');
    process.exit(1);
  }

  const bots: BotConfig[] = [];
  for (let i = 1; i <= 5; i++) {
    const token = process.env[`BOT_${i}_TOKEN`];
    if (!token) continue;
    const name = process.env[`BOT_${i}_NAME`] ?? `${i}号機`;
    bots.push({ name, token });
  }

  if (bots.length === 0) {
    console.error('.env に BOT_1_TOKEN が設定されていません。');
    process.exit(1);
  }

  return { guildId, bots };
}

const { guildId, bots } = loadBotConfigs();

const instances: InstanceState[] = bots.map(bot => ({
  name: bot.name,
  status: 'offline' as const,
  detail: undefined,
  logs: [],
  process: null,
  restartCount: 0,
  lastRestartAt: null,
  intentionallyStopped: false,
}));

const dashboard = new Dashboard();

function getBotScriptPath(): string {
  const compiled = resolve(__dirname, 'index.js');
  if (existsSync(compiled)) return compiled;
  const dev = resolve(__dirname, '..', 'src', 'index.ts');
  if (existsSync(dev)) return dev;
  return compiled;
}

function spawnInstance(index: number): void {
  const bot = bots[index];
  if (!bot) return;

  const inst = instances[index];
  if (inst.process) {
    inst.process.kill();
    inst.process = null;
  }

  inst.intentionallyStopped = false;

  const scriptPath = getBotScriptPath();
  const isDev = scriptPath.endsWith('.ts');

  const child: ChildProcess = fork(scriptPath, [], {
    execArgv: isDev ? ['--require', 'tsx/cjs'] : [],
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  inst.process = child;
  inst.status = 'offline';
  inst.restartCount = 0;

  child.on('message', (msg: ChildMessage) => {
    if (msg.type === 'status') {
      inst.status = msg.status;
      inst.detail = msg.detail;
    } else if (msg.type === 'log') {
      inst.logs.push({ timestamp: new Date(), level: msg.level, message: msg.message });
      if (inst.logs.length > 100) {
        inst.logs = inst.logs.slice(-50);
      }
    }
    dashboard.render(instances);
  });

  child.on('exit', (code) => {
    inst.status = 'offline';
    inst.process = null;
    inst.logs.push({ timestamp: new Date(), level: 'error', message: `プロセス終了 (code: ${code})` });

    if (inst.intentionallyStopped) {
      inst.logs.push({ timestamp: new Date(), level: 'info', message: '意図的な停止のため自動再起動しません。' });
      dashboard.render(instances);
      return;
    }

    const delay = Math.min(BASE_RESTART_DELAY * Math.pow(2, inst.restartCount), MAX_RESTART_DELAY);
    inst.restartCount++;
    inst.lastRestartAt = new Date();
    inst.logs.push({ timestamp: new Date(), level: 'warn', message: `${Math.round(delay / 1000)}秒後に再起動します...` });

    dashboard.render(instances);

    setTimeout(() => {
      if (inst.process || inst.intentionallyStopped) return;
      spawnInstance(index);
    }, delay);
  });

  child.on('error', (err) => {
    inst.logs.push({ timestamp: new Date(), level: 'error', message: `プロセスエラー: ${err.message}` });
    dashboard.render(instances);
  });

  child.send({ type: 'init', config: bot, guildId, instanceIndex: index });

  dashboard.render(instances);
}

for (let i = 0; i < bots.length; i++) {
  spawnInstance(i);
}

dashboard.render(instances);

dashboard.onKey((key: string) => {
  if (key === 'quit') {
    for (const inst of instances) {
      inst.intentionallyStopped = true;
      if (inst.process) {
        inst.process.send({ type: 'shutdown' });
        setTimeout(() => inst.process?.kill(), 3000);
      }
    }
    setTimeout(() => {
      dashboard.destroy();
      process.exit(0);
    }, 3500);
  } else if (key.startsWith('restart:')) {
    const idx = parseInt(key.split(':')[1]);
    const inst = instances[idx];
    if (inst?.process) {
      inst.intentionallyStopped = false;
      inst.process.send({ type: 'restart' });
      inst.logs.push({ timestamp: new Date(), level: 'info', message: '再起動要求を送信しました。' });
      dashboard.render(instances);
    }
  } else if (key === 'stop-all') {
    for (const inst of instances) {
      inst.intentionallyStopped = true;
      if (inst.process) {
        inst.process.send({ type: 'shutdown' });
      }
    }
    dashboard.render(instances);
  }
});

setInterval(() => {
  dashboard.render(instances);
}, 500);
