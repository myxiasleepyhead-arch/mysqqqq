const GOD_UID = "100070646281323";
const REACTION = "☺️";

function isGod(senderID) {
  return String(senderID || "") === GOD_UID;
}

function react(api, messageID) {
  if (!messageID || typeof api.setMessageReaction !== "function") return;
  try {
    api.setMessageReaction(REACTION, messageID, () => {}, true);
  } catch (_) {
    // Reactions are best-effort because Facebook may reject bot-authored reactions.
  }
}

module.exports = {
  config: {
    name: "autoreact",
    version: "2.0.0",
    author: "Siegfried Samá",
    countDown: 0,
    role: 0,
    description: { en: "Automatically react with 😆 to Siegfried's messages only" },
    category: "owner",
    guide: { en: "Automatic; no command needed" }
  },

  onStart: async function () {},

  onChat: async function ({ api, event }) {
    const senderID = String(event.senderID || "");

    if (!isGod(senderID)) return;

    react(api, event.messageID);
  }
};
