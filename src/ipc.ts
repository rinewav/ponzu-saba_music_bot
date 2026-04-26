import type { ChildMessage, ParentMessage } from './types.js';

export function sendToParent(msg: ChildMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

export function onParentMessage(handler: (msg: ParentMessage) => void): void {
  process.on('message', (msg: ParentMessage) => {
    handler(msg);
  });
}
