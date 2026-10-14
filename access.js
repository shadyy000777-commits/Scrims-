// Who may use the scrims bot's admin features.
// Manage Server, OR any Discord user ID listed in the ALLOWED_USER_IDS
// environment variable (comma-separated, set in Railway -> Variables).
const { PermissionFlagsBits } = require('discord.js');

function envAllowedIds() {
  return [...new Set((process.env.ALLOWED_USER_IDS || '').match(/\d{15,25}/g) || [])];
}

function isAllowedUser(userId) {
  return envAllowedIds().includes(String(userId));
}

function canManageServer(member) {
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.ManageGuild) || isAllowedUser(member.id);
}

module.exports = { envAllowedIds, isAllowedUser, canManageServer };
