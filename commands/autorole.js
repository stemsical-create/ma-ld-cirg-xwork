/**
 * Auto-Role Config Panel
 * Server Owner configures team -> role mappings via panels
 * No manual /link command — verification is auto-scraped from Bloxlink/Melonly
 */
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { query } = require('../database/db');

module.exports = {
  name: 'autorole',
  description: 'Configure ER:LC auto-role system',
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: false });
    const guildId = interaction.guild.id;


      const access = await query(
        'SELECT role_id FROM autorole_access WHERE guild_id = $1 AND permission = $2',
        [guildId, 'manage']
      );
      const granted = access.rows.some(r => interaction.member.roles.cache.has(r.role_id));
      if (!granted) {
        return interaction.editReply({ content: '❌ Only the Server Owner or configured roles can manage auto-role.', ephemeral: true });
      }
    }

    await showPanel(interaction, guildId);
  },
};

async function showPanel(interaction, guildId) {
  const cfgResult = await query('SELECT * FROM autorole_config WHERE guild_id = $1', [guildId]);
  const cfg = cfgResult.rows[0] || { enabled: false, log_channel: null, last_checked: null };

  const mapResult = await query('SELECT * FROM autorole_mappings WHERE guild_id = $1', [guildId]);
  const mappings = mapResult.rows;

  const accessResult = await query('SELECT * FROM autorole_access WHERE guild_id = $1', [guildId]);
  const accessRoles = accessResult.rows;

  const embed = new EmbedBuilder()
    .setTitle('⚙️ ER:LC Auto-Role')
    .setDescription('Team → Discord role mappings for automatic role assignment.')
    .setColor(cfg.enabled ? 0x00FF00 : 0xFF0000)
    .addFields(
      { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true },
      { name: 'Log Channel', value: cfg.log_channel ? `<#${cfg.log_channel}>` : 'Not set', inline: true },
      { name: 'Last Checked', value: cfg.last_checked ? `<t:${Math.floor(new Date(cfg.last_checked).getTime() / 1000)}:R>` : 'Never', inline: true },
    );

  // Team mappings
  const defaultTeams = ['Civilian', 'Police', 'Sheriff', 'State Police', 'Fire/EMS', 'DOT'];
  let mapText = '';
  for (const team of defaultTeams) {
    const m = mappings.find(x => x.team_name === team);
    const status = m ? `✅ <@&${m.role_id}>` : '⬜ Not set';
    mapText += `${status} — **${team}**\n`;
  }
  embed.addFields({ name: 'Team Mappings', value: mapText || 'None', inline: false });

  if (accessRoles.length > 0) {
    const list = accessRoles.map(a => `<@&${a.role_id}>`).join(', ');
    embed.addFields({ name: 'Roles with Access', value: list, inline: false });
  }

  // Verification auto-scan info (no /link needed)
  embed.addFields({
    name: '🔍 Verification',
    value: 'Roblox IDs are auto-detected from **Bloxlink** and **Melonly** nickname patterns. No manual `/link` command — just verify with those bots and auto-role will pick it up.',
    inline: false,
  });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ar_toggle')
      .setLabel(cfg.enabled ? 'Disable' : 'Enable')
      .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ar_team_select')
      .setPlaceholder('Select team to map...')
      .addOptions(
        defaultTeams.map(t => ({ label: t, value: t })),
      ),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ar_set_log').setLabel('Set Log Channel').setStyle(ButtonStyle.Secondary).setEmoji('📝'),
    new ButtonBuilder().setCustomId('ar_access').setLabel('Manage Access').setStyle(ButtonStyle.Secondary).setEmoji('🔑'),
    new ButtonBuilder().setCustomId('ar_sync').setLabel('Sync Now').setStyle(ButtonStyle.Primary).setEmoji('🔄'),
  );

  const msg = await interaction.editReply({ embeds: [embed], components: [row1, row2, row3], fetchReply: true });

  // Collector
  const filter = i => i.user.id === interaction.user.id;
  const collector = msg.createMessageComponentCollector({ filter, time: 120000 });

  collector.on('collect', async (i) => {
    if (i.customId === 'ar_toggle') {
      const newVal = !cfg.enabled;
      await query(
        `INSERT INTO autorole_config (guild_id, enabled) VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET enabled = $2, updated_at = NOW()`,
        [guildId, newVal]
      );
      cfg.enabled = newVal;
      await i.update({ content: `✅ Auto-role ${newVal ? 'enabled' : 'disabled'}.`, embeds: [], components: [], ephemeral: true });
      setTimeout(() => showPanel(interaction, guildId), 500);
    }

    else if (i.customId === 'ar_team_select') {
      const team = i.values[0];
      const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: ModalRow } = require('discord.js');
      const modal = new ModalBuilder()
        .setCustomId(`ar_role_${team}`)
        .setTitle(`Role for ${team}`);
      modal.addComponents(
        new ModalRow().addComponents(
          new TextInputBuilder()
            .setCustomId('role_id')
            .setLabel('Enter Role ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Paste the role ID')
            .setRequired(true),
        ),
      );
      await i.showModal(modal);
    }

    else if (i.customId === 'ar_set_log') {
      const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: ModalRow } = require('discord.js');
      const modal = new ModalBuilder()
        .setCustomId('ar_log_modal')
        .setTitle('Log Channel');
      modal.addComponents(
        new ModalRow().addComponents(
          new TextInputBuilder()
            .setCustomId('channel_id')
            .setLabel('Channel ID (leave blank to clear)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Channel ID')
            .setRequired(false),
        ),
      );
      await i.showModal(modal);
    }

    else if (i.customId === 'ar_access') {
      await showAccessPanel(i, guildId);
    }

    else if (i.customId === 'ar_sync') {
      await i.update({ content: '🔄 Syncing...', embeds: [], components: [], ephemeral: true });
      const AutoRoleService = require('../modules/autorole/AutoRoleService');
      const svc = new AutoRoleService(interaction.client);
      await svc.syncGuild({ guild_id: guildId, enabled: true, log_channel: cfg.log_channel });
      await interaction.editReply({ content: '✅ Sync done. Roles updated for verified members.', ephemeral: true });
      setTimeout(() => showPanel(interaction, guildId), 1000);
    }
  });
}

async function showAccessPanel(interaction, guildId) {
  const accessResult = await query('SELECT * FROM autorole_access WHERE guild_id = $1', [guildId]);
  const current = accessResult.rows;

  const embed = new EmbedBuilder()
    .setTitle('🔑 Access Management')
    .setDescription('Choose which Discord roles can access the `/autorole` panel.\nOnly selected roles + Server Owner.')
    .setColor(0x5865F2)
    .addFields({ name: 'Authorized Roles', value: current.map(r => `<@&${r.role_id}>`).join('\n') || 'None (Owner only)' });

  const roleOpts = interaction.guild.roles.cache
    .filter(r => r.id !== interaction.guild.id && !r.managed)
    .map(r => ({ label: r.name, value: r.id }));

  const addMenu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ar_add_access')
      .setPlaceholder('Add a role...')
      .addOptions(roleOpts.slice(0, 25).length > 0 ? roleOpts.slice(0, 25) : [{ label: 'No roles', value: 'none' }]),
  );

  const removeOpts = current.map(r => {
    const role = interaction.guild.roles.cache.get(r.role_id);
    return { label: role?.name || 'Unknown', value: r.role_id };
  });
  const removeMenu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ar_remove_access')
      .setPlaceholder('Remove a role...')
      .addOptions(removeOpts.length > 0 ? removeOpts : [{ label: 'No roles', value: 'none' }]),
  );

  const back = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ar_back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({ embeds: [embed], components: [addMenu, removeMenu, back] });
}

// Handle modals and access sub-menu actions
module.exports.handleModal = async (interaction) => {
  const guildId = interaction.guild.id;
  const cid = interaction.customId;

  if (cid.startsWith('ar_role_')) {
    const team = cid.replace('ar_role_', '');
    const roleId = interaction.fields.getTextInputValue('role_id').replace(/[<@&>]/g, '');
    if (!/^\d{17,20}$/.test(roleId)) {
      return interaction.reply({ content: '❌ Invalid role ID.', ephemeral: true });
    }
    await query(
      `INSERT INTO autorole_mappings (guild_id, team_name, role_id) VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, team_name) DO UPDATE SET role_id = $3`,
      [guildId, team, roleId]
    );
    await interaction.reply({ content: `✅ **${team}** → <@&${roleId}>`, ephemeral: true });
  }

  else if (cid === 'ar_log_modal') {
    const ch = interaction.fields.getTextInputValue('channel_id').replace(/[<#>]/g, '');
    await query(
      `INSERT INTO autorole_config (guild_id, log_channel) VALUES ($1, $2)
       ON CONFLICT (guild_id) DO UPDATE SET log_channel = $2, updated_at = NOW()`,
      [guildId, ch || null]
    );
    await interaction.reply({ content: ch ? `✅ Log channel set.` : '✅ Log channel cleared.', ephemeral: true });
  }

  else if (cid === 'ar_add_access') {
    const roleId = interaction.values?.[0];
    if (roleId && roleId !== 'none') {
      await query(
        `INSERT INTO autorole_access (guild_id, role_id, permission) VALUES ($1, $2, 'manage')
         ON CONFLICT DO NOTHING`,
        [guildId, roleId]
      );
      await interaction.reply({ content: `✅ <@&${roleId}> can now manage auto-role.`, ephemeral: true });
    }
  }

  else if (cid === 'ar_remove_access') {
    const roleId = interaction.values?.[0];
    if (roleId && roleId !== 'none') {
      await query(
        'DELETE FROM autorole_access WHERE guild_id = $1 AND role_id = $2',
        [guildId, roleId]
      );
      await interaction.reply({ content: `✅ Role removed from access list.`, ephemeral: true });
    }
  }
};
