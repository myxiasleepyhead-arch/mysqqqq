'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const media = require('./bratMedia');

const busyUsers = new Set();
const MAX_JOBS = 2;

function react(api, event, emoji) {
  try {
    const result = api.setMessageReaction?.(emoji, event.messageID, () => {}, true);
    result?.catch?.(() => {});
  } catch (_) {
    // Reactions are optional; sending the result should still work.
  }
}

function help(prefix) {
  return [
    'BRAT LYRICS VIDEO',
    `${prefix}bratlyrics <song title>`,
    `${prefix}bratlyrics <song> | <artist> | <start> | <5-60 seconds> | <white/green>`,
    '',
    'The first YouTube result is used with the bot music downloader and timed lyrics are searched from LRCLIB.',
    'Example: bratlyrics song title | artist | 0:45 | 30 | green',
    '',
    'To use your own audio, reply to an audio/video attachment:',
    `${prefix}bratlyrics text | first line / second line | 0:00 | 15 | white`,
    'Manual lyrics may also use timestamps such as [00:00.00]first line.',
    'Duration defaults to 60 seconds. Background defaults to white.'
  ].join('\n');
}

async function produce({ api, message, event, options, audioUrl }) {
  const userID = String(event.senderID || event.threadID);
  if (busyUsers.has(userID) || busyUsers.size >= MAX_JOBS) {
    return message.reply('A lyric video is already processing. Try again shortly.');
  }

  busyUsers.add(userID);
  let directory;
  let outputStream;
  let processingMessage;

  try {
    const settings = global.GoatBot?.config?.bratLyrics || {};
    const binaries = await media.ensureTools(settings);
    react(api, event, '⏳');
    processingMessage = await message.reply(
      'teka lang'
    );

    directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'goatbot-bratlyrics-'));

    const item = options.manual
      ? null
      : await media.firstResult(options.query, options.artist);
    const audio = audioUrl
      ? await media.downloadAttachment(audioUrl, directory)
      : await media.downloadMusic(item.url, path.join(directory, 'song.mp3'), settings);

    const audioLength = await media.mediaDuration(binaries.ffprobe, audio);
    if (!Number.isFinite(audioLength) || audioLength <= 0) {
      throw media.fail('Could not read the audio duration. Try another audio file or song.');
    }

    let lyrics = null;
    let rawCues;
    let start = options.start ?? 0;
    let how = 'manual';

    if (options.manual) {
      rawCues = media.manualCues(options.text, options.duration);
    } else {
      const synced = await media.syncLyrics(item, audioLength);
      lyrics = synced.lyrics;
      rawCues = media.parseLrc(lyrics.syncedLyrics);
      if (!rawCues.length) {
        throw media.fail('Timed lyrics were not found for that song. Reply to an audio/video with your own lyrics instead.');
      }
      if (options.start === null) {
        start = rawCues.find(cue => cue.text)?.time ?? 0;
      }
      how = 'LRCLIB timestamps';
    }

    if (start >= audioLength) {
      throw media.fail('The start time is past the end of the audio.');
    }

    const duration = Math.min(options.duration, audioLength - start);
    if (duration < 5) {
      throw media.fail('There are fewer than 5 seconds of audio left at that start time.');
    }

    const cues = media.clipCues(rawCues, options.manual ? 0 : start, duration);
    if (!cues.length) {
      throw media.fail('No lyrics fall within that clip. Try an earlier start time or use manual lyrics.');
    }

    const videoPath = await media.render({
      dir: directory,
      audio,
      cues,
      start: options.manual ? 0 : start,
      duration,
      color: options.color,
      ffmpeg: binaries.ffmpeg,
      font: binaries.font
    });

    const caption = [
      lyrics ? `${lyrics.trackName} — ${lyrics.artistName}` : 'Your brat lyric video',
      `${start.toFixed(1)}s · ${duration.toFixed(1)} seconds · ${options.color} background`,
      options.manual ? 'Custom lyrics · timing estimated unless timestamps are provided' : `Timed lyrics: ${how}`,
      audioUrl ? 'Music: your attachment' : `Music: ${item.videoTitle} · ${item.url}`
    ].join('\n');

    outputStream = fs.createReadStream(videoPath);
    await message.reply({ body: caption, attachment: outputStream });
    react(api, event, '✅');
  } catch (error) {
    console.error('[bratlyrics] Error:', error?.stack || error);
    react(api, event, '❌');
    const text = error?.forUser
      ? error.message
      : 'Could not create the lyric video. Try a shorter clip or reply to an audio/video attachment with manual lyrics.';
    try {
      await message.reply(text);
    } catch (_) {
      // Keep cleanup and the per-user lock release running even if the reply fails.
    }
  } finally {
    if (outputStream && !outputStream.destroyed) outputStream.destroy();
    if (processingMessage?.messageID && typeof message.unsend === 'function') {
      try {
        await message.unsend(processingMessage.messageID);
      } catch (_) {
        // The result is already sent; failure to remove the status message is harmless.
      }
    }
    if (directory) {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    busyUsers.delete(userID);
  }
}

module.exports = {
  config: {
    name: 'bratlyrics',
    version: '2.1.0',
    author: 'zach',
    countDown: 15,
    role: 0,
    description: { en: 'Create a brat-style lyric video from a song or audio attachment' },
    category: 'music',
    guide: {
      en: '{pn} <song> | <artist> | <start> | <5-60 seconds> | <white/green>\nReply to audio/video: {pn} text | lyrics | 0:00 | 15'
    }
  },

  onStart: async function ({ api, message, event, args }) {
    const input = (args || []).join(' ').trim();
    const prefix = global.GoatBot?.config?.prefix || '!';

    if (!input || /^(help|usage)$/i.test(input)) {
      return message.reply(help(prefix));
    }

    try {
      const options = media.parseOptions(input);
      const audioUrl = media.attachment(event);
      if (options.manual && !audioUrl) {
        throw media.fail('Reply to an audio/video attachment, then use: bratlyrics text | your lyrics.');
      }
      await produce({ api, message, event, options, audioUrl });
    } catch (error) {
      react(api, event, '❌');
      return message.reply(error?.forUser ? error.message : 'Invalid brat lyrics options. Type bratlyrics help for usage.');
    }
  }
};
