/**
 * Link Discord to Roblox ID for Auto-Role
 */
const { EmbedBuilder } = require('discord.js');
const { query } = require('../database/db');
const AutoRoleService = require('../modules/autorole/AutoRoleService');

module.exports = {
  name: 'link',
  description: 'Link your Roblox account for ER:LC auto-role',
  options: [
    {
      name: 'robloxid',
      description: 'Your Roblox User ID',
      type: 3,
      required: true,
    },
  ],
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const robloxId = interaction.options.getString('robloxid');
    if (!/^\d{1,15}$/.test(robloxId)) {
      return interaction.editReply('❌ Invalid Roblox ID. It should be numbers only.');
    }

    // Check config is enabled
    const configResult = await query('SELECT enabled FROM autorole_config WHERE guild_id = $1', [interaction.guild.id]);
    const config = configResult.rows[0];
    if (!config || !config.enabled) {
      return interaction.editReply('⚠️ Auto-role is not enabled on this server. Contact staff.');
    }

    // Upsert the player link
    await query(
      `INSERT INTO autorole_players (guild_id, user_id, roblox_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET roblox_id = $3, last_updated = NOW()`,
      [interaction.guild.id, interaction.user.id, robloxId]
    );

    // Try immediate sync
    const svc = new AutoRoleService(interaction.client);
    try {
      const res = await require('axios').get(
        `${process.env.ERLC_API || 'https://api.emergency-response-liberty-county.com'}/server/${process.env.ERLC_SERVER_ID || ''}/players`,
        { headers: { 'Authorization': `Bearer ${process.env.API_KEY}` }, timeout: 10000 }
      );
      const player = (res.data?.Players || []).find(p => String(p.robloxId || p.id) === robloxId);
      if (player) {
        const team = AutoRoleService.getTeamName(player.Team);
        const mappingResult = await query(
          'SELECT role_id FROM autorole_mappings WHERE guild_id = $1 AND LOWER(team_name) = LOWER($2)',
          [interaction.guild.id, team]
        );
        if (mappingResult.rows[0]) {
          const role = interaction.guild.roles.cache.get(mappingResult.rows[0].role_id);
          if (role && !interaction.member.roles.cache.has(role.id)) {
            await interaction.member.roles.add(role, 'AutoRole: Initial link');
            await query(
              'UPDATE autorole_players SET team_name = $1 WHERE guild_id = $2 AND user_id = $3',
              [team, interaction.guild.id, interaction.user.id]
            );
          }
        }
      }
    } catch {}

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('✅ Roblox Linked')
        .setDescription(`Your Roblox ID (**${robloxId}**) has been linked. Roles will sync automatically.`)
        .setColor(0x00FF00)
        .setFooter({ text: 'Auto-Role System' })
      ]
    });
  },
};
