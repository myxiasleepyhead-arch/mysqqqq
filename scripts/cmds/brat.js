'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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

function send(api, event, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = message && typeof message === 'object' && 'attachment' in message ? message.attachment : null;
    const finish = (error, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stream && typeof stream.removeListener === 'function') stream.removeListener('error', onError);
      if (error) return reject(new Error('Could not send the video/message. Please try again.'));
      resolve(info);
    };
    const onError = e => finish(e);
    const timer = setTimeout(() => finish(new Error('timeout')), 180000);

    if (stream && typeof stream.once === 'function') stream.once('error', onError);

    try {
      if (typeof api?.sendMessage === 'function') {
        const pending = api.sendMessage(message, event?.threadID, finish, event?.messageID);
        if (pending && typeof pending.then === 'function') {
          pending.then(info => finish(null, info), finish);
        }
        return;
      }

      if (typeof event?.reply === 'function') {
        Promise.resolve(event.reply(message)).then(info => finish(null, info), finish);
        return;
      }

      finish(new Error('No send method available'));
    } catch (e) {
      finish(e);
    }
  });
}

function react(api, event, emoji) {
  try {
    const p = api?.setMessageReaction?.(emoji, event?.messageID, () => {}, true);
    if (p?.catch) p.catch(() => {});
  } catch (_) {}
}

function attachment(event) {
  const items = [...(event?.messageReply?.attachments || []), ...(event?.attachments || [])];
  return items.find(a => ['audio', 'video'].includes(a?.type) && typeof a?.url === 'string')?.url || null;
}

function parseTimeToSeconds(value) {
  if (typeof value !== 'string') return 0;
  const match = value.match(/^(?:(\d+):)?(\d{1,2})(?::(\d{1,2}))?(?:\.(\d+))?$/);
  if (!match) return 0;
  const [, minutes = '0', sec, sec2, frac = '0'] = match;
  const total = Number(sec2 ?? sec) + Number(minutes) * 60;
  return Number((total + Number(`0.${frac}`)).toFixed(2));
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
      const match = line.match(/^\[([0-9]+):([0-9]+(?:\.[0-9]+)?)\](.*)$/);
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
  let currentTime = 0;
  const safeDuration = Math.max(5, Number(duration) || 30);

  for (const line of lines) {
    const match = line.match(/\[([0-9]+):([0-9]+(?:\.[0-9]+)?)\](.*)/);
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

  const output = [];
  for (const c of list) {
    const cueStart = c.time;
    const cueEnd = cueStart + c.duration;
    if (cueEnd < start) continue;
    if (cueStart > start + duration) continue;
    output.push({ ...c, time: cueStart });
  }

  return output;
}

function parseOptions(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return { manual: false, query: '', artist: '', start: 0, duration: 30, color: 'white', text: '' };
  }

  const segments = raw.split('|').map(s => s.trim()).filter(Boolean);
  const isManual = /(?:^|\s)text\s*(?:\||$)/i.test(raw) || /(?:^|\s)lyrics\s*(?:\||$)/i.test(raw);

  if (isManual) {
    const textSource = segments.length > 1 ? segments.slice(1).join(' | ') : raw;
    const text = textSource.replace(/^\s*text\s*[\|\-:]*\s*/i, '').trim();

    let start = 0;
    let duration = 30;

    if (segments[1] && /^(\d+:)?\d+(?::\d+)?(\.\d+)?$/i.test(segments[1])) {
      start = parseTimeToSeconds(segments[1]);
    }
    if (segments[2] && /^\d+(\.\d+)?$/i.test(segments[2])) {
      duration = clampDuration(segments[2]);
    }

    return {
      manual: true,
      query: '',
      artist: '',
      start,
      duration,
      color: 'white',
      text
    };
  }

  let query = segments[0] || '';
  let artist = '';
  let start = 0;
  let duration = 30;
  let color = 'white';

  if (segments.length >= 2) artist = segments[1];
  if (segments.length >= 3) start = parseTimeToSeconds(segments[2]);
  if (segments.length >= 4) duration = clampDuration(segments[3]);
  if (segments.length >= 5) color = ['white', 'green'].includes(segments[4].toLowerCase()) ? segments[4].toLowerCase() : 'white';

  return { manual: false, query: query.trim(), artist: artist.trim(), start, duration, color, text: '' };
}

function getMedia() {
  const media = global.media || global.GoatBot?.media || global?.GoatBot?.media;
  return media && typeof media === 'object' ? media : null;
}

async function produce(api, event, options, audioUrl) {
  const media = getMedia();

  if (!media) {
    return send(api, event, '⚠️ This bot build does not include the media helper required for brat lyric rendering. The command is installed and compatible, but the renderer is missing from the runtime.');
  }

  const user = String(event?.senderID || 'unknown');
  if (busy.has(user) || busy.size >= 2) {
    return send(api, event, 'A lyric video is already processing. Try again shortly.');
  }

  busy.add(user);

  try {
    const settings = global.config?.bratLyrics || {};
    const binaries = await media.ensureTools(settings);

    const timing = (track, shift = 0, length = Infinity) => {
      const raw = options.manual
        ? (media.manualCues ? media.manualCues(options.text, options.duration) : manualCues(options.text, options.duration))
        : (media.parseLrc ? media.parseLrc(track.syncedLyrics) : parseLrc(track.syncedLyrics));

      const songLength = options.manual ? options.duration : length;
      const start = Math.max(0, options.start ?? (options.manual ? 0 : (raw.find(c => c.text)?.time || 0)));
      const duration = options.manual ? options.duration : Math.min(options.duration, songLength - start);

      return {
        start,
        duration,
        cues: (media.clipCues ? media.clipCues(raw, options.manual ? 0 : start, duration, songLength) : clipCues(raw, options.manual ? 0 : start, duration, songLength))
      };
    };

    if (options.manual) timing(null);

    react(api, event, '⏳');
    await send(api, event, 'Preparing your brat lyric video. Downloading music and rendering can take a few minutes.');

    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'brat-lyrics-'));
    const item = options.manual ? null : await media.firstResult(options.query, options.artist);
    const audio = audioUrl
      ? await media.downloadAttachment(audioUrl, directory)
      : await media.downloadMusic(item.url, path.join(directory, 'song.mp3'), settings);

    const length = await media.mediaDuration(binaries.ffmpeg, audio);

    let track = null;
    let shift = 0;
    let how = 'manual';

    if (!options.manual) {
      ({ lyrics: track, shift, how } = await media.syncLyrics(item, audio, length || item.seconds, directory, settings, binaries.ffmpeg, { isResult: !audioUrl }));
    }

    const { start, duration, cues } = timing(track, shift, length || Infinity);
    const file = await media.render({
      dir: directory,
      audio,
      cues,
      start,
      duration,
      color: options.color,
      ffmpeg: binaries.ffmpeg,
      settings
    });

    const stream = fs.createReadStream(file);
    const caption = [
      track ? `${track.trackName} — ${track.artistName}` : 'Your brat lyric video',
      `${start.toFixed(1)}s · up to ${duration.toFixed(1)} seconds · ${options.color}`,
      how === 'manual'
        ? 'Custom lyrics · typing timing estimated'
        : how === 'measured'
          ? `Timed lyrics: LRCLIB · synced to this audio automatically (${shift >= 0 ? '+' : ''}${shift.toFixed(1)}s)`
          : how === 'approximate'
            ? 'Timed lyrics: LRCLIB (no exact match found, timing may be slightly off)'
            : how === 'length'
              ? 'Timed lyrics: LRCLIB (matched by length; no official track to check against)'
              : 'Timed lyrics: LRCLIB · official audio',
      audioUrl ? 'Music: your attachment' : `Music: ${item.videoTitle} · ${item.url}`
    ].join('\n');

    await send(api, event, { body: caption, attachment: stream });
    react(api, event, '✅');
    return true;
  } catch (error) {
    react(api, event, '❌');
    await send(api, event, error?.forUser ? error.message : 'Could not create this clip. Try a shorter clip or reply to an uploaded audio/video.');
    return false;
  } finally {
    busy.delete(user);
  }
}

module.exports = {
  config: {
    name: 'bratlyrics',
    aliases: ['brat', 'brat-lyrics'],
    version: '2.0.0',
    author: 'zach',
    role: 0,
    countDown: 15,
    category: 'music',
    description: { en: 'Make a brat typewriter lyric video with music' },
    guide: {
      en: '{pn}bratlyrics song title\n{pn}bratlyrics song title | artist | 0:45 | 30 | white'
    }
  },

  onStart: async function ({ api, event, args }) {
    const prefix = global.GoatBot?.config?.prefix || global.config?.PREFIX || '-';
    const input = (args || []).join(' ').trim();

    if (!input || /^(help|usage)$/i.test(input)) {
      return send(api, event, help(prefix));
    }

    try {
      const options = parseOptions(input);
      const audioUrl = attachment(event);

      if (options.manual && !audioUrl) {
        throw Object.assign(new Error('Reply to a music/audio file or a video with sound, then use bratlyrics text | your lyrics.'), { forUser: true });
      }

      await produce(api, event, options, audioUrl);
    } catch (error) {
      react(api, event, '❌');
      await send(api, event, error?.forUser ? error.message : error?.message || 'Unable to process brat lyrics.');
    }
  }
};

module.exports.run = module.exports.onStart;
