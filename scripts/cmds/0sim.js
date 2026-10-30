const axios = require("axios");

module.exports = {
  config: {
    name: "quantom",
    version: "1.0.0",
    author: "Siegfried Samá",
    countDown: 3,
    role: 0,
    description: { en: "Chat with SimSimi" },
    category: "fun",
    guide: { en: "{pn} <message>" }
  },

  onStart: async function ({ message, args, event }) {
    const query = args.join(" ").trim();
    const prefix = global.GoatBot.config.prefix;

    if (!query) {
      return message.reply(
        "Invalid use of command\n\nExample:\n" + prefix + "sim kamusta ka?"
      );
    }

    try {
      const res = await axios.get("https://urangkapolka.vercel.app/api/simsimi", {
        params: { query }
      });

      const reply = res.data?.result?.reply;
      if (!reply) return message.reply("Error please try again later.");

      return message.reply(reply);
    } catch (err) {
      return message.reply("May error sa SimSimi API. Subukan ulit mamaya.");
    }
  }
};
