import blessed from 'blessed';
import type { InstanceState } from '../types.js';
import { ASCII_ART } from './ascii.js';

const MAX_LOGS = 3;

export class Dashboard {
  private screen: blessed.Widgets.Screen;
  private headerBox!: blessed.Widgets.BoxElement;
  private instanceBoxes: blessed.Widgets.BoxElement[] = [];
  private footerBox!: blessed.Widgets.BoxElement;
  private onKeyHandler?: (key: string) => void;

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'ぽん酢鯖専用音楽ボット - るんるんぽぽび プロセスダッシュボード',
      fullUnicode: true,
      terminal: process.platform === 'win32' ? 'windows-256color' : undefined,
    });

    this.buildLayout();
    this.bindKeys();
  }

  private buildLayout(): void {
    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 10,
      content: `{center}{bold}{cyan-fg}${ASCII_ART}{/cyan-fg}{/bold}\n{center}{white-fg}Discord Music Bot Manager{/white-fg}{/center}`,
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
    });

    this.screen.append(this.headerBox);

    const instanceCount = 5;
    const instanceStartY = 11;
    const instanceHeight = 6;

    for (let i = 0; i < instanceCount; i++) {
      const box = blessed.box({
        top: instanceStartY + i * (instanceHeight + 1),
        left: 0,
        width: '100%',
        height: instanceHeight,
        tags: true,
        border: { type: 'line' },
        style: { border: { fg: 'gray' } },
        scrollable: true,
      });
      this.instanceBoxes.push(box);
      this.screen.append(box);
    }

    const footerY = instanceStartY + instanceCount * (instanceHeight + 1);
    this.footerBox = blessed.box({
      top: footerY,
      left: 0,
      width: '100%',
      height: 3,
      content: '{center}[1-5] 再起動  [S] 全停止  [Q] 終了{/center}',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'green' }, fg: 'white' },
    });

    this.screen.append(this.footerBox);
  }

  private bindKeys(): void {
    this.screen.key(['1', '2', '3', '4', '5'], (_ch, key) => {
      const idx = parseInt(key.full) - 1;
      this.onKeyHandler?.(`restart:${idx}`);
    });

    this.screen.key(['s', 'S'], () => {
      this.onKeyHandler?.('stop-all');
    });

    this.screen.key(['q', 'Q', 'C-c'], () => {
      this.onKeyHandler?.('quit');
    });
  }

  onKey(handler: (key: string) => void): void {
    this.onKeyHandler = handler;
  }

  render(instances: InstanceState[]): void {
    for (let i = 0; i < this.instanceBoxes.length; i++) {
      const inst = instances[i];
      if (!inst) continue;

      const statusColor = inst.status === 'online'
        ? '{green-fg}●{/green-fg}'
        : inst.status === 'playing'
          ? '{cyan-fg}●{/cyan-fg}'
          : '{red-fg}○{/red-fg}';

      const statusLabel = inst.status === 'online'
        ? '{green-fg}Online{/green-fg}'
        : inst.status === 'playing'
          ? '{cyan-fg}Playing{/cyan-fg}'
          : '{red-fg}Offline{/red-fg}';

      const borderColor = inst.status === 'offline' ? 'red' : inst.status === 'playing' ? 'cyan' : 'green';
      this.instanceBoxes[i].style.border!.fg = borderColor;

      let detail = '';
      if (inst.detail) {
        detail = ` 🎵 ${inst.detail.slice(0, 40)}`;
      }

      let lines = `{bold}${statusColor} ${inst.name}  [${statusLabel}]{/bold}${detail}\n`;

      const recentLogs = inst.logs.slice(-MAX_LOGS);
      if (recentLogs.length > 0) {
        for (const log of recentLogs) {
          const time = log.timestamp.toLocaleTimeString('ja-JP', { hour12: false });
          const levelTag = log.level === 'error'
            ? '{red-fg}[ERR]{/red-fg}'
            : log.level === 'warn'
              ? '{yellow-fg}[WRN]{/yellow-fg}'
              : '{gray-fg}[INF]{/gray-fg}';
          const msg = log.message.slice(0, 200);
          lines += `  ${levelTag} ${time} ${msg}\n`;
        }
      } else {
        lines += '  {gray-fg}ログなし{/gray-fg}\n';
      }

      try {
        this.instanceBoxes[i].setContent(lines);
      } catch {
        this.instanceBoxes[i].setContent(lines.replace(/\{[^}]+\}/g, ''));
      }
    }

    this.screen.render();
  }

  destroy(): void {
    this.screen.destroy();
  }
}
