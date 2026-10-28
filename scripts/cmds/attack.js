'use strict';

const runningThreads = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isBotAdmin(senderID) {
  const adminList = global.GoatBot?.config?.adminBot || [];
  return adminList.some(id => String(id) === String(senderID));
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
    version: '1.1.0',
    author: 'Siegfried Samá',
    countDown: 5,
    role: 2,
    category: 'admin',
    description: { en: '' },
    guide: { en: '{pn} attack' }
  },

  onStart: async function ({ api, event, args }) {
    const { threadID, senderID, isGroup } = event;
    if (!threadID || !senderID || isGroup !== true) return;
    if (!isBotAdmin(senderID)) return;
    if (runningThreads.has(String(threadID))) return;

    let threadInfo;
    try {
      threadInfo = await api.getThreadInfo(threadID);
    } catch (_) {
      return;
    }

    const nickname = (args || []).join(' ').trim() || 'GOD NYO SI SIEG 🥷🏿';
    const participants = getParticipants(threadInfo);
    if (!participants.length) return;

    runningThreads.add(String(threadID));
    try {
      await setGroupTitle(api, threadID, nickname);

      for (const userID of participants) {
        try {
          await api.changeNickname(nickname, threadID, userID);
        } catch (_) {}
        await sleep(120);
      }
    } finally {
      runningThreads.delete(String(threadID));
    }
  }
};
