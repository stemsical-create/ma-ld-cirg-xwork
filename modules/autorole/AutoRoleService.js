/**
 * ER:LC Auto-Role Service
 * Polls ER:LC API, checks player teams, syncs Discord roles
 */
const { REST } = require('discord.js');
const axios = require('axios');
const { query } = require('../../database/db');

class AutoRoleService {
  constructor(client) {
    this.client = client;
    this.interval = null;
    this.pollInterval = 30000; // 30 seconds default
  }

  get apiBase() {
    return process.env.ERLC_API || 'https://api.emergency-response-liberty-county.com';
  }

  get headers() {
    return { 'Authorization': `Bearer ${process.env.API_KEY}`, 'Content-Type': 'application/json' };
  }

  async start() {
    console.log('[AutoRole] Service started');
    // Run immediately, then every 30s
    await this.syncAllGuilds();
    this.interval = setInterval(() => this.syncAllGuilds(), this.pollInterval);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[AutoRole] Service stopped');
    }
  }

  async syncAllGuilds() {
    try {
      const result = await query('SELECT * FROM autorole_config WHERE enabled = true');
      for (const config of result.rows) {
        await this.syncGuild(config);
      }
    } catch (err) {
      console.error('[AutoRole] Sync error:', err.message);
    }
  }

  async syncGuild(config) {
    const guild = this.client.guilds.cache.get(config.guild_id);
    if (!guild) return;

    // Get mappings
    const mappingsResult = await query(
      'SELECT * FROM autorole_mappings WHERE guild_id = $1',
      [config.guild_id]
    );
    const mappings = mappingsResult.rows;

    // Get linked players
    const playersResult = await query(
      'SELECT * FROM autorole_players WHERE guild_id = $1',
      [config.guild_id]
    );

    // Fetch online players from ER:LC
    let onlinePlayers = [];
    try {
      const res = await axios.get(`${this.apiBase}/server/${process.env.ERLC_SERVER_ID || ''}/players`, {
        headers: this.headers,
        timeout: 10000,
      });
      onlinePlayers = res.data?.Players || [];
    } catch (err) {
      console.error('[AutoRole] API fetch error:', err.message);
      return;
    }

    // For each linked player in this guild, check their ER:LC team
    for (const player of playersResult.rows) {
      const onlineData = onlinePlayers.find(p => String(p.robloxId || p.id) === String(player.roblox_id));
      const currentTeam = onlineData?.Team || null;

      // Get previous team
      const prevTeam = player.team_name;

      if (currentTeam === prevTeam) continue; // No change

      // Find the member in Discord
      try {
        await guild.members.fetch();
      } catch { continue; }
      const member = guild.members.cache.get(player.user_id);
      if (!member) continue;

      // Remove old team role
      if (prevTeam) {
        const oldMapping = mappings.find(m => m.team_name.toLowerCase() === prevTeam.toLowerCase());
        if (oldMapping) {
          const oldRole = guild.roles.cache.get(oldMapping.role_id);
          if (oldRole && member.roles.cache.has(oldRole.id)) {
            await member.roles.remove(oldRole, 'AutoRole: Left team');
          }
        }
      }

      // Apply new team role
      if (currentTeam) {
        const newMapping = mappings.find(m => m.team_name.toLowerCase() === currentTeam.toLowerCase());
        if (newMapping) {
          const newRole = guild.roles.cache.get(newMapping.role_id);
          if (newRole && !member.roles.cache.has(newRole.id)) {
            await member.roles.add(newRole, 'AutoRole: Team sync');
          }
        }
      }

      // Update stored team
      await query(
        'UPDATE autorole_players SET team_name = $1, last_updated = NOW() WHERE guild_id = $2 AND user_id = $3',
        [currentTeam, config.guild_id, player.user_id]
      );
    }

    // Update last checked
    await query(
      'UPDATE autorole_config SET last_checked = NOW() WHERE guild_id = $1',
      [config.guild_id]
    );

    // Log to channel if configured
    if (config.join_log_channel) {
      const chan = guild.channels.cache.get(config.join_log_channel);
      if (chan) {
        // optional periodic log
      }
    }
  }

  // Get team display name
  static getTeamName(team) {
    if (!team || team === 0 || team === '') return null;
    const teamNames = {
      '1': 'Police',
      '2': 'Sheriff',
      '3': 'State Police',
      '4': 'Fire/EMS',
      '5': 'DOT',
      '6': 'Civilian',
      police: 'Police',
      sheriff: 'Sheriff',
      statepolice: 'State Police',
      fire: 'Fire/EMS',
      ems: 'Fire/EMS',
      dot: 'DOT',
      civilian: 'Civilian',
    };
    const key = String(team).toLowerCase().replace(/\s+/g, '');
    return teamNames[key] || String(team);
  }
}

module.exports = AutoRoleService;
