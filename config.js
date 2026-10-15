// Fixed channel / role IDs for the bot.
// Paste the IDs between the quotes (leave '' to keep using whatever is saved
// in the admin panel). Each one can also be set from Railway -> Variables
// using the env var name shown next to it — the env var wins if both are set.
//
// These are applied on top of the per-server settings, and the admin panel
// shows "xxxxxx" for them instead of the real channel/role.
const ID_CONFIG = {
  verifyLogChannelId:              process.env.VERIFY_CHANNEL_ID           || '1559852773393305721',
  verifiedRoleId:                  process.env.VERIFY_ROLE_ID              || '1540233633598541905',
  registrationLogChannelId:        process.env.REGISTER_CHANNEL_ID         || '1559976369629175949',
  registeredRoleId:                process.env.REGISTER_ROLE_ID            || '1559856608375472199',
  requiredVerifyRoleId:            process.env.REQUIRED_VERIFY_ROLE_ID     || '1559992705499791440',
  privateVerifyLogChannelId:       process.env.PRIVATE_VERIFY_CHANNEL_ID   || '1559847938358779904',
  privateRegistrationLogChannelId: process.env.PRIVATE_REGISTER_CHANNEL_ID || '1559913082879475782',
};

// Copies every non-empty ID above into a guild's settings object.
function applyIdConfig(settings) {
  for (const [key, id] of Object.entries(ID_CONFIG)) {
    const clean = String(id || '').trim();
    if (clean) settings[key] = clean;
  }
  return settings;
}

module.exports = { ID_CONFIG, applyIdConfig };
