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
    GatewayIntentBits.MessageContent
  ]
});

client.commands = new Collection();
let dbReady = false;

client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} is online!`);
  client.user.setActivity('Modern Colorado | dsc.gg/MDCRX', { type: 'PLAYING' });

  // Init database
  if (process.env.DATABASE_URL) {
    try {
      await initDatabase();
      dbReady = true;
      console.log('✅ PostgreSQL initialized');
    } catch (err) {
      console.error('❌ DB init:', err.message);
    }
  }

  // Load slash commands
  const commandsPath = path.join(__dirname, 'commands');
  const files = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const cmd = require(`./commands/${file}`);
    if (cmd.name) client.commands.set(cmd.name, cmd);
  }
  console.log(`✅ Loaded ${client.commands.size} commands`);

  // Deploy slash commands
  if (process.env.GUILD_ID) {
    try {
      const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
      const cmds = Array.from(client.commands.values()).map(c => ({
        name: c.name, description: c.description || 'No description', options: c.options || [],
      }));
      await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID), { body: cmds });
      console.log('✅ Slash commands deployed');
    } catch (err) {
      console.error('❌ Slash deploy:', err.message);
    }
  }

  // Start auto-role service
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
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (cmd) await cmd.execute(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('autorole_')) {
      const { handleModal } = require('./commands/autorole');
      await handleModal(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.replied) {
      interaction.reply({ content: '❌ Error', ephemeral: true }).catch(() => {});
    }
  }
});

// Prefix commands
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.toLowerCase() === 'apply') {
    await message.reply('**Applications**: https://forms.gle/yourform | Check pins.\n<@&1486887218072125533>');
    return;
  }
  if (message.content === '!ping') {
    await message.reply(`Pong! ${client.ws.ping}ms`);
  }
});

client.login(process.env.BOT_TOKEN);
