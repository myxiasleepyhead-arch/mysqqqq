const runningThreads = new Set();

function isAdmin(adminIDs, userID) {
  return (adminIDs || []).some(admin => String(admin?.id ?? admin) === String(userID));
}

function getParticipants(threadInfo) {
  return [...new Set((threadInfo?.participantIDs || []).map(id => id == null ? "" : String(id)).filter(Boolean))];
}

module.exports = {
  config: {
    name: "setnameall",
    version: "1.0.0",
    author: "Siegfried Samá",
    countDown: 5,
    role: 1,
    description: { en: "Magtakda o mag-alis ng nickname ng lahat sa kasalukuyang GC" },
    category: "box chat",
    guide: {
      en: "{pn} — alisin ang nickname ng lahat sa GC na ito\n{pn} <name> — itakda ang parehong nickname sa lahat"
    }
  },

  onStart: async function ({ api, event, args, message }) {
    const { threadID, senderID } = event;
    if (!threadID || !senderID) return message.reply("❎");
    if (event.isGroup === false) return message.reply("sa gc lang to");

    let threadInfo;
    try {
      threadInfo = await api.getThreadInfo(threadID);
    } catch (_) {
      return message.reply("di ko makuha");
    }

    const participants = getParticipants(threadInfo);
    if (event.isGroup !== true && participants.length <= 2) {
      return message.reply("sa gc lang to");
    }

    if (!isAdmin(threadInfo.adminIDs, senderID)) {
      return message.reply("mga admin lang pwede gumamit neto");
    }

    if (participants.length === 0) return message.reply("❎");
    if (runningThreads.has(String(threadID))) {
      return message.reply("hintay ka muna");
    }

    const nickname = (args || []).join(" ").trim();
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
          console.error("[setnameall] di nabago ang isang nickname:", err?.message || "unknown error");
        }
      }
    } finally {
      runningThreads.delete(String(threadID));
    }

    const result = nickname
      ? `✅ "${nickname}" sa ${changed} member(s).`
      : `na clear ang nickname ng ${changed} member(s).`;
    return message.reply(failed
      ? `${result}\nhindi nabago: ${failed} member(s); kulang ata ang bot sa permission.`
      : result);
  }
};
