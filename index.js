require('dotenv').config();
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { initDatabase } = require('./database/db');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();
let dbReady = false;

client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} online`);
  client.user.setActivity('Modern Colorado | dsc.gg/MDCRX', { type: 'PLAYING' });

  // Database
  if (process.env.DATABASE_URL) {
    try {
      await initDatabase();
      dbReady = true;
      console.log('✅ PostgreSQL initialized');
    } catch (err) {
      console.error('❌ DB:', err.message);
    }
  }

  // Load commands
  const cmdDir = path.join(__dirname, 'commands');
  fs.readdirSync(cmdDir).filter(f => f.endsWith('.js')).forEach(f => {
    const cmd = require(`./commands/${f}`);
    if (cmd.name) client.commands.set(cmd.name, cmd);
  });
  console.log(`✅ ${client.commands.size} commands loaded`);

  // Deploy slash commands
  if (process.env.GUILD_ID) {
    try {
      const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
      const cmds = Array.from(client.commands.values()).map(c => ({
        name: c.name,
        description: c.description || '_',
        options: c.options || [],
      }));
      await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: cmds });
      console.log('✅ Slash commands deployed');
    } catch (err) {
      console.error('❌ Slash deploy:', err.message);
    }
  }

  // Start auto-role
  if (dbReady) {
    try {
      const AutoRoleService = require('./modules/autorole/AutoRoleService');
      new AutoRoleService(client).start();
    } catch (err) {
      console.error('❌ AutoRole:', err.message);
    }
  }
});

// Interaction handler
client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) {
      const cmd = client.commands.get(i.commandName);
      if (cmd) await cmd.execute(i);
    }
    if (i.isModalSubmit() && i.customId.startsWith('ar_')) {
      const { handleModal } = require('./commands/autorole');
      await handleModal(i);
    }
    if (i.isStringSelectMenu()) {
      const ids = ['ar_add_access', 'ar_remove_access'];
      if (ids.includes(i.customId)) {
        const { handleModal } = require('./commands/autorole');
        await handleModal(i);
      }
    }
  } catch (err) {
    console.error('Error:', err);
    if (!i.replied) i.reply({ content: '❌ Error', ephemeral: true }).catch(() => {});
  }
});

// Prefix commands
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (msg.content.toLowerCase() === 'apply') {
    await msg.reply('**Applications**: https://forms.gle/yourform | Check pins.\n<@&1486887218072125533>');
  }
  if (msg.content === '!ping') {
    await msg.reply(`Pong! ${client.ws.ping}ms`);
  }
});

client.login(process.env.BOT_TOKEN);
