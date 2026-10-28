'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const commandConfig = {
  name: 'bratlyrics',
  aliases: ['brat', 'brat-lyrics'],
  version: '2.0.0',
  author: 'zach',
  role: 0,
  countDown: 15,
  category: 'Music',
  description: { en: 'Make a brat typewriter lyric video with music' },
  guide: { en: '{pn}bratlyrics song title\n{pn}bratlyrics song title | artist | 0:45 | 30 | white' }
};

const busy = new Set();

const help = prefix => [
  'BRAT LYRICS VIDEO',
  `${prefix}bratlyrics song title`,
  `${prefix}bratlyrics song title | artist | 0:45 | 30 | white`,
  'Works like the music command: the first YouTube result, downloaded with the music API.',
  'The timed lyrics are synced to that audio automatically.',
  'Default: 60 seconds from the first lyric, white background; green is optional.',
  '',
  'Reply to your own audio/video with the song command to use that recording (synced automatically too).',
  'Or supply your own lyrics while replying to audio/video:',
  `${prefix}bratlyrics text | first line / second line | 0:00 | 15`,
  'Text mode also accepts [00:00.00]first line [00:04.00]second line.',
  'Text-mode timestamps start at 0 for the selected audio clip. Plain lines use estimated timing.'
].join('\n');

function parseTimeToSeconds(value) {
  if (typeof value !== 'string') return 0;
  const match = value.match(/^(?:(\d+):)?(\d+)(?:\.(\d+))?$/);
  if (!match) return 0;
  const [, minutes, secs, frac] = match;
  const totalSeconds = Number(secs) + (minutes ? Number(minutes) * 60 : 0);
  return Number((totalSeconds + (frac ? Number(`0.${frac}`) : 0)).toFixed(2));
}

function clampDuration(value) {
  const num = Number(value) || 30;
  return Math.min(60, Math.max(5, num));
}

function parseLrc(rawLrc = '') {
  if (!rawLrc || typeof rawLrc !== 'string') return [];
  return rawLrc
    .split(/\r?\n/)
    .map(line => {
      const match = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
      if (!match) return null;
      const [, min, sec, text] = match;
      return { time: Number(min) * 60 + Number(sec), text: String(text || '').trim() };
    })
    .filter(Boolean);
}

function manualCues(text, duration) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
  if (!lines.length) return [];

  const cues = [];
  const timestampRegex = /\[(\d+):(\d+(?:\.\d+)?)\](.*)/;
  const safeDuration = Number(duration) > 0 ? Number(duration) : 30;
  let currentTime = 0;

  for (const line of lines) {
    const match = line.match(timestampRegex);
    if (match) {
      const [, min, sec, content] = match;
      currentTime = Number(min) * 60 + Number(sec);
      if (content.trim()) {
        cues.push({ time: currentTime, text: content.trim(), duration: Math.max(2.5, Math.min(6, safeDuration / 2)) });
      }
      continue;
    }
    cues.push({ time: currentTime, text: line, duration: Math.max(2.5, Math.min(6, safeDuration / 2)) });
    currentTime += 2.5;
  }

  return cues;
}

function clipCues(cues, start, duration, songLength) {
  if (!Array.isArray(cues)) return [];

  const list = cues
    .map(c => ({ ...c, time: Number(c.time) || 0, duration: Number(c.duration) || 2.5 }))
    .filter(c => Number.isFinite(c.time) && c.text)
    .filter(c => c.time >= start && c.time <= (Number(songLength) || Infinity));

  const maxAllowed = Math.max(0, Number(duration) || 0);
  const output = [];

  for (const c of list) {
    const cueStart = c.time;
    const cueEnd = cueStart + c.duration;
    if (cueEnd < start) continue;
    if (cueStart > start + maxAllowed) continue;
    output.push({ ...c, time: cueStart });
  }

  return output;
}

function parseOptions(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return { manual: false, query: '', artist: '', start: 0, duration: 30, color: 'white', text: '' };
  }

  const segments = raw.split('|').map(s => s.trim());
  const isManual = /^text\s*$/i.test(segments[0] || '') || /\|\s*.*\//i.test(raw);

  if (isManual) {
    const textSource = segments.length > 1 ? segments.slice(1).join(' | ') : raw;
    const text = textSource.replace(/^text\s*\|\s*/i, '').trim();

    let duration = 30;
    let start = 0;
    const first = segments[0]?.trim() || '';

    if (/^text$/i.test(first)) {
      if (segments[1] && /^\d+:\d+$/i.test(segments[1])) start = parseTimeToSeconds(segments[1]);
      if (segments[2] && /^\d+$/i.test(segments[2])) duration = Number(segments[2]);
    }

    const lines = text.split(/\s*\|\s*/).filter(Boolean);
    const cleanText = lines.length ? lines.join('\n') : text;
    const startMatch = cleanText.match(/\[(\d+):(\d+(?:\.\d+)?)\]/g);
    if (startMatch && startMatch.length) start = Math.min(start, parseTimeToSeconds(startMatch[0]));

    return { manual: true, query: '', artist: '', start, duration: Number(duration) || 30, color: 'white', text: cleanText };
  }

  let query = segments[0] || '';
  let artist = '';
  let start = 0;
  let duration = 30;
  let color = 'white';

  if (segments.length >= 2 && !/^\d+:\d+$/i.test(segments[1]) && !/^\d+$/i.test(segments[1])) artist = segments[1];
  if (segments.length >= 3 && /^\d+:\d+$/i.test(segments[2])) start = parseTimeToSeconds(segments[2]);
  if (segments.length >= 4 && /^\d+$/i.test(segments[3])) duration = Number(segments[3]);
  if (segments.length >= 5 && /^(white|green)$/i.test(segments[4])) color = segments[4].toLowerCase();
  if (segments.length >= 3 && /^\d+$/i.test(segments[2])) duration = Number(segments[2]);
  if (segments.length >= 2 && /^\d+:\d+$/i.test(segments[1])) start = parseTimeToSeconds(segments[1]);

  return { manual: false, query: query.trim(), artist: artist.trim(), start, duration: clampDuration(duration), color, text: '' };
}

function getMedia() {
  if (global.media && typeof global.media === 'object') return global.media;
  throw Object.assign(new Error('This bot does not include the media helper needed by bratlyrics. Install the custom media engine or ensure global.media exists.'), { forUser: true });
}

function send(api, event, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = message?.attachment;
    const finish = (error, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stream) stream.removeListener?.('error', onError);
      error ? reject(new Error('Could not send the video/message. Please try again.')) : resolve(info);
    };
    const onError = e => finish(e);
    const timer = setTimeout(() => finish(new Error('timeout')), 180000);
    if (stream) stream.once?.('error', onError);
    try {
      const pending = api.sendMessage(message, event.threadID, finish, event.messageID);
      if (pending && typeof pending.then === 'function') {
        pending.then(info => { if (info) finish(null, info); }, finish);
      }
    } catch (e) {
      finish(e);
    }
  });
}

function react(api, event, emoji) {
  try {
    const p = api.setMessageReaction?.(emoji, event.messageID, () => {}, true);
    if (p?.catch) p.catch(() => {});
  } catch (_) {}
}

async function report(api, event, error) {
  react(api, event, '❌');
  try {
    const msg = error?.forUser ? error.message : (error?.message || 'Could not create this clip. Try a shorter clip or reply to an uploaded audio/video.');
    await send(api, event, msg);
  } catch (_) {}
}

function attachment(event) {
  const items = [...(event.messageReply?.attachments || []), ...(event.attachments || [])];
  return items.find(a => ['audio', 'video'].includes(a.type) && typeof a.url === 'string')?.url || null;
}

async function produce(api, event, options, audioUrl) {
  const media = getMedia();
  const user = String(event.senderID);
  if (busy.has(user) || busy.size >= 2) {
    return send(api, event, 'A lyric video is already processing. Try again shortly.');
  }

  busy.add(user);
  let directory, stream;

  try {
    if (!media.ensureTools || !media.render || !media.firstResult || !media.downloadMusic || !media.syncLyrics) {
      throw Object.assign(new Error('The media helper is incomplete for bratlyrics. Required functions are missing.'), { forUser: true });
    }

    const settings = global.config?.bratLyrics || {};
    const binaries = await media.ensureTools(settings);

    const timing = (track, shift = 0, length = Infinity) => {
      const raw = options.manual ? media.manualCues(options.text, options.duration) : media.parseLrc(track?.syncedLyrics || '').map(c => ({ ...c, time: c.time + shift }));
      const songLength = options.manual ? options.duration : length;
      const start = Math.max(0, options.start ?? (options.manual ? 0 : raw.find(c => c.text)?.time || 0));
      const duration = options.manual ? options.duration : Math.min(options.duration, songLength - start);
      return { start, duration, cues: media.clipCues(raw, options.manual ? 0 : start, duration, songLength) };
    };

    if (options.manual) timing(null);
    react(api, event, '⏳');
    await send(api, event, 'Preparing your brat lyric video. Downloading music and rendering can take a few minutes.');

    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chia-bratlyrics-'));
    const item = options.manual ? null : await media.firstResult(options.query, options.artist);
    const audio = audioUrl ? await media.downloadAttachment(audioUrl, directory)
      : await media.downloadMusic(item.url, path.join(directory, 'song.mp3'), settings);
    const length = await media.mediaDuration(binaries.ffmpeg, audio);

    let track = null;
    let shift = 0;
    let how = 'manual';
    if (!options.manual) {
      ({ lyrics: track, shift, how } = await media.syncLyrics(item, audio, length || item.seconds, directory, settings, binaries.ffmpeg, { isResult: !audioUrl }));
    }

    const { start, duration, cues } = timing(track, shift, length || Infinity);
    const file = await media.render({ dir: directory, audio, cues, start, duration, color: options.color, ffmpeg: binaries.ffmpeg, settings });
    stream = fs.createReadStream(file);

    const caption = [
      track ? `${track.trackName} — ${track.artistName}` : 'Your brat lyric video',
      `${start.toFixed(1)}s · up to ${duration.toFixed(1)} seconds · ${options.color}`,
      how === 'manual' ? 'Custom lyrics · typing timing estimated'
        : how === 'measured' ? `Timed lyrics: LRCLIB · synced to this audio automatically (${shift >= 0 ? '+' : ''}${shift.toFixed(1)}s)`
        : how === 'approximate' ? 'Timed lyrics: LRCLIB (no exact match found, timing may be slightly off)'
        : how === 'length' ? 'Timed lyrics: LRCLIB (matched by length; no official track to check against)'
        : 'Timed lyrics: LRCLIB · official audio',
      audioUrl ? 'Music: your attachment' : `Music: ${item.videoTitle} · ${item.url}`
    ].join('\n');

    await send(api, event, { body: caption, attachment: stream });
    react(api, event, '✅');
  } catch (error) {
    await report(api, event, error);
  } finally {
    if (stream && !stream.closed) {
      await new Promise(resolve => {
        stream.once('close', resolve);
        stream.destroy();
      });
    }
    if (directory) {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    busy.delete(user);
  }
}

module.exports = {
  config: commandConfig,

  onStart: async function ({ api, event, args }) {
    const input = (args || []).join(' ').trim();
    const prefix = global.GoatBot?.config?.prefix || global.config?.PREFIX || '-';

    if (!input || /^(help|usage)$/i.test(input)) {
      return send(api, event, help(prefix));
    }

    try {
      const media = getMedia();
      const options = media.parseOptions ? media.parseOptions(input) : parseOptions(input);
      const audioUrl = attachment(event);
      if (options.manual && !audioUrl) {
        throw Object.assign(new Error('Reply to a music/audio file or a video with sound, then use bratlyrics text | your lyrics.'), { forUser: true });
      }
      await produce(api, event, options, audioUrl);
    } catch (error) {
      await report(api, event, error);
    }
  },

  onReply: async function ({ api, event, Reply }) {
    if (!Reply || !Reply.shouldContinue) return;
    if (Reply.command !== 'bratlyrics') return;

    const input = (event.body || '').trim();
    if (!input) return;

    try {
      const media = getMedia();
      const options = media.parseOptions ? media.parseOptions(input) : parseOptions(input);
      const audioUrl = attachment(event);
      if (options.manual && !audioUrl) {
        throw Object.assign(new Error('Reply to a music/audio file or a video with sound, then use bratlyrics text | your lyrics.'), { forUser: true });
      }
      await produce(api, event, options, audioUrl);
    } catch (error) {
      await report(api, event, error);
    }
  }
};

module.exports.ST = module.exports.onStart;
module.exports.run = module.exports.onStart;
