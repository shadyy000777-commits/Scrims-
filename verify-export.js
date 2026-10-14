const { AttachmentBuilder, MessageFlags } = require('discord.js');
const ExcelJS = require('exceljs');
const { getGuildStore } = require('./storage');
const { canManageServer } = require('./access');

// Staff-only "Export" button on the Scrims Verification panel.
// Builds an .xlsx of every verified team with just these columns:
// ID, Owner ID, Team Name, Owner Full Name, WhatsApp, Owner Email, City,
// Player 1-5 IGN + UID (Player 5 optional -> left blank), Timestamp.
const COLUMNS = [
  ['ID', 8],
  ['Owner ID', 22],
  ['Team Name', 24],
  ['Owner Full Name', 24],
  ['WhatsApp Number', 18],
  ['Owner Email', 30],
  ['City', 16],
  ['Player 1 IGN', 20], ['Player 1 UID', 16],
  ['Player 2 IGN', 20], ['Player 2 UID', 16],
  ['Player 3 IGN', 20], ['Player 3 UID', 16],
  ['Player 4 IGN', 20], ['Player 4 UID', 16],
  ['Player 5 IGN', 20], ['Player 5 UID', 16],
  ['Timestamp', 22],
];

function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }) + ' IST';
}

async function handleVerifyExportButton(interaction) {
  if (!canManageServer(interaction.member)) {
    return interaction.reply({
      content: '❌ Only staff can export verification data.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const store = getGuildStore(interaction.guildId);
  const records = Object.entries(store.verifications || {})
    .map(([ownerId, r]) => ({ ownerId, r }))
    .sort((a, b) => (a.r.teamNumber || 0) - (b.r.teamNumber || 0));

  if (!records.length) {
    return interaction.editReply({ content: '❌ No verified teams to export yet.' });
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Verifications');
  ws.columns = COLUMNS.map(([header, width]) => ({ header, width }));

  for (const { ownerId, r } of records) {
    // Text cells so long UIDs / phone numbers aren't shown in scientific notation.
    ws.addRow([
      r.teamNumber ?? '',
      String(ownerId),
      r.team_name || '',
      r.owner_name || '',
      String(r.whatsapp || ''),
      r.owner_email || '',
      r.city || '',
      r.p1_ign || '', String(r.p1_uid || ''),
      r.p2_ign || '', String(r.p2_uid || ''),
      r.p3_ign || '', String(r.p3_uid || ''),
      r.p4_ign || '', String(r.p4_uid || ''),
      r.p5_ign || '', r.p5_ign ? String(r.p5_uid || '') : '',
      formatTimestamp(r.registeredDate),
    ]);
  }

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  // Force text format on ID-like columns (Owner ID, WhatsApp, every UID).
  [2, 5, 9, 11, 13, 15, 17].forEach(c => { ws.getColumn(c).numFmt = '@'; });

  const buffer = await wb.xlsx.writeBuffer();
  const file = new AttachmentBuilder(Buffer.from(buffer), { name: 'scrims-verifications.xlsx' });
  await interaction.editReply({
    content: `📄 Exported **${records.length}** verified team(s).`,
    files: [file],
  });
}

module.exports = { handleVerifyExportButton };
