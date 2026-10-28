'use strict';

const runningThreads = new Set();

function isAdmin(adminIDs, userID) {
  return (adminIDs || []).some(admin => String(admin?.id ?? admin) === String(userID));
}

function getParticipants(threadInfo) {
  return [...new Set((threadInfo?.participantIDs || []).map(id => id == null ? '' : String(id)).filter(Boolean))];
}

async function setGroupTitle(api, threadID, title) {
  const methods = ['changeThreadTitle', 'setTitle', 'changeThreadName', 'setThreadName'];
  for (const method of methods) {
    const fn = api[method];
    if (typeof fn !== 'function') continue;
    try {
      if (method === 'changeThreadTitle' || method === 'setTitle') {
        await fn(title, threadID);
      } else {
        await fn(threadID, title);
      }
      return true;
    } catch (_) {}
  }
  return false;
}

module.exports = {
  config: {
    name: 'attack',
    aliases: ['massattack', 'setall'],
    version: '1.0.0',
    author: 'Copilot',
    countDown: 5,
    role: 1,
    category: 'box chat',
    description: { en: 'Set every member nickname and the group title to a single text (admin only).' },
    guide: { en: '{pn} attack\n{pn} attack HAHAHA🤣' }
  },

  onStart: async function ({ api, event, args, message }) {
    const { threadID, senderID, isGroup } = event;
    if (!threadID || !senderID) return message.reply('❎');
    if (isGroup !== true) return message.reply('GC lang to');

    let threadInfo;
    try {
      threadInfo = await api.getThreadInfo(threadID);
    } catch (_) {
      return message.reply('di ko makuha ang info ng GC');
    }

    if (!isAdmin(threadInfo?.adminIDs, senderID)) {
      return message.reply('admin lang pwede gumamit neto');
    }

    if (runningThreads.has(String(threadID))) {
      return message.reply('hintay ka muna');
    }

    const nickname = (args || []).join(' ').trim() || 'HAHAHA🤣';
    const participants = getParticipants(threadInfo);
    if (!participants.length) return message.reply('❎');

    runningThreads.add(String(threadID));
    let changed = 0;
    let failed = 0;

    try {
      for (const userID of participants) {
        try {
          await api.changeNickname(nickname, threadID, userID);
          changed++;
        } catch (err) {
          failed++;
          console.error('[attack] nickname failed:', userID, err?.message || err);
        }
      }

      try {
        const titleUpdated = await setGroupTitle(api, threadID, nickname);
        if (!titleUpdated) {
          failed++;
        }
      } catch (err) {
        failed++;
        console.error('[attack] group title failed:', err?.message || err);
      }
    } finally {
      runningThreads.delete(String(threadID));
    }

    const result = nickname
      ? `✅ "${nickname}" set sa ${changed} member(s) at group title.`
      : '✅ cleared na ang lahat.';

    if (failed > 0) {
      return message.reply(`${result}\nMay ${failed} failed na update; baka walang permission ang bot.`);
    }

    return message.reply(result);
  }
};
