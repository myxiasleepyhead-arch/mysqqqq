'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isIP } = require('node:net');

const execFileAsync = promisify(execFile);
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_RENDER_STAGES = 300;

function fail(message) {
  const error = new Error(message);
  error.forUser = true;
  return error;
}

function parseTime(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  if (/^\d+(?:\.\d+)?$/.test(input)) return Number(input);

  const parts = input.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d{1,2}(?:\.\d+)?$/.test(parts[1])) {
    const seconds = Number(parts[1]);
    if (seconds >= 60) throw fail('Seconds in a timestamp must be less than 60.');
    return Number(parts[0]) * 60 + seconds;
  }
  if (parts.length === 3 && parts.every(part => /^\d+(?:\.\d+)?$/.test(part))) {
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    const seconds = Number(parts[2]);
    if (minutes >= 60 || seconds >= 60) throw fail('Minutes and seconds in a timestamp must be less than 60.');
    return hours * 3600 + minutes * 60 + seconds;
  }
  throw fail(`Invalid timestamp: ${input}`);
}

function parseOptions(input) {
  const fields = String(input).split('|').map(field => field.trim());
  const isManual = /^(text|lyrics|manual)$/i.test(fields[0] || '');
  const durationValue = fields[3] ? Number(fields[3]) : 60;
  if (!Number.isFinite(durationValue) || durationValue < 5 || durationValue > 60) {
    throw fail('Clip duration must be between 5 and 60 seconds.');
  }

  const colorValue = (fields[4] || '').toLowerCase();
  const color = colorValue || 'white';
  if (!['white', 'green'].includes(color)) {
    throw fail('Background must be white or green.');
  }

  if (isManual) {
    const text = (fields[1] || '').trim();
    if (!text) throw fail('Add your lyrics after “text |”.');
    if (text.length > 3000) throw fail('Manual lyrics are limited to 3,000 characters.');
    return {
      manual: true,
      text,
      start: fields[2] ? parseTime(fields[2]) : 0,
      duration: durationValue,
      color
    };
  }

  const query = fields[0];
  if (!query) throw fail('Enter a song title.');
  return {
    manual: false,
    query,
    artist: fields[1] || '',
    start: fields[2] ? parseTime(fields[2]) : null,
    duration: durationValue,
    color
  };
}

function parseLrc(lrc) {
  if (typeof lrc !== 'string') return [];
  const cues = [];
  for (const line of lrc.split(/\r?\n/)) {
    const matches = [...line.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = line.replace(/\[[^\]]+\]/g, '').trim();
    if (!text) continue;

    for (const match of matches) {
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
      const time = Number(match[1]) * 60 + Number(match[2]) + fraction;
      cues.push({ time, text });
    }
  }
  return cues.sort((a, b) => a.time - b.time);
}

function manualCues(text, duration) {
  const source = String(text || '').trim();
  const timestamped = parseLrc(source);
  if (timestamped.length) return timestamped;
  if (/\[\d+:\d{2}/.test(source)) {
    throw fail('Could not read the lyric timestamps. Use [00:00.00]lyric format.');
  }

  const lines = source.split(/\s*\/\s*|\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw fail('Add at least one lyric line.');
  const spacing = duration / lines.length;
  return lines.map((line, index) => ({ time: index * spacing, text: line }));
}

function clipCues(cues, start, duration) {
  const end = start + duration;
  const sorted = [...(cues || [])]
    .filter(cue => Number.isFinite(cue.time) && cue.time >= 0 && cue.text?.trim())
    .sort((a, b) => a.time - b.time);

  let previous = null;
  for (const cue of sorted) {
    if (cue.time <= start) previous = cue;
    else break;
  }

  const result = [];
  if (previous) result.push({ time: 0, text: previous.text.trim() });
  for (const cue of sorted) {
    if (cue.time > start && cue.time < end) {
      result.push({ time: cue.time - start, text: cue.text.trim() });
    }
  }

  return result.filter((cue, index) => index === 0
    || cue.time !== result[index - 1].time
    || cue.text !== result[index - 1].text);
}

function attachment(event) {
  const allAttachments = [
    ...(event?.messageReply?.attachments || []),
    ...(event?.attachments || [])
  ];
  const item = allAttachments.find(candidate =>
    ['audio', 'video'].includes(candidate.type) && typeof candidate.url === 'string'
  );
  return item?.url || null;
}

function assertHttpUrl(value, facebookAttachment = false) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw fail('The audio URL is invalid.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw fail('Only public HTTP(S) media URLs are supported.');
  }

  const host = url.hostname.toLowerCase();
  if (
    !host
    || host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || isIP(host)
  ) {
    throw fail('The audio URL must use a public hostname.');
  }

  if (facebookAttachment) {
    const allowed = ['fbcdn.net', 'facebook.com', 'messenger.com']
      .some(domain => host === domain || host.endsWith(`.${domain}`));
    if (!allowed) throw fail('Reply to an audio or video uploaded in this chat.');
  }
  return url;
}

async function downloadResponse(response, outputPath, maxBytes = MAX_AUDIO_BYTES) {
  if (!response.ok || !response.body) {
    throw new Error(`Media download failed (HTTP ${response.status}).`);
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw fail('The audio file is too large (100 MB maximum).');

  let bytes = 0;
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(fail('The audio file is too large (100 MB maximum).'));
      else callback(null, chunk);
    }
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      limit,
      require('node:fs').createWriteStream(outputPath)
    );
  } catch (error) {
    await fs.unlink(outputPath).catch(() => {});
    throw error;
  }
  return outputPath;
}

async function downloadAttachment(url, directory) {
  assertHttpUrl(url, true);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60000),
    headers: { 'User-Agent': 'GoatBot brat lyric video' },
    redirect: 'follow'
  });
  assertHttpUrl(response.url || url, true);
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !/audio|video|octet-stream/i.test(contentType)) {
    throw fail('The reply attachment does not appear to be audio or video.');
  }
  return downloadResponse(response, path.join(directory, 'attachment-media'), MAX_AUDIO_BYTES);
}

async function downloadMusic(videoUrl, outputPath, settings = {}) {
  const apiFactory = global.utils?.STBotApis;
  if (!apiFactory) throw new Error('The GoatBot music downloader is not available.');

  const apiBase = new apiFactory().baseURL;
  if (typeof apiBase !== 'string' || !/^https?:\/\//i.test(apiBase)) {
    throw new Error('The music downloader URL is invalid.');
  }
  const endpoint = `${apiBase.replace(/\/+$/, '')}/st/ytviddl`;
  const axios = require('axios');

  const formatsResponse = await axios.post(endpoint, { url: videoUrl }, {
    timeout: settings.apiTimeoutMs || 45000
  });
  const formats = Array.isArray(formatsResponse.data?.formats)
    ? formatsResponse.data.formats
    : [];
  const selected = formats.find(format => String(format.ext).toLowerCase() === 'mp3')
    || formats.find(format => String(format.type).toLowerCase() === 'audio');
  if (!selected?.url) throw new Error('The music downloader did not provide an audio format.');

  const downloadResponse = await axios.post(endpoint, {
    url: videoUrl,
    formatUrl: selected.url
  }, {
    timeout: settings.apiTimeoutMs || 45000
  });
  const downloadUrl = downloadResponse.data?.downloadUrl;
  if (!downloadUrl) throw new Error('The music downloader did not return an audio URL.');
  assertHttpUrl(downloadUrl);

  const audioResponse = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
    timeout: settings.downloadTimeoutMs || 90000,
    maxContentLength: MAX_AUDIO_BYTES,
    maxBodyLength: MAX_AUDIO_BYTES
  });
  const audioBuffer = Buffer.from(audioResponse.data);
  if (!audioBuffer.length) throw new Error('The downloader returned an empty audio file.');
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw fail('The audio file is too large (100 MB maximum).');
  }
  await fs.writeFile(outputPath, audioBuffer);
  return outputPath;
}

async function firstResult(query, artist = '') {
  let yts;
  try {
    yts = require('yt-search');
  } catch (_) {
    throw new Error('The yt-search package is missing. Install the dependencies listed in package.json.');
  }

  const search = await yts([query, artist].filter(Boolean).join(' '));
  const video = search?.videos?.find(result => result?.url && result?.seconds > 0);
  if (!video) throw fail('No playable YouTube result was found for that song.');
  return {
    url: video.url,
    videoTitle: video.title || query,
    artistName: video.author?.name || artist || '',
    seconds: Number(video.seconds) || 0
  };
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(official|video|audio|lyrics|lyric|visualizer|hd|4k)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function similarity(left, right) {
  const a = new Set(normalize(left).split(/\s+/).filter(Boolean));
  const b = new Set(normalize(right).split(/\s+/).filter(Boolean));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap++;
  return overlap / Math.max(a.size, b.size);
}

async function syncLyrics(item, audioLength) {
  const params = new URLSearchParams({
    track_name: item.videoTitle,
    artist_name: item.artistName || '',
    duration: String(Math.round(audioLength))
  });
  const response = await fetch(`https://lrclib.net/api/search?${params}`, {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'GoatBot brat lyric video' }
  });
  if (!response.ok) throw new Error(`LRCLIB returned HTTP ${response.status}.`);

  const results = await response.json();
  if (!Array.isArray(results)) throw fail('LRCLIB returned an unexpected lyrics response.');
  const matches = results
    .filter(result => result?.syncedLyrics && parseLrc(result.syncedLyrics).length)
    .map(result => {
      const titleScore = similarity(item.videoTitle, result.trackName);
      const artistScore = item.artistName ? similarity(item.artistName, result.artistName) : 0.5;
      const duration = Number(result.duration) || 0;
      const durationScore = duration ? Math.max(0, 1 - Math.abs(duration - audioLength) / 90) : 0;
      return { result, score: titleScore * 0.65 + artistScore * 0.2 + durationScore * 0.15 };
    })
    .sort((a, b) => b.score - a.score);

  if (!matches.length) {
    throw fail('Timed lyrics were not found for that song. Reply to an audio/video with your own lyrics instead.');
  }
  return { lyrics: matches[0].result, shift: 0, how: 'lrclib' };
}

async function runTool(binary, args, timeout = 900000) {
  try {
    return await execFileAsync(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const output = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
    throw new Error(output.slice(-2000) || 'Media tool failed.');
  }
}

async function ensureTools(settings = {}) {
  const ffmpeg = settings.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = settings.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
  await runTool(ffmpeg, ['-version'], 20000);
  await runTool(ffprobe, ['-version'], 20000);

  let font = settings.fontPath || '';
  if (font) {
    await fs.access(font);
  } else {
    try {
      const result = await runTool('fc-match', ['-f', '%{file}', 'DejaVu Sans:style=Bold'], 10000);
      font = result.stdout.trim();
      await fs.access(font);
    } catch (_) {
      const candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf'
      ];
      for (const candidate of candidates) {
        try {
          await fs.access(candidate);
          font = candidate;
          break;
        } catch (_) {
          // Try the next common font path.
        }
      }
    }
  }
  if (!font) throw new Error('No usable font found for lyric video rendering.');
  return { ffmpeg, ffprobe, font };
}

async function mediaDuration(ffprobe, filePath) {
  const result = await runTool(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ], 30000);
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not determine audio duration.');
  return duration;
}

function wrapText(text, maxCharacters = 22) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxCharacters) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [' '];
}

function escapeFilterPath(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/'/g, "\\'");
}

async function render({ dir, audio, cues, start, duration, color, ffmpeg, font }) {
  if (!Array.isArray(cues) || !cues.length) throw fail('No lyrics are available for this clip.');
  const background = color === 'green' ? '0x89E45D' : 'white';
  const sorted = [...cues].sort((a, b) => a.time - b.time);
  const stages = [];
  const stageBudget = Math.max(1, Math.floor(MAX_RENDER_STAGES / sorted.length));

  for (let index = 0; index < sorted.length; index++) {
    const cue = sorted[index];
    const cueStart = Math.max(0, cue.time);
    const cueEnd = Math.min(duration, sorted[index + 1]?.time ?? duration);
    if (cueStart >= duration || cueEnd <= cueStart) continue;

    const characters = [...wrapText(cue.text).join('\n')];
    const typingWindow = Math.min(cueEnd - cueStart, Math.max(0.15, characters.length / 12));
    const updateCount = Math.max(1, Math.min(
      characters.length,
      stageBudget,
      Math.floor(typingWindow / 0.12) || 1
    ));
    const charsPerUpdate = Math.ceil(characters.length / updateCount);

    for (let update = 1; update <= updateCount; update++) {
      const prefixLength = update === updateCount
        ? characters.length
        : Math.min(characters.length, update * charsPerUpdate);
      const from = cueStart + typingWindow * (update - 1) / updateCount;
      const to = update === updateCount
        ? cueEnd
        : cueStart + typingWindow * update / updateCount;
      stages.push({
        text: characters.slice(0, prefixLength).join(''),
        from,
        to
      });
    }
  }

  if (!stages.length) throw fail('No lyrics fall within the selected clip.');
  const filters = [];
  let previous = '[0:v]';
  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index];
    const textPath = path.join(dir, `lyric_${index}.txt`);
    await fs.writeFile(textPath, stage.text, 'utf8');
    const next = `[v${index}]`;
    const drawtext = [
      `fontfile=${escapeFilterPath(font)}`,
      `textfile=${escapeFilterPath(textPath)}`,
      'fontcolor=black',
      'fontsize=52',
      'line_spacing=14',
      'x=(w-text_w)/2',
      'y=(h-text_h)/2',
      'expansion=none',
      `enable='between(t,${stage.from.toFixed(3)},${stage.to.toFixed(3)})'`
    ].join(':');
    filters.push(`${previous}drawtext=${drawtext}${next}`);
    previous = next;
  }
  filters.push(`${previous}format=yuv420p[vout]`);

  const outputPath = path.join(dir, 'brat-lyrics.mp4');
  await runTool(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${background}:s=720x720:r=24:d=${duration.toFixed(3)}`,
    '-ss', String(start),
    '-i', audio,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '1:a:0',
    '-t', String(duration),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '25',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  ]);
  return outputPath;
}

module.exports = {
  fail,
  parseOptions,
  parseLrc,
  manualCues,
  clipCues,
  attachment,
  firstResult,
  downloadAttachment,
  downloadMusic,
  syncLyrics,
  ensureTools,
  mediaDuration,
  render
};
