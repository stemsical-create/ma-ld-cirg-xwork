/**
 * ER:LC Auto-Role Service (V2 API)
 *
 * Uses: https://api.erlc.gg/v2/server?Players=true
 * Auth: server-key header (get at https://erlc.link/sk)
 * Player format: "Username:UserId" (e.g. "PlayerName:123456")
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
    return process.env.ERLC_API || 'https://api.erlc.gg';
  }

  get serverKey() {
    return process.env.API_KEY || process.env.ERLC_SERVER_KEY;
  }

  async start() {
    console.log('[AutoRole] Service started');
    if (!this.serverKey) {
      console.log('[AutoRole] No server key set — add API_KEY to env. Disabling.');
      return;
    }
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
    if (this._scanning) return;
    this._scanning = true;
    try {
      const result = await query('SELECT * FROM autorole_config WHERE enabled = true');
      for (const config of result.rows) {
        try { await this.syncGuild(config); }
        catch (err) { console.error(`[AutoRole] Guild ${config.guild_id}:`, err.message); }
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
      'SELECT * FROM autorole_mappings WHERE guild_id = $1', [config.guild_id]
    );
    const mappings = mappingsResult.rows;
    if (mappings.length === 0) return;

    // ===== VERIFICATION SCAN =====
    const newlyFound = await VerificationScanner.scanGuild(guild);
    if (newlyFound > 0) {
      console.log(`[AutoRole] Found ${newlyFound} new verified members`);
    }

    // Get verified players
    const playersResult = await query(
      'SELECT * FROM autorole_players WHERE guild_id = $1 AND verified = true AND roblox_id IS NOT NULL',
      [config.guild_id]
    );
    if (playersResult.rows.length === 0) return;

    // ===== FETCH FROM ER:LC V2 API =====
    // GET https://api.erlc.gg/v2/server?Players=true
    // Header: server-key: YOUR_KEY
    // Response: { CurrentPlayers, MaxPlayers, Players: [{ Team: "Sheriff", Player: "Name:UserId" }] }
    let serverData = null;
    try {
      const res = await axios.get(`${this.apiBase}/v2/server`, {
        params: { Players: true },
        headers: { 'server-key': this.serverKey },
        timeout: 10000,
      });
      serverData = res.data;
    } catch (err) {
      console.error(`[AutoRole] ER:LC API error (${err.response?.status || err.message})`);
      return;
    }

    const onlinePlayers = serverData?.Players || [];
    console.log(`[AutoRole] ${onlinePlayers.length} players online`);

    // Build lookup: robloxId -> team
    // Player field format: "Username:UserId"
    const teamMap = {};
    for (const p of onlinePlayers) {
      const playerStr = p.Player || '';
      const parts = playerStr.split(':');
      const userId = parts[parts.length - 1]; // last part after colon is the ID
      if (userId && /^\d+$/.test(userId)) {
        const teamName = p.Team || null;
        const mapped = teamName ? AutoRoleService.getTeamName(teamName) : null;
        if (mapped) teamMap[userId] = mapped;
      }
    }

    // ===== SYNC ROLES =====
    for (const player of playersResult.rows) {
      const currentTeam = teamMap[player.roblox_id] || null;
      const prevTeam = player.team_name;
      if (currentTeam === prevTeam) continue;

      const member = guild.members.cache.get(player.user_id);
      if (!member) continue;

      // Remove old
      if (prevTeam) {
        const oldMap = mappings.find(m => m.team_name.toLowerCase() === prevTeam.toLowerCase());
        if (oldMap) {
          const role = guild.roles.cache.get(oldMap.role_id);
          if (role && member.roles.cache.has(role.id)) {
            await member.roles.remove(role, 'AutoRole: Left team').catch(() => {});
          }
        }
      }

      // Add new
      if (currentTeam) {
        const newMap = mappings.find(m => m.team_name.toLowerCase() === currentTeam.toLowerCase());
        if (newMap) {
          const role = guild.roles.cache.get(newMap.role_id);
          if (role && !member.roles.cache.has(role.id)) {
            await member.roles.add(role, 'AutoRole: Team sync').catch(() => {});
          }
        }
      }

      // Update DB
      await query(
        'UPDATE autorole_players SET team_name = $1, last_updated = NOW() WHERE guild_id = $2 AND user_id = $3',
        [currentTeam, config.guild_id, player.user_id]
      );
    }

    await query(
      'UPDATE autorole_config SET last_checked = NOW() WHERE guild_id = $1',
      [config.guild_id]
    );
  }

  /**
   * Map ER:LC team name (string from API V2) to standardized name
   */
  static getTeamName(team) {
    if (!team || team === '') return null;
    const t = String(team).trim().toLowerCase();
    const map = {
      civilian: 'Civilian',
      police: 'Police',
      sheriff: 'Sheriff',
      'state police': 'State Police',
      statepolice: 'State Police',
      'fire/ems': 'Fire/EMS',
      fire: 'Fire/EMS',
      ems: 'Fire/EMS',
      dot: 'DOT',
    };
    return map[t] || t.charAt(0).toUpperCase() + t.slice(1);
  }
}

module.exports = AutoRoleService;
