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
  description: {
    en: 'Make a brat typewriter lyric video with music'
  },
  usages: '<song> | <artist> | <start> | <5–60 seconds> | <white/green>',
  guide: {
    en: '{pn}bratlyrics song title\n{pn}bratlyrics song title | artist | 0:45 | 30 | white'
  }
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

function getMedia() {
  if (!global.media || typeof global.media !== 'object') {
    throw Object.assign(new Error('This bot does not include the media helper required by bratlyrics.'), { forUser: true });
  }
  return global.media;
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
    const msg = error?.forUser ? error.message : 'Could not create this clip. Try a shorter clip or reply to an uploaded audio/video.';
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
    const settings = global.config?.bratLyrics || {};
    const binaries = await media.ensureTools(settings);

    const timing = (track, shift = 0, length = Infinity) => {
      const raw = options.manual ? media.manualCues(options.text, options.duration) : media.parseLrc(track.syncedLyrics).map(c => ({ ...c, time: c.time + shift }));
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
      const options = media.parseOptions(input);
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
      const options = media.parseOptions(input);
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

module.exports.run = module.exports.onStart;
