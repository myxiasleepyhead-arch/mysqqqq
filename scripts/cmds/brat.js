'use strict';

const fs = require('fs-extra');
const media = require('./utils/bratlyricsMedia');

function react(api, event, emoji) {
  try {
    const result = api.setMessageReaction?.(emoji, event.messageID, () => {}, true);
    result?.catch?.(() => {});
  } catch (_) {
    // Reactions are optional.
  }
}

module.exports = {
  config: {
    name: 'bratlyrics',
    version: '3.0.0',
    author: 'zach',
    countDown: 15,
    role: 0,
    description: { en: 'Create a brat-style lyric video from a song' },
    category: 'music',
    guide: {
      en: '{pn} <song> [| artist | start | 5-60 seconds | white/green]\nExample: {pn} Espresso | Sabrina Carpenter | 0:00 | 30 | green'
    }
  },

  onStart: async function ({ api, message, event, args }) {
    const input = (args || []).join(' ').trim();
    if (!input || /^(help|usage)$/i.test(input)) {
      return message.reply(
        'BRAT LYRICS VIDEO\n\n' +
        'Usage: bratlyrics <song> [| artist | start | duration | white/green]\n' +
        'Example: bratlyrics Espresso | Sabrina Carpenter | 0:00 | 30 | green\n\n' +
        'Lyrics come from LRCLIB. Duration defaults to 30 seconds.'
      );
    }

    let options;
    try {
      options = media.parseOptions(input);
    } catch (error) {
      return message.reply(error.forUser ? error.message : 'Invalid bratlyrics options. Type bratlyrics help.');
    }

    const senderID = String(event.senderID || event.threadID);
    if (!media.acquire(senderID)) {
      return message.reply('A brat video is already processing for you. Try again shortly.');
    }

    let currentStage = 'starting';
    let result;
    let videoStream;
    let statusMessage;
    try {
      react(api, event, '⏳');
      statusMessage = await message.reply('Preparing the lyric video...');
      result = await media.createVideo(options, stage => {
        currentStage = stage;
      });

      currentStage = 'sending the video';
      videoStream = fs.createReadStream(result.videoPath);
      await message.reply({
        body: [
          `${result.trackName} — ${result.artistName}`,
          `${result.start.toFixed(1)}s · ${result.duration.toFixed(1)} seconds · ${options.color} background`,
          `Lyrics: LRCLIB${result.estimated ? ' · timing estimated' : ' · synced timestamps'}`,
          `Audio: ${result.videoTitle} · ${result.videoUrl}`
        ].join('\n'),
        attachment: videoStream
      });
      react(api, event, '✅');
    } catch (error) {
      console.error(`[bratlyrics] Failed during ${currentStage}:`, error?.stack || error);
      react(api, event, '❌');
      const reply = error?.forUser
        ? `❌ ${error.message}`
        : `❌ Failed during ${currentStage}. Check the bot server log for details.`;
      try {
        await message.reply(reply);
      } catch (_) {
        // Keep cleanup running even if the error reply fails.
      }
    } finally {
      if (videoStream && !videoStream.destroyed) videoStream.destroy();
      if (statusMessage?.messageID && typeof message.unsend === 'function') {
        try {
          await message.unsend(statusMessage.messageID);
        } catch (_) {
          // A status message that remains is harmless.
        }
      }
      if (result?.directory) await media.removeDirectory(result.directory);
      media.release(senderID);
    }
  }
};
