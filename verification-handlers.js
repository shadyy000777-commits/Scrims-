const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  UserSelectMenuBuilder,
} = require('discord.js');
const { getGuildStore, saveGuildStore } = require('./storage');
const { startPending, getPending, updatePending, clearPending } = require('./pending-verifications');
const { buildVerifyStep1Modal, buildVerifyStep2Modal, buildVerifyStep3Modal } = require('./verification-modals');
const { resolveLogChannel, getOrCreatePrivateVerifyChannel } = require('./log-channel');
const { notifySlotOpened } = require('./slot-reminders');
const { checkPlayerUids, applyCorrections, reviewChecks } = require('./bgmi-lookup');
const { refreshLivePanel, refreshGroupSlotList } = require('./live-panel-handlers');

const WHATSAPP_RE = /^[0-9]{10}$/; // exactly 10 digits
const UID_RE = /^[0-9]{5,12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// "IGN - UID" — captures everything up to the last " - " as the name, and
// requires the trailing part to look like a UID (digits only).
const P5_COMBINED_RE = /^(.+?)\s*-\s*([0-9]{5,12})$/;

const RESTART_HINT = 'Click **Verify** again to restart — no partial data is saved.';

function continueRow(customId, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary)
  );
}

// Discord doesn't let a bot write custom error text inside a modal itself —
// the closest real equivalent: keep whatever they already typed, show the
// error as a normal reply, and give them a button that reopens the SAME
// modal pre-filled with their last attempt, so they only need to fix the
// one wrong field instead of retyping everything.
function retryRow(customId, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(ButtonStyle.Danger)
  );
}

// Mandatory picker shown after all 5 players' details are entered: the team
// owner picks 4 real Discord members from the server (Discord's native
// member picker — search, avatars, the works) as the confirmed playing
// lineup. These are the accounts that get @mentioned in the verification
// log post. This is separate from the 5 typed IGN/UID entries above, since
// a typed IGN doesn't necessarily map to a specific Discord account.
function buildPlayerSelectRow() {
  const menu = new UserSelectMenuBuilder()
    .setCustomId('verify_select_players')
    .setPlaceholder('Select the 4 players who will play')
    .setMinValues(4)
    .setMaxValues(4);

  return new ActionRowBuilder().addComponents(menu);
}

// `store` is optional (only needed to look up a custom confirmation
// message set via the admin panel — see admin-panel-handlers.js) so every
// existing call site that doesn't have one handy keeps working unchanged.
function buildVerifiedEmbed(data, isEdit, store) {
  const playerFields = [1, 2, 3, 4, 5]
    .filter(n => n < 5 || data.p5_ign) // Player 5 is optional — omit the field entirely if not filled in
    .map(n => {
      const key = `p${n}`;
      return { name: `Player ${n}`, value: `${data[`${key}_ign`]} (${data[`${key}_uid`]})` };
    });

  const lineupLine = (data.selectedPlayerIds || []).map(id => `<@${id}>`).join(' ') || '_not selected_';

  const embed = new EmbedBuilder()
    .setTitle(isEdit ? `✏️ ${data.team_name} — Details Updated` : `✅ ${data.team_name} — Verified`)
    .setColor(isEdit ? 0x5865F2 : 0x57F287)
    .addFields(
      { name: 'Team Name', value: data.team_name, inline: true },
      { name: 'Team Owner Full Name', value: data.owner_name, inline: true },
      { name: 'City', value: data.city, inline: true },
      { name: 'WhatsApp Contact Number', value: data.whatsapp, inline: true },
      { name: 'Team Owner Email', value: data.owner_email, inline: true },
      ...playerFields,
      { name: 'Playing Lineup', value: lineupLine },
      { name: 'Team Registered Date', value: new Date(data.registeredDate).toUTCString() },
    );

  const customMessage = store && store.settings && store.settings.verifyConfirmationMessage;
  if (customMessage) embed.setFooter({ text: customMessage });

  return embed;
}

// Posted to the PRIVATE channel configured via /set-private-verify-channel
// — mirrors the "OQ Team Registration Confirmed" card style (team number
// header, divider lines, per-player IGN/UID blocks, substitute section)
// but built from verification data only, since verification happens
// before a team has a scrim slot/group/match schedule to show. Player 5
// (if filled in) is treated as the substitute, same as the registration
// flow already does.
function buildPrivateVerifiedLogEmbed(data, teamNumber, ownerId, isEdit) {
  const playerLines = [1, 2, 3, 4]
    .map(n => `**PLAYER ${n}**\nIGN :- ${data[`p${n}_ign`]}\nUID :- ${data[`p${n}_uid`]}`)
    .join('\n\n');

  const substituteLine = data.p5_ign
    ? `IGN :- ${data.p5_ign}\nUID :- ${data.p5_uid}`
    : 'NO SUBSTITUTE SELECTED';

  const lineupLine = (data.selectedPlayerIds || []).map(id => `<@${id}>`).join(' ') || '_not selected_';

  return new EmbedBuilder()
    .setTitle(isEdit ? '🔄 Team Verification Updated' : '✅ Team Verification Confirmed')
    .setColor(isEdit ? 0x5865F2 : 0x57F287)
    .setDescription(
      `**TEAM NUMBER**\n#${teamNumber}\n\n` +
      `👑 **OWNER**\n<@${ownerId}>\n\n` +
      `🏳️ **TEAM NAME**\n${data.team_name}\n\n` +
      `📍 **CITY**\n${data.city}\n\n` +
      `📱 **WHATSAPP**\n${data.whatsapp}\n\n` +
      `✉️ **EMAIL**\n${data.owner_email}\n\n` +
      `🧑‍🤝‍🧑 **PLAYERS**\n${playerLines}\n\n` +
      `🔁 **SUBSTITUTE**\n${substituteLine}\n\n` +
      `👥 **PLAYING LINEUP**\n${lineupLine}`
    )
    .setFooter({ text: isEdit ? 'Updated' : 'Best of luck 👊 for your matches!!' })
    .setTimestamp();
}

// Public-channel privacy: hide all but the last 3 digits of a phone number
// (9876543210 -> xxxxxxx210). Only used by the PUBLIC log embed — the
// private verification channel embed still shows the full number.
function maskPhone(num) {
  const d = String(num || '');
  if (d.length <= 3) return d;
  return 'x'.repeat(d.length - 3) + d.slice(-3);
}

// Posted to the PUBLIC channel configured via /set-verify-channel — the
// card (team number, owner mention, city, masked WhatsApp — email hidden,
// per-player IGN/UID, playing lineup). Also reused by !team
// (pcmd-team.js) for the on-demand admin lookup — mirrors the "Team
// Confirmed" card style rather than the plain field grid used for the
// player's own ephemeral confirmation.
function buildVerifiedLogEmbed(data, teamNumber, ownerId, isEdit) {
  const playerLines = [1, 2, 3, 4, 5]
    .filter(n => n < 5 || data.p5_ign) // Player 5 is optional — omit the line entirely if not filled in
    .map(n => {
      const key = `p${n}`;
      return `<a:452028tick:1549274499789365339> \`${data[`${key}_ign`]}\` / ${data[`${key}_uid`]}`;
    })
    .join('\n');

  const lineupLine = (data.selectedPlayerIds || []).map(id => `<@${id}>`).join(' ') || '_not selected_';

  return new EmbedBuilder()
    .setTitle(isEdit ? '<:99583verified:1549274762730143864> TEAM VERIFICATION CONFIRMED' : '<a:6bbbe07d495743d0a6b546e50d7dd64e:1549274602906062908> TEAM VERIFICATION — Team Confirmed')
    .setColor(isEdit ? 0x5865F2 : 0xF5A623)
    .setDescription(
      `<a:6bbbe07d495743d0a6b546e50d7dd64e:1549274602906062908> ${teamNumber} : **TEAM ${data.team_name}**\n` +
      `<a:69074e9b22af4fb892386c31bb0999d6:1549274595583074354> Owner - <@${ownerId}>\n` +
      `<a:836435400498741289:1549274672103690240> City - ${data.city}\n\n` +
      `<a:1037776333327052890:1549274238588813383> **Players (IGN/UID)**\n${playerLines}\n\n` +
      `<:7578whatsapp:1549274615191306340> WhatsApp: ${maskPhone(data.whatsapp)}\n\n` +
      `<:806126playing:1549274618353680445> **Playing Lineup -** ${lineupLine}`
    )
    .setFooter({
      text: isEdit
        ? `Updated ${new Date().toUTCString()}`
        : `Registered ${new Date(data.registeredDate).toUTCString()}`,
    });
}

// Only members holding the configured Required Role (config.js ->
// requiredVerifyRoleId) may verify. Nothing configured = everyone can.
function memberMissingRequiredRole(interaction, store) {
  const roleId = store.settings && store.settings.requiredVerifyRoleId;
  if (!roleId) return false;
  const roles = interaction.member && interaction.member.roles;
  if (!roles) return true;
  if (Array.isArray(roles)) return !roles.includes(roleId);   // raw API member
  return !roles.cache.has(roleId);
}

// --- Step 0a: "Verify" button pressed (fresh verification) ---
async function handleVerifyButton(interaction) {
  const store = getGuildStore(interaction.guildId);

  if (memberMissingRequiredRole(interaction, store)) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('❌ VERIFICATION RESTRICTED')
        .setDescription(
          '### 🔒 Missing Required Role\n' +
          `To verify for these scrims, you must have the <@&${store.settings.requiredVerifyRoleId}> role\n\n` +
          '📌 *If you are an esports player, please contact the management to get verified.*'
        )],
      flags: MessageFlags.Ephemeral,
    });
  }
  const existing = store.verifications && store.verifications[interaction.user.id];

  if (existing) {
    return interaction.reply({
      content: `❌ You've already verified team **${existing.team_name}**. Use the **Edit** button to update your details instead.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  startPending(interaction.user.id, interaction.guildId, 'create');
  await interaction.showModal(buildVerifyStep1Modal());
}

// --- Step 0b: "Edit" button pressed (update an existing verification) ---
async function handleVerifyEditButton(interaction) {
  const store = getGuildStore(interaction.guildId);
  const existing = store.verifications && store.verifications[interaction.user.id];

  if (!existing) {
    return interaction.reply({
      content: "❌ You haven't verified yet — click **Verify** first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  startPending(interaction.user.id, interaction.guildId, 'edit', existing);
  await interaction.showModal(buildVerifyStep1Modal(existing));
}

// --- Step 1/3 submitted: team name, owner, whatsapp, email, city ---
async function handleVerifyStep1Submit(interaction) {
  const team_name = interaction.fields.getTextInputValue('team_name').trim();
  const owner_name = interaction.fields.getTextInputValue('owner_name').trim();
  const whatsapp = interaction.fields.getTextInputValue('whatsapp').trim();
  const owner_email = interaction.fields.getTextInputValue('owner_email').trim();
  const city = interaction.fields.getTextInputValue('city').trim();

  // Keep whatever they typed (valid or not) so a retry can prefill it —
  // this needs a pending entry to exist even on the very first step.
  if (!getPending(interaction.user.id)) startPending(interaction.user.id, interaction.guildId, 'create');
  updatePending(interaction.user.id, { team_name, owner_name, whatsapp, owner_email, city });

  if (!WHATSAPP_RE.test(whatsapp)) {
    return interaction.reply({
      content: "❌ That WhatsApp number doesn't look valid (it must be exactly 10 digits, numbers only). Tap **Try Again** to fix it — your other answers are kept.",
      components: [retryRow('verify_retry_step1', 'Try Again')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!EMAIL_RE.test(owner_email)) {
    return interaction.reply({
      content: "❌ That email address doesn't look valid. Tap **Try Again** to fix it — your other answers are kept.",
      components: [retryRow('verify_retry_step1', 'Try Again')],
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.reply({
    content: '✅ Step 1 saved. Continue to enter Player 1 and Player 2 details.',
    components: [continueRow('verify_continue_2', 'Continue to Players 1 & 2')],
    flags: MessageFlags.Ephemeral,
  });
}

// "Try Again" after a Step 1 validation error — reopens Step 1's modal
// prefilled with everything they already typed, including the bad field.
async function handleVerifyRetryStep1(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your verification session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.showModal(buildVerifyStep1Modal(pending.data));
}

// Modal submissions cannot reliably open the next modal directly on every Discord client.
// Use an explicit component interaction so the next modal always opens.
async function handleVerifyStep2Button(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your verification session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.showModal(buildVerifyStep2Modal(pending.original));
}

// Checks the typed UIDs against the real in-game names (see bgmi-lookup.js):
//   * a UID that doesn't exist  -> the step is refused (player taps Try Again)
//   * a real UID, different IGN -> the IGN is auto-corrected to the in-game name
//   * lookup down / blocked     -> nothing is refused ("unverified", fail-open)
// Mutates `igns` in place. Returns { problems, corrections }.
async function runUidCheck(labels, igns, uids) {
  const checks = await checkPlayerUids(igns, uids);
  applyCorrections(igns, checks, 30); // modal IGN limit is 30
  return reviewChecks(labels, igns, uids, checks);
}

function uidProblemMessage(problems) {
  return `❌ Some player details are wrong:\n${problems.map(p => `• ${p}`).join('\n')}\n\nTap **Try Again** to fix them — your other answers are kept.`;
}

function correctionNote(corrections) {
  return corrections.length
    ? `\n\n🔧 **IGN auto-corrected from your UID:**\n${corrections.join('\n')}`
    : '';
}

// --- Step 2/3 submitted: player 1 (ign+uid), player 2 (ign+uid), player 3 ign ---
async function handleVerifyStep2Submit(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your verification session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const p1_ign = interaction.fields.getTextInputValue('p1_ign').trim();
  const p1_uid = interaction.fields.getTextInputValue('p1_uid').trim();
  const p2_ign = interaction.fields.getTextInputValue('p2_ign').trim();
  const p2_uid = interaction.fields.getTextInputValue('p2_uid').trim();

  // Keep whatever they typed (valid or not) so a retry can prefill it.
  updatePending(interaction.user.id, { p1_ign, p1_uid, p2_ign, p2_uid });

  for (const [label, uid] of [['Player 1', p1_uid], ['Player 2', p2_uid]]) {
    if (!UID_RE.test(uid)) {
      return interaction.reply({
        content: `❌ ${label}'s Game UID must be numbers only (5-12 digits). Tap **Try Again** to fix it — your other answers are kept.`,
        components: [retryRow('verify_retry_step2', 'Try Again')],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // The lookup can take a few seconds and a modal must be answered within 3s.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const igns2 = [p1_ign, p2_ign];
  const uids2 = [p1_uid, p2_uid];
  const review2 = await runUidCheck(['Player 1', 'Player 2'], igns2, uids2);
  updatePending(interaction.user.id, { p1_ign: igns2[0], p2_ign: igns2[1] }); // corrected names (also prefill a retry)
  if (review2.problems.length) {
    return interaction.editReply({
      content: uidProblemMessage(review2.problems),
      components: [retryRow('verify_retry_step2', 'Try Again')],
    });
  }

  await interaction.editReply({
    content: '✅ Step 2 saved. Continue to enter Player 3, Player 4 and Player 5 details.' + correctionNote(review2.corrections),
    components: [continueRow('verify_continue_3', 'Continue to Player 3, 4 & 5')],
  });
}

// "Try Again" after a Step 2 validation error — reopens Step 2's modal
// prefilled with everything they already typed, including the bad field.
async function handleVerifyRetryStep2(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your verification session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.showModal(buildVerifyStep2Modal(pending.data));
}

async function handleVerifyStep3Button(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your verification session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.showModal(buildVerifyStep3Modal(pending.original));
}

// --- Step 3/3 submitted: player 3 uid, players 4 and 5 -> ask which 4 play ---
async function handleVerifyStep3Submit(interaction) {
  const pendingEntry = getPending(interaction.user.id);
  if (!pendingEntry) {
    return interaction.reply({
      content: `❌ Your verification session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const p3_ign = interaction.fields.getTextInputValue('p3_ign').trim();
  const p3_uid = interaction.fields.getTextInputValue('p3_uid').trim();
  const p4_ign = interaction.fields.getTextInputValue('p4_ign').trim();
  const p4_uid = interaction.fields.getTextInputValue('p4_uid').trim();
  const p5_combined = interaction.fields.getTextInputValue('p5_combined').trim();

  // Keep whatever they typed (valid or not) so a retry can prefill it.
  updatePending(interaction.user.id, { p3_ign, p3_uid, p4_ign, p4_uid, p5_combined });

  for (const [label, uid] of [['Player 3', p3_uid], ['Player 4', p4_uid]]) {
    if (!UID_RE.test(uid)) {
      return interaction.reply({
        content: `❌ ${label}'s Game UID must be numbers only (5-12 digits). Tap **Try Again** to fix it — your other answers are kept.`,
        components: [retryRow('verify_retry_step3', 'Try Again')],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const p5Match = p5_combined ? P5_COMBINED_RE.exec(p5_combined) : null;
  if (p5_combined && !p5Match) {
    return interaction.reply({
      content: '❌ Player 5 must be in the format **IGN - UID** (e.g. `ProGamer123 - 5123456789`), or left blank if there is no Player 5. Tap **Try Again** to fix it — your other answers are kept.',
      components: [retryRow('verify_retry_step3', 'Try Again')],
      flags: MessageFlags.Ephemeral,
    });
  }
  const p5_ign = p5Match ? p5Match[1].trim() : '';
  const p5_uid = p5Match ? p5Match[2].trim() : '';
  updatePending(interaction.user.id, { p5_ign, p5_uid });

  // UID check (Players 3, 4 and the optional Player 5) — see runUidCheck().
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const igns3 = [p3_ign, p4_ign];
  const uids3 = [p3_uid, p4_uid];
  const labels3 = ['Player 3', 'Player 4'];
  if (p5Match) { igns3.push(p5_ign); uids3.push(p5_uid); labels3.push('Player 5'); }
  const review3 = await runUidCheck(labels3, igns3, uids3);
  updatePending(interaction.user.id, {
    p3_ign: igns3[0],
    p4_ign: igns3[1],
    ...(p5Match ? { p5_ign: igns3[2], p5_combined: `${igns3[2]} - ${p5_uid}` } : {}),
  });
  if (review3.problems.length) {
    return interaction.editReply({
      content: uidProblemMessage(review3.problems),
      components: [retryRow('verify_retry_step3', 'Try Again')],
    });
  }

  const entry = getPending(interaction.user.id);

  // Belt-and-suspenders: every field except Player 5 is `required` on its
  // modal, so this should never actually be missing anything — but if a
  // step was somehow skipped, refuse to continue with a half-filled
  // verification. Player 5 is optional and deliberately excluded here.
  const requiredFields = [
    'team_name', 'owner_name', 'whatsapp', 'owner_email', 'city',
    'p1_ign', 'p1_uid', 'p2_ign', 'p2_uid', 'p3_ign', 'p3_uid', 'p4_ign', 'p4_uid',
  ];
  const missing = requiredFields.filter(f => !entry.data[f]);
  if (missing.length) {
    clearPending(interaction.user.id);
    return interaction.editReply({
      content: `❌ Verification incomplete — some details were missing. ${RESTART_HINT}`,
    });
  }

  await interaction.editReply({
    content: '✅ Step 3 saved. Last step — select the **4 players from this server** who will play:' + correctionNote(review3.corrections),
    components: [buildPlayerSelectRow()],
  });
}

// "Try Again" after a Step 3 validation error — reopens Step 3's modal
// prefilled with everything they already typed, including the bad field.
async function handleVerifyRetryStep3(interaction) {
  const pending = getPending(interaction.user.id);
  if (!pending) {
    return interaction.reply({
      content: `❌ Your verification session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.showModal(buildVerifyStep3Modal(pending.data));
}

// Gives the configured "verified" role (set via /set-verify-role), if one
// is configured. Never throws — a missing role, missing permissions, or the
// member having left shouldn't ever block verification itself from
// completing. Mirrors giveRegisteredRole in register-handlers.js.
async function giveVerifiedRole(interaction, store) {
  const roleId = store.settings && store.settings.verifiedRoleId;
  if (!roleId) {
    console.warn(`[verified-role] No verifiedRoleId configured for guild ${interaction.guildId} — run /set-verify-role.`);
    return;
  }

  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) {
    console.error(`[verified-role] Configured role ${roleId} no longer exists in guild ${interaction.guildId} — re-run /set-verify-role.`);
    return;
  }

  const botMember = interaction.guild.members.me;
  if (!botMember.permissions.has('ManageRoles')) {
    console.error(`[verified-role] Bot is missing the "Manage Roles" permission in guild ${interaction.guildId}.`);
    return;
  }
  if (role.position >= botMember.roles.highest.position) {
    console.error(`[verified-role] Bot's highest role is below "${role.name}" (${roleId}) in guild ${interaction.guildId} — move the bot's role above it.`);
    return;
  }

  try {
    const member = interaction.member ?? await interaction.guild.members.fetch(interaction.user.id);
    if (!member.roles.cache.has(roleId)) {
      await member.roles.add(roleId);
    }
  } catch (err) {
    console.error(`[verified-role] Failed to give role ${roleId} to ${interaction.user.id} in guild ${interaction.guildId}: ${err.code ?? ''} ${err.message}`);
  }
}

// --- Final step: pick 4 real Discord members as the playing lineup -> finalize and save verification ---
async function handleVerifyPlayerSelect(interaction) {
  const pendingEntry = getPending(interaction.user.id);
  if (!pendingEntry) {
    return interaction.reply({
      content: `❌ Your verification session expired or was interrupted. ${RESTART_HINT}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const selectedIds = interaction.values;
  const isEdit = pendingEntry.mode === 'edit';

  // Reject bot accounts — UserSelectMenu has no built-in "humans only"
  // filter, so this has to be checked after the fact. interaction.users
  // is populated by discord.js alongside .values for a UserSelectMenu.
  const bots = selectedIds.filter(id => interaction.users.get(id)?.bot);
  if (bots.length) {
    return interaction.update({
      content: `❌ Bots can't be selected as players: ${bots.map(id => `<@${id}>`).join(', ')}. Select 4 real players from the server.`,
      components: [buildPlayerSelectRow()],
    });
  }

  // Reject players already locked into another team's lineup. When
  // editing, skip the caller's own existing record so re-picking the same
  // players (or swapping just one) doesn't falsely flag as a conflict.
  const store = getGuildStore(interaction.guildId);
  const takenBy = new Map(); // playerId -> team name that already has them
  if (store.verifications) {
    for (const [ownerId, record] of Object.entries(store.verifications)) {
      if (isEdit && ownerId === interaction.user.id) continue;
      for (const pid of record.selectedPlayerIds || []) {
        if (!takenBy.has(pid)) takenBy.set(pid, record.team_name);
      }
    }
  }
  const conflicts = selectedIds.filter(id => takenBy.has(id));
  if (conflicts.length) {
    const list = conflicts.map(id => `<@${id}> — already in **${takenBy.get(id)}**`).join('\n');
    return interaction.update({
      content: null,
      embeds: [new EmbedBuilder()
        .setTitle('❌ Players Already Selected')
        .setColor(0xED4245)
        .setDescription(`These players are already in another team's lineup:\n\n${list}`)
        .setFooter({ text: 'Pick different players.' })],
      components: [buildPlayerSelectRow()],
    });
  }

  const data = { ...pendingEntry.data, selectedPlayerIds: selectedIds };

  if (!store.verifications) store.verifications = {};
  if (!store.settings) store.settings = {};

  const existingRecord = store.verifications[interaction.user.id];

  if (!isEdit && existingRecord) {
    // Belt-and-suspenders: handleVerifyButton already blocks this, but guard
    // against a race (e.g. two rapid submissions) from double-creating.
    clearPending(interaction.user.id);
    return interaction.reply({
      content: `❌ You've already verified team **${existingRecord.team_name}**. Use **Edit** to update your details instead.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  let teamNumber;
  if (isEdit && existingRecord) {
    teamNumber = existingRecord.teamNumber;
    data.registeredDate = existingRecord.registeredDate; // keep original registration date
  } else {
    teamNumber = (store.settings.verifyTeamCounter || 0) + 1;
    store.settings.verifyTeamCounter = teamNumber;
    data.registeredDate = new Date().toISOString();
  }
  data.teamNumber = teamNumber;

  store.verifications[interaction.user.id] = data;
  saveGuildStore(interaction.guildId, store);
  clearPending(interaction.user.id);

  await giveVerifiedRole(interaction, store);

  const verifiedEmbed = buildVerifiedEmbed(data, isEdit, store);

  const logChannel = await resolveLogChannel(interaction.guild, store, store.settings.verifyLogChannelId);
  if (logChannel) {
    try {
      // Mentions inside an embed never notify anyone, so put the owner + every
      // selected lineup player in the message content to actually ping them.
      const publicPingIds = [...new Set([interaction.user.id, ...(data.selectedPlayerIds || [])])];
      await logChannel.send({
        content: publicPingIds.map(id => `<@${id}>`).join(' '),
        embeds: [buildVerifiedLogEmbed(data, teamNumber, interaction.user.id, isEdit)],
        allowedMentions: { users: publicPingIds },
      });
    } catch (err) {
      console.error('Failed to post verification to public log channel:', err);
      // Don't block the user's confirmation just because the log post failed
      // (e.g. channel deleted, bot missing permissions).
    }
  }

  // Auto-created the first time it's needed (see log-channel.js) — no admin
  // setup required, and reused after that.
  const privateChannel = await getOrCreatePrivateVerifyChannel(interaction.guild, store);
  if (privateChannel) {
    try {
      // Mentions inside an embed never notify anyone, so also put the owner +
      // every selected lineup player in the message content to actually ping them.
      const pingIds = [...new Set([interaction.user.id, ...(data.selectedPlayerIds || [])])];
      await privateChannel.send({
        content: pingIds.map(id => `<@${id}>`).join(' '),
        embeds: [buildPrivateVerifiedLogEmbed(data, teamNumber, interaction.user.id, isEdit)],
        allowedMentions: { users: pingIds },
      });
    } catch (err) {
      console.error('Failed to post verification to private log channel:', err);
    }
  }

  await interaction.update({
    content: null,
    embeds: [verifiedEmbed],
    components: [],
  });
}

// --- "Delete Team" button on the verification panel ---
// Lets a team owner remove their own verification. Because a registration
// only makes sense for a verified team, deleting the verification also:
//   * frees the owner's scrim slot (if they registered), and
//   * strips the Verified, Registered and group roles from the owner and
//     every player in the verified lineup / registered lineup.
async function handleVerifyDeleteButton(interaction) {
  const store = getGuildStore(interaction.guildId);
  const record = store.verifications && store.verifications[interaction.user.id];

  if (!record) {
    const onLineup = Object.values(store.verifications || {}).find(r => (r.selectedPlayerIds || []).includes(interaction.user.id));
    return interaction.reply({
      content: onLineup
        ? `❌ Only the team owner can delete team **${onLineup.team_name}**. Ask your owner (or an admin) to do it.`
        : "❌ You don't have a verified team to delete.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify_delete_confirm').setLabel('Yes, delete my team').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('verify_delete_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    content:
      `⚠️ Delete verified team **${record.team_name}**?\n` +
      `This removes your verification, frees your scrim slot (if registered) and takes the Verified / Registered / Group roles away from your whole lineup. You will need to verify again.`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleVerifyDeleteCancel(interaction) {
  await interaction.update({ content: '✅ No changes made — your team is still verified.', components: [] });
}

async function handleVerifyDeleteConfirm(interaction) {
  const store = getGuildStore(interaction.guildId);
  const record = store.verifications && store.verifications[interaction.user.id];
  if (!record) {
    return interaction.update({ content: "❌ You don't have a verified team to delete (it may already be gone).", components: [] });
  }

  await interaction.update({ content: '⏳ Deleting your team...', components: [] });

  const ownerId = interaction.user.id;
  const scrim = store.scrim;
  const slotEntry = scrim && scrim.slots
    ? Object.entries(scrim.slots).find(([, sl]) => sl.userId === ownerId)
    : null;
  const slot = slotEntry ? slotEntry[1] : null;

  const players = new Set([
    ownerId,
    ...(record.selectedPlayerIds || []),
    ...(slot ? (slot.selectedPlayerIds || []) : []),
  ]);

  const settings = store.settings || {};
  const roleIds = [
    settings.verifiedRoleId,
    settings.registeredRoleId,
    slot && settings.groupRoles ? settings.groupRoles[slot.group] : null,
  ].filter(Boolean);

  // Remove the data first so a role-permission hiccup can never leave a half-deleted team.
  delete store.verifications[ownerId];
  if (slotEntry) delete scrim.slots[slotEntry[0]];
  saveGuildStore(interaction.guildId, store);
  clearPending(ownerId); // kill any half-finished verify/edit form

  let roleFailures = 0;
  for (const pid of players) {
    try {
      const member = await interaction.guild.members.fetch(pid);
      const toRemove = roleIds.filter(id => member.roles.cache.has(id));
      if (toRemove.length) await member.roles.remove(toRemove, `Verification deleted by team owner ${interaction.user.tag}`);
    } catch (err) {
      roleFailures++; // left the server, or the bot lacks permission
    }
  }

  if (slot) {
    try {
      await refreshLivePanel(interaction.client, interaction.guildId);
      await refreshGroupSlotList(interaction.client, interaction.guildId, slot.group);
      await notifySlotOpened(interaction.client, interaction.guildId, slot.group, ownerId);
    } catch (err) {
      console.error('Failed to refresh panels after verification delete:', err);
    }
  }

  const privateChannel = await getOrCreatePrivateVerifyChannel(interaction.guild, store).catch(() => null);
  if (privateChannel) {
    privateChannel.send({
      embeds: [new EmbedBuilder()
        .setTitle('🗑️ TEAM DELETED')
        .setColor(0xED4245)
        .setDescription(
          `**TEAM ${record.team_name}** (owner <@${ownerId}>) deleted their verification.` +
          (slot ? '\nTheir scrim slot was freed too.' : ''))
        .setFooter({ text: new Date().toUTCString() })],
      allowedMentions: { parse: [] },
    }).catch(err => console.error('Failed to log team deletion:', err));
  }

  const note = roleFailures
    ? `\n⚠️ Could not update roles for ${roleFailures} player(s) (they may have left the server, or I lack permission).`
    : '';
  await interaction.editReply({
    content: `🗑️ Team **${record.team_name}** has been deleted${slot ? ' and your scrim slot was freed' : ''}. Roles were removed from your lineup. Click **Verify** to start again.${note}`,
    components: [],
  });
}

module.exports = {
  handleVerifyDeleteButton,
  handleVerifyDeleteConfirm,
  handleVerifyDeleteCancel,
  buildVerifiedLogEmbed,
  handleVerifyButton,
  handleVerifyEditButton,
  handleVerifyStep1Submit,
  handleVerifyRetryStep1,
  handleVerifyStep2Button,
  handleVerifyStep2Submit,
  handleVerifyRetryStep2,
  handleVerifyStep3Button,
  handleVerifyStep3Submit,
  handleVerifyRetryStep3,
  handleVerifyPlayerSelect,
  giveVerifiedRole,
};
