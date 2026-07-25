/**
 * Verification Scanner
 * Scrapes Discord member data for Bloxlink / Melonly verification info
 * No manual /link command needed — reads existing verifications
 *
 * Bloxlink patterns:
 *   - Nickname: "Name | 123456"  or  "Name (123456)"  or  "123456 | Name"
 *   - Sometimes stores in member's custom status
 *   - Adds a "Verified" role (configurable per server)
 *
 * Melonly patterns:
 *   - Nickname: "Name [123456]"  or  "123456 - Name"
 *   - Adds a "Verified" role
 *
 * Returns: { robloxId, verifiedBy }
 */
const { query } = require('../../database/db');

class VerificationScanner {
  /**
   * Extract Roblox ID from a member's nickname or display name
   * @param {string} nickname - Member's guild nickname (or display name fallback)
   * @returns {string|null} - Roblox ID if found, null otherwise
   */
  static extractFromNickname(nickname) {
    if (!nickname) return null;

    // Pattern 1: "Name | 123456" (Bloxlink standard)
    let match = nickname.match(/\|\s*(\d{4,15})\s*$/);
    if (match) return match[1];

    // Pattern 2: "123456 | Name" (Bloxlink alt)
    match = nickname.match(/^(\d{4,15})\s*\|/);
    if (match) return match[1];

    // Pattern 3: "Name (123456)" (common)
    match = nickname.match(/\((\d{4,15})\)/);
    if (match) return match[1];

    // Pattern 4: "Name [123456]" (Melonly)
    match = nickname.match(/\[(\d{4,15})\]/);
    if (match) return match[1];

    // Pattern 5: "123456 - Name" (Melonly alt)
    match = nickname.match(/^(\d{4,15})\s*-/);
    if (match) return match[1];

    // Pattern 6: "Name - 123456"
    match = nickname.match(/-\s*(\d{4,15})$/);
    if (match) return match[1];

    // Pattern 7: just a bare 4-15 digit number in nickname (less reliable, check if it's the only thing)
    match = nickname.match(/^(\d{4,15})$/);
    if (match) return match[1];

    return null;
  }

  /**
   * Check if member has a verification-related role
   * @param {object} member - GuildMember
   * @param {string[]} verifiedRoleIds - Array of role IDs considered "verified" 
   * @returns {boolean}
   */
  static hasVerifiedRole(member, verifiedRoleIds = []) {
    if (!verifiedRoleIds || verifiedRoleIds.length === 0) return false;
    return verifiedRoleIds.some(roleId => member.roles.cache.has(roleId));
  }

  /**
   * Try to find Roblox ID in member's custom status
   * @param {object} member - GuildMember
   * @returns {string|null}
   */
  static extractFromActivity(member) {
    if (!member.presence) return null;
    const activity = member.presence.activities?.find(a => a.type === 4); // CUSTOM_STATUS
    if (!activity || !activity.state) return null;

    // Check for Roblox ID patterns in custom status
    const match = activity.state.match(/(\d{4,15})/);
    return match ? match[1] : null;
  }

  /**
   * Scan a single member for verification data
   * @param {object} member - GuildMember
   * @param {object} options
   * @param {string[]} options.verifiedRoleIds - Role IDs considered "verified"
   * @returns {{ robloxId: string|null, method: string|null }}
   */
  static scanMember(member, options = {}) {
    const { verifiedRoleIds = [] } = options;

    // 1. Try nickname
    const displayName = member.nickname || member.user.displayName;
    let robloxId = this.extractFromNickname(displayName);
    if (robloxId) {
      return { robloxId, method: 'nickname' };
    }

    // 2. Try custom status
    robloxId = this.extractFromActivity(member);
    if (robloxId) {
      return { robloxId, method: 'activity' };
    }

    // 3. Check if they have a verified role but we couldn't extract ID
    if (this.hasVerifiedRole(member, verifiedRoleIds)) {
      return { robloxId: null, method: 'verified_role_only' };
    }

    return { robloxId: null, method: null };
  }

  /**
   * Scan entire guild for verified members and update database
   * @param {object} guild - Discord Guild
   * @param {object} options
   * @param {string[]} options.verifiedRoleIds
   * @returns {number} - Number of newly found verifications
   */
  static async scanGuild(guild, options = {}) {
    const { verifiedRoleIds = [] } = options;
    let newVerifications = 0;

    // Ensure members are cached
    await guild.members.fetch();

    for (const [, member] of guild.members.cache) {
      if (member.user.bot) continue;

      const { robloxId, method } = this.scanMember(member, { verifiedRoleIds });
      if (!robloxId) continue;

      // Upsert into database
      try {
        const existing = await query(
          'SELECT roblox_id, verified FROM autorole_players WHERE guild_id = $1 AND user_id = $2',
          [guild.id, member.id]
        );

        if (existing.rows.length === 0) {
          // New player
          await query(
            `INSERT INTO autorole_players (guild_id, user_id, roblox_id, verified)
             VALUES ($1, $2, $3, true)`,
            [guild.id, member.id, robloxId]
          );
          newVerifications++;
        } else if (!existing.rows[0].verified || existing.rows[0].roblox_id !== robloxId) {
          // Update existing
          await query(
            `UPDATE autorole_players SET roblox_id = $1, verified = true, last_updated = NOW()
             WHERE guild_id = $2 AND user_id = $3`,
            [robloxId, guild.id, member.id]
          );
          newVerifications++;
        }
      } catch (err) {
        console.error(`[Verification] DB error for ${member.id}:`, err.message);
      }
    }

    return newVerifications;
  }
}

module.exports = VerificationScanner;
