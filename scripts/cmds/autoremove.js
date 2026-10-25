const pendingRemovals = new Map();

const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;
const REMOVE_INTERVAL_MS = 700;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAdmin(adminIDs, userID) {
  return adminIDs.some(admin => String(admin?.id ?? admin) === String(userID));
}

function isFacebookUser(user) {
  return String(user?.name || "").trim().toLowerCase() === "facebook user";
}

function getCandidates(threadInfo, botID) {
  const adminIDs = threadInfo.adminIDs || [];
  return (threadInfo.userInfo || [])
    .filter(user =>
      user?.id
      && isFacebookUser(user)
      && String(user.id) !== String(botID)
      && !isAdmin(adminIDs, user.id)
    )
    .map(user => ({
      id: String(user.id),
      name: user.name
    }));
}

function pendingKey(threadID, senderID) {
  return `${threadID}:${senderID}`;
}

function formatCandidateList(candidates) {
  const visible = candidates.slice(0, 30).map((user, index) => `${index + 1}. ${user.name} (${user.id})`);
  if (candidates.length > visible.length) {
    visible.push(`... at ${candidates.length - visible.length} pa`);
  }
  return visible.join("\n");
}

async function removeCandidates(api, threadID, candidates) {
  const removed = [];
  const failed = [];

  for (const candidate of candidates) {
    try {
      await api.removeUserFromGroup(candidate.id, threadID);
      removed.push(candidate);
    } catch (err) {
      failed.push({
        ...candidate,
        error: err.message || "unknown error"
      });
    }
    await wait(REMOVE_INTERVAL_MS);
  }

  return { removed, failed };
}

module.exports = {
  config: {
    name: "autoremove",
    version: "1.0.0",
    author: "Siegfried Samá",
    countDown: 5,
    role: 1,
    shortDescription: "Hanapin ang Facebook User accounts sa group",
    longDescription: "Magpapakita muna ng preview ng exact Facebook User accounts bago sila alisin.",
    category: "group",
    guide: {
      en: "{pn} — preview ng exact Facebook User accounts\n{pn} confirm — alisin ang preview candidates"
    }
  },

  onStart: async function ({ api, event, args, message }) {
    const { threadID, senderID } = event;
    const botID = api.getCurrentUserID();

    let threadInfo;
    try {
      threadInfo = await api.getThreadInfo(threadID);
    } catch (err) {
      return message.reply("hindi makuha ang group member list ngayon. Subukan ulit mamaya.");
    }

    const adminIDs = threadInfo.adminIDs || [];
    if (!isAdmin(adminIDs, botID)) {
      return message.reply("kailangan munang gawing group admin ang bot bago gamitin ang command na ito.");
    }

    const key = pendingKey(threadID, senderID);
    if (String(args[0] || "").toLowerCase() === "confirm") {
      const pending = pendingRemovals.get(key);
      if (!pending || pending.expiresAt < Date.now()) {
        pendingRemovals.delete(key);
        return message.reply("wala nang pending preview. Gamitin muna ang `/autoremove`.");
      }

      const currentCandidates = getCandidates(threadInfo, botID)
        .filter(candidate => pending.ids.includes(candidate.id));
      pendingRemovals.delete(key);

      if (currentCandidates.length === 0) {
        return message.reply("ubos na");
      }

      const { removed, failed } = await removeCandidates(api, threadID, currentCandidates);
      let result = `na remove: ${removed.length}`;
      if (failed.length > 0) {
        result += `\nhindi naremove: ${failed.length}\n${failed.map(user => `• ${user.name} (${user.id})`).join("\n")}`;
      }
      return message.reply(result);
    }

    const candidates = getCandidates(threadInfo, botID);
    if (candidates.length === 0) {
      return message.reply("walang exact na `Facebook User` account na nakita sa group.");
    }

    pendingRemovals.set(key, {
      ids: candidates.map(candidate => candidate.id),
      expiresAt: Date.now() + CONFIRMATION_TIMEOUT_MS
    });

    return message.reply(
      `nakita ko ang ${candidates.length} exact na \`Facebook User\` candidate(s):\n`
      + `${formatCandidateList(candidates)}\n\n`
      + "kung tama boss ang listahan, icommand moko sipain ko sila lahat dito sa gc mo"
    );
  }
};
