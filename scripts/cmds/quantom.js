'use strict';

const adminState = new Map();

function getAdminList() {
  const list = global.GoatBot?.config?.adminBot || global.config?.adminBot || [];
  return Array.isArray(list) ? list.map(String) : [];
}

function isAdmin(senderID) {
  return getAdminList().includes(String(senderID));
}

function getFlowKey(event) {
  return `${event?.threadID || '0'}:${event?.senderID || '0'}`;
}

function reactToMessage(api, event) {
  try {
    const p = api?.setMessageReaction?.('🥷🏿', event?.messageID, () => {}, true);
    if (p?.catch) p.catch(() => {});
  } catch (_) {}
}

function pickReplyText(body) {
  const text = String(body || '').trim().toLowerCase();
  if (/\bmeron\b/i.test(text)) return 'meron';
  if (/\bwala\b/i.test(text)) return 'wala';
  return null;
}

function shouldTriggerQuantom(body) {
  return typeof body === 'string' && /\bquantom\b/i.test(body);
}

function registerQuestion(api, threadID, senderID, questionID) {
  if (!global.GoatBot?.onReply) return;
  global.GoatBot.onReply.set(String(questionID), {
    commandName: 'quantom',
    author: String(senderID),
    messageID: String(questionID),
    threadID: String(threadID)
  });
}

module.exports = {
  config: {
    name: 'kuwantom',
    aliases: ['qntm'],
    version: '1.1.0',
    author: 'Siegfried Samá',
    countDown: 0,
    role: 0,
    category: 'fun',
    description: { en: 'Admin keyword-triggered quantom flow' },
    guide: { en: '{pn} quantom' }
  },

  onChat: async function ({ api, event }) {
    if (!event || !event.body || !shouldTriggerQuantom(event.body)) return;

    reactToMessage(api, event);

    if (!isAdmin(event.senderID)) return;

    const key = getFlowKey(event);
    const state = adminState.get(key) || { step: 0, questionMessageID: null };

    if (state.step === 0) {
      adminState.set(key, { step: 1, questionMessageID: event.messageID });
      const info = await api.sendMessage('yohooo', event.threadID, event.messageID);
      if (info?.messageID) registerQuestion(api, event.threadID, event.senderID, info.messageID);
      return;
    }

    adminState.set(key, { step: 2, questionMessageID: event.messageID });
    const info = await api.sendMessage('may kukulatain ba ako boss?', event.threadID, event.messageID);
    if (info?.messageID) registerQuestion(api, event.threadID, event.senderID, info.messageID);
  },

  onReply: async function ({ api, event, Reply }) {
    if (!event || !event.body || !Reply || String(Reply.commandName || '') !== 'quantom') return;
    if (String(event.senderID) !== String(Reply.author)) return;

    const rawBody = event.body || '';
    const answer = pickReplyText(rawBody);
    if (!answer) return;

    const key = getFlowKey(event);
    adminState.delete(key);

    if (global.GoatBot?.onReply) {
      global.GoatBot.onReply.delete(String(Reply.messageID));
    }

    if (answer === 'meron') {
      return api.sendMessage('sige boss, command mo lang ako wlang tulugan kami', event.threadID, event.messageID);
    }

    if (answer === 'wala') {
      return api.sendMessage('pasabi lang kong may kukulatain', event.threadID, event.messageID);
    }
  },

  onStart: async function ({ api, event, args }) {
    const body = (args || []).join(' ').trim();
    if (!body || !shouldTriggerQuantom(body)) return;

    reactToMessage(api, event);

    if (!isAdmin(event.senderID)) return;

    const key = getFlowKey(event);
    const state = adminState.get(key) || { step: 0, questionMessageID: null };

    if (state.step === 0) {
      adminState.set(key, { step: 1, questionMessageID: event.messageID });
      const info = await api.sendMessage('yohooo', event.threadID, event.messageID);
      if (info?.messageID) registerQuestion(api, event.threadID, event.senderID, info.messageID);
      return;
    }

    adminState.set(key, { step: 2, questionMessageID: event.messageID });
    const info = await api.sendMessage('may kukulatain ba ako boss?', event.threadID, event.messageID);
    if (info?.messageID) registerQuestion(api, event.threadID, event.senderID, info.messageID);
  }
};
