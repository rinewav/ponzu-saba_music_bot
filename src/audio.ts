import { execFile } from 'node:child_process';
import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import type { Song, LyricLine } from './types.js';

const ffmpegPath: string =
  ffmpegStatic && fs.existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg';

export function measureLufs(filePath: string): Promise<{ input_i: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', filePath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null',
      '-',
    ];

    execFile(ffmpegPath, args, (error, _stdout, stderr) => {
      if (error) return reject(error);
      try {
        const jsonStartIndex = stderr.lastIndexOf('{');
        const jsonEndIndex = stderr.lastIndexOf('}');
        if (jsonStartIndex === -1 || jsonEndIndex === -1) {
          return reject(new Error('ffmpegの出力からLoudnormのJSONデータが見つかりませんでした。'));
        }
        const jsonString = stderr.substring(jsonStartIndex, jsonEndIndex + 1);
        resolve(JSON.parse(jsonString));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export async function fetchAndParseLyrics(song: Song): Promise<LyricLine[] | null> {
  try {
    const searchParams = new URLSearchParams({
      track_name: song.title,
      artist_name: song.uploader,
      duration: song.duration.toString(),
    });
    const searchResponse = await fetch(`https://lrclib.net/api/search?${searchParams}`);
    if (!searchResponse.ok) throw new Error(`API検索エラー: ${searchResponse.statusText}`);

    const searchResults = await searchResponse.json() as Array<{ syncedLyrics?: string }>;
    if (!searchResults || searchResults.length === 0) throw new Error('APIで歌詞が見つかりません。');

    const lyricData = searchResults[0];
    if (!lyricData.syncedLyrics) throw new Error('同期された歌詞が見つかりません。');

    const lines = lyricData.syncedLyrics.split('\n');
    const parsedLyrics: LyricLine[] = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

    for (const line of lines) {
      const match = line.match(timeRegex);
      if (match) {
        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
        const start = minutes * 60 + seconds + milliseconds / 1000;
        const text = line.substring(line.indexOf(']') + 1).trim();

        if (text) {
          if (parsedLyrics.length > 0) {
            parsedLyrics[parsedLyrics.length - 1].end = start;
          }
          parsedLyrics.push({ start, end: start + 10, text });
        }
      }
    }

    if (parsedLyrics.length === 0) throw new Error('歌詞の解析に失敗しました。');

    return parsedLyrics;
  } catch (e) {
    const err = e as Error;
    console.warn(`[LRCLib] 歌詞の取得に失敗: ${song.title} - ${err.message}`);
    return null;
  }
}
