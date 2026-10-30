'use strict';

const axios = require('axios');

function getOpenAIConfig() {
  const cfg = (global.GoatBot && global.GoatBot.config && global.GoatBot.config.openai)
    || (global.config && global.config.openai)
    || {};

  return {
    apiKey: cfg.apiKey || process.env.OPENAI_API_KEY || '',
    model: cfg.model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: Number(cfg.temperature ?? 0.7),
    maxTokens: Number(cfg.maxTokens ?? 800)
  };
}

module.exports = {
  config: {
    name: 'ai',
    aliases: ['gpt', 'chatgpt', 'openai'],
    version: '1.0.0',
    author: 'Copilot',
    countDown: 5,
    role: 0,
    category: 'tools',
    description: {
      en: 'Ask OpenAI from the bot'
    },
    guide: {
      en: '{pn} ai <your question>'
    }
  },

  onStart: async function ({ api, event, args, message }) {
    const question = (args || []).join(' ').trim();

    if (!question) {
      return message ? message.reply('Use: ai <your question>') : api.sendMessage('Use: ai <your question>', event.threadID, event.messageID);
    }

    const openaiConfig = getOpenAIConfig();
    if (!openaiConfig.apiKey) {
      return message
        ? message.reply('OpenAI API key is missing. Put it in config.json under openai.apiKey or set OPENAI_API_KEY in the environment.')
        : api.sendMessage('OpenAI API key is missing. Put it in config.json under openai.apiKey or set OPENAI_API_KEY in the environment.', event.threadID, event.messageID);
    }

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: openaiConfig.model,
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: question }
          ],
          temperature: openaiConfig.temperature,
          max_tokens: openaiConfig.maxTokens
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openaiConfig.apiKey}`
          },
          timeout: 60000
        }
      );

      const answer = response?.data?.choices?.[0]?.message?.content || 'No answer returned.';
      return api.sendMessage(String(answer).trim(), event.threadID, event.messageID);
    } catch (error) {
      const msg = error?.response?.data?.error?.message || error?.message || 'Unknown OpenAI error';
      return api.sendMessage(`❌ OpenAI error: ${msg}`, event.threadID, event.messageID);
    }
  }
};

module.exports.run = module.exports.onStart;
