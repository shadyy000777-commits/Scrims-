const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');

// /ai stop  -> the AI is completely off: tagging the bot (or replying to it)
//              gets no answer at all.
// /ai start -> turns it back on.
// The switch is saved per server (settings.aiStopped), so it survives
// restarts and redeploys. index.js checks it before doing anything AI-related.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription("Control the bot's AI chat")
    .addSubcommand(sub =>
      sub.setName('stop').setDescription("Turn the AI completely off — it won't answer anyone who tags it"))
    .addSubcommand(sub =>
      sub.setName('start').setDescription('Turn the AI back on'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const store = getGuildStore(interaction.guildId);
    if (!store.settings) store.settings = {};

    if (sub === 'stop') {
      store.settings.aiStopped = true;
      saveGuildStore(interaction.guildId, store);
      return interaction.reply({
        content: '🔇 AI is now **OFF**. It will not answer anyone who tags it. Use `/ai start` to turn it back on.',
        flags: MessageFlags.Ephemeral,
      });
    }

    store.settings.aiStopped = false;
    saveGuildStore(interaction.guildId, store);
    return interaction.reply({
      content: '🔊 AI is now **ON** again.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
