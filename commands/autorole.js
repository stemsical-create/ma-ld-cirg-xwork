/**
 * Auto-Role Management Panel
 * Server Owner / Admins configure ER:LC team -> Discord role mappings
 */
const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { query } = require('../database/db');

module.exports = {
  name: 'autorole',
  description: 'Configure ER:LC auto-role system',
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: false });

    const guildId = interaction.guild.id;

    // Check permission: Server Owner OR role-based access
    if (interaction.user.id !== interaction.guild.ownerId) {
      const accessRows = await query(
        'SELECT role_id FROM autorole_access WHERE guild_id = $1 AND permission = $2',
        [guildId, 'manage']
      );
      const hasAccess = accessRows.rows.some(r => interaction.member.roles.cache.has(r.role_id));
      if (!hasAccess) {
        return interaction.editReply({ content: '❌ Only the Server Owner or configured roles can manage auto-role.', ephemeral: true });
      }
    }

    await showMainPanel(interaction, guildId);
  },
};

async function showMainPanel(interaction, guildId) {
  // Fetch current config
  const configResult = await query('SELECT * FROM autorole_config WHERE guild_id = $1', [guildId]);
  const config = configResult.rows[0] || { enabled: false, join_log_channel: null };

  const mappingsResult = await query('SELECT * FROM autorole_mappings WHERE guild_id = $1', [guildId]);
  const mappings = mappingsResult.rows;

  const accessResult = await query('SELECT * FROM autorole_access WHERE guild_id = $1', [guildId]);
  const accessRoles = accessResult.rows;

  const teamRoles = {};
  const defaultTeams = ['Civilian', 'Police', 'Sheriff', 'State Police', 'Fire/EMS', 'DOT'];
  for (const t of defaultTeams) teamRoles[t] = 'Not set';

  for (const m of mappings) {
    teamRoles[m.team_name] = m.role_id ? `<@&${m.role_id}>` : 'Not set';
  }

  const statusEmoji = config.enabled ? '🟢 Enabled' : '🔴 Disabled';
  const logChanStr = config.join_log_channel ? `<#${config.join_log_channel}>` : 'Not set';

  const embed = new EmbedBuilder()
    .setTitle('⚙️ ER:LC Auto-Role Management')
    .setDescription(`Configure team-to-role mappings for automatic role assignment based on ER:LC in-game teams.`)
    .setColor(config.enabled ? 0x00FF00 : 0xFF0000)
    .addFields(
      { name: 'Status', value: statusEmoji, inline: true },
      { name: 'Log Channel', value: logChanStr, inline: true },
      { name: 'Last Checked', value: config.last_checked ? `<t:${Math.floor(new Date(config.last_checked).getTime() / 1000)}:R>` : 'Never', inline: true },
      { name: '\u200B', value: '\u200B' },
    );

  // List each team mapping
  let mappingText = '';
  for (const [team, roleStr] of Object.entries(teamRoles)) {
    const exists = mappings.some(m => m.team_name === team);
    const emoji = exists ? '✅' : '⬜';
    mappingText += `${emoji} **${team}** → ${roleStr}\n`;
  }
  embed.addFields({ name: 'Team → Role Mappings', value: mappingText || 'No mappings configured.', inline: false });

  if (accessRoles.length > 0) {
    const accessStr = accessRoles.map(a => `<@&${a.role_id}>`).join('\n');
    embed.addFields({ name: 'Roles with Access', value: accessStr, inline: false });
  }

  // Buttons
  const toggleBtn = new ButtonBuilder()
    .setCustomId('autorole_toggle')
    .setLabel(config.enabled ? 'Disable' : 'Enable')
    .setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success);

  const row1 = new ActionRowBuilder().addComponents(toggleBtn);

  const row2 = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('autorole_team_select')
        .setPlaceholder('Select a team to map...')
        .addOptions(
          { label: 'Civilian', value: 'Civilian', emoji: '👤' },
          { label: 'Police', value: 'Police', emoji: '👮' },
          { label: 'Sheriff', value: 'Sheriff', emoji: '⭐' },
          { label: 'State Police', value: 'State Police', emoji: '🚔' },
          { label: 'Fire/EMS', value: 'Fire/EMS', emoji: '🚒' },
          { label: 'DOT', value: 'DOT', emoji: '🚧' },
        ),
    );

  const row3 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('autorole_set_log').setLabel('Set Log Channel').setStyle(ButtonStyle.Secondary).setEmoji('📝'),
      new ButtonBuilder().setCustomId('autorole_access').setLabel('Manage Access').setStyle(ButtonStyle.Secondary).setEmoji('🔑'),
      new ButtonBuilder().setCustomId('autorole_sync_now').setLabel('Sync Now').setStyle(ButtonStyle.Primary).setEmoji('🔄'),
    );

  msg = await interaction.editReply({ embeds: [embed], components: [row1, row2, row3], fetchReply: true });

  // Collector for modal-like responses
  const filter = i => i.user.id === interaction.user.id;
  const collector = msg.createMessageComponentCollector({ filter, time: 120000 });

  collector.on('collect', async (i) => {
    if (i.customId === 'autorole_toggle') {
      const newStatus = !config.enabled;
      await query(
        `INSERT INTO autorole_config (guild_id, enabled) VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET enabled = $2, updated_at = NOW()`,
        [guildId, newStatus]
      );
      config.enabled = newStatus;
      await i.update({ content: `✅ Auto-role ${newStatus ? 'enabled' : 'disabled'}.`, embeds: [], components: [], ephemeral: true });
      await showMainPanel(interaction, guildId);
    }

    else if (i.customId === 'autorole_team_select') {
      const team = i.values[0];
      // Ask for role via modal
      const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder: ModalRow } = require('discord.js');
      const modal = new ModalBuilder()
        .setCustomId(`autorole_role_modal_${team}`)
        .setTitle(`Set Role for ${team}`);

      const roleInput = new TextInputBuilder()
        .setCustomId('role_id')
        .setLabel('Enter Role ID or mention')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 123456789012345678')
        .setRequired(true);

      modal.addComponents(new ModalRow().addComponents(roleInput));
      await i.showModal(modal);
    }

    else if (i.customId === 'autorole_set_log') {
      const modal = new ModalBuilder()
        .setCustomId('autorole_log_modal')
        .setTitle('Set Log Channel');

      const chanInput = new TextInputBuilder()
        .setCustomId('channel_id')
        .setLabel('Enter Channel ID')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Channel ID for logs')
        .setRequired(false);

      modal.addComponents(new ActionRowBuilder().addComponents(chanInput));
      await i.showModal(modal);
    }

    else if (i.customId === 'autorole_access') {
      // Show access management sub-panel
      await showAccessPanel(i, guildId);
    }

    else if (i.customId === 'autorole_sync_now') {
      await i.update({ content: '🔄 Syncing roles now...', embeds: [], components: [], ephemeral: true });
      const AutoRoleService = require('../modules/autorole/AutoRoleService');
      const svc = new AutoRoleService(interaction.client);
      await svc.syncGuild({ guild_id: guildId, enabled: true, join_log_channel: config.join_log_channel });
      await interaction.editReply({ content: '✅ Sync complete!', ephemeral: true });
      setTimeout(() => showMainPanel(interaction, guildId), 1000);
    }
  });

  // Handle modal submissions
  const modalFilter = i => i.user.id === interaction.user.id && i.isModalSubmit();
  const modalCollector = interaction.channel.createMessageComponentCollector({ modalFilter, time: 120000 });

  // Actually we need to listen on the interaction for modal submit
  // The modal submit will come through interactionCreate, not the message components
}

async function showAccessPanel(interaction, guildId) {
  const accessResult = await query('SELECT * FROM autorole_access WHERE guild_id = $1', [guildId]);
  const currentRoles = accessResult.rows;

  const embed = new EmbedBuilder()
    .setTitle('🔑 Access Management')
    .setDescription('Select which Discord roles can manage the auto-role system.\nOnly selected roles + Server Owner have access.')
    .setColor(0x5865F2);

  if (currentRoles.length > 0) {
    embed.addFields({ name: 'Authorized Roles', value: currentRoles.map(r => `<@&${r.role_id}>`).join('\n') || 'None' });
  } else {
    embed.addFields({ name: 'Authorized Roles', value: 'None (only Server Owner)' });
  }

  const roleOptions = interaction.guild.roles.cache
    .filter(r => r.id !== interaction.guild.id && !r.managed)
    .map(r => ({ label: r.name, value: r.id }))
    .slice(0, 25);

  const row1 = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('autorole_add_access_role')
        .setPlaceholder('Add a role...')
        .addOptions(roleOptions.length > 0 ? roleOptions : [{ label: 'No roles available', value: 'none' }]),
    );

  const row2 = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('autorole_remove_access_role')
        .setPlaceholder('Remove a role...')
        .addOptions(currentRoles.length > 0
          ? currentRoles.map(r => {
              const role = interaction.guild.roles.cache.get(r.role_id);
              return { label: role?.name || 'Unknown', value: r.role_id };
            })
          : [{ label: 'No roles to remove', value: 'none' }]
        ),
    );

  const backBtn = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('autorole_back').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    );

  await interaction.update({ embeds: [embed], components: [row1, row2, backBtn] });
}

// Handle modal submits globally via interactionCreate
module.exports.handleModal = async (interaction) => {
  const customId = interaction.customId;
  const guildId = interaction.guild.id;

  if (customId.startsWith('autorole_role_modal_')) {
    const team = customId.replace('autorole_role_modal_', '');
    const roleId = interaction.fields.getTextInputValue('role_id').replace(/[<@&>]/g, '');

    if (!/^\d{17,20}$/.test(roleId)) {
      return interaction.reply({ content: '❌ Invalid role ID. Please enter a valid role ID.', ephemeral: true });
    }

    await query(
      `INSERT INTO autorole_mappings (guild_id, team_name, role_id) VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, team_name) DO UPDATE SET role_id = $3`,
      [guildId, team, roleId]
    );

    await interaction.reply({ content: `✅ **${team}** → <@&${roleId}> saved!`, ephemeral: true });
  }

  else if (customId === 'autorole_log_modal') {
    const channelId = interaction.fields.getTextInputValue('channel_id').replace(/[<#>]/g, '');
    await query(
      `INSERT INTO autorole_config (guild_id, join_log_channel) VALUES ($1, $2)
       ON CONFLICT (guild_id) DO UPDATE SET join_log_channel = $2, updated_at = NOW()`,
      [guildId, channelId || null]
    );
    await interaction.reply({ content: channelId ? `✅ Log channel set to <#${channelId}>` : '✅ Log channel cleared.', ephemeral: true });
  }
};
