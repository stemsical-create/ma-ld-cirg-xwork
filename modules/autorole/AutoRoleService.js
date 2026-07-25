/**
 * ER:LC Auto-Role Service
 * 1. Scans members for Bloxlink/Melonly verification via nickname patterns
 * 2. Polls ER:LC API for each player's team
 * 3. Assigns/removes Discord roles automatically
 */
const axios = require('axios');
const { query } = require('../../database/db');
const VerificationScanner = require('./VerificationScanner');

class AutoRoleService {
  constructor(client) {
    this.client = client;
    this.interval = null;
    this.pollInterval = 30000; // 30 seconds
    this._scanning = false;
  }

  get apiBase() {
    return process.env.ERLC_API || 'https://api.emergency-response-liberty-county.com';
  }

  get headers() {
    return {
      'Authorization': `Bearer ${process.env.API_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  async start() {
    console.log('[AutoRole] Service started');
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
    if (this._scanning) return; // prevent overlap
    this._scanning = true;

    try {
      const result = await query('SELECT * FROM autorole_config WHERE enabled = true');
      for (const config of result.rows) {
        try {
          await this.syncGuild(config);
        } catch (err) {
          console.error(`[AutoRole] Guild ${config.guild_id} error:`, err.message);
        }
      }
    } catch (err) {
      console.error('[AutoRole] Sync error:', err.message);
    } finally {
      this._scanning = false;
    }
  }

  async syncGuild(config) {
    const guild = this.client.guilds.cache.get(config.guild_id);
    if (!guild) return;

    await guild.members.fetch();

    // Get mappings
    const mappingsResult = await query(
      'SELECT * FROM autorole_mappings WHERE guild_id = $1',
      [config.guild_id]
    );
    const mappings = mappingsResult.rows;

    if (mappings.length === 0) return; // no mappings = nothing to do

    // ===== VERIFICATION SCAN =====
    // Auto-detect verified members via Bloxlink/Melonly nickname patterns
    // No /link command needed — reads existing verification data
    const newlyFound = await VerificationScanner.scanGuild(guild);
    if (newlyFound > 0) {
      console.log(`[AutoRole] Found ${newlyFound} new verified members via nickname scan`);
    }

    // Get all verified players for this guild
    const playersResult = await query(
      'SELECT * FROM autorole_players WHERE guild_id = $1 AND verified = true AND roblox_id IS NOT NULL',
      [config.guild_id]
    );

    if (playersResult.rows.length === 0) return; // no verified players to check

    // ===== FETCH ER:LC ONLINE PLAYERS =====
    let onlinePlayers = [];
    try {
      const res = await axios.get(
        `${this.apiBase}/server/${process.env.ERLC_SERVER_ID || ''}/joinlog`,
        { headers: this.headers, timeout: 10000 }
      );
      // joinlog gives recent join data with Team info
      onlinePlayers = res.data || [];
    } catch (err) {
      // Try the players endpoint instead
      try {
        const res = await axios.get(
          `${this.apiBase}/server/${process.env.ERLC_SERVER_ID || ''}/players`,
          { headers: this.headers, timeout: 10000 }
        );
        onlinePlayers = res.data?.Players || [];
      } catch (err2) {
        console.error('[AutoRole] ER:LC API error:', err2.message);
        return;
      }
    }

    // Build a lookup map: robloxId -> team
    const teamMap = {};
    for (const p of onlinePlayers) {
      const id = p.robloxId || p.id || p.RobloxId;
      if (id) {
        const teamName = AutoRoleService.getTeamName(p.Team || p.team);
        if (teamName) teamMap[String(id)] = teamName;
      }
    }

    // ===== SYNC ROLES FOR EACH VERIFIED PLAYER =====
    for (const player of playersResult.rows) {
      const currentTeam = teamMap[player.roblox_id] || null;
      const prevTeam = player.team_name;

      if (currentTeam === prevTeam) continue; // no change

      const member = guild.members.cache.get(player.user_id);
      if (!member) continue;

      // Remove old team role
      if (prevTeam) {
        const oldMapping = mappings.find(m => m.team_name.toLowerCase() === prevTeam.toLowerCase());
        if (oldMapping) {
          const role = guild.roles.cache.get(oldMapping.role_id);
          if (role && member.roles.cache.has(role.id)) {
            await member.roles.remove(role, 'AutoRole: Left team').catch(() => {});
          }
        }
      }

      // Apply new team role
      if (currentTeam) {
        const newMapping = mappings.find(m => m.team_name.toLowerCase() === currentTeam.toLowerCase());
        if (newMapping) {
          const role = guild.roles.cache.get(newMapping.role_id);
          if (role && !member.roles.cache.has(role.id)) {
            await member.roles.add(role, 'AutoRole: Team sync').catch(() => {});
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
  }

  /**
   * Map ER:LC team value to readable name
   */
  static getTeamName(team) {
    if (!team || team === 0 || team === '0') return null;
    const t = String(team).trim();
    const map = {
      '1': 'Civilian',
      '2': 'Police',
      '3': 'Sheriff',
      '4': 'State Police',
      '5': 'Fire/EMS',
      '6': 'DOT',
      civilian: 'Civilian',
      police: 'Police',
      sheriff: 'Sheriff',
      statepolice: 'State Police',
      fire: 'Fire/EMS',
      ems: 'Fire/EMS',
      dot: 'DOT',
    };
    return map[t.toLowerCase()] || t;
  }
}

module.exports = AutoRoleService;
