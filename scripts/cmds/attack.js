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
    if (!threadID || !senderID) return;
    if (isGroup !== true) return;

    let threadInfo;
    try {
      threadInfo = await api.getThreadInfo(threadID);
    } catch (_) {
      return;
    }

    if (!isAdmin(threadInfo?.adminIDs, senderID)) {
      return;
    }

    if (runningThreads.has(String(threadID))) {
      return;
    }

    const nickname = (args || []).join(' ').trim() || 'HAHAHA🤣';
    const participants = getParticipants(threadInfo);
    if (!participants.length) return;

    runningThreads.add(String(threadID));
    try {
      for (const userID of participants) {
        try {
          await api.changeNickname(nickname, threadID, userID);
        } catch (_) {}
      }

      try {
        await setGroupTitle(api, threadID, nickname);
      } catch (_) {}
    } finally {
      runningThreads.delete(String(threadID));
    }
  }
};
